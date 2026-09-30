// =============================================================================
// vs/asr-flow.js —— ASR 开关与缓存加载子模块
// -----------------------------------------------------------------------------
// 职责：toggleASR()（ASR 按钮启动/停止，预识别架构 backend job 单路径）、
//       stopASRInternal()（停止识别但保留已识别字幕）、loadASRCacheIfAny()/
//       loadASRCacheWithCoverage()（无字幕时自动加载 ASR 缓存 + 覆盖率）、
//       selectASRTrackAndContinue()（选中 ASR 轨道并按覆盖率增量识别）。
// 状态内聚：_asrUnsub（startASR 取消订阅）、_videoKey（当前视频缓存 key）、
//       _lastAsrCacheCoverage（上次覆盖率）仅本模块读写，随函数一并迁入。
// 关系：依赖 ../../lib/asr-client.js（startASR/stopASR/hasASRCache/getCachedSubtitles/
//       getASRCoverage）、../vs-asr-progress.js、./asr-stage.js、./subtitle-renderer.js、
//       ./sidebar-layout.js、./playback-gate.js、../subtitle-overlay.js、./dom-utils.js、
//       ../../lib/i18n.js（t）、./logger.js（log）；因需读写门面 _root/_subtitles/
//       _asrActive/_asrCacheLoaded/_userPickedASR/_asrTrackIndex，经 getRoot/
//       getSubtitlesRef/setSubtitles/isASRActive/setAsrActive/getAsrCacheLoaded/
//       setAsrCacheLoaded/setUserPickedASR/getAsrTrackIndex 对门面
//       构成受控循环 import——本模块顶层仅自身状态与函数声明，绝不触碰门面绑定，
//       门面绑定调用全部发生在函数体内（运行时门面已初始化完毕，安全）。
//       等价改写：loadASRCache* 原直读 `_video`，改走 getActiveVideo()（拆分约定，
//       SPA 换集失效时返回新元素，与 vs/* 子模块同口径）。
//       门面经 export 接驳 loadASRCacheIfAny/loadASRCacheWithCoverage/
//       selectASRTrackAndContinue（vc/controller 引用方符号不变）。
// =============================================================================

import { startASR, stopASR, hasASRCache, getCachedSubtitles, getASRCoverage } from '../../lib/asr-client.js';
import { showASRProgress, hideASRProgress, updateASRProgressFill } from '../vs-asr-progress.js';
import { pushDiagLine, clearDiagLines, updateASRProgressFromStage } from './asr-stage.js';
import { resetRenderState, appendASRSubtitle } from './subtitle-renderer.js';
import { setSizeFrozen } from './sidebar-layout.js';
import { installPlaybackGate, uninstallPlaybackGate } from './playback-gate.js';
import { setSubtitles as overlaySetSubtitles } from '../subtitle-overlay.js';
import { makeVideoKey } from './dom-utils.js';
import { t } from '../../lib/i18n.js';
import { log } from './logger.js';
import {
  getRoot, getSubtitlesRef, getActiveVideo, isASRActive, updateSubtitles, toast,
  setSubtitles, setAsrActive, getAsrCacheLoaded, setAsrCacheLoaded,
  setUserPickedASR, getAsrTrackIndex
} from '../video-sidebar.js';

// === 模块状态（仅本模块读写，随函数自门面迁入） ===
let _asrUnsub = null;        // ASR 字幕回调取消订阅
let _videoKey = '';          // 当前视频缓存 key（URL-based）
let _lastAsrCacheCoverage = 0; // 上次 ASR 缓存的覆盖率（避免重复加载时重新计算）

// === ASR 识别：切换开关（预识别架构，与普通字幕同源处理） ===
// 预识别方案：backend job 单路径（此前的 B站下载管线与 captureStream 回退已删除）。
// 点击 ASR 按钮时触发：
//   启动：保存当前字幕 → 清空面板 → asr-client 自动识别当前所在分钟并预识别后续分钟
//   停止：停止识别 → 保留 ASR 字幕不清空
// ASR 识别结果直接进入 _subtitles/_subEntries（与普通字幕同源），
// 复制/总结/评论按钮和 highlightCurrent 同步高亮自动生效。

export async function toggleASR(clickX, clickY) {
  if (isASRActive()) {
    // 停止：保留 ASR 字幕不清空，仅停止识别
    // 停止不弹 toast（用户要求“除非报错否则不浮窗”）。
    stopASRInternal();
    return;
  }
  // 启动
  const v = getActiveVideo();
  if (!v) {
    toast(t('toast.noVideo'), { x: clickX, y: clickY });
    return;
  }
  const _root = getRoot();
  // 用户批评「谁给你的胆子清空asr结果的！那还要缓存干啥！」：
  //   若面板字幕已由 loadASRCacheIfAny 预加载缓存，点ASR应接续不清空，直接实时识别。
  //   skipReplay=true 时：不清空 _subtitles，startASR 跳过 replayCachedSegs（已预加载）。
  const skipReplay = getAsrCacheLoaded() && getSubtitlesRef().length > 0;
  setAsrCacheLoaded(false);  // 决策完毕，重置（换集/重建时也会重置）
  if (!skipReplay) {
    _videoKey = makeVideoKey();
  }
  // 不记录墙钟偏移：asr-client 的 onText 回调直接返回绝对视频秒数（backend 直出），
  // appendASRSubtitle 直接使用。
  // 选中态：背景色
  const asrBtn = _root.querySelector('#beaver-asr-toggle');
  if (asrBtn) asrBtn.classList.add('active');
  setAsrActive(true);
  // 用户点 ASR 按钮启动，置标记防止后续 setTracks 覆盖轨道选中态
  setUserPickedASR(true);
  // 同步轨道下拉框到 ASR 轨道（点击按钮启动时，下拉框也应切到 ASR）
  const _asrTrackIndex = getAsrTrackIndex();
  if (_asrTrackIndex >= 0) {
    const sel = _root.querySelector('#beaver-track-select');
    if (sel && sel.value !== String(_asrTrackIndex)) sel.value = String(_asrTrackIndex);
  }
  // 显示 ASR 进度条
  showASRProgress(t('asr.preparing'), '');
  // 清空阶段时间线，开始新会话（诊断仅走日志通道）
  clearDiagLines();
  pushDiagLine('—— 开始识别 ——');
  // 用户裁定："点击识别立即暂停"被否决——点击识别不改变播放状态，识别在后台进行
  // （直连下载或回退采集）。
  // ASR 结果直接进入 _subtitles/_subEntries（与普通字幕同源），
  // 复制/总结/评论按钮和 highlightCurrent 同步高亮自动生效。
  // 非缓存预加载场景：清空面板准备接收 ASR 结果；缓存预加载场景：保留缓存字幕接续实时识别。
  if (!skipReplay) {
    setSubtitles([]);
    // 用户反馈"选的是asr，叠加字幕却是其他轨道的时间戳错乱"：
    //   根因：此处清空了侧栏 _subtitles，但视频叠加字幕（subtitle-overlay）从未同步清空——
    //   overlay 里仍留着切换前的原生轨道字幕，继续按其时间戳渲染，与 ASR 侧栏字幕
    //   两套来源并存 → 视频上显示的是旧轨道内容且时间戳对不上。同步清空 overlay。
    try { overlaySetSubtitles([]); } catch (e) { /* ignore */ }
    resetRenderState();
    // 用户反馈"字幕区空白，生词表倒是一大堆"：
    //   根因：清空 _subtitles 但没清 _windowSlots/_activeSubIdx/面板 DOM，
    //   appendASRSubtitle 检查 _windowSlots.length===0 来决定是否初始化面板，
    //   旧槽位不为空 → 不调 renderSubtitlePanel → 面板保留旧 DOM 不更新。
    //   collectAnnotations 仍 push 生词到 _allAnnotations + appendWordPanelItems → 生词表有数据。
    //   同步清 _windowSlots + _activeSubIdx + 面板 DOM，让首批 ASR 结果正确初始化面板。
    // 用户反馈"点了一下asr按钮，结果字幕清空了，生词表还一长串"：
    //   根因：_allAnnotations=[] 清了数组但 #beaver-word-panel DOM 未清，旧生词条目残留。
    //   现同步清 #beaver-word-panel DOM。
    const panel = _root.querySelector('#beaver-subtitle-panel');
    if (panel) panel.innerHTML = '';
    const wp = _root.querySelector('#beaver-word-panel');
    if (wp) wp.innerHTML = '';
  }
  try {
    _asrUnsub = await startASR({
      videoKey: _videoKey,
      videoElement: v,
      skipReplay,
      onText: (seg) => {
        // appendASRSubtitle 为 async（getAnnotations 异步翻译），fire-and-forget + catch 防止 unhandledrejection
        appendASRSubtitle(seg).catch((e) => console.warn('[VocabRadar][asr][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] appendASRSubtitle 失败:', e));
      },
      onStatus: (s) => {
        // 用户要求“除非报错，否则不要给用户浮窗”：所有非错误状态仅打印日志
        //   + 更新进度条（此前 loading/ready/stage 多种状态都弹 toast，干扰严重），
        //   错误由 onError 回调处理。
        const _t = new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0');
        if (s.status === 'loading') {
          const pct = Math.round(s.progress || 0);
          console.log('[VocabRadar][asr][' + _t + '] model:', (s.file || ''), pct + '%');
          showASRProgress(t('asr.modelDownloading'), (s.file || '') + ' ' + pct + '%');
          updateASRProgressFill(pct);
        } else if (s.status === 'ready') {
          console.log('[VocabRadar][asr][' + _t + '] model ready');
          showASRProgress(t('asr.modelReady'), '');
          updateASRProgressFill(0);
        } else if (s.status === 'stage') {
          console.log('[VocabRadar][asr][' + _t + ']', '[' + s.stage + ']', s.info || '');
          updateASRProgressFromStage(s);
        }
      },
      onError: (err) => {
        console.warn('[VocabRadar][asr][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] ASR 错误:', err);
        // asr-client 的 onError 仅在终态触发（backend job failed / job 丢失且重提失败），
        //   lib 层轮询已停，此处必须同步复位按钮态（否则按钮卡在 active）
        stopASRInternal();
        // 进度条显示错误 5 秒后收起（stopASRInternal 已置非 active，不能再用 isASRActive 守卫，否则永不隐藏）
        showASRProgress(t('asr.errorLabel'), String(err.message || err).slice(0, 60));
        setTimeout(() => { hideASRProgress(); }, 5000);
      }
    });
    console.log('[VocabRadar][asr][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] 已启动');
    // ASR 启动成功 → 本页会话冻结自动重塑（startSyncHeight/对位/补测停写）。
    // 不随 ASR 停止解冻——用户裁定"不因 asr 等活动重塑窗口"，解冻会让停止瞬间再次改写。
    setSizeFrozen(true);
    // 用户裁定：闸门停用（恢复开关见 _gateEnabled）
    installPlaybackGate();
  } catch (e) {
    console.warn('[VocabRadar][asr][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] ASR 启动失败:', e);
    const msg = String(e.message || e);
    // 扩展上下文失效（扩展被重载/更新后旧 content script 仍在页面上）
    if (msg.includes('CONTEXT_INVALIDATED') || msg.includes('Extension context invalidated')) {
      toast(t('asr.ctxInvalidated'), { x: clickX, y: clickY, error: true, duration: 10000 });
      stopASRInternal();
      return;
    }
    // 用户要求"整个处理不了直接不显示窗口，别现眼"：ASR 启动失败（如无音轨）
    // 静默退出，仅控制台保留 warn 日志供诊断。
    // backend 是唯一路径，其不可用须如实报错引导启动 backend（用户裁定）。
    if (e.code === 'BACKEND_UNAVAILABLE' || String(e.message || e).includes('backend 不可用')) {
      toast(String(e.message || e), { x: clickX, y: clickY, error: true, duration: 8000 });
    }
    stopASRInternal();
  }
}

// 停止 ASR 识别，保留 ASR 字幕结果
// 用户反馈"关停asr发现你清理字幕，大错"：停止 ASR 仅停止识别，
// ASR 识别出来的字幕保留在面板中，不清空、不恢复旧字幕
// （此前曾恢复原字幕清空 ASR 结果）。
// 用户反馈"asr中途退出"：添加调用栈日志，
//   记录 stopASRInternal 的调用来源，便于诊断自动停止的根因。
export function stopASRInternal(skipRestore) {
  // 打印调用栈，诊断 ASR 中途退出的根因
  const _stack = new Error().stack;
  const _caller = _stack ? _stack.split('\n').slice(2, 5).map(s => s.trim()).join(' <- ') : 'unknown';
  console.log('[VocabRadar][asr][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] stopASRInternal 被调用, skipRestore=' + !!skipRestore + ', 调用来源: ' + _caller);
  if (_asrUnsub) { try { _asrUnsub(); } catch (e) { /* ignore */ } _asrUnsub = null; }
  try { stopASR(); } catch (e) { /* ignore */ }
  setAsrActive(false);
  // 卸载播放闸门；若暂停由闸门所为则恢复播放（不把用户卡在暂停态）
  uninstallPlaybackGate(true);
  // ASR 停止后清除用户选中标记，后续 setTracks 可正常按 pickedIndex 选轨
  setUserPickedASR(false);
  const _root = getRoot();
  const asrBtn = _root.querySelector('#beaver-asr-toggle');
  if (asrBtn) asrBtn.classList.remove('active');
  // 隐藏 ASR 进度条
  hideASRProgress();
  // 会话结束标注（仅日志）
  pushDiagLine('—— 已停止 ——');
  // 保留 ASR 字幕，不恢复旧字幕，不清理面板
  console.log('[VocabRadar][asr][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] 已停止，字幕保留');
}

/**
 * 无字幕时自动加载 ASR 缓存（若有）。
 * 用户反馈「asr缓存结果并没有出现在轨道，只有识别后才出现」：
 *   用户确认期望「有缓存自动加载显示」，时机「仅无字幕时自动加载」
 *   （符合约束「字幕加载优先级：优先显示找到的字幕内容，其次显示ASR结果」）。
 *   流程：生成 videoKey → 查 hasASRCache → 有则 getCachedSubtitles 取字幕数组
 *   → 按 start 排序 → updateSubtitles 填充字幕面板。
 *   点 ASR 按钮时走 startASRInternal 清空重建（startASR 内部 replayCachedSegs 回放+实时接续）。
 * @returns {Promise<boolean>} 是否成功加载了缓存字幕
 */
export async function loadASRCacheIfAny() {
  const v = getActiveVideo();
  if (!v) {
    log('loadASRCacheIfAny: 无 video, 跳过');
    return false;
  }
  const videoKey = makeVideoKey();
  const has = await hasASRCache(videoKey);
  if (!has) {
    log('loadASRCacheIfAny: 无 ASR 缓存, videoKey=', videoKey);
    return false;
  }
  const subs = await getCachedSubtitles(videoKey);
  if (!subs || subs.length === 0) {
    log('loadASRCacheIfAny: 缓存为空, videoKey=', videoKey);
    return false;
  }
  // 按 start 排序（缓存段顺序未必严格递增，highlightCurrent 假定有序）
  subs.sort((a, b) => (a.start || 0) - (b.start || 0));
  _videoKey = videoKey;  // 保存供后续 ASR 按钮复用
  log('loadASRCacheIfAny: 检测到 ASR 缓存, 自动加载', subs.length, '条, videoKey=', videoKey);
  await updateSubtitles(subs);  // 内部 renderSubtitlePanel 会重置 _asrCacheLoaded=false
  setAsrCacheLoaded(true);  // updateSubtitles 之后再设 true，标记面板字幕来源为缓存预加载
  return true;
}

/**
 * 加载 ASR 缓存并返回覆盖率，供 video-controller 判断是否需自动继续识别。
 * 用户要求「若是用户首选英语，而且已经有asr缓存，
 *   那么应当优先加载asr轨道，不足之处还要自动识别」。
 *   本函数加载缓存字幕到面板，同时返回覆盖率供调用方决定是否自动启动 ASR。
 * @returns {Promise<{loaded:boolean, coverage:number}>}
 */
export async function loadASRCacheWithCoverage() {
  // 用户反馈"经常刷新字幕区"。
  //   根因：video-controller 每次 handleSubtitlesArrived 都调用本函数，
  //   每次都 updateSubtitles 清空当前字幕重新加载缓存，导致频繁刷新。
  //   若缓存已加载则跳过，返回上次的覆盖率。
  if (getAsrCacheLoaded()) {
    log('loadASRCacheWithCoverage: 缓存已加载, 跳过, coverage=', _lastAsrCacheCoverage.toFixed(2));
    return { loaded: true, coverage: _lastAsrCacheCoverage };
  }
  const v = getActiveVideo();
  if (!v) {
    log('loadASRCacheWithCoverage: 无 video, 跳过');
    return { loaded: false, coverage: 0 };
  }
  const videoKey = makeVideoKey();
  const has = await hasASRCache(videoKey);
  if (!has) {
    log('loadASRCacheWithCoverage: 无 ASR 缓存, videoKey=', videoKey);
    return { loaded: false, coverage: 0 };
  }
  const subs = await getCachedSubtitles(videoKey);
  if (!subs || subs.length === 0) {
    log('loadASRCacheWithCoverage: 缓存为空, videoKey=', videoKey);
    return { loaded: false, coverage: 0 };
  }
  subs.sort((a, b) => (a.start || 0) - (b.start || 0));
  _videoKey = videoKey;
  log('loadASRCacheWithCoverage: 加载 ASR 缓存', subs.length, '条, videoKey=', videoKey);
  await updateSubtitles(subs);
  setAsrCacheLoaded(true);
  const duration = (v.duration && !isNaN(v.duration)) ? v.duration : 0;
  const coverage = await getASRCoverage(videoKey, duration);
  _lastAsrCacheCoverage = coverage;  // 保存覆盖率，供后续跳过时返回
  log('loadASRCacheWithCoverage: 覆盖率=', coverage.toFixed(2), 'duration=', duration.toFixed(1));
  return { loaded: true, coverage };
}

/**
 * 选中 ASR 轨道并按需自动继续识别。
 * 用户要求「选择asr轨道后，若识别区间未覆盖全文，则继续识别，
 *   asr按钮此时才默认选中」。本函数检查 ASR 缓存覆盖率，不完整时调 toggleASR 启动增量识别
 *   （asr-client 的 biliRecognizeLoop 自动跳过已监听段，只识别未覆盖部分）。
 * @param {number} coverage - 缓存覆盖率 0-1，<1 视为不完整
 */
export function selectASRTrackAndContinue(coverage) {
  const _root = getRoot();
  if (!_root) return;
  // 同步轨道下拉框到 ASR
  const _asrTrackIndex = getAsrTrackIndex();
  if (_asrTrackIndex >= 0) {
    const sel = _root.querySelector('#beaver-track-select');
    if (sel) sel.value = String(_asrTrackIndex);
  }
  if (coverage < 1) {
    // 缓存不完整，自动启动 ASR 继续识别未覆盖部分
    log('selectASRTrackAndContinue: 缓存不完整(coverage=' + coverage.toFixed(2) + '), 自动启动 ASR');
    // 置标记防止后续 setTracks 覆盖 ASR 选中态
    setUserPickedASR(true);
    if (!isASRActive()) {
      const asrBtn = _root.querySelector('#beaver-asr-toggle');
      if (asrBtn) {
        const rect = asrBtn.getBoundingClientRect();
        toggleASR(rect.left, rect.top);
      } else {
        toggleASR(0, 0);
      }
    }
  } else {
    log('selectASRTrackAndContinue: 缓存完整(coverage=' + coverage.toFixed(2) + '), 仅选中 ASR 轨道');
  }
}
