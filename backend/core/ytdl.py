"""媒体下载：内嵌 yt-dlp resolve/download + /media 文件服务。

yt-dlp Python API（plan-backend §2.7，ytdl-server 已废弃）：resolve 同步取
直链信息；download 起后台线程落 backend/media/，文件名以任务 id 为前缀，
经 /media/<id> 按前缀定位（带 Range）。

音频 fmt（m4a/bestaudio，ASR 用途，PyAV 直接解码）只选原生流；视频
fmt（mp4/bestvideo，MPV 本地播放方向 plan §2.7）为 bestvideo+bestaudio
ffmpeg 合流——remux 封装不重编码。ffmpeg 系统 PATH 优先，缺失时补挂
static-ffmpeg 静态执行器（第514次替代 imageio-ffmpeg；requirements 常装，
首调才下载平台二进制并缓存，下载失败保持缺失由 yt-dlp 报错）。

客户端信息：全局兜底 http_headers（UA + Accept-Language，提取器自带各站
专属头优先）；cookie 携带（YouTube 机器人墙等登录墙场景需要，配置即读
即用）：Netscape cookiefile（config ytdl.cookiefile，建议小号导出，路径
缺失报错不静默）或 cookies_from_browser（浏览器名直读，或 auto＝第435次
自动探测本机已装浏览器；第437次：每次直读浏览器 cookie 库逐条解密太慢，
改旧缓存优先——backend/cache/ytdl-cookies.txt 存在先用，yt-dlp 报错则删
jar 现取重试一次（_extract_info 统一入口），失败如实上抛不静默）。

并行直链下载（第438次引入，第515次引擎迁出）：parallel_download 引擎
（upos 镜像探测择优 + 多线程 Range 分块 + 控制文件断点续传，与 downkyi/
BBDown 同源、纯标准库）独立为 core/dl_engine.py，本模块 re-export 保持
asr_job/bili_api 既有导入不变；任何失败返回 False 由调用方回退 yt-dlp
原生下载（asr_job 调用侧回退，保证不比老路更差）。

管理页下载主路（第448次）：download 任务先 extract_info(download=False)
拿选中格式直链走 parallel_download（第438次模式推广：合流档 mp4/bestvideo
视频+音频两路分块，ffmpeg -c copy 合并；半成品 cache/dl-<id>/ 原子进
media/），失败回退 yt-dlp 原生下载——_base_opts 同次起带
concurrent_fragment_downloads=4（yt-dlp -N，HLS/DASH 分片并发，官方建议 4+）。
"""

import glob
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.request
import uuid

import config

# 第515次：直链并行分块引擎迁 core/dl_engine.py（断点续传），re-export
# 保持 asr_job/bili_api 既有 `from core.ytdl import parallel_download` 不变
from core.dl_engine import parallel_download

log = logging.getLogger(__name__)

# 任务表：模块级内存态，进程生命周期即任务生命周期（重启即清，无需持久化）
_tasks = {}
_lock = threading.Lock()

# 客户端信息兜底：yt-dlp 提取器自带各站专属头优先，此处仅全局兜底
_HTTP_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/126.0.0.0 Safari/537.36"),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

# fmt → yt-dlp format 串：音频只选原生流（ASR 用途，PyAV 直解）；
# 视频为 bestvideo+bestaudio 合流（ffmpeg remux 封装，不重编码）。
# 未知 fmt 一律回退 m4a 串（老客户端传 mp3 等值时拿原生流，不报错）
_FMT_FORMAT = {
    "m4a": "bestaudio[ext=m4a]/bestaudio/best",
    "bestaudio": "bestaudio/best",
    "mp4": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
    "bestvideo": "bestvideo+bestaudio/best",
    # 第442次（用户裁定「超过whisper音质的最低音质，不知道就最低音质」）：
    #   ASR 专用档——worstaudio 选最低码率原生流（whisper 解码按 16kHz 单声
    #   道重采样，最低档已远超所需），无音频元数据可判档时按裁定取最低；
    #   下载器默认档 m4a（最高音质）不受影响
    "asr": "worstaudio[ext=m4a]/worstaudio/best",
}

# 合流 fmt → 容器封装：ffmpeg 只 remux 不重编码（bestvideo 混编解码面
# 用 mkv 兼容；单流 fallback 命中时该选项自动无效）
_MERGE_CONTAINER = {"mp4": "mp4", "bestvideo": "mkv"}

# height/abr 上限模板：视频 fmt 限分辨率时逐级加 [height<=H]（第408次下载器
# 参数化），音频 fmt 限音质时逐级加 [abr<=A]（第409次）；best 合流选择符同样
# 支持该过滤器，fallback 保留兜底
_HEIGHT_FMT = {
    "mp4": ("bestvideo[ext=mp4][height<={h}]+bestaudio[ext=m4a]"
            "/bestvideo[height<={h}]+bestaudio"
            "/best[height<={h}]/best"),
    "bestvideo": "bestvideo[height<={h}]+bestaudio/best[height<={h}]/best",
}

_ABR_FMT = {
    "m4a": ("bestaudio[ext=m4a][abr<={a}]/bestaudio[abr<={a}]"
            "/bestaudio[ext=m4a]/bestaudio/best"),
    "bestaudio": "bestaudio[abr<={a}]/bestaudio/best",
}


def _import_yt_dlp():
    try:
        import yt_dlp
    except ImportError as e:
        raise RuntimeError("yt-dlp 未安装：请 pip install yt-dlp") from e
    return yt_dlp


def _pick_format(fmt, height=None, abr=None):
    """fmt → format 串；视频类 fmt 带 height（如 720）时限分辨率上限，
    音频类 fmt 带 abr（如 128 kbps）限音质上限（第409次）。

    height/abr 空/0/非法 = 不限；视频 fmt 忽略 abr，音频 fmt 忽略 height。
    """
    fmt = fmt or ""
    try:
        h = int(height or 0)
    except (TypeError, ValueError):
        h = 0
    try:
        a = int(float(abr) or 0)
    except (TypeError, ValueError):
        a = 0
    if h > 0 and fmt in _HEIGHT_FMT:
        return _HEIGHT_FMT[fmt].format(h=h)
    if a > 0 and fmt in _ABR_FMT:
        return _ABR_FMT[fmt].format(a=a)
    return _FMT_FORMAT.get(fmt, _FMT_FORMAT["m4a"])


def _ensure_ffmpeg():
    """ffmpeg 就绪：系统 PATH 优先；缺失时补挂 static-ffmpeg 包内静态执行器。

    就绪返回 True。static-ffmpeg 首调才下载平台二进制并缓存（含 ffprobe，
    yt-dlp 探测流元数据同用）；下载失败仅告警保持缺失状态（HLS 等场景由
    yt-dlp 报错）。补挂仅在本进程 PATH 生效（子进程继承），幂等——补挂后
    which 短路不会重复插入。
    """
    if shutil.which("ffmpeg"):
        return True
    try:
        from static_ffmpeg import run
        exe, _ffprobe = run.get_or_fetch_platform_executables_else_raise()
        os.environ["PATH"] = os.pathsep.join(
            [os.path.dirname(exe), os.environ["PATH"]])
    except Exception as e:
        log.warning("static-ffmpeg 执行器就绪失败（保持缺失状态）：%s", str(e)[:200])
    return shutil.which("ffmpeg") is not None


# 第437次：cookies_from_browser 模式的进程外缓存 jar（Netscape 格式）。
# 每次直读浏览器 cookie 库要逐条解密（上千条，秒级开销），改「旧缓存优先，
# 失败失效现取」：jar 存在先用（统一走 _extract_info），yt-dlp 报错删 jar
# 现取重试一次，成功回写。jar 含会话 cookie 明文，置于 backend/cache/ 不出目录。
_COOKIE_CACHE = os.path.join(config.CACHE_DIR, "ytdl-cookies.txt")


def _get_cookiefile():
    """cookiefile 配置解析：空返回 None；配了但文件缺失即报错（不静默忽略）。

    config.load() 即读即用（改 config.json 无需重启），resolve/download
    频率低，读盘开销可忽略。相对路径以 backend/ 目录为基准（与 config
    其他路径一致，不受进程 CWD 影响）。
    """
    path = (config.load().get("ytdl") or {}).get("cookiefile") or ""
    if not path:
        return None
    if not os.path.isabs(path):
        path = os.path.join(config.BASE_DIR, path)
    if not os.path.isfile(path):
        raise RuntimeError(
            f"ytdl.cookiefile 不存在：{path}（Netscape 格式 cookie.txt，建议小号导出）")
    return path


# cookies_from_browser=auto 的探测候选（顺序即优先级）：Firefox cookie 库
# 无加密、运行中锁库由 yt-dlp 复制临时文件规避，最稳故最优先；Chromium 系
# 在 Windows 上可能因 App-Bound Encryption 解密失败。浏览器名须为 yt-dlp
# --cookies-from-browser 支持值。(浏览器名, 环境变量, 相对路径段, 库类型)
_BROWSER_HINTS = [
    ("firefox", "APPDATA", ("Mozilla", "Firefox", "Profiles"), "firefox"),
    ("chrome", "LOCALAPPDATA", ("Google", "Chrome", "User Data"), "chromium"),
    ("edge", "LOCALAPPDATA", ("Microsoft", "Edge", "User Data"), "chromium"),
    ("brave", "LOCALAPPDATA", ("BraveSoftware", "Brave-Browser", "User Data"), "chromium"),
    ("vivaldi", "LOCALAPPDATA", ("Vivaldi", "User Data"), "chromium"),
    ("chromium", "LOCALAPPDATA", ("Chromium", "User Data"), "chromium"),
]

# auto 探测结果进程内缓存：浏览器安装状态进程生命周期内不变，探测纯文件
# 系统检查，缓存后 /api/status 透出解析结果零重复开销
_AUTO_BROWSER = {"done": False, "name": None}


def _pick_browser_auto():
    """cookies_from_browser=auto 的本机浏览器探测（第435次）。

    按 _BROWSER_HINTS 顺序查 cookie 库文件存在性（只查文件不做解密验证，
    实际读取由 yt-dlp 自行处理）；命中返回浏览器名。全无候选返回 None
    （不带 cookie 直连——非错误，撞墙时 yt-dlp 报错自会透出）。结果缓存。
    """
    if not _AUTO_BROWSER["done"]:
        for name, env_key, parts, kind in _BROWSER_HINTS:
            base = os.path.join(os.environ.get(env_key, ""), *parts)
            if not os.path.isdir(base):
                continue
            if kind == "firefox":
                hit = any(os.path.isfile(os.path.join(p, "cookies.sqlite"))
                          for p in glob.glob(os.path.join(base, "*"))
                          if os.path.isdir(p))
            else:  # chromium 系：Default 或 Profile*/Network/Cookies（老版 Default/Cookies）
                probes = [os.path.join(base, "Default", "Network", "Cookies"),
                          os.path.join(base, "Default", "Cookies")]
                probes += [os.path.join(p, "Network", "Cookies")
                           for p in glob.glob(os.path.join(base, "Profile*"))
                           if os.path.isdir(p)]
                hit = any(os.path.isfile(p) for p in probes)
            if hit:
                _AUTO_BROWSER["name"] = name
                break
        _AUTO_BROWSER["done"] = True
    return _AUTO_BROWSER["name"] or None


def _browser_cookie_name():
    """cookies_from_browser 配置 → 浏览器名（auto＝第435次 _pick_browser_auto）；
    未配置或未发现浏览器返回 None。仅在 cookiefile 未显式配置时被调用。"""
    browser = (config.load().get("ytdl") or {}).get("cookies_from_browser") or ""
    if browser.strip().lower() == "auto":
        browser = _pick_browser_auto() or ""
    return browser.strip() or None


def _base_opts(fmt, height=None, abr=None, fresh_cookie=False):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,  # 只取单视频，URL 带列表参数时忽略列表
        "retries": 3,
        # 第448次：分片流（HLS/DASH）原生下载并发分片（yt-dlp -N 等价，官方建议 4+）；
        # 直链走 parallel_download 主路不经此参
        "concurrent_fragment_downloads": 4,
        "format": _pick_format(fmt, height, abr),
        # 客户端信息兜底：yt-dlp 提取器自带各站专属头优先，此处仅全局兜底
        "http_headers": dict(_HTTP_HEADERS),
    }
    container = _MERGE_CONTAINER.get(fmt or "")
    if container:
        opts["merge_output_format"] = container  # 合流封装（remux 不重编码）
    cookiefile = _get_cookiefile()
    if cookiefile:
        opts["cookiefile"] = cookiefile  # yt-dlp 读并回写 jar，跨任务保持会话
    else:
        # 第407次：cookies_from_browser——自动取已登录浏览器的 cookie
        # （等价 yt-dlp --cookies-from-browser 的 Python API 形式，一元组即可）。
        # cookiefile 显式配置时优先（二选一，用户自管 jar 不参与缓存策略）。
        # auto＝第435次探测本机已装浏览器（_browser_cookie_name），未发现浏览器
        # 则不带 cookie 直连。浏览器名非法或未登录目标站点时 yt-dlp 自行报错，
        # 如实向上抛（RuntimeError 由 API 层映射 503）。
        # 注意：Windows 上 Chrome 127+ 因 App-Bound Encryption 解密会失败，Firefox 最稳。
        # 第437次：直读浏览器逐条解密慢——旧 jar 优先在 _extract_info 统一处理；
        # fresh_cookie=True 强制现取（首次无缓存或旧 jar 失效重试走这路）。
        browser = _browser_cookie_name()
        if browser:
            if not fresh_cookie and os.path.isfile(_COOKIE_CACHE):
                opts["cookiefile"] = _COOKIE_CACHE  # 旧 jar 快路径（零解密开销）
            else:
                opts["cookiesfrombrowser"] = (browser,)
    return opts


def _cookie_mode(opts):
    """第440次：cookie 模式一句话描述（轨迹日志用）——回应「不知道有没有
    尝试 cookie」。三种：显式 cookiefile / 浏览器现取 / 旧缓存 jar。"""
    if opts.get("cookiefile"):
        return f"cookiefile({opts['cookiefile']})"
    if opts.get("cookiesfrombrowser"):
        return f"browser({opts['cookiesfrombrowser'][0]})"
    return "none"


def _extract_info(make_opts, url, download=False):
    """统一 extract_info 入口：浏览器 cookie 旧缓存优先，失败失效现取（第437次）。

    make_opts(fresh) 构造 yt-dlp opts（闭包携带业务参数；fresh=True 强制
    现取直读浏览器）。本次用旧缓存 jar（cookiefile == _COOKIE_CACHE）且
    yt-dlp 报错（YoutubeDLError：下载失败/旧 jar 过期损坏）时：删 jar、
    fresh 现取重试一次，重试仍失败如实上抛；现取成功回写缓存 jar。
    显式 cookiefile 与无 cookie 模式不经重试逻辑，错误原样上抛（调用方
    既有 DownloadError 翻译语义不变）。
    第440次：每次解析与删 jar 重试均带轨迹日志（URL + cookie 模式 +
    原始错误摘要），失败时日志可完整还原尝试路径。
    """
    yt_dlp = _import_yt_dlp()
    opts = make_opts(False)
    log.info("yt-dlp 解析 %s（cookie: %s）", url, _cookie_mode(opts))
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=download)
            _save_cookie_cache(opts, ydl.cookiejar)
        return info
    except yt_dlp.utils.YoutubeDLError as e:
        if opts.get("cookiefile") != _COOKIE_CACHE:
            raise  # 非旧缓存路径：不重试，原样上抛
        log.warning("yt-dlp 旧 jar 首试失败（%s），删 jar 现取浏览器 cookie 重试：%s",
                    _cookie_mode(opts), str(e)[:200])
        _drop_cookie_cache()  # 旧 jar 失效/损坏：删掉，现取重试一次
    opts = make_opts(True)
    log.info("yt-dlp 重试 %s（cookie: %s）", url, _cookie_mode(opts))
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=download)
        _save_cookie_cache(opts, ydl.cookiejar)
    return info


def _save_cookie_cache(opts, jar):
    """现取成功回写缓存 jar（含会话 cookie）。失败静默——缓存只是加速手段，
    写失败不影响本次结果。仅浏览器现取路径回写（旧 jar 快路径下 yt-dlp 关闭
    时自带回写同一路径，顺带保鲜）。tmp + os.replace 原子落盘防并发写坏。"""
    if not opts.get("cookiesfrombrowser"):
        return
    try:
        os.makedirs(config.CACHE_DIR, exist_ok=True)
        tmp = _COOKIE_CACHE + ".tmp"
        jar.save(tmp, ignore_discard=True, ignore_expires=True)
        os.replace(tmp, _COOKIE_CACHE)
    except Exception:
        pass


def _drop_cookie_cache():
    try:
        os.remove(_COOKIE_CACHE)
    except OSError:
        pass


def resolve(url, fmt=None, height=None, abr=None):
    """解析直链信息（不下载）。direct_url 有时效，拿到应尽快使用。

    合流 fmt（mp4/bestvideo）无单一直链，direct_url 可能为 null。
    height/abr 仅影响请求侧 format 串（extract_info 始终返回全量 formats，
    摘要不受影响）；第409次：额外返回 formats 摘要（可选分辨率档/音质档/
    字幕轨道），供管理页与扩展把下载参数做成数据驱动下拉。
    """
    yt_dlp = _import_yt_dlp()
    _ensure_ffmpeg()  # 就绪保障：HLS/分段流站点需要；缺失不阻塞原生流下载
    try:
        info = _extract_info(lambda _fresh=False: _base_opts(fmt, height, abr),
                             url, download=False)
    except yt_dlp.utils.DownloadError as e:
        raise RuntimeError(f"resolve 失败：{e}") from e
    out = {
        "title": info.get("title"),
        "duration": info.get("duration"),
        "uploader": info.get("uploader"),
        "thumbnail": info.get("thumbnail"),
        "ext": info.get("ext"),
        "acodec": info.get("acodec"),
        "filesize": info.get("filesize") or info.get("filesize_approx"),
        "direct_url": info.get("url"),
    }
    out.update(_formats_summary(info))
    return out


def _formats_summary(info):
    """info["formats"] → {heights, abrs, subs}：

    - heights：视频流分辨率档（去重降序，int）
    - abrs：音频流音质档 abr kbps（去重降序，int）
    - subs：字幕轨道 {manual: [lang], auto: [lang]}（语言代码原始值）
    """
    heights, abrs = set(), set()
    for f in info.get("formats") or []:
        if f.get("vcodec") and f["vcodec"] != "none" and f.get("height"):
            heights.add(int(f["height"]))
        if f.get("acodec") and f["acodec"] != "none" and f.get("abr"):
            abrs.add(int(round(f["abr"])))
    subs = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}
    return {
        "heights": sorted(heights, reverse=True),
        "abrs": sorted(abrs, reverse=True),
        "subs": {"manual": sorted(subs), "auto": sorted(auto)},
    }


def subtitles(url, lang=None):
    """提取字幕：优先手动轨，回退自动轨，vtt 抓取解析为结构化条目（不落盘）。

    lang 精确匹配 → 主语言段匹配（zh 命中 zh-Hans）→ 轨道表首个；不传
    lang 默认取视频原始语言（yt-dlp info 的 language 字段，即原声音轨
    语言），缺该字段才落到轨道表首个。条目为 {start,end,text}（秒，
    float，与扩展字幕解析器同构）。两轨全空返回 None（api 层映射 404）。
    零新依赖（urllib 标准库），扩展侧五路字幕全失败后的 backend 兜底
    （第399次）。
    """
    yt_dlp = _import_yt_dlp()
    try:
        info = _extract_info(lambda _fresh=False: _base_opts(None),
                             url, download=False)
    except yt_dlp.utils.DownloadError as e:
        raise RuntimeError(f"字幕提取失败：{e}") from e
    manual = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}
    if not manual and not auto:
        return None
    if not (lang or "").strip():
        lang = info.get("language") or ""  # 默认原声语言，无则 _pick_track 落首个
    kind = "manual"
    key, track = _pick_track(manual, lang)
    vtt_url = _vtt_url(track)
    if vtt_url is None:  # 手动轨无 vtt（罕见）：同 lang 策略回退自动轨
        kind = "auto"
        key, track = _pick_track(auto, lang)
        vtt_url = _vtt_url(track)
    if vtt_url is None:
        raise RuntimeError("字幕轨无 vtt 格式，暂不支持解析")
    req = urllib.request.Request(vtt_url, headers={
        "User-Agent": _HTTP_HEADERS["User-Agent"]})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            content = resp.read().decode("utf-8", "replace")
    except OSError as e:  # HTTPError/URLError 均为 OSError 子类
        raise RuntimeError(f"字幕 vtt 抓取失败：{e}") from e
    return {
        "lang": key,
        "kind": kind,  # manual=站方手动轨 auto=机器生成
        "cues": _vtt_to_cues(content),
        "available": {"manual": list(manual), "auto": list(auto)},
        # 第437次方案A：asr_job 官方字幕直出写缓存用（条目 video_id 字段）
        "video_id": info.get("id"),
    }


def _pick_track(tracks, lang):
    """lang 选轨：精确 → 主语言段匹配（zh 命中 zh-Hans）→ 表内首个。

    tracks 为 {lang: [track]}；空表返回 (None, None)。主语言段命中多键
    （YouTube 自动轨 xx-orig 原始轨 + xx-yy 翻译链同头）时优先 -orig
    原始轨——翻译链是原轨机翻副本，默认场景用户要的是原文。
    """
    if not tracks:
        return None, None
    want = (lang or "").strip().lower()
    if want:
        if want in tracks:
            return want, tracks[want]
        want_head = want.split("-")[0]
        hits = [k for k in tracks if k.lower().split("-")[0] == want_head]
        if hits:
            k = next((k for k in hits if k.lower().endswith("-orig")), hits[0])
            return k, tracks[k]
    k = next(iter(tracks))
    return k, tracks[k]


def _vtt_url(track_list):
    """同轨多格式条目里取 vtt（json3/srv 等格式解析未支持）。"""
    for t in track_list or []:
        if t.get("ext") == "vtt":
            return t.get("url")
    return None


_VTT_TS = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})")


def _vtt_sec(ts):
    """vtt 时间戳（HH:MM:SS.mmm / MM:SS.mmm）→ 秒 float；解析失败 None。"""
    m = _VTT_TS.match(ts.strip())
    if not m:
        return None
    h, mnt, s, ms = m.groups()
    return int(h or 0) * 3600 + int(mnt) * 60 + int(s) + int(ms) / 1000.0


def _vtt_to_cues(content):
    """vtt → [{start,end,text}]（秒）：逐块取时间行与末行文本；自动字幕
    前缀滚动帧（后帧=前帧+新词）合并为单条（start 取首帧 end 取末帧），
    手动字幕相邻同文条目区间合并去重。"""
    raw = []
    for block in re.split(r"\n\s*\n", content):
        start = end = None
        text_line = None
        for ln in block.strip().splitlines():
            s = ln.strip()
            if "-->" in s:  # cue 时间行（尾随 align/position 参数截去）
                a, _, b = s.partition("-->")
                start, end = _vtt_sec(a), _vtt_sec(b.split()[0] if b.split() else "")
                continue
            if (not s or s.startswith(("WEBVTT", "Kind:", "Language:", "NOTE",
                                       "STYLE", "X-TIMESTAMP-MAP"))
                    or s.isdigit()):
                continue
            text_line = s  # 逐行覆盖：滚动帧末行最完整
        if start is not None and text_line:
            raw.append((start, end, re.sub(r"<[^>]+>", "", text_line).strip()))
    out = []
    for st, en, t in raw:
        if not t:
            continue
        if out and t.startswith(out[-1][2]):
            out[-1][1] = en
            out[-1][2] = t
        elif not (out and out[-1][2].startswith(t)):
            out.append([st, en, t])
    return [{"start": c[0], "end": c[1], "text": c[2]} for c in out]


def download(url, fmt=None, height=None, abr=None):
    """后台任务下载 → 返回任务 id。产物落 media/{id}.{ext}。

    abr（第409次）：音频 fmt 音质上限（kbps），同 height 模式透传。
    """
    _ensure_ffmpeg()  # 就绪保障：HLS/分段流站点需要；缺失不阻塞原生流下载
    try:
        h = int(height or 0) or None
    except (TypeError, ValueError):
        h = None
    try:
        a = int(float(abr) or 0) or None
    except (TypeError, ValueError):
        a = None
    task_id = uuid.uuid4().hex[:12]
    task = {
        "id": task_id,
        "url": url,
        "format": fmt,
        "height": h,
        "abr": a,
        "state": "pending",  # pending | running | done | error
        "progress": 0,
        "title": None,
        "filename": None,
        "error": None,
        "created_at": time.time(),
        "finished_at": None,
    }
    with _lock:
        _tasks[task_id] = task
    threading.Thread(target=_run_download, args=(task,), daemon=True).start()
    return task_id


def _run_download(task):
    task["state"] = "running"
    try:
        # opts 构造含 cookiefile 等配置校验，放 try 内统一记 task.error
        def make_opts(_fresh=False):
            opts = _base_opts(task["format"], task.get("height"), task.get("abr"),
                              fresh_cookie=_fresh)
            opts["outtmpl"] = os.path.join(config.MEDIA_DIR, f"{task['id']}.%(ext)s")
            opts["progress_hooks"] = [_progress_hook(task)]
            return opts
        # 第448次：先提取（download=False）拿选中格式直链走并行分块下载主路
        # （第438次 asr_job 同款），不适合直链或失败回退下方 yt-dlp 原生老路
        info = _extract_info(make_opts, task["url"], download=False)
        if info.get("_type") == "playlist":  # 防御：noplaylist 之外的入口形态
            info = (info.get("entries") or [{}])[0]
        task["title"] = info.get("title")
        if not _parallel_media(info, task):
            info = _extract_info(make_opts, task["url"], download=True)
            if info.get("_type") == "playlist":
                info = (info.get("entries") or [{}])[0]
            task["title"] = info.get("title") or task["title"]
            # requested_downloads[0].filepath 是最终产物路径（含 postprocessor 改后缀）
            rd = (info.get("requested_downloads") or [{}])[0]
            filepath = rd.get("filepath")
            if filepath:
                task["filename"] = os.path.basename(filepath)
            else:  # 兜底：按 id 前缀反查 media/
                found = find_media(task["id"])
                task["filename"] = os.path.basename(found) if found else None
        task["state"] = "done"
        task["progress"] = 100
    except Exception as e:  # yt-dlp 异常类型庞杂，统一兜底记入任务
        task["state"] = "error"
        task["error"] = str(e)[:300]
    finally:
        task["finished_at"] = time.time()


def _progress_hook(task):
    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                task["progress"] = round(d.get("downloaded_bytes", 0) / total * 100)
    return hook


# ---- 第448次：管理页下载直链并行主路（第438次模式推广，失败回退原生） ----

def _direct_fmt(fmt, info):
    """选中格式 → (url, headers, ext)；非 http(s) 直链返回 None（交回原生）。"""
    url = (fmt or {}).get("url")
    proto = (fmt or {}).get("protocol")
    if not url or not url.startswith(("http://", "https://")) \
            or (proto and proto not in ("http", "https")):
        return None
    ext = (fmt or {}).get("ext") or info.get("ext") or "bin"
    headers = {**_HTTP_HEADERS, **((fmt or {}).get("http_headers") or {})}
    return url, headers, ext


def _parallel_media(info, task):
    """直链并行分块下载主路（第448次）：单流档并行分块直落 media/；合流档
    （requested_formats 视频+音频）两路依次分块（进度 0-50/50-95）后 ffmpeg
    -c copy 合并。半成品在 cache/dl-<id>/（不落 media/ 防 find_media 命中），
    成功后 os.replace 原子进 media/。不适合直链（HLS/DASH 分段等）或任何
    失败返回 False（临时目录已清）由 _run_download 回退 yt-dlp 原生下载。"""
    rf = info.get("requested_formats")
    fmts = list(rf) if rf and len(rf) >= 2 else [rf[0] if rf else info]
    checked = [_direct_fmt(f, info) for f in fmts]
    if any(c is None for c in checked):
        return False

    def prog(base, span):
        def cb(pct):
            task["progress"] = min(99, base + pct * span // 100)
        return cb

    tmpdir = os.path.join(config.CACHE_DIR, f"dl-{task['id']}")
    shutil.rmtree(tmpdir, ignore_errors=True)
    os.makedirs(tmpdir, exist_ok=True)
    try:
        parts = []
        for i, (url, headers, ext) in enumerate(checked):
            if len(checked) == 1:
                base, span = 0, 100
            else:  # 合流两路：视频 0-50、音频 50-95（合并完成置 100）
                base, span = (0, 50) if i == 0 else (50, 45)
            log.info("下载 %s 直链并行：fmt=%s ext=%s url=%s", task["id"],
                     (fmts[i] or {}).get("format_id"), ext, url[:200])
            dest = os.path.join(tmpdir, f"{i}.{ext}")
            if not parallel_download(url, dest, headers, prog(base, span)):
                return False
            parts.append(dest)
        os.makedirs(config.MEDIA_DIR, exist_ok=True)
        if len(parts) == 1:
            final = os.path.join(config.MEDIA_DIR, f"{task['id']}.{checked[0][2]}")
            os.replace(parts[0], final)
        else:
            container = _MERGE_CONTAINER.get(task.get("format") or "", "mkv")
            final = os.path.join(config.MEDIA_DIR, f"{task['id']}.{container}")
            if not _merge_av(parts[0], parts[1], final):
                return False
        task["filename"] = os.path.basename(final)
        return True
    except Exception as e:  # 网络/文件异常：如实记日志后回退原生
        log.warning("下载 %s 直链并行失败（%s），回退 yt-dlp 原生下载",
                    task["id"], str(e)[:200])
        return False
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _merge_av(video, audio, dest):
    """ffmpeg -c copy 合并视频/音频两路（remux 不重编码，同 yt-dlp 合流语义）。
    ffmpeg 就绪走 _ensure_ffmpeg（系统 PATH/static-ffmpeg）；失败清残骸返回
    False 由调用方回退原生下载（yt-dlp 自行合流）。"""
    if not _ensure_ffmpeg():
        log.warning("合流失败：ffmpeg 缺失（系统 PATH 与 static-ffmpeg 均无）")
        return False
    r = subprocess.run(["ffmpeg", "-y", "-nostdin", "-v", "error",
                        "-i", video, "-i", audio, "-c", "copy", dest],
                       capture_output=True, text=True)
    if r.returncode != 0 or not os.path.isfile(dest) or not os.path.getsize(dest):
        log.warning("ffmpeg 合流失败（%s）", (r.stderr or "").strip()[-300:])
        try:
            os.remove(dest)
        except OSError:
            pass
        return False
    return True


def task_status(task_id=None):
    """单任务（dict 或 None）或全部任务列表（新任务在前）。"""
    with _lock:
        if task_id:
            t = _tasks.get(task_id)
            return dict(t) if t else None
        return [dict(t) for t in reversed(list(_tasks.values()))]


# yt-dlp 中间文件/半成品后缀：.f<format_id>.<ext>（多流下载未合流的单流，
# 如 bb3b9957f6b2.f616.mp4=video-only）、.part（下载中）、.ytdl（断点记录）。
# find_media 只认最终产物——否则 error 残留的 video-only 中间文件会被
# /media/<id> 前缀命中，呈现为「下载的视频没带音频」（第433次实锤修复）
_INCOMPLETE_RE = re.compile(r"\.f\d+\.|\.part$|\.ytdl$|\.temp$")


def find_media(file_id):
    """按 id 前缀在 media/ 定位文件路径；找不到返回 None。

    跳过 yt-dlp 中间文件/半成品（_INCOMPLETE_RE），只返回合并完成的产物。
    """
    try:
        for name in sorted(os.listdir(config.MEDIA_DIR)):
            if name.startswith(file_id) and not _INCOMPLETE_RE.search(name):
                return os.path.join(config.MEDIA_DIR, name)
    except OSError:
        pass
    return None


