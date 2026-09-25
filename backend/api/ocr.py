"""OCR API：/api/ocr（multipart file 或 JSON dataURL）、/api/ocr/status。

错误映射（对齐 api/asr.py）：RuntimeError → 503 ocr_engine_failed；
ValueError → 400 bad_image；engine 白名单外 → 400 invalid_engine。
结果不做缓存（plan §2.11）。
"""

import base64

from flask import Blueprint, current_app, jsonify, request

bp = Blueprint("ocr", __name__)

_VALID_ENGINES = ("llm", "rapidocr")
_VALID_MIMES = ("image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp")


@bp.get("/api/ocr/status")
def ocr_status():
    engine = current_app.extensions["engines"]["ocr"]
    return jsonify({"ok": True, **engine.status()})


@bp.post("/api/ocr")
def ocr():
    engine_obj = current_app.extensions["engines"]["ocr"]

    # 双入参：multipart file（浏览器表单/扩展 fetch FormData）或 JSON dataURL
    if request.files:
        f = request.files.get("file")
        if f is None or not f.filename:
            return jsonify({"ok": False, "error": "missing_image"}), 400
        image_bytes = f.read()
        mime = (f.mimetype or "").split(";")[0]
        engine_name = (request.form.get("engine") or "").strip() or None
    else:
        data = request.get_json(silent=True) or {}
        image = (data.get("image") or "").strip()
        if not image:
            return jsonify({"ok": False, "error": "missing_image"}), 400
        try:
            head, _, b64 = image.partition(",")
            mime = head[5:].split(";")[0] if head.startswith("data:") else ""
            image_bytes = base64.b64decode(b64, validate=True)
        except (ValueError, TypeError):
            return jsonify({"ok": False, "error": "bad_image"}), 400
        engine_name = (data.get("engine") or "").strip() or None

    if engine_name is not None and engine_name not in _VALID_ENGINES:
        return jsonify({"ok": False, "error": "invalid_engine"}), 400
    if not image_bytes:
        return jsonify({"ok": False, "error": "bad_image"}), 400
    mime = mime if mime in _VALID_MIMES else "image/png"

    try:
        result = engine_obj.recognize(image_bytes, mime=mime, engine=engine_name)
    except RuntimeError as e:
        return jsonify({"ok": False, "error": "ocr_engine_failed",
                        "message": str(e)}), 503
    except ValueError as e:
        return jsonify({"ok": False, "error": "bad_image", "message": str(e)}), 400
    return jsonify({"ok": True, **result})
