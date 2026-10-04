// =============================================================================
// SW 消息路由
// 职责：chrome.runtime.onMessage 唯一分发点——按 msg.type 转各 handler；
//   MAIN world 函数注册表（chrome.scripting world:'MAIN' 执行体）。
// 顶层副作用：注册 onMessage 监听（由入口 service-worker.js import 触发）。
// =============================================================================
import { handleWordDbMessage } from '../../lib/word-db.js';
import { _ts, log } from './log.js';
import { handleTranslateText, getChannelStatus } from './translate.js';
import { handleParseMaterial } from './parse-material.js';
import { handleOcrRecognize } from './ocr.js';
import { handleAsrLlmFile, handleSegmentByLlm } from './asr.js';
import { handleLlmChat, handleLlmTranslate } from './llm.js';
import {
  handleFetchSubtitle, submitAsrJobOnce, handleAsrJobPoll, handleYtdlSubtitles,
  handleFetchUrl, handleFetchText, handleKuroFetch
} from './backend.js';
import { wfFetchMemoized } from './wf.js';

// === MAIN world 函数注册表 ===
// 这些函数会被序列化后在页面主世界执行（world:'MAIN'），只能访问页面 window/document。
// 注意：不得引用 SW 作用域内的任何变量/导入。
function mwReadPlayinfo() {
  try {
    var p = window.__playinfo__;
    return p ? JSON.parse(JSON.stringify(p)) : null;
  } catch (e) { return null; }
}

function mwReadBiliTitle() {
  try {
    var st = window.__INITIAL_STATE__;
    var t = st ? ((st.videoData && st.videoData.title) ||
      (st.epInfo && (st.epInfo.showTitle || st.epInfo.long_title || st.epInfo.title)) ||
      (st.h1Title && st.h1Title.title) || '') : '';
    return String(t || '');
  } catch (e) { return ''; }
}

const MAIN_WORLD_FUNCS = { readPlayinfo: mwReadPlayinfo, readBiliTitle: mwReadBiliTitle };

// 消息路由（保留扩展点）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') {
    sendResponse({ ok: false, error: 'invalid msg' });
    return true;
  }
  switch (msg.type) {
    case 'START_ASR':
      // ASR 一律在线转写，无会话状态；START/STOP 仅协议握手（调用方以此判断链路可达）。
      sendResponse({ ok: true });
      return true;
    case 'ASR_AUDIO_SEGMENT':
      // content script 采集的音频段，在线转写（OpenAI 兼容 /audio/transcriptions）
      // 不等待结果（转写完成后 handleSegmentByLlm 主动发 ASR_SEGMENT 回发起 tab）
      (async () => {
        try {
          handleSegmentByLlm(msg, sender).catch((e) => {
            console.warn('[VocabRadar][sw][' + _ts() + '] ASR(api) 段失败:', e);
          });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
      })();
      return true;
    case 'STOP_ASR':
      // 同 START_ASR，轻量确认（无会话可停）
      sendResponse({ ok: true });
      return true;
    case 'ASR_CHECK':
      sendResponse({ ok: true, supported: true });
      return true;
    case 'TRANSLATE_TEXT':
      // msg.prior = 内容侧浏览器内置译文的同形先验票 {text,channel}，
      //   供 handleTranslateText 计入跨渠道共识（≥2 票采纳）。
      handleTranslateText(msg.word, msg.source, msg.target, msg.channels, msg.prior)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'CHANNEL_STATUS':
      // 翻译渠道状态快照（成功/失败/连败/冷却/最近错误与耗时），
      //   引导页翻译分组状态行（guide/ch-health.js）读取。
      sendResponse({ ok: true, channels: getChannelStatus() });
      return true;
    case 'FETCH_SUBTITLE':
      handleFetchSubtitle(msg.url)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'ASR_JOB_SUBMIT':
      // ASR 端点提交——content script 受页面 CSP 限制不能直连 backend，
      //   SW 代理 POST /api/asr/jobs（同 FETCH_SUBTITLE 的代理逻辑）；
      //   失败如实上抛不自动拉起（用户裁定）。
      submitAsrJobOnce(msg.url, msg.language)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'ASR_JOB_POLL':
      // 任务增量轮询——GET /api/asr/jobs/<id>?after=N（下载/转写进度+新增段）
      handleAsrJobPoll(msg.id, msg.after)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'YTDL_SUBTITLES':
      // 字幕 backend 兜底——扩展五路全失败后 SW 代理 GET /api/ytdl/subtitles
      handleYtdlSubtitles(msg.url, msg.lang)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    // === chrome.scripting MAIN world 执行/注入 ===
    // 内联 <script> 注入受页面 CSP 限制（B站下发严格 CSP 则主世界读取静默失败）。
    // world:'MAIN' 不受页面 CSP 管，且能直接拿返回值。
    // 内容脚本经消息调用；Firefox 无 world 选项时由调用方 catch 后走旧注入路径兜底。
    case 'MAIN_WORLD_EXEC': {
      const tabId = sender.tab?.id;
      const fn = MAIN_WORLD_FUNCS[msg.name];
      if (!tabId || !fn) {
        sendResponse({ ok: false, error: 'bad args' });
        return true;
      }
      chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: fn, args: msg.args || [] })
        .then((results) => sendResponse({ ok: true, result: results && results[0] ? results[0].result : null }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }
    case 'MAIN_WORLD_INJECT_FILE': {
      const tabId2 = sender.tab?.id;
      if (!tabId2 || !msg.file || !/^src\/lib\//.test(msg.file)) {
        sendResponse({ ok: false, error: 'bad args' });
        return true;
      }
      chrome.scripting.executeScript({ target: { tabId: tabId2 }, world: 'MAIN', files: [msg.file] })
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }
    case 'OCR_RECOGNIZE':
      // content script 发来的 OCR 请求，经 SW 转给 offscreen（页面 CSP 限制直连）；
      //   lang 透传（OCR 语言随 learnLanguage）。识别走 LLM 视觉，见 ocr.js。
      handleOcrRecognize(msg.imageDataUrl, msg.lang)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'PARSE_MATERIAL':
      // 网站 Creator 解析编排 —— vocabradar-bridge 转发的素材解析，按 kind 分流：
      // link → SW fetch HTML（host_permissions <all_urls>，不受页面 CSP 限制）
      //        → offscreen 用 main-text.extractDefuddleFromHtml 提取正文；
      // image → 复用 OCR_RECOGNIZE 链路（LLM 视觉）；asr → 在线转写；
      // document → offscreen parse-doc 解析（pdf/docx/epub，文件字节 b64 透传）；
      // 视频/音频链接 → 引导走扩展自身字幕/转写工作流（code:'video-link'）；
      // 其余类型这里兜底明示错误（不静默）。分工契约见 docs/桥接网站.md §4.2。
      handleParseMaterial(msg.kind, msg.payload)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'ASR_LLM_FILE':
      // 整段 LLM 转写（引导页上传原始文件一次请求，不本地解码分片）；
      //   handler 返回结果对象，此处统一回包。
      handleAsrLlmFile(msg)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'FETCH_URL':
      // content script 受页面 CSP 限制无法 fetch CDN，diverse-lemmas 词典数据
      //   下载需经 SW 代理（SW 有 host_permissions <all_urls>）。
      handleFetchUrl(msg.url)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'FETCH_TEXT':
      // Parser 链接抓取（guide 页 CSP connect-src 白名单不含任意站点，
      //   页面直 fetch 被拒——见 handleFetchText 头注释），返回纯文本。
      handleFetchText(msg.url)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'KURO_FETCH':
      // kuromoji 日语注音词典 CDN 中转：词典 12 个 .dat.gz 不随包，
      //   phonemize-ja.mjs（构建时 patch 过的 BrowserDictionaryLoader）经本消息请求，
      //   SW 代理 fetch 直传 ArrayBuffer（本地 Cache API 命中则直接回缓存，不发网络）。
      //   白名单/回退链/缓存见 handleKuroFetch。
      handleKuroFetch(msg.url)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'WF_FETCH':
      // wordfreq 词频数据 HF dataset 中转：42 语 small_*.msgpack.gz 不随包，
      //   word-loader.js loadWordfreq 经本消息请求，SW 代理 fetch 并做
      //   files.json SHA-256 校验，直传 ArrayBuffer 回传（wfFetchMemoized 在途
      //   去重 + 30s 结果缓存）。白名单/校验见 handleWfFetch。
      // 收到即打日志（诊断口径）：页面端报"消息通道错误"时，SW console 有此行=消息
      //   已到达但未回话，无此行=消息根本没送到 SW——一条日志即可分流定位。
      log('[VocabRadar][sw][' + _ts() + '] 收到 WF_FETCH: ' + msg.file);
      wfFetchMemoized(msg.file)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    // Chat 面板的模型请求。content script 受宿主页面 CSP 限制无法直接
    //   fetch 第三方 API（与 FETCH_URL / OCR_RECOGNIZE 同因），统一由 SW 代理。
    case 'LLM_CHAT':
      handleLlmChat(msg.messages)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    // 翻译渠道的 LLM 文本翻译——直接用聊天的 LLM 配置（文本形态）；
    //   content 侧组装好的提示词随消息下发（哑管道直发，空则 SW 硬编码兜底）
    case 'LLM_TRANSLATE':
      handleLlmTranslate(msg.text, msg.target, msg.prompt)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    // 打开引导页：Chat 面板"打开设置配置模型"按钮，或两侧栏 ⋯「停用本站」
    //   （section:'deactivate' + pattern 当前域名 → ?deactivate=<地址> 查询串，
    //   引导页 src/guide/deactivate.js 据此切设定栏/展开停用组/定位该地址行）。
    //   content script 无法开扩展页，由 SW 代开。
    case 'OPEN_GUIDE': {
      let guideUrl = chrome.runtime.getURL('src/guide/guide.html');
      if (msg && msg.section === 'deactivate') {
        guideUrl += '?deactivate=' + encodeURIComponent(String(msg.pattern || ''));
      }
      chrome.tabs.create({ url: guideUrl }).catch(() => {});
      sendResponse({ ok: true });
      return true;
    }
    // 统一词典 WORD_DB_* / DICT_CACHE_* 消息分发：content script 经 sendMessage
    //   请求 SW 操作 IndexedDB（CS 的 IDB 按站点隔离），词典缓存读写也走本分发。
    default:
      // 先尝试 WORD_DB_* / DICT_CACHE_* / LEMMAS_* / LEMMATIZE_*（逐词词形还原）消息，
      //   转发给 handleWordDbMessage。
      if (msg.type && (msg.type.startsWith('WORD_DB_') || msg.type.startsWith('DICT_CACHE_') || msg.type.startsWith('LEMMAS_') || msg.type.startsWith('LEMMATIZE_'))) {
        // handleWordDbMessage 是 async 函数：isSW=false 时返回 false 且不调
        //   sendResponse，若 `if (handled) return true` 会令通道挂起——直接调用并
        //   return true 保持通道开放，.then 中 handled=false 时补发错误响应。
        handleWordDbMessage(msg, sender, sendResponse).then((handled) => {
          if (!handled) {
            sendResponse({ ok: false, error: 'WORD_DB handler not available (not in background context)' });
          }
        });
        return true;
      }
      sendResponse({ ok: true });
      return true;
  }
});
