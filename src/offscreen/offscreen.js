// Offscreen document：音频解码 / 网页正文提取 / 文档解析
// 第三百九十四次（plan 阶段二③，用户裁定"扩展不再保留这两个模型"）：
//   Whisper 与 Tesseract 本地模型推理整链移除（transformers.js pipeline、
//   Tesseract worker、whisper 幻觉修正管线、OFFSCREEN_ASR_* 与 OFFSCREEN_OCR
//   消息全删）。ASR/OCR 一律走在线引擎（SW 直调 OpenAI 兼容 /v1 端点），
//   本文件只保留三类不依赖模型的 DOM/Audio 能力：
//     1. OFFSCREEN_AUDIO_DECODE —— 网页录音解码 + 重采样 16k（SW 无 AudioContext）
//     2. OFFSCREEN_EXTRACT_TEXT —— Defuddle 正文提取（页面可能需要登录或无正文）
//     3. OFFSCREEN_PARSE_DOC   —— pdf/docx/epub 文档解析（unpdf/mammoth）
//   另保留 OFFSCREEN_PING 就绪探针（本文件是 ES module，监听器注册晚于模块求值，
//   创建方轮询到 ok 才能确认可应答；Firefox 隐藏 iframe 宿主同款教训）。

// 时间戳辅助：所有日志带 HH:MM:SS.mmm 便于诊断时序问题
function _ts() {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// 重采样目标采样率：16k 单声道，对齐在线转写引擎输入口径
const SAMPLE_RATE = 16000;

// === 消息入口 ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  // 就绪探针（第一百七十九次）：能应答即说明监听器已注册，创建方轮询到 ok 后再发后续消息。
  if (msg.type === 'OFFSCREEN_PING') {
    sendResponse({ ok: true, ready: true });
    return true;
  }
  if (msg.type === 'OFFSCREEN_AUDIO_DECODE') {
    // 316次（用户"送入模型之前应当转换，包括网页送入"）：音频解码+重采样辅助消息——
    //   SW 端把网页（桥接站）送入的原始录音（webm/opus 等）在送在线转写引擎前
    //   先做客户端转换：本端 decodeAudioData 解码 → OfflineAudioContext 重采样 16k
    //   单声道 → Float32 PCM 以 base64 回传，SW 端 pcmF32ToWavBlob 编码 WAV 再送
    //   （与分片路径 handleSegmentByLlm 的 16k WAV 同款）。
    //   offscreen 有 AudioContext，SW 没有，解码必须在本端。
    (async () => {
      let ab = null;
      try {
        const webmB64 = String(msg.webmB64 || '');
        if (!webmB64) throw new Error('webmB64 missing');
        const bin = atob(webmB64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        ab = new AudioContext();
        const decoded = await ab.decodeAudioData(u8.buffer);
        // 重采样到 16k 单声道（转写引擎输出口径，对齐 SAMPLE_RATE）
        const target = SAMPLE_RATE;
        const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * target), target);
        const srcNode = off.createBufferSource();
        srcNode.buffer = decoded;
        srcNode.connect(off.destination);
        srcNode.start();
        const rendered = await off.startRendering();
        const pcm = rendered.getChannelData(0);
        // Float32Array → base64（分块防 apply 栈溢出）
        const f32Bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        let s = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < f32Bytes.length; i += CHUNK) {
          s += String.fromCharCode.apply(null, f32Bytes.subarray(i, i + CHUNK));
        }
        sendResponse({ ok: true, pcmB64: btoa(s), sampleRate: target, samples: pcm.length });
      } catch (e) {
        try { sendResponse({ ok: false, error: String(e.message || e) }); } catch (_) { }
      } finally {
        if (ab) { try { ab.close(); } catch (_) { } }
      }
    })();
    return true;
  }
  // === G4（2026-09-08）：网页正文提取（网站 Creator 解析编排用） ===
  // SW fetch 到 HTML 后转发到这里，用 main-text.js 的 extractDefuddleFromHtml 提取正文。
  // 本文件是 ES module（offscreen.html 以 type="module" 加载），可加载 main-text.js；
  // main-text 顶层无 DOM 副作用（全为常量/函数定义），offscreen document 提供 DOMParser。
  // 动态 import：Defuddle/vendor 仅在首次链接解析时加载。
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
  // === B2（2026-09-10）：文档解析（网站 Creator G4 通道 B 的 document kind） ===
  // SW 转发文件字节（b64，runtime message JSON 序列化约束）到这里，
  // 用 parse-doc.js（与 guide/parser.js 同源）提取纯文本。
  // 动态 import：unpdf/mammoth 仅在首次文档解析时加载。
  if (msg.type === 'OFFSCREEN_PARSE_DOC') {
    const _docStart = Date.now();
    console.log('[VocabRadar][offscreen][' + _ts() + '] OFFSCREEN_PARSE_DOC 收到请求, kind=' + msg.docKind + ', name=' + (msg.name || '') + ', b64 长度=' + (msg.b64 || '').length);
    parseDocFile(msg).then((text) => {
      const _docCost = ((Date.now() - _docStart) / 1000).toFixed(2);
      console.log('[VocabRadar][offscreen][' + _ts() + '] 文档解析完成, 耗时=' + _docCost + 's, 文本长度=' + (text || '').length);
      sendResponse({ ok: true, text: text || '' });
    }).catch((e) => {
      console.warn('[VocabRadar][offscreen][' + _ts() + '] 文档解析失败:', e);
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

// === B2：文档解析入口（parse-doc.js 的调用壳） ===
// b64 → Uint8Array → parseDocBuffer；空文本按失败回报（明示，同 extractFromHtml 纪律）。
async function parseDocFile(msg) {
  const bin = atob(msg.b64 || '');
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const { parseDocBuffer } = await import('./parse-doc.js');
  const text = await parseDocBuffer(u8, msg.docKind, msg.name || '');
  if (!text || !text.trim()) {
    throw new Error('extracted text is empty (scanned pdf or unsupported file?)');
  }
  return text;
}
