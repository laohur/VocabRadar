// =============================================================================
// vs/dom-utils.js —— 通用工具函数子模块（纯函数为主）
// -----------------------------------------------------------------------------
// 职责：视频缓存 key 生成、剪贴板复制、按钮闪烁、时间格式化、随机短义项选取、
//       HTML/正则/CSS 选择器转义。
// 关系：依赖 ./logger.js（copyToClipboard 内 log）。被门面与
//       ./comment-fill.js、./playback-gate.js、./asr-stage.js、./ocr.js 引用。
// =============================================================================

import { log } from './logger.js';

// 生成视频缓存 key（区分不同视频/集数）
// 仅用 hostname+pathname 会有两类问题：
//   1. B站番剧同一 ss ID 下多集共享同一 pathname（如 /bangumi/play/ss107779），
//      一集的 ASR 缓存被其他集复用——"一份字幕应用于所有视频"。
//   2. YouTube 所有视频 pathname 都是 /watch，视频 ID 在 ?v= 参数中，
//      不含 v 参数会导致所有 YouTube 视频共享同一缓存 key。
// 因此：保留区分视频/集数的查询参数（v / ep_id / p / cid），其余临时参数丢弃。
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

// location → {platform, videoId}（P4 云端消费查索引用，2026-10-17 自 auto-share.js 上移）：
// bilibili 取 BV 号/ep 号，youtube 取 v 参数，其余用 makeVideoKey（页面哈希键）。
// **分P 口径（20261017 用户令"视频带分P，字幕也带，链接也带，口径一致"）**：
// p≥2 时并入 videoId（`BV..?p=N`）——云端索引、库条目、出链均区分分P；p=1 或缺省
// 归一为不带（P1 即默认页，同内容同 id），与侧栏缓存键（makeVideoKey 一直含 p）对齐
export function parsePlatformVideo() {
  try {
    const u = new URL(location.href);
    if (/(^|\.)bilibili\.com$/.test(u.hostname)) {
      const p = Number(u.searchParams.get('p')) || 0;
      const suffix = p > 1 ? `?p=${p}` : '';
      const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
      if (m) return { platform: 'bilibili', videoId: m[1] + suffix };
      const ep = u.searchParams.get('ep_id');
      if (ep) return { platform: 'bilibili', videoId: 'ep' + ep + suffix };
    }
    if (/(^|\.)youtube\.com$/.test(u.hostname) || u.hostname === 'youtu.be') {
      const v = u.searchParams.get('v') || u.pathname.slice(1);
      if (v) return { platform: 'youtube', videoId: v };
    }
  } catch (e) { /* 解析失败走兜底 */ }
  return { platform: 'web', videoId: makeVideoKey() };
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

// === 时间格式化 m:ss（小时级面板统一 h:mm:ss）===
// 超小时视频改用 h:mm:ss（用户裁定）。
//   面板级开关 _hourly：视频时长≥1h 时整面板统一 h:mm:ss（与主流播放器一致，
//   避免 m:ss/h:mm:ss 混排导致 grid 时间列宽窄不齐）；_hourly=false 时逐条
//   判定（start≥1h 的条目仍显示小时位，兜底 duration 未知场景）。
let _hourly = false;

/** 面板级小时格式开关（renderSubtitlePanel/appendASRSubtitle 依视频时长设置） */
export function setHourlyFormat(v) { _hourly = !!v; }

export function formatTime(sec) {
  if (sec == null || isNaN(sec)) return '0:00';
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const useH = _hourly || h > 0;
  const mm = useH ? String(m).padStart(2, '0') : String(m);
  return (useH ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`;
}

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
