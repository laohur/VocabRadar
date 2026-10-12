# -*- coding: utf-8 -*-
"""Qwen3-ASR（Haujet GGUF 工具）转写 worker：独立子进程，TCP 回环 JSON-lines 协议。

进程形态裁定（后端 ASR 接入评审 2026-10 §2）：Qwen3 混合运行时（ONNX-DML 编码器
+ llama.cpp Vulkan 解码器 + ForceAligner + 辅助进程）DLL/版本与 backend 隔离，
不进 backend 进程——backend 以 sys.executable 拉起本脚本，模型/工具目录与回环
端口经 argv 注入，worker 主动 connect 后在该连接上收发行协议：

  → {"id": 1, "cmd": "transcribe", "path": "C:/…/win_000.wav", "language": "en"}
  ← {"id": 1, "ok": true, "segments": [{"start": 0.12, "end": 3.4, "text": "…"}]}
  ← {"id": 1, "ok": false, "error": "…"}
  → {"id": 2, "cmd": "quit"}
  ← {"event": "ready"}   # 引擎初始化完成（含编码器预热），此后才接受 transcribe

协议走 socket 而非 stdout 管道：引擎与 multiprocessing 辅助进程会向 stdout
打印（进度/告警），管道会被污染；socket 通道独占，引擎输出归 backend 日志流。

段切分复用工具 exporters.alignment_to_srt 的口径：词级对齐（ForceAligner）按
分割标点/最大行宽聚合成字幕段，时间相对窗口起点（backend 端加窗口偏移）。

依赖（backend 运行环境需具备，见 requirements.txt）：numpy、onnxruntime（win 用
directml 变体）、gguf、pydub、scipy；nagisa/soynlp 为日/韩分词增强，缺省自动
降级（工具内建 ImportError 兜底）。
"""

import argparse
import json
import re
import socket
import sys

# 2 字语言码 → 工具 SUPPORTED_LANGUAGES 全名（utils.validate_language 要求
# 全名；未知码回落 None=自动检测——不因语言标签报错废掉转写）
_LANG_MAP = {
    "zh": "Chinese", "en": "English", "yue": "Cantonese", "ar": "Arabic",
    "de": "German", "fr": "French", "es": "Spanish", "pt": "Portuguese",
    "id": "Indonesian", "it": "Italian", "ko": "Korean", "ru": "Russian",
    "th": "Thai", "vi": "Vietnamese", "ja": "Japanese", "tr": "Turkish",
    "hi": "Hindi", "ms": "Malay", "nl": "Dutch", "sv": "Swedish",
    "da": "Danish", "fi": "Finnish", "pl": "Polish", "cs": "Czech",
    "fil": "Filipino", "fa": "Persian", "el": "Greek", "ro": "Romanian",
    "hu": "Hungarian", "mk": "Macedonian",
}


def _lang_name(code):
    if not code:
        return None
    return _LANG_MAP.get(str(code).strip().lower())


def _segment_items(items, max_chars=40):
    """词级对齐 → 字幕段（对齐工具 exporters.alignment_to_srt 的切分口径，
    直出 dict 而非 SRT 文本）。items: ForcedAlignItem 列表
    （.text/.start_time/.end_time）。"""
    split_pattern = re.compile(r"[，。？！、\n]|[,.?!]\s*")
    segs, cur, start = [], [], None
    for it in items or []:
        if start is None:
            start = it.start_time
        cur.append(it.text)
        content = "".join(cur)
        if split_pattern.search(it.text) or len(content) >= max_chars:
            text = "".join(cur).strip().rstrip("，。？！：、,.?!")
            if text:
                segs.append({"start": round(start, 3),
                             "end": round(it.end_time, 3), "text": text})
            cur, start = [], None
    if cur:
        text = "".join(cur).strip().rstrip("，。？！：、,.?!")
        if items:
            segs.append({"start": round(start, 3),
                         "end": round(items[-1].end_time, 3), "text": text})
    return segs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tool-dir", required=True, help="Qwen3-ASR-Transcribe 工具根目录")
    ap.add_argument("--model-dir", required=True, help="模型目录（ASR+Aligner 同目录）")
    ap.add_argument("--port", type=int, required=True, help="backend 监听的回环端口（协议通道）")
    ap.add_argument("--no-dml", action="store_true", help="禁用 DirectML（编码器走 CPU）")
    a = ap.parse_args()

    # 协议通道：连入 backend 监听口（只回环）。stdout/stderr 保持继承 backend
    # 日志流——引擎与其辅助进程的一切打印不影响协议。
    try:
        conn = socket.create_connection(("127.0.0.1", a.port), timeout=30)
    except OSError as e:
        print(f"[qwen3-worker] 连接协议端口失败 {a.port}：{e}", flush=True)
        return 1
    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    proto = conn.makefile("rw", encoding="utf-8", errors="replace")

    def emit(obj):
        proto.write(json.dumps(obj, ensure_ascii=False) + "\n")
        proto.flush()

    sys.path.insert(0, a.tool_dir)
    try:
        from qwen_asr_gguf.inference import ASREngineConfig, QwenASREngine
    except Exception as e:
        emit({"ok": False, "error": f"Qwen3-ASR 工具导入失败（{a.tool_dir}）：{e}"})
        return 1
    try:
        cfg = ASREngineConfig(model_dir=a.model_dir, use_dml=not a.no_dml,
                              enable_aligner=True, verbose=False)
        eng = QwenASREngine(cfg)
    except Exception as e:
        emit({"ok": False, "error": f"Qwen3-ASR 引擎初始化失败：{e}"})
        return 1
    emit({"event": "ready", "pid": __import__("os").getpid()})

    for line in proto:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError as e:
            emit({"ok": False, "error": f"请求非 JSON：{e}"})
            continue
        rid = req.get("id")
        if req.get("cmd") == "quit":
            emit({"id": rid, "ok": True, "event": "bye"})
            break
        if req.get("cmd") != "transcribe":
            emit({"id": rid, "ok": False, "error": f"未知 cmd：{req.get('cmd')!r}"})
            continue
        try:
            result = eng.transcribe(req["path"],
                                    language=_lang_name(req.get("language")))
            items = getattr(getattr(result, "alignment", None), "items", None) or []
            segs = _segment_items(items)
            if not segs and (getattr(result, "text", "") or "").strip():
                # 对齐器未产出（罕见）：整窗单段兜底，时间戳=全窗
                segs = [{"start": 0.0, "end": round(float(req.get("duration") or 0.0), 3),
                         "text": result.text.strip()}]
            emit({"id": rid, "ok": True, "segments": segs})
        except Exception as e:
            emit({"id": rid, "ok": False, "error": str(e)})
    try:
        eng.shutdown()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
