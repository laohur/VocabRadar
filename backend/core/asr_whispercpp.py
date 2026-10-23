# -*- coding: utf-8 -*-
"""whisper.cpp 适配器：常驻 server（官方 win-cuda 预编译 + 官方 ggml 权重）。

- 评审 2026-10 §1.3b 第 4 适配器候选（WcppAdapter，2026-10-14 接入）：whisper.cpp
  b5454（2026-10-06）官方 win-cuda-12.4 x64 预编译（sm_120 经 PTX JIT 实测可用）
  + FlashAttention，质量与 fw-CT2 fp16 统计持平。**禁 -nt**：无时间戳模式丢中段
  （en 137/221 tokens 实测），基准与产线红线。
- 第564次形态重裁定（用户）：模型服务不得逐请求重载——接入时的「每窗一拉
  CLI 子进程（冷载 ~0.55s/窗）」作废，改常驻 whisper-server（同包自带
  whisper-server.exe）：引擎首用拉起、模型载一次，调用走本机 HTTP /inference
  （verbose_json 直出 segments，SRT 解析退役），close/空闲卸载杀进程归零显存
  ——「零持有」退回空闲层，与 fw/qwen3/moss 生命周期对齐。实测 b5454 server：
  verbose_json 含 {start,end,text,no_speech_prob}（时间相对上传片段，offset
  平移照旧），language 逐请求可传（auto 合法），/health 存活探针；进程崩溃
  由连接失败检测重拉一次兜底。no_speech_prob 对 turbo 恒 0.000（实测）不可
  作幻觉过滤依据，过滤仍归调用层（_looks_hallucinated 口径）。
- 第564次（续）静音幻觉根治（用户裁定）：server 启动带 silero VAD
  （--vad --vad-model ggml-silero-v6.2.0.bin，~0.9MB 双源自管）——静音在
  解码前剥除，"Thank you." 类幻觉无从产生且静音段零解码开销；实测时间戳
  原轴保真（5s 静音+人声 → 段落 [5.15-9.21]）、纯静音 4s → 0 段。
- 仅 GPU 档（2026-10-14 用户裁定）：CUDA 二进制包 685MB（cublas/cudart/
  nvrtc DLL 全随包自带，不需 pip cuBLAS，不污染系统）；无 CUDA 设备如实
  拒绝并指回落 faster-whisper（评审口径 fw 即无 GPU 回落档）。
- 资产自管（评审 §2.1）：二进制取 GitHub Releases（bin/whisper-cpp/，
  .ok 标记判完整）；权重取 hf 官方 ggerganov/whisper.cpp → hf-mirror 双源
  （backend/models/，同 moss 口径）。q5_0 唯一档：q4_0 有损（fr 30.5/hi
  44.7）、q8_0 未本地基准，均不接入。
"""

import json
import logging
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid
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
# 随包，解压即用（whisper-server.exe 同包在 Release/ 内）
_BINARY_TAG = "b5454"
_BINARY_ZIP = "whisper-bin-win-cuda-12.4.0-x64.zip"
_BINARY_URL = ("https://github.com/ggml-org/whisper.cpp/releases/download/"
               + _BINARY_TAG + "/" + _BINARY_ZIP)
_BINARY_BYTES = 684_913_404   # 2026-10-14 实测（与本地基准 zip 逐字节一致）
_WEIGHT_BYTES = {"q5_0": 574_041_195}  # 本地基准实测；进度兜底（HF 元数据优先）

# server 就绪等待上限（模型冷载 ~0.6s 实测，留足慢盘余量）
_STARTUP_TIMEOUT_SEC = 60

# 第564次（续）静音幻觉根治：server 内置 silero VAD（上游 ggml-org/whisper-vad，
# b5454 自带测试模型即 v6.2.0，实测逐字节同尺寸）。实测（2026-10-22）：纯静音
# 4s → 0 段（"Thank you." 无从产生）；5s 静音+人声 → 段落 [5.15-9.21] 原轴
# 保真；静音段不解码（0.15s/次）。hf 官方 → hf-mirror 双源（同权重口径）。
_VAD_FILE = "ggml-silero-v6.2.0.bin"
_VAD_HF_REPO = "ggml-org/whisper-vad"

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
    """whisper.cpp 常驻 server 封装：引擎首用拉起、逐请求 HTTP、close 杀进程。

    server 本身逐请求串行处理，_lock 保持调用侧串行化不变；进程崩溃由
    连接失败检测 → 重拉一次 → 再失败如实上抛（错误附 server 日志尾部，
    不遮蔽）。"""

    def __init__(self, quant="q5_0"):
        quant = (quant or "q5_0").strip()
        if quant not in _QUANTS:
            raise ValueError(
                f"未知 whisper.cpp 量化：{quant}（可选 {'/'.join(_QUANTS)}）")
        _require_cuda()
        self.quant = quant
        self._bin_root = _ensure_binary()
        self._bin_dir = os.path.join(self._bin_root, "Release")
        self._server_exe = os.path.join(self._bin_dir, "whisper-server.exe")
        self.model_path = _ensure_weights(quant)
        self._lock = threading.Lock()
        self._seq = 0
        self._tmpdir = tempfile.mkdtemp(prefix="whisper-cpp-")
        self._proc = None
        self._port = 0
        self._log_f = None
        self._log_path = os.path.join(self._tmpdir, "server.log")
        self._closed = False  # close() 置位：防停机打断在途调用时重拉孤儿 server
        self._vad_path = _ensure_vad_model()
        self._start_server()
        log.info("whisper.cpp 就绪：server=127.0.0.1:%d model=%s",
                 self._port, self.model_path)

    # ---- server 生命周期 ----

    def _start_server(self):
        """拉起 whisper-server（模型载一次）：动态端口 + /health 就绪轮询。"""
        self._kill_server()
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self._port = s.getsockname()[1]
        self._log_f = open(self._log_path, "ab")
        self._proc = subprocess.Popen(
            [self._server_exe, "-m", self.model_path,
             "--vad", "--vad-model", self._vad_path,
             "--host", "127.0.0.1", "--port", str(self._port)],
            stdout=self._log_f, stderr=subprocess.STDOUT, cwd=self._bin_dir)
        deadline = time.time() + _STARTUP_TIMEOUT_SEC
        while time.time() < deadline:
            if self._proc.poll() is not None:
                raise RuntimeError(
                    f"whisper-server 启动即退出（exit {self._proc.returncode}）："
                    + self._log_tail())
            try:
                urllib.request.urlopen(self._health_url(), timeout=2)
                self._closed = False  # 重拉成功即恢复可重试态
                return  # 端口应答即模型已载毕（server 载完才监听）
            except Exception:
                time.sleep(0.2)
        self._kill_server()
        raise RuntimeError("whisper-server %ds 未就绪：%s"
                           % (_STARTUP_TIMEOUT_SEC, self._log_tail()))

    def _kill_server(self):
        proc = getattr(self, "_proc", None)
        self._proc = None
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        f = getattr(self, "_log_f", None)
        self._log_f = None
        if f is not None:
            try:
                f.close()
            except OSError:
                pass

    def _health_url(self):
        return "http://127.0.0.1:%d/health" % self._port

    def _log_tail(self):
        try:
            with open(self._log_path, "rb") as f:
                return f.read()[-500:].decode("utf-8", "replace")
        except OSError:
            return "（server 日志不可读）"

    # ---- 推理 ----

    def transcribe_window(self, audio, sr, start, end, language=None):
        """窗口转写：audio 为 16k float32 numpy 全片，切 [start,end) 写临时
        wav 发本机 server，返回绝对时间轴段 [{start,end,text}]。"""
        import numpy as np
        lo, hi = int(start * sr), min(int(end * sr), len(audio))
        win = audio[lo:hi]
        if win.size == 0:
            return []
        with self._lock:
            return self._run_server(win, sr, start, language)

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
            return self._run_server(pcm, 16000, 0.0, language)

    def _run_server(self, pcm, sr, offset, language):
        import numpy as np
        if self._closed:
            raise RuntimeError("whisper.cpp 引擎已关停（close 后不可再转写）")
        if sr != 16000:
            raise ValueError(f"whisper.cpp 引擎要求 16kHz 音频，收到 {sr}")
        self._seq += 1
        wav = os.path.join(self._tmpdir, "run%d.wav" % self._seq)
        pcm16 = (np.clip(pcm, -1.0, 1.0) * 32767.0).astype("<i2")
        with wave.open(wav, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(pcm16.tobytes())
        dur = pcm.size / float(sr)
        timeout = max(600, int(dur * 5))
        log.info("whisper.cpp 转写：%.1fs 音频（lang=%s）", dur, language or "auto")
        try:
            try:
                with open(wav, "rb") as f:
                    segs = self._post_inference(f, language, timeout)
            except Exception as e:
                if getattr(self, "_closed", False):
                    raise  # 引擎已被 close/停机：不重拉（防孤儿 server 占显存）
                # server 崩溃/掉线兜底：重拉一次（模型载一次语义不变）再试，
                # 再败如实上抛。转写日志尾已落 server.log 可查。
                log.warning("whisper-server 调用失败，重拉进程重试：%s",
                            str(e)[:200])
                self._start_server()
                with open(wav, "rb") as f:
                    segs = self._post_inference(f, language, timeout)
        finally:
            try:
                os.remove(wav)
            except OSError:
                pass
        # 空文本段不收（与原 SRT 路径坏块跳过同口径）；时间平移回绝对轴
        return [{"start": round(offset + float(s["start"]), 3),
                 "end": round(offset + float(s["end"]), 3),
                 "text": (s.get("text") or "").strip()}
                for s in segs if (s.get("text") or "").strip()]

    def _post_inference(self, fobj, language, timeout):
        """multipart POST /inference（verbose_json）→ segments 列表。"""
        boundary = "----wcpp" + uuid.uuid4().hex
        parts = [
            ("--%s\r\nContent-Disposition: form-data; name=\"file\"; "
             "filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
             % boundary).encode() + fobj.read() + b"\r\n",
            ("--%s\r\nContent-Disposition: form-data; name=\"response_format\""
             "\r\n\r\nverbose_json\r\n" % boundary).encode(),
            ("--%s\r\nContent-Disposition: form-data; name=\"language\""
             "\r\n\r\n%s\r\n" % (boundary, language or "auto")).encode(),
            ("--%s--\r\n" % boundary).encode(),
        ]
        req = urllib.request.Request(
            "http://127.0.0.1:%d/inference" % self._port,
            data=b"".join(parts),
            headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read().decode("utf-8", "replace"))
        return out.get("segments") or []

    def close(self):
        """杀 server 进程 + 清理临时目录（空闲卸载/关停入口；显存在此归零）。
        置位 _closed：在途调用不再触发重拉（见 _run_server 兜底分支）。"""
        self._closed = True
        self._kill_server()
        shutil.rmtree(getattr(self, "_tmpdir", ""), ignore_errors=True)


# ---- 资产获取（首用下载；齐备即跳过，同 qwen3/moss 口径） ----


def _default_vad_path():
    return os.path.join(config.BASE_DIR, "models", _VAD_FILE)


def _ensure_vad_model():
    """silero VAD ggml 就绪 → 绝对路径；缺失时 hf 官方 → hf-mirror 双源补拉
    （~0.9MB）。全败抛 RuntimeError（文案带直链，不遮蔽）——VAD 是静音幻觉
    根治件，宁可拒启不可静默退场（无 VAD 即回到 "Thank you." 时代）。"""
    path = _default_vad_path()
    if os.path.isfile(path) and os.path.getsize(path) > 0:
        return path
    from huggingface_hub import HfApi, hf_hub_download
    dest = os.path.join(config.BASE_DIR, "models")
    last = None
    for name, endpoint in (("hf", None), ("hf-mirror", _HF_MIRROR)):
        if name == "hf" and _ENDPOINT_STATE["hf"] is False:
            continue  # 本进程已判死：跳过直连（与权重共用同一探活记忆）
        try:
            log.info("whisper VAD 模型补拉：%s（源 %s，落 %s）",
                     _VAD_FILE, name, dest)
            api = HfApi(endpoint=endpoint) if endpoint else HfApi()
            out = api.hf_hub_download(repo_id=_VAD_HF_REPO, filename=_VAD_FILE,
                                      local_dir=dest)
            log.info("whisper VAD 模型就绪：%s", out)
            return out if os.path.isabs(out) else os.path.abspath(out)
        except Exception as e:
            last = e
            log.warning("whisper VAD 模型源 %s 失败：%s", name, str(e)[:200])
            if name == "hf":
                _ENDPOINT_STATE["hf"] = False
    raise RuntimeError(
        f"whisper VAD 模型自动下载失败（hf 与 hf-mirror 均不可达，请检查网络后"
        f"重启引擎重试）。也可手动下载（直链已验证）："
        f"https://hf-mirror.com/{_VAD_HF_REPO}/resolve/main/{_VAD_FILE} "
        f"放到 {dest}。原因：{str(last)[:200]}")


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
