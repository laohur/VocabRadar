// 视频元素监听：统一处理 B站/YouTube 的 video 元素查找与字幕加载 -- 门面（纯 re-export，零行为变更）
//
// 改动（2026-06-30）：字幕后同时启动 subtitle-overlay 与 sidebar。
// sidebar 接管"字幕标签页+生词表+底部按钮填入弹幕/评论"功能。
//
// 改动（2026-07-01，性能优化）：sidebar 骨架与字幕获取解耦。
//   原流程：waitForVideo -> waitForVideoReady -> getBilibiliSubtitles -> startSidebar(video, subs)
//   全部串行，sidebar 要等字幕下载完才显示骨架，且 startSidebar 内 await rerender() 还要
//   下载 7.86MB 词典+串行处理字幕，导致骨架 5 秒后才出现。
//   新流程：waitForVideo -> 立即 startSidebar(video) 显骨架("字幕加载中...")，
//   与 waitForVideoReady + getBilibiliSubtitles 并行；字幕到达后 updateSubtitles(subs) 填充。
//
// ===拆分说明（2026-08-28）===
// 本文件原为 524 行单文件，已按功能拆分为 src/content/vc/ 目录模块（纯机械搬移）：
//   - state.js：跨模块共享状态唯一属主（vcState：started/currentPlatform/lastInitUrl/
//     lastInitKey，原模块级 let _started/_currentPlatform/_lastInitUrl/_lastInitKey 收拢）
//   - video-detect.js：视频检测与换集监听（waitForVideo/waitForVideoReady/
//     observeVideoChange：history hook + document 级 loadstart 双保险、
//     triggerReloadGlobal 重载触发器及其本地 hook 状态）
//   - controller.js：启动主流程（startVideoController/reviveSidebarIfPossible、
//     getSettings/isSupportedPage/removeExistingSidebar、PLATFORM、_requestId 竞态保护、
//     storage.onChanged 监听注册）
// 跨模块共享状态铁律：vcState 唯一实例在 state.js，controller.js 与 video-detect.js
//   经 import 同源引用，绝不复制两份。
// 本门面仅 re-export 全部原导出符号（符号名不变），所有引用方
//   （bilibili.js/youtube.js/generic.js 动态 import、web-sidebar-impl.js 静态 import）零改动。
export { startVideoController, reviveSidebarIfPossible } from './vc/controller.js';
