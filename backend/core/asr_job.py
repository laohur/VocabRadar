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
- 下载复用 core/ytdl 的 yt-dlp 基础（_import_yt_dlp/_ensure_ffmpeg/_base_opts，
  固定 m4a 串原生流，PyAV 直解）。产物落进程临时目录，转写完成即删——音频
  只是中间产物，缓存只存 JSON 不存音频。
- 并发：全局信号量 1——CPU 转写单路即饱和，同刻只放行一个任务，其余停在
  queued 排队。任务表同 core/ytdl：内存态，进程重启即清，无持久化。
- 缓存：读写在本模块（任务生命周期内：创建时查、转写完写；api 层 multipart
  的缓存读写仍归 api/asr.py）。条目格式与现有缓存兼容（ASR_CACHE_DIR，管理
  界面 cache_list 可见）。key = URL 的 SHA-256 前 16 位；命中校验引擎与请求
  语言（同 api 层语义）。
"""

import hashlib
import json
import logging
import os
import shutil
import tempfile
import threading
import time
import uuid

import config
from core.asr import ASR_CACHE_DIR, _safe_key
from core.ytdl import _base_opts, _ensure_ffmpeg, _import_yt_dlp

log = logging.getLogger(__name__)

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
    hit = _cache_get(url, language)
    job = _new_job(language, asr_engine, hit)
    job["url"] = url
    with _lock:
        _jobs[job["id"]] = job
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
        "duration": None,
        "detected_language": None,
        "segments": list(hit["segments"]) if hit else [],
        "text": (hit or {}).get("text", ""),
        "error": None,
        "cached": bool(hit),
        "created_at": int(time.time()),
        "finished_at": None,
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


def _run_url(job, asr_engine):
    with _run_sem:  # 排队：前面的任务跑完才进入下载
        _pipeline_url(job, asr_engine)


def _run_file(job, asr_engine):
    with _run_sem:  # 文件任务与 URL 任务共用单路信号量
        _pipeline_file(job, asr_engine)


def _pipeline_url(job, asr_engine):
    yt_dlp = _import_yt_dlp()
    _ensure_ffmpeg()  # 就绪保障：HLS/分段流站点需要（缺失不阻塞原生流下载）
    tmpdir = tempfile.mkdtemp(prefix="asrjob_")
    try:
        job["status"] = "downloading"
        # opts 构造含 cookiefile 配置校验，放 try 内统一记 job.error
        opts = _base_opts(None)  # 默认 m4a 串：ASR 用途原生流，PyAV 直解
        opts["outtmpl"] = os.path.join(tmpdir, f"{job['id']}.%(ext)s")
        opts["progress_hooks"] = [_download_hook(job)]
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(job["url"], download=True)
        if info.get("_type") == "playlist":  # 防御：noplaylist 之外的入口形态
            info = (info.get("entries") or [{}])[0]
        job["title"] = info.get("title")
        job["duration"] = info.get("duration")
        # requested_downloads[0].filepath 是最终产物路径（同 core/ytdl 取法）
        rd = (info.get("requested_downloads") or [{}])[0]
        audio_path = rd.get("filepath") or _find_tmp(tmpdir, job["id"])
        if not audio_path:
            raise RuntimeError("下载产物未定位到文件")
        _transcribe(job, asr_engine, audio_path, video_id=info.get("id"))
    except Exception as e:  # yt-dlp/模型/解码异常类型庞杂，统一兜底记任务
        job["status"] = "failed"
        job["error"] = str(e)[:300]
        log.error("ASR 任务 %s（URL 源）失败：%s", job["id"], job["error"])
    finally:
        job["finished_at"] = int(time.time())
        shutil.rmtree(tmpdir, ignore_errors=True)


def _pipeline_file(job, asr_engine):
    """上传文件管线（第409次）：无下载段，直接转写；结束回收临时文件。"""
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
    """转写共用段（URL/文件两源）：逐段消费生成器、增量可见、完成写缓存。"""
    job["status"] = "transcribing"
    model, _ = asr_engine.ensure_loaded("faster-whisper")
    segs_iter, tinfo = model.transcribe(audio_path,
                                        language=job["language"] or None)
    job["detected_language"] = tinfo.language
    total = tinfo.duration or job["duration"]
    texts = []
    for s in segs_iter:  # 生成器：识别一段、追加一段，轮询端即刻可见
        seg = {"start": round(s.start, 3), "end": round(s.end, 3),
               "text": s.text.strip()}
        job["segments"].append(seg)
        texts.append(seg["text"])
        if total:  # 转写进度 = 已识别到的音频位置 / 总时长
            job["progress"]["transcribe"] = round(s.end / total * 100)
    job["text"] = " ".join(t for t in texts if t)
    if _cache_enabled():
        if job.get("source") == "file":
            _cache_put_key(job.get("cache_key"), job)
        else:
            _cache_put(job, video_id)
    job["status"] = "completed"
    log.info("ASR 任务 %s 转写完成：%d 段（%s）",
             job["id"], len(job["segments"]), job["detected_language"])


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


def _cache_key(url):
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]


def _cache_get(url, language):
    return _cache_get_key(_cache_key(url), language)


def _cache_get_key(key, language):
    """按现成 key 读缓存（第409次：文件任务用内容 SHA-256 做 key）。"""
    try:
        with open(os.path.join(ASR_CACHE_DIR, _safe_key(key) + ".json"),
                  "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if data.get("engine") != "faster-whisper":  # 引擎不同不复用（同 api 层语义）
        return None
    if language and data.get("req_language") != language:
        return None
    if not data.get("segments"):
        return None  # 无时间戳的旧条目（如 qwen 写的）对 job 无用
    return data


def _cache_put(job, video_id):
    _cache_put_key(_cache_key(job["url"]), job, video_id)


def _cache_put_key(key, job, video_id=None):
    entry = {
        "key": key,
        "video_id": video_id,
        "engine": "faster-whisper",
        "req_language": job["language"],
        "ts": int(time.time()),
        "text": job["text"],
        "language": job["detected_language"],
        "segments": job["segments"],
    }
    os.makedirs(ASR_CACHE_DIR, exist_ok=True)
    path = os.path.join(ASR_CACHE_DIR, _safe_key(key) + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(entry, f, ensure_ascii=False)
