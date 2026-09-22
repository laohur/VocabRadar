// === 第361次（诊断）建：B站侧栏注入时机分档开关；第362次转正为默认档3；第364次浮窗撤除并入诊断中心 ===
// 背景：用户缺陷「开启扩展，若不抑制视频侧栏，bilibili 评论区消失」，多次盲修失败。
// 用户指令：按页面加载时间线划分注入时机档位，逐档实测评论区是否消失，锁定失败步骤。
//
// 实测结论（用户六档回传，第362次实锤根因）：
//   只有档0（立即注入）评论区消失；档1/2/3/4/5 全部正常。
//   根因 = 评论区挂载前把侧栏插入右列文档流，打断 B站 Vue 初始 hydration（评论区挂壳不填）。
//
// 档位定义（storage 键 vsInjectTiming，默认 3=第362次修复值）：
//   0 = 立即注入右列（原线上行为，实锤致评论区消失，仅留作对照档）
//   1 = 延迟 2 秒注入右列
//   2 = 延迟 5 秒注入右列
//   3 = 评论区挂载后再注入右列（waitForBiliCommentsThen，30 秒超时兜底照常注入）
//       【默认】第365次：仅对 bilibili 生效——非 B站域立即注入（YouTube 页永远没有
//       bili-comments，旧实现必等 30s 超时，用户实测"YouTube 视频侧栏很久之后才有"）
//   4 = 浮动注入（挂 body 顶层 fixed，不进右列文档流——隔离「插入位置」变量）
//   5 = 不注入（基线，等同抑制侧栏对照）
//
// 第364次（用户："诊断窗口…拆分独立，都从一个诊断路由窗口启动"）：
//   原右下角档位浮窗（startTimingSwitcher，host=vr-inject-timing-host）与 main-text 诊断窗
//   「同键双开」（Ctrl+Shift+V 两窗同显隐）——浮窗 UI 撤除，六档按钮并入诊断中心路由窗
//   「注入时机」标签（src/content/diag-window.js）。本文件保留档位单一属主：
//   TIMING_LABELS（六档文案）/ getInjectTiming（同步缓存，注入调度用）/
//   readInjectTiming（storage 实读 Promise，诊断窗渲染用）/ setInjectTiming（写档+刷新生效）。

// 档位值预取：模块求值即读 storage，注入发生在页面加载数百 ms 后，通常已就绪；
// 未就绪时 getInjectTiming() 返回默认 3（第362次修复值）。
let _timing = 3;
try {
  chrome.storage.local.get({ vsInjectTiming: 3 }, (r) => { _timing = r.vsInjectTiming | 0; });
} catch (e) { /* 非扩展环境忽略 */ }

// 六档文案（诊断中心「注入时机」标签渲染用）：[档位值, 按钮文案, title 说明]
export const TIMING_LABELS = [
  ['0', '0 立即注入', '立即注入右列——原默认行为，实锤致评论区消失，仅作对照'],
  ['1', '1 +2秒', '延迟 2 秒注入右列'],
  ['2', '2 +5秒', '延迟 5 秒注入右列'],
  ['3', '3 评论区后（默认）', '等评论区挂载后再注入右列（30s 超时兜底）——修复默认档；第365次：仅 B站生效，其他站立即注入'],
  ['4', '4 浮动', '浮动注入：挂 body 顶层，不进右列文档流'],
  ['5', '5 不注入', '基线：完全不注入侧栏（等同抑制侧栏对照）']
];

/** 读当前注入时机档位（0-5，见文件头注释）；模块预取缓存（切档必刷新，不会失效） */
export function getInjectTiming() {
  return _timing;
}

/** storage 实读当前档位（诊断窗打开时核对真实存值，不依赖预取时点），顺手校准缓存 */
export function readInjectTiming() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ vsInjectTiming: 3 }, (r) => {
        _timing = r.vsInjectTiming | 0;
        resolve(_timing);
      });
    } catch (e) { resolve(_timing); }
  });
}

/** 写档位（诊断中心档位按钮调用）并刷新页面生效 */
export function setInjectTiming(val) {
  try {
    chrome.storage.local.set({ vsInjectTiming: val | 0 }, () => location.reload());
  } catch (e) { /* 非扩展环境忽略 */ }
}

/**
 * 档3：等 B 站评论区挂载后执行 fn。
 * 评论区为嵌套 shadow DOM 的 web component（bili-comments），宿主容器 #commentapp；
 * 诊断工具不追求优雅，500ms 轮询足够；30 秒超时兜底执行 fn（关评论区视频兜底，避免永不注入卡死）。
 */
export function waitForBiliCommentsThen(fn) {
  // 第365次：站点守卫——「等评论区」只对 B站有意义（修 Vue hydration 打断评论区）。
  // 非 B站域（YouTube 等）立即执行 fn：YouTube 页永远没有 bili-comments，旧实现
  // 必等 30s 超时兜底才注入，侧栏白等 30 秒（用户实测"YouTube 视频侧栏很久之后才有"）。
  // 参照 videoseek（ytIndex.a719a07b.js）：YouTube 不等站点信号——注入本体
  // injectIntoPage 已自带 MutationObserver 等右列容器 + 重注入守卫能力，立即注入即秒挂。
  if (String(location.hostname || '').indexOf('bilibili.com') === -1) {
    try {
      console.log('[VocabRadar][inject-timing] 档3 非B站域（' + location.hostname
        + '）跳过评论区等待，立即注入 @' + Math.round(performance.now()) + 'ms');
    } catch (e) { /* ignore */ }
    fn();
    return;
  }
  // 第362次收紧：去掉 #commentapp——该容器可能静态存在于初始 HTML，命中过早使档3退化成
  // 「只延迟~500ms」的弱信号；只认 bili-comments / .bili-comments（web component 本体，一定动态挂载）。
  const SEL = 'bili-comments, .bili-comments';
  const startedAt = Date.now();
  const timer = setInterval(() => {
    let mounted = false;
    try { mounted = !!document.querySelector(SEL); } catch (e) { mounted = false; }
    if (mounted || Date.now() - startedAt > 30000) {
      clearInterval(timer);
      try {
        console.log('[VocabRadar][inject-timing] 档3 评论区'
          + (mounted ? '已挂载' : '30s超时兜底') + '，执行注入 @'
          + Math.round((Date.now() - startedAt) / 100) / 10 + 's');
      } catch (e) { /* ignore */ }
      fn();
    }
  }, 500);
}
