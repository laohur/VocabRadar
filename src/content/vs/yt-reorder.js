// =============================================================================
// vs/yt-reorder.js —— 侧栏置顶守卫子模块（YouTube #secondary / B站右列通用）
// -----------------------------------------------------------------------------
// 职责：保持视频侧栏处于所在列容器的首位（顶部对齐视频顶部），含防抖动
//       争抢判定（30 秒窗口移动超 5 次即暂停移回，2 分钟后经定时器重试）。
// 来源：拆分自 src/content/video-sidebar.js（2026-08-28 拆分第二刀，纯机械搬移）。
// 第一百七十二次：泛化为通用守卫——新增 resolveContainer 可选参数，B 站右列复用
//       同一套置顶逻辑（用户反馈"哔哩哔哩中都挪到弹幕列表和广告之下了"，
//       此前 B 站只有"被移除才重注入"的守卫，DOM 顺序被改动时无人纠正）。
// 第一百七十五次（用户裁定"不可兜底首位。右列首位你是妄想。几天之前一直稳定正常。"）：
//       新增**锚点模式**——第 4 参数 resolveAnchor 返回参照元素（B 站为弹幕列表
//       danmaku-box）时，守卫只保证"侧栏排在锚点之前"，不再把侧栏抬到容器首位。
//       B 站目标位置是"视频之右、作者之下、弹幕列表之上"，抬到首位会盖掉作者块。
//       YouTube 未传锚点解析器，仍走原置顶逻辑（#secondary 首位即视频顶）。
// 关系：依赖 ./logger.js（log）；_reorder* 四个模块级状态与本守卫函数内聚于
//       本模块。被 vs/sidebar-layout.js 的注入流程调用（YT 与 B 站各一处）。
// =============================================================================

import { log } from './logger.js';

// === 保持视频提示在所在列首位（YouTube 侧即 videoseek 之上） ===
// 反思（2026-07-03）：旧版用 `idx > 1` 即"被挤到第3位及以后才移回"，
// 主动让位给 videoseek，结果我方被压在 videoseek 之下，用户明确要求我方在上。
// 新策略：`idx > 0` 即"非首位就移回 firstChild"，保证我方始终在 videoseek 之上。
// 防与 videoseek 死循环：30 秒内移动超 5 次即判定对方在主动争抢，停止再移
// （用户可禁用 videoseek 或手动调整），避免 DOM 抖动。
let _reorderObs = null;
let _reorderTimer = null;
let _reorderMoveCount = 0;       // 滑动窗口内移动次数
let _reorderWindowStart = 0;     // 当前窗口起点
let _noAnchorLogged = false;     // 第一百七十六次：「无锚点」诊断只打一次，避免刷屏

/** YouTube 默认容器解析（容器可能被 YouTube 重建，故每次重查） */
function resolveYTContainer() {
  return document.querySelector('#secondary.ytd-watch-flexy')
    || document.querySelector('#secondary-inner')
    || document.querySelector('#secondary');
}

/**
 * 启动侧栏顺序守卫。
 * @param {HTMLElement} root 侧栏根节点
 * @param {HTMLElement} container 初始容器（用于挂 MutationObserver）
 * @param {Function} [resolveContainer] 容器重解析函数（默认 YouTube #secondary 系）
 * @param {Function} [resolveAnchor] 锚点重解析函数；返回元素时启用**锚点模式**
 *        （只保证侧栏在该元素之前），不传则为置顶模式（保证侧栏在容器首位）
 * @param {Function} [dump] 诊断回调 dump(tag)；每次移位/异常落位时调用一次
 */
export function startYTReorderGuard(root, container, resolveContainer, resolveAnchor, dump) {
  if (_reorderObs) _reorderObs.disconnect();
  if (_reorderTimer) clearInterval(_reorderTimer);
  const resolve = typeof resolveContainer === 'function' ? resolveContainer : resolveYTContainer;
  const anchorOf = typeof resolveAnchor === 'function' ? resolveAnchor : null;
  const diag = typeof dump === 'function' ? dump : () => {};
  let reordering = false;
  // 争抢熔断：命中即记一次移动，窗口内超阈值判定他方脚本在抢，暂停移动避免抖动。
  // 第一百七十六次（用户第三次反馈"落到弹幕列表和广告之下"）：旧阈值"30 秒 5 次"
  //   在 B 站 Vue 频繁重渲染右列时极易被打满，一旦熔断就彻底停手，侧栏被永久
  //   压在广告之下——这是本缺陷的放行口之一。放宽到"60 秒 20 次"，并在熔断时
  //   打印诊断，便于区分"真争抢"与"Vue 正常重渲染"。
  const overheated = () => {
    const now = Date.now();
    if (now - _reorderWindowStart > 60000) {
      _reorderWindowStart = now;
      _reorderMoveCount = 0;
    }
    _reorderMoveCount++;
    if (_reorderMoveCount > 20) {
      log('顺序守卫: 60秒内移动 ' + _reorderMoveCount + ' 次，判定他方脚本在争抢，暂停移回（避免抖动）');
      diag('熔断暂停时');
      return true;
    }
    return false;
  };
  const check = () => {
    if (reordering || !root || !document.contains(root)) return;
    const sec = resolve();
    if (!sec || !sec.contains(root)) return;
    // 侧栏可能被包在容器的中间层里；取其直接父节点做顺序判定，
    // 避免 indexOf(root) === -1 时守卫静默失效。
    const holder = root.parentElement;
    if (!holder) return;
    // === 锚点模式（B 站）：只纠正"排到了锚点之后"，绝不抬到首位 ===
    if (anchorOf) {
      const anchor = anchorOf();
      // 锚点不存在（B 站换版/未渲染）时不动——宁可不管，也不擅自挪位置。
      // 第一百七十六次：此处曾是静默失效口，现补一次诊断输出（限次，避免刷屏）。
      if (!anchor || anchor === root || anchor.parentElement !== holder) {
        if (!_noAnchorLogged) { _noAnchorLogged = true; diag('顺序守卫: 无可用锚点，暂不移动'); }
        return;
      }
      _noAnchorLogged = false;
      // compareDocumentPosition：FOLLOWING 表示 anchor 在 root 之后，即顺序正确
      const ok = !!(root.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (ok) return;
      if (overheated()) return;
      reordering = true;
      try {
        holder.insertBefore(root, anchor);
        log('顺序守卫: 侧栏落到锚点之后 → 移回锚点之前（作者之下、弹幕列表之上）');
        diag('顺序守卫移位后');
      } catch (e) { /* ignore */ }
      setTimeout(() => { reordering = false; }, 500);
      return;
    }
    // === 置顶模式（YouTube #secondary）===
    const children = Array.from(holder.children);
    const idx = children.indexOf(root);
    if (idx > 0) {
      if (overheated()) return;
      reordering = true;
      try {
        holder.insertBefore(root, holder.firstElementChild);
        log('置顶守卫: 当前第' + (idx + 1) + '位，移回首位');
      } catch (e) { /* ignore */ }
      setTimeout(() => { reordering = false; }, 500);
    }
  };
  // 第一百七十六次：补 subtree——B 站右列的弹幕区/广告卡是在**孙层**延迟渲染的，
  //   只监听 childList 会漏检这类变更，导致侧栏被挤下去后长时间无人纠正
  //   （只能等 2 秒定时器兜底，期间用户已经看到错位）。
  // 但 subtree 会被弹幕列表的滚动刷新高频触发，故用 200ms 合并节流包一层，
  //   避免每条弹幕都跑一次 querySelector（check 自身幂等，合并不影响正确性）。
  let coalesce = 0;
  _reorderObs = new MutationObserver(() => {
    if (coalesce) return;
    coalesce = setTimeout(() => { coalesce = 0; check(); }, 200);
  });
  _reorderObs.observe(container, { childList: true, subtree: true });
  // 定时备份：MutationObserver 可能漏检（如容器被整体替换）
  // 且定时器负责在"暂停争抢"后 2 分钟重试
  _reorderTimer = setInterval(check, 2000);
}
