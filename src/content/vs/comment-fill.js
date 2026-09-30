// =============================================================================
// vs/comment-fill.js —— 评论框填入子模块
// -----------------------------------------------------------------------------
// 职责：评论超长时按字节长度加权概率选行（pickRandomLinesForComment）、查找视频正下方主评论框
//       容器（findMainCommentContainer）、自动展开评论区、跨 shadow DOM 递归查找
//       并填入评论输入框（deepQuery/deepQueryAll/isInCommentItem/fillCommentInput）、
//       最小滚动定位（scrollMinIntoView）。
// 关系：依赖 ./logger.js（log）与 ./dom-utils.js（escapeHtml）。仅被门面
//       video-sidebar.js 的评论按钮流程调用；deepQuery/deepQueryAll/isInCommentItem
//       为本模块内部实现细节，不对外导出。
// =============================================================================

import { log } from './logger.js';
import { escapeHtml } from './dom-utils.js';

/**
 * 评论超长时按字节长度加权概率选取若干行，使 prefix + 选取行.join('\n') 总长度 ≤ maxLen
 *
 * 算法（Efraimidis–Spirakis 加权随机抽样）：
 *   1. 每行算 key = ln(1-U)/w（U∈(0,1)，w=字节长；与 U^(1/w) 同序，越长越优先）
 *   2. 按 key 降序贪心加入：只要再加一行不超限就加入（单行超限的跳过）
 *   3. 排序恢复原始字幕顺序，保证阅读连贯
 * @param {string[]} lines 已格式化的注释行
 * @param {number} maxLen 评论最大字符数（含前缀）
 * @param {number} prefixLen 前缀字符数
 * @param {number[]=} weights 各行概率权重（单词 UTF-8 字节长）；缺省用行内容字节长
 * @returns {string[]} 选取的行（按原顺序）
 */
export function pickRandomLinesForComment(lines, maxLen, prefixLen, weights) {
  const enc = new TextEncoder();
  const byteLen = (s) => enc.encode(s).length;
  const ws = (weights && weights.length === lines.length)
    ? weights
    : lines.map((l) => byteLen(l));
  const keyed = lines.map((_, i) => ({
    i,
    key: Math.log(1 - Math.random()) / Math.max(1, ws[i]),
  }));
  keyed.sort((a, b) => b.key - a.key); // key 大者先出
  const picked = [];
  let total = prefixLen;
  for (const { i } of keyed) {
    const lineLen = lines[i].length + 1; // +1 为换行符
    if (total + lineLen > maxLen) continue; // 跳过该行（含单行就超限的极端情况）
    picked.push(i);
    total += lineLen;
  }
  picked.sort((a, b) => a - b); // 恢复原字幕顺序
  return picked.map((i) => lines[i]);
}

// === 查找"视频正下方主评论框容器" ===
// B站评论区结构（自上而下）：#commentapp / #comment > bili-comments > 主评论框(顶部) + 评论列表(下方)
// 主评论框容器特征：id 含 comment、class 含 comment-wrapper/comment-app/publisher，
// 或 bili-comments 元素本身（其顶部即主评论框）。排除评论项列表。
export function findMainCommentContainer() {
  // 1. 优先精确匹配主评论框容器
  const direct = document.querySelector('#commentapp')
    || document.querySelector('#comment')
    || document.querySelector('.comment-wrapper')
    || document.querySelector('.comment-app');
  if (direct) return direct;
  // 2. bili-comments 元素（顶部即主评论框，滚动到它而非其内部列表）
  const bc = document.querySelector('bili-comments');
  if (bc) return bc;
  // YouTube：未点开时只有占位 #placeholder-area/#simplebox-placeholder，
  // 真正的 #contenteditable-root 点开后才挂载。容器定位优先认主框本体，
  // 返回其外层 ytd-comments（滚动到评论区顶部，而非某个回复项）。
  const ytSimplebox = document.querySelector('ytd-comment-simplebox-renderer')
    || document.querySelector('ytd-commentbox')
    || document.querySelector('#placeholder-area')
    || document.querySelector('#simplebox-placeholder');
  if (ytSimplebox) {
    return ytSimplebox.closest?.('ytd-comments')
      || ytSimplebox.closest?.('#comments')
      || ytSimplebox;
  }
  const ytComments = document.querySelector('ytd-comments')
    || document.querySelector('#comments');
  if (ytComments) return ytComments;
  // 3. 回退：第一个含 comment 的顶层容器
  return document.querySelector('[class*="comment-app"], [class*="comment-wrapper"], [class*="comment"]');
}

// === YouTube 评论区懒加载等待 ===
// 未滚到评论区时 ytd-comments/simplebox 可能根本不在 DOM 里，
// 第一次点击只起到"滚加载"作用，第二次才真填。改为主动滚触发加载并轮询等占位出现。
export async function ensureYtCommentsLoaded(maxWaitMs = 6000) {
  const ytHit = () => document.querySelector('ytd-comment-simplebox-renderer')
    || document.querySelector('ytd-commentbox')
    || document.querySelector('#placeholder-area')
    || document.querySelector('#simplebox-placeholder')
    || document.querySelector('ytd-commentbox #contenteditable-root')
    || document.querySelector('#contenteditable-root')
    || document.querySelector('ytd-comments')
    || document.querySelector('#comments');
  if (ytHit()) return ytHit();
  const below = document.querySelector('#below');
  if (below) below.scrollIntoView({ block: 'start' });
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < maxWaitMs) {
    const hit = ytHit();
    if (hit) return hit;
    // 步进下滚触发懒加载（一次滚到底可能跳过挂载时机）
    window.scrollBy({ top: 600 });
    n++;
    // 每滚几次把 #below 再拉回视口一次，防止滚过头
    if (n % 5 === 0 && below) below.scrollIntoView({ block: 'start' });
    await new Promise((r) => setTimeout(r, 250));
  }
  return ytHit();
}

// === 自动展开评论区 ===
export async function expandCommentBox() {
  // B站评论区默认折叠，需点击"写评论"展开
  const triggers = [
    '.reply-box .reply-box-trigger',
    '.reply-box .reply-box-input',
    '.comment-box .comment-trigger',
    '.bb-comment .reply-box-trigger',
    '.reply-box-trigger'
  ];
  for (const sel of triggers) {
    const el = document.querySelector(sel);
    if (el) {
      el.click();
      log('评论区触发点击:', sel);
      await new Promise((r) => setTimeout(r, 300));
      return;
    }
  }
  // YouTube：未点开时只有占位文案"Add a comment..."，真正的
  // #contenteditable-root 点占位后才挂载。旧实现点整个
  // ytd-comment-simplebox-renderer 常展不开，改点最内层占位。
  const ytHasEditor = () => !!document.querySelector('ytd-commentbox #contenteditable-root')
    || !!document.querySelector('#contenteditable-root');
  const ytPlaceholder = document.querySelector('ytd-comment-simplebox-renderer #placeholder-area')
    || document.querySelector('#placeholder-area')
    || document.querySelector('#simplebox-placeholder')
    || document.querySelector('ytd-comment-simplebox-renderer');
  if (ytPlaceholder) {
    if (ytHasEditor()) return;
    // 占位在视口外时点击可能被 YouTube 忽略，先滚进视口再点
    try { ytPlaceholder.scrollIntoView({ block: 'center' }); } catch (e) {}
    await new Promise((r) => setTimeout(r, 350));
    ytPlaceholder.click();
    log('YouTube 评论区触发点击: placeholder');
    // 轮询等 #contenteditable-root 挂载（最多约 3s），不等死 500ms
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (ytHasEditor()) return;
    }
    log('YouTube 占位已点但 #contenteditable-root 未出现');
    return;
  }
  const ytSimplebox = document.querySelector('ytd-comment-simplebox-renderer')
    || document.querySelector('#simplebox');
  if (ytSimplebox) {
    ytSimplebox.click();
    log('YouTube 评论区触发点击: simplebox');
    await new Promise((r) => setTimeout(r, 500));
    return;
  }
  log('未找到评论区触发器，可能已展开');
}

// === 填入评论框（递归穿透多层 shadow DOM） ===
// B站新版评论区 bili-comments 是嵌套 web component，textarea 藏在多层 shadowRoot 内
// 主评论框在视频正下方；评论项内的"回复"框在评论列表内，要排除
function deepQueryAll(root, selector) {
  const all = [];
  const collect = (r) => {
    if (!r) return;
    (r.querySelectorAll?.(selector) || []).forEach((el) => all.push(el));
    (r.querySelectorAll?.('*') || []).forEach((h) => {
      if (h.shadowRoot) collect(h.shadowRoot);
    });
  };
  collect(root);
  return all;
}

// 判断元素是否在评论项/回复项子树内（要排除的）
function isInCommentItem(el) {
  let p = el;
  while (p) {
    const tag = (p.tagName || '').toLowerCase();
    const cls = String(p.className || '').toLowerCase();
    const id = String(p.id || '').toLowerCase();
    if (/bili-comment-thread|bili-comment-item|comment-item|reply-item|reply-list|bili-comments-list|bili-comment-reply/.test(tag + ' ' + cls)) {
      return true;
    }
    // YouTube：评论项/回复项（主评论框 ytd-comment-simplebox-renderer 不在此列）
    if (/ytd-comment-thread-renderer|ytd-comment-renderer|ytd-comment-replies-renderer/.test(tag)) {
      return true;
    }
    if (/comment-replies|comment-thread/.test(cls + ' ' + id)) {
      // 主框 simplebox 本身 id/class 含 simplebox，不含 thread/replies，可安全排除回复
      return true;
    }
    // 跨 shadow boundary
    p = p.parentElement || (p.getRootNode && p.getRootNode().host);
  }
  return false;
}

function deepQuery(root, selector) {
  const all = deepQueryAll(root, selector);
  if (all.length === 0) return null;
  log('deepQuery 候选', all.length, '个:', all.slice(0, 5).map((el) =>
    `${el.tagName}.${String(el.className).slice(0,30)} inItem=${isInCommentItem(el)}`).join(' | '));
  // 优先级1：publisher/main 容器内的 editor（主评论框）
  const pub = all.find((el) => {
    let p = el;
    while (p) {
      const cls = String(p.className || '').toLowerCase();
      const tag = (p.tagName || '').toLowerCase();
      if (/publisher|main-input|reply-main|comment-publish|comment-input-main/.test(cls + ' ' + tag)) return true;
      p = p.parentElement || (p.getRootNode && p.getRootNode().host);
    }
    return false;
  });
  if (pub) return pub;
  // 优先级2：不在评论项内的（主评论框）
  const main = all.find((el) => !isInCommentItem(el));
  if (main) return main;
  // 全在评论项内：不回退到回复框，返回 null（宁可填不入也不填错位置）
  log('deepQuery: 所有候选都在评论项内，拒绝填入回复框');
  return null;
}

export async function fillCommentInput(text) {
  // 1. 优先富文本编辑器（普通 DOM）
  const editorSelectors = [
    '.reply-box .ql-editor[contenteditable=true]',
    '.comment-box .ql-editor[contenteditable=true]',
    '.ql-editor[contenteditable=true]'
  ];
  for (const sel of editorSelectors) {
    const editor = document.querySelector(sel);
    if (editor && !isInCommentItem(editor)) {
      editor.innerText = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      log('评论框命中: ql-editor', sel);
      return true;
    }
  }
  // 2. textarea（普通 DOM）
  const taSelectors = ['.reply-box textarea', '.comment-box textarea', 'textarea.reply-text'];
  for (const sel of taSelectors) {
    const ta = document.querySelector(sel);
    if (ta && !isInCommentItem(ta)) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(ta, text);
      else ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      log('评论框命中: textarea', sel);
      return true;
    }
  }
  // 3. YouTube 评论框：未点开时只有占位 #placeholder-area/#simplebox-placeholder，
  // 点开后才挂载 ytd-commentbox #contenteditable-root。按"先真实编辑器、后占位回退"
  // 顺序找；编辑器查找穿透 shadow DOM，且排除评论项内的回复框。
  const ytEditor = deepQuery(document, 'ytd-commentbox #contenteditable-root')
    || deepQuery(document, '#contenteditable-root')
    || (() => {
      const cands = deepQueryAll(document, '[contenteditable=true]');
      const main = cands.find((el) => {
        if (isInCommentItem(el)) return false;
        let p = el;
        while (p) {
          const tag = (p.tagName || '').toLowerCase();
          if (tag === 'ytd-comment-simplebox-renderer' || tag === 'ytd-commentbox') return true;
          p = p.parentElement || (p.getRootNode && p.getRootNode().host);
        }
        return false;
      });
      return main || cands.find((el) => !isInCommentItem(el)) || null;
    })();
  if (ytEditor) {
    ytEditor.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(ytEditor);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) document.execCommand('insertLineBreak');
        document.execCommand('insertText', false, lines[i]);
      }
    } catch (e) {
      ytEditor.innerText = text;
      ytEditor.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // 补一次 input 事件，让 YouTube polymer 同步内部 model
    ytEditor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    log('评论框命中: YouTube contenteditable');
    return true;
  }
  // 3b. 占位还没点开（调用方 expand 失败/评论区懒加载时）：点占位再等编辑器出现后填入
  const ytPlaceholder = document.querySelector('ytd-comment-simplebox-renderer #placeholder-area')
    || document.querySelector('#placeholder-area')
    || document.querySelector('#simplebox-placeholder');
  if (ytPlaceholder) {
    ytPlaceholder.click();
    log('YouTube 占位补点，等待编辑器挂载');
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const retry = document.querySelector('ytd-commentbox #contenteditable-root')
        || document.querySelector('#contenteditable-root');
      if (retry && !isInCommentItem(retry)) {
        return fillCommentInput(text);
      }
    }
    log('YouTube 占位补点后仍无编辑器');
  }
  // 4. 递归穿透所有 shadow DOM（bili-comments 等嵌套组件）
  const bc = document.querySelector('bili-comments') || document.querySelector('[class*="comment"]');
  if (bc) {
    const inner = deepQuery(bc.shadowRoot || bc, 'textarea, .ql-editor[contenteditable=true], [contenteditable=true]');
    if (inner) {
      if (inner.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(inner, text);
        else inner.value = text;
        inner.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        // contenteditable div（如 brt-editor）：直接改 DOM 会让框架数据失配，
        // 发布时框架只读到旧 model → 只剩前缀。
        // 用 execCommand 逐行 insertText + insertLineBreak，模拟真实键盘输入，
        // 让框架 input 监听逐行捕获并同步到内部 model。
        inner.focus();
        try {
          const root = inner.getRootNode() || document;
          const sel = root.getSelection ? root.getSelection() : null;
          const range = document.createRange();
          range.selectNodeContents(inner);
          if (sel) {
            sel.removeAllRanges();
            sel.addRange(range);
          }
          // 逐行插入：insertText 插文本，insertLineBreak 插换行，框架 model 逐次更新
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (i > 0) {
              document.execCommand('insertLineBreak');
            }
            if (lines[i]) {
              document.execCommand('insertText', false, lines[i]);
            }
          }
        } catch (e) {
          // 回退：innerHTML 用 <br> 换行（至少视觉完整，框架可能不认但可见）
          inner.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
          log('execCommand 逐行插入异常，回退 innerHTML:', e.message);
        }
        // 触发 input + beforeinput，部分框架监听 beforeinput
        inner.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
      log('评论框命中: shadow DOM 深度查找', inner.tagName, inner.className);
      return true;
    }
  }
  return false;
}

// === 最小滚动：只滚到元素刚进入视口，不把元素顶到屏幕顶部 ===
// 如果元素已在视口内，不滚动。下方/上方分别只补足最小距离。
export function scrollMinIntoView(el) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const margin = 24; // 留白
  if (rect.top >= 0 && rect.bottom <= vh) return; // 已在视口
  if (rect.bottom > vh) {
    // 元素在下方：只滚到让底部进入视口（元素顶部可能仍超出上方，但内容可见）
    const delta = rect.bottom - vh + margin;
    window.scrollBy({ top: delta, behavior: 'smooth' });
  } else if (rect.top < 0) {
    // 元素在上方：只滚到让顶部进入视口
    const delta = rect.top - margin;
    window.scrollBy({ top: delta, behavior: 'smooth' });
  }
}
