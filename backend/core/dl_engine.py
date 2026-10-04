"""直链并行分块下载引擎：CDN 镜像探测择优 + 多线程 Range 分块 + 断点续传。

第515次自 core/ytdl.py 迁出（ytdl.py 逼近千行上限，第438次引入的并行下载
经第448次推广已是管理页与 ASR 下载主路，引擎独立成模块；ytdl.py re-export
parallel_download 保持 asr_job/bili_api 既有导入不变），并补齐断点续传
（第515次，调研裁定不引 aria2c 后自研补齐——Persepolis 5.x 弃 aria2 改
纯 Python Range 下载同路数）：

- 控制文件断点续传：<dest>.dlstate（JSON）记录分块完成位图，每完成一块
  原子落盘；续传时校验响应未变（Content-Range 全长 + chunk 公式一致 +
  ETag/Last-Modified 两侧均有值时相等 + 半成品存在且大小=total），任一
  不符作废重来（内容变了续传即写坏文件）。块级粒度（块≥1MB），块内
  半截不落位图（重下一块，开销可忽略）。
- 整周期重试：块内重试耗尽上抛后，换一轮重新探测镜像（坏节点淘汰换池）
  并从已完成块续传，_CYCLES 轮耗尽才清理半成品返回 False——调用方回退
  yt-dlp 原生下载的语义与第438次一致（半成品必须清，防 yt-dlp 同路径
  误判「已下载」跳过）。

不引入 aria2c 的调研裁定（第448次保留）：直链多连接价值本模块已覆盖，
aria2c 进度回调仅完成一次（管理页进度条跳变）且部分流反而变慢
（yt-dlp#7962），非 Windows 官方无预编译包（业界统一 brew/apt 自装）。

镜像策略与 downkyi（Aria2 多线程）/BBDown（默认多线程 + upos host 替换）
同源：B 站 upos CDN 签名与 host 无关，同 path+query 换 host 即换 CDN 池，
并发探测谁快用谁（坏候选 403/断连自动淘汰）。纯标准库零新依赖。
"""

import json
import logging
import os
import threading
import time
import urllib.parse
import urllib.request

log = logging.getLogger(__name__)

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

# 整周期重试上限：每轮重新探测镜像并按控制文件续传（已完成块不重下），
# 首轮读到历史控制文件（前次调用中断遗留）同样续传。耗尽才清理半成品。
_CYCLES = 3

# 断点续传控制文件后缀：<dest>.dlstate（JSON：total/chunk/etag/
# last_modified/done 位图/done_bytes），与半成品同目录同生命周期，
# 成功或最终失败即删（不留残骸）。
_STATE_SUFFIX = ".dlstate"


def parallel_download(url, dest_path, headers, progress_cb=None):
    """直链并行分块下载：CDN 测速择优 + 多线程 Range 分块落盘 + 断点续传。

    url 必须是 http(s) 直链；headers 请求头（调用方合并 yt-dlp format 专属
    头与全局兜底）；progress_cb(pct) 可选（0-100 int，按全局完成字节计，
    续传后不回跳）。B 站 upos 链接自动扩展镜像候选并发探测选最快节点，
    其余站点仅探测原链。返回 True 完整落盘；False 不适合直链或 _CYCLES
    轮重试耗尽（半成品与控制文件已清），调用方回退 yt-dlp。
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
        for cycle in range(1, _CYCLES + 1):
            try:
                best = _probe_fastest(candidates, head)
                if best is None:
                    return False
                best_url, total, etag, last_modified = best
                if not total:  # 拿不到全长（无 Content-Range）：单线程流式兜底
                    _drop_state(dest_path)  # 流式无续传，历史控制文件作废
                    return _stream_download(best_url, dest_path, head,
                                            progress_cb)
                state = _load_state(dest_path, total, etag, last_modified)
                if state is None:  # 无历史或校验不符：全新下载
                    chunk = _chunk_size(total)
                    state = {"idx": 0, "total": total, "chunk": chunk,
                             "done_bytes": 0,
                             "done": [False] * -(-total // chunk),
                             "etag": None, "last_modified": None}
                # 首次探测到的内容指纹记入状态，供后续轮次/调用校验
                state["etag"] = state.get("etag") or etag
                state["last_modified"] = (state.get("last_modified")
                                          or last_modified)
                _download_chunks(best_url, total, dest_path, head, state,
                                 progress_cb)
                _drop_state(dest_path)
                return True
            except Exception as e:
                log.warning("parallel_download 第%d/%d轮失败（%s）", cycle,
                            _CYCLES, str(e)[:200])
        log.warning("parallel_download 重试耗尽（%d 轮），清理半成品回退",
                    _CYCLES)
        _cleanup(dest_path)
        return False
    except Exception as e:  # 网络/构造候选等意外：如实记录后回退
        log.warning("parallel_download 失败（%s），调用方回退 yt-dlp",
                    str(e)[:200])
        _cleanup(dest_path)  # 半成品必须清掉，防回退路 yt-dlp 误判已完成
        return False


def _probe_fastest(candidates, headers, probe_bytes=1024 * 1024, timeout=3.0):
    """并发小段 Range 探测：按「字节/耗时」选最快候选。

    探测段取 1MB：B 站烂节点有「短段快、持续烂」的 QoS 特征（实测 256KB
    短段测不出，2MB 持续拉速仅 40KB/s 的节点短段可到 170KB/s），段太短
    会误选原链。返回 (url, total, etag, last_modified)：total 取
    Content-Range 尾数（206）或 Content-Length（200，服务端不支持 Range），
    拿不到为 None；etag/last_modified 响应头原样（可能为 None），供断点
    续传校验内容未变。全部候选零数据返回 None。

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
                    results.append((speed, u, total,
                                    r.headers.get("ETag"),
                                    r.headers.get("Last-Modified")))
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
    for speed, u, _t, _e, _lm in results:
        log.info("probe %s: %.2f MB/s", urllib.parse.urlparse(u).hostname,
                 speed / 1e6)
    if len(candidates) > 1 and len(results) > 1:
        origin_host = urllib.parse.urlparse(candidates[0]).hostname or ""
        alts = [r for r in results
                if (urllib.parse.urlparse(r[1]).hostname or "") != origin_host]
        if alts:
            return alts[0][1], alts[0][2], alts[0][3], alts[0][4]
    return results[0][1], results[0][2], results[0][3], results[0][4]


def _chunk_size(total, workers=16):
    """分块大小：块数≈workers*4 内动态收缩（续传校验复用同一公式——块大小
    变了旧位图索引即失效，必须作废）。"""
    return max(_CHUNK_MIN, -(-total // (workers * 4)))


def _load_state(dest_path, total, etag, last_modified):
    """读控制文件续传：响应与落盘时一致才返回续传状态，否则 None 作废。

    一致性 = total 相等 + chunk 公式一致 + ETag/Last-Modified 两侧均有值
    时相等（B 站镜像池同内容换 host，单侧缺失不苛责）+ 半成品存在且大小
    =total（预分配尺寸）。done 位图长度与分块数不符即作废；done_bytes 由
    位图重算，不信任落盘值。
    """
    try:
        with open(dest_path + _STATE_SUFFIX, "r", encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        return None
    chunk = _chunk_size(total)
    ranges_n = -(-total // chunk)
    done = st.get("done")
    if (st.get("total") != total or st.get("chunk") != chunk
            or not isinstance(done, list) or len(done) != ranges_n
            or not all(isinstance(d, bool) for d in done)):
        return None
    if st.get("etag") and etag and st["etag"] != etag:
        return None
    if st.get("last_modified") and last_modified \
            and st["last_modified"] != last_modified:
        return None
    if not os.path.isfile(dest_path) or os.path.getsize(dest_path) != total:
        return None
    done_bytes = sum(min(chunk, total - i * chunk)
                     for i, d in enumerate(done) if d)
    return {"idx": 0, "total": total, "chunk": chunk, "done": done,
            "done_bytes": done_bytes, "etag": st.get("etag"),
            "last_modified": st.get("last_modified")}


def _save_state(dest_path, state):
    """控制文件原子落盘（tmp + os.replace）：每完成一块调用（持锁内）。
    total/chunk/etag 随位图一并落盘，供 _load_state 校验内容一致性。
    失败静默——续传只是加速，落盘失败退化为本次调用内无断点（内存位图
    仍在，整周期重试不受影响）。"""
    try:
        tmp = dest_path + _STATE_SUFFIX + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"total": state["total"], "chunk": state["chunk"],
                       "etag": state["etag"],
                       "last_modified": state["last_modified"],
                       "done": state["done"],
                       "done_bytes": state["done_bytes"]}, f)
        os.replace(tmp, dest_path + _STATE_SUFFIX)
    except OSError:
        pass


def _drop_state(dest_path):
    try:
        os.remove(dest_path + _STATE_SUFFIX)
    except OSError:
        pass


def _cleanup(dest_path):
    """最终失败收场：半成品与控制文件全清（yt-dlp 回退同路径写文件，
    残留会被误判「已下载」跳过）。"""
    for p in (dest_path, dest_path + _STATE_SUFFIX):
        try:
            os.remove(p)
        except OSError:
            pass


def _download_chunks(url, total, dest_path, headers, state,
                     progress_cb=None, workers=16, retries=3):
    """多线程 Range 分块下载：预分配文件，线程池动态领块（首个异常全局收工）。

    state["done"] 位图有已完成块即为续传：半成品以 r+b 打开续写（全新为
    wb + truncate 预分配），已完成块直接跳过。每线程独立文件句柄 seek 写
    各自偏移（Windows 无 os.pwrite）；块读取字节不精确即失败重试，重试
    耗尽上抛由 parallel_download 换镜像续传重试。每完成一块控制文件落盘
    （断点粒度=块），进度按全局完成字节计（续传不回跳）。
    """
    chunk = _chunk_size(total)
    ranges = [(off, min(off + chunk, total) - 1)
              for off in range(0, total, chunk)]
    fresh = not any(state["done"])
    with open(dest_path, "wb" if fresh else "r+b") as f:
        f.truncate(total)
    lock = threading.Lock()
    err_box = {"err": None}

    def worker():
        try:
            with open(dest_path, "r+b") as f:
                while True:
                    with lock:
                        if err_box["err"]:
                            return
                        while state["idx"] < len(ranges) \
                                and state["done"][state["idx"]]:  # 跳过已完成块
                            state["idx"] += 1
                        if state["idx"] >= len(ranges):
                            return
                        a, b = ranges[state["idx"]]
                        state["idx"] += 1
                    data = _fetch_range(url, headers, a, b, retries)
                    f.seek(a)
                    f.write(data)
                    with lock:
                        state["done"][a // chunk] = True
                        state["done_bytes"] += len(data)  # 块完成无序，防进度跳动
                        if progress_cb:
                            progress_cb(state["done_bytes"] * 100 // total)
                        _save_state(dest_path, state)
        except Exception as e:
            with lock:
                err_box["err"] = err_box["err"] or e

    ts = [threading.Thread(target=worker, daemon=True)
          for _ in range(min(workers, len(ranges)))]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    if err_box["err"]:
        raise err_box["err"]


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
