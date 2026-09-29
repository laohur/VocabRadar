/**
 * llm.js —— 对话（Chat）大模型配置：来源预置表 + 配置解析
 * （第445次：free 组裁撤，轮替清单随之移除，不再有免费轮替）
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
 * 第三百九十二次（plan 阶段二①）：新增「河狸后端」组两个来源 ——
 *   local-backend（本地后端 http://127.0.0.1:7777/v1，OpenAI 格式，免 Key；第401次
 *   起地址可被引导页「本地后端地址」填空的 backendBaseUrl 覆写）与
 *   official-backend（官方后端，阶段三上线，先占位域名）。format 仍为 'openai'：
 *   请求形状复用 service-worker 既有 openai 分支，无 Key 时不带 Authorization 头，
 *   与本地后端（CORS/Host 已放行）天然兼容；且 format≠'free' 不触发免费轮替。
 *   新增 group 字段供引导页下拉单独分组（不混入"需申请 Key"组），noKey 字段
 *   供引导页隐藏 Key 输入框。默认免费轮替（LLM_FREE_ROTATION / LLM_DEFAULT_PROVIDER）
 *   与免费项清单均不变。本地地址无需改 manifest：connect-src 已含 http:、
 *   host_permissions 已有 <all_urls>。
 *
 * 第444次（用户裁定：分组名 "Free, no account needed"→Free、"OpenAI-compatible
 *   (API key required)"→OpenAI-compatible、"Anthropic (API key required)"→Anthropic，
 *   所有选项移除括号后缀；VocabRadar backend 组内含 Local / Official 两选项）：
 *   仅改显示 label，id / format / baseUrl / model 一概不动，storage 旧值不受影响。
 *
 * 第445次（用户裁定）：
 *   1) free 组整体裁撤——"免费且无需账号的托管服务已不存在"（调研 2026-09-27：
 *      Pollinations 新网关 gen.pollinations.ai 全面要求 API key；免费 whisper API
 *      只有本地方案），chat/asr/ocr 三处下拉不再出现免费组。free 四家来源、
 *      LLM_FREE_ROTATION 轮替清单、getFreeProviders 一并删除；默认来源改为
 *      local-backend（本地后端免 Key 即用，见各自注释）。
 *   2) 组名按用户原文（Sytle 为笔误，经确认按 Style）：openai 组 →
 *      "OpenAI Chat Completion Style"，anthropic 组 → "Anthropic Messages Style"。
 *   3) 本地后端不再有独立「本地后端地址」填空（backendBaseUrl 已删）：形制与其他
 *      LLM API 完全一致——Endpoint 留空用预置 127.0.0.1:7777，用户在 Endpoint 填空
 *      填完整地址即指向自定义端口；后台不再范围扫描端口。
 *
 * 注意：新增来源域名必须同时写入 data/manifest.json 的
 *   content_security_policy.extension_pages 的 connect-src，否则后台 fetch 会被 CSP 拦截。
 */

// 三类 API 格式的分组显示名：引导页下拉用 <optgroup> 按此分组
// （第444次：组名简化；第445次：free 组裁撤，组名按用户裁定全称化）
export const LLM_FORMAT_GROUPS = [
  { format: 'backend', label: { en: 'VocabRadar backend', zh: '河狸后端' } },
  { format: 'openai', label: { en: 'OpenAI Chat Completion Style', zh: 'OpenAI Chat Completion 格式' } },
  { format: 'anthropic', label: { en: 'Anthropic Messages Style', zh: 'Anthropic Messages 格式' } }
];

// 来源预置表：id / format / 显示名（中英）/ 接口地址 / 默认模型
// 反思：不内置任何他人的 Key（既不合法也会失效），需要账号的来源只预置
//   "地址 + 模型名"两件麻烦事，用户只粘贴 Key 即可用。
export const LLM_PROVIDERS = [
  {
    // 第三百九十二次（plan 阶段二①）：本地后端 —— backend 目录的 Flask 网关（默认对外 7777，
    //   llama-server 内部 7788），/v1/chat/completions 为 OpenAI 格式（阶段一已实测）。
    //   本地使用免 Key：无 Key 时 openai 分支不带 Authorization 头，与后端 CORS/Host 校验兼容。
    //   第445次：预置地址即默认 7777，不再有「本地后端地址」独立填空与后台端口扫描——
    //   用户在 Endpoint 填空填完整地址即指向自定义端口（形制与其他 LLM API 一致）。
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
    // 第一百七十六次（用户："llm api，硅基流动换成 openai"）：原 siliconflow 一项整体替换为
    //   OpenAI 官方端点。OpenAI 官方即 openai 格式的"原型"，放在本组首位更符合直觉。
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

// 默认来源：第445次改为 local-backend —— free 组裁撤后，本地后端是唯一免 Key 即用的
//   来源（backend 起着即可对话）；已配置过的用户 storage 里存着自己的 llmProvider，不受影响。
export const LLM_DEFAULT_PROVIDER = 'local-backend';
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
// 翻译提示词兜底模板（2026-09-29）：正常走 config.json 出厂值 > storage > 此常量 三级优先，
//   由 translator/index.js 组装（{text} = 选中文本，{lang} = 释义语言名），SW 端只做哑管道直发。
//   约束句式防 LLM 输出解释/引号等冗余内容（旧硬编码 "Please translate ... in ..." 无任何输出约束）。
export const LLM_TRANSLATE_PROMPT = 'Translate "{text}" into {lang}. Output only the translation: no explanations, no quotes.';

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
 * 把 storage 里的设置解析为一次请求所需的最终配置
 * 规则：用户显式填写的 baseUrl/model 优先，留空则回退到所选来源的预置值。
 * 第一百八十四次：移除 prompt 字段 —— 提示词模板只在 content 侧 chat.js 消费
 *   （buildFirstPrompt 直接读 storage 的 chatWordPrompt/chatSidebarPrompt），
 *   后台 handleLlmChat 从不使用 cfg.prompt，留着只会误导且强绑单一模板常量。
 * @param {object} res chrome.storage.local 读出的设置对象
 * @returns {{provider:string, format:string, noKey:boolean, baseUrl:string, model:string,
 *   apiKey:string, userBaseUrl:boolean, userModel:boolean}}
 *   userBaseUrl/userModel 标记"是否为用户手填"，后台据此判断能否用轮替替换地址与模型；
 *   noKey（第三百九十三次）标记来源是否免 Key（本地后端）——后台 llmVisionOnce 据此
 *   豁免 Key 强校验（与 free 同待遇），llmTranscribeBlob 鉴权头逻辑本就兼容无需改
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
