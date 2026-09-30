// ============================================================
// 文件职责：字幕内容解析与共用工具（XML / JSON / timedtext 各格式 → 统一 [{start,end,text}]）
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
 * ASR JSON3 碎片事件合并成句：YouTube json3 ASR 轨的 events 是逐词/逐碎片渲染
 *   事件（实测一条视频可解析出 14331 条碎片，每条一两个词甚至 [Music]），逐条
 *   全量塞侧栏会阻塞主线程几十秒（用户报"等了很久也无注释"），碎片句内容也与
 *   画面 CC 行对不上。本函数把碎片吸并到正常字幕行（~80 字符/7s/句末标点切句），
 *   条数降 1-2 个数量级，内容与画面 CC 行一致；对已是整行的 events（合并条件
 *   不满足则每条独立）无副作用。
 * 参考：youtube-transcript-api / yt-dlp 对 json3 均做行级重组，本函数同思路。
 * @param {Array<{start,end,text}>} list 已解析的碎片列表（json3 events 天然按时间有序）
 * @returns {Array<{start,end,text}>} 合并后的字幕行
 */
function mergeFragmentEvents(list) {
  if (!Array.isArray(list) || list.length < 2) return list;
  // 噪音行（[Music]/[Applause] 等，可带 >> 说话人前缀）：独立成句，不与正文互吸
  const isNoise = (t) => /^(>>\s*)?\[\s*(music|applause|laughter)\s*\]$/i.test(String(t).trim());
  const sentenceEnd = (t) => /[.!?…]['")\]]?$/.test(String(t).trim());
  const out = [];
  let cur = null; // {start, end, text} 当前合并中的行
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (isNoise(s.text)) { flush(); out.push(s); continue; }
    if (!cur) {
      cur = { start: s.start, end: s.end, text: s.text };
    } else if (s.start - cur.end >= 2) {
      // 与正在积累的行间隔过大 → 先切句，本碎片另起一行
      flush();
      cur = { start: s.start, end: s.end, text: s.text };
    } else {
      cur.end = Math.max(cur.end, s.end);
      cur.text = (cur.text + ' ' + s.text).replace(/\s+/g, ' ').trim();
    }
    // 切句判定：句末标点 / 已 80 字符 / 已 7 秒 / 与下一条碎片间隔 >= 2s
    const next = list[i + 1];
    const gapNext = next ? (next.start - cur.end) : Infinity;
    if (sentenceEnd(cur.text) || cur.text.length >= 80 || (cur.end - cur.start) >= 7 || gapNext >= 2) flush();
  }
  flush();
  return out;
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
    // 逐词碎片合并成句（长视频 ASR 实测 14331 条碎片 → 正常行数）
    const merged = mergeFragmentEvents(result);
    if (merged.length !== result.length) {
      console.log('[VocabRadar][subtitle-parser] JSON3 碎片合并:', result.length, '→', merged.length, '条');
    }
    return merged;
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
