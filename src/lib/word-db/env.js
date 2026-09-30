// ============================================================
// 文件职责：运行环境检测与共享环境常量（src/lib/word-db/env.js）
// isSW / DIRECT_IDB / runtimeValid 是跨模块共享的环境判定，本文件是唯一定义处
//   （导出常量与函数，全模块图仅此一份，绝不复制两份），被 db-ops.js（getDB
//   isSW 守卫）与 sw-channel.js（DIRECT_IDB 直连优先 / isSW / runtimeValid 路由）
//   import 引用。模块加载时执行一次站点库清污副作用（env.js 在模块图中仅加载
//   一次，不会重复执行）。
// ============================================================

// 检测运行环境：扩展后台（SW/背景页） vs 内容脚本
// Firefox MV3 用 background.scripts（背景页），其中 typeof window !== 'undefined'
//   （与 SW 不同），但 indexedDB 可直接使用（扩展源 IDB，非站点隔离）；
//   仅按 SW（无 window）检测会漏掉 Firefox 背景页。故检测扩展后台上下文（含 SW
//   和 Firefox 背景页）：
//   1. self.constructor.name === 'ServiceWorkerGlobalScope'（Chrome/Firefox SW）
//   2. typeof window === 'undefined' && typeof self !== 'undefined'（无 window = SW/Worker）
//   3. typeof importScripts === 'function'（SW 特有 API）
//   4. typeof chrome.tabs !== 'undefined'（后台上下文独有 API，content script 无 chrome.tabs）
//   4 个条件任一满足即判定为后台上下文（可直接操作 IDB）。
//   content script 中 chrome.tabs 不存在，不会误判。
export const isSW = (typeof self !== 'undefined' && (
  (self.constructor && self.constructor.name === 'ServiceWorkerGlobalScope') ||
  (typeof window === 'undefined' && typeof self !== 'undefined') ||
  (typeof importScripts === 'function')
)) || (typeof chrome !== 'undefined' && typeof chrome.tabs !== 'undefined');

// DIRECT_IDB 架构裁定：**IDB 唯一属主 = Service Worker**，前端直写禁用--
// Chromium 系与 Firefox 的 content script 的 indexedDB 均指向**页面源**（storage
// 按文档源隔离，扩展只豁免 chrome.storage），直写会把词典建进每个网站的源：
// 跨页即丢（每页重建）+ 站点存储污染。可靠性从通道侧解决：逐块即时小事务
// （不攒批+末块巨事务），全块确认后才打构建标记。
export const DIRECT_IDB = false;

// 站点库清污：历史直写可能在已访问网站源残留 beaver-dict，尽力删除
// （deleteDatabase 对不存在的库是无害 no-op；http(s) 页面上下文才执行）。
try {
  if (typeof indexedDB !== 'undefined'
      && typeof location !== 'undefined' && /^https?:$/i.test(location.protocol)) {
    indexedDB.deleteDatabase('beaver-dict');
  }
} catch (e) { /* ignore */ }

/**
 * 扩展上下文有效性检测：chrome.runtime.getURL 可调用即上下文有效
 * （参照 text-hint-impl.js isContextValid 模式）。
 * @returns {boolean} 扩展运行时上下文是否有效（SW/后台页 true；content script 上下文失效时 false）
 */
export function runtimeValid() {
  try {
    return !!(typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function');
  } catch (e) {
    return false;
  }
}
