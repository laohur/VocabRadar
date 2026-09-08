/**
 * page-fetch.js — 页面主世界注入脚本
 *
 * 作用：此脚本在页面主世界执行，在页面上下文中执行 fetch 请求并拦截 XHR/fetch。
 *
 * 注入方式（第一百七十八次改为双轨）：
 *   1. Chrome/Edge：data/manifest.json 中以声明式 content_script 注入
 *      （"world": "MAIN" + "run_at": "document_start"）。这是**决定性**的一环：
 *      借鉴 VideoSeek（ytIndex 以 world:MAIN + document_start 注册，模块顶层立刻
 *      YoutubeInjectHelper.initInject()），拦截补丁必须在 YouTube 播放器自身脚本
 *      之前就位，播放器自己请求的每条 /api/timedtext 才会被记下。
 *      旧实现是**懒注入**（用户点取字幕时才 <script src> 注入），此时播放器早已
 *      发完请求，补丁装上等于空网；而播放器对已加载轨道不会重复请求 → 白等 8 秒。
 *   2. Firefox：MV3 不支持 content_scripts[].world="MAIN"，build.mjs 会剥离该条；
 *      仍走 youtube-fetcher.js injectPageScript() 的 <script src> 懒注入路径。
 *   两条路径并存时靠 window.__beaverPageFetchInjected 去重，只装一次补丁。
 *
 * 为什么需要注入到页面主世界：
 *   Content Script 运行在隔离世界中，虽然能共享 DOM，但 JavaScript 上下文隔离。
 *   1. Content Script 的 fetch 请求虽然带同源 cookie，但 YouTube 的 timedtext URL
 *      签名绑定播放器会话上下文（可能涉及 Sec-Fetch-* 头、浏览器内部状态等），
 *      从 Content Script 发出的 fetch 返回 0 字节（HTTP 200 content-length:0）。
 *   2. 从页面主世界发出的 fetch 请求与 YouTube 播放器自身发出的请求完全一致，
 *      能正常获取字幕数据。
 *   3. Content Script 无法拦截页面主世界的 XMLHttpRequest/fetch，
 *      需要在主世界注入拦截器才能捕获播放器的字幕请求响应。
 *
 * 通信机制：
 *   Content Script ↔ Page Script 通过 window.postMessage 双向通信：
 *   - Content Script 发送 BEAVER_FETCH_REQUEST → Page Script 执行 fetch 并回复 BEAVER_FETCH_RESPONSE
 *   - Page Script 拦截 timedtext XHR → 主动发送 BEAVER_TIMEDTEXT_CAPTURE 给 Content Script
 *   - Page Script 加载完成 → 发送 BEAVER_PAGE_FETCH_READY 给 Content Script
 *   - Content Script 发送 BEAVER_PAGE_FETCH_PING → Page Script 补发 READY
 *     （document_start 注入时 READY 早于 CS 监听器建立，必须能补问一次）
 *   - Content Script 用 url='__beaver_timedtext_query__' 回查页面侧 timedtext 缓存
 *     （同理：document_start 期间捕获并广播的 CAPTURE 消息，CS 那时还没监听，会丢；
 *       故页面侧必须自留一份缓存供事后回查——这是本次修复的关键补齐项）
 *
 * 安全：仅处理 youtube.com 域名的按需 fetch，不泄露其他请求信息。
 */
(function () {
  'use strict';

  // 防止重复注入（Chrome 声明式 + Firefox 懒注入两条路径并存时只装一次补丁）
  if (window.__beaverPageFetchInjected) return;
  window.__beaverPageFetchInjected = true;

  // === timedtext 页面侧缓存（第一百七十八次新增）===
  // 为什么必需：本脚本在 document_start 就位，播放器随后自发的 timedtext 请求会被
  // 立刻捕获并 postMessage 广播；但内容脚本是 document_idle 才加载、且监听器建立
  // 更晚，那些早期广播无人接收即丢失。故页面侧自留缓存，供内容脚本事后回查。
  // 上限 60 条，超出丢弃最旧的，避免长会话内存增长。
  var timedtextCache = [];

  function saveTimedtext(url, respText, contentType) {
    try {
      if (!url || !respText) return;
      // 同 URL 去重（播放器可能重复请求同一轨道）
      for (var i = 0; i < timedtextCache.length; i++) {
        if (timedtextCache[i].url === url) return;
      }
      timedtextCache.push({ url: url, resp: respText, contentType: contentType || '' });
      if (timedtextCache.length > 60) timedtextCache.shift();
      window.postMessage({
        type: 'BEAVER_TIMEDTEXT_CAPTURE',
        url: url,
        resp: respText,
        contentType: contentType || ''
      }, '*');
    } catch (e) { /* 忽略 */ }
  }

  // === B站 playurl 响应捕获（第一百零七次 P1 方案C，借鉴 VideoSeek injectXhr）===
  // 页面播放器自身会请求 /x/player/wbi/playurl（签名/cookie/referer/风控天然合法），
  // 我们只旁路读响应，按 cid 缓存并 postMessage 上报给内容脚本。
  // 注意：本文件经 <script src=chrome-extension://...> 注入，与内联注入同样受页面 CSP 约束；
  //   若被拦截则内容侧 P0 诊断会显示"注入超时"，届时走 P3(chrome.scripting MAIN world)。
  var biliPlayurlCache = {}; // cid -> resp(text)

  function reportPlayurl(rawUrl, respText) {
    try {
      var cid = '';
      try { cid = new URL(rawUrl, location.origin).searchParams.get('cid') || ''; } catch (e) { /* ignore */ }
      if (!respText || respText.length < 32) return;
      var data = JSON.parse(respText);
      var dash = data && data.data && data.data.dash;
      if (!dash || !dash.audio || !dash.audio.length) return; // 无 DASH 音轨（VIP/DURL）不缓存
      if (cid) biliPlayurlCache[cid] = respText;
      window.postMessage({
        type: 'BEAVER_BILI_PLAYURL',
        cid: cid,
        resp: respText,
        url: rawUrl
      }, '*');
    } catch (e) { /* 非 JSON/结构不符：忽略 */ }
  }

  function isBiliPlayurl(u) {
    return typeof u === 'string' && u.indexOf('bilibili.com') !== -1 && (
      u.indexOf('/x/player/wbi/playurl') !== -1 ||
      u.indexOf('/x/player/playurl') !== -1 ||
      u.indexOf('/pgc/player/web/playurl') !== -1
    );
  }

  // === XHR 拦截：捕获 /api/timedtext 与 B站 playurl 响应 ===
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var origAddEventListener = XMLHttpRequest.prototype.addEventListener;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._beaverUrl = url;
    // 第一百零七次：B站 playurl 响应捕获（load 事件路径，覆盖 addEventListener 用法）
    if (isBiliPlayurl(url)) {
      var selfX = this;
      this.addEventListener('load', function () {
        try {
          if (selfX.readyState === 4 && selfX.status === 200) reportPlayurl(selfX._beaverUrl, selfX.responseText);
        } catch (e) { /* ignore */ }
      });
    }
    return origOpen.apply(this, arguments);
  };

  // 拦截 addEventListener('readystatechange', ...) 方式
  // ⚠ 第一百七十八次修 bug：旧实现重新赋值形参 listener，但本文件顶部有 'use strict'，
  //   严格模式下形参与 arguments 对象**不联动**，末尾 origAddEventListener.apply(this, arguments)
  //   传下去的仍是**原始未包装的 listener** → 这条拦截路径此前完全失效。
  //   改为构造新的实参数组显式传递包装后的 listener。
  XMLHttpRequest.prototype.addEventListener = function (type, listener) {
    if (type === 'readystatechange' && typeof listener === 'function'
        && this._beaverUrl && String(this._beaverUrl).indexOf('/api/timedtext') !== -1) {
      var xhr = this;
      var origListener = listener;
      var wrapped = function () {
        if (xhr.readyState === 4 && xhr.status === 200 && !xhr._beaverCaptured) {
          xhr._beaverCaptured = true;
          saveTimedtext(xhr._beaverUrl, xhr.responseText, xhr.getResponseHeader('content-type') || '');
        }
        return origListener.apply(this, arguments);
      };
      var args = Array.prototype.slice.call(arguments);
      args[1] = wrapped;
      return origAddEventListener.apply(this, args);
    }
    return origAddEventListener.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this._beaverUrl && String(this._beaverUrl).indexOf('/api/timedtext') !== -1) {
      var xhr = this;
      var captured = false;
      var origOnReady = this.onreadystatechange;

      this.onreadystatechange = function () {
        if (!captured && xhr.readyState === 4 && xhr.status === 200) {
          captured = true;
          xhr._beaverCaptured = true;
          saveTimedtext(xhr._beaverUrl, xhr.responseText, xhr.getResponseHeader('content-type') || '');
        }
        if (typeof origOnReady === 'function') {
          origOnReady.apply(this, arguments);
        }
      };

      // 第一百七十八次：再加 load 事件兜底——播放器若既不用 onreadystatechange
      // 也不用 addEventListener('readystatechange')（如内部用 load/loadend），
      // 上面两条都拦不到。借鉴 B站 playurl 分支已验证可用的 load 路径。
      try {
        origAddEventListener.call(this, 'load', function () {
          if (!xhr._beaverCaptured && xhr.readyState === 4 && xhr.status === 200) {
            xhr._beaverCaptured = true;
            saveTimedtext(xhr._beaverUrl, xhr.responseText, xhr.getResponseHeader('content-type') || '');
          }
        });
      } catch (e) { /* 忽略 */ }
    }
    return origSend.apply(this, arguments);
  };

  // === fetch 拦截：捕获 /api/timedtext 与 B站 playurl 响应 ===
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var promise = origFetch.apply(this, arguments);
    // 第一百零七次：B站 playurl fetch 路径捕获
    if (isBiliPlayurl(url)) {
      promise.then(function (resp) {
        if (resp.ok) {
          try {
            resp.clone().text().then(function (t) { reportPlayurl(url, t); }).catch(function () { /* ignore */ });
          } catch (e) { /* ignore */ }
        }
      }).catch(function () { /* ignore */ });
    }

    if (url.indexOf('/api/timedtext') !== -1) {
      promise.then(function (resp) {
        if (resp.ok) {
          try {
            var clone = resp.clone();
            var ct = resp.headers.get('content-type') || '';
            clone.text().then(function (text) {
              if (text && text.length > 0) saveTimedtext(url, text, ct);
            }).catch(function () { /* 忽略 */ });
          } catch (e) { /* 忽略 */ }
        }
      }).catch(function () { /* 忽略 */ });
    }

    return promise;
  };

  // === 按需 fetch：Content Script 发送请求，Page Script 执行并返回结果 ===
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || typeof event.data !== 'object') return;

    // 第一百七十八次：READY 补答——本脚本 document_start 就绪时内容脚本（document_idle）
    // 尚未建立监听，那条 BEAVER_PAGE_FETCH_READY 必然丢失。内容脚本主动 PING，此处补答。
    if (event.data.type === 'BEAVER_PAGE_FETCH_PING') {
      window.postMessage({ type: 'BEAVER_PAGE_FETCH_READY' }, '*');
      return;
    }

    if (event.data.type !== 'BEAVER_FETCH_REQUEST') return;

    // 第一百七十八次：timedtext 页面侧缓存回查——把 document_start 期间捕获、
    // 但内容脚本当时无法接收的记录整批补给内容脚本。这是"VideoSeek 能、我不行"
    // 的关键补齐：VideoSeek 的 injectedData 与播放器同世界常驻，天然可事后取。
    if (event.data.id && event.data.url === '__beaver_timedtext_query__') {
      window.postMessage({
        type: 'BEAVER_FETCH_RESPONSE',
        id: event.data.id,
        ok: timedtextCache.length > 0,
        text: JSON.stringify(timedtextCache),
        contentType: 'application/json'
      }, '*');
      return;
    }

    // 第一百零七次：B站 playurl 缓存查询（按 cid；cid 为空回最近一条）
    var id0 = event.data.id;
    var url0 = event.data.url;
    if (id0 && url0 === '__beaver_bili_playurl_query__') {
      var wantCid = (event.data.cid || '') + '';
      var pick = null;
      if (wantCid && biliPlayurlCache[wantCid]) pick = biliPlayurlCache[wantCid];
      else {
        var keys = Object.keys(biliPlayurlCache);
        if (keys.length > 0) pick = biliPlayurlCache[keys[keys.length - 1]];
      }
      window.postMessage({
        type: 'BEAVER_FETCH_RESPONSE',
        id: id0,
        ok: !!pick,
        text: pick || '',
        contentType: 'application/json'
      }, '*');
      return;
    }

    var id = event.data.id;
    var url = event.data.url;

    // 安全限制：仅允许 youtube.com 域名的请求
    if (!url || (url.indexOf('youtube.com') === -1 && url.indexOf('ytimg.com') === -1)) {
      window.postMessage({
        type: 'BEAVER_FETCH_RESPONSE',
        id: id,
        ok: false,
        error: 'URL not allowed'
      }, '*');
      return;
    }

    fetch(url, { credentials: 'same-origin' })
      .then(function (resp) {
        var contentType = resp.headers.get('content-type') || '';
        var status = resp.status;
        return resp.text().then(function (text) {
          window.postMessage({
            type: 'BEAVER_FETCH_RESPONSE',
            id: id,
            ok: resp.ok,
            status: status,
            text: text,
            contentType: contentType
          }, '*');
        });
      })
      .catch(function (e) {
        window.postMessage({
          type: 'BEAVER_FETCH_RESPONSE',
          id: id,
          ok: false,
          error: e.message
        }, '*');
      });
  });

  // 通知 Content Script 注入完成
  window.postMessage({ type: 'BEAVER_PAGE_FETCH_READY' }, '*');
})();
