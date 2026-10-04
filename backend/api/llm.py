"""LLM API：/v1/chat/completions（反代 llama-server，OpenAI 兼容）、/api/llm/status、
模型卡片（只读元数据：自动下载交 llama.cpp -hf 三源重试链，
卡片仅声明 command/hf_repo/fallback_url 等启动要素）+ 启动命令解析。"""

import json
import logging
import shlex
import time

import requests
from flask import Blueprint, Response, current_app, jsonify, request

import config

bp = Blueprint("llm", __name__)

log = logging.getLogger(__name__)

# llama-server 启动命令中「带值」的旗标 → 卡片字段（/api/llm/models/parse 用）；
# 旗标匹配用精确相等或 flag= 前缀，防 -cudart 之类误配 -c。
# 卡片以 command 为权威，parse 只解析下载相关旗标（-hf/-mu/-mmu）
# 与端口/上下文（port/ctx 仅供参考，实际以 config 为准）
_VALUE_FLAGS = {
    "-hf": "hf_repo", "-hfr": "hf_repo", "--hf-repo": "hf_repo",
    "-mu": "fallback_url", "--model-url": "fallback_url",
    "-mmu": "fallback_mmproj_url", "--mmproj-url": "fallback_mmproj_url",
    "--port": "port",
    "-c": "ctx", "--ctx-size": "ctx",
}


@bp.get("/api/llm/status")
def llm_status():
    engine = current_app.extensions["engines"]["llm"]
    return jsonify({"ok": True, **engine.status()})


@bp.post("/v1/chat/completions")
def chat_completions():
    """原样反代 llama-server（OpenAI 兼容格式，含 image_url base64 多模态）。

    on-demand 模式在首个请求时按需拉起（手动停机期间不惰性拉起，返回 503）；
    流式（SSE）与非流式均透传；每次对话请求入日志（不落正文）。
    """
    engine = current_app.extensions["engines"]["llm"]
    st = engine.status()
    if not st["running"]:
        if not engine.auto_start_allowed():
            return jsonify({"ok": False, "error": "llm_manually_stopped",
                            "message": "LLM 引擎已手动停机，请到管理页重新启动后再对话"}), 503
        try:
            engine.start()
        except RuntimeError as e:
            return jsonify({"ok": False, "error": "llm_start_failed",
                            "message": str(e)}), 503
    engine.begin_request()  # inflight+1：on-demand 下推理期间不被空闲误杀
    # 先取原始请求体再转发：get_data(cache=False) 消费流后 get_json 恒为空
    raw = request.get_data(cache=False)
    try:
        body = json.loads(raw.decode("utf-8", "replace")) if raw else {}
    except ValueError:
        body = {}
    try:
        r = requests.post(f"{engine.base_url()}/v1/chat/completions",
                          data=raw,
                          headers={"Content-Type": "application/json"},
                          stream=True, timeout=(10, 600))
    except requests.RequestException as e:
        engine.end_request()
        log.warning("对话转发失败：%s", e)
        return jsonify({"ok": False, "error": "llm_unreachable",
                        "message": str(e)}), 502

    t0 = time.time()
    # 请求日志：模型与消息规模摘要（不落正文，避免日志泄敏感内容）
    model = body.get("model") or "-"
    n_msg = len(body.get("messages") or [])
    stream = bool(body.get("stream"))
    log.info("对话请求 -> llama-server（model=%s, messages=%d, stream=%s, "
             "http=%d）", model, n_msg, stream, r.status_code)

    def passthrough():
        try:
            for chunk in r.iter_content(8192):
                yield chunk
        finally:
            engine.end_request()  # 流结束/客户端断连均回收到位
            log.info("对话响应完成（%.1fs，http=%d）", time.time() - t0,
                     r.status_code)
    return Response(passthrough(), status=r.status_code,
                    content_type=r.headers.get("Content-Type", "application/json"))


# ---------------------------------------------------------------------------
# 模型卡片：llm.cards 数组，每张卡描述一个可经 llama.cpp -hf 自动下载/切换
# 的模型。name=唯一 ID（llm.model 存卡片名）；command=llama-server 启动命令
# （权威，自动下载由其中 -hf <repo>[:quant] 驱动）；hf_repo=归属仓库
# （installed 扫 %USERPROFILE%/.cache/huggingface/hub 判定）；
# fallback_url/fallback_mmproj_url = hf 与 hf-mirror 均失败后的直链兜底
# （engine 启动时改写 -mu/-mmu）。
# ---------------------------------------------------------------------------

def _get_cards():
    cards = current_app.config["CFG"].get("llm", {}).get("cards")
    return cards if isinstance(cards, list) else []


def _save_cards(cards, model=None):
    """写回 llm.cards（put_config 同款最小持久化：update_user→load→CFG→4 引擎同步）。

    deep_merge 对 list 整体替换，cards 传 [] 即清空；model 非 None 时一并
    写 llm.model（设默认/默认卡改名跟随/删默认回未选卡）。
    """
    patch = {"llm": {"cards": cards}}
    if model is not None:
        patch["llm"]["model"] = model
    config.update_user(patch)  # 用户层最小持久化，不固化 DEFAULTS
    merged = config.load()     # 运行时全量视图 = DEFAULTS + 用户层覆盖
    current_app.config["CFG"] = merged
    engines = current_app.extensions["engines"]
    for name in ("llm", "translate_llm", "asr", "ocr", "translate"):
        engines[name].cfg = merged.get(name, {})


def _normalize_card(body):
    """校验并规范化卡片；合法返回 (card, None)，否则 (None, 错误码)。"""
    if not isinstance(body, dict):
        return None, "bad_body"
    name = str(body.get("name") or "").strip()
    command = str(body.get("command") or "").strip()
    if not name or not command:
        return None, "name_and_command_required"
    card = {"name": name, "command": command}
    for key in ("desc", "desc_en", "hf_repo", "fallback_url",
                "fallback_mmproj_url"):
        v = str(body.get(key) or "").strip()
        if v:
            card[key] = v
    # 采样参数白名单（数值过滤；llm_engine.start 注入 llama-server 启动参数）
    smp = body.get("sampling")
    if isinstance(smp, dict):
        norm_smp = {}
        for k in ("temperature", "top_p", "top_k", "min_p", "repeat_penalty"):
            v = smp.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                norm_smp[k] = float(v)
        if norm_smp:
            card["sampling"] = norm_smp
    return card, None


@bp.get("/api/llm/models")
def list_model_cards():
    engine = current_app.extensions["engines"]["llm"]
    cfg = current_app.config["CFG"].get("llm", {})
    model = (cfg.get("model") or "").strip().lower()
    out = []
    for c in _get_cards():
        d = dict(c)
        # installed：扫 llama.cpp/huggingface_hub 共用 hub 缓存判定
        d["installed"] = engine.card_installed(c)
        d["is_default"] = bool(model) and str(c.get("name", "")).lower() == model
        out.append(d)
    return jsonify({"ok": True, "cards": out})


@bp.post("/api/llm/models")
def add_model_card():
    card, err = _normalize_card(request.get_json(silent=True))
    if err:
        return jsonify({"ok": False, "error": err}), 400
    cards = _get_cards()
    if any(c.get("name") == card["name"] for c in cards):
        return jsonify({"ok": False, "error": "duplicate_name"}), 400
    cards.append(card)
    _save_cards(cards)
    return jsonify({"ok": True, "card": card})


@bp.put("/api/llm/models/<path:name>")
def update_model_card(name):
    card, err = _normalize_card(request.get_json(silent=True))
    if err:
        return jsonify({"ok": False, "error": err}), 400
    cards = _get_cards()
    idx = next((i for i, c in enumerate(cards) if c.get("name") == name), None)
    if idx is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    if any(c.get("name") == card["name"] and i != idx
           for i, c in enumerate(cards)):
        return jsonify({"ok": False, "error": "duplicate_name"}), 400
    old_name = str(cards[idx].get("name", ""))
    cards[idx] = card
    # 默认模型跟随：旧卡名正被设为默认且卡改名 → 指向新名
    cfg_model = (current_app.config["CFG"]["llm"].get("model") or "").lower()
    model = (card["name"] if old_name.lower() == cfg_model
             and old_name != card["name"] else None)
    _save_cards(cards, model)
    return jsonify({"ok": True, "card": card})


@bp.delete("/api/llm/models/<path:name>")
def delete_model_card(name):
    cards = _get_cards()
    idx = next((i for i, c in enumerate(cards) if c.get("name") == name), None)
    if idx is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    removed = cards.pop(idx)
    # 删的是默认卡 → model 清空（needs_setup 重新置位）；只删卡不清 hub 缓存
    cfg_model = (current_app.config["CFG"]["llm"].get("model") or "").lower()
    model = "" if str(removed.get("name", "")).lower() == cfg_model else None
    _save_cards(cards, model)
    return jsonify({"ok": True})


@bp.post("/api/llm/models/parse")
def parse_launch_cmd():
    """解析 llama-server 启动命令 → 卡片字段（-hf/-mu/-mmu 下载旗标，
    name 取 -hf 参数原值）。

    shlex(posix=False) 保留 Windows 反斜杠路径，token 再手工剥引号；
    i 从 1 起（parts[0] 是可执行文件）。
    """
    body = request.get_json(silent=True) or {}
    cmd = str(body.get("cmd") or "").strip()
    if not cmd:
        return jsonify({"ok": False, "error": "empty_cmd"}), 400
    try:
        parts = shlex.split(cmd, posix=False)
    except ValueError as e:
        return jsonify({"ok": False, "error": "bad_cmd", "message": str(e)}), 400
    out = {"hf_repo": "", "fallback_url": "", "fallback_mmproj_url": "",
           "port": "", "ctx": "", "name": ""}
    i = 1
    while i < len(parts):
        tok = parts[i].strip().strip('"').strip("'")
        low = tok.lower()
        for flag, key in _VALUE_FLAGS.items():
            if low == flag and i + 1 < len(parts):
                out[key] = parts[i + 1].strip().strip('"').strip("'")
                i += 2
                break
            if low.startswith(flag + "="):
                out[key] = tok[len(flag) + 1:].strip().strip('"').strip("'")
                i += 1
                break
        else:
            i += 1
    if out["hf_repo"]:
        # name 即 -hf 参数原值（含 :quant 后缀，如 unsloth/Qwen3-0.6B-GGUF:Q4_K_M）
        out["name"] = out["hf_repo"]
    return jsonify({"ok": True, "parsed": out})

