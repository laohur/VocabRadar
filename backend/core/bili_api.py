"""B 站 API 直链（第440次）：绕过 yt-dlp 页面解析的额外下载渠道。

背景：yt-dlp BiliBili extractor 依赖网页 initial state，站方改版/风控即
「Unable to extract initial state」整链挂死。B 站 web API（view/playurl）
直取 DASH 音频直链，实测（BV1Uwh36bEDH）无需 WBI 签名、无需登录 cookie，
仅需完整浏览器请求头——缺 Accept/Sec-Fetch-* 等特征即 412 Precondition
Failed（主站指纹 cookie 也救不了，特征头才是过关关键）。

链路：主站指纹 cookie（buvid3/b_nut，进程内缓存一次）→ view 拿 cid/title/
pages → playurl(fnval=16) 拿 DASH 音频直链 → 复用 core.ytdl.parallel_download
（直链为 bilivideo.com 域，自动镜像池择优 + 多线程 Range 分块）。

范围与回退：仅支持普通投稿视频（/video/BVxx|avxx + 分 P p 参数）；番剧
（ep/ss）等 playurl 需登录或特殊参数，不支持——调用方（core.asr_job）失败
回落 yt-dlp 老路。API 风控收紧/接口改版同样如实上抛由调用方回退。

时长语义：view 顶层 duration 是合集总时长（多 P 不可用）；单 P 时长取
playurl 的 data.timelength（毫秒，实测精确），缺失时退 pages[p-1].duration。
"""

import gzip
import http.cookiejar
import json
import logging
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import urlencode

from core.ytdl import _HTTP_HEADERS, parallel_download

log = logging.getLogger(__name__)

# 412 过关头组合（第440次实测：裸 UA+Referer 全 412，补全特征头即 code 0）。
# Accept-Encoding 只声明 gzip——urllib 不会自动解压 br，声明了就解不了。
_HEADERS = {
    **_HTTP_HEADERS,  # UA + Accept-Language（与 yt-dlp 全局兜底同源）
    "Referer": "https://www.bilibili.com/",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.bilibili.com",
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "Accept-Encoding": "gzip",
}

_BV_RE = re.compile(r"/video/(BV[0-9A-Za-z]{10})")
_AV_RE = re.compile(r"/video/av(\d+)", re.IGNORECASE)

# 模块级指纹态：主站 Set-Cookie 一次拿到，进程生命周期复用（buvid3 无时效压力）
_JAR_LOCK = threading.Lock()
_OPENER = None  # 带 cookie jar 的 opener（fingerprint 成功后非 None）
_NO_REDIRECT_OPENER = None  # 短链逐跳手跟用（类定义后初始化）


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """禁自动跟随：30x 时抛 HTTPError（headers 带 Location），短链逐跳手跟。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirectHandler())


def is_bili_url(url):
    """是否 B 站链接（主站任意子域或 b23.tv 短链）。"""
    host = urllib.parse.urlsplit(url).netloc.lower()
    return host.endswith("bilibili.com") or host.endswith("b23.tv")


def expand_short(url):
    """b23.tv 短链 → 真身 URL（逐跳读 Location，最多 5 跳）；非短链原样返回。"""
    host = urllib.parse.urlsplit(url).netloc.lower()
    if not host.endswith("b23.tv"):
        return url
    cur = url
    for _ in range(5):
        req = urllib.request.Request(cur, headers=_HEADERS)
        try:
            with _NO_REDIRECT_OPENER.open(req, timeout=10) as r:
                r.read(256)  # 200：重定向已结束
                return cur
        except urllib.error.HTTPError as e:
            e.close()
            loc = e.headers.get("Location") if e.headers else None
            if not loc:
                raise RuntimeError(f"b23.tv 短链无 Location（HTTP {e.code}）") from e
            cur = urllib.parse.urljoin(cur, loc)
    raise RuntimeError("b23.tv 短链重定向超 5 跳")


def parse(url):
    """真身 URL → {"vid": "BVxx"/"avN", "p": 分P号}；非视频页返回 None。

    p 从 query 取（缺省 1）；av 大小写不敏感，BV 严格原样（BV 号大小写敏感）。
    """
    parts = urllib.parse.urlsplit(url)
    m = _BV_RE.search(parts.path) or _AV_RE.search(parts.path)
    if not m:
        return None
    try:
        p = int((dict(urllib.parse.parse_qsl(parts.query)).get("p") or "1").strip() or 1)
    except ValueError:
        p = 1
    return {"vid": m.group(1), "p": max(p, 1)}


def _fingerprint():
    """主站 GET 拿浏览器指纹 cookie（buvid3/b_nut），进程内一次。失败如实上抛。"""
    global _OPENER
    if _OPENER is not None:
        return
    with _JAR_LOCK:
        if _OPENER is not None:
            return
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar))
        req = urllib.request.Request("https://www.bilibili.com/",
                                     headers=_HEADERS)
        try:
            with opener.open(req, timeout=10) as r:
                r.read(256)  # Set-Cookie 在响应头，body 读一小段即可
        except OSError as e:
            raise RuntimeError(f"B 站主站指纹获取失败：{e}") from e
        _OPENER = opener
        log.info("B 站主站指纹 cookie：%s", ", ".join(sorted(c.name for c in jar)))


def _get_json(url):
    """API GET → dict。带指纹 cookie；gzip 手动解压（Accept-Encoding 声明了 gzip）。"""
    _fingerprint()
    req = urllib.request.Request(url, headers=_HEADERS)
    try:
        with _OPENER.open(req, timeout=10) as r:
            raw = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
    except OSError as e:
        raise RuntimeError(f"B 站 API 请求失败：{e}") from e
    return json.loads(raw.decode("utf-8", "replace"))


def extract(url):
    """B 站视频 → 元数据 + DASH 音频直链。

    返回 {video_id, title, duration, cid, p, audio_url}；非 B 站视频页、
    分 P 超界、接口 code 非 0、无可用音频轨均 RuntimeError（调用方回落）。
    """
    url = expand_short(url)
    m = parse(url)
    if not m:
        raise RuntimeError(f"非 B 站视频 URL：{url}")
    vid, p = m["vid"], m["p"]
    params = {"bvid": vid} if vid.startswith("BV") else {"aid": vid[2:]}
    j = _get_json(f"https://api.bilibili.com/x/web-interface/view?{urlencode(params)}")
    if j.get("code") != 0:
        raise RuntimeError(f"B 站 view 接口 code={j.get('code')} {j.get('message')}")
    data = j.get("data") or {}
    pages = data.get("pages") or []
    page = next((pg for pg in pages if pg.get("page") == p), None)
    if p > 1 and page is None:
        raise RuntimeError(f"B 站分 P 超界：p={p} 共 {len(pages)} P")
    cid = (page or {}).get("cid") or data.get("cid")
    if not cid:
        raise RuntimeError("B 站 view 未返回 cid")
    title = data.get("title") or vid
    if len(pages) > 1:  # 多 P：拼分 P 号与分 P 名，合集标题不可指别
        part = (page or {}).get("part") or ""
        title = f"{title} P{p} {part}".strip()
    j2 = _get_json(
        f"https://api.bilibili.com/x/player/playurl?"
        f"{urlencode({'bvid': vid, 'cid': cid, 'fnval': 16})}")
    if j2.get("code") != 0:
        raise RuntimeError(f"B 站 playurl 接口 code={j2.get('code')} {j2.get('message')}")
    d2 = j2.get("data") or {}
    audios = (d2.get("dash") or {}).get("audio") or []
    if not audios:
        raise RuntimeError("B 站 playurl 无 DASH 音频轨")
    # 第442次（用户裁定「asr下载音频用最高音质错误，之前有规定超过whisper
    #   音质的最低音质，不知道就最低音质。asr谁让你下载大文件的！」）：不取
    #   首档（服务端降档排序首档=会话最高档），按带宽（缺省回退 id）升序取
    #   最低档——whisper 解码按 16kHz 单声道重采样，最低档 30216（64kbps
    #   AAC）已远超所需，杜绝为转写拉最高码率大文件。
    a = min(audios, key=lambda x: (x.get("bandwidth") or x.get("id") or 0))
    audio_url = a.get("baseUrl") or (a.get("backupUrl") or [None])[0]
    if not audio_url:
        raise RuntimeError("B 站 playurl 音频轨无直链")
    # 单 P 时长：timelength 毫秒（playurl 实测精确）> pages duration
    duration = d2.get("timelength")
    duration = round(duration / 1000, 3) if duration else (page or {}).get("duration")
    # 第441次（用户裁定「下载之前要打印，包括选定参数」）：音质档与完整
    #   直链入日志（直链截断防刷屏；mirror host 由 parallel_download 择优）。
    log.info("B 站 API 直链：%s p%s cid=%s 音质id=%s host=%s 时长=%ss url=%s",
             vid, p, cid, a.get("id"),
             urllib.parse.urlparse(audio_url).hostname, duration,
             audio_url[:200])
    return {"video_id": vid, "title": title, "duration": duration,
            "cid": cid, "p": p, "audio_url": audio_url}


def download_audio(url, dest_path, progress_cb=None):
    """B 站音频下载（第440次渠道）：extract + parallel_download（镜像池+分块）。

    返回 extract 元数据（含 audio_path）；提取或下载失败 RuntimeError，
    调用方回落 yt-dlp 链路。直链为 bilivideo.com 域，parallel_download
    自动扩展 upos 镜像候选并发测速择优。
    """
    meta = extract(url)
    ok = parallel_download(meta["audio_url"], dest_path,
                           dict(_HEADERS), progress_cb)
    if not ok:
        raise RuntimeError("B 站 API 直链下载失败")
    meta["audio_path"] = dest_path
    return meta
