// =============================================================================
// yt/innertube.js —— youtubei.js 客户端、熔断器、免 PoToken 路径 A/B 与 URL 构造
// -----------------------------------------------------------------------------
// 职责：熔断器 _circuitBreaker、youtubei 惰性单例 _ytCaptionInnertube/
//       getYtCaptionInnertube()、warmYouTubeCaptionInnertube()（预热，导出）、
//       路径A fetchTrackViaAndroidClient（ANDROID→IOS→… 客户端矩阵，导出）、
//       __fetchTrackViaInnertubeClient、fetchTrackListViaInnertube（轨道列表补拉，导出）、
//       路径B fetchTrackViaGetTranscript（导出）、getFreshCaptionBaseUrl（导出）、
//       buildJson3Url/buildTranscriptUrl（导出）。
// 来源：拆分自 src/lib/subtitle/youtube-fetcher.js（2026-09-27 拆分第三刀，机械搬移）。
// 关系：依赖 ../subtitle-parser.js、./yt-utils.js（ensureXmlFormat/extractYtcfg——
//       抽到叶子模块以避免与 caption-tracks 形成循环 import）。
// 消费方：./caption-tracks.js（fetchTrackListViaInnertube）、
//       ./track-download.js（路径A/B、fresh baseUrl、URL 构造）、
//       门面 youtube-fetcher.js（warmYouTubeCaptionInnertube）。
// =============================================================================

import { parseSubtitleContent } from '../subtitle-parser.js';
import { extractYtcfg, ensureXmlFormat } from './yt-utils.js';

// === 第一百二十二次：YouTube PoToken 时代兜底（调研：docs 与 yt-dlp PO Token Guide / ytranscript / LuanRT youtubei.js）===
// 现象：captionTrack baseUrl 含 &exp=xpe 的视频，无 pot 参数的 timedtext 请求一律 HTTP 200 空体
//   （youtube-transcript-api issue #592、dev.to 2026-06 综述），即用户所见"轨道识别得到、加载空白"。
// 可行通道（均不需要 BotGuard PoToken）：
//   A) ANDROID 客户端 player API 返回的 timedtext URL——服务端/同源直接可用（ytranscript 实证策略，
//      对标 yt-dlp 客户端矩阵）；本项目在 youtube.com 同源内容脚本世界 fetch，携带 cookie。
//   B) InnerTube get_transcript（播放器"显示转录"面板数据，youtubei.js getTranscript()）。
// 会话惰性单例；retrieve_player:false（字幕/转录无需 decipher，免 base.js 拉取）。
// 简单熔断器：连续失败达到阈值后暂停一段时间，防止级联失败。
// （2026-09-27：删除零调用点的 recordInnertubeResult 后，其独占的 recordSuccess/
//   recordFailure 一并删除——failures 恒为 0，isOpen 恒 false，与历史实际行为一致；
//   isOpen 结构与调用点保留，若日后接入失败上报即可恢复熔断。）
const _circuitBreaker = {
  failures: 0,
  lastFailure: 0,
  threshold: 5,
  timeout: 30000, // 30秒冷却
  isOpen() {
    return this.failures >= this.threshold && (Date.now() - this.lastFailure) < this.timeout;
  }
};

let _ytCaptionInnertube = null;
function getYtCaptionInnertube() {
  if (_circuitBreaker.isOpen()) {
    console.warn(`[VocabRadar][youtube] 熔断器开启，${Math.ceil((_circuitBreaker.timeout - (Date.now() - _circuitBreaker.lastFailure)) / 1000)}秒后重试`);
    return Promise.reject(new Error(`熔断器开启，${Math.ceil((_circuitBreaker.timeout - (Date.now() - _circuitBreaker.lastFailure)) / 1000)}秒后重试`));
  }
  if (!_ytCaptionInnertube) {
    _ytCaptionInnertube = (async () => {
      const mod = await import(chrome.runtime.getURL('src/lib/vendor/youtubei.web.bundle.min.js'));
      const { Innertube } = mod;
      return await Innertube.create({ retrieve_player: false });
    })().catch((e) => { _ytCaptionInnertube = null; throw e; });
  }
  return _ytCaptionInnertube;
}

/**
 * 第一百三十四次：youtubei 单例预热——vendor bundle import + Innertube.create 需数百 ms，
 * 与播放器加载并行做掉，消除"首取轨道时冷启动竞争→空结果、手动切轨（单例已热）才成功"。
 * 失败静默（真取轨时路径A/B 自会再试并把错误打进诊断日志）。
 */
export async function warmYouTubeCaptionInnertube() {
  try { await getYtCaptionInnertube(); } catch (e) {
    console.warn('[VocabRadar][youtube] youtubei 预热失败(不阻塞):', e && e.message || e);
  }
}

/**
 * 路径A（第一百二十二次）：ANDROID 客户端 captionTracks → 同源 fetch timedtext。
 * 第一百五十六次：增强重试机制和错误处理。
 * @param {string} videoId
 * @param {{languageCode:string, kind?:string}} prefer 原轨道语言/kind
 * @returns {Promise<Array<{start,end,text}>|null>}
 */
export async function fetchTrackViaAndroidClient(videoId, prefer) {
  if (!videoId) return null;
  // 第一百二十四次：ANDROID 失败再试 IOS（对标 yt-dlp 客户端矩阵；两客户端均免 POT）
  // 第一百三十三次：追加 ANDROID_VR / TV_EMBEDDED——部分视频对 ANDROID/IOS 也收紧了
  // timedtext（"en 自动生成轨仍空"），yt-dlp 2025+ 矩阵中此两客户端常仍放行。
  // 第一百五十七次：增加重试机制和错误分类
  // 第一百六十二次：过滤 exp=xpe 轨道，尝试多个轨道，增加客户端类型
  const CLIENTS = ['ANDROID', 'IOS', 'ANDROID_VR', 'TV_EMBEDDED', 'WEB', 'MWEB', 'WEB_EMBEDDED', 'TV'];
  const MAX_RETRIES = 3;

  for (const clientName of CLIENTS) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const sub = await __fetchTrackViaInnertubeClient(videoId, prefer, clientName);
        if (sub) return sub;
      } catch (e) {
        const msgStr = (e && e.message) || String(e);
        const isRetryable = /network|timeout|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|503|502|504|429/i.test(msgStr);
        const isAuthError = /401|403|unauthorized|forbidden/i.test(msgStr);
        const isNotFound = /404|not found/i.test(msgStr);

        if (attempt < 3 && (isRetryable || !isAuthError && !isNotFound)) {
          const delay = 500 * Math.pow(2, attempt - 1) + Math.random() * 100;
          console.log(`[VocabRadar][youtube] 路径A[${clientName}] 第${attempt}次尝试失败，${delay}ms后重试:`, msgStr.slice(0, 100));
          await new Promise(r => setTimeout(r, delay));
          continue;
        } else {
          console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 最终失败:', msgStr);
          break;
        }
      }
    }
  }
  return null;
}

async function __fetchTrackViaInnertubeClient(videoId, prefer, clientName) {
  try {
    const yt = await getYtCaptionInnertube();
    const info = await yt.getBasicInfo(videoId, clientName);
    // youtubei.js 各版本字段形态不同，逐层探测（raw snake_case 优先）
    const ctr = info?.captions?.playerCaptionsTracklistRenderer;
    const tracks = info?.captions?.caption_tracks
      || ctr?.caption_tracks || ctr?.captionTracks
      || info?.page?.[0]?.captions?.playerCaptionsTracklistRenderer?.caption_tracks
      || [];
    // 诊断：把探测到的形态与数量打出来，空轨道时可直接归因
    console.log('[VocabRadar][youtube] 路径A[' + clientName + '] 探测: captions=' + (info?.captions ? Object.keys(info.captions).join('|') : 'null')
      + ' 轨道数=' + tracks.length
      + (tracks.length ? (' [' + tracks.slice(0, 4).map((t) => (t.languageCode || t.language_code || '?') + '/' + (t.kind || '-')).join(', ') + ']') : ''));
    if (!tracks.length) { console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 无 captionTracks'); return null; }
    // 按原轨道语言匹配，优先同 kind（asr）
    let pool = tracks;
    if (prefer && prefer.languageCode) {
      const m = tracks.filter((t) => String(t.languageCode || t.language_code || '').startsWith(prefer.languageCode));
      if (m.length) pool = m;
    }
    if (prefer && prefer.kind) {
      const m = pool.filter((t) => String(t.kind || '') === prefer.kind);
      if (m.length) pool = m;
    }
    const ct = pool[0];
    let url = ct.base_url || ct.baseUrl || '';
    if (!url) { console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 轨道缺 baseUrl'); return null; }
    if (!/[?&]fmt=/.test(url)) url += '&fmt=json3';
    console.log('[VocabRadar][youtube] 路径A[' + clientName + '] timedtext, lang=', ct.languageCode || ct.language_code);
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) { console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 响应:', res.status); return null; }
    const text = await res.text();
    if (!text.length) { console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 空响应'); return null; }
    const parsed = parseSubtitleContent(text, /json/i.test(res.headers.get('content-type') || '') || text.trim().startsWith('{') ? 'application/json' : 'application/xml');
    if (parsed && parsed.length > 0) { console.log('[VocabRadar][youtube] 路径A[' + clientName + '] 解析:', parsed.length, '条'); return parsed; }
    console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 解析为空');
  } catch (e) {
    const msgStr = (e && e.message) || String(e);
    const isRetryable = /network|timeout|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|503|502|504|429/i.test(msgStr);
    const isAuthError = /401|403|unauthorized|forbidden/i.test(msgStr);
    const isNotFound = /404|not found/i.test(msgStr);
    const isParserError = /Parser|not found/i.test(msgStr);

    if (isParserError) {
      console.log(`[VocabRadar][youtube] 路径A[${clientName}] 已知解析缺口(跳过):`, msgStr.slice(0, 80));
    } else if (isRetryable) {
      console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 网络错误(可重试):', msgStr);
    } else if (isAuthError || isNotFound) {
      console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 认证/未找到错误(不重试):', msgStr);
    } else {
      console.warn('[VocabRadar][youtube] 路径A[' + clientName + '] 异常:', msgStr);
    }
  }
  return null;
}

/**
 * 第一百三十二次：轨道列表补拉——页面四路（player对象/script/innertube-WEB/timedtext list）
 * 全部落空时（SPA 导航早期、播放器接口变更、consent 拦截等），用 youtubei.js 免 PoToken
 * 客户端（ANDROID→IOS）拉 captionTracks 重建轨道列表。与路径A 同一客户端矩阵、同一单例。
 * 用户反馈"加载字幕轨道为空"（下拉只剩 ASR）即列表源全空的直接表现。
 * @param {string} videoId
 * @returns {Promise<Array<{baseUrl,languageCode,name,kind}>|null>}
 */
export async function fetchTrackListViaInnertube(videoId) {
  if (!videoId) return null;
  // 第一百三十三次：客户端矩阵与路径A 对齐（ANDROID→IOS→ANDROID_VR→TV_EMBEDDED）
  const CLIENTS = ['ANDROID', 'IOS', 'ANDROID_VR', 'TV_EMBEDDED'];
  for (const clientName of CLIENTS) {
    try {
      const yt = await getYtCaptionInnertube();
      const info = await yt.getBasicInfo(videoId, clientName);
      const ctr = info?.captions?.playerCaptionsTracklistRenderer;
      const raw = info?.captions?.caption_tracks
        || ctr?.caption_tracks || ctr?.captionTracks
        || info?.page?.[0]?.captions?.playerCaptionsTracklistRenderer?.caption_tracks
        || [];
      console.log('[VocabRadar][youtube] 轨道列表补拉[' + clientName + ']: 原始轨道数=' + raw.length);
      if (!raw.length) continue;
      // 统一映射为页面轨道同构：baseUrl 补 v 参数（ensureXmlFormat），name 兼容 string/simpleText/runs
      const seen = new Set();
      const tracks = [];
      for (const t of raw) {
        const base = t.base_url || t.baseUrl || '';
        if (!base) continue;
        const lang = String(t.languageCode || t.language_code || '');
        const kind = String(t.kind || '');
        const name = (typeof t.name === 'string' && t.name)
          || t.name?.simpleText
          || t.name?.runs?.[0]?.text
          || (kind === 'asr' ? '(auto-generated)' : '')
          || lang;
        const key = lang + '|' + kind + '|' + name;
        if (seen.has(key)) continue;
        seen.add(key);
        tracks.push({
          baseUrl: ensureXmlFormat(base, videoId),
          languageCode: lang,
          name,
          kind,
          // 第一百七十八次：补 vss_id（源可能是驼峰 vssId 或下划线；都缺则按规则重建）
          vss_id: t.vssId || t.vss_id || ((kind === 'asr' ? 'a.' : '.') + lang)
        });
      }
      if (tracks.length > 0) {
        console.log('[VocabRadar][youtube] 轨道列表补拉[' + clientName + '] 命中:',
          tracks.map((t) => t.languageCode + '/' + (t.kind || '-')).join(', '));
        return tracks;
      }
    } catch (e) {
      console.warn('[VocabRadar][youtube] 轨道列表补拉[' + clientName + '] 异常:', e.message || e);
    }
  }
  return null;
}

/**
 * 路径B（第一百五十八次）：InnerTube get_transcript（"显示转录"面板，无需 PoToken）。
 * 增强重试机制和错误处理。
 * 深度遍历 TranscriptInfo 收集 TranscriptSegment（跨 youtubei.js 版本字段差异稳健）。
 * @param {string} videoId
 * @returns {Promise<Array<{start,end,text}>|null>}
 */
export async function fetchTrackViaGetTranscript(videoId) {
  if (!videoId) return null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const yt = await getYtCaptionInnertube();
      const info = await yt.getInfo(videoId);
      const ti = await info.getTranscript();
      // 诊断：可用语言与当前选中语言（空段落时可直接归因）
      try {
        console.log('[VocabRadar][youtube] 路径B transcript 语言: 选中=', (ti && ti.selectedLanguage) || '?',
          ' 可用=', (ti && ti.languages || []).slice(0, 6).join(' / '));
      } catch (_) { /* ignore */ }
      const segs = [];
      const collect = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 8) return;
        if (Array.isArray(node)) { for (const n of node) collect(n, depth + 1); return; }
        if (node.type === 'TranscriptSegment') {
          const startMs = Number(node.start_ms) || 0;
          const endMs = Number(node.end_ms) || startMs + 3000;
          const text = node.snippet != null ? String(node.snippet) : '';
          if (text.trim()) segs.push({ startMs, endMs, text: text.trim() });
          return;
        }
        for (const k of Object.keys(node)) {
          if (k === 'actions' || k === 'session' || k === 'page') continue;
          try { collect(node[k], depth + 1); } catch (_) { /* 循环引用防御 */ }
        }
      };
      collect(ti.transcript && ti.transcript.content, 0);
      if (!segs.length) { console.warn('[VocabRadar][youtube] 路径B get_transcript 无段落'); return null; }
      segs.sort((a, b) => a.startMs - b.startMs);
      const subs = segs.map((s) => ({ start: s.startMs / 1000, end: s.endMs / 1000, text: s.text }));
      console.log('[VocabRadar][youtube] 路径B get_transcript:', subs.length, '条, 语言=', ti.selectedLanguage || '(默认)');
      return subs;
    } catch (e) {
      const msgStr = (e && e.message) || String(e);
      if (attempt < 3 && /network|timeout|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|503|502|504|429/i.test(msgStr)) {
        const delay = 500 * Math.pow(2, attempt - 1) + Math.random() * 100;
        console.log(`[VocabRadar][youtube] 路径B 第${attempt}次尝试失败，${Math.round(500 * Math.pow(2, attempt - 1))}ms后重试:`, msgStr.slice(0, 100));
        await new Promise(r => setTimeout(r, delay));
        continue;
      } else {
        console.warn('[VocabRadar][youtube] 路径B get_transcript 异常:', e.message || e);
        break;
      }
    }
  }
  return null;
}

/**
 * 通过 innertube API（WEB_EMBEDDED_PLAYER 客户端）获取全新的字幕 baseUrl。
 *
 * 反思（2026-07-03）：getPlayerResponse() / ytInitialPlayerResponse 返回的 baseUrl
 *   签名绑定了播放器会话上下文，content script 直接 fetch 该 URL 返回 0 字节。
 *   innertube API 用 WEB_EMBEDDED_PLAYER 客户端请求，返回的 baseUrl 签名不绑定
 *   会话上下文，可直接 fetch 成功。
 *
 * @param {string} videoId 视频 ID
 * @returns {Promise<string|null>} 全新的 baseUrl
 */
export async function getFreshCaptionBaseUrl(videoId, preferLang, preferKind) {
  if (!videoId) return null;
  try {
    // 从页面 ytcfg 提取 INNERTUBE_API_KEY
    const cfg = extractYtcfg();
    const apiKey = cfg.apiKey || '';
    const url = 'https://www.youtube.com/youtubei/v1/player' + (apiKey ? '?key=' + apiKey : '');
    console.log('[VocabRadar][youtube] innertube WEB_EMBEDDED_PLAYER 请求: videoId=' + videoId);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'WEB_EMBEDDED_PLAYER',
            clientVersion: '1.20241009.01.00'
          }
        }
      })
    });

    if (!res.ok) {
      console.warn('[VocabRadar][youtube] innertube WEB_EMBEDDED_PLAYER 响应:', res.status);
      return null;
    }

    const data = await res.json();
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) {
      console.warn('[VocabRadar][youtube] innertube WEB_EMBEDDED_PLAYER 无 captionTracks');
      return null;
    }

    // 第一百二十次：不再盲取第一条——按原轨道语言匹配（ASR 自动字幕时优先同 kind）。
    let pool = tracks;
    if (preferLang) {
      const langMatch = tracks.filter((t) => String(t.languageCode || '').startsWith(preferLang));
      if (langMatch.length > 0) pool = langMatch;
    }
    if (preferKind) {
      const kindMatch = pool.filter((t) => String(t.kind || '') === preferKind);
      if (kindMatch.length > 0) pool = kindMatch;
    }
    const baseUrl = pool[0].baseUrl;
    console.log('[VocabRadar][youtube] innertube 获取 baseUrl 成功, lang=', pool[0].languageCode, 'kind=', pool[0].kind || '-', 'url长度=', baseUrl.length);
    return baseUrl;
  } catch (e) {
    console.warn('[VocabRadar][youtube] innertube WEB_EMBEDDED_PLAYER 异常:', e.message || e);
    return null;
  }
}

/**
 * 在 baseUrl 上设置 fmt=json3，构造 JSON3 格式下载 URL。
 * fmt 不在 sparams 签名参数列表中，添加 fmt 不会破坏签名。
 * @param {string} baseUrl 原始 baseUrl
 * @param {string} lang 目标语言
 * @returns {string} 带 fmt=json3 的 URL
 */
export function buildJson3Url(baseUrl, lang) {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set('fmt', 'json3');
    // 如果 URL 的 lang 与目标语言不同，设置 tlang 做翻译
    const currentLang = u.searchParams.get('lang');
    if (currentLang && currentLang !== lang) {
      u.searchParams.set('tlang', lang);
    }
    return u.toString();
  } catch {
    return baseUrl;
  }
}

/**
 * 在 baseUrl 上删除 fmt 参数，构造 XML（transcript）格式下载 URL。
 * 不带 fmt 时 YouTube 返回默认 XML 格式。
 * @param {string} baseUrl 原始 baseUrl
 * @returns {string} 不带 fmt 的 URL
 */
export function buildTranscriptUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    u.searchParams.delete('fmt');
    return u.toString();
  } catch {
    return baseUrl;
  }
}
