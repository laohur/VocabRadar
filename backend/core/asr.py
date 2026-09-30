"""ASR 引擎：faster-whisper（唯一引擎，自带 timestamps）分发 + 生命周期。

- 引擎：faster-whisper（CTranslate2，档位 asr.whisper_model 写全名如
  large-v3-turbo，旧值 turbo 自动归一）；模型完全交
  faster-whisper/huggingface_hub 自动维护（hub 默认缓存，不自建
  models 目录、不落标记文件、不指明路径）：
  ensure_local_model 先 hub 本地缓存直取（local_files_only，就绪绝不联网，
  规避启动 etag 校验/镜像波动即重下），无缓存才联网
  snapshot_download（断点续传，尊重 HF_ENDPOINT 镜像）。历史残留
  qwen3-asr 值一律归一。
- 音频解码：faster-whisper 内部用 PyAV 解码，直接喂文件路径，无需预处理。
- 生命周期：resident 启动即后台预加载；on-demand 首请求加载、
  空闲超时卸载（进程内模型，卸载即释放内存）。加载互斥与 LLM 同款 _starting 防护。
- 缓存读写归 api 层（见 api/asr.py）；本模块只提供推理与缓存目录管理。
"""

import gc
import os
import re
import threading
import time

import config

ASR_CACHE_DIR = os.path.join(config.CACHE_DIR, "asr")

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


def ensure_local_model(tier):
    """确保档位模型就绪，返回模型目录（faster-whisper/huggingface_hub
    自动维护：hub 默认缓存，断点续传/并发锁/完整性自管；本模块不自建
    目录、不落任何标记文件）。

    先 hub 本地缓存直取（local_files_only=True，就绪绝不联网，规避
    启动 etag 校验/镜像波动即重下）；无缓存才联网
    snapshot_download（尊重 HF_ENDPOINT 镜像环境变量）。"""
    repo = _WHISPER_REPOS.get(tier, "Systran/faster-whisper-" + tier)
    from huggingface_hub import snapshot_download
    try:
        return snapshot_download(repo_id=repo, local_files_only=True)
    except Exception:
        return snapshot_download(repo_id=repo)


class AsrEngine:
    """进程内 ASR 引擎属主（挂 app.extensions["engines"]["asr"]）。

    唯一引擎 faster-whisper；模型加载互斥，
    on-demand 模式空闲超时自动卸载。
    """

    def __init__(self, cfg):
        self.cfg = cfg or {}
        self.mode = self.cfg.get("mode", "resident")
        self._model = None
        self._engine_loaded = None      # 已加载模型对应的引擎名（切换引擎须重载）
        self._lock = threading.Lock()
        self._starting = False          # 三层防重入标志（同 llm_engine）
        # 手动停机标志，置位期间懒加载被拒绝；从 config <asr>.stopped 恢复：
        # 默认 True（默认全关），重启后仍尊重用户设定
        self._manual_stop = bool(self.cfg.get("stopped"))
        self._last_used = 0.0
        if self.mode == "on-demand":
            t = threading.Thread(target=self._idle_watch, daemon=True)
            t.start()

    # ---- 生命周期 ----

    def ensure_loaded(self, engine=None, force=False):
        """确保引擎就绪（懒加载）；返回 (model, engine_name)。线程安全。

        唯一引擎 faster-whisper；engine 参数作签名兼容，残留
        qwen3-asr 值一律归一（不再分支加载）。
        force=True（管理页启动按钮）解除手动停机；普通调用在手动停机
        期间拒绝加载（停了就是停了，不被业务请求悄悄拉回）。
        """
        engine = "faster-whisper"
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
                self._model = self._load_whisper()
                self._engine_loaded = engine
                self._last_used = time.time()
                return self._model, engine
            finally:
                self._starting = False

    def _load_whisper(self):
        from faster_whisper import WhisperModel
        tier = normalize_tier(self.cfg.get("whisper_model", _DEFAULT_TIER))
        # hub 缓存路径直载（ensure_local_model 已确保本地就绪，不联网）
        return WhisperModel(ensure_local_model(tier),
                            device="cpu", compute_type="int8")

    def _release(self):
        self._model = None
        self._engine_loaded = None
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
        return {
            "engine": "faster-whisper",
            "mode": self.mode,
            "loaded": self._model is not None,
            "loading": self._starting,
            "loaded_engine": self._engine_loaded,
            "manual_stop": self._manual_stop,  # 手动停机中（懒加载被抑制）
            "model": normalize_tier(self.cfg.get("whisper_model", _DEFAULT_TIER)),
        }

    # ---- 推理 ----

    def transcribe(self, audio_path, engine=None, language=None):
        """转写 → {text, segments, language}；segments 为 whisper 逐段时间戳。

        engine 参数作签名兼容（api 层已校验合法值），一律走 faster-whisper。
        """
        model, _engine = self.ensure_loaded(engine)
        # vad_filter=True 跳过静音段（只转写有人声部分，提速）并压制静音段
        # 幻觉——幻觉是 whisper 段时间戳紊乱（乱序）的主要来源。
        # silero-vad onnx 已随 faster-whisper 包内置。
        segs, info = model.transcribe(audio_path, language=language or None,
                                      vad_filter=True)
        items, text = [], []
        for s in segs:  # 生成器，须消费
            items.append({"start": round(s.start, 3), "end": round(s.end, 3),
                          "text": s.text.strip()})
            text.append(s.text.strip())
        return {"text": " ".join(t for t in text if t),
                "segments": items, "language": info.language}


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
