/**
 * chat.js —— 对话（Chat）面板：唯一实现，供三处入口共用
 *
 * 背景（第一百七十一次）：用户要求"右键查询的页面，底部增加 chat 图示按钮，文本侧栏底部也是；
 *   视频侧栏评论左侧增加 chat"。三处入口若各写一份面板必然行为分叉，故本文件是唯一实现，
 *   三处入口只负责"取文本 + 调用 openChatPanel(text)"。
 *
 * 职责边界：
 *   1. 面板 DOM（Shadow DOM 隔离，避免宿主页面 CSS 污染）、消息渲染、输入与发送
 *   2. 首条消息由引导页配置的默认提示词生成（{} = 选中文本，{lang} = 释义语言名）
 *   3. 网络请求不在本文件：content script 受宿主页面 CSP 限制无法直接 fetch 第三方 API，
 *      统一发 LLM_CHAT 消息交由 Service Worker 代理（与既有 OCR_RECOGNIZE / FETCH_URL 同构）
 *   4. 未配置 Key 时不静默失败，显示"打开设置"按钮跳转引导页（OPEN_GUIDE 消息）
 *
 * 定位策略：默认固定右下角浮层（position:fixed），不参与宿主页面布局，
 *   与右键查词面板/侧栏互不遮挡（右键面板跟随鼠标，侧栏贴边）；
 *   第一百七十五次起标题栏可拖拽（见 bindHeadDrag），用户可自行挪位置。
 */

import { LANG_NAMES, t } from './i18n.js';
// 第二百零七次：上下文按引导页字节上限截断（超出取当前阅读位置附近文本）
import { capContextByBytes } from './main-text.js';
import { CHAT_WORD_PROMPT, CHAT_SIDEBAR_PROMPT } from './llm.js';

// 面板宿主元素 id：右键查词面板的"点击外部关闭"逻辑需按此 id 放行（见 th/panel.js）
export const CHAT_PANEL_ID = 'beaver-chat-panel';

// 单实例：整页只有一个对话面板，重复调用复用同一实例（避免多个浮层叠加）
let _host = null;
let _shadow = null;
// 对话历史（发给模型的完整上下文），面板关闭即清空——一次对话一个话题
let _history = [];
// 请求进行中标志：防止连点造成多路并发写入同一条 pending 气泡
let _busy = false;

// 引用文本最大长度：过长的字幕/正文直接塞给模型既慢又易超上下文，统一截断
const MAX_TEXT = 2000;
// 第二百零六次：上下文正文上限与提问引用分离。第二百零七次改为**引导页参数**
//   chatContextMaxBytes（默认 100000 字节），超出时取当前阅读位置附近文本
//   （capContextByBytes）；本常量仅作 storage 读取失败时的保底值。
const MAX_CONTEXT = 20000;

/**
 * 面板结构与样式（Shadow DOM 内部）
 * @returns {string} HTML 字符串
 */
function buildChatHTML() {
  return `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .wrap { display: flex; flex-direction: column; width: 420px; max-width: calc(100vw - 24px); height: 520px; max-height: calc(100vh - 24px);
              background: #ffffff; border: 1px solid #e9eee7; border-radius: 14px; box-shadow: 0 8px 28px rgba(0,0,0,0.18);
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; color: #1a1f1a; overflow: hidden; }
      /* 第一百七十五次（用户："聊天窗能动"）：标题栏即拖拽把手，故给 move 光标并禁用选中，
         避免拖动时把标题文字选成蓝块。关闭按钮上恢复 pointer。 */
      .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; background: #f5f8f3;
              cursor: move; user-select: none; }
      .head .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .head .close { border: 0; background: transparent; cursor: pointer; font-size: 16px; line-height: 1; color: #424942; padding: 2px 4px; }
      /* 第一百八十四次：上下文区改为「The context is」标签 + 可编辑正文框。
         第一百八十五次（用户："上下文框是折叠不见了。上下文那不用复选框，用底色表示选中。
         对话框，上下文框，都是点击的时候从一行扩展半页，失去焦点的时候压缩"）：
           · 去掉复选框与折叠箭头 —— 选中态改由标签底色表达（.ctx.on 时标签为深绿底白字），
             点标签即切换"是否把正文带给模型"；
           · 正文框不再 display:none（用户判为"折叠不见了"），改为常驻可见的一行，
             聚焦即扩展到半页、失焦压回一行，高度全程由 JS syncBoxHeight 写内联 height 控制，
             故此处 CSS 只留上限与一行的兜底最小高，不能钉死 min-height（钉死则压不回去）。 */
      .ctx { border-bottom: 1px solid #e9eee7; background: #fafcf9; padding-bottom: 8px; flex: none; }
      .ctx-head { display: flex; align-items: center; gap: 6px; padding: 6px 12px 4px;
                  color: #424942; font-size: 0.9em; user-select: none; }
      /* 底色即选中态：未选中为浅灰描边，选中为品牌绿实心 */
      .ctx-head .ctx-label { cursor: pointer; padding: 2px 8px; border-radius: 999px;
                             border: 1px solid #dbe3d8; background: #eef2ec; color: #6b736b; transition: background 0.12s ease; }
      .ctx.on .ctx-head .ctx-label { background: #2e6b43; border-color: #2e6b43; color: #fff; }
      .ctx-text { display: block; width: calc(100% - 24px); margin: 0 12px; min-height: 34px; max-height: 60vh;
                  padding: 6px 8px; border: 1px solid #dbe3d8; border-radius: 8px; background: #fff;
                  font: inherit; font-size: 0.85em; line-height: 1.5; color: #424942; resize: vertical; outline: none;
                  overflow-y: auto; transition: height 0.12s ease; }
      .body { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
      .msg { padding: 8px 10px; border-radius: 10px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
      .msg.user { background: #2e6b43; color: #fff; align-self: flex-end; max-width: 88%; }
      .msg.bot { background: #f2f5f1; color: #1a1f1a; align-self: flex-start; max-width: 96%; }
      .msg.err { background: #fdecea; color: #8a1c12; align-self: flex-start; max-width: 96%; }
      .cfg { align-self: flex-start; padding: 6px 12px; background: #2e6b43; color: #fff; border: 0; border-radius: 8px; cursor: pointer; font-size: inherit; }
      /* 输入区改为上下排布：输入框独占一行、发送按钮居右下，这样输入框能做得足够高 */
      .foot { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-top: 1px solid #e9eee7; background: #fafcf9; }
      /* 第一百七十六次（用户："输入时候输入框大些容纳多点字，不再输入状态时候缩回去"）：
         高度不再由 CSS min-height 钉死（钉死则永远缩不回去），改由 JS syncBoxHeight 写内联
         height 全权控制；这里只留一行的兜底最小高。
         第一百八十五次（用户："都是点击的时候从一行扩展半页，失去焦点的时候压缩。目前输入框固定"）：
           旧写法把 max-height 钉在 200px，且 .foot 的兄弟 .body 是 flex:1，
           textarea 在 flex 列里默认 flex-shrink:1 会被压回原样 —— 这就是"输入框固定"的真因。
           故此处显式 flex: none 关掉收缩，上限交由 JS 按面板高度算（半页）。 */
      .foot textarea { width: 100%; flex: none; min-height: 34px; resize: vertical; padding: 8px; border: 1px solid #dbe3d8;
                       border-radius: 8px; font: inherit; line-height: 1.5; color: inherit; outline: none; background: #fff; overflow-y: auto;
                       transition: height 0.12s ease; }
      .foot .send { align-self: flex-end; padding: 8px 14px; background: #2e6b43; color: #fff; border: 0; border-radius: 8px; cursor: pointer; font-size: inherit; white-space: nowrap; }
      .foot .send:disabled { opacity: 0.55; cursor: not-allowed; }
    </style>
    <div class="wrap">
      <div class="head">
        <div class="title">${t('chat.title')}</div>
        <button class="close" title="${t('btn.close')}">✕</button>
      </div>
      <div class="ctx on">
        <div class="ctx-head">
          <span class="ctx-label">The context is</span>
        </div>
        <textarea class="ctx-text" rows="1"></textarea>
      </div>
      <div class="body"></div>
      <div class="foot">
        <textarea class="input" rows="1" placeholder="${t('chat.placeholder')}"></textarea>
        <button class="send">${t('chat.send')}</button>
      </div>
    </div>
  `;
}

/**
 * 创建（或复用）面板宿主与事件绑定；幂等
 */
function ensureChatPanel() {
  if (_host && document.documentElement.contains(_host)) return;
  _host = document.createElement('div');
  _host.id = CHAT_PANEL_ID;
  // 不设 all:initial（Shadow DOM 已隔离样式），仅固定层级与位置
  _host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;display:none;';
  _shadow = _host.attachShadow({ mode: 'open' });
  _shadow.innerHTML = buildChatHTML();
  document.documentElement.appendChild(_host);

  _shadow.querySelector('.close').onclick = () => closeChatPanel();
  _shadow.querySelector('.send').onclick = () => submitInput();
  // 回车发送、Shift+回车换行（与常见聊天框一致）
  const input = _shadow.querySelector('.input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitInput();
    }
  });
  // 第一百八十五次（用户："对话框，上下文框，都是点击的时候从一行扩展半页，失去焦点的时候压缩"）：
  //   输入框与上下文框走同一套双态高度逻辑 syncBoxHeight，事件绑定完全对称，
  //   免得两个框行为分叉（第一百八十四次就是只管了输入框）。
  //   click 也要绑：textarea 已聚焦时再点不会重复触发 focus，但用户的心智是"点击就展开"。
  const bindBox = (el) => {
    ['focus', 'blur', 'input', 'click'].forEach((ev) => {
      el.addEventListener(ev, () => syncBoxHeight(el));
    });
  };
  bindBox(input);
  const ctx = _shadow.querySelector('.ctx');
  const ctxText = _shadow.querySelector('.ctx-text');
  bindBox(ctxText);
  // 第一百八十五次：上下文选中态改用底色表达（去掉复选框），点标签切换 .ctx.on
  _shadow.querySelector('.ctx-label').addEventListener('click', () => {
    ctx.classList.toggle('on');
  });
  bindHeadDrag();
}

/**
 * 文本框高度双态：聚焦时扩展到半页，失焦压回一行
 * 第一百七十五次（用户："输入时候输入框大些容纳多点字"）：起初按内容驱动。
 * 第一百八十四次（用户："输入框输入时才会展开，失去焦点应当一行"）：改为聚焦/失焦两态。
 * 第一百八十五次（用户："都是点击的时候从一行扩展半页，失去焦点的时候压缩。目前输入框固定"）：
 *   三处修正 ——
 *     1. 上限从硬编码 200px 改为"半页"= 面板可视高度的一半（min 120px 兜底），
 *        面板高 520px 时约 260px，符合"扩展半页"；
 *     2. 通用化：输入框与上下文框共用本函数（原先只服务输入框，上下文框无高度逻辑）；
 *     3. 不再按 scrollHeight 量体裁衣——聚焦一律给到半页。用户要的是"点击就扩展半页"，
 *        内容不足时若仍按内容算高度，看起来就是"输入框固定不动"（即本轮所诉症状）。
 *   判焦必须用 _shadow.activeElement：Shadow DOM 内 document.activeElement 只会
 *   指到宿主元素 #beaver-chat-panel，拿不到内部真正的焦点节点。
 * @param {HTMLTextAreaElement} el 目标文本框
 */
function syncBoxHeight(el) {
  if (!el || !_shadow) return;
  const ONE_LINE = 34;
  if (_shadow.activeElement !== el) {
    el.style.height = ONE_LINE + 'px';
    return;
  }
  const wrap = _shadow.querySelector('.wrap');
  const half = Math.max(120, Math.round(((wrap && wrap.clientHeight) || 520) / 2));
  el.style.height = half + 'px';      // 聚焦即半页；内容更长时由自身滚动条承载
}

/**
 * 标题栏拖拽：让面板可被用户挪到任意位置
 * 第一百七十五次（用户："聊天窗能动"）。实现要点：
 *   1. 初始定位用 right/bottom，拖动前先换算成 left/top（否则两组属性同时生效会打架）；
 *   2. 用 pointer 事件 + setPointerCapture，鼠标移出面板甚至移出窗口仍能持续拖动；
 *   3. 拖动范围夹在视口内（至少留 40px 可见），避免把面板拖出屏幕再也点不回来；
 *   4. 点关闭按钮不触发拖拽（closest('.close') 直接返回）。
 */
function bindHeadDrag() {
  const head = _shadow.querySelector('.head');
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let dragging = false;
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('.close')) return;
    const r = _host.getBoundingClientRect();
    // 一次性把 right/bottom 定位切换为 left/top 定位，后续只改 left/top
    _host.style.left = r.left + 'px';
    _host.style.top = r.top + 'px';
    _host.style.right = 'auto';
    _host.style.bottom = 'auto';
    startX = e.clientX;
    startY = e.clientY;
    startLeft = r.left;
    startTop = r.top;
    dragging = true;
    try { head.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器忽略 */ }
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = _host.offsetWidth;
    const maxLeft = Math.max(0, window.innerWidth - 40);
    const maxTop = Math.max(0, window.innerHeight - 40);
    const left = Math.min(Math.max(startLeft + (e.clientX - startX), 40 - w), maxLeft);
    const top = Math.min(Math.max(startTop + (e.clientY - startY), 0), maxTop);
    _host.style.left = left + 'px';
    _host.style.top = top + 'px';
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    try { head.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  };
  head.addEventListener('pointerup', stop);
  head.addEventListener('pointercancel', stop);
}

/**
 * 追加一条消息气泡
 * @param {string} kind 'user' | 'bot' | 'err'
 * @param {string} text 文本内容
 * @returns {HTMLElement} 气泡元素（便于后续原地替换"思考中"文案）
 */
function appendMsg(kind, text) {
  const body = _shadow.querySelector('.body');
  const div = document.createElement('div');
  div.className = 'msg ' + kind;
  div.textContent = text;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
  return div;
}

/**
 * 显示"打开设置"按钮（未配置 API Key 时）
 */
function appendConfigButton() {
  const body = _shadow.querySelector('.body');
  const btn = document.createElement('button');
  btn.className = 'cfg';
  btn.textContent = t('chat.openGuide');
  btn.onclick = () => {
    try { chrome.runtime.sendMessage({ type: 'OPEN_GUIDE' }); } catch (e) { /* 上下文失效则忽略 */ }
  };
  body.appendChild(btn);
  body.scrollTop = body.scrollHeight;
}

/**
 * 取输入框内容并发送
 * 第一百八十四次：勾选「The context is」时，把上下文区的正文一并发出，
 *   格式即用户指定的 `The context is \n{正文}`，置于提问语之前 ——
 *   侧栏默认提示词是 "Please summarise the text above in {lang}."，
 *   正文必须在"上面"才对得上。
 *   只在本轮对话的第一条消息拼接：后续轮次 _history 里已带着这段正文，
 *   再拼一次就是重复喂料，白烧上下文额度。
 */
function submitInput() {
  const input = _shadow.querySelector('.input');
  const text = (input.value || '').trim();
  if (!text) return;
  input.value = '';
  syncBoxHeight(input);
  sendMessage(withContext(text));
}

/**
 * 按上下文区的选中态给提问语拼上正文
 * 第一百八十五次（用户："组装提示词的时候，记得中间换行符拼接"、"上下文依旧内容胡来"、
 *   "上下文那不用复选框，用底色表示选中"）：
 *     1. 选中态判据从复选框 .ctx-on.checked 改为容器类名 .ctx.on（复选框已移除，
 *        原判据会取到 null 而直接 return question —— 正文根本发不出去，即"内容胡来"之一）；
 *     2. 拼接一律用换行符分段：标签行 / 正文 / 空行 / 提问语，四段之间只用 \n 连接，
 *        不再把 'The context is ' 尾随空格与正文黏在一行。
 * @param {string} question 用户提问语
 * @returns {string} 实际发给模型的内容
 */
function withContext(question) {
  if (_history.length > 0) return question;            // 只拼第一条
  const ctx = _shadow.querySelector('.ctx');
  const ctxText = _shadow.querySelector('.ctx-text');
  if (!ctx || !ctx.classList.contains('on')) return question;
  const body = String((ctxText && ctxText.value) || '').trim();
  if (!body) return question;
  // 第一百八十六次（用户："提示词用换行符拼接，是指上下文跟输入框，
  //   \"The contex...\"+'\n\n'+\"input prompt\""）：
  //   上下文块 = 'The context is\n{正文}'（note.txt 原始规定），
  //   上下文块与输入框内容之间用一个空行（\n\n）隔开，仅此两段。
  return 'The context is\n' + body + '\n\n' + question;
}

/**
 * 发送一条用户消息并渲染模型回复
 * @param {string} content 用户消息
 */
async function sendMessage(content) {
  if (_busy) return;
  _busy = true;
  const sendBtn = _shadow.querySelector('.send');
  sendBtn.disabled = true;
  appendMsg('user', content);
  _history.push({ role: 'user', content });
  const pending = appendMsg('bot', t('chat.thinking'));
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'LLM_CHAT', messages: _history });
    if (resp && resp.ok && resp.content) {
      pending.textContent = resp.content;
      _history.push({ role: 'assistant', content: resp.content });
    } else {
      // 不遮蔽错误：把后台返回的原始错误原文显示出来，便于用户与诊断
      pending.className = 'msg err';
      pending.textContent = t('chat.failed') + (resp && resp.error ? '：' + resp.error : '');
      if (resp && resp.needConfig) appendConfigButton();
      // 失败的这一轮不留在上下文里，避免污染后续对话
      _history.pop();
    }
  } catch (e) {
    pending.className = 'msg err';
    pending.textContent = t('chat.failed') + '：' + String((e && e.message) || e);
    _history.pop();
  }
  _busy = false;
  sendBtn.disabled = false;
  _shadow.querySelector('.body').scrollTop = _shadow.querySelector('.body').scrollHeight;
}

/**
 * 读取引导页配置的默认提示词，并用引用文本与释义语言填充
 * 第一百八十四次（用户："查询默认提示词，对于单词类查询 Please explain the text"{}" in {lang}.
 *   右键查询，点开的单词等。侧栏默认提示词 Please summarise the text above in {lang}."）：
 *   提示词从一套拆成两套，按入口类型取用：
 *     · kind='word'    —— 右键查词面板、悬浮提示里点开的单词，模板含 {}（= 该词/选区）
 *     · kind='sidebar' —— 文本侧栏正文、视频侧栏字幕，正文由上下文区承载，模板不含 {}
 *   侧栏模板不含 {} 时 split('{}') 是无害空转，故仍统一走同一套替换。
 * @param {string} text 引用文本
 * @param {string} kind 'word' | 'sidebar'
 * @returns {Promise<string>} 首条消息
 */
function buildFirstPrompt(text, kind) {
  const isWord = kind !== 'sidebar';
  const key = isWord ? 'chatWordPrompt' : 'chatSidebarPrompt';
  const def = isWord ? CHAT_WORD_PROMPT : CHAT_SIDEBAR_PROMPT;
  return new Promise((resolve) => {
    let done = false;
    const fill = (tpl, langName) => tpl.split('{}').join(text).split('{lang}').join(langName);
    const fallback = () => {
      if (done) return;
      done = true;
      resolve(fill(def, 'English'));
    };
    try {
      chrome.storage.local.get({ [key]: def, meaningLanguage: 'zh' }, (res) => {
        if (done) return;
        done = true;
        const tpl = String((res && res[key]) || def);
        const langCode = String((res && res.meaningLanguage) || 'zh');
        const langName = LANG_NAMES[langCode] || langCode;
        resolve(fill(tpl, langName));
      });
    } catch (e) { fallback(); }
  });
}

/**
 * 打开对话面板；若带文本则把首条提问“预填”进输入框，等用户自己按发送
 *
 * 行为约定（第一百七十四次，按用户要求修正）：
 *   1. 只唤起、只预填，绝不自动发起请求——发送权完全归用户（避免误点即消耗额度/等待）
 *   2. 无文本也能唤起：此时引用区隐藏、输入框为空，用户可直接自由提问
 * @param {string} [text] 要讨论的对象（单词/选区/字幕/正文），用于填充提问语模板的 {}
 * @param {string} [kind] 入口类型：'word'（右键查词/悬浮提示的单词）| 'sidebar'（文本侧栏正文/视频侧栏字幕）
 * @param {string} [contextText] 上下文框正文。第一百八十六次（用户："对话框的上下文依旧胡说。
 *   老毛病，并不是第一次出现。你复述一遍我的要求上下文来源。"）：按 note.txt 原始规定，
 *   上下文框的正文**只有两种来源**——Readability 提取的网页正文，或字幕；
 *   单词/选区只进提问语，绝不进上下文。省略时才退回用 text 充当上下文（侧栏入口原本就传正文）。
 * @returns {Promise<boolean>} 是否成功唤起（恒为 true，保留返回值以兼容既有调用方）
 */
export async function openChatPanel(text, kind, contextText) {
  const raw = String(text || '').trim();
  const clipped = raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT) : raw;
  // 上下文正文：显式传入则用之（网页正文/字幕），否则沿用 text
  const ctxRaw = (contextText === undefined || contextText === null)
    ? raw : String(contextText).trim();
  // 第二百零七次（用户："对话窗口的上下文要截断，引导页参数，默认最多10万字节。
  //   选取当前位置附近的文本"）：有独立上下文（网页正文/字幕）→ 读引导页字节上限，
  //   超限以当前阅读位置为锚点取附近文本；无独立上下文（单词/选区）→ 维持 2000。
  let ctxClipped;
  if (contextText === undefined || contextText === null) {
    ctxClipped = ctxRaw.length > MAX_TEXT ? ctxRaw.slice(0, MAX_TEXT) : ctxRaw;
  } else {
    let cap = MAX_CONTEXT;
    try {
      const res = await new Promise((resolve) => {
        try { chrome.storage.local.get({ chatContextMaxBytes: 10000 }, resolve); } catch (_) { resolve({}); }
      });
      if (typeof res.chatContextMaxBytes === 'number' && res.chatContextMaxBytes >= 1000) {
        cap = Math.floor(res.chatContextMaxBytes);
      }
    } catch (_) { /* 读取失败用保底值 */ }
    ctxClipped = capContextByBytes(ctxRaw, cap);
  }
  ensureChatPanel();
  // 每次打开都是新话题：清空历史与气泡
  _history = [];
  _shadow.querySelector('.body').innerHTML = '';
  // 第一百八十四次：上下文区 —— 正文进 textarea。
  //   无正文时整块隐藏（避免顶部出现一条空白横条）。
  // 第一百八十五次：折叠态改为"可见的一行"（不再 display:none），选中态改由 .ctx.on 底色表达；
  //   每次打开都重置为「选中 + 一行」，否则上一轮的状态会带到下一轮。
  const ctx = _shadow.querySelector('.ctx');
  const ctxText = _shadow.querySelector('.ctx-text');
  ctxText.value = ctxClipped;
  ctx.classList.add('on');
  ctxText.style.height = '34px';
  ctx.style.display = ctxClipped ? '' : 'none';
  _host.style.display = 'block';
  const input = _shadow.querySelector('.input');
  // 预填而不发送：有文本 → 填入按模板生成的首条提问；无文本 → 留空
  input.value = clipped ? await buildFirstPrompt(clipped, kind) : '';
  // 第一百八十四次：顺序要紧 —— syncBoxHeight 要看聚焦态（失焦压一行），
  //   必须先 focus 再同步高度，否则预填的提问语会被当成失焦状态压成一行。
  input.focus();
  syncBoxHeight(input);
  // 光标置于末尾，便于用户在预填语句后继续补充
  try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* 忽略 */ }
  return true;
}

/**
 * 关闭对话面板（清空历史，下次打开为新话题）
 */
export function closeChatPanel() {
  if (!_host) return;
  _host.style.display = 'none';
  _history = [];
  if (_shadow) _shadow.querySelector('.body').innerHTML = '';
}
