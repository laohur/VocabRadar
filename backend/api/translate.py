"""翻译 API：/api/translate（{text, from, to} → {ok, text, model}）。

模型路由：取 config <translate>.model（"nllb" | translate_llm 卡片名，管理页
翻译段下拉按模型名选择）。错误映射（对齐 api/ocr.py）：RuntimeError → 503
translate_engine_failed；ValueError → 400 bad_request。结果不做缓存
（plan §2.11）。from 是 JSON 字段名（core 层参数名用 src）。
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


@bp.get("/api/translate/models")
def translate_models():
    """翻译模型清单（管理页翻译段下拉数据源）。

    首元素恒为内置 NLLB（模型名即标签）；其后为 translate_llm 实例的卡片
    （name/desc/installed/is_default，与 /api/llm/models 同口径——installed 扫
    hub 缓存，is_default 对 <translate>.model 的当前选择）。"""
    engines = current_app.extensions["engines"]
    cfg = current_app.config["CFG"]
    llm_cfg = cfg.get("translate_llm", {})
    chosen = (engines["translate"].status()["model"] or "").strip().lower()
    out = [{"name": "nllb", "desc": "NLLB-200-distilled-600M（内置 CT2 int8，快）",
            "installed": True, "is_default": engines["translate"].status()["model"] == "nllb"}]
    for c in (llm_cfg.get("cards") or []):
        if not isinstance(c, dict):
            continue
        out.append({
            "name": str(c.get("name") or ""),
            "desc": str(c.get("desc") or ""),
            "installed": engines["translate_llm"].card_installed(c),
            "is_default": bool(chosen) and str(c.get("name", "")).lower() == chosen,
        })
    return jsonify({"ok": True, "models": out})
