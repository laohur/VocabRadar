// =============================================================================
// SW 日志门面
// 职责：时间戳格式 _ts、调试开关 _debug（config.json 读取）、受控输出 log。
// 唯一属主：_debug 只在本文件读写；各子模块一律 import { _ts, log } 使用，
//   不得自建时间戳或直读 config.json（口径唯一）。
// =============================================================================

/** 时间戳辅助：所有日志带 HH:MM:SS.mmm 便于诊断时序问题 */
export function _ts() {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// 用户要求"网络请求等打印日志遵循调试开关"：
//   _debug 从 config.json 读取，false 时只输出 console.warn（错误），
//   true 时输出 console.log（调试信息：网络请求、渠道、转发日志等）
let _debug = false;

/** 调试日志：仅在 _debug=true 时输出 */
export function log(...args) {
  if (_debug) console.log(...args);
}

// 异步读取 config.json 的 debug 字段（模块顶层副作用：SW 每次唤醒即读一次）
(async () => {
  try {
    const url = chrome.runtime.getURL('src/data/config.json');
    const res = await fetch(url);
    const cfg = await res.json();
    _debug = !!cfg.debug;
  } catch (_) { /* ignore */ }
})();
