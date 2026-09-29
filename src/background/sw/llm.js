// =============================================================================
// SW LLM 请求（2026-09-27 拆分自 service-worker.js）
// 职责：对话（chat）非流式/流式单来源请求、对话的 LLM 文本翻译、
//   ASR/OCR 两组独立引擎配置解析（resolveLlmEngineCfg）、流式 Port 通道注册。
// 来源表与请求参数预设见 lib/llm.js（resolveLlmConfig，引导页与 SW 共用）。
// =============================================================================
import { resolveLlmConfig } from '../../lib/llm.js';
import { _ts, log } from './log.js';

// 第二百一十六次（用户："可以下拉，可以单独配置，跟聊天的LLM不同"）：
//   ASR-LLM 与 OCR-LLM 各自独立的 LLM 配置（asrLlm* / ocrLlm* 键），
//   provider 缺省 local-backend（第三百九十四次：随用户裁定由 openai 改河狸后端），
//   与聊天 llm* 配置互不影响。
export async function resolveLlmEngineCfg(engine) {
  const keys = (engine === 'asr')
    ? { p: 'asrLlmProvider', b: 'asrLlmBaseUrl', m: 'asrLlmModel', k: 'asrLlmApiKey' }
    : { p: 'ocrLlmProvider', b: 'ocrLlmBaseUrl', m: 'ocrLlmModel', k: 'ocrLlmApiKey' };
  const res = await new Promise((resolve) => {
    chrome.storage.local.get(
      // 第三百九十四次：兜底 provider 随用户裁定（"local-backend，没有免key后缀"）由
      //   'openai' 改 'local-backend'——storage 无值（从未打开引导页）时默认走河狸后端
      { [keys.p]: 'local-backend', [keys.b]: '', [keys.m]: '', [keys.k]: '' },
      (r) => resolve(r || {})
    );
  });
  const cfg = resolveLlmConfig({
    llmProvider: res[keys.p], llmBaseUrl: res[keys.b],
    llmModel: res[keys.m], llmApiKey: res[keys.k]
  });
  // 第445次：getBackendBase 覆写分支删除——backend 组预置 baseUrl 即默认 7777 地址，
  //   不再有「自动发现端口」（backend 启动前端口预检，占用即失败；扩展端不再范围尝试）
  return cfg;
}

// 第二百一十六次：LLM 文本翻译（翻译渠道候选之一）——直接复用聊天的 LLM 配置与轮替；
//   提示词只要求输出译文本身，词条级短文本，max_tokens 默认 1024 足够。
// 2026-09-29（用户："目前的翻译提示词模板效果差"）：提示词改为哑管道——content 侧
//   translator/index.js 三级优先组装（config.json llmTranslatePrompt ＞ storage ＞ 常量，
//   {lang} 用语言名）后随消息下发，本端非空即直发；空则保留旧硬编码兜底（兼容旧消息方）。
export async function handleLlmTranslate(text, target, prompt) {
  if (!text) return { ok: false, error: 'empty text' };
  let msg = (typeof prompt === 'string' && prompt.trim()) ? prompt : null;
  if (!msg) {
    const tgt = String(target || 'zh');
    const NL = String.fromCharCode(10);
    msg = 'Translate the following text into ' + tgt
      + '. Output ONLY the translation, with no commentary, no quotes.'
      + NL + NL + String(text);
  }
  const out = await handleLlmChat([{ role: 'user', content: msg }]);
  if (!out.ok) return { ok: false, error: out.error };
  return { ok: true, text: String(out.content || '').trim() };
}

// 第407次（用户："对话中，翻译输出很长乃至于无响应……是否应该约束，硬约束和提示词优化"）：
//   对话统一注入系统提示词——回答保持简洁；要求翻译时只输出译文本身
//   （专门翻译窗口 handleLlmTranslate 的 "Output ONLY the translation" 正是对话
//   链路缺的约束）；配合流式输出消除长输出黑盒等待，openai/free 请求体加
//   max_tokens 1024 硬约束（与 anthropic 分支既有上限对齐）。
const LLM_CHAT_SYSTEM = 'You are a concise assistant in a vocabulary-learning browser extension. '
  + 'Keep answers short and to the point. '
  + 'When the user asks for a translation, output ONLY the translation itself: '
  + 'no commentary, no quotes, no explanations. '
  + 'Respond in the language the user used unless they ask otherwise.';

/**
 * 代理 LLM 对话请求
 * 第一百七十一次：content script 受宿主页面 CSP 限制无法 fetch 第三方 API，
 *   统一由 SW 代理（扩展 CSP 的 connect-src 已加入各来源域名）。
 * 第一百七十四次：来源按 format 分两类（见 lib/llm.js），请求差异集中在本函数：
 *   - 'openai'   ：POST {baseUrl}/chat/completions，取 choices[0].message.content，
 *                  Authorization: Bearer 头（noKey 的 backend 组不带头）。
 *   - 'anthropic'：POST {baseUrl}/v1/messages，x-api-key + anthropic-version 头，
 *                  system 消息须单列、max_tokens 必填，取 content[0].text。
 * 第445次：'free' 格式与轮替机制随 free 组裁撤删除，只请求用户所选来源本身。
 * @param {Array<{role: string, content: string}>} messages 对话上下文
 * @param {(text: string) => void} [onDelta] 第407次：传入即走流式（SSE 逐 chunk 回调），
 *   不传保持原非流式行为（LLM_TRANSLATE 词条翻译仍走非流式）。
 * @returns {Promise<{ok: boolean, content?: string, error?: string, needConfig?: boolean}>}
 *   needConfig=true 表示尚未配置，前端应显示"打开设置"按钮而非只报错
 */
export async function handleLlmChat(messages, onDelta) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: 'empty messages' };
  }
  // 系统提示词统一在此注入（anthropic 分支由请求体构造时提到顶层 system 字段）
  const turns = [{ role: 'system', content: LLM_CHAT_SYSTEM }].concat(messages);
  // 读配置：引导页「模型」行写入的 llm* 键；缺省由 resolveLlmConfig 用来源预设补齐
  const res = await new Promise((resolve) => {
    chrome.storage.local.get(
      { llmProvider: '', llmBaseUrl: '', llmModel: '', llmApiKey: '' },
      (r) => resolve(r || {})
    );
  });
  const cfg = resolveLlmConfig(res);
  // 第445次（free 组裁撤 + 扩展端不再范围尝试）：原「local-backend 未手填地址则
  //   经 getBackendBase 自动发现端口覆写」与「free 组轮替清单（_llmFreeCursor 游标
  //   + 遇 402/429 换下一家免费直连）」整套删除——backend 预置 baseUrl 即 7777 地址，
  //   只尝试用户所选来源本身，失败如实上抛不换家。
  const attempts = [cfg];

  let last = { ok: false, error: 'no attempt' };
  for (let i = 0; i < attempts.length; i++) {
    // 第407次：传了 onDelta 走流式；turns 已含系统提示词，两路都必须用 turns
    last = onDelta
      ? await llmChatStreamOnce(attempts[i], turns, onDelta)
      : await llmChatOnce(attempts[i], turns);
    if (last.ok || !last.retryable) return last;
    log('[VocabRadar][sw][' + _ts() + '] llmChat 来源 ' + attempts[i].provider + ' 失败(' + last.error + ')');
  }
  // 全部失败：把最后一次的原始错误如实返回（不遮蔽），并去掉内部标记字段
  return { ok: false, error: last.error, needConfig: !!last.needConfig };
}

/**
 * 发起一次 LLM 请求（单来源）
 * @param {object} cfg resolveLlmConfig 的结果
 * @param {Array<{role: string, content: string}>} messages 对话上下文
 * @returns {Promise<{ok: boolean, content?: string, error?: string, needConfig?: boolean, retryable?: boolean}>}
 *   retryable=true 表示"本家限流/不通"（402/429/5xx/网络错）；第445次轮替已删，仅保留语义字段
 */
async function llmChatOnce(cfg, messages) {
  // 第445次：free 格式删除，是否需要 Key 只看 noKey（backend 组）
  const noKey = !!cfg.noKey;
  const isAnthropic = cfg.format === 'anthropic';
  // 不遮蔽错误：缺 baseUrl / 缺 model 都明确告知；Key 只对需账号的两类强制要求
  if (!noKey && !cfg.apiKey) return { ok: false, error: 'API Key 未配置', needConfig: true };
  if (!cfg.baseUrl) return { ok: false, error: 'Base URL 未配置', needConfig: true };
  if (!cfg.model) return { ok: false, error: '模型名未配置', needConfig: true };

  // 三类格式的 URL / 头 / 请求体差异
  const url = cfg.baseUrl + (isAnthropic ? '/v1/messages' : '/chat/completions');
  const headers = { 'Content-Type': 'application/json' };
  if (isAnthropic) {
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    // 浏览器环境直连 Anthropic 需显式声明，否则被其 CORS 策略拒绝
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (!noKey) {
    headers['Authorization'] = 'Bearer ' + cfg.apiKey;
  }
  let body;
  if (isAnthropic) {
    // Anthropic 的 system 不能混在 messages 里，须提到顶层字段
    const sys = messages.filter((m) => m && m.role === 'system').map((m) => String(m.content || '')).join('\n');
    const turns = messages.filter((m) => m && m.role !== 'system');
    const payload = { model: cfg.model, max_tokens: 1024, messages: turns, stream: false };
    if (sys) payload.system = sys;
    body = JSON.stringify(payload);
  } else {
    // 第407次：max_tokens 1024 硬约束（与 anthropic 分支既有上限对齐），防对话翻译输出超长无响应
    body = JSON.stringify({ model: cfg.model, messages, max_tokens: 1024, stream: false });
  }

  log('[VocabRadar][sw][' + _ts() + '] llmChat provider=' + cfg.provider + ' format=' + cfg.format
    + ' model=' + cfg.model + ' turns=' + messages.length);
  try {
    const resp = await fetch(url, { method: 'POST', headers, credentials: 'omit', cache: 'no-store', body });
    // 失败时把响应体前 300 字一并带回：各家错误信息（额度耗尽/模型名错/Key 无效）都在这里
    const raw = await resp.text();
    if (!resp.ok) {
      console.warn('[VocabRadar][sw][' + _ts() + '] llmChat HTTP ' + resp.status + ': ' + raw.slice(0, 300));
      // 402=配额耗尽、429=限流、5xx=服务端故障 → 标记可重试（第445次轮替已删，仅保留语义字段）
      const retryable = resp.status === 402 || resp.status === 429 || resp.status >= 500;
      return { ok: false, error: 'HTTP ' + resp.status + ' ' + raw.slice(0, 300), retryable };
    }
    let data = null;
    try { data = JSON.parse(raw); } catch (e) {
      // 返回体不是 JSON（常见于网关错误页/限流页）→ 如实带回可重试标记
      return { ok: false, error: '响应不是 JSON：' + raw.slice(0, 200), retryable: true };
    }
    // 响应解析：Anthropic 是 content[] 数组（取所有 text 块拼接），OpenAI 形状是 choices[0].message.content
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
    if (!content) return { ok: false, error: '响应中无内容：' + raw.slice(0, 200), retryable: true };
    return { ok: true, content };
  } catch (e) {
    console.error('[VocabRadar][sw][' + _ts() + '] llmChat 异常:', e);
    // 网络层异常（DNS/TLS/超时）→ 换一家可能成
    return { ok: false, error: String(e.message || e), retryable: true };
  }
}

/**
 * 第407次：LLM 流式请求（单来源）——SSE 逐 chunk 经 onDelta 回调，
 *   聊天气泡原地增长，消除长输出黑盒等待。请求形状与 llmChatOnce 一致
 *   （system 提示词 + max_tokens 1024 硬约束 + stream: true）。
 * 第445次（轮替已删，语义保留）：未产出任何 delta 前的失败（HTTP 非 200 /
 *   返回非 SSE / SSE 无内容）标记 retryable；已产出部分内容后中断则不重试
 *   （重发会重复输出），部分内容以 content 如实带回，由上层展示。
 * @param {object} cfg 同 llmChatOnce
 * @param {Array<{role: string, content: string}>} messages 已含 system 的对话上下文
 * @param {(text: string) => void} onDelta 每收到一段增量文本回调一次
 */
async function llmChatStreamOnce(cfg, messages, onDelta) {
  // 第445次：free 格式删除，是否需要 Key 只看 noKey（backend 组）
  const noKey = !!cfg.noKey;
  const isAnthropic = cfg.format === 'anthropic';
  if (!noKey && !cfg.apiKey) return { ok: false, error: 'API Key 未配置', needConfig: true };
  if (!cfg.baseUrl) return { ok: false, error: 'Base URL 未配置', needConfig: true };
  if (!cfg.model) return { ok: false, error: '模型名未配置', needConfig: true };

  const url = cfg.baseUrl + (isAnthropic ? '/v1/messages' : '/chat/completions');
  const headers = { 'Content-Type': 'application/json' };
  if (isAnthropic) {
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (!noKey) {
    headers['Authorization'] = 'Bearer ' + cfg.apiKey;
  }
  let body;
  if (isAnthropic) {
    // Anthropic 的 system 提到顶层字段；max_tokens 必填（流式同样 1024 上限）
    const sys = messages.filter((m) => m && m.role === 'system').map((m) => String(m.content || '')).join('\n');
    const turns = messages.filter((m) => m && m.role !== 'system');
    const payload = { model: cfg.model, max_tokens: 1024, messages: turns, stream: true };
    if (sys) payload.system = sys;
    body = JSON.stringify(payload);
  } else {
    body = JSON.stringify({ model: cfg.model, messages, max_tokens: 1024, stream: true });
  }

  log('[VocabRadar][sw][' + _ts() + '] llmChatStream provider=' + cfg.provider + ' format=' + cfg.format
    + ' model=' + cfg.model + ' turns=' + messages.length);
  let acc = '';
  try {
    const resp = await fetch(url, { method: 'POST', headers, credentials: 'omit', cache: 'no-store', body });
    if (!resp.ok) {
      const raw = await resp.text();
      console.warn('[VocabRadar][sw][' + _ts() + '] llmChatStream HTTP ' + resp.status + ': ' + raw.slice(0, 300));
      const retryable = resp.status === 402 || resp.status === 429 || resp.status >= 500;
      return { ok: false, error: 'HTTP ' + resp.status + ' ' + raw.slice(0, 300), retryable };
    }
    // 来源不支持流式时回 JSON：整包解析，形状同非流式，一次性回调兜底
    const ctype = resp.headers.get('content-type') || '';
    if (!ctype.includes('text/event-stream')) {
      const raw = await resp.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (_e) {
        return { ok: false, error: '响应不是 JSON：' + raw.slice(0, 200), retryable: true };
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
      if (!content) return { ok: false, error: '响应中无内容：' + raw.slice(0, 200), retryable: true };
      if (onDelta) onDelta(content);
      return { ok: true, content };
    }
    // SSE 逐 data: 行解析 delta（openai=choices[0].delta.content；anthropic=content_block_delta 的 delta.text）
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // 半行留在缓冲，下轮拼接
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j = null;
        try { j = JSON.parse(payload); } catch (_e) { continue; }
        // anthropic 流式错误事件：如实带回（已有部分内容则不轮替）
        if (isAnthropic && j.type === 'error') {
          const msg = (j.error && j.error.message) ? j.error.message : JSON.stringify(j.error || j);
          if (acc) return { ok: false, error: msg, content: acc };
          return { ok: false, error: msg, retryable: true };
        }
        const piece = isAnthropic
          ? (j.type === 'content_block_delta' && j.delta ? String(j.delta.text || '') : '')
          : (j.choices && j.choices[0] && j.choices[0].delta ? String(j.choices[0].delta.content || '') : '');
        if (piece) { acc += piece; if (onDelta) onDelta(piece); }
      }
    }
    if (!acc) return { ok: false, error: 'SSE 无内容', retryable: true };
    return { ok: true, content: acc };
  } catch (e) {
    console.error('[VocabRadar][sw][' + _ts() + '] llmChatStream 异常:', e);
    if (acc) return { ok: false, error: String(e.message || e), content: acc }; // 已有部分：不轮替
    return { ok: false, error: String(e.message || e), retryable: true };
  }
}

// 第407次：聊天流式通道——chat.js 用 chrome.runtime.connect({name:'llm-chat'}) 建长连，
//   delta 逐段推回前端气泡；sendMessage 一次性消息无法承载多次推送，故走 Port。
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'llm-chat') return;
  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'start') return;
    const post = (m) => { try { port.postMessage(m); } catch (_e) { /* 端口已断 */ } };
    handleLlmChat(msg.messages, (chunk) => post({ type: 'delta', text: chunk }))
      .then((r) => {
        post({ type: 'done', ok: !!r.ok, content: r.content || '', error: r.error || '',
          needConfig: !!r.needConfig, partial: !r.ok && !!r.content });
        port.disconnect();
      })
      .catch((e) => {
        post({ type: 'done', ok: false, error: String(e.message || e) });
        port.disconnect();
      });
  });
});
