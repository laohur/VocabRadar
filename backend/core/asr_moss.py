# -*- coding: utf-8 -*-
"""MOSS-Transcribe-Diarize 适配器：transcribe.cpp 绑定（进程内，ggml 系一体运行时）。

- 运行时：pip `transcribe-cpp` + native 后端包（Windows vulkan 包 52MB / cuda 包
  235MB；backend="auto" 探测，2026-10 基准即 Vulkan 实测 RTFx 18–35x、显存
  1.78GB、载入 1.1s；CPU 后端 RTFx 0.3x 不可用级——auto 无 GPU 时如实报错回落
  faster-whisper）。
- 模型：MOSS-Transcribe-Diarize q4_K_M（589MB）/q8_0（941MB）gguf。HF 有
  稳定分发（handy-computer/moss-transcribe-diarize-gguf，library 即
  transcribe.cpp，q4/q8 文件名与官方量化命名一致，直链已验证 200）：
  默认路径缺失时自动补拉（hf 官方 → hf-mirror 双源，落 backend/models/，
  .gitignore 已盖该目录）；moss_model_path 显式路径仍只查找不下载——
  用户指定路径不代下，未就绪即报错（不遮蔽）。
- 唯一带说话人分离的引擎（diarize="on"）：speaker_id 随段返回，字幕暂不透出
  （扩展端段落结构无说话人字段），缓存条目留待后续需要时启用。
"""

import logging
import os

import config

log = logging.getLogger(__name__)

# 量化名 → gguf 文件名（MOSS 官方命名）
_QUANT_FILES = {
    "q4_K_M": "MOSS-Transcribe-Diarize-Q4_K_M.gguf",
    "q8_0": "MOSS-Transcribe-Diarize-Q8_0.gguf",
}
_QUANTS = tuple(_QUANT_FILES)

# 自动补拉源（2026-10-13 实查：该仓库 library 标注 transcribe.cpp，q4_K_M
# 617,345,728 B / q8_0 986,900,160 B，与官方命名精确一致；hf 与 hf-mirror
# resolve 直链均已验证 200、长度吻合——非盲猜 URL）
_HF_REPO = "handy-computer/moss-transcribe-diarize-gguf"
_HF_MIRROR = "https://hf-mirror.com"
# 坏源结论进程内记住（None=未试 / True=可用 / False=已判死），同 fw
# ensure_local_model 思路；与 asr.py 各持一份（避免跨模块耦合，最多多付
# 一次探活超时）
_ENDPOINT_STATE = {"hf": None}


class MossEngine:
    """transcribe_cpp 进程内封装（线程安全：转写单路由 backend 调度保证，
    锁仅防 API 并发误用）。"""

    def __init__(self, quant="q4_K_M", model_path=None):
        quant = (quant or "q4_K_M").strip()
        if quant not in _QUANTS:
            raise ValueError(f"未知 MOSS 量化：{quant}（可选 {'/'.join(_QUANTS)}）")
        self.quant = quant
        self.model_path = model_path or _default_model_path(quant)
        if not os.path.isfile(self.model_path):
            if model_path:
                raise RuntimeError(
                    f"MOSS 模型未就绪：{self.model_path} 不存在。moss_model_path "
                    f"显式路径只查找不自动下载；若想自动补拉请留空该配置"
                    f"（走 backend/models/ 默认路径）")
            self.model_path = _download_model(quant)
        import transcribe_cpp as tc
        self._tc = tc
        log.info("MOSS-Transcribe 加载：%s（backend=auto）", self.model_path)
        self.model = tc.Model(self.model_path, backend="auto")

    def transcribe_window(self, audio, sr, start, end, language=None):
        """窗口转写：audio 为 float32 numpy 全片，切 [start,end) 送识别，
        返回绝对时间轴段 [{start,end,text}]。"""
        lo, hi = int(start * sr), min(int(end * sr), len(audio))
        pcm = audio[lo:hi]
        if pcm.size == 0:
            return []
        return self._transcribe_pcm(pcm, sr, start)

    def transcribe_file(self, path, language=None):
        """整文件转写（交互路径）：读 wav（16k s16，backend 临时产物）转写。"""
        import wave
        import numpy as np
        with wave.open(path) as w:
            sr = w.getframerate()
            raw = w.readframes(w.getnframes())
        data = np.frombuffer(raw, dtype="<i2")
        if w.getnchannels() > 1:
            data = data.reshape(-1, w.getnchannels()).mean(axis=1)
        return self._transcribe_pcm(data.astype("float32") / 32768.0, sr, 0.0)

    def _transcribe_pcm(self, pcm, sr, offset):
        if sr != 16000:
            raise ValueError(f"MOSS 引擎要求 16kHz 音频，收到 {sr}")
        r = self._tc.transcribe(self.model, pcm, backend="auto",
                                diarize="on", timestamps="segment")
        out = []
        for seg in (getattr(r, "segments", None) or []):
            text = (getattr(seg, "text", "") or "").strip()
            if not text:
                continue
            out.append({
                "start": round(offset + (getattr(seg, "t0_ms", 0) or 0) / 1000.0, 3),
                "end": round(offset + (getattr(seg, "t1_ms", 0) or 0) / 1000.0, 3),
                "text": text,
            })
        return out

    def close(self):
        """释放模型（进程内引用置空即回收；on-demand 空闲卸载入口）。"""
        self.model = None
        self._tc = None


def _default_model_path(quant):
    return os.path.join(config.BASE_DIR, "models",
                        _QUANT_FILES[quant])


def _download_model(quant, on_source=None):
    """默认路径无 gguf 时联网补拉，返回实际落地路径。

    hf 官方 → hf-mirror 双源（同 fw ensure_local_model 三源思路的进程内
    版），落 backend/models/（.gitignore 已盖，不入 git）；huggingface_hub
    自管断点续传/并发锁/完整性。官方失败转镜像；on_source 可选回调记录
    实际选中的源（预下载状态用）。全败抛 RuntimeError——文案带已验证的
    手动直链与放置目录（不遮蔽：给得出处的 URL，非盲链）。"""
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
            log.info("MOSS gguf 补拉：%s（源 %s，落 %s）", filename, name, dest)
            api = HfApi(endpoint=endpoint) if endpoint else HfApi()
            out = api.hf_hub_download(repo_id=_HF_REPO, filename=filename,
                                      local_dir=dest)
            if name == "hf":
                _ENDPOINT_STATE["hf"] = True
            log.info("MOSS gguf 就绪：%s", out)
            return out
        except Exception as e:
            last = e
            log.warning("MOSS gguf 源 %s 失败：%s", name, str(e)[:200])
            if name == "hf":
                _ENDPOINT_STATE["hf"] = False
    raise RuntimeError(
        f"MOSS 模型自动下载失败（hf 与 hf-mirror 均不可达，请检查网络后重启"
        f"引擎重试）。也可手动下载（直链已验证）："
        f"https://hf-mirror.com/{_HF_REPO}/resolve/main/{filename} 放到 {dest}。"
        f"原因：{str(last)[:200]}")
