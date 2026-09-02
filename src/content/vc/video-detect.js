// ============================================================
// 文件职责：视频元素检测与换集监听（src/content/vc/video-detect.js）
// 来源：拆分自 src/content/video-controller.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// 内容：waitForVideo/waitForVideoReady（video 元素等待）、observeVideoChange
//   （SPA 换集检测：history.pushState/replaceState hook + document 级 loadstart
//   capture 事件双保险）、triggerReloadGlobal（模块级重新初始化触发器）。
// 本地状态（仅本模块使用，不跨模块共享）：_historyHooked/_loadstartHooked/
//   _reloadTimer/_lastVideoSrc；跨模块状态（started/currentPlatform/lastInitUrl/
//   lastInitKey）统一存于 ./state.js 的 vcState。
// 受控循环 import 说明：本模块 import ./controller.js 的 startVideoController，
//   controller.js import 本模块的 waitForVideo/waitForVideoReady/observeVideoChange。
//   两端均为函数声明（提升后可用），且顶层均仅初始化自身状态、不在模块加载时
//   调用对方导出函数，运行时调用安全，无 TDZ 风险（项目先例：vs/* 子模块与
//   video-sidebar.js 门面同为受控循环 import）。
// ============================================================

import { stopOverlay } from '../subtitle-overlay.js';
import { currentVideoKey, isASRActive } from '../video-sidebar.js';
import { vcState } from './state.js';
import { startVideoController } from './controller.js';

// 反思（2026-07-07）：用户反馈"换了视频，字幕窗口纹丝不动"。
// 根因：observeVideoChange 每次都重复包装 history.pushState/replaceState，
//   导致 hook 嵌套、onUrlChange 多次触发；video src observer 绑定旧 video 元素，
//   B站换集替换 video 元素时旧 observer 失效；1.5s 延迟过长用户感觉无响应。
// 修正：history hook 幂等化（只注册一次）；延迟从 1500ms 降到 500ms。
let _historyHooked = false;     // history hook 是否已注册（幂等标志）
let _loadstartHooked = false;   // loadstart 事件是否已注册（与 history hook 双保险）
let _reloadTimer = null;        // 重新初始化的延迟定时器
let _lastVideoSrc = '';         // 上次 video src（loadstart 过滤：画质切换/广告 src 不变）

/** 等待 video 元素出现 */
export function waitForVideo(timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const v = document.querySelector('video');
      if (v) return resolve(v);
      if (Date.now() - start > timeout) return reject(new Error('video 元素未找到'));
      setTimeout(check, 500);
    };
    check();
  });
}

/** 等待视频有 duration（真正加载） */
export function waitForVideoReady(video, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (video.duration && !isNaN(video.duration)) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('视频加载超时'));
      setTimeout(check, 500);
    };
    check();
  });
}

/** 监听 SPA 切换视频（URL 变化 + video src 变化双保险）
 *
 * 反思修复（2026-07-07）：用户反馈"换了视频，字幕窗口纹丝不动"。
 *   旧版（2026-07-01）每次 startVideoController 都调用此函数，重复包装
 *   history.pushState/replaceState 导致 hook 嵌套、onUrlChange 多次触发；
 *   video src observer 绑定传入的 video 元素，B站换集替换 video 元素时旧 observer 失效；
 *   1.5s 延迟过长用户感觉无响应。
 *   修正：1) history hook 幂等化（_historyHooked 模块级 flag，只注册一次）；
 *         2) video 监听改用 body MutationObserver，跟踪当前 video 元素（被替换也能感知）；
 *         3) 延迟 1500ms -> 500ms，并立即 showLoading（startSidebar 已存在分支已处理）。
 *
 * 反思修复（2026-07-01，保留）：
 *   旧实现只监听 video 的 src 属性变化，但 B站换集时常替换 video 元素或走 source
 *   子元素，src 属性不一定变，导致"下一集字幕没动"。
 *   换集时 started=false 后重调 startVideoController：waitForVideo 拿新 video ->
 *   startSidebar(已存在分支只更新 video) -> showLoading -> getBilibiliSubtitles(新集)
 *   -> updateSubtitles(填充新字幕, rerender 内重置 _activeSubIdx)。
 */
export function observeVideoChange() {
  // history hook 幂等化：只注册一次，避免重复包装导致 onUrlChange 多次触发
  // 反思（2026-07-07 三次修复）：用户反馈"不停地刷新，重复打印日志"。
  //   根因：旧版还有 startVideoElementObserver 用 body MutationObserver 监听 childList subtree，
  //   B站页面频繁插入节点（弹幕/评论/推荐/播放器内部元素）每秒触发多次回调，
  //   防抖 500ms 无效（DOM 变化持续），侧栏自身插入也触发 observer 形成循环。
  //   修正：移除 startVideoElementObserver，只靠 history hook 检测换集。
  //   安全性：B站换集（分P）改 URL（?p=2），点击推荐改 URL（/video/BVxxx），
  //   YouTube 换视频改 URL（?v=xxx），都通过 history API，hook 能捕获。
  // 反思（2026-07-09 五次修复）：用户反馈「依旧不能识别视频切换」。
  //   根因：仅靠 history hook 不够可靠--某些站点换集可能不通过 history API，
  //   或 SPA 框架包装方式特殊导致 hook 未触发。
  //   修正：增加 document 级 'loadstart' 事件监听（capture 阶段），video 元素加载新源
  //   或被替换时触发。与 history hook 双保险，任一检测到换集都触发重载。
  //   loadstart 是 video 元素加载新 src 时触发的事件，capture 阶段在冒泡被拦截前捕获，
  //   用事件委托挂在 document 上（无需绑定具体 video 元素，元素替换也能感知）。
  //   防抖 500ms：loadstart 与 history hook 可能同时触发，防抖合并为一次重载。
  if (!_historyHooked) {
    _historyHooked = true;
    let lastUrl = location.href;
    let _urlChangeTimer = null;
    const onUrlChange = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      // URL 变化防抖 500ms，连续 replaceState 只触发一次重载
      if (_urlChangeTimer) clearTimeout(_urlChangeTimer);
      _urlChangeTimer = setTimeout(() => triggerReloadGlobal('URL 变化'), 500);
    };
    ['pushState', 'replaceState'].forEach((m) => {
      const orig = history[m];
      history[m] = function (...args) {
        orig.apply(this, args);
        onUrlChange();
      };
    });
    window.addEventListener('popstate', onUrlChange);
    console.log('[VocabRadar][video-detect] history hook 已注册（幂等，仅 URL 变化触发重载）');
  }

  // loadstart 事件监听（幂等）：video 元素加载新源时触发，与 history hook 双保险
  //   反思（2026-07-09 五次修复）：history hook 可能不触发（SPA 框架包装方式特殊），
  //   loadstart 是 video 元素原生事件，src 变化或元素替换时必然触发。
  //   capture 阶段：在冒泡被站点 stopPropagation 拦截前捕获。
  //   事件委托：挂在 document 上，无需绑定具体 video 元素（元素替换也能感知）。
  if (!_loadstartHooked) {
    _loadstartHooked = true;
    let _loadstartTimer = null;
    document.addEventListener('loadstart', (e) => {
      // 仅响应 video 元素的 loadstart 事件
      if (!e.target || e.target.tagName !== 'VIDEO') return;
      // 防抖 500ms：loadstart 可能与 history hook 同时触发，合并为一次重载
      if (_loadstartTimer) clearTimeout(_loadstartTimer);
      _loadstartTimer = setTimeout(() => triggerReloadGlobal('video loadstart', true), 500);
    }, true);  // capture 阶段
    console.log('[VocabRadar][video-detect] loadstart 监听已注册（capture 阶段，与 history hook 双保险）');
  }
}

/**
 * 模块级重新初始化触发器（供 history hook 和 video observer 共用）。
 * 延迟从 1500ms 降到 500ms，让用户更快感知到窗口更新。
 * 反思（2026-07-07 二次修复）：去掉 if(!started) return 守卫。
 *   从非视频页 SPA 导航到视频页时，history hook 触发此函数，但 started 为 false，
 *   导致直接 return 不启动侧栏。修正：无论 started 状态都执行清理和重启。
 * @param {string} reason
 */
function triggerReloadGlobal(reason, skipUrlCheck) {
  // 反思（2026-07-28 #bug4）：合集内换视频（分P/推荐/合集）常通过 AJAX 替换 video src，
  //   URL 不变但视频内容完全不同。旧版 URL guard 对此一律跳过，导致旧字幕/生词残留。
  //   区分两种触发源：
  //   - history hook（URL 变化）：保留 URL guard（防非视频 SPA 导航误触）
  //   - loadstart（video 元素事件）：跳过 URL guard（loadstart 本身就是视频切换信号）
  //   同时保留 loadstart 触发的 URL 检查用于过滤广告/画质切换等场景（URL + src 都不变）。
  if (!skipUrlCheck && location.href === vcState.lastInitUrl) {
    console.log('[VocabRadar][video-detect] URL 未变化, 跳过重载:', reason, location.href);
    return;
  }
  // loadstart 过滤：若 video src 未变（画质切换/广告），跳过重载
  if (skipUrlCheck) {
    const curVideo = document.querySelector('video');
    const curSrc = curVideo ? (curVideo.currentSrc || curVideo.src || '') : '';
    if (curSrc && curSrc === _lastVideoSrc) {
      console.log('[VocabRadar][video-detect] video src 未变, 跳过重载:', reason, curSrc.slice(-60));
      return;
    }
    _lastVideoSrc = curSrc;
  }
  // 第一百零二次：ASR 运行中且视频稳定标识（URL 参数组合）未变 -> 判定伪换集跳过重载。
  // 根因：B站清晰度自动切换会更换视频 src 触发 loadstart，src 与 _lastVideoSrc 不同
  //   绕过了上面的过滤 -> 整个控制器重启 -> 停 ASR + 清面板 + 载原生轨，
  //   即用户反馈的"识别一小会儿就擅自切换到别的字幕轨道"。
  // 真换集（点开新 BV / ?p=N 变化）标识必变，不受影响。
  if (isASRActive()) {
    const k = currentVideoKey();
    if (k && k === vcState.lastInitKey) {
      console.log('[VocabRadar][video-detect] ASR 运行中且视频标识未变, 跳过重载(疑似画质切换):', reason);
      return;
    }
  }
  vcState.started = false;
  // SPA 换集时停止旧 overlay，清理旧 video 引用和监听器
  stopOverlay();
  console.log(`[VocabRadar][video-detect] 检测到 ${reason}, 重新初始化:`, location.href);
  if (_reloadTimer) clearTimeout(_reloadTimer);
  _reloadTimer = setTimeout(() => startVideoController(vcState.currentPlatform), 500);
}
