// =============================================================================
// vs/ocr-store.js —— OCR 截帧识别结果存储（OCR 字幕轨道的数据源）
// -----------------------------------------------------------------------------
// 职责：OCR 识别段（{start,end,text}，视频相对秒）按 videoKey 持久化到
//       chrome.storage.local（键 ocr_cache_${videoKey}，仿 lib/asr-client.js 的
//       asr_cache_${videoKey} 口径），作为 OCR 独立字幕轨道的唯一真相源——
//       选轨/重进页面全量恢复；上屏只负责选中态的实时追加（appendASRSubtitle）。
// 关系：纯数据存取，不触碰 DOM；调用方 vs/ocr.js（写入+分流）与
//       vs/tracks.js（选轨加载）。
// =============================================================================

const storeKey = (videoKey) => 'ocr_cache_' + (videoKey || 'unknown');

function storageGet(key) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (r) => resolve((r && r[key]) || null));
    } catch (_) { resolve(null); }   // 扩展上下文失效等：按无存储处理
  });
}

function storageSet(key, value) {
  return new Promise((resolve) => {
    try { chrome.storage.local.set({ [key]: value }, () => resolve()); } catch (_) { resolve(); }
  });
}

/** 读整个 OCR 段表（按 start 升序；无存储/异常返回 []） */
export async function loadOCRStore(videoKey) {
  const arr = await storageGet(storeKey(videoKey));
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((s) => s && typeof s.start === 'number' && isFinite(s.start) && s.text)
    .sort((a, b) => a.start - b.start);
}

/** 追加一段 OCR 结果（同 start+text 去重，防连点重写）；返回更新后的段表 */
export async function saveOCRSegment(videoKey, seg) {
  if (!seg || !seg.text) return loadOCRStore(videoKey);
  const arr = await loadOCRStore(videoKey);
  const dup = arr.some((s) => s.start === seg.start && s.text === seg.text);
  if (!dup) arr.push({ start: seg.start, end: seg.end, text: seg.text });
  arr.sort((a, b) => a.start - b.start);
  await storageSet(storeKey(videoKey), arr);
  return arr;
}
