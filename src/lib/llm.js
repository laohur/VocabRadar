/**
 * llm.js —— 对话（Chat）大模型配置：来源预置表 + 配置解析 + 免费来源轮替清单
 *
 * 背景（第一百七十次）：用户要求"引导页增加模型行，配置 api，包括 key 以及几个可直接用的
 *   免费来源（默认）"。本文件只负责"配置数据与解析"，不含网络请求，
 *   使 引导页(src/guide/guide.js) 与 后台(src/background/service-worker.js) 共用同一份来源表，
 *   避免两处各写一份导致地址/模型名不一致。
 *
 * 第一百七十四次（用户要求"api 格式分三类：openai、anthropic、免费直接的（不需账号）"）：
 *   引入 format 维度，取代原先"所有来源都是 OpenAI 兼容"的单一假设。三类语义：
 *     - 'openai'    ：POST {baseUrl}/chat/completions，Authorization: Bearer <key>，取 choices[0].message.content
 *     - 'anthropic' ：POST {baseUrl}/v1/messages，x-api-key + anthropic-version 头，max_tokens 必填，取 content[0].text
 *     - 'free'      ：请求形状同 openai，但完全不带鉴权头、也不要求 Key（免注册免账号的公开端点）
 *   请求分支实现在 service-worker.js 的 handleLlmChat；本文件只声明 format，不做请求。
 *
 * 第一百七十五次（用户："llm api，免费直连的，有几个列几个，另加 openai 格式兼容、anthropic
 *   格式兼容两样自定义模型，移除 Get a key 按钮"；裁定补充："默认轮替免费直连，除非用户配置 key"）：
 *   1) 免费直连由 1 家扩为 3 家（均已本机实测 HTTP 200，见各项注释），并新增
 *      LLM_FREE_ROTATION 轮替清单：后台默认在三家之间轮替，遇 402/429 自动改试下一家
 *      —— 直接应对用户实测到的 Pollinations "HTTP 402 Payment Required"（匿名配额限流）。
 *   2) 原 'custom' 单项拆为 'custom-openai' / 'custom-anthropic' 两个自定义来源。
 *   3) 全表删除 keyUrl 字段（引导页"Get a key"入口一并移除）。
 *
 * 注意：新增来源域名必须同时写入 data/manifest.json 的
 *   content_security_policy.extension_pages 的 connect-src，否则后台 fetch 会被 CSP 拦截。
 */

// 三类 API 格式的分组显示名：引导页下拉用 <optgroup> 按此分组，让"要不要账号"一眼可辨
export const LLM_FORMAT_GROUPS = [
  { format: 'free', label: { en: 'Free, no account needed', zh: '免费直连（无需账号 / 无需 Key）' } },
  { format: 'openai', label: { en: 'OpenAI-compatible (API key required)', zh: 'OpenAI 格式（需申请 Key）' } },
  { format: 'anthropic', label: { en: 'Anthropic (API key required)', zh: 'Anthropic 格式（需申请 Key）' } }
];

// 来源预置表：id / format / 显示名（中英）/ 接口地址 / 默认模型
// 反思：不内置任何他人的 Key（既不合法也会失效），需要账号的来源只预置
//   "地址 + 模型名"两件麻烦事，用户只粘贴 Key 即可用。
export const LLM_PROVIDERS = [
  {
    // 免费直连 ①：Pollinations 公开文本端点，OpenAI 兼容形状且不校验任何鉴权头。
    // 已实测（2026-08-29）：POST https://text.pollinations.ai/v1/chat/completions
    //   body {model:'openai-fast', messages:[...]} → HTTP 200，返回 choices[0].message.content。
    // 局限：匿名请求按 IP 限流，超额返回 402 Payment Required（用户已实测遇到）→ 由轮替兜底。
    id: 'pollinations',
    format: 'free',
    label: { en: 'Pollinations (no key)', zh: 'Pollinations（免 Key）' },
    baseUrl: 'https://text.pollinations.ai/v1',
    model: 'openai-fast'
  },
  {
    // 免费直连 ②：OVHcloud AI Endpoints 的 OpenAI 兼容聚合端点，匿名可用。
    // 已实测（2026-08-29）：POST https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions
    //   body {model:'Meta-Llama-3_3-70B-Instruct', messages:[...]} → HTTP 200。
    // GET /v1/models 可列 24 个模型（gpt-oss-120b / Qwen3.5-397B-A17B / Mistral-Small-3.2-24B 等）。
    // 局限：匿名限流，压测时返回 429 → 由轮替兜底。
    id: 'ovh-kepler',
    format: 'free',
    label: { en: 'OVHcloud AI Endpoints (no key)', zh: 'OVHcloud AI 端点（免 Key）' },
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    model: 'Meta-Llama-3_3-70B-Instruct'
  },
  {
    // 免费直连 ③：OVHcloud 单模型端点，与 ② 是独立限流池（域名不同），因此可作第三家兜底。
    // 已实测（2026-08-29）：POST https://mistral-7b-instruct-v0-3.endpoints.kepler.ai.cloud.ovh.net
    //   /api/openai_compat/v1/chat/completions，model 'Mistral-7B-Instruct-v0.3' → HTTP 200。
    id: 'ovh-mistral7b',
    format: 'free',
    label: { en: 'OVHcloud Mistral-7B (no key)', zh: 'OVHcloud Mistral-7B（免 Key）' },
    baseUrl: 'https://mistral-7b-instruct-v0-3.endpoints.kepler.ai.cloud.ovh.net/api/openai_compat/v1',
    model: 'Mistral-7B-Instruct-v0.3'
  },
  {
    id: 'groq',
    format: 'openai',
    label: { en: 'Groq (free tier, fastest)', zh: 'Groq（免费额度，速度最快）' },
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile'
  },
  {
    id: 'openrouter',
    format: 'openai',
    label: { en: 'OpenRouter (most free models)', zh: 'OpenRouter（免费模型最多）' },
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemma-3-27b-it:free'
  },
  {
    id: 'gemini',
    format: 'openai',
    label: { en: 'Google Gemini (OpenAI-compatible)', zh: 'Google Gemini（OpenAI 兼容端点）' },
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash'
  },
  {
    // 第一百七十六次（用户："llm api，硅基流动换成 openai"）：原 siliconflow 一项整体替换为
    //   OpenAI 官方端点。OpenAI 官方即 openai 格式的"原型"，放在本组首位更符合直觉。
    id: 'openai',
    format: 'openai',
    label: { en: 'OpenAI (official)', zh: 'OpenAI（官方）' },
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  {
    id: 'deepseek',
    format: 'openai',
    label: { en: 'DeepSeek (CN direct)', zh: 'DeepSeek（国内直连）' },
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
  },
  {
    // 自定义 ①：任意 OpenAI 格式兼容服务（本地 Ollama / vLLM / 中转站均可），地址与模型名由用户填
    id: 'custom-openai',
    format: 'openai',
    label: { en: 'Custom (OpenAI-compatible)', zh: '自定义（OpenAI 格式兼容）' },
    baseUrl: '',
    model: ''
  },
  {
    // Anthropic 官方：与 OpenAI 格式不兼容（路径、鉴权头、响应结构、max_tokens 均不同）
    id: 'anthropic',
    format: 'anthropic',
    label: { en: 'Anthropic Claude (official)', zh: 'Anthropic Claude（官方）' },
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-haiku-latest'
  },
  {
    // 自定义 ②：任意 Anthropic 格式兼容服务（自建代理 / 企业网关）
    id: 'custom-anthropic',
    format: 'anthropic',
    label: { en: 'Custom (Anthropic-compatible)', zh: '自定义（Anthropic 格式兼容）' },
    baseUrl: '',
    model: ''
  }
];

// 免费直连轮替清单（后台按此顺序试）：用户未配置 Key 时默认轮替，
//   某家返回 402/429/网络错即自动改试下一家，三家全败才向用户报最后一次的原始错误。
export const LLM_FREE_ROTATION = ['pollinations', 'ovh-kepler', 'ovh-mistral7b'];

// 默认来源：第一百七十四次改为免 Key 的 Pollinations —— 未配置任何 Key 的新用户
//   点开对话即能得到回复，而不是撞上"API Key 未配置"。已配置过的用户 storage 里
//   存着自己的 llmProvider，不受影响。
export const LLM_DEFAULT_PROVIDER = 'pollinations';
// 默认对话提示词（第一百八十四次，按用户裁定拆成两套）：
//   1. 单词类查询（右键查询、悬浮提示里点开的单词）—— 讨论对象是一个词/一小段选区，
//      故模板带 {text} 占位（{text} = 该词/选区，{lang} = 释义语言）；
//   2. 侧栏（文本侧栏正文、视频侧栏字幕）—— 讨论对象是整篇正文，正文另由面板顶部
//      「The context is」上下文区承载，提问语只需指向"上面的文本"，故模板不含 {text}。
//   旧版只有一套 'Please explain "{text}" in {lang}.'，侧栏也套用它 →
//   整篇正文被塞进 {text} 里，读起来是"解释这段文本"而非"总结上文"。
// 2026-09-02 修正占位为 {text}（用户裁定：Please explain "{text}" in {lang}. / Please translate "{text}" in {lang}.）
export const CHAT_WORD_PROMPT = 'Please explain "{text}" in {lang}.';
export const CHAT_SIDEBAR_PROMPT = 'Please summarise the text above in {lang}.';

/**
 * 按 id 取预置来源；未知 id 回退到默认来源（避免 storage 残留旧 id 导致取不到，
 *   例如第一百七十五次把 'custom' 拆成两项后，老配置里的 'custom' 会落到此回退）
 * @param {string} id 来源 id
 * @returns {object} 预置来源对象
 */
export function getProvider(id) {
  return LLM_PROVIDERS.find((p) => p.id === id)
    || LLM_PROVIDERS.find((p) => p.id === LLM_DEFAULT_PROVIDER);
}

/**
 * 取免费直连来源列表（按 LLM_FREE_ROTATION 的顺序），供后台轮替使用
 * @returns {Array<object>} 免费来源对象数组
 */
export function getFreeProviders() {
  return LLM_FREE_ROTATION.map((id) => getProvider(id)).filter((p) => p && p.format === 'free');
}

/**
 * 把 storage 里的设置解析为一次请求所需的最终配置
 * 规则：用户显式填写的 baseUrl/model 优先，留空则回退到所选来源的预置值。
 * 第一百八十四次：移除 prompt 字段 —— 提示词模板只在 content 侧 chat.js 消费
 *   （buildFirstPrompt 直接读 storage 的 chatWordPrompt/chatSidebarPrompt），
 *   后台 handleLlmChat 从不使用 cfg.prompt，留着只会误导且强绑单一模板常量。
 * @param {object} res chrome.storage.local 读出的设置对象
 * @returns {{provider:string, format:string, baseUrl:string, model:string, apiKey:string,
 *   userBaseUrl:boolean, userModel:boolean}}
 *   userBaseUrl/userModel 标记"是否为用户手填"，后台据此判断能否用轮替替换地址与模型
 */
export function resolveLlmConfig(res) {
  const p = getProvider(res && res.llmProvider);
  const rawBase = String((res && res.llmBaseUrl) || '').trim().replace(/\/+$/, '');
  const rawModel = String((res && res.llmModel) || '').trim();
  const baseUrl = rawBase || String(p.baseUrl || '').trim().replace(/\/+$/, '');
  const model = rawModel || String(p.model || '').trim();
  const apiKey = String((res && res.llmApiKey) || '').trim();
  // format 随来源走：三类请求分支据此选择路径/鉴权头/响应解析
  return {
    provider: p.id,
    format: p.format || 'openai',
    baseUrl,
    model,
    apiKey,
    userBaseUrl: !!rawBase,
    userModel: !!rawModel
  };
}
