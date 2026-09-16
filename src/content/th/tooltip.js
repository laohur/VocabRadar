// 文本提示 · 悬浮卡片模块（hover/click 生词的悬浮提示）
//
// === 拆分说明（2026-08-28）===
// 来源：src/content/text-hint-impl.js（2390 行）机械拆分，逻辑与行为零改动。
// 本文件职责：
//   1. 悬浮提示宿主创建（#beaver-hint-tooltip，Shadow DOM，复用面板卡片结构）
//   2. 悬浮提示显示/隐藏/避让定位（生词矩形四周 12px 缓冲，右→左、下→上翻转）
//   3. 指针区域判定（生词 ∪ 悬浮窗，外扩 24px；移出即立即隐藏，无停留时间）
//   4. 生词交互事件处理器：onWordHover / onWordLeave / onWordClick
//   5. 滚动隐藏 onScrollHide（同时隐藏悬浮提示与右键面板）
//
// 共享状态一律取自 core.js 的 thState（唯一属主），本文件不再声明任何同名变量。
// 模块级副作用：ensureTooltip 内的 window pointermove 监听，
//   由 window.__beaverTooltipMoveBound 守卫保证只注册一次，与拆分前完全一致。
//
// 跨模块调用（受控循环 import，两端均为函数声明，顶层不调用）：
//   → panel.js: buildPanelHTML（卡片结构）、hidePanel（滚动同隐）、queryWordForPanel（统一词典译文）
//   → scan.js: validateSpan / unwrapSingle（失效 span 清理）、backfillSideAnnotation（同步侧邻注释）
// 第二百四十三次：补 primeTranslator——onWordHover 是 hover/点击高亮词两条翻译链的汇聚点。
import { translate, primeTranslator } from '../../lib/translator.js';
import { t } from '../../lib/i18n.js';
import { isBalancedParens, pickCleanShortTrans, splitTransLines } from '../../lib/dict-clean.js';
import { getPhonetic } from '../../lib/phonetics.js';
import {
  thState, TOOLTIP_ID, formatStage, isContextValid, speak
} from './core.js';
import { buildPanelHTML, hidePanel, queryWordForPanel, renderLemmaInto, bindLemmaChipClick, showInsertFeedback } from './panel.js';
import { validateSpan, unwrapSingle, backfillSideAnnotation } from './scan.js';
// 第一百七十一次：悬浮提示卡片底部 chat 按钮（结构复用 buildPanelHTML，故此处也需绑定）
import { openChatPanel } from '../../lib/chat.js';
// 第一百八十六次：对话上下文的网页正文来源（Readability 优先），唯一实现在 lib/main-text.js
import { getAiMainText } from '../../lib/main-text.js';

// 反思（2026-08-12 第四十三次）：统一面板和悬浮提示的 HTML/CSS 结构。
//   buildCardHTML 是两者共用的内容模板，buildPanelHTML 仅多一层 header 包裹。
//   CSS 值统一，不再有字号/间距差异。
// 反思（2026-08-13 第四十九次）：用户要求"文本悬浮提示跟右键查询的窗口和内容应当一样"。
//   旧版 tooltip 用本函数（无 header 的小卡片），面板用 buildPanelHTML（有 header），
//   两者窗口/内容不一致。修正：本函数直接复用 buildPanelHTML()，使悬浮提示与右键面板
//   结构、样式、内容完全一致。
export function buildCardHTML() {
  return buildPanelHTML();
}

export function ensureTooltip() {
  if (thState.tooltip) return;
  thState.tooltip = document.createElement('div');
  thState.tooltip.id = TOOLTIP_ID;
  // 反思（2026-08-13 第四十九次）：用户要求"文本悬浮提示跟右键查询的窗口和内容应当一样"。
  //   旧版 tooltip 宿主自带背景/圆角/padding/max-width:320px，与右键面板（ensurePanel：
  //   min-width:280px;max-width:400px;width:max-content，无宿主背景）外观不一致。
  //   修正：tooltip 宿主样式与 ensurePanel 对齐，窗口外观完全交给 buildPanelHTML 内部样式。
  thState.tooltip.style.cssText = `
    position: fixed !important;
    z-index: 2147483647 !important;
    background: #fbfdf9 !important;
    color: #1a1f1a !important;
    border-radius: 16px !important;
    box-shadow: 0 4px 12px rgba(26,31,26,.12), 0 1px 3px rgba(26,31,26,.08) !important;
    min-width: 280px !important;
    max-width: 400px !important;
    padding: 0 !important;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif !important;
    /* 309次第四轮：同 panel.js——hover 飘窗也挂 documentElement，inherit=16px 偏大，
       定死 14px 与侧栏正文/右键面板同基准 */
    font-size: 14px !important;
    line-height: 1.5 !important;
    display: none !important;
    pointer-events: auto !important;
  `;
  const shadow = thState.tooltip.attachShadow({ mode: 'open' });
  shadow.innerHTML = buildCardHTML();
  // 反思（2026-09-04）：卡片原形 chip 点击委托（与右键面板共用 bindLemmaChipClick）
  bindLemmaChipClick(shadow);
  document.documentElement.appendChild(thState.tooltip);

  // 反思（2026-08-18 第七十五次修正）：用户要求"漂浮提示无停留时间，
  //   鼠标挪走一些距离就消失"。旧版用 thState.hideTimer + thState.panelHideDelay（默认 5s）
  //   延迟隐藏，鼠标一离开生词还要等 5 秒才消失，且 tooltip 悬停取消延迟。
  //   修正：改为全局 pointermove 跟踪——鼠标离开生词与悬浮窗联合区域
  //   （外扩 24px 缓冲）即立即隐藏，无任何停留计时；鼠标移入悬浮窗仍不消失
  //   （联合区域包含 tooltip 自身矩形）。
  if (!window.__beaverTooltipMoveBound) {
    window.__beaverTooltipMoveBound = true;
    window.addEventListener('pointermove', (e) => {
      thState.lastPointerX = e.clientX;
      thState.lastPointerY = e.clientY;
      if (thState.tooltip && thState.tooltip.style.display !== 'none' && pointerOutOfTooltipZone()) {
        hideTooltip();
      }
    }, { passive: true });
  }
}

export function showTooltip(data, anchorRect, opts) {
  ensureTooltip();
  // 310次（用户"查询窗固定字号"）：删 syncBodyFontSize——同 panel.js，body 字号同步
  //   会覆盖 ensureTooltip 的 14px !important，查询窗字号恒为 14px 基准。
  const shadow = thState.tooltip.shadowRoot;
  // 单词（正文显示；header 固定显示品牌，词阶在 header 右侧）
  shadow.querySelector('.word').textContent = data.word;
  thState.tooltipWord = data.word || '';

  // 词阶
  let stage = formatStage(data.rank);
  if (stage.indexOf('NaN') !== -1) {
    console.warn('[VocabRadar][text-hint] stage 含 NaN, data.rank=', data.rank, '→ 替换为', t('th.outside'));
    stage = t('th.outside');
  }
  shadow.querySelector('.stage').textContent = stage;
  shadow.querySelector('.panel-header .header-stage').textContent = stage;

  // 音标：异步加载（phonemize bundle 5.1MB 首次 1-2 秒，后续命中缓存）
  const phoneticEl = shadow.querySelector('.phonetic-row');
  if (data.word && phoneticEl && isContextValid()) {
    phoneticEl.textContent = '…';
    getPhonetic(data.word).then((phon) => {
      if (thState.tooltipWord === data.word && thState.tooltip && thState.tooltip.style.display !== 'none') {
        phoneticEl.textContent = phon || '';
      }
    }).catch(() => {
      if (thState.tooltipWord === data.word) phoneticEl.textContent = '';
    });
  } else if (phoneticEl) {
    phoneticEl.textContent = '';
  }

  // 词形还原原形（2026-09-04：改走面板共用 renderLemmaInto，常显 chip＋小写归一）
  renderLemmaInto(shadow, data.word, data.lemma);

  // 标签
  const tagsEl = shadow.querySelector('.tags-row');
  const tagsSection = shadow.querySelector('.tags-section');
  tagsEl.innerHTML = '';
  const tags = data.tags || [];
  if (tagsSection) tagsSection.style.display = tags.length > 0 ? '' : 'none';
  tags.forEach((tag) => {
    const span = document.createElement('span');
    span.className = 'tag';
    span.textContent = tag;
    tagsEl.appendChild(span);
  });

  // 反思（2026-08-13 第四十九次）：释义显示——有则显示；
  //   翻译查询中（translations 空且 opts.pending=true）显示浮动省略号（动画三点），
  //   翻译完成由调用方重渲染替换；翻译失败调用方以 pending=false 重渲染留空。
  //   全程不显示"查询中…"/"暂无释义"/"No definition"等歧义文案。
  const trans = data.translations || [];
  const pending = !!(opts && opts.pending);
  if (trans.length > 0) {
    // 310次（用户"查询卡片释义没有分拆"）：单条释义内按 | 词性段拆行（与 panel.js 同口径）
    shadow.querySelector('.trans-row').innerHTML = splitTransLines(trans).map(row => `<div>${row}</div>`).join('');
  } else if (pending) {
    shadow.querySelector('.trans-row').innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
  } else {
    shadow.querySelector('.trans-row').textContent = '';
  }
  shadow.querySelector('.speak').onclick = (e) => { e.stopPropagation(); speak(data.word); };
  // 第一百七十一次：悬浮提示与右键面板共用卡片结构，chat 按钮同样生效（就该生词发起对话）
  // 第一百八十四次：传 kind='word' —— 点开的单词属"单词类查询"，用 chatWordPrompt 模板
  // 第一百八十六次（用户："对话框的上下文依旧胡说。老毛病，并不是第一次出现。"）：
  //   上下文框正文只允许来自 Readability 网页正文或字幕；单词只进提问语的 {}。
  const chatBtn = shadow.querySelector('.chat');
  if (chatBtn) chatBtn.onclick = async (e) => {
    e.stopPropagation();
    let ctxBody = '';
    try {
      const m = await getAiMainText();
      ctxBody = String((m && m.text) || '');
    } catch (err) {
      console.warn('[VocabRadar][th-tooltip] 取网页正文失败，上下文退回单词:', err);
    }
    openChatPanel(data.word, 'word', ctxBody || data.word);
  };
  // 309次第二轮（用户"🗒️标签按钮没反应，无日志"根因修复）：悬浮提示与右键面板共用
  //   卡片结构（buildPanelHTML → footer 含 .show-page 🗒️），但本函数此前只绑
  //   .speak/.chat——🗒️ 在 hover 飘窗里可见却从未绑定 onclick（308 次引入的遗漏），
  //   点击无任何反应也无 console 日志（用户实测症状）。现绑定插入：锚点 = 当前
  //   hover 生词 span（thState.tooltipTargetEl，hover/click 入口均已 validateSpan 校验），
  //   释义读本卡 .trans-row，插入结果走 showInsertFeedback 反馈行。
  const showPageBtn = shadow.querySelector('.show-page');
  if (showPageBtn) showPageBtn.onclick = (e) => {
    e.stopPropagation();
    // 309次第三轮：传当次 data.translations（每次 showTooltip 重绑，闭包捕获最新释义数组）
    insertMeaningAfterTarget(data.translations);
  };

  thState.tooltip.style.display = 'block';
  const tRect = thState.tooltip.getBoundingClientRect();
  // 反思（2026-08-18 第七十五次修正）：用户要求"漂浮提示应当绕开原来位置，
  //   不要干扰"。旧版直接锚到生词 rect.bottom 正下方（gap 仅 18px），
  //   生词靠近视口底边时翻转到上方又可能盖住生词本身。
  //   修正：在生词矩形四周留 GAP=12px 缓冲，优先下方、其次上方放置，
  //   确保悬浮窗不与生词矩形重叠（不遮原文、不盖生词），并钳制在视口内。
  const gap = 12;
  const rectLeft = anchorRect.left;
  const rectTop = anchorRect.top;
  const rectBottom = anchorRect.bottom;
  const rectRight = anchorRect.right;
  const wordWidth = anchorRect.right - anchorRect.left;
  const wordHeight = anchorRect.bottom - anchorRect.top;
  // 水平：优先放在生词右侧（不遮原文），空间不足放左侧
  let tx = rectRight + gap;
  if (tx + tRect.width > window.innerWidth - 8) {
    tx = rectLeft - tRect.width - gap;
  }
  tx = Math.min(Math.max(tx, 8), window.innerWidth - tRect.width - 8);
  // 垂直：优先生词下方（不与生词重叠），空间不足放上方
  let ty = rectBottom + gap;
  if (ty + tRect.height > window.innerHeight - 8) {
    ty = rectTop - tRect.height - gap;
    if (ty < 8) ty = 8;
  }
  thState.tooltip.style.left = tx + 'px';
  thState.tooltip.style.top = ty + 'px';
}

/**
 * 309次第二轮：悬浮提示语境的 show in page——把本卡释义插回页面。
 * 与 panel.js insertMeaningIntoPage（右键面板）的差异仅在锚点来源：
 *   右键面板用 showContextPanel 保存的选区 Range；本函数用当前 hover 的
 *   生词 span（thState.tooltipTargetEl，hover/click 入口 validateSpan 校验过），
 *   单词 → 行内 span 续接在生词后（el.after），多词/长文（hover 场景几乎不出现）
 *   → 块级 div 新起一行。插入节点带主题绿字色，与 panel.js 口径一致。
 * 309次第三轮（用户"插入的释义应当是短释义"+"不要Inserted into page提示"）：
 *   插入文本改取 translations 经 pickCleanShortTrans 的首条短义项（与侧邻注释
 *   同口径），回退 .trans-row 首行；成功不再显示反馈行（console 可查），失败保留。
 * @param {string[]} [translations] 当次查询释义数组（showTooltip 闭包捕获）
 */
function insertMeaningAfterTarget(translations) {
  const shadow = (thState.tooltip && thState.tooltip.shadowRoot) || null;
  if (!shadow) return;
  const q = (sel) => shadow.querySelector(sel);
  // 310次（用户裁定）：回滚为短释义首条——pickCleanShortTrans（同 panel.js 口径，
  //   "只插一段翻译的前几个字"即短释义口径，是预期行为非截断 bug）。
  let text = pickCleanShortTrans(translations);
  if (!text) {
    const transRow = q('.trans-row');
    const firstLine = transRow && transRow.firstElementChild ? transRow.firstElementChild.textContent : '';
    text = String(firstLine || (transRow ? transRow.textContent : '') || '').trim();
  }
  if (!text) {
    console.warn('[VocabRadar][th-tooltip] show in page：释义未就绪，跳过插入');
    showInsertFeedback(q, false, t('th.insertNoDef'));
    return;
  }
  const el = thState.tooltipTargetEl;
  if (!el || !el.isConnected) {
    console.warn('[VocabRadar][th-tooltip] show in page：生词锚点已失效，跳过插入');
    showInsertFeedback(q, false, t('th.insertNoAnchor'));
    return;
  }
  try {
    const word = String(el.dataset.word || '');
    const tokens = word.split(/[\s\u3000]+/).filter((s) => /[A-Za-z\u00C0-\u024F]/.test(s));
    const isMultiWord = tokens.length > 1 || word.length > 24;
    const node = document.createElement(isMultiWord ? 'div' : 'span');
    node.className = 'beaver-page-insert';
    // 318次：插入翻译沿用"原文"样式（用户裁定）——317 次的"纯继承"继承的是插入点
    //   后文样式，原文与后文字体/字色不同时会错。改为锁定 el 父元素（原文容器，
    //   标注 span 之外）computedStyle 五项（字色/字族/字号/斜体/粗细）内联。
    //   （panel.js show in page 同款逻辑，锁选区起点）
    node.style.cssText = (isMultiWord ? 'margin-top:4px;' : 'margin-left:2px;');
    const srcEl = el.parentElement;
    if (srcEl && srcEl.isConnected) {
      const cs = getComputedStyle(srcEl);
      node.style.color = cs.color;
      node.style.fontFamily = cs.fontFamily;
      node.style.fontSize = cs.fontSize;
      node.style.fontStyle = cs.fontStyle;
      node.style.fontWeight = cs.fontWeight;
    }
    node.textContent = isMultiWord ? text : ` ${text}`;
    // 319次：el.after 会把译文插进"词 span 与紧邻注释（.beaver-side-ann）"中间，
    //   形成夹心（词-新译文-旧注释）重复观感。紧邻是注释时排到注释之后，与
    //   panel.js 路径 A 同规则。
    const annSib = el.nextElementSibling;
    if (annSib && annSib.classList && annSib.classList.contains('beaver-side-ann')) {
      annSib.parentNode.insertBefore(node, annSib.nextSibling);
    } else {
      el.after(node);
    }
    console.log(`[VocabRadar][th-tooltip] show in page：已插入 "${word}" 短释 → ${text.slice(0, 40)}`);
    // 309次第四轮：成功不显示反馈行（用户裁定），失败保留。
    // 315次（用户"撤销任何禁止插入"）：309 次第五轮"成功后禁用本卡按钮"撤销——
    //   按钮永远可点，允许重复插入（与 panel.js 同口径，不做任何阻断）。
  } catch (e) {
    console.error('[VocabRadar][th-tooltip] show in page 插入失败:', e);
    showInsertFeedback(q, false, `${t('th.insertFail')}${e && e.message ? `：${e.message}` : ''}`);
  }
}

// 反思（2026-07-14 #98 → 2026-07-26 修正）：
//   旧版误解用户意图，加了 scroll 跟随重定位逻辑，导致飘窗随页面滚动
//   （违反"右键查询的飘窗固定不动"硬约束）。
//   用户明确："滚动说明失去注意力了"——scroll 触发时立即隐藏 tooltip 和 panel。
//   tooltip/panel 均为 position:fixed 本就视口固定，无需重定位；scroll 即视为用户
//   失去对当前提示的注意力，直接隐藏。
// 反思（2026-08-03 修正）：用户反馈"当适应侧栏时，文本提示和右键查询窗口很快消失"。
//   根因：scroll 用 capture:true 监听，侧栏内部字幕面板滚动也触发 onScrollHide。
//   修正：检查 event.target，若滚动来自 #beaver-sidebar 内部则忽略（不影响页面滚动隐藏）。
export function onScrollHide(e) {
  // 忽略侧栏内部的滚动（字幕面板滚动不应隐藏文本提示/右键面板）
  if (e && e.target && e.target.closest && e.target.closest('#beaver-sidebar, #beaver-subtitle-overlay')) {
    return;
  }
  if (thState.tooltip && thState.tooltip.style.display !== 'none') hideTooltip();
  if (thState.panel && thState.panel.style.display !== 'none') hidePanel();
}

// 优先级：主动操作（scroll/点击外部）> 默认操作（hover 指针移出区域）。
// 任何途径调用 hideTooltip 都视为"立即隐藏"。
export function hideTooltip() {
  if (thState.tooltip) thState.tooltip.style.display = 'none';
  thState.tooltipTargetEl = null;
  thState.tooltipWord = '';  // 清除当前词标记，取消待填充的异步音标
  if (thState.hideTimer) { clearTimeout(thState.hideTimer); thState.hideTimer = null; }
}

// 反思（2026-08-18 第七十五次修正）：指针是否已离开"生词 + 悬浮窗"联合区域。
//   联合区域 = 生词矩形 ∪ 悬浮窗矩形，各向外扩 24px 缓冲；
//   指针移出该区域即视为"挪走一些距离"，立即隐藏（无停留时间）。
//   悬浮窗自身在区域内 → 鼠标移到悬浮窗上查看/点朗读不会消失。
export function pointerOutOfTooltipZone() {
  if (!thState.tooltip || thState.tooltip.style.display === 'none') return true;
  const el = thState.tooltipTargetEl;
  if (!el || !el.isConnected) return true;
  // 反思（2026-08-28 第一百六十九次）：lastPointerX/Y 初值为 -1（core.js），表示
  //   "本页尚未收到过任何 pointermove"。此时下面的区间判断必然成立（-1 < left），
  //   于是 onWordLeave 一进来就判"已离开"→ 刚显示的提示被立刻隐藏，
  //   表现为"文本提示没了"。触发条件：mouseenter 先于任何 pointermove 到达
  //   （键盘/程序化聚焦、指针进入时首个事件被页面 stopPropagation 吞掉、
  //   或 window.__beaverTooltipMoveBound 已被先前实例占用导致本实例坐标永不更新）。
  //   修正：坐标未知时不判定离开，交由 scroll/点击外部等主动路径隐藏。
  if (thState.lastPointerX < 0 && thState.lastPointerY < 0) return false;
  const pad = 24;
  const r = el.getBoundingClientRect();
  const t = thState.tooltip.getBoundingClientRect();
  const left = Math.min(r.left, t.left) - pad;
  const right = Math.max(r.right, t.right) + pad;
  const top = Math.min(r.top, t.top) - pad;
  const bottom = Math.max(r.bottom, t.bottom) + pad;
  return thState.lastPointerX < left || thState.lastPointerX > right ||
    thState.lastPointerY < top || thState.lastPointerY > bottom;
}

export function onWordHover(e) {
  // 第二百四十三次：温和 prime 内置翻译（不清冷却）。hover 本身不产生 user activation
  //   （浏览器只认 click/keydown 等），但用户近 5s 内点过页面时 isActive 有效 → create 成功；
  //   点击高亮词是 click 手势，activation 必定有效。冷却期内快速 return，实例就绪后零开销。
  primeTranslator();
  if (thState.hideTimer) { clearTimeout(thState.hideTimer); thState.hideTimer = null; }
  const el = e.currentTarget;
  // 校验 span 仍有效：框架可能改动 textContent，失效则清理且不显示 tooltip
  // （杜绝"凭空造词"位置的 NaN/错乱数据显示）
  if (!validateSpan(el)) {
    unwrapSingle(el);
    return;
  }
  thState.tooltipTargetEl = el;
  const data = {
    word: el.dataset.word,
    // NaN 防御：dataset.rank 为空或非数字串时置 null，避免 Number('NaN')=NaN
    rank: (el.dataset.rank && !isNaN(Number(el.dataset.rank))) ? Number(el.dataset.rank) : null,
    tags: el.dataset.tags ? el.dataset.tags.split(',').filter(Boolean) : [],
    translations: el.dataset.translations ? el.dataset.translations.split('；') : [],
    lemma: el.dataset.lemma || ''  // 词形还原原形（仅词形还原后命中时非空）
  };
  const rect = el.getBoundingClientRect();
  showTooltip(data, rect, { pending: data.translations.length === 0 });

  // 反思（2026-08-02 修正）：
  //   用户要求"鼠标飘过或者点击生词时候，要翻译"。
  //   queryWord 异步翻译只更新 thState.wordCache，已包裹的 span 不会更新。
  //   hover 时若 translations 为空，触发翻译获取释义并更新 tooltip + dataset。
  //   - 缓存命中（thState.wordCache 已有 translations）：直接显示
  //   - 缓存未命中：调 translate 获取，成功后更新 tooltip + dataset
  // 反思（2026-08-03 修正）：translator.js 已移除 force 参数，translate 纯做翻译。
  if (data.translations.length === 0) {
    const word = data.word;
    const lower = word.toLowerCase();
    // 先查缓存（异步翻译可能已完成）
    const cached = thState.wordCache.get(lower);
    if (cached && cached.translations && cached.translations.length > 0) {
      data.translations = cached.translations;
      // 第一百二十三次：过滤括号不配对的截断残片
      el.dataset.translations = cached.translations.filter((s) => Boolean(s) && isBalancedParens(s)).join('；');
      showTooltip(data, rect, { pending: false });
      return;
    }
    // 缓存未命中，触发翻译（hover 是用户主动行为）
    // 反思（2026-08-06）：上下文失效时跳过，避免无意义的翻译调用
    if (!isContextValid()) return;
    // 反思（2026-08-15 第六十四次）：翻译同一通道——
    //   hover 时优先读统一词典 IDB 译文（与侧栏/右键面板同一数据源），
    //   未命中才调 translate()。两者一致时 tooltip 与侧邻注释恒为同一译文。
    const showTranslation = (translations) => {
      // 第一百二十三次：过滤括号不配对的截断残片
      const okT = translations.filter((s) => Boolean(s) && isBalancedParens(s));
      el.dataset.translations = okT.join('；');
      // 仅当 tooltip 仍指向当前 span 时更新（避免快速 hover 串扰）
      if (thState.tooltipTargetEl === el) {
        data.translations = okT;
        showTooltip(data, rect, { pending: false });
      }
      // 同步侧邻注释，保证与悬浮提示显示同一译文
      if (thState.colors.sideAnnotation && thState.enabled) {
        backfillSideAnnotation(lower, okT);
      }
    };
    const doTranslate = () => {
      translate(word, true).then((translated) => {
        if (!translated) return;
        // 更新缓存 + dataset，下次 hover 直接命中
        thState.wordCache.set(lower, {
          isWord: true,
          rank: data.rank,
          tags: data.tags,
          lemma: data.lemma || null,
          translations: [translated]
        });
        showTranslation([translated]);
      }).catch((e) => {
        // 扩展上下文失效时标记，避免后续翻译调用（静默处理）
        const msg = e && (e.message || String(e));
        if (msg && /Extension context invalidated/.test(msg)) {
          thState.contextInvalidated = true;
        }
        // 反思（2026-08-13 第四十九次）：翻译失败移除省略号，释义区留空。
        //   不自作主张显示"暂无释义"；tooltip 仍指向当前 span 时刷新。
        if (thState.tooltipTargetEl === el) {
          showTooltip(data, rect, { pending: false });
        }
      });
    };
    queryWordForPanel(lower, word).then((panel) => {
      if (panel && panel.translations && panel.translations.length > 0) {
        // 统一词典译文命中：与侧栏/右键面板一致，不再重复 translate
        showTranslation(panel.translations);
      } else {
        doTranslate();
      }
    }).catch(() => {
      // IDB 读取失败：退回到 translate
      doTranslate();
    });
  }
}

export function onWordLeave() {
  // 反思（2026-08-18 第七十五次修正）：无停留时间——指针移出联合区域立即隐藏。
  //   pointermove 监听已覆盖大多数情况；此处兜底：mouseleave 触发且指针
  //   已不在区域内（例如移向页面其他位置）则立即隐藏。
  if (pointerOutOfTooltipZone()) hideTooltip();
}

export function onWordClick(e) {
  // 328次修正（2026-09-16）：删除 stopPropagation——它截断 click 冒泡，
  //   宿主页依赖冒泡的组件随之失效（用户报障：开启扩展后 B 站合集列表点不动。
  //   实测对照：包词 span 调 stopPropagation 后，click 在 target 阶段即死，
  //   .video-pod 及以上所有 bubble 层收不到；不调则全链路 17 条完整到达）。
  //   查词（speak+翻译）不依赖冒泡，删除无副作用；点 <a> 内的词本来就照样
  //   跳转（stopPropagation 从不阻止默认行为），无回归。对齐 saladict
  //   「不拦截宿主点击」原则：包进宿主文本的 span 必须放行冒泡。
  const el = e.currentTarget;
  speak(el.dataset.word);
  // 反思（2026-08-02）：用户要求"点击生词时候，要翻译"。
  //   点击触发 hover 同样的翻译逻辑（若释义已存在则不重复翻译）
  //   onWordHover 已处理 translations 为空时的翻译，click 时先检查是否需要翻译
  const translations = el.dataset.translations ? el.dataset.translations.split('；') : [];
  if (translations.length === 0) {
    // 复用 hover 的翻译逻辑：构造 mouseenter 事件触发 onWordHover
    onWordHover({ currentTarget: el, stopPropagation: () => {} });
  }
}
