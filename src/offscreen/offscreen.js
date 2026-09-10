// Offscreen document：ASR whisper 识别
// 音频捕获重构（2026-07-04）：
//   旧方案：offscreen 用 tabCapture + getUserMedia + AudioContext 采集音频。
//   新方案：音频采集移至 content script（AudioContext + MediaElementAudioSourceNode），
//   offscreen 只负责接收音频段、运行 whisper 识别、回传文本。
//   好处：消除 tabCapture 静音副作用；offscreen 大幅简化。
//
// 流程：
//   content script 采集音频段 → SW 转发 OFFSCREEN_ASR_RECOGNIZE → offscreen 用 whisper 识别
//   → 回传 ASR_SEGMENT（经 SW 中转给 content script）
//
// 为什么仍需要 offscreen：content script 受页面 CSP 限制，B站/YouTube 的 CSP
// 可能阻止 wasm-unsafe-eval，而 transformers.js/onnxruntime-web 依赖 WASM。
// offscreen 使用扩展自身的 CSP（manifest 中配置了 wasm-unsafe-eval），可正常运行。
//
// 修复历史（2026-07-03）：
//   1. asrSegmentSec 不生效：loadConfig() 在模块顶层异步调用但 startRecognition
//      不 await 它。修正：startRecognition 内 await loadConfig() 确保配置就绪。
//   2. 首段时间错误：_segStart 初始值为 0。修正：startRecognition 内初始化 _segStart。

let _whisper = null;       // whisper pipeline
let _whisperPromise = null;
let _running = false;
let _videoKey = '';
// 反思（2026-07-06）：用户反馈高频日志刷屏。pushStatus 无条件 console.log，
// ASR 运行时每段状态更新都打印。修正：仅 debug=true 时打印状态日志。
let _debug = false;
const SAMPLE_RATE = 16000;
// 识别分段长度（秒）：从 config.json 读取，默认 3 秒
// 用于 whisper chunk_length_s 参数（实际段长由 content script 控制）
let _segmentSec = 3;
// ASR 模型大小：tiny/base/small/turbo，从 storage 读取
// 反思（2026-07-09 #69）：用户要求「设定中可选模型大小」。
//   旧版硬编码 whisper-tiny，无法切换。修正：从 storage.local 读取 asrModelSize，
//   动态构建模型名，缓存检测和日志同步使用。
// 反思（2026-07-26）：用户要求"再加上v3 turbo"。候选项扩展为 tiny/base/small/turbo。
//   turbo 用 onnx-community/whisper-large-v3-turbo（Xenova 命名空间无 turbo 转换）。
let _modelSize = 'tiny';

// 反思（2026-08-09 第八次）：用户要求"模型候选项要全，包括英文专用"。
//   候选项扩展为：tiny/tiny.en/base/base.en/small/small.en/medium/medium.en/large-v3/turbo
//   英文专用模型（.en 后缀）仅识别英文，但对英文更准确，体积相同。
//   turbo 用 onnx-community 命名空间，large-v3 用 Xenova 命名空间。
// 支持的模型列表
const SUPPORTED_MODELS = ['tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en', 'medium', 'medium.en', 'large-v3', 'turbo'];

// 模型名构建
function getModelName(size) {
  if (size === 'turbo') return 'onnx-community/whisper-large-v3-turbo';
  return 'Xenova/whisper-' + size;
}
// 缓存检测关键词：与模型 URL 路径片段一致
function getCachePattern(size) {
  if (size === 'turbo') return 'whisper-large-v3-turbo';
  return 'whisper-' + size;
}

// 时间戳辅助：所有日志带 HH:MM:SS.mmm 便于诊断时序问题
function _ts() {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// 状态推送：把 offscreen 内部状态通过 ASR_STATUS 转发到页面 toast，便于无控制台诊断
function pushStatus(stage, info) {
  if (_debug) console.log('[VocabRadar][offscreen][' + _ts() + '] 状态:', stage, info || '');
  chrome.runtime.sendMessage({
    type: 'ASR_STATUS',
    status: 'stage',
    stage,
    info: info || ''
  }).catch(() => { /* ignore */ });
}

// 加载配置（asrSegmentSec 等）
// 优先级：chrome.storage.local（popup 设置）> config.json（默认）> 代码默认值(3)
async function loadConfig() {
  try {
    // 1. config.json 默认值
    const url = chrome.runtime.getURL('src/data/config.json');
    const res = await fetch(url);
    const fileCfg = await res.json();
    _debug = fileCfg.debug === true;
    if (fileCfg.asrSegmentSec && fileCfg.asrSegmentSec > 0) {
      _segmentSec = fileCfg.asrSegmentSec;
    }
    // 2. storage 覆盖（popup 用户设置优先）
    if (chrome?.storage?.local) {
      const stored = await new Promise((r) => chrome.storage.local.get(['asrSegmentSec', 'asrModelSize'], r));
      if (stored.asrSegmentSec && stored.asrSegmentSec > 0) {
        _segmentSec = stored.asrSegmentSec;
      }
      if (stored.asrModelSize && SUPPORTED_MODELS.includes(stored.asrModelSize)) {
        _modelSize = stored.asrModelSize;
      }
    }
    console.log('[VocabRadar][offscreen][' + _ts() + '] 配置加载: asrSegmentSec=' + _segmentSec + 's asrModelSize=' + _modelSize);
  } catch (e) {
    console.warn('[VocabRadar][offscreen][' + _ts() + '] 配置加载失败，使用默认值:', e.message);
  }
}

// 监听 storage 变化：popup 改 asrSegmentSec/asrModelSize 时即时生效
if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.asrSegmentSec && changes.asrSegmentSec.newValue > 0) {
      _segmentSec = changes.asrSegmentSec.newValue;
      console.log('[VocabRadar][offscreen][' + _ts() + '] asrSegmentSec 变更生效: ' + _segmentSec + 's');
    }
    // 反思（2026-07-14）：用户要求「切换模型，自然asr要重新识别」。
    //   旧版只更新变量并打印日志，但 _whisper 实例不会自动切换，需手动重启 ASR。
    //   修正：模型大小变更时，清除旧 _whisper 和 _whisperPromise，下次 getWhisper() 会加载新模型。
    //   如果 ASR 正在运行，通知 content script 重启以触发新模型加载。
    if (changes.asrModelSize && SUPPORTED_MODELS.includes(changes.asrModelSize.newValue)) {
      const oldModel = _modelSize;
      _modelSize = changes.asrModelSize.newValue;
      console.log('[VocabRadar][offscreen][' + _ts() + '] asrModelSize 变更: ' + oldModel + ' → ' + _modelSize);
      // 清除旧模型实例，强制下次加载新模型
      if (_whisper || _whisperPromise) {
        console.log('[VocabRadar][offscreen][' + _ts() + '] 清除旧 whisper 实例，下次识别将加载新模型');
        _whisper = null;
        _whisperPromise = null;
      }
      // 如果 ASR 正在运行，通知重启
      if (_running) {
        console.log('[VocabRadar][offscreen][' + _ts() + '] ASR 运行中，通知重启以加载新模型');
        chrome.runtime.sendMessage({
          type: 'ASR_STATUS',
          status: 'model-changed',
          info: '模型已切换为 ' + _modelSize + '，请重启 ASR'
        }).catch(() => { /* ignore */ });
      }
    }
  });
}
loadConfig();

// === 消息入口 ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  // 第一百七十九次（用户报障：火狐 "ASR start failed in service worker: no response"）：
  //   就绪探针。Firefox 无 chrome.offscreen，whisper 宿主是页面内隐藏 iframe（本页）。
  //   旧版创建方只等 iframe 的 load 事件（或 4s 超时）就回报 ok，而本文件是 ES module，
  //   下面这个 onMessage 监听器要等模块求值到此行才注册；SW 紧接着广播的
  //   OFFSCREEN_ASR_START 可能无人应答 → SW 侧 sendMessage reject → resp=null →
  //   error 为 null → 客户端拼出兜底文案 "no response"。
  //   修正：本端提供 OFFSCREEN_PING（能应答即说明监听器已注册），SW 轮询到 ok 后才发 START。
  if (msg.type === 'OFFSCREEN_PING') {
    sendResponse({ ok: true, ready: true, running: _running });
    return true;
  }
  if (msg.type === 'OFFSCREEN_ASR_START') {
    // 初始化识别（不再有 streamId，音频由 content script 采集）
    startRecognition(msg.videoKey).then(() => {
      sendResponse({ ok: true });
    }).catch((e) => {
      console.warn('[VocabRadar][offscreen][' + _ts() + '] ASR 启动失败:', e);
      chrome.runtime.sendMessage({ type: 'ASR_ERROR', videoKey: _videoKey, error: String(e.message || e) }).catch(() => { /* ignore */ });
      sendResponse({ ok: false, error: String(e.message || e) });
    });
    return true;
  }
  if (msg.type === 'OFFSCREEN_ASR_STOP') {
    stopRecognition();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'OFFSCREEN_ASR_RECOGNIZE') {
    // 接收 content script 采集的音频段，送 whisper 识别
    // 反思（2026-07-04）：旧版 ArrayBuffer 经 SW 中继丢失（samples=0），曾改普通 Array。
    // 反思（第九十八次实测复发）：samples=0 再现——ArrayBuffer 双跳中继在部分环境不可靠。
    //   发送端现同时携带 audio(快路径) 与 audioB64(base64 可靠通道)，
    //   本端优先快路径、缺失/为空自动落 base64，并打印实际采用通道便于诊断。
    let audioData = null;
    let src = 'none';
    if (Array.isArray(msg.audio) && msg.audio.length > 0) {
      audioData = new Float32Array(msg.audio);
      src = 'array';
    } else if (msg.audio instanceof ArrayBuffer && msg.audio.byteLength > 0) {
      audioData = new Float32Array(msg.audio);
      src = 'arraybuffer';
    } else if (typeof msg.audioB64 === 'string' && msg.audioB64.length > 0) {
      try {
        const bin = atob(msg.audioB64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        audioData = new Float32Array(u8.buffer);
        src = 'base64(' + Math.round(msg.audioB64.length / 1024) + 'KB)';
      } catch (e) {
        console.warn('[VocabRadar][offscreen][' + _ts() + '] base64 解码失败:', e);
      }
    }
    if (!audioData || audioData.length === 0) {
      console.warn('[VocabRadar][offscreen][' + _ts() + '] OFFSCREEN_ASR_RECOGNIZE 音频缺失: msgKeys=' +
        Object.keys(msg || {}).join(',') + ' audioType=' + (msg ? typeof msg.audio : 'n/a'));
    }
    console.log('[VocabRadar][offscreen][' + _ts() + '] OFFSCREEN_ASR_RECOGNIZE: ch=' + src + ' samples=' + (audioData ? audioData.length : 0) + ' returnTimestamps=' + !!msg.returnTimestamps);
    recognizeAndSend(audioData || new Float32Array(0), msg.start, msg.end, msg.videoKey, msg.returnTimestamps || false, src);
    sendResponse({ ok: true });
    return true;
  }
  // OCR 识别：接收 content script 截取的视频帧 dataUrl，用 Tesseract.js 识别
  // 反思（2026-07-28）：旧版在 content script 中直接创建 <script> 加载 Tesseract.js，
  //   受页面 CSP 限制（B站/YouTube 的 script-src 不允许 cdn.jsdelivr.net）导致加载失败。
  //   修正：OCR 移到 offscreen document 运行，使用扩展自身 CSP（已配置 cdn.jsdelivr.net）。
  //   反思（2026-07-28 二次）：CSP script-src 原本只有 'self'，不允许 CDN 脚本加载。
  //   修正：manifest.json CSP 的 script-src 添加 https://cdn.jsdelivr.net。
  //   日志策略：全链路打印详细日志（dataUrl 长度、加载耗时、识别耗时、结果长度），
  //   toast 只在真正错误时提示用户。
  if (msg.type === 'OFFSCREEN_OCR') {
    const _ocrStart = Date.now();
    console.log('[VocabRadar][offscreen][' + _ts() + '] OFFSCREEN_OCR 收到请求, dataUrl 长度=' + (msg.imageDataUrl || '').length + ', lang=' + msg.lang);
    runOcr(msg.imageDataUrl, msg.lang).then((text) => {
      const _ocrCost = ((Date.now() - _ocrStart) / 1000).toFixed(2);
      console.log('[VocabRadar][offscreen][' + _ts() + '] OCR 完成, 耗时=' + _ocrCost + 's, 结果长度=' + (text || '').length + ', 前50字=' + JSON.stringify((text || '').slice(0, 50)));
      sendResponse({ ok: true, text: text || '' });
    }).catch((e) => {
      const _ocrCost = ((Date.now() - _ocrStart) / 1000).toFixed(2);
      console.warn('[VocabRadar][offscreen][' + _ts() + '] OCR 失败, 耗时=' + _ocrCost + 's, error=', e, 'stack=', e && e.stack);
      sendResponse({ ok: false, error: String(e.message || e) });
    });
    return true;
  }
  // === G4（2026-09-08）：网页正文提取（网站 Creator 解析编排用） ===
  // SW fetch 到 HTML 后转发到这里，用 main-text.js 的 extractDefuddleFromHtml 提取正文。
  // 本文件是 ES module（offscreen.html 以 type="module" 加载），可加载 main-text.js；
  // main-text 顶层无 DOM 副作用（全为常量/函数定义），offscreen document 提供 DOMParser。
  // 动态 import：Defuddle/vendor 仅在首次链接解析时加载，ASR 旧路径零影响。
  if (msg.type === 'OFFSCREEN_EXTRACT_TEXT') {
    const _extStart = Date.now();
    console.log('[VocabRadar][offscreen][' + _ts() + '] OFFSCREEN_EXTRACT_TEXT 收到请求, html 长度=' + (msg.html || '').length);
    extractFromHtml(msg.html, msg.baseUrl).then((r) => {
      const _extCost = ((Date.now() - _extStart) / 1000).toFixed(2);
      console.log('[VocabRadar][offscreen][' + _ts() + '] 正文提取完成, 耗时=' + _extCost + 's, 文本长度=' + (r.text || '').length);
      sendResponse(r);
    }).catch((e) => {
      console.warn('[VocabRadar][offscreen][' + _ts() + '] 正文提取失败:', e);
      sendResponse({ ok: false, error: String(e.message || e) });
    });
    return true;
  }
  return false;
});

// === G4：网页正文提取（main-text.js 唯一实现的参数化入口） ===
// 提取结果为空按失败回报（明示，不静默给空文本）——页面可能需要登录或无正文。
async function extractFromHtml(html, baseUrl) {
  const mod = await import('../lib/main-text.js');
  const r = await mod.extractDefuddleFromHtml(html, baseUrl);
  if (!r || !r.text || !r.text.trim()) {
    throw new Error('extracted text is empty (page may require login or have no article body)');
  }
  return { ok: true, text: r.text, title: r.title || '' };
}

// === OCR 识别（Tesseract.js）===
// 反思（2026-07-28）：content script 受页面 CSP 限制无法加载 CDN 脚本，
//   OCR 移到 offscreen 运行。
//   反思（2026-07-28 二次）：MV3 CSP 的 script-src 不允许外部域名（https://cdn.jsdelivr.net），
//   只有 'self' 和 'wasm-unsafe-eval'。修正：tesseract.min.js 下载到 vendor 目录本地加载，
//   worker 用 blob URL（CSP 添加 worker-src 'self' blob:），
//   corePath/langPath 从 CDN fetch（connect-src 已包含 cdn.jsdelivr.net）。
// 反思（2026-08-05 修正）：用户反馈 OCR 失败 "NetworkError: Failed to execute 'importScripts'
//   on 'WorkerGlobalScope': tesseract-core-simd-lstm.wasm.js failed to load"。
//   根因：jsdelivr CDN 在用户网络环境不可达（中国网络限制），worker 无法 importScripts 核心。
//   修正：tesseract.js-core 和语言数据（eng/chi_sim traineddata）全部本地化到 vendor 目录，
//   corePath/langPath 指向 chrome-extension:// 本地路径，彻底脱离 CDN 依赖。
//   语言数据使用 4.0.0_best_int 版本（integer 量化，体积小：eng 2.8MB + chi_sim 1.6MB）。
//   日志策略：全链路打印（加载、worker 创建、识别、终止），便于诊断问题。
// 反思（2026-09-07）：tessdata 语言包按用户指令改为多 CDN 回退链加载，本地
//   vendor/tessdata 已删除（包体 -7.3MB）。回退链按实测可达性排序，前三源为
//   jsDelivr 同一仓库的多域名镜像（tessdata_fast@4.0.0，裸 .traineddata，gzip:false），
//   尾源为 tesseract.js 官方 CDN（.traineddata.gz，gzip:true，需解压）：
//     cdn.jsdelivr.net → fastly.jsdelivr.net → gcore.jsdelivr.net
//     → tessdata.projectnaptha.com/4.0.0
//   任一源 createWorker 失败即换下一源，全链失败才向上抛错（日志逐源打印，不静默）。
//   已知局限：createWorker 失败时其内部半途 worker 无引用可 terminate，可能泄漏一个
//   空 worker（不阻塞后续重建，如实记录）；完全离线时 OCR 不可用（此前本地包可离线）。
let _tesseractWorker = null;
let _tesseractLang = null;

// tessdata CDN 回退链。langPath 与 gzip 必须成对：jsDelivr 镜像是裸 traineddata
// （文件名 <lang>.traineddata），projectnaptha 是 gzip 包（<lang>.traineddata.gz），
// 两者的请求文件名与解压行为都不同。
const TESSDATA_SOURCES = [
  { name: 'cdn.jsdelivr.net', langPath: 'https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@4.0.0', gzip: false },
  { name: 'fastly.jsdelivr.net', langPath: 'https://fastly.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@4.0.0', gzip: false },
  { name: 'gcore.jsdelivr.net', langPath: 'https://gcore.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@4.0.0', gzip: false },
  { name: 'tessdata.projectnaptha.com', langPath: 'https://tessdata.projectnaptha.com/4.0.0', gzip: true },
];

// 42 语 → Tesseract 语言代码全表（2026-09-08 放开，用户："放开全部 OCR 语言映射"）。
// tessdata_fast 4.0.0 覆盖全部 42 个 tess 代码，走上方 TESSDATA_SOURCES 的 CDN 回退链
// 按需拉取。键是 learnLanguage/界面语言代码，值是 tess 代码；与 guide.js 的
// TESS_LANG_CODES 内容一致（两处同步维护，改动须双向核对）。
const TESS_LANG_MAP = {
  ar: 'ara', bg: 'bul', bn: 'ben', ca: 'cat', cs: 'ces', da: 'dan', de: 'deu', el: 'ell',
  en: 'eng', es: 'spa', fa: 'fas', fi: 'fin', fil: 'fil', fr: 'fra', he: 'heb', hi: 'hin',
  hu: 'hun', id: 'ind', is: 'isl', it: 'ita', ja: 'jpn', ko: 'kor', lt: 'lit', lv: 'lav',
  mk: 'mkd', ms: 'msa', nb: 'nor', nl: 'nld', pl: 'pol', pt: 'por', ro: 'ron', ru: 'rus',
  sh: 'hrv', sk: 'slk', sl: 'slv', sv: 'swe', ta: 'tam', tr: 'tur', uk: 'ukr', ur: 'urd',
  vi: 'vie', zh: 'chi_sim',
};
// 合法 tess 代码白名单（TESS_LANG_MAP 的值域）——校验请求串防任意语言注入 createWorker
const TESS_VALID_CODES = new Set(Object.values(TESS_LANG_MAP));

/**
 * 归一 OCR 语言请求 → Tesseract 语言串
 * 反思（2026-08-16 第六十六次）：OCR 语言随 learnLanguage——旧实现只有两档
 *   （zh 开头→chi_sim，其余→eng），且实际传入的是引导页勾选并集串（tess 代码形态，
 *   如 'eng+chi_sim'），'chi_sim' 不以 zh 开头被误归 'eng'——只勾中文时识别语言
 *   仍是英文的隐藏 bug。2026-09-08 改全表映射后一并修复。
 * 输入两种形态：tess 代码串（SW 从 storage.ocrLanguages 收集的勾选并集，
 *   如 'eng+chi_sim'、'jpn'），或语言代码（'ja'/'zh'——语义上 learnLanguage 直传）。
 * 规则：按 '+' 逐段——TESS_LANG_MAP 键命中翻译成 tess 代码；已是合法 tess 代码
 *   （TESS_VALID_CODES）原样保留；'zh' 变体（zh-TW 等）回落 chi_sim；沾不上的段
 *   丢弃（不猜语言，勾选态由引导页保证）。去重保持顺序。全空返回 null（调用方
 *   回落 'eng+chi_sim' 旧行为）。
 * @param {string} [lang]
 * @returns {string|null} '+' 连接的 tess 语言串；null 表示无可识别语言（回落默认）
 */
function resolveTessLang(lang) {
  if (!lang) return null;
  const parts = String(lang).toLowerCase().split('+');
  const out = [];
  const push = (code) => { if (!out.includes(code)) out.push(code); };
  for (const p of parts) {
    if (!p) continue;
    if (TESS_LANG_MAP[p]) { push(TESS_LANG_MAP[p]); continue; }
    if (TESS_VALID_CODES.has(p)) { push(p); continue; }
    if (p.startsWith('zh')) push('chi_sim');
    // 其余未知段丢弃：createWorker 只接受白名单内语言，宁可少识别也不让 worker 加载失败
  }
  return out.length > 0 ? out.join('+') : null;
}

async function getOcrWorker(lang) {
  const langKey = resolveTessLang(lang) || 'eng+chi_sim';
  // 语言未变化且 worker 已就绪：直接复用
  if (_tesseractWorker && _tesseractLang === langKey) {
    console.log('[VocabRadar][offscreen][' + _ts() + '] OCR worker 内存复用 (lang=' + langKey + ')');
    return _tesseractWorker;
  }
  // 语言变化：终止旧 worker 重建（如 en → zh 切换）
  if (_tesseractWorker) {
    try {
      await _tesseractWorker.terminate();
      console.log('[VocabRadar][offscreen][' + _ts() + '] OCR 语言变化, 旧 worker 已终止 (' + _tesseractLang + ' → ' + langKey + ')');
    } catch (e) { /* 终止失败忽略 */ }
    _tesseractWorker = null;
  }
  // 本地加载 Tesseract.js（vendor/tesseract/ 子目录，符合 script-src 'self'）。
  // 反思（2026-09-08 第二百三十九次）："OCR failed: Tesseract.js 本地加载失败"根因——
  //   vendor 平铺重构把 tesseract 六件套移入 tesseract/ 子目录（单文件库才平铺顶层，
  //   多文件功能保留子目录），本文件三处路径漏加 /tesseract/ 段 → script 404 →
  //   onerror reject。修正三处路径（不加 CDN 回退：本地 vendor 资源自包含）。
  if (!window.Tesseract) {
    const _loadStart = Date.now();
    const tessUrl = chrome.runtime.getURL('src/lib/vendor/tesseract/tesseract.min.js');
    console.log('[VocabRadar][offscreen][' + _ts() + '] 加载本地 Tesseract.js: ' + tessUrl);
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = tessUrl;
      script.onload = () => {
        console.log('[VocabRadar][offscreen][' + _ts() + '] Tesseract.js 加载成功, 耗时=' + ((Date.now() - _loadStart) / 1000).toFixed(2) + 's');
        resolve();
      };
      script.onerror = (e) => {
        console.warn('[VocabRadar][offscreen][' + _ts() + '] Tesseract.js 加载失败, 耗时=' + ((Date.now() - _loadStart) / 1000).toFixed(2) + 's, error=', e);
        reject(new Error('Failed to load Tesseract.js locally'));
      };
      document.head.appendChild(script);
    });
  } else {
    console.log('[VocabRadar][offscreen][' + _ts() + '] Tesseract.js 已在内存中');
  }
  // 创建 OCR worker：
  // 反思（2026-07-28）：Tesseract.js 默认 workerBlobURL=true 会创建 blob URL worker，
  //   被 MV3 CSP 阻止（worker-src 不允许 blob:）。修正：workerBlobURL=false，
  //   workerPath 指定本地路径，new Worker(chrome-extension://...) 符合 script-src 'self'。
  // 反思（2026-09-07）：langPath 不再指向本地 vendor/tessdata（已删），改为按
  //   TESSDATA_SOURCES 顺序逐源 createWorker，失败换下一源（详见上方反思注释）。
  // 反思（2026-08-16 第六十六次）：语言包随 learnLanguage（eng / chi_sim），非固定双语言。
  // 反思（2026-09-04）：tessdata 已真解压为 .traineddata（Edge 拒绝包内 .gz 文件），
  //   jsDelivr 源须传 gzip:false 按裸文件 fetch 且跳过 gunzip；projectnaptha 源为
  //   .traineddata.gz，须传 gzip:true。
  console.log('[VocabRadar][offscreen][' + _ts() + '] 创建 OCR worker (lang=' + langKey + ', 本地 core, tessdata 走 CDN 回退链, workerBlobURL=false)');
  const _workerStart = Date.now();
  let _lastSrcErr = null;
  for (const _src of TESSDATA_SOURCES) {
    try {
      console.log('[VocabRadar][offscreen][' + _ts() + '] 尝试 tessdata 源: ' + _src.name + ' (gzip=' + _src.gzip + ')');
      _tesseractWorker = await Tesseract.createWorker(langKey, 1, {
        workerPath: chrome.runtime.getURL('src/lib/vendor/tesseract/tesseract-worker.min.js'),
        workerBlobURL: false,
        corePath: chrome.runtime.getURL('src/lib/vendor/tesseract'),
        langPath: _src.langPath,
        gzip: _src.gzip,
        logger: (m) => {
          if (m && m.status) {
            console.log('[VocabRadar][offscreen][' + _ts() + '] Tesseract: ' + m.status + (m.progress !== undefined ? ' ' + (m.progress * 100).toFixed(0) + '%' : ''));
          }
        }
      });
      console.log('[VocabRadar][offscreen][' + _ts() + '] tessdata 源成功: ' + _src.name + ', worker 创建总耗时=' + ((Date.now() - _workerStart) / 1000).toFixed(2) + 's');
      break;
    } catch (_srcErr) {
      _lastSrcErr = _srcErr;
      console.warn('[VocabRadar][offscreen][' + _ts() + '] tessdata 源失败: ' + _src.name + ', error=', _srcErr, '— 换下一源');
      if (_tesseractWorker) {
        try {
          await _tesseractWorker.terminate();
        } catch (_termErr) { /* 终止失败忽略 */ }
        _tesseractWorker = null;
      }
    }
  }
  if (!_tesseractWorker) {
    throw new Error('All tessdata CDN sources failed (' + TESSDATA_SOURCES.map((s) => s.name).join(' -> ') + '): ' + String((_lastSrcErr && _lastSrcErr.message) || _lastSrcErr));
  }
  _tesseractLang = langKey;
  return _tesseractWorker;
}

async function runOcr(imageDataUrl, lang) {
  console.log('[VocabRadar][offscreen][' + _ts() + '] runOcr 开始, dataUrl 长度=' + imageDataUrl.length + ', lang=' + lang);
  const worker = await getOcrWorker(lang);
  const _recogStart = Date.now();
  const result = await worker.recognize(imageDataUrl);
  console.log('[VocabRadar][offscreen][' + _ts() + '] worker.recognize 完成, 耗时=' + ((Date.now() - _recogStart) / 1000).toFixed(2) + 's');
  return result.data.text;
}

// === 加载 whisper pipeline（懒加载单例） ===
// vendor/transformers.min.js 是完整的 ESM bundle（自包含 onnxruntime-web，末尾有 export{}）。
// 反思（2026-07-05）：
//   1. transformers.js 自己管理 Cache API 缓存（useBrowserCache=true），无需手动诊断。
//   2. 下载源默认用 https://hf-mirror.com（海内外都可用，国内不被墙）。
//   3. 进度回调限流：仅进度变化≥10%或新文件时打印，避免 1ms 间隔刷屏。
//
// 反思（2026-07-05 第二次）：用户反馈"为啥每次启动都要下载模型？每间隔几十毫秒就打印进度"。
//   调研 transformers.js 源码（transformers.mjs 第 22961-23005 行）发现：
//   即使 Cache API 命中（cacheHit=true），transformers.js 在 Chrome 中仍会逐块读取
//   Response body 并触发 progress 回调（仅 Firefox 跳过缓存命中的进度回调）。
//   缓存命中时读取极快，每文件几毫秒内 0%→100%，6+ 文件导致几十毫秒刷一次屏。
//   修正：pipeline() 前手动检查 Cache API 是否已有模型主文件，缓存命中时完全抑制
//   progress 回调；未缓存时改用时间限流（每文件至少 3 秒间隔）。
//
// 反思（2026-08-08）：用户反馈"asr经常几秒就停止"。
//   根因：getWhisper 失败时直接发 ASR_ERROR + 重新抛出，recognizeAndSend catch
//   到后 isFatal=true（消息含"模型加载失败"）再发 ASR_ERROR，content script 收到
//   后 _asrAborted=true 立即中断循环。任何瞬时网络错误都会导致 ASR 几秒停止。
//   修正：(1) getWhisper 内部加重试机制（3 次，间隔 3 秒），重试期间不发 ASR_ERROR；
//   (2) getWhisper 失败后只 throw，不发 ASR_ERROR（由 recognizeAndSend 统一处理）；
//   (3) recognizeAndSend 新增 _modelFailCount，连续 3 次模型失败才发 ASR_ERROR，
//   否则发空 ASR_SEGMENT 让循环继续（下一段会再次调 getWhisper 重试）。

// 模型连续失败计数器（recognizeAndSend 用，成功时重置为 0）
let _modelFailCount = 0;

/**
 * 校验模型设置是否变化（2026-08-21 第八十九次）：用户反馈"切换了asr模型，识别依旧用旧的"。
 *   onChanged 监听依赖事件送达；若错过（如 offscreen 重建竞态），旧实例会一直用到会话结束。
 *   修正：每次识别段前直接读 storage 比对，发现变更立即切换（清旧实例，本段即用新模型）。
 */
async function ensureModelCurrent() {
  try {
    if (!chrome?.storage?.local) return;
    const stored = await new Promise((r) => chrome.storage.local.get(['asrModelSize'], r));
    const want = (stored.asrModelSize && SUPPORTED_MODELS.includes(stored.asrModelSize)) ? stored.asrModelSize : null;
    if (want && want !== _modelSize) {
      console.log('[VocabRadar][offscreen][' + _ts() + '] 识别前校验: 模型变更 ' + _modelSize + ' → ' + want + '，清除旧实例');
      _modelSize = want;
      _whisper = null;
      _whisperPromise = null;
    }
  } catch (e) { /* 读取失败沿用当前模型 */ }
}

async function getWhisper() {
  if (_whisper) {
    console.log('[VocabRadar][offscreen][' + _ts() + '] whisper 内存复用（offscreen 未销毁）');
    return _whisper;
  }
  if (_whisperPromise) {
    console.log('[VocabRadar][offscreen][' + _ts() + '] whisper 加载中（等待 promise）');
    return _whisperPromise;
  }
  _whisperPromise = (async () => {
    try {
    console.log('[VocabRadar][offscreen][' + _ts() + '] caches 可用:', typeof caches !== 'undefined');
    const tfUrl = chrome.runtime.getURL('src/lib/vendor/transformers.min.js');
    console.log('[VocabRadar][offscreen][' + _ts() + '] 加载 transformers.min.js (ESM):', tfUrl);
    const mod = await import(tfUrl);
    const pipeline = mod.pipeline;
    if (!pipeline) throw new Error('transformers.pipeline not found (unexpected ESM exports)');
    console.log('[VocabRadar][offscreen][' + _ts() + '] transformers ESM 已就绪, env=', !!mod.env);

    // 配置下载源 + ONNX wasm
    // hfHost 提到 if 块外声明，供后续缓存检测代码使用
    let hfHost = 'https://hf-mirror.com';
    if (mod.env) {
      mod.env.allowLocalModels = false;
      mod.env.useBrowserCache = true;  // transformers.js 自己管理 Cache API 缓存
      // 下载源：默认 hf-mirror.com（海内外都可用），用户可在 popup 覆盖
      try {
        if (chrome?.storage?.local) {
          const cfg = await new Promise((r) => chrome.storage.local.get(['asrHfMirror'], r));
          if (cfg && cfg.asrHfMirror) hfHost = cfg.asrHfMirror;
        }
      } catch (e) { /* ignore */ }
      mod.env.remoteHost = hfHost;
      console.log('[VocabRadar][offscreen][' + _ts() + '] 下载源:', hfHost);
      try {
        const onnxBackend = mod.env.backends && mod.env.backends.onnx;
        if (onnxBackend && onnxBackend.wasm) {
          onnxBackend.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/';
          onnxBackend.wasm.numThreads = 1;
        }
      } catch (e) { /* ignore */ }
    }

    // === 缓存检测：pipeline() 前手动检查 Cache API 是否已有模型主文件 ===
    // transformers.js 在 Chrome 中即使缓存命中也会触发 progress 回调（逐块读取 body），
    // 导致用户误以为"每次启动都下载模型"。此处预检：若主文件已缓存，抑制 progress 回调。
    // 反思（2026-07-07）：旧版用构造的精确 URL 做 cache.match，但 transformers.js
    // 实际请求的 URL 可能因 redirect 或路径差异与构造的不一致，导致预检误判为未缓存，
    // progress 回调未被抑制，用户看到进度日志误以为"每次都下载"。
    // 改进：遍历 cache.keys()，只要存在模型相关条目即视为缓存命中。
    //   turbo 的缓存关键词为 whisper-large-v3-turbo（onnx-community 命名空间）。
    let _modelCached = false;
    const cachePattern = getCachePattern(_modelSize);
    const modelRegex = new RegExp(cachePattern, 'i');
    if (typeof caches !== 'undefined') {
      try {
        const cache = await caches.open('transformers-cache');
        const keys = await cache.keys();
        _modelCached = keys.some((req) => modelRegex.test(req.url));
        console.log('[VocabRadar][offscreen][' + _ts() + '] Cache API 预检: ' + keys.length + ' 条缓存，' + cachePattern + ' ' + (_modelCached ? '已缓存（将静默加载）' : '未缓存（需网络下载）'));
      } catch (e) {
        console.warn('[VocabRadar][offscreen][' + _ts() + '] Cache API 预检失败:', e.message);
      }
    }

    const modelName = getModelName(_modelSize);
    pushStatus('Model load', _modelCached ? ('loading ' + modelName + ' (cache hit)') : ('loading ' + modelName + ' (download needed)'));
    console.log('[VocabRadar][offscreen][' + _ts() + '] 开始加载 ' + modelName + ', cached=' + _modelCached);
    const _modelLoadStart = Date.now();
    // 进度限流：时间限流，每文件至少 3 秒间隔（仅未缓存时生效）
    const _lastProgress = {};  // {fileName: {pct, time}}
    // 反思（2026-08-08）：加重试机制（3 次，间隔 3 秒），避免瞬时网络错误导致永久失败。
    //   旧版 pipeline() 失败直接抛出 → _whisperPromise reject → 后续调用返回同一 rejected promise。
    //   修正：循环重试 3 次，每次失败后等待 3 秒再重试。3 次全部失败才抛出。
    let _pipelineError = null;
    for (let _attempt = 1; _attempt <= 3; _attempt++) {
      try {
        _whisper = await pipeline('automatic-speech-recognition', modelName, {
          quantized: true,
          progress_callback: (p) => {
            if (p && p.status === 'ready') {
              console.log('[VocabRadar][offscreen][' + _ts() + '] 模型就绪');
              chrome.runtime.sendMessage({ type: 'ASR_STATUS', status: 'ready' }).catch(() => { /* ignore */ });
              return;
            }
            // 缓存命中时静默：transformers.js 在 Chrome 中即使缓存命中也会逐块读取
            // Response body 并触发 progress 回调，这并非真正下载，抑制以避免刷屏。
            if (_modelCached) return;
            if (p && p.status === 'progress' && p.file) {
              const pct = p.progress || 0;
              const now = Date.now();
              const last = _lastProgress[p.file] || { pct: 0, time: 0 };
              // 时间限流：每文件至少 3 秒间隔，或首条（time=0），或达到 100%
              if (last.time === 0 || now - last.time >= 3000 || pct >= 100) {
                _lastProgress[p.file] = { pct, time: now };
                console.log('[VocabRadar][offscreen][' + _ts() + '] 模型下载', p.file, pct.toFixed(0) + '%');
                chrome.runtime.sendMessage({
                  type: 'ASR_STATUS',
                  status: 'loading',
                  file: p.file,
                  progress: pct
                }).catch(() => { /* ignore */ });
              }
            }
          }
        });
        // pipeline 成功，跳出重试循环
        _pipelineError = null;
        break;
      } catch (e) {
        _pipelineError = e;
        console.warn('[VocabRadar][offscreen][' + _ts() + '] pipeline 第 ' + _attempt + '/3 次失败:', e.message || e);
        if (_attempt < 3) {
          pushStatus('Model retry', 'attempt ' + _attempt + ' failed, retrying in 3s');
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
    // 3 次重试全部失败
    if (_pipelineError) {
      throw _pipelineError;
    }
    const _modelLoadTotal = ((Date.now() - _modelLoadStart) / 1000).toFixed(1);
    // 缓存命中时 loadType 由预检结果决定，不再仅凭耗时猜测
    const loadType = _modelCached ? '缓存命中' : (parseFloat(_modelLoadTotal) < 3 ? '缓存命中(推测)' : '网络下载');
    console.log('[VocabRadar][offscreen][' + _ts() + '] whisper pipeline 就绪, 总耗时 ' + _modelLoadTotal + 's (' + loadType + ')');
    // 模型加载成功，重置失败计数器
    _modelFailCount = 0;
    return _whisper;
    } catch (e) {
      // 反思（2026-08-08）：不在 getWhisper 中发 ASR_ERROR。
      //   旧版发 ASR_ERROR + throw，recognizeAndSend catch 再发一次，
      //   content script 收到后立即 _asrAborted=true 中断循环，几秒停止。
      //   修正：只清空状态 + throw，由 recognizeAndSend 统一决定是否致命。
      _whisperPromise = null;
      _whisper = null;
      console.error('[VocabRadar][offscreen][' + _ts() + '] whisper 加载失败:', e);
      throw e;
    }
  })();
  return _whisperPromise;
}

/**
 * 初始化识别：加载配置 + 预加载 whisper
 * 不再接收 streamId（音频由 content script 采集）
 * @param {string} videoKey
 */
async function startRecognition(videoKey) {
  console.log('[VocabRadar][offscreen][' + _ts() + '] startRecognition videoKey=', videoKey);
  if (_running) stopRecognition();

  await loadConfig();

  _videoKey = videoKey || '';
  _running = true;
    pushStatus('start', 'offscreen ready, segmentSec=' + _segmentSec + 's (audio captured by content script)');

  // 模型已就绪时立即发 ready 消息（处理 offscreen 持久化、模型已在上次会话加载完成的情况）
  if (_whisper) {
    chrome.runtime.sendMessage({ type: 'ASR_STATUS', status: 'ready' }).catch(() => { /* ignore */ });
  }

  // 反思（2026-07-05）：旧版有心跳保活机制。但模型下载本身（_whisperPromise pending）
  // 就是活跃的异步操作，offscreen document 不会在有待完成的异步操作时被 Chrome 回收。
  // 心跳完全多余，且刷屏日志。用户反馈"为啥要这么干"。删除心跳。

  // 预加载 whisper（不阻塞）
  getWhisper().catch((e) => {
    console.warn('[VocabRadar][offscreen][' + _ts() + '] whisper 加载失败:', e, '\nstack:', e && e.stack);
    const detail = e && e.stack ? String(e.message) + ' | stack: ' + String(e.stack).split('\n').slice(0, 5).join(' | ') : String(e.message || e);
    chrome.runtime.sendMessage({ type: 'ASR_ERROR', videoKey: _videoKey, error: 'whisper load failed: ' + detail }).catch(() => { /* ignore */ });
  });
}

function stopRecognition() {
  _running = false;
  _videoKey = '';
  // 无需心跳保活：模型下载（_whisperPromise pending）本身保持 offscreen 存活。
  // offscreen document 在有待完成的异步操作时不会被 Chrome 回收。
}

// === ASR 错误结果修正（2026-07-23）===
// Whisper 模型常见幻觉：同句重复输出、行内单词/短语重复、短音频生成过量文本。
// 以下三个函数在 recognizeAndSend 中于回传前应用，一次修正下游全部受益
// （asr-client 缓存、sidebar 字幕面板均收到修正后结果）。

/**
 * 去除重复的识别行：连续相同文本的 chunk 只保留第一条
 * Whisper 幻觉常见：同一段文本被重复输出多次（如 "Thank you." "Thank you." "Thank you."）
 * @param {Array<{text:string,timestamp:Array}>} chunks - Whisper 输出的 chunk 数组
 * @returns {Array<{text:string,timestamp:Array}>} 去重后的 chunk 数组
 */
function dedupeRepeatedChunks(chunks) {
  if (!chunks || chunks.length === 0) return chunks;
  const result = [];
  let lastText = '';
  for (const c of chunks) {
    const t = (c.text || '').trim().toLowerCase();
    if (t && t !== lastText) {
      result.push(c);
      lastText = t;
    }
    // 连续相同则跳过（只保留第一条）
  }
  return result;
}

/**
 * 去除行内重复：折叠连续重复的单词/短语
 * Whisper 幻觉："the the the the" → "the"，"thank you thank you" → "thank you"
 * 算法：逐词扫描，尝试短语长度 1-5，若连续重复 3+ 次则折叠为 1 次
 * 比较时忽略大小写，保留首次出现的原始大小写
 * @param {string} text - 单个 chunk 的文本
 * @returns {string} 折叠重复后的文本
 */
function dedupeInlineRepetition(text) {
  if (!text) return text;
  const words = text.split(/\s+/);
  if (words.length < 3) return text;
  const result = [];
  let i = 0;
  while (i < words.length) {
    // 尝试短语长度 5→1，找最长的重复短语
    let bestPhraseLen = 0;
    let bestRepeatCount = 0;
    const maxPlen = Math.min(5, Math.floor((words.length - i) / 3));
    for (let plen = maxPlen; plen >= 1; plen--) {
      const phrase = words.slice(i, i + plen).join(' ').toLowerCase();
      let count = 1;
      let j = i + plen;
      while (j + plen <= words.length) {
        const next = words.slice(j, j + plen).join(' ').toLowerCase();
        if (next === phrase) { count++; j += plen; }
        else break;
      }
      if (count >= 3) {
        bestPhraseLen = plen;
        bestRepeatCount = count;
        break; // 取最长短语优先
      }
    }
    if (bestPhraseLen > 0) {
      // 保留1份，跳过重复
      for (let k = 0; k < bestPhraseLen; k++) result.push(words[i + k]);
      i += bestPhraseLen * bestRepeatCount;
    } else {
      result.push(words[i]);
      i++;
    }
  }
  return result.join(' ');
}

/**
 * 按每秒 30 字节限制截断文本（UTF-8 字节数）
 * 超过部分丢弃，截断到字符边界不切断多字节字符
 * 用于防止 Whisper 对短音频段生成过量文本（幻觉）
 * @param {string} text - 文本
 * @param {number} durationSec - 音频时长（秒）
 * @returns {string} 截断后的文本
 */
function truncateByBytesPerSec(text, durationSec) {
  if (!text || durationSec <= 0) return text;
  const maxBytes = Math.ceil(durationSec * 30);
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  // 回退到字符边界（UTF-8 续字节以 10xxxxxx 开头）
  let cutBytes = maxBytes;
  while (cutBytes > 0 && (bytes[cutBytes] & 0xC0) === 0x80) {
    cutBytes--;
  }
  return new TextDecoder().decode(bytes.slice(0, cutBytes));
}

/**
 * 用 whisper 识别一段音频，回传文本
 * 2026-07-04 重构：支持 return_timestamps，返回 chunk 级时间戳供精确字幕定位。
 * chunk_length_s 固定 30（whisper 上下文窗口，tiny/base/small 通用），stride 5 秒重叠。
 * 输入段长由 content script 控制（asrSegmentSec，默认 30s，与 whisper 窗口对齐）。
 * 2026-07-23 新增：ASR 错误结果修正——回传前应用三项修正：
 *   1. 重复行只取第一条（连续相同 chunk 去重）
 *   2. 行内重复折叠（"the the the" → "the"）
 *   3. 每秒 30 字节限制（UTF-8 字节数，超过丢弃）
 * @param {Float32Array} audioData 16kHz 单声道 PCM
 * @param {number} segStart 段起始时间（视频秒数）
 * @param {number} segEnd 段结束时间（视频秒数）
 * @param {string} videoKey
 * @param {boolean} returnTimestamps 是否返回 chunk 级时间戳
 */
async function recognizeAndSend(audioData, segStart, segEnd, videoKey, returnTimestamps, srcCh) {
  try {
    // 反思（2026-08-21 第八十九次）：每段识别前校验模型设置——切换模型立即生效，
    //   不依赖 onChanged 事件送达（用户反馈"切换了asr模型，识别依旧用旧的"）。
    await ensureModelCurrent();
    // 第一百零二次：抽样峰值——随 ASR_SEGMENT 回传，内容侧时间线可区分
    // 「解码静音（峰值≈0）」与「有声但识别空（模型/语言侧）」
    let peak = 0;
    {
      const st = Math.max(1, Math.floor(audioData.length / 20000));
      for (let i = 0; i < audioData.length; i += st) { const a = Math.abs(audioData[i]); if (a > peak) peak = a; }
    }
    // 第一百二十六次（用户裁定"ASR 提示都要用英文"）：阶段名 ASCII 化——
    // '识别段'→'Segment'，'whisper未就绪'→'Whisper not ready'（侧栏原样显示）
    pushStatus('Segment', 'ch=' + (srcCh || '?') + ' samples=' + audioData.length + ' peak=' + peak.toFixed(3) + ' ts=' + returnTimestamps + ' waiting for whisper...');
    const whisper = await getWhisper();
    if (!whisper) {
      pushStatus('Whisper not ready', 'skip this segment');
      return;
    }
    // chunk_length_s 固定 30（whisper 上下文窗口，tiny/base/small 通用）
    // stride 5 秒重叠，确保分块边界处的识别连续性
    const chunkLen = 30;
    const strideLen = 5;
    // 反思（2026-07-08）：用户反馈"人说话，为何识别全静音，是你限定了语言吗"。
    //   根因：原 language:'english' 强制英语识别，whisper 是多语言模型，
    //   遇到中文等非英语语音会识别失败返回空（表现为全静音）。
    //   修正：移除 language 参数，让 Whisper 自动检测源语言（支持多语言自动检测）。
    //   task:'transcribe' 保留（语音转文字，不翻译）。
    //
    // 反思（2026-08-08）：用户反馈"asr效果差，你是设定了语言吗？"。
    //   根因：未传 language 参数，whisper 需额外做语言检测，tiny 模型检测精度低，
    //   导致非英语语音识别效果差。
    //   修正：从 storage 读取用户设置的 learnLanguage，传给 whisper。
    //   - learnLanguage='en' → language='en'（英语，whisper 支持）
    //   - learnLanguage='zh' → language='zh'（中文）
    //   - learnLanguage=null/未设置 → 不传 language，whisper 自动检测
    let _asrLang = null;
    try {
      const stored = await chrome.storage.local.get({ learnLanguage: 'en' });
      if (stored.learnLanguage && stored.learnLanguage !== 'auto') {
        _asrLang = stored.learnLanguage;
      }
    } catch (_) { /* ignore */ }

    const whisperOpts = {
      task: 'transcribe',
      chunk_length_s: chunkLen,
      stride_length_s: strideLen,
      return_timestamps: returnTimestamps
    };
    if (_asrLang) whisperOpts.language = _asrLang;

    const output = await whisper(audioData, whisperOpts);
    const rawText = (output && output.text) ? output.text.trim() : '';
    pushStatus('Segment result', JSON.stringify(rawText).slice(0, 80) + (returnTimestamps ? ' chunks=' + (output?.chunks?.length || 0) : ''));
    if (!rawText && !(output && output.chunks && output.chunks.length)) {
      // Whisper 返回空：仍发送空 ASR_SEGMENT 解除 sendSegmentAndWait 等待，避免 60s 卡死
      // 第一百零二次：附带 samples/peak/ch 供内容侧时间线定位空结果根因
      chrome.runtime.sendMessage({ type: 'ASR_SEGMENT', videoKey: videoKey || _videoKey, start: segStart, end: segEnd, text: '', samples: audioData.length, peak, ch: srcCh || '?' }).catch(() => { /* ignore */ });
      return;
    }

    // === ASR 错误结果修正（2026-07-23）===
    // 修正1+2+3：重复行去重 → 行内重复折叠 → 每秒30字节截断
    let correctedText = '';
    let correctedChunks = null;

    if (returnTimestamps && output && output.chunks && output.chunks.length > 0) {
      // 有 chunk 时间戳：逐 chunk 修正
      // 修正1：连续相同 chunk 只保留第一条
      const dedupedChunks = dedupeRepeatedChunks(output.chunks);
      // 修正2+3：每个 chunk 行内重复折叠 + 按时长截断
      correctedChunks = [];
      for (const c of dedupedChunks) {
        const ts0 = (c.timestamp && typeof c.timestamp[0] === 'number') ? c.timestamp[0] : 0;
        // timestamp[1] 可能为 null（Whisper 末尾 chunk 常见），回退 ts0+2s
        const ts1 = (c.timestamp && typeof c.timestamp[1] === 'number') ? c.timestamp[1] : (ts0 + 2);
        const chunkDur = Math.max(0.5, ts1 - ts0); // 最小 0.5s 避免除零
        let cText = (c.text || '').trim();
        cText = dedupeInlineRepetition(cText);       // 修正2：行内重复折叠
        cText = truncateByBytesPerSec(cText, chunkDur); // 修正3：每秒30字节
        if (cText) {
          correctedChunks.push({ text: cText, timestamp: c.timestamp });
        }
      }
      if (correctedChunks.length === 0) {
        // 全部 chunk 修正后为空：仍发送空 ASR_SEGMENT 解除等待，避免 60s 卡死
        pushStatus('Empty after correction', 'no valid text in chunks');
        chrome.runtime.sendMessage({ type: 'ASR_SEGMENT', videoKey: videoKey || _videoKey, start: segStart, end: segEnd, text: '' }).catch(() => { /* ignore */ });
        return;
      }
      correctedText = correctedChunks.map((c) => c.text).join(' ').trim();
    } else {
      // 无 chunk 时间戳：整段修正
      const segDur = Math.max(0.5, segEnd - segStart);
      correctedText = dedupeInlineRepetition(rawText);       // 修正2：行内重复折叠
      correctedText = truncateByBytesPerSec(correctedText, segDur); // 修正3：每秒30字节
      if (!correctedText) {
        // 整段修正后为空：仍发送空 ASR_SEGMENT 解除等待，避免 60s 卡死
        pushStatus('Empty after correction', 'no valid text in segment');
        chrome.runtime.sendMessage({ type: 'ASR_SEGMENT', videoKey: videoKey || _videoKey, start: segStart, end: segEnd, text: '' }).catch(() => { /* ignore */ });
        return;
      }
    }

    // 回传给 asr-client（经 SW 中转）
    // 含 chunks 时附带 chunk 级时间戳，asr-client 据此拆分为多条字幕
    const segmentMsg = {
      type: 'ASR_SEGMENT',
      videoKey: videoKey || _videoKey,
      start: segStart,
      end: segEnd,
      text: correctedText,
      samples: audioData.length, // 第一百零二次：诊断回传
      peak,
      ch: srcCh || '?'
    };
    if (correctedChunks) {
      segmentMsg.chunks = correctedChunks.map((c) => ({
        text: c.text,
        timestamp: c.timestamp
      }));
    }
    chrome.runtime.sendMessage(segmentMsg).catch(() => { /* ignore */ });
  } catch (e) {
    console.warn('[VocabRadar][offscreen][' + _ts() + '] whisper 识别失败:', e);
    pushStatus('Whisper failed', String(e.message || e));
    // 反思（2026-08-08）：用户持续反馈"asr几秒后直接停止"。
    //   根因：旧版对模型加载错误（isFatal=true）直接发 ASR_ERROR，content script
    //   收到后 _asrAborted=true 立即中断循环。任何瞬时网络错误都会导致 ASR 停止。
    //   修正：引入 _modelFailCount 连续失败计数器。
    //   - 模型加载错误：递增 _modelFailCount，若 <3 次则发空 ASR_SEGMENT（非致命，
    //     循环继续，下一段调 getWhisper 会重试）；若 ≥3 次连续失败才发 ASR_ERROR。
    //   - 识别错误（非模型）：发空 ASR_SEGMENT（非致命，循环继续）。
    //   - 成功识别时 _modelFailCount 重置为 0（在 getWhisper 成功返回时重置）。
    const errStr = String(e && e.message || e);
    const isModelError = errStr.includes('模型加载失败') || errStr.includes('whisper load failed') ||
                    errStr.includes('pipeline') || errStr.includes('transformers') ||
                    errStr.includes('No model') || errStr.includes('network') ||
                    errStr.includes('fetch') || errStr.includes('import');
    if (isModelError) {
      _modelFailCount++;
      console.warn('[VocabRadar][offscreen][' + _ts() + '] 模型加载失败计数: ' + _modelFailCount + '/3');
      if (_modelFailCount >= 3) {
        // 连续 3 次模型失败，判定为致命错误
        console.warn('[VocabRadar][offscreen][' + _ts() + '] 模型连续失败 3 次，发送 ASR_ERROR 停止循环');
        chrome.runtime.sendMessage({ type: 'ASR_ERROR', videoKey: videoKey || _videoKey, error: '模型加载失败(连续3次): ' + errStr }).catch(() => { /* ignore */ });
      } else {
        // 未达阈值：发空 ASR_SEGMENT 解除等待，循环继续下一段（getWhisper 会重试）
        pushStatus('Model retry', 'attempt ' + _modelFailCount + ' failed, will retry');
        chrome.runtime.sendMessage({ type: 'ASR_SEGMENT', videoKey: videoKey || _videoKey, start: segStart, end: segEnd, text: '' }).catch(() => { /* ignore */ });
      }
    } else {
      // 非模型错误：发空 ASR_SEGMENT 解除等待，循环继续
      chrome.runtime.sendMessage({ type: 'ASR_SEGMENT', videoKey: videoKey || _videoKey, start: segStart, end: segEnd, text: '' }).catch(() => { /* ignore */ });
    }
  }
}
