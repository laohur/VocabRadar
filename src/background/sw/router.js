// =============================================================================
// SW 消息路由（2026-09-27 拆分自 service-worker.js）
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

// === 第一百零九次 P3：MAIN world 函数注册表 ===
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
  // 第一百八十次：删除 ASR_FALLBACK_IFRAME 分支——该广播原用于请求页面/引导页创建
  //   Firefox 回退 iframe，现宿主已改建在后台页自身 document 内（ensureFallbackIframe），
  //   不再有此消息类型。
  // 第三百九十四次：删除 ASR_STATUS/ASR_SEGMENT/ASR_ERROR 转发区——旧生产者
  //   （offscreen whisper 识别回传）已随本地模型移除消失；现 ASR_SEGMENT 由
  //   handleSegmentByLlm 直发发起方 tab（sender.tab.id），无需中转。
  switch (msg.type) {
    case 'START_ASR':
      // 第三百九十四次：whisper 会话移除后轻量化——旧版在此创建 offscreen document
      //   并预加载模型、维护 _asrActive 状态机。现 ASR 一律在线转写，分段请求自带
      //   全部上下文（sender.tab 直发结果），START/STOP 只剩协议握手意义（调用方
      //   asr-client.js/asr.js 仍以此判断链路可达），直接确认即可。
      sendResponse({ ok: true });
      return true;
    case 'ASR_AUDIO_SEGMENT':
      // content script 采集的音频段，在线转写（OpenAI 兼容 /audio/transcriptions）
      // 不等待结果（转写完成后 handleSegmentByLlm 主动发 ASR_SEGMENT 回发起 tab）
      // 反思（2026-08-08）：旧版此处有 _asrActive 状态检查与 session 恢复兜底、
      //   引擎分流（local→OFFSCREEN_ASR_RECOGNIZE）。第三百九十四次：引擎单一化
      //   （在线），状态机与 local 分支删除，段处理无条件走 handleSegmentByLlm。
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
      // 第三百九十四次：同 START_ASR，轻量确认（无会话可停）
      sendResponse({ ok: true });
      return true;
    case 'ASR_CHECK':
      sendResponse({ ok: true, supported: true });
      return true;
    case 'TRANSLATE_TEXT':
      // 第460次：msg.prior = 内容侧浏览器内置译文的同形先验票 {text,channel}，
      //   供 handleTranslateText 计入跨渠道共识（≥2 票采纳）。
      handleTranslateText(msg.word, msg.source, msg.target, msg.channels, msg.prior)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'CHANNEL_STATUS':
      // 第461次：翻译渠道状态快照（成功/失败/连败/冷却/最近错误与耗时），
      //   引导页翻译分组状态行（guide/ch-health.js）读取。
      sendResponse({ ok: true, channels: getChannelStatus() });
      return true;
    case 'FETCH_SUBTITLE':
      handleFetchSubtitle(msg.url)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'ASR_JOB_SUBMIT':
      // 第398次（阶段三2）：ASR 端点提交——content script 受页面 CSP 限制
      //   不能直连 backend，SW 代理 POST /api/asr/jobs（同 FETCH_SUBTITLE 的代理逻辑）；
      //   第443次（用户裁定）：第442次的 NM 唤起包装撤销，失败如实上抛不自动拉起
      submitAsrJobOnce(msg.url, msg.language)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'ASR_JOB_POLL':
      // 第398次：任务增量轮询——GET /api/asr/jobs/<id>?after=N（下载/转写进度+新增段）
      handleAsrJobPoll(msg.id, msg.after)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'YTDL_SUBTITLES':
      // 第399次：字幕 backend 兜底——扩展五路全失败后 SW 代理 GET /api/ytdl/subtitles
      handleYtdlSubtitles(msg.url, msg.lang)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    // === 第一百零九次 P3：chrome.scripting MAIN world 执行/注入 ===
    // 背景：内联 <script> 注入受页面 CSP 限制（B站若下发严格 CSP 则主世界读取静默失败，
    // 即调研文档 H1）。chrome.scripting 的 world:'MAIN' 不受页面 CSP 管，且能直接拿返回值。
    // 内容脚本经消息调用；Firefox 旧版无 world 选项时由调用方 catch 后走旧注入路径兜底。
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
      // content script 发来的 OCR 请求，转发给 offscreen 运行 Tesseract.js
      // 反思（2026-07-28）：content script 受页面 CSP 限制无法加载 CDN 脚本，
      //   OCR 需在 offscreen document 运行（扩展自身 CSP 已配置 cdn.jsdelivr.net）。
      // 反思（2026-08-16 第六十六次）：透传 lang（OCR 语言随 learnLanguage）。
      handleOcrRecognize(msg.imageDataUrl, msg.lang)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'PARSE_MATERIAL':
      // G4（2026-09-08）：网站 Creator 解析编排 —— vocabradar-bridge 转发的素材解析。
      // link → SW fetch HTML（host_permissions <all_urls>，不受页面 CSP 限制）
      //        → offscreen 用 main-text.extractDefuddleFromHtml 提取正文；
      // image → 复用 OCR_RECOGNIZE 链路（Tesseract/LLM 引擎按用户设定）；
      // 视频站链接 → 引导走扩展自身字幕/转写工作流（code:'video-link'）；
      // document → offscreen parse-doc 解析（B2：pdf/docx/epub，文件字节 b64 透传）；
      // 音频 kind → asr 分支实装（P 批起本地推理；312 批在线转写失败自动降级本地）。
      // 视频 kind → 引导走扩展字幕/转写工作流（code:'video-link'）；其余类型这里兜底明示错误（不静默）。
      handleParseMaterial(msg.kind, msg.payload)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'ASR_LLM_FILE':
      // 第二百一十五次：离线整段 LLM 转写（引导页上传原始文件一次请求，不本地解码分片）
      // 拆分修复（2026-09-27）：handler 改返回结果对象（原实现误用监听器形参 sendResponse，
      //   运行期 ReferenceError 恒失败），此处统一回包。
      handleAsrLlmFile(msg)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'FETCH_URL':
      // 反思（2026-08-09）：content script 受页面 CSP 限制无法 fetch CDN，
      //   diverse-lemmas 词典数据下载需经 SW 代理（SW 有 host_permissions <all_urls>）。
      handleFetchUrl(msg.url)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'FETCH_TEXT':
      // 257 次：Parser 链接抓取（guide 页 CSP connect-src 白名单不含任意站点，
      //   页面直 fetch 被拒——见 handleFetchText 头注释），返回纯文本。
      handleFetchText(msg.url)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'KURO_FETCH':
      // kuromoji 日语注音词典 CDN 中转（2026-09-08）：词典 12 个 .dat.gz 不随包，
      //   phonemize-ja.mjs（构建时 patch 过的 BrowserDictionaryLoader）经本消息请求，
      //   SW 代理 fetch 直传 ArrayBuffer（本地 Cache API 命中则直接回缓存，不发网络）。
      //   白名单/回退链/缓存见 handleKuroFetch。
      handleKuroFetch(msg.url)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'WF_FETCH':
      // wordfreq 词频数据 HF dataset 中转（2026-09-08）：42 语 small_*.msgpack.gz
      //   不随包，word-loader.js loadWordfreq 经本消息请求，SW 代理 fetch 并做
      //   files.json SHA-256 校验，直传 ArrayBuffer 回传。白名单/校验见 handleWfFetch。
      //   第二百四十七次：经 wfFetchMemoized 在途去重 + 30s 结果缓存（见 handleWfFetch 上方）。
      wfFetchMemoized(msg.file)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    // 第一百七十一次：Chat 面板的模型请求。content script 受宿主页面 CSP 限制无法直接
    //   fetch 第三方 API（与 FETCH_URL / OCR_RECOGNIZE 同因），统一由 SW 代理。
    case 'LLM_CHAT':
      handleLlmChat(msg.messages)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    // 第二百一十六次：翻译渠道的 LLM 文本翻译——**直接用聊天的 LLM 配置**（文本形态）
    case 'LLM_TRANSLATE':
      handleLlmTranslate(msg.text, msg.target)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    // 第一百七十一次：Chat 面板"打开设置配置模型"按钮 —— content script 无法开扩展页
    // 第二百七十次：扩展 OPEN_GUIDE——两侧栏 ⋯「停用本站」带 section:'deactivate'+
    //   pattern（当前域名），打开引导页时带 ?deactivate=<地址> 查询串，
    //   引导页 src/guide/deactivate.js 据此切设定栏/展开停用组/定位该地址行。
    case 'OPEN_GUIDE': {
      let guideUrl = chrome.runtime.getURL('src/guide/guide.html');
      if (msg && msg.section === 'deactivate') {
        guideUrl += '?deactivate=' + encodeURIComponent(String(msg.pattern || ''));
      }
      chrome.tabs.create({ url: guideUrl }).catch(() => {});
      sendResponse({ ok: true });
      return true;
    }
    // 反思（2026-08-12）：统一词典 WORD_DB_* 消息分发
    //   content script 通过 sendMessage 请求 SW 操作 IndexedDB（CS 的 IDB 按站点隔离）
    // 反思（2026-08-13 第五十二次）：词典缓存 DICT_CACHE_GET/SET 也走本分发，
    //   旧版只匹配 WORD_DB_ 前缀，DICT_CACHE_* 落入 sendResponse({ok:true})（无 cache 字段），
    //   导致每次刷新都"无词典缓存, 首次构建并写入缓存"。补上 DICT_CACHE_ 前缀。
    default:
      // 先尝试 WORD_DB_* / DICT_CACHE_* / LEMMAS_* / LEMMATIZE_* 消息
      // 反思（2026-08-16 第六十七次）：补上 LEMMATIZE_ 前缀——逐词词形还原消息，
      //   旧版只匹配前三个前缀，LEMMATIZE_WORD 会落入 sendResponse({ok:true})（无 lemma 字段）
      //   → 页面逐词词形还原永远返回原词。必须转发给 handleWordDbMessage。
      if (msg.type && (msg.type.startsWith('WORD_DB_') || msg.type.startsWith('DICT_CACHE_') || msg.type.startsWith('LEMMAS_') || msg.type.startsWith('LEMMATIZE_'))) {
        // 反思（2026-08-13 第四十七次）：handleWordDbMessage 是 async 函数，返回 Promise（truthy），
        //   旧版 `if (handled) return true` 恒成立，fallback sendResponse 永不执行。
        //   当 isSW=false 时 handleWordDbMessage 返回 false 且不调 sendResponse → 通道挂起。
        //   修正：直接调用并 return true 保持通道开放，.then 中检查 handled，
        //   false 时补发 sendResponse 错误响应。
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
