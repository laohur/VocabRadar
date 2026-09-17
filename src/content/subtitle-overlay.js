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
//
// 282次：字幕正文样式全线增强——
//   1. 用户样式（guide 页大加号保存，storage.subtitleUserStyles）由 syncUserStyleRules
//      用独立 <style> 动态重建 style-user-* 规则，声明与 guide 预览同源（styles.js）
//   2. 个性化 custom 规则补 fx 特效三变量（text-shadow/描边/paint-order），
//      setSubtitleCustom 按 subFxDecl 拆分写入
//   3. 字体/特效/用户样式声明收敛共享层 styles.js（本地 SUB_FONTS 已删），
//      setSubtitleStyle 改 'style-' 前缀扫描清理并放行 user-* 前缀
//
// 283次：三处改动——
//   1. 注释模板分键（用户"Annotation template 只会影响当前选中的注释栏"）：本模块
//      只消费 videoOverlayAnnTemplate（第四栏字幕注释专用），不再读全局 annTemplate；
//   2. 首尾生词过滤（用户"注释样式作用于首尾两个单词"=字幕的首尾两个单词选为生词
//      注释）：side/detail 两模式的生词高亮与注释列表都只保留位于句首/句尾 token
//      位置的生词，中段生词不高亮不注释（collectEdgeMatches 统一管线）；
//   3. 个性化样式缺省值对齐（用户"个性化样式默认配置给个能用的样式"）：custom 规则
//      CSS 变量缺省底色 transparent、字号 28px，与 guide 页 Custom 默认值同源。

import { getAnnotations, setRankMax } from '../lib/annotator.js';
// 302次：侧邻注释统一用短释（与各侧邻路径同源；本地旧版只认；已删）
import { pickCleanShortTrans } from '../lib/dict-clean.js';
// 反思（2026-08-13 第五十一次）：字幕样式数据驱动（差异化属性定义在 styles.js SUBTITLE_TEXT_STYLES），
//   CSS 按元数据生成，避免样式定义与元数据不一致。
// 反思（2026-08-16 第六十九次）：文字样式与位置样式解耦——文字外观由 SUBTITLE_TEXT_STYLES，
//   位置（距视频底部比例）由 SUBTITLE_POSITIONS 独立选择（storage.subtitlePosition），
//   位置由 updateOverlayPosition 按 ratio 内联计算，样式类不再含位置。
// 282次：SUB_FONTS/subFontFamily/subFxDecl/buildUserStyleDecl 收敛到共享层 styles.js——
//   字体栈、特效声明、用户样式声明与 guide 页预览同源（预览=真实渲染），删除本文件
//   本地 SUB_FONTS 常量（旧三栈与共享层重复，字体扩列后必然脱节）。
import { SUBTITLE_TEXT_STYLES, SUBTITLE_POSITIONS, POOL_STYLES, SUB_FONTS, findStyle, annDecl, splitAnnTemplate, DEFAULT_ANN_TEMPLATE, BUILD_STAMP, subFontFamily, subFxDecl, buildUserStyleDecl, pxToSizePct, subFontSizePct, ANN_DEFAULT_STYLE, SUB_DEFAULT_STYLE } from '../lib/styles.js';

let _overlay = null;
let _video = null;
let _subtitles = [];             // [{start, end, text}]
let _annotationsCache = new Map(); // text -> annotations
let _seen = new Set();           // 跨字幕去重
let _enabled = true;
let _rankThreshold = 5000;   // 2026-08-14 第五十四次修正：恢复默认 5000
// 注释重复生词（2026-08-15 第六十二次：默认不选，后续出现不包裹不注释）
let _annotateRepeat = false;
// 280次：侧邻注释模板（annBrackets 布尔退役，默认 {word}({meaning})，{word}/{meaning} 均为变量）
// 283次：模板分键——本模块读 videoOverlayAnnTemplate（第四栏字幕注释专用键）
let _annTemplate = DEFAULT_ANN_TEMPLATE;
let _lastKey = '';               // 避免重复渲染
let _scrollHandler = null;       // scroll/resize 监听器
let _mode = 'side';              // 'side'（侧邻注释）或 'detail'（详细注释）
let _styleId = SUB_DEFAULT_STYLE; // 当前字幕文字样式 id（'custom'=个性化；注释布局由 _mode 决定；318次：初值=默认代指常量 SUB_DEFAULT_STYLE）
let _posId = 'b20';              // 当前字幕位置样式 id（距视频底部比例；314次：默认改贴底 1/10；329次：用户裁定改回下 1/5（b20），推翻 314 次裁定）
let _storageListener = null;     // storage 变化监听器（同步详略模式）
let _fullscreenHandler = null;   // fullscreenchange 监听器（全屏时移动 overlay）
let _userStyleSheet = null;      // 282次：用户样式动态 <style> 元素（style-user-* 规则重建用）
let _userStylesCache = [];       // 282次：最近一次同步的用户样式列表（激活样式被删时回落判定）

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
  right: 0;
  top: 0;
  --beaver-first-bg: #2e6b43;
  --beaver-first-fg: #ffffff;
  --beaver-later-bg: #2e6b43;
  --beaver-later-fg: #ffffff;
  color: #fff;
  padding: 8px 14px;
  border-radius: 6px;
  /* 第一百二十七次：默认字号随视频高度自适应——--beaver-sub-fs 由
   * updateOverlayPosition 按视频高×当前样式百分比注入（297次无 clamp；298次短边作废）。
   * 依据：YouTube 默认 ≈24-28px / Netflix 28-32px@1080p / BBC ≈8% 帧高、
   * Captionator polyfill 默认 4.5%；原固定 16px 低于广播下限，用户反馈太小。 */
  font-size: var(--beaver-sub-fs, 24px);
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  pointer-events: none;
  z-index: 2147483647;
  /* 329次（用户"全屏后字幕变窄，挤成一团"根治）：水平居中由
   *  left:视频中心 + transform:translateX(-50%) 改为 left/right 限定视频横切片 +
   *  width:fit-content + margin:0 auto。根因：旧法 width:auto 走 shrink-to-fit，
   *  其可用宽 = 视口宽 − left ≈ 半屏（绝对定位元素右界为 auto 时可用宽从 left 起算），
   *  全屏（视频/视口 1920）时长句在 ~960px 处被迫换行 → 变成窄条挤成一团；
   *  非全屏时可用宽≈视频宽，症状只在全屏暴露（用户日志 video rect 1920 vs 1152）。
   *  新法可用宽 = 视频横切片宽（left/right 由 updateOverlayPosition 内联写入），
   *  长句可铺满视频宽度、短句仍收缩居中。 */
  width: fit-content;
  max-width: 80%;
  margin: 0 auto;
  text-align: center;
  line-height: 1.5;
  display: none;
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
 * 反思（2026-08-16 第六十九次）：删除位置（pos 字段）——位置改由 updateOverlayPosition
 *   按 SUBTITLE_POSITIONS 的 ratio 内联计算，样式类只管外观。
 * 281次：职责分离——正文样式类（style-{id}）只管字幕正文外观；注释行外观由第四栏池
 *   样式类（annstyle-{id}）统一控制，删除旧"bg 透明时注释块强制透明"联动规则
 *  （用户裁定：注释样式由 subtitle hints on video 栏指派，不再跟随正文样式）。
 *   个性化字幕（style-custom）外观走 CSS 变量（setSubtitleCustom 写入内联值）。
 * @returns {string} CSS 规则文本
 */
// 293次：当前样式的字号百分比（字号=视频高×pct；custom/用户样式各取其值）。
// 297次缺省默认 5%（298次：基线改回统一视频高，短边作废）。
let _sizePct = 5;
let _diagLastFs = null;   // 309次第四轮：字号诊断日志限频（fs 变化才打一条，防 timeupdate 刷屏）
let _customPct = 5;
function sizePctOfStyle(id) {
  if (id === 'custom') return _customPct;
  if (id && id.indexOf('user-') === 0) {
    const st = _userStylesCache.find((s) => s.id === id);
    if (st) return subFontSizePct(st);
  }
  // 309次第五轮（用户"默认的字幕样式字号非常大，其他样式正常"）根因实锤：
  //   旧条件 id !== 'none' 把默认样式（none 条目，fontSizePct:5）跳过，掉到兜底 7——
  //   默认 7% vs 其他样式 4-6%，恰是"默认偏大、比值看着差不多"（设定 UI 显示同表 pct）。
  //   去掉排除条件：findStyle 对 'none' 同样命中条目，返回其自带 fontSizePct。
  if (id) {
    const s = findStyle(SUBTITLE_TEXT_STYLES, id);
    if (s) return subFontSizePct(s);
  }
  return 7;
}
function refreshActivePct() { _sizePct = sizePctOfStyle(_styleId); }

function buildSubtitleStyleCss() {
  // 正文样式规则（none + 内置）：字体/颜色/背景/描边/粗细来自元数据；
  // 293次：字号不再写死 px（旧 size 固定值小屏大、大屏小），统一走基础层
  //   var(--beaver-sub-fs)——updateOverlayPosition 按视频高×当前样式 sizePct 注入。
  const textRules = SUBTITLE_TEXT_STYLES.map((s) => {
    const parts = [];
    parts.push('background:' + (s.bg || 'transparent'));
    parts.push('color:' + s.fg);
    parts.push('font-family:' + (SUB_FONTS[s.font] || SUB_FONTS.sans));
    parts.push('border-radius:4px');
    parts.push('max-width:90%');
    // 281次：weight 优先于 bold（edge-white-bold 用 800）
    if (s.weight) parts.push('font-weight:' + s.weight);
    else if (s.bold) parts.push('font-weight:600');
    if (s.italic) parts.push('font-style:italic');
    if (s.edge) parts.push('-webkit-text-stroke:1px ' + s.edge);
    // 反思（2026-08-15 第六十四次）：shadow 字段支持字符串（自定义 text-shadow），true 用默认黑投影
    if (s.shadow) parts.push('text-shadow:' + (typeof s.shadow === 'string' ? s.shadow : '0 0 6px rgba(0,0,0,.9)'));
    return '#beaver-subtitle-overlay.style-' + s.id + '{' + parts.join(';') + ';}';
  }).join('\n');

  // 281次：个性化字幕规则（guide 页控件：底色/字色/字号/字体），变量缺省值与默认一致。
  // 282次：补 fx 特效三变量（text-shadow/描边/paint-order），setSubtitleCustom 按
  //   subFxDecl(c.fx) 拆分写入；缺省值须合法——'none' 对 -webkit-text-stroke 非法，
  //   描边缺省用 '0 transparent'，投影缺省 'none'，paint-order 缺省 'normal'。
  // 283次：缺省值对齐 guide 页 Custom 默认（用户"默认底色为透明，不小的字体"）——
  //   bg 缺省 transparent（guide.js _subCustom 同源；旧 storage 残留已由 guide 首次写回兜底）。
  // 293次：字号不再自带变量（旧 --beaver-custom-fs），与内置/用户样式一样走基础层
  //   var(--beaver-sub-fs)（按视频高×custom sizePct 注入），setSubtitleCustom 只存百分比。
  const customRule = '#beaver-subtitle-overlay.style-custom{' +
    'background:var(--beaver-custom-bg,transparent);' +
    'color:var(--beaver-custom-fg,#ffffff);' +
    'font-family:var(--beaver-custom-ff,' + SUB_FONTS.sans + ');' +
    'text-shadow:var(--beaver-custom-tsh,none);' +
    '-webkit-text-stroke:var(--beaver-custom-stroke,0 transparent);' +
    'paint-order:var(--beaver-custom-po,normal);' +
    'border-radius:4px;max-width:90%;}';

  // 281次：注释行样式规则（第四栏池 annstyle-{id}）——annDecl 输出过滤 font-size
  //  （池条目 12-15px 是侧栏语境，字幕注释行统一 0.9em 基准），词头加粗 600 与基础层一致
  const annRules = POOL_STYLES
    .filter((s) => s.id)
    .map((s) => {
      const decl = annDecl(s).filter((d) => !d.startsWith('font-size')).join(';');
      if (!decl) return '';
      const sel = '#beaver-subtitle-overlay.annstyle-' + s.id;
      return sel + ' .beaver-overlay-subtitle .beaver-side-ann,' +
        sel + ' .beaver-overlay-ann-word,' +
        sel + ' .beaver-overlay-ann-trans{' + decl + ';}' +
        sel + ' .beaver-overlay-ann-word{font-weight:600;}';
    })
    .filter(Boolean)
    .join('\n');

  return textRules + '\n' + customRule + '\n' + annRules;
}

/**
 * 282次：重建用户字幕正文样式规则（guide 页大加号保存的样式，storage.subtitleUserStyles）
 * 反思：用户样式条目动态增删，静态清单（SUBTITLE_STYLE_CLASSES）必然滞后，
 *   改用独立 <style> 元素整表重写——声明由共享层 buildUserStyleDecl 生成，
 *   与 guide 预览（subCard/buildSubBoxCss）同源，预览=真实渲染。
 * 同步缓存 _userStylesCache 供 storage 监听判定「激活样式被删除」。
 * @param {Array<{id:string,bg?:string,fg?:string,sizePct?:number,fontSize?:number,fontFamily?:string,fx?:string}>} list
 */
function syncUserStyleRules(list) {
  _userStylesCache = Array.isArray(list) ? list.filter((st) => st && typeof st.id === 'string' && st.id.indexOf('user-') === 0) : [];
  // 293次：用户规则字号同样走 --beaver-sub-fs 实时变量（静态表无法跟视频高），此处过滤
  //   font-size 声明（旧值残留经 subFontSizePct 在 refreshActivePct 内换算）。
  refreshActivePct();
  if (!document.head) return;
  if (!_userStyleSheet) {
    _userStyleSheet = document.createElement('style');
    _userStyleSheet.id = 'beaver-subtitle-user-styles';
    document.head.appendChild(_userStyleSheet);
  }
  const css = _userStylesCache.map((st) => {
    const decl = buildUserStyleDecl(st).filter((d) => d.indexOf('font-size') !== 0);
    decl.push('border-radius:4px');
    decl.push('max-width:90%');
    return '#beaver-subtitle-overlay.style-' + st.id + '{' + decl.join(';') + ';}';
  }).join('\n');
  _userStyleSheet.textContent = css;
}

/**
 * 根据 video.getBoundingClientRect() 更新 overlay 位置
 * overlay 水平居中于视频（left/right 限定视频横切片），垂直在视频底部 8% 处
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
  // 329次：兜底 ratio 随默认位置改 0.2（下 1/5；314 次曾为 0.1）
  const ratio = (posMeta && typeof posMeta.ratio === 'number') ? posMeta.ratio : 0.2;
  // 329次（用户"全屏后字幕变窄，挤成一团"根治）：水平方向由
  //   left:视频中心 + transform:translateX(-50%) 改为 left/right 限定视频横切片，
  //   配合基础样式 width:fit-content + margin:0 auto 居中。根因见基础样式注释。
  //   left = 视频左边界，right = 视口宽 − 视频右边界 → 切片宽恒等于视频宽，
  //   overlay 可用宽不再被"视口宽 − left ≈ 半屏"卡死，长句可铺满视频宽度。
  _overlay.style.left = Math.max(0, rect.left) + 'px';
  _overlay.style.right = Math.max(0, window.innerWidth - rect.right) + 'px';
  // 第一百二十七次：默认字号随视频高度自适应（Captionator polyfill 同款比例）。
  // 293次：全部样式统一按当前样式百分比换算（预设固定 px 已退役）。
  // 297次 clamp 删除（用户"clamp 不是失真么"）——大小屏纯比例；缺省默认 5%。
  // 298次（用户笔误纠正）：基线改回统一视频高（短边方案作废）。
  {
    const pct = (typeof _sizePct === 'number' && isFinite(_sizePct)) ? _sizePct : 5;
    const fs = Math.round(rect.height * pct / 100);
    _overlay.style.setProperty('--beaver-sub-fs', fs + 'px');
    // 309次第四轮诊断（用户"字幕字体比设定大很多"）：静态链路无错（YouTube/Netflix/WebVTT
    //   ::cue 默认同为"显示高度×百分比"口径），加限频日志实测定案——仅在算出的 fs 变化时
    //   打一条（timeupdate/scroll 高频路径不刷屏，302 次教训），输出三要素：
    //   视频显示高 rect.height、百分比 pct 及来源样式 id。用户贴日志即可判别
    //   "显示高异常（选错 video 元素）/ pct 未随设定更新 / 纯比例观感问题"。
    if (fs !== _diagLastFs) {
      _diagLastFs = fs;
      console.log(`[VocabRadar][overlay] 字号: ${fs}px = 视频显示高 ${Math.round(rect.height)}px × ${pct}%（样式=${_styleId}）`);
    }
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
  if (fsEl) {
    // 进入全屏：将 overlay 挂到全屏元素内部
    if (_overlay.parentElement !== fsEl) {
      fsEl.appendChild(_overlay);
    }
  } else {
    // 退出全屏：移回 body
    if (_overlay.parentElement !== document.body) {
      document.body.appendChild(_overlay);
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

// 302次（用户"侧邻注释都用短释"）：本地旧版只认 ；，radar 例漏网——
//   改共享 pickCleanShortTrans（宽分隔符，与各侧邻路径同源），本地函数删除。
//   （detail 列表仍全量 join，179次"详细全列"口径不变）

/**
 * 283次：首尾生词筛选管线（side/detail 两模式共用）——
 * 用户裁定"注释样式作用于首尾两个单词"= 字幕的首尾两个单词选为生词注释：
 * 只有位于句首/句尾 token 位置的生词才高亮/注释，中段生词不再处理。
 * 管线：过滤重复生词 → \bword\b 定位 → 排序去重叠 → 与首/尾 token 边界完全一致者保留。
 * token 提取正则：[A-Za-z][A-Za-z'’-]*（g 标志全局匹配；撇号/连字覆盖缩略与所有格，如 don't、teacher's）。
 * （283次自查：JSDoc 内不能出现「星号+斜杠」相邻序列——正则原样粘贴会让块注释提前闭合，
 *   后续中文说明被当作代码导致 esbuild/terser 构建失败，故此处以文字描述正则。）
 * @param {string} text 字幕文本
 * @param {Array} anns 注解数组
 * @returns {Array<{start:number,end:number,word:string,ann:object}>} 首尾生词匹配
 */
function collectEdgeMatches(text, anns) {
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
  // 首尾过滤：句首/句尾 token 的边界区间（单 token 时首尾同一区间，去重）
  const tokens = [...text.matchAll(/[A-Za-z][A-Za-z'’-]*/g)];
  if (!tokens.length) return [];
  const firstTok = tokens[0];
  const lastTok = tokens[tokens.length - 1];
  const edges = [[firstTok.index, firstTok.index + firstTok[0].length]];
  if (lastTok !== firstTok) edges.push([lastTok.index, lastTok.index + lastTok[0].length]);
  return valid.filter((m) => edges.some(([s, e]) => m.start === s && m.end === e));
}

/**
 * 构建侧邻注释 HTML：生词高亮 + (释义) 行内
 * 283次：生词集合先经 collectEdgeMatches 首尾过滤——只有句首/句尾生词参与渲染
 * @param {string} text 字幕文本
 * @param {Array} anns 注解数组
 * @returns {string} HTML 字符串
 */
function buildSideAnnotationHtml(text, anns) {
  if (!anns || anns.length === 0) return escapeHtml(text);
  // 283次：首尾生词筛选（collectEdgeMatches，见上）——中段生词不高亮不注释
  const valid = collectEdgeMatches(text, anns);
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
      const trans = pickCleanShortTrans(ann.translations);
      if (trans) {
        // 280次：注释文本按模板拼装（{word}/{meaning} 变量，模板前后缀为字面量；
        //   侧邻只渲染释义段，{word} 变量丢弃——词本身已在高亮 span 中）
        const { pre, post } = splitAnnTemplate(_annTemplate);
        html += '<span class="beaver-side-ann">' + escapeHtml(pre) + escapeHtml(trans) + escapeHtml(post) + '</span>';
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
  // 字幕正文：仅高亮生词，不加行内注释（buildSideAnnotationHtml 内已做首尾过滤）
  const subtitleHtml = buildSideAnnotationHtml(text, anns.map(a => ({ ...a, translations: [] })));
  // 283次（用户"注释样式作用于首尾两个单词"）：注释列表同样只保留首尾生词——
  //   与字幕高亮走同一 collectEdgeMatches 管线，保证列表与高亮词完全一致
  const edgeWords = new Set(collectEdgeMatches(text, anns).map((m) => m.word.toLowerCase()));
  // 注释列表：每个生词一行（词头+释义）
  let annotationHtml = '';
  const usedWords = new Set();
  for (const a of anns) {
    const lower = (a.word || '').toLowerCase();
    if (!edgeWords.has(lower)) continue;
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

  // 281次：注释布局只由详略开关(_mode)决定——旧逻辑"正文字样式的 annMode 优先"在新
  //   10 条内置样式（annMode 全为 'side'）下会压过用户切换的详细注释（缺陷预防修正）。
  const annMode = _mode === 'detail' ? 'detail' : 'side';

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
  // 274次：每秒 timeupdate 的"命中"调试日志删除（用户："打印全部字幕干啥"——刷屏无益）
  _lastKey = key;
  renderSubtitle(sub).catch((e) => console.warn('[VocabRadar][overlay] renderSubtitle 失败:', e));
}

/**
 * 启动视频内字幕
 * 反思（2026-07-06 v4）：先调 stopOverlay 清理旧状态，防止 SPA 换集时旧 video 引用残留。
 * @param {HTMLVideoElement} video
 * @param {Array<{start,end,text}>} subtitles
 * @param {{rankThreshold?:number, rankThresholdMax?:number, enabled?:boolean, mode?:string}} options
 */
export function startOverlay(video, subtitles, options = {}) {
  stopOverlay();

  _video = video;
  _subtitles = subtitles;
  _rankThreshold = options.rankThreshold ?? 5000;
  // 词频范围上界（storage.rankThresholdMax；0/缺省=不限制），annotator 模块级生效
  setRankMax(options.rankThresholdMax);
  _enabled = options.enabled ?? true;
  _mode = options.mode === 'detail' ? 'detail' : 'side';
  // 注释重复生词（2026-08-15 第六十二次：默认不选）
  _annotateRepeat = options.annotateRepeat === true;
  // 280次：注释模板兜底（真实值下方从 storage 异步读取覆盖）
  // 283次：分键后本模块只读 videoOverlayAnnTemplate（第四栏字幕注释专用）
  _annTemplate = DEFAULT_ANN_TEMPLATE;

  // 从 storage 读取详略模式（与视频提示同步）
  // 反思（2026-08-05）：视频内字幕的注释模式与视频提示的详略模式共用一个 storage key
  //   sidebar.js 切换详略时写入 subtitleDetailMode，本模块监听变化自动切换
  if (chrome.storage?.local) {
    // 280次：初始读取注释模板（与详略模式同批读取，原 annBrackets）
    // 283次：模板分键——annTemplate → videoOverlayAnnTemplate
    chrome.storage.local.get({ subtitleDetailMode: false, videoOverlayAnnMode: 'side', videoOverlayAnnTemplate: DEFAULT_ANN_TEMPLATE }, (res) => {
      // 优先使用独立的 videoOverlayAnnMode，向后兼容 subtitleDetailMode
      const mode = res.videoOverlayAnnMode || (res.subtitleDetailMode ? 'detail' : 'side');
      _mode = mode;
      if (typeof res.videoOverlayAnnTemplate === 'string' && res.videoOverlayAnnTemplate.trim()) _annTemplate = res.videoOverlayAnnTemplate;
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
      // 281次：注释样式（第四栏池指派）与个性化字幕热更新——引导页改动即时生效
      // 318次：newValue 若为 'none'（旧端残留写入）清洗回落默认代指常量
      //   ANN_DEFAULT_STYLE（注释样式默认由该常量锚定）
      if (changes.videoOverlayAnnStyle) {
        const nv = changes.videoOverlayAnnStyle.newValue;
        setVideoOverlayAnnStyle(nv === 'none' ? ANN_DEFAULT_STYLE : nv);
      }
      // 301次：个性化/用户注释规则热更新（类名不变即时生效）
      if (changes.annotationCustom || changes.annotationUserStyles) {
        chrome.storage.local.get({ annotationCustom: null, annotationUserStyles: [] }, (res) => {
          syncAnnCustomRules(res.annotationCustom, res.annotationUserStyles);
        });
      }
      if (changes.subtitleCustom) {
        setSubtitleCustom(changes.subtitleCustom.newValue);
      }
      // 282次：用户字幕正文样式（大加号保存/删除）热更新——整表重建 style-user-* 规则；
      //   若当前激活样式被删除则回落默认（guide 端删除选中项时会写 subtitleStyle，
      //   此处兜底防其他入口删除时激活类悬空）。
      if (changes.subtitleUserStyles) {
        syncUserStyleRules(changes.subtitleUserStyles.newValue);
        if (_styleId && _styleId.indexOf('user-') === 0 &&
            !_userStylesCache.some((s) => s.id === _styleId)) {
          setSubtitleStyle(SUB_DEFAULT_STYLE);   // 318次：回落默认代指常量（版本变化才改常量值）
        }
      }
      // 280次：注释模板热更新——前后缀变化需强制重渲染（原 annBrackets）
      // 283次：模板分键——本模块只响应 videoOverlayAnnTemplate（其他栏的模板不波及）
      if (changes.videoOverlayAnnTemplate) {
        if (typeof changes.videoOverlayAnnTemplate.newValue === 'string' && changes.videoOverlayAnnTemplate.newValue.trim()) _annTemplate = changes.videoOverlayAnnTemplate.newValue;
        _lastKey = '';
        if (_video && _enabled) onTimeUpdate();
      }
    };
    chrome.storage.onChanged.addListener(_storageListener);
  }

  // 调试日志（274次删除，用户："打印全部字幕干啥"）——旧版把全部字幕逐条 join 打印，
  // 283 条字幕即刷一屏；每秒 timeupdate 的"命中"日志一并移除（需要时用诊断工具现场取）。

  // 注入样式 + 创建 overlay
  injectOverlayStyles();
  _overlay = createOverlay();
  document.body.appendChild(_overlay);
  // 反思（2026-08-13 第五十次）：应用已保存的字幕样式（引导页/侧栏可设置）
  // 反思（2026-08-15 第六十五次）：走 setSubtitleStyle（含未知样式 id 优雅回退），
  //   不再直接 classList.add 死类（旧删掉的样式 id 会让 overlay 回落黑底）。
  // 反思（2026-08-16 第六十九次）：同时应用已保存的位置样式（subtitlePosition）。
  if (chrome.storage?.local) {
    // 281次：初始读取补个性化字幕（subtitleCustom）与注释样式（videoOverlayAnnStyle）
    // 282次：再补用户样式表（subtitleUserStyles）——须先重建 style-user-* 规则，
    //   再应用激活样式（激活值可能是 user-*，规则就绪后类一挂即生效）
    // 309次第五轮（用户四栏统一裁定）：videoOverlayAnnStyle 兜底默认
    // 318次：兜底/回落改默认代指常量（317 次的 annDefaultStyle/subDefaultStyle 指针键撤销）
    chrome.storage.local.get({ subtitleStyle: SUB_DEFAULT_STYLE, subtitlePosition: 'b20', subtitleCustom: null, videoOverlayAnnStyle: ANN_DEFAULT_STYLE, subtitleUserStyles: [] }, (res) => {
      syncUserStyleRules(res.subtitleUserStyles);
      setSubtitleStyle(res.subtitleStyle || SUB_DEFAULT_STYLE);
      // 316次：videoOverlayAnnStyle 读数清洗——池中 none 卡已删，残留 'none' 统一落
      //   默认代指常量 ANN_DEFAULT_STYLE（与引导页口径一致）；subtitlePosition 的
      //   旧 't10' 残留由 setSubtitlePosition 内迁移为 b90（见该函数）。
      setSubtitlePosition(res.subtitlePosition || 'b20');   // 314次：默认贴底 1/10；329次：默认改回下 1/5（b20）
      if (res.subtitleCustom) setSubtitleCustom(res.subtitleCustom);
      setVideoOverlayAnnStyle(res.videoOverlayAnnStyle === 'none' ? ANN_DEFAULT_STYLE : (res.videoOverlayAnnStyle || ANN_DEFAULT_STYLE));
    });
    // 301次：个性化/用户注释规则初始同步（与正文用户样式表同构，独立键）
    chrome.storage.local.get({ annotationCustom: null, annotationUserStyles: [] }, (res) => {
      syncAnnCustomRules(res.annotationCustom, res.annotationUserStyles);
    });
  }
  // 反思（2026-08-16 第七十次）：构建版本 + 生效样式日志——若本日志版本与引导页头部
  //   "vXX" 不一致，即旧构建内容脚本残留（扩展已更新但视频页未重载），
  //   用户反馈"edge 默认样式被改/设定栏没选中"多为这类残留，不必再猜。
  console.log('[VocabRadar][overlay] 构建 ' + BUILD_STAMP + '（引导页头部版本若不同 = 旧构建残留，请重载扩展并刷新视频页）');
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

/** 设置词频范围上界（storage.rankThresholdMax 变化时调用；0/缺省=不限制） */
export function setRankThresholdMax(v) {
  setRankMax(v);
  _annotationsCache.clear();
  _seen.clear();
  _lastKey = '';
}

// 282次：删除静态类名清单 SUBTITLE_STYLE_CLASSES——用户样式（style-user-*）动态增删，
//   静态清单必然滞后；setSubtitleStyle 改为按 'style-' 前缀扫描清理（与
//   setVideoOverlayAnnStyle 的 'annstyle-' 前缀扫描同一手法），永不脱节。

/**
 * 应用字幕文字样式
 * 反思（2026-08-13 第五十次）：用户要求"字幕样式选择，选中后样例字幕叠加在视频上"。
 *   storage key: subtitleStyle（值=池内样式 id，与 style-{name} 类对应；318次：
 *   旧 'none' 存量非法，入参处统一迁移为默认代指样式，见下方 856 行注释）。
 * 反思（2026-08-15 第六十五次）：样式校验——storage 中的样式 id 若已在
 *   SUBTITLE_TEXT_STYLES 中被移除（旧版本曾删 right-vertical/center-vertical，导致旧选中
 *   值挂死类 → 回落黑底，用户看到"透明当黑色"），现未知 id 优雅回落并写回 storage
 *   清理，杜绝死类。
 * 318次：回落目标为默认代指常量 SUB_DEFAULT_STYLE（317 次指针撤销，版本变化才改常量值）。
 * @param {string} style 文字样式名（样式池 id；空值/旧 'none' 迁移为默认样式）
 */
export function setSubtitleStyle(style) {
  if (!_overlay) return;
  // 282次：'style-' 前缀扫描清理（原静态清单 SUBTITLE_STYLE_CLASSES 已删，
  //   用户样式 style-user-* 动态增删，前缀扫描永不漏清）
  for (const cls of Array.from(_overlay.classList)) {
    if (cls.indexOf('style-') === 0) _overlay.classList.remove(cls);
  }
  // 318次：存量 'none'（旧白字贴底 id，用户裁定非法全清）一次性迁移为实名
  //   'white-bottom'（SUB_DEFAULT_STYLE 常量锚定）；空值同落默认常量。
  let id = (style === 'none' || !style) ? SUB_DEFAULT_STYLE : style;
  // 281次：'custom'（个性化字幕，CSS 变量驱动）为合法 id，不参与存在性校验
  // 282次：user-* 前缀（guide 页大加号保存的用户样式，规则由 syncUserStyleRules 重建）
  //   同为合法 id——CSS 表动态生成，无法用 findStyle 校验，直接放行
  const isUserStyle = typeof id === 'string' && id.indexOf('user-') === 0;
  if (id !== 'custom' && !isUserStyle && !findStyle(SUBTITLE_TEXT_STYLES, id)) {
    console.warn(`[VocabRadar][overlay] 字幕样式 "${id}" 已不存在，回退默认样式并清理 storage`);
    // 318次：回落默认代指常量 SUB_DEFAULT_STYLE（白字贴底，版本变化才改常量值）
    id = SUB_DEFAULT_STYLE;
    try {
      chrome.storage.local.set({ subtitleStyle: id });
    } catch (e) { /* 清理失败忽略 */ }
  }
  _styleId = id;
  refreshActivePct();   // 293次：切换样式即刷新字号百分比（随后 onTimeUpdate 经 updateOverlayPosition 落 px）
  // 反思（2026-08-16 第七十一次）：④ 恒加类——默认样式也显式加 .style-white-bottom
  //   （318 次前为 .style-none，显式黑底条），不再依赖基础规则隐式兜底，
  //   避免"选了透明样式却仍显示黑底"。
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
 *   storage key: subtitlePosition（'b20' 默认下 1/5，329次起；其他见 SUBTITLE_POSITIONS）。
 * @param {string} posId 位置样式 id
 */
export function setSubtitlePosition(posId) {
  let id = posId || 'b20';
  // 316次：'t10'（原顶部 1/10，316 次改名 b90 延续 b 系列命名）存量迁移——
//   落 b90 保持视觉位置不变；不迁的话 b90 已入池、t10 查不到会被当未知 id 回落默认（329次起 b20），
//   用户选好的"顶部 1/10"会无端跳回下 1/5。
  if (id === 't10') id = 'b90';
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
 * 281次：应用个性化字幕样式（guide 页四控件：底色/字色/字号/字体）
 * 外观走 CSS 变量（buildSubtitleStyleCss 生成的 style-custom 规则消费），
 * 变量写入 overlay 内联 style；字号/字体变化会改变 overlay 尺寸，custom 激活时
 * 清 _lastKey 强制重渲染（渲染末尾会 updateOverlayPosition 重定位）。
 * @param {{bg?:string, fg?:string, fontSizePct?:number, sizePct?:number, fontSize?:number, fontFamily?:string}|null} c
 */
export function setSubtitleCustom(c) {
  if (!_overlay || !c || typeof c !== 'object') return;
  // 283次：缺省对齐引导页新默认（透明底；旧 storage 残留由 guide 首次写回兜底）。
  // 293次：字号改百分比，经 refreshActivePct 进入 --beaver-sub-fs 实时变量
  //   （--beaver-custom-fs 退役）。295次：参数名 fontSizePct（过渡 sizePct 与旧 fontSize 照收）。
  _overlay.style.setProperty('--beaver-custom-bg', c.bg || 'transparent');
  _overlay.style.setProperty('--beaver-custom-fg', c.fg || '#ffffff');
  _customPct = (typeof c.fontSizePct === 'number' && isFinite(c.fontSizePct))
    ? Math.min(12, Math.max(2, c.fontSizePct))
    : ((typeof c.sizePct === 'number' && isFinite(c.sizePct))
      ? Math.min(12, Math.max(2, c.sizePct)) : pxToSizePct(c.fontSize));
  refreshActivePct();
  _overlay.style.setProperty('--beaver-custom-ff', subFontFamily(c.fontFamily));
  // 282次：fx 特效拆分写三变量（style-custom 规则消费，见 buildSubtitleStyleCss）。
  //   subFxDecl 输出形如 'text-shadow:…' 或 '-webkit-text-stroke:…;paint-order:…'，
  //   按「属性名:」前缀分发到对应变量；fx 无效/none 时回写合法缺省值
  //  （描边缺省须 '0 transparent'，'none' 对 -webkit-text-stroke 非法），
  //   保证特效从有→无切换时正确清除残留。
  const fxDecls = {};
  const fxd = subFxDecl(c.fx);
  if (fxd) {
    for (const d of fxd.split(';')) {
      const i = d.indexOf(':');
      if (i > 0) fxDecls[d.slice(0, i)] = d.slice(i + 1);
    }
  }
  _overlay.style.setProperty('--beaver-custom-tsh', fxDecls['text-shadow'] || 'none');
  _overlay.style.setProperty('--beaver-custom-stroke', fxDecls['-webkit-text-stroke'] || '0 transparent');
  _overlay.style.setProperty('--beaver-custom-po', fxDecls['paint-order'] || 'normal');
  if (_styleId === 'custom') {
    _lastKey = '';
    if (_video && _enabled) onTimeUpdate();
  }
}

/**
 * 301次：个性化/用户注释规则表（#beaver-ann-custom-css 独立元素；annDecl 输出，
 *   font-size 照既有口径过滤；custom 对象拼 id，用户条目直用）。
 */
let _annCustomSheet = null;
export function syncAnnCustomRules(customObj, userList) {
  const rules = [];
  const pushEntry = (entry, id) => {
    const decl = annDecl(entry).filter((d) => !d.startsWith('font-size')).join(';');
    if (!decl) return;
    const sel = '#beaver-subtitle-overlay.annstyle-' + id;
    rules.push(sel + ' .beaver-overlay-subtitle .beaver-side-ann,' +
      sel + ' .beaver-overlay-ann-word,' +
      sel + ' .beaver-overlay-ann-trans{' + decl + ';}');
    rules.push(sel + ' .beaver-overlay-ann-word{font-weight:600;}');
  };
  if (customObj && typeof customObj === 'object') {
    pushEntry(Object.assign({ id: 'ann-custom' }, customObj), 'ann-custom');
  }
  if (Array.isArray(userList)) {
    for (const st of userList) {
      if (st && typeof st.id === 'string' && st.id.indexOf('ann-user-') === 0) pushEntry(st, st.id);
    }
  }
  if (!_annCustomSheet) {
    if (!document.head) return;
    _annCustomSheet = document.createElement('style');
    _annCustomSheet.id = 'beaver-ann-custom-css';
    document.head.appendChild(_annCustomSheet);
  }
  _annCustomSheet.textContent = rules.join('\n');
}

/**
 * 281次：应用视频中字幕的注释样式（第四栏池指派，storage.videoOverlayAnnStyle）
 * 注释行外观由 annstyle-{id} 类统一控制（规则见 buildSubtitleStyleCss），
 * 纯外观切换，CSS 即时作用于现有 DOM，无需重渲染字幕。
 * 301次：ann-custom/ann-user-* 同样挂类（规则由 syncAnnCustomRules 提供）。
 * 316次：池中 none 卡已删；'none' 入参仅作防御（视为未知值回退基础外观），
 *   正常调用方（初始读取/onChanged）已先把 'none' 清洗为默认代指样式。
 * @param {string} id 池样式 id
 */
export function setVideoOverlayAnnStyle(id) {
  if (!_overlay) return;
  for (const cls of Array.from(_overlay.classList)) {
    if (cls.indexOf('annstyle-') === 0) _overlay.classList.remove(cls);
  }
  const known = (id === 'ann-custom') || (id && id.indexOf('ann-user-') === 0);
  const s = (id && id !== 'none') ? (known ? { id } : findStyle(POOL_STYLES, id)) : null;
  if (id && id !== 'none' && !s) {
    console.warn(`[VocabRadar][overlay] 字幕注释样式 "${id}" 已不存在，回落默认样式 "${ANN_DEFAULT_STYLE}"`);
    setVideoOverlayAnnStyle(ANN_DEFAULT_STYLE);   // 318次：回落默认代指常量（版本变化才改常量值，递归深度 1）
    return;
  }
  if (s) _overlay.classList.add('annstyle-' + id);
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
