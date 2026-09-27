"""ASR API：/api/asr/transcribe（含缓存）、/v1/audio/transcriptions（OpenAI 兼容薄壳）、
/api/asr/cache（列表/清空）、/api/asr/status。"""

import hashlib
import json
import logging
import os
import tempfile
import time

from flask import Blueprint, current_app, jsonify, request

from core.asr import ASR_CACHE_DIR, _safe_key, cache_clear, cache_list

log = logging.getLogger(__name__)  # 第446次：同步转写完成日志（视频任务路径已有，此处此前缺失）

bp = Blueprint("asr", __name__)

_VALID_ENGINES = ("faster-whisper",)  # 第404次：qwen3-asr 备选移除，唯一引擎


@bp.get("/api/asr/status")
def asr_status():
    engine = current_app.extensions["engines"]["asr"]
    return jsonify({"ok": True, **engine.status()})


@bp.post("/api/asr/transcribe")
def transcribe():
    """multipart：file 必带；engine/language/video_id 可选（plan §3.5）。"""
    body, code = _transcribe_multipart()
    return jsonify(body), code


@bp.post("/v1/audio/transcriptions")
def transcribe_openai():
    """OpenAI 兼容转写端点（第三百九十三次）：与 /v1/chat/completions 同构的薄壳。

    扩展 ASR-LLM 路径发 {baseUrl}/audio/transcriptions（OpenAI 形状），本地后端
    据此对外统一为 OpenAI 兼容服务（对话+转写）。multipart：file 必带；model/
    language/response_format 按 OpenAI 语义可带——model 忽略（引擎由后端配置
    决定，客户端 whisper-1 等占位值不映射），language 透传，response_format 恒
    json。成功响应 OpenAI 形状 {"text": ...}；错误沿用 backend 统一 {ok,error,
    message} 形状与状态码（扩展侧只透出原始文本，不解析错误形状）。
    """
    body, code = _transcribe_multipart()
    if code != 200:
        return jsonify(body), code
    return jsonify({"text": body.get("text", "")})


def _transcribe_multipart():
    """公共转写流程（两共享端点复用）：multipart file → 缓存/引擎 → 转写。

    缓存 key：video_id 优先，否则音频 SHA-256 前 16 位；命中且引擎/语言一致
    直接返回（cached:true）。结果 JSON 落 backend/cache/asr/（plan §2.11-4）。
    返回 (payload, status)：成功 payload 含 {ok, cached, text, language, segments?}；
    失败为 {ok: False, ...}。
    """
    f = request.files.get("file")
    if f is None or not f.filename:
        return {"ok": False, "error": "missing_file"}, 400
    engine_name = (request.form.get("engine") or "").strip() or None
    if engine_name is not None and engine_name not in _VALID_ENGINES:
        return {"ok": False, "error": "invalid_engine"}, 400
    language = (request.form.get("language") or "").strip() or None
    video_id = (request.form.get("video_id") or "").strip()
    asr_cfg = current_app.config["CFG"].get("asr", {})
    eff_engine = "faster-whisper"  # 唯一引擎（engine_name 已过 _VALID_ENGINES 校验；历史配置残留值不再进缓存标签）
    use_cache = asr_cfg.get("cache", True)

    fd, tmp_path = tempfile.mkstemp(
        suffix=os.path.splitext(f.filename)[1] or ".bin")
    sha = hashlib.sha256()
    try:
        with os.fdopen(fd, "wb") as out:
            for chunk in iter(lambda: f.stream.read(1 << 20), b""):
                out.write(chunk)
                sha.update(chunk)
        key = video_id or sha.hexdigest()[:16]
        if use_cache:
            hit = _cache_get(key, eff_engine, language)
            if hit is not None:
                return {"ok": True, "cached": True, **hit}, 200
        try:
            t0 = time.time()
            result = current_app.extensions["engines"]["asr"].transcribe(
                tmp_path, engine=engine_name, language=language)
        except RuntimeError as e:  # 模型缺失 / 加载互斥
            return {"ok": False, "error": "asr_engine_failed",
                    "message": str(e)}, 503
        except ValueError as e:    # 音频解码失败
            return {"ok": False, "error": "bad_audio",
                    "message": str(e)}, 400
        if use_cache:
            _cache_put(key, video_id, eff_engine, language, result)
        # 第446次：同步转写完成日志（key/语言/段数/字符数/耗时），
        #   对齐视频任务路径 core/asr_job.py 的「转写完成」日志
        log.info("同步转写完成：key=%s 引擎=%s 语言=%s 段数=%d 字符数=%d 耗时=%.1fs",
                 key, eff_engine, result.get("language") or language or "auto",
                 len(result.get("segments") or []),
                 len(result.get("text") or ""), time.time() - t0)
        return {"ok": True, "cached": False, **result}, 200
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


@bp.get("/api/asr/cache")
def cache_items():
    return jsonify({"ok": True, "items": cache_list()})


@bp.delete("/api/asr/cache")
def cache_drop():
    return jsonify({"ok": True, "removed": cache_clear()})


# ---- 缓存读写（plan §2.11-4：只存 JSON，不存音频） ----


def _cache_path(key):
    return os.path.join(ASR_CACHE_DIR, _safe_key(key) + ".json")


def _cache_get(key, engine, language):
    """命中要求引擎与请求语言一致（同音频换引擎/语言结果不同，不复用）。"""
    try:
        with open(_cache_path(key), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if data.get("engine") != engine:
        return None
    if language and data.get("req_language") != language:
        return None
    # 第440次：条目去 text，但 OpenAI 形状响应仍要 text——从 segments 现拼，
    #   不兜底旧条目的 text 字段。
    return {
        "text": " ".join((s.get("text") or "").strip()
                         for s in (data.get("segments") or [])),
        "segments": data.get("segments") or [],
        "language": data.get("language"),
    }


def _cache_put(key, video_id, engine, language, result):
    entry = {
        "key": key,
        "video_id": video_id or None,
        "engine": engine,
        "req_language": language,
        "ts": int(time.time()),
        # 第440次：条目去 text（读侧从 segments 现拼），对齐 asr_job 条目。
        "language": result.get("language"),
    }
    if result.get("segments") is not None:
        entry["segments"] = result["segments"]
    os.makedirs(ASR_CACHE_DIR, exist_ok=True)
    with open(_cache_path(key), "w", encoding="utf-8") as f:
        json.dump(entry, f, ensure_ascii=False)
