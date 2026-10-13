"""翻译 API：/api/translate（{text, from, to} → {ok, text, model}）。

模型路由：取 config <translate>.model（translate_llm 卡片名，默认 Hy-MT2-1.8B，
管理页翻译段下拉按模型名选择；进程内 NLLB 快路径已移除）。错误映射（对齐
api/ocr.py）：RuntimeError → 503 translate_engine_failed；ValueError → 400
bad_request。结果不做缓存（plan §2.11）。from 是 JSON 字段名（core 层参数名用 src）。
"""

from flask import Blueprint, current_app, jsonify, request

from api import cards  # 模型卡片 CRUD 共用件（与 /api/llm/models 同构）

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
    """翻译模型清单（管理页翻译段下拉 + 模型卡片区数据源）。

    全部为 translate_llm 实例的卡片：全字段 + installed/is_default/builtin，
    与 /api/llm/models 同口径（installed 扫 hub 缓存，is_default 对
    <translate>.model 当前选择）。进程内 NLLB 快路径已移除，无内置首元素。"""
    engines = current_app.extensions["engines"]
    chosen = (engines["translate"].status()["model"] or "").strip()
    return jsonify({"ok": True,
                    "models": cards.listing("translate_llm", "translate_llm",
                                            chosen)})


@bp.post("/api/translate/models")
def add_translate_model():
    """新增翻译卡（内置卡「另存为新卡」与「新增卡片」同走此口）。"""
    return cards.add("translate_llm", request.get_json(silent=True))


@bp.put("/api/translate/models/<path:name>")
def update_translate_model(name):
    """改翻译卡；内置卡 409 builtin_card（前端引导另存为新卡）。"""
    return cards.update("translate_llm", name, request.get_json(silent=True))


@bp.delete("/api/translate/models/<path:name>")
def delete_translate_model(name):
    """删翻译卡；内置卡 409 builtin_card。删中选中卡时指针回落首卡。"""
    return cards.delete("translate_llm", name)


@bp.post("/api/translate/models/download/<path:name>")
def download_translate_model(name):
    """手动预下载翻译卡模型进 hub 缓存（与 /api/llm/models/download 同构）。"""
    return cards.download("translate_llm", "translate_llm", name)
