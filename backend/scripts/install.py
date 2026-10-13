"""VocabRadar backend 安装器 + 升级器（幂等；首次部署手动运行一次，日常启动无需再跑）。

安装（默认，无参数）——plan-backend §5.3：
0. 状态检查：读 backend/.installed.json 打印上次安装信息供参考（第514次撤销
   第401次"已装即退出"——跳过会让 requirements 更新后的增量依赖永远装不上；
   本脚本各步幂等，依赖已满足时 pip 秒过、llama.cpp 已就位时跳过下载）
1. 检查 Python >= 3.10（不内置 Python；脚本能跑即有解释器，环境用户自备不代管）
2. 用当前 Python 环境装依赖（已满足时 pip 自动跳过）；ffmpeg 执行器由
   static-ffmpeg 提供（第514次替代 imageio-ffmpeg，系统 PATH 缺失时运行时按需下载）
2b. whisper GPU 支持（可选，第558次）：检测到 NVIDIA GPU 才询问 y/N（--whisper-gpu
   yes|no 可跳过询问）；装 = pip 装 cuBLAS 12 运行库（Windows 下 cuDNN 9 已随
   ctranslate2 wheel 自带，仅 Linux 需另装 cudnn 包）。不装 whisper 走 CPU，
   管理界面 ASR 页不出现 GPU 设定卡
3. 按 backend/scripts/manifest.json 下载 llama.cpp 预编译包到 backend/bin/
   （已存在跳过 → 支持离线手动放置）
4. 健康自检（llama-server --version），写安装状态到 backend/.installed.json
   （模型 GGUF 不归本脚本管，第431次：llama-server -hf 自动下载进 HF hub 缓存）

升级（第557次用户裁定：升级能力唯一入口=本脚本，管理界面不设升级中心）：
    python backend/scripts/install.py --check              # 只查新版本，不改动
    python backend/scripts/install.py --upgrade            # 升级全部（llama.cpp + yt-dlp）
    python backend/scripts/install.py --upgrade llamacpp   # 只升级 llama.cpp
    python backend/scripts/install.py --upgrade ytdlp      # 只升级 yt-dlp
- llama.cpp：解析远端 release → 下载到 _unpack 验证 → 终止本机 llama-server
  （Windows 文件锁）→ 原子换名 bin/llamacpp → 写 .tag
- yt-dlp：venv 内 pip install -U；backend 需重启（core/ytdl 进程内已 import yt_dlp）
- backend 自身：无对外发布仓库，只提示（重新下载 zip 覆盖，config/bin 保留）
- app 启动仍走 silent_check()（只写一条日志提示升级命令，不打扰）

第443次（用户裁定）：NM 自动唤起整套撤销——扩展不再经 Native Messaging 拉起
backend，日常启动由用户手动执行 python backend/app.py；原步骤 4 的 NM 注册
（backend/scripts/native-messaging/）随之整体删除。
"""

import argparse
import fnmatch
import json
import os
import platform as plat
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent  # 本脚本在 backend/scripts/ 下
BIN_DIR = BACKEND / "bin"
MANIFEST_PATH = Path(__file__).resolve().parent / "manifest.json"
STATE_PATH = BACKEND / ".installed.json"  # 环境与安装状态记录（本脚本独占写读）
IS_WIN = os.name == "nt"

GITHUB_RELEASES = "https://api.github.com/repos/ggml-org/llama.cpp/releases"


def info(msg):
    print(f"[安装] {msg}")


def warn(msg):
    print(f"[警告] {msg}")


class InstallError(Exception):
    """软失败（soft fail）：检查类只读场景不终止进程，由调用方决定呈现方式。"""


def fail(msg, soft=False):
    """硬失败：打印到 stderr 并 sys.exit（进程内调用方统一捕获 SystemExit）。

    soft=True 时改抛 InstallError——`--check` / 启动静默检查要继续看其余资产，
    不能被一次网络失败整进程退出。
    """
    if soft:
        raise InstallError(msg)
    print(f"[错误] {msg}", file=sys.stderr)
    sys.exit(1)


_GH_MIRRORS = ["https://ghfast.top", "https://gh-proxy.com", "https://ghproxy.net"]
_gh_proxy = None  # 自适应探测结果缓存（None=未探测）


def _reachable(url):
    """HEAD 探测网络可达性：拿到任何 HTTP 响应（含 4xx/5xx）即算通，
    仅连接层异常（超时/重置/DNS 失败）算不通。"""
    import requests
    try:
        requests.head(url, timeout=4, allow_redirects=True)
        return True
    except requests.RequestException:
        return False


def resolve_gh_proxy(purpose=None):
    """GitHub 代理自适应（结果缓存）：环境变量 GH_PROXY 优先；未设时探测
    github.com 直连，不通则从镜像列表选第一个可用的（国内直连 github.com 及其
    下载 CDN objects.githubusercontent.com 常被重置，2026-09 实机核实）。
    purpose：本次访问的目的（第412次：日志须说明在干啥、连啥）。"""
    global _gh_proxy
    if _gh_proxy is not None:
        return _gh_proxy
    what = f"『{purpose}』" if purpose else "GitHub 访问"
    env = os.environ.get("GH_PROXY", "").rstrip("/")
    if env:
        _gh_proxy = env
        return env
    if _reachable("https://github.com") and _reachable("https://objects.githubusercontent.com"):
        # 直连判据含下载 CDN 域：github.com 通而 objects CDN 不通时（2026-09 实机
        # 核实的组合）仍须走镜像，否则 release 资产下载必挂
        _gh_proxy = ""
    else:
        _gh_proxy = next((m for m in _GH_MIRRORS if _reachable(m)), "")
        if _gh_proxy:
            info(f"{what}：github.com 直连失败，自动使用镜像 {_gh_proxy}（也可设 GH_PROXY 强制指定）")
        else:
            warn(f"{what}：github.com 与已知镜像均不可达，回退直连（下载可能失败）")
    return _gh_proxy


def gh_url(url, purpose=None):
    """GitHub 下载地址按代理自适应换镜像（见 resolve_gh_proxy）。"""
    proxy = resolve_gh_proxy(purpose)
    if proxy and url.startswith("https://github.com/"):
        return f"{proxy}/{url}"
    return url


def gh_request(url, stream=False, purpose=None, soft=False):
    """GitHub GET：镜像替换 + 连接级重试（api.github.com 国内偶发 10054 重置）。"""
    import requests
    last = None
    for i in range(3):
        try:
            return requests.get(gh_url(url, purpose), stream=stream,
                                timeout=(30, 60), allow_redirects=True)
        except requests.exceptions.RequestException as e:
            last = e
            if i < 2:
                what = f"『{purpose}』" if purpose else "GitHub 访问"
                info(f"{what}：请求失败（{e}），重试 {i + 1}/3：{url}")
                time.sleep(2 * (i + 1))
    fail(f"{'『' + purpose + '』' if purpose else 'GitHub 访问'}：GitHub 访问失败（已重试 3 次）：{last}\n请求地址：{url}", soft=soft)


def load_state():
    """读安装状态（backend/.installed.json）。无记录返回 None。"""
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def step0_check_state():
    """读安装状态打印上次安装信息（仅参考，不再跳过流程——第514次撤销第401次
    "已装且解释器未变→直接退出"：重跑安装器多半是依赖/资产有更新，整体跳过
    会让 requirements 的增量依赖永远装不上；各步幂等，已满足时开销可忽略）。
    解释器变了（用户换环境）→ 打印提示后按当前环境重装依赖。"""
    st = load_state()
    if not st:
        return
    gpu = "已装" if st.get("whisper_gpu") else "未装"
    if st.get("python") == sys.executable:
        info(f"上次安装：{st.get('installed_at', '?')}（Python {st.get('python_version', '?')}，"
             f"whisper GPU 支持{gpu}），继续幂等检查（依赖已满足时 pip 秒过）。")
    else:
        info(f"检测到解释器变更（{st.get('python')} → {sys.executable}），按当前环境重新安装依赖。")


def record_state():
    """写安装状态：环境（解释器/版本）+ whisper GPU 支持 + 完成时间，
    供下次运行的 step0 展示参考。"""
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump({
                "version": 1,
                "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "python": sys.executable,
                "python_version": sys.version.split()[0],
                "whisper_gpu": cublas_installed() is not None,
            }, f, ensure_ascii=False, indent=2)
    except OSError as e:
        warn(f"写安装状态失败（不影响使用）：{e}")


def step1_check_python():
    if sys.version_info < (3, 10):
        fail(f"需要 Python >= 3.10，当前 {sys.version.split()[0]}。"
             f"请从 https://www.python.org/downloads/ 安装后重跑。")
    info(f"Python {sys.version.split()[0]}（{sys.executable}）")


def step2_prepare_env():
    """用当前 Python 环境装依赖（已满足时 pip 自动跳过）。
    不检测不提示 venv——本脚本能跑即有解释器，环境由用户全权作主。
    ffmpeg 执行器不再单独按需装（第514次：imageio-ffmpeg 废弃）——
    static-ffmpeg 已在 requirements（wheel 仅数 KB），系统 PATH 已有 ffmpeg
    则运行时不会触发其平台二进制下载（core/ytdl._ensure_ffmpeg 补挂）。"""
    info("安装依赖（已满足时 pip 自动跳过）...")
    r = subprocess.run([sys.executable, "-m", "pip", "install",
                        "-r", str(BACKEND / "requirements.txt")])
    if r.returncode != 0:
        fail("依赖安装失败，请检查网络后重试。")


# ===== whisper GPU 支持（可选，第558次） =====

CUBLAS_SIZE_MB = 553  # nvidia-cublas-cu12 wheel 下载体积（2026-10 实测 12.9.2.10）


def cublas_installed():
    """已装 cuBLAS pip 包则返回版本号，未装返回 None（只查元数据不 import）。"""
    from importlib.metadata import version
    try:
        return version("nvidia-cublas-cu12")
    except Exception:
        return None


def nvidia_gpu_present():
    """NVIDIA GPU 探测：nvidia-smi 在 PATH 且能报出型号。返回 (bool, 描述)。"""
    import shutil
    smi = shutil.which("nvidia-smi")
    if not smi:
        return False, ""
    try:
        r = subprocess.run([smi, "--query-gpu=name,memory.total", "--format=csv,noheader"],
                           capture_output=True, text=True, timeout=10)
        line = (r.stdout or "").strip().splitlines()
        if line and line[0].strip():
            return True, line[0].strip()
    except Exception:
        pass
    return False, ""


def step2b_whisper_gpu(force=None):
    """whisper GPU 支持可选安装（第558次用户裁定：可选，装了管理界面才出 GPU 卡）。

    force：None=检测到 NVIDIA GPU 且交互终端才询问 y/N；"yes"=跳过询问直接装；
    "no"=明确跳过。幂等：cuBLAS 已装即跳过。装机集：Windows 仅 nvidia-cublas-cu12
    （cuDNN 9 已随 ctranslate2 wheel 自带，2026-10 实机实证：装 cublas 后 CUDA
    全链路通）；Linux 官方 README 口径 ct2 wheel 不带 cuDNN，另装 cudnn 包。
    安装失败软处理：不终止安装流程，whisper 回落 CPU。"""
    ver = cublas_installed()
    if ver:
        info(f"whisper GPU 支持：nvidia-cublas-cu12 {ver} 已装，跳过。")
        return
    if force == "no":
        info("whisper GPU 支持：按 --whisper-gpu no 跳过（whisper 走 CPU）。")
        return
    has_gpu, desc = nvidia_gpu_present()
    if not has_gpu:
        info("whisper GPU 支持：未检测到 NVIDIA GPU/驱动（nvidia-smi），"
             "跳过（whisper 走 CPU）。")
        return
    if force is None:
        if not (sys.stdin and sys.stdin.isatty()):
            info("whisper GPU 支持：非交互环境，跳过（需安装请加 --whisper-gpu yes）。")
            return
        try:
            ans = input(f"检测到 NVIDIA GPU（{desc}）。是否安装 whisper GPU 加速支持"
                        f"（cuBLAS 12 运行库，下载约 {CUBLAS_SIZE_MB}MB）？[y/N] "
                        ).strip().lower()
        except (EOFError, OSError):
            ans = ""
        if ans not in ("y", "yes"):
            info("已跳过。之后想装：python backend/scripts/install.py --whisper-gpu yes"
                 "（装后管理界面 ASR 页出现 GPU 设定卡，设备默认 auto=检测到即用）。")
            return
    pkgs = ["nvidia-cublas-cu12"]
    if not IS_WIN:
        pkgs.append("nvidia-cudnn-cu12==9.*")  # Linux ct2 wheel 不带 cuDNN（官方口径）
    info(f"安装 whisper GPU 支持：pip install {' '.join(pkgs)} ...")
    r = subprocess.run([sys.executable, "-m", "pip", "install", *pkgs])
    if r.returncode != 0:
        warn("whisper GPU 支持安装失败（不影响其余功能，whisper 走 CPU）；"
             "可重跑本脚本重试。")
        return
    info("whisper GPU 支持安装完成。管理界面 ASR 页将出现 GPU 设定卡"
         "（设备默认 auto：检测到 CUDA 即用 GPU，失败自动回落 CPU）。")


def load_manifest(soft=False):
    try:
        with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        fail(f"读取 {MANIFEST_PATH} 失败：{e}", soft=soft)


def llamacpp_platform_key(manifest):
    """平台 + GPU 偏好 → manifest.llamacpp.assets 的 key（plan §5.2）。"""
    gpu = "auto"
    try:
        with open(BACKEND / "config.json", "r", encoding="utf-8") as f:
            gpu = json.load(f).get("binaries", {}).get("gpu", "auto")
    except (OSError, ValueError):
        pass
    if sys.platform == "darwin":
        if plat.machine() != "arm64":
            warn("macOS 首版仅提供 arm64 资产（plan §5.6）。")
        return "osx-arm64"
    if sys.platform.startswith("linux"):
        return "linux-x64"
    if IS_WIN:
        # auto → win-x64（vulkan 默认：NVIDIA/AMD/Intel 通吃，免 CUDA 版本匹配）
        return {"vulkan": "win-x64", "cuda": "win-x64-cuda", "cpu": "win-x64-cpu"}.get(gpu, "win-x64")
    fail(f"不支持的平台：{sys.platform}")


def find_llama_server():
    """定位 llama-server 可执行文件。b10964+ 包结构：llama-server.exe 是薄启动器
    （实现在 llama-server-impl.dll），须排除同名 .dll/.so，否则 sorted 后会先匹配到它。"""
    cands = sorted(BIN_DIR.rglob("llama-server*"))
    exact = f"llama-server{'.exe' if IS_WIN else ''}"
    return (next((p for p in cands if p.name == exact), None)
            or next((p for p in cands if p.is_file()
                     and p.suffix not in (".dll", ".so", ".dylib")
                     and os.access(p, os.X_OK)), None))


def match_assets(assets, patterns):
    """按 patterns 逐个匹配资产；任一 pattern 未命中 → 返回 None（多资产是配套整体）。"""
    out = []
    for pat in patterns:
        hit = next((a for a in assets if fnmatch.fnmatch(a["name"], pat)), None)
        if not hit:
            return None
        out.append(hit)
    return out


def resolve_llamacpp_release(patterns, purpose=None, soft=False):
    """定位含全部目标资产的 release，返回 (tag, assets)。三级回退：

    ① latest release 自身资产直接命中（官方恢复正式发布模式时走这条）
    ② latest 仅挂 nightly-tag.txt 时（2026-09 实机核实的新模式：latest v0.4.1
       只有该探测文件），读其内容得版本号（如 b10964），取该 tag 的 release
    ③ 回落遍历近期 prerelease，取第一个命中的 nightly

    soft=True：失败改抛 InstallError（`--check`/启动静默检查用，不终止进程）。
    """
    try:
        latest = gh_request(f"{GITHUB_RELEASES}/latest", purpose=purpose, soft=soft).json()
    except Exception as e:
        what = f"『{purpose}』" if purpose else ""
        fail(f"{what}访问 GitHub 失败：{e}\n"
             f"可设 GH_PROXY 指定镜像后重跑（默认已自动探测）；"
             f"或离线手动放置：下载资产解压到 {BIN_DIR / 'llamacpp'}"
             f"（确保其中有 llama-server）。", soft=soft)
    matched = match_assets(latest.get("assets", []), patterns)
    if matched:
        return latest.get("tag_name", "unknown"), matched
    probe = next((a for a in latest.get("assets", [])
                  if a["name"] == "nightly-tag.txt"), None)
    if probe:
        try:
            tag = gh_request(probe["browser_download_url"], purpose=purpose, soft=soft).text.strip()
            resp = gh_request(f"{GITHUB_RELEASES}/tags/{tag}", purpose=purpose, soft=soft)
            if resp.status_code == 200:
                rel = resp.json()
                matched = match_assets(rel.get("assets", []), patterns)
                if matched:
                    return rel.get("tag_name", tag), matched
        except Exception as e:
            warn(f"nightly-tag.txt 探测失败：{e}")
    info("latest 未命中，回落查找近期 nightly prerelease ...")
    try:
        for rel in gh_request(f"{GITHUB_RELEASES}?per_page=30", purpose=purpose, soft=soft).json():
            if not rel.get("prerelease"):
                continue
            matched = match_assets(rel.get("assets", []), patterns)
            if matched:
                return rel.get("tag_name", "unknown"), matched
    except Exception as e:
        warn(f"prerelease 查询失败：{e}")
    fail(f"未找到匹配资产 {patterns}。可离线手动放置到 {BIN_DIR} 后重跑。", soft=soft)


def safe_extract(archive, unpack):
    """按扩展名解压 zip / tar.gz，解压前检查成员路径安全。"""
    import tarfile
    if archive.name.lower().endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            names = z.namelist()
            if any(n.startswith("/") or ".." in Path(n).parts for n in names):
                fail(f"{archive.name} 内含异常路径，中止（疑似非官方包）。")
            z.extractall(unpack)
    else:  # .tar.gz / .tgz
        with tarfile.open(archive) as t:
            names = t.getnames()
            if any(n.startswith(("/", "\\")) or ".." in Path(n).parts
                   for n in names):
                fail(f"{archive.name} 内含异常路径，中止（疑似非官方包）。")
            try:
                t.extractall(unpack, filter="data")  # Py3.12+ 再挡一层危险成员
            except TypeError:
                t.extractall(unpack)


def download_asset(asset, dest_dir):
    """下载单个 release 资产到 dest_dir，返回本地路径。"""
    path = dest_dir / f"_dl_{asset['name']}"
    size_mb = asset.get("size", 0) // 1048576
    info(f"下载 {asset['name']}（约 {size_mb} MB）...")
    with gh_request(asset["browser_download_url"], stream=True) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        done = 0
        with open(path, "wb") as f:
            for chunk in r.iter_content(256 * 1024):
                f.write(chunk)
                done += len(chunk)
                if total:
                    print(f"\r[安装] 下载进度 {done * 100 // total}%",
                          end="", flush=True)
    print()
    return path


def step3_install_llamacpp(manifest):
    if (server := find_llama_server()):
        info(f"llama.cpp 已就绪（{server}），跳过下载。如需更新："
             f"python backend/scripts/install.py --upgrade llamacpp")
        return
    patterns = manifest["llamacpp"]["assets"][llamacpp_platform_key(manifest)]
    tag, assets = resolve_llamacpp_release(patterns, purpose="下载 llama.cpp 预编译包")
    info(f"命中 release {tag}：{' + '.join(a['name'] for a in assets)}")
    _commit_llamacpp(_fetch_llamacpp(assets), tag)


def _fetch_llamacpp(assets):
    """下载并解压全部资产到 bin/_unpack（安装与升级共用；返回 unpack 目录）。

    先下到临时目录、验证含 llama-server 后才动 bin/llamacpp——失败不影响现役
    二进制（原子替换的前半程）。
    """
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    unpack = BIN_DIR / "_unpack"
    shutil.rmtree(unpack, ignore_errors=True)
    for asset in assets:  # 多资产配套（如 CUDA：cudart 运行时 + 主包）逐个下载解压
        archive = download_asset(asset, BIN_DIR)
        info("解压中（Windows 首次扫描可能拖慢，请耐心等待）...")
        safe_extract(archive, unpack)
        archive.unlink()
    return unpack


def _commit_llamacpp(unpack, tag):
    """把 _unpack 内含 llama-server 的目录就位到 bin/llamacpp（原子换名）并写 .tag。

    调用前须确保 llama-server 未在运行（Windows 文件锁会让 rmtree 抛
    PermissionError），安装场景天然满足，升级场景由 _stop_local_llamacpp() 兜底。
    """
    server = next((p for p in unpack.rglob("llama-server*") if p.is_file()), None)
    if not server:
        shutil.rmtree(unpack, ignore_errors=True)
        fail("解压产物中未找到 llama-server。")
    all_files = [p for p in unpack.rglob("*") if p.is_file()]
    dest = BIN_DIR / "llamacpp"
    try:
        shutil.rmtree(dest, ignore_errors=True)
    except PermissionError:
        shutil.rmtree(unpack, ignore_errors=True)
        fail(f"无法替换 {dest}（文件被占用）：请先关停正在运行的 llama-server "
             f"（或整个 backend）后重试。")
    shutil.move(str(server.parent), str(dest))
    for p in all_files:  # 其余包（如 CUDA cudart）平铺并入 dest，保证运行时可加载
        if not p.exists():  # 已随 llama-server 所在目录一并移动
            continue
        target = dest / p.name
        if not target.exists():
            shutil.move(str(p), str(target))
    shutil.rmtree(unpack, ignore_errors=True)
    (dest / ".tag").write_text(tag, encoding="utf-8")
    info(f"llama.cpp {tag} → {dest}")
    if sys.platform == "darwin":
        remove_quarantine(dest)
    return dest


def remove_quarantine(dest):
    """macOS Gatekeeper：去掉下载二进制的隔离属性（无属性时报错可忽略）。"""
    info("移除 macOS 隔离属性 ...")
    for p in dest.rglob("*"):
        if p.is_file():
            subprocess.run(["xattr", "-d", "com.apple.quarantine", str(p)],
                           capture_output=True)


# 第443次（用户裁定）：原 step4_register_nm 已删——NM 自动唤起整套撤销（原实现注册
# Native Messaging host 供扩展「自动唤起 backend」用，host 脚本曾位于
# backend/scripts/native-messaging/）。日常启动由用户手动执行 python backend/app.py。


def step5_selfcheck():
    info("健康自检 ...")
    ok = True
    server = find_llama_server()
    if not server:
        warn("未找到 llama-server（backend/bin/）。")
        ok = False
    else:
        try:
            r = subprocess.run([str(server), "--version"],
                               capture_output=True, text=True, timeout=30)
            ver = (r.stdout or r.stderr).strip().splitlines()
            info(f"llama-server：{ver[0] if ver else '已就绪'}")
        except Exception as e:
            warn(f"llama-server --version 运行失败：{e}")
            ok = False
    if (ver := cublas_installed()):
        info(f"whisper GPU 支持：nvidia-cublas-cu12 {ver}（ASR 页 GPU 卡可用，设备 auto）")
    else:
        info("whisper GPU 支持：未安装（whisper 走 CPU int8；需要则 --whisper-gpu yes）")
    print()
    if ok:
        info("全部就绪。日常启动：python backend/app.py（自动打开管理界面）；"
             "模型由 llama-server -hf 按卡片自动下载（首次选定卡后需等待下载）。")
    else:
        warn("存在未完成项（见上）。处理后重跑本脚本即可（幂等）。")


# ===== 检查与升级（第557次用户裁定：升级唯一入口=本脚本，管理界面不设升级中心） =====

UPGRADE_HINT = "python backend/scripts/install.py --upgrade"  # 提示语里的命令写法


def llamacpp_tag():
    """本地 llama.cpp 版本（bin/llamacpp/.tag，安装/升级落盘）。"""
    try:
        return (BIN_DIR / "llamacpp" / ".tag").read_text(encoding="utf-8").strip()
    except OSError:
        return None


def _llamacpp_patterns():
    manifest = load_manifest(soft=True)
    return manifest["llamacpp"]["assets"][llamacpp_platform_key(manifest)]


def check_llamacpp():
    """llama.cpp 新版本检查（只读）：.tag vs GitHub latest release。"""
    current = llamacpp_tag()
    if not current:
        return {"status": "missing"}
    try:
        tag, _assets = resolve_llamacpp_release(_llamacpp_patterns(),
                                                purpose="检查 llama.cpp 新版本",
                                                soft=True)
    except (InstallError, SystemExit):
        # fail() 的两种出口都不打断其余资产的检查；详情已打印到 stderr
        return {"status": "error", "current": current,
                "detail": "GitHub 访问失败或无匹配资产（详情见控制台）"}
    except Exception as e:
        return {"status": "error", "current": current, "detail": str(e)}
    return {"status": "ok", "current": current, "latest": tag,
            "update_available": tag != current}


def check_ytdlp():
    """yt-dlp 新版本检查（只读）：venv 内已装版本 vs PyPI latest。"""
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
    """三资产检查（同步网络请求，几秒；GitHub 不可达时最坏数分钟）。"""
    result = {
        "backend": {"status": "skipped",
                    "reason": "backend 无对外发布仓库；升级请到发布页重新下载覆盖"
                              "（config 自动保留）"},
        "llamacpp": check_llamacpp(),
        "ytdlp": check_ytdlp(),
    }
    return result


def silent_check(report=print, delay=3):
    """app 启动时的静默检查（app.py 后台线程调用）：有更新只写一条日志提示
    升级命令，不打扰、不改任何东西（第557次：升级动作只在本脚本执行）。"""
    time.sleep(delay)  # 让先启动的引擎日志走完，提示不插队
    try:
        result = check_all()
    except SystemExit:  # fail() 的硬退绝不允许杀掉 app 进程
        report("启动版本检查失败（可忽略），详情见控制台")
        return
    except Exception as e:  # 静默检查绝不影响启动
        report(f"启动版本检查失败（可忽略）：{e}")
        return
    for name, label in (("llamacpp", "llama.cpp"), ("ytdlp", "yt-dlp")):
        st = result.get(name) or {}
        if st.get("update_available"):
            report(f"{label} 有新版本：{st['current']} → {st['latest']}，"
                   f"升级运行：{UPGRADE_HINT} {name}")


def _pid_alive_is_llama(pid):
    """pid 复用防护：确认该 pid 当前进程名含 llama 才动手，防误伤复用 pid 的新进程。

    （与 core/llm_engine._pid_alive_is_llama 同口径的独立实现——安装/升级脚本
    不 import backend 核心，避免在未装依赖的机器上先崩。）
    """
    try:
        if IS_WIN:
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=5,
                creationflags=subprocess.CREATE_NO_WINDOW).stdout or ""
            return "llama" in out.lower()
        with open(f"/proc/{pid}/comm", "r", encoding="utf-8", errors="replace") as f:
            return "llama" in (f.read() or "").lower()
    except Exception:
        return False


def _stop_local_llamacpp():
    """升级前停掉本机 llama-server（Windows 文件锁；pid 文件由 app 写）。

    backend 在跑也没关系：llama-server 停掉后，backend 下次对话请求会按需
    自动拉起（惰性启动），届时用的已是新版二进制。
    """
    stopped = 0
    for pid_file in sorted(BACKEND.glob(".llama-server-*.pid")):
        try:
            pid = int((pid_file.read_text(encoding="utf-8") or "").strip() or 0)
        except (OSError, ValueError):
            pid = 0
        if pid > 0 and _pid_alive_is_llama(pid):
            try:
                os.kill(pid, 9)  # Windows 上映射 TerminateProcess
                stopped += 1
                info(f"终止运行中的 llama-server（pid={pid}）")
            except OSError as e:
                warn(f"终止 llama-server（pid={pid}）失败：{e}")
        try:
            pid_file.unlink()
        except OSError:
            pass
    if stopped:
        time.sleep(1)  # 让文件句柄释放后再动 bin/llamacpp
    else:
        info("未发现运行中的 llama-server")


def upgrade_llamacpp():
    """升级 llama.cpp：解析远端 release → 下载解压验证 → 停服 → 原子换名 → 写 .tag。"""
    patterns = _llamacpp_patterns()
    tag, assets = resolve_llamacpp_release(patterns, purpose="升级 llama.cpp")
    current = llamacpp_tag()
    if current == tag:
        info(f"llama.cpp 已是最新（{tag}），无需升级。")
        return False
    total_mb = sum(a.get("size", 0) for a in assets) // 1048576
    info(f"目标 {tag}：{' + '.join(a['name'] for a in assets)}（约 {total_mb} MB）")
    # 先下载解压到 _unpack（不动现役二进制），停服只占最后一步，缩短停机窗口
    unpack = _fetch_llamacpp(assets)
    _stop_local_llamacpp()
    _commit_llamacpp(unpack, tag)
    info(f"llama.cpp {current or '未安装'} → {tag}"
         f"（backend 下次请求自动用新版，无需重启）")
    return True


def upgrade_ytdlp():
    """升级 yt-dlp（当前 Python 环境内 pip）。"""
    info("升级 yt-dlp（pip install -U yt-dlp）...")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-U", "yt-dlp"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        fail(f"pip 升级失败：{(r.stderr or r.stdout).strip()[-500:]}")
    for line in (r.stdout or "").strip().splitlines()[-3:]:
        info(line)
    info("yt-dlp 升级完成（backend 重启后生效：core/ytdl 进程内已 import yt_dlp）")


def _cli_check():
    """--check：只读打印三资产版本状态与升级命令。"""
    info("检查新版本 ...")
    result = check_all()
    be = result["backend"]
    info(f"backend：{be['reason']}")
    for name, label in (("llamacpp", "llama.cpp"), ("ytdlp", "yt-dlp")):
        st = result.get(name) or {}
        if st.get("status") == "ok":
            if st.get("update_available"):
                info(f"{label} 有新版本：{st['current']} → {st['latest']}，"
                     f"运行 {UPGRADE_HINT} {name}")
            else:
                info(f"{label} 已是最新（{st['current']}）")
        elif st.get("status") == "missing":
            info(f"{label} 未安装")
        else:
            warn(f"{label} 检查失败：{st.get('detail')}")


def _cli_upgrade(targets):
    """--upgrade [llamacpp|ytdlp|all]：逐个升级，单项失败不阻断其余项。"""
    steps = []
    if targets in ("all", "llamacpp"):
        steps.append(("llamacpp", "llama.cpp", upgrade_llamacpp))
    if targets in ("all", "ytdlp"):
        steps.append(("ytdlp", "yt-dlp", upgrade_ytdlp))
    rc = 0
    for _name, label, fn in steps:
        info(f"=== 升级 {label} ===")
        try:
            fn()
        except SystemExit as e:  # fail() 的硬退转成本轮失败，继续下一项
            rc = e.code if isinstance(e.code, int) else 1
            warn(f"{label} 升级失败（详情见上方错误）")
        except InstallError as e:
            rc = 1
            warn(f"{label} 升级失败：{e}")
        except Exception as e:
            rc = 1
            warn(f"{label} 升级失败：{type(e).__name__}: {e}")
    return rc


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="install.py",
        description="VocabRadar backend 安装器 / 升级器（默认无参数 = 安装）")
    ap.add_argument("--check", action="store_true",
                    help="只检查 llama.cpp / yt-dlp 新版本，不改动任何东西")
    ap.add_argument("--upgrade", nargs="?", const="all", default=None,
                    metavar="TARGET", choices=("all", "llamacpp", "ytdlp"),
                    help="升级资产（缺省 TARGET=all）")
    ap.add_argument("--whisper-gpu", choices=("auto", "yes", "no"), default="auto",
                    help="whisper GPU 支持（第558次）：auto=检测到 NVIDIA GPU 且交互"
                         "终端才询问；yes=直接安装 cuBLAS 运行库；no=跳过（CPU）")
    args = ap.parse_args(argv)
    if args.check:
        _cli_check()
        return 0
    if args.upgrade:
        print("=== VocabRadar backend 升级器 ===")
        return _cli_upgrade(args.upgrade)
    print("=== VocabRadar backend 安装器 ===")
    step0_check_state()  # 第514次：仅打印上次安装信息，不再跳过流程（幂等重查）
    step1_check_python()
    step2_prepare_env()
    step2b_whisper_gpu(force=args.whisper_gpu)  # 第558次：whisper GPU 支持（可选）
    manifest = load_manifest()
    step3_install_llamacpp(manifest)
    step5_selfcheck()  # 第443次：NM 注册步骤撤销（用户裁定），仅保留健康自检
    record_state()  # 记录环境与安装状态，供下次运行的 step0 展示参考
    return 0


if __name__ == "__main__":
    sys.exit(main())
