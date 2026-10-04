"""VocabRadar backend 入口：Flask 工厂 + Host 校验 + CORS + 蓝图注册。

对外监听 127.0.0.1:7777（扩展与管理界面，地址可在扩展设置中任意配置）；
可用 --port N 运行级指定端口（不写回 config.json）。
backend 固定监听配置端口，占用即失败退出；扩展端只认固定地址，不再范围尝试。
LLM 由 llama-server 子进程承担（内部端口 7788，core/llm_engine.py），
本进程只做反代与功能 API。
"""

import atexit
import logging
import os
import sys
import threading
import webbrowser

from flask import Flask, jsonify, request, send_from_directory

import config
import scripts.upgrade as upgrade
from core.asr import AsrEngine
from core.llm_engine import LlmEngine
from core.logs import setup as setup_logs
from core.ocr import OcrEngine
from core.translate import TranslateEngine
from api.admin import bp as admin_bp
from api.asr import bp as asr_bp
from api.asr_job import bp as asr_job_bp
from api.llm import bp as llm_bp
from api.ocr import bp as ocr_bp
from api.translate import bp as translate_bp
from api.upgrade import bp as upgrade_bp
from api.ytdl import bp as ytdl_bp

VERSION = "0.1.0"

log = logging.getLogger("app")


def create_app(cfg=None):
    cfg = cfg or config.load()
    app = Flask(__name__, static_folder=None)
    # 所有 jsonify 输出（含报错 message 的中文）直出 UTF-8，不做 \uXXXX ascii
    # 转义——转义串人不可读且徒增体积（Flask 默认 ensure_ascii=True）
    app.json.ensure_ascii = False
    app.config["CFG"] = cfg
    app.config["VERSION"] = VERSION
    # 引擎实例唯一属主挂在这里，蓝图经 current_app.extensions 取用
    llm = LlmEngine(cfg.get("llm", {}))
    translate_llm = LlmEngine(cfg.get("translate_llm", {}))  # 翻译专用实例（7789），与对话 LLM 分开启停
    app.extensions["engines"] = {
        "llm": llm,
        "translate_llm": translate_llm,
        "asr": AsrEngine(cfg.get("asr", {})),
        "ocr": OcrEngine(cfg.get("ocr", {}), llm),  # llm 引擎路径复用上方 LlmEngine
        # translate 的 engine=llm 路径复用 translate_llm 实例（core/translate.py）
        "translate": TranslateEngine(cfg.get("translate", {}), translate_llm),
    }

    for bp in (admin_bp, llm_bp, asr_bp, asr_job_bp, ocr_bp, translate_bp,
               ytdl_bp, upgrade_bp):
        app.register_blueprint(bp)

    app.register_error_handler(NotImplementedError, _not_implemented)
    app.before_request(_make_host_guard(cfg))
    app.after_request(_add_cors)

    @app.route("/")
    def index():
        # max_age=0：发 must-revalidate，防浏览器启发式缓存旧 UI
        return send_from_directory(config.UI_DIR, "index.html", max_age=0)

    @app.route("/ui/<path:name>")
    def ui_asset(name):
        return send_from_directory(config.UI_DIR, name, max_age=0)

    @app.route("/api/health")
    def health():
        return jsonify({"ok": True, "version": VERSION, "needs_setup": config.needs_setup()})

    return app


def _not_implemented(e):
    """core 未实现的占位统一落到 501，路由层不用各自判断。"""
    return jsonify({"ok": False, "error": "not_implemented", "message": str(e)}), 501


def _make_host_guard(cfg):
    """Host 头白名单，防 DNS rebinding（plan-backend §2.9/§3.5）。
    每次请求按 cfg 现值求值：--port 覆写（main 预检前改 cfg["port"]）无需重建 app。"""
    def guard():
        allowed = {f"127.0.0.1:{cfg['port']}", f"localhost:{cfg['port']}"}
        if request.host not in allowed:
            return jsonify({"ok": False, "error": "bad_host"}), 403

    return guard


def _add_cors(resp):
    """只放行浏览器扩展 origin；管理界面同源无需 CORS。"""
    origin = request.headers.get("Origin", "")
    if origin.startswith(("chrome-extension://", "moz-extension://")):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return resp


def _preload(engine, label):
    """resident 模式后台预加载进程内模型；失败不阻塞启动（如依赖/模型未安装）。"""
    try:
        engine.ensure_loaded()
    except Exception as e:
        log.warning("%s预加载失败：%s", label, e)


def _port_in_use(host, port):
    """启动前端口预检。连接探测 + 试绑双重判断——Windows 上先到进程若带
    SO_REUSEADDR 可被二次绑定（本机曾出现两个 python 同听 7777 的双绑），
    仅 bind 成功不足以证明空闲，故先 connect 探测。"""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        if s.connect_ex((host, port)) == 0:
            return True
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
            return False
        except OSError:
            return True


def _parse_cli_port(argv):
    """--port N / --port=N 运行级指定端口（不写回 config.json）；无参返回 None。
    坏参直接退出而非回落默认——端口号写错还悄悄生效旧端口，用户难以察觉（不遮蔽）。"""
    for i, a in enumerate(argv):
        if a == "--port":
            if i + 1 >= len(argv):
                sys.exit("用法：python app.py [--port N]，--port 后需跟端口号")
            raw = argv[i + 1]
        elif a.startswith("--port="):
            raw = a[len("--port="):]
        else:
            continue
        try:
            port = int(raw)
        except ValueError:
            sys.exit(f"--port 端口号无效：{raw!r}")
        if not 1 <= port <= 65535:
            sys.exit(f"--port 端口超出范围（1-65535）：{port}")
        return port
    return None


def main():
    setup_logs()  # 双通道日志（stderr + backend/logs/backend.log），见 core/logs.py
    cfg = config.load()
    cli_port = _parse_cli_port(sys.argv[1:])  # --port 运行级覆盖，不写回 config.json
    if cli_port is not None:
        cfg["port"] = cli_port
    app = create_app(cfg)
    engines = app.extensions["engines"]
    # 后端退出（正常退出/Ctrl+C）时自动终止 llama-server——manual=False
    # 不置手动停机标志，下次启动照常惰性拉起；taskkill /F 强杀无法拦截，
    # 该场景由 pid 文件兜底（core/llm_engine.py 下次 start() 先清残留）。
    atexit.register(engines["llm"].stop, False)
    atexit.register(engines["translate_llm"].stop, False)  # 翻译 LLM 实例同款退出清场
    # LLM 不随启动预拉——llama-server 加载重（显存紧张时启动即崩），
    # 对话/OCR(llm) 首请求时自动惰性拉起（api/llm.py、core/ocr.py），
    # 管理页可手动启停；进程内模型引擎（ASR/OCR/翻译）预加载照旧。
    if not engines["llm"].auto_start_allowed():
        log.info("LLM 引擎处于主动关停状态（llm.stopped=true），首次对话请求也不会拉起")
    if engines["asr"].mode == "resident":  # resident 后台预加载 ASR 模型
        if engines["asr"].status()["manual_stop"]:
            log.info("ASR 引擎处于主动关停状态（asr.stopped=true），跳过自动预加载")
        else:
            threading.Thread(target=_preload, args=(engines["asr"], "ASR"),
                             daemon=True).start()
    ocr = engines["ocr"]  # ocr 配 rapidocr 且 resident 时后台预加载（llm 引擎归 LlmEngine 管）
    if ocr.cfg.get("engine", "llm") == "rapidocr" and ocr.mode == "resident":
        if ocr.status()["manual_stop"]:
            log.info("OCR 引擎处于主动关停状态（ocr.stopped=true），跳过自动预加载")
        else:
            threading.Thread(target=_preload, args=(ocr, "OCR"),
                             daemon=True).start()
    translate = engines["translate"]  # NLLB resident 后台预加载（快路径低时延）
    # 选了 llama.cpp 翻译模型（model≠nllb）时翻译流量走 translate_llm 实例（自管
    # 生命周期），NLLB 预加载纯属白占内存
    if translate.mode == "resident" and translate.cfg.get("model", "nllb") == "nllb":
        if translate.status()["manual_stop"]:
            log.info("翻译引擎处于主动关停状态（translate.stopped=true），跳过自动预加载")
        else:
            threading.Thread(target=_preload, args=(translate, "翻译"),
                             daemon=True).start()
    # 升级静默检查（plan §5.5）：daemon 线程，有更新仅日志提示不打扰
    threading.Thread(target=upgrade.silent_check, daemon=True).start()
    url = f"http://{cfg['host']}:{cfg['port']}"
    log.info(f"VocabRadar backend v{VERSION} -> {url}")

    # 预检失败即退出，不自动递延换端口（用户自行解除占用或 --port 指定）
    if _port_in_use(cfg["host"], cfg["port"]):
        log.error(f"端口 {cfg['port']} 已被占用（常见原因：另一个 backend 实例仍在运行）。"
                  f"请先解除占用（结束占用进程），或用 --port 指定其他端口后重试。")
        sys.exit(1)

    if os.environ.get("BACKEND_NO_BROWSER") != "1":
        threading.Timer(1.5, webbrowser.open, args=(url,)).start()

    app.run(host=cfg["host"], port=cfg["port"], debug=False)


if __name__ == "__main__":
    main()
