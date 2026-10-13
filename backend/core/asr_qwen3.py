# -*- coding: utf-8 -*-
"""Qwen3-ASR（Haujet GGUF）适配器：子进程 worker 客户端 + 工具/模型首用获取。

- 进程形态（评审 2026-10 §2 裁定）：混合运行时（ONNX-DML 编码器 + llama.cpp
  Vulkan 解码器 + ForceAligner）与 backend 进程隔离，走独立 python 子进程
  （core/asr_qwen3_worker.py，stdin/stdout JSON-lines）。
- 资产自管：工具与模型均取 HaujetZhao/Qwen3-ASR-GGUF 的 GitHub Releases——
  工具 zip 解压到 bin/qwen3-asr/<tag>/，模型 zip 解压到 models/qwen3-asr/<size>/，
  齐备即跳过（断点不适用 zip，残包按 .ok 标记判完整）。0.6B 与 1.7B 同一
  适配器换 model_dir；两者各自带 0.6B ForceAligner（模型包内已含）。
- 显存：0.6B ≈ 3.2GB（DML 编码 + Vulkan 解码）；纯 CPU 不可用（RTFx<0.1，
  实测 40s 音频 >6 分钟）——检测不到可用的 DirectML 时如实报错，用户回落
  faster-whisper。
- 生命周期：worker 随 AsrEngine on-demand 空闲卸载关闭（进程退出即释放显存）。
"""

import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import zipfile

import config

log = logging.getLogger(__name__)

# 资产源（GitHub Releases；tag=版本锁定，升级=改 tag）
_RELEASE_REPO = "HaujetZhao/Qwen3-ASR-GGUF"
_TOOL_TAG = "v0.1"
_TOOL_ZIP = "Qwen3-ASR-Transcribe-20260223.zip"
_MODEL_ZIPS = {  # size → (zip 名, 解压后模型子目录名)
    "0.6b": "Qwen3-ASR-0.6B-gguf.zip",
    "1.7b": "Qwen3-ASR-1.7B-gguf.zip",
}
_ALIGNER_ZIP = "Qwen3-ForceAligner-0.6B-gguf.zip"
_TOOL_URL = f"https://github.com/{_RELEASE_REPO}/releases/download/{_TOOL_TAG}/{_TOOL_ZIP}"
_MODEL_URL = f"https://github.com/{_RELEASE_REPO}/releases/download/models/{{}}"


def _gh_download(url, dest, timeout=(15, 600), progress=None):
    """GitHub Releases 直链下载（requests 流式落盘，失败抛 RuntimeError）。
    progress: 可选回调 callable(frac)，按当前文件已下比例（0..1）回报；
    Content-Length 缺失时不回报、完成时补 1.0。"""
    import requests
    tmp = dest + ".part"
    try:
        with requests.get(url, stream=True, timeout=timeout) as r:
            r.raise_for_status()
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
                    done += len(chunk)
                    if progress and total:
                        progress(min(1.0, done / total))
        os.replace(tmp, dest)
        if progress:
            progress(1.0)
    except Exception as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise RuntimeError(f"下载失败 {url}：{e}") from e


def _unzip(zip_path, dest_dir):
    """解压 zip 到 dest_dir（zipfile，条目名安全过滤防穿越）。"""
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = info.filename.replace("\\", "/")
            if name.startswith("/") or ".." in name.split("/"):
                continue  # 跳过绝对路径/穿越条目
            target = os.path.join(dest_dir, *name.split("/"))
            if info.is_dir() or name.endswith("/"):
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def _asset_ready(path):
    return os.path.isdir(path) and os.path.isfile(os.path.join(path, ".ok"))


class Qwen3Worker:
    """Qwen3-ASR worker 子进程客户端（线程安全：单飞行转写，backend 单路调度
    已保证任务串行，此处锁只防 API 并发误用）。"""

    def __init__(self, size="0.6b", dml=True):
        self.tool_dir = _ensure_tool()
        self.model_dir = _ensure_model(size)
        self.dml = dml
        self._proc = None
        self._lock = threading.Lock()
        self._req_id = 0
        self._tmpdir = tempfile.mkdtemp(prefix="qwen3-asr-")
        self._lines = None
        self._start()

    # ---- 子进程管理 ----

    def _start(self):
        worker_py = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "asr_qwen3_worker.py")
        # 协议通道 = TCP 回环（backend 监听随机口，worker 主动 connect）——
        # 引擎与其 multiprocessing 辅助进程向 stdout 打印会污染管道协议，
        # socket 独占通道；worker stdout/stderr 继承 backend 日志流。
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        argv = [sys.executable, worker_py,
                "--tool-dir", self.tool_dir, "--model-dir", self.model_dir,
                "--port", str(port)]
        if not self.dml:
            argv.append("--no-dml")
        log.info("Qwen3-ASR worker 启动：%s", " ".join(argv))
        self._proc = subprocess.Popen(argv, cwd=self.tool_dir)  # 输出继承日志流
        try:
            listener.settimeout(180)
            conn, _ = listener.accept()
        except OSError as e:
            listener.close()
            self.close()
            raise RuntimeError(f"Qwen3-ASR worker 未在 180s 内连入协议端口"
                               f"（进程可能崩溃，详见 backend 日志）：{e}") from e
        finally:
            listener.close()
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self._sock, self._wfile = conn, conn.makefile("w", encoding="utf-8",
                                                      errors="replace")
        import queue
        self._lines = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()
        # 等就绪（含引擎初始化 + 编码器预热；首次冷启 <1min）
        line = self._readline(timeout=180)
        if line is None:
            self.close()
            raise RuntimeError("Qwen3-ASR worker 未在 180s 内就绪（进程可能崩溃，"
                               "详见 backend 日志）")
        msg = json.loads(line)
        if msg.get("ok") is False:
            self.close()
            raise RuntimeError(msg.get("error") or "Qwen3-ASR worker 初始化失败")
        log.info("Qwen3-ASR worker 就绪（pid=%s）", msg.get("pid"))

    def _readline(self, timeout):
        """协议通道读一行（泵线程 + 带超时取；None=EOF/超时）。"""
        try:
            return self._lines.get(timeout=timeout)
        except Exception:
            return None

    def _pump(self):
        for line in self._sock.makefile("r", encoding="utf-8", errors="replace"):
            self._lines.put(line)
        self._lines.put(None)  # EOF 哨兵

    # ---- 推理 ----

    def transcribe_window(self, audio, sr, start, end, language=None):
        """窗口转写：audio 为 16k float32 numpy（全片），切 [start,end) 写临时
        wav 送 worker，返回绝对时间轴段 [{start,end,text}]。"""
        import numpy as np
        lo, hi = int(start * sr), min(int(end * sr), len(audio))
        win = audio[lo:hi]
        if win.size == 0:
            return []
        wav = os.path.join(self._tmpdir, f"win_{lo}.wav")
        import wave
        pcm16 = (np.clip(win, -1.0, 1.0) * 32767.0).astype("<i2")
        with wave.open(wav, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(pcm16.tobytes())
        segs = self._request({"cmd": "transcribe", "path": wav,
                              "language": language or None,
                              "duration": round(hi - lo, 3) / sr})
        out = []
        for s in segs:
            text = (s.get("text") or "").strip()
            if not text:
                continue
            out.append({"start": round(start + float(s.get("start") or 0), 3),
                        "end": round(start + float(s.get("end") or 0), 3),
                        "text": text})
        try:
            os.remove(wav)
        except OSError:
            pass
        return out

    def transcribe_file(self, path, language=None):
        """整文件转写（交互路径）：复用窗口协议，时间戳即绝对值。"""
        import wave as _wave
        dur = 0.0
        try:
            with _wave.open(path) as w:
                dur = w.getnframes() / w.getframerate()
        except Exception:
            pass
        segs = self._request({"cmd": "transcribe", "path": path,
                              "language": language or None, "duration": dur})
        return [{"start": round(float(s.get("start") or 0), 3),
                 "end": round(float(s.get("end") or 0), 3),
                 "text": (s.get("text") or "").strip()}
                for s in segs if (s.get("text") or "").strip()]

    def _request(self, payload, timeout=600):
        with self._lock:
            if self._proc is None or self._proc.poll() is not None:
                raise RuntimeError("Qwen3-ASR worker 已退出（详见 backend 日志），"
                                   "请到管理页重启 ASR")
            self._req_id += 1
            payload = dict(payload, id=self._req_id)
            self._wfile.write(json.dumps(payload, ensure_ascii=False) + "\n")
            self._wfile.flush()
            line = self._readline(timeout=timeout)
            if line is None:
                self.close()
                raise RuntimeError("Qwen3-ASR worker 响应超时/退出（详见 backend 日志）")
            msg = json.loads(line)
            if not msg.get("ok"):
                raise RuntimeError(f"Qwen3-ASR 转写失败：{msg.get('error')}")
            return msg.get("segments") or []

    def close(self):
        """结束 worker（进程退出即释放 GPU 显存；on-demand 空闲卸载入口）。"""
        proc, sock, wfile = self._proc, getattr(self, "_sock", None), getattr(self, "_wfile", None)
        self._proc = None
        if wfile is not None:
            try:
                if proc is not None and proc.poll() is None:
                    wfile.write(json.dumps({"cmd": "quit"}) + "\n")
                    wfile.flush()
                    proc.wait(timeout=10)
            except Exception:
                pass
            try:
                wfile.close()
            except Exception:
                pass
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass
        if proc is not None and proc.poll() is None:
            proc.kill()
        shutil.rmtree(self._tmpdir, ignore_errors=True)


# ---- 资产获取（首用下载解压；齐备即跳过） ----


def _ensure_tool(progress=None):
    """工具本体就绪 → 返回 Qwen3-ASR-Transcribe 根目录。progress 透传给下载。"""
    root = os.path.join(config.BIN_DIR, "qwen3-asr")
    tool = os.path.join(root, "Qwen3-ASR-Transcribe")
    if _asset_ready(root):
        return tool
    os.makedirs(root, exist_ok=True)
    zip_path = os.path.join(root, _TOOL_ZIP)
    if not os.path.isfile(zip_path):
        log.info("Qwen3-ASR 工具未就绪，开始下载 %s（约 103MB）", _TOOL_URL)
        _gh_download(_TOOL_URL, zip_path, progress=progress)
    log.info("Qwen3-ASR 工具解压 → %s", tool)
    _unzip(zip_path, root)
    open(os.path.join(root, ".ok"), "w").close()
    os.remove(zip_path)
    if not os.path.isdir(tool):
        raise RuntimeError(
            f"Qwen3-ASR 工具解压后未找到预期目录（{tool}）——发布包结构可能已变，"
            "请检查 release 资产")
    return tool


def _ensure_model(size, progress=None):
    """模型包就绪（0.6b/1.7b）→ 返回模型目录。size 归一小写。progress 透传。"""
    size = (size or "0.6b").strip().lower()
    if size not in _MODEL_ZIPS:
        raise ValueError(f"未知 Qwen3-ASR 档位：{size}（可选 {'/'.join(_MODEL_ZIPS)}）")
    root = os.path.join(config.CACHE_DIR, "models", "qwen3-asr", size)
    if _asset_ready(root):
        return root
    os.makedirs(root, exist_ok=True)
    zips = [_MODEL_ZIPS[size]]
    if size == "1.7b":
        zips.append(_ALIGNER_ZIP)  # 1.7B 包不含 0.6B Aligner，另取
    for name in zips:
        url = _MODEL_URL.format(name)
        zip_path = os.path.join(root, name)
        if not os.path.isfile(zip_path):
            log.info("Qwen3-ASR 模型包未就绪，开始下载 %s", url)
            _gh_download(url, zip_path, progress=progress)
        log.info("Qwen3-ASR 模型包解压 → %s", root)
        _unzip(zip_path, root)
        os.remove(zip_path)
    open(os.path.join(root, ".ok"), "w").close()
    return root
