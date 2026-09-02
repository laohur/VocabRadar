// 单次扫描总线（2026-08-16 第七十一次）
//
// 反思：用户裁定"二者用一个扫描，任意一方开关都不影响"——
//   页面只允许有一个扫描器（text-hint 的 TreeWalker 逐文本节点扫描），
//   text-hint 把每块文本的注释结果推给本总线；文本侧栏订阅消费，
//   不再 querySelectorAll('.beaver-word') 二次扫描（旧版两个 content script
//   各扫一遍，日志里出现两条"页面扫描"，且时序不一致导致侧栏读到未翻译的空释义）。
//   text-hint 关闭时侧栏才走自身 fallback 独立扫描（此时无总线产出）。
//
// 同一 content script 隔离世界内，多个模块动态 import 同一 URL 得到同一实例，
//   text-hint-impl 与 web-sidebar-impl 都 import 本文件 → 天然单例互通。

const listeners = new Set();
const blocks = [];
let _lastEmitAt = 0;
// 上限：超长页面（数千文本节点）时每个块内各文本节点都携带同一全块文本，内存/回放成本
//   与节点数成正比；截断为最近 MAX_BLOCKS 块（侧栏已按句子去重，旧块不影响结果）。
const MAX_BLOCKS = 3000;

/** text-hint 扫描产出：{ text, words:[{word,lower,rank,tags,translations,lemma,isFirst,pending}] } */
export function emitBlock(block) {
  if (!block || !block.text) return;
  blocks.push(block);
  if (blocks.length > MAX_BLOCKS) blocks.splice(0, blocks.length - MAX_BLOCKS);
  _lastEmitAt = Date.now();
  for (const l of [...listeners]) {
    try { l(block); } catch (e) { console.warn('[VocabRadar][scan-bus] 监听器异常:', e); }
  }
}

/** 订阅扫描产出；reset 事件形如 { reset: true }（text-hint 重扫/清高亮时发出） */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 已产出的全部块（侧栏启动晚于扫描时回放用） */
export function getBlocks() { return blocks.slice(); }

/** 最近一次产出时间戳（0=从未产出） */
export function getLastEmitAt() { return _lastEmitAt; }

/** 重扫/清高亮时清空历史块并通知消费方清去重（text-hint 重扫前调用） */
export function resetScan() {
  blocks.length = 0;
  _lastEmitAt = 0;
  for (const l of [...listeners]) {
    try { l({ reset: true }); } catch (e) { console.warn('[VocabRadar][scan-bus] 监听器异常:', e); }
  }
}
