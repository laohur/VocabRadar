"""ytdl API：resolve / download / 任务状态 / subtitles / /media/<id>（带 Range）。

错误映射对齐其他模块：ValueError→400 bad_request；RuntimeError→503
（resolve_failed/download_failed/subtitles_failed）；未知任务→404
not_found。subtitles 为扩展侧五路字幕全失败后的 backend 兜底（第399次），
两轨全空→404 no_subtitles。
"""

import logging
import os

from flask import Blueprint, current_app, jsonify, request, send_file

from core import ytdl as ytdl_core

bp = Blueprint("ytdl", __name__)

log = logging.getLogger(__name__)


def _default_fmt():
    return current_app.config["CFG"].get("ytdl", {}).get("format")


@bp.get("/api/ytdl/resolve")
def resolve():
    url = request.args.get("url")
    if not url:
        return jsonify({"ok": False, "error": "missing_url"}), 400
    log.info("ytdl 解析：%s", url)
    try:
        info = ytdl_core.resolve(url, request.args.get("format") or _default_fmt(),
                                 request.args.get("height"),
                                 request.args.get("abr"))  # 第409次：abr 音质上限
    except RuntimeError as e:
        log.error("ytdl 解析失败（%s）：%s", url, e)
        return jsonify({"ok": False, "error": "resolve_failed", "message": str(e)}), 503
    log.info("ytdl 解析完成：%s（%s）", info.get("title"), info.get("ext"))
    return jsonify({"ok": True, **info})


@bp.post("/api/ytdl/download")
def download():
    body = request.get_json(silent=True) or {}
    if not body.get("url"):
        return jsonify({"ok": False, "error": "missing_url"}), 400
    log.info("ytdl 下载提交：%s（format=%s height=%s abr=%s）",
             body["url"], body.get("format") or _default_fmt(),
             body.get("height"), body.get("abr"))
    try:
        task_id = ytdl_core.download(body["url"], body.get("format") or _default_fmt(),
                                     body.get("height"),
                                     body.get("abr"))  # 第409次：abr 音质上限
    except RuntimeError as e:
        log.error("ytdl 下载提交失败（%s）：%s", body["url"], e)
        return jsonify({"ok": False, "error": "download_failed", "message": str(e)}), 503
    log.info("ytdl 任务已排队：id=%s", task_id)
    return jsonify({"ok": True, "id": task_id})


@bp.get("/api/ytdl/status")
def ytdl_status():
    task_id = request.args.get("id")
    if task_id:
        task = ytdl_core.task_status(task_id)
        if task is None:
            return jsonify({"ok": False, "error": "not_found"}), 404
        return jsonify({"ok": True, "task": task})
    return jsonify({"ok": True, "tasks": ytdl_core.task_status()})


@bp.get("/api/ytdl/subtitles")
def subtitles():
    url = request.args.get("url")
    if not url:
        return jsonify({"ok": False, "error": "missing_url"}), 400
    log.info("ytdl 字幕获取：%s（lang=%s）", url, request.args.get("lang") or "默认")
    try:
        result = ytdl_core.subtitles(url, request.args.get("lang") or None)
    except RuntimeError as e:
        log.error("ytdl 字幕获取失败（%s）：%s", url, e)
        return jsonify({"ok": False, "error": "subtitles_failed", "message": str(e)}), 503
    if result is None:
        log.warning("ytdl 无可用字幕轨道：%s", url)
        return jsonify({"ok": False, "error": "no_subtitles"}), 404
    log.info("ytdl 字幕就绪：%s（%s，%d 条）",
             result.get("lang"), result.get("kind"), len(result.get("cues") or []))
    return jsonify({"ok": True, **result})


@bp.get("/media/<file_id>")
def media(file_id):
    # file_id 只用作前缀匹配，不进入路径拼接，无目录穿越面
    path = ytdl_core.find_media(file_id)
    if not path or not os.path.isfile(path):
        return jsonify({"ok": False, "error": "not_found"}), 404
    return send_file(path, conditional=True)  # conditional=True 自带 Range
