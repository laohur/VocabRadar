"""backend 升级器（plan-backend §5.5）。

三资产检查 + 两动作，动作一律后台线程执行（下载耗时不可控，前端轮询 status）：
- backend 自身：无对外发布仓库，Ghost 原则只提示（skipped，用户重下 zip 覆盖，
  config 均保留）
- llama.cpp：bin/llamacpp/.tag 对比远端 release；动作 = 下载到临时目录 → 解压
  验证 → 回调停服（Windows 文件锁；llm 引擎惰性启动，下次请求自动用新版本）
  → 原子换名 → 写 .tag
- yt-dlp：venv 内 pip 升级；core/ytdl.py 进程内 import yt_dlp，升级后须重启后端

（第431次：模型升级撤除——模型改 llama-server -hf 自动下载进 HF hub 缓存，
无需手动升级体系。）

复用 scripts/install 的网络/下载/解压原子件（同进程 import，不复制代码）。
install 内部 fail() 会 sys.exit，本模块统一捕获 SystemExit 转升级错误，
防止误杀 Flask 进程。启动静默检查走 silent_check()（只写日志，不打扰）。
"""

import logging
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import scripts.install as inst  # backend 在 sys.path 时可用（python app.py 启动）

BACKEND = Path(__file__).resolve().parent.parent
BIN_DIR = BACKEND / "bin"

ACTIONS = ("llamacpp", "ytdlp")

_lock = threading.Lock()
_state = {"running": False, "action": None, "stage": "", "log": [],
          "error": None, "ok": None}
_check_cache = None  # 第416次：检查结果缓存（含错误态）——只查一次不重试

log = logging.getLogger(__name__)  # 随 app 进程运行，handler 由 core/logs.py 统一挂


def _log(msg):
    _state["log"].append(msg)
    log.info(msg)


def _stage(s):
    _state["stage"] = s


# ---------- 检查 ----------

def llamacpp_tag():
    """本地 llama.cpp 版本（bin/llamacpp/.tag，install step3 落盘）。"""
    try:
        return (BIN_DIR / "llamacpp" / ".tag").read_text(encoding="utf-8").strip()
    except OSError:
        return None


def _llamacpp_patterns():
    manifest = inst.load_manifest()
    return manifest["llamacpp"]["assets"][inst.llamacpp_platform_key(manifest)]


def check_llamacpp():
    current = llamacpp_tag()
    if not current:
        return {"status": "missing"}
    try:
        tag, _assets = inst.resolve_llamacpp_release(
            _llamacpp_patterns(), purpose="检查 llama.cpp 新版本")
    except SystemExit:
        # install.fail 已把详情打到后端控制台；这里不中断检查其余资产
        return {"status": "error", "current": current,
                "detail": "GitHub 访问失败或无匹配资产（详情见后端控制台）"}
    return {"status": "ok", "current": current, "latest": tag,
            "update_available": tag != current}


def check_ytdlp():
    from importlib.metadata import version as pkg_version
    try:
        current = pkg_version("yt-dlp")
    except Exception:
        return {"status": "missing"}
    import requests
    try:
        r = requests.get("https://pypi.org/pypi/yt-dlp/json", timeout=10)
        r.raise_for_status()
        latest = r.json()["info"]["version"]
    except Exception as e:
        return {"status": "error", "current": current, "detail": str(e)}
    return {"status": "ok", "current": current, "latest": latest,
            "update_available": latest != current}


def check_all():
    """三资产检查（同步网络请求，几秒；GitHub 不可达时最坏数分钟）。

    第416次：检查不是要紧事，只查一次不重试——启动 silent_check 算的那次
    即唯一网络检查，结果（含错误态）缓存于 _check_cache；升级动作完成后
    缓存失效（_run finally），下次检查重算一次。缓存命中不重复打网络。"""
    global _check_cache
    if _check_cache is not None:
        return _check_cache
    result = {
        "backend": {"status": "skipped",
                    "reason": "backend 无对外发布仓库；升级请到发布页重新下载覆盖"
                              "（config 自动保留）"},
        "llamacpp": check_llamacpp(),
        "ytdlp": check_ytdlp(),
    }
    log.info("升级检查完成：llama.cpp=%s yt-dlp=%s",
             (result.get("llamacpp") or {}).get("status"),
             (result.get("ytdlp") or {}).get("status"))
    _check_cache = result
    return result


def silent_check():
    """启动时静默检查（app.py 后台线程调用）：有更新仅日志提示，不打扰。"""
    time.sleep(3)  # 让先启动的引擎日志走完，提示不插队
    try:
        result = check_all()
    except Exception as e:  # 静默检查绝不影响启动
        log.warning(f"启动检查失败（可忽略）：{e}")
        return
    for name in ("llamacpp", "ytdlp"):
        st = result.get(name) or {}
        if st.get("update_available"):
            log.info(f"{name} 有新版本：{st['current']} → {st['latest']}，"
                     f"可在管理界面升级中心处理")


# ---------- 动作（后台线程） ----------

def start(action, stop_llm=None):
    """启动升级动作；已有动作进行中返回 False（互斥）。"""
    if action not in ACTIONS:
        raise ValueError(f"未知升级动作：{action}")
    with _lock:
        if _state["running"]:
            return False
        _state.update(running=True, action=action, stage="准备中",
                      log=[], error=None, ok=None)
    threading.Thread(target=_run, args=(action, stop_llm),
                     daemon=True).start()
    return True


def status():
    with _lock:
        return {**_state, "log": _state["log"][-50:]}


def _run(action, stop_llm):
    global _check_cache
    try:
        if action == "llamacpp":
            _upgrade_llamacpp(stop_llm)
        else:
            _upgrade_ytdlp()
        _state["ok"] = True
        _stage("完成")
    except SystemExit as e:  # install.fail()
        _fail(str(e) if str(e) != "1" else "升级失败（详情见后端控制台）")
    except Exception as e:
        _fail(f"{type(e).__name__}: {e}")
    finally:
        _state["running"] = False
        _check_cache = None  # 第416次：动作完成后缓存失效，下次检查重算一次


def _fail(msg):
    _state["ok"] = False
    _state["error"] = msg
    _stage("失败")
    _log(f"升级失败：{msg}")


def _upgrade_llamacpp(stop_llm):
    _stage("探测远端 release")
    tag, assets = inst.resolve_llamacpp_release(_llamacpp_patterns(),
                                                purpose="升级 llama.cpp")
    current = llamacpp_tag()
    if current == tag:
        _log(f"llama.cpp 已是最新（{tag}）")
        return
    total_mb = sum(a.get("size", 0) for a in assets) // 1048576
    _log(f"目标 {tag}：{' + '.join(a['name'] for a in assets)}（约 {total_mb} MB）")

    unpack = BIN_DIR / "_unpack"
    shutil.rmtree(unpack, ignore_errors=True)
    unpack.mkdir(parents=True, exist_ok=True)
    for asset in assets:  # 多资产配套（如 CUDA：cudart 运行时 + 主包）
        _stage(f"下载 {asset['name']}")
        archive = inst.download_asset(asset, BIN_DIR)
        _stage(f"解压 {asset['name']}")
        inst.safe_extract(archive, unpack)
        archive.unlink()

    server = next((p for p in unpack.rglob("llama-server*") if p.is_file()), None)
    if not server:
        shutil.rmtree(unpack, ignore_errors=True)
        raise RuntimeError("解压产物中未找到 llama-server")

    _stage("停用引擎")
    if stop_llm:
        stop_llm()  # Windows 文件锁；llm 惰性启动，下次请求自动用新二进制

    _stage("就位替换")
    dest = BIN_DIR / "llamacpp"
    shutil.rmtree(dest, ignore_errors=True)
    shutil.move(str(server.parent), str(dest))
    for p in [p for p in unpack.rglob("*") if p.is_file()]:  # 其余包平铺并入
        if not p.exists():  # 已随 llama-server 所在目录一并移动
            continue
        target = dest / p.name
        if not target.exists():
            shutil.move(str(p), str(target))
    shutil.rmtree(unpack, ignore_errors=True)
    (dest / ".tag").write_text(tag, encoding="utf-8")
    if sys.platform == "darwin":
        inst.remove_quarantine(dest)
    _log(f"llama.cpp {current or '未安装'} → {tag}（下次引擎启动生效）")


def _upgrade_ytdlp():
    _stage("pip 升级 yt-dlp")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-U", "yt-dlp"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"pip 升级失败：{(r.stderr or r.stdout).strip()[-500:]}")
    for line in (r.stdout or "").strip().splitlines()[-3:]:
        _log(line)
    _log("yt-dlp 已升级（当前进程仍用旧模块，重启后端生效）")
