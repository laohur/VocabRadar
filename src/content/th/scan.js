// 文本提示 - 扫描/注释/生命周期模块（ES module）
//
// === 拆分说明（2026-08-28）===
// 本文件由 src/content/text-hint-impl.js（原 2390 行）机械拆分而来，
// 逻辑与行为与拆分前完全一致，仅把变量 _xxx 改为共享状态 thState.xxx。
//
// 职责：
//   1. 生命周期：startHint / stopHint / rescanNow / clearHighlights
//   2. 设置变更入口：setRankThreshold / setAnnotateOov / setAnnotateRepeat
//   3. TreeWalker + requestIdleCallback 分批扫描（scheduleScan / scanSubtree / processBatch）
//   4. 文本节点处理与查词包裹（processTextNode / queryWord / wrapWordAt）
//   5. 侧邻注释（appendSideAnnotation / backfillSideAnnotation / applySideAnnotationToAll /
//      removeAllSideAnnotations）
//   6. 可见性切换与清理（updateWordVisibility / clearProcessedAttr / unwrapSingle /
//      validateSpan / cleanupStaleSpans / unwrapAll）
//   7. MutationObserver 增量扫描（startObserver）
//   8. 文档级事件委托兜底（installDelegationGuard）
//   9. 诊断快照（getDiagState）
//
// 模块级副作用（只能有一份）：
//   - installDelegationGuard 的 3 个 document capture 监听（window.__beaverHintDelegation 幂等守卫）
//   - startHint 中的 window scroll 监听（thState.scrollHandler 幂等守卫）
//
// 跨模块调用：tooltip.js 提供浮层处理器；panel.js 提供查词面板；core.js 提供共享状态/常量/工具。
// 第一百八十七次：新增 prefetchFull —— processBatch 每批开跑前一次性批量预取本批词，
//   消除 lookupFull 逐词 SW 往返（实测串行查词 1069 次）。
import { lookupFull, prefetchFull, getDiagState as getDictDiagState, ensureReady, setQuietBatch, isLoaded as isDictLoaded } from '../../lib/dictionary.js';
import { getDiagState as getLemmatizerDiagState } from '../../lib/lemmatizer.js';
import { translate } from '../../lib/translator.js';
import { initLang } from '../../lib/i18n.js';
import { cleanDictEntry, isBalancedParens } from '../../lib/dict-clean.js';
import { beginBatch, countChars, countTokens, countUnique, incField, incScalar, getBatches, logBatch } from '../../lib/dict-stats.js';
import { emitBlock, resetScan } from '../page-scan-bus.js';
import { lookupWord } from '../../lib/annotator.js';
import {
  thState, HIGHLIGHT_CLASS, FIRST_CLASS, LATER_CLASS, HIDE_WORD_CLASS, SIDE_ANN_CLASS,
  PROCESSED_ATTR, TOOLTIP_ID, PANEL_ID, STYLE_ID, WORD_G_PATTERN, SELECT_PATTERN,
  SKIP_TAGS, NON_CONTENT_SELECTOR, JS_SENTINELS,
  waitForBody, isContextValid, injectStyles, applyColorVars, pickColors,
  thMark, thAdd, getHintTiming
} from './core.js';
import {
  ensureTooltip, hideTooltip, onScrollHide, onWordHover, onWordLeave, onWordClick
} from './tooltip.js';
import { ensurePanel, hidePanel } from './panel.js';

// 模块级：扫描门闸看门狗定时器（见 scheduleScan#run 的 release）
// 反思（2026-08-30 第一百八十三次）：scanRunning 只靠 onDone 复位，异常路径会永久卡死全部扫描
//   且无任何日志（本次「生词提示消失」形态）。用一个模块级定时器做兜底解闸，只能有一份。
let _scanWatchdog = null;

export async function startHint(settings) {
  // 反思（2026-08-14 第五十六次修正）：诊断实证 effective.enabled=false 但存储要求启动。
  //   旧版任一早期语句（如 initLang）同步抛错会让 startHint 在 _enabled=true 之前 reject，
  //   调用方 await 中断 → 监听器永不注册 → 后续改设置全部失效（"网页无提示"）。
  //   修正：整个启动过程包 try/catch 永不 reject，_enabled 尽快置 true，
  //   出错记 _lastStartError 供诊断窗展示，并依赖 text-hint.js 的 3s 自愈重试。
  thState.startedEver = true;
  thState.lastStartError = null;
  // 第一百八十六次埋点：全链路计时起点（用户症状「体感好几秒才出现网页提示」）
  thMark('hint:start');
  try {
    // 反思（2026-08-12 第四十一次）：初始化 i18n，使 t() 返回界面语言对应文案
    initLang().catch(() => { /* ignore */ });
    // 反思（2026-08-06）：NaN 防御 — rankThreshold 非有限数字时回退 5000（默认）
    //   settings.rankThreshold 若为 NaN，旧版 `?? 0` 不触发（NaN 非 null/undefined），
    //   导致 _rankThreshold=NaN → lookupWord 中 `rank > NaN` 恒 false → 所有词按表外处理。
    //   虽不直接产生"NaN阶"显示，但影响高亮判定，且 console.log 会打印 NaN。
    thState.rankThreshold = (typeof settings.rankThreshold === 'number' && isFinite(settings.rankThreshold))
      ? settings.rankThreshold : 5000;
    thState.annotateOov = settings.annotateOov === true;  // 默认 false（注释表外词默认不选）
    thState.annotateRepeat = settings.annotateRepeat === true;  // 默认 false（不注释重复生词）
    thState.colors = pickColors(settings);
    thState.enabled = true;
    // 第一百八十七次：panelHideDelay 的 config.json 读取**改为非阻塞**。
    //   实测（learn.microsoft.com）：startHint 入口 4021ms，而这段 await fetch 位于
    //   ensureReady() 词典调度之前，把「词典开始装载」硬性推后一个网络/磁盘往返；
    //   而它只影响"悬浮提示失焦后停留多久"，首屏根本用不到。改 fire-and-forget，
    //   取到就覆盖 thState.panelHideDelay（默认 5000ms 期间行为不变）。
    (async () => {
      try {
        const url = chrome.runtime.getURL('src/data/config.json');
        const res = await fetch(url);
        const cfg = await res.json();
        if (typeof cfg.panelHideDelay === 'number') thState.panelHideDelay = cfg.panelHideDelay;
      } catch (_) { /* ignore，用默认 5000ms */ }
    })();
    // 反思（2026-08-05 修正）：startHint 中词典装载异常必须 try/catch，不得中断启动。
    // 反思（2026-08-18 第七十三次修正）：先 await ensureReady() 再扫描。
    // 第一百一十四次：曾恢复阻塞——当时"非阻塞+就绪重扫"链路不可靠导致网页无提示。
    // 第一百三十九次（用户裁定"网页先异步装载词典"）：改为**异步装载**——不阻塞
    // 首屏扫描启动；就绪后 rescanNow() 重扫补齐 rank/tags（重扫前所有词按表外处理，
    // annotateOov=false 时不高亮＝短暂无提示属预期，装完即出）。跨页 IDB 投影命中时
    // ensureReady 毫秒级返回，重扫代价可忽略；真正冷构建（首次/损坏自愈）不再卡首屏。
    // 可靠性保障：rescanNow 是既有的对账/诊断共路函数（text-hint.js:41 亦在用），
    // 且完成回调只跑一次（_dictRescanArmed 幂等），失败静默由 3s 自愈兜底。
    let _dictRescanArmed = false;
    try {
      ensureReady().then(() => {
        thMark('hint:dictReady');
        if (_dictRescanArmed) return;
        _dictRescanArmed = true;
        thMark('hint:dictRescan');
        try { rescanNow(); } catch (e) { console.warn('[VocabRadar][text-hint] 词典就绪重扫失败:', e); }
      }).catch((e) => {
        console.warn('[VocabRadar][text-hint] 词典装载失败（按表外词高亮继续）:', e);
      });
    } catch (e) {
      console.warn('[VocabRadar][text-hint] 词典装载调度失败:', e);
    }
    injectStyles();
    applyColorVars();
    ensureTooltip();
    ensurePanel();
    // 第一百一十二次：委托兜底（幂等）——覆盖 Firefox 直绑监听器失效场景
    installDelegationGuard();
    // 反思（2026-08-12 第四十四次）：等待 body 就绪后再扫描和观察，
    //   避免 document.body 为 null 时 scheduleScan/startObserver 无效。
    //   大部分情况下 body 已就绪，waitForBody 立即返回，不影响性能。
    const scanRoot = await waitForBody();
    thMark('hint:bodyReady');
    // 反思（2026-08-16 第七十一次）：重启即代表注释语义可能变化（设置变了），
    //   清空总线历史并通知侧栏清去重，侧栏等新一批 emit 重建列表。
    resetScan();
    scheduleScan(scanRoot);
    startObserver();
    // 反思（2026-07-14 #98 → 2026-07-26 修正）：
    //   旧版误解"飘窗固定不动"约束，加了 onScrollReposition 让飘窗跟随内容滚动，
    //   反而导致飘窗随页面滚动（违反"右键查询的飘窗固定不动"硬约束）。
    //   用户明确："滚动说明失去注意力了"——scroll 触发时立即隐藏 tooltip 和 panel。
    //   tooltip/panel 均为 position:fixed 本就视口固定，无需重定位。
    // 反思（2026-08-06）：用户要求"只翻译可见正文区域"，scroll 时需重新扫描
    //   新进入视口的文本节点。节流 500ms，避免滚动频繁触发。
    // 反思（2026-08-18 第七十五次修正）：scroll 监听幂等注册——
    //   startHint 可被 3s 自愈 / 5s 对账 / 诊断按钮 / storage 事件重复调用，
    //   旧版每次都 addEventListener 叠加监听器，多次启动导致重复扫描（网页重复提示）。
    let _scrollScanTimer = null;
    if (!thState.scrollHandler) {
      thState.scrollHandler = () => {
        onScrollHide();
        // 节流重新扫描可见区域
        if (_scrollScanTimer) clearTimeout(_scrollScanTimer);
        _scrollScanTimer = setTimeout(() => {
          if (thState.enabled) scheduleScan(document.body || document.documentElement);
        }, 500);
      };
      window.addEventListener('scroll', thState.scrollHandler, { capture: true, passive: true });
    }
    console.log(`[VocabRadar][text-hint] 已启动 rankThreshold=${thState.rankThreshold}`, thState.colors);
  } catch (e) {
    thState.lastStartError = String((e && e.message) || e);
    console.error('[VocabRadar][text-hint] startHint 出错（已尽力继续）:', e);
  }
}

/** 停止文本提示，清除所有高亮 */
export function stopHint() {
  thState.enabled = false;
  if (thState.observer) { thState.observer.disconnect(); thState.observer = null; }
  if (thState.scrollHandler) { window.removeEventListener('scroll', thState.scrollHandler, { capture: true }); thState.scrollHandler = null; }
  thState.scanScheduled = false;
  // 反思（2026-08-28 第一百六十九次）：停止时一并复位扫描门闸，
  //   否则若停在扫描中途，scanRunning 残留 true 会让重启后的 scheduleScan 永久静默。
  thState.scanRunning = false;
  thState.scanPendingRoot = null;
  // 第一百八十三次：一并清掉看门狗定时器，避免停用后仍打出"强制解闸"错误日志。
  if (_scanWatchdog) { clearTimeout(_scanWatchdog); _scanWatchdog = null; }
  unwrapAll();
  hideTooltip();
  hidePanel();
  console.log('[VocabRadar][text-hint] 已停止');
}

/**
 * 强制重新扫描整页正文（诊断悬浮窗"重扫"按钮 / 自愈路径用）
 * 反思（2026-08-14 第五十六次）：scheduleScan 原为模块内部函数，
 *   诊断悬浮窗需要"看网页是否变化"的操作按钮，故导出。
 * 反思（2026-08-14 第五十八次）：重扫前必须清空 _seenWords。
 *   根因：clearProcessedAttr 后 TreeWalker 会重新包裹所有出现，
 *   若 _seenWords 保留首扫记录，全部出现被判 isFirst=false → later 类，
 *   laterEnabled=false（默认）时 .beaver-hide-later 全透明 →"高亮全部消失"。
 * 反思（2026-08-28 第一百六十九次）：必须一并清空 thState.wordCache。
 *   根因（用户："生词很少，调整词频后正常"）：startHint 改为异步 ensureReady 后，
 *   首屏扫描发生在词典 dictMap 装载完成之前，lookupFull 直接 return null，
 *   processTextNode 把这批"假 null"写进 wordCache；词典就绪后 .then(rescanNow)
 *   重扫，但旧版 rescanNow 只清 seenWords 不清 wordCache，
 *   于是 `info === undefined` 判据失效，全部命中假 null → 无高亮/生词极少。
 *   而 setRankThreshold/setAnnotateOov/setAnnotateRepeat 三个 setter 都清了
 *   wordCache，故"调整词频后正常"——精确对上现象。
 */
export function rescanNow() {
  if (!thState.enabled) return;
  thState.wordCache.clear();
  thState.seenWords.clear();
  clearProcessedAttr();
  resetScan();
  scheduleScan(document.body || document.documentElement);
}

/**
 * 删除全部高亮包裹（诊断悬浮窗"删高亮"按钮用）：仅剥 span，不停止观察器
 * 反思（2026-08-14 第五十六次）：stopHint 会一并停观察器，删高亮只想去掉
 *   效果再看网页是否变化，保留后续扫描能力。
 */
export function clearHighlights() {
  unwrapAll();
  resetScan();
  console.log('[VocabRadar][text-hint] 已删除全部高亮');
}

/**
 * 修改阈值：CSS class 切换可见性（不 unwrapAll，避免搅乱网页）
 * 反思（2026-08-11 第三十三次）：用户反馈"调整词频后页面破坏，正文消失，白屏"。
 *   根因：旧版 setRankThreshold 调 unwrapAll() 移除所有 span + scheduleScan 重扫整个 body，
 *   139+ span 移除 + 800+ 文本节点重扫 + 139+ 新 span 创建 = 大量 DOM 修改，
 *   触发网站脚本 MutationObserver 响应 → 页面重新渲染 → 白屏。
 *   修正：新增 HIDE_WORD_CLASS，setRankThreshold 不再 unwrapAll，
 *   改用 CSS class 切换可见性（不改变 DOM 结构）。
 *   - 阈值升高（更少词显示）：给高频词 span 加 .beaver-word-hidden
 *   - 阈值降低（更多词显示）：清除 PROCESSED_ATTR 重新扫描包裹新增词
 * @param {number} v
 */
export function setRankThreshold(v) {
  const oldThreshold = thState.rankThreshold;
  thState.rankThreshold = (typeof v === 'number' && isFinite(v)) ? v : 5000;
  thState.wordCache.clear();
  thState.seenWords.clear();
  if (thState.enabled) {
    // 切换已包裹 span 的可见性（不改变 DOM 结构）
    updateWordVisibility();
    // 阈值降低：可能有之前跳过的高频词现在需要显示，重新扫描
    // 阈值升高：不需要重新扫描（updateWordVisibility 已隐藏高频词）
    if (thState.rankThreshold < oldThreshold) {
      clearProcessedAttr();
      resetScan();
      scheduleScan(document.body || document.documentElement);
    }
  }
}

/**
 * 修改"注释表外词"开关：CSS class 切换可见性（不 unwrapAll）
 * 反思（2026-08-11 第三十三次）：与 setRankThreshold 同理，用 CSS class 代替 unwrapAll
 * 反思（2026-08-14 第五十四次）：函数名与键名同步改名（localTranslateEnabled → annotateOov）
 * @param {boolean} v
 */
export function setAnnotateOov(v) {
  thState.annotateOov = !!v;
  thState.wordCache.clear();
  thState.seenWords.clear();
  // 反思（2026-08-16 第七十一次）：表外词开关决定注释集合，重扫前清总线，
  //   侧栏随后收到新 emit 重建列表（避免旧词残留）。
  resetScan();
  if (thState.enabled) {
    updateWordVisibility();
  }
}

/**
 * 修改"注释重复生词"开关（2026-08-15 第六十二次）
 * 变化后需重新扫描才能对已包裹节点生效（同一文本节点内去重逻辑在 processTextNode）
 * @param {boolean} v
 */
export function setAnnotateRepeat(v) {
  thState.annotateRepeat = !!v;
  thState.wordCache.clear();
  thState.seenWords.clear();
  if (thState.enabled) {
    clearProcessedAttr();
    resetScan();
    scheduleScan(document.body || document.documentElement);
  }
}

/**
 * 遍历所有 .beaver-word span，有翻译的追加 .beaver-side-ann
 * 侧邻注释（2026-08-05）：开关从 false→true 时调用
 *   - dataset.translations 非空 → 直接追加
 *   - dataset.translations 为空但 _wordCache 有缓存 → 回填并追加
 *   - 都没有 → 不追加（翻译完成后 backfillSideAnnotation 会自动追加）
 */
export function applySideAnnotationToAll() {
  const spans = document.querySelectorAll('.' + HIGHLIGHT_CLASS);
  spans.forEach((span) => {
    // 跳过视频提示内的 span（侧栏有独立渲染）
    // 跳过字幕 overlay（由 subtitle-overlay.js 独立渲染，无 dataset.word，校验必败）
    if (span.closest && span.closest('#beaver-sidebar, #beaver-web-sidebar, #beaver-subtitle-overlay')) return;
    // 校验 span 仍有效
    if (!validateSpan(span)) return;
    const word = span.dataset.word;
    if (!word) return;
    // 优先用 dataset.translations
    let transList = [];
    if (span.dataset.translations) {
      transList = span.dataset.translations.split('；').filter(Boolean);
    }
    // dataset.translations 为空时，从 _wordCache 获取
    if (transList.length === 0) {
      const cached = thState.wordCache.get(word.toLowerCase());
      if (cached && cached.translations && cached.translations.length > 0) {
        transList = cached.translations;
        span.dataset.translations = transList.join('；');
      }
    }
    if (transList.length > 0) {
      appendSideAnnotation(span, transList);
    }
  });
}

/**
 * 移除所有 .beaver-side-ann（非侧栏内）
 * 侧邻注释（2026-08-05）：开关从 true→false 时调用，高亮 span 保留
 */
export function removeAllSideAnnotations() {
  document.querySelectorAll('.' + SIDE_ANN_CLASS).forEach((el) => {
    if (el.closest && el.closest('#beaver-sidebar, #beaver-web-sidebar, #beaver-subtitle-overlay')) return;  // 跳过侧栏/overlay
    el.remove();
  });
}

// === 扫描 ===

/** 调度扫描（requestIdleCallback / setTimeout）
 * 反思（2026-08-28 第一百六十九次）：旧版仅用 scanScheduled 防"调度重入"，
 *   而 run() 一进入就把它置回 false，随后 scanSubtree 的分批推进要持续很久，
 *   期间 scroll（500ms 节流）与 MutationObserver 可再次调度，形成多轮并发扫描
 *   交错遍历同一棵树 → 重复查词、日志不断、扫描迟迟不完（用户："文本许久在扫"）。
 *   修正：新增 scanRunning 门闸；执行中的调度请求合并进 scanPendingRoot
 *   （不同 root 合并为整个 body），本轮结束后补跑一轮。
 */
export function scheduleScan(root) {
  if (!root) return;  // 防御：root 为 null 时跳过（body 未就绪等）
  if (thState.scanRunning) {
    // 扫描执行中：合并请求，不并发再起一轮
    if (!thState.scanPendingRoot) thState.scanPendingRoot = root;
    else if (thState.scanPendingRoot !== root) thState.scanPendingRoot = document.body || document.documentElement;
    return;
  }
  if (thState.scanScheduled) return;
  thState.scanScheduled = true;
  thMark('hint:sched');   // 埋点：进入空闲调度排队的时刻
  const run = () => {
    thState.scanScheduled = false;
    thMark('hint:runStart');  // 埋点：真正开跑（与 hint:sched 之差＝空闲回调等待，最长 2000ms）
    if (!thState.enabled) return;
    thState.scanRunning = true;
    // 反思（2026-08-30 第一百八十三次）：门闸只靠 onDone 复位，onDone 不来就是"整页永久停扫且无日志"
    //   （本次「生词提示消失」即此形态）。加看门狗：本轮 30s 未回报即强制解闸并出声，
    //   既不遮蔽问题（console.error 打出），又不至于让用户永远看不到高亮。
    let settled = false;
    const release = (byWatchdog) => {
      if (settled) return;
      settled = true;
      if (_scanWatchdog) { clearTimeout(_scanWatchdog); _scanWatchdog = null; }
      thState.scanRunning = false;
      if (byWatchdog) {
        console.error('[VocabRadar][text-hint] 扫描 30s 未完成，强制解除 scanRunning 门闸（本轮结果可能不完整）');
      }
      const pending = thState.scanPendingRoot;
      thState.scanPendingRoot = null;
      if (pending && thState.enabled) scheduleScan(pending);
    };
    if (_scanWatchdog) clearTimeout(_scanWatchdog);
    _scanWatchdog = setTimeout(() => release(true), 30000);
    scanSubtree(root, () => release(false));
  };
  if ('requestIdleCallback' in window) {
    requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 200);
  }
}

/** TreeWalker 遍历文本节点，分批处理
 * @param {Node} root 扫描根
 * @param {Function} [onDone] 全部批次处理完毕（或提前终止）时回调一次；
 *        供 scheduleScan 解除 scanRunning 门闸用。OCR 等直接调用方不传。
 */
export function scanSubtree(root, onDone) {
  const done = () => { if (typeof onDone === 'function') { try { onDone(); } catch (e) { /* 忽略 */ } } };
  // 扫描前清理失效高亮（框架更新 DOM 导致的 textContent 错位）
  if (root === document.body) cleanupStaleSpans();
  // 反思（2026-08-06）：用户要求"翻译过多，只翻译可见正文区域"。
  //   旧版扫描全部文本节点（包括视口外），导致大量不必要的翻译请求。
  //   修正：仅处理视口内（含上下各1屏缓冲）的文本节点，减少翻译量。
  //   滚动时通过 _scrollScanPending 触发重新扫描，补充新进入视口的节点。
  // 反思（2026-08-30 第一百八十三次）：用户报障「视频网站中，网页的生词提示消失」（正文完全无高亮）。
  //   旧版 vh 取 window.innerHeight||0，某些视频站在全屏/画中画切换瞬间 innerHeight 读到 0，
  //   视口条件退化为 `rect.bottom<0 || rect.top>0`，几乎全部文本节点被 REJECT → 整页无高亮且无日志。
  //   修正：退到 documentElement.clientHeight；仍拿不到高度时直接放弃视口过滤（宁多扫不漏扫）。
  const vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
  const skipViewportFilter = !(vh > 0);
  if (skipViewportFilter) {
    console.warn('[VocabRadar][text-hint] 视口高度读到 0，本轮跳过视口过滤（全量扫描）');
  }
  const walkBound = vh * 2;  // 上下各1屏缓冲
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // 反思（2026-08-05 修正）：parent.dataset[PROCESSED_ATTR] 永远返回 undefined
      //   （dataset 键为驼峰式 beaverDone，非 data-beaver-done），
      //   导致已处理节点不被跳过、重复扫描。改用 hasAttribute 精确判断。
      if (parent.hasAttribute && parent.hasAttribute(PROCESSED_ATTR)) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
      // 非正文 ARIA 角色 + 可见性过滤（2026-08-06）
      //   closest() 一次检查所有祖先：aria-hidden / contenteditable / 非正文 role
      //   参考 Readability.js 的内容区域识别 + 沙拉查词的选词范围限制
      if (parent.closest && parent.closest(NON_CONTENT_SELECTOR)) {
        return NodeFilter.FILTER_REJECT;
      }
      // display:none 过滤：offsetParent===null 表示元素或祖先被 display:none 隐藏
      //   例外：position:fixed 元素 offsetParent 也为 null 但可见，需排除
      if (parent.offsetParent === null) {
        const pos = getComputedStyle(parent).position;
        if (pos !== 'fixed') return NodeFilter.FILTER_REJECT;
      }
      // 已在我们高亮 span 内
      if (parent.classList && parent.classList.contains(HIGHLIGHT_CLASS)) {
        return NodeFilter.FILTER_REJECT;
      }
      // 防递归注释：跳过本扩展自身创建的元素（sidebar、overlay、tooltip、panel）
      // 否则 TreeWalker 会扫描 sidebar 内的注释文本，对注释结果再次注释
      // OCR 面板（#beaver-ocr-panel）也跳过：由 showOcrResultPanel 手动调 scanSubtree 注释
      // 诊断面板（#beaver-debug-panel）也跳过：防止面板自身文本被高亮，干扰诊断
      // 反思（2026-08-30 第一百八十三次）：本行是全文件唯一缺 `parent.closest &&` 守卫者
      //   （对比上方 NON_CONTENT_SELECTOR 分支）。XML/SVG 等特殊节点的 parentElement 没有
      //   closest 方法，此处会抛 TypeError；异常从 acceptNode 冒出会中断 walker.nextNode()
      //   循环（该循环无 try/catch）→ scanSubtree 的 done() 永不执行 → scanRunning 永久为 true
      //   → 之后所有 scheduleScan 静默 return，整页永久无高亮且无任何日志。补齐守卫。
      if (parent.closest && parent.closest('#beaver-sidebar, #beaver-web-sidebar, #beaver-subtitle-overlay, #beaver-hint-tooltip, #beaver-context-panel, #beaver-ocr-panel, #beaver-debug-panel')) {
        return NodeFilter.FILTER_REJECT;
      }
      if (node.nodeValue.trim().length < 2) return NodeFilter.FILTER_REJECT;
      // 可见性检查：仅处理视口附近（上下各1屏缓冲）的节点
      if (skipViewportFilter) return NodeFilter.FILTER_ACCEPT;
      const rect = parent.getBoundingClientRect();
      if (rect.bottom < -walkBound || rect.top > vh + walkBound) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  // 反思（2026-08-30 第一百八十三次）：遍历阶段原先裸奔——acceptNode 内任何异常
  //   都会从 walker.nextNode() 抛出，越过下方的分批 .catch，使 done() 永不执行，
  //   scanRunning 永久卡 true（全页永久停扫）。这是"生词提示消失"的首号根因。
  //   修正：遍历包 try/catch，异常不遮蔽（console.error 打出），已收集到的节点照常处理。
  const all = [];
  thMark('hint:walkStart');
  try {
    while (walker.nextNode()) all.push(walker.currentNode);
  } catch (e) {
    console.error('[VocabRadar][text-hint] TreeWalker 遍历中断（已收集 ' + all.length + ' 个节点，继续处理）:', e);
  }
  thMark('hint:walkEnd');
  thAdd('nodes', all.length);
  // 分批
  let i = 0;
  const BATCH = 50;
  const next = () => {
    if (!thState.enabled || i >= all.length) { done(); return; }
    const end = Math.min(i + BATCH, all.length);
    const batch = all.slice(i, end);
    i = end;
    thAdd('batches', 1);
    processBatch(batch).then(() => {
      if (i < all.length) {
        // 第二百零七次（用户："你在分屏处理么…咋要处理这么多？"）：批间空闲超时 1000→250ms——
        //   忙页（SPA 持续占主线程）会一路顶到超时，11 批白等 11s；250ms 取衡。
        if ('requestIdleCallback' in window) requestIdleCallback(next, { timeout: 250 });
      } else {
        thMark('hint:scanDone');
        done();
      }
    }).catch(() => { done(); });
  };
  next();
}

/** 处理一批文本节点（每批 50 个，一次扫描屏）
 * 反思（2026-08-11 第三十三次）：添加 try/catch 防止 surroundContents 异常中断扫描。
 * 反思（2026-08-16 第七十二次）：批次级账本——processBatch 创建一个 stats，
 *   各 processTextNode 累计入同一 stats，批次结束调 logBatch 打印一次统计
 *   （不再每个文本节点都打印，避免日志刷屏）。
 * 反思（2026-08-19 第八十次）：扫描期间置词典静音（setQuietBatch(true)），
 *   使 dictionary 的 ①②③ 逐词日志不在批量扫描时刷屏，一屏只打印 logBatch 一条统计
 *   （用户："扫描出来一屏的单词没有打印统计，是统计，不是逐条打印"）。
 */
export async function processBatch(textNodes) {
  const stats = beginBatch('text-hint', '分屏扫描（每批' + textNodes.length + '节点）');
  setQuietBatch(true);
  try {
    // 第一百八十七次·性能修复（用户实测：串行查词 1069 次，扫描 4105ms 走完却无高亮）：
    //   processTextNode 是 for + await 串行，每个首见词在 lookupFull 里要走一次
    //   getWord 的 SW 消息往返；50 个节点一批就可能几百次往返串起来。
    //   改为**每批开跑前一次性批量预取**（prefetchFull → WORD_DB_GET_BATCH，
    //   SW 侧单事务并发 get），把本批词的完整记录一次取回内存；随后逐词查词全部
    //   命中内存，不再逐词往返。预取失败静默（退回原逐词路径，行为不变）。
    const preWords = [];
    for (const tn of textNodes) {
      const t = tn && tn.nodeValue;
      if (!t || t.trim().length < 2) continue;
      for (const m of t.matchAll(WORD_G_PATTERN)) {
        if (SELECT_PATTERN.test(m[0]) && !JS_SENTINELS.has(m[0].toLowerCase())) preWords.push(m[0].toLowerCase());
      }
    }
    try { await prefetchFull(preWords); } catch (e) { /* 预取失败不影响本批 */ }
    for (const tn of textNodes) {
      if (!thState.enabled) break;
      if (!tn.isConnected) continue;
      try {
        await processTextNode(tn, stats);
      } catch (e) {
        // 单个节点失败不中断整个批次
        console.warn('[VocabRadar][text-hint] processTextNode 失败:', e && e.message);
      }
    }
  } finally {
    setQuietBatch(false);
  }
  logBatch(stats);
}

/**
 * 获取 block 原始文本（供 web-sidebar 同源读取）
 * 反思（2026-08-16 第六十八次）：单一来源架构——页面"先选出"原文本记录到块上，
 *   文本侧栏直接读取（不自行重扫）。记录时机在首个文本节点包裹前，此时块内其余文本节点
 *   仍是原文，因此需跳过已注入的 .beaver-side-ann 侧邻注释；拼接规则与 web-sidebar
 *   getBlockText 一致（相邻文本补空格、块级元素补换行、跳过隐藏元素）。
 * @param {Element} block 块级容器
 * @returns {string} 原文本（无侧邻注释）
 */
export function getBlockOriginText(block) {
  const parts = [];
  const BLOCK_TAGS = new Set(['P','DIV','LI','TD','TH','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','DD','DT','CAPTION','FIGCAPTION','ARTICLE','SECTION','MAIN','TR','UL','OL','TABLE','BR']);
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      const el = node.parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      try {
        if (el.closest && el.closest('.' + SIDE_ANN_CLASS)) return NodeFilter.FILTER_REJECT;
      } catch (e) { /* ignore */ }
      try {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      } catch (e) { /* ignore */ }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  while (walker.nextNode()) {
    const node = walker.currentNode;
    let txt = node.textContent || '';
    const el = node.parentElement;
    if (el && BLOCK_TAGS.has(el.tagName)) {
      txt = '\n' + txt + '\n';
    }
    if (parts.length > 0) {
      const prev = parts[parts.length - 1];
      if (prev && txt && !/[\s\u00a0\u3000]$/.test(prev) && !/^[\s\u00a0\u3000]/.test(txt)) {
        parts.push(' ');
      }
    }
    parts.push(txt);
  }
  return parts.join('');
}

/** 处理单个文本节点：提取单词 → 查词 → 包裹高亮 */
export async function processTextNode(textNode, stats) {
  const text = textNode.nodeValue;
  if (!text || text.trim().length < 2) return;

  const parent = textNode.parentElement;
  if (!parent || parent.hasAttribute(PROCESSED_ATTR)) return;
  parent.setAttribute(PROCESSED_ATTR, '1');

  // 反思（2026-08-16 第六十八次）：单一来源——本块首个文本节点处理时，把块原始文本
  //   记录到 data-beaver-orig，供文本侧栏直接读取（不自行重扫、不重复注释）。
  //   幂等：首次记录后不再覆盖；此时块内其余文本节点仍是原文，仅需跳过已注入的侧邻注释。
  // 反思（2026-08-16 第七十一次）：block 变量提升到函数级，供总线 emit 复用——
  //   总线推全块原文本（data-beaver-orig）而非本文本节点片段，保证侧栏句子与旧 span
  //   路径一致（完整句子而非碎片），片段会破坏拆句（"The quick brown " 与 "fox jumps"）。
  let scanBlock = null;
  try {
    // 块选择器与 web-sidebar scanPageTextFromSpans 一致（同块 → 同源），避免记录在
    //   更大的 article/section/main 上导致侧栏按其内层 div 读不到 data-beaver-orig。
    const block = parent.closest('p, div, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, caption, figcaption, label');
    scanBlock = block;
    if (block && !block.dataset.beaverOrig) {
      const orig = getBlockOriginText(block);
      if (orig && orig.trim().length >= 3) {
        block.dataset.beaverOrig = orig;
      }
    }
  } catch (e) { /* 记录失败不影响高亮 */ }

  // 提取单词及位置
  // 反思（2026-08-06）：过滤 JS 特殊值（NaN/undefined/Infinity），
  //   这些是页面 JS 异常产生的文本，非真实单词，不应高亮
  const words = [];
  for (const m of text.matchAll(WORD_G_PATTERN)) {
    if (SELECT_PATTERN.test(m[0]) && !JS_SENTINELS.has(m[0].toLowerCase())) {
      words.push({ word: m[0], start: m.index, end: m.index + m[0].length });
    }
  }
  if (words.length === 0) return;

  // 反思（2026-08-15 第六十二次）：注释重复生词默认不选——同一文本节点内
  //   重复出现的词只注释首次（对应 2026-07-28"一行之中你注释了两次"的修复）；
  //   勾选后每次出现都包裹高亮。
  if (!thState.annotateRepeat) {
    const seen = new Set();
    const dedup = [];
    for (const w of words) {
      const lower = w.word.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      dedup.push(w);
    }
    words.length = 0;
    words.push(...dedup);
  }

  // 查词：词典同步命中 + 表外 translator 异步
  const highlights = [];
  // 反思（2026-08-16 第七十二次）：批次级账本——stats 由 processBatch 创建，
  //   本函数累计 chars/tokens/unique + 各属性 dict/asm + 跳过计数，
  //   不再每个文本节点都创建/打印。
  countChars(stats, text.length);
  countTokens(stats, words.length);
  const batchUnique = new Set();
  // 反思（2026-08-28 第一百六十九次）：词典未就绪时 lookupFull 直接 return null，
  //   这种"假 null"绝不能写进 wordCache（否则词典就绪后重扫仍命中缓存 →"生词很少"）。
  //   dictReady 在循环外取一次即可：同一批次内装载状态不会来回翻转，
  //   即便中途就绪，本批漏缓存只是多查一次，不会产生错误结果。
  const dictReady = isDictLoaded();
  for (const w of words) {
    if (!batchUnique.has(w.word.toLowerCase())) { batchUnique.add(w.word.toLowerCase()); countUnique(stats, 1); }
    const lower = w.word.toLowerCase();
    let info = thState.wordCache.get(lower);
    if (info === undefined) {
      info = await queryWord(lower, w.word, stats);
      thAdd('queries', 1);   // 埋点：逐词串行查词次数（每词 1~3 次 SW 往返）
      // 只在词典已就绪时缓存 null（此时 null 表示"确定为高频词/表外词"）；
      // 未就绪时的 null 不可信，留待词典就绪后重查。
      if (info !== null || dictReady) thState.wordCache.set(lower, info);
    } else {
      // 本批未重新查词典（全局缓存命中）
      incScalar(stats, 'cacheHit');
    }
    if (info && info.isWord) {
      const isFirst = !thState.seenWords.has(lower);
      thState.seenWords.add(lower);
      highlights.push({ ...w, ...info, isFirst });
    }
  }

  if (highlights.length === 0) return;
  if (!textNode.isConnected || textNode.nodeValue !== text) return;

  // 包裹（从后往前，避免位置偏移）
  for (let i = highlights.length - 1; i >= 0; i--) {
    try {
      wrapWordAt(textNode, highlights[i]);
    } catch (e) {
      console.warn('[VocabRadar][text-hint] wrap 失败', e);
    }
  }

  // 反思（2026-08-16 第七十一次）：单次扫描总线——把块文本 + 注释结果推给
  //   文本侧栏（text-hint 是唯一扫描器，侧栏不二次扫描）。词条带 rank/tags/
  //   translations/lemma/isFirst，翻译异步完成前 translations 可能为空，
  //   侧栏对 pending 词自行 translate 回填（与旧 span 路径行为一致）。
  //   文本取全块原文本（data-beaver-orig，无侧邻注释）而非本节点片段——侧栏拆句
  //   需完整句子；块内各文本节点都携带同一全块文本，侧栏按 _seenSentences 去重，
  //   每个句子只在其词条所在节点推送时落入（与旧 span 路径"块原文+span词过滤"一致）。
  const emitText = (scanBlock && scanBlock.dataset && scanBlock.dataset.beaverOrig)
    ? scanBlock.dataset.beaverOrig
    : text;
  // 第二百零七次（用户要求重申："网页提示依旧走全规则（整页 TreeWalker），
  //   只有他保留了菜单"）：撤销 206 次的容器 emit 过滤——菜单/导航词必须进侧栏，
  //   总线恢复全量 emit（词集对账"仅网页 21"即过滤误伤的实证）。
  try {
    emitBlock({
      text: emitText,
      words: highlights.map((h) => ({
        word: h.word,
        rank: h.rank,
        tags: h.tags || [],
        translations: h.translations || [],
        lemma: h.lemma || '',
        isFirst: h.isFirst !== false
      }))
    });
  } catch (e) { console.warn('[VocabRadar][scan-bus] emitBlock 失败:', e); }
}


/**
 * 查询单词，返回高亮信息或 null
 * @param {string} lower 小写单词
 * @param {string} original 原始大小写
 * @returns {Promise<{isWord,rank,tags,translations}|null>}
 *
 * 用途：高亮包裹（processTextNode 调用）。受 _rankThreshold 限制：
 *   - rank<=阈值的高频词 → 返回 null（不高亮）
 *   - 词典命中且超阈值 → 返回 info（释义异步获取，不阻塞高亮）
 *   - 表外单词 → 返回 info（rank=null，释义异步获取）
 *
 * 反思（2026-07-07）：原注释称"右键查询也用此函数"，但右键查询不应受阈值限制
 * （用户主动查词有啥显示啥）。已新增 queryWordForPanel 专供右键面板，此函数
 * 保留阈值过滤供高亮使用。原实现与 annotator.getAnnotations 内部查词逻辑重复，
 * 曾因两边 tokenizer 不一致导致"同阈值不同结果"，现统一调用共享 lookupWord。
 *
 * 反思（2026-08-02 修正）：用户反馈"原先有个设计，词典查不到释义就跳过。
 *   现在取消词典了，是不是仍然沿用此逻辑？没有释义先标出来。"
 *   旧版 translate 返回 null 时 queryWord 也返回 null（不高亮），
 *   导致"注释生僻词"开关未开或翻译失败时所有词都不高亮。
 *   修正：先返回高亮信息（rank+tags），释义异步获取。
 *   translate 仍调用（用于缓存和后续 hover 显示释义），但不阻塞高亮。
 *   翻译成功后通过 _wordCache 更新（下次该词出现时已有缓存）。
 *
 * 反思（2026-08-16 第七十次）：数据来源账本——rank/lemma/tags 的来源由
 *   lookupFull 在 needsMaps 决策点真实计数（本函数把 stats 透传过去）；
 *   释义的来源在本函数决策点计数（IDB 译文命中=dict，否则在线获取=asm）；
 *   高频/表外跳过也在本函数真实计数。
 */
export async function queryWord(lower, original, stats) {
  // 反思（2026-08-13 第五十次）：统一词典——高亮路径优先从 IDB 读
  //   rank/lemma/tags（lookupFull），词典内单词刷新页面/换网站后不再重建；
  //   仅 IDB 未命中才走 lookupWord（Maps 组装，lookupFull 会写回 IDB）。
  //   lookupWord 保留作回退（IDB 读取失败时降级）。
  let full = null;
  try { full = await lookupFull(lower, stats); } catch (e) { /* IDB 失败降级到 lookupWord */ }
  let rank = null;
  let tags = [];
  let lemma = null;
  if (!full) {
    // lookupFull 异常降级：此路径未在 lookupFull 计数，此处补记组装来源
    const info = lookupWord(lower, thState.rankThreshold);
    if (!info) {
      if (stats) incScalar(stats, 'highFreq'); // 高频词（rank<=阈值）
      return null;
    }
    rank = info.rank;
    tags = info.tags || [];
    lemma = info.lemma || null;
    if (stats) { incField(stats, 'rank', 'asm'); incField(stats, 'lemma', 'asm'); incField(stats, 'tags', 'asm'); }
  } else {
    rank = full.rank;
    tags = full.tags || [];
    lemma = full.lemma || null;
    // IDB 命中路径需手动做高频过滤（lookupWord 内部已做，此处补上）
    if (rank !== null && typeof rank === 'number' && isFinite(rank) && rank <= thState.rankThreshold) {
      if (stats) incScalar(stats, 'highFreq');
      return null;
    }
  }

  // 反思（2026-08-07）：annotateOov=false 时跳过表外词（rank=null）
  //   与 sidebar.js 行为一致：表外词不注释、不收集
  //   右键查询不受此限（queryWordForPanel 不检查，用户主动查词有啥显示啥）
  if (rank === null && !thState.annotateOov) {
    if (stats) incScalar(stats, 'oov');
    return null;
  }

  // 反思（2026-08-15 第六十四次）：翻译同一通道——
  //   查询时若统一词典 IDB 已有目标语言译文（translationLang===_targetLang），
  //   直接同步返回该译文，不再异步 translate。否则首次出现的 span 无释义，
  //   侧邻注释回填走的是 translate 的结果；两次走不同数据源会产生不同译文。
  if (full && full.translation && full.translationLang === thState.targetLang) {
    if (stats) incField(stats, 'trans', 'dict');
    return {
      isWord: true,
      rank,
      tags,
      lemma,
      translations: [full.translation]
    };
  }

  // 先返回高亮信息（rank + tags + lemma），不等待翻译
  // 反思（2026-08-02）：用户要求"没有释义先标出来"，
  //   不再因 translate 返回 null 而跳过高亮
  // 反思（2026-08-02 修正）：传递 lemma（词形还原原形）供浮层显示
  const result = {
    isWord: true,
    rank,        // 词典命中为数字，表外为 null
    tags,
    lemma,       // 词形还原原形（running→run，直接命中为 null）
    translations: []  // 释义暂为空，异步获取后通过 _wordCache 更新
  };

  // 异步获取释义（不阻塞高亮）：
  // - 成功：缓存到 _wordCache，下次该词出现时 translations 已就绪
  //   同时回填到已渲染的 .beaver-word span（侧邻注释异步回填）
  // - 失败/开关未开：translations 保持空数组，word 仍被高亮
  //   hover 浮层显示"暂无释义"（与右键面板一致）
  // 反思（2026-08-06）：扩展更新后 chrome.runtime 上下文失效，跳过翻译避免刷屏
  if (!isContextValid()) return result;
  // 释义账：词典无目标语言译文 → 需在线翻译获取（结果写回 IDB，下次直读）
  if (stats) incField(stats, 'trans', 'asm');
  translate(original).then((translated) => {
    if (translated) {
      // 更新缓存：下次该词出现时直接命中
      thState.wordCache.set(lower, {
        isWord: true,
        rank,
        tags,
        lemma,
        translations: [translated]
      });
      // 侧邻注释异步回填（2026-08-05）：找到所有该词的 .beaver-word span，
      //   更新 dataset.translations 并追加 .beaver-side-ann (释义)
      //   反思：首次出现时 translations 为空未插入 .beaver-side-ann，
      //   翻译完成后回填，用户无需 hover 即可看到释义
      if (thState.colors.sideAnnotation && thState.enabled) {
        backfillSideAnnotation(lower, [translated]);
      }
    }
  }).catch((e) => {
    // 扩展更新/重载后旧内容脚本的 chrome.runtime 上下文失效，翻译必然失败
    // 这是预期行为（非真实错误），标记后跳过后续翻译，避免控制台刷屏
    const msg = e && (e.message || String(e));
    if (msg && /Extension context invalidated/.test(msg)) {
      thState.contextInvalidated = true;
      return;
    }
    console.warn(`[VocabRadar][text-hint] 异步翻译失败: ${original}`, e);
  });

  return result;
}

/** 用 span 包裹文本节点内 [start, end) 区间；对应类别关闭则跳过 */
export function wrapWordAt(textNode, h) {
  // 反思（2026-08-06）：始终包裹所有出现（首次+后续），不再因 laterEnabled=false 跳过后续。
  //   后续出现的可见性由 CSS .beaver-hide-later 控制（零重扫切换）。
  //   firstEnabled 恒为 true（首次出现总是高亮），保留判断以防未来变更。
  if (h.isFirst && !thState.colors.firstEnabled) return;
  const range = document.createRange();
  range.setStart(textNode, h.start);
  range.setEnd(textNode, h.end);
  const span = document.createElement('span');
  // 首次加 FIRST_CLASS，后续加 LATER_CLASS（用于 CSS 控制可见性）
  span.className = HIGHLIGHT_CLASS + (h.isFirst ? ' ' + FIRST_CLASS : ' ' + LATER_CLASS);
  span.dataset.word = h.word;
  // NaN 防御：rank 为非有限数字时存空串，避免 dataset.rank='NaN' → onWordHover Number('NaN')=NaN
  span.dataset.rank = (typeof h.rank === 'number' && isFinite(h.rank)) ? String(h.rank) : '';
  span.dataset.tags = (h.tags || []).join(',');
  span.dataset.translations = (h.translations || []).join('；');
  // 词形还原原形（仅词形还原后命中时非空，如 running→run；直接命中或表外为空）
  span.dataset.lemma = h.lemma || '';
  range.surroundContents(span);
  thState.wrapCount++;  // 诊断计数（2026-08-14 第五十四次）
  // 第一百八十七次·埋点缺失修补：上一轮（第一百八十六次）建链路计时时只写了
  //   hint:firstAnn，漏了 hint:firstHighlight，导致诊断窗恒显示"★首个高亮 未发生"——
  //   那不是真实症状而是埋点没打，属"看不见即误判"。此处补上（thMark 首次为准）。
  thMark('hint:firstHighlight');

  // 侧邻注释（2026-08-05）：启用且有释义时，在 span 后插入 (释义) 兄弟节点
  //   异步翻译完成时通过 appendSideAnnotation 回填（queryWord translate.then 调用）
  if (thState.colors.sideAnnotation && h.translations && h.translations.length > 0) {
    appendSideAnnotation(span, h.translations);
  }

  span.addEventListener('mouseenter', onWordHover);
  span.addEventListener('mouseleave', onWordLeave);
  span.addEventListener('click', onWordClick);
  // 第一百一十二次：标记"直绑监听器已挂"。Firefox 下部分动态 span 的直绑监听器
  // 可能因未知机制失效（用户实测：前几个有悬浮提示、之后只有高亮无悬浮）——
  // 文档级委托兜底（installDelegationGuard）据此判定是否代为触发。
  span.__beaverDirect = true;
}

/**
 * 文档级事件委托兜底（第一百一十二次）：直绑监听器未生效的 .beaver-word span
 * 由 capture 阶段委托触发同样的 hover/leave/click 处理；直绑正常时按时间戳去重跳过。
 * 触发即打 warn 日志（诊断信号：证明存在监听器丢失现象）。
 */
export function installDelegationGuard() {
  if (window.__beaverHintDelegation) return;
  window.__beaverHintDelegation = true;
  // 反思（2026-08-30 第一百八十二次）：用户报障「视频侧栏的句子 高亮词鼠标滑过后会去掉底色」。
  //   根因：本 hit() 是全文件唯一没有排除自家侧栏的函数（其余 8 处都跳过 #beaver-sidebar）。
  //   视频侧栏的 .beaver-word 由 vs/subtitle-renderer.js 生成、无 dataset.word、无 __beaverDirect，
  //   于是被这里的委托当成「直绑失效的正文 span」→ onWordHover → validateSpan 读不到 dataset 必失败
  //   → unwrapSingle 把 span 拆掉 → 底色随类名一起消失（文字和括号注释还留着）。
  //   修正：命中后若落在两个侧栏内一律视为未命中，交由侧栏自身的事件处理。
  const hit = (e) => {
    const el = (e.target && e.target.closest) ? e.target.closest('.' + HIGHLIGHT_CLASS) : null;
    if (!el || !el.isConnected) return null;
    if (el.closest('#beaver-sidebar, #beaver-web-sidebar, #beaver-subtitle-overlay')) return null;
    return el;
  };
  document.addEventListener('mouseover', (e) => {
    const el = hit(e);
    if (!el) return;
    const now = Date.now();
    if (now - (el.__beaverLastHover || 0) < 150) return;
    el.__beaverLastHover = now;
    if (el.__beaverDirect) return;
    console.warn('[VocabRadar][text-hint] hover 委托兜底触发（该 span 直接监听器未生效）word=', el.dataset.word);
    onWordHover({ currentTarget: el, stopPropagation() {} });
  }, { capture: true });
  document.addEventListener('mouseout', (e) => {
    const el = hit(e);
    if (!el || el.__beaverDirect) return;
    const now = Date.now();
    if (now - (el.__beaverLastHover || 0) >= 0 && !el.__beaverDirect) onWordLeave();
  }, { capture: true });
  document.addEventListener('click', (e) => {
    const el = hit(e);
    if (!el) return;
    const now = Date.now();
    if (now - (el.__beaverLastClick || 0) < 300) return;
    el.__beaverLastClick = now;
    if (el.__beaverDirect) return;
    onWordClick({ currentTarget: el, stopPropagation() {} });
  }, { capture: true });
}

/**
 * 在 .beaver-word span 后插入/更新侧邻注释 (释义) 兄弟节点
 * 侧邻注释（2026-08-05）：半角括号，释义用独立配色（--beaver-ann-bg/fg）
 *   - 若 span 后已存在 .beaver-side-ann 兄弟，更新其文本（避免重复插入）
 *   - 若无，创建 <span class="beaver-side-ann">(释义)</span> 插入到 span.nextSibling 前
 *   - 释义取第一条（短义项），多条用；分隔
 *
 * 反思（2026-08-30 第一百八十次，用户报障"依旧重复：Skip(跳) to main content /
 *   Skip(跳) to Ask Learn chat experience"）：processTextNode 的 annotateRepeat 去重
 *   只作用于**单个文本节点内部**，同一个词出现在不同块（如两个 skip-link）时各自都是
 *   该节点内的首次，于是都挂上了 (释义)，与「注释重复生词」开关的语义不符
 *   （用户预期是整页只注释首次）。页级"是否首次"信息其实已有：wrapWordAt 依据
 *   thState.seenWords 给后续出现的 span 打 LATER_CLASS。故此处消费该标记：
 *   未勾选「注释重复生词」时，LATER_CLASS 的 span 不挂侧邻注释。
 *   与侧栏句子 tab 第一百七十九次的判据（ws/scanner.js 按 isFirst 卡住）同语义、
 *   同受该开关控制。高亮本身不受影响（后续出现仍高亮，可见性由 .beaver-hide-later 管）。
 * @param {HTMLElement} span .beaver-word span
 * @param {string[]} translations 释义数组
 */
export function appendSideAnnotation(span, translations) {
  if (!span || !translations || translations.length === 0) return;
  // 第一百八十次：页级去重——非首次出现的词，未开开关时不注释
  if (!thState.annotateRepeat && span.classList && span.classList.contains(LATER_CLASS)) return;
  const transText = translations.map((x) => cleanDictEntry(x)).filter(Boolean).join('；');
  if (!transText) return;
  // 检查是否已有侧邻注释兄弟节点（避免重复插入）
  let annSpan = span.nextElementSibling;
  if (!annSpan || !annSpan.classList || !annSpan.classList.contains(SIDE_ANN_CLASS)) {
    annSpan = document.createElement('span');
    annSpan.className = SIDE_ANN_CLASS;
    span.parentNode.insertBefore(annSpan, span.nextSibling);
  }
  annSpan.textContent = '(' + transText + ')';
  thMark('hint:firstAnn');   // 埋点：首条侧注释可见时刻
}

/**
 * 异步回填侧邻注释到所有该词的 .beaver-word span
 * 侧邻注释（2026-08-05）：翻译完成后调用，回填到已渲染但未含释义的 span
 *   - 跳过视频提示内的 span（侧栏有独立渲染逻辑）
 *   - 跳过失效 span（textContent 与 dataset.word 不符，框架已改动 DOM）
 *   - 更新 dataset.translations 并追加 .beaver-side-ann
 * @param {string} lower 小写单词
 * @param {string[]} translations 释义数组
 */
export function backfillSideAnnotation(lower, translations) {
  if (!lower || !translations || translations.length === 0) return;
  const spans = document.querySelectorAll('.' + HIGHLIGHT_CLASS);
  spans.forEach((span) => {
    // 跳过视频提示内的 span（侧栏有独立渲染，不复用文本提示的侧邻注释）
    // 跳过字幕 overlay（由 subtitle-overlay.js 独立渲染，无 dataset.word）
    if (span.closest && span.closest('#beaver-sidebar, #beaver-web-sidebar, #beaver-subtitle-overlay')) return;
    // 大小写不敏感匹配 data-word
    const word = span.dataset.word;
    if (!word || word.toLowerCase() !== lower) return;
    // 校验 span 仍有效（框架可能改动 textContent）
    if (!validateSpan(span)) return;
    // 更新 dataset.translations
    // 第一百二十三次：过滤括号不配对的截断残片（历史缓存中的半截释义）
    const okTrans = translations.filter((s) => Boolean(s) && isBalancedParens(s));
    span.dataset.translations = okTrans.join('；');
    // 追加侧邻注释（appendSideAnnotation 内部已处理去重）
    appendSideAnnotation(span, okTrans);
  });
}

/**
 * 遍历所有 .beaver-word span，根据当前 _rankThreshold 和 _annotateOov
 * 切换 .beaver-word-hidden class（不改变 DOM 结构，仅切换 class）
 * 反思（2026-08-11 第三十三次）：用 CSS class 代替 unwrapAll，避免 DOM 修改触发白屏
 */
export function updateWordVisibility() {
  document.querySelectorAll('.' + HIGHLIGHT_CLASS).forEach((span) => {
    if (span.closest && span.closest('#beaver-sidebar, #beaver-web-sidebar, #beaver-subtitle-overlay, #beaver-debug-panel')) return;
    const rankStr = span.dataset.rank;
    const rank = rankStr ? parseInt(rankStr, 10) : NaN;
    let shouldHide = false;
    if (isNaN(rank)) {
      // 表外词：受 _annotateOov 控制
      shouldHide = !thState.annotateOov;
    } else {
      // 词典命中：受 _rankThreshold 控制（rank<=阈值=高频词=隐藏）
      shouldHide = rank <= thState.rankThreshold;
    }
    span.classList.toggle(HIDE_WORD_CLASS, shouldHide);
  });
}

/**
 * 清除所有 PROCESSED_ATTR 标记（阈值降低时让 TreeWalker 重新扫描已跳过的节点）
 */
export function clearProcessedAttr() {
  document.querySelectorAll('[' + PROCESSED_ATTR + ']').forEach((el) => {
    if (el.closest && el.closest('#beaver-sidebar, #beaver-web-sidebar, #beaver-subtitle-overlay, #beaver-debug-panel')) return;
    el.removeAttribute(PROCESSED_ATTR);
  });
}

export function unwrapSingle(el) {
  const parent = el.parentNode;
  if (!parent) return;
  // 侧邻注释（2026-08-05）：同步移除 span 后紧跟的 .beaver-side-ann 兄弟
  const annSibling = el.nextElementSibling;
  if (annSibling && annSibling.classList && annSibling.classList.contains(SIDE_ANN_CLASS)) {
    annSibling.remove();
  }
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
  // 反思（2026-08-11）：不调 parent.normalize()，避免触发网站脚本 DOM 响应
}

/**
 * 校验高亮 span 是否仍有效（textContent 仍是 dataset.word）
 * @returns {boolean} 有效返回 true，失效返回 false（调用方应 unwrap）
 */
export function validateSpan(el) {
  const word = el.dataset.word;
  if (!word) return false;
  // textContent 可能含首尾空白，trim 后比较；大小写不敏感（原词可能首字母大写）
  return el.textContent.trim().toLowerCase() === word.toLowerCase();
}

/** 清理全文档所有失效的 beaver-word span（扫描前/SPA 切换时调用） */
export function cleanupStaleSpans() {
  const stale = [];
  document.querySelectorAll('.' + HIGHLIGHT_CLASS).forEach((el) => {
    // 跳过侧栏内的 span：侧栏有独立渲染，不因 textContent 校验而剥掉高亮
    // 跳过字幕 overlay：由 subtitle-overlay.js 独立渲染，无 dataset.word，校验必败
    if (el.closest && el.closest('#beaver-sidebar, #beaver-web-sidebar, #beaver-subtitle-overlay')) return;
    if (!validateSpan(el)) stale.push(el);
  });
  for (const el of stale) unwrapSingle(el);
  // 诊断（2026-08-30 第一百八十二次）：用户报障「视频网站中，网页的生词先会高亮又消失」。
  //   剥离动作此前完全无痕，无法区分是本函数、unwrapAll 还是 observer 干的。
  //   此处按"失效原因"分类留痕（无 dataset / 文本不符），下次可一眼定位剥离者。
  if (stale.length > 0) {
    const noData = stale.filter((el) => !el.dataset.word).length;
    console.warn('[VocabRadar][text-hint] 清理失效高亮 ' + stale.length +
      ' 个（无 dataset.word=' + noData + '，文本不符=' + (stale.length - noData) + '）');
  }
}

// === 移除所有高亮 ===

export function unwrapAll() {
  // 反思（2026-07-28 #bug1）：侧边栏(#beaver-sidebar)有独立的生词注释渲染，
  //   unwrapAll 不应移除侧栏内的 .beaver-word 元素。否则切换词频阈值时
  //   text-hint 侧的 unwrapAll 会剥掉侧栏生词的高亮包裹，导致注释颜色丢失。
  // 反思（2026-08-11 第二十九次）：移除所有 normalize() 调用。
  //   用户诊断确认 normalize() 是破坏正文的元凶：document.body.normalize()
  //   递归合并所有后代文本节点，触发网站脚本 DOM 变化响应，导致正文被重新渲染或丢失。
  // 反思（2026-08-30 第一百八十二次）：补上 #beaver-subtitle-overlay。
  //   视频页上 text-hint 与 subtitle-overlay 必然同页共存（manifest 中 text-hint.js
  //   对 <all_urls> 无 exclude），overlay 的 .beaver-word 由 subtitle-overlay.js 独立渲染，
  //   原先会被这里一并剥掉；同时加剥离计数留痕，供"高亮又消失"追溯。
  let _unwrapped = 0;
  document.querySelectorAll('.' + HIGHLIGHT_CLASS).forEach((el) => {
    if (el.closest && el.closest('#beaver-sidebar, #beaver-web-sidebar, #beaver-subtitle-overlay')) return;  // 跳过侧栏/字幕 overlay 元素
    const parent = el.parentNode;
    if (!parent) return;
    // 侧邻注释（2026-08-05）：移除 span 后紧跟的 .beaver-side-ann 兄弟节点
    //   先移除兄弟再 unwrap，避免 .beaver-side-ann 残留显示释义而无生词
    const annSibling = el.nextElementSibling;
    if (annSibling && annSibling.classList && annSibling.classList.contains(SIDE_ANN_CLASS)) {
      annSibling.remove();
    }
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    _unwrapped++;
    // 反思（2026-08-11）：不调 parent.normalize()，避免触发网站脚本 DOM 响应
  });
  // 侧邻注释（2026-08-05）：清理孤立的 .beaver-side-ann（span 已被框架移除但 ann 残留）
  document.querySelectorAll('.' + SIDE_ANN_CLASS).forEach((el) => {
    if (el.closest && el.closest('#beaver-sidebar, #beaver-web-sidebar, #beaver-subtitle-overlay')) return;  // 跳过侧栏/字幕 overlay 元素
    el.remove();
  });
  document.querySelectorAll('[' + PROCESSED_ATTR + ']').forEach((el) => {
    if (el.closest && el.closest('#beaver-sidebar, #beaver-web-sidebar, #beaver-subtitle-overlay')) return;  // 跳过侧栏/字幕 overlay
    el.removeAttribute(PROCESSED_ATTR);
  });
  // 诊断（2026-08-30 第一百八十二次）：剥离全部高亮是"高亮又消失"最猛的一条路径，
  //   此前无痕。打印剥离数量，便于与 stopHint/clearHighlights 的日志对齐定位调用者。
  if (_unwrapped > 0) {
    console.warn('[VocabRadar][text-hint] 已剥离全部正文高亮 ' + _unwrapped + ' 个');
  }
}

// === MutationObserver：增量扫描新节点 ===

export function startObserver() {
  if (thState.observer) thState.observer.disconnect();
  thState.observer = new MutationObserver((mutations) => {
    if (!thState.enabled) return;
    for (const m of mutations) {
      // 新增节点：增量扫描
      for (const n of m.addedNodes) {
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        // 跳过我们自己的浮层/面板
        if (n.id === TOOLTIP_ID || n.id === PANEL_ID || n.id === STYLE_ID) continue;
        if (n.closest && n.closest('#' + TOOLTIP_ID + ', #' + PANEL_ID)) continue;
        // 跳过侧边栏（#beaver-sidebar）：侧边栏有独立的生词注释渲染逻辑，
        //   文本提示 MutationObserver 不应扫描/包裹侧栏内的生词，避免与侧栏 .beaver-word 样式冲突
        //   （2026-07-28 #bug1：切换词频阈值后，text-hint 重新包裹侧栏内容导致注释颜色丢失）
        if (n.id === 'beaver-sidebar' || (n.closest && n.closest('#beaver-sidebar, #beaver-web-sidebar'))) continue;
        // 反思（2026-08-11 第三十三次）：跳过 web-sidebar 和诊断面板，
        //   防止面板日志 div 触发 scheduleScan 造成无谓扫描
        if (n.id === 'beaver-web-sidebar' || (n.closest && n.closest('#beaver-web-sidebar, #beaver-debug-panel'))) continue;
        // 反思（2026-08-30 第一百八十二次）：跳过视频内字幕 overlay。
        //   subtitle-overlay.js 每次字幕换行都整体替换 innerHTML，新节点里的 .beaver-word
        //   无 dataset.word；若被这里调度扫描，text-hint 会把它当正文重新包裹/清理。
        if (n.id === 'beaver-subtitle-overlay' || (n.closest && n.closest('#beaver-subtitle-overlay'))) continue;
        // 跳过 beaver-word 和 beaver-side-ann 自身（防止重复扫描已包裹的内容）
        if (n.classList && (n.classList.contains(HIGHLIGHT_CLASS) || n.classList.contains(SIDE_ANN_CLASS))) continue;
        scheduleScan(n);
      }
      // 文本变化：若发生在 beaver-word span 内，span 内容已被框架改动 → 清理失效 span
      // （避免高亮出现在已被替换成中文/空的旧位置，即"凭空造词"）
      if (m.type === 'characterData') {
        const parent = m.target.parentElement;
        if (parent && parent.classList && parent.classList.contains(HIGHLIGHT_CLASS)) {
          // 反思（2026-08-30 第一百八十二次）：用户报障「视频网站中，网页的生词先会高亮又消失」。
          //   本分支原先没有任何容器跳过，是全文件唯一的遗漏点。视频页上 text-hint 与
          //   video-sidebar / subtitle-overlay 必然同页共存（manifest 中 text-hint.js
          //   对 <all_urls> 无 exclude），侧栏与 overlay 的 .beaver-word 由
          //   vs/subtitle-renderer.js、subtitle-overlay.js 生成且不带 dataset.word，
          //   字幕滚动时的文本变更会命中这里 → validateSpan 读不到 dataset 必失败
          //   → unwrapSingle 把 span 拆掉。修正：与其余清理函数取齐，跳过自家容器。
          if (parent.closest && parent.closest('#beaver-sidebar, #beaver-web-sidebar, #beaver-subtitle-overlay, #beaver-debug-panel')) continue;
          if (!validateSpan(parent)) unwrapSingle(parent);
        }
      }
    }
  });
  // 反思（2026-08-12 第四十四次）：body 可能未就绪（Bing 等特殊页面），
  //   waitForBody 已确保 body 存在，但仍做防御性检查
  const observeTarget = document.body || document.documentElement;
  if (!observeTarget) return;
  thState.observer.observe(observeTarget, { childList: true, subtree: true, characterData: true });
}

/**
 * 诊断信息（2026-08-14 第五十四次）：供诊断悬浮窗展示文本提示运行状态。
 * 返回当前生效的实值（设置、词典、词形、扫描计数、浮层状态），便于定位
 * "网页无提示"等问题的真实根因。
 */
export async function getDiagState() {
  const settings = await new Promise((resolve) => {
    try {
      chrome.storage.local.get({
        textHintEnabled: true, sidebarEnabled: true, webSidebarEnabled: true,
        sourceLanguage: 'en', targetLanguage: 'zh', rankThreshold: 5000,
        annotateOov: false, hintFirstEnabled: true, hintSideAnnotation: false,
        uiLanguage: 'en'
      }, resolve);
    } catch (_) { resolve({}); }
  });
  const dict = getDictDiagState();
  const lem = getLemmatizerDiagState();
  const sample = {};
  // 反思（2026-08-28 第一百六十九次）：诊断样本查词也会触发 query.js 的
  //   ①②③ 逐词日志，诊断窗每次刷新都刷屏。用 quiet 括起来（引用计数安全）。
  setQuietBatch(true);
  try {
    for (const w of ['hello', 'computer', 'running', 'bilibili']) {
      try {
        // 反思（2026-08-14 第五十六次修正）：lookupFull 是 async，旧版未 await
        //   → r 是 Promise 对象，isWord/rank/lemma 全部 undefined，样本永远显示
        //   {tags:null, trans:null}，误导"词典没实现"。补 await。
        const r = await lookupFull(w);
        if (!r) { sample[w] = { error: '词典未就绪' }; continue; }
        sample[w] = {
          isWord: r.isWord, rank: r.rank, lemma: r.lemma,
          tags: (r.tags || []).length ? r.tags.join(',') : null,
          trans: r.pending ? 'pending' : ((r.translations && r.translations[0]) || null)
        };
      } catch (e) {
        sample[w] = { error: String(e && e.message || e) };
      }
    }
  } finally {
    setQuietBatch(false);
  }
  return {
    url: location.href,
    settings: {
      textHintEnabled: settings.textHintEnabled, sidebarEnabled: settings.sidebarEnabled,
      webSidebarEnabled: settings.webSidebarEnabled,
      sourceLanguage: settings.sourceLanguage, targetLanguage: settings.targetLanguage,
      rankThreshold: settings.rankThreshold, annotateOov: settings.annotateOov,
      uiLanguage: settings.uiLanguage
    },
    effective: {
      enabled: thState.enabled, rankThreshold: thState.rankThreshold, annotateOov: thState.annotateOov,
      annotateRepeat: thState.annotateRepeat,
      sideAnnotation: thState.colors ? thState.colors.sideAnnotation : null,
      firstEnabled: thState.colors ? thState.colors.firstEnabled : null,
      startedEver: thState.startedEver, lastStartError: thState.lastStartError,
      contextValid: isContextValid()
    },
    dict,
    lemmatizer: lem,
    // 第一百八十六次：全链路分段计时进诊断——用户症状「解析至多一秒，但体感好几秒才出现提示」，
    //   解析之外的耗时（空闲回调等待、词典装载、逐词串行查词、批间等待）必须能被看见。
    timing: getHintTiming(),
    counts: {
      wrappedWords: thState.wrapCount, seenWords: thState.seenWords.size, queryCache: thState.wordCache.size
    },
    // 第一百八十三次：扫描门闸进诊断字段——scanRunning 卡 true 是"整页无高亮"的隐形根因，
    //   不进快照就永远看不见（本次报障即此形态）。
    scan: {
      scanRunning: thState.scanRunning, scanScheduled: thState.scanScheduled,
      scanPendingRoot: thState.scanPendingRoot ? (thState.scanPendingRoot.nodeName || 'node') : null
    },
    // 反思（2026-08-16 第七十次）：词典层数据来源账本——最近几批"整句/逐块"处理的
    //   文本字符/分词/去重单词 与 各属性(rank/lemma/tags/释义) 词典直读 vs 组装 的真实计数。
    //   页内各处理模块（annotator 整句 / text-hint 逐块）共用同一账本，此处统一展示。
    stats: getBatches(),
    ui: {
      tooltipVisible: !!(document.getElementById('beaver-hint-tooltip') && document.getElementById('beaver-hint-tooltip').style.display !== 'none'),
      panelVisible: !!(document.getElementById('beaver-context-panel') && document.getElementById('beaver-context-panel').style.display !== 'none'),
      panelExists: !!document.getElementById('beaver-context-panel'),
      tooltipExists: !!document.getElementById('beaver-hint-tooltip')
    },
    sample,
    lang: navigator.language
  };
}
