// 文本提示实现（ES module）—— 门面（facade）
//
// === 拆分说明（2026-08-28）===
// 本文件原为 2390 行单体实现，已机械拆分到 src/content/th/ 下 4 个模块：
//   - th/core.js    共享状态（thState 唯一属主）/常量/正则/样式注入/配色/朗读等工具
//   - th/tooltip.js 悬浮卡片（hover 浮层）：ensureTooltip/showTooltip/onWordHover/onWordClick 等
//   - th/panel.js   右键查询面板与 OCR 结果面板：showContextPanel/showOcrResultPanel/ocrVideoFrame 等
//   - th/scan.js    扫描/注释/生命周期：startHint/stopHint/扫描分批/侧邻注释/MutationObserver/诊断
// 拆分为纯搬移，逻辑与行为与拆分前完全一致；原模块级变量 _xxx 统一为共享状态 thState.xxx，
// 全局共享状态只在 th/core.js 定义一份，其余模块通过 import { thState } 读写（getter/setter 接缝）。
// 本文件仅做 re-export，对外导出集合与拆分前完全一致，外部引用方（src/content/text-hint.js
// 动态 import 本文件）零改动。
//
// 功能（详见各子模块头部注释）：
//   1. 全站正文文本节点扫描，识别生词
//   2. 生词包裹高亮：词典命中且 rank>阈值，或表外单词(translator 命中)
//   3. 首次出现用"首次配色"（默认白字灰蓝底），后续用"后续配色"（默认白字灰绿底）
//   4. 鼠标 hover 弹出浮层：单词、词阶、标签、释义、朗读按钮
//   5. 点击生词朗读（Web Speech API）
//   6. 右键菜单查词面板：选中任意文本，显示释义/标签/词阶/朗读
//
// 配色可配置（popup 取色框）：
//   - 首次：开关 hintFirstEnabled + 背景色 hintFirstBg + 字色 hintFirstFg
//   - 后续：开关 hintLaterEnabled + 背景色 hintLaterBg + 字色 hintLaterFg
//   - 颜色写入 :root 的 CSS 变量，样式表通过 var() 引用，改色无需重扫
//   - 开关变化需重扫（决定是否包裹）
//
// 设计要点：
//   - 浮层/面板用 Shadow DOM 隔离样式，避免页面 CSS 污染
//   - 扫描用 TreeWalker + requestIdleCallback 分批，避免阻塞
//   - MutationObserver 增量扫描新节点
//   - 单词查询结果全局缓存(thState.wordCache)，避免重复 translator 调用
//   - 浮层/面板均为 position:fixed 视口固定；scroll 视为失去注意力，立即隐藏
//   - 右键面板点击外部立即关闭；hover tooltip mouseleave 延迟 panelHideDelay（默认5秒）

// 配色热更新与文本样式类（来源：th/core.js）
// 301次：refreshAnnExtraCss——个性化/用户条目文本规则刷新（门面直通，引用方零改动）
export { updateColors, applyTextStyleClass, refreshAnnExtraCss } from './th/core.js';

// 右键查词面板 / OCR 结果面板 / 视频帧 OCR（来源：th/panel.js）
// w4（2026-09-09）：panel.js 连带 dictionary/translator/lemmatizer/phonetics/chat 等重依赖，
//   静态 re-export 会把整串拖进启动模块图，抵消 scan.js 惰性化收益，故改动态转发。
//   调用方（text-hint.js L392/L405）对前两个函数均为 fire-and-forget（忽略返回值），
//   Promise 转发兼容；ocrVideoFrame 当前无外部调用方，保留转发不删功能。
export function showContextPanel(text, clientX, clientY) {
  return import('./th/panel.js').then((m) => m.showContextPanel(text, clientX, clientY));
}
export function showOcrResultPanel(text, clientX, clientY, info = '') {
  return import('./th/panel.js').then((m) => m.showOcrResultPanel(text, clientX, clientY, info));
}
export function ocrVideoFrame(clientX, clientY) {
  return import('./th/panel.js').then((m) => m.ocrVideoFrame(clientX, clientY));
}

// 生命周期、设置入口与诊断（来源：th/scan.js）
// 280次：setAnnTemplate——侧邻注释模板 setter（模板变化需清缓存重扫，原 setAnnBrackets）
export {
  startHint,
  stopHint,
  rescanNow,
  clearHighlights,
  setRankThreshold,
  setRankThresholdMax,
  setAnnotateOov,
  setAnnotateRepeat,
  setAnnTemplate,
  getDiagState
} from './th/scan.js';
