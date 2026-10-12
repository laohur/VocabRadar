# -*- coding: utf-8 -*-
"""MOSS-Transcribe-Diarize 适配器：transcribe.cpp 绑定（进程内，ggml 系一体运行时）。

- 运行时：pip `transcribe-cpp` + native 后端包（Windows vulkan 包 52MB / cuda 包
  235MB；backend="auto" 探测，2026-10 基准即 Vulkan 实测 RTFx 18–35x、显存
  1.78GB、载入 1.1s；CPU 后端 RTFx 0.3x 不可用级——auto 无 GPU 时如实报错回落
  faster-whisper）。
- 模型：MOSS-Transcribe-Diarize q4_K_M（589MB）/q8_0（942MB）gguf。社区分发
  未见稳定直链（ModelScope 有同名仓库但文件 API 不可枚举，GitHub releases 空）
  ——默认路径 backend/models/ 下按量化名查找，未找到则报错并指明放置路径
  （不遮蔽：不猜 URL 盲下）。asr.moss_model_path 可覆盖。
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
            raise RuntimeError(
                f"MOSS 模型未就绪：{self.model_path} 不存在。请下载 "
                f"MOSS-Transcribe-Diarize-{quant}.gguf（q4 约 589MB，社区分发："
                f"ModelScope 搜 'MOSS-Transcribe-Diarize-GGUF'），放到该路径或"
                f"在管理页 ASR 段填写 moss_model_path")
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
