// ========== 通道 A：内容脚本桥（扩展草稿缓存 → VocabRadar 网站） ==========
// 契约：网站侧 src/utils/draftBridge.js 头注释（两端同步约束，改动需两端同步）：
//   时机 ①页面加载时推一次（覆盖「扩展先存、网站后开」）
//       ②chrome.storage.onChanged 推增量（覆盖「网站先开、扩展后存」）
//   消息 = { type: 'vocabradar:drafts-push', from: 'vocabradar-extension', scrolls: [...] }
// 网站侧校验 event.source === window 且 type 匹配；落库 importDrafts 按 id+version 幂等，
// 故本桥每次推缓存全量即可（重复推送不重复计数），无需自做差量。
// 设计：独立于侧栏开关 webSidebarEnabled——桥职责是向网站供数，与侧栏 UI 启停无关；
//       无 UI，异常仅 console 留痕，绝不阻断宿主页面。

(function () {
  'use strict';
  // 与 ws/draft-export.js 的 DRAFT_CACHE_KEY 一致（classic script 不便互引，字面量同步维护）
  const DRAFT_CACHE_KEY = 'vocabradarDraftScrolls';
  const PUSH_TYPE = 'vocabradar:drafts-push';
  const FROM = 'vocabradar-extension';

  // pushDrafts：读缓存全量 → 向页面 postMessage（targetOrigin '*'：
  // 接收方按 source===window 严校验，消息仅草稿数据非敏感）
  function pushDrafts() {
    try {
      chrome.storage.local.get({ [DRAFT_CACHE_KEY]: [] }, function (res) {
        const list = (res && Array.isArray(res[DRAFT_CACHE_KEY])) ? res[DRAFT_CACHE_KEY] : [];
        try {
          window.postMessage({ type: PUSH_TYPE, from: FROM, scrolls: list }, '*');
        } catch (e) {
          console.error('[VocabRadar][bridge] postMessage 失败', e);
        }
      });
    } catch (e) {
      console.error('[VocabRadar][bridge] storage 读取失败', e);
    }
  }

  pushDrafts(); // ①页面加载推一次
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && DRAFT_CACHE_KEY in changes) pushDrafts(); // ②缓存变化推增量
    });
  } catch (e) {
    console.error('[VocabRadar][bridge] onChanged 监听失败', e);
  }

  // ========== 通道 B：网站 Creator 解析请求转发 ==========
  // 契约（两端同步约束，网站侧 src/utils/extParseChannel.js 头注释同文）：
  //   ping: { type:'vocabradar:parse-ping', from:'vocabradar-web', reqId }
  //         → 立即回 parse-response {ok:true, pong:true}（不经 SW；网站 1.5s 超时判未装）
  //   请求: { type:'vocabradar:parse-request', from:'vocabradar-web', reqId,
  //           kind:'link'|'image'|'document'|'llm'|'translation',
  //           payload:{url}|{imageDataUrl, lang}|{docKind, b64, name}|{prompt}|{word,source,target} }
  //         → chrome.runtime.sendMessage({type:'PARSE_MATERIAL'}) 转发 SW
  //         → SW 响应 {ok, text?|title?|error?|code?} 原样回传页面 parse-response
  //   document/llm/translation 均为透传：本桥只转发不改写、无 kind 白名单
  //     （llm 走 SW LLM 聊天返回 {ok, text}，供网站阅读理解 AI 生成与 AI 润色共用；
  //      translation 走 SW 快渠道返回 {ok, text, channel}；本桥对 translation 先试
  //      浏览器内置（见 tryBuiltinTranslation），700ms 未命中才转发 SW——
  //      website 侧契约不变，只是 channel 可能为"浏览器内置"）
  //   接收校验：ev.source===window 且 from==='vocabradar-web'（与通道 A 同款纪律）；
  //   reqId 由网站侧生成并配对，本桥原样带回，不做去重。
  const PARSE_PING = 'vocabradar:parse-ping';
  const PARSE_REQ = 'vocabradar:parse-request';
  const PARSE_RESP = 'vocabradar:parse-response';
  const FROM_WEB = 'vocabradar-web';
  // 通道 C 中继常量（Firefox 路径，见文件尾该节）
  const AUTH_RELAY = 'vocabradar:auth-relay';
  const AUTH_RELAY_RESP = 'vocabradar:auth-relay-response';
  const AUTH_ORIGINS = ['https://vocabradar.com', 'https://localhost:3001', 'http://localhost:3001'];
  const AUTH_ACTIONS = ['vocabradar:auth-handoff', 'vocabradar:auth-ping', 'vocabradar:auth-disconnect'];

  function replyParse(reqId, fields) {
    try {
      window.postMessage(Object.assign({ type: PARSE_RESP, from: FROM, reqId: reqId }, fields), '*');
    } catch (e) {
      console.error('[VocabRadar][bridge] parse 回复失败', e);
    }
  }

  // ========== 翻译类请求「浏览器内置优先」快路径 ==========
  // 网站要一个词的译文时，不必一律转发 SW 走在线渠道：扩展内容侧本就有
  //   Chrome Translator API（本地神经网络，最优渠道）。本桥是 classic script
  //   （IIFE），用动态 import() 引 src/lib/translator/builtin-translator.js 模块
  //   （在 manifest web_accessible_resources 的 src/lib/* 内），模块缓存与本扩展
  //   其他内容脚本（同 isolated world）共享同一单例，getTranslator 直接可用。
  // 采纳条件（与 index.js 内置渠道同口径，不遮蔽错误）：
  //   ①勾选门控：translationChannels.builtin === false 时不试；
  //   ②语言对必须与内置单例一致（storage learnLanguage/meaningLanguage 基码 ==
  //     请求 payload.source/target 基码，BCP-47 截首段），不一致内置译出来也是错语言；
  //   ③结果过 targetScriptOk 文字系统校验、且非「译文=原文」同形回显——
  //     同形/脚本不符一律不采纳（转 SW 快渠道，由 SW 给真实译文；桥接路径不做
  //     跨渠道同形共识——快渠道多为词典释义，同形票凑不齐，见 translate.js 注释）；
  //   ④700ms 竞速超时即放弃（冷启动下载模型很慢，网站侧总预算 2.2s 要留给 SW）。
  // 命中 → 直接回译文（省一次 SW 在线请求）；未命中 → 照旧转发 PARSE_MATERIAL。
  function tryBuiltinTranslation(payload) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(
          { learnLanguage: 'en', meaningLanguage: 'zh', translationChannels: null },
          function (st) {
            try {
              st = st || {};
              var ch = st.translationChannels || {};
              if (ch.builtin === false) { resolve(null); return; }
              var word = String(payload.word || '').trim();
              if (!word) { resolve(null); return; }
              var src = String(payload.source || 'en').split('-')[0].toLowerCase();
              var tgt = String(payload.target || 'zh').split('-')[0].toLowerCase();
              var ls = String(st.learnLanguage || 'en').split('-')[0].toLowerCase();
              var ms = String(st.meaningLanguage || 'zh').split('-')[0].toLowerCase();
              if (src !== ls || tgt !== ms) { resolve(null); return; }
              var done = false;
              var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, 700);
              import(chrome.runtime.getURL('src/lib/translator/builtin-translator.js'))
                .then(function (m) {
                  return m.getTranslator().then(function (tr) {
                    if (!tr) return null;
                    return tr.translate(word);
                  }).then(function (t) {
                    var text = t ? String(t).trim() : '';
                    if (!text) return null;
                    if (src !== tgt && text.toLowerCase() === word.toLowerCase()) return null; // 同形回显
                    if (src !== tgt && !m.targetScriptOk(text, tgt)) return null;              // 文字系统不符
                    return text;
                  });
                })
                .then(function (hit) {
                  if (done) return;
                  done = true;
                  clearTimeout(timer);
                  resolve(hit || null);
                })
                .catch(function () {
                  if (done) return;
                  done = true;
                  clearTimeout(timer);
                  resolve(null);
                });
            } catch (e) { resolve(null); }
          });
      } catch (e) { resolve(null); }
    });
  }

  // 转发 SW（PARSE_MATERIAL 原样语义，响应/异常回传与旧行为一致）
  function forwardParse(m) {
    chrome.runtime.sendMessage({ type: 'PARSE_MATERIAL', reqId: m.reqId, kind: m.kind, payload: m.payload })
      .then(function (resp) {
        if (!resp) { replyParse(m.reqId, { ok: false, error: 'no response from extension' }); return; }
        replyParse(m.reqId, resp);
      })
      .catch(function (e) {
        replyParse(m.reqId, { ok: false, error: String(e && e.message || e) });
      });
  }

  try {
    window.addEventListener('message', function (ev) {
      if (ev.source !== window) return;
      const m = ev.data;
      if (!m || typeof m !== 'object' || m.from !== FROM_WEB) return;
      if (m.type === PARSE_PING) { replyParse(m.reqId, { ok: true, pong: true }); return; }
      if (m.type === AUTH_RELAY) { handleAuthRelay(ev, m); return; }
      if (m.type !== PARSE_REQ) return;
      // 翻译类先试浏览器内置（700ms 竞速），未命中再转发 SW 在线快渠道
      if (m.kind === 'translation' && m.payload && m.payload.word) {
        tryBuiltinTranslation(m.payload).then(function (hit) {
          if (hit) { replyParse(m.reqId, { ok: true, text: hit, channel: '浏览器内置' }); return; }
          forwardParse(m);
        }, function () { forwardParse(m); });
        return;
      }
      forwardParse(m);
    });
  } catch (e) {
    console.error('[VocabRadar][bridge] parse 监听注册失败', e);
  }

  // ========== 通道 C 中继：账号交接（Firefox 专用路径） ==========
  // Firefox 不支持 externally_connectable/onMessageExternal（MDN：未实现），网页无法
  // 直发 chrome.runtime.sendMessage。本中继把网站的 auth 消息转发给 SW（内部消息，
  // sw/auth.js 的 onMessage 监听承接），响应原样回传页面。
  // **token 过页面是 Firefox 下的妥协**（方案风险表「扩展 token 经页面暴露」的
  // Chrome 裁定在 Firefox 无替代），因此接收校验比通道 A/B 严一档：除 source/from
  // 外必须校验 ev.origin ∈ 白名单——任意第三方网页不得借本中继投递/清除登录态。
  // 契约：web/docs/桥接扩展.md §7 + 扩展 docs/桥接网站.md §八（改动四处同步）
  function replyAuthRelay(reqId, fields) {
    try {
      window.postMessage(Object.assign({ type: AUTH_RELAY_RESP, from: FROM, reqId: reqId }, fields), '*');
    } catch (e) {
      console.error('[VocabRadar][bridge] auth 回复失败', e);
    }
  }

  function handleAuthRelay(ev, m) {
    if (AUTH_ORIGINS.indexOf(ev.origin) === -1) {
      replyAuthRelay(m.reqId, { ok: false, error: 'origin not allowed' });
      return;
    }
    const action = m.action;
    if (AUTH_ACTIONS.indexOf(action) === -1) {
      replyAuthRelay(m.reqId, { ok: false, error: 'unknown action' });
      return;
    }
    // 透传 SW（handoff 载荷在 m.payload 内展开；ping/disconnect 无载荷）
    const msg = Object.assign({ type: action }, action === 'vocabradar:auth-handoff' ? (m.payload || {}) : {});
    chrome.runtime.sendMessage(msg)
      .then(function (resp) {
        replyAuthRelay(m.reqId, resp || { ok: false, error: 'no response from extension' });
      })
      .catch(function (e) {
        replyAuthRelay(m.reqId, { ok: false, error: String(e && e.message || e) });
      });
  }
})();