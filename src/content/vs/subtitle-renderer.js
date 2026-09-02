// ============================================================================
// vs/subtitle-renderer.js -- 字幕/生词表面板渲染子模块
// ----------------------------------------------------------------------------
// 职责：
//   - 全量渲染字幕标签页（槽位创建/大间隔分隔符/当前行高亮滚动）
//   - 生词表标签页渲染与增量追加（音标异步填充、表外词异步翻译回填）
//   - 注释获取统一入口（Promise 缓存 + 跨字幕去重 + 生词收集守卫）
//   - ASR 识别结果插入字幕面板（appendASRSubtitle，与普通字幕同源处理）
//   - 底部按钮：词单切换 onWordListToggle / 复制 onCopy / 评论填入 onCommentClick
// 来源：拆分自 video-sidebar.js（拆分日期：2026-08-28）
// 关系：
//   - 渲染状态归属本模块：_subEntries/_allAnnotations/_seenWords/_noAnnotation/
//     _detailMode/_activeSubIdx/_windowSlots/_windowSize/_annotationsCache/
//     _collectedSubs/_wordOnlyMode；门面经 setNoAnnotation/setDetailMode/
//     getDetailMode/resetRenderState 接驳读写
//   - 经受控循环 import 读取门面导出的 getRoot/getSubtitlesRef/getActiveVideo/
//     getRankThreshold/getAnnotateOov/getAnnotateRepeat/getCfg/getActiveTab/
//     showNoSubtitle/clearLoading/toast（均为函数声明、提升后可用，运行时安全）
//   - getRoot()/getSubtitlesRef()/getActiveVideo()/getRankThreshold()/getAnnotateOov()/getAnnotateRepeat()/getCfg()/
//     getActiveTab() 归属门面，本模块读走 getter，写仍由门面内部完成
//   - requestSyncHeightOnce/autoExpandOnce 来自 vs/sidebar-layout.js（同级）
// ============================================================================

import { log } from './logger.js';
import { formatTime, copyToClipboard, flashButton, pickRandomShortTrans, escapeHtml, escapeReg, cssEscape } from './dom-utils.js';
import { pickRandomLinesForComment, findMainCommentContainer, expandCommentBox, fillCommentInput, scrollMinIntoView } from './comment-fill.js';
import { autoExpandOnce, requestSyncHeightOnce } from './sidebar-layout.js';
import { getAnnotations, rankToStage, resetDiag } from '../../lib/annotator.js';
import { getPhonetic } from '../../lib/phonetics.js';
import { t } from '../../lib/i18n.js';
import { isBalancedParens } from '../../lib/dict-clean.js';
import { addSubtitle as overlayAddSubtitle } from '../subtitle-overlay.js';
// 第一百七十一次：视频侧栏底部对话按钮 —— 对话面板唯一实现在 lib/chat.js
import { openChatPanel } from '../../lib/chat.js';
import {
  getRoot, getSubtitlesRef, getActiveVideo, getRankThreshold, getAnnotateOov,
  getAnnotateRepeat, getCfg, getActiveTab, showNoSubtitle, clearLoading, toast
} from '../video-sidebar.js';

// === 渲染状态（拆分自门面"模块状态"区，机械搬移） ===
let _subEntries = [];         // 当前窗口内的字幕条目 [{sub, annotations, el, subIdx}]
let _allAnnotations = [];     // 生词本：所有首次出现的生词注释
let _seenWords = new Set();   // 跨字幕去重
// 第一百八十六次（用户："依旧重复单词。"）：词表已收词键集（wordDedupKey 口径）。
//   旧版 collectAnnotations 用 `_allAnnotations.some(...)` 判重，是 check-then-act：
//   多条字幕的注释 Promise 各自 .then 里"先扫数组、后 insertAnnotationsOrdered push"，
//   两步之间可被另一条字幕的回调插入同词 → 重复。改为键集判重+当场登记（同步无窗口）。
//   与 _allAnnotations 的同步一律走 setAllAnnotations()，避免键集与数组各清一半。
let _wordKeys = new Set();

/** 整体替换 _allAnnotations 并同步重建词键集（唯一替换入口） */
function setAllAnnotations(arr) {
  _allAnnotations = Array.isArray(arr) ? arr : [];
  _wordKeys = new Set();
  for (const a of _allAnnotations) {
    const k = wordDedupKey(a && a.word);
    if (k) _wordKeys.add(k);
  }
}

/** 登记词键（true = 首次，可入表；false = 别处已收，丢弃） */
function addWordKey(key) {
  if (!key || _wordKeys.has(key)) return false;
  _wordKeys.add(key);
  return true;
}
let _noAnnotation = false;    // 不显示注释（Annotation 按钮非 active 时为 true）
let _detailMode = false;      // 详略模式：false=简略（注释跟在生词后不另起一行），true=详细（注释另起一行，老版本格式）
let _activeSubIdx = -1;       // 当前激活字幕索引
// === 全量渲染模式（2026-07-13 #93）===
// 反思：用户反馈"字幕限制死了，不可滚动查看。应当可以滚动查看全部，生词表也是"。
//   旧版滑动窗口固定 5 个槽位，用户无法查看完整字幕列表。改为全量渲染所有字幕，
//   面板区域 overflow-y:auto 支持滚动，highlightCurrent 仅负责高亮当前行。
let _windowSlots = [];        // 保留变量名兼容旧代码
let _windowSize = 0;          // 全量渲染模式下窗口大小为 0
let _annotationsCache = new Map();  // sub对象 -> annotations Promise 缓存（按需获取，避免重复查词）
// 反思（2026-07-08）：_annotationsCache 改存 Promise（原存 Array）。
//   根因：appendASRSubtitle 先 splice sub 进 getSubtitlesRef() 再 await getAnnotations，
//   await 期间 timeupdate → updateSlotContent 见缓存未命中 → fetchAnnotationsForSlot
//   又调 getAnnotations。两者共享 _seenWords，后完成的用 [] 覆盖缓存 → 内联注释消失。
//   改 Promise 后两者复用同一 Promise，杜绝重复查词与覆盖。
let _collectedSubs = new WeakSet();  // 已收集进 _allAnnotations 的 sub 对象（避免重复 push）

// === 渲染字幕标签页（全量渲染模式）===
// 全量渲染所有字幕，面板区域 overflow-y:auto 支持滚动查看全部内容。
// 表外单词用非阻塞翻译（onAsyncTranslate 回调），避免首次下载 Translator
// 模型（几十 MB）阻塞首屏——先显示"翻译中..."占位，翻译完成后异步回填 DOM。
//
// 全量渲染架构（2026-07-13 #93）：
//   反思：用户反馈"字幕限制死了，不可滚动查看。应当可以滚动查看全部，生词表也是"。
//   旧版滑动窗口固定 5 个槽位，用户无法查看完整字幕列表。改为全量渲染所有字幕，
//   面板区域支持滚动，highlightCurrent 仅负责高亮当前行并滚动到可视区。
// 反思（2026-07-13 #92）：用户反馈「asr，生词表有内容，过了一会儿再看看，全都没了」。
//   根因：appendASRSubtitle 首批字幕到达时先调 collectAnnotations（push _allAnnotations +
//   appendWordPanelItems），再调 renderSubtitlePanel（清空 _allAnnotations/_seenWords/
//   _annotationsCache/_collectedSubs）→ 已收集的生词数据丢失。后续若 renderWordPanel 被调用
//   （如 rerender），从空的 _allAnnotations 重建 → 生词表空白。
//   修正：新增 keepAnnotations 参数，appendASRSubtitle 调用时传 true 保留注释状态。
//   renderSubtitlePanel 默认 keepAnnotations=false（全量重渲染场景需要清空）。
async function renderSubtitlePanel(keepAnnotations = false) {
  const panel = getRoot().querySelector('#beaver-subtitle-panel');
  panel.innerHTML = '';
  _subEntries = [];
  if (!keepAnnotations) {
    setAllAnnotations([]);   // 第一百八十六次：同步清词键集
    _seenWords.clear();
    _annotationsCache.clear();
    _collectedSubs = new WeakSet();
  }
  // 反思（2026-07-28）：_asrCacheLoaded 重置移到 updateSubtitles 中，
  //   避免 renderSubtitlePanel 被重新渲染时误清缓存标记导致频繁刷新。
  _windowSlots = [];
  _activeSubIdx = -1;
  resetDiag();

  if (!getSubtitlesRef() || getSubtitlesRef().length === 0) {
    showNoSubtitle();
    return;
  }
  clearLoading();

  // 全量渲染所有字幕（2026-07-13 #93）
  // 反思（2026-07-28 #bug3 三次修正）：
  //   1) 用户要求"空行，不要写时间"→ 分隔符改为纯空行（无 textContent）
  //   2) 用户要求"前后连续区间应当合并"→ 连续大间隔合并为一个分隔符
  //   3) 阈值从 2s 提到 5s：ASR 自然句间停顿 2-4s 不算间断
  //   算法：标记每个字幕前的间隔是否为"大间隔"(>5s)，
  //     仅在"大间隔"变为"非大间隔"的转折点（即间断区间的起点）插入一个分隔符。
  const GAP_THRESHOLD = 5.0;
  let wasDiscontinuous = false;
  for (let i = 0; i < getSubtitlesRef().length; i++) {
    const sub = getSubtitlesRef()[i];
    let isDiscontinuous = false;
    if (i > 0) {
      const prev = getSubtitlesRef()[i - 1];
      const prevEnd = (prev && typeof prev.end === 'number' && isFinite(prev.end)) ? prev.end : (prev?.start || 0);
      const curStart = (sub && typeof sub.start === 'number' && isFinite(sub.start)) ? sub.start : 0;
      isDiscontinuous = (curStart - prevEnd) > GAP_THRESHOLD;
    }
    // 间断区间起点：当前不连续 且 之前是连续的 → 插入分隔符
    if (isDiscontinuous && !wasDiscontinuous) {
      const sep = document.createElement('div');
      sep.className = 'beaver-sub-gap';
      panel.appendChild(sep);
    }
    wasDiscontinuous = isDiscontinuous;
    const slot = createEmptySlot();
    slot.dataset.idx = String(i);
    slot.querySelector('.beaver-sub-time').textContent = formatTime(sub.start || 0) + '\u00a0\u00a0';
    slot.querySelector('.beaver-sub-content').textContent = sub.text || '';
    panel.appendChild(slot);
    _windowSlots.push(slot);
    _subEntries.push({ sub, annotations: null, el: slot, subIdx: i });
    collectAnnotationsForSlot(slot, i);
  }

  panel.onclick = onPanelClick;

  const v = getActiveVideo();
  const curT = (v && isFinite(v.currentTime)) ? v.currentTime : 0;
  highlightCurrent(curT);
  // 第一百二十五次：面板渲染后补测一次高度（ASR 首批/轨道切换路径）
  requestSyncHeightOnce();
  log('字幕面板已全量渲染, 总字幕=', getSubtitlesRef().length);
}

// === 创建空槽位（固定结构，内容后续填充）===
function createEmptySlot() {
  const div = document.createElement('div');
  div.className = 'beaver-sub-item';
  div.dataset.idx = '-1';
  div.innerHTML = `
    <div class="beaver-sub-text">
      <span class="beaver-sub-time"></span>
      <span class="beaver-sub-content"></span>
    </div>
    <div class="beaver-ann-container"></div>
  `;
  return div;
}

// === 面板点击事件委托（点击跳转到对应字幕）===
function onPanelClick(e) {
  const item = e.target.closest('.beaver-sub-item');
  if (!item || item.dataset.idx === '-1') return;
  const idx = parseInt(item.dataset.idx, 10);
  if (isNaN(idx)) return;
  const sub = getSubtitlesRef()[idx];
  if (sub && isFinite(sub.start)) {
    const v = getActiveVideo();
    if (v) v.currentTime = sub.start;
    log('跳转到', sub.start, 's');
  }
}

// === 渲染单条字幕条目 ===
// 反思（2026-07-07）：滑动窗口重构后此函数已无调用方，由 createEmptySlot +
//   updateSlotContent + fillSlotAnnotations 替代。删除避免误用与代码膨胀。
// === 表外单词异步翻译完成回调 ===
// getAnnotations 非阻塞模式下，表外单词 translate 完成后调用此函数。
// - 有译文：去掉 pending + 填译文 → 注释行/生词条目显示译文
// - 无译文（translate 失败/translator 关闭）：移除字幕条目中的注释行（"没结果就算了"），
//   但生词表条目保留——词表为空是用户反馈的问题，单词本身仍应展示（无译文而已）。
//   反思（2026-07-05）：旧版无译文时移除生词表条目，导致 translator 关闭时词表全空。
//   反思（2026-07-13 #94）：当 getAnnotateOov()=false 时，表外词（rank=null）不应显示注释。
//   虽然 collectAnnotations 已过滤表外词，但 onAsyncTranslate 仍会处理翻译结果并更新 UI。
//   修正：表外词且未开启注释时直接返回，不更新字幕注释和生词表。
function onAsyncTranslate(ann) {
  if (!getRoot() || !ann || !ann.word) return;
  if (ann.rank === null && !getAnnotateOov()) return;
  // 第一百七十七次：与 createWordPanelItem 的 data-word 同键（trim+小写）
  const wordSel = cssEscape(wordDedupKey(ann.word));
  const hasTrans = (ann.translations && ann.translations.length > 0);
  // 反思（2026-07-22）：字幕区改为 生词(注释)，注释为随机短义项；
  //   生词表仍用完整释义 translations.join('；')。
  //   简略/详细模式统一走 fillSlotAnnotations 重绘整个 slot（fillSlotAnnotations 内部根据 _detailMode 分支，
  //   并过滤无翻译词）。pending 词翻译成功后该词有翻译，fillSlotAnnotations 不再过滤，显示高亮+注释。
  //   翻译失败（无 shortTrans）时 fillSlotAnnotations 过滤掉该词，不高亮、不显示。
  // 第一百二十三次：生词表完整释义同样过滤括号不配对的截断残片
  const wordPanelTransTxt = hasTrans
    ? ann.translations.filter((s) => Boolean(s) && isBalancedParens(s)).join('；')
    : '';

  // 字幕区：遍历所有 slot，对包含该 word 的 sub 重新调 fillSlotAnnotations
  const slots = getRoot().querySelectorAll('.beaver-sub-item');
  slots.forEach((slot) => {
    const idxAttr = slot.dataset.idx;
    if (idxAttr == null || idxAttr === '-1') return;
    const subIdx = parseInt(idxAttr, 10);
    if (isNaN(subIdx)) return;
    const sub = getSubtitlesRef()[subIdx];
    if (!sub) return;
    // 取已 resolve 的注释（同步从缓存 Promise 拿结果）
    const p = _annotationsCache.get(sub);
    if (!p) return;
    Promise.resolve(p).then((anns) => {
      if (!Array.isArray(anns)) return;
      // 仅当该 sub 的注释中包含此 word 才重绘（避免无关 slot 重复重绘）
      if (!anns.some((a) => a.word === ann.word)) return;
      fillSlotAnnotations(slot, sub, anns);
    });
  });

  // 生词表：更新对应条目的释义
  const items = getRoot().querySelectorAll(`.beaver-word-item[data-word="${wordSel}"]`);
  items.forEach((item) => {
    item.classList.remove('pending');
    if (hasTrans) {
      const trans = item.querySelector('.beaver-w-trans');
      if (trans) trans.textContent = wordPanelTransTxt;
    }
  });
}

// === 高亮字幕中的生词 ===
// 简略模式（inlineAnnotations=true）：注释直接跟在生词高亮 span 后，不另起一行。
//   格式：<span class="beaver-word">word</span><span class="beaver-ann-inline">(释义)</span>
//   释义为随机短义项（pickRandomShortTrans）。无释义时仅高亮，不加括号。
// 反思（2026-07-22）：用户要求「字幕的单词注释跟在字幕正文里面的生词后，不另起一行，这是简略模式。
//   详细模式是之前老版本（注释另起一行）」。
function highlightWords(text, annotations, inlineAnnotations = false) {
  if (!annotations || annotations.length === 0) return escapeHtml(text);
  // 按词长降序，避免短词先替换破坏长词
  const sorted = [...annotations].sort((a, b) => b.word.length - a.word.length);
  let result = escapeHtml(text);
  // 用占位符避免嵌套替换
  const placeholders = [];
  for (const a of sorted) {
    // 反思（2026-07-28）：用户反馈"一行之中你注释了两次"。
    //   旧版用 'gi' 全局替换，同一行同一词全部高亮+注释。
    //   修正：去掉 g 标志，只替换首次出现，后续出现不高亮不注释。
    // 反思（2026-08-15 第六十二次）：注释重复生词 勾选后恢复 'gi'，每次出现都注释。
    // 第一百九十一次：与 ws/scanner.js highlightWords 同步对齐——重复开关关闭时，
    //   后续出现（isFirst===false）不包高亮 span 保持纯文本（页面 .beaver-hide-later
    //   默认透明语义的字幕侧对应实现），消除同一生词多处重复提示。
    if (!getAnnotateRepeat() && a.isFirst === false) continue;
    const re = new RegExp(`\\b${escapeReg(a.word)}\\b`, getAnnotateRepeat() ? 'gi' : 'i');
    const cls = a.isFirst === false ? 'beaver-word later' : 'beaver-word';
    const ph = `\x00${placeholders.length}\x00`;
    // 简略模式：生词后追加 (释义) inline span。无释义时仅高亮。
    let replacement = `<span class="${cls}">${escapeHtml(a.word)}</span>`;
    if (inlineAnnotations) {
      const shortTrans = pickRandomShortTrans(a.translations);
      if (shortTrans) {
        replacement += `<span class="beaver-ann-inline">(${escapeHtml(shortTrans)})</span>`;
      }
    }
    placeholders.push(replacement);
    result = result.replace(re, ph);
  }
  // 还原占位符
  for (let i = 0; i < placeholders.length; i++) {
    result = result.split(`\x00${i}\x00`).join(placeholders[i]);
  }
  return result;
}

// === 渲染生词表标签页 ===
function renderWordPanel() {
  const panel = getRoot().querySelector('#beaver-word-panel');
  panel.innerHTML = '';
  for (const a of _allAnnotations) {
    const div = createWordPanelItem(a);
    panel.appendChild(div);
  }
  log('生词表渲染:', _allAnnotations.length, '词');
}

/**
 * 创建单条生词表条目 DOM 元素
 * @param {{word:string,rank:number|null,tags:string[],translations:string[],pending?:boolean}} a
 * @returns {HTMLDivElement}
 */
function createWordPanelItem(a) {
  const div = document.createElement('div');
  div.className = 'beaver-word-item' + (a.pending ? ' pending' : '');
  // 第一百七十七次：data-word 统一存规范化键（trim+小写），与 appendWordPanelItems
  //   的查重 selector、onAsyncTranslate 的回填 selector 三处同键，否则查重形同虚设。
  div.dataset.word = wordDedupKey(a.word);
  // 第一百八十四次：把词序键写进 DOM，appendWordPanelItems 靠它定位插入点，
  //   使词表 DOM 顺序恒等于字幕顺序（而非注释异步完成顺序）。
  div.dataset.seq = String(annSeq(a));
  const rankText = rankToStage(a.rank);
  const transText = (a.translations && a.translations.length > 0)
    ? escapeHtml(a.translations.join('；'))
    : '';
  const tagsText = (a.tags && a.tags.length > 0) ? escapeHtml(a.tags.join(',')) : '';
  // 反思（2026-07-09 #68）：整体一段自然换行，各 span 用空格分隔，inline 文本流。
  //   只渲染有内容的 span，避免空 span 产生多余空格。
  // 反思（2026-08-03 修正）：用户反馈"视频提示字幕区有释义，生词表中却没有"。
  //   根因：pending 状态下 translations 为空，旧版不创建 .beaver-w-trans span，
  //   onAsyncTranslate 翻译成功后 item.querySelector('.beaver-w-trans') 返回 null
  //   → 释义无法填入。字幕区有释义是因为 fillSlotAnnotations 重建整个 slot。
  //   修正：始终创建 .beaver-w-trans span（即使为空），便于 onAsyncTranslate 后续更新。
  // 反思（2026-08-06 修正）：用户反馈"没看到音标"。
  //   根因：音标仅在详细模式注释行中显示，生词表不显示音标。
  //   修正：生词表条目也加音标 span，异步填充。
  let html = `<span class="beaver-w-word">${escapeHtml(a.word || '')}</span>`;
  // 反思（2026-08-08）：用户要求"音标前加一个喇叭按钮"。点击朗读单词（Web Speech API）。
  // 反思（2026-08-10）：用户要求"喇叭音标应当紧贴"，去掉两者之间的空格
  html += ` <button class="beaver-w-speak" data-word="${escapeHtml(a.word || '')}" title="🔊">🔊</button><span class="beaver-w-phonetic" data-word="${escapeHtml(a.word || '')}"></span>`;
  // 词形（2026-08-14 第五十四次）：词汇表显示词形还原原形（running→run）。
  //   与悬浮提示/右键面板的 lemma-row 一致，仅当原形不同于词面时显示。
  const lemma = (a.lemma || '').trim();
  if (lemma && lemma.toLowerCase() !== String(a.word || '').toLowerCase()) {
    html += ` <span class="beaver-w-lemma">${escapeHtml(t('th.lemma'))}: ${escapeHtml(lemma)}</span>`;
  }
  html += ` <span class="beaver-w-trans">${transText}</span>`;
  if (tagsText) html += ` <span class="beaver-w-tags">${tagsText}</span>`;
  if (rankText) html += ` <span class="beaver-w-rank">${rankText}</span>`;
  div.innerHTML = html;
  // 异步填充音标
  if (a.word) {
    fillWordPanelPhonetic(div, a.word);
  }
  return div;
}

/**
 * 异步填充生词表条目的音标
 * 反思（2026-08-06）：用户反馈"没看到音标"，生词表也应显示音标。
 * @param {HTMLElement} item 生词表条目 div
 * @param {string} word 单词
 */
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

/**
 * 第一百八十四次（用户："侧栏中 词汇的顺序跟句子/字幕的顺序不一致"）：词序键。
 * 根因：词表顺序此前等于"注释 Promise 完成顺序"——renderSubtitlePanel 循环里
 *   collectAnnotationsForSlot 是并发 fire（不 await），谁先查完词谁先进表，
 *   与字幕先后无关。修正：给每条注释打上「字幕时间 × 句内词序」复合键，
 *   数组与 DOM 一律按此键有序插入。
 * 为何用 start 而非字幕下标：ASR 是按时间二分插入字幕的，中途插入会让其后
 *   所有字幕的下标整体后移，已入表旧词的下标键就此失真；start 是绝对时间，
 *   与面板顺序（按 start 升序）恒等，插入多少条都不失真。
 * 量纲：start 秒 → 毫秒取整 → ×1000 留出低位给句内词序（句内词数 < 1000）。
 * @param {{start?:number}} sub 字幕对象
 * @param {number} wordIdx 词在该条字幕注释数组中的下标
 */
function makeSeq(sub, wordIdx) {
  const start = (sub && typeof sub.start === 'number' && isFinite(sub.start) && sub.start > 0)
    ? sub.start : 0;
  const w = (typeof wordIdx === 'number' && wordIdx >= 0) ? Math.min(wordIdx, 999) : 0;
  return Math.round(start * 1000) * 1000 + w;
}

/**
 * 第一百八十五次（用户裁定："不可兜底首位。右列首位你是妄想。"）：
 *   缺失词序键者一律排表尾，绝不占首位（旧版回退 0 恰好抢占表首，
 *   与用户裁定相反，也是"词序与字幕不一致"的最显眼表现）。
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
 * 第一百七十七次：生词去重键（trim + 小写）
 * 用户反馈"评论提示里 ego 重复两遍"。根因：collectAnnotations 往 _allAnnotations
 * 直接 push，数组层从未按词去重；而 appendWordPanelItems 只在 DOM 层查重，
 * 于是面板看着不重复，走 _allAnnotations 的评论/复制/导出却重复。
 * 与 ws/scanner.js 的 wordDedupKey 同键，两侧行为一致。
 */
function wordDedupKey(w) {
  return String(w || '').trim().toLowerCase();
}

/**
 * 第一百八十七次（用户："字幕注释了高频词"）：注释显示口径的唯一关口。
 *
 * 根因：高频词/表外词过滤此前只做在 collectAnnotations 的词表分支（fresh），
 *   而字幕行注释走 fillSlotAnnotations(slot, sub, anns)，用的是**未过滤的 anns**。
 *   anns 由 ensureAnnotations 缓存，可能是阈值尚未从设置读回时算出的（缺省阈值更低），
 *   于是字幕行照旧挂着高频词注释，与词表口径分裂。
 *   现把过滤抽成本函数，字幕行与词表共用同一份判据。
 * @param {Array} anns 原始注释数组
 * @returns {Array} 按当前 annotateOov + rankThreshold 过滤后的注释
 */
function filterByCurrentRank(anns) {
  if (!Array.isArray(anns)) return [];
  const thr = getRankThreshold();
  const oov = getAnnotateOov();
  return anns.filter((a) => {
    if (!a) return false;
    if (a.rank === null || a.rank === undefined) return !!oov;   // 表外词
    if (typeof a.rank === 'number' && isFinite(a.rank)
        && typeof thr === 'number' && isFinite(thr) && a.rank <= thr) return false;   // 高频词
    return true;
  });
}

/**
 * 增量追加生词到词表面板（ASR 追加字幕时调用，避免全量重渲染）
 * 仅追加新出现的词（已存在于 DOM 的跳过）
 * @param {Array} anns - 新增注释数组
 */
function appendWordPanelItems(anns) {
  if (!getRoot() || !anns || anns.length === 0) return;
  const panel = getRoot().querySelector('#beaver-word-panel');
  if (!panel) return;
  // 第一百七十七次：批内也去重（同一批里可能含同词的不同词面，如 Ego/ego）
  const batchSeen = new Set();
  for (const a of anns) {
    const key = wordDedupKey(a.word);
    if (!key || batchSeen.has(key)) continue;
    // 跳过已存在的同名单词（去重）
    const wordSel = cssEscape(key);
    if (panel.querySelector(`.beaver-word-item[data-word="${wordSel}"]`)) continue;
    batchSeen.add(key);
    const div = createWordPanelItem(a);
    // 第一百八十七次（用户："视频侧栏字幕跟词汇顺序无关"）：条目创建后立即写
    //   dataset.seq。insertItemBySeq 依赖读取已有条目的 dataset.seq 定位插点，
    //   不写则 Number(undefined)=NaN → 一律按 SEQ_TAIL 处理 → 插序整体倒置。
    const seq = annSeq(a);
    div.dataset.seq = String(seq);
    // 第一百八十四次：按 seq 有序插入 —— 从末尾往前找第一个 seq 不大于本词的条目，
    //   插到它后面；无则插到最前。异步先到的靠后字幕词不会再霸占表首。
    insertItemBySeq(panel, div, seq);
  }
  log('词表增量追加:', anns.length, '词, 总计:', _allAnnotations.length);
  // 第一百八十五次：每批追加后安排一次全量重排兜底（见 resortWordPanelSoon）
  resortWordPanelSoon();
}

/**
 * 第一百八十五次（用户："两种侧栏中 词汇的顺序跟字幕的顺序不一致"）：
 *   增量插入的顺序只在"插入时 seq 已正确"时才成立；ASR 追加字幕、异步翻译回填、
 *   注释开关切换等场景一旦有条目晚打/漏打 seq，顺序就永久错乱且无纠正机会。
 *   现补防抖收尾重排：以 _allAnnotations（按 seq 有序）为准重挂 DOM，并清除
 *   数组与 DOM 中的同键重复项，作为顺序与去重的最终保障。
 */
let _resortTimer = null;
function resortWordPanelSoon() {
  if (_resortTimer) clearTimeout(_resortTimer);
  _resortTimer = setTimeout(() => {
    _resortTimer = null;
    try { resortWordPanel(); } catch (e) {
      console.warn('[VocabRadar][video-sidebar] 词表重排失败:', e);
    }
  }, 600);
}

/** 按 seq 全量重排词表数组与 DOM（同键去重） */
function resortWordPanel() {
  const root = getRoot();
  if (!root) return;
  const panel = root.querySelector('#beaver-word-panel');
  if (!panel) return;
  // 1. 数组：稳定排序（同键保持先来先到）+ 同键去重
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
  // 第一百八十六次：整体替换（同步重建词键集），不再原地 length=0+push，
  //   否则被清掉的重复词键滞留键集，该词此后再也无法入表。
  setAllAnnotations(uniq);
  // 2. DOM：按数组顺序重挂（appendChild 会移动已有节点），多余条目移除
  const items = Array.from(panel.querySelectorAll('.beaver-word-item'));
  const byWord = new Map();
  for (const el of items) {
    const k = el.dataset.word || '';
    if (byWord.has(k)) { el.remove(); continue; }
    byWord.set(k, el);
  }
  for (const a of uniq) {
    const key = wordDedupKey(a.word);
    const el = byWord.get(key);
    if (!el) continue;
    el.dataset.seq = String(annSeq(a));
    panel.appendChild(el);
    byWord.delete(key);
  }
  for (const el of byWord.values()) el.remove();
  if (dupRemoved > 0) {
    console.warn(`[VocabRadar][video-sidebar] 词表重排清除重复词 ${dupRemoved} 条`);
  }
}

/**
 * 第一百八十四次：把条目按 seq 插入面板（保持面板与字幕同序）。
 * @param {HTMLElement} panel 词表面板
 * @param {HTMLElement} div 待插入条目
 * @param {number} seq 本条目的词序键
 */
function insertItemBySeq(panel, div, seq) {
  const items = panel.querySelectorAll('.beaver-word-item');
  let ref = null;   // 插入位置的后继节点
  for (let i = 0; i < items.length; i++) {
    // 第一百八十五次：dataset.seq 缺失/非法时按 SEQ_TAIL（表尾）解读，与 annSeq 一致，
    //   旧版 `|| 0` 会让无键条目被当成最小键而霸占表首。
    const raw = Number(items[i].dataset.seq);
    const cur = isFinite(raw) ? raw : SEQ_TAIL;
    if (cur > seq) { ref = items[i]; break; }
  }
  panel.insertBefore(div, ref);
}

// === 重新计算并渲染（词频变化时） ===
export async function rerender() {
  await renderSubtitlePanel();
  renderWordPanel();
}

// === 仅重渲染面板（注释按钮切换时）===
// 反思（2026-07-08）：需同时清 _collectedSubs，否则注释 off→on 时 sub 已标记 collected，
//   collectAnnotations 跳过 push，生词无法重新进入生词表/内联。
// 反思（2026-07-22）：用户反馈「点击 detail 并没有切换」。
//   根因：旧版清缓存后调 highlightCurrent，但 highlightCurrent 不重绘注释。
//   修正：annotation 切换清缓存+清 _seenWords+遍历 slot 重新调 collectAnnotationsForSlot 重新获取；
//   detail 切换不清缓存，直接调 rerenderSlotsFromCache 从缓存重绘（见 detail 按钮绑定）。
export function rerenderPanelOnly() {
  // 清除注释缓存 + 已收集标记 + 去重集合，让 collectAnnotationsForSlot 重新获取（应用 _noAnnotation 新值）
  _annotationsCache.clear();
  _collectedSubs = new WeakSet();
  _seenWords = new Set();
  // 遍历所有 slot 重新触发注释获取+回填
  _windowSlots.forEach((slot, idx) => {
    collectAnnotationsForSlot(slot, idx);
  });
  // 重新高亮当前行
  const v = getActiveVideo();
  const curT = (v && isFinite(v.currentTime)) ? v.currentTime : 0;
  _activeSubIdx = -1;
  highlightCurrent(curT);
}

// 遍历所有 _windowSlots，从 _annotationsCache 取已 resolve 的 anns 重新调 fillSlotAnnotations。
// 用于 _detailMode 切换后立即重绘（注释数据不变，仅渲染方式变）。
// 未 resolve 的 pending 注释跳过（保持原样，onAsyncTranslate 完成后会单独重绘）。
export function rerenderSlotsFromCache() {
  if (!_windowSlots) return;
  _windowSlots.forEach((slot, idx) => {
    const sub = getSubtitlesRef()[idx];
    if (!sub) return;
    const p = _annotationsCache.get(sub);
    if (!p) return;
    Promise.resolve(p).then((anns) => {
      if (!Array.isArray(anns)) return;
      if (slot.dataset.idx === String(idx)) {
        fillSlotAnnotations(slot, sub, anns);
      }
    });
  });
}

// === 高亮当前字幕（全量渲染模式）===
// 全量渲染模式下，所有字幕已渲染到 DOM，highlightCurrent 仅负责高亮当前行并滚动到可视区。
// 反思（2026-07-13 #93）：用户要求"字幕应当可以滚动查看全部"。
//   旧版滑动窗口固定槽位，改为全量渲染后，highlightCurrent 只处理高亮和滚动，
//   不再更新槽位内容。
export function highlightCurrent(time) {
  if (typeof time !== 'number' || !isFinite(time)) return;
  if (!_windowSlots || _windowSlots.length === 0) return;

  let idx = -1;
  for (let i = 0; i < getSubtitlesRef().length; i++) {
    const s = getSubtitlesRef()[i];
    if (!s || typeof s.start !== 'number' || typeof s.end !== 'number') continue;
    if (time >= s.start && time <= s.end) { idx = i; break; }
  }

  if (idx === -1) {
    if (_activeSubIdx !== -1) {
      _windowSlots.forEach((s) => s.classList.remove('active'));
      _activeSubIdx = -1;
    }
    return;
  }

  if (idx === _activeSubIdx) return;

  _windowSlots.forEach((s) => s.classList.remove('active'));
  if (idx >= 0 && idx < _windowSlots.length) {
    _windowSlots[idx].classList.add('active');
    // 反思（2026-07-14 #97）：用户反馈「视频提示滚动字幕时候，不要让网页跳动。我正在写字，视频播放，视频提示字幕同步的时候会让整个网页跳动」。
    //   根因：scrollIntoView 不仅滚动目标容器（字幕面板），还会滚动所有可滚动的父级元素（包括整个网页），
    //   导致用户正在输入时网页被意外滚动。
    //   修正：改为直接操作面板的 scrollTop，只滚动字幕面板本身，不影响父级网页。
    const panel = getRoot().querySelector('#beaver-subtitle-panel');
    if (panel) {
      const slot = _windowSlots[idx];
      const slotRect = slot.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      // 计算目标元素相对于面板的位置，滚动到面板中央
      const targetScrollTop = panel.scrollTop + (slotRect.top - panelRect.top) - (panelRect.height / 2) + (slotRect.height / 2);
      panel.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
    }
  }

  _activeSubIdx = idx;
  const sub = getSubtitlesRef()[idx];
  const range = sub && isFinite(sub.start) && isFinite(sub.end)
    ? `[${formatTime(sub.start)}-${formatTime(sub.end)}]`
    : '';
  log('当前字幕 idx=', idx, range);
}

// === 更新槽位内容（同步部分：时间+正文；异步部分：注释按需获取）===
function updateSlotContent(slot, subIdx) {
  const sub = getSubtitlesRef()[subIdx];
  if (!sub) { slot.style.display = 'none'; slot.dataset.idx = '-1'; return; }
  slot.style.display = '';
  slot.dataset.idx = String(subIdx);

  const start = (typeof sub.start === 'number' && isFinite(sub.start)) ? sub.start : 0;
  slot.querySelector('.beaver-sub-time').textContent = formatTime(start) + '\u00a0\u00a0';

  // 注释统一走 collectAnnotationsForSlot（内部用 Promise 缓存复用，避免重复查词）。
  // 先同步显示纯文本（无高亮），注释 Promise resolve 后回填高亮+注释行。
  // 反思（2026-07-08）：原版区分缓存命中/未命中两条路径，缓存存 Array 时存在竞态覆盖。
  //   改 Promise 缓存后统一一条路径，collectAnnotationsForSlot 内部 await ensureAnnotations
  //   命中已 resolve 的 Promise 仅一次微任务延迟（paint 前完成，无闪烁）。
  slot.querySelector('.beaver-sub-content').textContent = sub.text || '';
  slot.querySelector('.beaver-ann-container').innerHTML = '';
  collectAnnotationsForSlot(slot, subIdx);
}

// === 填充槽位的正文高亮 + 注释行 ===
function fillSlotAnnotations(slot, sub, anns) {
  const contentSpan = slot.querySelector('.beaver-sub-content');
  const annContainer = slot.querySelector('.beaver-ann-container');
  // 反思（2026-07-22）：用户要求「有些生词没注释，没翻译的就不要显示了」。
  //   过滤掉无翻译的词（pickRandomShortTrans 返回空），字幕区不高亮、不显示注释。
  //   pending 表外词初始 translations=[] 被过滤，翻译成功后 onAsyncTranslate 触发重绘显示。
  //   生词表仍保留所有生词（createWordPanelItem 不过滤），仅字幕区过滤。
  const validAnns = (anns || []).filter(a => pickRandomShortTrans(a.translations));
  // 第一百八十七次：字幕行与词表共用同一份阈值/表外词过滤，杜绝字幕注释高频词
  const shownAnns = filterByCurrentRank(validAnns);
  // 反思（2026-07-22）：用户要求「字幕的单词注释跟在字幕正文里面的生词后，不另起一行，这是简略模式。
  //   详细模式是之前老版本」。
  //   简略模式：highlightWords 第三参 true，注释作为 inline span 跟在生词后；annContainer 清空。
  //   详细模式：highlightWords 第三参 false，annContainer 渲染独立注释行（老版本格式 生词(注释)）。
  if (_detailMode) {
    // 详细模式：正文仅高亮（不带注释），注释独立成行
    contentSpan.innerHTML = highlightWords(sub.text || '', _noAnnotation ? [] : shownAnns, false);
    annContainer.innerHTML = '';
    if (_noAnnotation) return;
  } else {
    // 简略模式：注释跟在生词后，annContainer 清空不渲染独立行
    contentSpan.innerHTML = highlightWords(sub.text || '', _noAnnotation ? [] : shownAnns, true);
    annContainer.innerHTML = '';
    return;
  }
  // 详细模式注释行：展示完整注释信息
  //   - 词头 + 阶数 + 标签（如 [初中][高中]）
  //   - 全部释义（保留词典完整条目，不再截取随机短义项）
  //   简略模式：注释跟在生词后（inline），仅随机短义项，不另起一行。
  //   详细模式：独立成行，显示 Rank、标签、完整释义。
  for (const a of shownAnns) {
    const line = document.createElement('div');
    line.className = 'beaver-ann-line' + (a.pending ? ' pending' : '');
    line.dataset.word = a.word || '';
    let html = '';
    if (_detailMode) {
      // 详细模式：显示完整注释信息
      // 1. 词头（深绿背景白字）
      html += `<span class="beaver-ann-word">${escapeHtml(a.word || '')}</span>`;
      // 反思（2026-08-08）：用户要求"音标前加一个喇叭按钮"。点击朗读单词（Web Speech API）。
      html += `<button class="beaver-ann-speak" data-word="${escapeHtml(a.word || '')}" title="🔊">🔊</button>`;
      // 2. 注音（异步填充，phonemize 懒加载 5MB bundle）
      //    反思（2026-08-05）：用户要求"用在单词详细注释的时候"，仅详细模式显示
      html += `<span class="beaver-ann-phonetic" data-word="${escapeHtml(a.word || '')}"></span>`;
      // 3. 阶数（如有；第六十三次：不再显示原始 rank 数字，只显示阶数）
      if (a.rank != null && isFinite(a.rank)) {
        html += `<span class="beaver-ann-rank">${rankToStage(a.rank)}</span>`;
      }
      // 4. 标签（如有）
      if (a.tags && a.tags.length > 0) {
        for (const tag of a.tags) {
          html += `<span class="beaver-ann-tags">${escapeHtml(tag)}</span>`;
        }
      }
      // 5. 全部释义（保留词典完整条目）
      // 第一百二十三次：过滤括号不配对的截断残片（历史缓存中已存的 "短裤( shor" 类条目）
      const allTrans = (a.translations || []).filter((s) => Boolean(s) && isBalancedParens(s));
      if (allTrans.length > 0) {
        html += `<span class="beaver-ann-detail-trans">${escapeHtml(allTrans.join(' | '))}</span>`;
      } else if (a.pending) {
        html += `<span class="beaver-ann-detail-trans pending">翻译中...</span>`;
      }
    } else {
      // 简略模式：随机短义项，生词(注释) 格式
      const shortTrans = pickRandomShortTrans(a.translations);
      const transText = shortTrans ? escapeHtml(shortTrans) : '';
      if (transText) {
        html = `<span class="beaver-ann-word">${escapeHtml(a.word || '')}</span><span class="beaver-ann-paren">(</span><span class="beaver-ann-trans">${transText}</span><span class="beaver-ann-paren">)</span>`;
      } else {
        html = `<span class="beaver-ann-word">${escapeHtml(a.word || '')}</span>`;
      }
    }
    line.innerHTML = `<div class="beaver-ann-content">${html}</div>`;
    annContainer.appendChild(line);
    // 注音异步填充（仅详细模式）
    // 反思（2026-08-05）：用户要求"使用 phonemize 给单词注音，用在单词详细注释的时候"。
    //   phonetics.getPhonetic 懒加载 phonemize-bundle.mjs（5.1MB），首次调用 1-2 秒，
    //   后续命中 _cache Map 直接返回。await 期间 line 可能被 fillSlotAnnotations 重绘移除，
    //   故 await 后校验 line.isConnected，避免向已脱离 DOM 的 span 写入（无效且浪费）。
    if (_detailMode && a.word) {
      fillPhoneticAsync(line, a.word);
    } else {
      console.log('[VocabRadar][video-sidebar] 跳过音标填充: _detailMode=' + _detailMode + ' word="' + (a.word || '') + '"');
    }
  }
}

/**
 * 异步填充详细注释行的注音 span
 * 反思（2026-08-05）：
 *   - line 可能在 await 期间被 fillSlotAnnotations 重绘替换（换集/重扫），需 isConnected 校验
 *   - getPhonetic 内部已缓存（_cache Map），同一单词重复调用 O(1)
 *   - 注音失败返回空串，span 保持空（CSS :empty 不占位）
 * 反思（2026-08-05 修正）：用户反馈"没看到音标"。
 *   - 新增 console.log 诊断日志，打印 word 和结果，便于排查
 *   - 新增 span.isConnected 校验（span 可能随 line 一起被重绘移除）
 *   - 新增加载中占位符 "…"，让用户知道注音正在加载（bundle 5.1MB 首次 1-2 秒）
 * @param {HTMLElement} line 详细注释行 .beaver-ann-line
 * @param {string} word 单词
 */
async function fillPhoneticAsync(line, word) {
  const span = line.querySelector('.beaver-ann-phonetic');
  if (!span) return;
  // 加载中占位符（让用户知道注音正在加载）
  span.textContent = '…';
  try {
    const phon = await getPhonetic(word);
    // await 期间 line 可能已被重绘移除（fillSlotAnnotations 重建 annContainer.innerHTML）
    if (!line.isConnected) {
      console.log('[VocabRadar][phonetics] line 已断开, 丢弃结果: "' + word + '"');
      return;
    }
    // 重新查询 span（line 可能被重绘，span 可能已是新元素）
    const curSpan = line.querySelector('.beaver-ann-phonetic');
    if (!curSpan) return;
    if (phon) {
      curSpan.textContent = phon;
      console.log('[VocabRadar][phonetics] 填充成功: "' + word + '" → "' + phon + '"');
    } else {
      // 注音失败，清空占位符（CSS :empty 不占位）
      curSpan.textContent = '';
      console.warn('[VocabRadar][phonetics] 注音为空: "' + word + '"（bundle 可能未加载或 phonetizeWord 失败）');
    }
  } catch (e) {
    console.warn('[VocabRadar][phonetics] 注音失败:', word, e);
    // 清空占位符
    if (line.isConnected) {
      const curSpan = line.querySelector('.beaver-ann-phonetic');
      if (curSpan) curSpan.textContent = '';
    }
  }
}

// === 注释获取统一入口（Promise 缓存，杜绝 appendASRSubtitle 与渲染槽位竞态）===
// 反思（2026-07-08）：用户反馈"字幕列表一两个生词，生词表十几个生词，匹配么？"。
//   根因：appendASRSubtitle 先 splice sub 进 getSubtitlesRef()，再 await getAnnotations（让出事件循环）。
//   await 期间 timeupdate → updateSlotContent 见缓存未命中 → fetchAnnotationsForSlot 又调
//   getAnnotations。两者共享 _seenWords：先完成的拿真实生词并入 _allAnnotations；后完成的
//   拿 []（词已 seen）并覆盖 _annotationsCache → 字幕内联注释消失，生词表却累计正确。
//   修正：_annotationsCache 改存 Promise；ensureAnnotations 缓存复用，collectAnnotations
//   保证 _allAnnotations.push/appendWordPanelItems 只执行一次（_collectedSubs 守卫），
//   并在换集（sub 被移出 getSubtitlesRef()）后跳过陈旧 push。

// 返回 sub 的注释 Promise（缓存命中复用，未命中创建）。无副作用（不 push 生词表）。
function ensureAnnotations(sub) {
  let p = _annotationsCache.get(sub);
  if (p) return p;
  const text = (typeof sub.text === 'string') ? sub.text : '';
  p = (_noAnnotation || !text)
    ? Promise.resolve([])
    : getAnnotations(text, getRankThreshold(), _seenWords, onAsyncTranslate);
  _annotationsCache.set(sub, p);
  return p;
}

// 获取注释并收集进生词表（_allAnnotations.push + appendWordPanelItems 仅首次执行）。
// 守卫：_collectedSubs 防重复 push；getSubtitlesRef().indexOf(sub)===-1 防换集后陈旧 push。
// 反思（2026-07-13 #94）：用户要求"默认不注释表外词，取消了注释表外词，生词表依然有表外词"。
//   根因：getAnnotations 返回所有注释（含表外词），collectAnnotations 未过滤直接 push。
//   修正：当 getAnnotateOov()=false 时，过滤掉 rank=null 的表外词，只收集词典内单词。
async function collectAnnotations(sub) {
  const anns = await ensureAnnotations(sub);
  const subIdx = getSubtitlesRef().indexOf(sub);
  if (subIdx === -1) return anns;  // sub 已被换集移除，不收集
  if (!_collectedSubs.has(sub)) {
    _collectedSubs.add(sub);
    // 第一百八十七次：过滤口径抽到 filterByCurrentRank，与字幕行注释完全一致
    //   （原本表外词过滤与高频词过滤分散两处，字幕行漏了高频词过滤）
    const filtered = filterByCurrentRank(anns);
    // 第一百七十七次（用户："评论提示里 ego 重复两遍"）：_allAnnotations 数组层去重。
    //   此前直接 push，重复来源有二：① rerenderPanelOnly 清了 _seenWords 却没清
    //   _allAnnotations，注释按钮 off→on 会把同一批词再 push 一遍；② 同批内同词的
    //   不同词面（Ego/ego）。评论/复制/导出/对话全直读 _allAnnotations，故此处必须去重。
    const batchSeen = new Set();
    const fresh = filtered.filter((a) => {
      const key = wordDedupKey(a.word);
      if (!key || batchSeen.has(key)) return false;
      // 第一百八十六次：键集判重+当场登记，消除 check-then-act 竞态
      if (!addWordKey(key)) return false;
      batchSeen.add(key);
      return true;
    });
    // 第一百八十四次：在收集处打词序键 —— 高位取字幕 start（面板即按 start 升序排），
    //   低位取该词在本句注释数组中的下标（= 原文出现顺序，annotator 全链无重排）。
    // 第一百八十五次：句内词序按 wordDedupKey 定位，不再依赖对象同一性
    //   （anns.indexOf(a) 在 a 来自 filtered 的浅层拷贝或跨批对象时返回 -1 → 词序退化为 0）。
    const baseKeys = anns.map((x) => wordDedupKey(x && x.word));
    for (const a of fresh) {
      const w = baseKeys.indexOf(wordDedupKey(a.word));
      a.seq = makeSeq(sub, w >= 0 ? w : baseKeys.length);
    }
    insertAnnotationsOrdered(fresh);
    appendWordPanelItems(fresh);
  }
  return anns;
}

// 槽位注释获取+回填（替换原 fetchAnnotationsForSlot，统一走 collectAnnotations）
async function collectAnnotationsForSlot(slot, subIdx) {
  const sub = getSubtitlesRef()[subIdx];
  if (!sub) return;
  const anns = await collectAnnotations(sub);
  // 首批诊断：打印首条字幕文本+阈值+命中生词数
  if (subIdx === 0) {
    const text = (typeof sub.text === 'string') ? sub.text : '';
    log('首批字幕诊断 text=', JSON.stringify(text.slice(0, 60)),
        'threshold=', getRankThreshold(), '命中生词=', anns.length);
  }
  // 只在槽位仍显示同一条字幕时回填（可能已滚走，此时不更新避免闪烁）
  if (slot.dataset.idx === String(subIdx)) {
    fillSlotAnnotations(slot, sub, anns);
  }
}

// === 底部按钮处理 ===

// 词单模式：点击后只剩单词，移走所有注释（2026-08-07）
// 用户要求"导出按钮改称词单，不再飘窗，点击后只剩单词，移走所有注释"
// 反思（2026-08-07）：旧版用弹窗+textarea，用户嫌飘窗。
//   改为视图切换：点击切换到词表面板，CSS 隐藏音标/释义/标签/词阶，只剩单词。
//   再点击恢复正常视图。按钮 active 态指示当前是否词单模式。
// 反思（2026-08-07 修正）：用户反馈"词汇按钮扩展到了整行"。
//   根因：隐藏字幕/练习标签后，词汇标签 flex:1 扩展整行。
//   修正：不隐藏标签页，只切换到词汇面板+CSS隐藏注释列。切其他标签时自动退出词单模式。
let _wordOnlyMode = false;
export function onWordListToggle() {
  if (_allAnnotations.length === 0) {
    toast(t('toast.noContent'));
    return;
  }
  _wordOnlyMode = !_wordOnlyMode;
  const btn = getRoot().querySelector('#beaver-export');
  if (_wordOnlyMode) {
    btn.classList.add('active');
    // 切换到词汇标签页（但不隐藏其他标签）
    getRoot().querySelectorAll('.beaver-tab').forEach((tab) => tab.classList.remove('active'));
    const wordTab = getRoot().querySelector('.beaver-tab[data-tab="words"]');
    if (wordTab) wordTab.classList.add('active');
    // 显示词汇面板，隐藏其他面板
    getRoot().querySelectorAll('.beaver-panel-section').forEach((p) => p.style.display = 'none');
    const wordPanel = getRoot().querySelector('#beaver-word-panel');
    if (wordPanel) {
      wordPanel.style.display = '';
      wordPanel.classList.add('beaver-word-only');
    }
  } else {
    btn.classList.remove('active');
    const wordPanel = getRoot().querySelector('#beaver-word-panel');
    if (wordPanel) wordPanel.classList.remove('beaver-word-only');
  }
}

// 复制：复制当前标签页整个面板的文本（字幕+注释 或 生词表）到剪切板
// 滑动窗口模式：字幕 tab 遍历所有 getSubtitlesRef()（非仅窗口内），注释从 _annotationsCache 读
// 反思（2026-08-03）：用户反馈"视频提示生词表明明一堆，复制或者评论按钮说没有单词"。
//   旧版用 hasTranslation 过滤无译文的词，导致词表有词但复制报"无内容"。
//   修正：不再过滤，无译文词也纳入复制（释义列显示"-"）；仅当字幕未加载或生词表为空时才提示。
export async function onCopy() {
  const body = await buildPanelBody();
  // body === null 表示当前标签页（练习）不支持导出/复制，提示已在 buildPanelBody 内发出
  if (body === null) return;
  // 空内容保护：禁止只复制前缀（字幕未加载/生词表为空时 body 为空）
  if (!body.trim()) {
    toast(t('toast.noContent'));
    log('复制取消: body 为空, subtitles=', getSubtitlesRef().length, 'anns=', _allAnnotations.length);
    return;
  }
  const text = getCfg().prefixCopy + body;
  log('复制文本长度:', text.length);
  const ok = await copyToClipboard(text);
  if (ok) {
    toast(t('toast.copied'));
    flashButton(getRoot().querySelector('#beaver-copy'));
  } else {
    toast(t('toast.copyFail'));
    log('复制失败，文本预览:', text.slice(0, 100));
  }
}

/**
 * 第一百八十三次：单独拼装「字幕全文 + 各条注释」
 * 抽出的理由：复制/导出要的是"当前标签页所见内容"，而对话要讨论的恒是字幕文本；
 *   旧版三方共用 buildPanelBody，切到生词表标签后点对话就把整张词汇表预填进输入框
 *   （用户："历史对话预填对话咋成了词汇表？"）。抽出此函数供对话单独调用，
 *   复制/导出的行为完全不变。
 * @returns {Promise<string>} 字幕正文文本
 */
async function buildSubtitleBody() {
  let body = '';
  // 整个字幕面板：每条字幕 + 其下所有注释（含无译文词，释义列显示"-"）
  for (let i = 0; i < getSubtitlesRef().length; i++) {
    const sub = getSubtitlesRef()[i];
    if (!sub) continue;
    body += `${formatTime(sub.start)} ${sub.text || ''}\n`;
    const annsP = _annotationsCache.get(sub);
    const anns = annsP ? await annsP : [];
    for (const a of anns) {
      body += `  ${formatAnnotationLine(a)}\n`;
    }
  }
  return body;
}

/**
 * 第一百七十一次：拼装当前标签页正文（复制 / 导出共用，避免两处格式分叉）
 * @returns {Promise<string|null>} 正文文本；null 表示当前标签页不支持（已 toast）
 */
async function buildPanelBody() {
  let body = '';
  if (getActiveTab() === 'subtitle') {
    body = await buildSubtitleBody();
  } else if (getActiveTab() === 'words') {
    // 整个生词表（含无译文词，释义列显示"-"）
    for (const a of _allAnnotations) {
      body += `${formatAnnotationLine(a)}\n`;
    }
  } else {
    toast(t('toast.trainNoCopy'));
    return null;
  }
  return body;
}

/**
 * 第一百七十一次：导出当前标签页正文为 .txt 文件（copy 右侧按钮）
 * manifest 未申请 downloads 权限，走 Blob + URL.createObjectURL + a[download]。
 */
export async function onExportFile() {
  const body = await buildPanelBody();
  if (body === null) return;
  if (!body.trim()) {
    toast(t('toast.noContent'));
    return;
  }
  const text = getCfg().prefixCopy + body;
  try {
    // 文件名用页面标题（剔除文件系统非法字符）+ 时间戳，避免同名覆盖
    const base = String(document.title || 'VocabRadar').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60).trim() || 'VocabRadar';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = base + '_' + stamp + '.txt';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // 延迟回收：立刻 revoke 会让部分浏览器的下载中断
    setTimeout(() => {
      try { a.remove(); } catch (_) { /* ignore */ }
      try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
    }, 4000);
    toast(t('ws.exported'));
    flashButton(getRoot().querySelector('#beaver-export-file'));
  } catch (e) {
    // 不遮蔽错误：把原始异常带给用户
    toast(t('ws.exportFail') + String((e && e.message) || e));
  }
}

/**
 * 第一百七十一次：视频侧栏对话按钮（评论按钮左侧）
 * 第一百七十四次：按用户要求"没有内容也能唤起"——正文为空不再 toast 拦截，
 *   照样打开空面板（此时无引用、输入框为空），由用户自由提问。
 * 第一百八十三次（用户："预填对话咋成了词汇表？"）：讨论对象恒为字幕全文。
 *   旧版走 buildPanelBody，会随当前标签页变化——切到生词表就预填整张词汇表、
 *   切到练习页则 toast 拦截后预填空。对话要讨论的是原文，与看哪个标签页无关，
 *   故改为直接调 buildSubtitleBody（复制/导出仍走 buildPanelBody，行为不变）。
 * 第一百八十四次：传 kind='sidebar' —— 用 chatSidebarPrompt（"总结上文"），
 *   字幕全文由面板顶部「The context is」上下文区承载。
 */
export async function onChatClickVs() {
  const body = await buildSubtitleBody();
  await openChatPanel(String(body || ''), 'sidebar');
}

// 工具：注释是否有有效译文（非空且非空白）
// 用于评论/弹幕/复制"必须有译文才填"，杜绝"只有前缀"或"单词无释义"
function hasTranslation(a) {
  return Array.isArray(a.translations) && a.translations.some((t) => t && String(t).trim());
}

// 格式化单条注释为文本行：单词 | 释义 | 标签 | 词阶
// 反思（2026-07-08）：用户要求"单词注释除了释义，还有标签、词阶属性，弹幕评论中也带上"。
//   旧版弹幕/评论只有"单词 释义"，缺少标签和词阶。统一为完整四段格式。
//   释义完整不简化（annotator.js 已移除 sim_translate 截断）。
// 反思（2026-08-03）：用户反馈"视频提示生词表明明一堆，复制或者评论按钮说没有单词"。
//   根因：复制/评论用 hasTranslation 过滤掉无译文的词，导致词表有词但按钮报"无单词"。
//   修正：复制/评论不再过滤无译文词，无译文时释义列显示"-"（与标签列空值处理一致）。
function formatAnnotationLine(a) {
  const transArr = a.translations || [];
  const trans = transArr.length > 0 ? transArr.join('；') : '-';
  const tags = (a.tags && a.tags.length > 0) ? a.tags.join(',') : '-';
  const stage = (a.rank !== null && a.rank !== undefined) ? rankToStage(a.rank) : '表外';
  return `${a.word} | ${trans} | ${tags} | ${stage}`;
}

// 评论按钮：点击即把整个生词本填入"视频正下方主评论框"
// 反思修复（2026-07-01）：
//   1. 旧实现 scrollMinIntoView(bili-comments) 会把整个评论区滚进视口，bili-comments
//      很长，主评论框在其顶部之上（视频正下方），结果 deepQuery 命中评论区底部"回复框"。
//      改为：滚到"主评论框容器"（#comment , .comment-wrapper, bili-comments 顶部），
//      用 block:'center' 让主评论框居中，绝不在评论列表里找框。
//   2. 空内容保护：_allAnnotations 为空或译文全 pending 时禁止只填前缀。
//   3. fillCommentInput 限定在"视频正下方主评论区"内查找，不进入评论项列表。
// 反思修复（2026-07-19）：
//   用户反馈"有些评论有字数限制，随机选取"。各平台/场景评论上限不同（B站前端实测约 1000
//   字符，回复框更短，其他平台差异更大）。组装全文后若超 commentMaxLen，需随机选取若干
//   行重新组装，保证可发送。算法：Fisher-Yates 打乱行索引→贪心加入直到再加超限→
//   恢复原始字幕顺序（保证阅读连贯）。单行就超限的极端情况下，该行被跳过。
export async function onCommentClick() {
  // 反思（2026-08-03）：用户反馈"视频提示生词表明明一堆，复制或者评论按钮说没有单词"。
  //   旧版用 hasTranslation 过滤无译文的词，导致词表有词但评论报"无单词"。
  //   修正：不再过滤，所有生词均纳入评论（无译文词释义列显示"-"）；仅当生词表为空时才提示。
  const lines = _allAnnotations.map(formatAnnotationLine);
  if (lines.length === 0) {
    toast(t('toast.noContent'));
    log('评论填入取消: 生词表为空, anns=', _allAnnotations.length);
    return;
  }
  const prefix = getCfg().prefixComment;
  const maxLen = getCfg().commentMaxLen || 0;
  let usedLines = lines;
  let trimmed = false;
  // 字数限制保护：超限时随机选取
  if (maxLen > 0) {
    const fullLen = prefix.length + lines.reduce((s, l) => s + l.length + 1, 0);
    if (fullLen > maxLen) {
      usedLines = pickRandomLinesForComment(lines, maxLen, prefix.length);
      trimmed = true;
      log(`评论超长: 全文 ${fullLen} > ${maxLen}，随机选取 ${usedLines.length}/${lines.length} 词`);
      if (usedLines.length === 0) {
        // 极端：所有单行都超限，无法填入
        toast(t('toast.commentFail'));
        log('评论填入取消: 所有单行均超 commentMaxLen');
        return;
      }
    }
  }
  const cmtText = prefix + usedLines.join('\n');
  log('准备填入评论, 文本预览:', cmtText.slice(0, 100));
  // 先给视觉反馈
  flashButton(getRoot().querySelector('#beaver-comment'));

  // 定位"视频正下方主评论框容器"：B站结构为 #commentapp > bili-comments，
  // 主评论框在 bili-comments 顶部（评论列表之上）。滚到该容器顶部而非底部。
  const mainCommentContainer = findMainCommentContainer();
  if (mainCommentContainer) {
    scrollMinIntoView(mainCommentContainer);
    await new Promise((r) => setTimeout(r, 450));
  }
  await expandCommentBox();
  const ok = await fillCommentInput(cmtText);
  if (ok) {
    if (trimmed) {
      toast(t('toast.commentTrimmed', { picked: usedLines.length, total: lines.length }));
    } else {
      toast(t('toast.commentFilled'));
    }
  } else {
    toast(t('toast.commentFail'));
    log('评论框未命中, mainContainer=', mainCommentContainer ? mainCommentContainer.tagName : '无');
  }
}

// 追加一条 ASR 识别结果到字幕区域（作为普通字幕条目，与普通字幕完全同源）。
// 2026-07-04 重构：预识别架构简化时间逻辑。
//   asr-client 的 onText 回调直接返回视频相对秒数（seg.start/seg.end），
//   无需墙钟偏移反算。B站路径通过 PCM 偏移精确计算，回退路径通过 video.currentTime 跟踪。
//   offscreen 启用 return_timestamps=true，返回 chunk 级时间戳，
//   asr-client 按 chunk 拆分后逐条调用 onText，每条字幕有精确的起止时间。
//   ASR 结果直接进入 getSubtitlesRef()，复制/OCR/弹幕/评论和 highlightCurrent 自动生效。
//   滑动窗口模式（2026-07-07）：不再直接插入 DOM/_subEntries，只插入 getSubtitlesRef() +
//   缓存注释。窗口内容由 highlightCurrent 在下次 timeupdate 时自然更新。
// seg: {start, end, text}（start/end 为视频相对秒数）。
// 反思（2026-07-05）：用户反馈"字幕要按照时间顺序，不是识别顺序"。
// 旧版直接 push 到末尾，若识别段乱序到达（如 Whisper 处理时间差异），字幕顺序错乱。
// 修正：按 start 时间二分查找插入位置，保持 getSubtitlesRef() 有序。
export async function appendASRSubtitle(seg) {
  if (!getRoot() || !seg || !seg.text) return;
  // 第一百三十三次：首批 ASR 结果到达 → 自动展开一次（启动折叠态的解除）
  autoExpandOnce();
  // seg.start/seg.end 已经是视频相对秒数，直接使用
  let videoStart = (typeof seg.start === 'number' && isFinite(seg.start)) ? seg.start : 0;
  let videoEnd = (typeof seg.end === 'number' && isFinite(seg.end)) ? seg.end : (videoStart + 5);
  if (videoStart < 0) videoStart = 0;
  if (videoEnd <= videoStart) videoEnd = videoStart + 1;
  const sub = {
    start: videoStart,
    end: videoEnd,
    text: seg.text
  };

  // 按 start 时间查找插入位置（二分查找）
  let lo = 0, hi = getSubtitlesRef().length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (getSubtitlesRef()[mid].start < videoStart) lo = mid + 1;
    else hi = mid;
  }
  const insertIdx = lo;

  // 插入 getSubtitlesRef()
  getSubtitlesRef().splice(insertIdx, 0, sub);
  // 反思（2026-08-06）：同步单条 ASR 字幕到视频内字幕 overlay（全屏时显示）
  overlayAddSubtitle(sub);

  // 走生词注释流程（统一入口 collectAnnotations，避免与渲染槽位竞态覆盖缓存）
  const anns = await collectAnnotations(sub);
  // 诊断日志：排查"ASR 字幕无生词注释，生词表空"
  log('ASR 注释诊断 text=', JSON.stringify(sub.text.slice(0, 50)),
      'noAnn=', _noAnnotation, 'rank=', getRankThreshold(),
      'anns=', anns.length, '总生词=', _allAnnotations.length);

  // 全量渲染模式：直接创建字幕条目并追加到面板（2026-07-13 #93）
  const panel = getRoot().querySelector('#beaver-subtitle-panel');
  if (panel) {
    if (panel.querySelector('.beaver-loading') || _windowSlots.length === 0) {
      if (_windowSlots.length === 0) {
        // 首批 ASR 结果：初始化全量渲染面板
        // 反思（2026-07-13 #92）：传 keepAnnotations=true 保留 collectAnnotations 已收集的生词，
        //   避免 renderSubtitlePanel 清空 _allAnnotations 后生词表丢失已收集的内容。
        renderSubtitlePanel(true);
      }
    } else {
      // 后续 ASR 结果：直接追加到面板末尾（全量渲染模式）
      const slot = createEmptySlot();
      slot.dataset.idx = String(insertIdx);
      slot.querySelector('.beaver-sub-time').textContent = formatTime(sub.start || 0) + '\u00a0\u00a0';
      slot.querySelector('.beaver-sub-content').textContent = sub.text || '';

      // 反思（2026-07-28 #bug3 三次修正）：
      //   1) 分隔符改为纯空行（无 textContent）
      //   2) 阈值提到 5s：ASR 自然句间停顿不算间断
      //   3) 合并连续间隔：仅在间断区间起点插入一个分隔符
      //     判断：当前间隔>5s 且 前一条字幕是连续的（间隔<=5s）→ 新间断区间起点
      const GAP_THRESHOLD = 5.0;
      const prevSub = getSubtitlesRef()[insertIdx - 1];
      if (prevSub) {
        const prevEnd = (typeof prevSub.end === 'number' && isFinite(prevSub.end)) ? prevSub.end : (prevSub.start || 0);
        const curStart = videoStart;
        const curGap = curStart - prevEnd;
        if (curGap > GAP_THRESHOLD) {
          // 当前是大间隔，检查前一条字幕是否也在大间隔中
          const prevPrevSub = getSubtitlesRef()[insertIdx - 2];
          let prevWasDiscontinuous = false;
          if (prevPrevSub) {
            const ppEnd = (typeof prevPrevSub.end === 'number' && isFinite(prevPrevSub.end)) ? prevPrevSub.end : (prevPrevSub.start || 0);
            const prevStart = (typeof prevSub.start === 'number' && isFinite(prevSub.start)) ? prevSub.start : 0;
            prevWasDiscontinuous = (prevStart - ppEnd) > GAP_THRESHOLD;
          }
          // 仅在 前一条是连续的 情况下插入分隔符（间断区间起点）
          if (!prevWasDiscontinuous) {
            const sep = document.createElement('div');
            sep.className = 'beaver-sub-gap';
            panel.insertBefore(sep, panel.children[insertIdx] || null);
          }
        }
      }

      // 二分查找插入位置，保持字幕有序
      const insertBeforeEl = _windowSlots.find((s, i) => i >= insertIdx);
      if (insertBeforeEl) {
        panel.insertBefore(slot, insertBeforeEl);
      } else {
        panel.appendChild(slot);
      }
      _windowSlots.splice(insertIdx, 0, slot);
      _subEntries.splice(insertIdx, 0, { sub, annotations: null, el: slot, subIdx: insertIdx });
      // 更新后续条目的 data-idx
      for (let i = insertIdx + 1; i < _windowSlots.length; i++) {
        _windowSlots[i].dataset.idx = String(i);
        if (_subEntries[i]) _subEntries[i].subIdx = i;
      }
      collectAnnotationsForSlot(slot, insertIdx);
    }
  }
  log('ASR 字幕已插入 idx=', insertIdx, 'text=', seg.text.slice(0, 40));
  // 插入字幕后主动调 highlightCurrent，让当前时间附近的字幕立即高亮
  if (getActiveVideo() && _windowSlots.length > 0) {
    try { highlightCurrent(getActiveVideo().currentTime); } catch (e) { /* ignore */ }
  }
}
// ============================================================================
// 2026-08-28 拆分第三刀：渲染状态接驳导出（门面经此读写，等价于原同模块直接赋值）
// ============================================================================
export function setNoAnnotation(v) { _noAnnotation = v; }
export function setDetailMode(v) { _detailMode = v; }
export function getDetailMode() { return _detailMode; }
// 渲染状态整体重置：换集/骨架重建/destroySidebar/ASR 启动清空共用同一序列，
// 语句与原门面内联清空块逐字一致，仅提取为函数（机械搬移，行为不变）
export function resetRenderState() {
  _subEntries = [];
  setAllAnnotations([]);   // 第一百八十六次：同步清词键集
  _seenWords.clear();
  _annotationsCache.clear();
  _collectedSubs = new WeakSet();
  _windowSlots = [];
  _activeSubIdx = -1;
}
