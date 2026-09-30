// =============================================================================
// SW OCR（LLM 视觉识别）
// 职责：图片入口统一缩放（handleOcrRecognize，全部 OCR 调用的收口）+
//   LLM 视觉单次请求（llmVisionOnce，镜像 llmChatOnce 的 URL/头/解析）。
// OCR 一律走 LLM 视觉（用户裁定"扩展不再保留这两个模型"；引擎 provider 默认 local-backend）。
// =============================================================================
import { downscaleImageDataUrl } from '../../lib/image-downscale.js';
import { _ts, log } from './log.js';
import { resolveLlmEngineCfg } from './llm.js';

// === OCR 的 LLM 引擎（视觉识别）===
// 与 handleLlmChat 同一套 llm* 配置与三类格式分流；图片走 dataURL，
//   openai/free 形态用 image_url，anthropic 形态用 base64 source 块。
// 提示词要求逐字提取可见文本（保持原语言与换行），供侧栏注释/生词流程直接消费。
const OCR_LLM_PROMPT = 'Extract ALL visible text from this image verbatim. '
  + 'Keep the original language, line breaks and reading order. '
  + 'Output ONLY the extracted text, with no commentary.';

export async function handleOcrRecognize(imageDataUrl, lang) {
  // 用户裁定"图片短边最长1280"：入口统一等比缩放——本函数是全部图片 OCR 的收口
  //   （右键/侧栏/引导页 OCR 栏与 Parser 栏/网站 Creator），在此缩放一次全部生效；
  //   缩放失败原样放行不阻断。引导页/网站侧发送前已各自缩放的，此处短边未超限
  //   会原样返回（零开销直通）。
  const ds = await downscaleImageDataUrl(imageDataUrl, 1280);
  if (ds.scaled) {
    log('[VocabRadar][sw][' + _ts() + '] OCR 图片已缩放: ' + ds.origWidth + 'x' + ds.origHeight
      + ' → ' + ds.width + 'x' + ds.height + ', ' + (ds.origBytes / 1024).toFixed(0) + 'KB → '
      + (ds.bytes / 1024).toFixed(0) + 'KB');
  } else if (ds.error) {
    log('[VocabRadar][sw][' + _ts() + '] OCR 图片缩放跳过（原图直送）: ' + ds.error);
  }
  imageDataUrl = ds.dataUrl;
  return handleOcrByLlm(imageDataUrl, lang);
}

export async function handleOcrByLlm(imageDataUrl, lang) {
  const cfg = await resolveLlmEngineCfg('ocr');   // OCR-LLM 独立配置
  const out = await llmVisionOnce(cfg, OCR_LLM_PROMPT, imageDataUrl);
  if (!out.ok) {
    log('[VocabRadar][sw][' + _ts() + '] OCR(LLM) 失败: ' + out.error);
    return { ok: false, error: 'OCR(LLM): ' + out.error };
  }
  return { ok: true, text: out.content };
}

/**
 * 单来源 LLM 视觉识别（镜像 llmChatOnce 的 URL/头/解析，消息体为多模态 content 数组）
 * @returns {Promise<{ok:boolean, content?:string, error?:string}>}
 */
async function llmVisionOnce(cfg, prompt, imageDataUrl) {
  // noKey 来源（本地后端）免 Key 强校验；鉴权头仅在有 Key 时携带
  //   （镜像 llmTranscribeBlob），空 Bearer 不发给本地服务
  const noKey = !!cfg.noKey;
  const isAnthropic = cfg.format === 'anthropic';
  if (!noKey && !cfg.apiKey) return { ok: false, error: 'API Key 未配置' };
  if (!cfg.baseUrl) return { ok: false, error: 'Base URL 未配置' };
  if (!cfg.model) return { ok: false, error: '模型名未配置' };

  // 解析 dataURL：data:image/png;base64,xxxx
  const m = /^data:([^;]+);base64,(.*)$/s.exec(imageDataUrl || '');
  if (!m) return { ok: false, error: 'imageDataUrl 不是 base64 dataURL' };
  const mime = m[1];
  const b64 = m[2];

  const url = cfg.baseUrl + (isAnthropic ? '/v1/messages' : '/chat/completions');
  const headers = { 'Content-Type': 'application/json' };
  if (isAnthropic) {
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (!noKey && cfg.apiKey) {
    headers['Authorization'] = 'Bearer ' + cfg.apiKey;
  }
  let body;
  if (isAnthropic) {
    body = JSON.stringify({
      model: cfg.model,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } }
        ]
      }],
      stream: false
    });
  } else {
    body = JSON.stringify({
      model: cfg.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      }],
      stream: false
    });
  }
  log('[VocabRadar][sw][' + _ts() + '] ocrLLM provider=' + cfg.provider + ' format=' + cfg.format + ' model=' + cfg.model);
  try {
    const resp = await fetch(url, { method: 'POST', headers, credentials: 'omit', cache: 'no-store', body });
    const raw = await resp.text();
    if (!resp.ok) {
      console.warn('[VocabRadar][sw][' + _ts() + '] ocrLLM HTTP ' + resp.status + ': ' + raw.slice(0, 300));
      return { ok: false, error: 'HTTP ' + resp.status + ' ' + raw.slice(0, 300) };
    }
    let data = null;
    try { data = JSON.parse(raw); } catch (e) {
      return { ok: false, error: '响应不是 JSON：' + raw.slice(0, 200) };
    }
    let content = '';
    if (isAnthropic) {
      content = Array.isArray(data && data.content)
        ? data.content.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('')
        : '';
    } else {
      content = data && data.choices && data.choices[0] && data.choices[0].message
        ? String(data.choices[0].message.content || '')
        : '';
    }
    if (!content) return { ok: false, error: '响应中无内容：' + raw.slice(0, 200) };
    return { ok: true, content };
  } catch (e) {
    console.error('[VocabRadar][sw][' + _ts() + '] ocrLLM 异常:', e);
    return { ok: false, error: String(e.message || e) };
  }
}
