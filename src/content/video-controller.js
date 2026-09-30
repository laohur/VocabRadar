// 视频元素监听：统一处理 B站/YouTube 的 video 元素查找与字幕加载 -- 门面（纯 re-export）
// 功能模块在 src/content/vc/（state/video-detect/controller）。
//
// 跨模块共享状态铁律：vcState 唯一实例在 state.js，controller.js 与 video-detect.js
//   经 import 同源引用，绝不复制两份。
// 本门面仅 re-export 全部导出符号（符号名不变），所有引用方
//   （bilibili.js/youtube.js/generic.js 动态 import、web-sidebar-impl.js 静态 import）零改动。
export { startVideoController, reviveSidebarIfPossible } from './vc/controller.js';
