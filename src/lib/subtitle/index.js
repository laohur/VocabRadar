// ============================================================
// 文件职责：字幕模块统一导出入口（src/lib/subtitle/index.js）
// ============================================================

export { getBilibiliSubtitles, fetchBilibiliTrack } from './bilibili-fetcher.js';
export { getYouTubeSubtitles, warmYouTubeCaptionInnertube, fetchYouTubeTrack } from './youtube-fetcher.js';
