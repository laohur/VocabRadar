// 文本提示 · 核心模块（常量 / 共享状态 / 通用工具）
//
// === 拆分说明（2026-08-28）===
// 来源：src/content/text-hint-impl.js（2390 行）机械拆分，逻辑与行为零改动。
// 本文件职责：
//   1. 全部模块级常量（高亮类名、面板 ID、分词正则、跳过标签等）
//   2. 全部跨模块共享的可变状态（thState，唯一属主）
//   3. 目标语言缓存及其 chrome.storage 副作用（全项目只此一份注册）
//   4. 通用工具：词阶格式化、body 就绪等待、上下文校验、配色计算/写入、
//      文本样式类、字号同步、朗读、样式注入
//
// 铁律（沿用 vc/state.js 先例，dictionary/state.js dictState 亦同）：
//   共享状态只能有一份定义。thState 是唯一属主，其属性读写即 getter/setter 接缝，
//   其他模块一律 `import { thState } from './core.js'` 后按属性读写，
//   **绝不允许**在别处再 `let` 一份同名变量（否则两份状态各自漂移，功能瘫痪）。
//
// 不放此处的状态：函数内局部变量（如 startHint 的 _scrollScanTimer /
//   _dictRescanArmed、scanSubtree 的批次游标）——它们不跨模块，保持原样即可。
import { t } from '../../lib/i18n.js';
// 反思（2026-08-13 第五十一次）：文本样式差异化（粗细/斜体/下划线/阴影等）
// 279次：侧邻注释样式候选池共享——pickColors 读取池条目 annBg/annFg
// 280次：TEXT/ANN 合并为统一池 POOL_STYLES（别名不变）；wordDecl 用于页面类生成；
//   annBrackets 布尔退役改 annTemplate 模板（DEFAULT_ANN_TEMPLATE 为默认值）
import { TEXT_STYLES, ANN_STYLES, findStyle, resolveAnnEntry, wordDecl, DEFAULT_ANN_TEMPLATE } from '../../lib/styles.js';

// 反思（2026-08-12 第四十一次）：i18n 格式化词阶显示
//   rankToStage 返回中文（如 "3阶"/"表外"），此处用 i18n 重新格式化
export function formatStage(rank) {
  if (rank === null || rank === undefined) return t('th.outside');
  if (typeof rank !== 'number' || !isFinite(rank) || rank <= 0) return t('th.outside');
  const n = Math.floor((rank - 1) / 1000) + 1;
  return t('th.stage', { n });
}
export const HIGHLIGHT_CLASS = 'beaver-word';
export const FIRST_CLASS = 'beaver-word-first';
// 反思（2026-08-06）：后续出现标记类，配合 .beaver-hide-later 实现零重扫切换可见性
//   始终包裹所有出现，laterEnabled=false 时 documentElement 加 .beaver-hide-later
//   CSS 让 .beaver-word-later 透明（看起来像普通文本），切换开关只改类名不重扫
export const LATER_CLASS = 'beaver-word-later';
export const HIDE_LATER_CLASS = 'beaver-hide-later';
// 反思（2026-08-11 第三十三次）：词频阈值变化时用 CSS class 隐藏/显示 span，
//   不再 unwrapAll + 重扫，避免大量 DOM 修改触发网站脚本响应导致白屏。
//   .beaver-word-hidden 设为透明+无背景+无交互，看起来像普通文本
export const HIDE_WORD_CLASS = 'beaver-word-hidden';
// 侧邻注释（2026-08-05）：生词后紧跟的 (释义) span，半角括号，独立配色
//   格式：<span class="beaver-word">word</span><span class="beaver-side-ann">(释义)</span>
//   作为 .beaver-word 的兄弟节点（非子节点），避免 validateSpan 误判失效
export const SIDE_ANN_CLASS = 'beaver-side-ann';
export const PROCESSED_ATTR = 'data-beaver-done';
export const TOOLTIP_ID = 'beaver-hint-tooltip';
export const PANEL_ID = 'beaver-context-panel';
// OCR 结果面板（2026-08-05）：右键图片/视频 OCR 识别结果展示
//   light DOM（非 Shadow），文本节点可被 TreeWalker 扫描注释生词
//   不自动消失（onScrollHide 跳过），仅关闭按钮/Escape 关闭
export const OCR_PANEL_ID = 'beaver-ocr-panel';
export const STYLE_ID = 'beaver-hint-styles';

// 单词提取正则（带 g flag，用于 matchAll 得到位置）
// 与 tokenizer.js 的 TOKENIZE_PATTERN 一致，仅加 'g' flag
export const WORD_G_PATTERN = new RegExp(
  '\\p{Script=Han}|[\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]+|\\p{Extended_Pictographic}+|[^\\W_]+(?:[\'\\u2019\\-][^\\W_]+)*',
  'gu'
);
export const SELECT_PATTERN = new RegExp(
  "^(?!(?:[^'\\u2019]*['\\u2019]){2})[A-Za-z]+(?:[-'\\u2019]+[A-Za-z]+)*$"
);

// 不扫描这些标签内的文本（代码/表单/媒体/脚本等）
// 反思（2026-08-06）：新增非正文语义标签 NAV/HEADER/FOOTER/ASIDE/FORM/MENU/DIALOG
//   参考主流开源产品做法（Readability.js 语义评分 + 沙拉查词选词范围限制），
//   导航/页眉/页脚/侧栏/表单/菜单/对话框内的文本非正文，不应高亮。
//   TreeWalker FILTER_REJECT 会跳过整个子树，效率高。
export const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'INPUT', 'BUTTON',
  'TEXTAREA', 'SELECT', 'OPTION', 'CODE', 'PRE', 'TITLE', 'HEAD',
  'META', 'LINK', 'KBD', 'SAMP', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO',
  'CANVAS', 'MAP', 'AREA', 'TEMPLATE',
  // 非正文语义标签（2026-08-06）：导航/页眉/页脚/侧栏/表单/菜单/对话框
  'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'MENU', 'DIALOG'
]);

// 非正文 ARIA 角色选择器（2026-08-06）
export const NON_CONTENT_SELECTOR = [
  '[role="contentinfo"]',           // 页脚信息
  '[role="complementary"]',         // 补充内容（侧栏）
  '[role="search"]',                // 搜索框
  '[role="menu"]', '[role="menubar"]', // 菜单
  '[role="dialog"]', '[role="alertdialog"]', // 对话框
  '[role="alert"]'                  // 警告提示
].join(', ');

// 反思（2026-08-06）：JavaScript 特殊值过滤集
//   页面 JS 计算异常时会产生 "NaN"/"undefined"/"Infinity" 文本，
//   这些不是真实英文单词，但会匹配 WORD_G_PATTERN 且 "nan" 在词频词典中 rank=15282，
//   导致被高亮为生词（用户反馈"文本提示出现了NaN"）。
export const JS_SENTINELS = new Set(['nan', 'undefined', 'infinity']);

// === 状态（唯一属主）===
//
// 字段与拆分前的模块级变量一一对应（原名 → 现名）：
//   _meaningLang→meaningLang, _enabled→enabled, _rankThreshold→rankThreshold,
//   _annotateOov→annotateOov, _annotateRepeat→annotateRepeat,
//   _scanScheduled→scanScheduled, _colors→colors,
//   _contextInvalidated→contextInvalidated, _wrapCount→wrapCount,
//   _startedEver→startedEver, _lastStartError→lastStartError,
//   _seenWords→seenWords, _wordCache→wordCache, _tooltip→tooltip,
//   _panel→panel, _ocrPanel→ocrPanel, _observer→observer,
//   _hideTimer→hideTimer, _panelHideDelay→panelHideDelay,
//   _scrollHandler→scrollHandler, _tooltipTargetEl→tooltipTargetEl,
//   _curTextStyle→curTextStyle, _tooltipWord→tooltipWord,
//   _lastPointerX→lastPointerX, _lastPointerY→lastPointerY
export const thState = {
  // 反思（2026-08-12 第四十二次）：缓存当前目标语言，用于检查 IDB 中的翻译是否匹配。
  //   lookupFull 返回的 record.translationLang 需与此比较，不匹配则翻译已过期需重新查询。
  meaningLang: 'zh',
  enabled: false,
  // 反思（2026-08-14 第五十四次修正）：默认词频阈值恢复 5000，撤销第五十二次误改的 0
  rankThreshold: 5000,
  // 反思（2026-08-07）：用户反馈"并没有选中注释表外，依然注释了"。
  //   反思（2026-08-14 第五十四次）：设置键改名 localTranslateEnabled → annotateOov，
  //   默认 false（注释表外词默认不选）。
  annotateOov: false,
  // 反思（2026-08-15 第六十二次）：false=同文本节点内重复词只注释首次；true=每次出现都注释。
  annotateRepeat: false,
  // 280次：侧邻注释模板——annBrackets 布尔退役改 annTemplate 字符串模板
  //   （{word}/{meaning} 变量，默认 {word}({meaning})），消费方用 renderAnnText 渲染。
  //   旧 storage 值由 text-hint.js 启动迁移（migrateAnnBrackets）。
  annTemplate: DEFAULT_ANN_TEMPLATE,
  scanScheduled: false,
  // 反思（2026-08-28 第一百六十九次）：scanScheduled 只防"调度重入"，run() 一开头
  //   就置回 false，因此 scanSubtree 分批执行期间（requestIdleCallback 逐批推进，
  //   大页面可持续数秒）任何 scroll/MutationObserver 都能再调度一轮 scanSubtree，
  //   多轮并发交错遍历同一棵树 → 重复查词、扫描迟迟不结束（用户："文本许久在扫"）。
  //   修正：scanRunning 标记"扫描执行中"，执行中的调度请求合并为一个 scanPendingRoot，
  //   本轮结束后再跑一次。
  scanRunning: false,
  scanPendingRoot: null,
  // 反思（2026-08-18 第七十三次修正）：默认配色曾是单词绿底白字。
  // 302次注释默认改透明底绿字；304次（用户"默认无底色"）：生词底色一并去底——
  //   默认即透明底绿字（微读绿字式），白底绿字/绿底白字旧口径作废。
  colors: {
    firstEnabled: true, firstBg: 'transparent', firstFg: '#2e6b43',
    laterEnabled: true, laterBg: 'transparent', laterFg: '#2e6b43',
    sideAnnotation: true, annBg: 'transparent', annFg: '#2e6b43'
  },
  // 反思（2026-08-06）：扩展更新/重载后旧内容脚本的 chrome.runtime 上下文失效，
  //   translate 调用必然抛 "Extension context invalidated"，标记后跳过后续调用。
  contextInvalidated: false,
  // 诊断计数（2026-08-14 第五十四次）：已包裹生词数，供诊断悬浮窗展示
  wrapCount: 0,
  // 诊断标记（2026-08-14 第五十六次）：startHint 是否被调用过 / 最后一次启动错误
  startedEver: false,
  lastStartError: null,
  seenWords: new Set(),
  wordCache: new Map(),
  tooltip: null,
  panel: null,
  ocrPanel: null,
  observer: null,
  hideTimer: null,
  panelHideDelay: 5000,
  scrollHandler: null,
  tooltipTargetEl: null,
  // 反思（2026-08-13 第五十一次）：当前生效的文本样式 id
  curTextStyle: 'none',
  // 反思（2026-08-06）：当前 tooltip 显示的单词，用于异步音标加载后校验是否仍是同一个词
  tooltipWord: '',
  // 反思（2026-08-18 第七十五次修正）：最近一次 pointermove 的视口坐标
  lastPointerX: -1,
  lastPointerY: -1
};

// === 第一百九十次：侧注开关诊断 getter（"★首条侧注释出现 未发生"的预期/需查判别）===
// 用户实测确认：网页侧栏注释开关本来就关着 —— 此时"未发生"是预期现象而非故障。
// main-text.js 渲染耗时表时读取此值，未发生时区分标注「预期」与「需查」。
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__beaverSideAnnOn', {
    get() { return !!(thState.colors && thState.colors.sideAnnotation); },
    configurable: true
  });
}

// === 第一百八十六次：网页提示全链路分段计时 ===
//
// 用户症状："目前测试显示解析至多耗时一秒，但体感好几秒才出现网页提示，解析之外的耗时
//   也要调查。说了是网页，从网页文本出现到提示出现，不是点击聊天。"
//
// 因此必须测量的是「网页文本出现 → 高亮/注释出现」这条链路，而不是正文提取算法本身。
// 基准取 performance.now()（相对 timeOrigin＝本次导航开始），故每个打点值即"页面开始
//   计时多少毫秒后发生"，可直接与 domContentLoaded 对齐比较，无需另设起点。
//
// 埋点只做一次记录（首次为准），因为要回答的是"第一个提示什么时候出现"；
//   重复轮次（滚动重扫、词典就绪重扫）另用 repeat 计数体现，不覆盖首轮时刻。
export const thTiming = {
  marks: {},          // 名称 -> 首次发生时刻（ms，相对导航开始）
  counts: {},         // 名称 -> 发生次数（滚动重扫等重复事件用）
  extra: {}           // 附加数值（节点数、批数、串行查词次数等）
};

// 第一百九十六次：boot 拆段——classic 入口（text-hint.js 顶部）记录的开跑时刻回填进时间线。
//   「DCL→hint:scriptStart」＝浏览器注入等待，「scriptStart→hint:start」＝动态 import 的
//   ESM 模块图装载。用户实测 DCL→startHint 1685ms 无从下手，拆开后才知道优化谁。
try {
  if (typeof window !== 'undefined' && typeof window.__beaverHintScriptAt === 'number') {
    thTiming.marks['hint:scriptStart'] = window.__beaverHintScriptAt;
    thTiming.counts['hint:scriptStart'] = 1;
  }
} catch (_) { /* ignore */ }

/**
 * 打一个链路时间点（首次为准，重复只累加计数）
 * @param {string} name 打点名
 */
export function thMark(name) {
  if (!(name in thTiming.marks)) {
    thTiming.marks[name] = performance.now();
    // 关键节点即时出声（不藏日志）：用户体感的两个时刻——首个高亮、首条侧注释。
    if (name === 'hint:firstHighlight' || name === 'hint:firstAnn') {
      const t = thTiming.marks[name];
      const s = thTiming.marks['hint:start'];
      let dcl = null;
      try {
        const nav = performance.getEntriesByType('navigation')[0];
        if (nav && nav.domContentLoadedEventEnd) dcl = nav.domContentLoadedEventEnd;
      } catch (_) { /* ignore */ }
      const label = name === 'hint:firstHighlight' ? '首个高亮' : '首条侧注释';
      console.log('[VocabRadar][text-hint] ' + label + ' @ ' + Math.round(t) + 'ms'
        + (dcl != null ? '（DOMContentLoaded 后 ' + Math.round(t - dcl) + 'ms）' : '')
        + (s != null ? '（startHint 后 ' + Math.round(t - s) + 'ms）' : '')
        + '，分段耗时详见诊断窗 timing');
    }
  }
  thTiming.counts[name] = (thTiming.counts[name] || 0) + 1;
}

/**
 * 记录附加数值（累加型，如节点数/批次数/查词次数）
 * @param {string} name 字段名
 * @param {number} [n] 增量，默认 1
 */
export function thAdd(name, n) {
  thTiming.extra[name] = (thTiming.extra[name] || 0) + (typeof n === 'number' ? n : 1);
}

/**
 * 取链路时间线快照（供诊断浮窗展示）
 *
 * domContentLoaded 用 PerformanceNavigationTiming（无则退回 legacy timing），
 *   它就是"网页文本出现"的可观测代理时刻——提示时刻减它即用户真正体感的等待。
 * @returns {{marks:Object, counts:Object, extra:Object, dcl:number|null, now:number}}
 */
export function getHintTiming() {
  let dcl = null;
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav && nav.domContentLoadedEventEnd) dcl = nav.domContentLoadedEventEnd;
    else if (performance.timing && performance.timing.domContentLoadedEventEnd) {
      dcl = performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart;
    }
  } catch (_) { /* 取不到就留 null，不遮蔽也不阻断 */ }
  return {
    marks: Object.assign({}, thTiming.marks),
    counts: Object.assign({}, thTiming.counts),
    extra: Object.assign({}, thTiming.extra),
    dcl,
    now: performance.now()
  };
}

// 供诊断浮窗跨模块读取（content script 内 window 挂钩，与 __beaverHintDiag 同范式）
try { window.__beaverHintTiming = getHintTiming; } catch (_) { /* ignore */ }

// 目标语言订阅（模块级副作用，全项目仅此一处注册）
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get({ meaningLanguage: 'zh' }, (res) => {
    thState.meaningLang = res.meaningLanguage || 'zh';
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.meaningLanguage) {
      thState.meaningLang = changes.meaningLanguage.newValue || 'zh';
    }
  });
}

// 反思（2026-08-12 第四十四次）：用户反馈"Bing 等网站悬浮球缺失"、"Edge 网页无提示"。
//   根因：部分网站（如 cn.bing.com）在 document_idle 时 document.body 可能尚未就绪
//   或被框架替换，导致 scheduleScan(document.body) 和 _observer.observe(document.body)
//   抛异常或无效，文本提示完全不工作。
//   修正：新增 waitForBody() 等待 body 就绪，startHint 中等待 body 后再扫描/观察。
export function waitForBody(timeout = 3000) {
  return new Promise((resolve) => {
    if (document.body) return resolve(document.body);
    const deadline = Date.now() + timeout;
    const check = () => {
      if (document.body || Date.now() >= deadline) {
        return resolve(document.body || document.documentElement);
      }
      setTimeout(check, 50);
    };
    setTimeout(check, 50);
  });
}

// 反思（2026-08-19 第七十六次修正）：isContextValid 在 AI 三区域合并损坏中丢失定义，
//   但多处仍调用 → 每次调用抛 ReferenceError，processBatch 的 try/catch 吞掉异常
//   → 网页完全没有提示。恢复定义。
//   语义：chrome.runtime.id 非空 = 扩展上下文仍有效（扩展重载后旧页面 CS 失效）。
export function isContextValid() {
  return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
}

/**
 * 配色热更新：颜色变化直接改 CSS 变量；开关变化不操作 DOM（避免消失）
 * @param {object} settings 完整设置
 * 反思（2026-08-06 二次修正）：用户反馈"点击几次文本提示就消失了"。
 *   旧版在 sideAnnotation 开关变化时调用 applySideAnnotationToAll/removeAllSideAnnotations
 *   直接操作 DOM，虽然不重扫但仍有副作用（反复追加/移除 span 可能导致框架 DOM 错乱）。
 *   用户建议"实在做不好就算了，提示用户刷新后生效"。
 *   修正：updateColors 只做 CSS 变量热更新（applyColorVars），不操作 DOM。
 *   开关变化（sideAnnotation/laterEnabled）需要刷新页面才能生效：
 *     - laterEnabled：CSS 类 .beaver-hide-later 已即时切换（无需刷新，后续可见性即时生效）
 *     - sideAnnotation：已扫描的 span 不会追加/移除注释，需刷新后重新扫描
 *   配色变化（bg/fg）：CSS 变量即时生效，无需刷新。
 */
export function updateColors(settings) {
  if (!thState.enabled) return;
  applyColorVars();
  // 文本样式差异化：挂 beaver-text-style-{id} 类到 <html>
  const id = settings.textStyle || 'none';
  applyTextStyleClass(id);
  // 反思（2026-08-06）：不再在开关变化时操作 DOM，避免"点击几次文本提示消失"。
  //   sideAnnotation 开关变化需刷新页面生效（新扫描的词才追加注释）。
  //   laterEnabled 开关变化由 CSS 类 .beaver-hide-later 即时控制（无需刷新）。
}

// 反思（2026-08-13 第五十一次）：文本样式差异化应用。
//   颜色部分由 applyColorVars 写入 CSS 变量（即时生效），
//   字体属性（粗细/斜体/下划线/阴影/圆角）由 html.beaver-text-style-{id} 类控制。
export function applyTextStyleClass(id) {
  const root = document.documentElement;
  if (thState.curTextStyle && thState.curTextStyle !== 'none') {
    root.classList.remove('beaver-text-style-' + thState.curTextStyle);
  }
  thState.curTextStyle = id || 'none';
  if (thState.curTextStyle !== 'none') {
    root.classList.add('beaver-text-style-' + thState.curTextStyle);
  }
}

/** 从 settings 提取配色字段 */
// 反思（2026-08-05 重构）：用户要求"生词 背景色 前景色 / 注释 背景色 前景色"
//   移除首次/后续独立配色，合并为统一的"生词"配色（hintFirstBg/Fg）。
//   后续出现的词复用相同配色（laterBg/Fg = firstBg/Fg）。
//   hintLaterEnabled 控制是否高亮后续出现的词（默认 false=仅首次高亮）。
//   hintSideAnnotation 控制是否显示侧邻注释（默认 false=不显示）。
// 反思（2026-08-06 修正）：用户要求"注释为单词的前后景互换，总共两种颜色"。
//   旧版注释配色独立配置（hintAnnotationBg/Fg），storage 中的旧值会导致"设定栏暗底亮字但实际暗底暗字"。
//   修正：注释配色自动派生自单词配色（annBg=firstFg, annFg=firstBg），不再读 hintAnnotationBg/Fg。
//   这样注释始终是单词的前后景互换，与 sidebar.js applyColorSettings 逻辑一致。
/** 判断颜色是否为不透明实底（透明/带 alpha 的 rgba 视为非实底，用于防御派生配色与描边） */
// 280次：补 gradient 识别——统一池引入渐变底（如马克笔半高 linear-gradient(transparent 55%...)），
//   渐变底视觉上非实底（下半透明），派生注释配色应走透明底分支，且首现 1px 描边应清除。
export function isOpaqueBg(color) {
  if (!color) return false;
  if (/^transparent$/i.test(color)) return false;
  if (/gradient\(/i.test(color)) return false;
  if (/^rgba\(/i.test(color)) {
    const m = color.match(/[\d.]+\)$/);
    const alpha = m ? parseFloat(m[0]) : 1;
    if (alpha < 1) return false;
  }
  return true;
}

export function pickColors(s) {
  // 反思（2026-08-18 第七十三次修正）：默认配色——用户明确"网页提示默认配色是
  //   单词绿底白字，注释是白底绿字"。旧版 #0d2014（近黑）/#a8e6cf（青）被视为黑色。
  // 280次：统一池接入——textStyle 命中池条目时，生词底/字色取条目 wordBg/wordFg
  //   （渐变/透明底字符串同样经 --beaver-first-bg 变量生效，页面用 background shorthand）；
  //   优先级：popup 显式 hintFirstBg/Fg > 池条目 > 默认（304次：透明底绿字）。
  // 301次：custom/用户条目经 resolveAnnEntry 解析（settings 直通 caches）。
  const txtSt = resolveAnnEntry(s.textStyle, s.annotationCustom, s.annotationUserStyles);
  const wordBg = s.hintFirstBg || (txtSt && txtSt.wordBg) || 'transparent';
  const wordFg = s.hintFirstFg || (txtSt && txtSt.wordFg) || '#2e6b43';
  // 反思（2026-08-15 第六十四次）：透明/半透明底色样式（下划线/荧光/描边等，wordBg=transparent
  //   或带 alpha 的 rgba）派生侧邻注释时，annFg=wordBg 会得到透明字色 → 注释文字不可见。
  // 反思（2026-08-15 第六十五次修正）：上一版把注释底设为 wordFg（如荧光笔 #332700 深色）
  //   + 白字，用户反馈"为何把透明当作黑色——透明就透明，直视背景色，不要设定它色"。
  //   修正：底色非不透明时，注释底=transparent（直显页面背景），注释字=wordFg（可读同色系）；
  //   底色实底时保持"前后景互换"（注释底=wordFg，注释字=wordBg）。
  // 反思（2026-08-18 第七十三次修正）：popup 可独立设置注释配色（hintAnnotationBg/Fg），
  //   旧版忽略这两个字段永远用派生色 → "选的样式跟实际展现的没关系"。
  //   修正：显式设置优先；未设置时仍走派生（实底→前后景互换，透明底→透明+同色系）。
  const explicitAnnBg = s.hintAnnotationBg;
  const explicitAnnFg = s.hintAnnotationFg;
  // 279次：注释样式候选池共享——annotationStyle 命中池条目（ANN_STYLES）时，
  //   侧邻注释色取条目 annBg/annFg；优先级：显式 hintAnnotationBg/Fg > 池条目 >
  //   默认派生（'none' 无 annBg/annFg 字段，自然落到派生分支，行为与旧版一致）。
  // 301次：同上走 resolveAnnEntry（custom/用户条目）。
  const annSt = resolveAnnEntry(s.annotationStyle, s.annotationCustom, s.annotationUserStyles);
  const opaque = isOpaqueBg(wordBg);
  // 302次（用户"注释也应当没有背景色"）：默认派生改透明底（显式设置与池条目照旧优先）。
  const annBg = explicitAnnBg || (annSt && annSt.annBg) || 'transparent';
  const annFg = explicitAnnFg || (annSt && annSt.annFg) || (opaque ? wordBg : wordFg);
  return {
    firstEnabled: true,          // 首次出现总是高亮（不再有开关）
    firstBg: wordBg,             // 生词底色（亮色高亮，吸睛）
    firstFg: wordFg,             // 生词字色
    laterEnabled: s.hintLaterEnabled === true,  // 生词多次出现开关
    laterBg: wordBg,             // 后续出现复用生词配色（不再独立配置）
    laterFg: wordFg,
    // 侧邻注释：开关 + 注释底色/字色（自动派生自单词配色，前后景互换；透明底则透明+同色系）
    sideAnnotation: s.hintSideAnnotation === true,
    annBg,
    annFg
  };
}

/** 把配色写入 CSS 变量（:root），样式表通过 var() 引用 */
export function applyColorVars() {
  const root = document.documentElement;
  root.style.setProperty('--beaver-first-bg', thState.colors.firstBg);
  root.style.setProperty('--beaver-first-fg', thState.colors.firstFg);
  root.style.setProperty('--beaver-later-bg', thState.colors.laterBg);
  root.style.setProperty('--beaver-later-fg', thState.colors.laterFg);
  // 侧邻注释配色变量（视频提示字幕/视频内字幕复用）
  root.style.setProperty('--beaver-ann-bg', thState.colors.annBg);
  root.style.setProperty('--beaver-ann-fg', thState.colors.annFg);
  // 反思（2026-08-06）：后续出现可见性由 CSS 类控制，不重扫
  //   laterEnabled=false → 加 .beaver-hide-later（后续高亮透明）
  //   laterEnabled=true  → 移除类（后续高亮正常显示）
  if (thState.colors.laterEnabled) {
    root.classList.remove(HIDE_LATER_CLASS);
  } else {
    root.classList.add(HIDE_LATER_CLASS);
  }
  console.log('[VocabRadar][text-hint] 配色变量已应用:', {
    firstBg: thState.colors.firstBg, firstFg: thState.colors.firstFg,
    annBg: thState.colors.annBg, annFg: thState.colors.annFg,
    laterEnabled: thState.colors.laterEnabled, sideAnnotation: thState.colors.sideAnnotation
  });
}

// 反思（2026-07-07）：用户要求"正文字号应当同网页正文字号"。
// panel/tooltip 挂在 document.documentElement 上，默认继承 <html> 字号（通常16px），
// 而非 <body> 的字号（B站等可能为14px）。每次显示时同步 body 计算字号到宿主元素。
// 反思（2026-08-19 第八十一次）：字号下限钳制 14px——部分站点正文仅 12px，
//   悬浮提示/右键面板跟随后过小不可读（用户反馈"有时候文本悬浮提示的字号小"）。
//   正文 ≥14px 时仍完全跟随正文（满足 2026-07-07"正文字号同网页正文"约束）。
export function syncBodyFontSize(el) {
  try {
    if (!document.body) return;  // 防御：body 未就绪时跳过
    const fs = parseFloat(getComputedStyle(document.body).fontSize) || 0;
    if (fs) el.style.fontSize = (fs >= 14 ? fs : 14) + 'px';
  } catch (_) { /* ignore */ }
}

// === 朗读（Web Speech API） ===

export function speak(word) {
  if (!('speechSynthesis' in window)) {
    console.warn('[VocabRadar][text-hint] speechSynthesis 不可用');
    return;
  }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(word);
  u.lang = 'en-US';
  u.rate = 0.9;
  window.speechSynthesis.speak(u);
  console.log(`[VocabRadar][tts] 朗读: ${word}`);
}

// 301次：单条目文本样式规则（上面 injectStyles 的 map 体抽出；extra 刷新复用）。
function annTextStyleRule(s) {
  const rules = wordDecl(s, { important: true, colors: false });
  // 反思（2026-08-15 第六十四次）：透明/半透明底色样式清除首现 1px 深色描边，
  //   避免透明底上浮现深色框（用户反馈"透明当作黑色"）。特定选择器覆盖 FIRST_CLASS 描边。
  if (!isOpaqueBg(s.wordBg)) rules.push('box-shadow:none !important');
  return 'html.beaver-text-style-' + s.id + ' .' + HIGHLIGHT_CLASS + '{' + rules.join(';') + ';}';
}

// 301次：个性化/用户条目文本样式规则刷新（#beaver-ann-extra-css-th 独立表；
//   custom 对象拼 id，用户条目直用；空即清空，不留残留）。
export function refreshAnnExtraCss(customObj, userList) {
  let el = document.getElementById('beaver-ann-extra-css-th');
  const parts = [];
  if (customObj && typeof customObj === 'object') {
    parts.push(annTextStyleRule(Object.assign({ id: 'ann-custom' }, customObj)));
  }
  if (Array.isArray(userList)) {
    for (const st of userList) {
      if (st && typeof st.id === 'string' && st.id.indexOf('ann-user-') === 0) {
        parts.push(annTextStyleRule(st));
      }
    }
  }
  if (!parts.length) {
    if (el) el.textContent = '';
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = 'beaver-ann-extra-css-th';
    document.documentElement.appendChild(el);
  }
  el.textContent = parts.join('\n');
}

// === 样式注入 ===
// 颜色通过 CSS 变量引用（applyColorVars 写入 :root），改色无需重写样式表
export function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    .${HIGHLIGHT_CLASS} {
      background: var(--beaver-later-bg, transparent) !important;
      color: var(--beaver-later-fg, #2e6b43) !important;
      border-radius: 3px !important;
      padding: 0 2px !important;
      cursor: pointer !important;
      transition: filter 0.2s !important;
    }
    .${HIGHLIGHT_CLASS}:hover { filter: brightness(1.1) !important; }
    .${FIRST_CLASS} {
      /* 304次（用户"默认无底色"）：回退值同步透明底绿字；1px 描边删除
         （实底上不可见，透明底上是多余 chrome；透明池条目同口径已清，见上）。 */
      background: var(--beaver-first-bg, transparent) !important;
      color: var(--beaver-first-fg, #2e6b43) !important;
    }
    /* 反思（2026-08-06）：后续出现可见性由 .beaver-hide-later 控制（零重扫）
     *   laterEnabled=false 时 documentElement 加 .beaver-hide-later，
     *   后续高亮变透明（看起来像普通文本），不响应交互，侧邻注释也隐藏。
     *   laterEnabled=true 时移除类，后续高亮正常显示。切换无重扫、无闪烁。 */
    .${HIDE_LATER_CLASS} .${LATER_CLASS} {
      background: transparent !important;
      color: inherit !important;
      box-shadow: none !important;
      pointer-events: none !important;
    }
    .${HIDE_LATER_CLASS} .${LATER_CLASS}:hover { filter: none !important; }
    .${HIDE_LATER_CLASS} .${LATER_CLASS} + .${SIDE_ANN_CLASS} { display: none !important; }
    /* 反思（2026-08-11 第三十三次）：词频阈值变化时用 CSS class 隐藏 span，
     *   不 unwrapAll + 重扫，避免 DOM 修改触发网站脚本响应导致白屏。
     *   .beaver-word-hidden 透明+无背景+无交互，看起来像普通文本 */
    .${HIDE_WORD_CLASS} {
      background: transparent !important;
      color: inherit !important;
      box-shadow: none !important;
      pointer-events: none !important;
    }
    .${HIDE_WORD_CLASS}:hover { filter: none !important; }
    .${HIDE_WORD_CLASS} + .${SIDE_ANN_CLASS} { display: none !important; }
    /* 侧邻注释（2026-08-05）：生词后紧跟的 (释义) span，半角括号，独立配色
     *   使用 --beaver-ann-bg/fg 变量（与视频提示字幕/视频内字幕复用同一套配色）
     *   默认深绿底亮绿字（单词配色的前后景互换），与生词形成反相对比 */
    .${SIDE_ANN_CLASS} {
      background: var(--beaver-ann-bg, transparent) !important;
      color: var(--beaver-ann-fg, #2e6b43) !important;
      border-radius: 3px !important;
      padding: 0 2px !important;
      margin-left: 1px !important;
      font-size: 0.9em !important;
      font-weight: inherit !important;
    }
    /* 反思（2026-08-13 第五十一次）：文本样式差异化。
     * 颜色由 applyColorVars 的 CSS 变量控制；以下类补充字体属性差异。
     * 反思（2026-08-15 第六十三次）：新增 fontSize 支持（大字样式）。
     * 280次：统一池——字体/边框/描边/着重号/动画等全部字段改由 wordDecl 生成
     *   （colors:false：底色字色仍走 --beaver-first-* 变量，渐变经变量生效）；
     *   isOpaqueBg 已识别渐变底，透明/渐变底同样清除首现 1px 描边。 */
    ${TEXT_STYLES.filter((s) => s.id !== 'none').map(annTextStyleRule).join('\n')}
    /* 280次：隐藏态清理——统一池新增的描边/着重号/边框/动画/背景图等字段
     *   会让 .beaver-word-later / .beaver-word-hidden 隐藏词露出轮廓，
     *   特异性 (0,3,0) 高于上方生成规则，维持"零重扫隐藏"语义 */
    .${HIDE_LATER_CLASS} .${LATER_CLASS}, .${HIDE_WORD_CLASS} {
      -webkit-text-stroke: 0 !important;
      text-emphasis: none !important;
      animation: none !important;
      text-decoration: none !important;
      text-shadow: none !important;
      border: none !important;
      background-image: none !important;
    }
    /* 280次：blink 动画帧（统一池条目 blink；只动 background-color，覆盖变量底色） */
    @keyframes beaver-ann-blink {
      0%, 100% { background-color: #fde68a; }
      50% { background-color: transparent; }
    }
  `;
  document.documentElement.appendChild(s);
}
