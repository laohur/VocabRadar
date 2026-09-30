// ============================================================
// 文件职责：释义查询跨模块共享状态与基础工具（src/lib/translator/shared.js）
// 跨模块共享状态唯一属主（铁律：绝不复制两份）：
//   transState = { learnLang, meaningLang }：
//   builtin-translator.js（storage 语言对监听读写、availability/create 参数）与
//   index.js（词典缓存读写、SW 消息参数）经 import 引用同一实例读写。
//   _lastChannel（最近一次翻译成功渠道）仅存于本模块，经 _setLastChannel 写入、
//   getLastTranslateChannel() 读取（index.js 原形回退日志拼接直接调用该导出读取）。
// 本文件还含：withTimeout（带超时 Promise）、_ts() 时间戳、log() 调试日志
//   （_debug 开关 + config.json 读取）、getMeaningLang()。
// ============================================================

/**
 * 带超时的 Promise 包装：浏览器 Translator API 的 availability/create/translate
 *   调用可能永久挂起（如模型下载卡住、用户手势缺失时 create 不返回也不报错），
 *   导致翻译队列阻塞，后续所有词都卡住——所有 Translator API 调用加超时，
 *   超时后 reject 让翻译流程继续走在线渠道。
 * @param {Promise} promise 原始 Promise
 * @param {number} ms 超时毫秒
 * @param {string} label 超时标签（日志用）
 * @returns {Promise} 带超时的 Promise
 */
export function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' 超时(' + ms + 'ms)')), ms))
  ]);
}

// 时间戳辅助
export function _ts() {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// === 最近一次翻译成功渠道 ===
// 记录最近一次成功渠道，供调用方在日志中标注（translate() 返回纯字符串译文，
//   调用方日志看不出走的是哪个渠道）。
let _lastChannel = '';
function _setLastChannel(label) {
  if (label) _lastChannel = label;
}
/**
 * 获取最近一次翻译成功渠道（供调用方日志标注）
 * @returns {string} 如 '本地缓存' / '浏览器内置翻译' / '在线:BaiduSug'
 */
export function getLastTranslateChannel() {
  return _lastChannel;
}

/**
 * 获取当前目标语言（释义语言，如 'zh'）：annotator 判断统一词典翻译缓存是否
 *   命中时，需与 translationLang（记录的是目标语言）比对，故导出当前目标语言。
 * @returns {string} 目标语言代码
 */
export function getMeaningLang() {
  return transState.meaningLang;
}

// === 当前语言对（从 storage 读取，默认 en -> zh；支持多语言切换） ===
// 唯一实例在此定义：storage 初始读取与 onChanged 监听在 builtin-translator.js，
//   availability/create 参数与缓存/SW 消息参数在 index.js，均同源引用。
export const transState = {
  learnLang: 'en',
  meaningLang: 'zh'
};

// 日志遵循调试开关：_debug 从 config.json 读取，false 时只输出 console.warn（错误），
//   true 时输出 console.log（调试信息：渠道、翻译过程等）
let _debug = false;
// 异步读取 config.json 的 debug 字段
(async () => {
  try {
    const url = chrome.runtime.getURL('src/data/config.json');
    const res = await fetch(url);
    const cfg = await res.json();
    _debug = !!cfg.debug;
  } catch (_) { /* ignore */ }
})();
// 调试日志：仅在 _debug=true 时输出
export function log(...args) {
  if (_debug) console.log(...args);
}

// _setLastChannel 供 index.js（_translateInternal/translateWithLemma）写渠道标记
export { _setLastChannel };
