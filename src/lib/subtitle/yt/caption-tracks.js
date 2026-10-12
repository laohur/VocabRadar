// =============================================================================
// yt/caption-tracks.js —— 轨道发现（四路兜底）与 getYouTubeSubtitles
// -----------------------------------------------------------------------------
// 职责：parseTimedTextListXml()（timedtext list XML 重建轨道）、
//       getYouTubeCaptionTracks()（路径0 播放器对象轮询 + 路径1 script 提取 +
//       路径2 innertube WEB + 路径3 timedtext list）、
//       getYouTubeSubtitles()（默认选轨 + 下载 + innertube 补拉 + backend 兜底，导出）、
//       fetchYouTubeSecondarySubtitles()（双语第二轨：原生第二语言轨 + tlang 翻译轨，导出）。
// 来源：拆分自 src/lib/subtitle/youtube-fetcher.js（2026-09-27 拆分第三刀，机械搬移）。
// 关系：依赖 ./yt-utils.js（ensureXmlFormat/extractYtcfg/extractVarFromScripts——
//       叶子共享，避免与 innertube 循环）、./page-context.js（注入+状态日志）、
//       ./innertube.js（轨道列表补拉）、./backend.js（兜底）、./track-download.js（下载）、
//       ../subtitle-parser.js（tlang 响应解析）。
// 消费方：门面 youtube-fetcher.js（re-export getYouTubeSubtitles / fetchYouTubeSecondarySubtitles）。
// =============================================================================

import { ensureXmlFormat, extractYtcfg, extractVarFromScripts } from './yt-utils.js';
import { injectPageScript, getPageInjectStatus, fetchViaPageContext } from './page-context.js';
import { fetchTrackListViaInnertube } from './innertube.js';
import { backendSubtitlesFallback, fetchSubtitleViaServiceWorker } from './backend.js';
import { fetchYouTubeTrack } from './track-download.js';
import { parseSubtitleContent } from '../subtitle-parser.js';

// === YouTube ===
//
// 字幕轨道获取：四路兜底（2026-07-03 修订）
//
// 故障背景：
//   - 原版 innertube 用 2024 年硬编码 INNERTUBE_API_KEY/clientVersion，已失效。
//   - 上一轮加三路兜底后用户仍反馈"videoseek 能找到我方不能"。
//
// 调研 videoseek-ref/ytIndex.a719a07b.js 得知 videoseek 用的是：
//   document.querySelector("ytd-player#ytd-player")?.player_?.getPlayerResponse()
//   （Shorts 用 document.querySelector("#shorts-player")?.getPlayerResponse()）
// 即直接调 YouTube 自身播放器对象的方法，数据是 YouTube 自己加载完毕后持有的实时数据，
// SPA 导航后实时更新，永远可靠——这是 videoseek 能找到字幕的根因。
//
// 四路兜底顺序（新增路径0 为最优先，与 videoseek 同源）：
//   0) ytd-player.player_.getPlayerResponse() / #shorts-player.getPlayerResponse()
//      YouTube 自身播放器对象的实时数据（SPA 后也可靠，最稳）
//   1) 页面 <script> 提取 ytInitialPlayerResponse（首次全量加载有，需校验 videoId）
//   2) innertube player API：INNERTUBE_API_KEY / clientVersion 从页面 ytcfg 动态提取
//   3) timedtext list 接口兜底，重建 baseUrl
//
// 四路任一成功即返回；全失败返回 null。

/**
 * 解析 timedtext list 接口返回的 XML，重建字幕轨道。
 * 接口：https://www.youtube.com/api/timedtext?v=<id>&type=list
 * 返回 <transcript_list><track lang_code="en" lang_translated="English" kind="asr"/></transcript_list>
 * baseUrl 需用 v+lang+kind 重建（list 接口不直接给 baseUrl）。
 * @param {string} xml
 * @param {string} videoId
 * @returns {Array<{baseUrl, languageCode, name}>}
 */
function parseTimedTextListXml(xml, videoId) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const trackEls = doc.querySelectorAll('track');
  const tracks = [];
  for (const t of trackEls) {
    const langCode = t.getAttribute('lang_code') || '';
    const langName = t.getAttribute('lang_translated') || langCode;
    const kind = t.getAttribute('kind') || '';
    if (!langCode) continue;
    // 重建 baseUrl：lang+kind（asr）即可拉取对应字幕，强制 fmt=json3
    const baseUrl = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(langCode)}`
      + (kind ? `&kind=${encodeURIComponent(kind)}` : '')
      + '&fmt=json3';
    tracks.push({
      baseUrl,
      languageCode: langCode,
      name: langName,
      // 第一百七十八次：list 接口本就给了 kind，此前丢弃 → 下游无法识别 ASR 轨。
      // vss_id 该接口不提供，按 YouTube 命名规则重建（ASR 为 'a.xx'，手动轨为 '.xx'）。
      kind: kind,
      vss_id: (kind === 'asr' ? 'a.' : '.') + langCode
    });
  }
  return tracks;
}

/**
 * 从页面获取 YouTube 字幕轨道列表（路径0 + 三路兜底 + 轮询等待）
 * 反思（2026-07-03）：用户再次反馈"youtube中找不到字幕，videoseek能找到"。
 *   路径0 方法正确（与 videoseek 同源），但 SPA 导航后 ytd-player 重建，
 *   player_ 可能在调用时未就绪，一次性调用必失败。videoseek 持续监听 player
 *   就绪才拿到。修正：路径0 增加轮询等待 player 就绪（最多 8 秒，每 500ms），
 *   路径0 全部失败再走路径1-3。
 * @returns {Promise<Array<{baseUrl, languageCode, name}>|null>}
 */
async function getYouTubeCaptionTracks() {
  // 当前 videoId（从 URL 提取，SPA 导航后 URL 已更新）
  const videoId = location.search.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1]
    || location.pathname.match(/\/([A-Za-z0-9_-]{11})(?:[/?]|$)/)?.[1];
  console.log('[VocabRadar][youtube] getYouTubeCaptionTracks videoId=', videoId);

  // === 路径 0：YouTube 自身播放器对象的 getPlayerResponse()（与 videoseek 同源，最稳）===
  // 轮询等待 player 就绪：SPA 导航后 ytd-player 重建，player_ 延迟挂载。
  // 最多等 8 秒（16 次 × 500ms），命中即返回；超时再走路径1-3。
  const tryPath0 = () => {
    try {
      const isShort = location.pathname.includes('/shorts/');
      // 第一百五十七次：与 getYouTubePlayer 同款候选链——窄选择器在部分布局恒失败，
      // 白等 8 秒后才走兜底（轨道列表延迟＝"加载字幕轨道为空"观感来源之一）。
      const candidates = isShort
        ? ['#shorts-player', '#movie_player', 'div.html5-video-player']
        : ['ytd-player#ytd-player', '#movie_player', 'div.html5-video-player'];
      let player = null;
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const p = el.player_ || el;
        if (p && typeof p.getPlayerResponse === 'function') { player = p; break; }
      }
      const ready = isShort ? !!player : (player && typeof player.isReady === 'function' && player.isReady());
      if (ready && player && typeof player.getPlayerResponse === 'function') {
        const resp = player.getPlayerResponse();
        const respVideoId = resp?.videoDetails?.videoId;
        const tracks0 = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (tracks0 && tracks0.length) {
          if (respVideoId && videoId && respVideoId !== videoId) {
            return { skip: true, reason: 'videoId 不匹配 ' + respVideoId + ' vs ' + videoId };
          }
          return { tracks: tracks0.map((t) => ({
            // 反思（2026-07-03）：getPlayerResponse() 返回的 baseUrl 默认返回 JSON 格式，
            // parseYouTubeTimedText 只解析 XML → 解析为空数组（"虚空轨道"根因）。
            // ensureXmlFormat 仅补充 v 参数（不修改 fmt，签名 URL 修改 fmt 会失效）
            baseUrl: ensureXmlFormat(t.baseUrl, videoId),
            languageCode: t.languageCode,
            name: t.name?.simpleText || t.name?.runs?.[0]?.text || '',
            kind: t.kind || '',
            // 第一百三十三次：保留 vss_id——路径0 触发播放器时自动轨需 'a.xx' 原始标识
            // 第一百七十八次修 bug：getPlayerResponse() 的字段名是**驼峰 vssId**，
            // 旧代码只读下划线 t.vss_id → 恒为空串，"保留 vss_id"实际从未生效。
            vss_id: t.vssId || t.vss_id || ''
          })) };
        }
        return { skip: true, reason: '无 captionTracks' };
      }
      return null; // 未就绪，继续轮询
    } catch (e) {
      console.warn('[VocabRadar][youtube] 路径0 异常:', e);
      return null;
    }
  };

  for (let i = 0; i < 16; i++) {
    const r = tryPath0();
    if (r && r.tracks) {
      console.log('[VocabRadar][youtube] 路径0 命中(第' + (i + 1) + '次轮询): player_.getPlayerResponse() 轨道', r.tracks.map(t => t.languageCode).join(','));
      return r.tracks;
    }
    if (r && r.skip) {
      console.log('[VocabRadar][youtube] 路径0 ' + r.reason + '，停止轮询走兜底');
      break;
    }
    // 未就绪，等 500ms 再试
    if (i < 15) await new Promise((res) => setTimeout(res, 500));
  }
  console.log('[VocabRadar][youtube] 路径0 轮询超时/未命中，走路径1-3');

  // === 路径 1：页面 <script> 提取 ytInitialPlayerResponse ===
  // 仅首次全量加载有；SPA 导航后常拿不到，且需校验 videoId 防止拿旧视频数据
  try {
    const player = extractVarFromScripts('ytInitialPlayerResponse');
    const scriptVideoId = player?.videoDetails?.videoId;
    if (player?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
      if (scriptVideoId && videoId && scriptVideoId !== videoId) {
        console.log('[VocabRadar][youtube] 路径1 script videoId=' + scriptVideoId + ' 与当前 ' + videoId + ' 不匹配（SPA），跳过');
      } else {
        console.log('[VocabRadar][youtube] 路径1 命中: ytInitialPlayerResponse(script)');
        return player.captions.playerCaptionsTracklistRenderer.captionTracks.map((t) => ({
          baseUrl: ensureXmlFormat(t.baseUrl, videoId),
          languageCode: t.languageCode,
          name: t.name?.simpleText || t.name?.runs?.[0]?.text || '',
          // 第一百七十八次：路径1 此前丢了 kind/vss_id → 下游 triggerAndInterceptSubtitle
          // 拿不到轨道元数据，ASR 轨只能瞎拼 '.xx' 配置，setOption 不被接受。
          // 源数据字段名是驼峰 vssId（getPlayerResponse 原始形态），需转成下划线。
          kind: t.kind || '',
          vss_id: t.vssId || t.vss_id || ''
        }));
      }
    } else {
      console.log('[VocabRadar][youtube] 路径1 script 中无 captionTracks');
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] 路径1 extractVarFromScripts 异常', e);
  }

  // === 路径 2：innertube player API（动态 client）===
  // 从页面 ytcfg 提取 INNERTUBE_API_KEY / clientVersion，不再硬编码 2024 年旧值
  if (!videoId) {
    console.warn('[VocabRadar][youtube] 未取到 videoId，路径2/3 跳过');
    return null;
  }
  try {
    const cfg = extractYtcfg();
    const apiKey = cfg.apiKey || '';
    const clientVersion = cfg.clientVersion || '2.20240101.00.00';
    const url = 'https://www.youtube.com/youtubei/v1/player' + (apiKey ? '?key=' + apiKey : '');
    console.log('[VocabRadar][youtube] 路径2 innertube, videoId=' + videoId + ' clientVersion=' + clientVersion);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': clientVersion
      },
      credentials: 'omit',
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: clientVersion,
            hl: 'en',
            gl: 'US'
          }
        },
        videoId
      })
    });
    console.log('[VocabRadar][youtube] 路径2 innertube 响应:', res.status, res.statusText);
    if (res.ok) {
      const data = await res.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length) {
        console.log('[VocabRadar][youtube] 路径2 命中: innertube 轨道', tracks.map(t => t.languageCode).join(','));
        return tracks.map((t) => ({
          baseUrl: ensureXmlFormat(t.baseUrl, videoId),
          languageCode: t.languageCode,
          name: t.name?.simpleText || t.name?.runs?.[0]?.text || '',
          // 第一百七十八次：同路径1，补回 kind/vss_id（源为驼峰 vssId）
          kind: t.kind || '',
          vss_id: t.vssId || t.vss_id || ''
        }));
      }
      console.warn('[VocabRadar][youtube] 路径2 innertube 无 captionTracks');
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] 路径2 innertube 异常', e);
  }

  // === 路径 3：timedtext list 接口兜底 ===
  // 公开接口，返回所有可用轨道 XML，据此重建 baseUrl
  try {
    const listUrl = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&type=list`;
    console.log('[VocabRadar][youtube] 路径3 timedtext list:', listUrl);
    const res = await fetch(listUrl, { credentials: 'omit' });
    if (res.ok) {
      const xml = await res.text();
      const tracks = parseTimedTextListXml(xml, videoId);
      if (tracks.length > 0) {
        console.log('[VocabRadar][youtube] 路径3 命中: timedtext list 轨道', tracks.map(t => t.languageCode).join(','));
        return tracks;
      }
      console.warn('[VocabRadar][youtube] 路径3 timedtext list 返回 0 轨道（视频可能确实无字幕）');
    } else {
      console.warn('[VocabRadar][youtube] 路径3 timedtext list 响应:', res.status);
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] 路径3 timedtext list 异常', e);
  }

  return null;
}

/**
 * 获取 YouTube 字幕（返回所有轨道 + 默认轨道字幕）
 *
 * 默认轨道选择策略（2026-07-03 按用户确认调整）：
 *   1) 首选 learnLanguage（所学语言=目标语言）轨道，前缀匹配
 *   2) 无则取第一条非 meaningLanguage（释义语言）轨道（避免默认选母语字幕）
 *   四层链：原始语言 → 目标语言 → 界面语言 → 释义语言 → 首条（第421次，用户裁定）。
 * 反思：旧版曾硬编码优先 en（无视用户语言），第419次又改成 uiLanguage 首选——
 *   uiLanguage 默认 'en' 且 popup 不暴露，用户改学习语言后重拉仍恒选英语轨，
 *   "默认首选目标语言"从未生效。
 *
 * @param {string} [learnLanguage='en'] 所学语言（第2层）
 * @param {string} [meaningLanguage='zh'] 释义语言（第4层）
 * @param {string} [uiLanguage='en'] 界面语言（第3层）
 * @returns {Promise<{tracks: Array, subtitles: Array|null, pickedIndex: number}|null>}
 */
export async function getYouTubeSubtitles(learnLanguage = 'en', meaningLanguage = 'zh', uiLanguage = 'en') {
  console.log('[VocabRadar][youtube] 开始获取字幕, learnLanguage=' + learnLanguage + ' meaningLanguage=' + meaningLanguage + ' uiLanguage=' + uiLanguage);
  // 尽早注入页面主世界脚本，确保 YouTube 播放器的字幕请求能被拦截
  injectPageScript();
  // 拆分接驳：原直读 _pageScriptReady/_pageTimedtextCache.length 改走状态快照（取值时点等价）
  const _inj = getPageInjectStatus();
  console.log('[VocabRadar][youtube] 页面脚本注入完成, ready=', _inj.ready, '已有缓存=', _inj.cacheLen, '条');
  const tracks = await getYouTubeCaptionTracks();
  // 第一百三十二次：页面四路全部落空时用 youtubei.js 免 PoToken 客户端补拉轨道列表
  // （此前直接 return null → 轨道下拉只剩 ASR，即"加载字幕轨道为空"）。
  let trackList = tracks;
  if (!trackList || trackList.length === 0) {
    console.warn('[VocabRadar][youtube] 页面轨道列表为空, 尝试 innertube 客户端补拉');
    const videoId2 = location.search.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1]
      || location.pathname.match(/\/([A-Za-z0-9_-]{11})(?:[/?]|$)/)?.[1];
    trackList = await fetchTrackListViaInnertube(videoId2);
    if (!trackList || trackList.length === 0) {
      console.warn('[VocabRadar][youtube] 字幕轨道列表为空（含 innertube 补拉）');
      // 第399次：页面四路+innertube 全空 → backend yt-dlp 兜底（失败保持 return null 语义）
      // 第419次：兜底语言同步改为界面语言（与默认选轨一致）
      return await backendSubtitlesFallback(uiLanguage, null);
    }
  }
  console.log('[VocabRadar][youtube] 所有字幕轨道:', trackList.map((t) => `${t.languageCode}=${t.name}`).join(', '));

  // 第421次：默认选轨四层链（用户裁定）：原始语言 → 目标语言(learnLanguage)
  //   → 界面语言(uiLanguage) → 释义语言(meaningLanguage) → 首条。
  //   每层先 ASR 轨再任意同语言轨（前缀匹配）。原始语言 = 首条 ASR 轨的语言
  //   （ASR 只从原始音频生成，其语言即视频原生语言；无 ASR 轨则无原始语言
  //   信号，跳过该层）。用户手动选轨最高优先（tracks.js 手选恢复），本链仅决定默认。
  const pickLayer = (lang) => {
    let i = trackList.findIndex((t) => t.kind === 'asr' && t.languageCode.startsWith(lang));
    if (i < 0) i = trackList.findIndex((t) => t.languageCode.startsWith(lang));
    return i;
  };
  const origLang = (trackList.find((t) => t.kind === 'asr') || {}).languageCode || '';
  let pickedIndex = origLang ? pickLayer(origLang) : -1;
  if (pickedIndex < 0) pickedIndex = pickLayer(learnLanguage);
  if (pickedIndex < 0) pickedIndex = pickLayer(uiLanguage);
  if (pickedIndex < 0) pickedIndex = pickLayer(meaningLanguage);
  if (pickedIndex < 0) pickedIndex = 0;
const picked = trackList[pickedIndex];
  console.log(`[VocabRadar][youtube] 默认选中轨道: ${picked.languageCode} (${picked.name}) kind=${picked.kind || '-'}`);

  // 调用 fetchYouTubeTrack 下载默认轨道（避免重复 XML/JSON 解析逻辑）
  const subtitles = await fetchYouTubeTrack(picked);
  if (!subtitles || subtitles.length === 0) {
    // 第399次：轨道在但五路内容拉取全空（PoToken 语境常见）→ backend 兜底；
    // 失败时保留原返回结构（轨道列表仍可用于下拉）
    console.warn('[VocabRadar][youtube] 默认轨道内容拉取为空, backend 兜底');
    return await backendSubtitlesFallback(uiLanguage, { tracks: trackList, subtitles: [], pickedIndex });
  }
  return { tracks: trackList, subtitles, pickedIndex };
}
// 第一百二十三次自纠：此处原有上次会话遗留的两个孤立 '}'（ESM 解析失败），随修清除。

// =============================================================================
// 双语第二轨（D1 落地：站上现成多语言字幕优先，不再逐行实时翻译）
// 消费方：lib/bilingual-track.js（编排层，取不到才回退 bilingual-trans 实时翻译）。
// =============================================================================

/**
 * 下载 YouTube 官方翻译轨内容（tlang=）：以源轨 baseUrl 为基础**显式**追加
 * tlang=释义语言（fmt 同步置 json3），拉取站上现成机翻文件。tlang 响应沿用
 * 源轨时间轴——与以同轨为主显轨的场景天然同轴，错轴场景交给对齐层配对。
 * 两级下载：页面主世界 fetch（同路径1/2 口径，绕 CS 会话绑定）→ SW 代理（绕 CS CORS）。
 * @param {{baseUrl:string, languageCode:string}} src 源轨（学习语言轨优先）
 * @param {string} meaningLanguage 释义语言（tlang 目标）
 * @returns {Promise<Array<{start,end,text}>|null>}
 */
async function fetchTlangCues(src, meaningLanguage) {
  let url = '';
  try {
    const u = new URL(src.baseUrl);
    u.searchParams.set('fmt', 'json3');
    u.searchParams.set('tlang', meaningLanguage);   // 显式设置：不依赖源 URL 是否带 lang 参数
    url = u.toString();
  } catch (e) {
    console.warn('[VocabRadar][youtube] tlang URL 构造失败:', e && e.message);
    return null;
  }
  // ① 页面主世界 fetch（路径1/2 同口径）
  try {
    const r = await fetchViaPageContext(url);
    if (r && r.ok && r.text && r.text.length > 0) {
      const parsed = parseSubtitleContent(r.text, r.contentType || 'application/json');
      if (parsed && parsed.length > 0) return parsed;
      console.warn('[VocabRadar][youtube] tlang 页面fetch 解析为空, 前200字符:', r.text.slice(0, 200));
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] tlang 页面fetch 异常:', e && e.message);
  }
  // ② SW 代理（绕 CS CORS；签名参数原样透传）
  try {
    const text = await fetchSubtitleViaServiceWorker(url);
    if (text) {
      const parsed = parseSubtitleContent(text, text.trim().startsWith('<') ? 'application/xml' : 'application/json');
      if (parsed && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] tlang SW代理 异常:', e && e.message);
  }
  return null;
}

/**
 * 取 YouTube 站上第二语言字幕文件（双语副行数据源，D1）。
 * 优先级：
 *   ① 原生第二语言轨（languageCode 前缀匹配释义语言；人工轨优先于 ASR 机轨），
 *     经 fetchYouTubeTrack 七路下载（playerLast：直连路径先行，不惊动可见 CC）。
 *   ② 无原生轨 → YouTube 官方翻译轨 tlang=（站上现成机翻文件，源轨时间轴）。
 * ①② 皆空 → null（调用方回退实时翻译）。
 * @param {{learn?:string, meaning?:string}} [opts] learn=学习语言、meaning=释义语言
 * @returns {Promise<Array<{start,end,text}>|null>}
 */
export async function fetchYouTubeSecondarySubtitles(opts = {}) {
  const learn = opts.learn || 'en';
  const meaning = opts.meaning || 'zh';
  if (!meaning || meaning === learn) {
    console.log('[VocabRadar][youtube] 双语第二轨跳过: 释义语言与学习语言相同或为空 (', learn, '→', meaning, ')');
    return null;
  }
  // 轨道发现（同 getYouTubeSubtitles：页面四路 → innertube 补拉）
  let trackList = await getYouTubeCaptionTracks();
  if (!trackList || trackList.length === 0) {
    const videoId = location.search.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1]
      || location.pathname.match(/\/([A-Za-z0-9_-]{11})(?:[/?]|$)/)?.[1];
    trackList = await fetchTrackListViaInnertube(videoId);
  }
  if (!trackList || trackList.length === 0) {
    console.log('[VocabRadar][youtube] 双语第二轨: 轨道列表为空，转实时翻译兜底');
    return null;
  }

  // ① 原生第二语言轨（人工轨优先）
  const cands = trackList.filter((t) => String(t.languageCode || '').startsWith(meaning));
  const ordered = cands.filter((t) => t.kind !== 'asr').concat(cands.filter((t) => t.kind === 'asr'));
  for (const pick of ordered) {
    try {
      const cues = await fetchYouTubeTrack(pick, { playerLast: true });
      if (cues && cues.length > 0) {
        console.log('[VocabRadar][youtube] 双语第二轨命中原生轨:', pick.languageCode,
          'kind=' + (pick.kind || '-'), cues.length, '条');
        return cues;
      }
    } catch (e) {
      console.warn('[VocabRadar][youtube] 双语第二轨原生轨下载异常:', pick.languageCode, e && e.message);
    }
  }

  // ② 官方翻译轨 tlang=：源轨取学习语言轨（ASR 优先）——源语言与主显轨最接近时错轴最小
  const src = trackList.find((t) => String(t.languageCode || '').startsWith(learn) && t.kind === 'asr')
    || trackList.find((t) => String(t.languageCode || '').startsWith(learn))
    || trackList.find((t) => t.kind === 'asr')
    || trackList[0];
  if (src && src.baseUrl) {
    const cues = await fetchTlangCues(src, meaning);
    if (cues && cues.length > 0) {
      console.log('[VocabRadar][youtube] 双语第二轨命中翻译轨(tlang):', src.languageCode, '→', meaning, cues.length, '条');
      return cues;
    }
  }

  console.log('[VocabRadar][youtube] 双语第二轨未取到（原生+tlang 皆空），转实时翻译兜底');
  return null;
}
