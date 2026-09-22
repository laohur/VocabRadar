// =============================================================================
// log-flag.js —— 日志双阀门（第367次新增）
// -----------------------------------------------------------------------------
// 职责：debugLog（调试日志）/ diagLog（诊断日志）两个 storage 键的读取与即时生效，
//       为各上下文提供同步查询接口 isDebugLog()/isDiagLog()。
// 背景（2026-09-22 第三百六十七次）：config.json debug 默认改 false 后，打包默认静默；
//       引导页 help 底部两个开关（guide.js renderHelp 尾部）勾选写 storage，
//       本模块经 chrome.storage.onChanged 监听即时翻转，content script 无需刷新页面。
// 语义（用户裁定）：
//   - debugLog  ：普通调试日志阀门（vs/logger.js、ws/core.js 的 log 出口）；
//   - diagLog   ：诊断类日志阀门（annotator 0命中诊断、dict-stats 批量账本、
//                 asr-stage [asr][diag] 时间线等）。
//   - config.json debug 仍独立生效（vs/logger.js 内 OR 合并）：config true 时
//     打包期就全量打印，debugLog 是运行期补充开关。
// 注意：每个 JS 上下文（CS / 引导页 / offscreen）独立模块实例，各自读 storage
//       并监听变化；初始读取是异步的，首帧前的极少量日志可能错过（可接受）。
// 非扩展环境（无 chrome.storage）：保持 false，不抛错（vendor/测试环境兜底）。
// =============================================================================

let _debugLog = false;        // 调试日志开关（storage.local.debugLog 镜像）
let _diagLog = false;         // 诊断日志开关（storage.local.diagLog 镜像）
let _inited = false;          // 幂等初始化标记（首次查询时惰性启动）

function init() {
  if (_inited) return;
  _inited = true;
  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get(['debugLog', 'diagLog'], (res) => {
      if (chrome.runtime.lastError) return;
      _debugLog = !!(res && res.debugLog);
      _diagLog = !!(res && res.diagLog);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.debugLog) _debugLog = !!changes.debugLog.newValue;
      if (changes.diagLog) _diagLog = !!changes.diagLog.newValue;
    });
  } catch (e) { /* 环境不支持则恒 false（静默），不掩蔽业务错误 */ }
}

/** 调试日志是否开启（vs/logger.js / ws/core.js log 出口用） */
export function isDebugLog() { init(); return _debugLog; }

/** 诊断日志是否开启（annotator 0命中诊断 / dict-stats logBatch / asr-stage 用） */
export function isDiagLog() { init(); return _diagLog; }
