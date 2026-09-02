// ASR 客户端：content script 侧调用。
// 架构重构（2026-07-04）：从实时采集改为预识别方案。
//
// === 旧方案（已废弃）===
// ScriptProcessor（已废弃 API）从 <video> 实时采集音频，只能识别正在播放的内容，
// 字幕滞后 asrSegmentSec + Whisper 处理时间。
//
// === 新方案 ===
// 双路径架构：
//
// 路径 A — B站预识别（主路径）：
//   旧版（2026-07-04~2026-08-22）：SW 一次性下载整个 m4s → 整解 → 按 60 秒分段识别。
//   流式 v1（第九十五次）：从当前进度起边下边识边播。实测问题：无播放闸门致字幕落后几十秒；
//   字节估算跳位/下载三连败弃单/段超时跳过 → 经常丢音频。
//   闸门版（2026-08-22 第九十六次，详见 plan-full-download-asr.md）：
//   1. __playinfo__ 取音频 urls[](baseUrl+backupUrl) + bandwidth；FETCH_AUDIO_META 探测总字节
//   2. 首窗 = [seekByte-768K, seekByte+est×(领先秒+30)]：向前扩窗并按 tfdt 选解码起点
//      （最后一个 tfdt≤startSec 的片段），杜绝估算落片段中间丢音频；
//      解码「当前位置起约 asrFirstChunkSec 秒」→ 立即识别 → 完成后放行播放
//   3. 播放闸门：sidebar 据 getASRFrontier() 前沿暂停/续播——字幕永远≥播放位置，同步由机制保证
//   4. 后台不停：主队列 当前位置→EOF 顺序下载（严格接上一批片段边界，绝不估算跳位），
//      失败指数退避无限重试（仅手动停止放弃）；完成后自动回填 0→首窗起点（增量缓存兼容乱序）
//   5. 可靠性：段识别失败重试×2；tfdt 空洞插静音保时间轴连续；已识别且入缓存的批释放 PCM
//   6. 任一步失败 → 回退整文件旧路径（legacyPrepareFromUrl）
//
// 路径 B — captureStream 回退（非 B站）：
//   1. video.captureStream() 获取 MediaStream
//   2. AudioContext + ScriptProcessorNode 直接提取原始 PCM（无编码/解码）
//   3. setInterval 按 _segmentSec 截取段，OfflineAudioContext 重采样到 16kHz
//   4. 送 Whisper 识别（实时采集，音频完整无间隙）
//   反思（2026-07-05）：MediaRecorder 编码 webm/opus 后再 decodeAudioData 解码，
//   仅首段含容器头，后续段无头导致 EncodingError。改用 ScriptProcessorNode 直接取 PCM。
//   ScriptProcessorNode 虽已废弃但仍可靠工作；AudioWorklet 是现代替代但需额外 worklet 文件。
//
// === 消息流 ===
//   asr-client → ASR_AUDIO_SEGMENT → SW → OFFSCREEN_ASR_RECOGNIZE → offscreen
//   offscreen → ASR_SEGMENT (含 chunks 时间戳) → SW → asr-client → onText 回调
//
// === 时间戳 ===
//   onText 回调的 seg.start/seg.end 统一为视频相对秒数（非墙钟毫秒）。
//   offscreen 返回 chunks 的 timestamp 为相对段起始的秒数，
//   asr-client 转换为绝对视频时间后调用 onText。
//
// === 缓存 ===
//   按 asrCacheSegmentSec（默认 60 秒）分段缓存。
//   只有完整识别一个 asrCacheSegmentSec 长度的段才缓存，
//   末尾不足的段标记 complete:false。

// 第九十五次：流式下载需要 fMP4 解析（moof 边界/tfdt 时间戳/mdhd 时标）与带宽信息
import { getBilibiliAudioInfo } from './bilibili-audio.js';
import { walkBoxes, findMoofSync, parseMdhdTimescale, parseTfdtSeconds, completePrefixEnd } from './fmp4.js';

// === 模块状态 ===
// 反思（2026-07-06）：用户反馈"为啥一直要间隔几十毫秒就有日志输出"。
// 旧版 pushStatusLocal / _msgListener 无条件 console.log，ASR 运行时大量日志刷屏。
// 修正：新增 _debug 标志（从 config.json 读取），仅 debug=true 时打印状态日志。
let _debug = false;
let _msgListener = null;
let _onText = null;
let _onError = null;
let _onStatus = null;
let _currentVideoKey = null;
let _running = false;

// === 配置 ===
let _segmentSec = 10;              // 识别分段长度（秒），从 config asrSegmentSec 读取。控制每次送 Whisper 的音频段长
let _cacheSegmentSec = 60;          // 缓存分段长度（秒），从 config asrCacheSegmentSec 读取。控制缓存写入粒度
let _cacheAsr = false;              // 是否缓存 ASR 结果
// 第九十五次：首段快速处理时长（秒）。借鉴 videoseek processVideo 的 segmentDuration=30——
// 点击识别后先下载/解码约 30 秒音频立即开识，其余由后台循环边下边补。
// 第九十六次：该值同时是播放闸门的放行提前量（识别领先播放多少秒后放行/续播），
// 引导页 ASR 设定栏可配置（storage.asrFirstChunkSec），便于调试。
let _firstChunkSec = 30;

// === B站预识别路径状态 ===
// 第九十五次流式化：PCM 不再是单个大数组，而是按下载批次追加的「块+媒体时间锚点」映射表。
// 第一百一十三次：录制工作流——sidebar 录制的整段音频 Blob 经 startASR opts.recordedBlob
// 传入（_pendingRecordedBlob），优先于站点直连/回退：解码→16k PCM 单批入表→从 0 顺序识别。
// getSamplesForRange 按媒体时间取样本，识别循环按可用时长（_biliContigEnd）等待后台下载。
// 第九十六次：映射表按 mediaTime 有序插入（回填批次媒体时间小于主队列批次）。
let _biliDuration = 0;             // 已就绪音频可连续覆盖的时长终点（视频秒）。流式时随批推进
let _biliAudioCtx = null;          // 用于解码的 AudioContext
let _biliLoopAborted = false;      // B站识别/下载循环中止标志
let _biliPcmMap = [];              // [{mediaTime:number, pcm:Float32Array|null}] 按 mediaTime 升序；pcm=null 表示已释放
let _biliPcmLen = 0;               // 已就绪 PCM 总采样数（诊断用）
let _biliStreamDone = false;       // 后台下载是否已结束（EOF/失败/中止）
let _biliInitBlock = null;         // fMP4 初始化块（Uint8Array，第一个 moof 之前的字节）
let _biliTimescale = 0;            // mdhd 时标（刻度/秒），tfdt 换算用
// 第九十六次：播放闸门状态。_recogFrontier = 主方向已识别终点（视频秒）；
// sidebar 的 timeupdate 检查 video.currentTime >= frontier - ε 时暂停并显示缓冲，
// frontier 推进越过 currentTime 后自动续播。字幕永远≥播放位置。
let _recogFrontier = -1;           // -1 = 尚未建立首批锚点，闸门不生效
let _recogDoneAll = false;         // 全部段识别完成 → 闸门解除
let _pendingRecordedBlob = null;   // 第一百一十三次：待识别的录制音频 Blob（一次性消费）

// === 速率统计（第九十七次：同步展示与自适应滞回的数据源）===
// 估算依据（详见 docs/plan-full-download-asr.md 第六节）：
//   下载：B站音轨 64-320kbps ⇒ 每媒体秒 8-40KB；CDN 实际吞吐 1-10MB/s ⇒ 约 50-300 倍实时，
//         首窗 30s 音频（<1.5MB）通常 <2s —— 下载几乎从不构成瓶颈；
//   识别：Whisper WASM（CPU）：tiny≈5-15×实时、base≈2-6×、small≈0.8-2×、medium+ ≤1× —— 主瓶颈。
//   故播放闸门的续播滞回应按实测识别倍速自适应（sidebar 经 getASRStats 读取），而非固定值。
const _stats = {
  dlBytes: 0,        // 累计下载字节（诊断）
  dlPending: 0,      // 未结算字节（≥1s 结算一次）
  dlSpeedKBps: 0,    // 下载速率 KB/s（EWMA）
  recSpeedX: 0,      // 识别速率（倍实时，EWMA；含 offscreen 排队/模型加载影响）
  _lastDlTs: 0       // 上次下载速率结算时刻(ms)
};

// === captureStream 回退路径状态 ===
// 反思（2026-07-05）：旧版用 MediaRecorder 编码 webm/opus，再 decodeAudioData 解码。
// 但 MediaRecorder.start(timeslice) 仅首段含 webm 容器头，后续段无头导致 EncodingError。
// 修正：改用 AudioContext + ScriptProcessorNode 直接提取原始 PCM，跳过编码/解码。
// 反思（2026-07-09 四次修复）：用户反馈「依旧过一会全是静音」。
//   根因：ScriptProcessorNode 是已废弃 API，onaudioprocess 回调在主线程执行，
//   标签页后台/主线程繁忙时回调被挂起，_fallbackPcmBuffer 恒空 → 每段都走 fallback-silent 全静音。
//   修正：迁移到 AudioWorklet（现代替代），在独立的音频线程运行，不受主线程阻塞影响。
//   新建 src/lib/asr-worklet-processor.js，通过 audioCtx.audioWorklet.addModule 加载，
//   AudioWorkletNode 替换 ScriptProcessorNode，port.onmessage 接收 PCM。
let _recorderStream = null;        // MediaStream（音频轨）
let _fallbackVideoStart = 0;       // 当前段的视频起始时间（秒）
let _fallbackTimer = null;         // 段截取定时器（setInterval 控制段长）
let _fallbackAudioCtx = null;      // AudioContext（回退路径专用）
let _fallbackSourceNode = null;    // MediaStreamAudioSourceNode
let _fallbackProcessor = null;     // AudioWorkletNode（替代废弃的 ScriptProcessorNode）
let _fallbackPcmBuffer = [];       // PCM 采样累积缓冲（Float32Array 数组）
let _fallbackPcmLength = 0;        // 缓冲总采样数（避免频繁 reduce）
let _fallbackSegCount = 0;         // 已处理的音频段数（进度跟踪）
let _fallbackVideoEl = null;       // video 元素引用（用于获取总时长和 currentTime）
let _fallbackVisibilityHandler = null; // visibilitychange 监听器（恢复 AudioContext）
let _wasFallbackPaused = false;    // 上一帧 video.paused 状态（状态去重，避免 fallback-paused 日志刷屏）
let _fallbackPlayHandler = null;   // video 'play' 事件监听器（播放时 resume AudioContext）

// === ASR 缓存（增量识别）===
// 反思（2026-07-09）：用户要求「缓存识别结果，每段包括监听起止时间，识别结果包括的是
//   说话起止时间。监听起止时间临近就合并识别结果。监听超过参数值就缓存。再次识别只监听
//   未监听的内容」。旧版每次 startASR 都 clearASRCache + 从头全量识别，缓存形同虚设。
//   新设计：缓存格式 {segments:[{listenStart,listenEnd,speechStart,speechEnd,text}],
//   totalListened}，不清缓存，B站路径跳过已监听段只识别未监听内容，相邻监听段合并，
//   totalListened 超 _cacheSegmentSec 阈值写入 storage。
let _cache = null;                  // 缓存对象 {segments:[], totalListened:0}，startASR 时加载
let _lastSavedTotalListened = 0;    // 上次写入 storage 时的 totalListened，用于阈值判断（避免每段都写）
// 反思（2026-08-21 第八十九次）：当前 ASR 模型（loadSegmentConfig 从 storage 读取）。
//   缓存记录产出模型；模型变更后旧缓存整体失效（用户："切换了asr模型，识别依旧用旧的"——
//   旧根因是增量识别跳过已监听段并回放旧模型结果）。
let _currentModelSize = 'tiny';

// === 段响应等待（B站路径顺序识别用） ===
let _pendingResolve = null;        // ASR_SEGMENT 响应的 resolve 回调

const SAMPLE_RATE = 16000;

// 时间戳辅助：所有日志带 HH:MM:SS.mmm 便于诊断时序问题
function _ts() {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/**
 * 启动 ASR 识别
 * 优先尝试 B站预识别路径（__playinfo__ 下载音频），失败则回退到 captureStream。
 * @param {{videoKey:string, videoElement:HTMLVideoElement, onText?:(seg)=>void, onError?:(err)=>void, onStatus?:(s)=>void, skipReplay?:boolean}} opts
 *   skipReplay=true 时跳过 replayCachedSegsFromCache（用于缓存已由 sidebar.loadASRCacheIfAny 预加载到面板的场景，
 *   避免重复回放导致字幕重复）。反思（2026-07-08）：用户批评「谁给你的胆子清空asr结果的！那还要缓存干啥！」，
 *   有缓存时点ASR应接续不清空，sidebar 预加载缓存后传 skipReplay:true 直接进入实时识别。
 *   2026-07-09：增量识别重构——cacheAsr=true 时加载缓存到 _cache（不清除），
 *   biliRecognizeLoop 跳过已监听段只识别未监听内容，新识别结果合并/新增到 _cache。
 * @returns {Promise<() => void>} unsubscribe 函数（停止 ASR + 移除监听）
 */
export async function startASR(opts) {
  _onText = opts.onText || null;
  _onError = opts.onError || null;
  _onStatus = opts.onStatus || null;
  _currentVideoKey = opts.videoKey || '';
  // 第一百一十三次：录制工作流——外部传入的录音 Blob（一次性）
  _pendingRecordedBlob = opts.recordedBlob || null;
  const skipReplay = !!opts.skipReplay;
  console.log('[VocabRadar][asr-client][' + _ts() + '] startASR videoKey=', _currentVideoKey, 'cacheAsr=', _cacheAsr, 'skipReplay=', skipReplay);
  const videoEl = opts.videoElement;

  if (!videoEl) {
    throw new Error('startASR: videoElement is required');
  }

  // 加载配置
  await loadSegmentConfig();

  // 缓存控制（增量识别）
  // 反思（2026-07-09）：旧版每次 startASR 都 clearASRCache + 从头全量识别，缓存形同虚设。
  //   新设计：cacheAsr=true 时加载缓存到 _cache（不清除），skipReplay=false 时回放已缓存段，
  //   biliRecognizeLoop 跳过已监听段只识别未监听内容。
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

  // 注册消息监听（接收 offscreen 回传的识别段）
  if (!_msgListener) {
    _msgListener = (msg, sender, sendResponse) => {
      if (!msg || typeof msg !== 'object') return false;
      console.log('[VocabRadar][asr-client][' + _ts() + '] 收到消息:', msg.type); // 保留：消息类型日志对诊断至关重要，但仅在 ASR 运行时触发
      if (msg.type === 'ASR_SEGMENT' && msg.videoKey === _currentVideoKey) {
        // 处理识别结果：提取 chunks 并调用 onText
        handleASRResponse(msg);
        // 第一百零二次：段结果诊断入时间线（ch=音频到达通道 samples=样本数 peak=振幅）
        pushStatusLocal('seg-recv', '段[' + Math.round(msg.start) + '-' + Math.round(msg.end) + 's] ch=' + (msg.ch || '?') +
          ' samples=' + (msg.samples ?? '?') + ' peak=' + (typeof msg.peak === 'number' ? msg.peak.toFixed(3) : '?') +
          ' textLen=' + ((msg.text || '').length));
        // 缓存：合并/新增段，累积超 _cacheSegmentSec 阈值时写入 storage
        if (_cacheAsr && _cache) {
          mergeOrAddSegment(_cache, msg);
          if (_cache.totalListened - _lastSavedTotalListened >= _cacheSegmentSec) {
            _lastSavedTotalListened = _cache.totalListened;
            saveCache(_currentVideoKey, _cache);
          }
        }
        // 解除 B站路径的等待（顺序识别）
        if (_pendingResolve) {
          const resolve = _pendingResolve;
          _pendingResolve = null;
          resolve(msg);
        }
        sendResponse({ ok: true });
        return true;
      } else if (msg.type === 'ASR_ERROR') {
        if (_onError) { try { _onError(new Error(msg.error || 'ASR error')); } catch (e) { /* ignore */ } }
        sendResponse({ ok: true });
        return true;
      } else if (msg.type === 'ASR_STATUS') {
        if (_onStatus) { try { _onStatus(msg); } catch (e) { /* ignore */ } }
        sendResponse({ ok: true });
        return true;
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(_msgListener);
  }

  // 反思（2026-07-05）：用户要求"收集音频跟识别应当分离"。
  //   旧版先 await START_ASR（等 offscreen 创建）再下载音频，串行浪费时间。
  //   修正：音频下载（FETCH_AUDIO）与 offscreen 创建（START_ASR）并行——
   // 第一百一十一次：START_ASR 加重试（×3，600ms 间隔）——用户日志
  //   "ASR start failed in service worker: no response"：MV3 SW 冷启动/消息端口
  //   偶发不应答时旧版直接整体失败且不回退，识别啥都没有。重试可自愈瞬时态，
  //   并把 lastError 细节带进异常信息便于诊断。
  const offscreenPromise = startOffscreenWithRetry(_currentVideoKey);

  _running = true;
  _biliLoopAborted = false;

  // 2. 并行准备 B站音频（下载+解码+重采样，不等模型就绪）
  let audioInfo = null;
  try {
    audioInfo = await prepareBilibiliAudio(videoEl);
  } catch (e) {
    console.warn('[VocabRadar][asr-client][' + _ts() + '] B站音频准备失败:', e.message || e);
  }

  // 3. 等 offscreen 就绪（识别段需要 offscreen 接收）
  const started = await offscreenPromise;
  console.log('[VocabRadar][asr-client][' + _ts() + '] START_ASR 响应:', started);
  if (!started || !started.ok) {
    stopASR();
    throw new Error('ASR start failed in service worker: ' + ((started && started.error) || 'no response'));
  }

  // 4. 音频已就绪 → 开始识别循环；否则回退到 captureStream
  if (audioInfo) {
    // 第九十六次：立即建立播放闸门——前沿=点击位置所在段起始，
    // sidebar 收到 'gate' 状态即暂停视频等待首批（约 asrFirstChunkSec 秒）识别完成后放行。
    // 修复旧版「模型加载+下载期间视频照常跑几十秒 → 字幕永远追不上」。
    _recogDoneAll = false;
    _recogFrontier = Math.floor(audioInfo.startSec / _segmentSec) * _segmentSec;
    pushStatusLocal('gate', '先识别 ' + _firstChunkSec + 's 再播放', { frontier: _recogFrontier });
    biliRecognizeLoop(audioInfo.startSec, audioInfo.totalRecogSegs).catch((e) => {
      console.warn('[VocabRadar][asr-client][' + _ts() + '] B站识别循环异常:', e);
      if (_onError) { try { _onError(e); } catch (e2) { /* ignore */ } }
    });
  } else {
    pushStatusLocal('fallback', 'B站预识别不可用，回退到 captureStream');
    try {
      await startFallbackCapture(videoEl);
    } catch (e) {
      stopASR();
      throw new Error('音频采集启动失败: ' + String(e.message || e));
    }
  }

  // 返回 unsubscribe
  return () => {
    stopASR();
  };
}

/**
 * 处理 offscreen 回传的识别结果
 * 如果含 chunks（return_timestamps=true），按 chunk 拆分为多条字幕；
 * 否则作为单条字幕。
 * @param {object} msg - ASR_SEGMENT 消息
 */
function handleASRResponse(msg) {
  if (!_onText) return;
  const segStart = msg.start;  // 视频相对秒数
  const segEnd = msg.end;

  if (msg.chunks && msg.chunks.length > 0) {
    // 有 chunk 级时间戳：每 chunk 一条字幕
    for (const chunk of msg.chunks) {
      const ts0 = (chunk.timestamp && typeof chunk.timestamp[0] === 'number') ? chunk.timestamp[0] : 0;
      const ts1 = (chunk.timestamp && typeof chunk.timestamp[1] === 'number') ? chunk.timestamp[1] : (ts0 + 5);
      const text = (chunk.text || '').trim();
      if (!text) continue;
      // chunk.timestamp 是相对段起始的秒数，转为绝对视频时间
      try {
        _onText({ start: segStart + ts0, end: segStart + ts1, text });
      } catch (e) { /* ignore */ }
    }
  } else if (msg.text) {
    // 无 chunk 时间戳：整段一条字幕
    try {
      _onText({ start: segStart, end: segEnd, text: msg.text });
    } catch (e) { /* ignore */ }
  }
}

/** 停止 ASR：停采集 + 通知 SW + 移除本地监听 */
// 反思（2026-07-28）：用户反馈"asr中途退出"。添加调用栈日志，
//   记录 stopASR 的调用来源，便于诊断自动停止的根因。
export function stopASR() {
  // 打印调用栈，诊断 ASR 中途退出的根因
  const _stack = new Error().stack;
  const _caller = _stack ? _stack.split('\n').slice(2, 4).map(s => s.trim()).join(' <- ') : 'unknown';
  console.log('[VocabRadar][asr-client][' + _ts() + '] stopASR 被调用, 调用来源: ' + _caller);
  _running = false;
  _biliLoopAborted = true;

  // 停止 B站路径（第九十五次：清流式 PCM 映射与下载状态，后台循环经 _biliLoopAborted 退出；
  //   第九十六次：闸门状态一并复位，sidebar 收到 frontier=-1 即解除缓冲逻辑）
  _biliPcmMap = [];
  _biliPcmLen = 0;
  _biliDuration = 0;
  _biliStreamDone = true;
  _biliInitBlock = null;
  _biliTimescale = 0;
  _recogFrontier = -1;
  _recogDoneAll = false;
  // 第九十七次：统计一并复位（新会话从零计量）
  _stats.dlBytes = 0; _stats.dlPending = 0; _stats.dlSpeedKBps = 0; _stats.recSpeedX = 0; _stats._lastDlTs = 0;

  // 停止回退路径
  stopFallbackCapture();

  // 保存缓存（增量识别，末尾不足段也保存）
  if (_cacheAsr && _cache) {
    saveCache(_currentVideoKey, _cache);
    _lastSavedTotalListened = _cache.totalListened;
  }

  // 解除段响应等待
  if (_pendingResolve) {
    const resolve = _pendingResolve;
    _pendingResolve = null;
    resolve(null);
  }

  // 通知 SW/offscreen 停止
  sendMessage({ type: 'STOP_ASR' }).catch(() => { /* ignore */ });

  if (_msgListener) {
    try { chrome.runtime.onMessage.removeListener(_msgListener); } catch (e) { /* ignore */ }
    _msgListener = null;
  }
  _onText = null;
  _onError = null;
  _onStatus = null;
}

/** 检测 ASR 是否可用（offscreen 支持） */
export async function isASRReady() {
  try {
    const resp = await sendMessage({ type: 'ASR_CHECK' });
    return !!(resp && resp.ok);
  } catch (e) {
    return false;
  }
}

/**
 * 当前识别前沿（第九十六次：播放闸门依据）
 * sidebar 在 ASR 运行期间轮询/经 'gate' 状态更新：
 *   video.currentTime >= frontier - 0.25 → 暂停并显示缓冲；frontier 越过 currentTime 后续播。
 * @returns {number} -1=闸门未生效（captureStream 回退或未启动）；Infinity=全部识别完成
 */
export function getASRFrontier() {
  return _recogDoneAll ? Infinity : _recogFrontier;
}

/**
 * 速率统计快照（第九十七次：sidebar 同步展示 + 自适应续播滞回）
 * @returns {{dlSpeedKBps:number, recSpeedX:number, frontier:number, readyDur:number}}
 *   dlSpeedKBps=下载速率 KB/s（0=未知/整文件路径）；recSpeedX=识别倍实时（0=尚无样本）；
 *   frontier 同 getASRFrontier；readyDur=已就绪音频时长终点（秒）。
 */
export function getASRStats() {
  return {
    dlSpeedKBps: _stats.dlSpeedKBps,
    recSpeedX: _stats.recSpeedX,
    frontier: getASRFrontier(),
    readyDur: _biliDuration
  };
}

// === 配置加载 ===

/**
 * 加载分段长度配置
 * 优先级：chrome.storage.local（popup 设置）> config.json > 默认值
 */
async function loadSegmentConfig() {
  try {
    const url = chrome.runtime.getURL('src/data/config.json');
    const res = await fetch(url);
    const fileCfg = await res.json();
    if (fileCfg.asrSegmentSec && fileCfg.asrSegmentSec > 0) {
      _segmentSec = fileCfg.asrSegmentSec;
    }
    if (fileCfg.asrCacheSegmentSec && fileCfg.asrCacheSegmentSec > 0) {
      _cacheSegmentSec = fileCfg.asrCacheSegmentSec;
    }
    // 第九十五次：首段快速处理时长
    if (fileCfg.asrFirstChunkSec && fileCfg.asrFirstChunkSec > 0) {
      _firstChunkSec = fileCfg.asrFirstChunkSec;
    }
    _cacheAsr = fileCfg.cacheAsr === true;
    _debug = fileCfg.debug === true;
    if (chrome?.storage?.local) {
      const stored = await new Promise((r) => chrome.storage.local.get(['asrSegmentSec', 'cacheAsr', 'asrModelSize'], r));
      if (stored.asrSegmentSec && stored.asrSegmentSec > 0) {
        _segmentSec = stored.asrSegmentSec;
      }
      if (typeof stored.cacheAsr === 'boolean') {
        _cacheAsr = stored.cacheAsr;
      }
      // 第一百零二次：asrFirstChunkSec 不再读 storage（用户裁定唯一来源=config.json；
      // 引导页控件已移除，历史遗留的 storage 键自然失效）
      // 反思（2026-08-21 第八十九次）：记录当前 ASR 模型——缓存按模型失效
      //   （用户反馈"切换了asr模型，识别依旧用旧的"：旧模型结果被缓存回放）。
      if (stored.asrModelSize && typeof stored.asrModelSize === 'string') {
        _currentModelSize = stored.asrModelSize;
      }
    }
    console.log('[VocabRadar][asr-client][' + _ts() + '] 配置: asrSegmentSec=' + _segmentSec + 's asrCacheSegmentSec=' + _cacheSegmentSec + 's cacheAsr=' + _cacheAsr + ' model=' + _currentModelSize + ' debug=' + _debug);
  } catch (e) {
    console.warn('[VocabRadar][asr-client][' + _ts() + '] 配置加载失败，使用默认值:', e.message);
  }
}

// === B站预识别路径 ===

/**
 * 准备站点音频（第九十六次）：按站点分流——
 *   YouTube：youtubei.js 取 deciphered URL（音频单文件较小，走整文件下载=天然先下后识）；
 *   B站：流式防丢首窗 + 双区间后台下载。
 * 任一步失败回退：YouTube→null(captureStream)；B站→整文件→captureStream。
 * 反思（2026-07-05）：音频收集与识别分离——本函数只负责音频，识别循环由 startASR 调度。
 * @param {HTMLVideoElement} videoEl
 * @returns {Promise<{startSec:number, totalRecogSegs:number}|null>} null 表示站点直连路径不可用
 */
async function prepareBilibiliAudio(videoEl) {
  // 第一百一十三次：录制工作流优先——外部录音 Blob 直接解码识别（不依赖站点/网络）
  if (_pendingRecordedBlob) {
    const blob = _pendingRecordedBlob;
    _pendingRecordedBlob = null;
    try {
      pushStatusLocal('rec-decode', 'Decoding recorded audio...');
      if (!_biliAudioCtx) _biliAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ab = await blob.arrayBuffer();
      const audioBuffer = await _biliAudioCtx.decodeAudioData(ab);
      resetBiliStreamState();
      const pcm = await resampleTo16kMono(audioBuffer);
      appendBiliBatch({ pcm, duration: audioBuffer.duration, mediaTime: 0 }, 0);
      _biliStreamDone = true;
      const startSec = 0;
      const totalRecogSegs = Math.ceil(_biliDuration / _segmentSec);
      console.log('[VocabRadar][asr-client][' + _ts() + '] 录音路径：时长 ' + audioBuffer.duration.toFixed(1) + 's 共 ' + totalRecogSegs + ' 段');
      return { startSec, totalRecogSegs, fromRecorded: true };
    } catch (e) {
      console.warn('[VocabRadar][asr-client][' + _ts() + '] 录音解码失败，转常规路径:', e && e.message);
    }
  }
  // YouTube 路径（第九十六次）：youtubei.js（内容脚本世界动态 import，decipher 需隔离世界 eval）
  if (/youtube\.com$/.test(location.hostname)) {
    try {
      const m = await import(chrome.runtime.getURL('src/lib/youtube-audio.js'));
      const info = await m.getYoutubeAudioInfo();
      pushStatusLocal('yt-audio', info ? ('YouTube 音频就绪：' + (info.title || '')) : 'YouTube 音频获取失败');
      if (!info || !info.url) return null;
      return await legacyPrepareFromUrl([info.url], videoEl);
    } catch (e) {
      console.warn('[VocabRadar][asr-client][' + _ts() + '] YouTube 音频准备失败，回退 captureStream:', e.message || e);
      return null;
    }
  }
  // 1. 音频 URL + 带宽（bandwidth 用于字节位置估算：字节 ≈ bandwidth/8 × 秒）
  const info = await getBilibiliAudioInfo();
  if (!info || !info.url) {
    console.log('[VocabRadar][asr-client][' + _ts() + '] B站路径：未找到 __playinfo__ 音频 URL');
    // 第九十九次：失败原因推送到进度条（此前只在控制台，用户看不到为何回退实时模式）
    // 第一百一十次：原因放 extra.reason，侧栏用 i18n 标题+原文细节组装（提示语言随界面）
    try {
      const m = await import(chrome.runtime.getURL('src/lib/bilibili-audio.js'));
      const reason = await m.getBilibiliAudioUnavailableReason();
      pushStatusLocal('bili-none', '', { reason: reason || '' });
    } catch (e) { /* ignore */ }
    return null;
  }
  pushStatusLocal('bili-audio-url', '已获取音频 URL' + (info.title ? '：' + info.title : ''));

  // 2. 元数据：总字节数（切 Range 窗口的前提，借鉴 videoseek 先取 content-length）
  pushStatusLocal('bili-meta', '探测音频元数据...');
  const urls = [info.url, ...(info.backupUrls || [])];
  const meta = await Promise.race([
    sendMessage({ type: 'FETCH_AUDIO_META', url: info.url, urls }),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'meta超时(15s)' }), 15000))
  ]);
  if (!meta || !meta.ok || !meta.size || meta.size <= 0) {
    console.warn('[VocabRadar][asr-client][' + _ts() + '] B站路径：元数据探测失败', meta && meta.error);
    return await legacyPrepareFromUrl(urls, videoEl);
  }

  // 3. 流式准备；任何异常都落回整文件旧路径（与线上旧行为一致，保证可用性）
  try {
    return await streamPrepare(info, meta.size, videoEl);
  } catch (e) {
    console.warn('[VocabRadar][asr-client][' + _ts() + '] 流式准备失败，整文件回退:', e.message || e);
    pushStatusLocal('bili-stream-fail', '流式不可用(' + String(e.message || e).slice(0, 50) + ')，整文件回退');
    return await legacyPrepareFromUrl(urls, videoEl);
  }
}

/**
 * 流式准备主流程（第九十六次防丢版）：初始化块 → 防丢首窗 → 首批解码 → 启动双区间后台下载
 * 反思（第九十五次实测「经常丢失音频」根因之一）：旧首窗按 est×秒 估算 seekByte，
 *   落片段中间时 findMoofSync 直接跳到下一片段边界，半截片段被永久丢弃。
 *   新版：窗口起点向前扩 768KB，扫描窗口内全部完整片段的 tfdt，选「最后一个 tfdt≤startSec」
 *   的片段为解码起点 ⇒ startSec 所在片段必被完整覆盖；前扩区拿不到更早片段则再扩重取。
 * @param {{url:string, backupUrls?:string[], bandwidth:number}} info 音频信息
 * @param {number} totalSize 文件总字节数
 * @param {HTMLVideoElement} videoEl
 * @returns {Promise<{startSec:number, totalRecogSegs:number}|null>}
 */
async function streamPrepare(info, totalSize, videoEl) {
  const urls = (info.backupUrls && info.backupUrls.length > 0) ? [info.url, ...info.backupUrls] : [info.url];
  const est = Math.max(16000, Math.round((info.bandwidth || 128000) / 8)); // 字节/秒，兜底≥16KB/s
  const curTime = (isFinite(videoEl.currentTime)) ? videoEl.currentTime : 0;
  // 与旧版一致按缓存段对齐起点（增量缓存以 cacheSegmentSec 为粒度跳过已听段）
  const startSec = Math.floor(curTime / _cacheSegmentSec) * _cacheSegmentSec;

  // ① 初始化块：头部 256KB 扫盒找 moof（其前即 ftyp+moov）；找不到按 ×4 扩窗重试
  if (!_biliInitBlock) {
    let headLen = 262144;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetchRangeWithTimeout(urls, 0, Math.min(headLen, totalSize) - 1, 20000);
      if (!r.ok) throw new Error('头部下载失败: ' + (r.error || 'unknown'));
      const boxes = walkBoxes(r.arrayBuffer);
      const moofIdx = boxes.findIndex((b) => b.type === 'moof' && !b.truncated);
      if (moofIdx >= 1) {
        _biliInitBlock = new Uint8Array(r.arrayBuffer.slice(0, boxes[moofIdx].start));
        _biliTimescale = parseMdhdTimescale(r.arrayBuffer.slice(0, boxes[moofIdx].start)) || 0;
        break;
      }
      headLen *= 4;
      if (headLen > 16 * 1024 * 1024) break;
    }
    if (!_biliInitBlock) throw new Error('未找到 fMP4 初始化块(moof/moov)');
    pushStatusLocal('bili-init', '初始化块就绪 ' + Math.round(_biliInitBlock.length / 1024) + 'KB timescale=' + _biliTimescale);
  }

  // ② 防丢首窗：winStart=seekByte-768KB；解析窗口内完整片段 tfdt，
  //    解码起点=最后一个 tfdt≤startSec 的片段，解码终点=tfdt≥startSec+领先秒 的片段边界
  const seekByte = Math.min(Math.floor(est * startSec), Math.max(0, totalSize - 64 * 1024));
  const PRE_BYTES = 768 * 1024;
  let winStart = Math.max(0, seekByte - PRE_BYTES);
  let span = Math.ceil(seekByte - winStart + est * (_firstChunkSec + 30)) + 512 * 1024;
  let chosen = null; // {ab, decodeFrom, decEndRel, t0}
  for (let attempt = 0; attempt < 3 && !chosen; attempt++) {
    span = Math.max(Math.min(span, totalSize - winStart), 64 * 1024);
    if (span <= 0) break;
    const r = await fetchRangeWithTimeout(urls, winStart, winStart + span - 1, 30000);
    if (!r.ok) {
      if (r.error === 'range-unsupported') throw new Error('CDN不支持Range');
      throw new Error('首窗下载失败: ' + (r.error || 'unknown'));
    }
    const u8 = new Uint8Array(r.arrayBuffer);
    const syncRel = findMoofSync(u8);
    if (syncRel < 0) { winStart = Math.max(0, winStart - PRE_BYTES); span *= 2; continue; }
    const boxes = walkBoxes(r.arrayBuffer, syncRel);
    const compEnd = completePrefixEnd(boxes, syncRel);
    const frags = []; // [{rel,t}] 完整片段及媒体时间
    for (const b of boxes) {
      if (b.truncated || b.type !== 'moof' || b.start < syncRel || b.end > compEnd) continue;
      frags.push({ rel: b.start, t: parseTfdtSeconds(u8.subarray(b.start, b.end), _biliTimescale) });
    }
    if (frags.length === 0) { winStart = Math.max(0, winStart - PRE_BYTES); span *= 2; continue; }
    // 解码起点：最后一个 tfdt≤startSec 的片段（无更早片段且窗口起点>0 时向前扩重取）
    let di = -1;
    for (let k = 0; k < frags.length; k++) {
      if (frags[k].t !== null && frags[k].t <= startSec + 0.25) di = k;
    }
    if (di < 0) {
      if (winStart > 0 && frags[0].t !== null && frags[0].t > startSec + 0.25) {
        winStart = Math.max(0, winStart - PRE_BYTES * 2);
        span *= 2;
        continue;
      }
      di = 0;
    }
    // 解码终点：tfdt≥startSec+领先秒 的首个片段（含）之前的边界——多覆盖一段无害
    const targetT = startSec + _firstChunkSec;
    let ei = di;
    for (let k = di; k < frags.length; k++) {
      ei = k;
      if (frags[k].t !== null && frags[k].t >= targetT) break;
    }
    const decEndRel = (ei + 1 < frags.length) ? frags[ei + 1].rel : compEnd;
    const t0 = frags[di].t;
    if (t0 === null || !isFinite(t0)) throw new Error('无法解析首批 tfdt 时间戳');
    chosen = { ab: r.arrayBuffer, decodeFrom: frags[di].rel, decEndRel, t0 };
  }
  if (!chosen) throw new Error('首窗未取得可解码片段');

  // ③ 解码首批（initBlock+连续片段 ⇒ 最小合法 fMP4，见 fmp4.js 头注）
  pushStatusLocal('bili-decode', '解码首段...');
  const winU8 = new Uint8Array(chosen.ab);
  const batch = await decodeFmp4To16k(_biliInitBlock, winU8.subarray(chosen.decodeFrom, chosen.decEndRel));

  // ④ 首批 PCM 入映射表（tfdt 锚定真实媒体时间），启动双区间后台下载
  resetBiliStreamState();
  appendBiliBatch({ ...batch, mediaTime: chosen.t0 }, chosen.t0);
  recordDlBytes(chosen.decEndRel - chosen.decodeFrom); // 第九十七次：下载速率统计含首批
  // 第一百零一次诊断：首批振幅——区分「解码出全零/近静音（fMP4 窗口或解码问题）」与
  // 「PCM 有声但 Whisper 回空（offscreen/模型侧问题）」。抽样步长防大数组扫描开销。
  {
    let peak = 0;
    const s = batch.pcm, step = Math.max(1, Math.floor(s.length / 20000));
    for (let i = 0; i < s.length; i += step) { const a = Math.abs(s[i]); if (a > peak) peak = a; }
    console.log('[VocabRadar][asr-client][' + _ts() + '] 首批 PCM 振幅 peak=' + peak.toFixed(4) + ' samples=' + s.length +
      (peak < 0.001 ? ' ← 近全静音！解码/窗口可疑' : ' ← 有声'));
    // 第一百一十次：详情结构化（dur/from/peak），侧栏按界面语言组装提示文案
    pushStatusLocal('bili-first-ok', '', { dur: batch.duration, from: chosen.t0, peak });
  }

  startBiliBackgroundDownload({
    urls,
    totalSize,
    est,
    mainPos: winStart + chosen.decEndRel,          // 主队列接本批末片段边界（字节对齐，绝不估算跳位）
    mainMediaTime: chosen.t0 + batch.duration,
    backfillBoundary: winStart + chosen.decodeFrom, // 回填区间终点=首解码片段文件绝对位置
    backfillPos: 0,                                 // 回填从字节 0（天然盒对齐）到 boundary
    backfillMediaTime: 0,
    spanBytes: Math.max(1024 * 1024, Math.min(Math.ceil(est * 90), 8 * 1024 * 1024))
  });

  // 总段数供进度条显示：优先视频时长，缺失时按大小/带宽估算
  const durEst = (isFinite(videoEl.duration) && videoEl.duration > 0) ? videoEl.duration : Math.round(totalSize / est);
  const totalRecogSegs = Math.ceil(durEst / _segmentSec);
  console.log('[VocabRadar][asr-client][' + _ts() + '] B站流式路径：从 ' + startSec + 's 开始，首批至 ' +
    (chosen.t0 + batch.duration).toFixed(1) + 's，总长约 ' + durEst.toFixed(0) + 's 共 ' + totalRecogSegs + ' 段');
  return { startSec, totalRecogSegs };
}

/**
 * 后台双区间下载循环（第九十六次）：主队列 当前位置→EOF，完成后回填 0→首窗起点。
 * 反思（第九十五次实测「经常丢失音频」根因之二）：旧版连续失败 3 次即放弃续传，
 *   其后所有段被识别循环静默跳过 ⇒ 尾部大片永识不到。新版失败按指数退避无限重试
 *   （1s 起封顶 30s），仅用户停止才放弃；同一位置解码/下载反复失败 5 次才终止该队列。
 * @param {{urls:string[],totalSize:number,est:number,mainPos:number,mainMediaTime:number,
 *          backfillBoundary:number,backfillPos:number,backfillMediaTime:number,spanBytes:number}} ctx
 */
async function startBiliBackgroundDownload(ctx) {
  await biliDownloadPhase(ctx, true);
  if (_running && !_biliLoopAborted && ctx.backfillBoundary > 0) {
    pushStatusLocal('bili-backfill', '回填开头音频（0→' + Math.round(ctx.backfillBoundary / 1024) + 'KB）');
    await biliDownloadPhase(ctx, false);
  }
  _biliStreamDone = true;
  if (_running && !_biliLoopAborted) {
    pushStatusLocal('bili-dl-ok', '音频全部就绪');
    console.log('[VocabRadar][asr-client][' + _ts() + '] 双区间下载完成');
  }
}

/**
 * 单区间顺序下载：isMain=true 时 ctx.mainPos→totalSize，否则 ctx.backfillPos→ctx.backfillBoundary。
 * 每批 Range 拉取 → 扫盒取完整片段 → 解码追加 PCM 映射表 → 原地推进位置（严格片段边界）。
 * @param {object} ctx 下载上下文（成功后原地推进）
 * @param {boolean} isMain 是否主队列
 */
async function biliDownloadPhase(ctx, isMain) {
  let fails = 0;
  while (_running && !_biliLoopAborted) {
    const pos = isMain ? ctx.mainPos : ctx.backfillPos;
    const endLimit = isMain ? ctx.totalSize : ctx.backfillBoundary;
    if (pos >= endLimit) break;
    const span = isMain ? ctx.spanBytes : Math.min(ctx.spanBytes, endLimit - pos);
    const end = Math.min(pos + span, endLimit) - 1;
    const r = await fetchRangeWithTimeout(ctx.urls, pos, end, 30000);
    if (!r.ok) {
      fails++;
      if (fails >= 5) {
        console.warn('[VocabRadar][asr-client][' + _ts() + '] ' + (isMain ? '主' : '回填') + '队列连续失败5次，终止该队列:', r.error || 'unknown');
        pushStatusLocal('bili-dl-fail', (isMain ? '主' : '回填') + '队列下载失败终止（已就绪部分不受影响）');
        break;
      }
      const waitMs = Math.min(30000, 1000 * Math.pow(2, fails));
      pushStatusLocal('bili-dl-retry', (isMain ? '主' : '回填') + '队列下载失败，' + Math.round(waitMs / 1000) + 's后重试（已就绪 ' + _biliDuration.toFixed(0) + 's 不受影响）');
      await new Promise((res) => setTimeout(res, waitMs));
      continue;
    }
    try {
      const advanced = await processBiliWindow(r.arrayBuffer, ctx, isMain);
      if (!advanced) {
        // 窗口内无完整片段（片段异常大）：加倍窗口重取同一起点
        ctx.spanBytes = Math.min(ctx.spanBytes * 2, 16 * 1024 * 1024);
        // 已到区间尾仍无完整片段：放弃推进避免死循环
        if (end >= endLimit - 1) {
          console.warn('[VocabRadar][asr-client][' + _ts() + '] 区间尾无完整片段，跳过剩余 ' + (endLimit - pos) + 'B');
          if (isMain) ctx.mainPos = endLimit; else ctx.backfillPos = endLimit;
        }
      } else {
        fails = 0;
      }
    } catch (e) {
      fails++;
      if (fails >= 5) {
        console.warn('[VocabRadar][asr-client][' + _ts() + '] 批次处理连续失败5次，终止该队列:', e.message || e);
        pushStatusLocal('bili-dl-fail', '批次解码失败终止(' + String(e.message || e).slice(0, 40) + ')');
        break;
      }
      console.warn('[VocabRadar][asr-client][' + _ts() + '] 批次处理失败，2s 后重试:', e.message || e);
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
}

/**
 * 处理一个后台窗口：扫盒找完整片段 → 解码 initBlock+连续片段 → 追加映射表
 * 第九十六次：主/回填两队列各自推进位置与媒体时间锚点；PCM 映射表有序插入见 appendBiliBatch。
 * @param {ArrayBuffer} ab 窗口数据（两队列起点均为片段边界/文件头，天然盒对齐）
 * @param {{mainPos:number,mainMediaTime:number,backfillPos:number,backfillMediaTime:number,totalSize:number}} ctx
 * @param {boolean} isMain 是否主队列
 * @returns {Promise<boolean>} 是否有完整片段被处理（false=需扩窗）
 */
async function processBiliWindow(ab, ctx, isMain) {
  const u8 = new Uint8Array(ab);
  const boxes = walkBoxes(ab);
  const compEnd = completePrefixEnd(boxes, 0);
  const fragsInComp = boxes.filter((b) => b.type === 'moof' && !b.truncated && b.end <= compEnd).map((b) => b.start);
  if (fragsInComp.length === 0) return false;
  const decEnd = compEnd; // 取全部完整内容（含末尾完整片段）
  const batch = await decodeBatchAnchored(u8.subarray(fragsInComp[0], decEnd), isMain ? ctx.mainMediaTime : ctx.backfillMediaTime);
  appendBiliBatch(batch, batch.mediaTime);
  if (isMain) {
    ctx.mainPos += decEnd;
    ctx.mainMediaTime = batch.mediaTime + batch.duration;
  } else {
    ctx.backfillPos += decEnd;
    ctx.backfillMediaTime = batch.mediaTime + batch.duration;
  }
  recordDlBytes(decEnd); // 第九十七次：下载速率统计
  // 下载进度推送节流：按百分比变化推（避免刷屏）
  const pos = isMain ? ctx.mainPos : ctx.backfillPos;
  const pct = Math.round((pos / ctx.totalSize) * 100);
  if (pct !== processBiliWindow._lastPct) {
    processBiliWindow._lastPct = pct;
    pushStatusLocal('bili-dl', (isMain ? '后台下载 ' : '回填 ') + pct + '%（就绪 ' + _biliDuration.toFixed(0) + 's）');
  }
  return true;
}
processBiliWindow._lastPct = -1;

/**
 * 解码一批片段为 16kHz PCM，并以 tfdt 校正媒体时间锚点
 * tfdt 连续性校验：与预期起点偏差 >0.25s 视为流中出现空洞（告警但仍以实际值为准，
 * 时间轴锚定首批 t0，空洞只影响该处字幕缺失，不会整体漂移）。
 * tfdt 缺失时退回调用方传入的累计时间（正常连续下载下两者应一致）。
 * @param {Uint8Array} fragU8 连续完整片段字节
 * @param {number} expectedMediaTime 预期起始媒体时间（秒）
 * @returns {Promise<{pcm:Float32Array,duration:number,mediaTime:number}>}
 */
async function decodeBatchAnchored(fragU8, expectedMediaTime) {
  let t0 = parseTfdtSeconds(fragU8, _biliTimescale);
  if (t0 === null || !isFinite(t0)) t0 = expectedMediaTime;
  else if (Math.abs(t0 - expectedMediaTime) > 0.25) {
    console.warn('[VocabRadar][asr-client][' + _ts() + '] tfdt 断裂: 期望 ' + expectedMediaTime.toFixed(2) + 's 实际 ' + t0.toFixed(2) + 's（流中存在空洞）');
  }
  const b = await decodeFmp4To16k(_biliInitBlock, fragU8);
  return { ...b, mediaTime: t0 };
}

/**
 * 解码「初始化块+连续片段」为 16kHz 单声道 PCM
 * init+任意连续完整片段=最小合法 fMP4，decodeAudioData 可独立解码（见 plan-streaming-asr.md）。
 * 注意 decodeAudioData 会接管传入 buffer，故每次拼接新副本，initBlock 本体不受影响。
 * @param {Uint8Array} initU8 初始化块
 * @param {Uint8Array} fragU8 片段数据
 * @returns {Promise<{pcm:Float32Array, duration:number}>} duration 为本批时长（秒）
 */
async function decodeFmp4To16k(initU8, fragU8) {
  const merged = new Uint8Array(initU8.length + fragU8.length);
  merged.set(initU8, 0);
  merged.set(fragU8, initU8.length);
  if (!_biliAudioCtx) {
    _biliAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  const audioBuffer = await _biliAudioCtx.decodeAudioData(merged.buffer);
  const pcm = await resampleTo16kMono(audioBuffer);
  return { pcm, duration: audioBuffer.duration };
}

/**
 * 重置流式状态（新一次准备前 / 停止时）
 */
function resetBiliStreamState() {
  _biliPcmMap = [];
  _biliPcmLen = 0;
  _biliDuration = 0;
  _biliStreamDone = false;
  processBiliWindow._lastPct = -1;
  // 第九十七次：下载计量随新一次准备重置（识别倍速跨准备保留更有参考性，仅清下载侧）
  _stats.dlBytes = 0; _stats.dlPending = 0; _stats.dlSpeedKBps = 0; _stats._lastDlTs = 0;
}

/**
 * 追加一批 PCM 到映射表并推进可用时长终点（第九十六次重写）
 * - 映射表按 mediaTime 升序插入（回填批次媒体时间小于主队列批次，倒序扫到插入点）；
 * - 与前一 entry 衔接处缺口 >0.25s 时插静音占位：时间轴保持连续可取样本，
 *   字幕在该区间自然为空而不是整体错位（修复旧版「流出现时间洞」后样本错位/丢失）；
 * - _biliDuration 只增不减（回填批次不得收缩终点，旧版会错误地把终点拉回去）。
 * @param {{pcm:Float32Array, duration:number, mediaTime:number}} batch
 */
function appendBiliBatch(batch, mediaTimeOverride) {
  const t0 = (mediaTimeOverride !== undefined) ? mediaTimeOverride : batch.mediaTime;
  if (!batch.pcm || batch.pcm.length === 0) return;
  let idx = _biliPcmMap.length;
  while (idx > 0 && _biliPcmMap[idx - 1].mediaTime > t0) idx--;
  if (idx > 0) {
    const prev = _biliPcmMap[idx - 1];
    if (prev.pcm) {
      const prevEnd = prev.mediaTime + prev.pcm.length / SAMPLE_RATE;
      const gap = t0 - prevEnd;
      if (gap > 0.25) {
        console.warn('[VocabRadar][asr-client][' + _ts() + '] 流空洞 ' + gap.toFixed(2) + 's（' + prevEnd.toFixed(2) + '→' + t0.toFixed(2) + '），插静音占位');
        _biliPcmMap.splice(idx, 0, { mediaTime: prevEnd, pcm: new Float32Array(Math.round(gap * SAMPLE_RATE)) });
        idx++;
      }
    }
  }
  _biliPcmMap.splice(idx, 0, { mediaTime: t0, pcm: batch.pcm });
  _biliPcmLen += batch.pcm.length;
  const batchEnd = t0 + batch.duration;
  if (batchEnd > _biliDuration) _biliDuration = batchEnd;
}

/**
 * 释放指定时刻之前的 PCM（第九十六次：内存控制）
 * 段识别成功且结果已入缓存后调用——字幕文本已持久化，原始 PCM 不再需要。
 * 跨界（部分覆盖 sec）的 entry 保留。pcm 置 null 但保留 entry 结构占位。
 * @param {number} sec 视频秒
 */
function releaseBiliPcmBelow(sec) {
  let freed = 0;
  for (const entry of _biliPcmMap) {
    if (!entry.pcm) continue;
    const eDur = entry.pcm.length / SAMPLE_RATE;
    if (entry.mediaTime + eDur <= sec + 0.01) {
      freed += entry.pcm.length;
      entry.pcm = null;
    }
  }
  if (freed > 0) _biliPcmLen -= freed;
}

/**
 * 按视频秒区间取 PCM 样本（跨批次拼接）
 * 第九十六次：映射表按 mediaTime 升序；pcm=null 的已释放 entry 跳过（该区间返回零填充，
 * 仅发生在重复识别场景，正常流程先取样本后释放不冲突）。
 * @param {number} startSec 起始（含）
 * @param {number} endSec 结束（不含）
 * @returns {Float32Array|null} 无覆盖返回 null
 */
function getSamplesForRange(startSec, endSec) {
  const sr = SAMPLE_RATE;
  let out = null, filled = 0;
  for (const entry of _biliPcmMap) {
    if (!entry.pcm) continue;
    const eDur = entry.pcm.length / sr;
    const eEnd = entry.mediaTime + eDur;
    if (eEnd <= startSec) continue;
    if (entry.mediaTime >= endSec) break;
    const from = Math.max(startSec, entry.mediaTime);
    const to = Math.min(endSec, eEnd);
    if (to <= from) continue;
    const s0 = Math.floor((from - entry.mediaTime) * sr);
    const s1 = Math.ceil((to - entry.mediaTime) * sr);
    const piece = entry.pcm.subarray(s0, s1);
    if (!out) out = new Float32Array(Math.ceil((endSec - startSec) * sr));
    out.set(piece, filled);
    filled += piece.length;
    if (filled >= out.length) break;
  }
  if (!out || filled === 0) return null;
  return filled === out.length ? out : out.subarray(0, filled);
}

// === P2（第一百零七次）：内容脚本同源下载通道 ===
// SW fetch 的 referer 是扩展来源，可能被 B站 CDN 拒绝（调研文档 H2）；
// 内容脚本发起的请求 referer/Origin 与播放器自身 MSE 取流完全一致。
// 连续失败 ≥2 次本会话改走 SW 通道，成功即复位计数。
let _contentChanFails = 0;

/** 内容脚本直连 Range 拉取（fetch 于内容脚本世界，页面 origin） */
async function contentRangeFetch(urls, start, end, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let lastErr = 'unknown';
    for (const u of urls) {
      if (ctrl.signal.aborted) break;
      try {
        const res = await fetch(u, { headers: { Range: 'bytes=' + start + '-' + end }, credentials: 'omit', signal: ctrl.signal });
        if (res.status === 206) {
          const ab = await res.arrayBuffer();
          clearTimeout(timer);
          return { ok: true, arrayBuffer: ab };
        }
        try { if (res.body) await res.body.cancel(); } catch (e) { /* ignore */ }
        lastErr = 'HTTP ' + res.status;
      } catch (e) {
        if (ctrl.signal.aborted) { lastErr = '超时(' + Math.round(timeoutMs / 1000) + 's)'; break; }
        lastErr = String(e && e.message || e);
      }
    }
    clearTimeout(timer);
    return { ok: false, error: lastErr };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: String(e && e.message || e) };
  }
}

/** 内容脚本直连整文件拉取（legacy 回退的 P2 前置尝试） */
async function contentWholeFetch(urls, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let lastErr = 'unknown';
    for (const u of urls) {
      if (ctrl.signal.aborted) break;
      try {
        const res = await fetch(u, { credentials: 'omit', signal: ctrl.signal });
        if (res.ok) {
          const ab = await res.arrayBuffer();
          clearTimeout(timer);
          return { ok: true, arrayBuffer: ab };
        }
        try { if (res.body) await res.body.cancel(); } catch (e) { /* ignore */ }
        lastErr = 'HTTP ' + res.status;
      } catch (e) {
        if (ctrl.signal.aborted) { lastErr = '超时(' + Math.round(timeoutMs / 1000) + 's)'; break; }
        lastErr = String(e && e.message || e);
      }
    }
    clearTimeout(timer);
    return { ok: false, error: lastErr };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: String(e && e.message || e) };
  }
}

/**
 * Range 下载（SW 代理）+ 超时包装
 * 第九十六次：urls 为 [主URL, ...backupUrl]，SW 依序尝试（借鉴 videoseek/bilibili-evolved 多源回退）。
 * 第一百零七次 P2：优先内容脚本同源通道（短超时），失败自动落 SW 中继；只接受 206 的约束两通道一致。
 * @param {string[]} urls 候选 URL 列表
 * @param {number} start 起始字节（含）
 * @param {number} end 结束字节（含）
 * @param {number} timeoutMs 超时毫秒
 * @returns {Promise<{ok:boolean,arrayBuffer?:ArrayBuffer,error?:string}>}
 */
function fetchRangeWithTimeout(urls, start, end, timeoutMs) {
  return (async () => {
    if (_contentChanFails < 2) {
      const c = await contentRangeFetch(urls, start, end, Math.min(15000, timeoutMs));
      if (c.ok) {
        _contentChanFails = 0;
        return c;
      }
      _contentChanFails++;
      pushStatusLocal('diag', '内容通道失败(' + String(c.error || '').slice(0, 40) + ')，转SW通道');
    }
    return Promise.race([
      sendMessage({ type: 'FETCH_AUDIO_RANGE', url: urls[0], urls, start, end }),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'range超时(' + Math.round(timeoutMs / 1000) + 's)' }), timeoutMs))
    ]);
  })();
}

/**
 * 整文件旧路径（保留为回退）：全量下载→解码→单批入映射表。
 * 行为与 2026-07-04 版一致；流式链路任何环节失败都落到这里，保证功能不倒退。
 * 第九十六次：支持多候选 URL；闸门同样生效（识别循环共用）。
 * @param {string[]} urls 音频 URL 列表
 * @param {HTMLVideoElement} videoEl
 * @returns {Promise<{startSec:number,totalRecogSegs:number}|null>}
 */
async function legacyPrepareFromUrl(urls, videoEl) {
  pushStatusLocal('bili-download', '下载音频文件...');
  console.log('[VocabRadar][asr-client][' + _ts() + '] B站路径：请求 SW 下载音频(整文件)');
  // 第一百零七次 P2：先试内容脚本同源整文件（referer 正确），失败再走 SW 中继。
  const dlResp = await (async () => {
    if (_contentChanFails < 2) {
      const c = await contentWholeFetch(urls, 110000);
      if (c.ok) {
        _contentChanFails = 0;
        pushStatusLocal('bili-download-ok', '同源整文件 ' + Math.round(c.arrayBuffer.byteLength / 1024) + 'KB');
        return c;
      }
      _contentChanFails++;
      console.warn('[VocabRadar][asr-client][' + _ts() + '] 同源整文件失败，转SW:', c.error);
    }
    return Promise.race([
      sendMessage({ type: 'FETCH_AUDIO', url: urls[0], urls }),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: '下载超时(120s)' }), 120000))
    ]);
  })();
  if (!dlResp || !dlResp.ok || !dlResp.arrayBuffer) {
    console.warn('[VocabRadar][asr-client][' + _ts() + '] B站路径：音频下载失败', dlResp?.error);
    pushStatusLocal('bili-download-fail', '音频下载失败: ' + (dlResp?.error || 'unknown'));
    return null;
  }
  pushStatusLocal('bili-download-ok', '音频下载完成 ' + Math.round(dlResp.arrayBuffer.byteLength / 1024) + 'KB');

  pushStatusLocal('bili-decode', '解码音频...');
  try {
    if (!_biliAudioCtx) {
      _biliAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const audioBuffer = await _biliAudioCtx.decodeAudioData(dlResp.arrayBuffer);
    pushStatusLocal('bili-decode-ok', '解码完成 duration=' + audioBuffer.duration.toFixed(1) + 's channels=' + audioBuffer.numberOfChannels);

    resetBiliStreamState();
    const pcm = await resampleTo16kMono(audioBuffer);
    // 整文件解码：媒体时间 0 即视频时间 0，单批入表
    appendBiliBatch({ pcm, duration: audioBuffer.duration, mediaTime: 0 }, 0);
    _biliStreamDone = true;
    pushStatusLocal('bili-pcm', 'PCM 就绪 samples=' + _biliPcmLen + ' duration=' + _biliDuration.toFixed(1) + 's');
  } catch (e) {
    console.warn('[VocabRadar][asr-client][' + _ts() + '] B站路径：音频解码失败:', e);
    pushStatusLocal('bili-decode-fail', '解码失败: ' + String(e.message || e));
    return null;
  }

  const startSec = Math.floor(((isFinite(videoEl.currentTime)) ? videoEl.currentTime : 0) / _cacheSegmentSec) * _cacheSegmentSec;
  const totalRecogSegs = Math.ceil(_biliDuration / _segmentSec);
  console.log('[VocabRadar][asr-client][' + _ts() + '] B站路径(整文件回退)：从 ' + startSec + 's 开始，共 ' + totalRecogSegs + ' 段');
  pushStatusLocal('bili-start', '从' + startSec + 's开始识别（共' + totalRecogSegs + '段×' + _segmentSec + 's）');
  return { startSec, totalRecogSegs };
}

/**
 * B站预识别循环（第九十六次重写）：主方向 startSec→EOF，完成后回填 0→startSec。
 * - 播放闸门：_recogFrontier 跟随已识别终点推进并推 'gate' 状态，
 *   sidebar 据此暂停/续播——字幕永远≥播放位置（修复「落后几十秒」）。
 * - 段识别失败重试 ×2（修复旧版 60s 超时直接跳过丢段）。
 * - 识别成功后释放该段 PCM（内存控制）。
 * @param {number} startSec - 起始视频时间（秒，缓存段对齐）
 * @param {number} totalRecogSegs - 总识别段数
 */
async function biliRecognizeLoop(startSec, totalRecogSegs) {
  const startSegIdx = Math.floor(startSec / _segmentSec);
  // 反思（2026-07-09）：增量识别——跳过已监听段，只识别未监听内容。
  const listenedRanges = (_cache && _cache.segments && _cache.segments.length > 0)
    ? mergeRanges(_cache.segments.map((s) => ({ start: s.listenStart, end: s.listenEnd })))
    : [];
  let skipped = 0;
  // 主方向：startSegIdx → EOF
  for (let i = startSegIdx; i < totalRecogSegs; i++) {
    if (_biliLoopAborted || !_running) break;
    const ok = await recognizeBiliSegment(i, totalRecogSegs, listenedRanges);
    if (ok === null) break;                       // 中止
    if (ok === 'skipped') {
      skipped++;
      // 缓存命中的段视为已识别：前沿照常推进（闸门不放行未覆盖区域）
      advanceFrontier((i + 1) * _segmentSec);
    }
  }

  // 回填方向：0 → startSegIdx（第九十六次：主方向完成后自动补齐开头，
  //   全片字幕完整，「拖回点击前的位置也有字幕」；增量缓存自动跳过已听段）
  if (_running && !_biliLoopAborted && startSegIdx > 0) {
    pushStatusLocal('bili-backfill-recog', '回填识别开头 0→' + startSegIdx * _segmentSec + 's');
    for (let i = 0; i < startSegIdx; i++) {
      if (_biliLoopAborted || !_running) break;
      const ok = await recognizeBiliSegment(i, totalRecogSegs, listenedRanges);
      if (ok === null) break;
      if (ok === 'skipped') skipped++;
    }
  }

  if (skipped > 0) {
    console.log('[VocabRadar][asr-client][' + _ts() + '] 增量识别: 跳过已监听 ' + skipped + ' 段');
  }

  // 识别结束，保存缓存
  if (_cacheAsr && _cache) {
    saveCache(_currentVideoKey, _cache);
    _lastSavedTotalListened = _cache.totalListened;
  }

  if (!_biliLoopAborted && _running) {
    // 第九十六次：全部完成——解除播放闸门
    _recogDoneAll = true;
    pushStatusLocal('gate-done', '全部识别完成，闸门解除', { frontier: Infinity });
    pushStatusLocal('bili-done', '所有段识别完成');
    console.log('[VocabRadar][asr-client][' + _ts() + '] B站识别循环完成');
  }
}

/**
 * 推进主方向识别前沿并通知 sidebar（节流：每段一次即可）
 * 第九十七次：gate 消息附带 readyDur/dlSpeedKBps/recSpeedX，sidebar 进度条同步展示
 * 「前沿｜缓冲｜下载速率｜识别倍速」。
 * @param {number} sec 已识别终点（视频秒）
 */
function advanceFrontier(sec) {
  if (sec > _recogFrontier) {
    _recogFrontier = sec;
    pushStatusLocal('gate', '', {
      frontier: _recogFrontier,
      readyDur: _biliDuration,
      dlSpeedKBps: Math.round(_stats.dlSpeedKBps),
      recSpeedX: Math.round(_stats.recSpeedX * 10) / 10
    });
  }
}

/**
 * 累计下载字节并结算速率（EWMA，≥1s 结算一次；第九十七次）
 * @param {number} n 本次实际消费字节
 */
function recordDlBytes(n) {
  const now = performance.now();
  _stats.dlBytes += n;
  _stats.dlPending += n;
  if (!_stats._lastDlTs) { _stats._lastDlTs = now; return; }
  const dt = (now - _stats._lastDlTs) / 1000;
  if (dt >= 1) {
    const kbps = (_stats.dlPending / 1024) / dt;
    _stats.dlSpeedKBps = _stats.dlSpeedKBps ? (_stats.dlSpeedKBps * 0.6 + kbps * 0.4) : kbps;
    _stats.dlPending = 0;
    _stats._lastDlTs = now;
  }
}

/**
 * 识别单个 B站段（第九十六次抽出复用：主方向与回填共用）
 * @param {number} i 段序号
 * @param {number} totalRecogSegs 总段数（进度显示）
 * @param {Array<{start,end}>} listenedRanges 增量缓存范围
 * @returns {Promise<boolean|'skipped'|null>} true=识别成功；'skipped'=缓存命中跳过；null=中止
 */
async function recognizeBiliSegment(i, totalRecogSegs, listenedRanges) {
  const segStart = i * _segmentSec;
  // 等待本段 PCM 就绪：优先按样本可用性判断（回填区间不能看 _biliDuration），
  // 下载终结（EOF/失败/中止）后不再等待。
  while (_running && !_biliLoopAborted && !_biliStreamDone) {
    const readyPcm = getSamplesForRange(segStart, segStart + _segmentSec);
    if (readyPcm && readyPcm.length >= (Math.min(segStart + _segmentSec, _biliDuration) - segStart) * SAMPLE_RATE * 0.99) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (_biliLoopAborted || !_running) return null;
  let segEnd = segStart + _segmentSec;
  if (segEnd > _biliDuration) {
    if (segStart >= _biliDuration - 0.01) return 'skipped'; // 已超出实际音频末尾（估算段数偏大）
    segEnd = _biliDuration;                                  // 末段截短到实际可用终点
  }

  // 跳过已监听段（增量识别核心）
  if (isInRange(segStart, segEnd, listenedRanges)) return 'skipped';

  // 提取 [segStart,segEnd) 的 PCM（流式映射表按媒体时间跨批拼接）
  const pcm = getSamplesForRange(segStart, segEnd);
  if (!pcm || pcm.length === 0) {
    console.warn('[VocabRadar][asr-client][' + _ts() + '] 段 ' + segStart.toFixed(0) + '-' + segEnd.toFixed(0) + 's 无 PCM 可用，跳过');
    return 'skipped';
  }
  pushStatusLocal('bili-seg', '段' + i + ': ' + segStart.toFixed(0) + 's-' + segEnd.toFixed(0) + 's',
    { segIdx: i, totalSegs: totalRecogSegs, segStart, segEnd });

  // 发送 offscreen 识别；失败重试 ×2（修复旧版超时即永久丢段）
  // 第九十七次：成功后按墙钟时长结算识别倍速（EWMA），驱动闸门自适应滞回与同步展示
  const t0Wall = performance.now();
  let response = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (_biliLoopAborted || !_running) return null;
    if (attempt > 0) pushStatusLocal('bili-seg-retry', '段' + i + ' 第' + attempt + '次重试', { segIdx: i, totalSegs: totalRecogSegs });
    response = await sendSegmentAndWait(pcm, segStart, segEnd);
    if (response) break;
    if (_biliLoopAborted || !_running) return null;
  }

  if (!response) {
    pushStatusLocal('bili-seg-skip', '段' + i + ' 重试后仍失败，跳过', { segIdx: i, totalSegs: totalRecogSegs });
    return true;
  }

  // 识别倍速 = 媒体时长 / 墙钟耗时（含模型加载/排队，首段偏低随后 EWMA 收敛）
  const wallSec = Math.max(0.001, (performance.now() - t0Wall) / 1000);
  const mediaSec = Math.max(0.001, segEnd - segStart);
  const instX = Math.min(100, mediaSec / wallSec);
  _stats.recSpeedX = _stats.recSpeedX ? (_stats.recSpeedX * 0.7 + instX * 0.3) : instX;

  pushStatusLocal('bili-seg-ok', '段' + i + ' 识别完成: ' + (response.text || '(空)').slice(0, 50),
    { segIdx: i, totalSegs: totalRecogSegs });
  // 主方向成功：推进前沿 + 释放已持久化段的 PCM
  if (i >= Math.floor(_recogFrontier / _segmentSec) || segEnd > _recogFrontier) {
    advanceFrontier(segEnd);
  }
  releaseBiliPcmBelow(segEnd);
  return true;
}

/**
 * 发送音频段到 offscreen 并等待 ASR_SEGMENT 响应
 * @param {Float32Array} pcm - 16kHz 单声道 PCM
 * @param {number} videoStart - 段起始视频时间（秒）
 * @param {number} videoEnd - 段结束视频时间（秒）
 * @returns {Promise<object|null>} ASR_SEGMENT 响应，停止时返回 null
 */

// 反思（2026-08-16 第七十次）：紧凑 ArrayBuffer（4 字节/采样）传输音频段，绕开
//   sendMessage 64MiB 上限；offscreen 接收端已支持 ArrayBuffer。pcm 为共享父 buffer
//   的视图（subarray）时只取视图区间，避免整块父 buffer 一起发送。
// 反思（第九十八次实测复发）：samples=0 再现——ArrayBuffer 经 chrome.runtime 双跳
//   （content→SW→offscreen）的结构化克隆在部分环境不可靠（offscreen.js 头注同款历史 bug）。
//   新增 float32ToBase64 可靠字符串通道：发送端同时携带 audio + audioB64，
//   接收端优先快路径、失效自动落 base64。
function pcmToArrayBuffer(pcm) {
  if (pcm instanceof Float32Array) {
    if (pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength) return pcm.buffer;
    return pcm.slice().buffer;
  }
  return new Float32Array(pcm).buffer;
}

/**
 * Float32Array → base64（第九十八次：跨 SW 中继的可靠音频通道）
 * 分块 String.fromCharCode 避免 apply 栈溢出；1.9MB 段编码约几十 ms，可接受。
 * @param {Float32Array} pcm
 * @returns {string}
 */
function float32ToBase64(pcm) {
  const u8 = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
  }
  return btoa(bin);
}
function sendSegmentAndWait(pcm, videoStart, videoEnd) {
  return new Promise((resolve) => {
    // 反思（2026-07-09）：用户反馈"asr开头识别出结果，后续没了"。
    //   根因：旧版无超时，offscreen 识别失败/无响应时 _pendingResolve 永不调用，
    //   biliRecognizeLoop 死锁在该段，后续段不再识别。
    //   修正：加 60 秒超时，超时 resolve(null) 跳过该段继续下一段。
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      _pendingResolve = null;
      console.warn('[VocabRadar][asr-client][' + _ts() + '] 段识别超时(60s), 跳过: ' + videoStart + 's-' + videoEnd + 's');
      resolve(null);
    }, 60000);
    _pendingResolve = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(msg);
    };
    // 反思（2026-07-04）：旧版用 merged.buffer（ArrayBuffer）发送，经 MV3 SW 中继丢失。
    // 反思（2026-08-16 第七十次）：为绕过 64MiB 消息上限，曾改用 Array.from 普通数字数组；
    //   但普通数组每采样序列化开销大，长段（如 B站 60s 段）仍可能逼近/超限。
    //   现 offscreen 接收端已支持 ArrayBuffer（new Float32Array(msg.audio)），
    //   改回紧凑 ArrayBuffer（4 字节/采样）；pcm 为共享父 buffer 视图时仅取本段区间。
    sendMessage({
      type: 'ASR_AUDIO_SEGMENT',
      videoKey: _currentVideoKey,
      start: videoStart,       // 视频相对秒数
      end: videoEnd,           // 视频相对秒数
      audio: pcmToArrayBuffer(pcm),
      audioB64: float32ToBase64(pcm), // 第九十八次：可靠通道，ArrayBuffer 中继丢失时兜底
      returnTimestamps: true   // 请求 chunk 级时间戳
    }).catch((e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      _pendingResolve = null;
      console.warn('[VocabRadar][asr-client][' + _ts() + '] 发送段失败:', e);
      resolve(null);
    });
  });
}

// === captureStream 回退路径 ===

/**
 * 启动 captureStream + ScriptProcessorNode 直接 PCM 采集（非 B站回退路径）
 *
 * 反思（2026-07-05）：
 *   1. MediaRecorder.start(timeslice) 产出的 webm/opus chunk，仅首段含容器头。
 *      后续段无头导致 decodeAudioData 抛 EncodingError（用户日志可见）。
 *   2. 改用 AudioContext + ScriptProcessorNode 直接提取原始 PCM，跳过编码/解码。
 *      ScriptProcessorNode 虽已废弃但仍可靠工作；AudioWorklet 是现代替代但需额外 worklet 文件。
 *   3. 段长由 setInterval 定时器控制（_segmentSec），音频完整无间隙。
 *   4. 识别段长 = _segmentSec(10s)，缓存段长 = _cacheSegmentSec(60s)。
 *
 * 设计原则：音频收集与识别分离——收集不等模型就绪。
 * @param {HTMLVideoElement} videoEl
 */
async function startFallbackCapture(videoEl) {
  if (typeof videoEl.captureStream !== 'function') {
    throw new Error('video.captureStream() 不可用（浏览器不支持）');
  }

  const stream = videoEl.captureStream();
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks || audioTracks.length === 0) {
    throw new Error('captureStream 无音频轨（可能 CORS 限制或无音轨）');
  }

  // 仅取音频轨
  _recorderStream = new MediaStream(audioTracks);
  if (!_fallbackAudioCtx) {
    _fallbackAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // AudioContext 在 Chrome 中默认 suspended，需用户手势后 resume() 才能处理音频。
  // ASR 由用户点击启动，此时有手势上下文，resume() 可生效。
  if (_fallbackAudioCtx.state === 'suspended') {
    console.log('[VocabRadar][asr-client][' + _ts() + '] AudioContext suspended，尝试 resume...');
    try { await _fallbackAudioCtx.resume(); } catch (e) { /* ignore */ }
  }
  console.log('[VocabRadar][asr-client][' + _ts() + '] AudioContext state:', _fallbackAudioCtx.state, 'sampleRate:', _fallbackAudioCtx.sampleRate);

  // 反思（2026-07-09 四次修复）：迁移到 AudioWorklet，替换废弃的 ScriptProcessorNode。
  //   AudioWorklet 在独立的音频线程运行，不受主线程阻塞/标签页后台影响，
  //   解决「过一会全是静音」问题（旧 ScriptProcessorNode onaudioprocess 在主线程，
  //   被挂起后 _fallbackPcmBuffer 恒空）。
  //   加载 worklet 处理器模块（通过 chrome.runtime.getURL 访问扩展资源）。
  const workletUrl = chrome.runtime.getURL('src/lib/asr-worklet-processor.js');
  await _fallbackAudioCtx.audioWorklet.addModule(workletUrl);
  console.log('[VocabRadar][asr-client][' + _ts() + '] AudioWorklet 模块已加载:', workletUrl);

  // 创建 MediaStreamSource + AudioWorkletNode 提取 PCM
  _fallbackSourceNode = _fallbackAudioCtx.createMediaStreamSource(_recorderStream);
  // AudioWorkletNode：1 输入 1 输出，单声道。worklet 在音频线程持续采集 PCM。
  _fallbackProcessor = new AudioWorkletNode(_fallbackAudioCtx, 'asr-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    outputChannelCount: [1]
  });
  // 反思（2026-07-05）：直接连 destination 会导致音频回声（扬声器播放采集到的声音）。
  // 改用零增益 GainNode 中转：processor → gainNode(gain=0) → destination。
  // 必须连 destination 才能驱动 AudioWorklet 的 process()，但 gain=0 不输出声音。
  const _silenceGain = _fallbackAudioCtx.createGain();
  _silenceGain.gain.value = 0;

  _fallbackPcmBuffer = [];
  _fallbackPcmLength = 0;
  _fallbackSegCount = 0;
  _fallbackVideoEl = videoEl;
  // 反思（2026-07-09 #47）：用户要求「按照参数段落自动吸附，例如视频3秒处才开始点击识别，
  //   应当模型加载完成后移动到0秒录音」。
  //   旧版 _fallbackVideoStart = videoEl.currentTime（如 3s），导致 0-3s 内容未识别。
  //   修正：snap 到 _segmentSec 段起始（3s → 0s，15s → 10s），
  //   AudioWorklet 连接完成后 seek 视频到段起始，确保整段内容被录制。
  const clickedTime = (isFinite(videoEl.currentTime)) ? videoEl.currentTime : 0;
  const segSnapStart = Math.floor(clickedTime / _segmentSec) * _segmentSec;
  _fallbackVideoStart = segSnapStart;

  // AudioWorklet 通过 port.postMessage 发送 PCM 块（每 4096 帧一次）
  // worklet 在音频线程运行，不受主线程阻塞影响
  _fallbackProcessor.port.onmessage = (e) => {
    if (!_running) return;
    // e.data 是 Float32Array（worklet 已复制，无需再复制）
    _fallbackPcmBuffer.push(e.data);
    _fallbackPcmLength += e.data.length;
  };

  // 连接：source → processor(AudioWorkletNode) → silenceGain(0) → destination
  _fallbackSourceNode.connect(_fallbackProcessor);
  _fallbackProcessor.connect(_silenceGain);
  _silenceGain.connect(_fallbackAudioCtx.destination);

  // 自动吸附：模型加载完成后 seek 视频到段起始，确保整段内容被录制
  //   反思（2026-07-09 #47）：用户在 3s 点击识别，模型加载耗时数秒，
  //   加载完成时视频已播放到 5-6s，0-3s 内容丢失。seek 回段起始确保完整录制。
  if (segSnapStart < clickedTime) {
    try {
      videoEl.currentTime = segSnapStart;
      console.log('[VocabRadar][asr-client][' + _ts() + '] 自动吸附：从 ' + clickedTime.toFixed(1) + 's seek 到段起始 ' + segSnapStart + 's');
      pushStatusLocal('fallback-snap', '自动吸附到 ' + segSnapStart + 's（从 ' + clickedTime.toFixed(1) + 's 回退）');
    } catch (e) {
      console.warn('[VocabRadar][asr-client][' + _ts() + '] 自动吸附 seek 失败:', e.message);
    }
  }

  // 段截取定时器：每 _segmentSec 秒取走累积的 PCM，录制不中断
  _fallbackTimer = setInterval(() => {
    if (!_running) return;
    // 反思（2026-07-09）：用户反馈"fallback-paused 日志一直出现，时间为啥那么长还一直暂停"。
    //   根因：闭包捕获的 videoEl 在 SPA 换集后引用失效（旧 video 已移出 DOM），
    //   失效元素 paused 恒为 true → 每段都推 fallback-paused 刷屏。
    //   修正：每次回调重新查找当前活动 video 元素（document.querySelector('video')），
    //   闭包 videoEl 失效（!isConnected）时用新查到的；并状态去重（_wasFallbackPaused），
    //   只在暂停/恢复状态变化时推一次日志，不再每段刷屏。
    const curVideo = (videoEl && videoEl.isConnected) ? videoEl : (document.querySelector('video') || videoEl);
    const paused = curVideo ? curVideo.paused : true;
    // 反思（2026-07-22）：用户反馈「显示『视频暂停，等待恢复后继续识别』，但恢复不了」。
    //   根因：_fallbackPlayHandler 绑在闭包 videoEl 上，SPA 换集后 video 元素被替换，
    //   新 video 的 'play' 事件无人监听，AudioContext 无法 resume，导致 fallback-paused 后无法恢复。
    //   修正：每次 setInterval 回调检测当前活动 video，若与 _fallbackVideoEl 不同，
    //   1) 解绑旧 video 上的 play 监听；2) 绑定新 video 的 play 监听（resume AudioContext）；
    //   3) 更新 _fallbackVideoEl 引用。这样换集后新视频播放时 AudioContext 仍能被 resume。
    if (curVideo && curVideo !== _fallbackVideoEl) {
      if (_fallbackVideoEl && _fallbackPlayHandler) {
        try { _fallbackVideoEl.removeEventListener('play', _fallbackPlayHandler); } catch (e) { /* ignore */ }
      }
      _fallbackVideoEl = curVideo;
      if (_fallbackPlayHandler) {
        try { curVideo.addEventListener('play', _fallbackPlayHandler); } catch (e) { /* ignore */ }
      }
    }
    // 反思（2026-08-09 第九次）：用户反馈"视频播放完成暂停后，fallback-paused 一直出现"。
    //   根因：视频结束后 paused=true 且 ended=true，setInterval 持续运行，
    //   每段都进入 paused 分支。_wasFallbackPaused 仅去重日志，但进度条仍显示"暂停"状态。
    //   修正：视频 ended 时停止采集定时器，推送 fallback-done 状态，不再循环。
    // 反思（2026-08-09 第十次）：用户反馈"视频播放完成我暂停了，但日志仍显示 fallback-paused"。
    //   根因：部分视频播放器 ended 属性不可靠（B站/YouTube 自定义播放器可能不设 ended=true），
    //   仅 paused=true，导致走入 fallback-paused 分支。
    //   修正：增加接近末尾检测（currentTime >= duration - 1），视为已结束；
    //   同时刷新剩余 PCM 缓冲，避免最后几秒音频丢失。
    if (paused) {
      const dur = curVideo ? curVideo.duration : NaN;
      const curTime = curVideo ? curVideo.currentTime : 0;
      // 视频已结束：ended 属性为 true，或 currentTime 已接近 duration（末尾 1 秒内）
      const isEnded = (curVideo && curVideo.ended) ||
        (isFinite(dur) && dur > 0 && isFinite(curTime) && curTime >= dur - 1);
      if (isEnded) {
        // 刷新剩余 PCM（最后一段可能不足 _segmentSec，但仍有音频数据）
        if (_fallbackPcmBuffer.length > 0 && _fallbackPcmLength > 0) {
          const remainChunks = _fallbackPcmBuffer;
          const remainLen = _fallbackPcmLength;
          const remainStart = _fallbackVideoStart;
          _fallbackPcmBuffer = [];
          _fallbackPcmLength = 0;
          processFallbackSegment(remainChunks, remainLen, remainStart).catch((e) => {
            console.warn('[VocabRadar][asr-client][' + _ts() + '] 结束时刷新剩余 PCM 失败:', e);
          });
        }
        if (_fallbackTimer) { clearInterval(_fallbackTimer); _fallbackTimer = null; }
        _wasFallbackPaused = false;
        const totalSegs = (isFinite(dur) && dur > 0) ? Math.ceil(dur / _segmentSec) : 0;
        pushStatusLocal('fallback-done', '视频已结束，停止采集',
          { segIdx: _fallbackSegCount, totalSegs, segStart: _fallbackVideoStart, segEnd: _fallbackVideoStart, duration: dur || 0 });
        return;
      }
      _fallbackPcmBuffer = [];
      _fallbackPcmLength = 0;
      // 第一百二十六次（用户反馈"ASR 字幕时间戳错误"）：部分窗口暂停对齐——
      // 旧版整窗丢弃且不推进 _fallbackVideoStart，但视频在暂停前已实际播放了 n 秒，
      // 该 n 秒从未入账 → 之后所有段的时间戳整体偏早 n 秒。
      // 修正：按视频真实前进量推进段起点（仅本窗口内的推进量，clamp 防异常跳变）。
      {
        const progressed = Math.max(0, curTime - _fallbackVideoStart);
        if (progressed > 0.25 && progressed <= _segmentSec * 2) {
          pushStatusLocal('fallback-skip',
            'partial-window advanced ' + progressed.toFixed(1) + 's (paused drop), timeline aligned',
            { segIdx: _fallbackSegCount, segStart: _fallbackVideoStart, segEnd: _fallbackVideoStart + progressed });
          _fallbackVideoStart += progressed;
        }
      }
      if (!_wasFallbackPaused) {
        _wasFallbackPaused = true;
        // 第一百零二次：文案如实标注依赖关系与成因（用户质疑"识别为何依赖播放"——
        // 仅直连不可用落入本回退时才会出现；根因定位靠时间线的 bili-none/bili-stream-fail 行）
        pushStatusLocal('fallback-paused', '回退实时模式：识别跟随播放（直连下载不可用），视频暂停即暂停');
      }
      // 视频暂停时 AudioContext 可能因浏览器策略被挂起，
      // 主动尝试 resume（无副作用，AudioContext 在 paused 状态下 resume 是 no-op），
      // 确保恢复播放后 AudioContext 已处于 running 状态。
      if (_fallbackAudioCtx && _fallbackAudioCtx.state !== 'running') {
        _fallbackAudioCtx.resume().catch(() => {});
      }
      return;
    }
    if (_wasFallbackPaused) {
      _wasFallbackPaused = false;
      pushStatusLocal('fallback-resumed', '视频恢复，继续识别');
    }
    // PCM 缓冲为空时仍推进段计数（AudioContext 可能被挂起，但不跳过时间段）
    // 反思（2026-07-28 #需求1）：用户要求"录音且识别才算片段成功，光录音不可"。
    //   silent 段无 PCM，未真正录音，不应标记为已识别，下次启动 ASR 时仍需重识该段。
    if (_fallbackPcmBuffer.length === 0) {
      // AudioContext 可能被挂起（标签页后台），尝试恢复
      if (_fallbackAudioCtx && _fallbackAudioCtx.state !== 'running') {
        console.warn('[VocabRadar][asr-client][' + _ts() + '] AudioContext ' + _fallbackAudioCtx.state + '，尝试 resume');
        _fallbackAudioCtx.resume().catch(() => {});
      }
      const segStart = _fallbackVideoStart;
      // 暂停/无音频时按段长推进时间，不用 currentTime（可能未变）
      _fallbackVideoStart = segStart + _segmentSec;
      _fallbackSegCount++;
      const dur = curVideo ? curVideo.duration : NaN;
      const totalSegs = (isFinite(dur) && dur > 0) ? Math.ceil(dur / _segmentSec) : 0;
      pushStatusLocal('fallback-silent', '段 ' + _fallbackSegCount + ' 无 PCM（AudioContext 可能挂起）',
        { segIdx: _fallbackSegCount, totalSegs, segStart, segEnd: _fallbackVideoStart, duration: dur || 0 });
      return;
    }
    // 取出累积的 PCM
    const pcmChunks = _fallbackPcmBuffer;
    const pcmLength = _fallbackPcmLength;
    const segStart = _fallbackVideoStart;
    _fallbackPcmBuffer = [];
    _fallbackPcmLength = 0;
    // 反思（2026-07-05）：用户反馈"字幕位置错误，仍然漂浮"。
    // 旧版用 videoEl.currentTime 做 segEnd，但用户 seek 后 currentTime 跳转，
    // 导致段时间戳与实际音频位置不匹配。
    // 修正：用实际 PCM 时长计算 segEnd，确保时间戳连续且与音频内容匹配。
    // 同时检测 seek：若 currentTime 与预期偏差超过 5 秒，重置到 currentTime。
    const actualDuration = pcmLength / _fallbackAudioCtx.sampleRate;
    let segEnd = segStart + actualDuration;
    const expectedCur = segEnd;
    const curTime = curVideo ? curVideo.currentTime : expectedCur;
    const actualCur = isFinite(curTime) ? curTime : expectedCur;
    // 视频暂停时不做 seek 检测：currentTime 停在暂停位置，与 expectedCur 必然偏差，
    // 会被误判为 seek 并把 _fallbackVideoStart 重置回暂停位置，导致段 0-10s 无限重复。
    // 仅在视频正在播放时检测 seek（用户拖动进度条导致的 currentTime 跳变）。
    if (!paused && Math.abs(actualCur - expectedCur) > 5) {
      // seek 检测：偏差 >5s 说明用户拖动了进度条，重置到当前位置
      console.log('[VocabRadar][asr-client][' + _ts() + '] seek 检测: expected=' + expectedCur.toFixed(1) + 's actual=' + actualCur.toFixed(1) + 's，重置');
      segEnd = actualCur;
    }
    _fallbackVideoStart = segEnd;
    _fallbackSegCount++;
    const dur2 = curVideo ? curVideo.duration : NaN;
    const totalSegs = (isFinite(dur2) && dur2 > 0) ? Math.ceil(dur2 / _segmentSec) : 0;
    pushStatusLocal('fallback-seg', '音频段 ' + _fallbackSegCount + ' ' + Math.round(actualDuration) + 's',
      { segIdx: _fallbackSegCount, totalSegs, segStart, segEnd, duration: dur2 || 0 });
    // 异步处理（不阻塞定时器，采集继续）
    processFallbackSegment(pcmChunks, pcmLength, segStart).catch((e) => {
      console.warn('[VocabRadar][asr-client][' + _ts() + '] 回退路径处理段失败:', e);
    });
  }, _segmentSec * 1000);

  pushStatusLocal('fallback-start', 'captureStream+AudioWorklet PCM 采集, 段长=' + _segmentSec + 's');
  console.log('[VocabRadar][asr-client][' + _ts() + '] 回退路径：captureStream + AudioWorkletNode（音频线程采集），段长 ' + _segmentSec + 's');

  // 反思（2026-07-05）：用户反馈"开头识别四分钟，之后就没了"。
  // 根因：标签页切到后台时 Chrome 自动挂起 AudioContext，onaudioprocess 停止触发，
  // 后续段全静音被跳过。添加 visibilitychange 监听，标签页恢复时自动 resume AudioContext。
  // 反思（2026-07-09 四次修复）：AudioWorklet 在音频线程运行，不受标签页后台影响，
  //   但 AudioContext 仍可能被挂起（浏览器策略），保留 resume 逻辑。
  //   新增 video 'play' 事件监听：视频从暂停恢复播放时 resume AudioContext（用户手势触发）。
  _fallbackVisibilityHandler = () => {
    if (!_running || !_fallbackAudioCtx) return;
    if (document.visibilityState === 'visible' && _fallbackAudioCtx.state !== 'running') {
      console.log('[VocabRadar][asr-client][' + _ts() + '] 标签页恢复，resume AudioContext');
      _fallbackAudioCtx.resume().catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', _fallbackVisibilityHandler);

  // video 'play' 事件：视频恢复播放时 resume AudioContext（play 由用户手势触发，resume 可生效）
  _fallbackPlayHandler = () => {
    if (!_running || !_fallbackAudioCtx) return;
    if (_fallbackAudioCtx.state !== 'running') {
      console.log('[VocabRadar][asr-client][' + _ts() + '] video play 事件，resume AudioContext');
      _fallbackAudioCtx.resume().catch(() => {});
    }
  };
  videoEl.addEventListener('play', _fallbackPlayHandler);
}

/**
 * 处理回退路径的一个 PCM 段：合并→重采样→发送到 offscreen
 * 采集不中断，此函数异步执行不影响后续 PCM 累积。
 * @param {Float32Array[]} pcmChunks - 本段的 PCM 采样数组
 * @param {number} pcmLength - 本段总采样数
 * @param {number} segStart - 段起始视频时间（秒）
 */
async function processFallbackSegment(pcmChunks, pcmLength, segStart) {
  if (pcmLength === 0) return;

  // 合并为单个 Float32Array
  const pcm = new Float32Array(pcmLength);
  let offset = 0;
  for (const chunk of pcmChunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }

  // 检查是否全静音（视频暂停/无音轨）
  // 反思（2026-07-06）：用户问"段 31s 是 0-31s 还是 31.0-31.99s？"。
  // 明确日志格式：段 start-end 表示从 start 开始的一段（长度 _segmentSec），
  // 例如"段 31-41s"表示 31.0s ~ 41.0s 的 10 秒片段。
  let hasAudio = false;
  for (let i = 0; i < pcm.length; i += 100) {
    if (Math.abs(pcm[i]) > 0.001) { hasAudio = true; break; }
  }
  let segEnd = segStart + _segmentSec;
  if (!hasAudio) {
    pushStatusLocal('fallback-skip', '段 ' + segStart.toFixed(0) + '-' + segEnd.toFixed(0) + 's 全静音，跳过');
    return;
  }

  pushStatusLocal('fallback-pcm', '段 ' + segStart.toFixed(0) + '-' + segEnd.toFixed(0) + 's ' + pcmLength + ' samples');

  // 重采样到 16kHz 单声道
  const sr = _fallbackAudioCtx.sampleRate;
  const duration = pcmLength / sr;
  const audioBuffer = _fallbackAudioCtx.createBuffer(1, pcmLength, sr);
  audioBuffer.copyToChannel(pcm, 0);
  const pcm16k = await resampleTo16kMono(audioBuffer);
  segEnd = segStart + duration;

  // 发送给 offscreen（fire-and-forget，offscreen 内部排队等模型）
  // 第九十八次：audioB64 可靠通道与快路径并行携带
  sendMessage({
    type: 'ASR_AUDIO_SEGMENT',
    videoKey: _currentVideoKey,
    start: segStart,
    end: segEnd,
    audio: pcmToArrayBuffer(pcm16k),
    audioB64: float32ToBase64(pcm16k),
    returnTimestamps: true
  }).catch(() => { /* ignore */ });
}

/** 停止回退路径的 PCM 采集
 * 反思（2026-07-09 四次修复）：AudioWorkletNode 用 port.onmessage 替代 onaudioprocess，
 *   清理时需断开 port 消息监听。新增 _fallbackPlayHandler 清理（video play 事件监听器）。
 */
function stopFallbackCapture() {
  if (_fallbackTimer) { clearInterval(_fallbackTimer); _fallbackTimer = null; }
  if (_fallbackVisibilityHandler) {
    document.removeEventListener('visibilitychange', _fallbackVisibilityHandler);
    _fallbackVisibilityHandler = null;
  }
  if (_fallbackPlayHandler && _fallbackVideoEl) {
    try { _fallbackVideoEl.removeEventListener('play', _fallbackPlayHandler); } catch (e) { /* ignore */ }
    _fallbackPlayHandler = null;
  }
  if (_fallbackProcessor) {
    try { _fallbackProcessor.disconnect(); } catch (e) { /* ignore */ }
    // AudioWorkletNode 用 port 通信，清理 port.onmessage
    if (_fallbackProcessor.port) {
      _fallbackProcessor.port.onmessage = null;
    }
    _fallbackProcessor = null;
  }
  if (_fallbackSourceNode) {
    try { _fallbackSourceNode.disconnect(); } catch (e) { /* ignore */ }
    _fallbackSourceNode = null;
  }
  if (_recorderStream) {
    try { _recorderStream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    _recorderStream = null;
  }
  _fallbackPcmBuffer = [];
  _fallbackPcmLength = 0;
  _fallbackSegCount = 0;
  _fallbackVideoEl = null;
  _wasFallbackPaused = false;
}

// === 音频处理工具 ===

/**
 * 将 AudioBuffer 重采样到 16kHz 单声道 PCM
 * 使用 OfflineAudioContext 进行高质量重采样。
 * @param {AudioBuffer} audioBuffer - 输入音频（任意采样率、任意声道）
 * @returns {Promise<Float32Array>} 16kHz 单声道 PCM
 */
async function resampleTo16kMono(audioBuffer) {
  const targetLength = Math.ceil(audioBuffer.duration * SAMPLE_RATE);
  const offlineCtx = new OfflineAudioContext(1, targetLength, SAMPLE_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

/**
 * 推送本地状态到 onStatus 回调
 * 反思（2026-07-05）：扩展为支持额外数据字段（segIdx/totalSegs/duration 等），
 * 供 sidebar 进度条显示识别段进度。
 * @param {string} stage - 阶段名
 * @param {string} info - 描述
 * @param {object} [extra] - 额外数据（segIdx, totalSegs, segStart, segEnd, duration 等）
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
 *   2026-07-09 适配新缓存格式 {segments:[...], totalListened}，兼容旧数组格式。
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
    const curModel = (res.asrModelSize && typeof res.asrModelSize === 'string') ? res.asrModelSize : 'tiny';
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
 * 获取 ASR 缓存的覆盖率（已监听时长 / 视频总时长）
 * 反思（2026-07-10 #86）：用户要求「若asr轨道不完整，则自动asr」。
 *   需判断缓存是否覆盖全文：合并 segments 的 listenStart/listenEnd 为不重叠范围，
 *   计算总覆盖时长，除以视频时长得覆盖率。覆盖率 < 1 视为不完整，需自动继续识别。
 * @param {string} videoKey
 * @param {number} videoDuration - 视频总时长（秒）
 * @returns {Promise<number>} 覆盖率 0-1（0=无缓存或无效，1=完全覆盖）
 */
export async function getASRCoverage(videoKey, videoDuration) {
  if (!videoKey || !videoDuration || videoDuration <= 0) return 0;
  try {
    const cache = await loadCache(videoKey);
    if (!cache.segments || cache.segments.length === 0) return 0;
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
  if (!videoKey) return { segments: [], totalListened: 0 };
  try {
    const key = `asr_cache_${videoKey}`;
    // 反思（2026-08-21 第八十九次）：内联读当前模型——本函数可能在 loadSegmentConfig
    //   之前被调用（侧栏 loadASRCacheIfAny 页面加载路径），不能依赖 _currentModelSize 已初始化。
    const res = await new Promise((r) => chrome.storage.local.get([key, 'asrModelSize'], r));
    const cached = res[key];
    if (!cached) return { segments: [], totalListened: 0 };
    const curModel = (res.asrModelSize && typeof res.asrModelSize === 'string') ? res.asrModelSize : 'tiny';
    // 缓存按模型失效——缓存记录的产出模型与当前模型不一致（或旧缓存未记录模型）时
    //   整体丢弃，全部段用当前模型重新识别，避免"切换模型后回放旧模型结果"。
    if (cached.modelSize !== curModel) {
      console.log('[VocabRadar][asr-client][' + _ts() + '] 缓存模型不符（缓存=' + (cached.modelSize || '未知') + ' 当前=' + curModel + '），丢弃旧缓存，将全量重新识别');
      try { await new Promise((r) => chrome.storage.local.remove(key, r)); } catch (e2) { /* ignore */ }
      return { segments: [], totalListened: 0 };
    }
    // 新格式
    if (cached.segments && Array.isArray(cached.segments)) {
      console.log('[VocabRadar][asr-client][' + _ts() + '] 加载缓存(新格式): ' + cached.segments.length + ' 段 totalListened=' + cached.totalListened);
      return { segments: cached.segments, totalListened: cached.totalListened || 0 };
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
      return { segments, totalListened };
    }
  } catch (e) { /* ignore */ }
  return { segments: [], totalListened: 0 };
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
    let toSave = { modelSize: _currentModelSize, segments: cache.segments, totalListened: cache.totalListened };
    if (cache.segments.length > 2000) {
      toSave = { modelSize: _currentModelSize, segments: cache.segments.slice(cache.segments.length - 2000), totalListened: cache.totalListened };
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
  //   偏移量本身没丢（本函数用 msg.start 做绝对化，chunk 一律 listenStart+ts）。
  //   倒退来自缓存段乱序：B站预识别在点击位置之后先向后识别，随后回填
  //   0→startSegIdx 的靠前段（biliRecognizeLoop 设计使然），这些靠前段的 listenStart
  //   小于末段，旧版只与 segs[segs.length-1] 比较 → 直接 push 到末尾，
  //   cache.segments 不再按时间单调；回放（replayCachedSegsFromCache /
  //   getCachedSubtitles）按数组顺序吐出，消费方就看到"后出的时间更小"。
  //   修正：按 listenStart 定位插入点，只与"时间上的前一段"判邻接合并，
  //   新增段用 splice 插入，保证 cache.segments 始终按 listenStart 升序。
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
 * 检查段 [start,end] 是否被已监听范围完全覆盖（含 0.1s 容差）
 * @param {number} start
 * @param {number} end
 * @param {Array<{start:number,end:number}>} ranges
 * @returns {boolean}
 */
function isInRange(start, end, ranges) {
  for (const r of ranges) {
    if (r.start <= start + 0.1 && r.end >= end - 0.1) return true;
  }
  return false;
}

/**
 * 从内存缓存回放历史识别结果到 onText
 * 优先按 chunk 级时间戳回放（精细），无 chunk 时按 speechStart/speechEnd 整段回放。
 * @param {{segments:Array}} cache
 * @param {(seg)=>void} onText
 */
function replayCachedSegsFromCache(cache, onText) {
  if (!cache || !cache.segments || !onText) return;
  // 第一百七十九次：回放前按 listenStart 排序 —— 本次修复前写入的历史缓存
  //   （以及任何乱序来源）仍可能非单调，排序保证消费方拿到的时间戳单调不倒退。
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

/**
 * START_ASR 重试包装（第一百一十一次）：×3 次、间隔 600ms。
 * 返回最终响应；全部失败返回 { ok:false, error:最后一次细节 }（不再是无信息的 null）。
 * @param {string} videoKey
 */
async function startOffscreenWithRetry(videoKey) {
  let last = { ok: false, error: 'no response(SW未应答)' };
  for (let i = 0; i < 3; i++) {
    const r = await sendMessage({ type: 'START_ASR', videoKey });
    if (r && r.ok) return r;
    last = r || last;
    if (i < 2) {
      console.warn('[VocabRadar][asr-client][' + _ts() + '] START_ASR 第' + (i + 1) + '次失败(' + ((r && r.error) || 'no response') + ')，600ms 后重试');
      await new Promise((res) => setTimeout(res, 600));
    }
  }
  return last;
}
