// ============================================================
// 文件职责：字幕模块统一导出入口（src/lib/subtitle/index.js）
// ============================================================

export { getBilibiliSubtitles, fetchBilibiliTrack, fetchBilibiliSecondarySubtitles } from './bilibili-fetcher.js';
export { getYouTubeSubtitles, warmYouTubeCaptionInnertube, fetchYouTubeTrack, fetchYouTubeSecondarySubtitles } from './youtube-fetcher.js';
// 双语第二轨对齐算法（纯函数）：全局偏移估计 + 时间重叠配对
export { estimateOffset, prepareSecondary, pairSecondaryText } from './bilingual-align.js';
