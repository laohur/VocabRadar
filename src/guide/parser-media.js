// VocabRadar 引导页 功能栏 Parser 媒体侧（第二百五十五次新增；第二百五十六次修订）
// 职责（供 parser.js 调用，不碰 Parser 的 DOM 状态机）：
//   1) 录制（microphone/camera/screen）：复用 asr.js 的 acquireMediaStream/handleAcquireError
//      （用户手势内取流、授权错误分类），MediaRecorder 收录，停止后产出 File 交回调；
//      实时识别（256 次补回，用户"实时asr没有了"）：镜像 asr.js 引擎优先级——API 引擎已配置
//      则不走实时（停止后整段转写）；否则 audio/video 且浏览器支持 SpeechRecognition 时
//      实时识别，句子经 onLiveText 流入输出区；screen/不支持 → 停止后文件转写兜底；
//   2) 音视频文件转写：走与 asr.js 文件 ASR 完全相同的后台消息协议
//      （START_ASR → 本地 Whisper 分段 ASR_AUDIO_SEGMENT / API 引擎整段 ASR_LLM_FILE →
//      ASR_SEGMENT/ASR_ERROR 回传 → STOP_ASR），只收纯文本、不挂侧栏不注释。
// 255 次缺陷修复存档（用户报"pendingResolve is not defined"）：sendSegment 为模块级函数，
//   却给 transcribeAvFile 函数本地的 pendingResolve 赋值——ESM 严格模式下对未声明标识符
//   赋值直接 ReferenceError；改用调用方传入的 segState 载体对象共享（256 次）。

import { t } from '../lib/i18n.js';
import { $, log, toast } from './guide-common.js';
import {
  acquireMediaStream, handleAcquireError, decodeFileToPcm, arrayBufferToBase64
} from './asr.js';

// === 录制状态（Parser 栏专用，独立于 ASR 栏的 S.recording* 状态） ===
const rec = {
  active: false,
  kind: null,          // 'audio' | 'video' | 'screen'
  stream: null,
  recorder: null,
  chunks: [],
  blobUrl: null,
  btn: null,           // 「录制」按钮（⏹ 停止态挂在它上面）
  hintHtml: null       // 按钮原始文案（stopRecording 复原）
};

export function isParserRecording() {
  return rec.active;
}

function pickMime(kind) {
  const candidates = (kind === 'screen' || kind === 'video')
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/webm', ''];
  for (const m of candidates) {
    if (!m || MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

/**
 * 开始录制（来源由 Parser 栏 radio 决定）；按钮切 ⏹ 停止态
 * @param {string} kind 'audio'|'video'|'screen'
 * @param {(text: string) => void} [onLiveText] 实时识别句子回调（browser ASR final 结果）
 * @param {(stream: MediaStream, kind: string) => void} [onStream] 媒体流回调
 *   （260 次：摄像/录屏录制期间实时画面预览，Parser 栏渲到预览槽；audio 不回调无画面）
 */
export async function startParserRecording(kind, onLiveText, onStream) {
  if (rec.active) return;
  if (!chrome.runtime?.id) { toast(t('ws.extUpdated'), { error: true }); return; }
  // 用户手势内直接 getUserMedia/getDisplayMedia（授权框必弹，复用 ASR 栏同款逻辑）
  const acq = await acquireMediaStream(kind);
  if (acq.err) { handleAcquireError(kind, acq.err); return; }
  const stream = acq.stream;
  // 265 次（用户"录音时候没有预览"）：audio 也回调——纯音频由 Parser 栏渲染实时音量
  //   波形（AnalyserNode 只分析不外放，无回声）；video/screen 仍是画面预览
  if (typeof onStream === 'function') {
    try { onStream(stream, kind); } catch (e) { log('Parser 实时预览回调失败:', e); }
  }
  rec.active = true;
  rec.kind = kind;
  rec.stream = stream;
  rec.chunks = [];
  if (rec.blobUrl) { try { URL.revokeObjectURL(rec.blobUrl); } catch (e) { /* ignore */ } rec.blobUrl = null; }
  try {
    const mime = pickMime(kind);
    rec.recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    rec.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) rec.chunks.push(e.data);
    };
    rec.recorder.start(1000);
  } catch (e) {
    log('Parser MediaRecorder 初始化失败:', e);
    toast(t('ws.recordStartFail') + String(e && e.message || e), { error: true });
    stream.getTracks().forEach((tr) => tr.stop());
    rec.active = false;
    rec.stream = null;
    rec.recorder = null;
    return;
  }
  rec.btn = $('g-parser-record-btn');
  if (rec.btn) {
    rec.hintHtml = rec.btn.textContent;
    rec.btn.classList.add('recording');
    rec.btn.textContent = '⏹ ' + t('ws.stop');
  }
  // 实时识别（256 次补回）：条件镜像 asr.js useBrowserAsr——
  //   API 引擎已配置 → 不实时（停止后整段 API 转写）；screen → 不实时（停止后转写）；
  //   其余 audio/video 且浏览器支持 SpeechRecognition → 实时识别，句子流入输出区。
  liveNetErrShown = false;
  let llmReady = false;
  let lang = 'en';
  try {
    const er = await chrome.storage.local.get({
      asrEngine: 'local', asrLlmBaseUrl: '', asrLlmApiKey: '', learnLanguage: 'en'
    });
    llmReady = (er.asrEngine === 'api' || er.asrEngine === 'llm') && !!(er.asrLlmBaseUrl || er.asrLlmApiKey);
    lang = er.learnLanguage || 'en';
  } catch (e) { /* 默认本地 */ }
  const srSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  if (kind !== 'screen' && !llmReady && srSupported && typeof onLiveText === 'function') {
    startLiveAsr(lang, onLiveText);
    log('Parser 录制已开始（实时识别 browser ASR）: kind=', kind, 'lang=', lang);
  } else {
    log('Parser 录制已开始（无实时识别，停止后文件转写）: kind=', kind,
      'llmReady=', llmReady, 'srSupported=', srSupported);
  }
}

// === 浏览器实时识别（SpeechRecognition，镜像 asr.js startBrowserAsr/stopBrowserAsr） ===
let liveAsr = null;
let liveNetErrShown = false;   // network 错误 toast 每次录制只弹一次（与 asr.js 口径一致）

function startLiveAsr(lang, onFinalText) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return false;
  try {
    liveAsr = new SR();
    liveAsr.continuous = true;
    liveAsr.interimResults = true;
    liveAsr.lang = lang || 'en';
    liveAsr.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          if (text) onFinalText(text);
        }
      }
    };
    liveAsr.onerror = (event) => {
      log('Parser 浏览器 ASR 错误:', event.error);
      if (event.error === 'no-speech') return;   // 无语音正常，不提示
      if (event.error === 'network') {
        // 国内网络 Google 语音服务不可达为常态：toast 一次并停实时（阻断重启循环），
        // 录制继续，停止后走文件转写兜底（与 asr.js 同策略）
        if (!liveNetErrShown) {
          liveNetErrShown = true;
          toast(t('ws.browserAsrNetErr'), { error: true, duration: 10000 });
        }
        stopLiveAsr();
      } else if (event.error === 'not-allowed') {
        toast(t('ws.browserAsrError') + ' permission denied', { error: true });
        stopLiveAsr();
      }
    };
    liveAsr.onend = () => {
      // 无语音等自动结束：录制期间续启（与 asr.js 一致）
      if (rec.active && liveAsr) { try { liveAsr.start(); } catch (e) { /* ignore */ } }
    };
    liveAsr.start();
    return true;
  } catch (e) {
    log('Parser 浏览器 ASR 启动失败:', e);
    liveAsr = null;
    return false;
  }
}

function stopLiveAsr() {
  if (liveAsr) {
    try {
      liveAsr.onresult = null;
      liveAsr.onerror = null;
      liveAsr.onend = null;
      liveAsr.stop();
    } catch (e) { /* ignore */ }
    liveAsr = null;
  }
}

/** 停止录制并产出文件（无成品时 resolve null） */
export async function stopParserRecording() {
  if (!rec.active) return null;
  rec.active = false;
  stopLiveAsr();
  const { kind, recorder, stream } = rec;
  const blobType = (kind === 'screen' || kind === 'video') ? 'video/webm' : 'audio/webm';
  const { blobUrl, blob } = await new Promise((resolve) => {
    let settled = false;
    const finish = (url, b) => { if (!settled) { settled = true; resolve({ blobUrl: url, blob: b || null }); } };
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = () => {
        if (rec.chunks.length === 0) { finish(null, null); return; }
        const b = new Blob(rec.chunks, { type: blobType });
        finish(URL.createObjectURL(b), b);
        rec.chunks = [];
      };
      setTimeout(() => finish(null, null), 5000);
      try { recorder.stop(); } catch (e) { finish(null, null); }
    } else {
      finish(null, null);
    }
  });
  rec.recorder = null;
  rec.chunks = [];
  if (stream) {
    stream.getTracks().forEach((tr) => tr.stop());
    rec.stream = null;
  }
  if (rec.btn) {
    rec.btn.classList.remove('recording');
    rec.btn.textContent = rec.hintHtml || '🎙 ' + t('ws.record');
    rec.btn = null;
    rec.hintHtml = null;
  }
  if (!blobUrl || !blob) {
    log('Parser 录制无成品（未收到数据）');
    return null;
  }
  rec.blobUrl = blobUrl;
  const file = new File([blob], 'recording.webm', { type: blobType });
  return { file, blobUrl };
}

// === 音视频文件转写（与 asr.js 文件 ASR 同协议，只收纯文本） ===

/**
 * 转写音视频文件为纯文本
 * @param {File|Blob} file 音视频文件（含 Parser 录制成品）
 * @param {(stage: string, detail: string) => void} onStatus 进度回调（已本地化文案）
 * @returns {Promise<string>} 识别文本（无语音时为空串）
 */
export async function transcribeAvFile(file, onStatus) {
  if (!chrome.runtime?.id) throw new Error(t('ws.extUpdated'));
  const report = typeof onStatus === 'function' ? onStatus : () => {};
  const videoKey = 'parser-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  // 段响应等待（镜像 asr.js sendSegmentAndWait：keepalive + 超时跳段，不遮蔽——超时打日志）
  // 反思（256 次）：段解析器 sendSegment 是模块级函数，与监听器共享 pending 必须经调用方
  //   传入的载体对象——255 次直接赋值模块级未声明标识符 pendingResolve，ESM 严格模式
  //   ReferenceError（用户报"Parse failed: pendingResolve is not defined"根因）。
  const segState = { pending: null };
  const listener = (msg) => {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'ASR_STATUS') {
      // 广播消息（无 videoKey）：ready/loading/stage 转 onStatus 供输出区显示
      if (msg.status === 'ready') report(t('ws.modelReady'), '');
      else if (msg.status === 'loading') report(t('ws.modelDownloading', { pct: Math.round(msg.progress || 0) }), msg.file || '');
      else if (msg.status === 'stage' && msg.stage) report(t('ws.stageRecognizingSeg'), msg.info || '');
      return true;
    }
    if (msg.videoKey !== videoKey) return false;
    if (msg.type === 'ASR_SEGMENT') {
      if (segState.pending) { const r = segState.pending; segState.pending = null; r(msg); }
      return true;
    }
    if (msg.type === 'ASR_ERROR') {
      const errStr = String(msg.error || '');
      report(t('ws.error'), errStr.slice(0, 60));
      if (segState.pending) { const r = segState.pending; segState.pending = null; r(null); }
      return true;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);

  const texts = [];
  const takeText = (msg) => {
    if (!msg) return;
    if (msg.chunks && msg.chunks.length > 0) {
      for (const chunk of msg.chunks) {
        const text = (chunk.text || '').trim();
        if (text) texts.push(text);
      }
    } else if (msg.text) {
      const trimmed = String(msg.text).trim();
      // 无 chunks 的整段回包（API 引擎/单段）：按句切分入列，与 asr.js 口径一致
      if (trimmed) {
        const lines = trimmed.split(/\n+|[。！？.!?]+/).map((s) => s.trim()).filter(Boolean);
        if (lines.length === 0) texts.push(trimmed);
        else texts.push(...lines);
      }
    }
  };

  try {
    const startResp = await chrome.runtime.sendMessage({ type: 'START_ASR', videoKey });
    if (!startResp || !startResp.ok) {
      throw new Error(t('ws.asrStartFail') + ((startResp && startResp.error) || t('ws.noResponse')));
    }
    report(t('ws.decoding'), '');

    // 引擎选择（与设定栏一致：api=OpenAI 兼容转写整段；其余=本地 Whisper 分段）
    let asrLlmModel = null;
    try {
      const er = await chrome.storage.local.get({ asrEngine: 'local', asrLlmModel: 'whisper-1' });
      if (er.asrEngine === 'api' || er.asrEngine === 'llm') asrLlmModel = er.asrLlmModel || 'whisper-1';
    } catch (_) { /* 默认本地 */ }

    if (asrLlmModel) {
      report(t('ws.recognizing'), 'LLM');
      const buf = await file.arrayBuffer();
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'ASR_LLM_FILE',
          fileName: (file && file.name) || 'audio.webm',
          audioB64: arrayBufferToBase64(buf),
          model: asrLlmModel
        }).then(resolve).catch((e) => resolve({ ok: false, error: String(e.message || e) }));
      });
      if (!resp || !resp.ok) throw new Error(String((resp && resp.error) || 'LLM 转写失败'));
      takeText({ text: resp.text || '' });
      report(t('ws.recognizeDone'), 'LLM');
    } else {
      const pcm = await decodeFileToPcm(file);
      const SAMPLE_RATE = 16000;
      const SEGMENT_SEC = 300;
      const segLen = SEGMENT_SEC * SAMPLE_RATE;
      const total = Math.max(1, Math.ceil(pcm.length / segLen));
      for (let i = 0; i < pcm.length; i += segLen) {
        const seg = pcm.slice(i, Math.min(i + segLen, pcm.length));
        const start = i / SAMPLE_RATE;
        const end = Math.min((i + segLen) / SAMPLE_RATE, pcm.length / SAMPLE_RATE);
        report(t('ws.recognizing'), `${i / segLen + 1}/${total} ${t('ws.segments')}`);
        const msg = await sendSegment(seg, start, end, videoKey, segState);
        takeText(msg);
      }
      report(t('ws.recognizeDone'), `${total} ${t('ws.segments')}`);
    }
  } finally {
    try { chrome.runtime.sendMessage({ type: 'STOP_ASR' }).catch(() => { /* ignore */ }); } catch (e) { /* ignore */ }
    chrome.runtime.onMessage.removeListener(listener);
  }
  return texts.join('\n');
}

/** 单段发送并等待响应（含 ASR_CHECK keepalive 与超时，镜像 asr.js；pending 经 segState 共享） */
function sendSegment(pcm, start, end, videoKey, segState) {
  return new Promise((resolve) => {
    let settled = false;
    const segDur = Math.max(10, end - start);
    const timeoutMs = Math.max(180000, segDur * 3 * 1000);
    const keepAlive = setInterval(() => {
      if (settled) { clearInterval(keepAlive); return; }
      chrome.runtime.sendMessage({ type: 'ASR_CHECK' }).catch(() => {});
    }, 20000);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(keepAlive);
      segState.pending = null;
      log('Parser 转写段超时(' + (timeoutMs / 1000) + 's), 跳过:', start + 's-' + end + 's');
      resolve(null);
    }, timeoutMs);
    const resolveNow = (msg) => {
      if (settled) return;
      settled = true;
      clearInterval(keepAlive);
      clearTimeout(timeout);
      resolve(msg);
    };
    segState.pending = resolveNow;
    let pcmBuf = pcm;
    if (pcm instanceof Float32Array && (pcm.byteOffset !== 0 || pcm.byteLength !== pcm.buffer.byteLength)) {
      pcmBuf = pcm.slice();
    }
    chrome.runtime.sendMessage({
      type: 'ASR_AUDIO_SEGMENT',
      videoKey,
      start,
      end,
      audio: (pcmBuf instanceof Float32Array) ? pcmBuf.buffer : new Float32Array(pcmBuf).buffer,
      returnTimestamps: true
    }).catch((e) => log('Parser 转写段发送失败:', e));
  });
}
