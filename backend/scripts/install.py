"""VocabRadar backend 安装器（幂等；首次部署手动运行一次，日常启动无需再跑）。

流程（plan-backend §5.3）：
0. 状态检查：backend/.installed.json 存在且解释器未变 → 直接退出（二次启动秒过；
   删除该文件可强制重装）
1. 检查 Python >= 3.10（不内置 Python；脚本能跑即有解释器，环境用户自备不代管）
2. 用当前 Python 环境装依赖（已满足时 pip 自动跳过）；imageio-ffmpeg 按需
   装——系统 PATH 已有 ffmpeg 则跳过，缺失才补装（yt-dlp 执行器兜底）
3. 按 backend/scripts/manifest.json 下载 llama.cpp 预编译包到 backend/bin/
   （已存在跳过 → 支持离线手动放置）
4. 健康自检（llama-server --version），写安装状态到 backend/.installed.json
   （模型 GGUF 不归本脚本管，第431次：llama-server -hf 自动下载进 HF hub 缓存）
"""

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


def fail(msg):
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


def gh_request(url, stream=False, purpose=None):
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
    fail(f"{'『' + purpose + '』' if purpose else 'GitHub 访问'}：GitHub 访问失败（已重试 3 次）：{last}\n请求地址：{url}")


def load_state():
    """读安装状态（backend/.installed.json）。无记录返回 None。"""
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def step0_check_state():
    """已装且解释器未变 → 直接退出（run.* 二次启动秒过）；解释器变了（用户换环境）
    → 打印提示后照常重装依赖。强制重装：删除 backend/.installed.json。"""
    st = load_state()
    if not st:
        return
    if st.get("python") == sys.executable:
        info(f"已安装（{st.get('installed_at', '?')}，解释器一致），跳过安装流程。")
        sys.exit(0)
    info(f"检测到解释器变更（{st.get('python')} → {sys.executable}），重新执行安装。")


def record_state():
    """写安装状态：环境（解释器/版本）+ 完成时间，供二次启动直接跳过。"""
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump({
                "version": 1,
                "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "python": sys.executable,
                "python_version": sys.version.split()[0],
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
    imageio-ffmpeg 按需装（第404次）：系统 PATH 已有 ffmpeg 则跳过（用户
    环境全权作主，不重复提供执行器）；缺失才补装——yt-dlp 的 HLS/分段流与
    视频合流需要 ffmpeg 执行器，运行时 core/ytdl._ensure_ffmpeg 兜底补挂。"""
    info("安装依赖（已满足时 pip 自动跳过）...")
    r = subprocess.run([sys.executable, "-m", "pip", "install",
                        "-r", str(BACKEND / "requirements.txt")])
    if r.returncode != 0:
        fail("依赖安装失败，请检查网络后重试。")
    if shutil.which("ffmpeg"):
        info("系统已有 ffmpeg，跳过 imageio-ffmpeg。")
        return
    info("未检测到系统 ffmpeg，安装 imageio-ffmpeg（yt-dlp 执行器兜底）...")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "imageio-ffmpeg>=0.5"])
    if r.returncode != 0:
        warn("imageio-ffmpeg 安装失败：HLS/视频合流场景请自行安装 ffmpeg。")


def load_manifest():
    try:
        with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        fail(f"读取 {MANIFEST_PATH} 失败：{e}")


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


def resolve_llamacpp_release(patterns, purpose=None):
    """定位含全部目标资产的 release，返回 (tag, assets)。三级回退：

    ① latest release 自身资产直接命中（官方恢复正式发布模式时走这条）
    ② latest 仅挂 nightly-tag.txt 时（2026-09 实机核实的新模式：latest v0.4.1
       只有该探测文件），读其内容得版本号（如 b10964），取该 tag 的 release
    ③ 回落遍历近期 prerelease，取第一个命中的 nightly
    """
    try:
        latest = gh_request(f"{GITHUB_RELEASES}/latest", purpose=purpose).json()
    except Exception as e:
        what = f"『{purpose}』" if purpose else ""
        fail(f"{what}访问 GitHub 失败：{e}\n"
             f"可设 GH_PROXY 指定镜像后重跑（默认已自动探测）；"
             f"或离线手动放置：下载资产解压到 {BIN_DIR / 'llamacpp'}"
             f"（确保其中有 llama-server）。")
    matched = match_assets(latest.get("assets", []), patterns)
    if matched:
        return latest.get("tag_name", "unknown"), matched
    probe = next((a for a in latest.get("assets", [])
                  if a["name"] == "nightly-tag.txt"), None)
    if probe:
        try:
            tag = gh_request(probe["browser_download_url"], purpose=purpose).text.strip()
            resp = gh_request(f"{GITHUB_RELEASES}/tags/{tag}", purpose=purpose)
            if resp.status_code == 200:
                rel = resp.json()
                matched = match_assets(rel.get("assets", []), patterns)
                if matched:
                    return rel.get("tag_name", tag), matched
        except Exception as e:
            warn(f"nightly-tag.txt 探测失败：{e}")
    info("latest 未命中，回落查找近期 nightly prerelease ...")
    try:
        for rel in gh_request(f"{GITHUB_RELEASES}?per_page=30", purpose=purpose).json():
            if not rel.get("prerelease"):
                continue
            matched = match_assets(rel.get("assets", []), patterns)
            if matched:
                return rel.get("tag_name", "unknown"), matched
    except Exception as e:
        warn(f"prerelease 查询失败：{e}")
    fail(f"未找到匹配资产 {patterns}。可离线手动放置到 {BIN_DIR} 后重跑。")


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
        info(f"llama.cpp 已就绪（{server}），跳过下载。如需更新：删除 {BIN_DIR} 后重跑本脚本。")
        return
    patterns = manifest["llamacpp"]["assets"][llamacpp_platform_key(manifest)]
    tag, assets = resolve_llamacpp_release(patterns, purpose="下载 llama.cpp 预编译包")
    info(f"命中 release {tag}：{' + '.join(a['name'] for a in assets)}")

    BIN_DIR.mkdir(parents=True, exist_ok=True)
    unpack = BIN_DIR / "_unpack"
    shutil.rmtree(unpack, ignore_errors=True)
    for asset in assets:  # 多资产配套（如 CUDA：cudart 运行时 + 主包）逐个下载解压
        archive = download_asset(asset, BIN_DIR)
        info("解压中（Windows 首次扫描可能拖慢，请耐心等待）...")
        safe_extract(archive, unpack)
        archive.unlink()

    server = next((p for p in unpack.rglob("llama-server*") if p.is_file()), None)
    if not server:
        shutil.rmtree(unpack, ignore_errors=True)
        fail("解压产物中未找到 llama-server。")
    all_files = [p for p in unpack.rglob("*") if p.is_file()]
    dest = BIN_DIR / "llamacpp"
    shutil.rmtree(dest, ignore_errors=True)
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


def remove_quarantine(dest):
    """macOS Gatekeeper：去掉下载二进制的隔离属性（无属性时报错可忽略）。"""
    info("移除 macOS 隔离属性 ...")
    for p in dest.rglob("*"):
        if p.is_file():
            subprocess.run(["xattr", "-d", "com.apple.quarantine", str(p)],
                           capture_output=True)


def step4_selfcheck():
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
    print()
    if ok:
        info("全部就绪。日常启动：python backend/app.py（自动打开管理界面）；"
             "模型由 llama-server -hf 按卡片自动下载（首次选定卡后需等待下载）。")
    else:
        warn("存在未完成项（见上）。处理后重跑本脚本即可（幂等）。")


def main():
    print("=== VocabRadar backend 安装器 ===")
    step0_check_state()  # 第401次：已装且解释器未变 → 直接退出（二次启动秒过）
    step1_check_python()
    step2_prepare_env()
    manifest = load_manifest()
    step3_install_llamacpp(manifest)
    step4_selfcheck()
    record_state()  # 第401次：记录环境与安装状态，供下次启动跳过


if __name__ == "__main__":
    main()
