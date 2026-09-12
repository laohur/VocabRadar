// VocabRadar 全站网页侧栏 —— 扫描与渲染模块（scanner）
// 职责：页面文本扫描调度（扫描总线接入、data-beaver-orig 的 span 扫描、TreeWalker 兜底扫描）、
//       句子入库与去重、标注计算与缓存、异步翻译与音标回填、句槽与单词面板的 DOM 渲染、
//       滚动增量扫描监听的启停。
// 说明：由 web-sidebar-impl.js 机械拆分而来，代码逐字保留，未改动任何逻辑。
//       跨模块共享状态一律来自 ./core.js，写入走 core 导出的 set_xxx 接缝，绝不另存副本。

import { getAnnotations, rankToStage } from '../../lib/annotator.js';
import { isBalancedParens, pickCleanShortTrans } from '../../lib/dict-clean.js';
import { t } from '../../lib/i18n.js';
// 2026-09-04（原形折叠）：diverse-lemmas 语言名单（纯数据无依赖），用于判定
// 当前目标语是否有词形还原覆盖；无覆盖语种不显示常显原形（中/日原形即本身，无意义）。
import { LANGUAGES } from '../../lib/vendor/diverse-lemmas/languages.js';
// 第一百八十五次：扫描筛选常量的唯一定义处（与「给 AI 提取正文」共用同一套标准）
import { JS_SENTINELS, NON_CONTENT_SELECTOR, SKIP_TAGS } from '../../lib/main-text.js';
import { getPhonetic } from '../../lib/phonetics.js';
import { lemmaFamily } from '../../lib/lemmatizer.js';
import { translate } from '../../lib/translator.js';
import { getBlocks, getLastEmitAt, subscribe } from '../page-scan-bus.js';
import { _activeTab, _allAnnotations, _annotateOov, _annotateRepeat, _annTemplate, _annotationsCache, _cachedLearnLang, _collectedSubs, _detailMode, _firstSentMap, _noAnnotation, _pageSentenceEls, _pageSentences, _rankThreshold, _root, _scanScheduled, _seenSentences, _seenWords, addSentenceKey, addWordKey, cssEscape, escapeHtml, escapeReg, formatTime, getBlockText, hasSentenceKey, hasWordKey, log, normSentKey, set_allAnnotations, set_annotationsCache, set_collectedSubs, set_firstSentMap, set_pageSentenceEls, set_pageSentences, set_scanScheduled, set_seenSentences, set_seenWords, splitSentences } from './core.js';
// 280次：annBrackets 布尔退役改 annTemplate 模板——渲染走模板拆分（pre+释义+post）
import { splitAnnTemplate } from '../../lib/styles.js';

// === 扫描常量（与 text-hint-impl.js 同源）===
// 反思（2026-08-09）：用户反馈"文本侧栏句子比网页文本提示多了很多，很多垃圾。二者应当用一个筛选"。
//   根因：web-sidebar 的 SKIP_TAGS / NON_CONTENT_SELECTOR 与 text-hint-impl.js 不完全一致，
//   web-sidebar 缺少 [role="alert"] 过滤，且句子最小长度为 3 而 text-hint 为 2。
//   修正：完全对齐 text-hint-impl.js 的筛选逻辑，确保二者使用同一套筛选标准。
// 第一百八十五次：三个常量（SKIP_TAGS / NON_CONTENT_SELECTOR / JS_SENTINELS）上移至
//   lib/main-text.js 统一定义，本文件改为导入。理由：新增的「给 AI 提取正文」也要用同一套
//   筛选标准，若在两处各写一份，日后必然再次分叉（正是 2026-08-09 那次故障的成因）。
//   导入语句见文件顶部 import 区。

let _scanGen = 0;                 // 扫描代际计数（rank 变化时递增，使旧标记失效）

// 第一百八十三次：句子重复入库被拦下的累计次数（appendPageSentence 最终关口用，仅供日志）
let _dupSentenceBlocked = 0;

// === 第一百八十八次：词表去重诊断计数器（用户"文本生词重复还没解决"）===
// 反思：键集(addWordKey)/数组(insertAnnotationsOrdered)/DOM查重(querySelector)/
//   重排去重(resortWordPanel) 四层防护静态审查全部在位，187 轮改动也未引入新路径，
//   纯推理已无法定位重复来源 —— 按工作区规则"想不出来就加专门的诊断悬浮窗"，
//   本计数器抓收词全链路的每一层流量，插入后立即自查同键条目数，
//   一旦出现重复现场，console.warn 打出词面、seq、面板状态等完整证据，绝不静默。
// 查看：控制台 window.__beaverWsDedup（实时引用，非快照）。
const _wsDiag = {
  collectCalls: 0,     // collectToWordPanel 被调用次数
  offered: 0,          // 递到 filter 的注释总数
  blockedOov: 0,       // 表外词未开开关被挡
  blockedHighRank: 0,  // 高频词（rank<=阈值）被挡
  blockedBatch: 0,     // 批内已见（batchSeen）被挡
  blockedKey: 0,       // 全局键集（addWordKey）判"已收"被挡
  accepted: 0,         // 通过 filter 进入入表流程
  domDupBlocked: 0,    // DOM 查重挡掉（键集说没收、DOM 里却有 = 防护层间失联的证据）
  inserted: 0,         // 实际插入 DOM 的条目
  dupOnInsert: 0,      // 插入后同键条目数 >1 的现场次数（重复实锤）
  resortDupRemoved: 0, // 重排时从数组清除的同键重复条数
  sentGateBlocked: 0   // 第二百三十次：新词门闸拦下的无新词句累计数（句表侧，三条路径共用）
};
if (typeof window !== 'undefined') window.__beaverWsDedup = _wsDiag;   // 实时引用

// 第一百八十八次补充：重复现场事件流（诊断悬浮窗直接展示，用户无需开控制台）。
//   上限 10 条防刷屏；dupOnInsert/domDupBlocked/resortDupRemoved 三类失联现场同步 push。
const _wsDupEvents = [];
_wsDiag.events = _wsDupEvents;
function _wsDupNote(msg) {
  const rec = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
  _wsDupEvents.push(rec);
  if (_wsDupEvents.length > 10) _wsDupEvents.shift();
}

// 第二百三十一次（用户："新词门闸拦下无新词句"日志太频繁，一页刷 9 条）：限频出声——
//   首条照打，之后 60s 至多一条并汇报区间压制量。计数器 _wsDiag.sentGateBlocked 仍
//   全量递增（诊断窗/实时引用不受影响），只是不再逐条刷屏；真异常时线索仍在。
let _lastSentGateWarn = 0;   // 上次出声时间戳（0=从未）
let _sentGateSuppressed = 0; // 区间内被压制的条数
function warnSentGate(sample) {
  _wsDiag.sentGateBlocked++;
  const now = Date.now();
  if (!_lastSentGateWarn || now - _lastSentGateWarn > 60000) {
    const supp = _sentGateSuppressed;
    _sentGateSuppressed = 0;
    _lastSentGateWarn = now;
    console.warn(`[VocabRadar][web-sidebar] 新词门闸拦下无新词句（累计 ${_wsDiag.sentGateBlocked} 次${supp ? `，区间已压制 ${supp} 条` : ''}）: ${sample}`);
  } else {
    _sentGateSuppressed++;
  }
}

// === 第一百九十次：侧栏现状快照（诊断悬浮窗「侧栏现状」行数据源）===
// 词表内零重复实锤（__beaverWsDedup 三个失联字段全 0）后，把"重复"排查面
// 扩展到侧栏 DOM 整体：词表条目数、同 data-word 直读重复、句子面板条目数。
if (typeof window !== 'undefined') {
  window.__beaverWsPanelStats = function () {
    try {
      if (!_root) return null;
      const wp = _root.querySelector('#beaver-web-word-panel');
      const sp = _root.querySelector('#beaver-web-sentence-panel');
      const items = wp ? Array.from(wp.querySelectorAll('.beaver-web-word-item')) : [];
      const byWord = new Map();
      for (const el of items) {
        const k = el.dataset.word || '(空)';
        byWord.set(k, (byWord.get(k) || 0) + 1);
      }
      const dups = [];
      for (const [k, n] of byWord) if (n > 1) dups.push(k + '×' + n);
      return {
        words: items.length,
        uniq: byWord.size,
        dupCount: dups.length,
        dupKeys: dups.slice(0, 8).join('、'),
        // 第二百四十六次：只数真句子槽位（.beaver-web-sub-item）——旧口径 childElementCount
        //   会把 empty-tip 占位自身也计成"1 条句子"，0 命中场景误导排查（用户实测"句子 1 条
        //   却一直 Scanning"即此）。
        sentences: sp ? sp.querySelectorAll('.beaver-web-sub-item').length : -1,
        arrLen: _allAnnotations.length
      };
    } catch (e) { return { err: (e && e.message) || String(e) }; }
  };
}

// 第一百九十三次：词集对账诊断（用户："网页提示的生词跟文本侧栏的生词也不对应"）。
//   网页侧取 text-hint 高亮全集（.beaver-word 的 dataset.word，含透明的 later span——
//   侧栏词表本就"每词一条"不区分首现/后续，对账口径应取全集），统一 trim+小写；
//   侧栏侧取词表条目的 data-word（已是 wordDedupKey）。返回两个集合的互差，
//   供诊断悬浮窗「词集对账」行与控制台直接调用定位差异在哪一侧。
if (typeof window !== 'undefined') {
  window.__beaverWordCompare = function () {
    try {
      if (!_root) return { err: 'web-sidebar 未启动' };
      const page = new Map();
      for (const el of document.querySelectorAll('.beaver-word')) {
        if (el.closest && el.closest('#beaver-web-sidebar, #beaver-sidebar, #beaver-subtitle-overlay')) continue;
        const w = (el.dataset && el.dataset.word) ? String(el.dataset.word).trim().toLowerCase() : '';
        if (!w) continue;
        page.set(w, (page.get(w) || 0) + 1);
      }
      const panel = new Map();
      const wp = _root.querySelector('#beaver-web-word-panel');
      for (const el of (wp ? wp.querySelectorAll('.beaver-web-word-item') : [])) {
        const w = el.dataset.word || '';
        if (!w) continue;
        panel.set(w, (panel.get(w) || 0) + 1);
      }
      const onlyPage = [];
      const onlyPanel = [];
      for (const [w, n] of page) if (!panel.has(w)) onlyPage.push(n > 1 ? w + '×' + n : w);
      for (const [w, n] of panel) if (!page.has(w)) onlyPanel.push(n > 1 ? w + '×' + n : w);
      return {
        pageCount: page.size, panelCount: panel.size,
        onlyPageTotal: onlyPage.length, onlyPanelTotal: onlyPanel.length,
        onlyPage: onlyPage.slice(0, 8), onlyPanel: onlyPanel.slice(0, 8)
      };
    } catch (e) { return { err: (e && e.message) || String(e) }; }
  };
}

// 第一百八十三次：已回放过的总线 lastEmitAt（防 ensureScanBusSubscribed 被多次调用时重复回放历史块）
let _replayedEmitAt = 0;

let _scrollScanTimer = null;

let _scrollHandler = null;

// === 页面文本扫描（主功能）===

/** 调度扫描（requestIdleCallback / setTimeout） */
export function schedulePageScan() {
  if (!_root || _root.classList.contains('closed')) return;
  if (_scanScheduled) return;
  set_scanScheduled(true);
  const run = () => {
    set_scanScheduled(false);
    if (!_root) return;
    scanPageText();
  };
  if ('requestIdleCallback' in window) {
    requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 200);
  }
}

/**
 * 页面文本扫描——优先消费 page-scan-bus（text-hint 单次扫描产出），无产出才回退
 *
 * 反思（2026-08-09）：用户反馈"文本侧栏选取的内容一团乱麻，直接复用网页中的文本提示，不要新设"。
 *   旧版用 TreeWalker 独立扫描文本节点 + getAnnotations 查词，与 text-hint 逻辑重复且不一致。
 *   后改为直接查询页面上的 .beaver-word span（由 text-hint-impl.js 创建），从 span dataset
 *   提取词频/标签/释义，按句子分组显示。
 *
 * 反思（2026-08-09 第二次）：用户反馈"文本侧栏词汇内容为空了"。
 *   根因：text-hint 默认关闭（textHintEnabled=false），页面无 .beaver-word span，
 *   scanPageText 查询 0 个 span 直接 return → 句标签和词汇标签都为空。
 *   修正：当 .beaver-word span 为 0 时，用 TreeWalker + getAnnotations 做 fallback 扫描。
 *
 * 反思（2026-08-16 第七十一次）：① 单次扫描——text-hint 是页面唯一扫描器，结果经
 *   page-scan-bus 推送（live + 启动回放 getBlocks），侧栏不再 querySelectorAll('.beaver-word')
 *   二次扫描（旧版两个 content script 各扫一遍 → 两条"页面扫描"日志 + 时序不一致）。
 *   text-hint 关 → 总线空 → 侧栏走自身 fallback（TreeWalker 独立扫描）；
 *   text-hint 开 → 总线推送 → 侧栏不重复扫描。任意一方开关都不影响对方。
 */
let _fallbackScanAttempted = false;  // fallback 扫描是否已尝试（避免重复 fallback）

let _spanRetryScheduled = false;     // span 重试是否已调度

// 第一百九十四次：text-hint 开启时，兜底扫描前允许总线再等的轮数（每轮 3s）。
//   词典冷装载实测 4~17s，首轮 3s 重试大概率仍空；此时若直接兜底，兜底句（初始视口）
//   先入库、总线句（含视口上方内容）后入库，页面词序与侧栏顺序必然错开。
let _busWaitRetries = 0;
const BUS_WAIT_MAX = 3;              // 最多再等 3 轮（合计约 12s），覆盖词典冷装载大半窗口

function scanPageText() {
  if (!_root) return;
  // 首选：总线已有 text-hint 扫描结果（单次扫描，不重复扫描）
  const busBlocks = getBlocks();
  if (busBlocks.length > 0) {
    log(`页面扫描: 复用 text-hint 扫描结果 ${busBlocks.length} 块（page-scan-bus 单次扫描，不二次扫描）`);
    _fallbackScanAttempted = false;
    for (const b of busBlocks) ingestPageBlock(b);
    return;
  }
  // 无总线产出：延迟重试一次（text-hint 可能正在加载），仍无再回退
  if (!_spanRetryScheduled) {
    _spanRetryScheduled = true;
    setTimeout(async () => {
      _spanRetryScheduled = false;
      if (!_root) return;
      const retryBlocks = getBlocks();
      if (retryBlocks.length > 0) {
        log(`页面扫描: 重试后复用 text-hint 扫描结果 ${retryBlocks.length} 块（page-scan-bus 单次扫描，不二次扫描）`);
        for (const b of retryBlocks) ingestPageBlock(b);
        return;
      }
      if (_fallbackScanAttempted) return;
      // 第一百九十四次（用户："网页提示的顺序跟文本侧栏的顺序不对应"）：
      //   text-hint 开启时绝不轻易走兜底——兜底只有初始视口，且兜底句先入、总线句后入，
      //   侧栏顺序（句面板、词表 seq）与页面词序必然错开；兜底 getAnnotations 的分词/
      //   词表口径与 text-hint 也不完全一致（词集漂移）。故开启时先多等几轮总线，
      //   等满仍无产出才真正兜底（覆盖 text-hint 失常场景）。
      //   判定口径与 text-hint.js 对账一致：仅显式 false 才算关闭（undefined=启用）。
      let hintOn = true;
      try {
        const res = await new Promise((resolve) => {
          try { chrome.storage.local.get({ textHintEnabled: true }, resolve); } catch (_) { resolve({}); }
        });
        hintOn = (res.textHintEnabled !== false);
      } catch (_) { /* 读取异常按启用处理 */ }
      // 第二百次：text-hint 启动链路死亡的明确信号（__beaverHintBoot.ok===false，
      //   由 text-hint.js 的 import 失败/挂起路径写入）时不再空等剩余轮次——
      //   等也等不来，立即走兜底，避免"侧栏扫描超过 30 秒"的体感。
      let bootDead = false;
      try { bootDead = !!(window.__beaverHintBoot && window.__beaverHintBoot.ok === false); } catch (_) { /* ignore */ }
      if (hintOn && !bootDead && _busWaitRetries < BUS_WAIT_MAX) {
        _busWaitRetries++;
        // 2026-09-08 第二百四十次（日志降噪，用户批复）：中间轮静默重试，仅末轮打印一次
        if (_busWaitRetries === BUS_WAIT_MAX) {
          log(`页面扫描: 总线仍无产出（text-hint 开启，词典可能冷装载中），已重试 ${_busWaitRetries}/${BUS_WAIT_MAX} 轮，下轮转兜底扫描`);
        }
        scanPageText();
        return;
      }
      if (bootDead) {
        log('页面扫描: 检测到 text-hint 启动失败（boot.ok=false），跳过剩余等待，立即走兜底扫描');
      }
      _fallbackScanAttempted = true;
      // text-hint 未产出但页面已有 .beaver-word span（历史高亮），走旧 span 路径兜底
      const legacySpans = document.querySelectorAll('.beaver-word');
      if (legacySpans.length > 0) {
        log(`页面扫描: 总线无产出但页面有 ${legacySpans.length} 个 .beaver-word span，走旧 span 路径兜底`);
        scanPageTextFromSpans(legacySpans);
      } else {
        // 完全无产出：TreeWalker 独立扫描兜底（text-hint 关闭时的正常路径）
        scanPageTextFallback();
      }
    }, 3000);
  }
}

/**
 * 第一百九十三次：句-词归属判据——与渲染端 highlightWords 完全同判据（\b 词边界 + 忽略大小写）。
 *   旧版用 includes 子串判定：总线词 "rate" 会被含 "moderate" 的句子误收——
 *   注释行渲染不出来（\b 不命中，span 根本不生成）但 collectToWordPanel 照收进词表，
 *   词表里于是出现"网页上哪儿都没高亮"的词，正是「网页提示的生词跟侧栏不对应」来源之一。
 *   收词、渲染、归属三处同键同判据后，词表词 ⊆ 网页高亮词。
 * @param {string} sentLower 句子小写文本
 * @param {string} wordLower 词小写（wordDedupKey 口径）
 * @returns {boolean}
 */
function sentHasWord(sentLower, wordLower) {
  if (!sentLower || !wordLower) return false;
  try {
    return new RegExp('\\b' + escapeReg(wordLower) + '\\b', 'i').test(sentLower);
  } catch (e) {
    return sentLower.includes(wordLower);   // 正则构造异常时退回子串判定
  }
}

/**
 * 消费总线单块扫描结果（text-hint 产出的 { text, words:[...注释] }）
 * 反思（2026-08-16 第七十一次）：与旧 span 路径同一套"拆句 → 句子去重 → 按句过滤词 →
 *   appendPageSentence + pending 词异步翻译回填"逻辑，仅注释词来源改为总线词条
 *   （word/rank/tags/translations/lemma/isFirst），不再读 DOM dataset。
 * @param {{text:string, words:Array}} block 总线块
 */
function ingestPageBlock(block) {
  if (!_root || !block || !block.text) return;
  const fullText = block.text;
  if (fullText.trim().length < 3) return;
  // 拆句（与 span 路径同一拆分规则）
  const sentences = splitSentences(fullText);
  if (sentences.length === 0) return;
  // 总线块内词条（小写去重，与 span 路径 seenInSent 一致）
  const blockWords = [];
  const seenWord = new Set();
  for (const w of (block.words || [])) {
    const lower = (w && w.word) ? w.word.toLowerCase() : '';
    if (!lower || seenWord.has(lower)) continue;
    seenWord.add(lower);
    blockWords.push(w);
  }
  // 反思（2026-08-22 第九十三次）：block.all=true（引导页 OCR 喂入）时整行必收——
  //   用户反馈"文本侧栏抓取的内容少，即便降低词频也无动于衷"：旧语义只收"句含生词"的句子，
  //   OCR 结果多为常用词句子，几乎全被丢弃且与阈值无关。网页扫描块不带 all，旧语义不变。
  //   命中的词条仍照常带上（注释渲染+词汇面板收集），无命中的行作为纯文本句子收录。
  const forceAll = block.all === true;
  if (blockWords.length === 0 && !forceAll) return;

  for (const sent of sentences) {
    if (sent.length < 3) continue;
    const sentLower = sent.toLowerCase();
    // 反思（2026-08-16 第七十一次）：总线下同一块的每个文本节点都推全块文本，
    //   句子首次出现只带"当前节点"的词条。此处把后续节点推送的新词条并入已有句子，
    //   与旧 span 路径"块内所有 .beaver-word 都注释该句"保持一致的词条覆盖度。
    if (hasSentenceKey(sent)) {
      mergeAnnotationsForSentence(sent, sentLower, blockWords);
      continue;
    }
    // 句子必须包含至少一个总线词条（与 span 路径 sentWords 判定一致）；forceAll 时豁免
    const anns = [];
    for (const w of blockWords) {
      const word = w.word;
      // 第一百九十三次：includes 子串 → sentHasWord 词边界（与渲染同判据，防误收）
      if (!sentHasWord(sentLower, word.toLowerCase())) continue;
      anns.push({
        word,
        tags: w.tags || [],
        translations: w.translations || [],
        rank: (typeof w.rank === 'number' && isFinite(w.rank)) ? w.rank : null,
        isFirst: w.isFirst !== false,
        lemma: w.lemma || '',
        pending: !(w.translations && w.translations.length)
      });
    }
    if (anns.length === 0 && !forceAll) continue;
    // 第二百三十次（用户："生词重复。"，Microsoft Learn 左导航 8 行各自成句、各含
    //   documentation → 句表收 8 条）：新词门闸——句子注释词全部已在页级首现句权威表
    //   _firstSentMap（第193次）登记过、无任何新词时不再入库。此处提前挡下，省掉
    //   schedulePendingTranslate 的无谓查词；forceAll（OCR/ASR all=true 整行必收）豁免。
    //   注意：本路径拦下时不调 appendPageSentence → 不 addSentenceKey，同一句文本
    //   后续块若带来新词仍可正常入库，旧词覆盖度由 mergeAnnotationsForSentence 补齐。
    if (!forceAll && anns.length > 0 && anns.every((w) => _firstSentMap.has(wordDedupKey(w.word)))) {
      warnSentGate(sent.slice(0, 40));
      continue;
    }
    // 第一百八十三次：addSentenceKey 已收进 appendPageSentence（唯一汇入点统一去重）。
    appendPageSentence({ text: sent }, anns, { forceAll });
    schedulePendingTranslate(anns);
  }
}

/**
 * 把总线新推送的词条并入已存在的句子（词条覆盖度对齐旧 span 路径）。
 * @param {string} sent 句子原文本
 * @param {string} sentLower 句子小写文本
 * @param {Array} blockWords 总线块内词条
 */
function mergeAnnotationsForSentence(sent, sentLower, blockWords) {
  // 第一百八十三次（用户："文本侧栏的句子会重复"）：旧版用 `s.text === sent` 精确相等查已有句子，
  //   而去重键走的是 normSentKey（小写+空白折叠）。两套口径不一致时——总线块把同一可见句
  //   以不同空白形态再推一遍——hasSentenceKey 判为"已存在"走到这里，却又 find 不到 existing
  //   而静默 return，新词条丢失；改用同一 normSentKey 口径比对。
  const key = normSentKey(sent);
  const existing = _pageSentences.find((s) => normSentKey(s.text) === key);
  if (!existing) return;
  const p = _annotationsCache.get(existing);
  if (!p) return;
  Promise.resolve(p).then((anns) => {
    if (!Array.isArray(anns)) return;
    // 第一百七十七次：并入判重键统一为 wordDedupKey（trim+小写），
    //   与 collectToWordPanel / appendWordPanelItems / createWordPanelItem 同键，
    //   否则总线推来带空白的词面会绕过判重，重复并入注释数组并重复进生词面板。
    const have = new Set(anns.map((a) => wordDedupKey(a.word)));
    const fresh = [];
    for (const w of blockWords) {
      const word = w.word;
      if (have.has(wordDedupKey(word))) continue;
      // 第一百九十三次：includes 子串 → sentHasWord 词边界（与渲染同判据，防误收）
      if (!sentHasWord(sentLower, word.toLowerCase())) continue;
      fresh.push({
        word,
        tags: w.tags || [],
        translations: w.translations || [],
        rank: (typeof w.rank === 'number' && isFinite(w.rank)) ? w.rank : null,
        isFirst: w.isFirst !== false,
        lemma: w.lemma || '',
        pending: !(w.translations && w.translations.length)
      });
    }
    if (fresh.length === 0) return;
    // 第一百九十三次：fresh 词补登记页级首现句权威表——appendPageSentence 只登记入库时的
    //   anns，merge 补进来的词在此定格首现句（已在他句登记过的自然跳过）。
    //   检查与登记同在同步块内，无 await 间隔，与 core.js _firstSentMap 注释的登记铁律一致。
    for (const f of fresh) {
      const wk = wordDedupKey(f.word);
      if (!wk || _firstSentMap.has(wk)) continue;
      _firstSentMap.set(wk, key);
    }
    anns.push(...fresh);
    const idx = _pageSentences.indexOf(existing);
    const slot = (idx >= 0) ? _root.querySelector(`.beaver-web-sub-item[data-source="page"][data-idx="${idx}"]`) : null;
    if (slot) fillSlotAnnotations(slot, existing, anns);
    // 第一百八十四次：补词的句序取该句在 _pageSentences 中的下标（不是末尾），
    //   句内序按合并后的 anns 下标算，故补词排在本句既有词之后、下一句之前。
    collectToWordPanel(fresh, idx, anns);
    schedulePendingTranslate(fresh);
  }).catch((e) => log('mergeAnnotationsForSentence 失败:', e));
}

/** pending 词异步翻译回填（与旧 span 路径一致，translator 有 word-cache 命中不重复请求） */
function schedulePendingTranslate(anns) {
  for (const ann of anns) {
    if (!(ann.pending && ann.word)) continue;
    const annWord = ann.word;
    translate(annWord, true).then((translated) => {
      if (translated) ann.translations = [translated];
      ann.pending = false;
      onAsyncTranslate(ann);
    }).catch(() => {
      ann.pending = false;
      onAsyncTranslate(ann);
    });
  }
}

/**
 * 总线 reset 事件处理（text-hint 重扫/清高亮/设置变化时发出）
 * 反思（2026-08-16 第七十一次）：清空页面扫描派生数据，等新一批 emit 重建列表，
 *   避免重扫后同句被 _seenSentences 去重挡住导致侧栏不更新。
 */
function onScanBusReset() {
  if (!_root) return;
  log('页面扫描: text-hint 已重扫/清空，侧栏清空页面数据等待新一批扫描结果');
  _annotationsCache.clear();
  set_collectedSubs(new WeakSet());
  set_seenWords(new Set());
  set_seenSentences(new Set());
  set_allAnnotations([]);
  // 第一百九十三次：首现句权威表随页级数据一并清空——text-hint 重扫后词的首现句要按新一轮入库序重定。
  set_firstSentMap(new Map());
  clearPageSentences();
  // 第一百八十三次：reset 后历史块允许再回放一次（旧标记作废），否则新一批列表建不起来。
  _replayedEmitAt = 0;
  const wp = _root.querySelector('#beaver-web-word-panel');
  if (wp) wp.innerHTML = `<div class="beaver-web-empty-tip">${t('ws.noWords')}</div>`;
}

/**
 * 从 .beaver-word span 扫描页面文本（text-hint 已启用的主路径）
 * @param {NodeListOf<Element>} allSpans 页面上所有 .beaver-word span
 */
function scanPageTextFromSpans(allSpans) {

  // 按 parent block 分组，避免同一句子重复处理
  const processedBlocks = new WeakSet();
  const BATCH = 50;
  let i = 0;
  // 反思（2026-08-16 第六十八次）：同源统计——记录取自"页面原文本"的块数与兜底块数
  let origBlocks = 0;   // 块文本来源 = text-hint 记录的 data-beaver-orig（页面选出，单一来源）
  let fallbackBlocks = 0; // 块文本来源 = getBlockText 兜底（旧 span 无记录时）

  const next = () => {
    if (!_root || i >= allSpans.length) {
      // 扫描收尾汇总日志（③：恢复"来源/词数/失败"明确日志）
      if (origBlocks > 0 || fallbackBlocks > 0) {
        log(`页面文本同源扫描完成: 块=${origBlocks + fallbackBlocks} 个（源 data-beaver-orig=${origBlocks}，getBlockText 兜底=${fallbackBlocks}）`);
      }
      // 第二百四十六次：扫描收尾——0 命中时无句入库，占位换"暂无生词"防永久滞留。
      finalizeScanningTip();
      return;
    }
    const end = Math.min(i + BATCH, allSpans.length);
    for (let j = i; j < end; j++) {
      const span = allSpans[j];
      if (!span.isConnected) continue;
      // 排除侧栏内部的 span
      if (span.closest && span.closest('#beaver-web-sidebar, #beaver-sidebar')) continue;

      // 找到包含该 span 的块级元素（句子容器）
      const block = span.closest('p, div, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, caption, figcaption, label');
      if (!block || processedBlocks.has(block)) continue;
      processedBlocks.add(block);

      // 获取块级文本：单一来源——优先 text-hint 记录的页面原文本（data-beaver-orig，
      //   页面"先选出"的原句），无记录才用 getBlockText 智能拼接兜底（旧 span）。
      // 反思（2026-08-16 第六十八次）：用户裁定"先页面选出，然后一路页面提示，一路送入
      //   文本侧栏，不要新设扫描"——句子原文以页面选出的原文本为准，注释集同源自页面词条。
      let fullText = null;
      if (block.dataset && block.dataset.beaverOrig && block.dataset.beaverOrig.trim().length >= 3) {
        fullText = block.dataset.beaverOrig;
        origBlocks++;
      } else {
        fullText = getBlockText(block);
        if (fullText && fullText.trim().length >= 3) fallbackBlocks++;
      }
      if (!fullText || fullText.trim().length < 3) continue;

      // 拆句
      const sentences = splitSentences(fullText);
      for (const sent of sentences) {
        if (sent.length < 3) continue;
        // 句子去重
        if (hasSentenceKey(sent)) continue;

        // 检查该句子是否包含 .beaver-word span 的词
        const blockSpans = block.querySelectorAll('.beaver-word');
        const sentLower = sent.toLowerCase();
        const sentWords = new Set();
        for (const s of blockSpans) {
          const w = s.dataset.word;
          // 第一百九十三次：includes 子串 → sentHasWord 词边界（与渲染同判据，防误收）
          if (w && sentHasWord(sentLower, w.toLowerCase())) {
            sentWords.add(w.toLowerCase());
          }
        }
        if (sentWords.size === 0) continue;

        // 从 span dataset 构建注释
        const anns = [];
        const seenInSent = new Set();
        for (const s of blockSpans) {
          const word = s.dataset.word;
          if (!word || seenInSent.has(word.toLowerCase())) continue;
          // 第一百九十三次：includes 子串 → sentHasWord 词边界（与渲染同判据，防误收）
          if (!sentHasWord(sentLower, word.toLowerCase())) continue;
          seenInSent.add(word.toLowerCase());

          const rankStr = s.dataset.rank;
          const rank = rankStr ? Number(rankStr) : null;
          const tags = s.dataset.tags ? s.dataset.tags.split(',').filter(Boolean) : [];
          const translations = s.dataset.translations ? s.dataset.translations.split('；').filter(Boolean) : [];
          const isFirst = !s.classList.contains('beaver-word-later');
          const lemma = s.dataset.lemma || '';

          anns.push({
            word,
            tags,
            translations,
            rank: (typeof rank === 'number' && isFinite(rank)) ? rank : null,
            isFirst,
            lemma,
            pending: translations.length === 0
          });
        }

        if (anns.length > 0) {
          // 第一百八十三次：去重统一由 appendPageSentence 把关，此处不再自行 addSentenceKey。
          appendPageSentence({ text: sent }, anns);

          // 反思（2026-08-10）：用户反馈"文本侧栏词汇中大部分没有释义，即便悬浮注释有"。
          //   根因：scanPageTextFromSpans 从 .beaver-word span 的 dataset.translations 读取释义，
          //   但 text-hint 的 translate 是异步的，sidebar 扫描时翻译可能尚未完成 → translations 为空。
          //   旧版无重试机制，pending 词永久无释义。而 text-hint 的 hover tooltip 后来能翻译
          //   是因为 onWordHover 中会调 translate(word, true) 触发翻译。二者流程不同导致差异。
          //   修正：对 pending 词主动调 translate(word, true) 获取释义，完成后通过 onAsyncTranslate 回填 UI。
          //   translator 有 word-cache 缓存，若 text-hint 已翻译过则直接命中缓存，不会重复请求。
          for (const ann of anns) {
            if (ann.pending && ann.word) {
              const annWord = ann.word;
              translate(annWord, true).then((translated) => {
                if (translated) {
                  ann.translations = [translated];
                }
                ann.pending = false;
                onAsyncTranslate(ann);
              }).catch(() => {
                ann.pending = false;
                onAsyncTranslate(ann);
              });
            }
          }
        }
      }
    }
    i = end;
    if (i < allSpans.length) {
      if ('requestIdleCallback' in window) requestIdleCallback(next, { timeout: 1000 });
      else setTimeout(next, 30);
    }
  };
  next();
}

/**
 * Fallback 扫描：当 text-hint 未启用（无 .beaver-word span）时，
 * 用视口 TreeWalker 自行提取正文，不依赖 Readability。
 *
 * 反思（2026-08-13）：用户要求"Readability提取正文太慢，抛弃 Readability，
 *   当前视口TreeWalker自行提取，Overlay 覆盖层高亮，不改 DOM"。
 *   根因：Readability.js 需要 DOMParser 克隆整个页面 DOM + 解析正文，大页面耗时 1-3 秒。
 *   修正：直接用 TreeWalker 遍历当前视口内可见的文本节点，
 *   按 block 元素分组拆句，用 getAnnotations 查词。
 *   优点：无外部依赖、无 DOM 克隆、仅扫描可见区域、速度快。
 *   滚动时节流重扫，逐步覆盖整个页面。
 */
async function scanPageTextFallback() {
  if (!_root) return;
  log('页面无 .beaver-word span，启动视口 TreeWalker 正文提取');

  // 视口范围
  const viewportTop = window.scrollY;
  const viewportBottom = viewportTop + window.innerHeight;
  const sentences = [];
  const processedBlocks = new WeakSet();

  // TreeWalker 遍历文本节点
  const walker = document.createTreeWalker(
    document.body || document.documentElement,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        // 跳过非文本节点
        if (!node.textContent || !node.textContent.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        // 检查父元素是否在跳过列表中
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        // 跳过侧栏内部
        if (parent.closest && parent.closest('#beaver-web-sidebar, #beaver-sidebar, #beaver-subtitle-overlay, #beaver-hint-tooltip, #beaver-context-panel, #beaver-ocr-panel')) {
          return NodeFilter.FILTER_REJECT;
        }
        // 跳过非正文 ARIA 角色
        if (parent.closest && parent.closest(NON_CONTENT_SELECTOR)) {
          return NodeFilter.FILTER_REJECT;
        }
        // 跳过 JS 特殊值
        const text = node.textContent.trim().toLowerCase();
        if (JS_SENTINELS.has(text)) return NodeFilter.FILTER_REJECT;
        // 仅扫描视口内可见的文本节点（含一定预扫描区域）
        const rect = parent.getBoundingClientRect();
        if (rect.bottom < -100 || rect.top > window.innerHeight + 100) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  // 遍历文本节点，按 block 分组提取句子
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent) continue;

    // 找到包含该文本节点的 block 元素
    const block = parent.closest('p, div, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, caption, figcaption, article, section, main');
    if (!block) continue;
    if (processedBlocks.has(block)) continue;
    processedBlocks.add(block);

    // 获取 block 文本（getBlockText 智能拼接，避免生词黏连）
    const fullText = getBlockText(block);
    if (!fullText || fullText.trim().length < 3) continue;

    // 拆句
    for (const sent of splitSentences(fullText)) {
      if (sent.length < 3) continue;
      if (hasSentenceKey(sent)) continue;
      sentences.push(sent);
    }
  }

  if (sentences.length === 0) {
    log('视口 TreeWalker：无有效句子');
    // 第二百四十六次：无有效句子也是"扫描完成"——占位换"暂无生词"防永久滞留。
    finalizeScanningTip();
    return;
  }

  log('视口 TreeWalker：共', sentences.length, '个待查句子');

  // 分批用 getAnnotations 查词（非阻塞模式——释义仍异步回填，此处 await 的只有 rank/词形组装）
  // 第一百九十四次（用户："网页提示的顺序跟文本侧栏的顺序不对应"）：逐句顺序处理。
  //   旧版每批 20 句并发查词、按 **Promise 完成顺序** 入库——_pageSentences 下标
  //   （句面板顺序、词表 seq 高位）随之偏离页面词序；共享 _seenWords 时"同词归属哪句"
  //   也由完成顺序决定（先完成的句子抢到词）。改为按提交（DOM）顺序逐句 await：
  //   入库顺序、词归属都确定等于页面顺序。代价是兜底路径变慢（逐句一次 IDB 往返），
  //   但本路径本就是 text-hint 关闭/失常时的降级路径，正确性优先。
  const BATCH = 20;
  let idx = 0;

  const nextBatch = async () => {
    if (!_root || idx >= sentences.length) return;
    const end = Math.min(idx + BATCH, sentences.length);
    for (; idx < end; idx++) {
      const sent = sentences[idx];
      if (hasSentenceKey(sent)) continue;
      try {
        const anns = await getAnnotations(sent, _rankThreshold, _seenWords, (ann) => {
          // 反思（2026-08-14 第五十八次）：fallback 路径原只调 updateWordTranslation 更新词汇面板，
          //   翻译晚到时句子槽位不重渲染 → 侧栏句子无注释（与"网页无提示"同源）。
          //   改用 onAsyncTranslate：重渲染包含该词的句子 slot（fillSlotAnnotations）并更新词汇面板。
          onAsyncTranslate(ann);
        });
        if (!_root) return;
        // 第一百九十三次：与网页高亮同口径——annotateOov=false 时过滤表外词（rank=null），
        //   此时 th/queryWord 对表外词根本不高亮，侧栏也不该出注释。
        const useAnns = _annotateOov ? (anns || []) : (anns || []).filter((a) => a && a.rank !== null);
        if (useAnns.length === 0) continue;
        // 第一百八十三次：check(上方 hasSentenceKey) 与 act 跨 await 本就非原子，
        //   同句可并发走到这里；最终去重交给 appendPageSentence 的入口关口。
        appendPageSentence({ text: sent }, useAnns);
      } catch (e) {
        log('视口 TreeWalker getAnnotations 失败:', e);
      }
    }
    if (idx < sentences.length) {
      if ('requestIdleCallback' in window) requestIdleCallback(nextBatch, { timeout: 1000 });
      else setTimeout(nextBatch, 30);
    } else {
      // 第二百四十六次：本轮批次全部完成——句子面板仍无任何入库句时，
      //   把"Scanning page..."占位换成"暂无生词"，避免 0 命中场景占位永久滞留。
      finalizeScanningTip();
    }
  };
  nextBatch();
}

/**
 * 更新已渲染条目的异步翻译结果
 * @param {HTMLElement} slot 句子槽位 DOM
 * @param {object} ann 注释对象 {word, translations, ...}
 */
function updateWordTranslation(slot, ann) {
  if (!slot || !ann || !ann.word) return;
  // 词汇面板中的对应条目更新释义
  const wp = _root.querySelector('#beaver-web-word-panel');
  if (!wp) return;
  // 反思（2026-08-12）：用小写匹配 data-word，与 createWordPanelItem 一致
  // 第一百七十七次（用户："文本侧栏中也有生词重复"）：改用 wordDedupKey（trim+小写），
  //   原先只 toLowerCase 未 trim，" ego" 之类带空白的词面查不到已渲染条目，
  //   回填失败之外还会让上游误判为新词而重复插入。三处键必须完全一致。
  const wordSel = cssEscape(wordDedupKey(ann.word));
  const item = wp.querySelector(`.beaver-web-word-item[data-word="${wordSel}"]`);
  if (item) {
    const transSpan = item.querySelector('.beaver-w-trans');
    if (transSpan) {
      // 反思（2026-08-12）：翻译失败时显示"暂无释义"，避免词汇面板永久显示空
      // 第一百二十三次：过滤括号不配对的截断残片
      const okTrans = (ann.translations || []).filter((s) => Boolean(s) && isBalancedParens(s));
      transSpan.textContent = okTrans.length > 0 ? okTrans.join('；') : t('ws.noDef');
    }
    item.classList.remove('pending');
  }
}


// === 句子渲染（页面文本/ASR/OCR 共用）===

/**
 * 追加页面文本句子到句标签面板
 * @param {{text:string}} seg 句子对象
 * @param {Array} anns 初始注释数组（可能含 pending 词）
 */
function appendPageSentence(seg, anns, opts) {
  // 第一百八十三次（用户："文本侧栏的句子会重复"）：本函数是三条扫描路径
  //   （总线 ingestPageBlock / span 扫描 / TreeWalker 兜底）唯一的入库汇入点，
  //   旧版只 push+appendChild、从不校验，去重全靠各调用方自行 check-then-act：
  //     · 兜底路径的 check(L498) 与 act(L507) 跨 .then，非原子 → 同句并发入两次；
  //     · 总线路径"空注释句 continue"早于 addSentenceKey → 该句永不入键，块反复推送即反复入库；
  //     · ensureScanBusSubscribed 每次调用都回放全部历史块。
  //   修正：把 addSentenceKey 收进本函数并在入口做最终关口——已在库者直接拦下并出声
  //   （不遮蔽，warn 打出累计次数），调用方不再自行 addSentenceKey。
  const key = normSentKey(seg && seg.text);
  if (!key) return;
  if (hasSentenceKey(key)) {
    _dupSentenceBlocked++;
    console.warn(`[VocabRadar][web-sidebar] 句子重复入库已拦下（累计 ${_dupSentenceBlocked} 次）: ${key.slice(0, 40)}`);
    return;
  }
  // 第二百三十次（用户："生词重复。"）：新词门闸——句子若只含 _firstSentMap 已登记词
  //   （无任何新词），不再入库。根因：句表旧语义是"凡含生词的句子全收"，而词表五层
  //   去重只管词条目、管不住句条目本身——导航类页面每条菜单各自成句、各含同一生词
  //  （documentation ×8 即此）。判据用第193次页级首现句权威表 _firstSentMap 而非
  //   isFirst 标志：每词只随其首现句出现一次，之后的同词句全部免入；三条入库路径
  //   （总线/span/TreeWalker）统一生效，opts.forceAll 供总线传 OCR/ASR 全收豁免。
  //   注意：被拦句子不得 addSentenceKey——同一句文本后续块若带来新词仍可入库
  //  （覆盖度由 mergeAnnotationsForSentence 补齐）；词表/页面高亮/注释语义不变。
  if (!(opts && opts.forceAll) && Array.isArray(anns) && anns.length > 0
      && anns.every((a) => _firstSentMap.has(wordDedupKey(a && a.word)))) {
    warnSentGate(key.slice(0, 40));
    return;
  }
  addSentenceKey(key);
  // 第一百九十三次：页级首现句权威表登记——句子入库即定格本句各注释词的首现句
  //   （词首见才登记，已在其他句登记过的自然跳过）。登记与 addSentenceKey 同在同步块内、
  //   位于任何渲染/await 之前，保证 fillSlotAnnotations 消费时表已就绪。
  //   三条上游路径（总线 ingestPageBlock / span 扫描 / TreeWalker 兜底）的 anns 均在此汇合，
  //   渲染端据此补 isFirst 后，「注释重复生词」关闭时每词只在首现句出提示，不再依赖
  //   上游是否携带 isFirst 字段（兜底 getAnnotations 不产出，此前的判据是死判据）。
  if (Array.isArray(anns)) {
    for (const a of anns) {
      const wk = wordDedupKey(a && a.word);
      if (wk && !_firstSentMap.has(wk)) _firstSentMap.set(wk, key);
    }
  }
  _pageSentences.push(seg);
  const idx = _pageSentences.length - 1;
  const panel = _root.querySelector('#beaver-web-sentence-panel');
  // 反思（2026-08-08）：追加结果前移除 empty-tip 占位符（"Scanning page..."）
  const emptyTip = panel.querySelector('.beaver-web-empty-tip');
  if (emptyTip) emptyTip.remove();
  const slot = createSentenceSlot(seg, idx, 'page');
  panel.appendChild(slot);
  _pageSentenceEls.push(slot);
  // 如果已有注释（非阻塞模式返回的初始结果），直接渲染
  // 第一百八十五次（用户："词汇的顺序跟句子的顺序不一致…有重复"）：
  //   旧版此处额外调一次 collectToWordPanel(anns, idx)，与 collectAnnotationsForSlot
  //   内的收词形成"双重入口"：两者跨 .then 非原子，同句可能被收两次（数组层去重
  //   只在同步瞬间有效），且两次打的 seq 依据不同数组 → 词序错乱。
  //   修正：收词统一由 collectAnnotationsForSlot 一处负责（受 _collectedSubs 守卫）。
  if (anns && anns.length > 0) {
    _annotationsCache.set(seg, Promise.resolve(anns));
  }
  collectAnnotationsForSlot(slot, seg, _pageSentences, _pageSentenceEls);
}

/** 创建句子槽位 DOM 元素（固定结构，内容后续填充） */
function createSentenceSlot(seg, idx, source) {
  const slot = document.createElement('div');
  slot.className = 'beaver-web-sub-item';
  slot.dataset.idx = String(idx);
  slot.dataset.source = source;
  const hasTime = (typeof seg.start === 'number' && isFinite(seg.start) && seg.start > 0);
  slot.innerHTML = `
    <div class="beaver-web-sub-text">
      ${hasTime ? `<span class="beaver-web-sub-time">${formatTime(seg.start)} </span>` : ''}
      <span class="beaver-web-sub-content">${escapeHtml(seg.text || '')}</span>
    </div>
    <div class="beaver-web-ann-container"></div>
  `;
  return slot;
}

/** 收集生词到词汇面板（去重，过滤表外词） */
function wordDedupKey(w) {
  // 第一百三十二次：规范化去重键（trim+小写）——此前仅 lower，" word"/"word " 之类
  // 带空白的变体会绕过 _allAnnotations 过滤与 DOM data-word 查重，造成重复条目。
  return String(w || '').trim().toLowerCase();
}

/**
 * 第一百八十四次（用户："侧栏中 词汇的顺序跟句子/字幕的顺序不一致"）：词序键。
 * 根因：词表顺序此前等于"注释 Promise 完成顺序"（兜底路径 20 句一批并发查词、
 *   总线补词也一律追加到末尾），与句子先后无关。修正：给每条注释打上
 *   「句序 × 句内词序」复合键，数组与 DOM 一律按此键有序插入。
 * 句序用 _pageSentences 下标：网页句是纯追加入库（appendPageSentence 唯一关口），
 *   下标不会因后续入库而变动，故可长期作序键。
 * 乘数 1000：句内词数远小于 1000，低位放词在句内的出现次序。
 * @param {number} sentIdx 句子在 _pageSentences 中的下标
 * @param {number} wordIdx 词在该句注释数组中的下标
 */
function makeSeq(sentIdx, wordIdx) {
  const s = (typeof sentIdx === 'number' && sentIdx >= 0) ? sentIdx : 0;
  const w = (typeof wordIdx === 'number' && wordIdx >= 0) ? Math.min(wordIdx, 999) : 0;
  return s * 1000 + w;
}

/**
 * 第一百八十五次（用户裁定："不可兜底首位。右列首位你是妄想。"）：
 *   缺失词序键的注释一律排到表尾，绝不占首位。旧版回退 0 会让任何没打上
 *   seq 的注释（异步回填/兜底路径）抢在第一句之前，正是"词序与句子不一致"的
 *   最直观表现。SEQ_TAIL 取安全整数上限，保证恒大于任何真实 seq。
 */
const SEQ_TAIL = Number.MAX_SAFE_INTEGER;

/** 取注释的词序键（缺失一律排末尾，见 SEQ_TAIL 注释） */
function annSeq(a) {
  const v = a && a.seq;
  return (typeof v === 'number' && isFinite(v)) ? v : SEQ_TAIL;
}

/**
 * 按 seq 有序插入 _allAnnotations（从尾部回退，绝大多数情况一步到位）。
 * 同键保持先来先到（稳定），故用 > 而非 >=。
 * @param {Array} fresh 已带 seq 的新注释
 */
function insertAnnotationsOrdered(fresh) {
  for (const a of fresh) {
    let i = _allAnnotations.length;
    while (i > 0 && annSeq(_allAnnotations[i - 1]) > annSeq(a)) i--;
    _allAnnotations.splice(i, 0, a);
  }
}

/**
 * 收集生词到词汇面板（去重，过滤表外词）
 * @param {Array} anns 本句注释数组
 * @param {number} sentIdx 句子在 _pageSentences 中的下标（词序键高位）
 * @param {Array} [seqBase] 计算句内词序所依据的数组（默认 anns 自身；
 *        总线补词场景传合并后的完整 anns，使补词排在本句既有词之后）
 */
function collectToWordPanel(anns, sentIdx, seqBase) {
  if (!anns || anns.length === 0) return;
  // 第一百八十八次：诊断计数——本函数收词全链路的入口流量
  _wsDiag.collectCalls++;
  _wsDiag.offered += anns.length;
  // 反思（2026-08-12）：用小写去重，避免 Running/running 被当作两个词
  // 第一百三十二次：统一走 wordDedupKey（trim+小写）
  // 第一百八十五次（用户："也不知道你咋选词的，有重复，有高频词"）：
  //   ① 批内自去重——同一句注释数组里可能同时含 Ego/ego（大小写不同词面），
  //      旧版只与 _allAnnotations 比对，同批的两条会一起入表，词表就此重复；
  //   ② 高频词二次关口——总线路径（ingestPageBlock）的词条来自 text-hint 的
  //      高亮 span，其阈值与侧栏阈值可能不同步（侧栏调低/调高阈值时高亮未重扫），
  //      故入表前按侧栏当前 _rankThreshold 再拦一次，杜绝高频词进词表。
  // 第一百八十六次（用户："依旧重复单词。"）：
  //   ③ 判重-登记原子化——旧版 `_allAnnotations.some(...)` 是 check-then-act：
  //      本函数在多个句子注释 Promise 的 .then 里被调用，"扫数组发现没有"与
  //      "insertAnnotationsOrdered 真正 push" 之间存在窗口，另一句的回调
  //      在这窗口里插入同词即造成重复。现改用 core.js 的 _wordKeys 键集，
  //      addWordKey 在 filter 内当场登记（同一同步块内判重+登记，无窗口），
  //      与 annotator 第一百八十二次把 seen.add 前置的做法同型。
  const batchSeen = new Set();
  const newAnns = anns.filter((a) => {
    // 表外词且未开启注释表外词时，不收集
    if (a.rank === null && !_annotateOov) { _wsDiag.blockedOov++; return false; }
    // 高频词（rank <= 阈值）不收集
    if (typeof a.rank === 'number' && isFinite(a.rank)
        && typeof _rankThreshold === 'number' && isFinite(_rankThreshold)
        && a.rank <= _rankThreshold) { _wsDiag.blockedHighRank++; return false; }
    const aKey = wordDedupKey(a.word);
    if (!aKey || batchSeen.has(aKey)) { _wsDiag.blockedBatch++; return false; }
    // 键集登记即占位：返回 false 说明别处已收该词
    if (!addWordKey(aKey)) { _wsDiag.blockedKey++; return false; }
    batchSeen.add(aKey);
    return true;
  });
  if (newAnns.length > 0) {
    _wsDiag.accepted += newAnns.length;
    // 第一百八十四次：入表前打词序键，让数组与 DOM 都能按句序排。
    // 第一百八十五次：句内词序改为按 wordDedupKey 在 base 中定位。
    //   旧版 base.indexOf(a) 依赖对象同一性，seqBase 与 anns 非同一批对象时
    //   恒返回 -1 → 句内词序全退化为 0，同句内词序完全丢失。
    const base = Array.isArray(seqBase) ? seqBase : anns;
    const baseKeys = base.map((x) => wordDedupKey(x && x.word));
    for (const a of newAnns) {
      const w = baseKeys.indexOf(wordDedupKey(a.word));
      a.seq = makeSeq(sentIdx, w >= 0 ? w : baseKeys.length);
    }
    insertAnnotationsOrdered(newAnns);
    appendWordPanelItems(newAnns);
  }
}

// === 注释获取（Promise 缓存，与 sidebar.js 同模式） ===
function ensureAnnotations(sub) {
  let p = _annotationsCache.get(sub);
  if (p) return p;
  const text = (typeof sub.text === 'string') ? sub.text : '';
  p = (_noAnnotation || !text)
    ? Promise.resolve([])
    : getAnnotations(text, _rankThreshold, _seenWords, onAsyncTranslate);
  _annotationsCache.set(sub, p);
  return p;
}

/**
 * 为槽位收集注释并渲染
 * @param {HTMLElement} slot 槽位元素
 * @param {object} sub 句子对象
 * @param {Array} sentencesArr 句子数组（用于索引校验）
 * @param {Array} elsArr DOM 元素数组
 */
function collectAnnotationsForSlot(slot, sub, sentencesArr, elsArr) {
  if (!sub) return;
  ensureAnnotations(sub).then((anns) => {
    if (!Array.isArray(anns)) return;
    const sentIdx = sentencesArr.indexOf(sub);
    if (sentIdx === -1) return;   // 句子已被清库移除，不渲染也不收词
    // 第一百八十五次：把"槽位下标校验"与"收词"解耦。
    //   旧版 slot.dataset.idx !== sentIdx 时整体 return，连收词一起跳过 →
    //   该句的词永远进不了词表（用户看到的"词表与句子对不上"含此漏收）。
    //   现在下标不匹配只跳过 DOM 渲染，收词照常按真实句序进行。
    if (slot.dataset.idx === String(sentIdx)) {
      fillSlotAnnotations(slot, sub, anns);
    }
    // 收集到生词本（去重）——第一百八十四次：带句序，词表顺序与句子顺序一致
    if (!_collectedSubs.has(sub)) {
      _collectedSubs.add(sub);
      collectToWordPanel(anns, sentIdx);
    }
  }).catch((e) => log('collectAnnotationsForSlot 失败:', e));
}

// 表外词异步翻译完成回调
// 反思（2026-08-10）：用户反馈"文本侧栏词汇中大部分没有释义，即便悬浮注释有"。
//   根因：getAnnotations 非阻塞模式调用 translate(word, false)，若翻译器未就绪
//   （模型还在下载）或 SW 休眠，翻译失败返回 null，onAsyncTranslate 被调用但
//   hasTrans=false，pending 状态被移除但不填释义。悬浮提示后来能翻译是因为那时
//   翻译器已就绪。修正：翻译失败时延迟 5 秒重试一次（高优先级），避免永久无释义。
function onAsyncTranslate(ann) {
if (!_root || !ann || !ann.word) return;
if (ann.rank === null && !_annotateOov) return;
// 反思（2026-08-12）：用小写匹配 data-word，避免大小写不一致导致找不到 DOM 元素
//   页面 span 的 dataset.word 是原文大小写（如 Running），翻译缓存 key 是小写（running），
//   词汇面板的 data-word 也用小写存储，统一用小写查询。
// 第一百三十二次：统一走 wordDedupKey（trim+小写），与收集/查重同键。
const wordSel = cssEscape(wordDedupKey(ann.word));
const hasTrans = (ann.translations && ann.translations.length > 0);

  // 翻译失败时重试一次（5秒后，高优先级）
  // 反思（2026-08-10）：翻译器可能在页面加载时未就绪，5秒后重试给翻译器下载时间
  if (!hasTrans && !ann._retried) {
    ann._retried = true;
    setTimeout(() => {
      translate(ann.word, true).then((translated) => {
        if (translated) {
          ann.translations = [translated];
        }
        onAsyncTranslate(ann);
      }).catch(() => {
        onAsyncTranslate(ann);
      });
    }, 5000);
    return; // 保持 pending 状态，等待重试
  }

  // 第一百二十三次：完整释义过滤括号不配对的截断残片
  const wordPanelTransTxt = hasTrans
    ? ann.translations.filter((s) => Boolean(s) && isBalancedParens(s)).join('；')
    : '';

  // 句子区：遍历所有 slot，对包含该 word 的 sub 重新调 fillSlotAnnotations
  // 反思（2026-08-13 第五十三次）：ASR/OCR 已迁移引导页，仅剩页面句子（source=page）
  const annWordLower = ann.word.toLowerCase();
  const slots = _root.querySelectorAll('.beaver-web-sub-item');
  slots.forEach((slot) => {
    const idxAttr = slot.dataset.idx;
    const source = slot.dataset.source;
    if (idxAttr == null) return;
    const subIdx = parseInt(idxAttr, 10);
    if (isNaN(subIdx)) return;
    if (source !== 'page') return;
    const arr = _pageSentences;
    const sub = arr[subIdx];
    if (!sub) return;
    const p = _annotationsCache.get(sub);
    if (!p) return;
    Promise.resolve(p).then((anns) => {
      if (!Array.isArray(anns)) return;
      if (!anns.some((a) => a.word.toLowerCase() === annWordLower)) return;
      fillSlotAnnotations(slot, sub, anns);
    });
  });

  // 生词表：更新对应条目的释义
  const items = _root.querySelectorAll(`.beaver-web-word-item[data-word="${wordSel}"]`);
  items.forEach((item) => {
    item.classList.remove('pending');
    const trans = item.querySelector('.beaver-w-trans');
    if (trans) {
      // 反思（2026-08-12）：翻译失败时也更新 .beaver-w-trans 显示"暂无释义"，
      //   避免词汇面板永久显示空或"翻译中..."占位
      trans.textContent = hasTrans ? wordPanelTransTxt : t('ws.noDef');
    }
  });
}

// === 填充槽位的正文高亮 + 注释行（与 sidebar.js fillSlotAnnotations 同源） ===
// 反思（2026-08-12）：用户反馈"句子中生词咋没注释"。
//   根因：旧版 validAnns = anns.filter((a) => pickCleanShortTrans(a.translations))
//   过滤掉所有 translations 为空的词（pending 词），导致翻译未完成或失败时
//   句子既不高亮也不显示注释。即便 onAsyncTranslate 回填触发重渲染，
//   翻译失败的词仍被过滤，永久无注释。
//   修正：不再过滤 pending 词，所有 ann 都参与高亮和注释渲染：
//   - pending 词：高亮 + 显示"翻译中..."占位
//   - 翻译失败词：高亮 + 显示"暂无释义"
//   - 翻译成功词：高亮 + 显示释义
function fillSlotAnnotations(slot, sub, anns) {
  const contentSpan = slot.querySelector('.beaver-web-sub-content');
  const annContainer = slot.querySelector('.beaver-web-ann-container');
  if (!contentSpan || !annContainer) return;
  // 第一百三十八次（用户反馈"句子有重复单词"）：merge/总线多路径可能把同一单词
  // 多次并入注释数组——高亮替换天然幂等看不出，但详细模式逐词成行就重复了。
  // 按 trim+小写去重（保留首条=isFirst），与词汇面板去重键一致。
  const _seen = new Set();
  const validAnns = (anns || []).filter((a) => {
    const k = String(a.word || '').trim().toLowerCase();
    if (!k || _seen.has(k)) return false;
    _seen.add(k);
    return true;
  });
  // 第一百九十三次：isFirst 统一以页级首现句权威表（core.js _firstSentMap）为准补齐。
  //   根因（192 次反思定性、191 次判据失效）：总线路径词条带 isFirst，但兜底路径
  //   （lib/annotator.js#getAnnotations）与历史缓存注释均无此字段，`a.isFirst === false`
  //   对 undefined 恒不触发 → 跨句重复词照样高亮+出注释行（用户所见「句子生词重复」）。
  //   现按「本句是否该词的登记首现句」强制归一：是 → true；不是 → false；
  //   表中无登记（理论上不会发生，防御保留）→ 沿用上游值。
  //   下游三处消费（highlightWords 的跳过/类名/内联括号、注释行循环）据此统一生效。
  const _sentKey = normSentKey(sub.text || '');
  for (const a of validAnns) {
    const wk = wordDedupKey(a && a.word);
    if (!wk) continue;
    const reg = _firstSentMap.get(wk);
    a.isFirst = (reg === undefined) ? (a.isFirst !== false) : (reg === _sentKey);
  }
  if (_detailMode) {
    contentSpan.innerHTML = highlightWords(sub.text || '', _noAnnotation ? [] : validAnns, false);
    annContainer.innerHTML = '';
    if (_noAnnotation) return;
  } else {
    contentSpan.innerHTML = highlightWords(sub.text || '', _noAnnotation ? [] : validAnns, true);
    annContainer.innerHTML = '';
    return;
  }
  // 详细模式注释行
  for (const a of validAnns) {
    // 第一百七十九次：与简略模式括号释义同一判据——「注释重复生词」未勾选时，
    //   跨句重复词（isFirst===false）不再逐句重复出注释行，只保留 later 高亮。
    if (!_annotateRepeat && a.isFirst === false) continue;
    const line = document.createElement('div');
    line.className = 'beaver-web-ann-line' + (a.pending ? ' pending' : '');
    line.dataset.word = a.word || '';
    let html = '';
    html += `<span class="beaver-web-ann-word">${escapeHtml(a.word || '')}</span>`;
    // 反思（2026-08-08）：用户要求"音标前加一个喇叭按钮"。点击朗读单词（Web Speech API）。
    html += `<button class="beaver-web-ann-speak" data-word="${escapeHtml(a.word || '')}" title="🔊">🔊</button>`;
    html += `<span class="beaver-web-ann-phonetic" data-word="${escapeHtml(a.word || '')}"></span>`;
    // 反思（2026-08-16 第六十八次）：注释行元素顺序改为
    //   单词 → 喇叭 → 音标 → 释义 → 几阶 → 标签。
    //   用户反馈"释义排在末尾、长的词表标签排在前面"——释义紧跟音标（阅读第一需求），
    //   标签置尾（最次要、最长）。原顺序（释义最后）整行被长标签挤到最后才看到释义。
    const allTrans = (a.translations || []).filter(Boolean);
    if (allTrans.length > 0) {
      html += `<span class="beaver-web-ann-detail-trans">${escapeHtml(allTrans.join(' | '))}</span>`;
    } else if (a.pending) {
      html += `<span class="beaver-web-ann-detail-trans pending">${t('ws.translating')}</span>`;
    } else {
      // 反思（2026-08-12）：翻译失败时显示"暂无释义"，避免注释行无任何提示
      html += `<span class="beaver-web-ann-detail-trans pending">${t('ws.noDef')}</span>`;
    }
    if (a.rank != null && isFinite(a.rank)) {
      html += `<span class="beaver-web-ann-rank">${rankToStage(a.rank)}</span>`;
    }
    if (a.tags && a.tags.length > 0) {
      for (const tag of a.tags) {
        html += `<span class="beaver-web-ann-tags">${escapeHtml(tag)}</span>`;
      }
    }
    line.innerHTML = `<div class="beaver-web-ann-content">${html}</div>`;
    annContainer.appendChild(line);
    if (_detailMode && a.word) {
      fillPhoneticAsync(line, a.word, sub && sub.text);
    }
  }
}

// 高亮字幕中的生词（与 sidebar.js 同源）
// 第一百七十九次（用户反馈"依旧有重复生词：CSS(Cast Semi-Steel 半铸钢) / CSS(Cascading Style) /
//   CSS(钢性铸铁)"）：这三行是句子 tab 简略模式的三个句子槽位，同一个 CSS 在每句都挂了括号释义。
//   旧版 _annotateRepeat 只控制"同一句内多次出现"（正则 g 标志），未控制"跨句重复"。
//   修正：括号释义与开关语义对齐——开关未勾选时，只有首现句（isFirst）加括号，
//   后续句仅保留 later 高亮不再重注；勾选后每句都注。isFirst 由 th/scan.js 的
//   页级 seenWords 计算，经总线词条/beaver-word-later 类流入本函数。
//   （与 subtitle-overlay.js L341 同一判据，那里是整体跳过不高亮。）
function highlightWords(text, annotations, inlineAnnotations = false) {
  if (!annotations || annotations.length === 0) return escapeHtml(text);
  const sorted = [...annotations].sort((a, b) => b.word.length - a.word.length);
  let result = escapeHtml(text);
  const placeholders = [];
  for (const a of sorted) {
    // 反思（2026-08-15 第六十二次）：注释重复生词 勾选后 'gi' 全局替换，每次出现都注释。
    // 第一百九十一次：重复开关关闭时，后续出现（isFirst===false）不包高亮 span，
    //   保持纯文本——对齐页面 .beaver-hide-later 默认透明语义（th/core.js 注入 CSS
    //   L465-472：后续出现 background:transparent 看起来像普通文本）。此前 later 词
    //   始终包 span 且回退色与首现相同，侧栏句子行中同词每次出现都是完整提示，
    //   即用户所见「重复提示」。开关开启时恢复全量高亮（later 类）。
    if (!_annotateRepeat && a.isFirst === false) continue;
    const re = new RegExp(`\\b${escapeReg(a.word)}\\b`, _annotateRepeat ? 'gi' : 'i');
    const cls = a.isFirst === false ? 'beaver-web-word later' : 'beaver-web-word';
    const ph = `\x00${placeholders.length}\x00`;
    let replacement = `<span class="${cls}">${escapeHtml(a.word)}</span>`;
    if (inlineAnnotations && (_annotateRepeat || a.isFirst !== false)) {
      const shortTrans = pickCleanShortTrans(a.translations);
      if (shortTrans) {
        // 280次：注释文本由 _annTemplate 模板渲染（pre+释义+post，HTML 转义各段）
        const { pre, post } = splitAnnTemplate(_annTemplate);
        replacement += `<span class="beaver-web-ann-inline">${escapeHtml(pre)}${escapeHtml(shortTrans)}${escapeHtml(post)}</span>`;
      }
    }
    placeholders.push(replacement);
    result = result.replace(re, ph);
  }
  for (let i = 0; i < placeholders.length; i++) {
    result = result.split(`\x00${i}\x00`).join(placeholders[i]);
  }
  return result;
}

// 异步填充详细注释行的注音 span
async function fillPhoneticAsync(line, word, context) {
  const span = line.querySelector('.beaver-web-ann-phonetic');
  if (!span) return;
  span.textContent = '…';
  try {
    // 反思（2026-09-04）：日文连带上下文查注音——句子整句透传；非 ja 忽略，行为不变。
    const phon = await getPhonetic(word, undefined, context);
    if (!line.isConnected) return;
    const curSpan = line.querySelector('.beaver-web-ann-phonetic');
    if (!curSpan) return;
    curSpan.textContent = phon || '';
  } catch (e) {
    if (line.isConnected) {
      const curSpan = line.querySelector('.beaver-web-ann-phonetic');
      if (curSpan) curSpan.textContent = '';
    }
  }
}

// === 生词表 ===
// 2026-09-04（原形折叠诊断）：首个词表条目渲染时打一行门闸状态（之后不再打），
// 与视频侧同口径，用户反馈"没见着"时凭此行定位。
let _lemmaDiagDoneWs = false;
// 反思（2026-09-04）：原形折叠三件套（与 vs/subtitle-renderer.js 同口径，
// 独立实现——两侧 _allAnnotations/去重键各归各模块，不跨模块读状态）。
/**
 * 目标语是否有词形还原覆盖（diverse-lemmas LANGUAGES 名单为准）
 * @param {string} lang 语言码
 * @returns {boolean}
 */
function supportsLemmaLang(lang) {
  if (!LANGUAGES) return false;
  return Object.prototype.hasOwnProperty.call(LANGUAGES, String(lang || '').toLowerCase());
}

/**
 * 条目展示用原形：有还原结果用还原值，否则用词面小写（原词即原形也说）
 * 反思（2026-09-04）：与视频侧同口径，统一小写（历史 IDB 表层大小写坏档到显示层归一）。
 * @param {{word:string,lemma?:string|null}} a 注释条目
 * @returns {string} 原形文本（小写键形式）
 */
function lemmaDisplayOf(a) {
  const w = String((a && a.word) || '');
  const l = String((a && a.lemma) || '').trim();
  return (l || w.toLowerCase() || w).toLowerCase();
}

/**
 * 同原形归组键（与展示值同口径：lemma 缺失即词面小写）
 * @param {{word:string,lemma?:string|null}} a 注释条目
 * @returns {string}
 */
function lemmaKeyOf(a) {
  return lemmaDisplayOf(a).toLowerCase();
}

/**
 * 原形折叠开关（导出给 ui.js 的点击委托调用）
 *
 * 反思（2026-09-04）：与 vs/subtitle-renderer.js 同口径。
 * 反思（2026-09-04 二轮）：展开改纯词单行（同行列词，`, ` 分隔，块底色，不斜体，
 *   当前词加粗；展示统一小写）＋家族取词补齐。释义列删除（经常缺勤像 bug）。
 * @param {HTMLElement} itemEl 生词表条目 div.beaver-web-word-item
 */
export function toggleLemmaGroup(itemEl) {
  if (!itemEl || !itemEl.isConnected) return;
  const box = itemEl.querySelector('.beaver-w-lemma-group');
  const btn = itemEl.querySelector('.beaver-w-lemma-toggle');
  if (!box || !btn) return;
  // 已展开 → 收起并清空（下次展开重新查，保证与最新数据一致）
  if (box.style.display !== 'none') {
    box.style.display = 'none';
    box.innerHTML = '';
    btn.classList.remove('open');
    btn.title = t('th.lemmaExpand');
    return;
  }
  const key = String(box.dataset.lemma || '').toLowerCase();
  if (!key) return;
  const seen = new Set();
  const words = [];
  const pushWord = (w) => {
    const s = String(w || '').trim().toLowerCase();
    if (!s || seen.has(s)) return;
    seen.add(s);
    words.push(s);
  };
  // 当前词置顶（展示统一小写）
  pushWord(itemEl.dataset.word || '');
  for (const m of _allAnnotations) {
    if (lemmaKeyOf(m) !== key) continue;
    pushWord(m.word);
  }
  if (words.length === 0) return;
  const selfLower = words[0];
  box.innerHTML = words.map((w) => (w === selfLower ? `<b>${escapeHtml(w)}</b>` : escapeHtml(w))).join(', ')
    + `<span class="beaver-w-lemma-more">, …</span>`;
  box.style.display = '';
  btn.classList.add('open');
  btn.title = t('th.lemmaCollapse');
  // 同族补齐（异步）：整表家族去重后追加；失败/无新增时吃掉占位
  lemmaFamily(key, _cachedLearnLang, 20).then((fam) => {
    if (!box.isConnected || box.style.display === 'none') return;
    const ph = box.querySelector('.beaver-w-lemma-more');
    const extra = [];
    for (const w of (fam || [])) {
      const s = String(w || '').trim().toLowerCase();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      extra.push(s);
    }
    const html = extra.map((w) => escapeHtml(w)).join(', ');
    if (ph) ph.outerHTML = extra.length > 0 ? ', ' + html : '';
    else if (extra.length > 0) box.insertAdjacentHTML('beforeend', ', ' + html);
  }).catch(() => {
    const ph = box.querySelector('.beaver-w-lemma-more');
    if (ph) ph.remove();
  });
}

function createWordPanelItem(a) {
  if (!_lemmaDiagDoneWs) {
    _lemmaDiagDoneWs = true;
    try { log(`原形折叠门闸: learnLang=${_cachedLearnLang} 有覆盖=${supportsLemmaLang(_cachedLearnLang)} 首词=${(a && a.word) || ''} 原形=${lemmaDisplayOf(a)}`); } catch (_) {}
  }
  const div = document.createElement('div');
  div.className = 'beaver-web-word-item' + (a.pending ? ' pending' : '');
  // 反思（2026-08-12）：data-word 统一用小写存储，便于 onAsyncTranslate 用小写查询匹配
  // 第一百七十七次：改用 wordDedupKey（trim+小写），与 collectToWordPanel 的数组层
  //   去重键、appendWordPanelItems 的 DOM 查重键三处统一，杜绝重复条目。
  div.dataset.word = wordDedupKey(a.word);
  // 第一百八十四次：词序键写进 DOM，appendWordPanelItems 靠它定位插入点，
  //   使词表 DOM 顺序恒等于句子顺序（而非注释异步完成顺序）。
  div.dataset.seq = String(annSeq(a));
  const rankText = rankToStage(a.rank);
  // 反思（2026-08-12）：用户反馈"词汇中没有释义"。
  //   根因：旧版无翻译时 transText 为空字符串，词汇面板显示为空。
  //   onAsyncTranslate 翻译失败时（hasTrans=false）也不更新 .beaver-w-trans，
  //   导致词汇面板永远显示空。
  //   修正：无翻译时显示占位文案——pending 显示"翻译中..."，失败显示"暂无释义"。
  let transText;
  // 第一百二十三次：过滤括号不配对的截断残片
  const okTrans = (a.translations || []).filter((s) => Boolean(s) && isBalancedParens(s));
  if (okTrans.length > 0) {
    transText = escapeHtml(okTrans.join('；'));
  } else if (a.pending) {
    transText = t('ws.translating');
  } else {
    transText = t('ws.noDef');
  }
  const tagsText = (a.tags && a.tags.length > 0) ? escapeHtml(a.tags.join(',')) : '';
  // 反思（2026-08-16 第七十二次）：词表条目压行。
  //   顺序：单词 → 喇叭 → 音标 → 词形(原形≠词面时) → 释义 → 几阶 → 标签
  //   全部内联流动，沿一行自然换行，不再逐项独占一行
  let html = `<span class="beaver-w-word">${escapeHtml(a.word || '')}</span>`;
  // 反思（2026-08-08）：用户要求"音标前加一个喇叭按钮"。点击朗读单词（Web Speech API）。
  // 反思（2026-08-10）：用户要求"喇叭音标应当紧贴"，去掉两者之间的空格
  html += ` <button class="beaver-w-speak" data-word="${escapeHtml(a.word || '')}" title="🔊">🔊</button><span class="beaver-w-phonetic" data-word="${escapeHtml(a.word || '')}"></span>`;
  // 反思（2026-08-16 第七十二次）：词形还原——原形与词面不同时显示（如 running→run）
  // 反思（2026-09-04）：用户要求"词形还原即便原形也要说，右加上折叠符号，
  //   若展开列出所有同原词形的单词，展开的时候再查"。与视频侧同口径：
  //   有覆盖语种常显"原形：X"＋折叠按钮，展开时以当前 _allAnnotations 归组懒查；
  //   无覆盖语种沿用旧口径。目标语读 core 的 _cachedLearnLang（活绑定，免重复监听）。
  // 反思（2026-09-04）：用户要求 chip 化——原形 chip 即按钮（斜体＋底色见 CSS），
  //   无"原形："前缀无 ▶/▼ 后缀，展开态靠 .open 换底色区分。与视频侧同口径。
  const lemmaTextWs = lemmaDisplayOf(a);
  if (supportsLemmaLang(_cachedLearnLang)) {
    html += ` <button class="beaver-w-lemma-toggle" data-lemma="${escapeHtml(lemmaTextWs)}" title="${escapeHtml(t('th.lemmaExpand'))}">${escapeHtml(lemmaTextWs)}</button><div class="beaver-w-lemma-group" data-lemma="${escapeHtml(lemmaTextWs)}" style="display:none"></div>`;
  } else {
    const lemma = (a.lemma || '').trim();
    if (lemma && lemma.toLowerCase() !== String(a.word || '').toLowerCase()) {
      html += ` <span class="beaver-w-lemma">${escapeHtml(t('th.lemma'))}: ${escapeHtml(lemma)}</span>`;
    }
  }
  html += ` <span class="beaver-w-trans">${transText}</span>`;
  if (rankText) html += ` <span class="beaver-w-rank">${rankText}</span>`;
  if (tagsText) html += ` <span class="beaver-w-tags">${tagsText}</span>`;
  div.innerHTML = html;
  if (a.word) fillWordPanelPhonetic(div, a.word);
  return div;
}

async function fillWordPanelPhonetic(item, word) {
  const span = item.querySelector('.beaver-w-phonetic');
  if (!span) return;
  span.textContent = '…';
  try {
    const phon = await getPhonetic(word);
    if (!item.isConnected) return;
    span.textContent = phon || '';
  } catch (_) {
    span.textContent = '';
  }
}

function appendWordPanelItems(anns) {
  if (!_root || !anns || anns.length === 0) return;
  const panel = _root.querySelector('#beaver-web-word-panel');
  if (!panel) return;
  const emptyTip = panel.querySelector('.beaver-web-empty-tip');
  if (emptyTip) emptyTip.remove();
  // 第一百三十二次：批量内去重 + DOM 查重统一用规范化键；单条异常不中断整批
  const batchSeen = new Set();
  for (const a of anns) {
    try {
      const key = wordDedupKey(a.word);
      if (!key || batchSeen.has(key)) continue;
      // 反思（2026-08-12）：用小写匹配 data-word，与 createWordPanelItem 一致
      const wordSel = cssEscape(key);
      // 第一百八十八次：querySelectorAll 计数代替单点 querySelector——
      //   若此处数到 >0，说明「键集说没收、DOM 里却有」，即防护层间失联，
      //   domDupBlocked 计数就是定位重复发生在哪一层的直接证据。
      const existed = panel.querySelectorAll(`.beaver-web-word-item[data-word="${wordSel}"]`).length;
      if (existed > 0) {
        _wsDiag.domDupBlocked++;
        console.warn(`[VocabRadar][web-sidebar] DOM 查重拦下已存在词条（键集却判未收，防护层失联）: ${key}，已存在 ${existed} 条`);
        _wsDupNote(`DOM查重拦下 "${key}"，键集却判未收（层间失联），DOM 已有 ${existed} 条`);
        continue;
      }
      batchSeen.add(key);
      const div = createWordPanelItem(a);
      // 第一百八十七次（用户："文本侧栏句子跟词汇顺序无关"）：条目创建后必须**立即**
      //   写 dataset.seq。旧版只把 seq 传给 insertItemBySeq，条目本身没有 seq 属性，
      //   而 insertItemBySeq 是靠读取已有条目的 dataset.seq 决定插点，
      //   Number(undefined)=NaN → 全部按 SEQ_TAIL（表尾）解读 → 新条目永远被插到
      //   第一个条目之前，词表整体倒置，只能靠 600ms 后的 resortWordPanel 补救。
      const seq = annSeq(a);
      div.dataset.seq = String(seq);
      // 第一百八十八次：收录时刻标记——重复现场若两条时间差极大（>1s），
      //   即为"跨轮残留/异步迟到再插"，若几乎同时即"同轮双路并发"。
      div.dataset.collectedAt = String(Date.now());
      // 第一百八十四次：按 seq 有序插入 —— 找到首个 seq 更大的条目插到它前面，
      //   无则追加到末尾。异步先完成的靠后句子词不再霸占表首。
      insertItemBySeq(panel, div, seq);
      _wsDiag.inserted++;
      // 第一百八十八次：重复现场抓捕——插入后立即数同键条目，>1 即实锤。
      //   打出词面、seq、收录时刻、面板总数，绝不静默。
      const after = panel.querySelectorAll(`.beaver-web-word-item[data-word="${wordSel}"]`).length;
      if (after > 1) {
        _wsDiag.dupOnInsert++;
        const twins = Array.from(panel.querySelectorAll(`.beaver-web-word-item[data-word="${wordSel}"]`))
          .map((el) => ({ seq: el.dataset.seq, at: el.dataset.collectedAt }));
        console.warn(`[VocabRadar][web-sidebar] ★重复插入现场: "${key}" 词表内现有 ${after} 条`, JSON.stringify(twins), `panel子节点=${panel.childElementCount}`);
        _wsDupNote(`★重复插入 "${key}"：词表现有 ${after} 条 ${JSON.stringify(twins)} panel子节点=${panel.childElementCount}`);
      }
    } catch (e) {
      console.warn('[VocabRadar][web-sidebar] 生词条目渲染失败:', a && a.word, e);
    }
  }
  // 第一百八十五次：每批追加后安排一次全量重排兜底（见 resortWordPanelSoon）
  resortWordPanelSoon();
}

/**
 * 第一百八十五次（用户："两种侧栏中 词汇的顺序跟句子/字幕的顺序不一致"）：
 *   词表 DOM 顺序此前 100% 依赖"插入时刻 seq 已正确"，一旦某条注释晚打 seq、
 *   或插入时同键条目尚未落地，顺序就永久错乱且再无纠正机会——本模块此前
 *   完全没有任何全量重排入口（onWordListToggle 只加 class 不动 DOM）。
 *   现补一个防抖收尾重排：以 _allAnnotations（已按 seq 有序）为准，把 DOM
 *   条目按数组顺序重新 appendChild，作为顺序的最终保障。
 *   顺带清除数组中同键重复项（异步竞态漏网的重复词），与 DOM 保持一一对应。
 */
let _resortTimer = null;
function resortWordPanelSoon() {
  if (_resortTimer) clearTimeout(_resortTimer);
  _resortTimer = setTimeout(() => {
    _resortTimer = null;
    try { resortWordPanel(); } catch (e) {
      console.warn('[VocabRadar][web-sidebar] 词表重排失败:', e);
    }
  }, 600);
}

/** 按 seq 全量重排词表数组与 DOM（同键去重） */
function resortWordPanel() {
  if (!_root) return;
  const panel = _root.querySelector('#beaver-web-word-panel');
  if (!panel) return;
  // 1. 数组：稳定排序 + 同键去重
  const sorted = _allAnnotations
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (annSeq(x.a) - annSeq(y.a)) || (x.i - y.i))
    .map((x) => x.a);
  const seen = new Set();
  const uniq = [];
  for (const a of sorted) {
    const key = wordDedupKey(a.word);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniq.push(a);
  }
  const dupRemoved = _allAnnotations.length - uniq.length;
  // 第一百八十八次：接上去重诊断计数 —— 重排兜底层若真实清掉重复，
  //   说明前面三层（键集/数组/DOM 查重）有失联，此计数与 domDupBlocked/dupOnInsert
  //   一起构成定位证据链。
  _wsDiag.resortDupRemoved += dupRemoved;
  // 第一百八十六次：改走 set_allAnnotations 整体替换 —— 它会顺带重建 core 的
  //   _wordKeys 键集。若仍用 length=0 + push 原地改数组，被清掉的重复词键
  //   会滞留在键集里，该词此后永远无法再入表（掩盖问题而非解决）。
  set_allAnnotations(uniq);
  // 2. DOM：按数组顺序重挂；数组里没有的条目（重复词残留）直接移除
  const items = Array.from(panel.querySelectorAll('.beaver-web-word-item'));
  const byWord = new Map();
  for (const el of items) {
    const k = el.dataset.word || '';
    if (byWord.has(k)) { el.remove(); continue; }   // DOM 重复条目清掉
    byWord.set(k, el);
  }
  for (const a of uniq) {
    const el = byWord.get(wordDedupKey(a.word));
    if (!el) continue;
    el.dataset.seq = String(annSeq(a));
    panel.appendChild(el);   // appendChild 会把已存在节点移到末尾，逐条即成序
    byWord.delete(wordDedupKey(a.word));
  }
  for (const el of byWord.values()) el.remove();   // 数组中已无对应项
  if (dupRemoved > 0) {
    console.warn(`[VocabRadar][web-sidebar] 词表重排清除重复词 ${dupRemoved} 条`);
    _wsDupNote(`重排清除同键重复 ${dupRemoved} 条（前几层有失联，被兜底拦下）`);
  }
}

/**
 * 第一百八十四次：把条目按 seq 插入面板（保持面板与句子同序）。
 * @param {HTMLElement} panel 词表面板
 * @param {HTMLElement} div 待插入条目
 * @param {number} seq 本条目的词序键
 */
function insertItemBySeq(panel, div, seq) {
  const items = panel.querySelectorAll('.beaver-web-word-item');
  let ref = null;   // 插入位置的后继节点
  for (let i = 0; i < items.length; i++) {
    // 第一百八十五次：dataset.seq 缺失/非法时按 SEQ_TAIL（表尾）解读，与 annSeq 一致。
    //   旧版 `|| 0` 把无键条目当成"最小键"，新条目会被插到它前面，等于让无键条目霸占表首。
    const raw = Number(items[i].dataset.seq);
    const cur = isFinite(raw) ? raw : SEQ_TAIL;
    if (cur > seq) { ref = items[i]; break; }
  }
  panel.insertBefore(div, ref);
}

// === 清空句子（按来源） ===
/**
 * 第二百四十六次（用户："侧栏一直显示Scanning page..."）：扫描收尾占位纠正。
 * 说人话：句子面板的"Scanning page..."占位原本只在句子真正入库时才被移除；
 *   0 命中（词典空/无生词）时没有任何句子入库，占位就永远停在那。
 *   本函数在每轮扫描收尾时检查：面板里没有任何真句子槽位、占位还挂着 →
 *   把占位文案换成"暂无生词"（ws.noWords），让用户知道扫描完了而不是还在扫。
 *   已有句子时不动（正常场景占位已被 appendPageSentence 移除）。
 */
function finalizeScanningTip() {
  if (!_root) return;
  const sp = _root.querySelector('#beaver-web-sentence-panel');
  if (!sp) return;
  if (sp.querySelector('.beaver-web-sub-item')) return;
  const tip = sp.querySelector('.beaver-web-empty-tip');
  if (tip) tip.textContent = t('ws.noWords');
}

export function clearPageSentences() {
  set_pageSentences([]);
  set_pageSentenceEls([]);
  set_seenSentences(new Set());
  _scanGen++;  // 使旧标记失效
  const sp = _root.querySelector('#beaver-web-sentence-panel');
  if (sp) sp.innerHTML = `<div class="beaver-web-empty-tip">${t('ws.scanning')}</div>`;
}

function clearAllAnnotations() {
  set_allAnnotations([]);
  set_seenWords(new Set());
  set_annotationsCache(new Map());
  set_collectedSubs(new WeakSet());
  const wp = _root.querySelector('#beaver-web-word-panel');
  if (wp) wp.innerHTML = `<div class="beaver-web-empty-tip">${t('ws.noWords')}</div>`;
}

/** 重绘所有句子槽位（页面句子） */
export function rerenderAllSlots() {
  const slots = _root.querySelectorAll('.beaver-web-sub-item');
  slots.forEach((slot) => {
    const idxAttr = slot.dataset.idx;
    const source = slot.dataset.source;
    if (idxAttr == null) return;
    const subIdx = parseInt(idxAttr, 10);
    if (isNaN(subIdx)) return;
    if (source !== 'page') return;
    const sub = _pageSentences[subIdx];
    if (!sub) return;
    const p = _annotationsCache.get(sub);
    if (!p) return;
    Promise.resolve(p).then((anns) => {
      if (!Array.isArray(anns)) return;
      if (slot.dataset.idx === String(subIdx)) {
        fillSlotAnnotations(slot, sub, anns);
      }
    });
  });
}

// === 滚动监听（节流 500ms 重扫页面文本） ===
export function startScrollListener() {
  if (_scrollHandler) return;
  _scrollHandler = () => {
    if (_scrollScanTimer) clearTimeout(_scrollScanTimer);
    _scrollScanTimer = setTimeout(() => {
      if (_root && !_root.classList.contains('closed') && _activeTab === 'sentences') {
        schedulePageScan();
      }
    }, 500);
  };
  window.addEventListener('scroll', _scrollHandler, { capture: true, passive: true });
}

export function stopScrollListener() {
  if (_scrollHandler) {
    window.removeEventListener('scroll', _scrollHandler, { capture: true });
    _scrollHandler = null;
  }
  if (_scrollScanTimer) {
    clearTimeout(_scrollScanTimer);
    _scrollScanTimer = null;
  }
}

// 单次扫描总线订阅（2026-08-21 第八十九次）：两条启动路径共用，_busSubscribed 防重复订阅
let _busSubscribed = false;

export function ensureScanBusSubscribed() {
  if (!_busSubscribed) {
    _busSubscribed = true;
    // 反思（2026-08-16 第七十一次）：① 单次扫描——订阅 page-scan-bus（text-hint 推送），
    //   并回放启动前已产出的历史块（侧栏可能晚于 text-hint 启动）。
    //   reset 事件 → 清空页面数据等新一批（与 text-hint 重扫同步）。
    subscribe((msg) => {
      if (!_root) return;
      if (msg && msg.reset) { onScanBusReset(); return; }
      ingestPageBlock(msg);
    });
  }
  if (getLastEmitAt() > 0) {
    // 第一百八十三次（用户："文本侧栏的句子会重复"）：本函数被两处调用
    //   （web-sidebar-impl.js 的重复启动分支 L69 与首次启动 L202），旧版每次调用都把
    //   getBlocks() 全量重放一遍 → 同批块被 ingest 两次以上。回放只应发生一次：
    //   订阅之后的新块由 subscribe 实时送达，历史块补一次即可；总线 reset 后允许再补。
    if (_replayedEmitAt === getLastEmitAt()) {
      log('页面扫描: 历史块已回放过，跳过（避免句子重复入库）');
      return;
    }
    _replayedEmitAt = getLastEmitAt();
    log(`页面扫描: 回放 page-scan-bus 历史块 ${getBlocks().length} 块（单次扫描）`);
    for (const b of getBlocks()) ingestPageBlock(b);
  }
}
