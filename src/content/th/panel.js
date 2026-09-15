// 文本提示 · 面板模块（右键查词面板 + OCR 结果面板）
//
// === 拆分说明（2026-08-28）===
// 来源：src/content/text-hint-impl.js（2390 行）机械拆分，逻辑与行为零改动。
// 本文件职责：
//   1. 右键查词面板（#beaver-context-panel，Shadow DOM）：结构构建、创建、
//      显示/隐藏、定位（两遍法 + 动态 max-height）、面板用词条查询
//   2. OCR 结果面板（#beaver-ocr-panel，light DOM 便于 TreeWalker 扫描）：
//      创建、显示/隐藏、定位、视频截帧 OCR 入口
//   3. 卡片公共内容结构 buildCardInnerHTML（悬浮提示复用）
//
// 共享状态一律取自 core.js 的 thState（唯一属主），本文件不再声明任何同名变量。
// 模块级副作用：ensurePanel 的 document mousedown(capture)/keydown、
//   ensureOcrPanel 的 document mousedown(capture)/keydown——均由 `if (_xxx) return`
//   幂等守卫保证只注册一次，与拆分前完全一致。
//
// 跨模块调用（受控循环 import，两端均为函数声明，顶层不调用）：
//   → tooltip.js: hideTooltip（ensurePanel 的 mousedown 同时管 tooltip 与 panel）
//   → scan.js: processTextNode（OCR 文本注释生词）
import { lookupFull } from '../../lib/dictionary.js';
// 2026-09-09 第二百四十二次：补 primeTranslator——查词/OCR 面板打开即用户手势上下文，
//   此时机创建内置翻译实例（Chrome Translator API 的 create() 需 user activation），
//   创建后自动注释场景复用（translate 无需手势）。
import { translate, getLastTranslateChannel, primeTranslator } from '../../lib/translator.js';
import { lemmaFamily } from '../../lib/lemmatizer.js';
// 2026-09-04（原形折叠进悬浮/面板）：diverse-lemmas 语言名单（纯数据无依赖），
// 无覆盖语种不显示常显原形（中/日原形即本身，无意义）。
import { LANGUAGES } from '../../lib/vendor/diverse-lemmas/languages.js';
import { t } from '../../lib/i18n.js';
import { getPhonetic } from '../../lib/phonetics.js';
// 310次（用户裁定"本应该只插入短释义"）：插入口径回滚为 pickCleanShortTrans 首条短义项
//   （上轮全义项 join 是误判"插入不全"的正确行为，予以撤销）。
import { pickCleanShortTrans, splitTransLines } from '../../lib/dict-clean.js';
import {
  thState, PANEL_ID, OCR_PANEL_ID, HIGHLIGHT_CLASS, PROCESSED_ATTR,
  formatStage, isContextValid, speak
} from './core.js';
import { hideTooltip } from './tooltip.js';
import { processTextNode } from './scan.js';
// 第一百七十一次：右键查词面板底部 chat 按钮 —— 对话面板唯一实现在 lib/chat.js
import { CHAT_PANEL_ID, openChatPanel } from '../../lib/chat.js';
// 第一百八十六次：对话上下文的网页正文来源（Readability 优先），唯一实现在 lib/main-text.js
import { getAiMainText } from '../../lib/main-text.js';
// 第一百七十六次（用户："图示字符显示不出来，换成小图标"，裁定范围含扩展自身界面标题）：
//   原品牌前缀 🦫（U+1F9AB）在 Windows 10 旧版 Segoe UI Emoji 无字形，渲染成豆腐块；
//   改用侧栏顶行同款内联 SVG 小图标，由 sidebar-topbar.js 唯一定义。
import { brandIconSVG } from '../../lib/sidebar-topbar.js';

// === 原形折叠（2026-09-04，用户："网页提示以及右键查询中没有"）===
// 悬浮提示与右键面板共用卡片结构（buildCardInnerHTML），原形 chip 逻辑集中于此，
// tooltip.js 调用 renderLemmaInto（已从本模块导入 buildPanelHTML，同受控循环）。
// 目标语言缓存自建（th 模块各自读 storage，不跨模块搬状态）。
let _thLearnLang = 'en';
try {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({ learnLanguage: 'en' }, (res) => {
      if (res && typeof res.learnLanguage === 'string' && res.learnLanguage) _thLearnLang = res.learnLanguage;
    });
    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.learnLanguage && typeof changes.learnLanguage.newValue === 'string' && changes.learnLanguage.newValue) {
          _thLearnLang = changes.learnLanguage.newValue;
        }
      });
    }
  }
} catch (_) { /* 非扩展上下文默认 en */ }

/** 本文件内小转义（新代码用；旧 innerHTML 拼接沿用原样不动） */
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 目标语是否有词形还原覆盖（diverse-lemmas LANGUAGES 名单为准）
 * @param {string} lang 语言码
 * @returns {boolean}
 */
function supportsLemmaLang(lang) {
  if (!LANGUAGES) return false;
  return Object.prototype.hasOwnProperty.call(LANGUAGES, String(lang || '').toLowerCase());
}

/** 当前目标语是否显示原形 chip（tooltip.js 经 renderLemmaInto 间接使用） */
function lemmaChipEnabled() {
  return supportsLemmaLang(_thLearnLang);
}

/**
 * 渲染卡片原形行（悬浮提示与右键面板共用，tooltip.js 也调此函数）
 *
 * 反思（2026-09-04）：①"即便原形也要说"——有覆盖语种且 lemma 已知即常显 chip；
 *   lemma 未知（如悬浮 base 词 scan 只给 null）且查询是单词时，原词即原形兜底
 *   （与 annotator 组装口径一致；多词选区不兜底）；
 *   ②"首字母大写"——历史 IDB 表层大小写坏档到显示层统一小写（词典惯例）；
 *   ③chip 化——斜体＋底色按钮即开关，无"原形："前缀无 ▶/▼ 后缀，展开态 .open 换色。
 * @param {ShadowRoot} shadow 卡片 shadow root
 * @param {string} word 查询词面
 * @param {string|null} lemma 原形（可空）
 */
export function renderLemmaInto(shadow, word, lemma) {
  if (!shadow) return;
  const row = shadow.querySelector('.lemma-row');
  const box = shadow.querySelector('.lemma-group');
  if (!row || !box) return;
  let lem = String(lemma || '').trim().toLowerCase();
  const single = /^\S+$/.test(String(word || '').trim());
  if (!lem && supportsLemmaLang(_thLearnLang) && single) lem = String(word).trim().toLowerCase();
  if (supportsLemmaLang(_thLearnLang) && lem) {
    row.innerHTML = `<button class="lemma-chip" data-lemma="${escHtml(lem)}" title="${escHtml(t('th.lemmaExpand'))}">${escHtml(lem)}</button>`;
    box.dataset.lemma = lem;
    box.style.display = 'none';
    box.innerHTML = '';
  } else if (lem && lem !== String(word || '').toLowerCase()) {
    row.innerHTML = `${t('th.lemma')}: <b>${escHtml(lem)}</b>`;
    box.dataset.lemma = '';
    box.style.display = 'none';
    box.innerHTML = '';
  } else {
    row.innerHTML = '';
    box.dataset.lemma = '';
    box.style.display = 'none';
    box.innerHTML = '';
  }
}

/**
 * 卡片原形折叠开关（shadow 内点击委托调用，面板与悬浮共用）
 *
 * 反思（2026-09-04 二轮）：展开改纯词单行——同行只列词（`, ` 分隔，块底色，不斜体，
 *   查询词加粗置顶；展示统一小写），释义列删除（家族词多无缓存译文，空行像 bug）。
 * 展开源只有词形整表家族（卡片是单查询词，无词表上下文）：lemmaFamily 只要词，
 * 失败留空不报错。
 * @param {ShadowRoot} shadow 卡片 shadow root
 * @param {HTMLElement} btn 被点的 .lemma-chip 按钮
 */
export function toggleLemmaGroupTh(shadow, btn) {
  if (!shadow || !btn) return;
  const box = shadow.querySelector('.lemma-group');
  if (!box) return;
  if (box.style.display !== 'none') {
    box.style.display = 'none';
    box.innerHTML = '';
    btn.classList.remove('open');
    btn.title = t('th.lemmaExpand');
    return;
  }
  const key = String(btn.dataset.lemma || '').toLowerCase();
  if (!key) return;
  // 查询词置顶加粗（展示统一小写），家族随后追加
  let selfWord = '';
  try {
    const wEl = shadow.querySelector('.word');
    selfWord = String((wEl && wEl.textContent) || '').trim().toLowerCase();
  } catch (_) {}
  const seenF = new Set();
  const words = [];
  if (selfWord) { seenF.add(selfWord); words.push(selfWord); }
  box.innerHTML = words.map((w) => `<b>${escHtml(w)}</b>`).join(', ')
    + `<span class="lemma-more">, …</span>`;
  box.style.display = '';
  btn.classList.add('open');
  btn.title = t('th.lemmaCollapse');
  lemmaFamily(key, _thLearnLang, 20).then((fam) => {
    if (!box.isConnected || box.style.display === 'none') return;
    const ph = box.querySelector('.lemma-more');
    const extra = [];
    for (const w of (fam || [])) {
      const s = String(w || '').trim().toLowerCase();
      if (!s || seenF.has(s)) continue;
      seenF.add(s);
      extra.push(s);
    }
    const html = extra.map((w) => escHtml(w)).join(', ');
    if (ph) ph.outerHTML = extra.length > 0 ? ', ' + html : '';
    else if (extra.length > 0) box.insertAdjacentHTML('beforeend', ', ' + html);
  }).catch(() => {
    const ph = box.querySelector('.lemma-more');
    if (ph) ph.remove();
  });
}

/** 卡片 shadow 内原形 chip 点击委托（ensurePanel/ensureTooltip 各绑一次） */
function onCardLemmaClick(e, shadow) {
  const btn = (e && e.target && e.target.closest) ? e.target.closest('.lemma-chip') : null;
  if (!btn) return;
  e.stopPropagation();
  if (e.preventDefault) e.preventDefault();
  toggleLemmaGroupTh(shadow, btn);
}

/** 给卡片 shadow 绑定原形 chip 委托（导出给 tooltip.js 的 ensureTooltip 用） */
export function bindLemmaChipClick(shadow) {
  if (!shadow) return;
  shadow.addEventListener('click', (e) => onCardLemmaClick(e, shadow));
}

// 308次：show in page 插入锚点——showContextPanel 时保存的选区 Range 克隆（模块级单查询生效）
let lastQueryRange = null;
// 319次：整段插入时认定的块级元素集合（选区起点向上找最近块级，段落后新行插译文；
//   与 scan.js getBlockOriginText 的 BLOCK_TAGS 同口径精简）
const TH_BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'DD', 'DT', 'SECTION', 'ARTICLE', 'MAIN', 'FIGCAPTION', 'CAPTION']);
// 309次第三轮（用户"插入的释义应当是短释义"）：showContextPanel/renderQueryCard 数据流中
//   解析出的释义数组缓存（每次新查询重置）——插入时经 pickCleanShortTrans 取首条短义项，
//   与侧邻注释同一口径；无数组时回退 .trans-row 首行文本。
let lastQueryTranslations = [];
// 310次（用户"你禁止了文段翻译差异"）：来源标记——词典外选区走整段翻译（true），
//   词典释义/词典词翻译回填（false）。插入时文段插整段译文，词典插短释义，二者有别。
let lastQueryIsSegment = false;

/**
 * 309次第三轮（用户"查询到非单词，多个词的时候，不要注音，不要词形还原"）：
 * 多词/长文判定（与 renderQueryCard/insertMeaningIntoPage 既有口径统一抽取）：
 * 含 ≥2 个拉丁词元，或整体长度 >24 视为整段。
 * @param {string} text 查询文本
 * @returns {boolean}
 */
function isMultiWordText(text) {
  const tokens = String(text).split(/[\s\u3000]+/).filter((s) => /[A-Za-z\u00C0-\u024F]/.test(s));
  return tokens.length > 1 || String(text).length > 24;
}

/**
 * 316次：选段过滤辅助——按 Range 逐文本节点重建选区文本，跳过 .beaver-page-insert
 * （本扩展插入页面的释义节点，见 insertMeaningIntoPage）祖先内的文本，只保留原文。
 * 处理 start/end offset 切片；被跳过节点处以空格占位防跨块文字粘连；
 * 结果多空白归一，异常/空串返回 ''（调用方退回原始 selectionText）。
 * @param {Range} range 页面选区 Range
 * @returns {string}
 */
function extractCleanSelText(range) {
  try {
    const anc = range.commonAncestorContainer;
    const walkerRoot = (anc.nodeType === 1) ? anc : anc.parentElement;
    if (!walkerRoot) return '';
    const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT, null);
    const sc = range.startContainer;
    const ec = range.endContainer;
    const parts = [];
    let n;
    while ((n = walker.nextNode())) {
      if (!range.intersectsNode(n)) continue;
      const el = n.parentElement;
      if (el && el.closest && el.closest('.beaver-page-insert')) { parts.push(' '); continue; }
      let txt = n.textContent || '';
      const isStart = (n === sc && sc.nodeType === 3);
      const isEnd = (n === ec && ec.nodeType === 3);
      if (isStart && isEnd) txt = txt.slice(range.startOffset, range.endOffset);
      else if (isStart) txt = txt.slice(range.startOffset);
      else if (isEnd) txt = txt.slice(0, range.endOffset);
      parts.push(txt);
    }
    return parts.join('').replace(/\s+/g, ' ').trim();
  } catch (_) {
    return '';
  }
}

/**
 * 显示右键菜单查词面板
 * @param {string} text 用户选中的文本
 */
export function showContextPanel(text, clientX, clientY) {
  // 316次（用户"选段翻译时候，排除插入的释义，只选原文"）：SW 转发的 selectionText
  //   取自浏览器原生选区（info.selectionText），若框选范围混入了本扩展插入页面的
  //   释义节点（.beaver-page-insert），译文会被一并送查。此刻右键菜单刚触发、选区
  //   仍在，先取 Range：克隆作 lastQueryRange（308次插入锚点，原逻辑提前至此共用）；
  //   混入检测（端点落在插入节点内 或 克隆片段含插入元素）命中时按节点级过滤重取原文，
  //   过滤结果为空才退回原始 selectionText（例如只框选了插入释义本身）。
  let range = null;
  try {
    const sel = window.getSelection();
    range = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0) : null;
  } catch (_) { range = null; }
  if (range) {
    lastQueryRange = range.cloneRange();
    let hitInsert = false;
    try {
      const sEl = range.startContainer && range.startContainer.parentElement;
      const eEl = range.endContainer && range.endContainer.parentElement;
      hitInsert = !!(sEl && sEl.closest && sEl.closest('.beaver-page-insert'))
        || !!(eEl && eEl.closest && eEl.closest('.beaver-page-insert'))
        || (() => {
          const frag = range.cloneContents();
          return !!(frag.querySelector && frag.querySelector('.beaver-page-insert'));
        })();
    } catch (_) { hitInsert = false; }
    if (hitInsert) {
      const cleaned = extractCleanSelText(range);
      if (cleaned) text = cleaned;
    }
  } else {
    lastQueryRange = null;
  }
  const trimmed = text.trim();
  if (!trimmed) return;
  // 310次：新查询重置短释缓存与来源标记（旧查询残留会被 pickCleanShortTrans 误取）
  lastQueryTranslations = [];
  lastQueryIsSegment = false;
  // 2026-09-09 第二百四十二次：手势入口 prime 内置翻译（不 await，不阻塞面板）。
  //   本函数由右键菜单（SW 转发 SHOW_CONTEXT_PANEL）触发，距用户在页面右键 1-3s，
  //   transient activation（约 5s 窗口）仍有效，Translator.create() 此刻可成功；
  //   实例缓存后自动注释场景复用。已就绪/冷却期内为 no-op，重复调用无害。
  //   第二百四十三次：改显式 force=true——右键是明确查词意图，清冷却强制重试；
  //   force 语义现由 primeTranslator(opts) 控制，hover 等高频入口不得用。
  primeTranslator({ force: true });
  ensurePanel();
  // 310次（用户"查询窗固定字号"）：删 syncBodyFontSize——body 字号同步会覆盖
  //   ensurePanel 的 14px !important（localhost:3001 body 18px → 查询窗字号偏大），
  //   查询窗字号恒为 14px 基准（buildPanelCss 内 em 已换算 px 定死）。

  const shadow = thState.panel.shadowRoot;
  thState.panel.style.display = 'block';
  positionPanel(clientX, clientY);
  // 第二百七十二次：查询渲染核心抽为 renderQueryCard——右键浮动面板与文本侧栏
  //   query 标签内嵌卡片共用（同 buildCardInnerHTML 结构）。位置刷新经 onUpdate
  //   回调；alive 守卫保留"面板隐藏期间不写"语义（过期异步不覆盖新查询）。
  renderQueryCard(shadow, trimmed,
    () => positionPanel(clientX, clientY),
    () => !!(thState.panel && thState.panel.style.display !== 'none'),
    { showInPage: true }
  ).catch((e) => console.error('[VocabRadar][text-hint] 右键查询渲染异常:', e));
}

/**
 * 查询渲染核心（第二百七十二次自 showContextPanel 抽出，逻辑 1:1 搬移）
 * 把查询文本的 词典/翻译 结果渲染进 root。root 的 DOM 结构 = buildCardInnerHTML()
 * （.word/.stage/.phonetic-row/.lemma-row/.lemma-group/.trans-row/.tags-row/.footer），
 * 右键浮动面板的 shadowRoot 与文本侧栏 query 标签的内嵌卡片容器皆满足。
 * 算法沿用第一百一十一次用户裁定：①先查词典 ②词典外才翻译 ③翻译后分词——多词仅翻译；
 * 单词则翻译入词典并补全其他属性。
 * @param {Element|ShadowRoot} root 渲染目标（内含 buildCardInnerHTML 结构）
 * @param {string} trimmed 查询文本（已 trim 非空）
 * @param {() => void} [onUpdate] 异步内容到达后的位置刷新回调（浮动面板=positionPanel；内嵌卡片缺省 no-op）
 * @param {() => boolean} [isAlive] 写入守卫（浮动面板=display!==none；内嵌卡片缺省恒 true）
 * @param {{showInPage?: boolean}} [opts] 308次：showInPage=true 时显示 footer 中部
 *   "show in page" 按钮（仅右键浮动面板；内嵌卡片语境无页面插入点，按钮隐藏）
 */
export async function renderQueryCard(root, trimmed, onUpdate, isAlive, opts) {
  const refresh = (typeof onUpdate === 'function') ? onUpdate : () => {};
  const alive = (typeof isAlive === 'function') ? isAlive : () => true;
  const q = (sel) => root.querySelector(sel);

  let word = trimmed;
  // 第一百一十一次（用户裁定算法，撤销第一百一十次的"空白/长度即句子"启发式）：
  // ①先查词典 ②词典外才翻译 ③翻译后分词——多词仅翻译；单词则翻译入词典并补全其他属性。
  // word 不再预抽取：词典命中用选区原文；词典外走翻译分支。
  // 反思（2026-08-13）：用户要求"日志应当有意义，写当前有啥，还要查啥"。
  //   旧日志 "右键查词: learning (选区: learning)" 是废话——选区就是词本身。
  //   修正：先查 IDB 已有数据，日志输出已有字段 + 待查字段。
  //   实际查询在下面的 async 块中完成，此处仅记录入口。

  // 反思（2026-08-13 第四十九次）：panel-header 固定显示品牌（左）+ 词阶（右）。
  //   正文 .word 显示查询词；.word-row 的 .stage 由 CSS 隐藏（词阶只在 header 出现一次）。
  //   内嵌卡片（query 标签）无 .panel-header，各行重置一律判空跳过。
  const headerStage = q('.panel-header .header-stage');
  if (headerStage) headerStage.textContent = '';
  q('.word').textContent = word;
  // 反思（2026-08-13）：用户禁止"Querying..."/"No definition"等歧义文案。
  //   翻译未到时留空，不显示占位文字。翻译失败也留空，不自作主张。
  q('.phonetic-row').textContent = '';
  q('.stage').textContent = '';
  q('.lemma-row').innerHTML = '';
  q('.tags-row').innerHTML = '';
  const tagsSection = q('.tags-section');
  if (tagsSection) tagsSection.style.display = 'none';
  q('.trans-row').textContent = '';

  // 音标异步加载（词典命中路径用；词典外分支在 async 块内自行处理/清空）
  // 309次第三轮（用户"查询到非单词，多个词的时候，不要注音，不要词形还原"）：
  //   多词/整段不注音——多词无对应单词条目音标，异步回填会覆盖词典外分支的清空
  if (word && isContextValid() && !isMultiWordText(word)) {
    getPhonetic(word).then((phon) => {
      if (alive()) {
        q('.phonetic-row').textContent = phon || '';
        refresh();
      }
    }).catch(() => {
      q('.phonetic-row').textContent = '';
    });
  }

  (async () => {
    const lower = word.toLowerCase();
    // 第一百一十一次：①先查词典（lookupFull 含词形还原重试；OOV 返回 null）
    // 316次（用户"便签按钮插你似乎把翻译也像短释义那样截断了"）：多词/长文跳过词典
    //   查询——lookupFull 对表外文段也返回占位词条（query.js 尾部无条件 return result，
    //   其注释声称的"表外返回 null"分支并不存在），导致文段恒走"词典命中"路径、
    //   lastQueryIsSegment 恒 false，show in page 便签被 pickCleanShortTrans 按短释
    //   口径截断。跳过后文段直接落"词典外→翻译整段"分支，插入不再截断；单词路径零变化
    //   （不改 lookupFull：tooltip/scan 等消费方依赖其占位词条行为）。
    let fullRec = null;
    if (!isMultiWordText(word)) {
      try { fullRec = await lookupFull(lower); } catch (e) { fullRec = null; }
    }

    if (!fullRec) {
      // ②词典外 → 翻译整个选区
      q('.phonetic-row').textContent = '';
      q('.trans-row').innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
      let translated = null;
      try { translated = isContextValid() ? await translate(trimmed, true) : null; } catch (e) { translated = null; }
      if (alive()) {
        q('.trans-row').textContent = translated || '';
        // 310次：词典外＝文段翻译路径——整段译文入缓存，标记来源（插入时插整段）
        lastQueryTranslations = translated ? [translated] : [];
        lastQueryIsSegment = true;
        const ch = getLastTranslateChannel();
        console.log(`[VocabRadar][text-hint] 右键翻译(词典外, len=${trimmed.length}): ${translated ? '成功' : '失败'}${ch ? ' 渠道:' + ch : ''}`);
      }
      // ③翻译后分词：多词仅翻译；单词则入词典并补全属性
      //   （translate 已把译文写回统一词典；queryWordForPanel 组装 rank/lemma/tags 写回 IDB；getPhonetic 补音标）
      const tokens = String(trimmed).split(/[\s\u3000]+/).filter((s) => /[A-Za-z\u00C0-\u024F]/.test(s));
      const isMultiWord = tokens.length > 1 || trimmed.length > 24;
      if (!isMultiWord && translated && isContextValid()) {
        const info = await queryWordForPanel(lower, trimmed);
        if (info && info.isWord && alive()) {
          let stg = formatStage(info.rank);
          if (stg.indexOf('NaN') !== -1) stg = t('th.outside');
          q('.stage').textContent = stg;
          if (headerStage) headerStage.textContent = stg;
          // 反思（2026-09-04）：原形行改走共用 renderLemmaInto（常显 chip＋小写归一，悬浮共用）
          renderLemmaInto(root, trimmed, info.lemma);
          if (info.phonetic) {
            q('.phonetic-row').textContent = info.phonetic;
          } else {
            getPhonetic(trimmed).then((phon) => {
              if (alive()) q('.phonetic-row').textContent = phon || '';
            }).catch(() => {});
          }
        }
      }
      refresh();
      return;
    }

    // ④词典命中：沿用单词面板流程
    // 反思（2026-08-12 第四十二次）：queryWordForPanel 从统一词典 IDB 读取完整记录，
    //   返回时 rank/tags/lemma/phonetic 已就绪，translation 可能是缓存的或 pending。
    //   不再阻塞等待翻译完成——有啥先显示啥，翻译异步填充。
    const info = await queryWordForPanel(lower, word);
    if (info && info.isWord) {
      // === 立即显示 rank/tags/lemma（来自 IDB，不等待翻译）===
      let stage = formatStage(info.rank);
      if (stage.indexOf('NaN') !== -1) stage = t('th.outside');
      q('.stage').textContent = stage;
      if (headerStage) headerStage.textContent = stage;
      // 词形还原原形（2026-09-04：改走共用 renderLemmaInto，常显 chip＋小写归一）
      // 309次第三轮（用户"查询到非单词，多个词的时候，不要注音，不要词形还原"）：
      //   多词/整段（词典整体命中短语等）不显示词形还原
      if (!isMultiWordText(word)) renderLemmaInto(root, word, info.lemma);
      // 标签
      // 309次：用户实测"词表标签直接消失"，静态排查无果——在此输出诊断日志：
      //   tags 为空（词典记录无标签数据）与 tagsSection 隐藏状态均可从控制台直接判别
      const tags = info.tags || [];
      console.log(`[VocabRadar][text-hint] 查询卡词表标签: isWord=${info.isWord} tags=${tags.length}`, tags);
      const tagsEl = q('.tags-row');
      tagsEl.innerHTML = '';
      if (tagsSection) tagsSection.style.display = tags.length > 0 ? '' : 'none';
      tags.forEach((tag) => {
        const span = document.createElement('span');
        span.className = 'tag';
        span.textContent = tag;
        tagsEl.appendChild(span);
      });
      // 反思（2026-08-13）：翻译结果显示——
      //   已缓存则直接显示；pending 则显示浮动省略号（动画三点），翻译完成替换；
      //   翻译失败移除省略号留空，不显示"No definition"。
      const trans = info.translations || [];
      // 310次：缓存释义数组供 show in page 取短释；词典命中＝非文段来源
      lastQueryTranslations = trans;
      lastQueryIsSegment = false;
      if (trans.length > 0) {
        // 310次（用户"查询卡片释义没有分拆"）：单条释义内按 | 词性段拆行（letter 案例）
        q('.trans-row').innerHTML = splitTransLines(trans).map(row => `<div>${row}</div>`).join('');
      } else if (info.pending) {
        q('.trans-row').innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
        refresh();
        if (isContextValid()) {
          translate(word, true).then((translated) => {
            if (alive()) {
              if (translated) {
                // 310次：词典词翻译回填同样按 | 拆行（来源仍为词典路径，非文段）
                q('.trans-row').innerHTML = splitTransLines([translated]).map(row => `<div>${row}</div>`).join('');
                // 310次：翻译完成后同步短释缓存（词典路径保持 lastQueryIsSegment=false）
                lastQueryTranslations = [translated];
                // 反思（2026-08-13 第五十二次）：日志标注翻译渠道（本地缓存/内置翻译/在线:xxx），
                //   用户要求"日志能看出翻译渠道"。
                const ch = getLastTranslateChannel();
                console.log(`[VocabRadar][text-hint] 右键查词 "${lower}": 翻译完成 → "${translated}"${ch ? ` (渠道:${ch})` : ''}`);
              } else {
                q('.trans-row').textContent = '';
                console.warn(`[VocabRadar][text-hint] 右键查词 "${lower}": 翻译失败（所有渠道均未返回结果）`);
              }
              refresh();
            }
          }).catch(() => {
            if (alive()) {
              q('.trans-row').textContent = '';
            }
          });
        }
      } else {
        q('.trans-row').textContent = '';
      }
    } else {
      q('.stage').textContent = t('th.notWord');
      if (headerStage) headerStage.textContent = t('th.notWord');
      q('.trans-row').textContent = '';
    }
    refresh();
  })();

  const speakBtn = q('.speak');
  if (speakBtn) speakBtn.onclick = () => speak(word);
  // 第一百七十一次：chat 按钮就"选区原文"发起对话（不是词元，保留用户实际选中的上下文）
  // 第一百八十四次：传 kind='word' —— 右键查询属"单词类查询"，用 chatWordPrompt 模板
  // 第一百八十六次（用户："对话框的上下文依旧胡说。老毛病，并不是第一次出现。
  //   你复述一遍我的要求上下文来源。"）：按 note.txt 原始规定，上下文框的正文**只有两种来源**
  //   —— Readability 提取的网页正文，或字幕。选区原文只能进提问语的 {}，绝不能当上下文。
  //   故此处第三参传 getAiMainText() 的网页正文；提取失败则退回选区原文（不静默留空）。
  const chatBtn = q('.chat');
  if (chatBtn) chatBtn.onclick = async () => {
    let ctxBody = '';
    try {
      const m = await getAiMainText();
      ctxBody = String((m && m.text) || '');
    } catch (e) {
      console.warn('[VocabRadar][th-panel] 取网页正文失败，上下文退回选区原文:', e);
    }
    openChatPanel(trimmed, 'word', ctxBody || trimmed);
  };

  // 308次：底部按钮 show in page——把释义插入页面。整段新换行、单词插入续接。
  // 315次（用户"便签按钮插你禁止了文段翻译插入，大错，撤销任何禁止插入"）：
  //   撤销 308 次的 showInPage 条件——所有查询表面（右键面板/悬浮提示/文本侧栏/
  //   视频侧栏内嵌卡）一律绑定插入并显示按钮，不再任何一处隐藏。侧栏内嵌卡点击时
  //   锚点已失效则走实时选区回落（insertMeaningIntoPage L506-523），无选区给卡片内
  //   反馈行，均可见非静默。
  const showPageBtn = q('.show-page');
  if (showPageBtn) {
    showPageBtn.onclick = () => insertMeaningIntoPage(trimmed, q);
  }
}

/**
 * 322次：选区布局分析——译文样式「跟随原文多数」（用户裁定：跟随原文多数而不是
 *   开头一个字；多段的逐段跟随）。TreeWalker 遍历选区覆盖的文本节点（跳过扩展
 *   UI/已插入译文/侧邻注释），按最近块级容器（TH_BLOCK_TAGS，与路径 C 同口径）
 *   分组，以字符数为权重对五项样式（字色/字族/字号/斜体/粗细）投票：
 *   - global：全选区多数 → 单处插入的译文样式；
 *   - blocks：各块多数（文档序）→ 多段译文逐段插入各块末尾时的该段样式。
 *   生词高亮 span 内文本仍算原文，但样式取高亮容器的父元素（原文容器口径，同 318 次）。
 *   必须在任何 DOM 变更（B 路径 splitText）之前调用；分析失效（选区丢失/落在
 *   扩展 UI 内/无文本）返回 null，调用方回落旧口径（起点元素锁定）。
 * @param {Range} range 插入锚点选区
 * @returns {{blocks: Array<{el: Element, style: Object}>, global: Object}|null}
 */
function analyzeRangeLayout(range) {
  try {
    if (!range || !range.commonAncestorContainer) return null;
    const root = range.commonAncestorContainer;
    const rootEl = root.nodeType === 1 ? root : root.parentElement;
    if (!rootEl || !rootEl.isConnected || rootEl.getRootNode() !== document) return null;
    const SKIP = '.beaver-page-insert, .beaver-side-ann, #' + PANEL_ID
      + ', #beaver-sidebar, #beaver-web-sidebar, #beaver-subtitle-overlay, #beaver-debug-panel';
    if (rootEl.closest && rootEl.closest(SKIP)) return null;
    const STYLE_PROPS = ['color', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight'];
    const byBlk = new Map();   // 块元素 -> Map<样式签名,{style,chars}>
    const global = new Map();  // 签名 -> {style,chars}
    const addVote = (map, style, chars) => {
      const sig = STYLE_PROPS.map((k) => style[k]).join('|');
      const cur = map.get(sig);
      if (cur) cur.chars += chars;
      else map.set(sig, { style, chars });
    };
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || !p.closest || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        if (!range.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      let styleEl = p;
      const wordWrap = p.closest('.beaver-word');
      if (wordWrap && wordWrap.parentElement) styleEl = wordWrap.parentElement;
      const cs = getComputedStyle(styleEl);
      const style = {};
      for (const k of STYLE_PROPS) style[k] = cs[k];
      const chars = n.nodeValue.replace(/\s+/g, '').length;
      // 归块：向上找最近块级容器；到 body 未命中则该文本不参与逐段（无块可插），
      //   但仍计入整体多数
      let blk = p;
      while (blk && blk !== document.body && blk !== document.documentElement
        && !TH_BLOCK_TAGS.has(blk.tagName)) {
        blk = blk.parentElement;
      }
      if (blk && blk !== document.body && blk !== document.documentElement
        && TH_BLOCK_TAGS.has(blk.tagName)) {
        let m = byBlk.get(blk);
        if (!m) { m = new Map(); byBlk.set(blk, m); }
        addVote(m, style, chars);
      }
      addVote(global, style, chars);
    }
    if (global.size === 0) return null;
    const majorityOf = (m) => {
      let best = null;
      m.forEach((v) => { if (!best || v.chars > best.chars) best = v; });
      return best ? best.style : null;
    };
    const blocks = [];
    byBlk.forEach((m, el) => {
      const style = majorityOf(m);
      if (style) blocks.push({ el, style });
    });
    return { blocks, global: majorityOf(global) };
  } catch (e) {
    console.warn('[VocabRadar][text-hint] 选区布局分析失败，回落起点样式:', e);
    return null;
  }
}

/**
 * 308次：show in page——把查询卡片释义插回页面原文处。
 * 整段（多词或长文，同 renderQueryCard 的 isMultiWord 口径）→ 块级 div 新起一行；
 * 单词 → 行内 span 续接在选区词后（空格分隔）。插入点 = showContextPanel 保存的
 * 选区 Range（折叠到选区末尾＝原词后）。插入节点带主题绿字色，便于与正文区分。
 * 309次（用户"无反应"）：旧版失败只写 console，用户不可见——所有结果（成功/失败原因）
 *   均显示在卡片内反馈行（showInsertFeedback，footer 上方，5 秒自动消失）；
 *   保存的 Range 可能因页面重渲染脱离文档（detached），插入前检测
 *   startContainer.isConnected，失效则回落实时选区（排除扩展 UI 内的选区）。
 * @param {string} trimmed 查询原文
 * @param {(sel: string) => Element|null} q 卡片内选择器（读释义用）
 */
function insertMeaningIntoPage(trimmed, q) {
  // 310次（用户裁定）：词典来源取短释义首条 pickCleanShortTrans（"只插一段翻译的前几个
  //   字"即短释义口径，是预期行为非截断 bug）；文段翻译来源插整段译文（保留差异，不切分）。
  let text = lastQueryIsSegment
    ? (lastQueryTranslations[0] || '').trim()
    : pickCleanShortTrans(lastQueryTranslations);
  if (!text) {
    const transRow = q('.trans-row');
    const firstLine = transRow && transRow.firstElementChild ? transRow.firstElementChild.textContent : '';
    text = String(firstLine || (transRow ? transRow.textContent : '') || '').trim();
  }
  if (!text) {
    console.warn('[VocabRadar][text-hint] show in page：释义未就绪，跳过插入');
    showInsertFeedback(q, false, t('th.insertNoDef'));
    return;
  }
  // 309次：锚点有效性——保存的 Range 引用节点若已被页面移除（SPA 重渲染等），
  //   对 detached range insertNode 会把节点插进孤立子树，页面看不到＝"无反应"。
  let range = lastQueryRange;
  if (!range || !range.startContainer || !range.startContainer.isConnected) {
    const sel = window.getSelection();
    const live = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0) : null;
    // 回落条件：实时选区存在、在主文档（非扩展 shadow UI）、且不在本面板内
    const liveOk = live && live.startContainer && live.startContainer.isConnected
      && live.startContainer.getRootNode() === document
      && !(live.startContainer.nodeType === 1
        ? live.startContainer.closest(`#${PANEL_ID}`)
        : live.startContainer.parentElement && live.startContainer.parentElement.closest(`#${PANEL_ID}`));
    if (liveOk) {
      console.warn('[VocabRadar][text-hint] show in page：保存锚点已失效，回落实时选区');
      range = live;
    } else {
      console.warn('[VocabRadar][text-hint] show in page：无可用插入锚点（选区已丢失），跳过插入');
      showInsertFeedback(q, false, t('th.insertNoAnchor'));
      return;
    }
  }
  // 320次：插入护栏——保存的锚点落在已插入的译文/注释节点内部（用户先翻译一个词
  //   再选中一段翻译）时，再插入会把新译文嵌进旧译文（"先翻译一个词再选中一段翻译
  //   会让之前翻译囊括进来污染"）。命中即中止并提示重选原文。
  const guardEl = range.startContainer.nodeType === 3
    ? range.startContainer.parentElement : range.startContainer;
  if (guardEl && guardEl.closest && guardEl.closest('.beaver-page-insert, .beaver-side-ann')) {
    console.warn('[VocabRadar][text-hint] show in page：锚点在已插入译文/注释内，中止插入');
    showInsertFeedback(q, false, t('th.insertInsideAnn'));
    return;
  }
  try {
    // 309次第三轮：多词口径统一走 isMultiWordText
    const isMultiWord = isMultiWordText(trimmed);
    const node = document.createElement(isMultiWord ? 'div' : 'span');
    node.className = 'beaver-page-insert';
    // 318次：插入翻译沿用"原文"样式（用户裁定）——317 次的"外移后纯继承"继承的是
    //   插入点后文样式，原文与后文字体/字色不同时会错。改为在折叠/外移前锁定选区
    //   起点元素的 computedStyle 五项（字色/字族/字号/斜体/粗细）内联，样式随原文走。
    // 322次：译文样式跟随原文「多数」——先 analyzeRangeLayout（必须在任何 DOM
    //   变更之前）按字符权重投票取整体多数；分析失效回落旧口径：
    // 318次：起点元素锁定五项（起点在标注容器内取标注父元素＝原文容器）。
    let fallbackEl = null;
    const layout = analyzeRangeLayout(range);
    if (!layout) {
      fallbackEl = range.startContainer.nodeType === 3
        ? range.startContainer.parentElement
        : range.startContainer;
      const srcAnn = fallbackEl && fallbackEl.closest
        ? fallbackEl.closest('.beaver-word, .beaver-side-ann') : null;
      if (srcAnn && srcAnn.parentElement) fallbackEl = srcAnn.parentElement;
      if (fallbackEl && !fallbackEl.isConnected) fallbackEl = null;
    }
    const baseStyle = layout ? layout.global
      : (fallbackEl ? getComputedStyle(fallbackEl) : null);
    node.style.cssText = (isMultiWord ? 'margin-top:4px;' : 'margin-left:2px;');
    if (baseStyle) {
      node.style.color = baseStyle.color;
      node.style.fontFamily = baseStyle.fontFamily;
      node.style.fontSize = baseStyle.fontSize;
      node.style.fontStyle = baseStyle.fontStyle;
      node.style.fontWeight = baseStyle.fontWeight;
    }
    node.textContent = isMultiWord ? text : ` ${text}`;
    // 319次（调研 kiss-translator 后重写；用户反馈"跑到下一个元素位置插入前面"）：
    //   旧实现信任 live Range 端点——lastQueryRange 保存后 text-hint 扫描用
    //   surroundContents 把词包进 .beaver-word，浏览器把端点自动重映射成
    //   (父元素P, 词span相邻下标N)，closest 不命中时 insertNode 落在 (P,N)＝
    //   下一个元素之前。kiss-translator 的做法是不信任跨 DOM 变更的 Range，
    //   以原文节点为锚插兄弟节点。改为四路径：A 词span紧后 / B 单词文本节点
    //   切分紧后 / C 多词最近块级元素后新行 / F 旧 collapse 序列兜底（317次保留）。
    let pathTag = 'F-Range兜底';
    // 319次：解析词锚——起点在文本节点：父链 closest 找 .beaver-word，文本节点即
    //   B 的操作对象；起点漂移成 (元素,offset)：看 offset 处与前一子节点是否
    //   .beaver-word（修复重映射 (P,N) 场景）或文本节点（B 可继续）。
    const scEl = range.startContainer.nodeType === 3
      ? range.startContainer.parentElement : range.startContainer;
    let wordSpan = scEl && scEl.closest ? scEl.closest('.beaver-word') : null;
    let wordNode = range.startContainer.nodeType === 3 ? range.startContainer : null;
    if (!wordSpan && scEl && scEl.nodeType === 1 && range.startContainer.nodeType !== 3) {
      const kids = scEl.childNodes;
      const c0 = range.startOffset > 0 ? kids[range.startOffset - 1] : null;
      const c1 = kids[range.startOffset] || null;
      if (c0 && c0.nodeType === 1 && c0.classList && c0.classList.contains('beaver-word')) wordSpan = c0;
      else if (c1 && c1.nodeType === 1 && c1.classList && c1.classList.contains('beaver-word')) wordSpan = c1;
      if (!wordNode && c1 && c1.nodeType === 3) wordNode = c1;
      else if (!wordNode && c0 && c0.nodeType === 3) wordNode = c0;
    }
    let inserted = false;
    // 322次：多段逐段跟随——译文按换行拆出的段数与选区覆盖的块数一致时，逐段插到
    //   各块末尾（各段用该块多数样式），优先于 A/B 单点插入（多段译文挤在选区开头
    //   一词之后＝旧观感）；段块数不一致或译文无换行回落单处插入（整体多数样式）。
    const layoutBlocks = (layout && isMultiWord) ? layout.blocks : [];
    const segs = layoutBlocks.length > 1
      ? text.split(/\n+/).map((s) => s.trim()).filter(Boolean) : [];
    if (layoutBlocks.length > 1 && segs.length === layoutBlocks.length) {
      pathTag = 'C-逐段末尾';
      layoutBlocks.forEach((b, i) => {
        const seg = document.createElement(isMultiWord ? 'div' : 'span');
        seg.className = 'beaver-page-insert';
        seg.style.cssText = 'margin-top:4px;';
        seg.style.color = b.style.color;
        seg.style.fontFamily = b.style.fontFamily;
        seg.style.fontSize = b.style.fontSize;
        seg.style.fontStyle = b.style.fontStyle;
        seg.style.fontWeight = b.style.fontWeight;
        seg.textContent = segs[i];
        if (!(b.el.lastElementChild && b.el.lastElementChild.tagName === 'BR')) {
          b.el.appendChild(document.createElement('br'));
        }
        b.el.appendChild(seg);
      });
      inserted = true;
    }
    // A：词 span 命中→紧贴其后插；紧邻已是注释节点（.beaver-side-ann）则排其后，
    //   不插进"词与注释"中间（tooltip.js 同规则，避免夹心观感）。
    if (wordSpan && wordSpan.parentNode) {
      pathTag = 'A-词span紧后';
      const sib = wordSpan.nextElementSibling;
      if (sib && sib.classList && sib.classList.contains('beaver-side-ann')) {
        sib.parentNode.insertBefore(node, sib.nextSibling);
      } else {
        wordSpan.parentNode.insertBefore(node, wordSpan.nextSibling);
      }
      inserted = true;
    }
    // B：单词且拿到起点文本节点→在该节点内定位选中文本，splitText 切出独立节点后
    //   紧后插（kiss 式以原文为锚）；定位失败保持 inserted=false 落 F 兜底。
    if (!inserted && !isMultiWord && wordNode && wordNode.nodeValue) {
      const txt = wordNode.nodeValue;
      let idx = range.startContainer === wordNode
        ? txt.indexOf(trimmed, Math.min(range.startOffset, txt.length)) : -1;
      if (idx < 0) idx = txt.indexOf(trimmed);
      if (idx >= 0) {
        pathTag = 'B-文本切分紧后';
        wordNode.splitText(idx + trimmed.length);
        const mid = idx > 0 ? wordNode.splitText(idx) : wordNode;
        mid.parentNode.insertBefore(node, mid.nextSibling);
        inserted = true;
      }
    }
    // C：多词/整段→自起点向上找最近块级元素（TH_BLOCK_TAGS，与 scan.js BLOCK_TAGS
    //   同口径），插到块级之后＝新行；到 body 仍未命中块级则不动（不插 body 层级）。
    if (!inserted && isMultiWord) {
      let blk = scEl;
      while (blk && blk !== document.body && blk !== document.documentElement
        && !TH_BLOCK_TAGS.has(blk.tagName)) {
        blk = blk.parentElement;
      }
      if (blk && blk !== document.body
        && blk !== document.documentElement && TH_BLOCK_TAGS.has(blk.tagName)) {
        pathTag = 'C-块内末尾新行';
        // 321次（用户"没从下一行开始而是从右边格子开始……不应当是原文行末尾加入换行和新文本吗"）：
        //   旧版插到块级之后（insertBefore(node, blk.nextSibling)）——表格/网格布局下
        //   "块级之后"是同级并排块（td 旁的下一个 td），译文跑进右边格子。改为原文块内
        //   末尾追加 <br>＋译文：译文永远在原文文本流末尾换行，与外层布局无关。
        if (!(blk.lastElementChild && blk.lastElementChild.tagName === 'BR')) {
          blk.appendChild(document.createElement('br'));
        }
        blk.appendChild(node);
        inserted = true;
      }
    }
    // F：兜底＝317次序列原样：折叠到选区末尾；折叠点落在标注 span 内部时外移到
    //   标注之后，避免释义插进标注继承生词样式（"字体变粗"根因）。
    if (!inserted) {
      range.collapse(false);
      let anchor = range.startContainer;
      if (anchor.nodeType === 3) anchor = anchor.parentElement;
      const ann = anchor && anchor.closest ? anchor.closest('.beaver-word, .beaver-side-ann') : null;
      if (ann && ann.parentNode) range.setStartAfter(ann);
      range.insertNode(node);
    }
    console.log(`[VocabRadar][text-hint] show in page：已插入（${isMultiWord ? '整段新行' : '单词续接'}，锚点${pathTag}）→ ${text.slice(0, 40)}`);
    // 309次第四轮：成功不显示反馈行（用户裁定），失败反馈保留。
    // 315次（用户"撤销任何禁止插入"）：309 次第五轮"成功后禁用本卡按钮"撤销——
    //   按钮永远可点，允许重复插入（插几次、插到哪里由用户决定，不做任何阻断）。
  } catch (e) {
    console.error('[VocabRadar][text-hint] show in page 插入失败:', e);
    showInsertFeedback(q, false, `${t('th.insertFail')}${e && e.message ? `：${e.message}` : ''}`);
  }
}

/**
 * 309次：show in page 插入结果反馈行（卡片内可见，替代旧版"静默 + console"）。
 * 插入在 footer 上方，成功绿/失败红，5 秒后自动移除；重复点击复用同一行。
 * 309次第二轮：tooltip 语境也复用（export）——悬浮提示与右键面板共用卡片结构，
 *   两边的 show-page 都需要把插入结果显示给用户。
 * @param {(sel: string) => Element|null} q 卡片内选择器
 * @param {boolean} ok 是否成功
 * @param {string} msg 文案（已翻译）
 */
export function showInsertFeedback(q, ok, msg) {
  const footer = q('.footer');
  if (!footer || !footer.parentElement) return;
  const card = footer.parentElement;
  let tip = card.querySelector('.insert-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'insert-tip';
    card.insertBefore(tip, footer);
  }
  tip.style.cssText = 'font-size:12px;line-height:1.5;margin-top:2px;padding:2px 0;'
    + (ok ? 'color:#2e6b43;' : 'color:#b3261e;');
  tip.textContent = msg;
  clearTimeout(tip._beaverTimer);
  tip._beaverTimer = setTimeout(() => { tip.remove(); }, 5000);
}

// 反思（2026-07-07）：用户要求"右键查询弹出框应当在当前位置"。
// 旧版 left = clientX - rect.width/2（水平居中于点击点），不符合"在当前位置"的预期。
// 修正：面板左上角放在右键点击位置（如系统右键菜单），右侧/下方溢出时翻转到左侧/上方。
// panel 已改为 position:fixed，clientX/clientY 是视口坐标，无需加 scrollX/scrollY。
// 反思（2026-08-06 修正）：用户反馈"右键查询，边上窗口显示不全"，并要求
//   "页面底部向上展示，页面顶部向下展示"。
//   根因：1) 面板无 max-height，释义多时高度超过视口底部被裁切；
//         2) 异步内容（释义/标签）加载后面板变高，未重新定位 → 底部溢出。
//   修正：比较点击点上下可用空间，空间大的一侧作为展开方向（顶部→向下，底部→向上）；
//         动态 max-height 限制面板高度，内容区滚动；两遍法定位（设 max-height → 重排
//         → 测实际高度 → 锚定点击点）。异步内容加载后需再次调用本函数重定位。
export function positionPanel(clientX, clientY) {
  if (!thState.panel) return;
  const MARGIN = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = (typeof clientX === 'number') ? clientX : MARGIN;
  let top = (typeof clientY === 'number') ? clientY : MARGIN;

  // 水平：测宽度后右侧溢出翻转到左侧 + 兜底
  let rect = thState.panel.getBoundingClientRect();
  if (left + rect.width > vw - MARGIN) left = left - rect.width;
  left = Math.max(MARGIN, Math.min(left, vw - rect.width - MARGIN));

  // 垂直方向：比较点击点上下可用空间，空间大的一侧展开
  //   下方空间大（点击在上半部）→ 向下展开，顶部锚定点击点
  //   上方空间大（点击在下半部）→ 向上展开，底部锚定点击点
  const spaceBelow = vh - top - MARGIN;
  const spaceAbove = top - MARGIN;
  const downward = spaceBelow >= spaceAbove;
  const maxH = Math.max(120, downward ? spaceBelow : spaceAbove);

  // 第一遍：设 max-height 触发重排，临时定位避免闪烁
  thState.panel.style.setProperty('--panel-max-h', maxH + 'px');
  thState.panel.style.left = left + 'px';
  thState.panel.style.top = (downward ? top : Math.max(MARGIN, top - maxH)) + 'px';

  // 第二遍：重测受 max-height 约束后的实际高度，锚定到点击点
  rect = thState.panel.getBoundingClientRect();
  if (downward) {
    // 向下：顶锚定点击点，底部不超出视口
    top = Math.min(top, vh - rect.height - MARGIN);
    if (top < MARGIN) top = MARGIN;
  } else {
    // 向上：底锚定点击点
    top = top - rect.height;
    if (top < MARGIN) top = MARGIN;
  }
  thState.panel.style.top = top + 'px';
}

/**
 * 查询单词（右键面板用），返回完整信息（不受词频阈值限制）
 *
 * 反思（2026-08-12 第四十二次）：右键查词面板不再阻塞等待翻译。
 * 此函数不阻塞翻译：返回时 rank/tags/lemma/phonetic 已就绪，
 *   translation 可能是缓存的（pending=false）或待查询的（pending=true）。
 *   调用方根据 pending 决定是否显示"查询中…"并异步获取翻译。
 *
 * @param {string} lower 小写单词
 * @param {string} original 原始大小写
 * @returns {Promise<{isWord,rank,tags,lemma,translations,pending,phonetic}>}
 */
export async function queryWordForPanel(lower, original) {
  // 从统一词典 IDB 读取完整记录（rank/lemma/tags/translation/phonetic）
  const full = await lookupFull(lower);
  const rank = full ? full.rank : null;
  const tags = full ? (full.tags || []) : [];
  const lemma = full ? full.lemma : null;
  const phonetic = full ? full.phonetic : null;

  // 检查 IDB 中是否已有有效翻译（语言匹配）
  if (full && full.translation && full.translationLang === thState.meaningLang) {
    // 翻译缓存命中，直接返回
    console.log(`[VocabRadar][text-hint] 右键查词 "${lower}": IDB缓存命中 (rank=${rank}, tags=[${tags.join(',')}], lemma=${lemma || '无'}, phonetic=${phonetic ? '已缓存' : '无'}, translation="${full.translation}")`);
    return { isWord: true, rank, tags, lemma, translations: [full.translation], pending: false, phonetic };
  }

  // 翻译未缓存或语言不匹配，标记 pending
  const known = [];
  if (rank !== null) known.push(`rank=${rank}`);
  if (tags.length > 0) known.push(`tags=[${tags.join(',')}]`);
  if (lemma) known.push(`lemma=${lemma}`);
  if (phonetic) known.push(`phonetic=已缓存`);
  console.log(`[VocabRadar][text-hint] 右键查词 "${lower}": 已知=[${known.join(', ') || '无'}], 待查翻译(${thState.meaningLang})`);
  return { isWord: true, rank, tags, lemma, translations: [], pending: true, phonetic };
}

// === 面板 HTML 构建 ===
// 反思（2026-08-13 第四十九次）：header 显示品牌 + 词阶（右上角，靠右不挤生词）。
//   正文重复的 .stage 用 CSS .word-row .stage { display:none } 隐藏（词阶只显示一次）。
// 反思（2026-08-13 第四十九次）：用户要求"翻译结果若在查询中，则应当是浮动省略号"。
//   修正：新增 .dots 三点跳动动画，pending 时插入 trans-row，翻译完成移除。
/**
 * 查询卡片样式（272 次自 buildPanelHTML 抽出为独立导出）：
 * 右键浮动面板与文本侧栏 query 标签的内嵌卡片共用同一份 CSS（唯一定义处）。
 * @returns {string} CSS 文本（不含 <style> 标签）
 */
export function buildPanelCss() {
  return `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .panel-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 14px; background: #f5f8f3; border-radius: 16px 16px 0 0; }
      .panel-header .title { font-size: inherit; color: #1a1f1a; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
      /* 第一百七十六次：品牌小图标（内联 SVG，替代无字形的 🦫）。本面板是 Shadow DOM，
         顶行样式表（sidebar-topbar.js）不会穿透进来，故此处须自带一份尺寸规则。 */
      .panel-header .title .beaver-brand-icon { width: 16px; height: 16px; flex: 0 0 auto; display: block; color: inherit; }
      .panel-header .title > span { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
      .panel-header .header-stage { display: inline-block; padding: 2px 8px; background: #2e6b43; color: #ffffff; border-radius: 8px; font-size: 12px; white-space: nowrap; flex-shrink: 0; }
      .panel-content { padding: 12px 14px; max-height: var(--panel-max-h, 80vh); overflow-y: auto; }
      .word-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
      .word { font-size: 16px; color: #1a1f1a; font-weight: 600; }
      /* 反思（2026-08-13 第四十九次）：词阶只在 header 右侧显示一次（不挤生词），正文重复的 .stage 隐藏 */
      .word-row .stage { display: none; }
      .stage { display: inline-block; padding: 2px 8px; background: #2e6b43; color: #ffffff; border-radius: 8px; font-size: 12px; white-space: nowrap; }
      .phonetic-row { font-size: 13px; color: #424942; margin-bottom: 6px;
        /* 反思（2026-09-04）：用户反馈"注音用的啥字体，咋看不懂"。注音 span 此前未指定
           字体，Shadow DOM 内继承宿主页面字体，缺 IPA 扩展区字形即显示豆腐块。
           修正：统一指定系统字体栈（扩展装不到字体文件，只能用系统栈；Segoe UI 是
           Win10 默认且 IPA/变音符号覆盖最好，其余为回退）。无结果时隐藏整行
           （"注音有结果才显示"；加载中占位符 … 非空故仍显示）。 */
        font-family: "Segoe UI", "Microsoft YaHei", "Noto Sans", "Charis SIL", "Doulos SIL", "Arial Unicode MS", Arial, sans-serif; }
      .phonetic-row:empty { display: none; }
      .lemma-row { font-size: 12px; color: #424942; margin-bottom: 8px; }
      .lemma-row b { color: #1a1f1a; font-weight: 500; }
      .lemma-row:empty { display: none; }
      /* 原形 chip（2026-09-04）：斜体＋底色按钮即开关，无"原形："前缀无 ▶/▼ 后缀；
         展开态 .open 换深底色；title 保留文字说明。 */
      .lemma-chip { font-style: italic; background: #e4efe6; color: #2e6b43; border: 0; border-radius: 8px; padding: 1px 10px; cursor: pointer; font-size: inherit; line-height: 1.6; }
      .lemma-chip:hover { filter: brightness(0.96); }
      .lemma-chip.open { background: #2e6b43; color: #ffffff; }
      .lemma-group { margin: 0 0 8px 0; padding: 2px 10px; border-radius: 8px; background: #e4efe6; color: #2e6b43; font-size: 13px; font-style: normal; line-height: 1.7; word-break: break-word; }
      .lemma-group:empty { display: none; }
      .lemma-more { color: #8a918a; }
      .section { margin-bottom: 10px; }
      .section-label { font-size: 12px; color: #424942; margin-bottom: 4px; }
      .trans-row { color: #1a1f1a; line-height: 1.7;
        /* 314次（用户"文本侧栏的字号正常，查询窗口可以参考"）：trans-row 原先未指定
           字号，Shadow DOM 内继承宿主页面字号（网页正文字号多大释义就多大）；
           对齐文本侧栏 sidebar.css 正文 16px 写死方案，查询卡不再随网页缩放。 */
        font-size: 16px; }
      .trans-row div { margin-bottom: 6px; }
      .tags-row { display: flex; flex-wrap: wrap; gap: 4px; }
      /* 308次（用户"词表标签用浅色底，就跟侧栏中那样"）：对齐侧栏 beaver-w-tags/beaver-ann-tags
         的浅色底（sidebar.css --beaver-secondary-container #d1e8d8 / on #0d2014），
         深绿底白字退役 */
      /* 309次（用户"词表标签……现在直接消失了"）：静态排查产物 CSS 规则完整、渲染链路
         未改，无法复现；加 1px 深绿描边增强 chip 与浅底的对比（防"浅底淹没在卡片底色里"
         的视觉消失），并在渲染处补 console 诊断日志（见 renderQueryCard tags 段） */
      .tag { display: inline-block; padding: 3px 10px; background: #d1e8d8; color: #0d2014; border: 1px solid rgba(13,32,20,.22); border-radius: 8px; font-size: 12px; }
      .footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid #e9eee7; margin-top: 6px; }
      .speak { padding: 8px 16px; background: #2e6b43; color: #fff; border: 0; border-radius: 8px; cursor: pointer; font-size: inherit; white-space: nowrap; }
      .speak:hover { filter: brightness(1.1); }
      /* 第一百七十一次：footer 右侧新增 chat 按钮（与朗读按钮同视觉，footer 为 space-between 故左右分列） */
      .chat { padding: 8px 16px; background: #2e6b43; color: #fff; border: 0; border-radius: 8px; cursor: pointer; font-size: inherit; white-space: nowrap; }
      .chat:hover { filter: brightness(1.1); }
      /* 308次（用户"底部中间增加按钮 show in page，将释义插入页面"）：footer 三按钮
         space-between 自动左中右分布；仅右键浮动面板显示（内嵌卡片隐藏，见 renderQueryCard） */
      .show-page { padding: 8px 16px; background: #2e6b43; color: #fff; border: 0; border-radius: 8px; cursor: pointer; font-size: inherit; white-space: nowrap; }
      .show-page:hover { filter: brightness(1.1); }
      .dots { display: inline-flex; gap: 4px; align-items: center; padding: 4px 0; }
      .dots i { width: 5px; height: 5px; border-radius: 50%; background: #424942; opacity: 0.25; animation: beaver-dots 1.2s infinite ease-in-out; }
      .dots i:nth-child(2) { animation-delay: 0.2s; }
      .dots i:nth-child(3) { animation-delay: 0.4s; }
      @keyframes beaver-dots { 0%, 60%, 100% { opacity: 0.25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }
    `;
}

export function buildPanelHTML() {
  return `
    <style>${buildPanelCss()}</style>
    <div class="panel-header">
      <div class="title">${brandIconSVG()}<span>${t('th.brand')}</span></div>
      <div class="header-stage"></div>
    </div>
    <div class="panel-content">
      ${buildCardInnerHTML()}
    </div>
  `;
}
// 公共内容结构（面板和悬浮提示共用）
export function buildCardInnerHTML() {
  return `
    <div class="word-row">
      <span class="word"></span>
      <span class="stage"></span>
    </div>
    <div class="phonetic-row"></div>
    <div class="lemma-row"></div>
    <div class="lemma-group" style="display:none"></div>
    <div class="section">
      <div class="section-label">${t('th.definition')}</div>
      <div class="trans-row"></div>
    </div>
    <div class="section tags-section">
      <div class="section-label">${t('th.tags')}</div>
      <div class="tags-row"></div>
    </div>
    <div class="footer">
      <button class="speak">🔊</button>
      <!-- 308次：footer 中部 show in page（默认渲染，非浮动面板语境由 renderQueryCard 隐藏）
           309次（用户"按钮应当是便签图标🗒️。图标不需要翻译"）：改 emoji 图标，语义进 title -->
      <button class="show-page" title="${t('btn.showInPage')}">🗒️</button>
      <button class="chat" title="${t('btn.chat')}">💬</button>
    </div>
  `;
}

export function ensurePanel() {
  if (thState.panel) return;
  thState.panel = document.createElement('div');
  thState.panel.id = PANEL_ID;
  thState.panel.style.cssText = `
    position: fixed !important;
    z-index: 2147483647 !important;
    background: #fbfdf9 !important;
    color: #1a1f1a !important;
    border-radius: 16px !important;
    box-shadow: 0 4px 12px rgba(26,31,26,.12), 0 1px 3px rgba(26,31,26,.08) !important;
    padding: 0 !important;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif !important;
    /* 309次第四轮（用户"查询窗口字号咋定的，比之前和其他地方的正文大了很多"）：
       旧 font-size:inherit——面板挂在 documentElement 下，继承浏览器默认 16px，
       卡内 .word 1.15em≈18.4px，比侧栏正文 14px 大一截。定死 14px 与侧栏正文同基准。
       310次（用户"查询窗固定字号"）：删 syncBodyFontSize 覆盖路径 + buildPanelCss
       内 em 全换 px，查询窗任何站点恒 14px 基准（.word 16px） */
    font-size: 14px !important;
    line-height: 1.5 !important;
    min-width: 280px !important;
    max-width: 400px !important;
    display: none !important;
  `;
  const shadow = thState.panel.attachShadow({ mode: 'open' });
  shadow.innerHTML = buildPanelHTML();
  // 反思（2026-09-04）：卡片原形 chip 点击委托（shadow 内，绑一次；只处理 .lemma-chip，其余放行）
  bindLemmaChipClick(shadow);
  document.documentElement.appendChild(thState.panel);
  // 反思（2026-07-07）：用户反馈"右键的查询菜单无法消失，应当点击别处自动消失"。
  // 旧版只有 e.target === thState.panel（几乎不触发，因 thState.panel 内有 shadow DOM 子元素）
  // 和 Escape 键关闭。新增 document mousedown 监听器（capture 阶段），
  // 点击面板外部时自动关闭。用 composedPath 处理 shadow DOM boundary。
  // 反思（2026-08-05 修正）：用户反馈"右键查询，点击播放之后浮窗消失了"。
  //   根因：旧版 thState.panel.addEventListener('click', (e) => { if (e.target === thState.panel) hidePanel(); })
  //   当点击 shadow DOM 内的 🔊 speak 按钮时，click 事件冒泡到 thState.panel 时 e.target 被
  //   重定向到 shadow host（即 thState.panel 本身），导致 e.target === thState.panel 为 true，
  //   错误调用 hidePanel() 关闭面板。
  //   修正：移除该监听器。点击外部关闭已由 document mousedown capture 监听器处理
  //   （使用 composedPath 正确识别 shadow DOM 内部点击），不需要重复监听。
  // 反思（2026-07-07 → 2026-07-26 修正）：
  //   旧版把 _panelHideDelay（hover tooltip 的 mouseleave 延迟）错误复用到 panel 点击外部，
  //   导致点击外部延迟5秒才关闭，用户感觉"点击别处不消失"。
  //   用户明确："右键的查询菜单应当点击别处自动消失"——立即关闭。
  //   _panelHideDelay 仅用于 hover tooltip 的 mouseleave（onWordLeave），不再用于 panel。
  // 反思（2026-07-26 二次修正）：用户反馈"依旧点别处不消失"。
  //   根因：上版只给 panel 加了点击外部关闭，但 hover tooltip（飘窗）没有该逻辑——
  //   点击别处只靠 mouseleave 5秒延迟，用户感觉"不消失"。
  //   优先级：点击外部=主动操作，立即隐藏；mouseleave=默认操作，5秒延迟。
  //   点击生词 span 不隐藏 tooltip（让 onWordHover/onWordClick 处理，避免点击朗读时 tooltip 闪掉）。
  document.addEventListener('mousedown', (e) => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    // 第一百七十一次：点击 Chat 面板（独立 fixed 浮层，不在 panel/tooltip 的 DOM 内）
    //   不应关闭右键面板与悬浮提示，否则用户在对话框里打字会把来源卡片关掉。
    const onChat = path.some((el) => el && el.id === CHAT_PANEL_ID);
    if (onChat) return;
    // hover tooltip：点击 tooltip 内部或生词 span 不隐藏；其他点击立即隐藏
    if (thState.tooltip && thState.tooltip.style.display !== 'none') {
      const onTooltip = path.indexOf(thState.tooltip) !== -1;
      const onWord = path.some((el) => el && el.classList && el.classList.contains(HIGHLIGHT_CLASS));
      if (!onTooltip && !onWord) hideTooltip();
    }
    // 右键面板：点击 panel 内部不隐藏；其他点击立即隐藏
    if (thState.panel && thState.panel.style.display !== 'none') {
      if (path.indexOf(thState.panel) === -1) hidePanel();
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && thState.panel.style.display !== 'none') hidePanel();
  });
}

export function hidePanel() {
  if (thState.panel) thState.panel.style.display = 'none';
}

// === OCR 结果面板（2026-08-05）===
// 右键图片/视频 OCR 识别结果展示，light DOM（非 Shadow），文本节点可被 TreeWalker 扫描注释生词
// 不自动消失（onScrollHide 不隐藏 thState.ocrPanel），仅关闭按钮/Escape/点击外部关闭
// 反思：用户要求"识别结果受文本提示，不自动消失"——OCR 文本经过生词高亮+侧邻注释

/**
 * 创建 OCR 结果面板（light DOM）
 * 结构：header(标题+关闭按钮) + content(.beaver-ocr-text 文本节点)
 * 文本节点会被 processTextNode 注释生词（手动调 scanSubtree）
 */
export function ensureOcrPanel() {
  if (thState.ocrPanel) return;
  thState.ocrPanel = document.createElement('div');
  thState.ocrPanel.id = OCR_PANEL_ID;
  thState.ocrPanel.style.cssText = `
    position: fixed !important;
    z-index: 2147483647 !important;
    background: #fbfdf9 !important;
    color: #1a1f1a !important;
    border-radius: 16px !important;
    box-shadow: 0 4px 12px rgba(26,31,26,.12), 0 1px 3px rgba(26,31,26,.08) !important;
    padding: 0 !important;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif !important;
    font-size: 14px !important;
    line-height: 1.6 !important;
    min-width: 300px !important;
    max-width: 480px !important;
    display: none !important;
    overflow: hidden !important;
    flex-direction: column !important;
  `;
  thState.ocrPanel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#f5f8f3;border-radius:16px 16px 0 0;flex-shrink:0;">
      <span style="font-size:13px;color:#424942;display:inline-flex;align-items:center;gap:6px;">${brandIconSVG()}<span>VocabRadar · OCR 识别结果</span></span>
      <button class="beaver-ocr-close" style="background:none;border:0;cursor:pointer;font-size:18px;color:#424942;padding:0 4px;">✕</button>
    </div>
    <div class="beaver-ocr-text" style="padding:12px 14px;overflow-y:auto;flex:1 1 auto;white-space:pre-wrap;word-break:break-word;"></div>
  `;
  document.documentElement.appendChild(thState.ocrPanel);
  // 关闭按钮
  thState.ocrPanel.querySelector('.beaver-ocr-close').addEventListener('click', () => hideOcrPanel());
  // 点击外部关闭（mousedown capture 阶段，与 thState.panel 一致）
  document.addEventListener('mousedown', (e) => {
    if (thState.ocrPanel && thState.ocrPanel.style.display !== 'none') {
      const path = e.composedPath ? e.composedPath() : [e.target];
      if (path.indexOf(thState.ocrPanel) === -1) hideOcrPanel();
    }
  }, true);
  // Escape 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && thState.ocrPanel && thState.ocrPanel.style.display !== 'none') hideOcrPanel();
  });
}

export function hideOcrPanel() {
  if (thState.ocrPanel) thState.ocrPanel.style.display = 'none';
}

/**
 * 显示 OCR 结果面板
 * @param {string} text OCR 识别文本
 * @param {number} clientX 右键点击 X（视口坐标）
 * @param {number} clientY 右键点击 Y
 * @param {string} info 提示信息（如"未识别到文字"，text 为空时显示）
 * 反思（2026-08-05）：识别文本放入 .beaver-ocr-text 文本节点，手动调 scanSubtree
 *   注释生词（侧邻注释+高亮）。不自动消失，关闭按钮/Escape/点击外部关闭。
 */
export function showOcrResultPanel(text, clientX, clientY, info = '') {
  // 2026-09-09 第二百四十二次：手势入口 prime 内置翻译（同 showContextPanel 注释）。
  //   OCR 面板由侧栏按钮点击触发，按钮在手势上下文中，距点击仍在 activation 窗口内。
  //   第二百四十三次：改显式 force=true（同 showContextPanel）。
  primeTranslator({ force: true });
  ensureOcrPanel();
  const textEl = thState.ocrPanel.querySelector('.beaver-ocr-text');
  // 清空旧内容（含已注释的 .beaver-word span）
  textEl.innerHTML = '';
  if (!text || !text.trim()) {
    textEl.textContent = info || '未识别到文字';
    textEl.style.color = '#72797a';
    textEl.style.fontStyle = 'italic';
  } else {
    textEl.textContent = text.trim();
    textEl.style.color = '';
    textEl.style.fontStyle = '';
    // 手动调 scanSubtree 注释生词（侧邻注释+高亮）
    // 反思：scanSubtree 跳过 #beaver-ocr-panel（防递归），但这里直接对 textEl 调用
    //   processTextNode 注释其文本节点。若文本提示未启用（thState.enabled=false）则不注释。
    if (thState.enabled) {
      // 标记 textEl 未处理，让 TreeWalker 接受
      textEl.removeAttribute(PROCESSED_ATTR);
      // 遍历 textEl 的文本节点并注释
      const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      // processTextNode 是 async，串行处理
      (async () => {
        for (const tn of nodes) {
          if (!thState.enabled) break;
          if (!tn.isConnected) continue;
          await processTextNode(tn);
        }
        // 反思（2026-08-06）：注释生词后面板高度变化，重新定位避免溢出
        if (clientX !== null && clientX !== undefined) {
          positionOcrPanel(clientX, clientY);
        }
      })();
    }
  }
  thState.ocrPanel.style.display = 'flex';
  positionOcrPanel(clientX, clientY);
}

// 反思（2026-08-06 修正）：与 positionPanel 同步采用方向定位 + 动态 max-height。
//   OCR 文本经 scanSubtree 异步注释生词后面板高度变化，需重新定位。
//   比较点击点上下空间：上方大→向上展开（底锚定），下方大→向下展开（顶锚定）。
export function positionOcrPanel(clientX, clientY) {
  if (!thState.ocrPanel) return;
  const MARGIN = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = (typeof clientX === 'number') ? clientX : MARGIN;
  let top = (typeof clientY === 'number') ? clientY : MARGIN;

  // 水平：测宽度后右侧溢出翻转到左侧 + 兜底
  let rect = thState.ocrPanel.getBoundingClientRect();
  if (left + rect.width > vw - MARGIN) left = left - rect.width;
  left = Math.max(MARGIN, Math.min(left, vw - rect.width - MARGIN));

  // 垂直方向：比较上下空间，空间大的一侧展开
  const spaceBelow = vh - top - MARGIN;
  const spaceAbove = top - MARGIN;
  const downward = spaceBelow >= spaceAbove;
  const maxH = Math.max(120, downward ? spaceBelow : spaceAbove);

  // 第一遍：设 max-height 触发重排，临时定位避免闪烁
  thState.ocrPanel.style.maxHeight = maxH + 'px';
  thState.ocrPanel.style.left = left + 'px';
  thState.ocrPanel.style.top = (downward ? top : Math.max(MARGIN, top - maxH)) + 'px';

  // 第二遍：重测受 max-height 约束后的实际高度，锚定到点击点
  rect = thState.ocrPanel.getBoundingClientRect();
  if (downward) {
    top = Math.min(top, vh - rect.height - MARGIN);
    if (top < MARGIN) top = MARGIN;
  } else {
    top = top - rect.height;
    if (top < MARGIN) top = MARGIN;
  }
  thState.ocrPanel.style.top = top + 'px';
}

/**
 * 右键视频 OCR：截取右键位置 video 当前帧 → OCR → 显示结果面板
 * @param {number} clientX 右键点击 X（用于定位 video 和面板）
 * @param {number} clientY 右键点击 Y
 * 反思（2026-08-05）：用 elementFromPoint 找右键位置的 video 元素，
 *   找不到回退 document.querySelector('video')。截帧后走 OCR_RECOGNIZE 流程。
 */
export async function ocrVideoFrame(clientX, clientY) {
  // 找右键位置的 video 元素
  let video = null;
  if (typeof clientX === 'number' && typeof clientY === 'number') {
    const el = document.elementFromPoint(clientX, clientY);
    if (el && el.tagName === 'VIDEO') video = el;
  }
  // 回退：页面中最大的可见 video
  if (!video) {
    const videos = Array.from(document.querySelectorAll('video'));
    video = videos.find((v) => v.videoWidth > 0 && v.videoHeight > 0);
  }
  if (!video) {
    showOcrResultPanel('', clientX, clientY, '未找到视频元素，无法 OCR');
    return;
  }
  // 显示加载提示
  showOcrResultPanel('', clientX, clientY, '正在识别视频帧...');
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    // 反思（2026-08-16 第六十六次）：OCR 语言随 learnLanguage（zh→chi_sim，其余→eng）
    const ocrLang = await new Promise((resolve) => {
      chrome.storage.local.get({ learnLanguage: 'en' }, (res) => resolve(res.learnLanguage || 'en'));
    });
    const resp = await chrome.runtime.sendMessage({
      type: 'OCR_RECOGNIZE',
      imageDataUrl: dataUrl,
      lang: ocrLang
    });
    if (!resp || !resp.ok) {
      const errMsg = resp && resp.error ? resp.error : '未知错误';
      showOcrResultPanel('', clientX, clientY, 'OCR 失败: ' + errMsg);
      return;
    }
    const result = resp.text || '';
    showOcrResultPanel(result, clientX, clientY, result.trim() ? '' : '未识别到文字');
  } catch (e) {
    const errMsg = String(e && e.message ? e.message : e);
    showOcrResultPanel('', clientX, clientY, 'OCR 失败: ' + errMsg);
  }
}
