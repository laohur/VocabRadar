// =============================================================================
// yt/backend.js —— YouTube 字幕 backend 兜底与 SW 代理
// -----------------------------------------------------------------------------
// 职责：fetchSubsViaBackend()（SW → backend yt-dlp 提取，直出结构化条目）、
//       backendSubtitlesFallback()（与 getYouTubeSubtitles 同构结果包装/失败回 prev）、
//       fetchSubtitleViaServiceWorker()（SW 代理下载绕过 CS CORS）。
// 来源：拆分自 src/lib/subtitle/youtube-fetcher.js（2026-09-27 拆分第三刀，机械搬移）。
// 消费方：./caption-tracks.js（backendSubtitlesFallback）、
//       ./track-download.js（fetchSubsViaBackend/fetchSubtitleViaServiceWorker）。
// =============================================================================

// === 第399次：字幕 backend 兜底（扩展五路全失败后 SW 代理调 backend yt-dlp） ===
// SW case 'YTDL_SUBTITLES' → GET /api/ytdl/subtitles?url=&lang= → backend 用
// yt-dlp subtitles/automatic_captions 提取，直出结构化条目 {start,end,text}（秒）。
// 成功返回与 getYouTubeSubtitles 同构结果（伪轨 _backend=true、baseUrl 空——
// 条目已直出无需再拉）；backend 不可用/无字幕返回 prev（保持原失败语义）。
export async function fetchSubsViaBackend(lang) {
  return await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'YTDL_SUBTITLES', url: location.href, lang },
        (r) => resolve(chrome.runtime.lastError ? null : (r || null)));
    } catch (e) {
      console.warn('[VocabRadar][youtube] backend 兜底消息异常:', e);
      resolve(null);
    }
  });
}

export async function backendSubtitlesFallback(lang, prev) {
  const resp = await fetchSubsViaBackend(lang);
  if (resp && resp.ok && Array.isArray(resp.cues) && resp.cues.length) {
    console.log('[VocabRadar][youtube] backend 兜底成功: lang=' + resp.lang + ' kind=' + resp.kind + ' cues=' + resp.cues.length);
    return {
      tracks: [{
        languageCode: resp.lang || lang || '',
        name: 'backend (' + (resp.kind || 'auto') + ')',
        kind: 'asr', baseUrl: '', _backend: true,
      }],
      subtitles: resp.cues,
      pickedIndex: 0,
    };
  }
  // 第435次：失败原因透出（不遮蔽）——backend 业务错误（error/message，如
  // yt-dlp 撞 YouTube 机器人墙）与 SW 无响应（backend 未运行）分类如实打印
  if (!resp) {
    console.warn('[VocabRadar][youtube] backend 兜底失败: SW 无响应（backend 未运行或消息通道异常）');
  } else {
    console.warn('[VocabRadar][youtube] backend 兜底失败: ' + (resp.error || 'no cues')
      + (resp.message ? ' — ' + resp.message : ''));
  }
  return prev;
}

/**
 * 通过 service worker 代理下载字幕（绕过 content script 的 CORS 限制）
 * @param {string} url 字幕 URL
 * @returns {Promise<string|null>} 字幕内容
 */
export async function fetchSubtitleViaServiceWorker(url) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FETCH_SUBTITLE', url }, (resp) => {
      if (resp && resp.ok && resp.text) {
        resolve(resp.text);
      } else {
        console.warn('[VocabRadar][youtube] service worker 代理失败:', resp?.error || 'no response');
        resolve(null);
      }
    });
  });
}
