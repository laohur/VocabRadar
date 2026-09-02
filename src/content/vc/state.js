// ============================================================
// 文件职责：视频控制器跨模块共享状态唯一属主（src/content/vc/state.js）
// 来源：拆分自 src/content/video-controller.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// 跨模块共享状态铁律（绝不复制两份）：原模块级 let _started/_currentPlatform/
//   _lastInitUrl/_lastInitKey 收拢为导出可变对象 vcState（唯一实例），
//   controller.js（启动/复活流程读写）与 video-detect.js（换集检测读写）
//   经 import 同源引用，与原单文件行为一致（项目先例：dictionary/state.js dictState）。
//   原 2026-07-13 #92 反思注释随 lastInitUrl/lastInitKey 状态一并保留于下方。
// 仅本模块使用、不需跨模块共享的换集检测状态（_historyHooked/_loadstartHooked/
//   _reloadTimer/_lastVideoSrc）留在 video-detect.js，不在此处。
// ============================================================

// 反思（2026-07-13 #92）：用户反馈「asr，生词表有内容，过了一会儿再看看，全都没了」。
//   根因：loadstart 事件在视频画质切换、广告插入等非换集场景也会触发，此时 URL 未变化，
//   但 triggerReloadGlobal 仍无条件重载 -> startSidebar 换集分支停止 ASR + 清空 _allAnnotations
//   + 清空生词表 DOM -> startVideoController 重新获取字幕（可能中文字幕无英文生词）-> 生词表空白。
//   修正：新增 lastInitUrl 记录上次 startVideoController 时的 URL，triggerReloadGlobal
//   检测到 URL 未变化时跳过重载（仅记录日志），避免非换集的 loadstart 误触发清空。
// 第一百零二次：lastInitKey 上次启动时视频稳定标识（ASR 运行中伪换集过滤基准）
export const vcState = {
  started: false,          // 原 _started：控制器是否已启动（startVideoController 守卫）
  currentPlatform: null,   // 原 _currentPlatform：当前平台（供 triggerReloadGlobal 用）
  lastInitUrl: '',         // 原 _lastInitUrl：上次 startVideoController 时的 URL（检测 loadstart 误触发）
  lastInitKey: ''          // 原 _lastInitKey：上次启动时视频稳定标识（ASR 运行中伪换集过滤基准）
};
