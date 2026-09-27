// =============================================================================
// yt/page-context.js —— YouTube 页面主世界注入与 timedtext 拦截缓存
// -----------------------------------------------------------------------------
// 职责：injectPageScript()（注入 page-fetch.js + 建立 message 监听 + PING 补问）、
//       syncPageTimedtextCache()（回查页面侧缓存合并）、fetchViaPageContext()
//       （BEAVER_FETCH_REQUEST 经页面上下文 fetch，绕过签名绑定会话限制）、
//       timedtextUrlAllowed()（数据卫生：他源 timedtext 拒入缓存）。
//       模块状态内聚：_pageTimedtextCache/_pageScriptInjected/_pageScriptReady
//       仅本模块读写，随函数迁入；对外经 getTimedtextCache()（返回活数组引用，
//       身份不变=等价）与 getPageInjectStatus()（日志用 ready/cacheLen 快照）暴露。
// 来源：拆分自 src/lib/subtitle/youtube-fetcher.js（2026-09-27 拆分第三刀，机械搬移）。
// 消费方：./player-intercept.js（缓存读取/回查/注入）、./caption-tracks.js（注入+状态日志）、
//       ./track-download.js（页面上下文 fetch）。
// =============================================================================

// === YouTube 页面主世界注入 ===
//
// 反思（2026-07-03 第六次修正）：
//   旧版在 Content Script 隔离世界中猴子补丁 XMLHttpRequest.prototype，
//   以为能拦截 YouTube 播放器的 XHR——这是根本性错误！
//   Content Script 运行在隔离世界，与页面主世界 JavaScript 上下文隔离，
//   补丁仅影响 Content Script 自身的 XHR，无法捕获播放器的请求。
//   同时，Content Script 的 fetch 请求虽然带同源 cookie，但 YouTube 的
//   timedtext URL 签名绑定播放器会话（可能涉及 Sec-Fetch-* 头等浏览器内部状态），
//   从 Content Script 发出的 fetch 返回 0 字节。
//
//   正确方案：通过 <script src="chrome-extension://..."> 注入 page-fetch.js
//   到页面主世界，在页面上下文中执行 fetch 和 XHR 拦截。
//   页面上下文的 fetch 请求与播放器自身请求完全一致，能正常获取字幕数据。
//
// 通信机制：Content Script ↔ Page Script 通过 window.postMessage 双向通信

/** 页面主世界 timedtext 拦截缓存 */
const _pageTimedtextCache = [];
let _pageScriptInjected = false;
let _pageScriptReady = false;

/**
 * 拆分接驳：返回 timedtext 缓存活数组引用（与原模块级常量同一身份，
 * player-intercept 的 checkPageCache/计数读取语义不变）。
 */
export function getTimedtextCache() {
  return _pageTimedtextCache;
}

/**
 * 拆分接驳：页面注入状态快照（原 getYouTubeSubtitles 日志直读
 * _pageScriptReady/_pageTimedtextCache.length，改走本快照，取值时点等价）。
 */
export function getPageInjectStatus() {
  return { ready: _pageScriptReady, cacheLen: _pageTimedtextCache.length };
}

/**
 * 第三百七十三次（用户复测：侧栏字幕 100 句全是 [music] 类噪音，而视频真实 CC 是正常
 * 英文解说——抓到的字幕数据与画面不一致）：数据卫生校验——timedtext URL 的 v= 参数
 * 必须等于当前页面视频 ID，否则拒绝入缓存。
 * 是啥：预览播放器（频道/首页 hover 内联预览）、贴片广告、连播上一条都在**主文档**
 *   JS 上下文发 timedtext 请求，page-fetch.js 一律捕获；旧版无差别入缓存后，
 *   checkPageCache 的 `(!urlV || urlV === videoId)` 分支可能误用他源字幕。
 * 有啥用：从入缓存口断掉跨视频污染，SPA 连播换视频后旧字幕也不会被误用（额外收益）。
 * 口径：urlV 缺失或 pageV 缺失（无法判定）放行——保守不误杀；带 v 且不匹配才拒。
 * @param {string} url timedtext 请求 URL
 * @returns {boolean} true=放行入缓存
 */
function timedtextUrlAllowed(url) {
  let urlV = null;
  try { urlV = new URL(url, 'https://www.youtube.com').searchParams.get('v'); } catch (e) { /* 无法解析视为无 v */ }
  if (!urlV) return true;
  const pageV = location.search.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1]
    || location.pathname.match(/\/([A-Za-z0-9_-]{11})(?:[/?]|$)/)?.[1];
  if (!pageV) return true;
  if (urlV !== pageV) {
    console.warn('[VocabRadar][youtube] 数据卫生: 拒绝他源 timedtext 入缓存 urlV=', urlV, 'pageV=', pageV);
    return false;
  }
  return true;
}

/**
 * 注入 page-fetch.js 到页面主世界（Firefox 兜底路径）+ 建立消息监听。
 *
 * 第一百七十八次（借鉴 VideoSeek 修 YouTube CC 字幕）双轨化：
 *   - Chrome/Edge：page-fetch.js 已由 manifest 声明式注入（world:MAIN +
 *     document_start），本函数**不会重复装补丁**（页面侧 __beaverPageFetchInjected 去重），
 *     只负责建立本世界的 message 监听、PING 补问 READY、以及回查页面侧早期缓存。
 *   - Firefox：MV3 不支持 world:"MAIN"，build.mjs 剥离该条 → 仍靠此处 <script src> 懒注入。
 * 仅执行一次（_pageScriptInjected 标记）。
 */
export function injectPageScript() {
  if (_pageScriptInjected) return;
  _pageScriptInjected = true;

  // 先建监听，再注入/PING——顺序不能颠倒，否则 READY 与早期 CAPTURE 会漏接。
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    // 页面脚本就绪通知
    if (data.type === 'BEAVER_PAGE_FETCH_READY') {
      _pageScriptReady = true;
      console.log('[VocabRadar][youtube] 页面主世界脚本就绪, 已有缓存=', _pageTimedtextCache.length, '条');
      return;
    }

    // timedtext 拦截捕获
    if (data.type === 'BEAVER_TIMEDTEXT_CAPTURE' && data.url && data.resp) {
      // 避免重复缓存同一 URL
      if (_pageTimedtextCache.some(function (c) { return c.url === data.url; })) return;
      // 第三百七十三次：数据卫生——他源视频的 timedtext（预览/广告/连播）不入缓存
      if (!timedtextUrlAllowed(data.url)) return;
      _pageTimedtextCache.push({ url: data.url, resp: data.resp, contentType: data.contentType || '' });
      console.log('[VocabRadar][youtube] 页面主世界拦截: timedtext 已捕获, url长度=', data.url.length, '响应长度=', (data.resp || '').length, '共', _pageTimedtextCache.length, '条');
      // 第三百七十一次（用户批复"事件驱动重拉"）：捕获信号外发——旧版只进缓存+
      //   console.log，无人消费；用户初始未开 CC 时 getYouTubeSubtitles 早已一次性
      //   失败返回 null，之后点开 CC 侧栏永远"无字幕"。此处广播给本世界（content），
      //   vc/controller.js 监听后自动重拉轨道（每视频限 3 次防风暴）。
      try {
        window.dispatchEvent(new CustomEvent('vr-timedtext-captured', { detail: { len: (data.resp || '').length, n: _pageTimedtextCache.length } }));
      } catch (_) { /* 广播失败不影响缓存主链 */ }
    }
  });

  // PING 一次：Chrome 声明式注入下 READY 早在 document_start 就发过、必已丢失，
  // 必须补问，否则 _pageScriptReady 永远为 false → fetchViaPageContext 全线拒绝。
  try { window.postMessage({ type: 'BEAVER_PAGE_FETCH_PING' }, '*'); } catch (e) { /* 忽略 */ }

  // 懒注入（Firefox 路径；Chrome 下页面侧会因去重标记直接 return，无副作用）
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/lib/page-fetch.js');
    script.onload = function () {
      _pageScriptReady = true;
      script.remove();
    };
    script.onerror = function () {
      console.warn('[VocabRadar][youtube] page-fetch.js 懒注入失败（Chrome 下已有声明式注入，可忽略）');
    };
    (document.head || document.documentElement).appendChild(script);
  } catch (e) {
    console.warn('[VocabRadar][youtube] page-fetch.js 注入异常:', e);
  }
}

/**
 * 回查页面主世界的 timedtext 缓存，合并进本世界缓存。
 *
 * 为什么必需（第一百七十八次核心修复）：page-fetch.js 在 document_start 就位后，
 * 播放器自发的 timedtext 请求会被立即捕获并广播，但本内容脚本（document_idle）
 * 当时尚未建立监听，那些广播全部丢失。故必须主动向页面侧索取整批缓存。
 * 这一步等价于 VideoSeek 的 YoutubeInjectHelper.injectedData 事后读取。
 * @returns {Promise<number>} 新合并进来的条数
 */
export async function syncPageTimedtextCache() {
  try {
    const res = await fetchViaPageContext('__beaver_timedtext_query__', 3000);
    if (!res || !res.text) return 0;
    const list = JSON.parse(res.text);
    if (!Array.isArray(list)) return 0;
    let added = 0;
    for (const item of list) {
      if (!item || !item.url || !item.resp) continue;
      if (_pageTimedtextCache.some((c) => c.url === item.url)) continue;
      // 第三百七十三次：数据卫生——页面侧回查合并同样拒绝他源 timedtext
      if (!timedtextUrlAllowed(item.url)) continue;
      _pageTimedtextCache.push({ url: item.url, resp: item.resp, contentType: item.contentType || '' });
      added++;
    }
    if (added > 0) {
      console.log('[VocabRadar][youtube] 页面侧缓存回查: 合并', added, '条, 本世界共', _pageTimedtextCache.length, '条');
    }
    return added;
  } catch (e) {
    console.warn('[VocabRadar][youtube] 页面侧缓存回查失败:', e.message);
    return 0;
  }
}

/**
 * 通过页面主世界 fetch URL。
 * 发送 BEAVER_FETCH_REQUEST 消息，page-fetch.js 在页面上下文执行 fetch 并返回结果。
 * 页面上下文的 fetch 请求与播放器自身请求一致，能绕过签名绑定会话的限制。
 *
 * 第一百七十八次：ready 门禁由"立即拒绝"改为"短等待 1.5s"。
 *   原因：Chrome 声明式注入（document_start）下 READY 消息早已发过且丢失，
 *   只能靠 injectPageScript() 的 PING 补答；postMessage 是异步的，紧随其后的
 *   首次调用必然撞上 _pageScriptReady=false → 旧实现直接放弃，整条页面通道空转。
 * @param {string} url 要 fetch 的 URL（特殊值 '__beaver_timedtext_query__' /
 *        '__beaver_bili_playurl_query__' 为页面侧缓存回查指令，不发真实网络请求）
 * @param {number} [timeout=10000] 超时毫秒
 * @returns {Promise<{ok:boolean, status:number, text:string, contentType:string}|null>}
 */
export async function fetchViaPageContext(url, timeout = 10000) {
  if (!_pageScriptReady) {
    // 补问一次 READY，然后最多等 1.5s（15×100ms）
    try { window.postMessage({ type: 'BEAVER_PAGE_FETCH_PING' }, '*'); } catch (e) { /* 忽略 */ }
    for (let i = 0; i < 15 && !_pageScriptReady; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!_pageScriptReady) {
      console.warn('[VocabRadar][youtube] 页面主世界脚本未就绪（已等 1.5s），无法通过页面上下文 fetch');
      return null;
    }
  }

  return new Promise((resolve) => {
    const id = 'beaver_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    const handler = (event) => {
      if (event.source !== window) return;
      if (event.data?.type === 'BEAVER_FETCH_RESPONSE' && event.data?.id === id) {
        window.removeEventListener('message', handler);
        resolve(event.data);
      }
    };
    window.addEventListener('message', handler);

    window.postMessage({ type: 'BEAVER_FETCH_REQUEST', id, url }, '*');

    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, timeout);
  });
}
