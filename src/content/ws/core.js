// VocabRadar 全站网页侧栏 —— 核心模块（core）
// 职责：唯一存放跨模块共享的模块级状态（只有一份定义，跨模块写入统一走本文件导出的 set_xxx 接缝）、
//       扫描/渲染共用常量，以及基础工具函数（日志、时间戳、视口钳位、注入根、吐司、
//       HTML/正则/CSS 转义、时间格式化、按钮闪烁、短译文挑选、块文本提取、切句、
//       侧栏状态持久化、配色与注音样式应用）。
// 另含一处模块级副作用（全局唯一，不得重复注册）：源语言缓存的 chrome.storage 读取与 onChanged 监听。
// 说明：由 web-sidebar-impl.js 机械拆分而来，代码逐字保留，未改动任何逻辑。
//
// 第一百八十次（2026-08-30）：原先这里有 ASR_FALLBACK_IFRAME 监听器，在**网页 DOM** 内
//   创建隐藏 iframe（moz-extension://…/offscreen.html）承载 Firefox 的 whisper 宿主。
//   该路径被网页 CSP 拦（Firefox 对内容脚本发起的 DOM 加载施加网页 CSP；实测
//   learn.microsoft.com 的 `default-src *` 不匹配 moz-extension:），且旧实现无论成败
//   都 resolve({ok:true}) 遮蔽错误。宿主已改建在后台 event page 自身 document 内
//   （src/background/service-worker.js#ensureFallbackIframe），故此处整段删除。

// （第二百二十五次：原 pickCleanShortTrans 导入随转发包装 pickRandomShortTrans 的删除一并移除）

// 句子分隔正则：句号/感叹/问号/中文标点/换行
const SENTENCE_SPLIT_RE = /[.!?。！？\n]+/;

// 第二百二十五次：删除死常量 PROCESSED_ATTR（='data-beaver-web-gen'）——《命名清查》查明
//   全库无任何读写该属性之处（正文处理代际标记实际由 th 侧 PROCESSED_ATTR='data-beaver-done'
//   承担，本文件该常量从未被引用），连同与 th/core.js 同名不同值的混淆一并消除。

// === 模块状态 ===
export let _root = null;                  // 根元素 #beaver-web-sidebar

export let _activeTab = 'sentences';     // 当前标签：sentences | words | asr | ocr

export let _noAnnotation = false;        // 不显示注释（第二百三十九次：句标签工具栏加回 Annotation 按钮控制；inactive=true → 句子面板渲染 defuddle 提取的纯正文）

export let _detailMode = false;          // 详略模式：false=简略，true=详细

// 反思（2026-08-14 第五十四次修正）：默认词频阈值恢复 5000，撤销第五十二次误改的 0。
//   用户裁定"调整词频就能凸显，不应更改默认值"。
export let _rankThreshold = 5000;            // 词频阈值

// 反思（2026-08-14 第五十四次）：设置键改名 localTranslateEnabled → annotateOov；
//   默认 false（注释表外词默认不选）。
export let _annotateOov = false;             // 注释表外词

// 注释重复生词（2026-08-15 第六十二次：默认不选，同一文本节点内重复词仅注释首次）
export let _annotateRepeat = false;

export let _wordOnlyMode = false;        // 词单模式：仅显示单词

// 句子/注释数据
export let _pageSentences = [];          // 页面文本句子 [{text}]

export let _pageSentenceEls = [];        // 句子 DOM 元素数组

export let _allAnnotations = [];         // 生词本：所有首次出现的生词注释（跨来源汇总）

export let _seenWords = new Set();       // 跨句子去重

// 第一百八十六次（用户："依旧重复单词。"）：词表已收词键集（wordDedupKey 口径）。
//   根因：collectToWordPanel 原先用 `_allAnnotations.some(...)` 判重，那是
//   check-then-act —— 多句注释 Promise 各自 .then 里先扫一遍数组、再 push，
//   两步之间可被另一句的回调插入同词，重复就此产生（与 annotator 第一百八十二次
//   修过的 TOCTOU 同型）。改为独立键集：判重与登记在同一同步块内完成，
//   且查询是 O(1)，不再随词表增长退化。
//   与 _allAnnotations 的同步：set_allAnnotations 一律按新数组重建键集
//   （覆盖所有清空/替换入口，不会漏清）；数组内 push 的路径须调 addWordKey。
export let _wordKeys = new Set();

/** 词表是否已收该词（wordDedupKey 口径的键） */
export function hasWordKey(key) { return _wordKeys.has(key); }

/** 登记词表已收词键（返回 true 表示本次是首次登记，调用方据此决定是否入表） */
export function addWordKey(key) {
  if (!key || _wordKeys.has(key)) return false;
  _wordKeys.add(key);
  return true;
}

export let _seenSentences = new Set();   // 页面句子去重（避免重复扫描）

// 第一百三十九次（用户反馈"句子有重复单词"）：规范化句子键——两条扫描路径
// （总线 data-beaver-orig 与 getBlockText 兜底）对同一可见句可能产出仅空白/
// 大小写不同的字符串，精确匹配挡不住 → 同句入列两次、词重复出现。统一以
// normSentKey（小写+空白折叠）为去重基准，原文仍按参数原样展示。
function normSentKey(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// 第一百八十三次（用户："文本侧栏的句子会重复"）：把规范化键导出——入库唯一汇入点
//   appendPageSentence 需要用同一口径做"已在库则不再追加"的最终关口，
//   mergeAnnotationsForSentence 也需用它取代精确相等查找（口径不一致会静默丢词条）。
export { normSentKey };

// 第一百九十三次（用户："文本侧栏的句子生词重复还没解决"）：页级首现句权威表。
//   键 = wordDedupKey(词面 trim+小写)，值 = normSentKey(该词首次入库句子的规范化句键)。
//   由入库唯一汇入点 appendPageSentence（及 merge 补词）在**同步代码内**登记：
//   词首见即定格其首现句，此后渲染端（ws/scanner.js fillSlotAnnotations）据此补齐
//   isFirst——不再依赖上游是否携带该字段（总线路径词条带 isFirst，但兜底路径
//   lib/annotator.js#getAnnotations 不产出，历史缓存同样没有，`a.isFirst === false`
//   对 undefined 恒不触发，第一百九十一/一百九十二次的判据因此形同虚设）。
//   语义：无论数据来自总线/历史块回放/兜底扫描，「注释重复生词」关闭时每个生词
//   只在其首次入库的句子出提示（高亮+括号/注释行），其余句子保持纯文本。
export let _firstSentMap = new Map();

export function hasSentenceKey(sent) { return _seenSentences.has(normSentKey(sent)); }

export function addSentenceKey(sent) { _seenSentences.add(normSentKey(sent)); }

export let _annotationsCache = new Map();// sub对象 -> annotations Promise 缓存

export let _collectedSubs = new WeakSet();

// 页面扫描状态
export let _scanScheduled = false;

// === 工具函数 ===
export function log(...args) {
  console.log('[VocabRadar][web-sidebar]', ...args);
}

export function ts() {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// 冒泡提示（替代 alert）
// 反思（2026-08-12 第四十六次）：用户反馈"Bing 等网站悬浮球依旧缺失"。
//   根因：部分网站（如 cn.bing.com）的 SPA 框架会替换 document.body 或清除其子节点，
//   导致 appendChild 到 body 的悬浮球被移除。
//   修正：始终注入到 document.documentElement（<html>元素），不被框架替换；
//   新增 MutationObserver 监听 _root 被移除时自动重新注入。
// === 悬浮球位置视口夹取（2026-08-22 第九十四次）===
// 反思：用户反馈引导页"过一会儿文本侧栏消失"——启动异步恢复 webSidebarPos 时，
//   保存位置可能来自其他网页/更大视口/别的显示器，!important 内联定位把球放到
//   当前视口之外（页面刚加载时球还在默认位，恢复一执行就"消失"）。
//   恢复与保存一律夹取到当前视口内（48px 球体留边）。
export function clampPosToViewport(left, top) {
  const size = 48;
  const maxL = Math.max(0, window.innerWidth - size);
  const maxT = Math.max(0, window.innerHeight - size);
  if (!isFinite(left) || !isFinite(top)) return { left: maxL, top: 8 };
  return {
    left: Math.min(Math.max(0, left), maxL),
    top: Math.min(Math.max(0, top), maxT)
  };
}

// === 第一百八十七次：面板矩形的视口夹取（用户："侧栏位置乱跑"）===
// 反思：旧版展开态面板也走 clampPosToViewport——那是按 **48px 悬浮球** 写死的夹取，
//   maxT = 视口高 - 48。一个 380×760 的面板只要 top 略大，就被夹到 “视口高-48”，
//   于是面板整体沉到视口底边只露 48px，用户看到的就是“位置乱跑”。
//   本函数按面板自身宽高夹取，保证整块面板留在视口内；装不下时贴左上。
// 第二百四十六次（用户："侧栏不能拖动太低"；拍板"把手可见即可"）：top 上限从
//   "整高不出屏"（innerHeight - h，75vh 侧栏顶部最多到 25vh）放宽为"把手可见即可"
//   ——标题栏约 42px（sidebar-topbar.js padding 10+10 + 内容），取 44px 留屏内可抓，
//   主体允许探出下沿。与 ui.js onMove 的拖动 clamp 同语义，恢复路径不再把用户拖低的
//   位置拉回。x 方向与 top 下限保持"不出上/左沿"不变（用户未诉求放宽）。
export function clampRectToViewport(left, top, width, height, grabH = 44) {
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  const grab = Math.max(0, Math.min(Number(grabH) || 44, h));
  const maxL = Math.max(0, window.innerWidth - w);
  const maxT = Math.max(0, window.innerHeight - grab);
  const l = isFinite(left) ? left : maxL;
  const t = isFinite(top) ? top : 0;
  return {
    left: Math.min(Math.max(0, l), maxL),
    top: Math.min(Math.max(0, t), maxT)
  };
}

export function getInjectionRoot() {
  return document.documentElement;
}

// 等待 document.body 就绪（最多等待 3 秒）
// document_idle 通常保证 body 已就绪，但部分 SPA/框架页面可能在 idle 后替换 body
function waitForBody(timeout = 3000) {
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

export function toast(msg, opts) {
  const o = (typeof opts === 'number') ? { duration: opts } : (opts || {});
  const el = document.createElement('div');
  el.className = 'beaver-web-toast' + (o.error ? ' error' : '');
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  const close = document.createElement('span');
  close.className = 'beaver-web-toast-close';
  close.textContent = '×';
  close.addEventListener('click', () => el.remove());
  el.appendChild(close);
  el.style.left = '50%';
  el.style.bottom = '30px';
  el.style.transform = 'translateX(-50%)';
  getInjectionRoot().appendChild(el);
  // 反思（2026-08-15 第六十五次）：错误提示至少展示 5 秒；鼠标悬停/键盘焦点进入时
  //   计时暂停（不自动消失），离开后按剩余时间继续，便于读完报错信息。
  const dur = Math.max(o.duration || 2500, o.error ? 5000 : 0);
  let timer = null;
  let deadline = Date.now() + dur;
  let remaining = dur;
  function schedule(millis) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { try { el.remove(); } catch (e) { /* ignore */ } }, millis);
  }
  schedule(dur);
  el.addEventListener('mouseenter', () => {
    if (timer) clearTimeout(timer);
    remaining = Math.max(0, deadline - Date.now());
  });
  el.addEventListener('mouseleave', () => {
    deadline = Date.now() + remaining;
    schedule(remaining);
  });
  el.addEventListener('focusin', () => {
    if (timer) clearTimeout(timer);
    remaining = Math.max(0, deadline - Date.now());
  });
  el.addEventListener('focusout', () => {
    deadline = Date.now() + remaining;
    schedule(remaining);
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function cssEscape(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/["\\]/g, '\\$&');
}

export function formatTime(sec) {
  if (sec == null || isNaN(sec)) return '0:00';
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function flashButton(btn) {
  if (!btn) return;
  const orig = btn.style.background;
  btn.style.background = 'var(--beaver-primary)';
  setTimeout(() => { btn.style.background = orig; }, 300);
}

// 第二百二十五次：删除转发包装 pickRandomShortTrans（《命名清查》裁定：它早已无随机语义、
//   只是 lib/dict-clean.js#pickCleanShortTrans 的同名转发；调用方 ws/scanner.js 已改为直调）。

// === 状态管理（展开/收起/关闭） ===
// 反思（2026-08-12）：用户反馈"悬浮球跟侧栏切换时位置动来动去"。
//   根因：旧版 collapse 基于侧栏 rect 计算球位置（ballX = rect.right - 48），
//   拖动侧栏后折叠时球位置偏移；expand/collapse 循环时因 rect 取值时序差异位置逐渐偏移。
//   修正：expand 前保存球位置到 _preExpandPos，collapse 时恢复到该位置，
//   不基于侧栏 rect 计算。球位置固定，不随侧栏移动。
export let _preExpandPos = null;

// 第一百三十四次（Phase C 就地展开折叠 + 矩形持久化）：
// _panelRect = 展开态矩形的唯一内存权威；shellRectText = 其持久化键。
// 第一百八十七次：持久化口径由「文档坐标」改为「视口坐标」——侧栏是 position:fixed，
//   存文档坐标再减当前滚动量，刷新后滚动量不同就会算错位置（用户："侧栏位置乱跑"）。
// expand 优先级：anchor(形态切换，矩形原样) > _panelRect(就地还原) > 传统推算(首次)。
// collapse 前先 savePanelRect——"折叠时记住，展开时原样搬回"，位置不再乱窜。
export let _panelRect = null; // {left,top,width,height} 视口坐标

/**
 * 反思（2026-08-08）：用户要求"音标前加一个喇叭按钮"。
 * 朗读单词（Web Speech API），使用 learnLanguage 设置语音。
 * @param {string} word 要朗读的单词
 */
// 缓存 learnLanguage，避免每次朗读都读 storage
export let _cachedLearnLang = 'en';

try {
  chrome.storage.local.get({ learnLanguage: 'en' }, (res) => {
    _cachedLearnLang = res.learnLanguage || 'en';
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.learnLanguage) {
      _cachedLearnLang = changes.learnLanguage.newValue || 'en';
    }
  });
} catch (_) { /* ignore */ }

export function saveState(expanded) {
  try {
    chrome.storage.local.set({ webSidebarExpanded: !!expanded });
  } catch (e) { /* ignore */ }
}

async function loadState() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ webSidebarExpanded: false }, (s) => {
        resolve(!!s.webSidebarExpanded);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

/**
 * 获取 block 内文本，智能拼接：相邻文本节点间无空白则补空格，块级元素间补换行。
 *
 * 反思（2026-08-13）：用户反馈"找正文时找出的生词黏连"。
 *   根因：block.textContent 把 block 内所有文本节点文本首尾直接相接，
 *   相邻 inline 文本节点之间丢失空格（如 <span>love</span><span>beaver</span>
 *   → "lovebeaver"），tokenizer 把黏连串识别成一个生词。
 *   修正：自行遍历文本节点，按浏览器渲染规则拼接：
 *   - 相邻文本节点之间无空白时补一个空格（避免生词黏连）
 *   - 块级元素（p/div/li/br 等）前后补换行
 *   - 跳过隐藏元素（display:none / visibility:hidden）的文本
 * @param {Element} block 块级容器
 * @returns {string}
 */
export function getBlockText(block) {
  const parts = [];
  const BLOCK_TAGS = new Set(['P','DIV','LI','TD','TH','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','DD','DT','CAPTION','FIGCAPTION','ARTICLE','SECTION','MAIN','TR','UL','OL','TABLE','BR']);
  // 2026-09-02 短行合并修复：行内短句（如 <span>短行</span><span>短行</span>）在同一块内
  //   旧逻辑仅对 BLOCK_TAGS 补换行，行内 span 之间只补空格，导致"多短行→一长句"。
  //   新增：同父容器下的不同行内子元素视作换行分隔，保持短行独立。
  const INLINE_TAGS = new Set(['SPAN','B','I','EM','STRONG','A','FONT','U','S','SUP','SUB','CODE','MARK','SMALL','BIG','LABEL','Q','CITE','ABBR','TIME','VAR','SAMP','KBD']);
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      const el = node.parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      // 反思（2026-08-16 第六十八次）：本函数已降级为兜底——主路径优先读 text-hint
      //   记录的 data-beaver-orig（页面选出的原文本），仅旧 span 无记录时才走本函数。
      //   第六十七次加入的 .beaver-side-ann 跳过保留作为兜底防线：即便无 data-beaver-orig，
      //   也跳过页面侧注释（如 "Labs(实验室)"），避免句子含 "(实验室)" 再被注释一遍。
      try {
        if (el.closest && el.closest('.beaver-side-ann')) return NodeFilter.FILTER_REJECT;
      } catch (e) { /* ignore */ }
      // 跳过隐藏元素文本（display:none / visibility:hidden）
      try {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      } catch (e) { /* ignore */ }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let lastEl = null;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    let txt = node.textContent || '';
    const el = node.parentElement;
    let isNewlineBlock = false;
    // 块级元素前后补换行（与浏览器渲染一致）
    if (el && BLOCK_TAGS.has(el.tagName)) {
      txt = '\n' + txt + '\n';
      isNewlineBlock = true;
    } else if (lastEl && el !== lastEl) {
      // 同一父容器下、不同行内子元素 → 视作换行（短行独立）
      try {
        const lastParent = lastEl.parentElement;
        const curParent = el.parentElement;
        if (lastParent && curParent && lastParent === curParent && INLINE_TAGS.has(lastEl.tagName) && INLINE_TAGS.has(el.tagName)) {
          if (txt && !/^[\s\u00a0\u3000\n]/.test(txt)) {
            txt = '\n' + txt;
            isNewlineBlock = true;
          }
        } else {
          // 嵌套的行内格式（如 hello <b>world</b>）不视作换行
          const isNested = (lastEl.contains && el.contains) ? (lastEl.contains(el) || el.contains(lastEl)) : false;
          if (!isNested) {
            try {
              const csLast = getComputedStyle(lastEl);
              const csCur = getComputedStyle(el);
              const isBlock = (d) => d === 'block' || d === 'list-item' || d === 'table' || d === 'flex' || d === 'grid' || d === 'table-cell' || d === 'table-row';
              if (isBlock(csLast.display) || isBlock(csCur.display)) {
                if (txt && !/^[\s\u00a0\u3000\n]/.test(txt)) {
                  txt = '\n' + txt;
                  isNewlineBlock = true;
                }
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    }
    lastEl = el;
    if (!isNewlineBlock && parts.length > 0) {
      const prev = parts[parts.length - 1];
      // 相邻文本之间无空白 → 补空格，避免生词黏连
      if (prev && txt && !/[\s\u00a0\u3000\n]$/.test(prev) && !/^[\s\u00a0\u3000\n]/.test(txt)) {
        parts.push(' ');
      }
    }
    parts.push(txt);
  }
  return parts.join('');
}

/** 按句末标点拆分文本为句子数组 */
export function splitSentences(text) {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
}

// === 配色应用 ===
export function applyColors(settings) {
  if (!_root) return;
  if (settings.hintFirstBg) _root.style.setProperty('--beaver-first-bg', settings.hintFirstBg);
  if (settings.hintFirstFg) _root.style.setProperty('--beaver-first-fg', settings.hintFirstFg);
  if (settings.hintLaterBg) _root.style.setProperty('--beaver-later-bg', settings.hintLaterBg);
  if (settings.hintLaterFg) _root.style.setProperty('--beaver-later-fg', settings.hintLaterFg);
}

// === 侧栏注释样式预设（引导页选择，无+11种） ===
// 反思（2026-08-13 第五十次）：root 加/换 beaver-ann-style-{id} 类，
//   web-sidebar.css 中定义各类实际配色，覆盖句子生词/内联注释/详细词头。
export function applyAnnStyle(styleId) {
  if (!_root) return;
  const id = (typeof styleId === 'string' && styleId !== 'none') ? styleId : '';
  for (const cls of Array.from(_root.classList)) {
    if (cls.startsWith('beaver-ann-style-')) _root.classList.remove(cls);
  }
  if (id) _root.classList.add('beaver-ann-style-' + id);
}

// ==== 跨模块共享状态写入接缝 ====
// 铁律：共享状态只有本文件这一份定义；其他模块通过下列 setter 写入，读取靠 ESM 实时绑定。
export function set_activeTab(v) { _activeTab = v; }
export function set_allAnnotations(v) {
  _allAnnotations = v;
  // 第一百八十六次：数组被整体替换（清空/重排）时同步重建词键集，
  //   否则清空后旧键仍在，新一轮扫描会把所有词判成"已收"而全数丢弃。
  _wordKeys = new Set();
  if (Array.isArray(v)) {
    for (const a of v) {
      const k = String((a && a.word) || '').trim().toLowerCase();
      if (k) _wordKeys.add(k);
    }
  }
}
export function set_annotateOov(v) { _annotateOov = v; }
export function set_annotateRepeat(v) { _annotateRepeat = v; }
export function set_annotationsCache(v) { _annotationsCache = v; }
export function set_collectedSubs(v) { _collectedSubs = v; }
export function set_detailMode(v) { _detailMode = v; }
export function set_firstSentMap(v) { _firstSentMap = v; }
export function set_noAnnotation(v) { _noAnnotation = v; }
export function set_pageSentenceEls(v) { _pageSentenceEls = v; }
export function set_pageSentences(v) { _pageSentences = v; }
export function set_panelRect(v) { _panelRect = v; }
export function set_preExpandPos(v) { _preExpandPos = v; }
export function set_rankThreshold(v) { _rankThreshold = v; }
export function set_root(v) { _root = v; }
export function set_scanScheduled(v) { _scanScheduled = v; }
export function set_seenSentences(v) { _seenSentences = v; }
export function set_seenWords(v) { _seenWords = v; }
export function set_wordOnlyMode(v) { _wordOnlyMode = v; }
