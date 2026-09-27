// =============================================================================
// SW ASR（在线 LLM 转写） （2026-09-27 拆分自 service-worker.js）
// 职责：分片转写（handleSegmentByLlm，ASR_AUDIO_SEGMENT）、整段文件转写
//   （handleAsrLlmFile，ASR_LLM_FILE）、OpenAI 兼容 /audio/transcriptions 请求。
// 第三百九十四次：本地 whisper 随"扩展不再保留这两个模型"裁定移除，只剩在线一条路；
//   失败如实上抛，不做本地降级（不遮蔽）。
// =============================================================================
import { _ts, log } from './log.js';
import { b64ToUint8, pcmF32ToWavBlob } from './util.js';
import { resolveLlmEngineCfg } from './llm.js';

// === 第二百一十五次：ASR 的 LLM 引擎（音频转写）===
// 端点形态（用户裁定采用主流候选）：OpenAI 兼容 multipart POST {baseUrl}/audio/transcriptions，
//   字段 file/model/language/response_format=json → { text }。
// 音频形态：在线分片＝每段 Float32 PCM(16kHz) 现转 WAV 一次请求；离线整段＝原始上传文件
//   一次请求（ASR_LLM_FILE）。模型名用户自管（asrLlmModel，默认 whisper-1），有错就报。
export async function llmTranscribeBlob(blob, cfg, lang, fileName, signal) {
  // 第二百一十六次：cfg 由调用方传入（ASR-LLM 独立配置 resolveLlmEngineCfg('asr') 产物）
  // 313 批：新增第 5 形参 signal（AbortSignal，调用方可选）——fetch 透传，超时中断在线
  // 请求；不传（在线分片 handleSegmentByLlm）行为不变
  if (cfg.format === 'anthropic') throw new Error('Anthropic 无音频转写端点，请改用 OpenAI 兼容来源');
  if (!cfg.baseUrl) throw new Error('Base URL 未配置');
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
  const fd = new FormData();
  fd.append('file', blob, fileName || 'segment.wav');
  fd.append('model', cfg.model);
  if (lang) fd.append('language', String(lang).split('-')[0]);
  fd.append('response_format', 'json');
  const headers = {};
  // 第445次：free 格式判断删除（free 组裁撤）；有 Key 即带 Bearer（noKey 来源无 Key 不带）
  if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
  const resp = await fetch(url, { method: 'POST', headers, credentials: 'omit', cache: 'no-store', body: fd, signal });
  const raw = await resp.text();
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + raw.slice(0, 300));
  try {
    const j = JSON.parse(raw);
    return String((j && j.text) || '');
  } catch (e) {
    throw new Error('响应不是 JSON：' + raw.slice(0, 200));
  }
}

/** 分片在线转写：转 WAV → /audio/transcriptions → ASR_SEGMENT 回发起 tab */
export async function handleSegmentByLlm(msg, sender) {
  let f32 = msg.audio;
  if (!(f32 instanceof ArrayBuffer) && msg.audioB64) f32 = b64ToUint8(msg.audioB64).buffer;
  if (!f32) throw new Error('段音频缺失');
  const pcm = new Float32Array(f32);
  const wav = pcmF32ToWavBlob(pcm, 16000);
  let lang = null;
  try { lang = (await new Promise((r) => chrome.storage.local.get({ learnLanguage: 'en' }, r))).learnLanguage; } catch (_) { }
  const cfg = await resolveLlmEngineCfg('asr');   // 恢复 216 形态：ASR-LLM 独立配置
  const text = await llmTranscribeBlob(wav, cfg, lang, 'segment.wav');
  // 回包与 offscreen 的 ASR_SEGMENT 同形（无 chunks——接收端按整段文本处理，已兼容）
  if (sender && sender.tab && sender.tab.id) {
    chrome.tabs.sendMessage(sender.tab.id, {
      type: 'ASR_SEGMENT', videoKey: msg.videoKey, start: msg.start, end: msg.end,
      text: text, samples: pcm.length, engine: 'api'   // 第二百二十五次：引擎标记随值改名（payload 字段，当前无消费方）
    }).catch(() => { /* 接收页可能已关闭 */ });
  }
}

/**
 * 整段文件转写（引导页 ASR 栏上传原始文件，一次请求）。
 * 拆分修复（2026-09-27）：原实现函数体内直接调用 `sendResponse`，而该标识符只存在于
 *   onMessage 监听器形参作用域（顶层函数不可见）→ 运行期 ReferenceError，调用方
 *   （router 的 .catch）永远收到 "sendResponse is not defined"，整段上传恒失败。
 *   改为返回结果对象、由 router 统一 sendResponse（与其余 handler 同构）。
 * 有错就报（不遮蔽）：调用方 toast 展示原文。
 * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
 */
export async function handleAsrLlmFile(msg) {
  try {
    const u8 = b64ToUint8(msg.audioB64 || '');
    const ext = (String(msg.fileName || '').split('.').pop() || 'wav').toLowerCase();
    const mimeMap = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg', flac: 'audio/flac' };
    const blob = new Blob([u8], { type: mimeMap[ext] || 'audio/wav' });
    let lang = null;
    try { lang = (await new Promise((r) => chrome.storage.local.get({ learnLanguage: 'en' }, r))).learnLanguage; } catch (_) { }
    const cfg = await resolveLlmEngineCfg('asr');   // 第二百二十次：ASR-LLM 独立配置（与聊天 llm* 键互不影响）
    const text = await llmTranscribeBlob(blob, cfg, lang, String(msg.fileName || 'audio.wav'));
    return { ok: true, text: text };
  } catch (e) {
    log('[VocabRadar][sw][' + _ts() + '] ASR_LLM_FILE 失败:', String(e.message || e));
    return { ok: false, error: String(e.message || e) };
  }
}
