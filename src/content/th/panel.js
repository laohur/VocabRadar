// 文本提示 · 面板模块（右键查词面板）
//
// 本文件职责（第561次拆分后为门面 + 面板宿主）：
//   1. 门面 re-export：卡片构建（card-build.js）、查询渲染核心（query-card.js）、
//      My Words 标记按钮（card-mark.js）——tooltip.js/ws/ui.js/vs/actions.js 的
//      import 路径保持 './panel.js' 不变，符号名不变。
//   2. 右键查词面板（#beaver-context-panel，Shadow DOM）：创建、显示/隐藏、
//      定位（两遍法 + 动态 max-height）
//   （原第3项 OCR 结果面板 #beaver-ocr-panel 已拆除：OCR 结果改写入字幕轨道，
//     见 vs/ocr.js → appendASRSubtitle）
//
// 查询卡片内容渲染走 query-card.js renderQueryCard；卡片结构/样式/词形同族组
//   走 card-build.js；🏁/✓ 标记按钮走 card-mark.js；相关词汇行走 card-related.js。
//
// 共享状态一律取自 core.js 的 thState（唯一属主），本文件不声明任何同名变量。
// 模块级副作用：ensurePanel 的 document mousedown(capture)/keydown——
//   由 `if (_xxx) return` 幂等守卫保证只注册一次。
//
// 跨模块调用（受控循环 import，两端均为函数声明，顶层不调用）：
//   → tooltip.js: hideTooltip（ensurePanel 的 mousedown 同时管 tooltip 与 panel）
//   ← tooltip.js / ws/ui.js / vs/actions.js（消费门面导出）
import { primeTranslator } from '../../lib/translator.js';
import {
  thState, PANEL_ID, HIGHLIGHT_CLASS
} from './core.js';
import { hideTooltip } from './tooltip.js';
// 右键面板点击外部关闭需识别 Chat 面板（独立 fixed 浮层）
import { CHAT_PANEL_ID } from '../../lib/chat.js';
// 查询渲染核心与选段清洗（extractCleanSelText 供 showContextPanel 过滤插入节点，
//   setLastQueryRange 保存 show in page 插入锚点——query-card.js 私有状态唯一写入口）
import { renderQueryCard, extractCleanSelText, setLastQueryRange } from './query-card.js';

// === 门面 re-export（符号名不变，既有引用方零改动） ===
export {
  buildPanelCss,      // 卡片样式唯一定义（ws/vs 内嵌卡自组 <style> 用）
  buildPanelHTML,     // header 卡整卡（右键面板/悬浮提示）
  buildCardInnerHTML, // 卡体结构（悬浮/面板/内嵌共用；opts.markButtons=false 去标记按钮）
  renderLemmaInto     // 原形行 + 同族词汇组常显渲染
} from './card-build.js';
export {
  renderQueryCard,    // 查询渲染核心（含相关词汇异步填充）
  queryWordForPanel,  // 统一词典完整记录读取
  showInsertFeedback  // show in page 结果反馈行
} from './query-card.js';
export { bindMarkButtons } from './card-mark.js';

/**
 * 显示右键菜单查词面板
 * @param {string} text 用户选中的文本
 */
export function showContextPanel(text, clientX, clientY) {
  // 用户要求"选段翻译时候，排除插入的释义，只选原文"：SW 转发的 selectionText
  //   取自浏览器原生选区（info.selectionText），若框选范围混入了本扩展插入页面的
  //   释义节点（.beaver-page-insert），译文会被一并送查。此刻右键菜单刚触发、选区
  //   仍在，先取 Range：克隆作 lastQueryRange（插入锚点，query-card.js 消费）；
  //   混入检测（端点落在插入节点内 或 克隆片段含插入元素）命中时按节点级过滤重取原文，
  //   过滤结果为空才退回原始 selectionText（例如只框选了插入释义本身）。
  let range = null;
  try {
    const sel = window.getSelection();
    range = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0) : null;
  } catch (_) { range = null; }
  if (range) {
    setLastQueryRange(range.cloneRange());
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
    setLastQueryRange(null);
  }
  const trimmed = text.trim();
  if (!trimmed) return;
  // 手势入口 prime 内置翻译（不 await，不阻塞面板）。本函数由右键菜单
  //   （SW 转发 SHOW_CONTEXT_PANEL）触发，距用户在页面右键 1-3s，transient activation
  //   （约 5s 窗口）仍有效，Translator.create() 此刻可成功；实例缓存后自动注释场景复用。
  //   已就绪/冷却期内为 no-op，重复调用无害。右键是明确查词意图，显式传 force=true
  //   清冷却强制重试（force 语义由 primeTranslator(opts) 控制，hover 等高频入口不得用）。
  primeTranslator({ force: true });
  ensurePanel();
  // 用户裁定"查询窗固定字号"：不做 body 字号同步（syncBodyFontSize 会覆盖 ensurePanel
  //   的 14px !important），查询窗字号恒为 14px 基准（buildPanelCss 内 em 已换算 px 定死）。

  const shadow = thState.panel.shadowRoot;
  thState.panel.style.display = 'block';
  positionPanel(clientX, clientY);
  // 查询渲染核心为 renderQueryCard（query-card.js）——右键浮动面板与文本侧栏 query
  //   标签内嵌卡片共用（同 buildCardInnerHTML 结构）。位置刷新经 onUpdate 回调；
  //   alive 守卫保留"面板隐藏期间不写"语义（过期异步不覆盖新查询）。
  renderQueryCard(shadow, trimmed,
    () => positionPanel(clientX, clientY),
    () => !!(thState.panel && thState.panel.style.display !== 'none'),
    { showInPage: true }
  ).catch((e) => console.error('[VocabRadar][text-hint] 右键查询渲染异常:', e));
}

// 定位口径（用户要求"右键查询弹出框应当在当前位置"）：面板左上角放在右键点击位置
// （如系统右键菜单），右侧/下方溢出时翻转到左侧/上方。
// panel 为 position:fixed，clientX/clientY 是视口坐标，无需加 scrollX/scrollY。
// 用户反馈"右键查询，边上窗口显示不全"，并要求"页面底部向上展示，页面顶部向下展示"：
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
    /* 用户反馈"查询窗口字号咋定的，比之前和其他地方的正文大了很多"：面板挂在
       documentElement 下，font-size:inherit 继承浏览器默认 16px，卡内 .word 1.15em
       偏大。定死 14px 与侧栏正文同基准；不做 body 字号同步（用户裁定"查询窗固定字号"），
       buildPanelCss 内 em 全换 px，查询窗任何站点恒 14px 基准（.word 16px） */
    font-size: 14px !important;
    line-height: 1.5 !important;
    min-width: 280px !important;
    max-width: 400px !important;
    display: none !important;
  `;
  const shadow = thState.panel.attachShadow({ mode: 'open' });
  shadow.innerHTML = buildPanelHTML();
  document.documentElement.appendChild(thState.panel);
  // 点击外部自动关闭（用户要求"右键的查询菜单无法消失，应当点击别处自动消失"——立即关闭，不接延迟计时）。
  //   用 document mousedown capture 监听 + composedPath 处理 shadow DOM boundary
  //   （thState.panel 内是 shadow 子元素，e.target 冒泡到 host 时被重定向，直接比
  //   e.target === thState.panel 几乎不触发；监听 panel 自身 click 会把 shadow 内
  //   🔊 speak 按钮的点击误判为点击面板自身而错关面板，故不采用——外部关闭
  //   统一由本监听处理，内部点击经 composedPath 正确识别）。
  //   hover tooltip 的 mouseleave 延迟属于悬浮提示自身交互，与本面板无关。
  //   点击生词 span 不隐藏 tooltip（让 onWordHover/onWordClick 处理，避免点击朗读时 tooltip 闪掉）。
  document.addEventListener('mousedown', (e) => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    // 点击 Chat 面板（独立 fixed 浮层，不在 panel/tooltip 的 DOM 内）
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

