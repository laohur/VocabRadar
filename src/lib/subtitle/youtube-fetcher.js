// ============================================================
// 文件职责：YouTube 字幕获取（页面主世界注入、轨道发现、innertube 各路径、PoToken 熔断、track 下载）
// 来源：拆分自 src/lib/subtitle-fetcher.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-27
// 符号：getYouTubeSubtitles / warmYouTubeCaptionInnertube / fetchYouTubeTrack（由 index.js 统一 re-export）
// 内部工具：ensureXmlFormat / extractVarFromScripts / extractBalancedJson / fetchTrackListViaInnertube 等
//   仅被本文件使用，故保留在本文件而不放入 subtitle-parser.js（拆分计划规则）
// 注：下方紧随的原文件头注释（修复历史）原样保留；其中 B 站相关修复历史现位于 bilibili-fetcher.js。

// ⚠ 语法修复说明（2026-08-27，唯一一处偏离“逐字节搬移”的必要修复）：
//   原文件 fetchTrackViaGetTranscript 的 catch 块存在真实语法错误：
//   第一份残缺 catch 体（原 L1270-1279）以 “} catch (e) {”（原 L1280）非法衔接，
//   V8 解析直接报 SyntaxError: Unexpected token 'catch'（原文件在浏览器中同样无法加载）。
//   修复：删除第一份残缺 catch 体与非法的 “} catch (e) {” 行（原 L1270-1280，共11行），
//   保留紧随其后语义完整的第二份 catch 体（原 L1281-1294，重试/熔断逻辑完整）。
//   其余所有代码均逐字节原样搬移，原有注释全部保留。
// ============================================================
// 字幕获取：B站 + YouTube
// 返回统一格式 [{start, end, text}]
//
// 修复历史：
//   2026-06-25：B站 AI 字幕 lan 为 ai-en/ai-zh，原匹配 startsWith('en') 漏检 ai-en；
//               新增 wbi 签名（player wbi/v2 调用前对参数签名）；增加详细日志。
//   2026-06-30：修复字幕下载 CORS 失败——AI 字幕域名 aisubtitle.hdslb.com 响应头为
//               Access-Control-Allow-Origin:*，带 credentials:'include' 会被浏览器拒绝；
//               字幕 URL 已带 auth_key 鉴权，无需 cookie，改为 credentials:'omit'。
//               修复 getPageVar inline script 被 B站 CSP 拒绝——改读 <script> 标签
//               textContent 提取页面变量（仅读取不执行，不违反 CSP）；B站 aid/cid
//               统一走 view API（已验证可用）。
//   2026-07-03：YouTube 字幕下载根因修复。历次误判回顾：
//               v1 fmt=xml→空, v2 fmt=srv→空, v3 fmt=json3→空, v4 不改fmt→仍空。
//               误判结论"修改fmt会使签名失效"是错误的！真正根因：getPlayerResponse()
//               返回的 baseUrl 签名绑定了播放器会话上下文，content script 直接 fetch
//               该 URL 时 YouTube 返回 0 字节。正确方案：用 innertube API 的
//               WEB_EMBEDDED_PLAYER 客户端获取全新的 baseUrl（签名不绑定会话），
//               再加 fmt=json3 参数（fmt 不在 sparams 签名列表中，安全），
//               用普通 fetch 下载即可成功。

// ⚠ 第一百七十三次（用户反馈"youtube字幕依旧抓不到"）——真实根因修复：
//   2026-08-27 那次拆分把 parseSubtitleContent 留在 subtitle-parser.js 并加了 export，
//   却**漏写本文件的 import**。本文件 9 处调用它（路径 0/1/2/3/4/4b/A/5 的最后一步
//   全部依赖），运行时一律抛 ReferenceError: parseSubtitleContent is not defined，
//   且被各路径的 catch 吞成"路径N 异常"，观感与网络失败/PoToken 问题完全一致。
//   逃逸原因：未声明标识符是**运行时**错误而非语法错误，`node --check` 查不出来
//   （拆分自述的验证手段恰是 node --check，故当时全 PASS）。
//   教训：拆分后必须做"自由标识符对账"，不能只跑语法校验。
import { parseSubtitleContent } from './subtitle-parser.js';


/**
 * 补全 YouTube 字幕 URL 的 v 参数（不修改 fmt）。
 *
 * 反思（2026-07-03 第五次修正）：
 *   之前结论"修改fmt会使签名失效"是错误的。fmt 不在 sparams 签名参数列表中，
 *   添加/修改 fmt 不会破坏签名。但 getPlayerResponse() 返回的 baseUrl 签名
 *   绑定了播放器会话，直接 fetch 无论 fmt 取何值都返回 0 字节。
 *   此函数仅补充 v 参数，fmt 由 fetchYouTubeTrack 中的 innertube 路径处理。
 *
 * @param {string} url 原始 baseUrl
 * @param {string} videoId 当前视频 ID
 * @returns {string} 校验后的 URL
 */
function ensureXmlFormat(url, videoId) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (videoId && !u.searchParams.has('v')) {
      u.searchParams.set('v', videoId);
    }
    return u.toString();
  } catch (e) {
    console.warn('[VocabRadar][youtube] ensureXmlFormat 解析 URL 失败:', e.message, '保留原 URL');
    return url;
  }
}

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
 * 注入 page-fetch.js 到页面主世界（Firefox 兜底路径）+ 建立消息监听。
 *
 * 第一百七十八次（借鉴 VideoSeek 修 YouTube CC 字幕）双轨化：
 *   - Chrome/Edge：page-fetch.js 已由 manifest 声明式注入（world:MAIN +
 *     document_start），本函数**不会重复装补丁**（页面侧 __beaverPageFetchInjected 去重），
 *     只负责建立本世界的 message 监听、PING 补问 READY、以及回查页面侧早期缓存。
 *   - Firefox：MV3 不支持 world:"MAIN"，build.py 剥离该条 → 仍靠此处 <script src> 懒注入。
 * 仅执行一次（_pageScriptInjected 标记）。
 */
function injectPageScript() {
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
      _pageTimedtextCache.push({ url: data.url, resp: data.resp, contentType: data.contentType || '' });
      console.log('[VocabRadar][youtube] 页面主世界拦截: timedtext 已捕获, url长度=', data.url.length, '响应长度=', (data.resp || '').length, '共', _pageTimedtextCache.length, '条');
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
async function syncPageTimedtextCache() {
  try {
    const res = await fetchViaPageContext('__beaver_timedtext_query__', 3000);
    if (!res || !res.text) return 0;
    const list = JSON.parse(res.text);
    if (!Array.isArray(list)) return 0;
    let added = 0;
    for (const item of list) {
      if (!item || !item.url || !item.resp) continue;
      if (_pageTimedtextCache.some((c) => c.url === item.url)) continue;
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
async function fetchViaPageContext(url, timeout = 10000) {
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

/**
 * 睡眠若干毫秒（第一百七十八次新增，等价 VideoSeek 的 CommonHelper.sleep）。
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 判断当前是否正在播放贴片/前置广告（第一百七十八次新增）。
 *
 * 为什么必需：广告播放期间播放器的字幕轨道尚未挂载，此时 setOption('captions','track')
 * 不会触发任何 timedtext 请求 → 白等到超时。VideoSeek 的做法是先轮询等广告结束
 * （最多 30 次 × 1000ms），仍在播则直接抛 NeedSkipAdError 放弃本次抓取。
 * 判据与 VideoSeek 完全一致：存在 .video-ads 元素且其计算样式可见
 * （display≠none && visibility≠hidden && opacity≠'0'）。
 * @returns {boolean} true=正在播广告
 */
function isYouTubeAdShowing() {
  try {
    const el = document.querySelector('.video-ads');
    if (!el) return false;
    const st = window.getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  } catch {
    return false;
  }
}

/**
 * 获取 YouTube 播放器对象
 * @returns {Object|null}
 */
function getYouTubePlayer() {
  try {
    const isShort = location.pathname.includes('/shorts/');
    // 第一百五十次：选择器放宽——旧版仅认 ytd-player#ytd-player，部分布局/实验分支
    // 无此元素 → path0 恒"播放器不可用"→ 全渠道死。按优先级探测标准 API 宿主：
    const candidates = isShort
      ? ['#shorts-player', '#movie_player', 'div.html5-video-player']
      : ['ytd-player#ytd-player', '#movie_player', 'div.html5-video-player'];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const p = el.player_ || el;
      if (p && typeof p.setOption === 'function') return p;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 检查页面主世界缓存中是否有匹配语言的 timedtext 响应。
 * @param {string} languageCode 语言代码
 * @param {string} videoId 视频 ID
 * @returns {string|null} 匹配的响应文本，无匹配返回 null
 */
function checkPageCache(languageCode, videoId) {
  for (let i = _pageTimedtextCache.length - 1; i >= 0; i--) {
    const item = _pageTimedtextCache[i];
    try {
      const u = new URL(item.url, 'https://www.youtube.com');
      const urlLang = u.searchParams.get('lang');
      const urlTlang = u.searchParams.get('tlang');
      const urlV = u.searchParams.get('v');
      // 匹配条件：lang 匹配且无翻译(tlang)，videoId 匹配（或 URL 中无 v 参数）
      if (!urlTlang && urlLang === languageCode && (!urlV || urlV === videoId)) {
        console.log('[VocabRadar][youtube] 页面缓存命中: lang=', urlLang, 'v=', urlV, 'resp长度=', (item.resp || '').length);
        return item.resp;
      }
    } catch (e) {
      console.warn('[VocabRadar][youtube] 页面缓存 URL 解析失败', e.message);
    }
  }
  return null;
}

/**
 * 用 YouTube 播放器 API 触发字幕加载，然后等待页面主世界拦截器捕获响应。
 *
 * 流程（第一百七十八次按 VideoSeek getSubtitles 主流程重排）：
 *   1. 回查页面主世界 timedtext 缓存（document_start 拦截到的早期请求）
 *   2. 检查本世界缓存（播放器可能已加载过该语言字幕）
 *   3. 等广告播完（最多 30×1000ms），仍在播则放弃本路径
 *   4. 等播放器就绪 → toggleSubtitlesOn → 等轨道挂载
 *   5. 切轨前先回查一次缓存（对应 VideoSeek 的第一次 waitForInject）
 *   6. 构造目标轨道配置（captionTracks 命中走原生轨；否则走 translationLanguages 翻译轨）
 *   7. setOption → sleep(1000) → 轮询等待拦截
 *
 * @param {string} languageCode 语言代码（如 'en'）
 * @param {string} videoId 视频 ID
 * @param {number} timeout 超时秒数，默认 8
 * @param {{kind?:string, vss_id?:string, name?:string}} [track=null] 原轨道元数据——
 *        自动生成轨（kind='asr'）必须带 kind 且 vss_id 为 'a.xx' 形态；旧版固定 '.xx'
 *        手动轨配置对纯 ASR 视频无效，setOption 不被播放器接受 → 白等 8s 必空。
 * @returns {Promise<string|null>} 拦截到的字幕响应文本
 */
async function triggerAndInterceptSubtitle(languageCode, videoId, timeout = 8, track = null) {
  injectPageScript();

  // 第一百七十八次：先向页面主世界索取整批 timedtext 缓存。
  // Chrome 下 page-fetch.js 于 document_start 就位，播放器自发的字幕请求早已被捕获，
  // 但那时本内容脚本还没建立监听 → 广播丢失，只能主动回查。这是本轮决定性一步：
  // 播放器对已加载轨道不会重复请求，不回查就只能白等超时。
  await syncPageTimedtextCache();

  // 先检查缓存——播放器可能已经加载过字幕
  const cached = checkPageCache(languageCode, videoId);
  if (cached) return cached;

  // 第一百七十八次（借鉴 VideoSeek）：等前置广告播完。广告期间字幕轨道未挂载，
  // setOption 不触发任何 timedtext 请求。最多等 30 秒，仍在播则放弃路径0
  // （VideoSeek 此处抛 NeedSkipAdError；本项目下游有 A/B 免 POT 通道，返回 null 让其接手）。
  if (isYouTubeAdShowing()) {
    for (let i = 0; i < 30 && isYouTubeAdShowing(); i++) {
      if (i === 0) console.log('[VocabRadar][youtube] 页面拦截: 检测到广告播放中，等待广告结束');
      await sleep(1000);
    }
    if (isYouTubeAdShowing()) {
      console.warn('[VocabRadar][youtube] 页面拦截: 广告等待 30s 超时，放弃路径0');
      return null;
    }
    console.log('[VocabRadar][youtube] 页面拦截: 广告已结束，继续触发');
  }

  // 第一百三十七次（用户反馈"en generate 空，切轨再回来才有；你重试有啥用，咋不模仿用户操作"）：
  // 手动切换之所以总成功，是因为用户操作时播放器早已就绪。旧版此处"播放器不可用→立即放弃"，
  // 首取必然落在空窗期。改为**等播放器就绪再触发**（轮询 500ms，至多 waitMs）——时机对齐用户操作。
  // 第一百四十九次（用户反馈"现在切换也不行"）：等待播放器就绪 12s 过长——手动
  // 切轨被拖慢、A/B 免 POT 通道迟迟接手不了。收敛为 3.5s：等不到就让 A/B 上，
  // path0 的完整机会留到模拟切轨轮次（彼时播放器早已就绪，秒过等待）。
  const waitMs = 3500;
  let player = getYouTubePlayer();
  if (!player || typeof player.setOption !== 'function') {
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      await new Promise((r) => setTimeout(r, 500));
      player = getYouTubePlayer();
      if (player && typeof player.setOption === 'function') break;
    }
    if (!player || typeof player.setOption !== 'function') {
      console.warn('[VocabRadar][youtube] 页面拦截: 等待', waitMs, 'ms 后播放器仍不可用，放弃路径0');
      return null;
    }
    console.log('[VocabRadar][youtube] 页面拦截: 播放器经', Date.now() - t0, 'ms 就绪，继续触发');
  }

  // 记录拦截前的数据量，用于判断新增
  const beforeCount = _pageTimedtextCache.length;
  console.log('[VocabRadar][youtube] 页面拦截: 播放器就绪, beforeCount=', beforeCount);

  // 保存当前字幕轨道，稍后恢复
  const prevTrack = player.getOption?.('captions', 'track');
  const wasSubtitlesOn = player.isSubtitlesOn?.();
  console.log('[VocabRadar][youtube] 页面拦截: 原轨道=', prevTrack?.languageCode, '字幕开启=', wasSubtitlesOn);

  try {
    // 确保字幕开启
    if (typeof player.toggleSubtitlesOn === 'function') {
      console.log('[VocabRadar][youtube] 页面拦截: toggleSubtitlesOn() 确保开启');
      player.toggleSubtitlesOn();
    }

    // 等待播放器准备好字幕轨道
    let currentTrack = player.getOption?.('captions', 'track');
    console.log('[VocabRadar][youtube] 页面拦截: 等待轨道就绪, currentTrack=', currentTrack?.languageCode);
    for (let i = 0; i < 5 && (!currentTrack?.languageCode); i++) {
      await new Promise(r => setTimeout(r, 1000));
      currentTrack = player.getOption?.('captions', 'track');
      console.log('[VocabRadar][youtube] 页面拦截: 第', (i+1), '次等待, track=', currentTrack?.languageCode);
    }

    // 第一百七十八次（借鉴 VideoSeek 的第一次 waitForInject）：切轨之前先回查一次。
    // toggleSubtitlesOn() 本身就可能让播放器把默认轨道拉下来；若恰好是目标语言，
    // 直接用即可，不必再切轨（切轨反而扰动用户的字幕设置）。
    await syncPageTimedtextCache();
    const cachedAfterToggle = checkPageCache(languageCode, videoId);
    if (cachedAfterToggle) {
      console.log('[VocabRadar][youtube] 页面拦截: toggleSubtitlesOn 后缓存已命中，无需切轨');
      return cachedAfterToggle;
    }

    // 构造目标轨道配置，触发 YouTube 播放器请求该语言的字幕
    // 第一百三十三次：自动生成轨（kind='asr'）必须带 kind 且 vss_id 用 'a.xx' 形态，
    // 否则播放器不认这份手动轨配置、不发起请求（"en 自动生成轨加载为空"的路径0根因）。
    // 第一百七十八次（借鉴 VideoSeek）：优先**在播放器当前轨道对象上就地改字段**再回设，
    // 而不是凭空造一个新对象——当前对象里有播放器自己塞的内部字段，凭空造的配置
    // 常被静默丢弃。currentTrack 拿不到时才退回自造。
    const playerResp = (() => {
      try { return player.getPlayerResponse?.(); } catch { return null; }
    })();
    const respTracks = playerResp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const respTransLangs = playerResp?.captions?.playerCaptionsTracklistRenderer?.translationLanguages || [];
    // VideoSeek 读的是驼峰 vssId（getPlayerResponse 原始字段名），而播放器 setOption
    // 要的是下划线 vss_id——两边字段名不同，此前混用是"配置不被接受"的隐性根因之一。
    const nativeTrack = respTracks.find((t) => t.languageCode === languageCode);
    const isAsr = (track && track.kind === 'asr') || nativeTrack?.kind === 'asr';

    const trackConfig = (currentTrack && typeof currentTrack === 'object')
      ? Object.assign({}, currentTrack)
      : {
        languageCode: languageCode,
        vss_id: (track && track.vss_id) || (isAsr ? `a.${languageCode}` : `.${languageCode}`),
        kind: (track && track.kind) || '',
        displayName: languageCode,
        languageName: languageCode,
        translationLanguage: null
      };

    if (nativeTrack) {
      // 分支一：目标语言在原生 captionTracks 中，直接切原生轨
      const dn = nativeTrack.name?.simpleText || nativeTrack.name?.runs?.[0]?.text || languageCode;
      trackConfig.languageCode = languageCode;
      trackConfig.vss_id = nativeTrack.vssId || nativeTrack.vss_id
        || (track && track.vss_id) || (isAsr ? `a.${languageCode}` : `.${languageCode}`);
      trackConfig.kind = nativeTrack.kind || (track && track.kind) || '';
      trackConfig.displayName = dn;
      trackConfig.languageName = dn;
      trackConfig.translationLanguage = null;
      console.log('[VocabRadar][youtube] 页面拦截: 走原生轨分支', languageCode, 'vss_id=', trackConfig.vss_id, 'kind=', trackConfig.kind);
    } else {
      // 分支二（第一百七十八次新增，此前完全缺失）：目标语言不在 captionTracks 中，
      // 必须走 translationLanguages 翻译轨——保留当前轨道的 languageCode/vss_id 不变，
      // 只改 displayName 与 translationLanguage。旧实现把 languageCode 直接改成目标语言、
      // vss_id 瞎拼 '.xx'，播放器一律不接受 → 白等 8s 必空。
      const tl = respTransLangs.find((t) => t.languageCode === languageCode);
      if (!tl) {
        console.warn('[VocabRadar][youtube] 页面拦截:', languageCode, '既不在 captionTracks 也不在 translationLanguages，放弃路径0');
        return null;
      }
      const tlName = tl.languageName?.simpleText || tl.languageName?.runs?.[0]?.text || languageCode;
      // displayName 形如 "English >> 简体中文"；原名若已含 ">>" 先截掉旧的后半段
      let baseName = String(trackConfig.languageName || trackConfig.displayName || '');
      if (baseName.includes('>>')) baseName = baseName.split('>>')[0].trim();
      trackConfig.displayName = baseName + ' >> ' + tlName;
      trackConfig.translationLanguage = { languageCode: languageCode, languageName: tlName };
      console.log('[VocabRadar][youtube] 页面拦截: 走翻译轨分支 →', trackConfig.displayName);
    }

    console.log('[VocabRadar][youtube] 页面拦截: setOption captions track →', languageCode, 'kind=', trackConfig.kind, 'vss_id=', trackConfig.vss_id);
    player.setOption('captions', 'track', trackConfig);

    // 第一百七十八次（借鉴 VideoSeek）：setOption 后先固定睡 1 秒再进轮询。
    // 播放器切轨是异步的：立刻轮询会在轨道尚未发起请求时空转，且 200ms 一轮的
    // 日志噪声掩盖真实时序。VideoSeek 此处同样是 sleep(1e3)。
    await sleep(1000);

    // 等待页面主世界拦截器捕获响应
    const startTime = Date.now();
    const maxWait = timeout * 1000;

    while (Date.now() - startTime < maxWait) {
      // 检查是否有新增的拦截数据
      if (_pageTimedtextCache.length > beforeCount) {
        console.log('[VocabRadar][youtube] 页面拦截: 新增', (_pageTimedtextCache.length - beforeCount), '条记录, 共', _pageTimedtextCache.length, '条');
        // 查找匹配的拦截数据
        const matched = checkPageCache(languageCode, videoId);
        if (matched) return matched;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // 超时前最后向页面侧回查一次——广播可能因时序落空，但页面缓存里有
    await syncPageTimedtextCache();
    const lastChance = checkPageCache(languageCode, videoId);
    if (lastChance) {
      console.log('[VocabRadar][youtube] 页面拦截: 超时前回查命中');
      return lastChance;
    }

    console.warn('[VocabRadar][youtube] 页面拦截: 等待超时（', timeout, '秒），最终共', _pageTimedtextCache.length, '条记录');
    return null;
  } finally {
    // 恢复原始字幕轨道和状态
    setTimeout(() => {
      try {
        if (prevTrack && typeof player.setOption === 'function') {
          player.setOption('captions', 'track', prevTrack);
        }
        if (wasSubtitlesOn && !player.isSubtitlesOn?.()) {
          player.toggleSubtitlesOn?.();
        } else if (!wasSubtitlesOn && player.isSubtitlesOn?.()) {
          player.toggleSubtitles?.();
        }
      } catch { /* 恢复失败不影响主流程 */ }
    }, 2000);
  }
}

// === YouTube ===
//
// 字幕轨道获取：四路兜底（2026-07-03 修订）
//
// 故障背景：
//   - 原版 innertube 用 2024 年硬编码 INNERTUBE_API_KEY/clientVersion，已失效。
//   - 上一轮加三路兜底后用户仍反馈"videoseek 能找到我方不能"。
//
// 调研 videoseek-ref/ytIndex.a719a07b.js 得知 videoseek 用的是：
//   document.querySelector("ytd-player#ytd-player")?.player_?.getPlayerResponse()
//   （Shorts 用 document.querySelector("#shorts-player")?.getPlayerResponse()）
// 即直接调 YouTube 自身播放器对象的方法，数据是 YouTube 自己加载完毕后持有的实时数据，
// SPA 导航后实时更新，永远可靠——这是 videoseek 能找到字幕的根因。
//
// 四路兜底顺序（新增路径0 为最优先，与 videoseek 同源）：
//   0) ytd-player.player_.getPlayerResponse() / #shorts-player.getPlayerResponse()
//      YouTube 自身播放器对象的实时数据（SPA 后也可靠，最稳）
//   1) 页面 <script> 提取 ytInitialPlayerResponse（首次全量加载有，需校验 videoId）
//   2) innertube player API：INNERTUBE_API_KEY / clientVersion 从页面 ytcfg 动态提取
//   3) timedtext list 接口兜底，重建 baseUrl
//
// 四路任一成功即返回；全失败返回 null。

/**
 * 从页面 <script> 标签文本提取 ytcfg 中的 INNERTUBE_API_KEY 与 clientVersion。
 *
 * ytcfg.set({INNERTUBE_API_KEY: "AIza...", INNERTUBE_CONTEXT: {client: {clientVersion: "..."}}})
 * 仅读取脚本文本不执行，不违反 CSP。提取不到返回空串（调用方回退默认值）。
 * @returns {{apiKey:string, clientVersion:string}}
 */
function extractYtcfg() {
  let apiKey = '';
  let clientVersion = '';
  try {
    const scripts = document.getElementsByTagName('script');
    for (const s of scripts) {
      const text = s.textContent || '';
      if (!text.includes('INNERTUBE_API_KEY') && !text.includes('clientVersion')) continue;
      if (!apiKey) {
        const m = text.match(/INNERTUBE_API_KEY:\s*"([A-Za-z0-9_-]+)"/);
        if (m) apiKey = m[1];
      }
      if (!clientVersion) {
        const m = text.match(/"clientVersion":\s*"([0-9.]+)"/);
        if (m) clientVersion = m[1];
      }
      if (apiKey && clientVersion) break;
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] extractYtcfg 异常:', e);
  }
  console.log('[VocabRadar][youtube] ytcfg 提取: apiKey=' + (apiKey ? '(有)' : '(空)')
    + ' clientVersion=' + (clientVersion || '(空)'));
  return { apiKey, clientVersion };
}

/**
 * 解析 timedtext list 接口返回的 XML，重建字幕轨道。
 * 接口：https://www.youtube.com/api/timedtext?v=<id>&type=list
 * 返回 <transcript_list><track lang_code="en" lang_translated="English" kind="asr"/></transcript_list>
 * baseUrl 需用 v+lang+kind 重建（list 接口不直接给 baseUrl）。
 * @param {string} xml
 * @param {string} videoId
 * @returns {Array<{baseUrl, languageCode, name}>}
 */
function parseTimedTextListXml(xml, videoId) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const trackEls = doc.querySelectorAll('track');
  const tracks = [];
  for (const t of trackEls) {
    const langCode = t.getAttribute('lang_code') || '';
    const langName = t.getAttribute('lang_translated') || langCode;
    const kind = t.getAttribute('kind') || '';
    if (!langCode) continue;
    // 重建 baseUrl：lang+kind（asr）即可拉取对应字幕，强制 fmt=json3
    const baseUrl = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(langCode)}`
      + (kind ? `&kind=${encodeURIComponent(kind)}` : '')
      + '&fmt=json3';
    tracks.push({
      baseUrl,
      languageCode: langCode,
      name: langName,
      // 第一百七十八次：list 接口本就给了 kind，此前丢弃 → 下游无法识别 ASR 轨。
      // vss_id 该接口不提供，按 YouTube 命名规则重建（ASR 为 'a.xx'，手动轨为 '.xx'）。
      kind: kind,
      vss_id: (kind === 'asr' ? 'a.' : '.') + langCode
    });
  }
  return tracks;
}

/**
 * 从页面获取 YouTube 字幕轨道列表（路径0 + 三路兜底 + 轮询等待）
 * 反思（2026-07-03）：用户再次反馈"youtube中找不到字幕，videoseek能找到"。
 *   路径0 方法正确（与 videoseek 同源），但 SPA 导航后 ytd-player 重建，
 *   player_ 可能在调用时未就绪，一次性调用必失败。videoseek 持续监听 player
 *   就绪才拿到。修正：路径0 增加轮询等待 player 就绪（最多 8 秒，每 500ms），
 *   路径0 全部失败再走路径1-3。
 * @returns {Promise<Array<{baseUrl, languageCode, name}>|null>}
 */
async function getYouTubeCaptionTracks() {
  // 当前 videoId（从 URL 提取，SPA 导航后 URL 已更新）
  const videoId = location.search.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1]
    || location.pathname.match(/\/([A-Za-z0-9_-]{11})(?:[/?]|$)/)?.[1];
  console.log('[VocabRadar][youtube] getYouTubeCaptionTracks videoId=', videoId);

  // === 路径 0：YouTube 自身播放器对象的 getPlayerResponse()（与 videoseek 同源，最稳）===
  // 轮询等待 player 就绪：SPA 导航后 ytd-player 重建，player_ 延迟挂载。
  // 最多等 8 秒（16 次 × 500ms），命中即返回；超时再走路径1-3。
  const tryPath0 = () => {
    try {
      const isShort = location.pathname.includes('/shorts/');
      // 第一百五十七次：与 getYouTubePlayer 同款候选链——窄选择器在部分布局恒失败，
      // 白等 8 秒后才走兜底（轨道列表延迟＝"加载字幕轨道为空"观感来源之一）。
      const candidates = isShort
        ? ['#shorts-player', '#movie_player', 'div.html5-video-player']
        : ['ytd-player#ytd-player', '#movie_player', 'div.html5-video-player'];
      let player = null;
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const p = el.player_ || el;
        if (p && typeof p.getPlayerResponse === 'function') { player = p; break; }
      }
      const ready = isShort ? !!player : (player && typeof player.isReady === 'function' && player.isReady());
      if (ready && player && typeof player.getPlayerResponse === 'function') {
        const resp = player.getPlayerResponse();
        const respVideoId = resp?.videoDetails?.videoId;
        const tracks0 = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (tracks0 && tracks0.length) {
          if (respVideoId && videoId && respVideoId !== videoId) {
            return { skip: true, reason: 'videoId 不匹配 ' + respVideoId + ' vs ' + videoId };
          }
          return { tracks: tracks0.map((t) => ({
            // 反思（2026-07-03）：getPlayerResponse() 返回的 baseUrl 默认返回 JSON 格式，
            // parseYouTubeTimedText 只解析 XML → 解析为空数组（"虚空轨道"根因）。
            // ensureXmlFormat 仅补充 v 参数（不修改 fmt，签名 URL 修改 fmt 会失效）
            baseUrl: ensureXmlFormat(t.baseUrl, videoId),
            languageCode: t.languageCode,
            name: t.name?.simpleText || t.name?.runs?.[0]?.text || '',
            kind: t.kind || '',
            // 第一百三十三次：保留 vss_id——路径0 触发播放器时自动轨需 'a.xx' 原始标识
            // 第一百七十八次修 bug：getPlayerResponse() 的字段名是**驼峰 vssId**，
            // 旧代码只读下划线 t.vss_id → 恒为空串，"保留 vss_id"实际从未生效。
            vss_id: t.vssId || t.vss_id || ''
          })) };
        }
        return { skip: true, reason: '无 captionTracks' };
      }
      return null; // 未就绪，继续轮询
    } catch (e) {
      console.warn('[VocabRadar][youtube] 路径0 异常:', e);
      return null;
    }
  };

  for (let i = 0; i < 16; i++) {
    const r = tryPath0();
    if (r && r.tracks) {
      console.log('[VocabRadar][youtube] 路径0 命中(第' + (i + 1) + '次轮询): player_.getPlayerResponse() 轨道', r.tracks.map(t => t.languageCode).join(','));
      return r.tracks;
    }
    if (r && r.skip) {
      console.log('[VocabRadar][youtube] 路径0 ' + r.reason + '，停止轮询走兜底');
      break;
    }
    // 未就绪，等 500ms 再试
    if (i < 15) await new Promise((res) => setTimeout(res, 500));
  }
  console.log('[VocabRadar][youtube] 路径0 轮询超时/未命中，走路径1-3');

  // === 路径 1：页面 <script> 提取 ytInitialPlayerResponse ===
  // 仅首次全量加载有；SPA 导航后常拿不到，且需校验 videoId 防止拿旧视频数据
  try {
    const player = extractVarFromScripts('ytInitialPlayerResponse');
    const scriptVideoId = player?.videoDetails?.videoId;
    if (player?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
      if (scriptVideoId && videoId && scriptVideoId !== videoId) {
        console.log('[VocabRadar][youtube] 路径1 script videoId=' + scriptVideoId + ' 与当前 ' + videoId + ' 不匹配（SPA），跳过');
      } else {
        console.log('[VocabRadar][youtube] 路径1 命中: ytInitialPlayerResponse(script)');
        return player.captions.playerCaptionsTracklistRenderer.captionTracks.map((t) => ({
          baseUrl: ensureXmlFormat(t.baseUrl, videoId),
          languageCode: t.languageCode,
          name: t.name?.simpleText || t.name?.runs?.[0]?.text || '',
          // 第一百七十八次：路径1 此前丢了 kind/vss_id → 下游 triggerAndInterceptSubtitle
          // 拿不到轨道元数据，ASR 轨只能瞎拼 '.xx' 配置，setOption 不被接受。
          // 源数据字段名是驼峰 vssId（getPlayerResponse 原始形态），需转成下划线。
          kind: t.kind || '',
          vss_id: t.vssId || t.vss_id || ''
        }));
      }
    } else {
      console.log('[VocabRadar][youtube] 路径1 script 中无 captionTracks');
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] 路径1 extractVarFromScripts 异常', e);
  }

  // === 路径 2：innertube player API（动态 client）===
  // 从页面 ytcfg 提取 INNERTUBE_API_KEY / clientVersion，不再硬编码 2024 年旧值
  if (!videoId) {
    console.warn('[VocabRadar][youtube] 未取到 videoId，路径2/3 跳过');
    return null;
  }
  try {
    const cfg = extractYtcfg();
    const apiKey = cfg.apiKey || '';
    const clientVersion = cfg.clientVersion || '2.20240101.00.00';
    const url = 'https://www.youtube.com/youtubei/v1/player' + (apiKey ? '?key=' + apiKey : '');
    console.log('[VocabRadar][youtube] 路径2 innertube, videoId=' + videoId + ' clientVersion=' + clientVersion);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': clientVersion
      },
      credentials: 'omit',
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: clientVersion,
            hl: 'en',
            gl: 'US'
          }
        },
        videoId
      })
    });
    console.log('[VocabRadar][youtube] 路径2 innertube 响应:', res.status, res.statusText);
    if (res.ok) {
      const data = await res.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length) {
        console.log('[VocabRadar][youtube] 路径2 命中: innertube 轨道', tracks.map(t => t.languageCode).join(','));
        return tracks.map((t) => ({
          baseUrl: ensureXmlFormat(t.baseUrl, videoId),
          languageCode: t.languageCode,
          name: t.name?.simpleText || t.name?.runs?.[0]?.text || '',
          // 第一百七十八次：同路径1，补回 kind/vss_id（源为驼峰 vssId）
          kind: t.kind || '',
          vss_id: t.vssId || t.vss_id || ''
        }));
      }
      console.warn('[VocabRadar][youtube] 路径2 innertube 无 captionTracks');
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] 路径2 innertube 异常', e);
  }

  // === 路径 3：timedtext list 接口兜底 ===
  // 公开接口，返回所有可用轨道 XML，据此重建 baseUrl
  try {
    const listUrl = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&type=list`;
    console.log('[VocabRadar][youtube] 路径3 timedtext list:', listUrl);
    const res = await fetch(listUrl, { credentials: 'omit' });
    if (res.ok) {
      const xml = await res.text();
      const tracks = parseTimedTextListXml(xml, videoId);
      if (tracks.length > 0) {
        console.log('[VocabRadar][youtube] 路径3 命中: timedtext list 轨道', tracks.map(t => t.languageCode).join(','));
        return tracks;
      }
      console.warn('[VocabRadar][youtube] 路径3 timedtext list 返回 0 轨道（视频可能确实无字幕）');
    } else {
      console.warn('[VocabRadar][youtube] 路径3 timedtext list 响应:', res.status);
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] 路径3 timedtext list 异常', e);
  }

  return null;
}

/**
 * 获取 YouTube 字幕（返回所有轨道 + 默认轨道字幕）
 *
 * 默认轨道选择策略（2026-07-03 按用户确认调整）：
 *   1) 首选 learnLanguage（所学语言=目标语言）轨道，前缀匹配
 *   2) 无则取第一条非 meaningLanguage（释义语言）轨道（避免默认选母语字幕）
 *   3) 全失败则取第一条
 * 反思：旧版硬编码优先 en、回退非 zh，无视用户在 popup 改的源语言，
 * 导致"字幕轨道可选，默认首选目标语言"未生效。
 *
 * @param {string} [learnLanguage='en'] 所学语言（默认首选轨道）
 * @param {string} [meaningLanguage='zh'] 释义语言（回退时避开）
 * @returns {Promise<{tracks: Array, subtitles: Array|null, pickedIndex: number}|null>}
 */
export async function getYouTubeSubtitles(learnLanguage = 'en', meaningLanguage = 'zh') {
  console.log('[VocabRadar][youtube] 开始获取字幕, learnLanguage=' + learnLanguage + ' meaningLanguage=' + meaningLanguage);
  // 尽早注入页面主世界脚本，确保 YouTube 播放器的字幕请求能被拦截
  injectPageScript();
  console.log('[VocabRadar][youtube] 页面脚本注入完成, ready=', _pageScriptReady, '已有缓存=', _pageTimedtextCache.length, '条');
  const tracks = await getYouTubeCaptionTracks();
  // 第一百三十二次：页面四路全部落空时用 youtubei.js 免 PoToken 客户端补拉轨道列表
  // （此前直接 return null → 轨道下拉只剩 ASR，即"加载字幕轨道为空"）。
  let trackList = tracks;
  if (!trackList || trackList.length === 0) {
    console.warn('[VocabRadar][youtube] 页面轨道列表为空, 尝试 innertube 客户端补拉');
    const videoId2 = location.search.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1]
      || location.pathname.match(/\/([A-Za-z0-9_-]{11})(?:[/?]|$)/)?.[1];
    trackList = await fetchTrackListViaInnertube(videoId2);
    if (!trackList || trackList.length === 0) {
      console.warn('[VocabRadar][youtube] 字幕轨道列表为空（含 innertube 补拉）');
      return null;
    }
  }
  console.log('[VocabRadar][youtube] 所有字幕轨道:', trackList.map((t) => `${t.languageCode}=${t.name}`).join(', '));

  // 默认首选 learnLanguage 轨道；无则取非 meaningLanguage；再无则第一条
  // 第一百二十次：优先选择 ASR 自动字幕（kind=asr），无则按语言匹配
  let pickedIndex = trackList.findIndex((t) => t.kind === 'asr' && t.languageCode.startsWith(learnLanguage));
  if (pickedIndex < 0) {
    pickedIndex = trackList.findIndex((t) => t.languageCode.startsWith(learnLanguage));
  }
  if (pickedIndex < 0) {
    pickedIndex = trackList.findIndex((t) => !t.languageCode.startsWith(meaningLanguage));
  }
  if (pickedIndex < 0) pickedIndex = 0;
const picked = trackList[pickedIndex];
  console.log(`[VocabRadar][youtube] 默认选中轨道: ${picked.languageCode} (${picked.name}) kind=${picked.kind || '-'}`);

  // 调用 fetchYouTubeTrack 下载默认轨道（避免重复 XML/JSON 解析逻辑）
  const subtitles = await fetchYouTubeTrack(picked);
  return { tracks: trackList, subtitles, pickedIndex };
}
// 第一百二十三次自纠：此处原有上次会话遗留的两个孤立 '}'（ESM 解析失败），随修清除。

/**
 * 通过 service worker 代理下载字幕（绕过 content script 的 CORS 限制）
 * @param {string} url 字幕 URL
 * @returns {Promise<string|null>} 字幕内容
 */
async function fetchSubtitleViaServiceWorker(url) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FETCH_SUBTITLE', url }, (resp) => {
      if (resp && resp.ok && resp.text) {
        resolve(resp.text);
      } else {
        console.warn('[VocabRadar][youtube] service worker 代理失败:', resp?.error || 'no response');
        resolve(null);
      }
    });
  });
}

// === 第一百二十二次：YouTube PoToken 时代兜底（调研：docs 与 yt-dlp PO Token Guide / ytranscript / LuanRT youtubei.js）===
// 现象：captionTrack baseUrl 含 &exp=xpe 的视频，无 pot 参数的 timedtext 请求一律 HTTP 200 空体
//   （youtube-transcript-api issue #592、dev.to 2026-06 综述），即用户所见"轨道识别得到、加载空白"。
// 可行通道（均不需要 BotGuard PoToken）：
//   A) ANDROID 客户端 player API 返回的 timedtext URL——服务端/同源直接可用（ytranscript 实证策略，
//      对标 yt-dlp 客户端矩阵）；本项目在 youtube.com 同源内容脚本世界 fetch，携带 cookie。
//   B) InnerTube get_transcript（播放器"显示转录"面板数据，youtubei.js getTranscript()）。
// 会话惰性单例；retrieve_player:false（字幕/转录无需 decipher，免 base.js 拉取）。
// 简单熔断器：连续失败达到阈值后暂停一段时间，防止级联失败
const _circuitBreaker = {
  failures: 0,
  lastFailure: 0,
  threshold: 5,
  timeout: 30000, // 30秒冷却
  isOpen() {
    return this.failures >= this.threshold && (Date.now() - this.lastFailure) < this.timeout;
  },
  recordSuccess() {
    this.failures = 0;
  },
  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
  }
};

let _ytCaptionInnertube = null;
function getYtCaptionInnertube() {
  if (_circuitBreaker.isOpen()) {
    const waitTime = Math.ceil((_circuitBreaker.timeout - (Date.now() - _circuitBreaker.lastFailure)) / 1000);
    console.warn(`[VocabRadar][youtube] 熔断器开启，${Math.ceil((_circuitBreaker.timeout - (Date.now() - _circuitBreaker.lastFailure)) / 1000)}秒后重试`);
    return Promise.reject(new Error(`熔断器开启，${Math.ceil((_circuitBreaker.timeout - (Date.now() - _circuitBreaker.lastFailure)) / 1000)}秒后重试`));
  }
  if (!_ytCaptionInnertube) {
    _ytCaptionInnertube = (async () => {
      const mod = await import(chrome.runtime.getURL('src/lib/vendor/youtubei/web.bundle.min.js'));
      const { Innertube } = mod;
      return await Innertube.create({ retrieve_player: false });
    })().catch((e) => { _ytCaptionInnertube = null; throw e; });
  }
  return _ytCaptionInnertube;
}

/**
 * 记录成功/失败用于熔断器
 */
function recordInnertubeResult(success) {
  if (success) {
    _circuitBreaker.recordSuccess();
  } else {
    _circuitBreaker.recordFailure();
  }
}

/**
 * 第一百三十四次：youtubei 单例预热——vendor bundle import + Innertube.create 需数百 ms，
 * 与播放器加载并行做掉，消除"首取轨道时冷启动竞争→空结果、手动切轨（单例已热）才成功"。
 * 失败静默（真取轨时路径A/B 自会再试并把错误打进诊断日志）。
 */
export async function warmYouTubeCaptionInnertube() {
  try { await getYtCaptionInnertube(); } catch (e) {
    console.warn('[VocabRadar][youtube] youtubei 预热失败(不阻塞):', e && e.message || e);
  }
}

/**
 * 路径A（第一百二十二次）：ANDROID 客户端 captionTracks → 同源 fetch timedtext。
 * @param {string} videoId
 * @param {{languageCode:string, kind?:string}} prefer 原轨道语言/kind
 * @returns {Promise<Array<{start,end,text}>|null>}
 */
/**
 * 路径A（第一百二十二次）：ANDROID 客户端 captionTracks → 同源 fetch timedtext。
 * 第一百五十六次：增强重试机制和错误处理。
 * @param {string} videoId
 * @param {{languageCode:string, kind?:string}} prefer 原轨道语言/kind
 * @returns {Promise<Array<{start,end,text}>|null>}
 */
async function fetchTrackViaAndroidClient(videoId, prefer) {
  if (!videoId) return null;
  // 第一百二十四次：ANDROID 失败再试 IOS（对标 yt-dlp 客户端矩阵；两客户端均免 POT）
  // 第一百三十三次：追加 ANDROID_VR / TV_EMBEDDED——部分视频对 ANDROID/IOS 也收紧了
  // timedtext（"en 自动生成轨仍空"），yt-dlp 2025+ 矩阵中此两客户端常仍放行。
  // 第一百五十七次：增加重试机制和错误分类
  // 第一百六十二次：过滤 exp=xpe 轨道，尝试多个轨道，增加客户端类型
  const CLIENTS = ['ANDROID', 'IOS', 'ANDROID_VR', 'TV_EMBEDDED', 'WEB', 'MWEB', 'WEB_EMBEDDED', 'TV'];
  const MAX_RETRIES = 3;
  const BASE_DELAY = 500;

  for (const clientName of CLIENTS) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const sub = await __fetchTrackViaInnertubeClient(videoId, prefer, clientName);
        if (sub) return sub;
      } catch (e) {
        const msgStr = (e && e.message) || String(e);
        const isRetryable = /network|timeout|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|503|502|504|429/i.test(msgStr);
        const isAuthError = /401|403|unauthorized|forbidden/i.test(msgStr);
        const isNotFound = /404|not found/i.test(msgStr);

        if (attempt < 3 && (isRetryable || !isAuthError && !isNotFound)) {
          const delay = 500 * Math.pow(2, attempt - 1) + Math.random() * 100;
          console.log(`[VocabRadar][youtube] 路径A[${clientName}] 第${attempt}次尝试失败，${delay}ms后重试:`, msgStr.slice(0, 100));
          await new Promise(r => setTimeout(r, delay));
          continue;
        } else {
          console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 最终失败:', msgStr);
          break;
        }
      }
    }
  }
  return null;
}

async function __fetchTrackViaInnertubeClient(videoId, prefer, clientName) {
  try {
    const yt = await getYtCaptionInnertube();
    const info = await yt.getBasicInfo(videoId, clientName);
    // youtubei.js 各版本字段形态不同，逐层探测（raw snake_case 优先）
    const ctr = info?.captions?.playerCaptionsTracklistRenderer;
    const tracks = info?.captions?.caption_tracks
      || ctr?.caption_tracks || ctr?.captionTracks
      || info?.page?.[0]?.captions?.playerCaptionsTracklistRenderer?.caption_tracks
      || [];
    // 诊断：把探测到的形态与数量打出来，空轨道时可直接归因
    console.log('[VocabRadar][youtube] 路径A[' + clientName + '] 探测: captions=' + (info?.captions ? Object.keys(info.captions).join('|') : 'null')
      + ' 轨道数=' + tracks.length
      + (tracks.length ? (' [' + tracks.slice(0, 4).map((t) => (t.languageCode || t.language_code || '?') + '/' + (t.kind || '-')).join(', ') + ']') : ''));
    if (!tracks.length) { console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 无 captionTracks'); return null; }
    // 按原轨道语言匹配，优先同 kind（asr）
    let pool = tracks;
    if (prefer && prefer.languageCode) {
      const m = tracks.filter((t) => String(t.languageCode || t.language_code || '').startsWith(prefer.languageCode));
      if (m.length) pool = m;
    }
    if (prefer && prefer.kind) {
      const m = pool.filter((t) => String(t.kind || '') === prefer.kind);
      if (m.length) pool = m;
    }
    const ct = pool[0];
    let url = ct.base_url || ct.baseUrl || '';
    if (!url) { console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 轨道缺 baseUrl'); return null; }
    if (!/[?&]fmt=/.test(url)) url += '&fmt=json3';
    console.log('[VocabRadar][youtube] 路径A[' + clientName + '] timedtext, lang=', ct.languageCode || ct.language_code);
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) { console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 响应:', res.status); return null; }
    const text = await res.text();
    if (!text.length) { console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 空响应'); return null; }
    const parsed = parseSubtitleContent(text, /json/i.test(res.headers.get('content-type') || '') || text.trim().startsWith('{') ? 'application/json' : 'application/xml');
    if (parsed && parsed.length > 0) { console.log('[VocabRadar][youtube] 路径A[' + clientName + '] 解析:', parsed.length, '条'); return parsed; }
    console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 解析为空');
  } catch (e) {
    const msgStr = (e && e.message) || String(e);
    const isRetryable = /network|timeout|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|503|502|504|429/i.test(msgStr);
    const isAuthError = /401|403|unauthorized|forbidden/i.test(msgStr);
    const isNotFound = /404|not found/i.test(msgStr);
    const isParserError = /Parser|not found/i.test(msgStr);

    if (isParserError) {
      console.log(`[VocabRadar][youtube] 路径A[${clientName}] 已知解析缺口(跳过):`, msgStr.slice(0, 80));
    } else if (isRetryable) {
      console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 网络错误(可重试):', msgStr);
    } else if (isAuthError || isNotFound) {
      console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 认证/未找到错误(不重试):', msgStr);
    } else {
      console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 异常:', msgStr);
    }
  }
  return null;
}

/**
 * 第一百六十次：过滤掉需要 PoToken 的轨道 (exp=xpe)
 * 这些轨道需要 PoToken，无法直接获取
 */
// 修复（2026-08-27）：块体箭头函数缺收尾 ")" 导致整模块 SyntaxError
function filterTracksWithoutPoToken(tracks) {
  return tracks.filter(t => {
    const url = t.base_url || t.baseUrl || '';
    return !/exp=xpe/i.test(url);
  });
}

/**
 * 尝试多个轨道获取字幕，直到成功或耗尽
 */
async function tryFetchSubtitlesFromTracks(tracks, prefer, clientName) {
  if (!tracks || !tracks.length) return null;
  
  // 优先尝试匹配语言和 kind 的轨道
  let candidates = tracks;
  if (prefer && prefer.languageCode) {
    const filtered = tracks.filter(t => 
      String(t.languageCode || t.language_code || '').startsWith(prefer.languageCode)
    );
    if (filtered.length > 0) candidates = filtered;
  }
  
  // 过滤掉需要 PoToken 的轨道（修复：base 为未定义变量，应为 url）
  const filteredTracks = candidates.filter(t => {
    const url = t.base_url || t.baseUrl || '';
    return !/exp=xpe/i.test(url);
  });
  
  if (!filteredTracks.length) {
    console.warn('[VocabRadar][youtube] 所有轨道都包含 exp=xpe，无法直接获取');
    return null;
  }
  
  // 尝试每个候选轨道（修复：应遍历过滤后的 filteredTracks，否则 PoToken 过滤无效）
  for (const ct of filteredTracks) {
    let url = ct.base_url || ct.baseUrl || '';
    if (!url) continue;
    if (!/[?&]fmt=/.test(url)) url += '&fmt=json3';
    
    try {
      console.log('[VocabRadar][youtube] 尝试获取字幕:', ct.languageCode || ct.language_code, 'kind:', ct.kind || '-');
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) {
        console.warn('[VocabRadar][youtube] 字幕请求失败:', res.status);
        continue;
      }
      const text = await res.text();
      if (!text.length) {
        console.warn('[VocabRadar][youtube] 空响应');
        continue;
      }
      const parsed = parseSubtitleContent(text, /json/i.test(res.headers.get('content-type') || '') || text.trim().startsWith('{') ? 'application/json' : 'application/xml');
      if (parsed && parsed.length > 0) {
        console.log('[VocabRadar][youtube] 成功获取字幕:', parsed.length, '条');
        return parsed;
      }
      console.warn('[VocabRadar][youtube] 解析为空');
    } catch (e) {
      console.warn('[VocabRadar][youtube] 单轨道获取失败:', e.message);
    }
  }
  return null;
}

/**
 * 第一百三十二次：轨道列表补拉——页面四路（player对象/script/innertube-WEB/timedtext list）
 * 全部落空时（SPA 导航早期、播放器接口变更、consent 拦截等），用 youtubei.js 免 PoToken
 * 客户端（ANDROID→IOS）拉 captionTracks 重建轨道列表。与路径A 同一客户端矩阵、同一单例。
 * 用户反馈"加载字幕轨道为空"（下拉只剩 ASR）即列表源全空的直接表现。
 * @param {string} videoId
 * @returns {Promise<Array<{baseUrl,languageCode,name,kind}>|null>}
 */
async function fetchTrackListViaInnertube(videoId) {
  if (!videoId) return null;
  // 第一百三十三次：客户端矩阵与路径A 对齐（ANDROID→IOS→ANDROID_VR→TV_EMBEDDED）
  const CLIENTS = ['ANDROID', 'IOS', 'ANDROID_VR', 'TV_EMBEDDED'];
  for (const clientName of CLIENTS) {
    try {
      const yt = await getYtCaptionInnertube();
      const info = await yt.getBasicInfo(videoId, clientName);
      const ctr = info?.captions?.playerCaptionsTracklistRenderer;
      const raw = info?.captions?.caption_tracks
        || ctr?.caption_tracks || ctr?.captionTracks
        || info?.page?.[0]?.captions?.playerCaptionsTracklistRenderer?.caption_tracks
        || [];
      console.log('[VocabRadar][youtube] 轨道列表补拉[' + clientName + ']: 原始轨道数=' + raw.length);
      if (!raw.length) continue;
      // 统一映射为页面轨道同构：baseUrl 补 v 参数（ensureXmlFormat），name 兼容 string/simpleText/runs
      const seen = new Set();
      const tracks = [];
      for (const t of raw) {
        const base = t.base_url || t.baseUrl || '';
        if (!base) continue;
        const lang = String(t.languageCode || t.language_code || '');
        const kind = String(t.kind || '');
        const name = (typeof t.name === 'string' && t.name)
          || t.name?.simpleText
          || t.name?.runs?.[0]?.text
          || (kind === 'asr' ? '(auto-generated)' : '')
          || lang;
        const key = lang + '|' + kind + '|' + name;
        if (seen.has(key)) continue;
        seen.add(key);
        tracks.push({
          baseUrl: ensureXmlFormat(base, videoId),
          languageCode: lang,
          name,
          kind,
          // 第一百七十八次：补 vss_id（源可能是驼峰 vssId 或下划线；都缺则按规则重建）
          vss_id: t.vssId || t.vss_id || ((kind === 'asr' ? 'a.' : '.') + lang)
        });
      }
      if (tracks.length > 0) {
        console.log('[VocabRadar][youtube] 轨道列表补拉[' + clientName + '] 命中:',
          tracks.map((t) => t.languageCode + '/' + (t.kind || '-')).join(', '));
        return tracks;
      }
    } catch (e) {
      console.warn('[VocabRadar][youtube] 轨道列表补拉[' + clientName + '] 异常:', e.message || e);
    }
  }
  return null;
}

/**
 * 路径B（第一百五十八次）：InnerTube get_transcript（"显示转录"面板，无需 PoToken）。
 * 增强重试机制和错误处理。
 * 深度遍历 TranscriptInfo 收集 TranscriptSegment（跨 youtubei.js 版本字段差异稳健）。
 * @param {string} videoId
 * @returns {Promise<Array<{start,end,text}>|null>}
 */
async function fetchTrackViaGetTranscript(videoId) {
  if (!videoId) return null;
  const MAX_RETRIES = 3;
  const BASE_DELAY = 500;
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const yt = await getYtCaptionInnertube();
      const info = await yt.getInfo(videoId);
      const ti = await info.getTranscript();
      // 诊断：可用语言与当前选中语言（空段落时可直接归因）
      try {
        console.log('[VocabRadar][youtube] 路径B transcript 语言: 选中=', (ti && ti.selectedLanguage) || '?',
          ' 可用=', (ti && ti.languages || []).slice(0, 6).join(' / '));
      } catch (_) { /* ignore */ }
      const segs = [];
      const collect = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 8) return;
        if (Array.isArray(node)) { for (const n of node) collect(n, depth + 1); return; }
        if (node.type === 'TranscriptSegment') {
          const startMs = Number(node.start_ms) || 0;
          const endMs = Number(node.end_ms) || startMs + 3000;
          const text = node.snippet != null ? String(node.snippet) : '';
          if (text.trim()) segs.push({ startMs, endMs, text: text.trim() });
          return;
        }
        for (const k of Object.keys(node)) {
          if (k === 'actions' || k === 'session' || k === 'page') continue;
          try { collect(node[k], depth + 1); } catch (_) { /* 循环引用防御 */ }
        }
      };
      collect(ti.transcript && ti.transcript.content, 0);
      if (!segs.length) { console.warn('[VocabRadar][youtube] 路径B get_transcript 无段落'); return null; }
      segs.sort((a, b) => a.startMs - b.startMs);
      const subs = segs.map((s) => ({ start: s.startMs / 1000, end: s.endMs / 1000, text: s.text }));
      console.log('[VocabRadar][youtube] 路径B get_transcript:', subs.length, '条, 语言=', ti.selectedLanguage || '(默认)');
      return subs;
    } catch (e) {
      const msgStr = (e && e.message) || String(e);
      const isRetryable = /network|timeout|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|503|502|504|429/i.test(msgStr);
      const isAuthError = /401|403|unauthorized|forbidden/i.test(msgStr);
      const isNotFound = /404|not found/i.test(msgStr);
      
      if (attempt < 3 && /network|timeout|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|503|502|504|429/i.test(msgStr)) {
        const delay = 500 * Math.pow(2, attempt - 1) + Math.random() * 100;
        console.log(`[VocabRadar][youtube] 路径B 第${attempt}次尝试失败，${Math.round(500 * Math.pow(2, attempt - 1))}ms后重试:`, msgStr.slice(0, 100));
        await new Promise(r => setTimeout(r, delay));
        continue;
      } else {
        console.warn('[VocabRadar][youtube] 路径B get_transcript 异常:', e.message || e);
        break;
      }
    }
  }
  return null;
}

/**
 * 通过 innertube API（WEB_EMBEDDED_PLAYER 客户端）获取全新的字幕 baseUrl。
 *
 * 反思（2026-07-03）：getPlayerResponse() / ytInitialPlayerResponse 返回的 baseUrl
 *   签名绑定了播放器会话上下文，content script 直接 fetch 该 URL 返回 0 字节。
 *   innertube API 用 WEB_EMBEDDED_PLAYER 客户端请求，返回的 baseUrl 签名不绑定
 *   会话上下文，可直接 fetch 成功。
 *
 * @param {string} videoId 视频 ID
 * @returns {Promise<string|null>} 全新的 baseUrl
 */
async function getFreshCaptionBaseUrl(videoId, preferLang, preferKind) {
  if (!videoId) return null;
  try {
    // 从页面 ytcfg 提取 INNERTUBE_API_KEY
    const cfg = extractYtcfg();
    const apiKey = cfg.apiKey || '';
    const url = 'https://www.youtube.com/youtubei/v1/player' + (apiKey ? '?key=' + apiKey : '');
    console.log('[VocabRadar][youtube] innertube WEB_EMBEDDED_PLAYER 请求: videoId=' + videoId);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'WEB_EMBEDDED_PLAYER',
            clientVersion: '1.20241009.01.00'
          }
        }
      })
    });

    if (!res.ok) {
      console.warn('[VocabRadar][youtube] innertube WEB_EMBEDDED_PLAYER 响应:', res.status);
      return null;
    }

    const data = await res.json();
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) {
      console.warn('[VocabRadar][youtube] innertube WEB_EMBEDDED_PLAYER 无 captionTracks');
      return null;
    }

    // 第一百二十次：不再盲取第一条——按原轨道语言匹配（ASR 自动字幕时优先同 kind）。
    let pool = tracks;
    if (preferLang) {
      const langMatch = tracks.filter((t) => String(t.languageCode || '').startsWith(preferLang));
      if (langMatch.length > 0) pool = langMatch;
    }
    if (preferKind) {
      const kindMatch = pool.filter((t) => String(t.kind || '') === preferKind);
      if (kindMatch.length > 0) pool = kindMatch;
    }
    const baseUrl = pool[0].baseUrl;
    console.log('[VocabRadar][youtube] innertube 获取 baseUrl 成功, lang=', pool[0].languageCode, 'kind=', pool[0].kind || '-', 'url长度=', baseUrl.length);
    return baseUrl;
  } catch (e) {
    console.warn('[VocabRadar][youtube] innertube WEB_EMBEDDED_PLAYER 异常:', e.message || e);
    return null;
  }
}

/**
 * 在 baseUrl 上设置 fmt=json3，构造 JSON3 格式下载 URL。
 * fmt 不在 sparams 签名参数列表中，添加 fmt 不会破坏签名。
 * @param {string} baseUrl 原始 baseUrl
 * @param {string} lang 目标语言
 * @returns {string} 带 fmt=json3 的 URL
 */
function buildJson3Url(baseUrl, lang) {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set('fmt', 'json3');
    // 如果 URL 的 lang 与目标语言不同，设置 tlang 做翻译
    const currentLang = u.searchParams.get('lang');
    if (currentLang && currentLang !== lang) {
      u.searchParams.set('tlang', lang);
    }
    return u.toString();
  } catch {
    return baseUrl;
  }
}

/**
 * 在 baseUrl 上删除 fmt 参数，构造 XML（transcript）格式下载 URL。
 * 不带 fmt 时 YouTube 返回默认 XML 格式。
 * @param {string} baseUrl 原始 baseUrl
 * @returns {string} 不带 fmt 的 URL
 */
function buildTranscriptUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    u.searchParams.delete('fmt');
    return u.toString();
  } catch {
    return baseUrl;
  }
}

/**
 * 下载指定 YouTube 字幕轨道。
 *
 * 下载策略（2026-07-03 第六次修正）：
 *   0) 页面主世界拦截：检查缓存 + 用播放器 API 触发 YouTube 请求字幕，拦截响应
 *   1) 页面主世界 fetch 原始 baseUrl（核心路径！页面上下文 fetch 不受签名绑定限制）
 *   2) 页面主世界 fetch baseUrl + fmt=json3
 *   3) Content Script 直接 fetch（可能返回 0 字节，保留兜底）
 *   4) innertube WEB_EMBEDDED_PLAYER + fmt=json3（innertube 可能返回 0 轨道，保留兜底）
 *   A) ANDROID 客户端 captionTracks timedtext（第一百二十二次，无需 PoToken）
 *   B) get_transcript 面板数据（第一百二十二次，无需 PoToken）
 *   5) service worker 代理（SW 不受 CORS 限制）
 *
 * 反思：v1-v5 的根本性错误是在 Content Script 隔离世界中操作。
 *   Content Script 与页面主世界 JavaScript 上下文隔离：
 *   - 猴子补丁 XMLHttpRequest 仅影响 CS 自身，无法拦截播放器 XHR
 *   - CS 的 fetch 虽带同源 cookie，但签名绑定播放器会话（Sec-Fetch-* 头等），
 *     YouTube 返回 0 字节
 *   正确方案：注入 page-fetch.js 到页面主世界，在页面上下文中 fetch 和拦截 XHR。
 *
 * @param {Object} track {baseUrl, languageCode, name}
 * @returns {Promise<Array<{start, end, text}>|null>}
 */
/**
 * 下载指定 YouTube 字幕轨道。
 * 下载策略（2026-07-03 第六次修正）：
 *   0) 页面主世界拦截：检查缓存 + 用播放器 API 触发 YouTube 请求字幕，拦截响应
 *   1) 页面主世界 fetch 原始 baseUrl（核心路径！页面上下文 fetch 不受签名绑定限制）
 *   2) 页面主世界 fetch baseUrl + fmt=json3
 *   3) Content Script 直接 fetch（可能返回 0 字节，保留兜底）
 *   4) innertube WEB_EMBEDDED_PLAYER + fmt=json3（innertube 可能返回 0 轨道，保留兜底）
 *   5) service worker 代理（SW 不受 CORS 限制）
 *
 * 反思：v1-v5 的根本性错误是在 Content Script 隔离世界中操作。
 *   Content Script 与页面主世界 JavaScript 上下文隔离：
 *   - 猴子补丁 XMLHttpRequest 仅影响 CS 自身，无法拦截播放器 XHR
 *   - CS 的 fetch 虽带同源 cookie，但签名绑定播放器会话（Sec-Fetch-* 头等），
 *     YouTube 返回 0 字节
 *   正确方案：注入 page-fetch.js 到页面主世界，在页面上下文中 fetch 和拦截 XHR。
 *
 * @param {Object} track {baseUrl, languageCode, name}
 * @returns {Promise<Array<{start, end, text}>|null>}
 */
export async function fetchYouTubeTrack(track) {
  if (!track || !track.baseUrl) return null;
  console.log('[VocabRadar][youtube] fetchYouTubeTrack:', track.languageCode, 'url=', track.baseUrl);

  // 获取当前 videoId
  const videoId = location.search.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1]
    || location.pathname.match(/\/([A-Za-z0-9_-]{11})(?:[/?]|$)/)?.[1];

  // === 第一百二十二次：PoToken 需求探测 ===
  // baseUrl 含 exp=xpe ⇒ timedtext 必须 &pot=（BotGuard 运行时生成，扩展无法伪造），
  // 路径1/2/3/5 全部注定空 200——直接跳过省数秒等待，走路径0（播放器自带 pot）与 A/B 兜底。
  const needsPot = /exp=xpe/.test(track.baseUrl);
  if (needsPot) console.warn('[VocabRadar][youtube] 轨道带 exp=xpe（需 PoToken），跳过直连 timedtext 渠道');

  // === 路径 0：页面主世界拦截（检查缓存 + 触发播放器请求）===
  try {
    console.log('[VocabRadar][youtube] 路径0 页面拦截: 开始尝试, lang=', track.languageCode, 'kind=', track.kind || '-', 'videoId=', videoId);
    // 第一百三十三次：把原轨道 kind/vss_id 带进播放器触发配置（自动生成轨必需）
    const interceptResp = await triggerAndInterceptSubtitle(track.languageCode, videoId, 8, { kind: track.kind || '', vss_id: track.vss_id || '' });
    if (interceptResp) {
      console.log('[VocabRadar][youtube] 路径0 页面拦截成功, resp长度=', interceptResp.length);
      const parsed = parseSubtitleContent(interceptResp, '');
      if (parsed && parsed.length > 0) {
        console.log('[VocabRadar][youtube] 路径0 页面拦截解析:', parsed.length, '条');
        return parsed;
      }
      console.warn('[VocabRadar][youtube] 路径0 页面拦截响应解析为空, 前200字符:', interceptResp.slice(0, 200));
    } else {
      console.warn('[VocabRadar][youtube] 路径0 页面拦截: 响应为 null, 尝试其他方式');
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] 路径0 页面拦截异常:', e.message || e);
  }

  // === 路径 1：页面主世界 fetch 原始 baseUrl（核心路径！）===
  // 页面上下文的 fetch 请求与播放器自身请求一致，能绕过签名绑定会话的限制
  if (!needsPot) try {
    console.log('[VocabRadar][youtube] 路径1 页面fetch, url=', track.baseUrl.slice(0, 120));
    const pageResp = await fetchViaPageContext(track.baseUrl);
    if (pageResp && pageResp.ok && pageResp.text && pageResp.text.length > 0) {
      console.log('[VocabRadar][youtube] 路径1 页面fetch成功, status=', pageResp.status, 'content-type=', pageResp.contentType, '长度=', pageResp.text.length);
      const parsed = parseSubtitleContent(pageResp.text, pageResp.contentType || '');
      if (parsed && parsed.length > 0) {
        console.log('[VocabRadar][youtube] 路径1 页面fetch解析:', parsed.length, '条');
        return parsed;
      }
      console.warn('[VocabRadar][youtube] 路径1 页面fetch解析为空, 前200字符:', pageResp.text.slice(0, 200));
    } else {
      console.warn('[VocabRadar][youtube] 路径1 页面fetch失败:', pageResp?.ok ? '内容为空' : (pageResp?.error || '无响应'));
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] 路径1 页面fetch异常:', e.message || e);
  }

  // === 路径 2：页面主世界 fetch baseUrl + fmt=json3 ===
  if (!needsPot) try {
    const json3Url = buildJson3Url(track.baseUrl, track.languageCode);
    console.log('[VocabRadar][youtube] 路径2 页面fetch json3, url长度=', json3Url.length);
    const pageResp = await fetchViaPageContext(json3Url);
    if (pageResp && pageResp.ok && pageResp.text && pageResp.text.length > 0) {
      console.log('[VocabRadar][youtube] 路径2 页面fetch json3成功, 长度=', pageResp.text.length);
      const parsed = parseSubtitleContent(pageResp.text, pageResp.contentType || 'application/json');
      if (parsed && parsed.length > 0) {
        console.log('[VocabRadar][youtube] 路径2 页面fetch json3解析:', parsed.length, '条');
        return parsed;
      }
      console.warn('[VocabRadar][youtube] 路径2 页面fetch json3解析为空, 前200字符:', pageResp.text.slice(0, 200));
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] 路径2 页面fetch json3异常:', e.message || e);
  }

  // === 路径 3：Content Script 直接 fetch（可能返回 0 字节，保留兜底）===
  let text = null;
  let contentType = '';

  if (!needsPot) try {
    console.log('[VocabRadar][youtube] 路径3 CS直接下载, url=', track.baseUrl.slice(0, 120));
    const res = await fetch(track.baseUrl, { credentials: 'same-origin' });
    console.log('[VocabRadar][youtube] 路径3 CS直接下载响应:', res.status, res.statusText, 'content-length=', res.headers.get('content-length'));
    if (res.ok) {
      contentType = res.headers.get('content-type') || '';
      text = await res.text();
      console.log('[VocabRadar][youtube] 路径3 CS直接下载成功, content-type:', contentType, '长度:', text.length);
      if (text.length < 1000) {
        console.log('[VocabRadar][youtube] 路径3 响应内容:', text);
      }
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] 路径3 CS直接下载异常:', e.message || e);
  }

  // 如果路径3拿到有效内容，解析返回
  if (text && text.length > 0) {
    const parsed = parseSubtitleContent(text, contentType);
    if (parsed && parsed.length > 0) return parsed;
    console.warn('[VocabRadar][youtube] 路径3 解析为空，继续尝试');
  }

  // === 路径 4：innertube WEB_EMBEDDED_PLAYER + fmt=json3（第一百一十三次：按原轨道语言/kind 匹配）===
  // 第一百三十二次：exp=xpe 轨道同样跳过本路径——WEB_EMBEDDED_PLAYER 返回的 baseUrl
  // 同样不带 pot，请求注定空 200，白耗数秒后才轮到免 POT 的 A/B 通道。
  let freshBaseUrl = null;
  if (needsPot) {
    console.warn('[VocabRadar][youtube] 路径4 跳过（exp=xpe 需 PoToken，直取 A/B 免 POT 通道）');
  } else {
    freshBaseUrl = await getFreshCaptionBaseUrl(videoId, track.languageCode, track.kind || '');
  }
  if (freshBaseUrl) {
    const json3Url = buildJson3Url(freshBaseUrl, track.languageCode);
    console.log('[VocabRadar][youtube] 路径4 json3 URL 构造完成, url长度=', json3Url.length);
    try {
      const res = await fetch(json3Url, { method: 'GET' });
      console.log('[VocabRadar][youtube] 路径4 json3 下载响应:', res.status, res.statusText, 'content-length=', res.headers.get('content-length'));
      if (res.ok) {
        const json3Text = await res.text();
        console.log('[VocabRadar][youtube] 路径4 json3 下载成功, 长度:', json3Text.length);
        if (json3Text.length > 0) {
          const parsed = parseSubtitleContent(json3Text, 'application/json');
          if (parsed && parsed.length > 0) {
            console.log('[VocabRadar][youtube] 路径4 json3 解析:', parsed.length, '条');
            return parsed;
          }
          console.warn('[VocabRadar][youtube] 路径4 json3 解析为空, 前200字符:', json3Text.slice(0, 200));
        } else {
          console.warn('[VocabRadar][youtube] 路径4 json3 返回 0 字节');
        }
      }
    } catch (e) {
      console.warn('[VocabRadar][youtube] 路径4 json3 下载异常:', e.message || e);
    }

    // === 路径 4b：innertube baseUrl 删 fmt（XML transcript 格式）===
    console.log('[VocabRadar][youtube] 路径4b transcript XML 格式');
    const transcriptUrl = buildTranscriptUrl(freshBaseUrl);
    try {
      const res = await fetch(transcriptUrl, { method: 'GET' });
      console.log('[VocabRadar][youtube] 路径4b transcript 下载响应:', res.status, res.statusText, 'content-length=', res.headers.get('content-length'));
      if (res.ok) {
        const xmlText = await res.text();
        console.log('[VocabRadar][youtube] 路径4b transcript 下载成功, 长度:', xmlText.length);
        if (xmlText.length > 0) {
          const parsed = parseSubtitleContent(xmlText, 'application/xml');
          if (parsed && parsed.length > 0) {
            console.log('[VocabRadar][youtube] 路径4b transcript 解析:', parsed.length, '条');
            return parsed;
          }
          console.warn('[VocabRadar][youtube] 路径4b transcript 解析为空, 前200字符:', xmlText.slice(0, 200));
        } else {
          console.warn('[VocabRadar][youtube] 路径4b transcript 返回 0 字节');
        }
      }
    } catch (e) {
      console.warn('[VocabRadar][youtube] 路径4b transcript 下载异常:', e.message || e);
    }
  } else {
    console.warn('[VocabRadar][youtube] 路径4 innertube 获取 baseUrl 失败，跳过');
  }

  // === 路径 A（第一百二十二次）：ANDROID 客户端 timedtext（无需 PoToken）===
  // 第一百三十二次：不再以"路径3 是否拿到内容"为前置条件——xpe 轨道 text 恒为空，
  // 旧条件恰好把 A 通道挡在门外（空轨道加载的帮凶之一）。
  {
    const viaAndroid = await fetchTrackViaAndroidClient(videoId, { languageCode: track.languageCode, kind: track.kind || '' });
    if (viaAndroid && viaAndroid.length > 0) return viaAndroid;
  }

  // === 路径 B（第一百二十二次）：get_transcript 面板数据（无需 PoToken）===
  const viaTranscript = await fetchTrackViaGetTranscript(videoId);
  if (viaTranscript && viaTranscript.length > 0) return viaTranscript;

  // === 路径 5：service worker 代理 ===
  console.log('[VocabRadar][youtube] 路径5 service worker 代理');
  text = await fetchSubtitleViaServiceWorker(track.baseUrl);
  if (text) {
    contentType = text.trim().startsWith('<') ? 'application/xml' : 'application/json';
    console.log('[VocabRadar][youtube] 路径5 SW代理下载成功, 推断类型:', contentType, '长度:', text.length);
    if (text.length < 500) {
      console.log('[VocabRadar][youtube] 路径5 SW响应内容:', text);
    }
    const parsed = parseSubtitleContent(text, contentType);
    if (parsed && parsed.length > 0) return parsed;
  }

  // === 全部失败：汇总诊断行（第一百二十四次）——把关键探测结果集中一行，便于贴日志定位
  console.error('[VocabRadar][youtube] 所有下载渠道均失败 | lang=' + (track.languageCode || '?')
    + ' kind=' + (track.kind || '-')
    + ' exp=xpe=' + needsPot
    + ' videoId=' + (videoId || '?'));
  return null;
}

// === 工具：从页面 <script> 标签文本提取变量 ===

/**
 * 从 text 中下标 start 处（应为 '{'）开始，按花括号配对提取一个完整的 JSON 对象字符串。
 * 正确处理字符串字面量内的花括号与反斜杠转义，避免在 JSON 字符串里误判层级。
 * @param {string} text
 * @param {number} start '{' 的下标
 * @returns {string|null} 完整的 {...} 字符串，失败返回 null
 */
function extractBalancedJson(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 遍历页面所有 <script> 标签的 textContent，正则定位 varName 赋值语句，
 * 用花括号配对提取并 JSON.parse 出对应对象。
 *
 * 仅读取脚本文本、不执行任何脚本，不违反页面 CSP（与原 getPageVar 注入 inline
 * script 的方式相比，避免了被 script-src 拒绝的问题）。
 *
 * 适用前提：目标变量在页面 HTML 中以对象字面量形式赋值，且为合法 JSON
 * （YouTube 的 ytInitialPlayerResponse 满足；B站 __INITIAL_STATE__ 含 undefined
 * 等非合法 JSON，不适用，B站改走 view API）。
 * @param {string} varName
 * @returns {any|null}
 */
function extractVarFromScripts(varName) {
  const scripts = document.getElementsByTagName('script');
  // 匹配 varName = / var varName = / window.varName = / window["varName"] = 形式
  const re = new RegExp(
    `(?:var\\s+|window\\["${varName}"\\]\\s*=\\s*|window\\.${varName}\\s*=\\s*|)${varName}\\s*=\\s*`
  );
  for (const s of scripts) {
    const text = s.textContent || '';
    if (!text.includes(varName)) continue;
    const m = text.match(re);
    if (!m) continue;
    const braceStart = text.indexOf('{', m.index + m[0].length);
    if (braceStart === -1) continue;
    const jsonStr = extractBalancedJson(text, braceStart);
    if (!jsonStr) continue;
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      // 当前 script 不匹配，继续尝试下一个（可能有多个同名片段）
    }
  }
  return null;
}
