// 视频内字幕：在视频上叠加私有 overlay，支持侧邻注释和详细注释两种模式
//
// 功能：
//   1. 监听 video.timeupdate，找到当前字幕条目并注解
//   2. 侧邻注释模式（默认）：字幕中生词高亮 + (释义) 行内显示
//   3. 详细注释模式：字幕仅高亮生词，下方排列单词注释（词头+释义）
//   4. 配色复用 CSS 变量（--beaver-first-bg/fg, --beaver-later-bg/fg, --beaver-ann-bg/fg）
//      与文本提示、视频提示共用同一套配色变量，改色一处全局生效
//
// 模式控制：
//   通过 chrome.storage.local 的 subtitleDetailMode 控制
//   false（默认）= 侧邻注释，true = 详细注释
//   与视频提示（sidebar.js）的详略模式同步：sidebar 切换详略时写入 storage，
//   本模块监听 storage 变化自动切换渲染模式
//
// 设计要点：
//   - overlay 为 light DOM（非 Shadow），复用 :root CSS 变量
//   - 注解缓存（_annotationsCache）避免重复查词
//   - 跨字幕去重（_seen）
//   - renderSubtitle 是 async，位置更新必须放在渲染末尾，
//     否则 offsetHeight=0 导致位置错位
//
// 样式与模板：
//   1. 用户样式（guide 页大加号保存，storage.subtitleUserStyles）由 syncUserStyleRules
//      用独立 <style> 动态重建 style-user-* 规则，声明与 guide 预览同源（styles.js）
//   2. 注释模板分键（用户需求：注释模板只影响当前选中的注释栏）：本模块
//      只消费 videoOverlayAnnTemplate（第四栏字幕注释专用），不读全局 annTemplate
//   3. 生词口径与视频侧栏统一：全部生词全高亮全注释，无首尾过滤
//      （collectAnnotateMatches 统一管线）
//   4. 个性化 custom 规则补 fx 特效三变量（text-shadow/描边/paint-order），
//      setSubtitleCustom 按 subFxDecl 拆分写入；缺省底色 transparent、
//      字号 28px，与 guide 页 Custom 默认值同源
//   5. 字体/特效/用户样式声明收敛共享层 styles.js，与 guide 页预览同源
//      （预览=真实渲染），本地不再维护重复常量

import { getAnnotations, setRankMax, setMyWords } from '../lib/annotator.js';
// 渲染端词面定位（Unicode 词界/CJK 子串，修 ASCII \b 对重音/CJK 词失配——2026-10-05）
import { findWordPositions } from '../lib/tokenizer.js';
// 视频内字幕注释的翻译优先级档（2=视频侧栏，先于网页正文批量）
import { PRIO_VIDEO } from '../lib/translator.js';
// 第514次双语字幕：整句译文取数与会话缓存唯一实现（lib/bilingual-trans.js，
// 与视频侧栏字幕面板共用同一缓存与语言对监听）
import { fetchBilingualTrans } from '../lib/bilingual-trans.js';
// 侧邻注释统一用短释（与各侧邻路径同源）
import { pickCleanShortTrans } from '../lib/dict-clean.js';
// 词典就绪态（缓存守卫/时间线上报）+ 诊断记录器
import { isLoaded } from '../lib/dictionary.js';
import { reportSubtitle } from '../lib/ann-diag.js';
// 字幕样式数据驱动：差异化属性定义在 styles.js SUBTITLE_TEXT_STYLES，CSS 按元数据生成，
//   避免样式定义与元数据不一致；文字样式与位置样式解耦——文字外观由 SUBTITLE_TEXT_STYLES，
//   位置（距视频底部比例）由 SUBTITLE_POSITIONS 独立选择（storage.subtitlePosition），
//   位置由 updateOverlayPosition 按 ratio 内联计算，样式类不含位置。
import { SUBTITLE_TEXT_STYLES, POOL_STYLES, SUB_FONTS, findStyle, wordDecl, annDecl, splitAnnTemplate, DEFAULT_ANN_TEMPLATE, BUILD_STAMP, subFontFamily, subFxDecl, buildUserStyleDecl, pxToSizePct, subFontSizePct, ANN_DEFAULT_STYLE, SUB_DEFAULT_STYLE, VANN_DEFAULT_STYLE, resolveAnnEntry, subPosRatio } from '../lib/styles.js';
// 流水日志接 debugLog 阀门（引导页「调试日志」开关）：字号/构建版本/创建/样式应用
//   属流水信息，默认静默；warn/error 异常信号不受阀门影响。
import { isDebugLog } from '../lib/log-flag.js';

let _overlay = null;
let _video = null;
let _subtitles = [];             // [{start, end, text}]
let _annotationsCache = new Map(); // text -> annotations
let _seen = new Set();           // 跨字幕去重
let _enabled = true;
let _rankThreshold = 5000;   // 词频上限（用户裁定：5000-∞ 全放行，不设词频带）
// 注释重复生词（默认不选：后续出现不包裹不注释）
let _annotateRepeat = false;
// 侧邻注释模板，{word}/{meaning} 为变量；模板分键——本模块读 videoOverlayAnnTemplate
//   （第四栏字幕注释专用键）
let _annTemplate = DEFAULT_ANN_TEMPLATE;
let _lastKey = '';               // 避免重复渲染
let _scrollHandler = null;       // scroll/resize 监听器
let _mode = 'side';              // 'side'（侧邻注释）或 'detail'（详细注释）
let _styleId = SUB_DEFAULT_STYLE; // 当前字幕文字样式 id（'custom'=个性化；注释布局由 _mode 决定；初值=默认代指常量）
let _posId = 'b15';              // 当前字幕位置样式 id（距视频底部比例；出厂默认 b15）
let _storageListener = null;     // storage 变化监听器（同步详略模式）
let _fullscreenHandler = null;   // fullscreenchange 监听器（全屏时移动 overlay）
let _userStyleSheet = null;      // 用户样式动态 <style> 元素（style-user-* 规则重建用）
let _userStylesCache = [];       // 最近一次同步的用户样式列表（激活样式被删时回落判定）

// 第514次双语字幕（用户："视频叠加字幕的按钮后面增加双语标签按钮，目标语言在上，
// 释义语言在下。有了双语字幕，自然就不用注释了"）：开启时注释管线整体旁路，
// 原文纯文本在上、整句译文在下（.beaver-overlay-trans）。译文取数与语言对
// 监听在 lib/bilingual-trans.js（与侧栏字幕面板共用）。
let _bilingual = false;          // 双语开关（storage.overlayBilingual，默认关）

// 词典后台重建完成——清注释缓存并强制重绘。
//   首建/假就绪期算出的注释（全表外/翻译排队）可能被 _annotationsCache 钉死，
//   重建完成事件到达时字幕若在屏上不换 key 永不重算；清缓存 + 置 _lastKey=''
//   让 onTimeUpdate 走全渲染路径重算注释（projection.js vr-dict-rebuilt 广播）。
if (typeof window !== 'undefined') {
  window.addEventListener('vr-dict-rebuilt', () => {
    try {
      _annotationsCache.clear();
      _seen.clear();   // 第518次：同语言切换口径——旧 seen 集压制新词典首现判定，一并清
      _lastKey = '';
      if (_video && _enabled) onTimeUpdate();
      console.log('[VocabRadar][subtitle-overlay] 词典后台重建完成：注释缓存已清，重绘字幕');
    } catch (e) {
      console.warn('[VocabRadar][subtitle-overlay] 重建完成重绘失败:', e);
    }
  });
}

/** 创建 overlay 元素（position:fixed，位置由 updateOverlayPosition 动态计算） */
function createOverlay() {
  const el = document.createElement('div');
  el.id = 'beaver-subtitle-overlay';
  // 结构：字幕正文容器 + 双语译文容器（第514次，双语开关开启才填充）+ 注释列表容器（详细模式才填充）
  el.innerHTML = '<div class="beaver-overlay-subtitle"></div><div class="beaver-overlay-trans"></div><div class="beaver-overlay-annotations"></div>';
  return el;
}

/**
 * 注入 overlay 样式（复用 :root CSS 变量）
 * 样式注入 <style>（非内联 cssText）便于维护
 *   生词配色用 --beaver-first-bg/fg, --beaver-later-bg/fg
 *   注释配色用 --beaver-ann-bg/fg（与 text-hint-impl 侧邻注释共用）
 *   这些变量由 text-hint-impl.applyColorVars 或 sidebar.css :root 设置
 */
function injectOverlayStyles() {
  if (document.getElementById('beaver-overlay-styles')) return;
  const style = document.createElement('style');
  style.id = 'beaver-overlay-styles';
  // 基础规则不写 background，默认透明（黑底只由选中的 .style-none 等样式类提供）；
  //   显式钉住生词词块配色为绿底白字（本地定义，防止 text-hint 的 applyColorVars
  //   把页面暗色变量泄漏进字幕 overlay 导致词块变暗色块）。透明样式被选中时，
  //   视频底色如实透出。条目派生由 applyWordColorVars 内联覆盖
  //   （条目显式字段 > 本缺省）。
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
  /* 默认字号随视频高度自适应——--beaver-sub-fs 由
   * updateOverlayPosition 按视频高×当前样式百分比注入。
   * 依据：YouTube 默认 ≈24-28px / Netflix 28-32px@1080p / BBC ≈8% 帧高、
   * Captionator polyfill 默认 4.5%；原固定 16px 低于广播下限，用户反馈太小。 */
  font-size: var(--beaver-sub-fs, 24px);
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  pointer-events: none;
  z-index: 2147483647;
  /* 水平居中：left/right 限定视频横切片 + width:fit-content + margin:0 auto。
   * 不用 left:视频中心 + transform:translateX(-50%)：绝对定位元素右界为 auto 时
   *  shrink-to-fit 的可用宽 = 视口宽 − left ≈ 半屏，全屏时长句在 ~960px 处被迫
   *  换行 → 窄条挤成一团；新法可用宽 = 视频横切片宽（left/right 由
   *  updateOverlayPosition 内联写入），长句可铺满视频宽度、短句仍收缩居中。 */
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
/* 字幕正文生词高亮（首次/后续配色复用 CSS 变量）。
 * 词块 deco 装饰线由 applyWordColorVars 按生词条目（textStyle）派生为三个变量
 * （同 wordDecl 口径：line/style/color 合成 shorthand + thickness + offset），
 * 无 deco 条目走缺省 none。 */
#beaver-subtitle-overlay .beaver-overlay-subtitle .beaver-word {
  display: inline-block;
  background: var(--beaver-first-bg, #2e6b43);
  color: var(--beaver-first-fg, #ffffff);
  padding: 0 3px;
  border-radius: 2px;
  font-weight: 500;
  text-decoration: var(--beaver-word-deco, none);
  text-decoration-thickness: var(--beaver-word-deco-thickness, auto);
  text-underline-offset: var(--beaver-word-deco-offset, auto);
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
/* 双语译文行（第514次）：原文在上、译文在下，同享样式类底条（背景挂在 overlay 根）。
 * 0.8em 弱于正文一档（释义是辅助信息），配色继承根（白字）、底色透明。 */
#beaver-subtitle-overlay .beaver-overlay-trans {
  margin-top: 2px;
  font-size: 0.8em;
  line-height: 1.45;
  opacity: 0.92;
  text-align: center;
  word-break: break-word;
}
/* === 字幕样式预设 ===
 * 用户需求："字幕样式要含：位置、侧邻注释、新行注释、字号、颜色、边缘，样式差异化"。
 * 样式元数据定义在 src/lib/styles.js SUBTITLE_TEXT_STYLES：
 *   font 字体（sans/serif/mono）、fg 前景色、bg 背景色、size 字号、edge 描边色、
 *   bold 粗体、italic 斜体、shadow 文本阴影、annMode 注释模式。
 * 字幕一律横排（竖屏适配是"视频竖着，不是字幕竖着"）；样式类只描述外观，
 * 位置由 updateOverlayPosition 按 SUBTITLE_POSITIONS 的 ratio 内联计算。 */

${buildSubtitleStyleCss()}
`;
  document.head.appendChild(style);
}

/**
 * 按 SUBTITLE_TEXT_STYLES 元数据生成 style-{id} 差异化 CSS。
 * 职责分离：正文样式类（style-{id}）只管字幕正文外观；注释行外观由第四栏池
 *   样式类（annstyle-{id}）统一控制（用户裁定：注释样式由 subtitle hints on video
 *   栏指派，不跟随正文样式）。
 *   个性化字幕（style-custom）外观走 CSS 变量（setSubtitleCustom 写入内联值）。
 * @returns {string} CSS 规则文本
 */
// 当前样式的字号百分比（字号=视频高×pct；custom/用户样式各取其值），缺省 5%。
let _sizePct = 5;
let _diagLastFs = null;   // 字号诊断日志限频（fs 变化才打一条，防 timeupdate 刷屏）
let _customPct = 5;
function sizePctOfStyle(id) {
  if (id === 'custom') return _customPct;
  if (id && id.indexOf('user-') === 0) {
    const st = _userStylesCache.find((s) => s.id === id);
    if (st) return subFontSizePct(st);
  }
  // 不得排除 'none'：默认样式（none 条目，fontSizePct:5）也须命中条目取其自带
  //   fontSizePct；若跳过会掉到兜底 7，造成"默认样式字号偏大、其他样式正常"。
  if (id) {
    const s = findStyle(SUBTITLE_TEXT_STYLES, id);
    if (s) return subFontSizePct(s);
  }
  return 7;
}
function refreshActivePct() { _sizePct = sizePctOfStyle(_styleId); }

function buildSubtitleStyleCss() {
  // 正文样式规则（none + 内置）：字体/颜色/背景/描边/粗细来自元数据；
  // 字号不写死 px（固定值小屏大、大屏小），统一走基础层 var(--beaver-sub-fs)——
  //   updateOverlayPosition 按视频高×当前样式 sizePct 注入。
  const textRules = SUBTITLE_TEXT_STYLES.map((s) => {
    const parts = [];
    parts.push('background:' + (s.bg || 'transparent'));
    parts.push('color:' + s.fg);
    parts.push('font-family:' + (SUB_FONTS[s.font] || SUB_FONTS.sans));
    parts.push('border-radius:4px');
    parts.push('max-width:90%');
    // weight 优先于 bold（edge-white-bold 用 800）
    if (s.weight) parts.push('font-weight:' + s.weight);
    else if (s.bold) parts.push('font-weight:600');
    if (s.italic) parts.push('font-style:italic');
    // paint-order:stroke fill——text-stroke 默认画在填充之上，黑边吃进白字笔画
    //   （字形"被侵蚀"）；压到填充之下后描边只露外缘、字形主干完整
    //   （同 guide 预览端 sub-style.js 双端一致；与 subFxDecl 'stroke' 既有写法同口径）。
    if (s.edge) parts.push('-webkit-text-stroke:1px ' + s.edge + ';paint-order:stroke fill');
    // shadow 字段支持字符串（自定义 text-shadow），true 用默认黑投影
    if (s.shadow) parts.push('text-shadow:' + (typeof s.shadow === 'string' ? s.shadow : '0 0 6px rgba(0,0,0,.9)'));
    // glow 字段输出字幕盒外发光（box-shadow）——默认样式 white-glow 的
    //   "黑色半透明外发光"由此生效（与 guide 预览 sub-style.js buildSubBoxCss 同口径）。
    if (s.glow) parts.push('box-shadow:' + s.glow);
    return '#beaver-subtitle-overlay.style-' + s.id + '{' + parts.join(';') + ';}';
  }).join('\n');

  // 个性化字幕规则（guide 页控件：底色/字色/字号/字体），变量缺省值与 guide 页
  //   Custom 默认一致（bg 缺省 transparent）。fx 三变量（text-shadow/描边/paint-order）
  //   由 setSubtitleCustom 按 subFxDecl(c.fx) 拆分写入；缺省值须合法——'none' 对
  //   -webkit-text-stroke 非法，描边缺省 '0 transparent'，paint-order 缺省 'normal'。
  //   字号与内置/用户样式一样走基础层 var(--beaver-sub-fs)（按视频高×custom sizePct
  //   注入），setSubtitleCustom 只存百分比。
  const customRule = '#beaver-subtitle-overlay.style-custom{' +
    'background:var(--beaver-custom-bg,transparent);' +
    'color:var(--beaver-custom-fg,#ffffff);' +
    'font-family:var(--beaver-custom-ff,' + SUB_FONTS.sans + ');' +
    'text-shadow:var(--beaver-custom-tsh,none);' +
    '-webkit-text-stroke:var(--beaver-custom-stroke,0 transparent);' +
    'paint-order:var(--beaver-custom-po,normal);' +
    'border-radius:4px;max-width:90%;}';

  // 注释行样式规则（第四栏池 annstyle-{id}）——annDecl 输出过滤 font-size
  //  （池条目 12-15px 是侧栏语境，字幕注释行统一 0.9em 基准），词头加粗 600 与基础层一致。
  //  追加 word 规则（wordDecl 滤 font-size，同 annDecl 口径）消费 annstyle 条目的
  //  wordBg/wordFg 等生词字段。选择器显式含 .beaver-word.later：基础层 .beaver-word.later
  //  特异性与 annstyle word 规则平局时按源序兜底不可靠，.later 变体 (1,4,0) 稳胜。
  const annRules = POOL_STYLES
    .filter((s) => s.id)
    .map((s) => {
      const decl = annDecl(s).filter((d) => !d.startsWith('font-size')).join(';');
      // green-wave 的 wordFg:'inherit' 语义是"不动正文颜色"，但直出 color:inherit
      //  会经 word 规则覆盖 .beaver-word.later 基础层颜色——此处过滤之。
      const wordDeclCss = wordDecl(s).filter((d) => !d.startsWith('font-size') && d !== 'color:inherit').join(';');
      if (!decl && !wordDeclCss) return '';
      const sel = '#beaver-subtitle-overlay.annstyle-' + s.id;
      return (decl
        ? sel + ' .beaver-overlay-subtitle .beaver-side-ann,' +
          sel + ' .beaver-overlay-ann-word,' +
          sel + ' .beaver-overlay-ann-trans{' + decl + ';}' +
          sel + ' .beaver-overlay-ann-word{font-weight:600;}'
        : '') +
        (wordDeclCss
          ? sel + ' .beaver-overlay-subtitle .beaver-word,' +
            sel + ' .beaver-overlay-subtitle .beaver-word.later{' + wordDeclCss + ';}'
          : '');
    })
    .filter(Boolean)
    .join('\n');

  return textRules + '\n' + customRule + '\n' + annRules;
}

/**
 * 重建用户字幕正文样式规则（guide 页大加号保存的样式，storage.subtitleUserStyles）
 * 用户样式条目动态增删，静态清单（SUBTITLE_STYLE_CLASSES）必然滞后，
 *   改用独立 <style> 元素整表重写——声明由共享层 buildUserStyleDecl 生成，
 *   与 guide 预览（subCard/buildSubBoxCss）同源，预览=真实渲染。
 * 同步缓存 _userStylesCache 供 storage 监听判定「激活样式被删除」。
 * @param {Array<{id:string,bg?:string,fg?:string,sizePct?:number,fontSize?:number,fontFamily?:string,fx?:string}>} list
 */
function syncUserStyleRules(list) {
  _userStylesCache = Array.isArray(list) ? list.filter((st) => st && typeof st.id === 'string' && st.id.indexOf('user-') === 0) : [];
  // 用户规则字号同样走 --beaver-sub-fs 实时变量（静态表无法跟视频高），此处过滤
  //   font-size 声明（百分比经 subFontSizePct 在 refreshActivePct 内换算）。
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
 * overlay 水平居中于视频（left/right 限定视频横切片），垂直按 ratio 定位
 * rect 为 0×0 时只跳过位置更新、不隐藏 overlay：
 *   全屏切换/SPA 导航时 video 可能短暂 0×0，隐藏后 _lastKey 不变不会恢复。
 * 视频全屏时 overlay 须挂到全屏元素内部（fullscreenchange 时迁移）：
 *   全屏元素被提升到 top layer 后，document.body 上的 position:fixed 元素
 *   不再显示在全屏元素之上。位置计算 getBoundingClientRect 仍正确
 *   （全屏时 video 充满视口，rect 为视口尺寸）。
 */
function updateOverlayPosition() {
  // 总守卫：叠加字幕未开启时 scroll/resize 监听仍会触发本函数，
  // 造成"未开启却后台不停扫描"的日志刷屏。禁用即完全不工作。
  if (!_enabled || !_overlay || !_video) return;
  const rect = _video.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  // 位置一律相对"视频矩形"计算（水平居中于视频，垂直按样式位置：
  //   底部 10% / 偏高 20% / 顶部 8% / 居中）。横屏、竖屏视频都跟随视频矩形——
  //   竖屏视频字幕仍是横排文字、只是位于竖的视频内（用户明确："是视频竖着，
  //   不是字幕竖着"）。ratio=字幕框中心线距视频底部的高度占视频高度比例，
  //   top = 视频底边 - 视频高度×ratio - 字幕框高/2（-h/2 才符合"中心线"语义，
  //   旧 -h 把盒子底边压在 ratio 线上，预览/真实 overlay 都对不齐）。
  // ratio 统一经 subPosRatio——档表 b10/b20/… 或滑轨自定义 bNN（0-100）；
  //   null（脏值）兜底下 1/5。
  const _r = subPosRatio(_posId);
  const ratio = (typeof _r === 'number' && isFinite(_r)) ? _r : 0.2;
  // 水平方向：left/right 限定视频横切片，配合基础样式 width:fit-content +
  //   margin:0 auto 居中（根因见基础样式注释）。left = 视频左边界，
  //   right = 视口宽 − 视频右边界 → 切片宽恒等于视频宽，overlay 可用宽
  //   不再被"视口宽 − left ≈ 半屏"卡死，长句可铺满视频宽度。
  _overlay.style.left = Math.max(0, rect.left) + 'px';
  _overlay.style.right = Math.max(0, window.innerWidth - rect.right) + 'px';
  // 默认字号随视频高度自适应（Captionator polyfill 同款比例）：全部样式统一按
  //   当前样式百分比换算（预设固定 px 已退役）；不 clamp（用户：clamp 是失真）——
  //   大小屏纯比例；基线统一视频高。
  {
    const pct = (typeof _sizePct === 'number' && isFinite(_sizePct)) ? _sizePct : 5;
    const fs = Math.round(rect.height * pct / 100);
    _overlay.style.setProperty('--beaver-sub-fs', fs + 'px');
    // 字号诊断日志：静态链路无错（YouTube/Netflix/WebVTT ::cue 默认同为
    //   "显示高度×百分比"口径），限频日志实测定案——仅在算出的 fs 变化时
    //   打一条（timeupdate/scroll 高频路径不刷屏），输出三要素：
    //   视频显示高 rect.height、百分比 pct 及来源样式 id。用户贴日志即可判别
    //   "显示高异常（选错 video 元素）/ pct 未随设定更新 / 纯比例观感问题"。
    if (fs !== _diagLastFs) {
      _diagLastFs = fs;
      if (isDebugLog()) console.log(`[VocabRadar][overlay] 字号: ${fs}px = 视频显示高 ${Math.round(rect.height)}px × ${pct}%（样式=${_styleId}）`);
    }
  }
  const h = _overlay.offsetHeight || 0;
  _overlay.style.top = (rect.bottom - rect.height * ratio - h / 2) + 'px';
  _overlay.style.bottom = '';
  // 竖屏适配：字幕框宽度不能超出视频矩形。基础样式 max-width:80%（按视口）+
  //   各样式 max-width:90% 只适合横屏铺满视口；竖屏视频（视频矩形远窄于视口）
  //   内字幕框会溢出视频左右边界。视频矩形小于视口 80% 时，把字幕框最大宽度
  //   限制在视频矩形内（留 8px 余量，最小 100px）；横屏满宽视频时清空内联
  //   maxWidth，交回样式类（80%/90%）决定。
  const vw = window.innerWidth;
  if (rect.width > 0 && rect.width < vw * 0.8) {
    _overlay.style.maxWidth = Math.max(rect.width - 8, 100) + 'px';
  } else {
    _overlay.style.maxWidth = '';
  }
}

/**
 * 全屏变化处理：进入全屏时将 overlay 挂到全屏元素内部，退出时移回 body
 * 浏览器全屏 API 将全屏元素提升到 top layer，
 *   body 上的 fixed 元素无法覆盖全屏元素。必须将 overlay 挂到全屏元素内部才能显示。
 *   全屏元素可能是 video 本身或其祖先容器（如 .bpx-player-container）。
 */
function onFullscreenChange() {
  if (!_overlay) return;
  // 同时检查标准与 webkit 前缀（Safari/旧 Chrome）
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

// 侧邻注释统一用共享 pickCleanShortTrans（宽分隔符，与各侧邻路径同源）。
//   （detail 列表仍全量 join，"详细全列"口径不变）

/**
 * 生词注释管线（side/detail 两模式共用）——叠加字幕与视频侧栏口径统一：
 * 全部生词全注释（用户裁定）。
 * 管线：过滤重复生词（isFirst）→ 词面定位 → 排序去重叠。
 * 词面定位用 findWordPositions（2026-10-05：旧 \b 正则只认 ASCII 词界，
 *   重音词 café/être 与 CJK 词永远失配——高亮整体消失，即"边界被吃"的报告源之一；
 *   撇号/连字符/CJK 交由分词层同源口径处理）。
 * @param {string} text 字幕文本
 * @param {Array} anns 注解数组
 * @returns {Array<{start:number,end:number,word:string,ann:object}>} 全部生词匹配（去重叠后）
 */
function collectAnnotateMatches(text, anns) {
  const matches = [];
  for (const a of anns) {
    // 注释重复生词默认不选：后续出现（isFirst===false）不包裹不注释，
    //   与视频侧栏/文本侧栏一致。
    if (!_annotateRepeat && a.isFirst === false) continue;
    const positions = findWordPositions(text, a.word, false);
    if (positions.length > 0) {
      const pos = positions[0];
      matches.push({ start: pos.start, end: pos.end, word: text.slice(pos.start, pos.end), ann: a });
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
  return valid;
}

/**
 * 构建侧邻注释 HTML：生词高亮 + (释义) 行内
 * 生词集合经 collectAnnotateMatches 定位——全部生词全注释（与侧栏口径一致）
 * @param {string} text 字幕文本
 * @param {Array} anns 注解数组
 * @returns {string} HTML 字符串
 */
function buildSideAnnotationHtml(text, anns) {
  if (!anns || anns.length === 0) return escapeHtml(text);
  // 全注释管线（collectAnnotateMatches，见上）——中段生词同样高亮注释
  const valid = collectAnnotateMatches(text, anns);
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
        // 注释文本按模板拼装（{word}/{meaning} 变量，模板前后缀为字面量；
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
  // 字幕正文：仅高亮生词，不加行内注释（buildSideAnnotationHtml 内已做全注释定位）
  const subtitleHtml = buildSideAnnotationHtml(text, anns.map(a => ({ ...a, translations: [] })));
  // 注释列表同样全注释——与字幕高亮走同一 collectAnnotateMatches 管线，
  //   保证列表与高亮词完全一致
  const edgeWords = new Set(collectAnnotateMatches(text, anns).map((m) => m.word.toLowerCase()));
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
 * updateOverlayPosition 必须放在本函数末尾：本函数是 async，
 *   await getAnnotations 后才设 innerHTML 和 display:block。
 *   顺序：renderSubtitle 完成（设 display:block）→ updateOverlayPosition（offsetHeight 正确）。
 * @param {object|null} subtitle - 字幕条目，null 表示无字幕
 */
async function renderSubtitle(subtitle) {
  if (!subtitle) {
    _overlay.style.display = 'none';
    return;
  }

  const subtitleEl = _overlay.querySelector('.beaver-overlay-subtitle');
  const annEl = _overlay.querySelector('.beaver-overlay-annotations');
  const transEl = _overlay.querySelector('.beaver-overlay-trans');
  if (transEl) transEl.innerHTML = '';   // 默认清残留译文行（双语命中路径再填充）
  // 双语模式：注释管线整体旁路（用户裁定"有了双语字幕，自然就不用注释了"）——
  // 原文纯文本上屏（无高亮无注释，生词翻译队列零触发），整句译文经 _transCache
  // 异步取回填下方；无译文/失败/同文时不渲染译文行（只展示原文，降级不出声）。
  if (_bilingual) {
    subtitleEl.textContent = subtitle.text;
    annEl.innerHTML = '';
    reportSubtitle({ phase: 'show', start: subtitle.start, text: String(subtitle.text).slice(0, 40), dictReady: isLoaded(), cached: true });
    if (!_enabled) return;
    _overlay.style.display = 'block';
    updateOverlayPosition();
    const key = subtitle.start + ':' + subtitle.text;
    const trans = await fetchBilingualTrans(subtitle.text);
    // 等待期间已换字幕/已关叠加/双语已关 → 丢弃（防旧译文画上新字幕）
    if (!_enabled || !_bilingual || _lastKey !== key) return;
    if (trans && transEl) {
      transEl.textContent = trans;
      updateOverlayPosition();   // 译文行撑高后重定位（渲染末尾同口径）
    }
    return;
  }
  // 注释布局只由详略开关(_mode)决定——正文字样的 annMode 不得压过用户切换的详细注释
  const annMode = _mode === 'detail' ? 'detail' : 'side';

  // 字幕显示与注释计算解耦：若 await getAnnotations 完才设 innerHTML/display:block，
  //   注释计算被 lemma/翻译串行风暴拖住时（逐词 30s 叠加），纯字幕也被拖着分钟级
  //   不上屏。策略：缓存命中 → 直接渲染注释版；未命中 → 先以空注释渲染纯字幕
  //   立即上屏（buildXxx 对空数组天然降级为纯文本），注释异步算完后再补渲染。
  let anns = _annotationsCache.get(subtitle.text);
  const pending = anns === undefined;
  applyAnns(subtitle, pending ? [] : anns, annMode, subtitleEl, annEl);

  // 上屏前确认 _enabled，防止注释等待期间被关闭叠加。
  if (!_enabled) return;
  _overlay.style.display = 'block';
  updateOverlayPosition();

  // 字幕时间线上报——上屏时刻/词典就绪与否/缓存命中，
  //   配合 annotator 每句统计定位"字幕晚出现/没注释"卡在哪段。
  reportSubtitle({ phase: 'show', start: subtitle.start, text: String(subtitle.text).slice(0, 40), dictReady: isLoaded(), cached: !pending });

  if (!pending) return;

  // 注释异步补渲染：完成后写缓存；期间已换字幕（_lastKey 变）/已关叠加则跳过，
  //   防止把旧字幕的注释画到新字幕上（key 公式与 onTimeUpdate 保持一致）。
  const _annT0 = Date.now();   // 算注耗时起点（诊断窗时间线）
  // 非阻塞 + 翻译回填重画：不传 onAsyncTranslate 时翻译慢/失败的句子只有高亮
  //   无释义，异步翻译完成也无人重画（侧栏早已是非阻塞+回填）。传 onAsyncTranslate——
  //   回调收到的 ann 与数组内对象同引用（annotator 非阻塞分支原位回填），await 返回后
  //   触发的回调只需重画当前句；await 返回前触发的早回调（annsRef 未赋值）跳过——
  //   届时首次 applyAnns 已含其结果（同引用），不丢注释。
  let annsRef = null;
  anns = await getAnnotations(subtitle.text, _rankThreshold, _seen, (ann) => {
    if (!annsRef || !_enabled || _lastKey !== (subtitle.start + ':' + subtitle.text)) return;
    applyAnns(subtitle, annsRef, annMode, subtitleEl, annEl);
    updateOverlayPosition();
  }, PRIO_VIDEO);
  annsRef = anns;
  // 词典未就绪期算出的注释不可信（全表外/全 pending，"冷装载期查询结果不可信"），
  //   不写缓存——词典就绪后同句重算才有真注释；词典就绪后的空数组是真无生词，
  //   照常缓存（避免同句每帧重算 IDB 批读）。
  if (isLoaded()) _annotationsCache.set(subtitle.text, anns);
  reportSubtitle({ phase: 'ann', start: subtitle.start, text: String(subtitle.text).slice(0, 40), dictReady: isLoaded(), out: anns.length, pending: anns.filter((a) => a.pending).length, ms: Date.now() - _annT0 });
  if (!_enabled || _lastKey !== (subtitle.start + ':' + subtitle.text)) return;
  applyAnns(subtitle, anns, annMode, subtitleEl, annEl);
  _overlay.style.display = 'block';
  updateOverlayPosition();
}

// 注释版渲染应用（detail/side 两模式统一封装，供先上屏与补渲染共用）
function applyAnns(subtitle, anns, annMode, subtitleEl, annEl) {
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
 * 位置更新不在本函数：renderSubtitle 是 async，由其末尾处理。
 *   字幕未变时（key===_lastKey）仅更新位置（视频可能全屏/缩放）。
 */
function onTimeUpdate() {
  if (!_enabled || !_video || !_overlay) return;
  const t = _video.currentTime;
  const sub = findCurrentSubtitle(t);
  const key = sub ? sub.start + ':' + sub.text : '';
  if (key === _lastKey) {
    // 无字幕时（key 为空串）不更新位置：初始 _lastKey 恰为 ''，若放行则视频
    //   无字幕也每秒刷新位置（日志刷屏）。有字幕时仍需更新（全屏/缩放），
    //   故仅当 key 非空才刷新。
    if (key) updateOverlayPosition();
    return;
  }
  _lastKey = key;
  renderSubtitle(sub).catch((e) => console.warn('[VocabRadar][overlay] renderSubtitle 失败:', e));
}

/**
 * 启动视频内字幕
 * 先调 stopOverlay 清理旧状态，防止 SPA 换集时旧 video 引用残留。
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
  // My Words（用户生词/熟词表，优先级高于词频范围；storage.myWords={new:[],known:[]}）
  // 真值守卫：video-sidebar 等调用方未传 myWords 时不得清空 annotator
  //   已有集合（同一 JS 上下文内 annotator 模块级 Set 是共享的）
  if (options.myWords) setMyWords(options.myWords.new, options.myWords.known);
  _enabled = options.enabled ?? true;
  _mode = options.mode === 'detail' ? 'detail' : 'side';
  // 注释重复生词（默认不选）
  _annotateRepeat = options.annotateRepeat === true;
  // 注释模板兜底（真实值下方从 storage 异步读取覆盖）；分键后本模块只读
  //   videoOverlayAnnTemplate（第四栏字幕注释专用）
  _annTemplate = DEFAULT_ANN_TEMPLATE;

  // 从 storage 读取详略模式（与视频提示同步）
  // 视频内字幕的注释模式与视频提示的详略模式共用一个 storage key：
  //   sidebar.js 切换详略时写入 subtitleDetailMode，本模块监听变化自动切换
  if (chrome.storage?.local) {
    // 初始读取注释模板（与详略模式同批读取）；第514次同批补双语开关
    // （语言对由 lib/bilingual-trans.js 自持监听，此处不再读）
    chrome.storage.local.get({ subtitleDetailMode: false, videoOverlayAnnMode: 'side', videoOverlayAnnTemplate: DEFAULT_ANN_TEMPLATE, overlayBilingual: false }, (res) => {
      // 优先使用独立的 videoOverlayAnnMode，向后兼容 subtitleDetailMode
      const mode = res.videoOverlayAnnMode || (res.subtitleDetailMode ? 'detail' : 'side');
      _mode = mode;
      if (typeof res.videoOverlayAnnTemplate === 'string' && res.videoOverlayAnnTemplate.trim()) _annTemplate = res.videoOverlayAnnTemplate;
      // 双语字幕初始态
      _bilingual = res.overlayBilingual === true;
    });
    // 监听 storage 变化，实时同步模式
    _storageListener = (changes, area) => {
      if (area !== 'local') return;
      // 双语开关与语言对热更新（第514次）：均强制重渲染（当前句换渲染分支/
      // 换语言对后译文作废重取，缓存清理由 lib/bilingual-trans.js 自持监听负责）。
      if (changes.overlayBilingual) {
        _bilingual = changes.overlayBilingual.newValue === true;
        _lastKey = '';
        if (_video && _enabled) onTimeUpdate();
      }
      if (changes.learnLanguage || changes.meaningLanguage) {
        // 2026-10-05（用户："改了语言，并不生效，还是按照英语扫"）：语言切换必须清
        //   注释缓存与跨句去重集——_annotationsCache 按字幕文本键，不清则 onTimeUpdate
        //   重画时命中旧语言注释（英语注释一直挂到词典重建完）；_seen 不清则旧语言
        //   已见词压制新语言的首现判定。与 setRankThreshold/setMyWordsLists 同口径
        //   （阈值/词表变化都清，语言变化更是全变，唯此处漏了——第518次补齐）。
        _annotationsCache.clear();
        _seen.clear();
        _lastKey = '';
        if (_video && _enabled) onTimeUpdate();
      }
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
      // 字幕样式由引导页/侧栏写入 subtitleStyle，监听变化实时应用（无需刷新页面）。
      if (changes.subtitleStyle) {
        setSubtitleStyle(changes.subtitleStyle.newValue);
      }
      // 位置样式由引导页写入 subtitlePosition，监听变化实时应用
      //   （top 内联更新，无需重渲染字幕）。
      if (changes.subtitlePosition) {
        setSubtitlePosition(changes.subtitlePosition.newValue);
      }
      // 注释样式（第四栏池指派）与个性化字幕热更新——引导页改动即时生效。
      // newValue 若为 'none'（旧端残留写入）清洗回落默认代指常量；
      // 本栏默认与前三栏分道——回落 VANN_DEFAULT_STYLE（yellow-yellow）。
      if (changes.videoOverlayAnnStyle) {
        const nv = changes.videoOverlayAnnStyle.newValue;
        setVideoOverlayAnnStyle(nv === 'none' ? VANN_DEFAULT_STYLE : nv);
      }
      // 个性化/用户注释规则热更新（类名不变即时生效）；
      // 生词条目（textStyle/个性化/用户表）变化同步重派生词块配色。
      if (changes.annotationCustom || changes.annotationUserStyles || changes.textStyle) {
        chrome.storage.local.get({ textStyle: ANN_DEFAULT_STYLE, annotationCustom: null, annotationUserStyles: [] }, (res) => {
          syncAnnCustomRules(res.annotationCustom, res.annotationUserStyles);
          applyWordColorVars(res);
        });
      }
      if (changes.subtitleCustom) {
        setSubtitleCustom(changes.subtitleCustom.newValue);
      }
      // 用户字幕正文样式（大加号保存/删除）热更新——整表重建 style-user-* 规则；
      //   若当前激活样式被删除则回落默认（guide 端删除选中项时会写 subtitleStyle，
      //   此处兜底防其他入口删除时激活类悬空）。
      if (changes.subtitleUserStyles) {
        syncUserStyleRules(changes.subtitleUserStyles.newValue);
        if (_styleId && _styleId.indexOf('user-') === 0 &&
            !_userStylesCache.some((s) => s.id === _styleId)) {
          setSubtitleStyle(SUB_DEFAULT_STYLE);
        }
      }
      // 注释模板热更新——前后缀变化需强制重渲染；本模块只响应
      //   videoOverlayAnnTemplate（其他栏的模板不波及）。
      if (changes.videoOverlayAnnTemplate) {
        if (typeof changes.videoOverlayAnnTemplate.newValue === 'string' && changes.videoOverlayAnnTemplate.newValue.trim()) _annTemplate = changes.videoOverlayAnnTemplate.newValue;
        _lastKey = '';
        if (_video && _enabled) onTimeUpdate();
      }
    };
    chrome.storage.onChanged.addListener(_storageListener);
  }

  // 注入样式 + 创建 overlay
  injectOverlayStyles();
  _overlay = createOverlay();
  document.body.appendChild(_overlay);
  // 应用已保存的字幕样式（引导页/侧栏可设置）：走 setSubtitleStyle
  //   （含未知样式 id 优雅回退），不得直接 classList.add 死类（旧删掉的样式 id
  //   会让 overlay 回落黑底）；同时应用已保存的位置样式（subtitlePosition）。
  if (chrome.storage?.local) {
    // 初始读取顺序：先重建 style-user-* 规则（用户样式表），再应用激活样式
    //   （激活值可能是 user-*，规则就绪后类一挂即生效）；补个性化字幕
    //   （subtitleCustom）、注释样式（videoOverlayAnnStyle）、位置（subtitlePosition）。
    chrome.storage.local.get({ subtitleStyle: SUB_DEFAULT_STYLE, subtitlePosition: 'b15', subtitleCustom: null, videoOverlayAnnStyle: VANN_DEFAULT_STYLE, subtitleUserStyles: [], textStyle: ANN_DEFAULT_STYLE, annotationCustom: null, annotationUserStyles: [] }, (res) => {
      syncUserStyleRules(res.subtitleUserStyles);
      applyWordColorVars(res);   // 字幕词块配色随生词条目派生
      setSubtitleStyle(res.subtitleStyle || SUB_DEFAULT_STYLE);
      // videoOverlayAnnStyle 读数清洗——池中 none 卡已删，残留 'none' 统一落
      //   VANN_DEFAULT_STYLE（与引导页口径一致）；subtitlePosition 的旧 't10'
      //   残留由 setSubtitlePosition 内迁移为 b90（见该函数）。
      setSubtitlePosition(res.subtitlePosition || 'b15');
      if (res.subtitleCustom) setSubtitleCustom(res.subtitleCustom);
      setVideoOverlayAnnStyle(res.videoOverlayAnnStyle === 'none' ? VANN_DEFAULT_STYLE : (res.videoOverlayAnnStyle || VANN_DEFAULT_STYLE));
    });
    // 个性化/用户注释规则初始同步（与正文用户样式表同构，独立键）
    chrome.storage.local.get({ annotationCustom: null, annotationUserStyles: [] }, (res) => {
      syncAnnCustomRules(res.annotationCustom, res.annotationUserStyles);
    });
  }
  // 构建版本 + 生效样式日志（接 debugLog 阀门，默认静默；排障时勾选「调试日志」
  //   仍可取证）：若本日志版本与引导页头部"vXX"不一致，即旧构建内容脚本残留
  //   （扩展已更新但视频页未重载），用户反馈"edge 默认样式被改/设定栏没选中"
  //   多为这类残留，不必再猜。
  if (isDebugLog()) {
    console.log('[VocabRadar][overlay] 构建 ' + BUILD_STAMP + '（引导页头部版本若不同 = 旧构建残留，请重载扩展并刷新视频页）');
    console.log('[VocabRadar][overlay] overlay 已创建（mode=' + _mode + '，style=' + _styleId + '，pos=' + _posId + '）');
  }

  video.addEventListener('timeupdate', onTimeUpdate);

  _scrollHandler = () => updateOverlayPosition();
  window.addEventListener('scroll', _scrollHandler, true);
  window.addEventListener('resize', _scrollHandler);

  // 全屏监听：document.body 上的 position:fixed 元素在全屏时不可见，
  // 进入全屏须把 overlay 迁到 fullscreenElement 内部才能显示在视频之上。
  _fullscreenHandler = () => onFullscreenChange();
  document.addEventListener('fullscreenchange', _fullscreenHandler);
  // webkit 前缀兼容（Safari/旧版 Chrome）
  document.addEventListener('webkitfullscreenchange', _fullscreenHandler);
}

/**
 * 替换全部字幕（sidebar updateSubtitles 时同步调用）。
 * sidebar 的字幕变更（换集/ASR 缓存加载）必须同步到 overlay，
 * 否则全屏字幕不显示。
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
 * 设置开关（即时生效）。
 * 开启时不能只设 _enabled：须立即清除 display:none 并触发一次
 * onTimeUpdate() 重渲染，否则开启后视频内无字幕（要等 timeupdate 才恢复）。
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

/**
 * 设置双语字幕开关（第514次，storage.overlayBilingual，默认关）。
 * 开启：注释管线旁路，原文在上、整句译文在下；关闭：回到注释渲染。
 * 即时生效须清 _lastKey 强制重渲染（同 setOverlayEnabled 口径）。
 * @param {boolean} on
 */
export function setOverlayBilingual(on) {
  _bilingual = on === true;
  _lastKey = '';
  if (_video && _enabled) onTimeUpdate();
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

/** 设置 My Words 生词/熟词表（storage.myWords 变化时调用） */
export function setMyWordsLists(newList, knownList) {
  setMyWords(newList, knownList);
  _annotationsCache.clear();
  _seen.clear();
  _lastKey = '';
}

// 用户样式（style-user-*）动态增删，静态类名清单必滞后——样式与注释样式
// 的清理一律按前缀扫描（'style-' / 'annstyle-'），永不脱节。

/**
 * 应用字幕文字样式。
 * storage key: subtitleStyle（值=样式池 id，与 style-{id} 类对应）。
 * 旧 'none' 存量非法，入参处统一迁移为默认代指样式 SUB_DEFAULT_STYLE。
 * 样式校验：storage 中的 id 若已不在样式池（旧版本删过样式，旧选中值挂死类
 * → 回落黑底，用户看到"透明当黑色"），未知 id 优雅回落默认并写回 storage
 * 清理，杜绝死类；回落目标为常量 SUB_DEFAULT_STYLE（指针，版本变化才改值）。
 * @param {string} style 文字样式名（样式池 id；空值/旧 'none' 迁移为默认样式）
 */
export function setSubtitleStyle(style) {
  if (!_overlay) return;
  // 'style-' 前缀扫描清理：用户样式 style-user-* 动态增删，前缀扫描永不漏清
  for (const cls of Array.from(_overlay.classList)) {
    if (cls.indexOf('style-') === 0) _overlay.classList.remove(cls);
  }
  // 存量 'none'（旧白字贴底 id，用户裁定非法全清）迁移为 SUB_DEFAULT_STYLE；空值同落默认常量
  let id = (style === 'none' || !style) ? SUB_DEFAULT_STYLE : style;
  // 'custom'（CSS 变量驱动）与 'user-' 前缀（guide 页保存的用户样式）均为合法 id，
  // CSS 表动态生成，无法用 findStyle 校验，直接放行
  const isUserStyle = typeof id === 'string' && id.indexOf('user-') === 0;
  if (id !== 'custom' && !isUserStyle && !findStyle(SUBTITLE_TEXT_STYLES, id)) {
    console.warn(`[VocabRadar][overlay] 字幕样式 "${id}" 已不存在，回退默认样式并清理 storage`);
    id = SUB_DEFAULT_STYLE;
    try {
      chrome.storage.local.set({ subtitleStyle: id });
    } catch (e) { /* 清理失败忽略 */ }
  }
  _styleId = id;
  refreshActivePct();   // 切换样式即刷新字号百分比（随后 onTimeUpdate 经 updateOverlayPosition 落 px）
  // 默认样式也显式加类（如 .style-white-bottom），不依赖基础规则隐式兜底，
  // 避免"选了透明样式却仍显示黑底"。
  _overlay.classList.add('style-' + _styleId);
  // 应用后打印计算样式取证：computed 背景色/字色与所选样式不符即类未生效
  // （排查"透明当作黑色"用），接 debugLog 阀门默认静默。
  try {
    const cs = getComputedStyle(_overlay);
    if (isDebugLog()) console.log(`[VocabRadar][overlay] 字幕样式已应用: "${_styleId}" 计算背景色=${cs.backgroundColor} 计算字色=${cs.color}`);
  } catch (e) { /* 计算样式取证失败忽略 */ }
  // 字幕样式含"侧邻注释/新行注释"：样式非 none 时注释布局以样式为准。
  // 切换样式前必须清 _lastKey：否则 onTimeUpdate 里 key===_lastKey 直接 return
  // （缓存跳过渲染），样式类虽已换但当前字幕 DOM 不重建 → 不即时生效。
  _lastKey = '';
  if (_video && _enabled) onTimeUpdate();
}

/**
 * 字幕正文生词词块配色按生词条目（textStyle）派生：条目显式字段 > 缺省
 * （绿底白字，与样式表钉住值一致），内联 setProperty 覆盖样式表本地钉住值
 * （钉住结构保留防页面变量泄漏）。与 th pickColors / ws / vs 同口径
 * （条目显式字段优先，根治"显示不变实际变"）。
 * 词块 deco 装饰线同口径派生：条目 deco 字段（line/style/color/width/offset）
 * 合成三个变量，与 wordDecl 生成器同口径；无 deco 条目移除变量走样式表缺省
 * （text-decoration: none）。
 * @param {{textStyle?:string, annotationCustom?:object, annotationUserStyles?:Array}} s storage 子集
 */
function applyWordColorVars(s) {
  if (!_overlay || !s) return;
  const entry = resolveAnnEntry(s.textStyle, s.annotationCustom, s.annotationUserStyles);
  const firstBg = (entry && entry.wordBg !== undefined) ? entry.wordBg : '#2e6b43';
  const firstFg = (entry && entry.wordFg !== undefined) ? entry.wordFg : '#ffffff';
  _overlay.style.setProperty('--beaver-first-bg', firstBg);
  _overlay.style.setProperty('--beaver-first-fg', firstFg);
  _overlay.style.setProperty('--beaver-later-bg', firstBg);
  _overlay.style.setProperty('--beaver-later-fg', firstFg);
  if (entry && entry.deco && entry.deco.line) {
    _overlay.style.setProperty('--beaver-word-deco',
      [entry.deco.line, entry.deco.style, entry.deco.color].filter(Boolean).join(' '));
    _overlay.style.setProperty('--beaver-word-deco-thickness', entry.deco.width || 'auto');
    _overlay.style.setProperty('--beaver-word-deco-offset', entry.deco.offset || 'auto');
  } else {
    _overlay.style.removeProperty('--beaver-word-deco');
    _overlay.style.removeProperty('--beaver-word-deco-thickness');
    _overlay.style.removeProperty('--beaver-word-deco-offset');
  }
}

/**
 * 应用字幕位置样式（距视频底部比例）。位置与文字样式解耦：位置由
 * SUBTITLE_POSITIONS 元数据（ratio 字段）驱动，updateOverlayPosition 据此
 * 计算 top；本函数只更新 _posId 并刷新位置。
 * storage key: subtitlePosition（默认 'b15'，出厂默认 White Glow 所配位置）。
 * @param {string} posId 位置样式 id
 */
export function setSubtitlePosition(posId) {
  let id = posId || 'b15';
  // 存量 't10'（旧顶部 1/10，已改名 b90）迁移：b90 已入池、t10 查不到会被当
  // 未知 id 回落默认，用户选好的位置会无端跳回默认位。
  if (id === 't10') id = 'b90';
  if (subPosRatio(id) === null) {   // 非档位/滑轨 bNN 之外才视为脏值
    console.warn(`[VocabRadar][overlay] 字幕位置 "${id}" 不合法（非档位/滑轨 bNN），回退默认位置并清理 storage`);
    id = 'b15';
    try {
      chrome.storage.local.set({ subtitlePosition: 'b15' });
    } catch (e) { /* 清理失败忽略 */ }
  }
  _posId = id;
  if (_video && _enabled) onTimeUpdate();
}

/**
 * 应用个性化字幕样式（guide 页四控件：底色/字色/字号/字体）。
 * 外观走 CSS 变量（buildSubtitleStyleCss 生成的 style-custom 规则消费），
 * 变量写入 overlay 内联 style；字号/字体变化会改变 overlay 尺寸，custom 激活时
 * 清 _lastKey 强制重渲染（渲染末尾会 updateOverlayPosition 重定位）。
 * @param {{bg?:string, fg?:string, fontSizePct?:number, sizePct?:number, fontSize?:number, fontFamily?:string}|null} c
 */
export function setSubtitleCustom(c) {
  if (!_overlay || !c || typeof c !== 'object') return;
  // 缺省对齐引导页默认（透明底；旧 storage 残留由 guide 首次写回兜底）。
  // 字号为百分比，经 refreshActivePct 进入 --beaver-sub-fs 实时变量
  // （过渡参数 sizePct 与旧 fontSize 照收）。
  _overlay.style.setProperty('--beaver-custom-bg', c.bg || 'transparent');
  _overlay.style.setProperty('--beaver-custom-fg', c.fg || '#ffffff');
  _customPct = (typeof c.fontSizePct === 'number' && isFinite(c.fontSizePct))
    ? Math.min(12, Math.max(2, c.fontSizePct))
    : ((typeof c.sizePct === 'number' && isFinite(c.sizePct))
      ? Math.min(12, Math.max(2, c.sizePct)) : pxToSizePct(c.fontSize));
  refreshActivePct();
  _overlay.style.setProperty('--beaver-custom-ff', subFontFamily(c.fontFamily));
  // fx 特效拆分写三变量（style-custom 规则消费，见 buildSubtitleStyleCss）：
  // subFxDecl 输出形如 'text-shadow:…' 或 '-webkit-text-stroke:…;paint-order:…'，
  // 按「属性名:」前缀分发到对应变量；fx 无效/none 时回写合法缺省值
  // （描边缺省须 '0 transparent'，'none' 对 -webkit-text-stroke 非法），
  // 保证特效从有→无切换时正确清除残留。
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
 * 个性化/用户注释规则表（#beaver-ann-custom-css 独立元素；annDecl 输出，
 * font-size 照既有口径过滤；custom 对象拼 id，用户条目直用）。
 */
let _annCustomSheet = null;
export function syncAnnCustomRules(customObj, userList) {
  const rules = [];
  const pushEntry = (entry, id) => {
    // 与 buildSubtitleStyleCss annRules 同口径：custom/用户条目同样追加
    //  word 规则（生词字段此前从未消费），选择器显式含 .beaver-word.later
    //  保特异性 (1,4,0) 稳胜基础层；wordDecl 滤 font-size。
    const decl = annDecl(entry).filter((d) => !d.startsWith('font-size')).join(';');
    // wordFg:'inherit' 直出 color:inherit 会覆盖基础层正文颜色——
    //  inherit 语义是"不动"，过滤之。
    const wordDeclCss = wordDecl(entry).filter((d) => !d.startsWith('font-size') && d !== 'color:inherit').join(';');
    if (!decl && !wordDeclCss) return;
    const sel = '#beaver-subtitle-overlay.annstyle-' + id;
    if (decl) {
      rules.push(sel + ' .beaver-overlay-subtitle .beaver-side-ann,' +
        sel + ' .beaver-overlay-ann-word,' +
        sel + ' .beaver-overlay-ann-trans{' + decl + ';}');
      rules.push(sel + ' .beaver-overlay-ann-word{font-weight:600;}');
    }
    if (wordDeclCss) {
      rules.push(sel + ' .beaver-overlay-subtitle .beaver-word,' +
        sel + ' .beaver-overlay-subtitle .beaver-word.later{' + wordDeclCss + ';}');
    }
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
 * 应用视频中字幕的注释样式（第四栏池指派，storage.videoOverlayAnnStyle）。
 * 注释行外观由 annstyle-{id} 类统一控制（规则见 buildSubtitleStyleCss），
 * 纯外观切换，CSS 即时作用于现有 DOM，无需重渲染字幕。
 * ann-custom/ann-user-* 同样挂类（规则由 syncAnnCustomRules 提供）。
 * 'none' 入参仅作防御（视为未知值回退基础外观）：正常调用方（初始读取/
 * onChanged）已先把 'none' 清洗为默认代指样式。
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
    // 本栏（视频叠加注释）回落默认与前三栏分道：落 VANN_DEFAULT_STYLE 常量
    console.warn(`[VocabRadar][overlay] 字幕注释样式 "${id}" 已不存在，回落默认样式 "${VANN_DEFAULT_STYLE}"`);
    setVideoOverlayAnnStyle(VANN_DEFAULT_STYLE);   // 递归深度 1
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
