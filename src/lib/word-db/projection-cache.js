// ============================================================
// 文件职责：SW 词典投影内存缓存（src/lib/word-db/projection-cache.js）
// 来源：拆分自 src/lib/word-db.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// lang -> {built, ranks, tags, lemmas, ranksCount, expected} 会话级缓存，
//   消除"每页加载都整表扫描投影（~0.9s）"的浪费；bulkWrite/CLEAR 时失效。
// 拆分铁律（跨模块共享状态）：导出唯一 Map 实例 _projCache，绝不复制两份；
//   sw-channel.js 的 handleWordDbMessage（WORD_DB_GET_LANG_PROJ 读缓存、
//   WORD_DB_CLEAR_LANG/BULK_WRITE/PROJ_CACHE_INVALIDATE/CLEAR_ALL 失效）
//   与本文件同源引用同一实例。
// ============================================================

// 词典投影内存缓存（2026-08-20 第八十七次）：lang -> {built, ranks, tags}
//   消除"每页加载都整表扫描投影（~0.9s）"的浪费；bulkWrite/CLEAR 时失效。
export const _projCache = new Map();
