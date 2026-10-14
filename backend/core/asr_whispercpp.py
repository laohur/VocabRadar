# -*- coding: utf-8 -*-
"""whisper.cpp 适配器：子进程 CLI（官方 win-cuda 预编译 + 官方 ggml 权重）。

- 评审 2026-10 §1.3b 第 4 适配器候选（WcppAdapter，2026-10-14 接入）：
  whisper.cpp b5454（2026-10-06）官方 win-cuda-12.4 x64 预编译（sm_120 经
  PTX JIT 实测可用）+ FlashAttention `-fa`，RTFx ~36x / 显存净 1057MB，
  质量与 fw-CT2 fp16 统计持平；每调用一拉子进程（模型冷载 ~0.55s，vpipe
  产线同形态已验证）。**禁 `-nt`**：无时间戳模式丢中段（en 137/221 tokens
  实测），基准与产线红线。
- 仅 GPU 档（2026-10-14 用户裁定）：CUDA 二进制包 685MB（cublas/cudart/
  nvrtc DLL 全随包自带，不需 pip cuBLAS，不污染系统）；无 CUDA 设备如实
  拒绝并指回落 faster-whisper（评审口径 fw 即无 GPU 回落档）。
- 资产自管（评审 §2.1）：二进制取 GitHub Releases（bin/whisper-cpp/，
  .ok 标记判完整）；权重取 hf 官方 ggerganov/whisper.cpp → hf-mirror 双源
  （backend/models/，同 moss 口径）。q5_0 唯一档：q4_0 有损（fr 30.5/hi
  44.7）、q8_0 未本地基准，均不接入。
- 生命周期：无常驻进程/显存句柄（每窗一拉子进程，退出即释放），close 只
  清理临时目录；on-demand 空闲卸载即零持有。
"""

import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import wave
import zipfile

import config

log = logging.getLogger(__name__)

# 量化档 → ggml 权重文件名（ggerganov/whisper.cpp 官方命名）
_QUANT_FILES = {"q5_0": "ggml-large-v3-turbo-q5_0.bin"}
_QUANTS = tuple(_QUANT_FILES)

# 权重补拉源：hf 官方 → hf-mirror（同 asr_moss 思路，坏源记忆各持一份，
# 避免跨模块耦合——最多多付一次探活超时）
_HF_REPO = "ggerganov/whisper.cpp"
_HF_MIRROR = "https://hf-mirror.com"
_ENDPOINT_STATE = {"hf": None}

# 二进制（GitHub Releases，tag=版本锁定，升级=改 tag+核对字节数）：b5454
# 官方 win-cuda-12.4 x64 包，cublas64_12/cublasLt64_12/cudart64_12/nvrtc
# 随包，解压即用
_BINARY_TAG = "b5454"
_BINARY_ZIP = "whisper-bin-win-cuda-12.4.0-x64.zip"
_BINARY_URL = ("https://github.com/ggml-org/whisper.cpp/releases/download/"
               + _BINARY_TAG + "/" + _BINARY_ZIP)
_BINARY_BYTES = 684_913_404   # 2026-10-14 实测（与本地基准 zip 逐字节一致）
_WEIGHT_BYTES = {"q5_0": 574_041_195}  # 本地基准实测；进度兜底（HF 元数据优先）

# 纯函数助手复用 qwen3 同款（流式下载 .part→原子落盘 / zip 安全解压 / .ok
# 判定），避免二处重复
from core.asr_qwen3 import _asset_ready, _gh_download, _unzip  # noqa: E402


def _require_cuda():
    """仅 GPU 档门禁：无 CUDA 设备（或非 Windows）如实拒绝，指回落 fw。"""
    if os.name != "nt":
        raise RuntimeError(
            "whisper-cpp 仅提供 Windows x64 CUDA 预编译；当前平台不可用，"
            "请回落 faster-whisper")
    try:
        import ctranslate2
        n = ctranslate2.get_cuda_device_count()
    except Exception:
        n = 0
    if n <= 0:
        raise RuntimeError(
            "whisper-cpp 需要 NVIDIA GPU（CUDA 预编译，评审 §1.3b）；"
            f"检测到 CUDA 设备 {n} 个，请回落 faster-whisper（CPU 档）")


class WcppEngine:
    """whisper.cpp CLI 封装（每窗一拉子进程；锁串行化防显存叠加）。"""

    def __init__(self, quant="q5_0"):
        quant = (quant or "q5_0").strip()
        if quant not in _QUANTS:
            raise ValueError(
                f"未知 whisper.cpp 量化：{quant}（可选 {'/'.join(_QUANTS)}）")
        _require_cuda()
        self.quant = quant
        self._bin_root = _ensure_binary()
        self._cli = os.path.join(self._bin_root, "Release", "whisper-cli.exe")
        self.model_path = _ensure_weights(quant)
        self._lock = threading.Lock()
        self._seq = 0
        self._tmpdir = tempfile.mkdtemp(prefix="whisper-cpp-")
        log.info("whisper.cpp 就绪：cli=%s model=%s", self._cli, self.model_path)

    def transcribe_window(self, audio, sr, start, end, language=None):
        """窗口转写：audio 为 16k float32 numpy 全片，切 [start,end) 写临时
        wav 拉子进程，返回绝对时间轴段 [{start,end,text}]。"""
        import numpy as np
        lo, hi = int(start * sr), min(int(end * sr), len(audio))
        win = audio[lo:hi]
        if win.size == 0:
            return []
        with self._lock:
            return self._run_cli(win, sr, start, language)

    def transcribe_file(self, path, language=None):
        """整文件转写（交互路径）：直读 16k wav（扩展端上传即此形态）；非 16k
        wav 或非 wav（/v1 端点任意上传）落 PyAV decode_audio 解码+重采样。"""
        import numpy as np
        pcm = None
        try:
            with wave.open(path) as w:
                if w.getframerate() == 16000:
                    raw = w.readframes(w.getnframes())
                    data = np.frombuffer(raw, dtype="<i2")
                    if w.getnchannels() > 1:
                        data = data.reshape(-1, w.getnchannels()).mean(axis=1)
                    pcm = data.astype("float32") / 32768.0
        except Exception:
            pcm = None
        if pcm is None:
            from faster_whisper.audio import decode_audio
            pcm = decode_audio(path, sampling_rate=16000)
        if pcm is None or pcm.size == 0:
            return []
        with self._lock:
            return self._run_cli(pcm, 16000, 0.0, language)

    def _run_cli(self, pcm, sr, offset, language):
        import numpy as np
        if sr != 16000:
            raise ValueError(f"whisper.cpp 引擎要求 16kHz 音频，收到 {sr}")
        self._seq += 1
        base = os.path.join(self._tmpdir, "run%d" % self._seq)
        wav = base + ".wav"
        pcm16 = (np.clip(pcm, -1.0, 1.0) * 32767.0).astype("<i2")
        with wave.open(wav, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(pcm16.tobytes())
        dur = pcm.size / float(sr)
        # 命令行 = vpipe 产线原文（评审 §1.3b 实测口径）；-nt 禁用
        argv = [self._cli, "-m", self.model_path, "-f", wav,
                "-l", language or "auto", "-fa", "-osrt", "-of", base]
        timeout = max(600, int(dur * 5))
        log.info("whisper.cpp 转写：%.1fs 音频（lang=%s）", dur, language or "auto")
        try:
            r = subprocess.run(argv, capture_output=True, text=True,
                               encoding="utf-8", errors="replace",
                               timeout=timeout)
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(
                f"whisper.cpp 转写超时（{dur:.0f}s 音频超出 {timeout}s 护栏，"
                "详见 backend 日志）") from e
        finally:
            try:
                os.remove(wav)
            except OSError:
                pass
        if r.returncode != 0:
            raise RuntimeError(
                f"whisper.cpp 转写失败（exit {r.returncode}）："
                f"{(r.stderr or r.stdout or '')[-300:]}")
        srt = base + ".srt"
        try:
            with open(srt, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            return []  # 无语音段：whisper-cli 不产出 srt（如实空返回）
        out = [{"start": round(offset + t0, 3), "end": round(offset + t1, 3),
                "text": body}
               for t0, t1, body in _parse_srt(text)]
        try:
            os.remove(srt)
        except OSError:
            pass
        return out

    def close(self):
        """清理临时目录（无常驻进程/显存句柄；on-demand 空闲卸载入口）。"""
        shutil.rmtree(getattr(self, "_tmpdir", ""), ignore_errors=True)


def _parse_srt(text):
    """SRT 文本 → [(t0, t1, text)]（秒）。坏块跳过不整链失败。"""
    stamp = re.compile(
        r"(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*"
        r"(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})")

    def _sec(h, m, s, ms):
        return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000.0

    out = []
    for block in re.split(r"\n\s*\n", (text or "").strip()):
        m = stamp.search(block)
        if not m:
            continue
        lines = block.splitlines()
        idx = next(i for i, ln in enumerate(lines) if stamp.search(ln))
        body = " ".join(ln.strip() for ln in lines[idx + 1:]).strip()
        if not body:
            continue
        g = m.groups()
        out.append((_sec(*g[:4]), _sec(*g[4:]), body))
    return out


# ---- 资产获取（首用下载；齐备即跳过，同 qwen3/moss 口径） ----


def _ensure_binary(progress=None):
    """CUDA 预编译包就绪 → 解压根 bin/whisper-cpp/（含 Release/whisper-cli.exe
    与全套 CUDA DLL）。齐备（.ok）即跳过；zip 断点不适用，残包按 .ok 判。"""
    root = os.path.join(config.BIN_DIR, "whisper-cpp")
    if _asset_ready(root):
        return root
    os.makedirs(root, exist_ok=True)
    zip_path = os.path.join(root, _BINARY_ZIP)
    if not os.path.isfile(zip_path):
        log.info("whisper.cpp 二进制未就绪，开始下载 %s（约 %dMB）",
                 _BINARY_URL, _BINARY_BYTES >> 20)
        _gh_download(_BINARY_URL, zip_path, progress=progress)
    log.info("whisper.cpp 二进制解压 → %s", root)
    _unzip(zip_path, root)
    open(os.path.join(root, ".ok"), "w").close()
    os.remove(zip_path)
    if not os.path.isfile(os.path.join(root, "Release", "whisper-cli.exe")):
        raise RuntimeError(
            "whisper.cpp 解压后未找到 Release/whisper-cli.exe——发布包结构可能"
            "已变，请检查 release 资产")
    return root


def _default_model_path(quant):
    return os.path.join(config.BASE_DIR, "models", _QUANT_FILES[quant])


def _ensure_weights(quant, on_source=None):
    """权重 ggml 就绪 → 绝对路径。默认路径（backend/models/）缺失时联网补拉：
    hf 官方 → hf-mirror 双源（huggingface_hub 自管断点续传/完整性）。全败抛
    RuntimeError（文案带已验证直链，不遮蔽）。on_source 回调记录选中源。"""
    path = _default_model_path(quant)
    if os.path.isfile(path) and os.path.getsize(path) > 0:
        return path
    from huggingface_hub import HfApi, hf_hub_download
    filename = _QUANT_FILES[quant]
    dest = os.path.join(config.BASE_DIR, "models")
    last = None
    for name, endpoint in (("hf", None), ("hf-mirror", _HF_MIRROR)):
        if name == "hf" and _ENDPOINT_STATE["hf"] is False:
            continue  # 本进程已判死：跳过直连
        try:
            if on_source:
                on_source(name)
            log.info("whisper.cpp 权重补拉：%s（源 %s，落 %s）",
                     filename, name, dest)
            api = HfApi(endpoint=endpoint) if endpoint else HfApi()
            out = api.hf_hub_download(repo_id=_HF_REPO, filename=filename,
                                      local_dir=dest)
            if name == "hf":
                _ENDPOINT_STATE["hf"] = True
            log.info("whisper.cpp 权重就绪：%s", out)
            return out if os.path.isabs(out) else os.path.abspath(out)
        except Exception as e:
            last = e
            log.warning("whisper.cpp 权重源 %s 失败：%s", name, str(e)[:200])
            if name == "hf":
                _ENDPOINT_STATE["hf"] = False
    raise RuntimeError(
        f"whisper.cpp 权重自动下载失败（hf 与 hf-mirror 均不可达，请检查网络后"
        f"重启引擎重试）。也可手动下载（直链已验证）："
        f"https://hf-mirror.com/{_HF_REPO}/resolve/main/{filename} 放到 {dest}。"
        f"原因：{str(last)[:200]}")
