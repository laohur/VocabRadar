// =============================================================================
// vs/loading.js —— 加载态（骨架屏/超时兜底/无字幕提示）子模块
// -----------------------------------------------------------------------------
// 职责：showLoading()（骨架屏 + 15s 超时兜底）、clearLoading()（去 loading 态并清
//       超时计时器）、showNoSubtitle(msg)（无字幕/超时/错误提示，保留 tabs 可切换）、
//       自动加载链路活动标记 _autoChainActive（期间超时兜底不抢跳）。
// 来源：拆分自 src/content/video-sidebar.js（2026-09-27 拆分第四刀，纯机械搬移）。
// 关系：依赖 ./logger.js（log）、./dom-utils.js（escapeHtml）、../../lib/i18n.js（t）；
//       因需读取门面 _root/_subtitles，经 getRoot/getSubtitlesRef 对门面构成受控
//       循环 import——本模块顶层仅自身状态与函数声明，getRoot()/getSubtitlesRef()
//       调用全部发生在函数体内（运行时门面已初始化完毕，安全）。
//       状态内聚：_loadingTimeout（含 clearLoadingTimeout()，门面 destroySidebar 调用）、
//       _autoChainActive（tracks 子模块经 setAutoChainActive() 接驳写入）。
//       等价改写：showLoading 超时回调内原直读活模块变量 `_root`，改走 getRoot()
//       （同一时点语义等价——回调执行时按当时引用判断）。
//       门面经 export 接驳 clearLoading/showNoSubtitle（subtitle-renderer、
//       vc/controller、guide-common 引用方符号不变）。
// =============================================================================

import { log } from './logger.js';
import { escapeHtml } from './dom-utils.js';
import { t } from '../../lib/i18n.js';
import { getRoot, getSubtitlesRef } from '../video-sidebar.js';

// === 加载提示（字幕到达前显示） ===
// 加载态：仅显示 header + 骨架动画，隐藏 tabs/toolbar/footer
// 仿 videoseek 的 Skeleton active 样式（渐变呼吸动画条）
// 加载超时计时器（反思 2026-07-07：用户反馈"有的视频你一直转转转还不自知"）
// showLoading 后 15 秒未收到字幕/错误，自动 showNoSubtitle 兜底，避免 loading 永转。
let _loadingTimeout = null;
const LOADING_TIMEOUT_MS = 15000;
// 第一百四十五次（用户裁定"抓取字幕都是后台操作，不要干扰正常操作"）：
// 自动加载链路活动标记——期间 15s 超时兜底不再抢跳超时提示（链路自有终态），
// 且 onTrackSelect 不重复刷骨架屏。
let _autoChainActive = false;

/** 自动加载链路活动标记写入（tracks 子模块：链路各轮次切换与结束时置位） */
export function setAutoChainActive(v) { _autoChainActive = !!v; }

export function showLoading(msg) {
  const _root = getRoot();
  if (!_root) return;
  const panel = _root.querySelector('#beaver-subtitle-panel');
  // 第一百四十五次：后台化——面板已在 loading 态或已有真实字幕时不重绘不闪动
  if (panel && panel.querySelector('.beaver-loading')) return;
  const _subtitles = getSubtitlesRef();
  if (panel && _subtitles && _subtitles.length > 0) return;
  _root.classList.add('loading');
  if (!panel) return;
  const txt = msg || t('loading');
  // 骨架屏：模拟字幕列表（时间条 + 文本行），仿 videoseek 的 Skeleton
  panel.innerHTML = `<div class="beaver-loading skeleton" data-loading-key="loading">
    <div class="beaver-skeleton-row"><div class="beaver-skeleton-bar time"></div><div class="beaver-skeleton-bar long"></div></div>
    <div class="beaver-skeleton-row"><div class="beaver-skeleton-bar time"></div><div class="beaver-skeleton-bar medium"></div></div>
    <div class="beaver-skeleton-row"><div class="beaver-skeleton-bar time"></div><div class="beaver-skeleton-bar full"></div></div>
    <div class="beaver-skeleton-row"><div class="beaver-skeleton-bar time"></div><div class="beaver-skeleton-bar long"></div></div>
    <div class="beaver-skeleton-row"><div class="beaver-skeleton-bar time"></div><div class="beaver-skeleton-bar short"></div></div>
    <div style="text-align:center;color:#9499a0;font-size:13px;margin-top:8px"><span class="beaver-loading-spin"></span> ${escapeHtml(txt)}</div>
  </div>`;
  // 反思（2026-07-07）：超时兜底。字幕获取卡死（网络不响应/API 异常未抛错）时，
  // showLoading 不会被 clearLoading 清除，loading 永转。15秒后自动 showNoSubtitle。
  if (_loadingTimeout) clearTimeout(_loadingTimeout);
  _loadingTimeout = setTimeout(() => {
    _loadingTimeout = null;
    if (_autoChainActive) {
      // 自动链路进行中：不抢跳超时提示（链路 22s 自有终态），仅解除 loading 态防永转样式
      const rootNow = getRoot();
      if (rootNow) rootNow.classList.remove('loading');
      return;
    }
    const rootNow = getRoot();
    if (rootNow && rootNow.classList.contains('loading')) {
      log('loading 超时 ' + (LOADING_TIMEOUT_MS / 1000) + 's，自动显示超时提示');
      showNoSubtitle('subtitleTimeoutTip');
    }
  }, LOADING_TIMEOUT_MS);
}

// 加载完成：去掉 loading class，恢复 tabs/toolbar/footer 显示
// （2026-08-28 拆分第三刀：vs/subtitle-renderer 的 renderSubtitlePanel 调用，加 export 接驳）
export function clearLoading() {
  const _root = getRoot();
  if (!_root) return;
  _root.classList.remove('loading');
  // 反思（2026-07-07）：清除超时计时器，避免字幕正常到达后超时提示仍触发
  if (_loadingTimeout) {
    clearTimeout(_loadingTimeout);
    _loadingTimeout = null;
  }
}

/** 清 loading 超时计时器（门面 destroySidebar 清理序列调用；无计时器时为空操作） */
export function clearLoadingTimeout() {
  if (_loadingTimeout) {
    clearTimeout(_loadingTimeout);
    _loadingTimeout = null;
  }
}

// === 显示"无字幕"提示 ===
// 反思（2026-07-07）：用户要求"有啥显示啥"。
//   旧版清空 _subtitles/_subEntries/_allAnnotations，导致 tabs 无法切换查看
//   已收集的生词，且字幕 panel 内容全无。修正：只更新字幕 panel 显示提示，
//   保留旧数据，tabs（字幕/生词表/练习）仍可点击，生词表保留已收集的生词。
export function showNoSubtitle(msg) {
  const _root = getRoot();
  if (!_root) return;
  // 不清空 _subtitles/_subEntries/_allAnnotations：保留旧数据供 tabs 切换
  clearLoading();
  const panel = _root.querySelector('#beaver-subtitle-panel');
  if (panel) {
    // msg 为已知 i18n key 时按 key 渲染（标记 data-i18n，切换 UI 语言时 applyI18n 自动更新）；
    // msg 为普通文本（动态错误信息）时直接显示不跟随切换；不传 msg 默认 noSubtitleTip。
    const knownKeys = ['noSubtitleTip', 'subtitleTimeoutTip'];
    const key = (!msg) ? 'noSubtitleTip' : (knownKeys.includes(msg) ? msg : null);
    const tip = key ? t(key) : msg;
    const i18nAttr = key ? `data-i18n="${key}"` : '';
    panel.innerHTML = `<div class="beaver-loading" style="padding:40px 16px">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" style="opacity:.35"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6zm0 4h8v2H6zm10 0h2v2h-2zm-6-4h8v2h-8z" fill="currentColor"/></svg>
      <span ${i18nAttr} style="font-size:1em">${escapeHtml(tip)}</span>
    </div>`;
  }
  log('显示无字幕提示（保留 tabs 可切换）');
  // 第一百四十七次（用户裁定"有时候还会自动折叠"=不可接受）：撤销无字幕自动折叠。
  // 启动折叠/首批内容展开一次的既定策略不变；此后任何时刻都尊重用户当前展开态。
}
