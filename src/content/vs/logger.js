// =============================================================================
// vs/logger.js —— 调试日志子模块
// -----------------------------------------------------------------------------
// 职责：调试开关 _debug 与带时间戳的 log() 输出（唯一来源）。
// 来源：拆分自 src/content/video-sidebar.js（2026-08-28 拆分第二刀，纯机械搬移）。
// 关系：无外部依赖；其余 vs/* 模块与门面 video-sidebar.js 通过 import { log }
//       使用；门面 loadConfig 读取配置后调 setDebug(cfg.debug) 同步开关
//       （原门面内 `_debug = !!cfg.debug` 的等价接驳，开关唯一写入点仍在此模块）。
// 日志前缀（2026-08-30 第一百八十次，按用户裁定统一）：本模块输出
//       `[VocabRadar][video-sidebar][时间]` —— **特指视频侧栏**。旧前缀 `[sidebar]`
//       字面上会被误读成"公共侧栏"，且同一个视频侧栏此前混用 [sidebar] /
//       [Sidebar][size] / [VocabRadar][sidebar] 三种写法，本次全部收敛。
//       网页文本侧栏另有一套：`[VocabRadar][web-sidebar]`（src/content/ws/core.js#log）。
// =============================================================================

let _debug = false;           // 调试日志开关

// === debug 日志（带时间戳 HH:MM:SS.mmm） ===
function log(...args) {
  if (_debug) {
    const d = new Date();
    const ts = d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    console.log('[VocabRadar][video-sidebar][' + ts + ']', ...args);
  }
}

// 接驳导出：门面 loadConfig 读取配置后调用（原 `_debug = !!cfg.debug` 的等价迁移）
function setDebug(v) {
  _debug = !!v;
}

export { log, setDebug };
