// ========== G3（2026-09-08）：通道 A 内容脚本桥（扩展草稿缓存 → VocabRadar 网站） ==========
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

  // ========== G4（2026-09-08）：通道 B —— 网站 Creator 解析请求转发 ==========
  // 契约（两端同步约束，网站侧 src/utils/extParseChannel.js 头注释同文）：
  //   ping: { type:'vocabradar:parse-ping', from:'vocabradar-web', reqId }
  //         → 立即回 parse-response {ok:true, pong:true}（不经 SW；网站 1.5s 超时判未装）
  //   请求: { type:'vocabradar:parse-request', from:'vocabradar-web', reqId,
//           kind:'link'|'image'|'document'|'llm',
//           payload:{url}|{imageDataUrl, lang}|{docKind, b64, name}|{prompt} }
//         → chrome.runtime.sendMessage({type:'PARSE_MATERIAL'}) 转发 SW
//         → SW 响应 {ok, text?|title?|error?|code?} 原样回传页面 parse-response
//   （B2，2026-09-10：document kind 为文件字节 b64 透传，本桥只转发不改写；透传无 kind 白名单）
//   （W1，2026-09-11：llm kind 为提示词 payload:{prompt} 透传，SW 走 LLM 聊天返回 {ok, text}；
//    供网站阅读理解 AI 生成与 AI 润色共用；本桥仍只转发不改写）
  //   接收校验：ev.source===window 且 from==='vocabradar-web'（G2 通道A 同款纪律）；
  //   reqId 由网站侧生成并配对，本桥原样带回，不做去重。
  const PARSE_PING = 'vocabradar:parse-ping';
  const PARSE_REQ = 'vocabradar:parse-request';
  const PARSE_RESP = 'vocabradar:parse-response';
  const FROM_WEB = 'vocabradar-web';

  function replyParse(reqId, fields) {
    try {
      window.postMessage(Object.assign({ type: PARSE_RESP, from: FROM, reqId: reqId }, fields), '*');
    } catch (e) {
      console.error('[VocabRadar][bridge] parse 回复失败', e);
    }
  }

  try {
    window.addEventListener('message', function (ev) {
      if (ev.source !== window) return;
      const m = ev.data;
      if (!m || typeof m !== 'object' || m.from !== FROM_WEB) return;
      if (m.type === PARSE_PING) { replyParse(m.reqId, { ok: true, pong: true }); return; }
      if (m.type !== PARSE_REQ) return;
      chrome.runtime.sendMessage({ type: 'PARSE_MATERIAL', reqId: m.reqId, kind: m.kind, payload: m.payload })
        .then(function (resp) {
          if (!resp) { replyParse(m.reqId, { ok: false, error: 'no response from extension' }); return; }
          replyParse(m.reqId, resp);
        })
        .catch(function (e) {
          replyParse(m.reqId, { ok: false, error: String(e && e.message || e) });
        });
    });
  } catch (e) {
    console.error('[VocabRadar][bridge] parse 监听注册失败', e);
  }
})();