"""ASR 引擎属主：多引擎分发 + 生命周期（评审 2026-10《后端 ASR 接入评审》§2）。

- 引擎（config <asr>.engine）：
  - faster-whisper（默认/无 GPU 回落档）：CTranslate2，档位 asr.whisper_model
    （CPU int8；fw 系接口 fw 专属——clip_timestamps / no_speech_prob / 生成器
    增量，asr_job 对其保留专用零回归路径）。
  - qwen3-asr（Haujet GGUF）：子进程 worker（core/asr_qwen3.py），档位
    asr.qwen3_size（0.6b 默认档 / 1.7b 质量档），GPU（DML+Vulkan）专用。
  - moss（MOSS-Transcribe-Diarize）：transcribe_cpp 进程内（core/asr_moss.py），
    量化 asr.moss_quant，唯一自带说话人分离。
- 模型获取：各引擎自管——fw 走 huggingface_hub snapshot_download（先本地
  缓存直取、无缓存才联网补拉 hf 官方 → hf-mirror）；qwen3 工具/模型 zip 取
  GitHub Releases 首用解压；MOSS gguf 按 moss_model_path/默认路径查找。
- 生命周期：resident 启动即后台预加载；on-demand 首请求加载、空闲超时卸载
  （fw 进程内模型 / moss 引用置空 / qwen3 关 worker 进程——卸载即释放资源）。
  加载互斥同 llm_engine _starting 防护。第517次裁定延续：服务中已加载的模型
  不随配置换档——已加载判定只比引擎名，档位/量化改动下次启动/卸载后生效。
- 缓存读写归 api 层（见 api/asr.py / asr_job.py）；本模块提供推理与缓存
  目录管理。缓存条目引擎标签 = engine_tag(cfg)（engine/model 粒度）。
"""

import gc
import logging
import os
import re
import threading
import time

import config

log = logging.getLogger(__name__)

ASR_CACHE_DIR = os.path.join(config.CACHE_DIR, "asr")

# 合法引擎（api 层校验 + 管理页下拉同源）
ASR_ENGINES = ("faster-whisper", "qwen3-asr", "moss")

# 档位全名 → HF repo（旧值 turbo 经 _TIER_ALIASES 归一）
_WHISPER_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
}
_TIER_ALIASES = {"turbo": "large-v3-turbo"}
_DEFAULT_TIER = "large-v3-turbo"


def normalize_tier(name):
    """档位名归一：旧值 turbo → large-v3-turbo；空回落默认。"""
    name = (name or "").strip().lower()
    return _TIER_ALIASES.get(name) or name or _DEFAULT_TIER


def engine_tag(cfg):
    """缓存条目引擎标签（engine/model 粒度）：同音频换引擎/档位结果不同，
    不复用。official（官方字幕直出）条目按 asr_job 侧语义另行放行。"""
    cfg = cfg or {}
    engine = cfg.get("engine") or "faster-whisper"
    if engine == "qwen3-asr":
        return f"qwen3-asr/{(cfg.get('qwen3_size') or '0.6b').strip().lower()}"
    if engine == "moss":
        return f"moss/{(cfg.get('moss_quant') or 'q4_K_M').strip()}"
    return f"faster-whisper/{normalize_tier(cfg.get('whisper_model'))}"


# 联网补拉镜像（第516次）：hf 官方直连在大陆网络常态不可达，换未缓存
# 档位即炸 LocalEntryNotFoundError（4dc3c36f1a3e 实锤）；对齐 llm_engine
# 三源思路的进程内版——官方失败转 hf-mirror。坏源结论进程内记住
# （None=未试 / True=可用 / False=已判死），同源不重复付连接超时。
_HF_MIRROR = "https://hf-mirror.com"
_ENDPOINT_STATE = {"hf": None}


def ensure_local_model(tier):
    """确保档位模型就绪，返回模型目录（faster-whisper/huggingface_hub
    自动维护：hub 默认缓存，断点续传/并发锁/完整性自管；本模块不自建
    目录、不落任何标记文件）。

    先 hub 本地缓存直取（local_files_only=True，就绪绝不联网，规避
    启动 etag 校验/镜像波动即重下）；无缓存才联网补拉：hf 官方 →
    hf-mirror 镜像（0.36+ HfApi.snapshot_download 透传 endpoint，无需
    环境变量）。全败抛 RuntimeError（文案带档位与 repo，可读化——不再
    裸透 huggingface_hub 原文）。"""
    repo = _WHISPER_REPOS.get(tier, "Systran/faster-whisper-" + tier)
    from huggingface_hub import HfApi, snapshot_download
    try:
        return snapshot_download(repo_id=repo, local_files_only=True)
    except Exception:
        pass  # 本地无缓存/缓存残缺：联网补拉
    last = None
    for name, endpoint in (("hf", None), ("hf-mirror", _HF_MIRROR)):
        if name == "hf" and _ENDPOINT_STATE["hf"] is False:
            continue  # 本进程已判死：跳过直连
        try:
            api = HfApi(endpoint=endpoint) if endpoint else HfApi()
            out = api.snapshot_download(repo_id=repo)
            if name == "hf":
                _ENDPOINT_STATE["hf"] = True
            return out
        except Exception as e:
            last = e
            if name == "hf":
                _ENDPOINT_STATE["hf"] = False
    raise RuntimeError(
        "ASR 模型 %s（%s）本地无缓存且联网补拉失败（hf 与 hf-mirror 均不可达，"
        "请检查网络后重试，或到管理页换回已缓存档位）：%s"
        % (tier, repo, str(last)[:200]))


class AsrEngine:
    """ASR 引擎属主（挂 app.extensions["engines"]["asr"]）。

    多引擎分发（ASR_ENGINES）；加载互斥，on-demand 空闲超时自动卸载。
    """

    def __init__(self, cfg):
        self.cfg = cfg or {}
        self.mode = self.cfg.get("mode", "resident")
        self._model = None            # 引擎句柄（fw=WhisperModel / moss=MossEngine / qwen3=Qwen3Worker）
        self._engine_loaded = None    # 已加载引擎名（切换引擎须重载；第517次：档位不热切）
        self._lock = threading.Lock()
        self._starting = False        # 三层防重入标志（同 llm_engine）
        # 手动停机标志，置位期间懒加载被拒绝；从 config <asr>.stopped 恢复：
        # 默认 True（默认全关），重启后仍尊重用户设定
        self._manual_stop = bool(self.cfg.get("stopped"))
        self._last_used = 0.0
        if self.mode == "on-demand":
            t = threading.Thread(target=self._idle_watch, daemon=True)
            t.start()

    # ---- 引擎名/档位 ----

    @property
    def engine_name(self):
        """当前配置引擎（加载与否无关；job/api 层据此分流）。"""
        eng = (self.cfg.get("engine") or "faster-whisper").strip()
        return eng if eng in ASR_ENGINES else "faster-whisper"

    def _engine_model_name(self):
        """当前引擎的模型展示名（状态行/缓存标签共用）。"""
        eng = self.engine_name
        if eng == "qwen3-asr":
            return (self.cfg.get("qwen3_size") or "0.6b").strip().lower()
        if eng == "moss":
            return (self.cfg.get("moss_quant") or "q4_K_M").strip()
        return normalize_tier(self.cfg.get("whisper_model"))

    # ---- 生命周期 ----

    def ensure_loaded(self, force=False):
        """确保引擎就绪（懒加载）；返回 (handle, engine_name)。线程安全。

        引擎取 config <asr>.engine；已加载判定只比引擎名（第517次：档位/
        量化/whisper_model 改动下次启动/卸载后生效，勿改「换档即刻重载」）。
        force=True（管理页启动按钮）解除手动停机；普通调用在手动停机
        期间拒绝加载（停了就是停了，不被业务请求悄悄拉回）。
        """
        engine = self.engine_name
        with self._lock:
            if force:
                self._manual_stop = False
                config.set_engine_stopped("asr", False)  # 持久化用户启动设定（stopped:false）
            elif self._manual_stop:
                raise RuntimeError("ASR 引擎已手动停机，请到管理页重新启动")
            if self._model is not None and self._engine_loaded == engine:
                self._last_used = time.time()
                return self._model, engine
            if self._starting:
                raise RuntimeError("ASR 引擎正在加载中，请稍候重试")
            self._starting = True
            try:
                self._model = self._load(engine)
                self._engine_loaded = engine
                self._last_used = time.time()
                return self._model, engine
            finally:
                self._starting = False

    def _load(self, engine):
        if engine == "faster-whisper":
            return self._load_whisper()
        if engine == "qwen3-asr":
            if os.name != "nt":
                # DML 仅 Windows（requirements 已按平台标记装 directml 构建）；
                # 纯 CPU 不可用级（评审实测 RTFx<0.1）——直接拒绝，指回落 fw
                raise RuntimeError(
                    "qwen3-asr 需要 Windows + DirectML（编码器 GPU 路径）；"
                    "当前平台不可用，请回落 faster-whisper")
            from core.asr_qwen3 import Qwen3Worker
            return Qwen3Worker(size=self.cfg.get("qwen3_size"), dml=True)
        if engine == "moss":
            from core.asr_moss import MossEngine
            return MossEngine(quant=self.cfg.get("moss_quant"),
                              model_path=self.cfg.get("moss_model_path") or None)
        raise ValueError(f"未知 ASR 引擎：{engine}")

    def _load_whisper(self):
        from faster_whisper import WhisperModel
        tier = normalize_tier(self.cfg.get("whisper_model", _DEFAULT_TIER))
        # hub 缓存路径直载（ensure_local_model 已确保本地就绪，不联网）
        return WhisperModel(ensure_local_model(tier),
                            device="cpu", compute_type="int8")

    def _release(self):
        handle, self._model, self._engine_loaded = self._model, None, None
        if handle is not None and hasattr(handle, "close"):
            try:
                handle.close()  # qwen3 worker / moss 显式释放；WhisperModel 无 close
            except Exception as e:
                log.warning("引擎句柄关闭异常（%s）：%s", type(handle).__name__, e)
        gc.collect()

    def stop(self):
        """手动卸载模型（管理界面关停按钮；on-demand 之外显式入口）。线程安全。

        置位手动停机标志，业务请求不再自动重新加载；持久化到 config
        （移除键回落默认停机，进程重启后仍保持停机）。"""
        with self._lock:
            if self._starting:
                raise RuntimeError("ASR 引擎正在加载中，请稍候再关停")
            self._manual_stop = True
            self._release()
        config.set_engine_stopped("asr", True)  # 持久化主动关停（移除键回落默认停机）

    def _idle_watch(self):
        timeout = self.cfg.get("idle_timeout", 600)
        while True:
            time.sleep(30)
            with self._lock:
                if (self._model is not None and not self._starting
                        and time.time() - self._last_used > timeout):
                    self._release()

    def status(self):
        """/api/asr/status 与 /api/status 用。"""
        engine = self.engine_name
        return {
            "engine": engine,
            "mode": self.mode,
            "loaded": self._model is not None,
            "loading": self._starting,
            "loaded_engine": self._engine_loaded,
            "manual_stop": self._manual_stop,  # 手动停机中（懒加载被抑制）
            "model": self._engine_model_name(),
        }

    # ---- 推理 ----

    def transcribe(self, audio_path, engine=None, language=None):
        """整文件转写（交互路径 /api/asr/transcribe）→ {text, segments, language}。

        engine 参数作签名兼容（api 层已校验合法值），实际引擎取 config；
        fw 走 vad_filter 内置路径，qwen3/moss 走各自整文件转写。
        """
        handle, eng = self.ensure_loaded()
        if eng == "faster-whisper":
            # vad_filter=True 跳过静音段（只转写有人声部分，提速）并压制静音段
            # 幻觉——幻觉是 whisper 段时间戳紊乱（乱序）的主要来源。
            # silero-vad onnx 已随 faster-whisper 包内置。
            segs, info = handle.transcribe(audio_path, language=language or None,
                                           vad_filter=True)
            items, text = [], []
            for s in segs:  # 生成器，须消费
                items.append({"start": round(s.start, 3), "end": round(s.end, 3),
                              "text": s.text.strip()})
                text.append(s.text.strip())
            return {"text": " ".join(t for t in text if t),
                    "segments": items, "language": info.language}
        if eng == "qwen3-asr":
            items = handle.transcribe_file(audio_path, language=language)
            return {"text": " ".join(s["text"] for s in items),
                    "segments": items, "language": language or None}
        if eng == "moss":
            items = handle.transcribe_file(audio_path, language=language)
            return {"text": " ".join(s["text"] for s in items),
                    "segments": items, "language": language or None}
        raise ValueError(f"未知 ASR 引擎：{eng}")


# ---- 缓存目录管理（读写逻辑在 api 层，此处供管理界面列表/清空） ----


def _safe_key(key):
    # 通用站 key 前缀是裸 host（含点，如 example.com-…），白名单
    #   放行单个 `.` 保落盘文件名可读；连续 `.`（`..` 路径穿越成分）归 `_`。
    return re.sub(r"\.{2,}", "_", re.sub(r"[^A-Za-z0-9_.-]", "_", key))[:120]


def cache_list():
    out = []
    if not os.path.isdir(ASR_CACHE_DIR):
        return out
    for name in os.listdir(ASR_CACHE_DIR):
        if not name.endswith(".json"):
            continue
        path = os.path.join(ASR_CACHE_DIR, name)
        try:
            import json
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            out.append({
                "key": data.get("key", name[:-5]),
                "video_id": data.get("video_id"),
                "engine": data.get("engine"),
                "language": data.get("language"),
                "duration": data.get("duration"),
                # 条目不存 text，preview 从 segments 拼（字段名保持）。
                "preview": " ".join(
                    (s.get("text") or "").strip()
                    for s in (data.get("segments") or []))[:80],
                "size": os.path.getsize(path),
                "ts": data.get("ts"),
            })
        except (OSError, ValueError):
            continue
    out.sort(key=lambda x: x.get("ts") or 0, reverse=True)
    return out


def cache_clear():
    if not os.path.isdir(ASR_CACHE_DIR):
        return 0
    n = 0
    for name in os.listdir(ASR_CACHE_DIR):
        if name.endswith(".json"):
            os.remove(os.path.join(ASR_CACHE_DIR, name))
            n += 1
    return n
