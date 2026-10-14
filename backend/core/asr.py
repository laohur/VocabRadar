"""ASR 引擎属主：多引擎分发 + 生命周期（评审 2026-10《后端 ASR 接入评审》§2）。

- 引擎（config <asr>.engine）：
  - faster-whisper（默认/无 GPU 回落档）：CTranslate2，档位 asr.whisper_model
    （CPU int8；fw 系接口 fw 专属——clip_timestamps / no_speech_prob / 生成器
    增量，asr_job 对其保留专用零回归路径）。第558次起设备可选（asr.whisper_device
    auto/cpu/cuda）：安装器装 nvidia-cublas-cu12（cuDNN 9 已随 ct2 Windows wheel
    自带）后 auto/cuda 走 CUDA，加载或环境不满足回落 CPU 并把原因记入 status；
    缓存标签带设备维度（@cuda），设备不热切（第517次口径）。
  - qwen3-asr（Haujet GGUF）：子进程 worker（core/asr_qwen3.py），档位
    asr.qwen3_size（0.6b 默认档 / 1.7b 质量档），GPU（DML+Vulkan）专用。
  - moss（MOSS-Transcribe-Diarize）：transcribe_cpp 进程内（core/asr_moss.py），
    量化 asr.moss_quant，唯一自带说话人分离。
  - whisper-cpp（whisper.cpp large-v3-turbo q5_0）：子进程 CLI（core/
    asr_whispercpp.py，官方 win-cuda 预编译 + 官方 ggml，评审 §1.3b 第 4
    适配器候选）；仅 GPU 档，无 CUDA 如实拒绝指回落 faster-whisper；
    量化 asr.wcpp_quant。
- 模型获取：各引擎自管——fw 走 huggingface_hub snapshot_download（先本地
  缓存直取、无缓存才联网补拉 hf 官方 → hf-mirror）；qwen3 工具/模型 zip 取
  GitHub Releases 首用解压；MOSS gguf 默认路径缺失时自动补拉（hf 官方 →
  hf-mirror，见 asr_moss._download_model）；moss_model_path 显式路径只查找。
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
import sys
import threading
import time
from pathlib import Path

import config

log = logging.getLogger(__name__)

ASR_CACHE_DIR = os.path.join(config.CACHE_DIR, "asr")

# 合法引擎（api 层校验 + 管理页下拉同源）
ASR_ENGINES = ("faster-whisper", "qwen3-asr", "moss", "whisper-cpp")

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
    """缓存条目引擎标签（engine/model/device 粒度）：同音频换引擎/档位/设备
    结果不同，不复用。official（官方字幕直出）条目按 asr_job 侧语义另行放行。"""
    cfg = cfg or {}
    engine = cfg.get("engine") or "faster-whisper"
    if engine == "qwen3-asr":
        return f"qwen3-asr/{(cfg.get('qwen3_size') or '0.6b').strip().lower()}"
    if engine == "moss":
        return f"moss/{(cfg.get('moss_quant') or 'q4_K_M').strip()}"
    if engine == "whisper-cpp":
        return f"whisper-cpp/{(cfg.get('wcpp_quant') or 'q5_0').strip()}"
    return (f"faster-whisper/{normalize_tier(cfg.get('whisper_model'))}"
            + _device_tag(cfg))


# ---- whisper GPU 支持（第558次：安装器可选装 nvidia-cublas-cu12 后启用） ----

_GPU_INFO = None          # 探测缓存（驱动/库状态进程内视为不变）
_CUDA_DLL_PREPARED = False

# 计算精度合法集（越界加载时告警归 int8）：cpu 不支持 fp16 系（无 AVX512-FP16
# 的机器 CT2 直接拒），cuda 全开
_CPU_COMPUTES = ("int8", "int8_float32", "float32")
_CUDA_COMPUTES = ("int8", "int8_float16", "float16", "bfloat16", "float32")


def _normalize_device(val):
    """设备值归一：auto/cpu/cuda，非法/空回落 auto。"""
    v = (val or "").strip().lower()
    return v if v in ("auto", "cpu", "cuda") else "auto"


def _nvidia_lib_dirs(pkg):
    """pip nvidia 包的库目录（Windows=bin，Linux=lib）；找不到返回空表。

    先 importlib.util.find_spec（标准路径），namespace 包偶发探测不到时扫
    sys.path 兜底。"""
    out = []
    sub = "bin" if os.name == "nt" else "lib"
    try:
        from importlib.util import find_spec
        spec = find_spec(f"nvidia.{pkg}")
        if spec and spec.submodule_search_locations:
            d = Path(spec.submodule_search_locations[0]) / sub
            if d.is_dir():
                out.append(d)
    except (ImportError, ValueError):
        pass
    if not out:
        for base in sys.path:
            if not base:
                continue
            d = Path(base) / "nvidia" / pkg / sub
            if d.is_dir():
                out.append(d)
    return out


def _prepare_cuda_dlls():
    """注册 pip 版 cuBLAS 的库目录（幂等，进程内一次）。

    Windows：nvidia/cublas/bin 不在系统 DLL 搜索路径——实测仅
    os.add_dll_directory 不够（CT2 用无标志 LoadLibrary，只搜传统路径含
    PATH），须同时 PATH 前置。
    Linux：LD_LIBRARY_PATH 进程启动后改不动，按绝对路径 ctypes 预载
    （先 Lt 后主库；cuDNN 一并预载——Linux ct2 wheel 不带 cuDNN，官方
    README 口径装 nvidia-cudnn-cu12）。"""
    global _CUDA_DLL_PREPARED
    if _CUDA_DLL_PREPARED:
        return
    _CUDA_DLL_PREPARED = True
    if os.name == "nt":
        dirs = _nvidia_lib_dirs("cublas")
        for d in dirs:
            try:
                os.add_dll_directory(str(d))
            except OSError:
                pass
        if dirs:
            os.environ["PATH"] = (os.pathsep.join(str(d) for d in dirs)
                                  + os.pathsep + os.environ.get("PATH", ""))
        return
    import ctypes
    targets = [(d, ("libcublasLt.so.12", "libcublas.so.12"))
               for d in _nvidia_lib_dirs("cublas")]
    targets += [(d, ("libcudnn.so.9",)) for d in _nvidia_lib_dirs("cudnn")]
    for d, sonames in targets:
        for so in sonames:
            p = d / so
            if p.exists():
                try:
                    ctypes.CDLL(str(p))
                except OSError as e:
                    log.warning("预载 %s 失败：%s", so, e)


def gpu_info():
    """whisper GPU 支持状态（模块级缓存；/api/status 与管理页 GPU 卡共用）。

    installed：nvidia-cublas-cu12 pip 包在否（只查元数据不 import）；
    cuda_devices：ctranslate2 驱动级 CUDA 设备数（无驱动/无卡=0）；
    cublas_loadable：注册 DLL 目录后 cuBLAS 能否实际加载（ctypes 试载——
    模型加载不上卡不发错，推理时才炸 cublas，故必须预检这一步）。"""
    global _GPU_INFO
    if _GPU_INFO is None:
        gi = {"installed": False, "version": "", "cuda_devices": 0,
              "cublas_loadable": False}
        try:
            from importlib.metadata import version
            gi["version"] = version("nvidia-cublas-cu12")
            gi["installed"] = True
        except Exception:
            pass
        try:
            import ctranslate2
            gi["cuda_devices"] = ctranslate2.get_cuda_device_count()
        except Exception:
            pass  # 未装 faster-whisper/驱动缺失：一律按 CPU 处理
        if gi["cuda_devices"] > 0:
            _prepare_cuda_dlls()
            try:
                import ctypes
                if os.name == "nt":
                    ctypes.WinDLL("cublas64_12.dll")
                else:
                    ctypes.CDLL("libcublas.so.12")
                gi["cublas_loadable"] = True
            except OSError:
                pass
        _GPU_INFO = gi
    return _GPU_INFO


def _cuda_ready():
    """auto/cuda 上卡判据：有 CUDA 设备且 cuBLAS 可载（两者缺一回落 CPU）。"""
    gi = gpu_info()
    return gi["cuda_devices"] > 0 and gi["cublas_loadable"]


def _device_tag(cfg):
    """缓存标签设备维度：CUDA 生效路径加 @cuda（CPU/CUDA 数值有微差，不混
    缓存）；cpu 与「要 cuda 但环境不满足必回落」同走 CPU，共用无后缀标签。"""
    if _normalize_device((cfg or {}).get("whisper_device")) == "cpu":
        return ""
    return "@cuda" if _cuda_ready() else ""


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
        # whisper 设备（第558次）：effective=最近一次加载实际用的设备；note=
        # 要 GPU 而回落 CPU 的原因（加载失败/环境不满足），status 透出
        self._device_effective = None
        self._device_note = ""
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
        if eng == "whisper-cpp":
            return (self.cfg.get("wcpp_quant") or "q5_0").strip()
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
        if engine == "whisper-cpp":
            if os.name != "nt":
                # 官方预编译仅 win-cuda x64（评审 §1.3b）——如实拒绝，指回落 fw
                raise RuntimeError(
                    "whisper-cpp 仅提供 Windows x64 CUDA 预编译；当前平台不可用，"
                    "请回落 faster-whisper")
            from core.asr_whispercpp import WcppEngine
            return WcppEngine(quant=self.cfg.get("wcpp_quant"))
        raise ValueError(f"未知 ASR 引擎：{engine}")

    def _load_whisper(self):
        from faster_whisper import WhisperModel
        tier = normalize_tier(self.cfg.get("whisper_model", _DEFAULT_TIER))
        model_dir = ensure_local_model(tier)
        want = _normalize_device(self.cfg.get("whisper_device"))
        compute = (self.cfg.get("whisper_compute_type") or "").strip().lower()
        if want in ("auto", "cuda") and _cuda_ready():
            _prepare_cuda_dlls()  # gpu_info 预检时已注册，此处显式调用读着直白
            try:
                self._device_effective = "cuda"
                self._device_note = ""
                return WhisperModel(model_dir, device="cuda",
                                    compute_type=compute or "float16")
            except Exception as e:  # 显存不足/驱动版本错等加载期失败：回落 CPU
                log.warning("whisper CUDA 加载失败，回落 CPU：%s: %s",
                            type(e).__name__, e)
                self._device_note = f"{type(e).__name__}: {e}"
        elif want == "cuda":
            gi = gpu_info()
            self._device_note = (f"CUDA 设备 {gi['cuda_devices']} 个、"
                                 f"cuBLAS 可载 {gi['cublas_loadable']}")
            log.warning("whisper 指定 cuda 但 CUDA 不可用（%s），回落 CPU int8",
                        self._device_note)
        else:
            self._device_note = ""
        self._device_effective = "cpu"
        if compute and compute not in _CPU_COMPUTES:
            log.warning("whisper compute_type %s 不适用于 CPU，改用 int8", compute)
            compute = "int8"
        # hub 缓存路径直载（ensure_local_model 已确保本地就绪，不联网）
        return WhisperModel(model_dir, device="cpu",
                            compute_type=compute or "int8")

    def _release(self):
        handle, self._model, self._engine_loaded = self._model, None, None
        self._device_effective = None
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
            # 第558次：whisper 设备三维（请求值/实际生效/回落原因）+ GPU 环境
            "whisper_device": _normalize_device(self.cfg.get("whisper_device")),
            "device_effective": self._device_effective,
            "device_note": self._device_note,
            "gpu": gpu_info(),
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
        if eng == "whisper-cpp":
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


# ---- 手动预下载（管理页模型卡「下载」按钮）：提前拉齐档位资产，首次转写
#      不再等下载。fw=hub snapshot（hf → hf-mirror 双源，同 ensure_local_model
#      顺序）；qwen3=GitHub Releases 自取（复用 _ensure_tool/_ensure_model）；
#      moss=hf 双源单文件补拉（复用 asr_moss._download_model，落 backend/
#      models/，与首用自动补拉同路径同源顺序）；whisper-cpp=GitHub Releases
#      二进制 zip + hf 双源权重两段（复用 asr_whispercpp._ensure_*）。状态进
#      _DOWNLOADS，api 层 /api/asr/downloads 查询、/api/asr/download 触发。 ----

QWEN3_SIZES = ("0.6b", "1.7b")

_DOWNLOADS = {}  # "{engine}:{tier}" -> {state, progress, source, error}
_DL_LOCK = threading.Lock()


def _fw_cached(repo):
    """whisper 档位 hub 缓存齐备判定（local_files_only，不联网）。"""
    from huggingface_hub import snapshot_download
    try:
        snapshot_download(repo_id=repo, local_files_only=True)
        return True
    except Exception:
        return False


def _qwen3_cached(size):
    """qwen3 档位资产齐备判定（工具 + 模型包 .ok 标记，与首用自取同口径）。"""
    from core import asr_qwen3
    size = (size or "0.6b").strip().lower()
    tool_root = os.path.join(config.BIN_DIR, "qwen3-asr")
    model_root = os.path.join(config.CACHE_DIR, "models", "qwen3-asr", size)
    return (asr_qwen3._asset_ready(tool_root)
            and asr_qwen3._asset_ready(model_root))


def _moss_cached(quant):
    """moss 量化 gguf 齐备判定（默认路径单文件在即齐备，不联网）。"""
    from core import asr_moss
    return os.path.isfile(asr_moss._default_model_path(quant))


def _wcpp_cached(quant):
    """whisper-cpp 档位齐备判定（二进制 .ok + 权重单文件在，不联网）。"""
    from core import asr_whispercpp
    return (asr_whispercpp._asset_ready(
                os.path.join(config.BIN_DIR, "whisper-cpp"))
            and os.path.isfile(asr_whispercpp._default_model_path(quant)))


def _dir_bytes(root):
    """目录现有字节量（递归 lstat，不存在=0）——moss 落地目录进度用，
    与 _hub_repo_bytes 同口径（链接只计链接本身）。"""
    total = 0
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            try:
                total += os.lstat(os.path.join(dirpath, f)).st_size
            except OSError:
                continue
    return total


def _hub_repo_bytes(repo):
    """repo 在 hf hub 默认缓存里的现有字节量（预下载进度分子；目录不存在=0）。
    snapshot_download 未指定 cache_dir，默认根与 huggingface_hub.constants
    一致，这里取同源值。计数用 lstat 递归——hub 1.x 新布局文件直落
    snapshots/（blobs 空），旧布局 blobs 实文件 + snapshots 符号链接，
    lstat 对链接只计链接本身，两种布局都不重不漏。"""
    from huggingface_hub.constants import HF_HUB_CACHE
    org, _, name = str(repo or "").strip().strip("/").partition("/")
    target = f"models--{org}--{name}".casefold()
    try:
        entries = list(os.scandir(HF_HUB_CACHE))
    except OSError:
        return 0
    for e in entries:
        if e.is_dir() and e.name.casefold() == target:
            return _dir_bytes(e.path)
    return 0


def _sibling_size(s):
    """repo 文件条目字节数（新版 RepoSibling 属性 / 旧版 dict 双形态兼容）。"""
    v = getattr(s, "size", None)
    if v is None and isinstance(s, dict):
        v = s.get("size")
    return int(v or 0)


def downloads_status():
    """GET 视图：各可预下载档位的 {cached}，叠加活跃/最近一次手动下载状态。"""
    from core.asr_moss import _QUANTS as _MOSS_QUANTS
    from core.asr_whispercpp import _QUANTS as _WCPP_QUANTS
    out = {}
    for tier, repo in _WHISPER_REPOS.items():
        key = f"faster-whisper:{tier}"
        st = _DOWNLOADS.get(key)
        out[key] = {"cached": _fw_cached(repo), **(dict(st) if st else {})}
    for size in QWEN3_SIZES:
        key = f"qwen3-asr:{size}"
        st = _DOWNLOADS.get(key)
        out[key] = {"cached": _qwen3_cached(size), **(dict(st) if st else {})}
    for quant in _MOSS_QUANTS:
        key = f"moss:{quant}"
        st = _DOWNLOADS.get(key)
        out[key] = {"cached": _moss_cached(quant), **(dict(st) if st else {})}
    for quant in _WCPP_QUANTS:
        key = f"whisper-cpp:{quant}"
        st = _DOWNLOADS.get(key)
        out[key] = {"cached": _wcpp_cached(quant), **(dict(st) if st else {})}
    return out


def start_download(engine, tier):
    """触发预下载（后台线程，立即返回状态快照）。进行中重复触发幂等返回
    现状；引擎/档位非法抛 ValueError（api 层转 400）。"""
    engine = str(engine or "").strip()
    if engine == "faster-whisper":
        tier = normalize_tier(tier)
        if tier not in _WHISPER_REPOS:
            raise ValueError(f"未知 whisper 档位：{tier}")
    elif engine == "qwen3-asr":
        tier = (tier or "0.6b").strip().lower()
        if tier not in QWEN3_SIZES:
            raise ValueError(f"未知 qwen3-asr 档位：{tier}（可选 {'/'.join(QWEN3_SIZES)}）")
    elif engine == "moss":
        from core.asr_moss import _QUANTS as _MOSS_QUANTS
        tier = (tier or "q4_K_M").strip()
        if tier not in _MOSS_QUANTS:
            raise ValueError(f"未知 moss 量化：{tier}（可选 {'/'.join(_MOSS_QUANTS)}）")
    elif engine == "whisper-cpp":
        from core.asr_whispercpp import _QUANTS as _WCPP_QUANTS
        tier = (tier or "q5_0").strip()
        if tier not in _WCPP_QUANTS:
            raise ValueError(
                f"未知 whisper-cpp 量化：{tier}（可选 {'/'.join(_WCPP_QUANTS)}）")
    else:
        raise ValueError(f"引擎 {engine} 无可预下载资产")
    key = f"{engine}:{tier}"
    with _DL_LOCK:
        cur = _DOWNLOADS.get(key)
        if cur and cur.get("state") == "running":
            return dict(cur)
        state = {"state": "running", "progress": 0, "source": "", "error": ""}
        _DOWNLOADS[key] = state
    threading.Thread(target=_download_worker, args=(engine, tier, state),
                     daemon=True).start()
    return dict(state)


def _download_worker(engine, tier, state):
    """下载线程体：失败如实写 state 不抛出（管理页轮询可见）。"""
    try:
        if engine == "faster-whisper":
            _download_fw(tier, state)
        elif engine == "moss":
            _download_moss(tier, state)
        elif engine == "whisper-cpp":
            _download_wcpp(tier, state)
        else:
            _download_qwen3(tier, state)
        state.update(state="done", progress=100)
        log.info("ASR 预下载完成：%s:%s", engine, tier)
    except Exception as e:
        state.update(state="failed", error=str(e)[:300])
        log.warning("ASR 预下载失败 %s:%s —— %s", engine, tier, str(e)[:300])


def _download_fw(tier, state):
    """whisper 档位：先本地判齐备（秒过），再选源（hf → hf-mirror，记入进程内
    坏源记忆同 ensure_local_model），repo 缓存增量报进度。"""
    from huggingface_hub import HfApi
    repo = _WHISPER_REPOS[tier]
    if _fw_cached(repo):
        return  # 已齐备，秒过
    api = HfApi()
    source = "hf"
    try:
        info = api.model_info(repo, files_metadata=True)
    except Exception as e:
        api = HfApi(endpoint=_HF_MIRROR)
        info = api.model_info(repo, files_metadata=True)
        source = "hf-mirror"
        log.info("ASR 预下载 %s：hf 官方源不可达（%s），转 hf-mirror", tier, str(e)[:120])
    state["source"] = source
    expected = sum(_sibling_size(s) for s in (info.siblings or []))
    stop = threading.Event()
    if expected > 0:
        def _watch():
            while not stop.wait(1.0):
                state["progress"] = min(99, round(_hub_repo_bytes(repo) / expected * 100))
        threading.Thread(target=_watch, daemon=True).start()
    try:
        api.snapshot_download(repo_id=repo)
    finally:
        stop.set()


def _download_qwen3(size, state):
    """qwen3 档位：复用首用自取（工具 + 模型 zip 解压，齐备即跳过），
    多文件整体进度 =（已完成文件数 + 当前文件比例）/ 总文件数。"""
    from core import asr_qwen3
    tool_ready = asr_qwen3._asset_ready(os.path.join(config.BIN_DIR, "qwen3-asr"))
    model_root = os.path.join(config.CACHE_DIR, "models", "qwen3-asr", size)
    if asr_qwen3._asset_ready(model_root) and tool_ready:
        return  # 齐备，秒过
    total = (0 if tool_ready else 1) + (0 if asr_qwen3._asset_ready(model_root) else
                                        (2 if size == "1.7b" else 1))
    if total == 0:
        return
    done = [0]

    def _progress(frac):
        frac = max(0.0, min(1.0, float(frac or 0)))
        if frac >= 1.0:
            done[0] += 1
            state["progress"] = min(99, round(done[0] / total * 100))
        else:
            state["progress"] = min(99, round((done[0] + frac) / total * 100))

    if not tool_ready:
        asr_qwen3._ensure_tool(progress=_progress)
    asr_qwen3._ensure_model(size, progress=_progress)


def _download_moss(quant, state):
    """moss 量化：默认路径已齐备则秒过；否则复用 asr_moss._download_model
    （hf → hf-mirror 双源 + 坏源记忆，落 backend/models/）。进度按落地目录
    字节增量报——expected 取自 model_info 元数据，元数据不可得就不报中间
    进度（不编造百分比），完成即 100。"""
    from core import asr_moss
    if _moss_cached(quant):
        return  # 已齐备，秒过
    dest = os.path.join(config.BASE_DIR, "models")
    baseline = _dir_bytes(dest)
    expected = 0
    try:
        from huggingface_hub import HfApi
        filename = asr_moss._QUANT_FILES[quant]
        info = HfApi().model_info(asr_moss._HF_REPO, files_metadata=True)
        for s in (info.siblings or []):
            name = s.get("rfilename") if isinstance(s, dict) else getattr(s, "rfilename", None)
            if name == filename:
                expected = _sibling_size(s)
                break
    except Exception:
        expected = 0

    def _mark_source(src):
        state["source"] = src

    stop = threading.Event()
    if expected > 0:
        def _watch():
            while not stop.wait(1.0):
                got = _dir_bytes(dest) - baseline
                state["progress"] = min(99, max(0, round(got / expected * 100)))
        threading.Thread(target=_watch, daemon=True).start()
    try:
        asr_moss._download_model(quant, on_source=_mark_source)
    finally:
        stop.set()


def _download_wcpp(quant, state):
    """whisper-cpp 档位：二进制（GitHub Releases zip，期望字节=实测常量）+
    权重（hf 双源单文件，期望字节=HF 元数据优先、实测常量兜底）两段资产，
    进度按各自期望字节加权合计；元数据与常量皆不可得就不报该段中间进度
    （不编造百分比，完成即 100，同 moss 口径）。"""
    from core import asr_whispercpp as wc
    if _wcpp_cached(quant):
        return  # 已齐备，秒过
    bin_root = os.path.join(config.BIN_DIR, "whisper-cpp")
    weight_path = wc._default_model_path(quant)
    bin_ready = wc._asset_ready(bin_root)
    weight_ready = os.path.isfile(weight_path)
    if bin_ready and weight_ready:
        return
    expected_w = 0
    if not weight_ready:
        filename = wc._QUANT_FILES[quant]
        for endpoint in (None, _HF_MIRROR):
            try:
                from huggingface_hub import HfApi
                info = HfApi(endpoint=endpoint).model_info(
                    wc._HF_REPO, files_metadata=True)
                for s in (info.siblings or []):
                    name = (s.get("rfilename") if isinstance(s, dict)
                            else getattr(s, "rfilename", None))
                    if name == filename:
                        expected_w = _sibling_size(s)
                        break
                if expected_w:
                    break
            except Exception:
                continue  # 元数据不可得：换源/落常量兜底
        if not expected_w:
            expected_w = wc._WEIGHT_BYTES.get(quant, 0)
    bin_bytes = 0 if bin_ready else wc._BINARY_BYTES
    w_bytes = 0 if weight_ready else expected_w
    total = bin_bytes + w_bytes
    if total == 0:
        return  # 期望全不可得：直接跑首用补拉，不报中间进度
    prog = {"bin": 1.0 if bin_ready else 0.0, "w": 1.0 if weight_ready else 0.0}
    stop = threading.Event()

    def _report():
        state["progress"] = min(
            99, max(0, round((prog["bin"] * bin_bytes + prog["w"] * w_bytes)
                             / total * 100)))

    def _gh_progress(frac):
        prog["bin"] = max(0.0, min(1.0, float(frac or 0)))
        _report()

    def _watch():
        # 权重段进度：backend/models 落地字节增量（hf_hub_download 无回调，
        # moss 同款 1s 字节观测）
        baseline = _dir_bytes(os.path.join(config.BASE_DIR, "models"))
        while not stop.wait(1.0):
            if w_bytes:
                prog["w"] = max(0.0, min(1.0, (_dir_bytes(
                    os.path.join(config.BASE_DIR, "models")) - baseline)
                    / w_bytes))
                _report()

    threading.Thread(target=_watch, daemon=True).start()
    try:
        if not bin_ready:
            state["source"] = "github"
            wc._ensure_binary(progress=_gh_progress)
        if not weight_ready:
            wc._ensure_weights(
                quant, on_source=lambda src: state.__setitem__("source", src))
    finally:
        stop.set()
