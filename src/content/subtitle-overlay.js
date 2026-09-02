// 视频内字幕：在视频上叠加私有 overlay，支持侧邻注释和详细注释两种模式
//
// 功能：
//   1. 监听 video.timeupdate，找到当前字幕条目并注解
//   2. 侧邻注释模式（默认）：字幕中生词高亮 + (释义) 行内显示
//   3. 详细注释模式：字幕仅高亮生词，下方排列单词注释（词头+释义）
//   4. 配色复用 CSS 变量（--beaver-first-bg/fg, --beaver-later-bg/fg, --beaver-ann-bg/fg）
//      与文本提示、视频提示共用同一套配色变量，改色一处全局生效
//
// 模式控制（2026-08-05）：
//   通过 chrome.storage.local 的 subtitleDetailMode 控制
//   false（默认）= 侧邻注释，true = 详细注释
//   与视频提示（sidebar.js）的详略模式同步：sidebar 切换详略时写入 storage，
//   本模块监听 storage 变化自动切换渲染模式
//
// 设计要点：
//   - overlay 为 light DOM（非 Shadow），复用 :root CSS 变量
//   - 注解缓存（_annotationsCache）避免重复查词
//   - 跨字幕去重（_seen）
//   - 反思（2026-07-06 v4）：renderSubtitle 是 async，位置更新移入末尾
//     避免 offsetHeight=0 导致位置错位

import { getAnnotations } from '../lib/annotator.js';
// 反思（2026-08-13 第五十一次）：字幕样式数据驱动（差异化属性定义在 styles.js SUBTITLE_TEXT_STYLES），
//   CSS 按元数据生成，避免样式定义与元数据不一致。
// 反思（2026-08-16 第六十九次）：文字样式与位置样式解耦——文字外观由 SUBTITLE_TEXT_STYLES，
//   位置（距视频底部比例）由 SUBTITLE_POSITIONS 独立选择（storage.subtitlePosition），
//   位置由 updateOverlayPosition 按 ratio 内联计算，样式类不再含位置。
import { SUBTITLE_TEXT_STYLES, SUBTITLE_POSITIONS, findStyle, BUILD_STAMP } from '../lib/styles.js';

let _overlay = null;
let _video = null;
let _subtitles = [];             // [{start, end, text}]
let _annotationsCache = new Map(); // text -> annotations
let _seen = new Set();           // 跨字幕去重
let _enabled = true;
let _rankThreshold = 5000;   // 2026-08-14 第五十四次修正：恢复默认 5000
// 注释重复生词（2026-08-15 第六十二次：默认不选，后续出现不包裹不注释）
let _annotateRepeat = false;
let _lastKey = '';               // 避免重复渲染
let _scrollHandler = null;       // scroll/resize 监听器
let _mode = 'side';              // 'side'（侧邻注释）或 'detail'（详细注释）
let _styleId = 'none';           // 当前字幕文字样式 id（annMode 决定注释布局）
let _posId = 'b20';              // 当前字幕位置样式 id（距视频底部比例）
let _storageListener = null;     // storage 变化监听器（同步详略模式）
let _fullscreenHandler = null;   // fullscreenchange 监听器（全屏时移动 overlay）

/** 创建 overlay 元素（position:fixed，位置由 updateOverlayPosition 动态计算） */
function createOverlay() {
  const el = document.createElement('div');
  el.id = 'beaver-subtitle-overlay';
  // 结构：字幕正文容器 + 注释列表容器（详细模式才填充注释列表）
  el.innerHTML = '<div class="beaver-overlay-subtitle"></div><div class="beaver-overlay-annotations"></div>';
  return el;
}

/**
 * 注入 overlay 样式（复用 :root CSS 变量）
 * 反思（2026-08-05）：样式不再内联 cssText，改为注入 <style> 便于维护
 *   生词配色用 --beaver-first-bg/fg, --beaver-later-bg/fg
 *   注释配色用 --beaver-ann-bg/fg（与 text-hint-impl 侧邻注释共用）
 *   这些变量由 text-hint-impl.applyColorVars 或 sidebar.css :root 设置
 */
function injectOverlayStyles() {
  if (document.getElementById('beaver-overlay-styles')) return;
  const style = document.createElement('style');
  style.id = 'beaver-overlay-styles';
  // 反思（2026-08-16 第七十一次）：④ 撤销"黑底兜底"——基础规则不再写 background，
  //   默认透明（黑底只由选中的 .style-none 等样式类提供）；并显式钉住生词词块配色
  //   （--beaver-first-bg/fg 固定为浅绿深字，防止 text-hint 的 applyColorVars 把页面暗色
  //   变量泄漏进字幕 overlay 导致词块变暗色块）。透明样式被选中时，视频底色如实透出，
  //   不再"把透明当作黑色"。
  style.textContent = `
#beaver-subtitle-overlay {
  position: fixed;
  left: 0;
  top: 0;
  --beaver-first-bg: #2e6b43;
  --beaver-first-fg: #ffffff;
  --beaver-later-bg: #2e6b43;
  --beaver-later-fg: #ffffff;
  color: #fff;
  padding: 8px 14px;
  border-radius: 6px;
  /* 第一百二十七次：默认字号随视频高度自适应——--beaver-sub-fs 由
   * updateOverlayPosition 按 rect.height*4.5% 注入（clamp 18-40px）。
   * 依据：YouTube 默认 ≈24-28px / Netflix 28-32px@1080p / BBC ≈8% 帧高、
   * Captionator polyfill 默认 4.5%；原固定 16px 低于广播下限，用户反馈太小。 */
  font-size: var(--beaver-sub-fs, 24px);
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  pointer-events: none;
  z-index: 2147483647;
  max-width: 80%;
  text-align: center;
  line-height: 1.5;
  display: none;
  transform: translateX(-50%);
}
/* 字幕正文容器 */
#beaver-subtitle-overlay .beaver-overlay-subtitle {
  word-break: break-word;
}
/* 字幕正文生词高亮（首次/后续配色复用 CSS 变量） */
#beaver-subtitle-overlay .beaver-overlay-subtitle .beaver-word {
  display: inline-block;
  background: var(--beaver-first-bg, #2e6b43);
  color: var(--beaver-first-fg, #ffffff);
  padding: 0 3px;
  border-radius: 2px;
  font-weight: 500;
}
#beaver-subtitle-overlay .beaver-overlay-subtitle .beaver-word.later {
  background: var(--beaver-later-bg, #2e6b43);
  color: var(--beaver-later-fg, #ffffff);
}
/* 侧邻注释：(释义) 行内，紧贴生词后（默认透明底白字，避免黑块） */
#beaver-subtitle-overlay .beaver-overlay-subtitle .beaver-side-ann {
  display: inline;
  background: transparent;
  color: #ffffff;
  padding: 0 2px;
  border-radius: 2px;
}
/* 详细注释列表（字幕下方排列单词注释） */
#beaver-subtitle-overlay .beaver-overlay-annotations {
  margin-top: 4px;
  text-align: left;
  font-size: 0.9em;
  line-height: 1.6;
}
#beaver-subtitle-overlay .beaver-overlay-ann-line {
  margin-top: 2px;
}
#beaver-subtitle-overlay .beaver-overlay-ann-word {
  display: inline-block;
  background: transparent;
  color: #ffffff;
  padding: 0 4px;
  border-radius: 2px;
  font-weight: 500;
  margin-right: 4px;
}
#beaver-subtitle-overlay .beaver-overlay-ann-trans {
  display: inline;
  background: transparent;
  color: #ffffff;
  padding: 0 2px;
  border-radius: 2px;
  word-break: break-word;
}
/* === 字幕样式预设（2026-08-13 第五十一次）===
 * 用户要求"字幕样式要含：位置、侧邻注释、新行注释、字号、颜色、边缘，样式差异化"。
 * 样式元数据定义在 src/lib/styles.js SUBTITLE_TEXT_STYLES：
 *   font 字体（sans/serif/mono）、fg 前景色、bg 背景色、size 字号、edge 描边色、
 *   bold 粗体、italic 斜体、shadow 文本阴影、annMode 注释模式。
 * 反思（2026-08-16 第六十六次）：删除竖排（right-vertical/center-vertical）——用户明确
 *   竖屏适配是"视频竖着，不是字幕竖着"；字幕一律横排、位置随视频矩形计算。
 * 反思（2026-08-16 第六十九次）：样式类不再含位置（位置改由 updateOverlayPosition
 *   按 SUBTITLE_POSITIONS 的 ratio 内联计算），文字样式类只描述外观。 */

${buildSubtitleStyleCss()}
`;
  document.head.appendChild(style);
}

/**
 * 反思（2026-08-13 第五十一次）：按 SUBTITLE_TEXT_STYLES 元数据生成 style-{id} 差异化 CSS。
 * 字体/颜色/字号/背景/描边/粗体/斜体/阴影全部来自元数据，与引导页双预览一致。
 * 反思（2026-08-16 第六十六次）：删除竖排逻辑（pos 'right' / vertical 字段）。
 * 反思（2026-08-16 第六十九次）：删除位置（pos 字段）——位置改由 updateOverlayPosition
 *   按 SUBTITLE_POSITIONS 的 ratio 内联计算，样式类只管外观。
 * 背景透明（bg=null）的样式，其注释块（side-ann / ann-word / ann-trans）同步强制透明，
 * 避免"透明背景 + 深色注释块"在视频上变成黑块（用户反复强调"不要把透明当作黑色"）。
 * @returns {string} CSS 规则文本
 */
function buildSubtitleStyleCss() {
  const FONT_MAP = {
    sans: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
    serif: '"Georgia", "Times New Roman", "SimSun", serif',
    mono: '"Consolas", "Courier New", monospace'
  };
  return SUBTITLE_TEXT_STYLES.map((s) => {
    const parts = [];
    parts.push('background:' + (s.bg || 'transparent'));
    parts.push('color:' + s.fg);
    // 第一百二十七次：size=null（默认外观）不写死字号，回落基础层的
    // var(--beaver-sub-fs)——随视频高度 4.5% 自适应（clamp 18-40px）
    if (s.size) parts.push('font-size:' + s.size + 'px');
    parts.push('font-family:' + (FONT_MAP[s.font] || FONT_MAP.sans));
    parts.push('border-radius:4px');
    parts.push('max-width:90%');
    if (s.bold) parts.push('font-weight:600');
    if (s.italic) parts.push('font-style:italic');
    if (s.edge) parts.push('-webkit-text-stroke:1px ' + s.edge);
    // 反思（2026-08-15 第六十四次）：shadow 字段支持字符串（自定义 text-shadow），true 用默认黑投影
    if (s.shadow) parts.push('text-shadow:' + (typeof s.shadow === 'string' ? s.shadow : '0 0 6px rgba(0,0,0,.9)'));
    // 背景透明（无底）样式：注释块强制透明 + 前景色，防止视频上出现黑块
    let css = '#beaver-subtitle-overlay.style-' + s.id + '{' + parts.join(';') + ';}';
    if (!s.bg) {
      css += '#beaver-subtitle-overlay.style-' + s.id + ' .beaver-side-ann{background:transparent;color:' + s.fg + ';}';
      css += '#beaver-subtitle-overlay.style-' + s.id + ' .beaver-overlay-ann-word{background:transparent;color:' + s.fg + ';}';
      css += '#beaver-subtitle-overlay.style-' + s.id + ' .beaver-overlay-ann-trans{background:transparent;color:' + s.fg + ';}';
    }
    return css;
  }).join('\n');
}

/**
 * 根据 video.getBoundingClientRect() 更新 overlay 位置
 * overlay 水平居中于视频，垂直在视频底部 8% 处
 * 反思（2026-07-06 v4）：rect 为 0×0 时不隐藏 overlay，仅跳过位置更新。
 *   全屏切换/SPA 导航时 video 可能短暂 0×0，隐藏后 _lastKey 不变不会恢复。
 * 反思（2026-08-05 修正）：用户反馈"视频全屏播放内没有字幕"。
 *   根因：视频进入全屏时，全屏元素被提升到 top layer（浏览器顶层），
 *   document.body 上的 position:fixed 元素不再显示在全屏元素之上。
 *   修正：fullscreenchange 事件触发时，将 overlay 挂到全屏元素内部（全屏时），
 *   或移回 document.body（退出全屏时）。位置计算用 getBoundingClientRect 仍正确
 *  （全屏时 video 充满视口，rect 为视口尺寸）。
 */
function updateOverlayPosition() {
  // 第一百零五次：总守卫——叠加字幕未开启时 scroll/resize 监听仍会触发本函数，
  // 造成"未开启却后台不停扫描"的日志刷屏（用户反馈）。禁用即完全不工作。
  if (!_enabled || !_overlay || !_video) return;
  const rect = _video.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  // 反思（2026-08-16 第六十六次）：字幕位置一律相对"视频矩形"计算（水平居中于视频，
  //   垂直按样式位置：底部 10% / 偏高 20% / 顶部 8% / 居中）。横屏、竖屏视频都跟随视频
  //   矩形——竖屏视频字幕仍是横排文字、只是位于竖的视频内。删除旧 .portrait 竖屏分支与
  //   竖排样式定位（用户明确："是视频竖着，不是字幕竖着"）。
  // 反思（2026-08-16 第六十九次）：位置不再来自文字样式的 pos 字段，改由 SUBTITLE_POSITIONS
  //   独立选择（storage.subtitlePosition）：ratio=字幕框中心线距视频底部的高度占视频高度比例，
  //   top = 视频底边 - 视频高度×ratio - 字幕框高/2（2026-08-19 第八十次：修正为 -h/2——
  //   旧版 -h 把盒子底边压在 ratio 线上，与"中心线"语义不符，预览/真实 overlay 都对不齐
  //   用户说的"中心水平线"）。横屏/竖屏视频同一公式，天然跟随视频矩形。
  const posMeta = findStyle(SUBTITLE_POSITIONS, _posId);
  const ratio = (posMeta && typeof posMeta.ratio === 'number') ? posMeta.ratio : 0.1;
  _overlay.style.left = (rect.left + rect.width / 2) + 'px';
  // 第一百二十七次：默认字号随视频高度自适应——4.5% 视频高（Captionator polyfill
  // 同款比例），clamp 18-40px；预设样式自带固定 px 时其类规则优先，不受影响。
  {
    const fs = Math.round(Math.min(40, Math.max(18, rect.height * 0.045)));
    _overlay.style.setProperty('--beaver-sub-fs', fs + 'px');
  }
  const h = _overlay.offsetHeight || 0;
  _overlay.style.top = (rect.bottom - rect.height * ratio - h / 2) + 'px';
  _overlay.style.bottom = '';
  // 反思（2026-08-16 第六十七次）：竖屏适配——字幕框宽度不能超出视频矩形。
  //   基础样式 max-width:80%（按视口）+ 各样式 max-width:90% 只适合横屏铺满视口；
  //   竖屏视频（视频矩形远窄于视口）内字幕框会溢出视频左右边界。修正：视频矩形
  //   小于视口 80% 时，把字幕框最大宽度限制在视频矩形内（留 8px 余量，最小 100px）；
  //   横屏满宽视频时清空内联 maxWidth，交回样式类（80%/90%）决定。
  const vw = window.innerWidth;
  if (rect.width > 0 && rect.width < vw * 0.8) {
    _overlay.style.maxWidth = Math.max(rect.width - 8, 100) + 'px';
  } else {
    _overlay.style.maxWidth = '';
  }
  // 反思（2026-08-06）：诊断日志，验证全屏时 overlay 定位是否正确
  console.log('[VocabRadar][overlay] 位置更新: video rect=' + JSON.stringify({
    w: rect.width, h: rect.height, left: rect.left, top: rect.top
  }) + ' overlay parent=' + (_overlay.parentElement ? _overlay.parentElement.tagName : 'null') +
    ' fullscreen=' + (!!document.fullscreenElement) + ' display=' + _overlay.style.display +
    ' ratio=' + ratio.toFixed(2) + ' pos=' + _posId + ' style=' + _styleId);
}

/**
 * 全屏变化处理：进入全屏时将 overlay 挂到全屏元素内部，退出时移回 body
 * 反思（2026-08-05）：浏览器全屏 API 将全屏元素提升到 top layer，
 *   body 上的 fixed 元素无法覆盖全屏元素。必须将 overlay 挂到全屏元素内部才能显示。
 *   全屏元素可能是 video 本身或其祖先容器（如 .bpx-player-container）。
 */
function onFullscreenChange() {
  if (!_overlay) return;
  // 反思（2026-08-06）：同时检查标准与 webkit 前缀（Safari/旧 Chrome）
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  // 反思（2026-08-06）：诊断日志，验证全屏事件是否触发
  console.log('[VocabRadar][overlay] fullscreenchange: fullscreenElement=' +
    (fsEl ? fsEl.tagName + '#' + (fsEl.id || '') : 'null') +
    ' standard=' + (!!document.fullscreenElement) +
    ' webkit=' + (!!document.webkitFullscreenElement));
  if (fsEl) {
    // 进入全屏：将 overlay 挂到全屏元素内部
    if (_overlay.parentElement !== fsEl) {
      fsEl.appendChild(_overlay);
      console.log('[VocabRadar][overlay] overlay 已移入全屏元素:', fsEl.tagName);
    }
  } else {
    // 退出全屏：移回 body
    if (_overlay.parentElement !== document.body) {
      document.body.appendChild(_overlay);
      console.log('[VocabRadar][overlay] overlay 已移回 body');
    }
  }
  // 强制重新渲染（位置变化）
  _lastKey = '';
  if (_video && _enabled) onTimeUpdate();
}

/** HTML 转义 */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** 正则转义 */
function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从释义列表中取一个短义项（第一个释义的第一个分号前部分）
 * @param {string[]} translations
 * @returns {string}
 */
function pickShortTrans(translations) {
  if (!translations || translations.length === 0) return '';
  const t = translations[0] || '';
  const idx = t.indexOf('；');
  return idx > 0 ? t.slice(0, idx) : t;
}

/**
 * 构建侧邻注释 HTML：生词高亮 + (释义) 行内
 * @param {string} text 字幕文本
 * @param {Array} anns 注解数组
 * @returns {string} HTML 字符串
 */
function buildSideAnnotationHtml(text, anns) {
  if (!anns || anns.length === 0) return escapeHtml(text);
  // 生词查找表
  const annMap = new Map();
  for (const a of anns) {
    annMap.set(a.word.toLowerCase(), a);
  }
  // 找到所有生词在文本中的位置
  const matches = [];
  for (const a of anns) {
    // 反思（2026-08-15 第六十二次）：注释重复生词默认不选——
    //   后续出现（isFirst===false）不包裹不注释，与视频侧栏/文本侧栏一致。
    if (!_annotateRepeat && a.isFirst === false) continue;
    const re = new RegExp('\\b' + escapeReg(a.word) + '\\b', 'i');
    const m = text.match(re);
    if (m) {
      matches.push({ start: m.index, end: m.index + m[0].length, word: m[0], ann: a });
    }
  }
  matches.sort((a, b) => a.start - b.start);
  // 去除重叠
  const valid = [];
  let lastEnd = 0;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      valid.push(m);
      lastEnd = m.end;
    }
  }
  // 构建 HTML
  let html = '';
  let pos = 0;
  const usedWords = new Set();
  for (const m of valid) {
    html += escapeHtml(text.slice(pos, m.start));
    const lower = m.word.toLowerCase();
    const ann = m.ann;
    const cls = ann.isFirst === false ? 'beaver-word later' : 'beaver-word';
    html += '<span class="' + cls + '">' + escapeHtml(m.word) + '</span>';
    if (!usedWords.has(lower)) {
      usedWords.add(lower);
      const trans = pickShortTrans(ann.translations);
      if (trans) {
        html += '<span class="beaver-side-ann">(' + escapeHtml(trans) + ')</span>';
      }
    }
    pos = m.end;
  }
  html += escapeHtml(text.slice(pos));
  return html;
}

/**
 * 构建详细注释结构：字幕仅高亮 + 下方注释列表
 * @param {string} text 字幕文本
 * @param {Array} anns 注解数组
 * @returns {{subtitleHtml:string, annotationHtml:string}}
 */
function buildDetailAnnotationHtml(text, anns) {
  // 字幕正文：仅高亮生词，不加行内注释
  const subtitleHtml = buildSideAnnotationHtml(text, anns.map(a => ({ ...a, translations: [] })));
  // 注释列表：每个生词一行（词头+释义）
  let annotationHtml = '';
  const usedWords = new Set();
  for (const a of anns) {
    const lower = (a.word || '').toLowerCase();
    if (usedWords.has(lower)) continue;
    usedWords.add(lower);
    const trans = (a.translations || []).filter(Boolean).join(' | ');
    if (!trans) continue;
    annotationHtml += '<div class="beaver-overlay-ann-line">';
    annotationHtml += '<span class="beaver-overlay-ann-word">' + escapeHtml(a.word || '') + '</span>';
    annotationHtml += '<span class="beaver-overlay-ann-trans">' + escapeHtml(trans) + '</span>';
    annotationHtml += '</div>';
  }
  return { subtitleHtml, annotationHtml };
}

/**
 * 渲染一条字幕（含注解）
 * 反思（2026-07-06 v4）：updateOverlayPosition 移入此函数末尾。
 *   旧版在 onTimeUpdate 中同步调用，但此函数是 async，
 *   await getAnnotations 后才设 innerHTML 和 display:block。
 *   新序：renderSubtitle 完成（设 display:block）→ updateOverlayPosition（offsetHeight 正确）。
 * @param {object|null} subtitle - 字幕条目，null 表示无字幕
 */
async function renderSubtitle(subtitle) {
  if (!subtitle) {
    _overlay.style.display = 'none';
    return;
  }

  // 缓存注解结果
  let anns = _annotationsCache.get(subtitle.text);
  if (anns === undefined) {
    anns = await getAnnotations(subtitle.text, _rankThreshold, _seen);
    _annotationsCache.set(subtitle.text, anns);
    // 反思（2026-08-14 第五十四次修正）：getAnnotations 是 async，等待期间用户可能已关闭
    //   叠加字幕（setOverlayEnabled(false)）。若直接继续渲染，会"取消叠加字幕仍显示残留"。
    //   修正：await 返回后重新检查 _enabled，已关闭则不再渲染。
    if (!_enabled) return;
  }

  const subtitleEl = _overlay.querySelector('.beaver-overlay-subtitle');
  const annEl = _overlay.querySelector('.beaver-overlay-annotations');

  // 反思（2026-08-13 第五十一次）：字幕样式含"侧邻注释/新行注释"（annMode）。
  //   样式非 none 时以样式决定注释布局；样式 none 时回退到详略开关(_mode)。
  const styleMeta = findStyle(SUBTITLE_TEXT_STYLES, _styleId);
  const annMode = (styleMeta && styleMeta.annMode) || (_mode === 'detail' ? 'detail' : 'side');

  if (annMode === 'detail') {
    // 详细注释模式：字幕仅高亮 + 下方注释列表
    const { subtitleHtml, annotationHtml } = buildDetailAnnotationHtml(subtitle.text, anns);
    subtitleEl.innerHTML = subtitleHtml;
    annEl.innerHTML = annotationHtml;
  } else {
    // 侧邻注释模式：字幕中生词高亮 + (释义) 行内
    subtitleEl.innerHTML = buildSideAnnotationHtml(subtitle.text, anns);
    annEl.innerHTML = '';
  }

  // 反思（2026-08-14 第五十四次修正）：渲染前最后确认 _enabled（防止 await 期间被关闭，
  //   或缓存命中时跳过 await 检查导致的残留）。
  if (!_enabled) return;

  _overlay.style.display = 'block';
  updateOverlayPosition();
}

/** 找当前时间对应的字幕条目 */
function findCurrentSubtitle(time) {
  for (const s of _subtitles) {
    if (time >= s.start && time <= s.end) return s;
  }
  return null;
}

/**
 * timeupdate 回调
 * 反思（2026-07-06 v4）：不再在 onTimeUpdate 中调用 updateOverlayPosition。
 *   renderSubtitle 是 async，位置更新由 renderSubtitle 末尾处理。
 *   字幕未变时（key===_lastKey）仅更新位置（视频可能全屏/缩放）。
 */
function onTimeUpdate() {
  if (!_enabled || !_video || !_overlay) return;
  const t = _video.currentTime;
  const sub = findCurrentSubtitle(t);
  const key = sub ? sub.start + ':' + sub.text : '';
  if (key === _lastKey) {
    // 反思（2026-08-19 第八十一次）：无字幕时（key 为空串）不再更新位置——
    //   旧版空 key 恒等于初始 _lastKey=''，每次 timeupdate 都走 updateOverlayPosition，
    //   导致"视频没有字幕也一直打印 '位置更新: video rect='"（用户反馈）。
    //   有字幕时仍需更新位置（全屏/缩放），故仅当 key 非空才刷新位置。
    if (key) updateOverlayPosition();
    return;
  }
  console.log('[VocabRadar][overlay] t=' + t.toFixed(1) + 's 命中: ' + (sub ? '"' + sub.text.slice(0, 30) + '" [' + sub.start + '-' + sub.end + ']' : '无'));
  _lastKey = key;
  renderSubtitle(sub).catch((e) => console.warn('[VocabRadar][overlay] renderSubtitle 失败:', e));
}

/**
 * 启动视频内字幕
 * 反思（2026-07-06 v4）：先调 stopOverlay 清理旧状态，防止 SPA 换集时旧 video 引用残留。
 * @param {HTMLVideoElement} video
 * @param {Array<{start,end,text}>} subtitles
 * @param {{rankThreshold?:number, enabled?:boolean, mode?:string}} options
 */
export function startOverlay(video, subtitles, options = {}) {
  stopOverlay();

  _video = video;
  _subtitles = subtitles;
  _rankThreshold = options.rankThreshold ?? 5000;
  _enabled = options.enabled ?? true;
  _mode = options.mode === 'detail' ? 'detail' : 'side';
  // 注释重复生词（2026-08-15 第六十二次：默认不选）
  _annotateRepeat = options.annotateRepeat === true;

  // 从 storage 读取详略模式（与视频提示同步）
  // 反思（2026-08-05）：视频内字幕的注释模式与视频提示的详略模式共用一个 storage key
  //   sidebar.js 切换详略时写入 subtitleDetailMode，本模块监听变化自动切换
  if (chrome.storage?.local) {
    chrome.storage.local.get({ subtitleDetailMode: false, videoOverlayAnnMode: 'side' }, (res) => {
      // 优先使用独立的 videoOverlayAnnMode，向后兼容 subtitleDetailMode
      const mode = res.videoOverlayAnnMode || (res.subtitleDetailMode ? 'detail' : 'side');
      _mode = mode;
    });
    // 监听 storage 变化，实时同步模式
    _storageListener = (changes, area) => {
      if (area !== 'local') return;
      if (changes.videoOverlayAnnMode) {
        _mode = changes.videoOverlayAnnMode.newValue || 'side';
        _lastKey = ''; // 强制重新渲染
        if (_video && _enabled) onTimeUpdate();
      } else if (changes.subtitleDetailMode && !changes.videoOverlayAnnMode) {
        // 向后兼容：仅在无新 key 时回退
        _mode = changes.subtitleDetailMode.newValue ? 'detail' : 'side';
        _lastKey = '';
        if (_video && _enabled) onTimeUpdate();
      }
      // 反思（2026-08-13 第五十次）：字幕样式由引导页/侧栏写入 subtitleStyle，
      //   监听变化实时应用（无需刷新页面）。
      if (changes.subtitleStyle) {
        setSubtitleStyle(changes.subtitleStyle.newValue);
      }
      // 反思（2026-08-16 第六十九次）：位置样式由引导页写入 subtitlePosition，
      //   监听变化实时应用（top 内联更新，无需重渲染字幕）。
      if (changes.subtitlePosition) {
        setSubtitlePosition(changes.subtitlePosition.newValue);
      }
    };
    chrome.storage.onChanged.addListener(_storageListener);
  }

  // 调试：打印字幕时间戳范围
  if (subtitles && subtitles.length > 0) {
    const ranges = subtitles.map((s) => '[' + s.start + '-' + s.end + ']' + s.text.slice(0, 20)).join(' | ');
    console.log('[VocabRadar][overlay] 字幕 ' + subtitles.length + ' 条: ' + ranges);
    console.log('[VocabRadar][overlay] video.duration=' + video.duration + ' currentTime=' + video.currentTime);
  }

  // 注入样式 + 创建 overlay
  injectOverlayStyles();
  _overlay = createOverlay();
  document.body.appendChild(_overlay);
  // 反思（2026-08-13 第五十次）：应用已保存的字幕样式（引导页/侧栏可设置）
  // 反思（2026-08-15 第六十五次）：走 setSubtitleStyle（含未知样式 id 优雅回退），
  //   不再直接 classList.add 死类（旧删掉的样式 id 会让 overlay 回落黑底）。
  // 反思（2026-08-16 第六十九次）：同时应用已保存的位置样式（subtitlePosition）。
  if (chrome.storage?.local) {
    chrome.storage.local.get({ subtitleStyle: 'none', subtitlePosition: 'b20' }, (res) => {
      setSubtitleStyle(res.subtitleStyle || 'none');
      setSubtitlePosition(res.subtitlePosition || 'b20');
    });
  }
  // 反思（2026-08-16 第七十次）：构建版本 + 生效样式日志——若本日志版本与引导页头部
  //   "vXX" 不一致，即旧构建内容脚本残留（扩展已更新但视频页未重载），
  //   用户反馈"edge 默认样式被改/设定栏没选中"多为这类残留，不必再猜。
  console.log('[VocabRadar][overlay] 构建 v' + BUILD_STAMP + '（引导页头部版本若不同 = 旧构建残留，请重载扩展并刷新视频页）');
  console.log('[VocabRadar][overlay] overlay 已创建（mode=' + _mode + '，style=' + _styleId + '，pos=' + _posId + '）');

  video.addEventListener('timeupdate', onTimeUpdate);

  _scrollHandler = () => updateOverlayPosition();
  window.addEventListener('scroll', _scrollHandler, true);
  window.addEventListener('resize', _scrollHandler);

  // 全屏监听（2026-08-05）：进入全屏时移动 overlay 到全屏元素内部
  // 反思：document.body 上的 position:fixed 元素在全屏时不可见，
  //   必须挂到 fullscreenElement 内部才能显示在视频之上。
  _fullscreenHandler = () => onFullscreenChange();
  document.addEventListener('fullscreenchange', _fullscreenHandler);
  // webkit 前缀兼容（Safari/旧版 Chrome）
  document.addEventListener('webkitfullscreenchange', _fullscreenHandler);
}

/**
 * 替换全部字幕（sidebar updateSubtitles 时同步调用）
 * 反思（2026-08-06）：旧版 video-controller 注释说"subtitleOverlay 已移除"，
 *   导致 overlay 从未启动，全屏字幕不显示。重新启用 overlay 后，
 *   sidebar 的字幕变更（换集/ASR 缓存加载）需同步到 overlay。
 * @param {Array<{start,end,text}>} subtitles
 */
export function setSubtitles(subtitles) {
  _subtitles = Array.isArray(subtitles) ? subtitles : [];
  if (_subtitles.length > 1) {
    _subtitles.sort((a, b) => (a?.start || 0) - (b?.start || 0));
  }
  _annotationsCache.clear();
  _seen.clear();
  _lastKey = '';
  if (_video && _enabled) onTimeUpdate();
}

/**
 * 追加单条字幕（sidebar appendASRSubtitle 时同步调用）
 * 按 start 时间有序插入，不强制重渲染（等 timeupdate 自然触发）
 * @param {{start,end,text}} sub
 */
export function addSubtitle(sub) {
  if (!sub || !sub.text) return;
  const start = (typeof sub.start === 'number' && isFinite(sub.start)) ? sub.start : 0;
  // 二分查找插入位置
  let lo = 0, hi = _subtitles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((_subtitles[mid].start || 0) < start) lo = mid + 1;
    else hi = mid;
  }
  _subtitles.splice(lo, 0, sub);
}

/**
 * 设置开关
 * 反思（2026-08-13 第五十三次）：用户反馈"开关设置即时生效"。
 *   旧版 enabled=false 只隐藏，enabled=true 只设 _enabled——不恢复 display、
 *   不按当前播放时间重渲染，导致开启后视频内无字幕（需等 timeupdate 才恢复）。
 *   修正：开启时立即清除 display:none 并触发一次 onTimeUpdate() 重渲染。
 */
export function setOverlayEnabled(enabled) {
  _enabled = enabled;
  if (!enabled) {
    if (_overlay) _overlay.style.display = 'none';
    return;
  }
  if (_overlay) {
    _lastKey = ''; // 强制重新渲染当前字幕
    _overlay.style.display = '';
    if (_video) onTimeUpdate();
  }
}

/** 设置词频阈值 */
export function setRankThreshold(v) {
  _rankThreshold = v;
  _annotationsCache.clear();
  _seen.clear();
  _lastKey = '';
}

// 全部字幕文字样式类名（配合 setSubtitleStyle 全量清理）
// 反思（2026-08-15 第六十四次）：旧版硬编码 11 种类名，漏掉后续新增样式
//   （bottom-up-white/big-bottom 等 4 种），导致选中的样式类永不应用，
//   overlay 始终回落到默认半透明黑底（用户反馈"透明当作黑色"）。
//   改为由 SUBTITLE_TEXT_STYLES 元数据动态生成，与 styles.js 永不脱节。
// 反思（2026-08-16 第七十一次）：④ 含 'none'（.style-none 显式类）——
//   旧版 filter 掉 'none' 且 setSubtitleStyle 只对非 none 加类，导致"无（默认）"
//   只能靠基础规则兜底；现在选中任何样式（含默认）都有显式类驱动，透明/黑底
//   完全由所选样式元数据决定，不再有"基础规则悄悄给黑底"的隐式行为。
const SUBTITLE_STYLE_CLASSES = SUBTITLE_TEXT_STYLES
  .map((s) => 'style-' + s.id);

/**
 * 应用字幕文字样式
 * 反思（2026-08-13 第五十次）：用户要求"字幕样式选择，选中后样例字幕叠加在视频上"。
 *   storage key: subtitleStyle（'none' 或其他样式名，与 style-{name} 类对应）。
 * 反思（2026-08-15 第六十五次）：样式校验——storage 中的样式 id 若已在
 *   SUBTITLE_TEXT_STYLES 中被移除（旧版本曾删 right-vertical/center-vertical，导致旧选中
 *   值挂死类 → 回落黑底，用户看到"透明当黑色"），现未知 id 优雅回退 'none' 并写回 storage
 *   清理，杜绝死类。
 * @param {string} style 文字样式名，'none' 表示默认（深色半透明条）
 */
export function setSubtitleStyle(style) {
  if (!_overlay) return;
  for (const cls of SUBTITLE_STYLE_CLASSES) {
    _overlay.classList.remove(cls);
  }
  let id = (style && style !== 'none') ? style : 'none';
  if (id !== 'none' && !findStyle(SUBTITLE_TEXT_STYLES, id)) {
    console.warn(`[VocabRadar][overlay] 字幕样式 "${id}" 已不存在，回退默认样式并清理 storage`);
    id = 'none';
    try {
      chrome.storage.local.set({ subtitleStyle: 'none' });
    } catch (e) { /* 清理失败忽略 */ }
  }
  _styleId = id;
  // 反思（2026-08-16 第七十一次）：④ 恒加类——'none' 也加 .style-none（显式黑底条），
  //   不再依赖基础规则隐式兜底，避免"选了透明样式却仍显示黑底"。
  _overlay.classList.add('style-' + _styleId);
  // 反思（2026-08-16 第七十一次）：④ 应用后打印计算样式取证——computed backgroundColor
  //   若为 transparent/rgba(0,0,0,0.75) 即与所选样式一致；若出现未选样式值即类未生效，
  //   便于排查"透明当作黑色"（③ 需要实机对照的日志之一）。
  try {
    const cs = getComputedStyle(_overlay);
    console.log(`[VocabRadar][overlay] 字幕样式已应用: "${_styleId}" 计算背景色=${cs.backgroundColor} 计算字色=${cs.color}`);
  } catch (e) { /* 计算样式取证失败忽略 */ }
  // 字幕样式含"侧邻注释/新行注释"：样式非 none 时注释布局以样式为准
  // 反思（2026-08-14 第五十八次）：切换样式前必须清 _lastKey。
  //   旧版不清导致 onTimeUpdate 里 key===_lastKey 直接 return（缓存跳过渲染），
  //   样式类虽已换但当前字幕 DOM 不重建 →"切换字幕样式不即时生效"。
  _lastKey = '';
  if (_video && _enabled) onTimeUpdate();
}

/**
 * 应用字幕位置样式（距视频底部比例）
 * 反思（2026-08-16 第六十九次）：位置与文字样式解耦。位置由 SUBTITLE_POSITIONS 元数据
 *   （ratio 字段）驱动，updateOverlayPosition 据此计算 top；本函数只更新 _posId 并刷新位置。
 *   storage key: subtitlePosition（'b20' 默认贴底，其他见 SUBTITLE_POSITIONS）。
 * @param {string} posId 位置样式 id
 */
export function setSubtitlePosition(posId) {
  let id = posId || 'b20';
  if (!findStyle(SUBTITLE_POSITIONS, id)) {
    console.warn(`[VocabRadar][overlay] 字幕位置 "${id}" 已不存在，回退默认位置并清理 storage`);
    id = 'b20';
    try {
      chrome.storage.local.set({ subtitlePosition: 'b20' });
    } catch (e) { /* 清理失败忽略 */ }
  }
  _posId = id;
  if (_video && _enabled) onTimeUpdate();
}

/**
 * 设置注释模式（侧邻/详细）
 * @param {string} mode 'side' 或 'detail'
 */
export function setMode(mode) {
  _mode = mode === 'detail' ? 'detail' : 'side';
  _lastKey = ''; // 强制重新渲染
  if (_video && _enabled) onTimeUpdate();
}

/** 停止 */
export function stopOverlay() {
  if (_video) _video.removeEventListener('timeupdate', onTimeUpdate);
  if (_scrollHandler) {
    window.removeEventListener('scroll', _scrollHandler, true);
    window.removeEventListener('resize', _scrollHandler);
    _scrollHandler = null;
  }
  if (_fullscreenHandler) {
    document.removeEventListener('fullscreenchange', _fullscreenHandler);
    document.removeEventListener('webkitfullscreenchange', _fullscreenHandler);
    _fullscreenHandler = null;
  }
  if (_storageListener && chrome.storage?.onChanged) {
    chrome.storage.onChanged.removeListener(_storageListener);
    _storageListener = null;
  }
  if (_overlay) _overlay.remove();
  _overlay = null;
  _video = null;
  _annotationsCache.clear();
  _seen.clear();
  _lastKey = '';
}
