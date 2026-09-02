// ============================================================
// 文件职责：字幕模块统一导出入口（src/lib/subtitle/index.js）
// 来源：拆分自 src/lib/subtitle-fetcher.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-27
// 对外 re-export 原 src/lib/subtitle-fetcher.js 的全部 5 个导出符号，名称不变；
// 外部调用方仅将导入路径改为 ../subtitle/index.js 或 ./subtitle/index.js 即可。
// ============================================================

export { getBilibiliSubtitles, fetchBilibiliTrack } from './bilibili-fetcher.js';
export { getYouTubeSubtitles, warmYouTubeCaptionInnertube, fetchYouTubeTrack } from './youtube-fetcher.js';
