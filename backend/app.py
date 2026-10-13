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
import scripts.install as install  # 升级能力唯一入口（--check/--upgrade）+ 启动静默检查
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
               ytdl_bp):
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


# 第559次实锤（2026-10-13）：Windows 上外部 Ctrl+C（CTRL_C_EVENT）/ Ctrl+Break
# （CTRL_BREAK_EVENT）都会被系统投递成 KeyboardInterrupt 给主线程，而 werkzeug 3.x 的
# BaseWSGIServer.serve_forever 把它 except 后静默 pass——app.run 于是「正常返回」、
# 退出码 0、无 traceback，与闪退表现完全相同（已用 _thread.interrupt_main 实验复现）。
# 真控制台事件与 _thread.interrupt_main()（3.14 实测同样过 SIGINT 处理器）必经下面
# 打点；只有库线程直接调 server.shutdown() 不经处理器，由 main 末尾「无信号返回」
# 分支兜底。
_SIGNAL_DUMP_MARK = {"got": False, "name": ""}


def _dump_all_threads():
    """全部线程当前调用栈文本（信号到达瞬间的现场：worker 帧能暴露是哪个库在动）。"""
    import traceback
    main_tid = threading.main_thread().ident
    chunks = []
    for tid, frame in sys._current_frames().items():
        role = "main" if tid == main_tid else "worker"
        chunks.append(f"--- thread {tid}（{role}）---\n"
                      + "".join(traceback.format_stack(frame)).rstrip())
    return "\n".join(chunks)


def _install_exit_signal_trace():
    """SIGINT/SIGBREAK 到达瞬间落盘信号种类 + 全部线程栈，随后按默认语义抛
    KeyboardInterrupt（Ctrl+C 仍照常退出，只多留证据，不改行为）。仅主线程可调。"""
    import signal

    def _on_exit(signum, frame):
        name = {getattr(signal, "SIGINT", -1): "SIGINT（Ctrl+C）",
                getattr(signal, "SIGBREAK", -2): "SIGBREAK（Ctrl+Break）",
                }.get(signum, f"signal {signum}")
        _SIGNAL_DUMP_MARK["got"] = True
        _SIGNAL_DUMP_MARK["name"] = name
        log.warning("收到退出信号 %s，主线程在 serve_forever 中被打断；全部线程栈：\n%s",
                    name, _dump_all_threads())
        for h in logging.getLogger().handlers:  # 关控制台场景系统只给几秒，立即刷盘
            h.flush()
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, _on_exit)
    if hasattr(signal, "SIGBREAK"):  # Windows 专属：Ctrl+Break（关窗是 CTRL_CLOSE_EVENT，Python 无对应信号，抓不到）
        signal.signal(signal.SIGBREAK, _on_exit)


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
    # 升级静默检查（plan §5.5；第557次：升级动作只在安装脚本执行，这里只打日志提示）
    threading.Thread(target=install.silent_check, args=(log.info,), daemon=True).start()
    url = f"http://{cfg['host']}:{cfg['port']}"
    log.info(f"VocabRadar backend v{VERSION} -> {url}")

    # 预检失败即退出，不自动递延换端口（用户自行解除占用或 --port 指定）
    if _port_in_use(cfg["host"], cfg["port"]):
        log.error(f"端口 {cfg['port']} 已被占用（常见原因：另一个 backend 实例仍在运行）。"
                  f"请先解除占用（结束占用进程），或用 --port 指定其他端口后重试。")
        sys.exit(1)

    if os.environ.get("BACKEND_NO_BROWSER") != "1":
        threading.Timer(1.5, webbrowser.open, args=(url,)).start()

    # 第559次：banner 之后 werkzeug 的 INFO 启动行被 logs.py 收敛，控制台无输出即
    # 服务在跑；此前 app.run 若异常/静默返回，backend.log 无任何痕迹（用户报闪退
    # 无法定位）。这里加进入/退出锚点并把异常落文件——Ctrl+C 与真异常分开记。
    _install_exit_signal_trace()
    log.info("进入 HTTP 服务循环：%s （Ctrl+C 退出，本行之后无输出属正常）", url)
    try:
        app.run(host=cfg["host"], port=cfg["port"], debug=False)
    except KeyboardInterrupt:
        # 信号处理器已落盘信号种类+全线程栈，这里只补一条语义日志后照常退出
        log.info("收到 Ctrl+C（KeyboardInterrupt），HTTP 服务循环退出")
        raise
    except BaseException:
        log.exception("HTTP 服务循环异常退出")
        raise
    finally:
        if not _SIGNAL_DUMP_MARK["got"]:
            # werkzeug 吞掉的 KeyboardInterrupt 必经信号处理器打点；走到这里说明
            # serve_forever 是被 shutdown() 或 _thread.interrupt_main() 终结的
            log.warning("HTTP 服务循环未经退出信号即返回（疑似库线程 interrupt_main/"
                        "shutdown），现场线程栈：\n%s", _dump_all_threads())
        log.info("HTTP 服务循环已结束，进程退出")


if __name__ == "__main__":
    main()
