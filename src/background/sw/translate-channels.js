// =============================================================================
// SW 在线翻译渠道实现（2026-09-27 拆分自 service-worker.js）
// 职责：9 个渠道的单次请求实现（渠道 0 Backend + 1-2 词典快渠道 + 3-8 兜底）。
// 顺序、勾选门控与"未翻译"判定都在 translate.js（编排层），本文件只管发请求取译文。
// 译文返回 null 即本渠道不可用，由编排层换下一渠道。
// =============================================================================
import { cleanDictEntry } from '../../lib/dict-clean.js';
import { resolveLlmConfig } from '../../lib/llm.js';
import { fetchWithTimeout, md5Hex } from './util.js';

/**
 * 第447次（用户裁定）：后端翻译渠道——POST {后端}/api/translate（**翻译路由**）。
 * 说人话：跟「LLM」渠道不是一回事——LLM 渠道打的是 /v1/chat/completions（大模型路由，
 *   走对话提示词）；本渠道打后端自己的翻译接口（backend/api/translate.py，引擎层
 *   由后端自行编排），扩展侧不拼任何提示词。
 * 地址与 Key 全部复用「对话」行（llmProvider/llmBaseUrl/llmApiKey）的配置——
 *   翻译栏目只做勾选，不配置（用户裁定「这里只是选择，配置在 Chat LLM 中」）：
 *   选 Local 预置 127.0.0.1:7777、选 Official 预置 api.vocabradar.com、
 *   Endpoint 手填则用手填值；免 Key 来源不带鉴权头（同 llmChatOnce 口径）。
 * @param {string} text 待译文本
 * @param {string} [src] 源语言代码（缺省 auto）
 * @param {string} tgt 目标语言代码
 * @returns {Promise<string|null>} 译文；null=后端返回空译文
 * @throws 地址/Key 未配置、网络不通、HTTP 非 2xx——由调用方捕获记入根因（不遮蔽）
 */
export async function backendTranslateOnce(text, src, tgt) {
  if (!text) return null;
  const res = await new Promise((r) => chrome.storage.local.get(
    { llmProvider: '', llmBaseUrl: '', llmModel: '', llmApiKey: '' }, (x) => r(x || {})));
  const cfg = resolveLlmConfig(res);
  // 预置 baseUrl 形如 http://127.0.0.1:7777/v1 —— 翻译路由不在 /v1 下，去尾再拼
  const base = String(cfg.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (!base) throw new Error('Base URL 未配置');
  if (!cfg.noKey && !cfg.apiKey) throw new Error('API Key 未配置');
  const headers = { 'Content-Type': 'application/json' };
  if (!cfg.noKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
  const resp = await fetchWithTimeout(base + '/api/translate', {
    method: 'POST', headers, credentials: 'omit', cache: 'no-store',
    body: JSON.stringify({ text, from: src || 'auto', to: tgt })
  }, 8000);
  let data = null;
  try { data = await resp.json(); } catch (_) { /* 非 JSON 响应，下面按状态码报 */ }
  if (!resp.ok) {
    throw new Error('HTTP ' + resp.status + (data && data.error ? ' ' + data.error : ''));
  }
  const out = data && String(data.text || '').trim();
  return out || null;
}

/**
 * 百度联想 sug（单词中文释义）
 * 反思（2026-08-13 第五十一次）：fanyi.baidu.com/sug 免签名、免 key、国内快。
 *   POST 表单 kw=<word>，返回 {errno:0, data:[{k,v}]}，v 含中文释义。
 *   仅适合单词/短词（本扩展翻译对象即单词），长文本走渠道 3-8 的完整翻译 API。
 */
export async function baiduSugTranslate(text, src, tgt) {
  if (!text || !/^[\w .'-]+$/.test(text) || text.length > 60) return null;
  const url = 'https://fanyi.baidu.com/sug';
  const params = new URLSearchParams({ kw: text });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://fanyi.baidu.com/'
    },
    body: params.toString()
  }, 8000);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || data.errno !== 0 || !Array.isArray(data.data)) return null;
  // 优先精确命中原文（大小写不敏感），否则取第一条联想
  const lower = text.toLowerCase();
  const hit = data.data.find((d) => d && d.k && d.k.toLowerCase() === lower);
  const item = hit || data.data[0];
  if (!item || !item.v) return null;
  const first = String(item.v).split('\n')[0].trim();
  // 反思（2026-08-16 第六十六次）：百度 sug 对屈折形式返回夹杂"原形(释义)的屈折说明"，
  //   如 "v. 促进( facilitate的第三人称单数 ); 使便利; ..."，清洗后再返回。
  return cleanDictEntry(first) || null;
}

/**
 * 有道词典 jsonapi（单词中文释义）
 * 反思（2026-08-13 第五十一次）：dict.youdao.com/jsonapi 免签名、免 key、国内快。
 *   POST q=<word>，返回 ec.word[].trs[] 英文释义（含中文，格式如 "n. 测验"）。
 *   仅适合单词，长文本走渠道 3-8。
 */
export async function youdaoDictTranslate(text, src, tgt) {
  if (!text || !/^[\w .'-]+$/.test(text) || text.length > 60) return null;
  const url = 'https://dict.youdao.com/jsonapi?q=' + encodeURIComponent(text) + '&doctype=json&keyfrom=fanyi.web&xmlVersion=norm';
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://dict.youdao.com/'
    }
  }, 8000);
  if (!res.ok) return null;
  const data = await res.json();
  const trs = data?.ec?.word?.[0]?.trs;
  if (!Array.isArray(trs) || trs.length === 0) return null;
  // 第一百二十三次（用户反馈"释义缺右括号：短裤( shor"）：l.i 是**分段数组**——
  //   长释义被有道切进多个元素（余段在 i[1..]，如 "ts）"），旧版只取 i[0] 必然截断。
  //   修正：拼接全部字符串段（跳过 '#' 开头的元数据标签）后再清洗。
  const parts = trs
    .map((tr) => {
      const segs = tr?.tr?.[0]?.l?.i;
      if (!Array.isArray(segs)) return '';
      const txt = segs
        .filter((seg) => typeof seg === 'string' && !seg.startsWith('#'))
        .join('');
      return txt ? txt.trim() : '';
    })
    .filter(Boolean);
  if (parts.length === 0) return null;
  // 反思（2026-08-16 第六十六次）：有道 jsonapi 对屈折形式返回夹杂"原形(释义)的屈折说明"，
  //   如 "v. 使更容易，使便利；促进，推动（facilitate 的第三人称单数）"，清洗后再返回。
  // 取前 3 条释义，用分号连接，避免过长
  return cleanDictEntry(parts.slice(0, 3).join('；')) || null;
}

export async function mymemoryTranslate(text, src, tgt) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${src}|${tgt}`;
  // 反思（2026-08-02）：增加 User-Agent header，部分 API 要求
  // 反思（2026-08-12）：用 fetchWithTimeout 替代裸 fetch，8 秒超时防止永久挂起
  const res = await fetchWithTimeout(url, {
    credentials: 'omit',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  }, 8000);
  if (!res.ok) return null;
  const data = await res.json();
  const t = data?.responseData?.translatedText;
  if (!t || /MYMEMORY WARNING|INVALID/i.test(t)) return null;
  return t;
}

export async function googleTranslate(text, src, tgt) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${src}&tl=${tgt}&dt=t&q=${encodeURIComponent(text)}`;
  // 反思（2026-08-12）：用 fetchWithTimeout，8 秒超时
  const res = await fetchWithTimeout(url, {
    credentials: 'omit',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  }, 8000);
  if (!res.ok) return null;
  const data = await res.json();
  // data[0] 是段次数组，每段 [原文, 译文, ...]
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  const out = data[0].map((seg) => (seg && seg[0]) ? seg[0] : '').join('');
  return out || null;
}

/**
 * 有道翻译（国内可用，作为最终兜底渠道）
 *
 * 反思（2026-08-02 修正）：
 *   Python 测试发现 fanyi.youdao.com/translate?doctype=json 返回 HTML 而非 JSON，
 *   该端点已失效。改用 fanyi.youdao.com/translate_o 接口（POST + form 数据）。
 *   但 translate_o 需要 sign 计算（涉及 JS 加密），较复杂。
 *   替代方案：使用有道智云 API 的公共端点，或改用其他渠道。
 *   最终方案：改用 translate.googleapis.com 的备选端点 + 增加 User-Agent。
 *   有道作为最后兜底，用 dict.youdao.com/leopard/t/translate 端点。
 *
 * 实际：保留 youdaoTranslate 函数，但改用正确的 API 端点。
 *   https://fanyi.youdao.com/translate_o 端点需要 POST + form 数据：
 *   i=text, from=src, to=tgt, smartresult=dict, client=fanyideskweb
 *   但需要 sign 计算（salt + md5），暂时跳过，回退到其他渠道。
 */
export async function youdaoTranslate(text, src, tgt) {
  // 有道翻译 API：POST https://fanyi.youdao.com/translate_o
  // 反思（2026-08-02 修正）：fanyi.youdao.com/translate?doctype=json 端点已失效（返回 HTML）。
  //   改用 translate_o 端点，需要 form 数据 + salt + sign（md5）。
  //   sign 计算参考有道网页版：md5(client + text + salt + key)
  //   client=fanyideskweb, salt=时间戳, key=固定值
  //   但 key 会变化，且签名算法可能更新，此处仅作尝试。
  //   若 sign 错误会返回 {"errorCode": 50} 或空结果，返回 null 让调用方继续。
  const salt = Date.now().toString();
  const client = 'fanyideskweb';
  // 有道网页版 key（可能失效，仅作兜底尝试）
  const sign = md5Hex(client + text + salt + 'Ygy_4c=r#e#4EX^NUGUc5');
  const url = 'https://fanyi.youdao.com/translate_o';
  const params = new URLSearchParams({
    i: text,
    from: src,
    to: tgt,
    smartresult: 'dict',
    client: client,
    salt: salt,
    sign: sign,
    lts: salt,
    bv: md5Hex(navigator.userAgent),
    doctype: 'json',
    version: '2.1',
    keyfrom: 'fanyi.web',
    action: 'FY_BY_DEFAULT'
  });
  // 反思（2026-08-12）：用 fetchWithTimeout，8 秒超时
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://fanyi.youdao.com/',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: params.toString()
  }, 8000);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.errorCode !== 0) return null;
  if (!Array.isArray(data.translateResult) || !data.translateResult[0]) return null;
  const seg = data.translateResult[0][0];
  if (!seg || !seg.tgt) return null;
  return seg.tgt.trim() || null;
}

/**
 * 百度翻译（国内可用，fanyi.baidu.com transapi 公共端点）
 *
 * 反思（2026-08-02）：用户反馈所有在线渠道都 Failed to fetch。
 *   Python 测试 MyMemory/Google 可达，但浏览器扩展 fetch 失败。
 *   根因：manifest CSP connect-src 没有包含翻译 API 域名，已修复。
 *   增加百度翻译作为另一个国内可用渠道。
 *   baidu transapi 公共端点：https://fanyi.baidu.com/transapi
 *   POST: query=text, from=src, to=tgt
 *   返回: { "data": [{"dst":"译文","src":"原文"}], "from":"en", "to":"zh" }
 */
export async function baiduTranslate(text, src, tgt) {
  // 反思（2026-08-05 修正）：百度 transapi 语言码与 ISO 639-1 不完全一致，
  //   未映射时百度可能不识别（如 ja/ko），返回原文未翻译。
  //   映射表参考百度翻译网页版实际请求：ja→jp, ko→kor, fr→fra, es→spa, de→de, ru→ru。
  //   zh/en 保持 2 字母。未列出的语言原样传递（百度可能识别或不识别）。
  const BAIDU_LANG_MAP = {
    ja: 'jp', ko: 'kor', fr: 'fra', es: 'spa', ar: 'ara', th: 'th',
    vi: 'vie', id: 'ind', ms: 'may', tl: 'fil', hi: 'hi', bn: 'ben',
    ta: 'tam', te: 'tel', ml: 'mal', tr: 'tr', nl: 'nl', el: 'el',
    sv: 'swe', no: 'nor', da: 'dan', fi: 'fin', pl: 'pl', cs: 'cs',
    hu: 'hu', ro: 'rom', uk: 'uk', he: 'heb', fa: 'per'
  };
  const from = BAIDU_LANG_MAP[src] || src;
  const to = BAIDU_LANG_MAP[tgt] || tgt;
  const url = 'https://fanyi.baidu.com/transapi';
  const params = new URLSearchParams({
    query: text,
    from: from,
    to: to
  });
  // 反思（2026-08-12）：用 fetchWithTimeout，8 秒超时
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://fanyi.baidu.com/'
    },
    body: params.toString()
  }, 8000);
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data.data) || data.data.length === 0) return null;
  return data.data.map((seg) => seg.dst || '').join('') || null;
}

/**
 * Bing 翻译（Edge 浏览器用户优先可用）
 *
 * 反思（2026-08-02）：用户在 Edge 浏览器，Bing 翻译可能更容易访问。
 *   Bing translator API 需要 IG token（从 bing.com/translator 页面获取）。
 *   ttranslatev3 端点：POST https://www.bing.com/ttranslatev3?isVertical=1&IG=xxx
 *   返回: [{ "translations": [{ "text": "译文", "to": "zh" }] }]
 *   若 token 获取失败或翻译失败，返回 null 让调用方继续其他渠道。
 */
let _bingIG = null;
let _bingIGTime = 0;
export async function bingTranslate(text, src, tgt) {
  // IG token 有效期约 5 分钟，过期重新获取
  if (!_bingIG || Date.now() - _bingIGTime > 4 * 60 * 1000) {
    try {
      // 反思（2026-08-12）：用 fetchWithTimeout，8 秒超时
      const pageRes = await fetchWithTimeout('https://www.bing.com/translator', {
        credentials: 'omit',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      }, 8000);
      if (!pageRes.ok) return null;
      const pageText = await pageRes.text();
      const igMatch = pageText.match(/IG:"([^"]+)"/);
      if (igMatch) {
        _bingIG = igMatch[1];
        _bingIGTime = Date.now();
      } else {
        return null;
      }
    } catch (e) {
      return null;
    }
  }

  const url = `https://www.bing.com/ttranslatev3?isVertical=1&IG=${_bingIG}&IID=translator.5010`;
  const params = new URLSearchParams({
    fromLang: 'auto-detect',
    text: text,
    to: tgt
  });
  // 反思（2026-08-12）：用 fetchWithTimeout，8 秒超时
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.bing.com/translator'
    },
    body: params.toString()
  }, 8000);
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const translations = data[0]?.translations;
  if (!Array.isArray(translations) || translations.length === 0) return null;
  return translations[0]?.text?.trim() || null;
}

/**
 * Lingva 翻译（Google 翻译的代理，避免 Google 直接被墙）
 *
 * 反思（2026-08-02）：Lingva 是 Google 翻译的开源代理，
 *   公共实例可能不稳定，但作为额外渠道尝试。
 *   API: https://lingva.ml/api/v1/{src}/{tgt}/{text}
 *   返回: { "translation": "译文" }
 */
export async function lingvaTranslate(text, src, tgt) {
  // 尝试多个 Lingva 实例
  const instances = [
    'https://lingva.ml',
    'https://translate.plausibility.cloud',
    'https://lingva.lunar.icu'
  ];
  for (const base of instances) {
    try {
      const url = `${base}/api/v1/${src}/${tgt}/${encodeURIComponent(text)}`;
      // 反思（2026-08-12）：用 fetchWithTimeout，8 秒超时
      const res = await fetchWithTimeout(url, {
        credentials: 'omit',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      }, 8000);
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.translation) return data.translation.trim();
    } catch (e) {
      // 继续尝试下一个实例
    }
  }
  return null;
}
