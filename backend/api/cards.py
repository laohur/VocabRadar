"""模型卡片 CRUD 共用件：llm（api/llm.py）与 translate_llm（api/translate.py）同构。

卡片语义：
- name = 唯一 ID，选择指针存卡片名：llm.model；translate_llm 同时写路由段
  translate.model（管理页翻译下拉）与实例段 translate_llm.model（实例按卡启动）。
- command = llama-server 启动命令（权威，其中 -hf 驱动模型自动下载）。
- **内置卡只读**（名字命中 config.DEFAULTS 该段出厂卡）：PUT/DELETE 返回 409
  builtin_card，前端引导「另存为新卡片」（POST）——出厂卡不被用户改动遮蔽，
  改动以新卡留存，新卡可改可删。
- 保存走 config.update_user 用户层最小持久化（list 整体替换），随后重载全量
  视图并把 5 个引擎的 cfg 指向新对象（与 api/admin.put_config 同款口径）。
"""

import config
from flask import current_app, jsonify

# 除 name/command 外可编辑的字符串字段（translate_prompt 仅翻译卡有，留空即不写）
_STR_FIELDS = ("desc", "desc_en", "hf_repo", "fallback_url",
               "fallback_mmproj_url", "translate_prompt")
_SAMPLING_KEYS = ("temperature", "top_p", "top_k", "min_p", "repeat_penalty")
_ENGINES = ("llm", "translate_llm", "asr", "ocr", "translate")  # 与 put_config 同款同步范围


def get_cards(section):
    cards = current_app.config["CFG"].get(section, {}).get("cards")
    return [c for c in cards if isinstance(c, dict)] if isinstance(cards, list) else []


def builtin_names(section):
    """出厂内置卡名集合（判定 builtin 徽标与只读保护）。"""
    out = set()
    for c in (config.DEFAULTS.get(section, {}).get("cards") or []):
        if isinstance(c, dict) and c.get("name"):
            out.add(str(c["name"]))
    return out


def _pointer_refs(section):
    """选择指针所在的配置段：llm 自身；translate_llm 同时写路由段 translate。"""
    return ("llm",) if section == "llm" else ("translate", "translate_llm")


def normalize_card(body):
    """校验并规范化卡片；合法返回 (card, None)，否则 (None, 错误码)。"""
    if not isinstance(body, dict):
        return None, "bad_body"
    name = str(body.get("name") or "").strip()
    command = str(body.get("command") or "").strip()
    if not name or not command:
        return None, "name_and_command_required"
    card = {"name": name, "command": command}
    for key in _STR_FIELDS:
        v = str(body.get(key) or "").strip()
        if v:
            card[key] = v
    # 采样参数白名单（数值过滤；llm_engine.start 注入 llama-server 启动参数）
    smp = body.get("sampling")
    if isinstance(smp, dict):
        norm = {}
        for k in _SAMPLING_KEYS:
            v = smp.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                norm[k] = float(v)
        if norm:
            card["sampling"] = norm
    return card, None


def _sync_engines(merged):
    engines = current_app.extensions["engines"]
    for name in _ENGINES:
        engines[name].cfg = merged.get(name, {})


def save(section, cards, pointer=None):
    """写回卡片数组（+ 可选选择指针），随后同步运行时全量视图与各引擎 cfg。

    pointer: {配置段: 新模型名}；deep_merge 对 list 整体替换，cards 传 [] 即清空。
    """
    patch = {section: {"cards": cards}}
    for sec, val in (pointer or {}).items():
        patch.setdefault(sec, {})["model"] = val
    config.update_user(patch)  # 用户层最小持久化，不固化 DEFAULTS
    merged = config.load()     # 运行时全量视图 = DEFAULTS + 用户层覆盖
    current_app.config["CFG"] = merged
    _sync_engines(merged)


def _current_pointer(section):
    """当前选择的卡片名（取指针段里第一个非空值）。"""
    cfg = current_app.config["CFG"]
    for sec in _pointer_refs(section):
        val = str((cfg.get(sec) or {}).get("model") or "").strip()
        if val:
            return val
    return ""


def listing(section, engine_key, chosen=""):
    """GET 视图：卡片全字段 + installed / is_default / builtin / download。"""
    engine = current_app.extensions["engines"][engine_key]
    chosen = str(chosen or "").strip().lower()
    names = builtin_names(section)
    out = []
    for c in get_cards(section):
        d = dict(c)
        d["installed"] = engine.card_installed(c)
        name = str(c.get("name", ""))
        d["is_default"] = bool(chosen) and name.lower() == chosen
        d["builtin"] = name in names
        d["download"] = engine.download_state(name)  # 手动预下载状态（无则 None）
        out.append(d)
    return out


def download(section, engine_key, name):
    """POST：手动预下载卡片模型进 hub 缓存（hf → hf-mirror，见
    core/llm_engine.start_card_download）。内置/自定义卡均可；进行中重复
    触发幂等返回现状。直链兜底（fallback_url）仅 llama-server 启动链支持，
    本入口不支持——两源不可达时下载失败，报错可见。"""
    card = next((c for c in get_cards(section)
                 if str(c.get("name")) == str(name)), None)
    if card is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    engine = current_app.extensions["engines"][engine_key]
    return jsonify({"ok": True, "download": engine.start_card_download(card)})


def add(section, body):
    """POST：新增卡片（内置卡的「另存为新卡」与「新增卡片」同走此口）。"""
    card, err = normalize_card(body)
    if err:
        return jsonify({"ok": False, "error": err}), 400
    cards = get_cards(section)
    if any(str(c.get("name")) == card["name"] for c in cards):
        return jsonify({"ok": False, "error": "duplicate_name"}), 400
    cards.append(card)
    save(section, cards)
    return jsonify({"ok": True, "card": card})


def update(section, name, body):
    """PUT：修改卡片；内置卡 409 builtin_card（请另存为新卡）。"""
    if name in builtin_names(section):
        return jsonify({"ok": False, "error": "builtin_card"}), 409
    card, err = normalize_card(body)
    if err:
        return jsonify({"ok": False, "error": err}), 400
    cards = get_cards(section)
    idx = next((i for i, c in enumerate(cards) if str(c.get("name")) == name), None)
    if idx is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    if any(str(c.get("name")) == card["name"] and i != idx
           for i, c in enumerate(cards)):
        return jsonify({"ok": False, "error": "duplicate_name"}), 400
    cards[idx] = card
    # 改名的卡正被选用 → 指针跟随新名
    pointer = None
    cur = _current_pointer(section)
    if cur and cur.lower() == name.lower() and card["name"] != name:
        pointer = {sec: card["name"] for sec in _pointer_refs(section)}
    save(section, cards, pointer)
    return jsonify({"ok": True, "card": card})


def delete(section, name):
    """DELETE：删卡；内置卡 409 builtin_card。删的是选中卡时指针回落
    （llm 清空 = 未选卡；翻译段回落首卡，路由不留空）。"""
    if name in builtin_names(section):
        return jsonify({"ok": False, "error": "builtin_card"}), 409
    cards = get_cards(section)
    idx = next((i for i, c in enumerate(cards) if str(c.get("name")) == name), None)
    if idx is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    removed = str(cards.pop(idx).get("name") or "")
    pointer = None
    if _current_pointer(section).lower() == removed.lower():
        fallback = str(cards[0].get("name") or "") if cards else ""
        pointer = {sec: ("" if section == "llm" else fallback)
                   for sec in _pointer_refs(section)}
    save(section, cards, pointer)
    return jsonify({"ok": True})
