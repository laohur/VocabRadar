"""升级 API（plan-backend §5.5）：检查 + 动作触发 + 后台任务状态。

- GET  /api/upgrade/check   三资产检查（同步网络请求，几秒）
- POST /api/upgrade/<action>  llamacpp | ytdlp（后台线程，409 表进行中）
- GET  /api/upgrade/status  动作进度（stage/log/error），前端轮询
"""

from flask import Blueprint, current_app, jsonify

import scripts.upgrade as up

bp = Blueprint("upgrade", __name__)


@bp.get("/api/upgrade/check")
def check():
    result = up.check_all()
    result["backend"]["version"] = current_app.config["VERSION"]
    return jsonify({"ok": True, "result": result})


@bp.post("/api/upgrade/<action>")
def run(action):
    if action not in up.ACTIONS:
        return jsonify({"ok": False, "error": "unknown_action"}), 404
    engines = current_app.extensions["engines"]
    # llamacpp 二进制替换前须停 llama-server（Windows 文件锁）；llm 惰性启动，
    # 停服后下次请求自动用新版本，无需额外重启动作
    stop_llm = engines["llm"].stop if action == "llamacpp" else None
    if not up.start(action, stop_llm=stop_llm):
        return jsonify({"ok": False, "error": "upgrade_running"}), 409
    return jsonify({"ok": True, "started": action})


@bp.get("/api/upgrade/status")
def status():
    return jsonify({"ok": True, **up.status()})
