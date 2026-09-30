// =============================================================================
// SW 在线翻译渠道实现
// 职责：9 个渠道的单次请求实现（Backend + 2 词典快渠道 + 6 在线兜底渠道）。
// 顺序、勾选门控与"未翻译"判定都在 translate.js（编排层），本文件只管发请求取译文。
// 译文返回 null 即本渠道不可用，由编排层换下一渠道；
// 抛错（HTTP 状态/不支持语言）由编排层记入错误汇总——不遮蔽根因。
// 渠道清单：backend / baidusug / youdaodict / reverso /
//   bing / google / youdao / baidu / mymemory(默认不选，末位手工兜底)；
//   lingva 公共实例不稳定已摘除。
// =============================================================================
import { cleanDictEntry } from '../../lib/dict-clean.js';
import { resolveLlmConfig } from '../../lib/llm.js';
import { fetchWithTimeout, md5Hex } from './util.js';

/**
 * 后端翻译渠道（用户裁定）——POST {后端}/api/translate（**翻译路由**）。
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
 * fanyi.baidu.com/sug 免签名、免 key、国内快。
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
  // 百度 sug 对屈折形式返回夹杂"原形(释义)的屈折说明"，
  //   如 "v. 促进( facilitate的第三人称单数 ); 使便利; ..."，清洗后再返回。
  return cleanDictEntry(first) || null;
}

/**
 * 有道词典 jsonapi（单词中文释义）
 * dict.youdao.com/jsonapi 免签名、免 key、国内快。
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
  // l.i 是分段数组（用户反馈"释义缺右括号：短裤( shor"）：长释义被有道切进多个元素
  //   （余段在 i[1..]，如 "ts）"），只取 i[0] 会截断——拼接全部字符串段（跳过 '#'
  //   开头的元数据标签）后再清洗。
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
  // 有道 jsonapi 对屈折形式返回夹杂"原形(释义)的屈折说明"，
  //   如 "v. 使更容易，使便利；促进，推动（facilitate 的第三人称单数）"，清洗后再返回。
  // 取前 3 条释义，用分号连接，避免过长
  return cleanDictEntry(parts.slice(0, 3).join('；')) || null;
}

export async function mymemoryTranslate(text, src, tgt) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${src}|${tgt}`;
  // 8 秒超时防永久挂起；User-Agent 部分端点要求
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
  // 8 秒超时
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
 * POST fanyi.youdao.com/translate_o：form 数据 + salt + sign（md5）。
 *   sign 计算参考有道网页版：md5(client + text + salt + key)，
 *   client=fanyideskweb、salt=时间戳、key 取网页版固定值——网页版更新签名算法
 *   即失效，属预期内的兜底尝试；sign 错误返回 {"errorCode": 50} 或空结果，
 *   返回 null 让调用方继续。
 */
export async function youdaoTranslate(text, src, tgt) {
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
  // 8 秒超时
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
 * POST: query=text, from=src, to=tgt
 * 返回: { "data": [{"dst":"译文","src":"原文"}], "from":"en", "to":"zh" }
 */
export async function baiduTranslate(text, src, tgt) {
  // 百度 transapi 语言码与 ISO 639-1 不完全一致，未映射时百度可能不识别（如 ja/ko）
  //   返回原文未翻译。映射表参考百度翻译网页版实际请求：ja→jp, ko→kor, fr→fra,
  //   es→spa, de→de, ru→ru。zh/en 保持 2 字母；未列出的语言原样传递（百度可能
  //   识别或不识别）。
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
  // 8 秒超时
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
 * API 需要 IG + AbusePrevention token（从 bing.com/translator 页面取）。
 * 实测可用配方（PowerShell 直发验证 200，running→correndo）：
 *     1. GET https://www.bing.com/translator（带浏览器 UA），取**最终 pageRes.url 的
 *        origin**作 POST base（cn 地区 302→cn.bing.com，必须用页面落点而非写死 www）；
 *     2. 页面解析三件套：IG:"..."、data-iid="translator.50xx"（5023/5025/5010 均可）、
 *        params_AbusePreventionHelper=[keyTs, token, expiry]；
 *     3. POST {origin}/ttranslatev3?isVertical=1&IG={ig}&IID={iid}，表单带
 *        fromLang=auto-detect / text / to / token / key={keyTs}（key 必须是第 1 元素
 *        时间戳；缺 token → 205，缺 UA → 401 ShowCaptcha）；
 *     4. fromLang 恒 auto-detect（auto→400、显式 from=zh→400）；to=zh 需 zh-Hans、
 *        to=sh → 400（跳过）。
 *   三件套缓存约 4 分钟；请求失败即清缓存重取页面重试一次（token 可能已过期）。
 * @returns {Promise<string|null>} 译文；null=响应无译文
 * @throws 页面取三件套失败、HTTP 非 2xx、响应结构异常——由编排层记入错误汇总
 */
let _bingSess = null;   // { origin, ig, iid, keyTs, token, ts }
export async function bingTranslate(text, src, tgt) {
  if (!text) return null;
  if (tgt === 'sh') throw new Error('不支持目标语言(sh)（Bing 端点 400）');
  const to = tgt === 'zh' ? 'zh-Hans' : tgt; // 实测 to=zh → 400，需区域码
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!_bingSess || Date.now() - _bingSess.ts > 4 * 60 * 1000) {
      _bingSess = null;
      if (!(await _bingFetchSession())) continue; // 会话取不到 → 下一轮直接退出
    }
    try {
      const res = await fetchWithTimeout(
        _bingSess.origin + '/ttranslatev3?isVertical=1&IG=' + encodeURIComponent(_bingSess.ig) + '&IID=' + encodeURIComponent(_bingSess.iid),
        {
          method: 'POST',
          credentials: 'omit',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Referer': _bingSess.origin + '/translator'
          },
          body: new URLSearchParams({
            fromLang: 'auto-detect',
            text: text,
            to: to,
            token: _bingSess.token,
            key: String(_bingSess.keyTs)
          }).toString()
        }, 8000);
      if (res.ok) {
        const data = await res.json(); // 非 JSON（205 网关页等）抛错 → 走下面清缓存重试
        const translations = Array.isArray(data) && data[0] && data[0].translations;
        const out = Array.isArray(translations) && translations[0] && translations[0].text;
        if (out) return String(out).trim();
        throw new Error('响应无译文: ' + JSON.stringify(data).slice(0, 120));
      }
      throw new Error('HTTP ' + res.status);
    } catch (e) {
      _bingSess = null; // token 过期/站点换签：清缓存，下一轮（attempt=1）重取页面
      if (attempt === 1) throw new Error('Bing 翻译失败: ' + String(e.message || e));
    }
  }
  return null;
}

/** 取 Bing 翻译页并解析三件套（IG/IID/AbusePrevention token）→ _bingSess；成功 true */
async function _bingFetchSession() {
  const pageRes = await fetchWithTimeout('https://www.bing.com/translator', {
    credentials: 'omit',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' }
  }, 8000);
  if (!pageRes.ok) throw new Error('translator 页 HTTP ' + pageRes.status);
  const origin = new URL(pageRes.url).origin; // 302 落点（cn 地区为 cn.bing.com）
  const html = await pageRes.text();
  const ig = (html.match(/IG:"([^"]+)"/) || [])[1];
  const iid = (html.match(/data-iid="([^"]+)"/) || [])[1];
  const ab = html.match(/params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"?([^",\s]+)"?/);
  if (!ig || !iid || !ab) throw new Error('页面三件套解析失败(IG=' + !!ig + ',IID=' + !!iid + ',token=' + !!ab + ')');
  _bingSess = { origin, ig, iid, keyTs: ab[1], token: ab[2], ts: Date.now() };
  return true;
}

/**
 * Reverso Context 翻译（用户裁定新增）
 *
 * 调研实测：POST https://api.reverso.net/translate/v1/translation，
 *   JSON 必填 from/to/input/format/text + options 全套（缺 options 即拒）；
 *   from 必须显式（无 auto）、from==to → direction_invalid；响应取 translation[0]。
 *   预检需浏览器 UA（否则 403）。SW 走 host_permissions:<all_urls> 绕 CORS。
 * 支持集（对本项目 42 语言码实测，不支持的快速跳过不发请求）：
 *   源不支持：bn,ur,id,fil,ta,fa,pl,sh,bg,fi,nb,lt,sl,mk,lv,is
 *   目标不支持：bn,ur,id,fil,ta,fa,ms,sh,he,bg,fi,nb,lt,sl,mk,lv,is
 *   （ms/he 可作源不可作目标）
 * @returns {Promise<string|null>} 译文；null=响应无译文
 * @throws 语言不支持/HTTP 非 2xx——由编排层记入错误汇总
 */
const REV_SRC_BAD = ['bn', 'ur', 'id', 'fil', 'ta', 'fa', 'pl', 'sh', 'bg', 'fi', 'nb', 'lt', 'sl', 'mk', 'lv', 'is'];
const REV_TGT_BAD = ['bn', 'ur', 'id', 'fil', 'ta', 'fa', 'ms', 'sh', 'he', 'bg', 'fi', 'nb', 'lt', 'sl', 'mk', 'lv', 'is'];
export async function reversoTranslate(text, src, tgt) {
  if (!text) return null;
  if (!src || src === 'auto') throw new Error('需显式源语言（端点不支持 auto）');
  if (REV_SRC_BAD.includes(src)) throw new Error('不支持源语言(' + src + ')');
  if (REV_TGT_BAD.includes(tgt)) throw new Error('不支持目标语言(' + tgt + ')');
  if (src === tgt) throw new Error('源语言与目标语言相同(' + src + ')');
  const res = await fetchWithTimeout('https://api.reverso.net/translate/v1/translation', {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      from: src,
      to: tgt,
      input: text,
      format: 'text',
      options: { sentenceSplitter: true, origin: 'translation-results', contextResults: false, languageDetection: false }
    })
  }, 8000);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const out = data && Array.isArray(data.translation) && data.translation[0];
  return out ? String(out).trim() : null;
}
