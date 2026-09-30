/**
 * llm.js —— 对话（Chat）大模型配置：来源预置表 + 配置解析 + 免费来源轮替清单
 *
 * 本文件只负责"配置数据与解析"，不含网络请求，使 引导页(src/guide/guide.js) 与
 *   后台(src/background/sw/llm.js) 共用同一份来源表，避免两处各写一份导致地址/模型名不一致。
 *
 * format 维度决定请求分支（分支实现在 sw/llm.js 的 handleLlmChat，本文件只声明 format）：
 *     - 'openai'    ：POST {baseUrl}/chat/completions，Authorization: Bearer <key>，取 choices[0].message.content
 *     - 'anthropic' ：POST {baseUrl}/v1/messages，x-api-key + anthropic-version 头，max_tokens 必填，取 content[0].text
 *     - 'free'      ：请求形状同 openai，但完全不带鉴权头、也不要求 Key（免注册免账号的公开端点）
 *
 * 「河狸后端」组：local-backend（本地后端 http://127.0.0.1:7777/v1，OpenAI 格式，免 Key；
 *   预置地址即默认 7777，用户在 Endpoint 填空填完整地址即指向自定义端口，形制与其他
 *   LLM API 一致）与 official-backend（官方后端，阶段三上线，先占位域名）。format 仍为
 *   'openai'：请求形状复用既有 openai 分支，无 Key 时不带 Authorization 头，与本地后端
 *   （CORS/Host 已放行）天然兼容；且 format≠'free' 不触发免费轮替。group 字段供引导页
 *   下拉单独分组，noKey 字段标记免 Key。
 *
 * 注意：新增来源域名必须同时写入 data/manifest.json 的
 *   content_security_policy.extension_pages 的 connect-src，否则后台 fetch 会被 CSP 拦截。
 */

// API 格式的分组显示名：引导页下拉用 <optgroup> 按此分组，让"要不要账号"一眼可辨
// （backend 组的 provider 以 group 字段归入，format 仍是 'openai'）
export const LLM_FORMAT_GROUPS = [
  { format: 'free', label: { en: 'Free', zh: '免费直连' } },
  { format: 'backend', label: { en: 'VocabRadar backend', zh: '河狸后端' } },
  { format: 'openai', label: { en: 'OpenAI Chat Completion Style', zh: 'OpenAI Chat Completion 格式' } },
  { format: 'anthropic', label: { en: 'Anthropic Messages Style', zh: 'Anthropic Messages 格式' } }
];

// 来源预置表：id / format / 显示名（中英）/ 接口地址 / 默认模型。
// 不内置任何他人的 Key（既不合法也会失效），需要账号的来源只预置
//   "地址 + 模型名"两件麻烦事，用户只粘贴 Key 即可用。
export const LLM_PROVIDERS = [
  {
    // 免费直连 ①：Pollinations 公开文本端点，OpenAI 兼容形状且不校验任何鉴权头。
    // 匿名请求按 IP 限流，超额返回 402 Payment Required → 由轮替兜底。
    id: 'pollinations',
    format: 'free',
    label: { en: 'Pollinations', zh: 'Pollinations' },
    baseUrl: 'https://text.pollinations.ai/v1',
    model: 'openai-fast'
  },
  {
    // 免费直连 ②：OVHcloud AI Endpoints 的 OpenAI 兼容聚合端点，匿名可用，
    //   GET /v1/models 可列 24 个模型（gpt-oss-120b / Qwen3.5-397B-A17B 等）。
    // 匿名限流返回 429 → 由轮替兜底。
    id: 'ovh-kepler',
    format: 'free',
    label: { en: 'OVHcloud AI Endpoints', zh: 'OVHcloud AI 端点' },
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    model: 'Meta-Llama-3_3-70B-Instruct'
  },
  {
    // 免费直连 ③：OVHcloud 单模型端点，与 ② 是独立限流池（域名不同），可作第三家兜底。
    id: 'ovh-mistral7b',
    format: 'free',
    label: { en: 'OVHcloud Mistral-7B', zh: 'OVHcloud Mistral-7B' },
    baseUrl: 'https://mistral-7b-instruct-v0-3.endpoints.kepler.ai.cloud.ovh.net/api/openai_compat/v1',
    model: 'Mistral-7B-Instruct-v0.3'
  },
  {
    // 免费直连 ④：llm7.io 免费聚合端点，OpenAI 兼容且匿名（无鉴权头）可直接调用，
    //   匿名按 IP 限流、部分模型忙时返回 5xx → 由轮替兜底。默认模型取
    //   usage_based_only=false 的 turbo 档。
    id: 'llm7',
    format: 'free',
    label: { en: 'LLM7.io', zh: 'LLM7.io' },
    baseUrl: 'https://api.llm7.io/v1',
    model: 'mistral-Nemo-Instruct-2407'
  },
  {
    // 本地后端 —— backend 目录的 Flask 网关（默认对外 7777，llama-server 内部 7788），
    //   /v1/chat/completions 为 OpenAI 格式。本地使用免 Key：无 Key 时 openai 分支
    //   不带 Authorization 头，与后端 CORS/Host 校验兼容。
    id: 'local-backend',
    format: 'openai',
    group: 'backend',
    noKey: true,
    label: { en: 'Local', zh: '本地' },
    baseUrl: 'http://127.0.0.1:7777/v1',
    model: 'qwen3.5-0.8b'
  },
  {
    // 官方后端占位（plan 阶段三上线）：域名未定，先占 api.vocabradar.com，上线时改此一处
    //   即可（引导页 placeholder 随表走）。鉴权方式阶段三再定，暂按 openai 格式留 Key 框。
    id: 'official-backend',
    format: 'openai',
    group: 'backend',
    label: { en: 'Official', zh: '官方' },
    baseUrl: 'https://api.vocabradar.com/v1',
    model: 'qwen3.5-0.8b'
  },
  {
    id: 'groq',
    format: 'openai',
    label: { en: 'Groq', zh: 'Groq' },
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile'
  },
  {
    id: 'openrouter',
    format: 'openai',
    label: { en: 'OpenRouter', zh: 'OpenRouter' },
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemma-3-27b-it:free'
  },
  {
    id: 'gemini',
    format: 'openai',
    label: { en: 'Google Gemini', zh: 'Google Gemini' },
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash'
  },
  {
    // OpenAI 官方即 openai 格式的"原型"，放在本组首位更符合直觉。
    id: 'openai',
    format: 'openai',
    label: { en: 'OpenAI', zh: 'OpenAI' },
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  {
    id: 'deepseek',
    format: 'openai',
    label: { en: 'DeepSeek', zh: 'DeepSeek' },
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
  },
  {
    // 自定义 ①：任意 OpenAI 格式兼容服务（本地 Ollama / vLLM / 中转站均可），地址与模型名由用户填
    id: 'custom-openai',
    format: 'openai',
    label: { en: 'Custom', zh: '自定义' },
    baseUrl: '',
    model: ''
  },
  {
    // Anthropic 官方：与 OpenAI 格式不兼容（路径、鉴权头、响应结构、max_tokens 均不同）
    id: 'anthropic',
    format: 'anthropic',
    label: { en: 'Anthropic Claude', zh: 'Anthropic Claude' },
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-haiku-latest'
  },
  {
    // 自定义 ②：任意 Anthropic 格式兼容服务（自建代理 / 企业网关）
    id: 'custom-anthropic',
    format: 'anthropic',
    label: { en: 'Custom', zh: '自定义' },
    baseUrl: '',
    model: ''
  }
];

// 免费直连轮替清单（后台按此顺序试）：来源为免费直连且用户未手填地址/模型时默认轮替，
//   某家返回 402/429/网络错即自动改试下一家，全部失败才向用户报最后一次的原始错误。
export const LLM_FREE_ROTATION = ['pollinations', 'ovh-kepler', 'ovh-mistral7b', 'llm7'];

// 默认来源：免 Key 的 Pollinations —— 未配置任何 Key 的新用户点开对话即能得到回复，
//   而不是撞上"API Key 未配置"。已配置过的用户 storage 里存着自己的 llmProvider，不受影响。
export const LLM_DEFAULT_PROVIDER = 'pollinations';
// 默认对话提示词拆成两套：
//   1. 单词类查询（右键查询、悬浮提示里点开的单词）—— 讨论对象是一个词/一小段选区，
//      故模板带 {text} 占位（{text} = 该词/选区，{lang} = 释义语言）；
//   2. 侧栏（文本侧栏正文、视频侧栏字幕）—— 讨论对象是整篇正文，正文另由面板顶部
//      「The context is」上下文区承载，提问语只需指向"上面的文本"，故模板不含 {text}。
export const CHAT_WORD_PROMPT = 'Please explain "{text}" in {lang}.';
export const CHAT_SIDEBAR_PROMPT = 'Please summarise the text above in {lang}.';
// 翻译提示词兜底模板：正常走 config.json 出厂值 > storage > 此常量 三级优先，
//   由 translator/index.js 组装（{text} = 选中文本，{lang} = 释义语言名），SW 端只做哑管道直发。
//   约束句式防 LLM 输出解释/引号等冗余内容。
export const LLM_TRANSLATE_PROMPT = 'Translate "{text}" into {lang}. Output only the translation: no explanations, no quotes.';

/**
 * 按 id 取预置来源；未知 id 回退到默认来源（避免 storage 残留旧 id 导致取不到）
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
 * @param {object} res chrome.storage.local 读出的设置对象
 * @returns {{provider:string, format:string, noKey:boolean, baseUrl:string, model:string,
 *   apiKey:string, userBaseUrl:boolean, userModel:boolean}}
 *   userBaseUrl/userModel 标记"是否为用户手填"，后台据此判断能否用轮替替换地址与模型；
 *   noKey 标记来源是否免 Key（本地后端）——后台 llmVisionOnce 据此豁免 Key 强校验
 *   （与 free 同待遇），llmTranscribeBlob 鉴权头逻辑本就兼容无需改
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
    noKey: !!p.noKey,
    baseUrl,
    model,
    apiKey,
    userBaseUrl: !!rawBase,
    userModel: !!rawModel
  };
}
