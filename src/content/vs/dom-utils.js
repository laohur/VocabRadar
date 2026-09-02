// =============================================================================
// vs/dom-utils.js —— 通用工具函数子模块（纯函数为主）
// -----------------------------------------------------------------------------
// 职责：视频缓存 key 生成、剪贴板复制、按钮闪烁、时间格式化、随机短义项选取、
//       HTML/正则/CSS 选择器转义。
// 来源：拆分自 src/content/video-sidebar.js（2026-08-28 拆分第二刀，纯机械搬移）。
// 关系：依赖 ./logger.js（copyToClipboard 内 log）。被门面与
//       ./comment-fill.js、./playback-gate.js、./asr-stage.js、./record-workflow.js、
//       ./ocr.js 引用。
// =============================================================================

import { log } from './logger.js';

// 生成视频缓存 key（区分不同视频/集数）
// 反思（2026-07-05）：旧版仅用 hostname+pathname，导致两类问题：
//   1. B站番剧同一 ss ID 下多集共享同一 pathname（如 /bangumi/play/ss107779），
//      一集的 ASR 缓存被其他集复用——"一份字幕应用于所有视频"。
//   2. YouTube 所有视频 pathname 都是 /watch，视频 ID 在 ?v= 参数中，
//      旧版 IDENT_PARAMS 不含 v，导致所有 YouTube 视频共享同一缓存 key。
// 修正：保留区分视频/集数的查询参数（v / ep_id / p / cid），其余临时参数丢弃。
export function makeVideoKey() {
  try {
    const u = new URL(location.href);
    // 需保留的视频标识查询参数（区分视频/集数/分P）
    // v: YouTube 视频 ID；ep_id: B站番剧集数；p: B站分P；cid: B站视频 CID
    const IDENT_PARAMS = ['v', 'ep_id', 'p', 'cid'];
    const parts = [u.hostname + u.pathname];
    for (const key of IDENT_PARAMS) {
      const val = u.searchParams.get(key);
      if (val) parts.push(`${key}=${val}`);
    }
    return parts.join('?');
  } catch (e) {
    return location.href;
  }
}

// === 复制到剪切板（带 fallback） ===
export async function copyToClipboard(text) {
  // 1. 优先 navigator.clipboard
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    log('clipboard API 失败，回退 execCommand:', e.message);
  }
  // 2. 回退：临时 textarea + execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    log('execCommand 失败:', e.message);
    return false;
  }
}

// === 按钮闪烁反馈 ===
export function flashButton(btn) {
  btn.style.background = '#2e6b43';  // MD3 primary 马卡龙深绿
  setTimeout(() => { btn.style.background = ''; }, 300);
}

// === 时间格式化 mm:ss ===
export function formatTime(sec) {
  // mm:ss 格式（用户要求：不要加小时）
  if (sec == null || isNaN(sec)) return '0:00';
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 第二百二十五次：删除转发包装 pickRandomShortTrans（《命名清查》裁定：语义早已收敛到
//   lib/dict-clean.js#pickCleanShortTrans，调用方 vs/subtitle-renderer.js 已改为直调）。

// === 工具函数 ===
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// === CSS 选择器转义（用于 data-word 属性选择器） ===
export function cssEscape(s) {
  if (typeof s !== 'string') return '';
  // 属性选择器 [data-word="..."] 内只需转义双引号和反斜杠
  return s.replace(/["\\]/g, '\\$&');
}
