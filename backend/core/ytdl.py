"""媒体下载：内嵌 yt-dlp resolve/download + /media 文件服务。

yt-dlp Python API（plan-backend §2.7，ytdl-server 已废弃）：resolve 同步取
直链信息；download 起后台线程落 backend/media/，文件名以任务 id 为前缀，
经 /media/<id> 按前缀定位（带 Range）。

音频 fmt（m4a/bestaudio，ASR 用途，PyAV 直接解码）只选原生流；视频
fmt（mp4/bestvideo，MPV 本地播放方向 plan §2.7）为 bestvideo+bestaudio
ffmpeg 合流——remux 封装不重编码。ffmpeg 系统 PATH 优先，缺失时补挂
imageio-ffmpeg 包内执行器（可选依赖：系统无 ffmpeg 时 install.py 才装，
wheel 自带 exe 零网络；包未装则保持缺失由 yt-dlp 报错）。

客户端信息：全局兜底 http_headers（UA + Accept-Language，提取器自带各站
专属头优先）；cookie 携带（YouTube 机器人墙等登录墙场景需要，配置即读
即用）：Netscape cookiefile（config ytdl.cookiefile，建议小号导出，路径
缺失报错不静默）或 cookies_from_browser（浏览器名直读，或 auto＝第435次
自动探测本机已装浏览器；第437次：每次直读浏览器 cookie 库逐条解密太慢，
改旧缓存优先——backend/cache/ytdl-cookies.txt 存在先用，yt-dlp 报错则删
jar 现取重试一次（_extract_info 统一入口），失败如实上抛不静默）。

并行直链下载（第438次，ASR 音频提速）：yt-dlp 原生下载器对单文件直链
（B 站 DASH m4s 等）是单连接顺序下载，且 B 站分配的 upos CDN 节点质量
不稳（慢节点几十 KB/s）、backup_url 又被提取器丢弃——ASR 音频下载慢的
主因。parallel_download 对策与 downkyi（Aria2 多线程）/BBDown（默认
多线程 + upos host 替换）同源：upos 镜像 host 并发探测择优 + 多线程
Range 分块，纯标准库零新依赖；任何失败返回 False 由调用方回退 yt-dlp
原生下载（asr_job 调用侧回退，保证不比老路更差）。
"""

import glob
import logging
import os
import re
import shutil
import threading
import time
import urllib.parse
import urllib.request
import uuid

import config

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
    """ffmpeg 就绪：系统 PATH 优先；缺失时补挂 imageio-ffmpeg 包内执行器。

    就绪返回 True。补挂仅在本进程 PATH 生效（子进程继承），幂等——补挂后
    which 短路不会重复插入。
    """
    if shutil.which("ffmpeg"):
        return True
    try:
        import imageio_ffmpeg
        os.environ["PATH"] = os.pathsep.join(
            [os.path.dirname(imageio_ffmpeg.get_ffmpeg_exe()), os.environ["PATH"]])
    except (ImportError, RuntimeError):
        pass  # 包未装或 exe 异常：保持缺失状态（HLS 等场景由 yt-dlp 报错）
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
    lang 直接取首个。条目为 {start,end,text}（秒，float，与扩展字幕
    解析器同构）。两轨全空返回 None（api 层映射 404）。零新依赖
    （urllib 标准库），扩展侧五路字幕全失败后的 backend 兜底（第399次）。
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

    tracks 为 {lang: [track]}；空表返回 (None, None)。
    """
    if not tracks:
        return None, None
    want = (lang or "").strip().lower()
    if want:
        if want in tracks:
            return want, tracks[want]
        want_head = want.split("-")[0]
        for k in tracks:
            if k.lower().split("-")[0] == want_head:
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
            opts = _base_opts(task["format"], task.get("height"), task.get("abr"))
            opts["outtmpl"] = os.path.join(config.MEDIA_DIR, f"{task['id']}.%(ext)s")
            opts["progress_hooks"] = [_progress_hook(task)]
            return opts
        info = _extract_info(make_opts, task["url"], download=True)
        if info.get("_type") == "playlist":  # 防御：noplaylist 之外的入口形态
            info = (info.get("entries") or [{}])[0]
        task["title"] = info.get("title")
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


# ---- 直链并行分块下载（第438次：ASR 音频提速，调用方失败回退 yt-dlp） ----

# B 站 CDN host 域（playurl v3 起分配 cn-* 等新 host，不再只有 upos-*），
# 命中即扩展镜像候选：CDN 签名与 host 无关，同 path+query 换 host 即换
# CDN 池；谁快用谁（探测实测，不主观排序，坏候选 403/断连自动淘汰）。
_BILI_CDN_SUFFIX = ("bilivideo.com", "akamaized.net")

_UPOS_MIRRORS = (
    "upos-sz-mirror08c.bilivideo.com",
    "upos-sz-mirrorcoso1.bilivideo.com",
    "upos-sz-mirrorcoso2.bilivideo.com",
    "upos-sz-mirrorali.bilivideo.com",
    "upos-sz-mirroraliov.bilivideo.com",
    "upos-hz-mirrorakam.akamaized.net",
)

# 分块下限：块太小请求开销占比高；块数=ceil(total/chunk) 动态领块快者多劳。
# 取 1MB：5MB 级小文件也有 5+ 块可并行（2MB 下限只切 3 块，16 线程用不满）
_CHUNK_MIN = 1 * 1024 * 1024


def parallel_download(url, dest_path, headers, progress_cb=None):
    """直链并行分块下载：CDN 测速择优 + 多线程 Range 分块落盘。

    url 必须是 http(s) 直链；headers 请求头（调用方合并 yt-dlp format 专属
    头与全局兜底）；progress_cb(pct) 可选（0-100 int）。B 站 upos 链接自动
    扩展镜像候选并发探测选最快节点，其余站点仅探测原链。返回 True 完整落
    盘；False 不适合直链或下载失败（含清理半成品），调用方回退 yt-dlp。
    """
    try:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        candidates = [url]
        host = (parsed.hostname or "").lower()
        if host.endswith(_BILI_CDN_SUFFIX):  # B 站 CDN：镜像池换 host 测速
            candidates += [urllib.parse.urlunparse(parsed._replace(netloc=h))
                           for h in _UPOS_MIRRORS
                           if h != parsed.netloc.lower()]
        head = dict(headers or {})
        best = _probe_fastest(candidates, head)
        if best is None:
            return False
        best_url, total = best
        if not total:  # 拿不到全长（无 Content-Range）：单线程流式兜底
            return _stream_download(best_url, dest_path, head, progress_cb)
        _download_chunks(best_url, total, dest_path, head, progress_cb)
        return True
    except Exception as e:  # 网络/块重试耗尽等：如实记录后回退
        log.warning("parallel_download 失败（%s），调用方回退 yt-dlp", str(e)[:200])
        try:
            os.remove(dest_path)  # 半成品必须清掉，防回退路 yt-dlp 误判已完成
        except OSError:
            pass
        return False


def _probe_fastest(candidates, headers, probe_bytes=1024 * 1024, timeout=3.0):
    """并发小段 Range 探测：按「字节/耗时」选最快候选。

    探测段取 1MB：B 站烂节点有「短段快、持续烂」的 QoS 特征（实测 256KB
    短段测不出，2MB 持续拉速仅 40KB/s 的节点短段可到 170KB/s），段太短
    会误选原链。返回 (url, total)；total 取 Content-Range 尾数（206）或
    Content-Length（200，服务端不支持 Range），拿不到为 None。全部候选
    零数据返回 None。

    多候选（B 站）时镜像优先：candidates[0] 是原链，实测 bcache 原链
    短段测速虚高且持续烂（探测 0.32MB/s、并行仅 0.11MB/s，而镜像并行
    1.4-1.9MB/s），故只要任一镜像可达就选可达镜像中的最快者，镜像全灭
    才用原链。
    """
    results, lock = [], threading.Lock()

    def probe(u):
        req = urllib.request.Request(u, headers={
            **headers, "Range": "bytes=0-%d" % (probe_bytes - 1)})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                got = 0
                while got < probe_bytes and time.time() - t0 < timeout:
                    part = r.read(1 << 16)
                    if not part:
                        break
                    got += len(part)
                if not got:
                    return
                speed = got / max(time.time() - t0, 0.05)
                total = None
                cr = r.headers.get("Content-Range") or ""
                if "/" in cr:
                    try:
                        total = int(cr.rsplit("/", 1)[1])
                    except ValueError:
                        total = None
                if total is None and r.status == 200:
                    total = int(r.headers.get("Content-Length") or 0) or None
                with lock:
                    results.append((speed, u, total))
        except OSError:
            pass  # 该候选不通（403/超时/DNS）：淘汰

    ts = [threading.Thread(target=probe, args=(u,), daemon=True)
          for u in candidates]
    for t in ts:
        t.start()
    for t in ts:
        t.join(timeout + 2)
    if not results:
        return None
    results.sort(key=lambda x: x[0], reverse=True)
    for speed, u, _t in results:
        log.info("probe %s: %.2f MB/s", urllib.parse.urlparse(u).hostname,
                 speed / 1e6)
    if len(candidates) > 1 and len(results) > 1:
        origin_host = urllib.parse.urlparse(candidates[0]).hostname or ""
        alts = [r for r in results
                if (urllib.parse.urlparse(r[1]).hostname or "") != origin_host]
        if alts:
            return alts[0][1], alts[0][2]
    return results[0][1], results[0][2]


def _download_chunks(url, total, dest_path, headers, progress_cb,
                     workers=16, retries=3):
    """多线程 Range 分块下载：预分配文件，线程池动态领块（首个异常全局收工）。

    每线程独立文件句柄 seek 写各自偏移（Windows 无 os.pwrite）；块读取字节
    不精确即失败重试，重试耗尽上抛由 parallel_download 清理并回退。
    """
    chunk = max(_CHUNK_MIN, -(-total // (workers * 4)))
    ranges = [(off, min(off + chunk, total) - 1)
              for off in range(0, total, chunk)]
    with open(dest_path, "wb") as f:
        f.truncate(total)
    state = {"idx": 0, "done": 0, "err": None}
    lock = threading.Lock()

    def worker():
        try:
            with open(dest_path, "r+b") as f:
                while True:
                    with lock:
                        if state["err"] or state["idx"] >= len(ranges):
                            return
                        a, b = ranges[state["idx"]]
                        state["idx"] += 1
                    data = _fetch_range(url, headers, a, b, retries)
                    f.seek(a)
                    f.write(data)
                    with lock:
                        state["done"] += len(data)  # 累加实绩：块完成无序，防进度跳动
                        if progress_cb:
                            progress_cb(state["done"] * 100 // total)
        except Exception as e:
            with lock:
                state["err"] = state["err"] or e

    ts = [threading.Thread(target=worker, daemon=True)
          for _ in range(min(workers, len(ranges)))]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    if state["err"]:
        raise state["err"]


def _fetch_range(url, headers, a, b, retries):
    """单块 Range 抓取（字节精确）：读不满即失败，退避后整块重试。"""
    want = b - a + 1
    last = None
    for i in range(retries):
        if i:
            time.sleep(0.5 * i)
        try:
            req = urllib.request.Request(url, headers={
                **headers, "Range": "bytes=%d-%d" % (a, b)})
            with urllib.request.urlopen(req, timeout=30) as r:
                buf = bytearray()
                while len(buf) < want:
                    part = r.read(min(1 << 20, want - len(buf)))
                    if not part:
                        break
                    buf += part
                if len(buf) == want:
                    return bytes(buf)
                last = RuntimeError("Range 响应不足 %d/%d" % (len(buf), want))
        except OSError as e:
            last = e
    raise last if last else RuntimeError("Range 下载未知失败")


def _stream_download(url, dest_path, headers, progress_cb):
    """服务端不支持 Range（无全长）时的单线程流式兜底，罕见路径。"""
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r, \
            open(dest_path, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0) or None
        got = 0
        while True:
            part = r.read(1 << 20)
            if not part:
                break
            f.write(part)
            got += len(part)
            if progress_cb and total:
                progress_cb(got * 100 // total)
    return True
