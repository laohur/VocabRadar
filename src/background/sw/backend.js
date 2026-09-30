// =============================================================================
// SW 网络代理
// 职责：content script / guide 页受各自 CSP 限制不能直连的请求，统一由 SW 代理
//   （SW 有 host_permissions <all_urls>，无页面 CSP）：
//   - 字幕代理 FETCH_SUBTITLE、backend 任务 ASR_JOB_SUBMIT/POLL、字幕兜底 YTDL_SUBTITLES
//   - 词典数据 FETCH_URL、正文 FETCH_TEXT（Parser 链接）、kuromoji 词典 KURO_FETCH
// backend 地址固定 BACKEND_BASE_DEFAULT（7777），扩展端不再范围尝试端口。
// =============================================================================
import { _ts, log } from './log.js';
import { abToB64 } from './util.js';

/**
 * 代理下载字幕（绕过 content script 的 CORS 限制）
 * service worker 环境不受 CORS 限制，可以直接 fetch YouTube/B站 字幕 URL
 * @param {string} url 字幕 URL
 * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
 */
export async function handleFetchSubtitle(url) {
  if (!url) {
    console.warn('[VocabRadar][sw][' + _ts() + '] fetchSubtitle: empty url');
    return { ok: false, error: 'empty url' };
  }
  log('[VocabRadar][sw][' + _ts() + '] fetchSubtitle:', url.slice(0, 100) + '...');
  try {
    const res = await fetch(url, { credentials: 'omit' });
    log('[VocabRadar][sw][' + _ts() + '] fetchSubtitle 响应:', res.status, res.statusText);
    if (!res.ok) {
      return { ok: false, error: 'HTTP ' + res.status };
    }
    const text = await res.text();
    log('[VocabRadar][sw][' + _ts() + '] fetchSubtitle 成功, 内容长度:', text.length);
    return { ok: true, text };
  } catch (e) {
    console.error('[VocabRadar][sw][' + _ts() + '] fetchSubtitle 异常:', e);
    return { ok: false, error: String(e.message || e) };
  }
}

// === backend 代理（ASR 任务 + 字幕兜底） ===
// 背景：content script 受页面 CSP connect-src 限制无法直连 backend
//   （同 FETCH_SUBTITLE 代理的原因），SW 有 host_permissions 可直接 fetch。
// 用户裁定「扩展端不再范围尝试」：端口可配置/自动发现方案整体删除——backend 固定 7777
//   （backend 启动前端口预检，占用即失败、由用户解除占用或指定端口，不再递延），
//   任务地址一律 BACKEND_BASE_DEFAULT，连接错误如实上抛。
export const BACKEND_BASE_DEFAULT = 'http://127.0.0.1:7777';

/** 单次提交 ASR 任务：POST /api/asr/jobs {url, language} → {ok, id, status, cached}。
 *  网络层失败标 net=true（backend 根本没跑通），HTTP 层错误不标（backend 在跑）
 *  ——NM 自动唤起已撤销，net 仅供调用方提示用语区分，不再触发自动拉起。
 * @param {string} url 视频/音频页 URL（backend yt-dlp 解析下载）
 * @param {string} [language] 识别语言（ISO 码，缺省自动检测）
 * @returns {Promise<{ok: boolean, id?: string, status?: string, cached?: boolean, error?: string, net?: boolean}>}
 */
export async function submitAsrJobOnce(url, language) {
  if (!url) return { ok: false, error: 'empty url' };
  try {
    const base = BACKEND_BASE_DEFAULT;
    const res = await fetch(base + '/api/asr/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, language: language || undefined }),
      credentials: 'omit', cache: 'no-store'
    });
    const data = await res.json();
    if (!res.ok) {
      console.warn('[VocabRadar][sw][' + _ts() + '] asrJobSubmit HTTP ' + res.status + ':', data && data.error);
      return { ok: false, error: (data && data.error) || ('HTTP ' + res.status), message: data && data.message };
    }
    return data;
  } catch (e) {
    // 不遮蔽：backend 未启动 / 网络不通原样上抛（调用方决定回退路径）
    console.error('[VocabRadar][sw][' + _ts() + '] asrJobSubmit 异常:', e);
    return { ok: false, error: String(e.message || e), net: true };
  }
}

// backend 由用户手动启动，连通性检测收编进引导页各来源的「检测」按钮
//   （√/× 结果），失败如实上抛不自动拉起。

/**
 * 轮询 ASR 任务增量：GET /api/asr/jobs/<id>?after=N → 任务快照
 * （status/progress{download,transcribe}/segments(新增段,带 start/end)/segments_total）
 * @param {string} id 任务 id
 * @param {number} [after] 游标：已取到的段数，只回其后新增段
 * @returns {Promise<{ok: boolean, error?: string} & Record<string, unknown>>}
 */
export async function handleAsrJobPoll(id, after) {
  if (!id) return { ok: false, error: 'empty id' };
  try {
    const base = BACKEND_BASE_DEFAULT;
    const res = await fetch(base + '/api/asr/jobs/' + encodeURIComponent(id)
      + '?after=' + (Number.isFinite(after) && after > 0 ? after : 0),
      { credentials: 'omit', cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) {
      console.warn('[VocabRadar][sw][' + _ts() + '] asrJobPoll HTTP ' + res.status + ':', data && data.error);
      return { ok: false, error: (data && data.error) || ('HTTP ' + res.status) };
    }
    return data;
  } catch (e) {
    console.error('[VocabRadar][sw][' + _ts() + '] asrJobPoll 异常:', e);
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 字幕 backend 兜底——GET /api/ytdl/subtitles?url=&lang=
 * 扩展侧五路字幕全失败后经此代理调 backend yt-dlp 提取（纯文本直出）。
 * @param {string} url 视频页 URL
 * @param {string} [lang] 期望语言（zh/en…，缺省由 backend 取首个轨道）
 * @returns {Promise<{ok: boolean, lang?: string, kind?: string, text?: string,
 *   available?: object, error?: string, message?: string}>}
 */
export async function handleYtdlSubtitles(url, lang) {
  if (!url) return { ok: false, error: 'empty url' };
  try {
    const base = BACKEND_BASE_DEFAULT;
    const qs = '?url=' + encodeURIComponent(url)
      + (lang ? '&lang=' + encodeURIComponent(lang) : '');
    const res = await fetch(base + '/api/ytdl/subtitles' + qs,
      { credentials: 'omit', cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) {
      console.warn('[VocabRadar][sw][' + _ts() + '] ytdlSubtitles HTTP ' + res.status + ':', data && data.error);
      return { ok: false, error: (data && data.error) || ('HTTP ' + res.status), message: data && data.message };
    }
    return data;
  } catch (e) {
    console.error('[VocabRadar][sw][' + _ts() + '] ytdlSubtitles 异常:', e);
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 代理 fetch JSON 请求（绕过 content script 的 CSP/CORS 限制）
 * diverse-lemmas 词典数据需从 CDN 下载，
 *   content script 受页面 CSP 限制可能失败，SW 有 host_permissions 可直接 fetch。
 * @param {string} url JSON 数据 URL
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 */
export async function handleFetchUrl(url) {
  if (!url) return { ok: false, error: 'empty url' };
  log('[VocabRadar][sw][' + _ts() + '] fetchUrl:', url.slice(0, 120));
  try {
    // cache:'no-store' 避免浏览器 HTTP 缓存返回旧响应
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) {
      console.warn('[VocabRadar][sw][' + _ts() + '] fetchUrl HTTP ' + res.status + ':', url.slice(0, 80));
      return { ok: false, error: 'HTTP ' + res.status };
    }
    const data = await res.json();
    // 诊断日志：记录返回数据的 key 数量，便于排查词典加载异常
    const dataKeys = (data && typeof data === 'object') ? Object.keys(data).length : -1;
    const wdKeys = (data && data.word_dict && typeof data.word_dict === 'object') ? Object.keys(data.word_dict).length : -1;
    log('[VocabRadar][sw][' + _ts() + '] fetchUrl 成功, topKeys=' + dataKeys + ' wordDictKeys=' + wdKeys);
    return { ok: true, data };
  } catch (e) {
    console.error('[VocabRadar][sw][' + _ts() + '] fetchUrl 异常:', e);
    return { ok: false, error: String(e.message || e) };
  }
}

// === Parser 链接抓取文本中转（guide/parser.js parseLink） ===
// 引导页直接 fetch 任意链接行不通——扩展页 CSP
//   extension_pages 的 connect-src 是固定白名单（词典/翻译/LLM CDN），任意站点
//   （用户实测 usepomo.ai）被拒："Refused to connect because it violates the
//   document's Content Security Policy"。SW 无页面 CSP、有 host_permissions
//   <all_urls>，页面经消息中转即可。镜像 handleFetchUrl 风格，返回纯文本。
export async function handleFetchText(url) {
  if (!url) return { ok: false, error: 'empty url' };
  log('[VocabRadar][sw][' + _ts() + '] fetchText:', url.slice(0, 120));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);   // 30s 超时防挂死
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) {
      console.warn('[VocabRadar][sw][' + _ts() + '] fetchText HTTP ' + res.status + ':', url.slice(0, 80));
      return { ok: false, error: 'HTTP ' + res.status + ' ' + url.slice(0, 80) };
    }
    const text = await res.text();
    log('[VocabRadar][sw][' + _ts() + '] fetchText 成功, ' + text.length + ' chars');
    return { ok: true, text, finalUrl: res.url || url };
  } catch (e) {
    console.error('[VocabRadar][sw][' + _ts() + '] fetchText 异常:', e);
    // Failed to fetch 无法定位——Chrome 网络错误的具体原因在 e.cause
    //   （DNS 失败/TLS/被拒等），带上便于用户与排查定位
    const cause = e && e.cause ? ' (' + String(e.cause.message || e.cause).slice(0, 120) + ')' : '';
    return { ok: false, error: String(e.message || e) + cause };
  } finally {
    clearTimeout(timer);
  }
}

// === kuromoji 日语注音词典 CDN 中转 ===
// 背景：词典 12 个 .dat.gz（约 17MB）不随包，phonemize-ja.mjs 里 kuroshiro＋kuromoji
//   运行时加载。content script 的 XHR 受宿主页面 CSP connect-src 约束（B站/YouTube
//   等不放行 CDN 域），故 BrowserDictionaryLoader（构建时 patch，见
//   scripts/build-phonemize.mjs）发 KURO_FETCH 消息，由 SW 代理 fetch。
// 安全：URL 白名单——域名限下方 4 源、路径限 kuromoji@0.1.2/dict/、文件名限 12 个
//   固定值；即使宿主页面伪造消息，也只能拉到这 12 个公开词典文件（防借道 SSRF）。
// 回退链：jsdelivr 三镜像（cdn→fastly→gcore，/npm/ 前缀）→ unpkg（无 /npm/ 前缀），
//   与 tessdata 回退链同构（offscreen.js TESSDATA_SOURCES）。
// 回传：base64 字符串（chrome.runtime 消息默认 JSON 序列化，ArrayBuffer 直传实测变
//   {}——structured clone 仅 Chrome 148+ manifest 可选项；页面端
//   build-phonemize.mjs 注入的 loader 内联 atob 解码）；内容仍是 gzip 原始
//   字节，gunzip 由 kuromoji 自己做。命中本地 Cache API 时直接回缓存不发网络。
const KURO_DICT_BASE = 'kuromoji@0.1.2/dict/';
const KURO_DICT_FILES = new Set([
  'base.dat.gz', 'check.dat.gz', 'tid.dat.gz', 'tid_pos.dat.gz', 'tid_map.dat.gz', 'cc.dat.gz',
  'unk.dat.gz', 'unk_pos.dat.gz', 'unk_map.dat.gz', 'unk_char.dat.gz', 'unk_compat.dat.gz', 'unk_invoke.dat.gz',
]);
const KURO_SOURCES = [
  { host: 'cdn.jsdelivr.net', prefix: '/npm/' },
  { host: 'fastly.jsdelivr.net', prefix: '/npm/' },
  { host: 'gcore.jsdelivr.net', prefix: '/npm/' },
  { host: 'unpkg.com', prefix: '/' },
];

export async function handleKuroFetch(url) {
  try {
    const u = new URL(url);
    const idx = u.pathname.indexOf(KURO_DICT_BASE);
    const file = idx >= 0 ? u.pathname.slice(idx + KURO_DICT_BASE.length) : '';
    if (!KURO_DICT_FILES.has(file)) {
      return { ok: false, error: 'kuroFetch: 非白名单词典文件: ' + (file || u.pathname) };
    }
    const dictPath = u.pathname.slice(idx); // kuromoji@0.1.2/dict/<file>
    // 本地持久缓存优先（用户批复"文件存入本地缓存，供调用"；业界同型：
    //   transformers.js 默认 Cache API 'transformers-cache'，tesseract.js 用 IndexedDB，
    //   kuromoji.js 官方 loader 无任何缓存）：caches.open('kuro-dict-v1')，key=完整
    //   tryUrl（含 kuromoji@0.1.2 版本锁，内容永不变）→ 无需失效逻辑；缓存层任何
    //   异常（无 Cache API/配额满）均退化纯网络，不阻塞多源回退链。
    let cache = null;
    try { cache = await caches.open('kuro-dict-v1'); } catch (_) { /* Cache API 不可用，退化纯网络 */ }
    const srcErrs = []; // 逐源失败原因收集（用户裁定：失败要说清哪个链接连不上）
    for (const src of KURO_SOURCES) {
      const tryUrl = 'https://' + src.host + src.prefix + dictPath;
      try {
        const hit = cache ? await cache.match(tryUrl) : null;
        if (hit) {
          const cbuf = await hit.arrayBuffer();
          log('[VocabRadar][sw][' + _ts() + '] kuroFetch ' + file + ' ← 本地缓存 ' + (cbuf.byteLength / 1024).toFixed(1) + 'KB');
          return { ok: true, b64: abToB64(cbuf) };
        }
        const res = await fetch(tryUrl, { credentials: 'omit' });
        if (!res.ok) {
          log('[VocabRadar][sw][' + _ts() + '] kuroFetch HTTP ' + res.status + ': ' + tryUrl);
          srcErrs.push(tryUrl + ' -> HTTP ' + res.status);
          continue;
        }
        // 回填本地缓存（clone 后 put；失败静默——缓存是加速项不是依赖项）
        if (cache) {
          try { await cache.put(tryUrl, res.clone()); } catch (_) { /* 配额满等，忽略 */ }
        }
        const buf = await res.arrayBuffer();
        if (!buf || buf.byteLength === 0) {
          log('[VocabRadar][sw][' + _ts() + '] kuroFetch 空响应: ' + tryUrl);
          srcErrs.push(tryUrl + ' -> 空响应');
          continue;
        }
        log('[VocabRadar][sw][' + _ts() + '] kuroFetch ' + file + ' ← ' + src.host + ' ' + (buf.byteLength / 1024).toFixed(1) + 'KB');
        return { ok: true, b64: abToB64(buf) };
      } catch (e) { srcErrs.push(tryUrl + ' -> ' + String((e && e.message) || e)); }
    }
    return { ok: false, error: 'kuroFetch 全源失败: ' + srcErrs.join(' | ') };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
