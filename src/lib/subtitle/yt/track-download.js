// =============================================================================
// yt/track-download.js —— fetchYouTubeTrack：七路字幕内容下载
// -----------------------------------------------------------------------------
// 职责：按优先级依次尝试 路径0 播放器拦截 / 路径1-2 页面上下文 fetch / 路径3 CS 直连 /
//       路径4/4b innertube fresh baseUrl（json3 + transcript XML）/ 路径A ANDROID 客户端 /
//       路径B get_transcript / 路径5 SW 代理；全失败打汇总诊断行。
//       含 exp=xpe（需 PoToken）轨道的 needsPot 短路逻辑与 backend 伪轨重调。
// 来源：拆分自 src/lib/subtitle/youtube-fetcher.js（2026-09-27 拆分第三刀，机械搬移）。
// 关系：依赖 ../subtitle-parser.js、./page-context.js（fetchViaPageContext）、
//       ./player-intercept.js（路径0）、./innertube.js（路径4/A/B）、./backend.js（伪轨/路径5）。
// 消费方：./caption-tracks.js（默认轨道下载）、门面 youtube-fetcher.js（re-export）。
// =============================================================================

import { parseSubtitleContent } from '../subtitle-parser.js';
import { fetchViaPageContext } from './page-context.js';
import { triggerAndInterceptSubtitle } from './player-intercept.js';
import {
  getFreshCaptionBaseUrl,
  buildJson3Url,
  buildTranscriptUrl,
  fetchTrackViaAndroidClient,
  fetchTrackViaGetTranscript
} from './innertube.js';
import { fetchSubsViaBackend, fetchSubtitleViaServiceWorker } from './backend.js';

/**
 * 下载指定 YouTube 字幕轨道。
 *
 * 下载策略（2026-07-03 第六次修正）：
 *   0) 页面主世界拦截：检查缓存 + 用播放器 API 触发 YouTube 请求字幕，拦截响应
 *   1) 页面主世界 fetch 原始 baseUrl（核心路径！页面上下文 fetch 不受签名绑定限制）
 *   2) 页面主世界 fetch baseUrl + fmt=json3
 *   3) Content Script 直接 fetch（可能返回 0 字节，保留兜底）
 *   4) innertube WEB_EMBEDDED_PLAYER + fmt=json3（innertube 可能返回 0 轨道，保留兜底）
 *   A) ANDROID 客户端 captionTracks timedtext（第一百二十二次，无需 PoToken）
 *   B) get_transcript 面板数据（第一百二十二次，无需 PoToken）
 *   5) service worker 代理（SW 不受 CORS 限制）
 *
 * 反思：v1-v5 的根本性错误是在 Content Script 隔离世界中操作。
 *   Content Script 与页面主世界 JavaScript 上下文隔离：
 *   - 猴子补丁 XMLHttpRequest 仅影响 CS 自身，无法拦截播放器 XHR
 *   - CS 的 fetch 虽带同源 cookie，但签名绑定播放器会话（Sec-Fetch-* 头等），
 *     YouTube 返回 0 字节
 *   正确方案：注入 page-fetch.js 到页面主世界，在页面上下文中 fetch 和拦截 XHR。
 *
 * @param {Object} track {baseUrl, languageCode, name}
 * @returns {Promise<Array<{start, end, text}>|null>}
 */
export async function fetchYouTubeTrack(track) {
  if (!track || !track.baseUrl) {
    // 第399次：backend 伪轨（无 baseUrl）——经 SW 代理重调 backend 直出条目
    if (track && track._backend) {
      const resp = await fetchSubsViaBackend(track.languageCode);
      if (resp && resp.ok && Array.isArray(resp.cues) && resp.cues.length) return resp.cues;
      // 第435次：伪轨重调失败原因透出（不遮蔽）
      console.warn('[VocabRadar][youtube] 伪轨重调 backend 失败: '
        + (resp ? (resp.error || 'no cues') + (resp.message ? ' — ' + resp.message : '')
                : 'SW 无响应（backend 未运行或消息通道异常）'));
      return null;
    }
    return null;
  }
  console.log('[VocabRadar][youtube] fetchYouTubeTrack:', track.languageCode, 'url=', track.baseUrl);

  // 获取当前 videoId
  const videoId = location.search.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1]
    || location.pathname.match(/\/([A-Za-z0-9_-]{11})(?:[/?]|$)/)?.[1];

  // === 第一百二十二次：PoToken 需求探测 ===
  // baseUrl 含 exp=xpe ⇒ timedtext 必须 &pot=（BotGuard 运行时生成，扩展无法伪造），
  // 路径1/2/3/5 全部注定空 200——直接跳过省数秒等待，走路径0（播放器自带 pot）与 A/B 兜底。
  const needsPot = /exp=xpe/.test(track.baseUrl);
  if (needsPot) console.warn('[VocabRadar][youtube] 轨道带 exp=xpe（需 PoToken），跳过直连 timedtext 渠道');

  // === 路径 0：页面主世界拦截（检查缓存 + 触发播放器请求）===
  try {
    console.log('[VocabRadar][youtube] 路径0 页面拦截: 开始尝试, lang=', track.languageCode, 'kind=', track.kind || '-', 'videoId=', videoId);
    // 第一百三十三次：把原轨道 kind/vss_id 带进播放器触发配置（自动生成轨必需）
    const interceptResp = await triggerAndInterceptSubtitle(track.languageCode, videoId, 8, { kind: track.kind || '', vss_id: track.vss_id || '' });
    if (interceptResp) {
      console.log('[VocabRadar][youtube] 路径0 页面拦截成功, resp长度=', interceptResp.length);
      const parsed = parseSubtitleContent(interceptResp, '');
      if (parsed && parsed.length > 0) {
        console.log('[VocabRadar][youtube] 路径0 页面拦截解析:', parsed.length, '条');
        return parsed;
      }
      console.warn('[VocabRadar][youtube] 路径0 页面拦截响应解析为空, 前200字符:', interceptResp.slice(0, 200));
    } else {
      console.warn('[VocabRadar][youtube] 路径0 页面拦截: 响应为 null, 尝试其他方式');
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] 路径0 页面拦截异常:', e.message || e);
  }

  // === 路径 1：页面主世界 fetch 原始 baseUrl（核心路径！）===
  // 页面上下文的 fetch 请求与播放器自身请求一致，能绕过签名绑定会话的限制
  if (!needsPot) try {
    console.log('[VocabRadar][youtube] 路径1 页面fetch, url=', track.baseUrl.slice(0, 120));
    const pageResp = await fetchViaPageContext(track.baseUrl);
    if (pageResp && pageResp.ok && pageResp.text && pageResp.text.length > 0) {
      console.log('[VocabRadar][youtube] 路径1 页面fetch成功, status=', pageResp.status, 'content-type=', pageResp.contentType, '长度=', pageResp.text.length);
      const parsed = parseSubtitleContent(pageResp.text, pageResp.contentType || '');
      if (parsed && parsed.length > 0) {
        console.log('[VocabRadar][youtube] 路径1 页面fetch解析:', parsed.length, '条');
        return parsed;
      }
      console.warn('[VocabRadar][youtube] 路径1 页面fetch解析为空, 前200字符:', pageResp.text.slice(0, 200));
    } else {
      console.warn('[VocabRadar][youtube] 路径1 页面fetch失败:', pageResp?.ok ? '内容为空' : (pageResp?.error || '无响应'));
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] 路径1 页面fetch异常:', e.message || e);
  }

  // === 路径 2：页面主世界 fetch baseUrl + fmt=json3 ===
  if (!needsPot) try {
    const json3Url = buildJson3Url(track.baseUrl, track.languageCode);
    console.log('[VocabRadar][youtube] 路径2 页面fetch json3, url长度=', json3Url.length);
    const pageResp = await fetchViaPageContext(json3Url);
    if (pageResp && pageResp.ok && pageResp.text && pageResp.text.length > 0) {
      console.log('[VocabRadar][youtube] 路径2 页面fetch json3成功, 长度=', pageResp.text.length);
      const parsed = parseSubtitleContent(pageResp.text, pageResp.contentType || 'application/json');
      if (parsed && parsed.length > 0) {
        console.log('[VocabRadar][youtube] 路径2 页面fetch json3解析:', parsed.length, '条');
        return parsed;
      }
      console.warn('[VocabRadar][youtube] 路径2 页面fetch json3解析为空, 前200字符:', pageResp.text.slice(0, 200));
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] 路径2 页面fetch json3异常:', e.message || e);
  }

  // === 路径 3：Content Script 直接 fetch（可能返回 0 字节，保留兜底）===
  let text = null;
  let contentType = '';

  if (!needsPot) try {
    console.log('[VocabRadar][youtube] 路径3 CS直接下载, url=', track.baseUrl.slice(0, 120));
    const res = await fetch(track.baseUrl, { credentials: 'same-origin' });
    console.log('[VocabRadar][youtube] 路径3 CS直接下载响应:', res.status, res.statusText, 'content-length=', res.headers.get('content-length'));
    if (res.ok) {
      contentType = res.headers.get('content-type') || '';
      text = await res.text();
      console.log('[VocabRadar][youtube] 路径3 CS直接下载成功, content-type:', contentType, '长度:', text.length);
      if (text.length < 1000) {
        console.log('[VocabRadar][youtube] 路径3 响应内容:', text);
      }
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] 路径3 CS直接下载异常:', e.message || e);
  }

  // 如果路径3拿到有效内容，解析返回
  if (text && text.length > 0) {
    const parsed = parseSubtitleContent(text, contentType);
    if (parsed && parsed.length > 0) return parsed;
    console.warn('[VocabRadar][youtube] 路径3 解析为空，继续尝试');
  }

  // === 路径 4：innertube WEB_EMBEDDED_PLAYER + fmt=json3（第一百一十三次：按原轨道语言/kind 匹配）===
  // 第一百三十二次：exp=xpe 轨道同样跳过本路径——WEB_EMBEDDED_PLAYER 返回的 baseUrl
  // 同样不带 pot，请求注定空 200，白耗数秒后才轮到免 POT 的 A/B 通道。
  let freshBaseUrl = null;
  if (needsPot) {
    console.warn('[VocabRadar][youtube] 路径4 跳过（exp=xpe 需 PoToken，直取 A/B 免 POT 通道）');
  } else {
    freshBaseUrl = await getFreshCaptionBaseUrl(videoId, track.languageCode, track.kind || '');
  }
  if (freshBaseUrl) {
    const json3Url = buildJson3Url(freshBaseUrl, track.languageCode);
    console.log('[VocabRadar][youtube] 路径4 json3 URL 构造完成, url长度=', json3Url.length);
    try {
      const res = await fetch(json3Url, { method: 'GET' });
      console.log('[VocabRadar][youtube] 路径4 json3 下载响应:', res.status, res.statusText, 'content-length=', res.headers.get('content-length'));
      if (res.ok) {
        const json3Text = await res.text();
        console.log('[VocabRadar][youtube] 路径4 json3 下载成功, 长度:', json3Text.length);
        if (json3Text.length > 0) {
          const parsed = parseSubtitleContent(json3Text, 'application/json');
          if (parsed && parsed.length > 0) {
            console.log('[VocabRadar][youtube] 路径4 json3 解析:', parsed.length, '条');
            return parsed;
          }
          console.warn('[VocabRadar][youtube] 路径4 json3 解析为空, 前200字符:', json3Text.slice(0, 200));
        } else {
          console.warn('[VocabRadar][youtube] 路径4 json3 返回 0 字节');
        }
      }
    } catch (e) {
      console.warn('[VocabRadar][youtube] 路径4 json3 下载异常:', e.message || e);
    }

    // === 路径 4b：innertube baseUrl 删 fmt（XML transcript 格式）===
    console.log('[VocabRadar][youtube] 路径4b transcript XML 格式');
    const transcriptUrl = buildTranscriptUrl(freshBaseUrl);
    try {
      const res = await fetch(transcriptUrl, { method: 'GET' });
      console.log('[VocabRadar][youtube] 路径4b transcript 下载响应:', res.status, res.statusText, 'content-length=', res.headers.get('content-length'));
      if (res.ok) {
        const xmlText = await res.text();
        console.log('[VocabRadar][youtube] 路径4b transcript 下载成功, 长度:', xmlText.length);
        if (xmlText.length > 0) {
          const parsed = parseSubtitleContent(xmlText, 'application/xml');
          if (parsed && parsed.length > 0) {
            console.log('[VocabRadar][youtube] 路径4b transcript 解析:', parsed.length, '条');
            return parsed;
          }
          console.warn('[VocabRadar][youtube] 路径4b transcript 解析为空, 前200字符:', xmlText.slice(0, 200));
        } else {
          console.warn('[VocabRadar][youtube] 路径4b transcript 返回 0 字节');
        }
      }
    } catch (e) {
      console.warn('[VocabRadar][youtube] 路径4b transcript 下载异常:', e.message || e);
    }
  } else {
    console.warn('[VocabRadar][youtube] 路径4 innertube 获取 baseUrl 失败，跳过');
  }

  // === 路径 A（第一百二十二次）：ANDROID 客户端 timedtext（无需 PoToken）===
  // 第一百三十二次：不再以"路径3 是否拿到内容"为前置条件——xpe 轨道 text 恒为空，
  // 旧条件恰好把 A 通道挡在门外（空轨道加载的帮凶之一）。
  {
    const viaAndroid = await fetchTrackViaAndroidClient(videoId, { languageCode: track.languageCode, kind: track.kind || '' });
    if (viaAndroid && viaAndroid.length > 0) return viaAndroid;
  }

  // === 路径 B（第一百二十二次）：get_transcript 面板数据（无需 PoToken）===
  const viaTranscript = await fetchTrackViaGetTranscript(videoId);
  if (viaTranscript && viaTranscript.length > 0) return viaTranscript;

  // === 路径 5：service worker 代理 ===
  console.log('[VocabRadar][youtube] 路径5 service worker 代理');
  text = await fetchSubtitleViaServiceWorker(track.baseUrl);
  if (text) {
    contentType = text.trim().startsWith('<') ? 'application/xml' : 'application/json';
    console.log('[VocabRadar][youtube] 路径5 SW代理下载成功, 推断类型:', contentType, '长度:', text.length);
    if (text.length < 500) {
      console.log('[VocabRadar][youtube] 路径5 SW响应内容:', text);
    }
    const parsed = parseSubtitleContent(text, contentType);
    if (parsed && parsed.length > 0) return parsed;
  }

  // === 全部失败：汇总诊断行（第一百二十四次）——把关键探测结果集中一行，便于贴日志定位
  console.error('[VocabRadar][youtube] 所有下载渠道均失败 | lang=' + (track.languageCode || '?')
    + ' kind=' + (track.kind || '-')
    + ' exp=xpe=' + needsPot
    + ' videoId=' + (videoId || '?'));
  return null;
}
