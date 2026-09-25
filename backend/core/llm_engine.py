"""LLM 引擎：llama.cpp llama-server 子进程管理（阶段一第 3 条实现）。

规划要点（plan-backend §3.2/§3.3）：
- 启动：llama-server -hf <repo>:<quant>（第431次：卡片 command 即权威，模型
  交 llama.cpp 自动下载/管理，hub 缓存 %USERPROFILE%/.cache/huggingface/hub）
- 三源健壮性（第431次裁定）：-hf 官方源 → 失败且无缓存时 MODEL_ENDPOINT 指向
  hf-mirror 重试 → 仍失败且有 fallback_url 时 -mu/-mmu ModelScope 直链
- 生命周期：resident（Flask 启动即后台拉起）/ on-demand（首请求拉起 + 空闲 idle_timeout 退出）
- backend 对外反代其 /v1/*；7788 仅内部使用
- b10964+ 包结构：llama-server.exe 为薄启动器，实现在 llama-server-impl.dll
"""

import collections
import logging
import os
import shlex
import subprocess
import threading
import time
import urllib.request

import config

log = logging.getLogger(__name__)

# 第419次：pid 文件治理——后端退出走 atexit 自动停机；后端被 taskkill /F 强杀、
# 断电等未及清理时，下次 start() 读 pid 文件先行终止残留 llama-server，防 7788 双占。
_PID_FILE = os.path.join(config.BASE_DIR, ".llama-server.pid")

# 第425次：卡片 command 中「带值旗标」白名单——用于 --flag=value 预拆与带值
# 消费；--host/--port/-c 强制覆盖为配置值（后端反代依赖），其余（含 -m/
# --mmproj/-hf 等模型旗标）第431次起一律保留命令声明值原样透传（模型交
# llama.cpp 自管，引擎不再注入任何模型路径）。
_CMD_VALUE_FLAGS = {"-m", "--model", "--mmproj", "--host", "--port",
                    "-c", "--ctx-size", "--temp", "--top-p", "--top-k",
                    "--min-p", "--repeat-penalty"}

# 第431次：三源重试链层②的镜像端点（llama.cpp 读 MODEL_ENDPOINT 重定向
# repo 解析请求；hf-cache.cpp 实证 b10964 支持）。
_HF_MIRROR = "https://hf-mirror.com/"

# -hf 的等价长形式（_swap_hf_to_url 识别用；llama.cpp -hf/-hfr/--hf-repo 同义）
_HF_REPO_FLAGS = {"-hf", "-hfr", "--hf-repo"}


def _hub_cache_dir():
    """hf-cache.cpp 同序解析 hub 缓存根（第431次调研实证）：LLAMA_CACHE →
    HF_HUB_CACHE → HUGGINGFACE_HUB_CACHE → HF_HOME(+hub) →
    XDG_CACHE_HOME(+huggingface/hub) → USERPROFILE(+.cache/huggingface/hub)。"""
    env = os.environ
    for k in ("LLAMA_CACHE", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        v = env.get(k)
        if v:
            return v
    v = env.get("HF_HOME")
    if v:
        return os.path.join(v, "hub")
    v = env.get("XDG_CACHE_HOME")
    if v:
        return os.path.join(v, "huggingface", "hub")
    return os.path.join(os.environ.get("USERPROFILE") or os.path.expanduser("~"),
                        ".cache", "huggingface", "hub")


def _repo_cache_path(repo):
    """hf_repo（org/name）→ hub 缓存目录 models--<org>--<name> 实际路径；
    不存在返回 None。目录名匹配大小写不敏感（用户手改 hf_repo 大小写不误判）。"""
    org, _, name = str(repo or "").strip().strip("/").partition("/")
    if not org or not name:
        return None
    root = _hub_cache_dir()
    target = f"models--{org}--{name}".casefold()
    try:
        for e in os.scandir(root):
            if e.name.casefold() == target and e.is_dir():
                return e.path
    except OSError:
        pass
    return None


def _hub_cache_bytes():
    """hub 缓存根下全部 blobs 字节总量（无根目录返回 None）。

    start() 等待期每轮取一次：大小变化=下载活动进行中，据此延长健康等待
    超时（首次自动下载 3.3G 远超原 180s；\r 进度条不产生换行，输出行检测
    不可用，改量测缓存体积）。仅 scandir+stat 元数据，毫秒级开销。"""
    root = _hub_cache_dir()
    total = 0
    try:
        for e in os.scandir(root):
            if not e.is_dir() or not e.name.startswith("models--"):
                continue
            try:
                for b in os.scandir(os.path.join(e.path, "blobs")):
                    if b.is_file():
                        total += b.stat().st_size
            except OSError:
                continue
    except OSError:
        return None
    return total


def _pid_alive_is_llama(pid):
    """pid 复用防护：确认该 pid 当前进程名含 llama 才动手，防误伤复用 pid 的新进程。"""
    try:
        if os.name == "nt":
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=5,
                creationflags=subprocess.CREATE_NO_WINDOW).stdout or ""
            return "llama" in out.lower()
        with open(f"/proc/{pid}/comm", "r", encoding="utf-8", errors="replace") as f:
            return "llama" in (f.read() or "").lower()
    except Exception:
        return False


def _kill_stale_pid():
    """拉起前清场：读 pid 文件，进程名核验通过则终止残留 llama-server，随后删 pid 文件。"""
    try:
        with open(_PID_FILE, "r", encoding="utf-8") as f:
            pid = int((f.read() or "").strip())
    except (OSError, ValueError):
        return
    if pid > 0 and _pid_alive_is_llama(pid):
        log.info(f"发现残留 llama-server（pid={pid}），先行终止")
        try:
            os.kill(pid, 9)  # Windows 上映射 TerminateProcess
        except OSError as e:
            log.warning(f"终止残留进程 pid={pid} 失败：{e}")
    try:
        os.remove(_PID_FILE)
    except OSError:
        pass


def _kill_orphan_llama():
    """第424次：pid 文件丢失兜底——pid 文件可能与活进程脱钩（正常停机清除后进程未死、
    强杀后未及写入），孤儿 llama-server 占 7788 后新实例 bind 不上端口，请求仍打到无
    sampling 旗标的旧服务（复读依旧的根因：旧进程 14616 占口，带旗标新进程 11976 未监听）。
    backend 是本机 llama-server 唯一属主，拉起前按映像名全量清场，不再依赖 pid 文件。"""
    try:
        if os.name == "nt":
            out = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq llama-server.exe", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=10,
                creationflags=subprocess.CREATE_NO_WINDOW).stdout or ""
            pids = [int(cols[1]) for cols in
                    (line.split('","') for line in out.splitlines())
                    if len(cols) > 1 and cols[1].isdigit()]
        else:
            pids = []
            for name in os.listdir("/proc"):
                if not name.isdigit():
                    continue
                try:
                    with open(f"/proc/{name}/comm", "r", encoding="utf-8",
                              errors="replace") as f:
                        if "llama-server" in (f.read() or ""):
                            pids.append(int(name))
                except OSError:
                    continue
    except Exception as e:
        log.warning(f"扫描 llama-server 进程失败：{e}")
        return
    for pid in pids:
        log.info(f"发现 llama-server 进程（pid={pid}），先行终止")
        try:
            os.kill(pid, 9)  # Windows 上映射 TerminateProcess
        except OSError as e:
            log.warning(f"终止进程 pid={pid} 失败：{e}")


class LlmEngine:
    """llama-server 进程属主。实例挂在 app.extensions['engines']（唯一属主）。"""

    def __init__(self, cfg):
        self.cfg = cfg or {}
        self.proc = None
        self.lock = threading.Lock()
        self._starting = False  # start() 健康等待期间为 True，idle_watch 须避让
        # 第409次：手动停机标志——stop() 置位、start() 解除；置位期间惰性拉起点
        # （api/llm.py 反代、core/ocr.py LLM 识别）不得自动拉起。
        # 第410次：从 config.json <llm>.stopped 恢复——进程重启后仍尊重上次的主动关停
        self._manual_stop = bool(self.cfg.get("stopped"))
        self.inflight = 0       # 活跃请求数（on-demand 防推理中被空闲误杀）
        self.last_used = time.time()
        # 第431次：最近输出环形缓冲（启动即退出报错附证据，不遮蔽失败原因）
        self._last_lines = collections.deque(maxlen=8)
        if self.cfg.get("mode", "resident") == "on-demand":
            threading.Thread(target=self._idle_watch, daemon=True).start()

    # ---- 状态与路径 ----

    def status(self):
        return {
            "running": self.proc is not None and self.proc.poll() is None,
            "engine": self.cfg.get("engine", "llamacpp"),
            "mode": self.cfg.get("mode", "resident"),
            "port": self.cfg.get("port", 7788),
            "model": self.cfg.get("model", ""),   # 当前卡片名（llm.model，第431次由文件名改卡片名）
            "cards": self.list_cards(),            # 卡片只读清单（管理页展示，第431次替代 models 下拉）
            "manual_stop": self._manual_stop,      # 第409次：手动停机中（惰性拉起被抑制）
        }

    def base_url(self):
        return f"http://127.0.0.1:{self.cfg.get('port', 7788)}"

    def server_path(self):
        """定位 llama-server 可执行文件；排除 -impl.dll（薄启动器结构的实现库）。"""
        cands = []
        for root, _dirs, files in os.walk(config.BIN_DIR):
            for f in files:
                if f.startswith("llama-server"):
                    cands.append(os.path.join(root, f))
        exact = f"llama-server{'.exe' if os.name == 'nt' else ''}"
        hit = next((h for h in cands if os.path.basename(h) == exact), None)
        if hit:
            return hit
        return next((h for h in cands
                     if os.path.splitext(h)[1] not in (".dll", ".so", ".dylib")), None)

    def _current_card(self):
        """第431次：当前生效卡片——llm.model 为卡片名（匹配 cards[].name），
        未命中或为空回落首卡；无卡片返回 None（start() 报错）。"""
        cards = [c for c in (self.cfg.get("cards") or []) if isinstance(c, dict)]
        chosen = (self.cfg.get("model") or "").strip().lower()
        if chosen:
            hit = next((c for c in cards
                        if str(c.get("name") or "").strip().lower() == chosen), None)
            if hit:
                return hit
            log.warning("llm.model=%r 未命中卡片名，回落首卡", chosen)
        return cards[0] if cards else None

    def card_installed(self, card):
        """第431次：installed 判定=hub 缓存存在 models--<org>--<name> 目录
        （模型交 llama.cpp 自管后，引擎不再持有 models/ 落盘视图）。"""
        repo = str((card or {}).get("hf_repo") or "").strip()
        return bool(repo) and _repo_cache_path(repo) is not None

    def list_cards(self):
        """卡片只读清单（管理页展示数据源）：name/desc/installed。"""
        out = []
        for c in (self.cfg.get("cards") or []):
            if not isinstance(c, dict):
                continue
            out.append({"name": str(c.get("name") or ""),
                        "desc": str(c.get("desc") or ""),
                        "installed": self.card_installed(c)})
        return out

    def _command_argv(self, card, exe):
        """第431次：解析卡片 command 为启动 argv——卡片命令即权威，模型交
        llama.cpp 自管（-hf 自动下载/缓存命中离线可用），引擎不再注入任何
        模型路径（原 -m/--mmproj 强制绝对路径与兜底追加一并撤除）。

        规则：argv[0] 忽略（统一用引擎自定位 exe，保证 GPU 版二进制）；
        --host/--port/--ctx-size 强制配置值（后端反代依赖）；--jinja 缺失追加
        （reasoning_content 链路依赖）；-m/--mmproj/-hf 等模型旗标与 --temp 等
        采样旗标一律保留命令声明值，仅采样在命令未含时按 card.sampling 注入；
        其余旗标逐 token 透传。command 空/解析失败返回 None，调用方报错。"""
        raw = str((card or {}).get("command") or "").strip()
        if not raw:
            return None
        try:
            tokens = shlex.split(raw, posix=False)
        except ValueError as e:
            log.warning("卡片 command 解析失败（%s），回落内置模板：%r", e, raw)
            return None
        # posix=False 保留引号于 token 内（Windows 路径反斜杠安全），此处剥引号
        tokens = [t[1:-1] if len(t) >= 2 and t[0] == t[-1] and t[0] in "\"'" else t
                  for t in tokens]
        tokens = [t for t in tokens if t]
        if len(tokens) < 2:  # 除可执行名外无任何旗标，无解析价值
            return None
        argv, seen = [exe], set()
        i = 1
        while i < len(tokens):
            t = tokens[i]
            low = t.lower()
            if low.startswith("--") and "=" in t:  # --flag=value 预拆为两 token 统一处理
                flag, _, val = t.partition("=")
                flag = flag.lower()
                val = val[1:-1] if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'" else val
                if flag in _CMD_VALUE_FLAGS:
                    tokens[i:i + 1] = [flag, val]
                    continue
            if low in _CMD_VALUE_FLAGS:
                seen.add(low)
                if low == "--host":
                    argv += [low, "127.0.0.1"]
                elif low == "--port":
                    argv += [low, str(self.cfg.get("port", 7788))]
                elif low in ("-c", "--ctx-size"):
                    argv += [low, str(self.cfg.get("ctx", 16384))]
                elif i + 1 < len(tokens):  # 模型/采样旗标：一律保留命令声明值
                    argv += [low, tokens[i + 1]]
                else:
                    log.warning("卡片 command 旗标 %s 缺值，已丢弃", low)
                i += 2
            else:
                seen.add(low)
                argv.append(t)
                i += 1
        if "--jinja" not in seen:
            argv += ["--jinja"]
        # 命令未声明的采样旗标按 card.sampling 注入（第420/422次映射沿用）
        smp = (card or {}).get("sampling")
        if isinstance(smp, dict):
            for flag, key in (("--temp", "temperature"), ("--top-p", "top_p"),
                              ("--top-k", "top_k"), ("--min-p", "min_p"),
                              ("--repeat-penalty", "repeat_penalty")):
                if key in smp and flag not in seen:
                    argv += [flag, str(smp[key])]
        return argv

    # ---- 生命周期 ----

    def start(self, timeout=180):
        """拉起 llama-server 并等 /health 就绪（幂等，可并发调用）。

        第431次三源健壮性：①卡片 command 原样（-hf 官方源，缓存命中离线
        可用）；②失败且无缓存时 MODEL_ENDPOINT 指向 hf-mirror 重试同命令；
        ③仍失败且有 fallback_url 时 -hf 换 -mu（多模态加 -mmu）走直链。
        任一档就绪即返回；全败汇总报错（附尾部输出，不遮蔽）。下载/加载期
        健康等待按 hub 缓存体积增长自动续期（首次自动下载远超 timeout）。"""
        with self.lock:
            if self.proc is not None and self.proc.poll() is None:
                self._manual_stop = False  # 已在运行，仅解除手动停机抑制
                config.set_engine_stopped("llm", False)  # 第410次：同步清持久化标志
                return True
            self._manual_stop = False  # 显式 start（管理页按钮）解除手动停机抑制
            config.set_engine_stopped("llm", False)  # 第410次：同步清持久化标志
            exe = self.server_path()
            if not exe:
                raise RuntimeError("未找到 llama-server（backend/bin/）。请先运行 backend/scripts/install.py。")
            card = self._current_card()
            if card is None:
                raise RuntimeError("未配置模型卡片（config.json llm.cards），无法拉起 llama-server")
            args = self._command_argv(card, exe)
            if args is None:
                raise RuntimeError(
                    f"卡片 {card.get('name')!r} 的 command 未配置或解析失败，无法拉起 llama-server")
            _kill_stale_pid()  # 第419次：拉起前终止残留旧进程（再次启动先关停旧进程）
            _kill_orphan_llama()  # 第424次：按映像名兜底清场——pid 文件丢失的孤儿占口不再漏网
            self._starting = True  # 置位，idle_watch 在健康等待期避让
        try:
            errors = []
            # 第①源：官方 hf（llama.cpp 自管下载；缓存命中则离线可用）
            try:
                self._spawn_and_wait(args, None, "hf", exe, timeout)
                return True
            except RuntimeError as e:
                errors.append(f"hf 源：{e}")
                if self._manual_stop:  # 等待期间用户手动停机，不再重试
                    raise
            # 有缓存还失败 = 非下载问题（换源重试无意义），直接如实上报
            if _repo_cache_path(card.get("hf_repo")):
                raise RuntimeError("；".join(errors))
            # 第②源：hf-mirror 镜像（MODEL_ENDPOINT 重定向 repo 解析）
            try:
                log.warning("hf 源失败且无本地缓存，改走 hf-mirror：%s", errors[-1])
                self._spawn_and_wait(args, dict(os.environ, MODEL_ENDPOINT=_HF_MIRROR),
                                     "hf-mirror", exe, timeout)
                return True
            except RuntimeError as e:
                errors.append(f"hf-mirror 源：{e}")
                if self._manual_stop:
                    raise
            # 第③源：fallback_url 直链（-hf 换 -mu，多模态卡加 -mmu）
            fb = str(card.get("fallback_url") or "").strip()
            if not fb:
                raise RuntimeError("；".join(errors))
            args3 = self._swap_hf_to_url(args, fb,
                                         str(card.get("fallback_mmproj_url") or "").strip())
            if args3 is None:
                raise RuntimeError("；".join(errors)
                                   + "；卡片 command 未含 -hf，无法改写为直链")
            log.warning("hf-mirror 也失败，改走 fallback_url 直链：%s", errors[-1])
            self._spawn_and_wait(args3, None, "fallback_url", exe, timeout)
            return True
        except RuntimeError:
            with self.lock:
                self._stop_locked()  # 失败残骸清场（terminate 已死进程无害，清 pid 文件）
            raise
        finally:
            self._starting = False

    def _spawn_and_wait(self, args, env, tag, exe, timeout):
        """Popen + 写 pid + 输出采集 + 等待 /health 就绪（三源重试链共用）。"""
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        p = subprocess.Popen(args, cwd=os.path.dirname(exe), env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             creationflags=flags)
        with self.lock:  # 短持锁赋值，防与并发 stop() 竞态
            self.proc = p
        try:  # 第419次：记录 pid，供后端异常退出后下次启动清场
            with open(_PID_FILE, "w", encoding="utf-8") as f:
                f.write(str(p.pid))
        except OSError as e:
            log.warning(f"写 pid 文件失败：{e}")
        # 第432次：下载/启动前打印完整执行命令（可复制复现；三源重试每层各打一条）
        log.info("拉起 llama-server（%s 源，端口 %s）：%s",
                 tag, self.cfg.get("port", 7788), subprocess.list2cmdline(args))
        if env is not None and env.get("MODEL_ENDPOINT"):
            log.info("镜像端点：MODEL_ENDPOINT=%s", env["MODEL_ENDPOINT"])
        self._last_lines.clear()  # 先清再启采集线程，防首行被清竞态
        # 输出采集（plan §5.4）：后台读线程逐行入日志，排障不再黑洞
        threading.Thread(target=self._drain_output, args=(p.stdout,), daemon=True).start()
        deadline = time.time() + timeout
        last_bytes = _hub_cache_bytes()
        while time.time() < deadline:
            if p.poll() is not None:
                tail = " ｜ ".join(self._last_lines) or "无输出"
                raise RuntimeError(f"启动即退出（code {p.returncode}）：{tail}")
            try:
                with urllib.request.urlopen(f"{self.base_url()}/health", timeout=2) as r:
                    if r.status == 200:
                        log.info("llama-server 就绪（%s 源）", tag)
                        self.touch()  # 就绪即刷新空闲基准：闭合 _starting=False → api 层 touch() 间的误杀窗口
                        return True
            except Exception:
                pass
            b = _hub_cache_bytes()
            if b is not None:
                if last_bytes is None:  # 首轮仅建基线，防无下载活动也白续期
                    last_bytes = b
                elif b != last_bytes:   # 缓存体积在涨=下载进行中，续期
                    last_bytes = b
                    deadline = max(deadline, time.time() + 120)
            time.sleep(0.5)
        raise RuntimeError(f"健康等待超时（{timeout}s，下载活跃自动续期后仍超时）")

    @staticmethod
    def _swap_hf_to_url(argv, fb_url, fb_mmproj):
        """第③源 argv 改写：-hf <repo>[:<quant>] 替换为 -mu <fallback_url>；
        多模态卡有 fallback_mmproj_url 时追加 -mmu。未找到 -hf 返回 None。"""
        out, i, swapped = [], 0, False
        while i < len(argv):
            t = argv[i]
            low = t.lower()
            if low in _HF_REPO_FLAGS and i + 1 < len(argv):
                out += ["-mu", fb_url]
                swapped = True
                i += 2
            elif low.startswith("--hf-repo=") or low.startswith("-hf="):
                out += ["-mu", fb_url]
                swapped = True
                i += 1
            else:
                out.append(t)
                i += 1
        if not swapped:
            return None
        if fb_mmproj:
            out += ["-mmu", fb_mmproj]
        return out

    def stop(self, manual=True):
        """停机。manual=True（管理页按钮）置位手动停机标志并持久化（第410次：
        进程重启后不再自动拉起）；manual=False（on-demand 空闲自动退出）不置位，
        下次请求照常自动拉起。"""
        if manual:
            with self.lock:
                self._manual_stop = True
                self._stop_locked()
            config.set_engine_stopped("llm", True)  # 第410次：持久化主动关停
        else:
            with self.lock:
                self._stop_locked()

    def auto_start_allowed(self):
        """惰性拉起点（api/llm.py、core/ocr.py）用：手动停机期间返回 False。"""
        return not self._manual_stop

    def _stop_locked(self):
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        self.proc = None
        try:  # 第419次：pid 文件随停机清除（进程已自行退出也清，保持无残留）
            os.remove(_PID_FILE)
        except OSError:
            pass

    def _drain_output(self, stream):
        """后台读线程：llama-server 输出逐行入日志（stderr 已并入 stdout）。

        进程退出/管道关闭时 for 循环 EOF 自然结束；流以局部引用固定，
        防止 stop() 后重启新实例时误读新管道。"""
        try:
            for raw in stream:
                line = raw.decode("utf-8", "replace").rstrip()
                if line:
                    self._last_lines.append(line)  # 最近输出环形缓冲，供启动即退出报错取证
                    log.info("llama-server: %s", line)
        except (OSError, ValueError):
            pass

    def touch(self):
        """记录最近使用时刻（on-demand 空闲计时基准）。"""
        self.last_used = time.time()

    def begin_request(self):
        """活跃请求开始：inflight+1 并刷新空闲基准（推理期间不被空闲误杀）。"""
        with self.lock:
            self.inflight += 1
            self.last_used = time.time()

    def end_request(self):
        """活跃请求结束（含异常/断连）：inflight-1，空闲从请求结束重新计时。"""
        with self.lock:
            self.inflight = max(0, self.inflight - 1)
            self.last_used = time.time()

    def ensure_started(self):
        """resident 模式后台预拉（不阻塞 Flask 服务）；on-demand 交由首请求。"""
        if self.cfg.get("mode", "resident") == "resident":
            threading.Thread(target=self._safe_start, daemon=True).start()

    def _safe_start(self):
        try:
            self.start()
        except Exception as e:
            log.error(str(e))

    def _idle_watch(self):
        """on-demand 空闲退出线程（daemon）。"""
        timeout = int(self.cfg.get("idle_timeout", 600))
        step = min(30, max(1, timeout // 10))
        while True:
            time.sleep(step)
            if (not self._starting  # start() 健康等待期不退出（防模型加载中被误杀）
                    and self.inflight == 0  # 有活跃请求不退出（防长推理中被误杀）
                    and self.proc is not None and self.proc.poll() is None
                    and time.time() - self.last_used > timeout):
                log.info(f"空闲超过 {timeout}s，退出 llama-server（on-demand）")
                self.stop(manual=False)  # 空闲自动退出不算手动停机，不抑制下次拉起
