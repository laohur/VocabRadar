/**
 * main-text.js —— 给 AI 用的「网页正文提取」唯一实现（含耗时诊断）
 *
 * 背景（第一百八十五次，用户原话）：
 *   1. "回装 Readability，仅仅用在给AI提取正文。"
 *   2. "增加悬浮诊断按钮，测算目前直接解析正文跟用Readability解析正文耗时。"
 *
 * 边界（务必守住）：
 *   - Readability 只在本文件被调用，且只服务于「把正文交给 LLM」这一件事；
 *     高亮（text-hint）与侧栏扫描（web-sidebar）仍走各自的视口 TreeWalker，绝不引入 Readability
 *     —— 2026-08-13 用户已裁定"Readability 提取正文太慢，抛弃"，那条路不能回头。
 *   - Readability.prototype.parse() 会**直接改写**传入的 document。历史白屏事故即由此而来。
 *     故本文件一律传 DOMParser 解析出的独立副本（parseFromString(outerHTML)），
 *     真实页面 document 绝不交给它。
 *
 * 两条提取实现：
 *   - extractDirectText()：本扩展"目前直接解析正文"的等价纯提取（同一套 SKIP_TAGS /
 *     NON_CONTENT_SELECTOR 过滤 + 按 block 元素聚合），不查词不渲染，仅供 AI 与计时对照。
 *   - extractReadabilityText()：DOMParser 克隆整页 + Readability.parse()，取 textContent。
 *
 * 对比语义（第一百九十四次，用户纠偏原话："Readability 替代 不是（整页克隆），
 *   而是替代原始Readability或者同类产品，例如替代jsdom等"）：
 *   - 「喂法」＝同一个 Readability 喂入什么：整页克隆 / 密度选容器后只克隆子树（方案三、四）；
 *   - 「替代」＝换掉 Readability 本体或同类栈：浏览器内原生 DOM 已替代 jsdom 的宿主角色，
 *     第五方案＝Defuddle（第一百九十四次用户裁定引入，vendor 懒加载）；
 *     零依赖候选＝自研密度法（trafilatura / Chromium DOM Distiller 思路）；
 *     调研依据见 docs/正文提取替代方案调研.md。喂法变体永远不得标注为「替代」。
 *
 * 常量同源说明：SKIP_TAGS / NON_CONTENT_SELECTOR / JS_SENTINELS 原先在 ws/scanner.js 内私有，
 *   现上移至此并由 scanner.js 导入，避免"同一套筛选标准两处各写一份"再度分叉。
 *   （text-hint 侧另有一份历史副本，属高亮路径，本次不动，以免影响高亮行为。）
 */

// 不扫描这些标签内的文本（代码/表单/媒体/脚本/非正文语义等）
export const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'INPUT', 'BUTTON',
  'TEXTAREA', 'SELECT', 'OPTION', 'CODE', 'PRE', 'TITLE', 'HEAD',
  'META', 'LINK', 'KBD', 'SAMP', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO',
  'CANVAS', 'MAP', 'AREA', 'TEMPLATE',
  'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'MENU', 'DIALOG'
]);

// 非正文 ARIA 角色选择器
export const NON_CONTENT_SELECTOR = [
  '[aria-hidden="true"]',
  '[contenteditable="true"]',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="search"]',
  '[role="complementary"]',
  '[role="menu"]', '[role="menubar"]',
  '[role="dialog"]', '[role="alertdialog"]',
  '[role="alert"]'
].join(', ');

// JS 特殊值（非真实单词）
export const JS_SENTINELS = new Set(['nan', 'undefined', 'infinity']);

// 本扩展自身注入的 UI 容器：提取正文时必须整体跳过，否则侧栏/面板文字会被当成正文喂给模型
const OWN_UI_SELECTOR = '#beaver-web-sidebar, #beaver-sidebar, #beaver-subtitle-overlay, '
  + '#beaver-hint-tooltip, #beaver-context-panel, #beaver-ocr-panel, #beaver-chat-panel, '
  + '#beaver-main-text-diag';

// 第一百八十七次：本扩展注入到**正文流内部**的节点（不是独立容器）
//   .beaver-side-ann 是 text-hint 插在生词右侧的「(释义)」span，它是页面正文里的真实
//   文本节点，TreeWalker 与 Readability 都会当成正文一起提走 —— 这正是用户说的
//   「对话框的上下文是正文，你为啥加注释」。提取正文时必须整体剔除。
//   注意：不能把 .beaver-word 一起剔除，它包裹的是**原文单词本身**，剔了会丢正文。
const OWN_INLINE_SELECTOR = '.beaver-side-ann';

// 高亮包裹 span：提取正文时保留其文本，但在 Readability 副本里要解包，避免
//   多余 inline 标签干扰 Readability 的节点打分
const OWN_WRAP_SELECTOR = '.beaver-word';

// === 第二百零五次（用户："只要可见文本，就像手动复制粘贴纯文本那样"）===
// 折叠/隐藏内容标注：提取正文前在**活文档**上给不可见子树打标记（display:none /
// visibility:hidden / [hidden] / aria-hidden=true / 未展开 <details> / type=hidden），
// 序列化进 HTML 后由 stripOwnNodes 从副本整体剔除；标注随即摘除（finally 保证还原）。
// 动机：用户实测 Defuddle 把折叠不可见内容带进了正文；手动复制粘贴天然只含可见文本。
const HIDDEN_MARK_ATTR = 'data-beaver-hidden';

/** 判定元素（及其子树）是否不可见/折叠 */
function isHiddenElement(el) {
  if (el.tagName === 'DETAILS' && !el.hasAttribute('open')) return true;   // 折叠面板
  if (el.hasAttribute('hidden')) return true;
  if (el.tagName === 'INPUT' && String(el.getAttribute('type') || '').toLowerCase() === 'hidden') return true;
  if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
  try {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    if (cs.contentVisibility === 'hidden') return true;
  } catch (e) { /* 计算样式不可得按可见处理 */ }
  return false;
}

/** 给活文档的隐藏/折叠子树打标记（子树整体剪枝，返回标注元素数） */
function markHiddenElements() {
  const root = document.body || document.documentElement;
  const hiddenEls = [];
  if (!root) return 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(el) {
      if (el === root) return NodeFilter.FILTER_SKIP;
      // 隐藏子树整体拒收（prune）：祖先已标注，副本剔除时整棵移除
      if (isHiddenElement(el)) { hiddenEls.push(el); return NodeFilter.FILTER_REJECT; }
      return NodeFilter.FILTER_SKIP;
    }
  });
  try {
    while (walker.nextNode()) { /* 收集已在 acceptNode 内完成 */ }
  } catch (e) { /* 遍历中断按已收集处理 */ }
  for (const el of hiddenEls) {
    try { el.setAttribute(HIDDEN_MARK_ATTR, '1'); } catch (e) { /* ignore */ }
  }
  return hiddenEls.length;
}

/** 摘除活文档上的隐藏标注（与 markHiddenElements 成对，finally 调用） */
function unmarkHiddenElements() {
  try {
    (document.body || document.documentElement)
      .querySelectorAll('[' + HIDDEN_MARK_ATTR + ']')
      .forEach((el) => el.removeAttribute(HIDDEN_MARK_ATTR));
  } catch (e) { /* ignore */ }
}

/**
 * 生成"已标注隐藏内容"的整页克隆 HTML（四条克隆路径共用）
 * 标注 → 序列化 → 摘除标注（finally）；副本侧由 stripOwnNodes 统一剔除标注子树。
 * @returns {string}
 */
function buildPageCloneHtml() {
  let marked = 0;
  try { marked = markHiddenElements(); } catch (e) { /* ignore */ }
  try {
    return document.documentElement.outerHTML;
  } finally {
    if (marked > 0) { try { unmarkHiddenElements(); } catch (e) { /* ignore */ } }
  }
}

/**
 * 第二百零五次：正文容器 → 完整 document 的克隆 HTML（密度选容器两条路径共用）
 * 与 buildPageCloneHtml 同口径：标注隐藏/折叠子树 → 序列化 → 摘除标注。
 * @param {Element} rootEl 正文容器（密度法 pickContentRoot 产物）
 * @returns {string}
 */
function buildSubtreeDocHtml(rootEl) {
  let marked = 0;
  try { marked = markHiddenElements(); } catch (e) { /* ignore */ }
  try {
    return '<!DOCTYPE html><html><head><base href="' + location.href.replace(/"/g, '&quot;')
      + '"><title>' + String(document.title || '').replace(/</g, '&lt;') + '</title></head><body>'
      + rootEl.outerHTML + '</body></html>';
  } finally {
    if (marked > 0) { try { unmarkHiddenElements(); } catch (e) { /* ignore */ } }
  }
}

/**
 * 从（克隆出来的）文档副本里剔除本扩展注入的所有痕迹
 *
 * 为什么必须做：Readability 路径拿的是 document.documentElement.outerHTML，
 *   此时 text-hint 早已把 (释义) span 插进正文、把生词包进 .beaver-word，
 *   侧栏/面板也在 DOM 里。不清理就等于把自家 UI 文字和注释喂给模型。
 * @param {Document} doc DOMParser 解析出的文档副本（绝不可传真实 document）
 * @returns {{ann: number, ui: number, unwrap: number}} 清理计数（供诊断核对）
 */
function stripOwnNodes(doc) {
  const stat = { ann: 0, ui: 0, unwrap: 0, hidden: 0 };
  if (!doc || !doc.querySelectorAll) return stat;
  try {
    // 1. 侧邻注释：整体删除（连同 (释义) 文本）
    doc.querySelectorAll(OWN_INLINE_SELECTOR).forEach((n) => { n.remove(); stat.ann++; });
    // 2. 自家 UI 容器：整体删除
    doc.querySelectorAll(OWN_UI_SELECTOR).forEach((n) => { n.remove(); stat.ui++; });
    // 3. 高亮包裹：解包保留原文单词
    doc.querySelectorAll(OWN_WRAP_SELECTOR).forEach((n) => {
      const parent = n.parentNode;
      if (!parent) return;
      while (n.firstChild) parent.insertBefore(n.firstChild, n);
      n.remove();
      stat.unwrap++;
    });
    // 4. 第二百零五次：隐藏/折叠子树（提取前在活文档标注，见 buildPageCloneHtml）——
    //    "只要可见文本"：display:none/visibility:hidden/[hidden]/aria-hidden/
    //    未展开 details/type=hidden 的内容一律不进正文
    doc.querySelectorAll('[' + HIDDEN_MARK_ATTR + ']').forEach((n) => { n.remove(); stat.hidden++; });
    doc.querySelectorAll('details:not([open])').forEach((n) => { n.remove(); stat.hidden++; });
  } catch (e) {
    console.warn('[VocabRadar][main-text] 清理自家注入节点失败:', e);
  }
  return stat;
}

// 段落级容器标签：文本节点按最近的这类祖先聚合成一段
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'MAIN',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DD', 'DT', 'FIGCAPTION', 'SUMMARY', 'BODY'
]);

/** 统一日志前缀（全仓约定 [VocabRadar][模块]） */
function log(...args) {
  console.log('[VocabRadar][main-text]', ...args);
}

/**
 * 找文本节点所属的段落容器（最近的 BLOCK_TAGS 祖先，找不到则用直接父元素）
 * @param {Element} el 文本节点的父元素
 * @returns {Element} 段落容器
 */
function nearestBlock(el) {
  let cur = el;
  while (cur && cur.nodeType === 1) {
    if (BLOCK_TAGS.has(cur.tagName)) return cur;
    cur = cur.parentElement;
  }
  return el;
}

/**
 * 直接解析正文（当前扩展在用的方式的纯提取版）
 *
 * 与 ws/scanner.js 的差别只有两点，均为"可比性"所必需：
 *   1. 不限视口（AI 需要整页正文，而侧栏只扫可见区域）；
 *   2. 只提取文本，不查词、不渲染、不建 DOM 高亮。
 * 因此本函数耗时可视为"直接解析正文"的纯算法开销，与 Readability 同基准比较。
 *
 * @param {{viewportOnly?: boolean}} [opts] viewportOnly=true 时仅取视口内（与侧栏行为一致）
 * @returns {{text: string, blocks: number, chars: number}}
 */
export function extractDirectText(opts) {
  const root = document.body || document.documentElement;
  if (!root) return { text: '', blocks: 0, chars: 0 };
  return extractTextIn(root, opts);
}

/**
 * 在指定子树内按规则提取文本（extractDirectText 与 extractDensityText 的公共实现）
 *
 * 抽出来的理由：「全规则」扫 body、「密度法」扫正文容器，除根节点不同外筛选标准必须
 *   完全一致，否则两方案的耗时/字数对比失去意义（同一套 SKIP_TAGS 才可比）。
 * @param {Element} root 提取根节点
 * @param {{viewportOnly?: boolean}} [opts] viewportOnly=true 时仅取视口内
 * @returns {{text: string, blocks: number, chars: number}}
 */
function extractTextIn(root, opts) {
  const viewportOnly = !!(opts && opts.viewportOnly);
  if (!root) return { text: '', blocks: 0, chars: 0 };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest && parent.closest(OWN_UI_SELECTOR)) return NodeFilter.FILTER_REJECT;
      // 第一百八十七次：剔除自家侧邻注释「(释义)」，它在正文流里，否则上下文里全是注释
      if (parent.closest && parent.closest(OWN_INLINE_SELECTOR)) return NodeFilter.FILTER_REJECT;
      if (parent.closest && parent.closest(NON_CONTENT_SELECTOR)) return NodeFilter.FILTER_REJECT;
      // 第二百零五次（用户："只要可见文本"）：display:none/visibility:hidden/折叠
      //   <details> 等不可见内容剔除——与克隆路径的标注剔除同口径
      try {
        const cs = getComputedStyle(parent);
        if (cs.display === 'none' || cs.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      } catch (e) { /* 计算样式不可得按可见处理 */ }
      if (parent.closest && parent.closest('details:not([open])')) return NodeFilter.FILTER_REJECT;
      if (parent.closest && parent.closest('[' + HIDDEN_MARK_ATTR + ']')) return NodeFilter.FILTER_REJECT;
      const low = node.textContent.trim().toLowerCase();
      if (JS_SENTINELS.has(low)) return NodeFilter.FILTER_REJECT;
      if (viewportOnly) {
        const rect = parent.getBoundingClientRect();
        if (rect.bottom < -100 || rect.top > window.innerHeight + 100) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  // 按段落容器聚合：同一 block 内的多个文本节点（含 <a>/<em> 打断的碎片）拼成一段
  const order = [];              // 段落容器出现顺序
  const buf = new Map();         // 容器 -> 文本片段数组
  let node = walker.nextNode();
  while (node) {
    const block = nearestBlock(node.parentElement);
    if (!buf.has(block)) { buf.set(block, []); order.push(block); }
    buf.get(block).push(node.textContent.replace(/\s+/g, ' ').trim());
    node = walker.nextNode();
  }

  // 第二百零五次（用户："纯文本中 \t 即可"）：表格结构保留——同一 <tr> 的单元格
  //   （TD/TH）用 \t 相连，行间 \n；其余块照旧 \n 分行。
  const lines = [];
  let prevBlock = null;
  for (const block of order) {
    const seg = buf.get(block).join(' ').replace(/\s+/g, ' ').trim();
    if (seg.length < 2) { prevBlock = block; continue; }
    const tag = block.tagName;
    if (tag === 'TD' || tag === 'TH') {
      const row = block.closest && block.closest('tr');
      const prevTag = prevBlock && prevBlock.tagName;
      const prevInRow = (prevTag === 'TD' || prevTag === 'TH')
        && row && prevBlock.closest('tr') === row;
      if (prevInRow && lines.length) lines[lines.length - 1] += '\t' + seg;
      else lines.push(seg);
    } else {
      lines.push(seg);
    }
    prevBlock = block;
  }
  const text = lines.join('\n');
  return { text, blocks: lines.length, chars: text.length };
}

// Readability 构造器缓存（90KB 模块只加载一次）
let _ReadabilityCtor = null;

/**
 * 懒加载 Readability（vendor ESM，已在 manifest 的 web_accessible_resources 中）
 * @returns {Promise<Function>} Readability 构造器
 */
async function loadReadability() {
  if (_ReadabilityCtor) return _ReadabilityCtor;
  const url = chrome.runtime.getURL('src/lib/vendor/readability.js');
  const mod = await import(url);
  const ctor = mod && (mod.default || mod.Readability);
  if (typeof ctor !== 'function') {
    // 不遮蔽错误：加载到了模块但拿不到构造器，直接抛，由调用方回退并出声
    throw new Error('readability.js 未导出构造器');
  }
  _ReadabilityCtor = ctor;
  return ctor;
}

/**
 * 用 Readability 解析正文
 *
 * 关键：传入的是 DOMParser 解析出的独立文档副本。parse() 会改写它，
 *   但那只是一份内存副本，页面本体不受影响（真实 document 传进去必然白屏）。
 *
 * @returns {Promise<{text: string, title: string, chars: number, cloneMs: number, parseMs: number}>}
 */
export async function extractReadabilityText() {
  const Readability = await loadReadability();
  const t0 = performance.now();
  const html = buildPageCloneHtml();   // 第二百零五次：标注隐藏/折叠，副本侧剔除
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 第一百八十七次：副本里先清掉自家注入（(释义) 侧注释、侧栏面板、.beaver-word 包裹）
  const strip = stripOwnNodes(doc);
  // Readability 依赖 <base>/URI 解析绝对链接；副本没有 baseURI，补一个 <base> 以免相对链接告警
  try {
    if (!doc.querySelector('base')) {
      const base = doc.createElement('base');
      base.setAttribute('href', location.href);
      (doc.head || doc.documentElement).insertBefore(base, (doc.head || doc.documentElement).firstChild);
    }
  } catch (e) {
    console.warn('[VocabRadar][main-text] 注入 <base> 失败（不影响正文提取）:', e);
  }
  const cloneMs = performance.now() - t0;

  const t1 = performance.now();
  const article = new Readability(doc, { charThreshold: 200 }).parse();
  const parseMs = performance.now() - t1;

  // 第二百零五次：改用 htmlToLineText(article.content)——textContent 丢失块结构与
  //   表格（用户："除了 markdown，其他所有通道都丢失了表格信息，纯文本中 	 即可"）；
  //   content 为 Readability 清洗后的 HTML，结构化取文后块级换行/表格 	 与其余通道同口径。
  const raw = (article && article.content) ? htmlToLineText(article.content) : '';
  const text = raw.split(/\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 2).join('\n');
  return {
    text,
    title: (article && article.title) || document.title || '',
    chars: text.length,
    cloneMs,
    parseMs,
    strip
  };
}

// Defuddle 构造器缓存（约 330KB 模块只加载一次；与 Readability 同为懒加载，不占首屏）
let _DefuddleCtor = null;

// Defuddle FULL 构造器缓存（约 744KB，仅方案七 Markdown 模式懒加载——第二百零四次）
let _DefuddleFullCtor = null;

/**
 * 懒加载 Defuddle FULL 构建（vendor ESM，已在 manifest 的 web_accessible_resources 中）
 * 第二百零四次（用户实测 markdown:true 在 core 包原样吐 HTML）：Defuddle 的 Markdown
 *   转换只在 full 构建（README: Bundles→full adds math/Markdown conversion），
 *   Markdown 模式必须用本构造器；core（defuddle.js）保持主链路轻量。
 * @returns {Promise<Function>} Defuddle（full）构造器
 */
async function loadDefuddleFull() {
  if (_DefuddleFullCtor) return _DefuddleFullCtor;
  const url = chrome.runtime.getURL('src/lib/vendor/defuddle-full.js');
  const mod = await import(url);
  const ctor = mod && (mod.default || mod.Defuddle);
  if (typeof ctor !== 'function') {
    throw new Error('defuddle-full.js 未导出构造器');
  }
  _DefuddleFullCtor = ctor;
  return ctor;
}

// 块级元素标签（第一百九十九次：Defuddle 正文换行还原用）
const BLOCK_LINE_TAGS = /^(P|DIV|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TABLE|TR|THEAD|TBODY|SECTION|ARTICLE|MAIN|HEADER|FOOTER|FIGURE|FIGCAPTION|DL|DT|DD|HR|ASIDE|NAV)$/;

/**
 * 块级 HTML → 保留换行与表格结构的纯文本（第一百九十九次起；第二百零五次表格化）
 * textContent 会把 <p>/<br>/标题等块结构展平成连续字符串；本助手：
 *   - 块级元素边界补 \n（BR 亦然）；
 *   - 表格：<tr> 一行（单元格 \t 相连），行间 \n——用户裁定"纯文本中 \t 即可"，
 *     其余通道此前全部丢失表格结构（仅 Markdown 天然保留）。
 * @param {string} html HTML 字符串
 * @returns {string} 含块级换行与表格 \t 的文本
 */
function htmlToLineText(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  if (!doc.body) return '';
  const walk = (el) => {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) { out += node.nodeValue; continue; }
      if (node.nodeType !== 1) continue;
      if (node.tagName === 'BR') { out += '\n'; continue; }
      // 表格分支：行=单元格 \t 相连，行间 \n；嵌套表由自己的 TABLE 分支处理
      if (node.tagName === 'TABLE') {
        const rows = [];
        for (const tr of node.querySelectorAll('tr')) {
          if (tr.closest('table') !== node) continue;   // 嵌套表的行归嵌套表
          const cells = [];
          for (const cell of tr.children) {
            if (cell.tagName !== 'TD' && cell.tagName !== 'TH') continue;
            if (cell.closest('table') !== node) continue;
            cells.push(walk(cell).replace(/\s+/g, ' ').trim());
          }
          if (cells.length) rows.push(cells.join('\t'));
        }
        if (rows.length) out += '\n' + rows.join('\n') + '\n';
        continue;
      }
      const inner = walk(node);
      out += BLOCK_LINE_TAGS.test(node.tagName) ? ('\n' + inner + '\n') : inner;
    }
    return out;
  };
  return walk(doc.body);
}

/**
 * 懒加载 Defuddle（vendor ESM，已在 manifest 的 web_accessible_resources 中）
 * 第一百九十四次（用户裁定"引入 Defuddle 作 Readability 替代第五方案"）：
 *   替代的是 Readability 本体（kepano/defuddle，MIT），不是喂法变体。
 * @returns {Promise<Function>} Defuddle 构造器
 */
async function loadDefuddle() {
  if (_DefuddleCtor) return _DefuddleCtor;
  const url = chrome.runtime.getURL('src/lib/vendor/defuddle.js');
  const mod = await import(url);
  const ctor = mod && (mod.default || mod.Defuddle);
  if (typeof ctor !== 'function') {
    // 不遮蔽错误：加载到了模块但拿不到构造器，直接抛，由调用方原样报错
    throw new Error('defuddle.js 未导出构造器');
  }
  _DefuddleCtor = ctor;
  return ctor;
}

/**
 * 用 Defuddle 解析正文（Readability 的替代候选，与方案三同输入＝整页克隆，便于同基准对比）
 *
 * 第一百九十四次。关键与 Readability 路径同规：传入 DOMParser 独立副本，绝不传真实 document。
 *   Defuddle.parse() 同步返回 { content(HTML), title, wordCount, parseTime, ... }；
 *   为对齐各方案的"纯文本字符数"口径，content HTML 再经 DOMParser 取 textContent 压缩空白。
 *   parse() 返回值防御性兼容 thenable（上游 useAsync 选项语义可能演化，不赌同步）。
 *
 * @returns {Promise<{text: string, title: string, chars: number, cloneMs: number, parseMs: number, wordCount: number}>}
 */
export async function extractDefuddleText() {
  const Defuddle = await loadDefuddle();
  const t0 = performance.now();
  const html = buildPageCloneHtml();   // 第二百零五次：标注隐藏/折叠，副本侧剔除
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 与整页 Readability 同口径：副本里先清掉自家注入
  const strip = stripOwnNodes(doc);
  try {
    if (!doc.querySelector('base')) {
      const base = doc.createElement('base');
      base.setAttribute('href', location.href);
      (doc.head || doc.documentElement).insertBefore(base, (doc.head || doc.documentElement).firstChild);
    }
  } catch (e) {
    console.warn('[VocabRadar][main-text] 注入 <base> 失败（不影响正文提取）:', e);
  }
  const cloneMs = performance.now() - t0;

  const t1 = performance.now();
  const parsed = new Defuddle(doc).parse();
  const result = (parsed && typeof parsed.then === 'function') ? await parsed : parsed;
  const parseMs = performance.now() - t1;

  // content 是清洗后的 HTML；取其纯文本与其它方案同口径比较
  // 第一百九十九次：textContent 展平块结构 → htmlToLineText 按块级元素补换行
  let raw = '';
  if (result && result.content) {
    raw = htmlToLineText(result.content);
  }
  const text = raw.split(/\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 2).join('\n');
  return {
    text,
    title: (result && result.title) || document.title || '',
    chars: text.length,
    cloneMs,
    parseMs,
    wordCount: (result && typeof result.wordCount === 'number') ? result.wordCount : 0,
    strip
  };
}

// === 第一百八十六次：多方案正文提取（用户："调研网页解析正文方案，包括全规则，
//   规则+Readability，Readability替代等，都加入测试。"）===
//
// 调研依据（开源实现的通用做法）：
//   - Mozilla Readability：按 <p>/<div> 打分（逗号数、文本长度、class/id 正负词），
//     取分最高节点及其兄弟，靠"链接密度"剔除导航。
//   - Chromium DOM Distiller（boilerpipe 系）：文本块特征 + 链接密度 + 词数阈值。
//   - trafilatura：先按 XPath 白名单命中 article/main/[itemprop=articleBody] 等
//     常见正文容器，命中则只在该子树内提取，未命中再退回全页启发式。
// 本文件据此实现四套方案，全部纳入诊断对比，用户可据实测结果选定。

// 常见正文容器选择器（trafilatura 白名单思路，顺序即优先级）
const CONTENT_ROOT_SELECTORS = [
  'article',
  '[itemprop="articleBody"]',
  '[role="main"]',
  'main',
  '.article-content', '.article-body', '.post-content', '.entry-content',
  '#content', '.content'
];

/**
 * 计算元素的链接密度（<a> 内文本占比），用于剔除导航/列表页
 * @param {Element} el 目标元素
 * @returns {number} 0~1
 */
function linkDensity(el) {
  const total = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
  if (!total) return 1;
  let linkLen = 0;
  for (const a of el.querySelectorAll('a')) {
    linkLen += (a.textContent || '').replace(/\s+/g, ' ').trim().length;
  }
  return linkLen / total;
}

/**
 * 挑选正文容器（规则白名单 + 文本密度打分）
 *
 * 两步：
 *   1. 白名单命中且文本量够（>=200 字符）、链接密度低（<0.5）即采用；
 *   2. 未命中则遍历候选块，用 (文本长度 × (1-链接密度)) 打分取最高者。
 * @returns {{root: Element, how: 'selector'|'density'|'body', hit: string}}
 */
export function pickContentRoot() {
  const body = document.body || document.documentElement;
  for (const sel of CONTENT_ROOT_SELECTORS) {
    let el = null;
    try { el = document.querySelector(sel); } catch (e) { el = null; }
    if (!el) continue;
    if (el.closest && el.closest(OWN_UI_SELECTOR)) continue;
    // 第二百零五次：隐藏/折叠容器不作为正文容器候选（“只要可见文本”）
    if (isHiddenElement(el)) continue;
    const len = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
    if (len >= 200 && linkDensity(el) < 0.5) return { root: el, how: 'selector', hit: sel };
  }
  // 密度打分：只看 DIV/SECTION/ARTICLE/MAIN/TD 这类容器，避免逐个 <p> 碎片化
  let best = null, bestScore = 0;
  const cands = body.querySelectorAll('div, section, article, main, td');
  for (const el of cands) {
    if (el.closest && el.closest(OWN_UI_SELECTOR)) continue;
    if (isHiddenElement(el)) continue;   // 第二百零五次：隐藏容器不参与打分
    const len = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
    if (len < 200) continue;
    const score = len * (1 - linkDensity(el));
    if (score > bestScore) { bestScore = score; best = el; }
  }
  if (best) return { root: best, how: 'density', hit: best.tagName.toLowerCase() + (best.id ? '#' + best.id : '') };
  return { root: body, how: 'body', hit: 'body' };
}

/**
 * 方案「密度法」：先挑正文容器，再在该子树内按规则提取
 *
 * 与「全规则」的差别：全规则扫整个 body，正文之外的零散文字（面包屑、推荐位、
 *   评论区）也会进来；密度法先把范围压到正文容器，噪声更少但可能漏掉正文外的段落。
 * @returns {{text: string, blocks: number, chars: number, how: string, hit: string}}
 */
export function extractDensityText() {
  const pick = pickContentRoot();
  const r = extractTextIn(pick.root);
  return { text: r.text, blocks: r.blocks, chars: r.chars, how: pick.how, hit: pick.hit };
}

/**
 * 方案「规则 + Readability」：先按规则/密度挑出正文容器，只把该子树交给 Readability
 *
 * 动机：Readability 最贵的一步是克隆整页 DOM 并对全文打分。先把范围压到正文容器，
 *   克隆量往往只剩几分之一，理论上能在保留 Readability 清洗能力的同时大幅降耗时。
 * @returns {Promise<{text:string,title:string,chars:number,cloneMs:number,parseMs:number,how:string,hit:string}>}
 */
export async function extractRulesReadabilityText() {
  const Readability = await loadReadability();
  const pick = pickContentRoot();

  const t0 = performance.now();
  // Readability 要求一个完整 document：拿正文容器的 outerHTML 包一层最小骨架
  const html = buildSubtreeDocHtml(pick.root);   // 第二百零五次：标注隐藏/折叠，副本侧剔除
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 第一百八十七次：与整页路径同口径，先清掉自家注入
  const strip = stripOwnNodes(doc);
  const cloneMs = performance.now() - t0;

  const t1 = performance.now();
  // charThreshold 放低：子树本就不大，用整页阈值会频繁判"无正文"
  const article = new Readability(doc, { charThreshold: 100 }).parse();
  const parseMs = performance.now() - t1;

  const raw = (article && article.textContent) || '';
  const text = raw.split(/\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 2).join('\n');
  return {
    text,
    title: (article && article.title) || document.title || '',
    chars: text.length,
    cloneMs,
    parseMs,
    strip,
    how: pick.how,
    hit: pick.hit
  };
}

/**
 * 方案六/七「规则初筛 + Defuddle」：密度法挑正文容器，只把该子树交给 Defuddle
 *
 * 动机：Readability 最贵的一步是克隆整页 DOM 并对全文打分。先把范围压到正文容器，
 *   克隆量往往只剩几分之一，理论上能在保留清洗能力的同时大幅降耗时。
 * 第二百零一次（用户："诊断窗口增添一项"）：opts.markdown=true 时 Defuddle 以
 *   markdown 输出 content（喂 LLM 更省 token 的候选形态），供诊断窗对比——
 *   markdown 是纯文本，不走 htmlToLineText（那是对 HTML 块结构的还原）。
 * @param {{markdown?: boolean}} [opts] markdown=true 时 content 为 Markdown 文本
 * @returns {Promise<{text:string,title:string,chars:number,cloneMs:number,parseMs:number,how:string,hit:string,wordCount:number,markdown:boolean}>}
 */
export async function extractRulesDefuddleText(opts) {
  const md = !!(opts && opts.markdown);
  // 第二百零四次：Markdown 转换只在 full 构建（core 包 markdown:true 原样吐 HTML，用户实测）
  const Defuddle = md ? await loadDefuddleFull() : await loadDefuddle();
  const pick = pickContentRoot();

  const t0 = performance.now();
  // Defuddle 要求一个完整 document：拿正文容器的 outerHTML 包一层最小骨架
  const html = buildSubtreeDocHtml(pick.root);   // 第二百零五次：标注隐藏/折叠，副本侧剔除
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 第一百八十七次：与整页路径同口径，先清掉自家注入
  const strip = stripOwnNodes(doc);
  const cloneMs = performance.now() - t0;

  const t1 = performance.now();
  const parsed = new Defuddle(doc, { markdown: md }).parse();
  const result = (parsed && typeof parsed.then === 'function') ? await parsed : parsed;
  const parseMs = performance.now() - t1;

  // HTML 模式：清洗后的 HTML 按块级元素补换行取纯文本（第一百九十九次）；
  // Markdown 模式：content 本身即 Markdown 文本，原样采用。
  const raw = (result && result.content)
    ? (md ? String(result.content) : htmlToLineText(result.content))
    : '';
  const text = raw.split(/\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 2).join('\n');
  return {
    text,
    title: (result && result.title) || document.title || '',
    chars: text.length,
    cloneMs,
    parseMs,
    strip,
    how: pick.how,
    hit: pick.hit,
    wordCount: (result && typeof result.wordCount === 'number') ? result.wordCount : 0,
    markdown: md
  };
}

/**
 * 给 AI 的正文：Defuddle（整页克隆喂入）优先 → 自研密度法兜底 → 直接解析最后兜底
 *
 * 第二百零六次（用户裁定："提取正文首选Defuddle（替代候选·整页克隆喂入），
 *   自研密度法（替代 Readability 候选）兜底"）：主链路由方案六（子树）切换为方案五
 *   （整页克隆）——Defuddle 自身的正文界定不依赖密度选容器的命中面，整页信息更全；
 *   密度法降为兜底（零依赖、快），直接解析保底。Readability 退出主链，仅存诊断对比。
 *   回退判据 MIN_CHARS：宁可回退也不把空正文交给模型（"内容胡来"教训）。
 * @returns {Promise<{text: string, source: 'defuddle'|'density'|'direct', ms: number}>}
 */
export async function getAiMainText() {
  const MIN_CHARS = 200;
  const t0 = performance.now();
  // 1) 主链路：方案五（Defuddle 整页克隆喂入）
  try {
    const r = await extractDefuddleText();
    if (r.text && r.text.length >= MIN_CHARS) {
      const ms = performance.now() - t0;
      log(`Defuddle(整页) 提取正文 ${r.chars} 字符`
        + (r.wordCount ? `（上游词数 ${r.wordCount}）` : '')
        + `，克隆 ${r.cloneMs.toFixed(0)} + 解析 ${r.parseMs.toFixed(0)}ms，合计 ${ms.toFixed(0)}ms`);
      return { text: r.text, source: 'defuddle', ms };
    }
    console.warn(`[VocabRadar][main-text] Defuddle(整页) 正文过短(${(r.text || '').length} 字符)，回退密度法`);
  } catch (e) {
    // 不遮蔽错误：把真实异常打出来再回退
    console.warn('[VocabRadar][main-text] Defuddle(整页) 失败，回退密度法:', e);
  }
  // 2) 兜底：自研密度法（替代 Readability 候选，零依赖）
  try {
    const n = extractDensityText();
    if (n.text && n.text.length >= MIN_CHARS) {
      const ms = performance.now() - t0;
      log(`密度法 提取正文 ${n.chars} 字符 / ${n.blocks} 段（${n.how}:${n.hit}），${ms.toFixed(0)}ms`);
      return { text: n.text, source: 'density', ms };
    }
    console.warn(`[VocabRadar][main-text] 密度法 正文过短(${(n.text || '').length} 字符)，回退直接解析`);
  } catch (e) {
    console.warn('[VocabRadar][main-text] 密度法失败，回退直接解析:', e);
  }
  // 3) 最后兜底：直接解析
  const d = extractDirectText();
  const ms = performance.now() - t0;
  log(`直接解析提取正文 ${d.chars} 字符 / ${d.blocks} 段，${ms.toFixed(0)}ms`);
  return { text: d.text, source: 'direct', ms };
}

/**
 * 第二百零七次：对话上下文按 UTF-8 字节上限截断（用户："上下文要截断，引导页参数，
 *   默认最多10万字节。选取当前位置附近的文本"）
 * 超限时以**当前视口中心元素**的可读文本为锚点，在正文中定位后取以锚点为中心的
 *   字节窗口——正文远超一屏时优先给出用户正在阅读的段落而非页首；
 *   UTF-8 字节精确截断（多字节字符不切半）；锚点定位失败时从头部取。
 * @param {string} text 完整正文
 * @param {number} maxBytes 字节上限（引导页 chatContextMaxBytes，下限 1000）
 * @returns {string} 未超限原样返回；超限返回锚点附近的窗口文本
 */
export function capContextByBytes(text, maxBytes) {
  const t = String(text || '');
  const cap = (typeof maxBytes === 'number' && maxBytes >= 1000) ? Math.floor(maxBytes) : 10000;
  if (!t) return '';
  // 字符边界表：boff[k]=第 k 个字符边界的 UTF-8 字节偏移，u16[k]=对应 UTF-16 下标
  const boff = [0];
  const u16 = [0];
  let b = 0;
  let i = 0;
  while (i < t.length) {
    const cp = t.codePointAt(i);
    const step = cp > 0xffff ? 2 : 1;
    b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += step;
    boff.push(b);
    u16.push(i);
  }
  const total = boff[boff.length - 1];
  if (total <= cap) return t;
  // 锚点：视口中心元素向上找最近的有文本祖先，取其规范化前缀在正文中定位
  let anchorChar = 0;
  try {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    let node = el;
    for (let k = 0; k < 6 && node; k++) {
      const frag = (node.textContent || '').replace(/[\t\n]+/g, ' ').trim().slice(0, 40);
      if (frag.length >= 8) {
        const idx = t.indexOf(frag);
        if (idx >= 0) { anchorChar = idx; break; }
      }
      node = node.parentElement;
    }
  } catch (e) { /* 锚点失败从头部取 */ }
  const byteToChar = (byte) => {
    let lo = 0;
    let hi = boff.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (boff[mid] < byte) lo = mid + 1; else hi = mid;
    }
    return u16[lo];
  };
  const anchorByte = boff[Math.min(anchorChar, boff.length - 1)];
  let sb = Math.max(0, anchorByte - Math.floor(cap / 2));
  let eb = Math.min(total, sb + cap);
  sb = Math.max(0, eb - cap);
  return t.slice(byteToChar(sb), byteToChar(eb));
}

/**
 * 诊断：分别测算「直接解析」与「Readability 解析」耗时（③ 用）
 *
 * 两者各跑一次，互不复用缓存以外的中间结果；Readability 侧再拆出"克隆整页"与"解析"两段，
 *   因为 2026-08-13 抛弃它的理由正是"克隆整个页面 DOM 耗时 1-3 秒"，须让用户看到耗时构成。
 * @returns {Promise<Object>} 诊断明细（含错误信息，不吞异常）
 */
export async function measureMainTextExtractors() {
  const out = { url: location.href, at: new Date().toISOString(), plans: [] };

  // 方案一：全规则（扫整个 body，当前扩展在用的口径）
  const d0 = performance.now();
  try {
    const d = extractDirectText();
    out.directMs = performance.now() - d0;
    out.directChars = d.chars;
    out.directBlocks = d.blocks;
    out.plans.push({ name: '全规则（整页 TreeWalker）', ms: out.directMs, chars: d.chars, note: d.blocks + ' 段', preview: d.text.slice(0, 300), full: d.text });
  } catch (e) {
    out.directMs = performance.now() - d0;
    out.directError = String((e && e.message) || e);
    out.plans.push({ name: '全规则（整页 TreeWalker）', error: out.directError });
  }

  // 方案二：密度法（规则白名单/链接密度挑正文容器 + 同一套 TreeWalker）
  // 第一百九十四次：更名定角色——它才是「替代 Readability 本体」的候选（无依赖、思路取自
  //   trafilatura / Chromium DOM Distiller）；整页/子树克隆都只是 Readability 的喂法，不是替代。
  const n0 = performance.now();
  try {
    const n = extractDensityText();
    out.densityMs = performance.now() - n0;
    out.densityChars = n.chars;
    out.densityHit = n.how + ':' + n.hit;
    out.plans.push({ name: '自研密度法（替代 Readability 候选）', ms: out.densityMs, chars: n.chars, note: n.blocks + ' 段 ｜ ' + out.densityHit, preview: n.text.slice(0, 300), full: n.text });
  } catch (e) {
    out.densityMs = performance.now() - n0;
    out.densityError = String((e && e.message) || e);
    out.plans.push({ name: '自研密度法（替代 Readability 候选）', error: out.densityError });
  }

  // Readability 模块加载单列（首次约 90KB，之后走缓存）
  const l0 = performance.now();
  try {
    await loadReadability();
    out.loadMs = performance.now() - l0;
  } catch (e) {
    out.loadMs = performance.now() - l0;
    out.readabilityError = '模块加载失败: ' + String((e && e.message) || e);
    out.plans.push({ name: 'Readability 系（全部）', error: out.readabilityError });
    log('正文提取耗时对比:', out);
    return out;
  }

  // 方案三：Readability 本体·喂法A（克隆整页）——第一百九十四次更名：整页克隆只是喂法，
  //   不是「替代」（用户裁定：替代＝换掉原始 Readability 或同类产品，例如替代 jsdom 栈）。
  const r0 = performance.now();
  try {
    const r = await extractReadabilityText();
    out.readabilityMs = performance.now() - r0;
    out.cloneMs = r.cloneMs;
    out.parseMs = r.parseMs;
    out.readabilityChars = r.chars;
    out.readabilityTitle = r.title;
    out.plans.push({
      name: 'Readability 本体（整页克隆喂入）',
      ms: out.readabilityMs,
      chars: r.chars,
      note: '克隆 ' + r.cloneMs.toFixed(0) + ' + 解析 ' + r.parseMs.toFixed(0) + ' ms',
      preview: r.text.slice(0, 300),
      full: r.text
    });
  } catch (e) {
    out.readabilityMs = performance.now() - r0;
    out.readabilityError = String((e && e.message) || e);
    out.plans.push({ name: 'Readability 本体（整页克隆喂入）', error: out.readabilityError });
  }

  // 方案四：Readability 本体·喂法B（密度法先挑容器，只克隆该子树给 Readability）
  const m0 = performance.now();
  try {
    const m = await extractRulesReadabilityText();
    out.hybridMs = performance.now() - m0;
    out.hybridChars = m.chars;
    out.hybridHit = m.how + ':' + m.hit;
    out.plans.push({
      name: 'Readability 本体（密度选容器+子树克隆喂入）',
      ms: out.hybridMs,
      chars: m.chars,
      note: '克隆 ' + m.cloneMs.toFixed(0) + ' + 解析 ' + m.parseMs.toFixed(0) + ' ms ｜ ' + out.hybridHit,
      preview: m.text.slice(0, 300),
      full: m.text
    });
  } catch (e) {
    out.hybridMs = performance.now() - m0;
    out.hybridError = String((e && e.message) || e);
    out.plans.push({ name: 'Readability 本体（密度选容器+子树克隆喂入）', error: out.hybridError });
  }

  // 方案五：Defuddle（第一百九十四次用户裁定引入——替代 Readability 本体的候选，非喂法变体；
  //   与方案三同输入＝整页克隆，两行直接同基准对比。懒加载，首次点诊断窗才拉起 330KB 模块）
  const f0 = performance.now();
  try {
    const f = await extractDefuddleText();
    out.defuddleMs = performance.now() - f0;
    out.defuddleChars = f.chars;
    out.defuddleTitle = f.title;
    out.defuddleWordCount = f.wordCount;
    out.plans.push({
      name: 'Defuddle（替代候选·整页克隆喂入）',
      ms: out.defuddleMs,
      chars: f.chars,
      note: '克隆 ' + f.cloneMs.toFixed(0) + ' + 解析 ' + f.parseMs.toFixed(0) + ' ms'
        + (f.wordCount ? ' ｜ 上游词数 ' + f.wordCount : ''),
      preview: f.text.slice(0, 300),
      full: f.text
    });
  } catch (e) {
    out.defuddleMs = performance.now() - f0;
    out.defuddleError = String((e && e.message) || e);
    out.plans.push({ name: 'Defuddle（替代候选·整页克隆喂入）', error: out.defuddleError });
  }

  // 方案六：规则初筛 + Defuddle（子树克隆喂入）——第一百九十七次用户点名补齐：
  //   与方案四（Readability 同喂法）对照可知 Defuddle 的慢有多少来自整页 DOM 体积。
  const g0 = performance.now();
  try {
    const g = await extractRulesDefuddleText();
    out.defuddleHybridMs = performance.now() - g0;
    out.defuddleHybridChars = g.chars;
    out.defuddleHybridHit = g.how + ':' + g.hit;
    out.plans.push({
      name: 'Defuddle（密度选容器+子树克隆喂入）',
      ms: out.defuddleHybridMs,
      chars: g.chars,
      note: '克隆 ' + g.cloneMs.toFixed(0) + ' + 解析 ' + g.parseMs.toFixed(0) + ' ms ｜ ' + out.defuddleHybridHit
        + (g.wordCount ? ' ｜ 上游词数 ' + g.wordCount : ''),
      preview: g.text.slice(0, 300),
      full: g.text
    });
  } catch (e) {
    out.defuddleHybridMs = performance.now() - g0;
    out.defuddleHybridError = String((e && e.message) || e);
    out.plans.push({ name: 'Defuddle（密度选容器+子树克隆喂入）', error: out.defuddleHybridError });
  }

  // 方案七：Defuddle Markdown（第二百零一次用户："诊断窗口增添一项"）——
  //   同方案六的喂法，仅 markdown:true：content 直接输出 Markdown，
  //   评估"喂 LLM 省 token"形态用；主链路暂仍取 HTML→行文本。
  const h0 = performance.now();
  try {
    const h = await extractRulesDefuddleText({ markdown: true });
    out.defuddleMdMs = performance.now() - h0;
    out.defuddleMdChars = h.chars;
    out.plans.push({
      name: 'Defuddle Markdown（同方案六·markdown 输出）',
      ms: out.defuddleMdMs,
      chars: h.chars,
      note: '克隆 ' + h.cloneMs.toFixed(0) + ' + 解析 ' + h.parseMs.toFixed(0) + ' ms ｜ ' + out.defuddleHybridHit,
      preview: h.text.slice(0, 300),
      full: h.text
    });
  } catch (e) {
    out.defuddleMdMs = performance.now() - h0;
    out.defuddleMdError = String((e && e.message) || e);
    out.plans.push({ name: 'Defuddle Markdown（同方案六·markdown 输出）', error: out.defuddleMdError });
  }

  // 当前实际送给 AI 的正文（用户要能核对"上下文到底装了什么"）
  try {
    const ai = await getAiMainText();
    out.aiSource = ai.source;
    out.aiChars = ai.text.length;
    out.aiPreview = ai.text.slice(0, 300);
    out.aiFull = ai.text;
    out.aiMs = ai.ms;
  } catch (e) {
    out.aiError = String((e && e.message) || e);
  }

  log('正文提取耗时对比:', out);
  return out;
}

// === ③ 诊断悬浮窗（用户："增加悬浮诊断按钮，测算目前直接解析正文跟用Readability解析正文耗时"）===
// 放在本文件而非 ws/ui.js 的理由：被测的两个提取器都在这里，诊断面板与被测对象同处一处，
//   日后改提取逻辑不会漏改面板字段；面板容器 id 已列入 OWN_UI_SELECTOR，不会把自己的文字当正文。

const DIAG_HOST_ID = 'beaver-main-text-diag';

/**
 * 把一次测算结果渲染成表格 HTML
 * @param {Object} r measureMainTextExtractors() 的返回值
 * @returns {string} HTML
 */
function renderDiagRows(r) {
  const ms = (v) => (typeof v === 'number' ? v.toFixed(1) + ' ms' : '—');
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = '<table><tbody>';
  // 第一百九十四次（用户纠偏："Readability 替代 不是（整页克隆），而是替代原始Readability
  //   或者同类产品，例如替代jsdom等"）：对比有两个正交维度，先说清楚再列数——
  //   ①「喂法」：同一个 Readability，喂给它什么（整页克隆 / 密度选容器后只克隆子树）；
  //   ②「替代」：换掉 Readability 本体或同类栈（浏览器内原生 DOM 已替代 jsdom 的角色；
  //     候选＝自研密度法，外部库见 docs/正文提取替代方案调研.md）。
  html += '<tr><td class="k">对比维度说明</td><td class="v" colspan="2">'
    + '①喂法对比＝同一个 Readability 喂入范围不同（整页克隆 / 子树克隆）；'
    + '②替代对比＝换掉 Readability 本体（方案五/六＝Defuddle 的整页/子树两种喂法；'
    + '自研密度法为零依赖候选）。整页克隆只是喂法，不是替代。'
    + '选型更新（第二百零六次，用户裁定）：给 AI 的主链路＝方案五 Defuddle（整页克隆喂入），'
    + '自研密度法兜底、直接解析保底；Readability 退出主链，仅存本表对比。</td></tr>';
  html += '<tr><td class="k">Readability 模块加载</td><td class="v">' + ms(r.loadMs)
    + '</td><td class="n">首次约 90KB，之后走缓存</td></tr>';
  // 四方案逐行：耗时 / 字符数 / 备注，失败则显示原始错误（不遮蔽）
  for (const p of (r.plans || [])) {
    if (p.error) {
      html += '<tr><td class="k">' + esc(p.name) + '</td><td class="v err">失败</td><td class="n">'
        + esc(p.error) + '</td></tr>';
      continue;
    }
    html += '<tr><td class="k">' + esc(p.name) + '</td><td class="v">' + ms(p.ms)
      + '</td><td class="n">' + esc(p.chars) + ' 字符 ｜ ' + esc(p.note || '') + '</td></tr>';
  }
  html += '</tbody></table>';
  // 各方案正文预览：用户要能核对"送给 AI 的上下文到底是什么"
  // 第一百九十六次（用户："诊断窗口提取的正文似乎截断了"）：预览 300 字符是展示口径
  //   不是提取上限——每块加「展开全文」按钮看提取全文（数据源 r.plans[].full，见上）。
  let _pi = -1;
  for (const p of (r.plans || [])) {
    _pi++;
    if (p.error || !p.preview) continue;
    html += '<div class="pv"><b>' + esc(p.name) + '</b>'
      + '<button class="pvtg" data-pv="' + _pi + '">展开全文</button>'
      + '<div class="pvt" data-pv="' + _pi + '">' + esc(p.preview) + '…</div></div>';
  }
  if (r.aiError) {
    html += '<div class="err">当前送 AI 的正文获取失败：' + esc(r.aiError) + '</div>';
  } else if (r.aiPreview !== undefined) {
    html += '<div class="pv"><b>【当前送给 AI 的上下文】来源=' + esc(r.aiSource) + '，'
      + esc(r.aiChars) + ' 字符，' + ms(r.aiMs) + '</b>'
      + (r.aiFull ? '<button class="pvtg" data-pv="ai">展开全文</button>' : '')
      + '<div class="pvt" data-pv="ai">' + esc(r.aiPreview) + '…</div></div>';
  }
  html += renderHintTiming(esc, ms);
  return html;
}

/**
 * 渲染「网页提示（高亮/注释）链路耗时」段
 *
 * 用户症状："目前测试显示解析至多耗时一秒，但体感好几秒才出现网页提示，解析之外的耗时也要调查。
 *   说了是网页，从网页文本出现到提示出现，不是点击聊天。"
 * 因此这里展示的是 text-hint 的分段时间线（th/core.js 的 thMark 埋点），
 *   以 DOMContentLoaded（网页文本出现的可观测代理时刻）为基准算相对耗时。
 * @param {Function} esc HTML 转义
 * @param {Function} ms 毫秒格式化
 * @returns {string} HTML
 */
function renderHintTiming(esc, ms) {
  let t = null;
  try { t = (typeof window.__beaverHintTiming === 'function') ? window.__beaverHintTiming() : null; }
  catch (e) { return '<div class="err">提示链路计时读取失败：' + esc(e && e.message || e) + '</div>'; }
  if (!t) return '<div class="pv"><b>【网页提示链路耗时】</b><div class="pvt">未取到（text-hint 未在本页启动）</div></div>';
  // 展示顺序＝链路先后；名称给中文说明，避免只有代号看不懂
  const ORDER = [
    ['hint:scriptStart', '内容脚本 classic 入口开跑（注入完成，import 之前）'],
    ['hint:start', 'startHint 入口（ESM 模块图装载完成）'],
    ['hint:bodyReady', 'body 就绪（waitForBody 返回）'],
    ['hint:sched', '扫描进入空闲队列'],
    ['hint:runStart', '扫描真正开跑（等空闲回调，最长 2000ms）'],
    ['hint:walkStart', 'TreeWalker 遍历开始'],
    ['hint:walkEnd', 'TreeWalker 遍历结束'],
    ['hint:firstHighlight', '★首个高亮出现（用户看见提示）'],
    ['hint:firstAnn', '★首条侧注释出现'],
    ['hint:dictReady', '词典就绪'],
    ['hint:dictRescan', '词典就绪后重扫'],
    ['hint:scanDone', '本轮扫描全部批次完成']
  ];
  const base = (typeof t.dcl === 'number') ? t.dcl : null;
  let html = '<div class="pv"><b>【网页提示链路耗时】DOMContentLoaded＝'
    + (base != null ? ms(base) : '取不到') + '，快照时刻 ' + ms(t.now) + '</b>';
  html += '<table><tbody>';
  // 第二百次：启动链路 boot 行——text-hint 的 import 挂起/失败此前只表现为下游一排
  //   "未发生"，断在哪一级零痕迹。boot.state（loading/ok/error/hang）+ error 原文
  //   （text-hint.js 写入 window.__beaverHintBoot）让断点直接可见、可直接粘贴回报。
  let boot = null;
  try { boot = (typeof window !== 'undefined') ? window.__beaverHintBoot : null; } catch (e) { /* ignore */ }
  if (boot) {
    const bad = (boot.ok === false) || (boot.state === 'error') || (boot.state === 'hang');
    html += '<tr><td class="k">启动链路 boot</td><td class="' + (bad ? 'v err' : 'v') + '">'
      + esc(String(boot.state || (boot.ok ? 'ok' : '未知')))
      + '</td><td class="n">' + esc(String(boot.error || (boot.ok ? '模块图装载成功' : '（无错误信息）'))) + '</td></tr>';
  }
  for (const [key, label] of ORDER) {
    const v = t.marks[key];
    if (typeof v !== 'number') {
      // 第一百九十次：首条侧注释未发生——用户确认侧注开关本来就关着，
      //   读 __beaverSideAnnOn（th/core.js getter）区分「预期」与「需查」。
      let note = '—';
      if (key === 'hint:firstAnn') {
        let annOn = null;
        try { annOn = (typeof window !== 'undefined') ? window.__beaverSideAnnOn : undefined; } catch (e) { /* ignore */ }
        note = (annOn === true) ? '侧注开关开着却未见——需查'
          : (annOn === false) ? '侧注开关关着＝预期现象' : 'text-hint 未在本页启动';
      }
      html += '<tr><td class="k">' + esc(label) + '</td><td class="v err">未发生</td><td class="n">' + esc(note) + '</td></tr>';
      continue;
    }
    const rel = base != null ? ('DCL 后 ' + ms(v - base)) : '—';
    const cnt = t.counts[key] || 1;
    html += '<tr><td class="k">' + esc(label) + '</td><td class="v">' + ms(v)
      + '</td><td class="n">' + esc(rel) + (cnt > 1 ? ' ｜ 共 ' + cnt + ' 次' : '') + '</td></tr>';
  }
  const ex = t.extra || {};
  html += '<tr><td class="k">文本节点 / 批次 / 串行查词</td><td class="v">'
    + esc((ex.nodes || 0) + ' / ' + (ex.batches || 0) + ' / ' + (ex.queries || 0))
    + '</td><td class="n">批间还各等一次空闲回调（最长 250ms/批，第二百零七次 1000→250）</td></tr>';
  // 第一百八十八次：词表去重诊断行（用户"文本生词重复还没解决"——
  //   计数器在 ws/scanner.js 的 _wsDiag，这里从 window.__beaverWsDedup 实时读取；
  //   三个失联字段（重复实锤/键集DOM失联/重排清重）任一 >0 即防护层失联，标红）。
  const dd = (typeof window !== 'undefined' && window.__beaverWsDedup) ? window.__beaverWsDedup : null;
  if (dd) {
    const dupHit = (dd.dupOnInsert > 0) || (dd.domDupBlocked > 0) || (dd.resortDupRemoved > 0);
    html += '<tr><td class="k">词表去重诊断（重复调查）</td><td class="' + (dupHit ? 'v err' : 'v') + '">'
      + '收词 ' + (dd.collectCalls || 0) + ' 次 / 递词 ' + (dd.offered || 0)
      + ' ｜ 入表 ' + (dd.accepted || 0) + ' / 实插 ' + (dd.inserted || 0)
      + '</td><td class="n">'
      + '★重复实锤 ' + (dd.dupOnInsert || 0)
      + ' ｜ 键集DOM失联 ' + (dd.domDupBlocked || 0)
      + ' ｜ 重排清重 ' + (dd.resortDupRemoved || 0)
      + ' ｜ 挡：键集 ' + (dd.blockedKey || 0) + ' / 批内 ' + (dd.blockedBatch || 0)
      + ' / 高频 ' + (dd.blockedHighRank || 0) + ' / 表外 ' + (dd.blockedOov || 0)
      + '</td></tr>';
  }
  // 第一百九十次：侧栏现状行——词表内零重复实锤（__beaverWsDedup 失联字段全 0）后，
  //   把"重复"排查面扩展到侧栏 DOM 整体：词表条目数/同 data-word 直读重复/句子条目数。
  //   直读重复 >0 标红，数据源 window.__beaverWsPanelStats（scanner.js）。
  const ps = (typeof window !== 'undefined' && typeof window.__beaverWsPanelStats === 'function') ? window.__beaverWsPanelStats() : null;
  if (ps && !ps.err) {
    html += '<tr><td class="k">侧栏现状（重复直读）</td><td class="' + (ps.dupCount > 0 ? 'v err' : 'v') + '">'
      + '词表 ' + ps.words + ' 条（唯一 ' + ps.uniq + '）｜ 句子 ' + ps.sentences + ' 条'
      + '</td><td class="n">'
      + (ps.dupCount > 0 ? '★同键重复 ' + ps.dupCount + ' 组：' + esc(ps.dupKeys) : '同键重复 0 ｜ 词表数组 ' + ps.arrLen)
      + '</td></tr>';
  }
  // 第一百九十三次：词集对账（用户："网页提示的生词跟文本侧栏的生词也不对应"）——
  //   网页 .beaver-word 高亮全集（dataset.word 统一 trim+小写，含透明的 later span，
  //   因侧栏词表本就"每词一条"不区分首现/后续）与侧栏词表 data-word 两个集合互差；
  //   任一侧非空即标红并列出词面（各截 8 个），一眼看出差异在哪侧。
  //   数据源 window.__beaverWordCompare（ws/scanner.js）。
  const wc = (typeof window !== 'undefined' && typeof window.__beaverWordCompare === 'function') ? window.__beaverWordCompare() : null;
  if (wc && !wc.err) {
    const bad = (wc.onlyPageTotal > 0) || (wc.onlyPanelTotal > 0);
    html += '<tr><td class="k">词集对账（网页 vs 侧栏）</td><td class="' + (bad ? 'v err' : 'v') + '">'
      + '网页 ' + wc.pageCount + ' 词 ｜ 侧栏 ' + wc.panelCount + ' 词'
      + '</td><td class="n">'
      + (bad
        ? ('仅网页 ' + wc.onlyPageTotal + '：' + esc((wc.onlyPage || []).join('、'))
          + ' ｜ 仅侧栏 ' + wc.onlyPanelTotal + '：' + esc((wc.onlyPanel || []).join('、')))
        : '两侧一致')
      + '</td></tr>';
  }
  // 第一百八十八次：词典装载分段行（定位"词典就绪"行的剩余耗时花在哪一段）。
  const dt = (typeof window !== 'undefined' && window.__beaverDictTiming) ? window.__beaverDictTiming : null;
  if (dt && (dt.proj > 0 || dt.rebuild > 0)) {
    // 第一百九十次：附 IDB 内部细分（连接/各表 getAll/meta），数据源 window.__beaverIdbTiming。
    const it = (typeof window !== 'undefined' && window.__beaverIdbTiming) ? window.__beaverIdbTiming : null;
    const idbNote = it
      ? ('IDB: 连接 ' + (it.open || 0) + 'ms ｜ rank表 ' + (it.ranks || 0) + 'ms/' + (it.rankRows || 0) + '行'
        + ' ｜ tags表 ' + (it.tags || 0) + 'ms/' + (it.tagRows || 0) + '行'
        + ' ｜ lemma表 ' + (it.lemmas || 0) + 'ms/' + (it.lemmaRows || 0) + '行'
        + ' ｜ meta ' + (it.meta || 0) + 'ms')
      : '';
    html += '<tr><td class="k">词典装载分段</td><td class="v">'
      + '投影读取 ' + (dt.proj || 0) + 'ms / Map构建 ' + (dt.map || 0) + 'ms'
      + ' / manifest对账 ' + (dt.manifest || 0) + 'ms / 重建补齐 ' + (dt.rebuild || 0) + 'ms'
      + '</td><td class="n">合计 ' + (dt.total || 0) + 'ms（对照"词典就绪"行）' + (idbNote ? '<br>' + esc(idbNote) : '') + '</td></tr>';
  }
  html += '</tbody></table></div>';
  // 第一百八十八次：重复现场事件块（scanner.js 的 _wsDupEvents，旧→新，上限 10 条）。
  if (dd && Array.isArray(dd.events) && dd.events.length > 0) {
    html += '<div class="pv"><b>【重复现场记录】（旧→新，最多 10 条）</b><div class="pvt">'
      + esc(dd.events.join('\n')) + '</div></div>';
  }
  return html;
}

/**
 * 打开/复用「正文提取耗时」诊断悬浮窗，并立即测算一次
 *
 * 用 Shadow DOM 承载，免受宿主页面 CSS 影响；面板自带「重新测算」与「关闭」。
 * @returns {Promise<void>}
 */
export async function openMainTextDiag() {
  let host = document.getElementById(DIAG_HOST_ID);
  let shadow;
  if (host && host.shadowRoot) {
    shadow = host.shadowRoot;
    host.style.display = 'block';
  } else {
    host = document.createElement('div');
    host.id = DIAG_HOST_ID;
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        /* 第一百九十五次（用户："诊断窗口不能调整大小，看着费劲"）：
           .box 改 flex 列布局 + resize:both（原生右下角拖拽把手，需 overflow 非 visible 故用 hidden）；
           默认高度＝旧观感（50vh 内容区 + 头部约 42px），拖拽后浏览器写入内联宽高，
           重开（display 切回）不丢；min/max 夹取防拖得过小/过大，.bd 随窗口伸缩滚动。 */
        .box { width: 520px; height: calc(50vh + 42px); min-width: 340px; min-height: 200px;
               max-width: 96vw; max-height: 94vh;
               display: flex; flex-direction: column; resize: both; overflow: hidden;
               background: #1f2430; color: #e8eaed;
               font: 12px/1.6 -apple-system, "Segoe UI", sans-serif; border-radius: 10px;
               box-shadow: 0 8px 28px rgba(0,0,0,.45); }
        .hd { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #2b3242; }
        .hd .ttl { flex: 1; font-weight: 600; }
        .hd button { background: #3a4457; color: #e8eaed; border: 0; border-radius: 6px;
                     padding: 4px 10px; cursor: pointer; font-size: 12px; }
        .hd button:hover { background: #4a566e; }
        .bd { flex: 1 1 auto; min-height: 0; padding: 8px 10px; overflow: auto; }
        table { width: 100%; border-collapse: collapse; }
        td { padding: 3px 4px; vertical-align: top; border-bottom: 1px solid #2f3646; }
        td.k { white-space: nowrap; color: #b8c0cf; }
        td.v { white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; color: #7ee2a8; }
        td.n { color: #8b93a3; font-size: 11px; }
        td.v.err { color: #ff9a9a; }
        .err { margin-top: 6px; color: #ff9a9a; word-break: break-all; }
        .tip { margin-top: 6px; color: #8b93a3; font-size: 11px; }
        /* 第一百九十六次：正文预览可展开全文（用户："提取的正文似乎截断了"）——
           预览固定 300 字符＋90px 高被当成提取被截断；数据本就含全文（r.plans[].full），
           这里只加展示开关。 */
        .pv .pvtg { float: right; background: #3a4457; color: #e8eaed; border: 0; border-radius: 5px;
                    padding: 2px 8px; cursor: pointer; font-size: 11px; }
        .pv .pvtg:hover { background: #4a566e; }
        .pvt.pvfull { max-height: 44vh; }
        /* 正文预览块：让用户直接核对每个方案提取出来的文本 */
        .pv { margin-top: 8px; }
        .pv b { color: #cfd6e4; font-weight: 600; }
        .pvt { margin-top: 3px; padding: 5px 6px; background: #171b24; border-radius: 5px;
               color: #9aa5b8; font-size: 11px; max-height: 90px; overflow: auto;
               white-space: pre-wrap; word-break: break-word; }
      </style>
      <div class="box">
        <div class="hd">
          <span class="ttl">正文提取耗时诊断</span>
          <button class="run">重新测算</button>
          <button class="close">关闭</button>
        </div>
        <div class="bd"><div class="tip">测算中…</div></div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);
    shadow.querySelector('.close').addEventListener('click', () => { host.style.display = 'none'; });
    shadow.querySelector('.run').addEventListener('click', () => { runDiagInto(shadow); });
    // 第一百九十六次（用户："诊断窗又不能移动，你咋放大？"）：标题栏拖拽移动。
    //   resize 把手在右下角，窗口又钉在屏幕右下角，不动就没法利用放大——先能挪再谈大。
    //   拖动把定位从 right/bottom 切到 left/top（夹在视口内），与 resize:both 共存；
    //   setPointerCapture 保证拖出窗口仍跟手；标题栏上的按钮不触发拖动。
    const hd = shadow.querySelector('.hd');
    hd.style.cursor = 'move';
    let dragState = null;
    hd.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = host.getBoundingClientRect();
      dragState = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try { hd.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      e.preventDefault();
    });
    hd.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      // 第二百一十三次（用户："诊断窗口要能自由移动，越过边界也行"）：去除视口钳位，
      //   标题栏按住拖到哪算哪（窗口可整体拖出屏幕外，拖回标题栏即可找回）。
      host.style.left = (e.clientX - dragState.dx) + 'px';
      host.style.top = (e.clientY - dragState.dy) + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    });
    const endDrag = () => { dragState = null; };
    hd.addEventListener('pointerup', endDrag);
    hd.addEventListener('pointercancel', endDrag);
    // 第一百九十六次：预览「展开全文/收起」委托监听（.bd 元素常驻，innerHTML 重建不影响）。
    //   全文由 runDiagInto 挂在 shadow.__plans / shadow.__aiFull，此处按 data-pv 取用。
    const bdEl = shadow.querySelector('.bd');
    bdEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.pvtg');
      if (!btn) return;
      const key = btn.dataset.pv;
      const div = bdEl.querySelector('.pvt[data-pv="' + key + '"]');
      if (!div) return;
      const full = (key === 'ai')
        ? shadow.__aiFull
        : ((shadow.__plans || [])[Number(key)] || {}).full;
      if (!full) return;
      const expandNow = !div.classList.contains('pvfull');
      if (expandNow) {
        div.dataset.prev = div.textContent.replace(/…$/, '');
        div.textContent = full;
      } else {
        div.textContent = (div.dataset.prev || '') + '…';
      }
      div.classList.toggle('pvfull', expandNow);
      btn.textContent = expandNow ? '收起' : '展开全文';
    });
  }
  await runDiagInto(shadow);
}

/**
 * 跑一次测算并把结果写入面板
 * @param {ShadowRoot} shadow 面板的 shadow root
 */
async function runDiagInto(shadow) {
  const bd = shadow.querySelector('.bd');
  bd.innerHTML = '<div class="tip">测算中…</div>';
  try {
    const r = await measureMainTextExtractors();
    // 第一百九十六次：全文数据挂到 shadow 供「展开全文」按钮取用（不经 innerHTML，防转义问题）
    shadow.__plans = r.plans || [];
    shadow.__aiFull = r.aiFull || null;
    bd.innerHTML = renderDiagRows(r)
      + `<div class="tip">页面：${location.host} ｜ ${new Date().toLocaleTimeString()} ｜ 标题栏拖动移动 ｜ 右下角拖拽调大小 ｜ 「展开全文」看提取全文</div>`;
  } catch (e) {
    // 不遮蔽错误：连测算本身都抛了，就把异常原文摆出来
    bd.innerHTML = `<div class="err">测算异常：${String((e && e.stack) || e)}</div>`;
  }
}

