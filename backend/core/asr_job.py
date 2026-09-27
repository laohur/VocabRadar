"""ASR 端到端任务：URL → yt-dlp 下载 → faster-whisper 逐段转写 → 增量轮询。

设计（第398次，plan-backend 阶段三2，用户裁定）：
- 交互形态：POST 提交 URL 即返回任务 id；客户端定时轮询 GET ?after=N 取新增
  转写段（带 start/end 时间戳）——下载一段、识别一段、返回一段，不等全部
  完成。faster-whisper 的 transcribe 返回 (segments生成器, info)，逐段消费
  逐段可取，是增量协议的技术基础。
- 引擎锁定 faster-whisper：字幕跟随播放需要时间戳，且只有 whisper 提供生成
  器（第404次：qwen3-asr 备选整体移除，无时间戳是第三百九十六次不作默认的
  主因）。复用
  AsrEngine.ensure_loaded 拿模型，但转写循环自持——core/asr.py 的 transcribe
  把生成器消费完才返回，不满足增量。
- 下载复用 core/ytdl 的 yt-dlp 基础（_ensure_ffmpeg/_base_opts/_extract_info，
  固定 asr 串原生流，PyAV 直解；第442次用户裁定「超过whisper音质的最低音
  质，不知道就最低音质」——worstaudio 取最低码率档，杜绝为转写下大文件）。
  产物落进程临时目录，转写完成即删——音频只是中间产物，缓存只存 JSON 不存
  音频。
- 第438次下载提速：先提取（download=False）拿选中格式直链，走 ytdl
  parallel_download 并行分块下载（B 站 upos 镜像探测择优 + 多线程 Range，
  治「yt-dlp 单连接 + 慢 CDN 节点」）；非直链协议（HLS/DASH 等）或并行
  下载失败时回退 yt-dlp 原生下载老路（_ytdlp_download，语义与原实现一致）。
- 第437次方案A（用户裁定）：下载音频前先查官方字幕（core.ytdl.subtitles），
  有 cues 秒级直出（segments=官方字幕条目，缓存条目 engine=official），无才
  走下载+转写——backend 已拿到现成字幕时不再干等慢速 CPU 转写。
- 并发：全局信号量 1——CPU 转写单路即饱和，同刻只放行一个任务，其余停在
  queued 排队。任务表同 core/ytdl：内存态，进程重启即清，无持久化。
- 缓存：读写在本模块（任务生命周期内：创建时查、转写完写；api 层 multipart
  的缓存读写仍归 api/asr.py）。条目格式与现有缓存兼容（ASR_CACHE_DIR，管理
  界面 cache_list 可见）。命中校验引擎与请求语言（同 api 层语义）。
- 第439次缓存 key 归一化（用户裁定 backend 做）：B 站 URL 带毫秒时间戳类
  跟踪参数（trackid/spm_id_from/vd_source），整 URL SHA 作 key 每次都变、
  缓存永不命中。归一化只留视频身份：B 站路径（已含 BV/av/ep/ss 号）+ query
  保留 p/cid（分 P 与合集定位，同 makeVideoKey 语义）；YouTube watch 保留 v
  （youtu.be 短链取路径）；其余站点去 query+fragment 只留 host+path。
- 第439次覆盖与结果两维度（用户铁律：覆盖时间跟识别结果时间是两个维度，
  禁止混用）：覆盖（job["coverage"]）= VAD 判定有人声、实际送转写的音频
  区间秒值数组，独立记录、随轮询快照下发、写入缓存条目；识别结果段
  （segments）仅供字幕渲染。转写显式按覆盖区间送（clip_timestamps），
  不再依赖 vad_filter 内部黑盒——其区间不可记录，BGM 大段误杀即「缺一大段
  +时间跳跃」且无从补救。主转写后对覆盖空洞（≥ _HOLE_MIN_SEC）补转：
  vad_filter=False 强制转写 + no_speech_prob 过滤防静音幻觉；补转区间并入
  覆盖。空洞判定与进度推进只看覆盖维度，绝不以结果段反推覆盖。
- 第440次下载渠道：B 站 URL 优先走 core.bili_api（web API 直取 DASH 音频
  直链，绕过 yt-dlp 页面解析——站方改版即「Unable to extract initial
  state」整链挂死；API 实测无需登录，仅需完整浏览器请求头过 412），失败
  回落 yt-dlp 老路。
- 第440次缓存条目：key 改 site-vid slug（bilibili-BVxx-p2-cidxx /
  youtube-<v> / host-path-sha8），文件名可读、视频号在文件名里可双向反查；
  条目去合并 text（segments 即全量文本，合并冗余），加音频时长 duration。
  缓存 key 在 create() 算一次存 job["cache_key"]（b23.tv 短链只展开一次），
  写缓存不再重算。
- 第441次 key 命名（用户裁定「你过虑了，ytdl有现成方案就用他的命名规则」
  ＋「命名为 f'{ie_key.lower()}-{video_id}'」）：上半场的域名前缀方案作废，
  key 回第440次站点名 slug（bilibili-BVxx[-pN][-cidN] / youtube-<v> /
  host-path-sha8）——与 yt-dlp make_archive_id
  （f'{ie_key.lower()} {video_id}'，B 站即 bilibili BVxx）同规则，仅分隔符
  按文件名场景用 `-`；不另设 site 键（用户裁定「移除site键」）。
- 第441次受理/执行/下载前日志（用户裁定「任务执行前要打印，下载之前要
  打印，包括选定参数」）：create 受理即打 url/key/language 全参数；获执行
  权开跑时再打一条；下载前打选定参数（B 站 API：vid/p/cid/音质档/直链；
  yt-dlp 直链：format/协议/直链；原生回退：格式串）。
- 第444次进度里程碑日志改法（用户裁定「asr结果里程碑日志改为每100条输出
  一条，不再用定时，减轻复杂度」）：第441次的 10s 定时器作废，转写循环内
  以段计数驱动——每累计 100 段打一条，行带 phase/覆盖秒数/进度百分比/
  最近外联动作与 URL（last_net）。
"""

import hashlib
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit

from faster_whisper.audio import decode_audio
from faster_whisper.vad import get_speech_timestamps

import config
from core import bili_api
from core.asr import ASR_CACHE_DIR, _safe_key
from core.ytdl import (_FMT_FORMAT, _HTTP_HEADERS, _base_opts,
                       _ensure_ffmpeg, _extract_info, parallel_download,
                       subtitles as _ytdl_subtitles)

log = logging.getLogger(__name__)

# 第439次空洞补转参数：BGM 误杀的空洞 < 30s 不值得一次转写调用（句间停顿、
#   片头片尾静音常态存在）；补转段 no_speech_prob 高于阈值视为无语音（防
#   静音段幻觉——vad_filter=False 后 whisper 对无人声区间易产幻觉重复串）。
_HOLE_MIN_SEC = 30
_NO_SPEECH_PROB = 0.6

_jobs = {}  # 任务表：模块级内存态（同 core/ytdl）
_lock = threading.Lock()

# CPU 转写单路饱和：同刻只放行一个任务在跑，其余排队（状态停在 queued）
_run_sem = threading.Semaphore(1)


def create(url, language, asr_engine):
    """提交 URL 任务 → job dict。asr_engine 为请求上下文内取到的 AsrEngine 实例
    （后台线程无 app context，入口一次传入）。缓存命中时建即完成的任务，
    客户端首轮轮询即拿到全量段。"""
    if not url or not url.startswith(("http://", "https://")):
        raise ValueError("url 必须为 http(s) 链接")
    key = _cache_key(url)  # 第440次：create 算一次（b23.tv 短链在此展开），全程复用
    hit = _cache_get_key(key, language)
    job = _new_job(language, asr_engine, hit)
    job["url"] = url
    job["cache_key"] = key
    with _lock:
        _jobs[job["id"]] = job
    # 第441次（用户裁定「任务执行前要打印」）：受理即打全参数。
    log.info("ASR 任务受理 %s：url=%s key=%s lang=%s 命中缓存=%s",
             job["id"], url, key, language, bool(hit))
    if not hit:
        threading.Thread(target=_run_url, args=(job, asr_engine), daemon=True).start()
    return job


def create_file(filepath, filename, language, asr_engine, cache_key=None):
    """提交上传文件任务（第409次流式转写）：跳过下载，直接逐段转写。

    filepath 为 api 层落盘的临时文件（任务结束自删）；cache_key 为内容
    SHA-256 前 16 位（复用 ASR 缓存，重复上传同文件命中免转写）。
    """
    hit = _cache_get_key(cache_key, language) if cache_key else None
    job = _new_job(language, asr_engine, hit)
    job["source"] = "file"
    job["title"] = filename
    job["file_path"] = filepath
    job["cache_key"] = cache_key
    with _lock:
        _jobs[job["id"]] = job
    # 第441次：文件任务同样受理即打（用户裁定「任务执行前要打印」）。
    log.info("ASR 文件任务受理 %s：file=%s key=%s lang=%s 命中缓存=%s",
             job["id"], filename, cache_key, language, bool(hit))
    if not hit:
        threading.Thread(target=_run_file, args=(job, asr_engine), daemon=True).start()
    else:
        os.remove(filepath)  # 命中缓存无需转写，临时文件即刻回收
    return job


def _new_job(language, asr_engine, hit):
    """job 骨架（URL/文件两源共用）。缓存命中时建即完成的任务。"""
    job = {
        "id": uuid.uuid4().hex[:12],
        "url": None,
        "source": "url",
        "language": language,
        "engine": "faster-whisper",  # job 固定 whisper（时间戳 + 生成器增量）
        "status": "queued",          # queued|downloading|transcribing|completed|failed
        "progress": {"download": 0, "transcribe": 0},
        "title": None,
        "detected_language": None,
        "segments": list(hit["segments"]) if hit else [],
        "coverage": list(hit["coverage"]) if hit and hit.get("coverage") else [],
        # 第440次：命中恢复 duration（条目新字段）；合并 text 已废——segments
        #   即全量文本，扩展端确认不消费 job 顶层 text。
        "duration": (hit or {}).get("duration"),
        "error": None,
        "cached": bool(hit),
        "created_at": int(time.time()),
        "finished_at": None,
        "cache_key": None,
        # 第441次：phase（任务阶段，进度/快照用）、last_net（最近外联动作，
        #   _net 打点整体替换，进度日志与管理页快照共用）。
        "phase": "queued",
        "last_net": None,
    }
    if hit:
        job["status"] = "completed"
        job["finished_at"] = job["created_at"]
    return job


def status(job_id, after=0):
    """单任务增量快照：segments 只回 after 游标之后的段（轮询增量协议）；
    另带 segments_total 供客户端对齐游标。找不到返回 None。"""
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return None
        segs = job["segments"]
        snap = {k: v for k, v in job.items() if k != "segments"}
    after = after if isinstance(after, int) and after >= 0 else 0
    snap["segments_total"] = len(segs)
    snap["segments"] = segs[after:]
    return snap


def _phase(job, name):
    job["phase"] = name  # 赋值原子，快照并发安全


def _net(job, action, url=None):
    """第441次外联轨迹打点：job["last_net"] 整体替换（赋值原子），进度
    里程碑日志与管理页快照共用。url 截断防日志爆炸。"""
    job["last_net"] = {"t": round(time.time(), 1), "action": action,
                       "url": (url or "")[:150]}


def _run_url(job, asr_engine):
    with _run_sem:  # 排队：前面的任务跑完才进入下载
        _pipeline_url(job, asr_engine)


def _run_file(job, asr_engine):
    with _run_sem:  # 文件任务与 URL 任务共用单路信号量
        _pipeline_file(job, asr_engine)


def _pipeline_url(job, asr_engine):
    # 第441次（用户裁定「任务执行前要打印」）：获执行权开跑时打一条
    #   （排队结束的明确标志，与受理日志区分开）。
    log.info("ASR 任务 %s 开始执行：url=%s key=%s",
             job["id"], job["url"], job["cache_key"])
    tmpdir = tempfile.mkdtemp(prefix="asrjob_")
    try:
        # 第437次方案A：官方字幕秒级直出（命中则跳过下载+转写，异常不阻塞主线）
        _phase(job, "subtitles")  # 第441次：阶段打点（快照）
        _net(job, "yt-dlp 字幕探测", job["url"])
        if _try_official_subtitles(job):
            return
        _ensure_ffmpeg()  # 就绪保障：HLS/分段流站点需要（缺失不阻塞原生流下载）
        job["status"] = "downloading"
        _phase(job, "downloading")
        video_id, audio_path = None, None
        # 第440次：B 站先走 API 直链渠道（yt-dlp 页面解析挂死时仍可用），
        #   失败回落下方 yt-dlp 链路。title/duration 先填 API 元数据，转写
        #   阶段以真实解码时长覆盖。
        if bili_api.is_bili_url(job["url"]):
            _net(job, "B 站 API 取音频直链", job["url"])  # 第441次外联打点
            binfo = _try_bili_api(job, tmpdir)
            if binfo:
                job["title"] = binfo["title"]
                job["duration"] = binfo["duration"]
                video_id = binfo["video_id"]
                audio_path = binfo["audio_path"]
        if audio_path is None:
            # 第438次原链路：先提取（不下载）拿选中格式直链走并行分块下载；
            #   不合适或失败回退 yt-dlp 原生下载老路。opts 构造含 cookiefile
            #   配置校验，放 try 内统一记 job.error；_fresh 由 _extract_info
            #   传（旧缓存 jar 失效重试时强制现取）。
            def make_opts(_fresh=False):
                return _base_opts("asr", fresh_cookie=_fresh)  # 第442次 worstaudio 最低音质档
            info = _extract_info(make_opts, job["url"], download=False)
            if info.get("_type") == "playlist":  # 防御：noplaylist 之外的入口形态
                info = (info.get("entries") or [{}])[0]
            job["title"] = info.get("title")
            job["duration"] = info.get("duration")
            _net(job, "并行分块下载",
                 (info.get("url") or (info.get("requested_formats") or [{}])[0]
                  .get("url") or ""))  # 第441次外联打点（直链/首格式）
            audio_path = _parallel_audio(info, job, tmpdir)
            if audio_path is None:  # 回退 yt-dlp 原生下载，语义与第438次前一致
                info, audio_path = _ytdlp_download(job, tmpdir)
            video_id = info.get("id")
        _transcribe(job, asr_engine, audio_path, video_id=video_id)
    except Exception as e:  # yt-dlp/模型/解码异常类型庞杂，统一兜底记任务
        job["status"] = "failed"
        job["error"] = str(e)[:300]
        # 第440次：失败日志带 URL（此前只带任务 id，出问题无从对号）
        log.error("ASR 任务 %s（URL 源 %s）失败：%s",
                  job["id"], job["url"], job["error"])
    finally:
        job["finished_at"] = int(time.time())
        shutil.rmtree(tmpdir, ignore_errors=True)


def _try_bili_api(job, tmpdir):
    """第440次 B 站 API 直链渠道（core.bili_api）：成功返回元数据 dict
    （title/duration/video_id/audio_path），任何失败记 warning 后返回 None
    由调用方回落 yt-dlp 链路。"""
    def on_progress(pct):
        job["progress"]["download"] = pct
    try:
        return bili_api.download_audio(
            job["url"], os.path.join(tmpdir, f"{job['id']}.m4a"), on_progress)
    except Exception as e:
        log.warning("ASR 任务 %s B 站 API 直链失败，回落 yt-dlp 链路：%s",
                    job["id"], str(e)[:200])
        return None


def _parallel_audio(info, job, tmpdir):
    """第438次：选中格式直链并行分块下载（B 站提速主路）。

    不适合直链（非 http/https 协议，如 HLS/DASH 分段）或下载失败返回
    None，调用方回退 yt-dlp 原生下载。合流选择（bestaudio 全 miss 落
    best 合流的罕见场景，requested_formats 两项）取音频项；无音频项取
    首项（视频容器 ffmpeg 亦能解出音轨）。
    """
    rf = info.get("requested_formats")
    if rf:
        fmt = next((f for f in rf
                    if f.get("acodec") not in (None, "none")), rf[0])
    else:
        fmt = info
    url = (fmt or {}).get("url")
    proto = (fmt or {}).get("protocol")
    if not url or not url.startswith(("http://", "https://")) \
            or (proto and proto not in ("http", "https")):
        return None
    ext = (fmt or {}).get("ext") or info.get("ext") or "m4a"
    dest = os.path.join(tmpdir, f"{job['id']}.{ext}")
    headers = {**_HTTP_HEADERS, **((fmt or {}).get("http_headers") or {})}
    # 第441次（用户裁定「下载之前要打印，包括选定参数」）：选定格式全打
    #   （format_id/ext/协议/直链截断，mirror host 由 parallel_download 择优）。
    log.info("ASR 任务 %s 直链并行下载：fmt=%s ext=%s proto=%s url=%s",
             job["id"], (fmt or {}).get("format_id"), ext, proto, url[:200])

    def on_progress(pct):
        job["progress"]["download"] = pct

    ok = parallel_download(url, dest, headers, on_progress)
    return dest if ok else None


def _ytdlp_download(job, tmpdir):
    """yt-dlp 原生下载（第438次前的老路，现为直链并行下载的回退）：
    HLS/DASH 等非直链协议、并行下载失败时走这里。返回 (info, audio_path)。
    """
    def make_opts(_fresh=False):
        opts = _base_opts("asr", fresh_cookie=_fresh)  # 第442次 worstaudio 最低音质档
        opts["outtmpl"] = os.path.join(tmpdir, f"{job['id']}.%(ext)s")
        opts["progress_hooks"] = [_download_hook(job)]
        return opts
    _net(job, "yt-dlp 原生下载", job["url"])  # 第441次外联打点（回退路）
    # 第441次（用户裁定「下载之前要打印，包括选定参数」）：回退路打格式串
    #   （第442次起 _base_opts("asr") 恒取 _FMT_FORMAT["asr"] worstaudio 档；
    #   不预构造 opts，防触发 cookie 探测副作用）。
    log.info("ASR 任务 %s yt-dlp 原生下载回退：url=%s fmt=%s",
             job["id"], job["url"], _FMT_FORMAT["asr"])
    info = _extract_info(make_opts, job["url"], download=True)
    if info.get("_type") == "playlist":  # 防御：noplaylist 之外的入口形态
        info = (info.get("entries") or [{}])[0]
    job["title"] = info.get("title")
    job["duration"] = info.get("duration")
    # requested_downloads[0].filepath 是最终产物路径（同 core/ytdl 取法）
    rd = (info.get("requested_downloads") or [{}])[0]
    audio_path = rd.get("filepath") or _find_tmp(tmpdir, job["id"])
    if not audio_path:
        raise RuntimeError("下载产物未定位到文件")
    return info, audio_path


def _try_official_subtitles(job):
    """第437次方案A：下载音频前先查官方字幕，有则秒级直出。

    背景：字幕兜底链路（/api/ytdl/subtitles）与 ASR job 互不相通——backend
    已拿到官方字幕时，扩展侧 ASR 激活期间会丢弃原生字幕覆盖（updateSubtitles
    守卫），只能干等慢速 CPU 转写。官方字幕必须以 job 段形态走轮询直出路径。
    有 cues：按 start 排序填 job、写缓存（engine=official）、completed、返回
    True；查不到（无轨/站点不支持/网络异常）返回 False 落回转写主线，任何
    异常只记日志不阻塞。"""
    try:
        sub = _ytdl_subtitles(job["url"], job["language"])
    except Exception as e:
        log.info("ASR 任务 %s 官方字幕探测未命中（%s），落回转写主线",
                 job["id"], str(e)[:150])
        return False
    cues = (sub or {}).get("cues") or []
    if not cues:
        log.info("ASR 任务 %s 无可用官方字幕轨，落回转写主线", job["id"])
        return False
    cues.sort(key=lambda c: c.get("start", 0))
    job["segments"] = [{"start": c["start"], "end": c["end"], "text": (c.get("text") or "").strip()}
                       for c in cues if (c.get("text") or "").strip()]
    if not job["segments"]:
        return False  # cues 全空文（罕见）：等同无字幕，落回转写主线
    job["detected_language"] = sub.get("lang")
    job["progress"] = {"download": 100, "transcribe": 100}
    if _cache_enabled():
        _cache_put_official(job, sub.get("video_id"))
    job["status"] = "completed"
    log.info("ASR 任务 %s 官方字幕直出：%d 条（%s，%s）",
             job["id"], len(job["segments"]), sub.get("kind"), sub.get("lang"))
    return True


def _pipeline_file(job, asr_engine):
    """上传文件管线（第409次）：无下载段，直接转写；结束回收临时文件。"""
    log.info("ASR 文件任务 %s 开始执行：file=%s lang=%s",
             job["id"], job.get("title"), job["language"])  # 第441次
    try:
        _transcribe(job, asr_engine, job["file_path"])
    except Exception as e:  # 模型/解码异常统一兜底记任务
        job["status"] = "failed"
        job["error"] = str(e)[:300]
        log.error("ASR 任务 %s（文件源 %s）失败：%s",
                  job["id"], job.get("title", "?"), job["error"])
    finally:
        job["finished_at"] = int(time.time())
        try:
            os.remove(job["file_path"])
        except OSError:
            pass


def _transcribe(job, asr_engine, audio_path, video_id=None):
    """转写共用段（URL/文件两源）：逐段消费生成器、增量可见、完成写缓存。

    第439次（用户铁律：覆盖时间与识别结果时间是两个维度，禁止混用）：
    独立跑 silero VAD 拿覆盖真值（coverage），显式按覆盖区间送转写
    （clip_timestamps），进度按覆盖区间推进；空洞判定只看覆盖维度，
    绝不以结果段时间反推覆盖。
    """
    job["status"] = "transcribing"
    _phase(job, "transcribing")  # 第441次：阶段打点（快照）
    model, _ = asr_engine.ensure_loaded("faster-whisper")
    # 一次解码供 VAD 与转写共用（transcribe 传 numpy 跳过二次解码）；
    #   16kHz float32 单声道，1h 音频约 230MB，与模型开销同量级可接受。
    audio = decode_audio(audio_path, sampling_rate=16000)
    # 第439次：独立 VAD 取覆盖真值（与 vad_filter=True 同为 silero 默认参数，
    #   但区间可记录可下发）。VAD 判定无人声的区间不在覆盖内，主转写跳过。
    speeches = get_speech_timestamps(audio, sampling_rate=16000)
    coverage = [[round(sp["start"] / 16000, 3), round(sp["end"] / 16000, 3)]
                for sp in speeches]
    job["coverage"] = coverage  # 整体赋值；后续更新一律整体替换（快照并发安全）
    covered_total = sum(b - a for a, b in coverage)
    duration = len(audio) / 16000
    job["duration"] = round(duration, 3)  # 第440次：真实解码时长入 job，随缓存条目落盘
    log.info("ASR 任务 %s VAD 覆盖：%d 区间 %.1fs / 音频 %.1fs",
             job["id"], len(coverage), covered_total, duration)
    if not coverage:
        log.info("ASR 任务 %s 全程未检出人声，跳过转写，直接补转空洞", job["id"])
    else:
        # clip_timestamps（秒成对序列）：只转写覆盖区间，时间戳由 faster-whisper
        #   内部映射回原时间轴，绝对秒直出与 vad_filter 时代一致。
        clips = ",".join(f"{a:.3f},{b:.3f}" for a, b in coverage)
        segs_iter, tinfo = model.transcribe(audio,
                                            language=job["language"] or None,
                                            clip_timestamps=clips,
                                            vad_filter=False)
        job["detected_language"] = tinfo.language
        ci, done = 0, 0.0
        for s in segs_iter:  # 生成器：识别一段、追加一段，轮询端即刻可见
            seg = {"start": round(s.start, 3), "end": round(s.end, 3),
                   "text": s.text.strip()}
            job["segments"].append(seg)
            # 进度按覆盖区间推进：段 end 越过区间终点即计该区间完成
            #   （段 end 只是转写位置指示，不用于覆盖计算）。
            while ci < len(coverage) and s.end >= coverage[ci][1] - 0.01:
                done += coverage[ci][1] - coverage[ci][0]
                ci += 1
            if covered_total:
                job["progress"]["transcribe"] = round(done / covered_total * 100)
            # 第444次里程碑（用户裁定「每100条输出一条，不再用定时」）：
            #   段计数驱动，每累计 100 段打一条，行带外联轨迹。
            if len(job["segments"]) % 100 == 0:
                net = job.get("last_net") or {}
                log.info("ASR 任务 %s 转写进度：%.1fs/%.1fs 覆盖（%d%%）%d 段 外联=%s",
                         job["id"], done, covered_total,
                         job["progress"]["transcribe"], len(job["segments"]),
                         ("%s %s" % (net.get("action"), net.get("url", "")))
                         if net else "无")
    # 第439次空洞补转：VAD 误判无人声的长间隙（BGM 重人声轻的营销号视频
    #   常态）强制转写一遍，补转区间并入覆盖——先补转再写缓存，缓存条目
    #   的覆盖必为终值。
    _fill_holes(job, model, audio, coverage, language=job["language"] or None)
    job["progress"]["transcribe"] = 100
    if _cache_enabled():
        if job.get("source") == "file":
            _cache_put_key(job.get("cache_key"), job)
        else:
            _cache_put(job, video_id)
    job["status"] = "completed"
    log.info("ASR 任务 %s 转写完成：%d 段，覆盖 %d 区间（%s）",
             job["id"], len(job["segments"]), len(job["coverage"]),
             job["detected_language"])


def _coverage_holes(coverage, duration):
    """覆盖维度算空洞：[0, duration] 中未被 coverage 覆盖且时长 ≥
    _HOLE_MIN_SEC 的连续区间。与识别结果段无关（两维度禁止混用）。
    duration 非正时无从计算，返回空。"""
    if not duration or duration <= 0:
        return []
    holes, pos = [], 0.0
    for a, b in sorted(coverage or []):
        if a - pos >= _HOLE_MIN_SEC:
            holes.append((pos, a))
        pos = max(pos, b)
    if duration - pos >= _HOLE_MIN_SEC:
        holes.append((pos, duration))
    return holes


def _fill_holes(job, model, audio, coverage, language=None):
    """第439次空洞补转：对覆盖空洞逐段强制转写（vad_filter=False），
    no_speech_prob 过滤静音幻觉；无论转出与否，补转区间并入覆盖
    （送过识别即覆盖）。覆盖只在结束时整体替换一次（快照并发安全）。
    补转段追加在主转写段之后（到达序≠时间序）：轮询批内排序与缓存条目
    排序已由第436/437次机制兜住，无需在此重排本体。"""
    _phase(job, "filling-holes")  # 第441次：阶段打点（快照）
    holes = _coverage_holes(coverage, len(audio) / 16000)
    if not holes:
        return
    log.info("ASR 任务 %s 空洞补转：%d 段（%s）",
             job["id"], len(holes),
             ", ".join(f"{a:.0f}-{b:.0f}s" for a, b in holes))
    added = 0
    for a, b in holes:
        segs_iter, _ = model.transcribe(audio, language=language,
                                        clip_timestamps=f"{a:.3f},{b:.3f}",
                                        vad_filter=False)
        for s in segs_iter:
            if s.no_speech_prob > _NO_SPEECH_PROB or not s.text.strip():
                continue  # 静音段幻觉过滤：no_speech 概率高或空文本不收
            job["segments"].append({"start": round(s.start, 3),
                                    "end": round(s.end, 3),
                                    "text": s.text.strip()})
            added += 1
    job["coverage"] = sorted(coverage + [[a, b] for a, b in holes])
    if added:
        log.info("ASR 任务 %s 空洞补转出 %d 段", job["id"], added)


def _download_hook(job):
    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                job["progress"]["download"] = round(
                    d.get("downloaded_bytes", 0) / total * 100)
    return hook


def _find_tmp(tmpdir, job_id):
    """兜底：requested_downloads 缺 filepath 时按 id 前缀在临时目录定位。"""
    for name in sorted(os.listdir(tmpdir)):
        if name.startswith(job_id):
            return os.path.join(tmpdir, name)
    return None


# ---- 缓存（条目格式兼容 api/asr.py 的 multipart 缓存，管理界面可见） ----


def _cache_enabled():
    return (config.load().get("asr") or {}).get("cache", True)


def _norm_url(url):
    """第439次：URL 归一化——剥离跟踪/会话参数，只留视频身份做缓存 key。

    背景：B 站 URL 带 trackid（毫秒时间戳，每次不同）/spm_id_from/vd_source，
    整 URL SHA 作 key 缓存永不命中，同视频反复全量转写。规则（对齐扩展端
    makeVideoKey 语义）：B 站路径已含 BV/av/ep/ss 号，query 只保留 p（分 P）
    与 cid（合集定位）；YouTube watch 保留 v（youtu.be 短链取路径）；
    其余站点去 query+fragment 只留 host+path。路径尾部斜杠归一。
    """
    parts = urlsplit(url)
    host = parts.netloc.lower()
    qs = dict(parse_qsl(parts.query, keep_blank_values=True))
    keep, path = {}, parts.path.rstrip("/") or "/"
    if host.endswith("bilibili.com"):
        keep = {k: qs[k] for k in ("p", "cid") if k in qs}
    elif host.endswith("youtube.com"):
        if "v" in qs:
            keep = {"v": qs["v"]}
            path = "/watch"
    elif host.endswith("youtu.be"):
        pass  # 短链视频 id 即路径
    norm = host + path + (("?" + urlencode(keep)) if keep else "")
    return norm


def _cache_key(url):
    """缓存 key 为 site-vid slug（第440次引入；第441次用户裁定「你过虑了，
    ytdl有现成方案就用他的命名规则」——上半场的域名前缀/`--` collapse
    方案作废，回站点名形态）：文件名可读、视频号在文件名里可双向反查
    （slug 拼回站点 URL 即得视频页），取代整串 SHA（不可读不可反查）。
    命名与 yt-dlp make_archive_id（f'{ie_key.lower()} {video_id}'，B 站即
    bilibili BVxx）同规则，仅分隔符按文件名场景用 `-`。旧条目自然失效
    （孤儿文件管理页可见可清）。

    B 站：bilibili-BVxx[-pN][-cidN]（视频号 + 分 P 与合集定位，对齐
    makeVideoKey 语义；www./m. 子域与 b23.tv 展开后同归 bilibili，
    b23.tv 展开失败降级短码走通用分支）；YouTube：youtube-<v>（watch
    的 v 参数，shorts/embed 同取；youtu.be 短链 vid 即路径、归 youtube
    保同 key 命中）；其余站点：host（剥 www）+ path 安全化截断 +
    归一化 SHA 前 8 位防撞（非身份 slug，防不同页同名互覆）。
    """
    parts = urlsplit(url)
    host = parts.netloc.lower()
    if host.endswith("b23.tv"):
        try:
            url = bili_api.expand_short(url)
        except Exception as e:  # 展开失败：key 降级短码，不阻塞任务创建
            log.warning("b23.tv 短链展开失败，缓存 key 降级用短码：%s",
                        str(e)[:150])
        parts = urlsplit(url)
        host = parts.netloc.lower()
    qs = dict(parse_qsl(parts.query, keep_blank_values=True))
    if host.endswith("bilibili.com"):
        m = (re.search(r"/video/(BV[0-9A-Za-z]{10})", parts.path)
             or re.search(r"/video/(av\d+)", parts.path, re.IGNORECASE)
             or re.search(r"/bangumi/play/((?:ep|ss)\d+)", parts.path))
        if m:
            slug = "bilibili-" + m.group(1)
            if qs.get("p"):
                slug += "-p" + re.sub(r"\W", "", qs["p"], flags=re.ASCII)
            if qs.get("cid"):
                slug += "-cid" + re.sub(r"\W", "", qs["cid"], flags=re.ASCII)
            return slug
    elif host.endswith("youtube.com"):
        if qs.get("v"):
            return "youtube-" + qs["v"]
        m = re.search(r"/(?:shorts|embed|live)/([A-Za-z0-9_-]{5,})", parts.path)
        if m:
            return "youtube-" + m.group(1)
    elif host.endswith("youtu.be"):
        v = parts.path.lstrip("/").split("/")[0]
        if v:
            return "youtube-" + v  # 短域归 youtube：同视频同 key
    # 通用站点：host（剥 www）+ path 安全化截断 + 归一化 SHA8 防撞后缀
    norm = _norm_url(url)
    h = host[4:] if host.startswith("www.") else host
    p_seg = re.sub(r"[^A-Za-z0-9_-]", "_", unquote(parts.path)).strip("_-")[:60]
    return f"{h}-{p_seg or 'root'}-{hashlib.sha256(norm.encode('utf-8')).hexdigest()[:8]}"


def _cache_get_key(key, language):
    """按现成 key 读缓存（第409次：文件任务用内容 SHA-256 做 key）。"""
    try:
        with open(os.path.join(ASR_CACHE_DIR, _safe_key(key) + ".json"),
                  "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if data.get("engine") not in ("faster-whisper", "official"):
        return None  # 引擎不同不复用（同 api 层语义）；official=官方字幕直出（第437次）
    if language and data.get("req_language") != language:
        return None
    if not data.get("segments"):
        return None  # 无时间戳的旧条目（如 qwen 写的）对 job 无用
    return data


def _cache_put(job, video_id):
    # 第440次：key 在 create() 时一次算好存 job["cache_key"]（b23.tv 短链
    #   只展开一次），写侧不再重复 _cache_key。
    _cache_put_key(job["cache_key"], job, video_id)


def _cache_put_official(job, video_id):
    """官方字幕直出条目（第437次方案A）：engine=official 如实标注来源，
    读侧 _cache_get_key 同样放行——下次同 URL 秒级命中。"""
    _cache_put_key(job["cache_key"], job, video_id, engine="official")


def _cache_put_key(key, job, video_id=None, engine="faster-whisper"):
    entry = {
        "key": key,
        "video_id": video_id,
        "engine": engine,
        "req_language": job["language"],
        "ts": int(time.time()),
        # 第440次：条目去 text（唯一消费方管理页 preview 改从 segments 拼，
        #   api/asr.py 同步）；加 duration 真实解码时长（命中恢复、快照透出）。
        "duration": job.get("duration"),
        "language": job["detected_language"],
        # 第436次：缓存条目段按 start 排序（whisper 幻觉期可能产出时间戳紊乱段）。
        #   只排条目副本、不动 job["segments"] 本体——轮询协议按追加序切片
        #   segs[after:]，完成时重排本体会使已发游标与切片错位（漏段/重复段）。
        "segments": sorted(job["segments"], key=lambda s: s.get("start", 0)),
        # 第439次：覆盖区间真值随条目保存（覆盖维度，独立于 segments）；
        #   命中任务恢复 coverage，扩展端据此精确算覆盖率决定是否续识别。
        "coverage": job.get("coverage") or None,
    }
    os.makedirs(ASR_CACHE_DIR, exist_ok=True)
    path = os.path.join(ASR_CACHE_DIR, _safe_key(key) + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(entry, f, ensure_ascii=False)
