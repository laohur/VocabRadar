"""管理 API：/api/config（读/写配置）、/api/status（各引擎总览）、
/api/engine/<name>/start|stop（模型服务加载/关停）。"""

import logging
import threading

from flask import Blueprint, current_app, jsonify, request

import config

bp = Blueprint("admin", __name__)

log = logging.getLogger(__name__)

_ENGINE_NAMES = ("llm", "asr", "ocr", "translate")  # 可加载/关停的模型服务


@bp.post("/api/engine/<name>/start")
def engine_start(name):
    """显式加载模型服务：llm=拉起 llama-server 并等就绪；asr/ocr/translate=进程内模型加载。

    404 未知引擎；400 引擎形态不支持（如 OCR 由 llm 承载）；503 启动失败/依赖缺失。
    """
    if name not in _ENGINE_NAMES:
        return jsonify({"ok": False, "error": "unknown_engine"}), 404
    engine = current_app.extensions["engines"][name]
    log.info(f"引擎启动请求：{name}（管理页）")
    try:
        if name == "llm":
            engine.start()  # start() 内部解除手动停机抑制
        else:
            engine.ensure_loaded(force=True)  # 显式启动解除手动停机
    except ValueError as e:
        log.warning(f"引擎 {name} 启动不适用：{e}")
        return jsonify({"ok": False, "error": "not_applicable", "message": str(e)}), 400
    except Exception as e:
        log.error(f"引擎 {name} 启动失败：{e}")
        return jsonify({"ok": False, "error": "start_failed", "message": str(e)}), 503
    log.info(f"引擎 {name} 启动完成")
    return jsonify({"ok": True, "engines": {name: engine.status()}})


@bp.post("/api/engine/<name>/stop")
def engine_stop(name):
    """显式关停模型服务：llm=退出 llama-server；asr/ocr/translate=卸载进程内模型释放内存。"""
    if name not in _ENGINE_NAMES:
        return jsonify({"ok": False, "error": "unknown_engine"}), 404
    engine = current_app.extensions["engines"][name]
    log.info(f"引擎关停请求：{name}（管理页，将持久化 stopped 标志）")
    try:
        engine.stop()
    except ValueError as e:
        log.warning(f"引擎 {name} 关停不适用：{e}")
        return jsonify({"ok": False, "error": "not_applicable", "message": str(e)}), 400
    except Exception as e:
        log.error(f"引擎 {name} 关停失败：{e}")
        return jsonify({"ok": False, "error": "stop_failed", "message": str(e)}), 503
    log.info(f"引擎 {name} 关停完成")
    return jsonify({"ok": True, "engines": {name: engine.status()}})


@bp.get("/api/logs")
def get_logs():
    """backend.log 末尾日志（管理页日志卡片）。?tail=N 控制行数，
    默认 200 上限 2000。"""
    try:
        n = int(request.args.get("tail", 200))
    except ValueError:
        n = 200
    from core import logs
    return jsonify({"ok": True, "lines": logs.tail(n), "path": logs.log_path()})


@bp.get("/api/config")
def get_config():
    return jsonify({"ok": True, "config": current_app.config["CFG"]})


@bp.put("/api/config")
def put_config():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"ok": False, "error": "bad_body"}), 400
    old = current_app.config["CFG"]
    config.update_user(body)  # 用户层最小持久化：config.json 只存用户设定，不固化默认值
    merged = config.load()    # 运行时全量视图 = DEFAULTS + 用户层覆盖
    current_app.config["CFG"] = merged
    # config.load() 生成新 dict，引擎仍持旧 cfg 引用——同步各引擎 cfg
    # 指向新配置，改动（模型、engine、mode 等）才能生效。
    engines = current_app.extensions["engines"]
    for name in ("llm", "asr", "ocr", "translate"):
        engines[name].cfg = merged.get(name, {})
    # LLM 主模型/上下文变更且 llama-server 运行中：自动重启加载新模型，
    # 无需用户再手动点关停+启动。
    # ?no_reload=1 旁路（不进 body 不污染配置）——「设为默认」
    # 只落配置不热重启，下次启动生效。
    llm_reloading = False
    llm = engines["llm"]
    no_reload = request.args.get("no_reload") == "1"
    if (old["llm"].get("model") != merged["llm"].get("model")
            or old["llm"].get("ctx") != merged["llm"].get("ctx")):
        chosen = (merged["llm"].get("model") or "").strip()
        if no_reload:
            log.info(f"LLM 配置变更（model={chosen!r}），按 no_reload 请求"
                     f"不切换运行中的 llama-server（下次启动生效）")
        elif llm.status()["running"]:
            # 选中未装卡片无需在此按需下载——llm.start() 内三源
            # 重试链（-hf → hf-mirror → fallback_url）自动补拉
            log.info(f"LLM 配置变更（model={chosen!r}），"
                     f"重启 llama-server 加载新模型...")
            llm.stop(manual=False)  # 不置手动停机，随后自动拉起
            threading.Thread(target=llm._safe_start, daemon=True).start()
            llm_reloading = True
        else:
            log.info("LLM 配置变更（model=%r），下次启动生效", chosen)
    restart = old["port"] != merged["port"] or old["host"] != merged["host"]
    return jsonify({"ok": True, "config": merged, "restart_required": restart,
                    "llm_reloading": llm_reloading})


@bp.get("/api/status")
def status():
    engines = current_app.extensions["engines"]
    cfg = current_app.config["CFG"]
    return jsonify({
        "ok": True,
        "version": current_app.config["VERSION"],
        "needs_setup": config.needs_setup(),
        "engines": {
            "llm": engines["llm"].status(),
            "asr": engines["asr"].status(),
            "ocr": engines["ocr"].status(),
            "translate": engines["translate"].status(),
            "ytdl": _ytdl_status(cfg),
        },
    })


def _ytdl_status(cfg):
    """ytdl 无引擎对象（模块函数式）：给配置摘要 + yt-dlp 版本。

    importlib.metadata 只查元数据不 import 包本体（yt_dlp import 近秒级，
    /api/status 是总览页与扩展健康检查共用的高频接口）。cookies_from_browser
    原值透出；auto 时附 auto_browser＝探测解析到的浏览器名（core.ytdl
    结果缓存，零重复探测；空＝未发现已装浏览器，不带 cookie 直连）。
    """
    from importlib.metadata import version
    cb = (cfg["ytdl"].get("cookies_from_browser") or "").strip()
    info = {"engine": "yt-dlp", "format": cfg["ytdl"]["format"],
            "cookiefile": bool(cfg["ytdl"].get("cookiefile")),
            "cookies_from_browser": cb}
    if cb.lower() == "auto":
        from core import ytdl as ytdl_core  # 局部 import：与 api.ytdl 同惯用
        info["auto_browser"] = ytdl_core._pick_browser_auto() or ""
    try:
        info["version"] = version("yt-dlp")
    except Exception:
        pass  # 包缺失不阻塞总览；下载时自会暴露
    return info
