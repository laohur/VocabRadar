// ============================================================
// 文件职责：运行环境检测与共享环境常量（src/lib/word-db/env.js）
// 来源：拆分自 src/lib/word-db.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// isSW / DIRECT_IDB / runtimeValid 是跨模块共享的环境判定，本文件是唯一定义处
//   （导出常量与函数，全模块图仅此一份，绝不复制两份），被 db-ops.js（getDB
//   isSW 守卫）与 sw-channel.js（DIRECT_IDB 直连优先 / isSW / runtimeValid 路由）
//   import 引用。模块加载时执行一次站点库清污副作用（与原 word-db.js 行为一致，
//   env.js 在模块图中仅加载一次，副作用不会重复执行）。
// ============================================================

// 检测运行环境：扩展后台（SW/背景页） vs 内容脚本
// 反思（2026-08-12 第四十五次）：Firefox MV3 用 background.scripts（背景页），
//   背景页中 typeof window !== 'undefined'（与 SW 不同），但 indexedDB 可直接使用
//   （扩展源 IDB，非站点隔离）。旧检测仅覆盖 SW（无 window），遗漏 Firefox 背景页
//   -> isSW=false -> handleWordDbMessage 返回 false -> IDB 读写全部静默失败
//   -> 翻译/注音永不缓存 -> 每次刷新都重新查询。
//
//   修正：检测扩展后台上下文（含 SW 和 Firefox 背景页）：
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

// 第一百五十二次（用户裁定架构"前端直写 DB，后台仅刷新缓存"）：
// Chromium 系（Chrome/Edge）content script 与扩展页**共享扩展源 IndexedDB**
// （chrome-extension:// 源），可直连读写；旧注释"CS 的 IDB 按站点隔离"对
// Firefox 成立、对 Chromium 不成立--这正是此前 SW 通道末块失败的绕行根源。
// 判定：SW 本体 或 扩展协议页面/脚本（chrome-extension:|moz-extension: 页面上下文）
// ⇒ 直连；Firefox content script（页面 https 源）保持 SW 通道不变。
// 第一百五十三次·修正：上一轮用 location.protocol 判定直连--但内容脚本的
// location 是**网页地址**（https:），判定恒假，直连从未启用（用户日志实证仍走
// SW 通道且末块失败）。改为引擎探测（无副作用）：
//   Chromium 系（Chrome/Edge）content script 与扩展页共享扩展源 IndexedDB ⇒ 直连；
//   Firefox content script 的 indexedDB 指向页面源（会建错库）⇒ 保持 SW 通道。
const HAS_IDB = (typeof indexedDB !== 'undefined');
const IS_CHROMIUM = (typeof navigator !== 'undefined'
  && /Chrom(e|ium)|Edg\//.test(navigator.userAgent)
  && !/Firefox|FxiOS/i.test(navigator.userAgent));
// 第一百五十四次·架构勘误：152 轮"前端直写"是错误判断--Chromium 内容脚本的
// indexedDB 同样指向**页面源**（storage 按文档源隔离，扩展只豁免 chrome.storage）。
// 直写会把词典建进每个网站的源：跨页即丢（每页重建）+ 站点存储污染。
// 回归正确所有权：**IDB 唯一属主 = Service Worker**；可靠性从通道侧解决--
// 逐块即时小事务（不再 SW 攒批+末块巨事务），全块确认后才打构建标记。
export const DIRECT_IDB = false;

// 站点库清污：上两轮直写可能在已访问网站源残留 beaver-dict，尽力删除
// （deleteDatabase 对不存在的库是无害 no-op；http(s) 页面上下文才执行）。
try {
  if (typeof indexedDB !== 'undefined'
      && typeof location !== 'undefined' && /^https?:$/i.test(location.protocol)) {
    indexedDB.deleteDatabase('beaver-dict');
  }
} catch (e) { /* ignore */ }

/**
 * 扩展上下文有效性检测（第一百三十六次补缺失定义）
 * 反思：全文件 11 处调用 runtimeValid() 但从未定义--ReferenceError 被 dictionary.js
 *   捕获打印为「送入词典失败（忽略）」，IDB 缓存读写静默失效。参照 text-hint-impl.js
 *   isContextValid 模式：chrome.runtime.getURL 可调用即上下文有效。
 * @returns {boolean} 扩展运行时上下文是否有效（SW/后台页 true；content script 上下文失效时 false）
 */
export function runtimeValid() {
  try {
    return !!(typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function');
  } catch (e) {
    return false;
  }
}
