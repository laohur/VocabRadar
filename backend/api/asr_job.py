"""ASR 任务 API：POST /api/asr/jobs 提交（JSON URL / multipart 文件）、
GET /api/asr/jobs/<id>?after=N 增量轮询（第398次，plan-backend 阶段三2）。

交互形态（用户裁定：下载一段、识别一段、返回一段，不等全部完成）：
- POST {url, language?} → {ok, id, status}；status 用 OpenAI Batch 风格词汇
  （queued/in_progress 语义拆为 downloading+transcribing，供客户端分别展示
  下载/转写进度）。缓存命中时 status 直接 completed 且 cached:true。
- 第409次：POST 为 multipart（file 必带，language 可选）时走上传文件流式
  转写——跳过下载直接逐段转写，长音频转写中轮询即周期性拿到部分识别结果。
  缓存 key 为内容 SHA-256 前 16 位（同 multipart 同步端点语义）。
- GET ?after=N → 任务快照 + segments（只含第 N 段之后的新增段，带 start/end
  时间戳）+ segments_total 供对齐游标 + progress{download,transcribe}。
  status=failed 时带 error；任务不存在 404。
- 引擎固定 faster-whisper（时间戳 + 生成器增量，见 core/asr_job 模块注释），
  故不收 engine 参数。
"""

import hashlib
import logging
import os
import tempfile

from flask import Blueprint, current_app, jsonify, request

from core import asr_job

bp = Blueprint("asr_job", __name__)

log = logging.getLogger(__name__)


@bp.post("/api/asr/jobs")
def create_job():
    language = (request.form.get("language") if request.form
                else (request.get_json(silent=True) or {}).get("language"))
    language = (language or "").strip() or None
    if request.content_type and request.content_type.startswith("multipart/"):
        return _create_file_job(language)
    body = request.get_json(silent=True) or {}
    url = (body.get("url") or "").strip()
    try:
        job = asr_job.create(url, language,
                             current_app.extensions["engines"]["asr"])
    except ValueError as e:
        log.warning("ASR 任务创建被拒（URL 源）：%s", e)
        return jsonify({"ok": False, "error": "bad_request",
                        "message": str(e)}), 400
    log.info("ASR 任务已提交（URL 源）：id=%s language=%s cached=%s url=%s",
             job["id"], language or "auto", job["cached"], url)
    return jsonify({"ok": True, "id": job["id"], "status": job["status"],
                    "cached": job["cached"]}), 200


def _create_file_job(language):
    """multipart 上传 → 临时文件（流式 1MB 分块，算 SHA-256）→ 文件源任务。"""
    f = request.files.get("file")
    if f is None or not f.filename:
        return jsonify({"ok": False, "error": "missing_file"}), 400
    fd, tmp_path = tempfile.mkstemp(
        suffix=os.path.splitext(f.filename)[1] or ".bin")
    sha = hashlib.sha256()
    try:
        with os.fdopen(fd, "wb") as out:
            for chunk in iter(lambda: f.stream.read(1 << 20), b""):
                out.write(chunk)
                sha.update(chunk)
    except OSError:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        return jsonify({"ok": False, "error": "upload_failed"}), 500
    try:
        job = asr_job.create_file(
            tmp_path, f.filename, language,
            current_app.extensions["engines"]["asr"],
            cache_key=sha.hexdigest()[:16])
    except OSError as e:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        log.warning("ASR 任务创建被拒（文件源 %s）：%s", f.filename, e)
        return jsonify({"ok": False, "error": "bad_request",
                        "message": str(e)}), 400
    log.info("ASR 任务已提交（文件源）：id=%s file=%s language=%s cached=%s",
             job["id"], f.filename, language or "auto", job["cached"])
    return jsonify({"ok": True, "id": job["id"], "status": job["status"],
                    "cached": job["cached"]}), 200


@bp.get("/api/asr/jobs/<job_id>")
def job_status(job_id):
    after = request.args.get("after", 0, type=int)
    snap = asr_job.status(job_id, after)
    if snap is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    return jsonify({"ok": True, **snap}), 200
