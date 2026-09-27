// ASR 客户端：content script 侧调用。
// 第398次（plan-backend 阶段三2，用户裁定）：扩展内音频下载管线（B站 fMP4 流式
//   下载/解码、YouTube 取流、录音 Blob）全退役——音频下载统一靠 backend yt-dlp，
//   转写统一靠 backend faster-whisper，端到端任务式转写。
//   体验仍是「边出字幕」：下载一段、识别一段、返回一段，不等全部完成
//   （用户裁定原文），扩展侧定时轮询增量取段，段带绝对时间戳。
//
// === 双路径架构 ===
//
// 路径 A — backend job（主路径）：
//   1. ASR_JOB_SUBMIT（SW 代理；content script 受页面 CSP 不能直连 backend）
//      提交页面 URL → {id, status, cached}
//   2. 定时 ASR_JOB_POLL（after 游标递增）→ status/progress{download,transcribe}
//      + segments[{start,end,text}]（绝对视频秒）+ segments_total
//   3. 段直接 _onText + 入缓存（listen 窗口 = 上一段终点→本段终点，静音间隙
//      折入监听窗口）；
//      _recogFrontier 按段 end 推进（播放闸门遥测，playback-gate 默认停用）
//   4. 轮询失败不收场：只记日志，继续固定轮询（识别多少送多少，backend 恢复
//      自然接续）；job 丢失（backend 重启致内存任务表清空，404）→ 重提同 URL
//      接续（结果缓存落盘固定键，重提命中即接续；已收段按 start|end|text 去重
//      防重复上屏）；重提失败或任务 failed → stopASR + onError；
//      提交失败 → stopASR + 抛错（如实报错引导启动 backend）
// 第399次（用户裁定）：captureStream 实时识别回退（asr-fallback-capture.js）删除——
//   backend 是唯一路径，不再静默兜底。
//
// === 时间戳 ===
//   job 段：backend 直出绝对视频秒，无需转换。
//
// === 覆盖（第439次，两维度规定）===
//   覆盖时间（coverage）与识别结果时间（segment start/end）是两个维度，
//   禁止混用。backend 轮询响应带 coverage=[[a,b],...]（VAD 送识别的音频
//   区间秒值数组，含空洞补转后并入的区间），随缓存条目保存；
//   getASRCoverage 优先用后端真值精确计算，旧缓存无 coverage 时回退
//   listenStart/listenEnd 推断。
//
// === 缓存 ===
//   增量缓存：{segments:[{listenStart,listenEnd,speechStart,speechEnd,
//   text,chunks}], totalListened, modelSize}，累积超 asrCacheSegmentSec 写 storage，
//   按产出模型失效（第八十九次）。

// === 模块状态 ===
// 反思（2026-07-06）：_debug 标志（config.json 读取），仅 debug=true 时打印状态日志。
let _debug = false;
let _onText = null;
let _onError = null;
let _onStatus = null;
let _currentVideoKey = null;
let _running = false;

// === 配置 ===
let _cacheSegmentSec = 60;          // 缓存分段长度（秒），config asrCacheSegmentSec。控制缓存写入粒度
let _cacheAsr = false;              // 是否缓存 ASR 结果

// === 播放闸门状态（第九十六次引入；现仅作遥测——playback-gate._gateEnabled=false 停用）===
// _recogFrontier = 已识别终点（视频秒）；-1 = 尚未建立（闸门不生效）。
let _recogFrontier = -1;
let _recogDoneAll = false;         // 全部段识别完成 → 闸门解除

// === backend job 轮询状态（路径 A）===
const JOB_POLL_MS = 5000;          // 定时轮询间隔（第441次用户裁定 5s；定时轮询增量返回）
let _jobId = null;                 // backend 任务 id
let _jobAfter = 0;                 // 游标：已取到的段数（backend 按 after 切片）
let _jobTimer = null;              // setInterval id
let _jobFailStreak = 0;            // 连续轮询失败计数（仅日志展示，不影响轮询）
let _jobBusy = false;              // in-flight 守卫：上一轮未返回时不重入（防响应乱序）
let _jobListenEnd = 0;             // 已入缓存的监听窗口终点（秒）——job 段静音间隙折入窗口用
let _jobSeenSegs = new Set();      // 已收段键（start|end|text）——job 重提后 backend 从头重发已收段，去重防重复上屏

// === ASR 缓存（增量识别）===
// 缓存格式 {segments:[{listenStart,listenEnd,speechStart,speechEnd,text,chunks}],
// totalListened}，不清缓存，累计超 _cacheSegmentSec 阈值写入 storage。
let _cache = null;                  // startASR 时加载
let _lastSavedTotalListened = 0;    // 上次写入 storage 时的 totalListened（阈值判断）
// 反思（2026-08-21 第八十九次）：当前 ASR 模型（loadSegmentConfig 从 storage 读取）。
//   缓存记录产出模型；模型变更后旧缓存整体失效（用户："切换了asr模型，识别依旧用旧的"）。
let _currentModelSize = 'large-v3-turbo';  // 第419次：默认档 tiny → large-v3-turbo

// 时间戳辅助：所有日志带 HH:MM:SS.mmm 便于诊断时序问题
function _ts() {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/**
 * 启动 ASR 识别（backend job 单路径，第399次回退删除）
 * 提交页面 URL 给 backend，定时轮询增量取段。
 * @param {{videoKey:string, videoElement:HTMLVideoElement, onText?:(seg)=>void, onError?:(err)=>void, onStatus?:(s)=>void, skipReplay?:boolean}} opts
 *   skipReplay=true 时跳过 replayCachedSegsFromCache（用于缓存已由 sidebar.loadASRCacheIfAny 预加载到面板的场景，
 *   避免重复回放导致字幕重复）。反思（2026-07-08）：用户批评「谁给你的胆子清空asr结果的！那还要缓存干啥！」，
 *   有缓存时点ASR应接续不清空。
 * @returns {Promise<() => void>} unsubscribe 函数（停止 ASR + 移除监听）
 */
export async function startASR(opts) {
  _onText = opts.onText || null;
  _onError = opts.onError || null;
  _onStatus = opts.onStatus || null;
  _currentVideoKey = opts.videoKey || '';
  const skipReplay = !!opts.skipReplay;
  console.log('[VocabRadar][asr-client][' + _ts() + '] startASR videoKey=', _currentVideoKey, 'cacheAsr=', _cacheAsr, 'skipReplay=', skipReplay);
  const videoEl = opts.videoElement;

  if (!videoEl) {
    throw new Error('startASR: videoElement is required');
  }

  // 加载配置
  await loadSegmentConfig();

  // 缓存控制（增量识别，两路共用）
  // 反思（2026-07-09）：旧版每次 startASR 都 clearASRCache + 从头全量识别，缓存形同虚设。
  //   新设计：cacheAsr=true 时加载缓存到 _cache（不清除），skipReplay=false 时回放已缓存段。
  if (!_cacheAsr) {
    await clearASRCache(_currentVideoKey);
    _cache = { segments: [], totalListened: 0 };
    _lastSavedTotalListened = 0;
  } else {
    _cache = await loadCache(_currentVideoKey);
    _lastSavedTotalListened = _cache.totalListened;
    if (!skipReplay && _cache.segments.length > 0) {
      replayCachedSegsFromCache(_cache, _onText);
    }
  }

  _running = true;
  _recogFrontier = -1;
  _recogDoneAll = false;
  _jobSeenSegs = new Set();        // 新会话重建已收段表（防跨会话误去重）

  // job 提交（SW 代理 POST /api/asr/jobs，提交页面 URL——backend yt-dlp 自取音频）。
  // 第399次用户裁定：回退路径删除，提交失败如实报错（引导启动 backend），不再静默兜底。
  const submit = await sendMessage({ type: 'ASR_JOB_SUBMIT', url: location.href });
  if (!(submit && submit.ok && submit.id)) {
    const reason = (submit && submit.error) || 'no response';
    console.warn('[VocabRadar][asr-client][' + _ts() + '] backend job 提交失败:', reason);
    stopASR();
    const err = new Error('backend 不可用（' + reason + '）：请先启动本地 backend 再使用 ASR');
    err.code = 'BACKEND_UNAVAILABLE';
    throw err;
  }
  pushStatusLocal('job-submitted', 'job ' + submit.id + (submit.cached ? ' (cache hit)' : ''), { jobId: submit.id });
  startJobPolling(submit.id);

  // 返回 unsubscribe
  return () => {
    stopASR();
  };
}

// === backend job 轮询（路径 A 主循环）===

/** 启动定时轮询：立即首轮（缓存命中时首轮即拿全量段）+ 每 JOB_POLL_MS 一次 */
function startJobPolling(jobId) {
  _jobId = jobId;
  _jobAfter = 0;
  _jobListenEnd = 0;
  _jobFailStreak = 0;
  _jobBusy = false; // 清守卫：防上次会话遗留的挂起轮询阻塞新会话
  _jobTimer = setInterval(pollJobOnce, JOB_POLL_MS);
  pollJobOnce();
}

function stopJobPolling() {
  if (_jobTimer) { clearInterval(_jobTimer); _jobTimer = null; }
  _jobId = null;
  _jobAfter = 0;
  _jobListenEnd = 0;
  _jobFailStreak = 0;
}

/** 单次轮询入口：in-flight 守卫——上一轮未返回时跳过本轮，防响应乱序重入 */
async function pollJobOnce() {
  if (_jobBusy) return;
  _jobBusy = true;
  try {
    await pollJobOnceInner();
  } finally {
    _jobBusy = false;
  }
}

/** 单次轮询主体：增量取段 → 直出字幕 + 入缓存 + 推进闸门遥测；进度入状态时间线 */
async function pollJobOnceInner() {
  if (!_running || !_jobId) return;
  const resp = await sendMessage({ type: 'ASR_JOB_POLL', id: _jobId, after: _jobAfter });
  if (!_running) return; // 轮询期间 stopASR → 丢弃响应
  if (!resp || !resp.ok) {
    const errMsg = (resp && resp.error) || 'no response';
    // 404 = backend 重启丢内存任务表（job id 随机 uuid 不落盘）。结果缓存落盘
    //   且 key 固定（site-vid slug）→ 重提同 URL 可接续：命中缓存即建"已完成"
    //   任务首轮拿全量段，未命中重头转写；已收段由 _jobSeenSegs 去重不重复上屏。
    if (errMsg === 'not_found') {
      await resubmitJobAfter404();
      return;
    }
    // 其余失败（backend 失联/网络抖动）不收场（用户裁定"轮询后台，识别多少
    //   送多少；失败就说失败"）：只记日志与状态时间线，继续固定间隔轮询，
    //   backend 恢复后自然接续
    _jobFailStreak++;
    console.warn('[VocabRadar][asr-client][' + _ts() + '] job 轮询失败(' + _jobFailStreak + '):', errMsg);
    pushStatusLocal('job-poll-fail', 'poll ' + _jobFailStreak + ' failed: ' + errMsg);
    return;
  }
  _jobFailStreak = 0;

  // 第439次：backend 下发覆盖真值（coverage=[[a,b],...]，VAD 送识别区间，
  //   含空洞补转并入）——覆盖维度独立于 segments，随缓存条目保存，
  //   getASRCoverage 据此精确算覆盖率。整体替换，不与段数据混算。
  if (Array.isArray(resp.coverage) && resp.coverage.length > 0 && _cache) {
    _cache.coverage = resp.coverage;
  }

  // 增量段（绝对时间戳）：直出字幕 + 入缓存（静音间隙折入监听窗口）+ 推进前沿
  const segs = Array.isArray(resp.segments) ? resp.segments : [];
  // 第436次（用户报障"后端转写字幕并不总是按照时间顺序"）：batch 内按 start 排序
  //   再直出——whisper 幻觉期可能产出时间戳紊乱段，到达序未必等于时间序；
  //   下游 appendASRSubtitle 二分插入按 start，入参有序才能保证数组与 DOM 全程有序。
  if (segs.length > 1) {
    segs.sort((a, b) => ((a.start || 0) - (b.start || 0)));
  }
  if (segs.length > 0) {
    _jobAfter += segs.length;
    const batch = [];
    let batchEnd = _jobListenEnd;
    for (const s of segs) {
      const text = (s.text || '').trim();
      const end = (typeof s.end === 'number') ? s.end : 0;
      // 段去重：404 重提后 backend 从头重发已收段（缓存命中全量/重转写复现），
      //   按 start|end|text 过滤，防止重复上屏与重复入缓存
      const segKey = (s.start || 0) + '|' + end + '|' + text;
      if (_jobSeenSegs.has(segKey)) continue;
      _jobSeenSegs.add(segKey);
      if (text && end > batchEnd) batchEnd = end;
      batch.push({ start: s.start, end, text });
    }
    // 第437次：msgStart 改用本批最小 start（batch 已按 start 排序，取 batch[0]），
    //   不再用 _jobListenEnd——后者只增不减，幻觉段把窗口推后后，后续正常段的
    //   timestamp 全被 Math.max(0,·) 钳 0，mergeOrAddSegment 反算绝对时间堆错
    //   （缓存回放时间戳错乱的根因）。batchEnd/_jobListenEnd 闸门语义不变。
    const msgStart = batch.length > 0 ? (batch[0].start || 0) : _jobListenEnd;
    _jobListenEnd = Math.max(_jobListenEnd, batchEnd);
    for (const seg of batch) {
      if (!seg.text) continue;
      if (_onText) { try { _onText({ start: seg.start, end: seg.end, text: seg.text }); } catch (e) { /* ignore */ } }
    }
    if (_cacheAsr && _cache && batchEnd > msgStart) {
      // 构造 mergeOrAddSegment 期望的消息形态：listen 窗口 [msgStart, batchEnd]；
      // chunks 用 timestamp 数组（相对 msgStart，与 offscreen 段同构）保留精确说话时间
      mergeOrAddSegment(_cache, {
        start: msgStart,
        end: batchEnd,
        text: batch.map((s) => s.text).filter(Boolean).join(' '),
        chunks: batch.filter((s) => s.text).map((s) => ({
          timestamp: [Math.max(0, s.start - msgStart), Math.max(0, s.end - msgStart)],
          text: s.text
        }))
      });
      if (_cache.totalListened - _lastSavedTotalListened >= _cacheSegmentSec) {
        _lastSavedTotalListened = _cache.totalListened;
        saveCache(_currentVideoKey, _cache);
      }
    }
    if (batchEnd > _recogFrontier) _recogFrontier = batchEnd;
    pushStatusLocal('gate', 'job +' + batch.length + ' segs', { frontier: _recogFrontier });
  }

  // 进度遥测：backend progress{download,transcribe}（百分比）→ 状态时间线
  const prog = resp.progress || {};
  if (resp.status === 'queued') {
    pushStatusLocal('job-queued', 'waiting backend worker', { jobId: _jobId });
  } else if (resp.status === 'downloading') {
    pushStatusLocal('job-download', 'DL ' + (prog.download ?? 0) + '%', { jobId: _jobId });
  } else if (resp.status === 'transcribing') {
    pushStatusLocal('job-transcribe', 'ASR ' + (prog.transcribe ?? 0) + '%', { jobId: _jobId });
  }

  if (resp.status === 'completed') {
    _recogDoneAll = true;
    // 完成即落盘（末尾不足阈值的部分也保存）
    if (_cacheAsr && _cache) {
      saveCache(_currentVideoKey, _cache);
      _lastSavedTotalListened = _cache.totalListened;
    }
    pushStatusLocal('gate-done', 'job completed', { jobId: _jobId });
    stopJobPolling(); // 任务终态：停轮询，会话保留（由用户停止）
  } else if (resp.status === 'failed') {
    const msg = 'backend job 失败: ' + (resp.error || 'unknown');
    console.warn('[VocabRadar][asr-client][' + _ts() + ']', msg);
    const cb = _onError;
    stopASR();
    if (cb) { try { cb(new Error(msg)); } catch (e) { /* ignore */ } }
  }
}

/** 404（backend 重启丢内存任务表）→ 重提同 URL 接续；重提失败不可挽回 → 停 + 报错 */
async function resubmitJobAfter404() {
  console.warn('[VocabRadar][asr-client][' + _ts() + '] job 丢失(404)，重提接续');
  const submit = await sendMessage({ type: 'ASR_JOB_SUBMIT', url: location.href });
  if (!_running) return; // 重提期间 stopASR → 丢弃
  if (submit && submit.ok && submit.id) {
    // 只复位游标态，不动定时器：下一 tick 自然轮新 id（最多延迟一个 JOB_POLL_MS，
    //   不立即首轮——避免与既有 tick 竞争重入）；已收段由 _jobSeenSegs 去重
    _jobId = submit.id;
    _jobAfter = 0;
    _jobListenEnd = 0;
    _jobFailStreak = 0;
    pushStatusLocal('job-submitted', 'job ' + submit.id + ' (resubmit)', { jobId: submit.id });
  } else {
    const msg = 'backend job 丢失且重提失败: ' + ((submit && submit.error) || 'no response');
    console.warn('[VocabRadar][asr-client][' + _ts() + ']', msg);
    const cb = _onError;
    stopASR();
    if (cb) { try { cb(new Error(msg)); } catch (e) { /* ignore */ } }
  }
}

/** 停止 ASR：停轮询 + 通知 SW + 清回调 */
// 反思（2026-07-28）：用户反馈"asr中途退出"。保留调用栈日志，
//   记录 stopASR 的调用来源，便于诊断自动停止的根因。
export function stopASR() {
  const _stack = new Error().stack;
  const _caller = _stack ? _stack.split('\n').slice(2, 4).map(s => s.trim()).join(' <- ') : 'unknown';
  console.log('[VocabRadar][asr-client][' + _ts() + '] stopASR 被调用, 调用来源: ' + _caller);
  _running = false;

  // 停 job 轮询 + 闸门复位（sidebar 收到 frontier=-1 即解除缓冲逻辑）
  stopJobPolling();
  _recogFrontier = -1;
  _recogDoneAll = false;

  // 保存缓存（增量识别，末尾不足段也保存）
  if (_cacheAsr && _cache) {
    saveCache(_currentVideoKey, _cache);
    _lastSavedTotalListened = _cache.totalListened;
  }

  // 通知 SW 停止（协议握手）
  sendMessage({ type: 'STOP_ASR' }).catch(() => { /* ignore */ });

  _onText = null;
  _onError = null;
  _onStatus = null;
}

/** 检测 ASR 是否可用（SW 链路握手） */
export async function isASRReady() {
  try {
    const resp = await sendMessage({ type: 'ASR_CHECK' });
    return !!(resp && resp.ok);
  } catch (e) {
    return false;
  }
}

/**
 * 当前识别前沿（第九十六次：播放闸门依据；现仅遥测——闸门默认停用）
 * job 段按 end 推进。
 * @returns {number} -1=未推进（未启动或尚无段）；Infinity=全部识别完成
 */
export function getASRFrontier() {
  return _recogDoneAll ? Infinity : _recogFrontier;
}

/**
 * 速率统计快照（第九十七次接口保留）
 * job 路径无本地下载/识别速率（backend 按百分比回报进度，见 'job-download'/
 * 'job-transcribe' 状态）；恒 0 时 playback-gate 有兜底（recSpeedX=4），
 * asr-stage 的 gate 展示对 >0 才拼接，不显示空值。
 * @returns {{dlSpeedKBps:number, recSpeedX:number, frontier:number, readyDur:number}}
 */
export function getASRStats() {
  return {
    dlSpeedKBps: 0,
    recSpeedX: 0,
    frontier: getASRFrontier(),
    readyDur: 0
  };
}

// === 配置加载 ===

/**
 * 加载缓存粒度与开关配置
 * 优先级：chrome.storage.local（popup 设置，仅 cacheAsr）> config.json > 默认值
 * （asrSegmentSec/asrFirstChunkSec 属已退役的下载管线配置，第398次一并删除）
 */
async function loadSegmentConfig() {
  try {
    const url = chrome.runtime.getURL('src/data/config.json');
    const res = await fetch(url);
    const fileCfg = await res.json();
    if (fileCfg.asrCacheSegmentSec && fileCfg.asrCacheSegmentSec > 0) {
      _cacheSegmentSec = fileCfg.asrCacheSegmentSec;
    }
    _cacheAsr = fileCfg.cacheAsr === true;
    _debug = fileCfg.debug === true;
    if (chrome?.storage?.local) {
      const stored = await new Promise((r) => chrome.storage.local.get(['cacheAsr', 'asrModelSize'], r));
      if (typeof stored.cacheAsr === 'boolean') {
        _cacheAsr = stored.cacheAsr;
      }
      // 反思（2026-08-21 第八十九次）：记录当前 ASR 模型——缓存按模型失效
      if (stored.asrModelSize && typeof stored.asrModelSize === 'string') {
        _currentModelSize = stored.asrModelSize;
      }
    }
    console.log('[VocabRadar][asr-client][' + _ts() + '] 配置: asrCacheSegmentSec=' + _cacheSegmentSec + 's cacheAsr=' + _cacheAsr + ' model=' + _currentModelSize + ' debug=' + _debug);
  } catch (e) {
    console.warn('[VocabRadar][asr-client][' + _ts() + '] 配置加载失败，使用默认值:', e.message);
  }
}

/**
 * 本地状态推送（诊断时间线 + onStatus 回调）
 * @param {string} stage - 阶段标识（asr-stage.js ASR_INTERNAL_STAGES/KNOWN_STAGES 消费）
 * @param {string} info - 描述
 * @param {object} [extra] - 额外数据（jobId, frontier 等）
 */
function pushStatusLocal(stage, info, extra) {
  if (_debug) console.log('[VocabRadar][asr-client][' + _ts() + '] 状态:', stage, info || '');
  if (_onStatus) {
    try { _onStatus({ status: 'stage', stage, info: info || '', ...(extra || {}) }); } catch (e) { /* ignore */ }
  }
}

// === 缓存读写 ===

/** 清理指定视频的 ASR 缓存 */
async function clearASRCache(videoKey) {
  if (!videoKey) return;
  try {
    const key = `asr_cache_${videoKey}`;
    await new Promise((r) => chrome.storage.local.remove(key, r));
    console.log('[VocabRadar][asr-client][' + _ts() + '] 已清理 ASR 缓存:', key);
  } catch (e) { /* ignore */ }
}

/**
 * 检查指定视频是否有 ASR 缓存
 * 反思（2026-07-08）：用户反馈「asr缓存结果并没有出现在轨道，只有识别后才出现」。
 *   需在无字幕时自动加载缓存，前提是能查询缓存是否存在。此函数供 sidebar.loadASRCacheIfAny 调用。
 * @param {string} videoKey
 * @returns {Promise<boolean>}
 */
export async function hasASRCache(videoKey) {
  if (!videoKey) return false;
  try {
    const key = `asr_cache_${videoKey}`;
    // 反思（2026-08-21 第八十九次）：内联读当前模型（同 loadCache，不依赖初始化顺序）
    const res = await new Promise((r) => chrome.storage.local.get([key, 'asrModelSize'], r));
    const cached = res[key];
    if (!cached) return false;
    const curModel = (res.asrModelSize && typeof res.asrModelSize === 'string') ? res.asrModelSize : 'large-v3-turbo';
    // 模型不符的缓存视为无缓存（避免侧栏展示旧模型结果）
    if (cached.modelSize !== curModel) return false;
    if (cached.segments && Array.isArray(cached.segments)) return cached.segments.length > 0;
    if (Array.isArray(cached)) return cached.length > 0;
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * 获取 ASR 缓存的覆盖率（已覆盖时长 / 视频总时长）
 * 反思（2026-07-10 #86）：用户要求「若asr轨道不完整，则自动asr」。
 * 第439次（两维度规定）：缓存条目带 coverage（backend VAD 覆盖真值，含空洞
 *   补转并入）时优先按它精确计算；旧条目无 coverage 才回退 listenStart/
 *   listenEnd 合并推断。覆盖时间与识别结果时间是两个维度，禁止混用。
 * @param {string} videoKey
 * @param {number} videoDuration - 视频总时长（秒）
 * @returns {Promise<number>} 覆盖率 0-1（0=无缓存或无效，1=完全覆盖）
 */
export async function getASRCoverage(videoKey, videoDuration) {
  if (!videoKey || !videoDuration || videoDuration <= 0) return 0;
  try {
    const cache = await loadCache(videoKey);
    if (!cache.segments || cache.segments.length === 0) return 0;
    // 后端覆盖真值优先：[[a,b],...] 秒区间
    if (Array.isArray(cache.coverage) && cache.coverage.length > 0) {
      const ranges = cache.coverage
        .filter((r) => Array.isArray(r) && r.length === 2)
        .map((r) => ({ start: r[0], end: r[1] }));
      if (ranges.length > 0) {
        const merged = mergeRanges(ranges);
        const covered = merged.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0);
        return Math.min(1, covered / videoDuration);
      }
    }
    // 回退：listenStart/listenEnd 推断（旧缓存）
    const ranges = cache.segments.map((s) => ({ start: s.listenStart, end: s.listenEnd }));
    const merged = mergeRanges(ranges);
    const covered = merged.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0);
    return Math.min(1, covered / videoDuration);
  } catch (e) {
    return 0;
  }
}

/**
 * 获取指定视频的 ASR 缓存字幕（一次性返回数组，供无字幕时自动加载）
 * 复用 replayCachedSegsFromCache 的遍历逻辑，收集所有缓存段为 [{start,end,text}] 数组。
 * @param {string} videoKey
 * @returns {Promise<Array<{start:number,end:number,text:string}>>}
 */
export async function getCachedSubtitles(videoKey) {
  if (!videoKey) return [];
  const cache = await loadCache(videoKey);
  const subs = [];
  replayCachedSegsFromCache(cache, (seg) => subs.push(seg));
  return subs;
}

// === 增量识别缓存读写（2026-07-09 重构）===
// 缓存格式：{ segments:[{listenStart,listenEnd,speechStart,speechEnd,text,chunks}], totalListened }
//   listenStart/listenEnd：监听（送识别）的视频起止时间，用于增量识别跳过已监听段
//   speechStart/speechEnd：实际说话起止时间（chunk 首尾绝对时间），用于字幕回放
//   text：整段文本（chunks 拼接或 msg.text）
//   chunks：[{start,end,text}] 绝对时间的 chunk 级数据，用于精细回放（无 chunk 时为 null）
//   totalListened：累计监听时长（秒），超过 _cacheSegmentSec 触发写入 storage

/**
 * 从 storage 加载缓存（兼容旧数组格式）
 * @param {string} videoKey
 * @returns {Promise<{segments:Array, totalListened:number}>}
 */
async function loadCache(videoKey) {
  if (!videoKey) return { segments: [], totalListened: 0, coverage: null };
  try {
    const key = `asr_cache_${videoKey}`;
    // 反思（2026-08-21 第八十九次）：内联读当前模型——本函数可能在 loadSegmentConfig
    //   之前被调用（侧栏 loadASRCacheIfAny 页面加载路径），不能依赖 _currentModelSize 已初始化。
    const res = await new Promise((r) => chrome.storage.local.get([key, 'asrModelSize'], r));
    const cached = res[key];
    if (!cached) return { segments: [], totalListened: 0, coverage: null };
    const curModel = (res.asrModelSize && typeof res.asrModelSize === 'string') ? res.asrModelSize : 'large-v3-turbo';
    // 缓存按模型失效——缓存记录的产出模型与当前模型不一致（或旧缓存未记录模型）时
    //   整体丢弃，全部段用当前模型重新识别，避免"切换模型后回放旧模型结果"。
    if (cached.modelSize !== curModel) {
      console.log('[VocabRadar][asr-client][' + _ts() + '] 缓存模型不符（缓存=' + (cached.modelSize || '未知') + ' 当前=' + curModel + '），丢弃旧缓存，将全量重新识别');
      try { await new Promise((r) => chrome.storage.local.remove(key, r)); } catch (e2) { /* ignore */ }
      return { segments: [], totalListened: 0, coverage: null };
    }
    // 新格式（coverage=backend 覆盖真值，第439次；旧条目无此字段为 null）
    if (cached.segments && Array.isArray(cached.segments)) {
      console.log('[VocabRadar][asr-client][' + _ts() + '] 加载缓存(新格式): ' + cached.segments.length + ' 段 totalListened=' + cached.totalListened);
      return { segments: cached.segments, totalListened: cached.totalListened || 0, coverage: Array.isArray(cached.coverage) ? cached.coverage : null };
    }
    // 旧格式兼容：数组 of {startSec,endSec,segments/chunks/text,complete}
    if (Array.isArray(cached)) {
      const segments = [];
      for (const entry of cached) {
        const subSegs = (entry.segments && entry.segments.length > 0) ? entry.segments : [entry];
        for (const ss of subSegs) {
          const seg = legacyToSegment(ss.startSec, ss.endSec, ss.chunks, ss.text);
          if (seg) segments.push(seg);
        }
      }
      const totalListened = segments.reduce((s, x) => s + (x.listenEnd - x.listenStart), 0);
      console.log('[VocabRadar][asr-client][' + _ts() + '] 旧格式缓存转换: ' + segments.length + ' 段 totalListened=' + totalListened.toFixed(0) + 's');
      return { segments, totalListened, coverage: null };
    }
  } catch (e) { /* ignore */ }
  return { segments: [], totalListened: 0, coverage: null };
}

/**
 * 旧格式条目转新格式段
 * @param {number} startSec 监听起始
 * @param {number} endSec 监听结束
 * @param {Array} chunks 旧 chunk 数组（timestamp 相对 startSec）
 * @param {string} text 整段文本
 * @returns {{listenStart,listenEnd,speechStart,speechEnd,text,chunks}|null}
 */
function legacyToSegment(startSec, endSec, chunks, text) {
  const ls = startSec, le = endSec;
  let sp = ls, ep = le, tx = '', ch = null;
  if (chunks && chunks.length > 0) {
    ch = [];
    for (const c of chunks) {
      const ts0 = (c.timestamp && typeof c.timestamp[0] === 'number') ? c.timestamp[0] : 0;
      const ts1 = (c.timestamp && typeof c.timestamp[1] === 'number') ? c.timestamp[1] : (ts0 + 5);
      const ct = (c.text || '').trim();
      if (!ct) continue;
      ch.push({ start: ls + ts0, end: ls + ts1, text: ct });
    }
    if (ch.length > 0) {
      sp = ch[0].start;
      ep = ch[ch.length - 1].end;
      tx = ch.map((c) => c.text).join(' ');
    }
  } else if (text) {
    tx = text.trim();
  }
  if (!tx && (!ch || ch.length === 0)) return null;
  return { listenStart: ls, listenEnd: le, speechStart: sp, speechEnd: ep, text: tx, chunks: ch };
}

/**
 * 保存缓存到 storage（限制段数避免无限增长）
 * @param {string} videoKey
 * @param {{segments:Array, totalListened:number}} cache
 */
async function saveCache(videoKey, cache) {
  if (!videoKey || !cache) return;
  try {
    const key = `asr_cache_${videoKey}`;
    // 反思（2026-08-21 第八十九次）：缓存记录产出模型，供 loadCache 按模型失效
    // 第439次：coverage（backend 覆盖真值）随条目保存，getASRCoverage 优先消费
    let toSave = { modelSize: _currentModelSize, segments: cache.segments, totalListened: cache.totalListened, coverage: cache.coverage || null };
    if (cache.segments.length > 2000) {
      toSave = { modelSize: _currentModelSize, segments: cache.segments.slice(cache.segments.length - 2000), totalListened: cache.totalListened, coverage: cache.coverage || null };
    }
    await new Promise((r) => chrome.storage.local.set({ [key]: toSave }, r));
    console.log('[VocabRadar][asr-client][' + _ts() + '] 缓存写入: ' + toSave.segments.length + ' 段 totalListened=' + toSave.totalListened.toFixed(0) + 's model=' + toSave.modelSize);
  } catch (e) { /* ignore */ }
}

/**
 * 合并或新增段到缓存
 * 监听起止时间临近（gap <= 1s）则合并到末段，否则新增。
 * 合并时扩展 listenEnd/speechEnd，拼接 text，拼接 chunks。
 * totalListened 仅累加新覆盖的监听时长（合并=扩展量，新增=整段时长）。
 * @param {{segments:Array, totalListened:number}} cache
 * @param {object} msg - ASR_SEGMENT 消息（含 start/end/chunks/text）
 */
function mergeOrAddSegment(cache, msg) {
  if (!msg || !cache) return;
  const listenStart = msg.start;
  const listenEnd = msg.end;
  let speechStart = listenStart, speechEnd = listenEnd, text = '', chunks = null;
  if (msg.chunks && msg.chunks.length > 0) {
    chunks = [];
    for (const c of msg.chunks) {
      const ts0 = (c.timestamp && typeof c.timestamp[0] === 'number') ? c.timestamp[0] : 0;
      const ts1 = (c.timestamp && typeof c.timestamp[1] === 'number') ? c.timestamp[1] : (ts0 + 5);
      const ct = (c.text || '').trim();
      if (!ct) continue;
      chunks.push({ start: listenStart + ts0, end: listenStart + ts1, text: ct });
    }
    if (chunks.length > 0) {
      speechStart = chunks[0].start;
      speechEnd = chunks[chunks.length - 1].end;
      text = chunks.map((c) => c.text).join(' ');
    }
  } else if (msg.text) {
    text = msg.text.trim();
  }

  const segs = cache.segments;
  // 第一百七十九次（用户报障："edge 中有的 asr 时间戳后出的时间居然小"）：
  //   倒退来自缓存段乱序。修正：按 listenStart 定位插入点，只与"时间上的前一段"
  //   判邻接合并，新增段用 splice 插入，保证 cache.segments 始终按 listenStart 升序。
  let idx = segs.length;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].listenStart > listenStart) { idx = i; break; }
  }
  const prev = idx > 0 ? segs[idx - 1] : null;
  if (!prev || (listenStart - prev.listenEnd) > 1.0) {
    // 新增段（按时间序插入）
    segs.splice(idx, 0, { listenStart, listenEnd, speechStart, speechEnd, text, chunks });
    cache.totalListened += (listenEnd - listenStart);
  } else {
    // 合并到时间上的前一段（监听范围临近）
    const last = prev;
    const oldEnd = last.listenEnd;
    last.listenEnd = Math.max(last.listenEnd, listenEnd);
    last.speechEnd = Math.max(last.speechEnd, speechEnd);
    if (text) {
      last.text = last.text ? (last.text + ' ' + text) : text;
    }
    if (chunks && chunks.length > 0) {
      // 合并后 chunk 也按绝对时间排好，回放才不会在段内倒退
      last.chunks = (last.chunks || []).concat(chunks).sort((a, b) => a.start - b.start);
    }
    // 仅累加新覆盖的监听时长
    if (listenEnd > oldEnd) {
      cache.totalListened += (listenEnd - oldEnd);
    }
  }
}

/**
 * 合并重叠/相邻时间段（gap <= 0.5s 视为相邻）
 * @param {Array<{start:number,end:number}>} ranges
 * @returns {Array<{start:number,end:number}>}
 */
function mergeRanges(ranges) {
  if (!ranges || ranges.length === 0) return [];
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const merged = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end + 0.5) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ start: sorted[i].start, end: sorted[i].end });
    }
  }
  return merged;
}

/**
 * 从内存缓存回放历史识别结果到 onText
 * 优先按 chunk 级时间戳回放（精细），无 chunk 时按 speechStart/speechEnd 整段回放。
 * @param {{segments:Array}} cache
 * @param {(seg)=>void} onText
 */
function replayCachedSegsFromCache(cache, onText) {
  if (!cache || !cache.segments || !onText) return;
  // 第一百七十九次：回放前按 listenStart 排序 —— 任何乱序来源仍可能非单调，
  //   排序保证消费方拿到的时间戳单调不倒退。
  const segsSorted = cache.segments.slice().sort((a, b) => (a.listenStart || 0) - (b.listenStart || 0));
  for (const seg of segsSorted) {
    if (seg.chunks && seg.chunks.length > 0) {
      const chunksSorted = seg.chunks.slice().sort((a, b) => (a.start || 0) - (b.start || 0));
      for (const ch of chunksSorted) {
        if (!ch.text) continue;
        try { onText({ start: ch.start, end: ch.end, text: ch.text }); } catch (e) { /* ignore */ }
      }
    } else if (seg.text) {
      try { onText({ start: seg.speechStart, end: seg.speechEnd, text: seg.text }); } catch (e) { /* ignore */ }
    }
  }
  console.log('[VocabRadar][asr-client][' + _ts() + '] 回放缓存: ' + cache.segments.length + ' 段');
}

// === 工具 ===

/**
 * 发送消息到 SW（带扩展上下文失效检测）
 * @param {object} msg
 * @returns {Promise<object|null>}
 */
function sendMessage(msg) {
  return new Promise((resolve) => {
    try {
      if (!chrome.runtime?.id) {
        const err = new Error('Extension context invalidated. 请刷新页面（扩展已更新）');
        err.code = 'CONTEXT_INVALIDATED';
        console.warn('[VocabRadar][asr-client][' + _ts() + '] sendMessage 异常:', err.message);
        resolve({ ok: false, error: err.message, code: 'CONTEXT_INVALIDATED' });
        return;
      }
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          console.warn('[VocabRadar][asr-client][' + _ts() + '] 消息失败:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(resp);
      });
    } catch (e) {
      console.warn('[VocabRadar][asr-client][' + _ts() + '] sendMessage 异常:', e);
      if (e.message && e.message.includes('Extension context invalidated')) {
        resolve({ ok: false, error: 'Extension context invalidated. 请刷新页面（扩展已更新）', code: 'CONTEXT_INVALIDATED' });
      } else {
        resolve(null);
      }
    }
  });
}
