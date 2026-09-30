"""翻译 API：/api/translate（{text, from, to} → {ok, text, engine}）。

引擎唯一为 NLLB，在 core 层决定；请求无需也不能指定引擎。
错误映射（对齐 api/ocr.py）：RuntimeError → 503 translate_engine_failed；
ValueError → 400 bad_request。结果不做缓存（plan §2.11）。
from 是 JSON 字段名（core 层参数名用 src）。
"""

from flask import Blueprint, current_app, jsonify, request

bp = Blueprint("translate", __name__)


@bp.post("/api/translate")
def translate():
    engine_obj = current_app.extensions["engines"]["translate"]
    body = request.get_json(silent=True) or {}
    text = body.get("text")
    if not text:
        return jsonify({"ok": False, "error": "missing_text"}), 400
    dst = (body.get("to") or "").strip()
    if not dst:
        return jsonify({"ok": False, "error": "missing_to"}), 400
    src = (body.get("from") or "").strip() or "auto"
    try:
        result = engine_obj.translate(text, src=src, dst=dst)
    except RuntimeError as e:
        return jsonify({"ok": False, "error": "translate_engine_failed",
                        "message": str(e)}), 503
    except ValueError as e:
        return jsonify({"ok": False, "error": "bad_request", "message": str(e)}), 400
    return jsonify({"ok": True, **result})


@bp.get("/api/translate/status")
def translate_status():
    engine = current_app.extensions["engines"]["translate"]
    return jsonify({"ok": True, **engine.status()})
