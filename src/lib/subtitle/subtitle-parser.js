// ============================================================
// 文件职责：字幕内容解析与共用工具（XML / JSON / timedtext 各格式 → 统一 [{start,end,text}]）
// 来源：拆分自 src/lib/subtitle-fetcher.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-27
// 符号：parseSubtitleContent（export，供 youtube-fetcher.js 调用）
//   parseYouTubeTimedText / parseYouTubeTimedTextJson 仅被 parseSubtitleContent 内部调用，
//   与其同文件放置以避免循环依赖，保持模块私有（不加 export）。
// ============================================================
/**
 * 解析 YouTube timedtext XML
 * @param {string} xml
 * @returns {Array<{start, end, text}>}
 */
function parseYouTubeTimedText(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const segs = doc.querySelectorAll('text');
  const result = [];
  for (const seg of segs) {
    const start = parseFloat(seg.getAttribute('start')) || 0;
    const dur = parseFloat(seg.getAttribute('dur')) || 0;
    const text = (seg.textContent || '').replace(/\n/g, ' ').replace(/&amp;/g, '&').trim();
    if (text) {
      result.push({ start, end: start + dur, text });
    }
  }
  return result;
}

/**
 * 解析 YouTube 字幕 JSON 格式（主解析器，XHR 拦截返回 JSON）
 * YouTube JSON 字幕常见两种结构：
 *   1) {events: [{tStartMs, dDurationMs, segs: [{utf8}]}]}
 *   2) {transcript: [{start, duration, text}]}
 * @param {Object} json
 * @returns {Array<{start, end, text}>}
 */
function parseYouTubeTimedTextJson(json) {
  const result = [];
  // 格式 1：events 数组（最常见）
  if (json.events && Array.isArray(json.events)) {
    for (const ev of json.events) {
      const start = (typeof ev.tStartMs === 'number' && isFinite(ev.tStartMs)) ? ev.tStartMs / 1000 : 0;
      const dur = (typeof ev.dDurationMs === 'number' && isFinite(ev.dDurationMs)) ? ev.dDurationMs / 1000 : 0;
      let text = '';
      if (ev.segs && Array.isArray(ev.segs)) {
        text = ev.segs.map((s) => s.utf8 || '').join('');
      } else if (typeof ev.utf8 === 'string') {
        text = ev.utf8;
      }
      text = text.replace(/\n/g, ' ').trim();
      if (text) {
        result.push({ start, end: start + dur, text });
      }
    }
    return result;
  }
  // 格式 2：transcript 数组
  if (json.transcript && Array.isArray(json.transcript)) {
    for (const item of json.transcript) {
      const start = (typeof item.start === 'number' && isFinite(item.start)) ? item.start : 0;
      const dur = (typeof item.duration === 'number' && isFinite(item.duration)) ? item.duration : 0;
      const text = (item.text || '').replace(/\n/g, ' ').trim();
      if (text) {
        result.push({ start, end: start + dur, text });
      }
    }
    return result;
  }
  // 格式 3：subtitle 数组
  if (json.subtitles && Array.isArray(json.subtitles)) {
    for (const item of json.subtitles) {
      const start = (typeof item.start === 'number' && isFinite(item.start)) ? item.start : 0;
      const dur = (typeof item.duration === 'number' && isFinite(item.duration)) ? item.duration : 0;
      const text = (item.text || '').replace(/\n/g, ' ').trim();
      if (text) {
        result.push({ start, end: start + dur, text });
      }
    }
    return result;
  }
  console.warn('[VocabRadar][subtitle-parser] parseYouTubeTimedTextJson 未知 JSON 结构');
  return [];
}

/**
 * 解析字幕内容（XML 优先，JSON 回退）
 * @param {string} text 字幕内容
 * @param {string} contentType HTTP content-type
 * @returns {Array<{start, end, text}>|null}
 */
export function parseSubtitleContent(text, contentType) {
  if (contentType.includes('xml') || text.trim().startsWith('<')) {
    const subs = parseYouTubeTimedText(text);
    console.log('[VocabRadar][subtitle-parser] 解析结果: XML格式,', subs.length, '条');
    return subs;
  }
  if (contentType.includes('json') || text.trim().startsWith('{')) {
    try {
      const json = JSON.parse(text);
      const subs = parseYouTubeTimedTextJson(json);
      console.log('[VocabRadar][subtitle-parser] 解析结果: JSON格式,', subs.length, '条');
      return subs;
    } catch (e) {
      console.warn('[VocabRadar][subtitle-parser] JSON解析失败:', e);
    }
  }
  console.warn('[VocabRadar][subtitle-parser] 未知格式, 前200字符:', text.slice(0, 200));
  return null;
}
