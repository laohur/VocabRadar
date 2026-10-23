// VocabRadar 引导页 字幕库 模块（2026-10-08 P3：独立标签 panel-subs，仿 account.js）
// 职责（方案 §3.1 生产体系；管理面在网站「我的分享」——扩展保持薄、稳定）：
//   - 列表：本地字幕库（IndexedDB vocabradar-subs，lib/subs-library.js）按时间倒序，
//     行1=链接+视频标题、行2=时间+元信息+按钮（20261022 令）
//   - 打开列表自动从后端导入一次（20261022 令：会话内首个打开触发，仅真有新导入
//     才 toast；后端不可达静默——自动动作不刷屏，手动按钮保留完整汇报）
//   - 视频标题回填：存量条目（后端导入/收割/云端消费）title 普遍为空，对可出链的
//     bilibili/youtube 条目按平台公开接口取标题写回条目（取一次，会话内不重试）
//   - 上传分享：chrome.runtime.sendMessage('vocabradar:auth-get-token') 取有效 token
//     （续签在 SW，auth.js 单一属主）→ POST <站点>/api/subs/publish → 回填 shared
//   - 删除本地：仅删本地记录，云端一概不动（20261008 用户裁定）；confirm 防误删
//   - 未连接账号时上传按钮提示先到「账号」标签连接
import { $, m, log } from './shared.js';
import { S, toast } from './guide-common.js';
import { listSubs, getSub, deleteSub, markShared, makeEntry, saveSub } from '../lib/subs-library.js';

let _inited = false;
let _autoImported = false; // 打开列表自动导入：每页面会话只触发一次
let _importBusy = false; // 手动/自动导入并发只跑一个

function siteUrl() {
  try {
    const mf = chrome.runtime.getManifest();
    return mf && mf.update_url ? 'https://vocabradar.com' : 'https://localhost:3001';
  } catch (e) {
    return 'https://localhost:3001';
  }
}

function getToken() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'vocabradar:auth-get-token' }, (res) => {
        const err = chrome.runtime.lastError; // 必须读，避免未处理 lastError 报警
        resolve(err || !res || !res.ok ? null : res.accessToken);
      });
    } catch (e) { resolve(null); }
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

// 条目 → 规范视频链接（20261017 用户令：给链接时只带基本必要信息——平台+视频号，
// 不携带任何其他参数；无可还原地址返回 null 不渲染链接）：
//   bilibili BV → /video/BV..；ep 号 → /bangumi/play/ep..（P3 发布时的两种形态）
//   youtube     → watch?v=..；videoId 含 / 的路径形态（shorts/ID 等）→ 原路径还原
//   web         → videoId 即 makeVideoKey（host/path?ident 参数），https 前缀还原页面
//   local 等无平台视频号 → 无链接
// 防御剥离（20261017 二次令，用户实测链接带出 ?vd_source=.. 跟踪后缀）：videoId 若
//   混入查询/片段（历史数据脏字段），bilibili/youtube 一律截断，web 只保留视频定位
//   必需的 v/ep_id/p/cid 四个参数，其余（vd_source 等）无论来源一律不带出。
function urlForEntry(entry) {
  const id = String(entry.videoId || '').trim();
  if (!id) return null;
  if (entry.platform === 'bilibili') {
    // 分P 口径（20261017）：videoId 自带 `?p=N`（parsePlatformVideo p≥2 时并入），
    // 出链原样透传——字幕、链接、侧栏缓存键三方一致；其余查询/片段仍一律剥离
    const q = id.indexOf('?');
    const bare = (q === -1 ? id : id.slice(0, q)).split('#')[0];
    // 后缀只放行 p=N（分P 口径），vd_source 等其余参数仍一律剥离
    let suffix = '';
    if (q !== -1) {
      const pm = id.slice(q + 1).split('#')[0].match(/(?:^|&)(p=\d+)(?:&|$)/);
      if (pm) suffix = '?' + pm[1];
    }
    if (/^BV[0-9A-Za-z]+$/.test(bare)) return `https://www.bilibili.com/video/${bare}${suffix}`;
    if (/^ep\d+$/.test(bare)) return `https://www.bilibili.com/bangumi/play/${bare}${suffix}`;
    return null;
  }
  if (entry.platform === 'youtube') {
    const bare = id.split(/[?#]/)[0];
    if (bare.includes('/')) return `https://www.youtube.com/${bare}`;
    return `https://www.youtube.com/watch?v=${encodeURIComponent(bare)}`;
  }
  if (entry.platform === 'web') {
    const q = id.indexOf('?');
    const path = (q === -1 ? id : id.slice(0, q)).split('#')[0];
    if (!/^[\w.-]+/.test(path)) return null;
    const keep = [];
    if (q !== -1) {
      for (const kv of id.slice(q + 1).split('#')[0].split('&')) {
        if (/^(v|ep_id|p|cid)=/.test(kv)) keep.push(kv);
      }
    }
    return `https://${path}${keep.length ? '?' + keep.join('&') : ''}`;
  }
  return null;
}

async function publishEntry(entry, token) {
  // 20261018 用户报"分享一直在 uploading，日志无记录"：此路 fetch 无超时、失败
  // 走 log() 受门控全静默——挂起与失败皆不可见。补 30s 超时 + 失败恒 console.warn
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let res;
  let data = null;
  try {
    res = await fetch(`${siteUrl()}/api/subs/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        platform: entry.platform,
        videoId: entry.videoId,
        lang: entry.lang,
        kind: entry.kind,
        model: entry.model,
        durationSec: entry.durationSec,
        content: entry.content,
        cues: entry.cues || null,
        title: entry.title,
      }),
      signal: ctrl.signal,
    });
    data = await res.json();
  } catch (e) {
    console.warn('[VocabRadar][subs] 上传网络失败:', entry.id, String(e && e.message || e)); // 恒可见
    return false;
  } finally {
    clearTimeout(timer);
  }
  if (data && data.success && data.subtitle) {
    // 新发布（duplicate:false）云端行必属我；duplicate 时仅 mine:true 回填——
    // 撞他人行不回填，否则 cloudId 指到别人行、取消分享必报 not-owner。
    // （20261018 修：此前无条件读 data.mine——新发布响应没有该字段，fresh 分享
    // 永不 markShared，按钮永远停在「分享」，用户误判失败反复重传）
    if (!data.duplicate || data.mine) {
      await markShared(entry.id, data.subtitle.id, data.subtitle.content_hash);
    }
    return true;
  }
  console.warn('[VocabRadar][subs] 上传失败:', res && res.status, data && data.error); // 恒可见
  return false;
}

async function uploadEntry(entry, btn) {
  const token = await getToken();
  if (!token) { btn.textContent = m('subsNeedConnect'); return; }
  btn.disabled = true;
  btn.textContent = m('subsUploading');
  try {
    if (await publishEntry(entry, token)) {
      render();
    } else {
      btn.disabled = false;
      btn.textContent = m('subsShareFail');
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = m('subsShareFail');
    log('[VocabRadar][subs] 上传异常:', e);
  }
}

// 共享全部：把所有本地未分享条目逐条顺序上传（不并发，避免压服务器/触发限流）。
// token 只取一次；每条成败独立计数，结束后 toast 汇总并刷新
async function shareAll(btn) {
  const rows = await listSubs();
  const locals = rows.filter((r) => r.shareState !== 'shared');
  if (!locals.length) return;
  const token = await getToken();
  if (!token) { toast(m('subsNeedConnect')); return; }
  btn.disabled = true;
  const oldText = btn.textContent;
  let ok = 0;
  for (let i = 0; i < locals.length; i++) {
    // 逐条进度可见（20261018 用户报"一直在 uploading"——共享全部本就是逐条串行，
    // 条目多时耗时数分钟，无进度即像挂死）
    btn.textContent = `${m('subsUploading')} ${i + 1}/${locals.length}`;
    try {
      if (await publishEntry(locals[i], token)) ok++;
      else console.warn('[VocabRadar][subs] 共享全部单条失败:', locals[i].id); // 恒可见
    } catch (e) {
      console.warn('[VocabRadar][subs] 共享全部异常:', locals[i].id, String(e && e.message || e));
    }
  }
  btn.disabled = false;
  btn.textContent = oldText;
  toast(m('subsShareAllDone')
    .replace('{ok}', String(ok))
    .replace('{total}', String(locals.length))
    .replace('{skip}', String(locals.length - ok)));
  render();
}

async function deleteEntry(entry) {
  // eslint-disable-next-line no-alert
  if (!window.confirm(m('subsConfirmDelete').replace('{title}', entry.title || entry.id))) return;
  await deleteSub(entry.id);
  render();
}

// 取消分享：云端索引下线（active=false），本地条目保留、可再分享
async function unshareEntry(entry, btn) {
  btn.disabled = true;
  try {
    const token = await getToken();
    if (!token) { btn.disabled = false; btn.textContent = m('subsNeedConnect'); return; }
    const ctrl = new AbortController(); // 20261018：同 publishEntry 补超时+恒可见失败
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let res;
    let data = null;
    try {
      res = await fetch(`${siteUrl()}/api/subs/${entry.cloudId}/unshare`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      data = await res.json();
    } finally {
      clearTimeout(timer);
    }
    if (data && data.success) {
      entry.shareState = 'local';
      entry.cloudId = null;
      const lib = await import('../lib/subs-library.js');
      await lib.saveSub(entry);
      render();
    } else {
      btn.disabled = false;
      btn.textContent = m('subsUnshareFail');
      console.warn('[VocabRadar][subs] 取消分享失败:', data && data.error); // 恒可见
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = m('subsUnshareFail');
    console.warn('[VocabRadar][subs] 取消分享异常:', String(e && e.message || e)); // 恒可见
  }
}

// 页顶开关（用户 20261008 令：从账号 tab 挪到字幕库页顶）——完成后是否自动上传；
// 作者始终可按条 分享/取消分享（上传资格判定权在作者）
function bindAutoShareCheckbox() {
  const chk = $('chkSubsAutoShare');
  if (!chk || chk.dataset.bound) return;
  chk.dataset.bound = '1';
  chrome.storage.local.get({ subsAutoShare: false }, (items) => {
    chk.checked = !!items.subsAutoShare;
  });
  chk.addEventListener('change', () => {
    chrome.storage.local.set({ subsAutoShare: !!chk.checked });
    log('[VocabRadar][subs] 自动共享字幕 =', chk.checked);
  });
}

function fmtTime(ms) {
  try {
    const d = new Date(Number(ms));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return ''; }
}

// cues → SRT 文本（20261017）：HH:MM:SS,mmm 时间轴 + 序号 + 文本块
function buildSrt(cues) {
  const t = (sec) => {
    const ms = Math.max(0, Math.round(Number(sec) * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mmm = ms % 1000;
    const p2 = (n) => String(n).padStart(2, '0');
    return `${p2(h)}:${p2(m)}:${p2(s)},${String(mmm).padStart(3, '0')}`;
  };
  return cues.map((c, i) => `${i + 1}\n${t(c.start)} --> ${t(c.end)}\n${String(c.text || '').trim()}\n`)
    .join('\n');
}

function render() {
  const box = $('subsList');
  if (!box) return;
  bindAutoShareCheckbox();
  listSubs().then((rows) => {
    if (!rows.length) {
      box.innerHTML = `<div class="subs-empty">${esc(m('subsEmpty'))}</div>`;
      return;
    }
    box.innerHTML = rows.map((r) => {
      const status = r.shareState === 'shared'
        ? `<span class="subs-tag subs-tag-shared">${esc(m('subsTagShared'))}</span>`
        : `<span class="subs-tag">${esc(m('subsTagLocal'))}</span>`;
      const min = r.durationSec ? Math.round(r.durationSec / 60) + 'min · ' : '';
      const url = urlForEntry(r);
      // 两行（20261022 令）：行1=链接+视频标题（标题吃剩余宽度，超长省略，
      //   hover 原生 tooltip 出全文）；行2=时间+元信息 …… 查看·状态·其他按钮，
      //   隔一段后最右端是删除
      const row1 = (url || r.title) ? `<div class="subs-row">`
        + (url ? `<a class="subs-item-url" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">${esc(url)}</a>` : '')
        + (r.title ? `<span class="subs-item-title" title="${esc(r.title)}">${esc(r.title)}</span>` : '')
        + `</div>` : '';
      const row2 = `<div class="subs-row">`
        + `<span class="subs-item-time">${esc(fmtTime(r.createdAt))}</span>`
        + `<span class="subs-item-meta">${esc(r.platform)} · ${esc(r.lang)} · ${esc(r.kind)} · ${esc(min)}${esc(r.model)}</span>`
        + `<button type="button" class="mw-btn subs-view" data-id="${esc(r.id)}">${esc(m('subsView'))}</button>`
        + status
        + (r.shareState === 'local'
          ? `<button type="button" class="mw-btn subs-upload" data-id="${esc(r.id)}">${esc(m('subsUpload'))}</button>`
          : `<button type="button" class="mw-btn subs-unshare" data-id="${esc(r.id)}">${esc(m('subsUnshare'))}</button>`)
        + `<button type="button" class="mw-btn subs-download" data-id="${esc(r.id)}">${esc(m('subsDownload'))}</button>`
        + `<button type="button" class="mw-btn subs-del" data-id="${esc(r.id)}">${esc(m('subsDelete'))}</button>`
        + `</div>`;
      return `<div class="subs-item" data-id="${esc(r.id)}">${row1}${row2}</div>`;
    }).join('');
    box.querySelectorAll('.subs-upload').forEach((btn) => {
      btn.addEventListener('click', () => {
        const entry = rows.find((r) => r.id === btn.dataset.id);
        if (entry) uploadEntry(entry, btn);
      });
    });
    box.querySelectorAll('.subs-unshare').forEach((btn) => {
      btn.addEventListener('click', () => {
        const entry = rows.find((r) => r.id === btn.dataset.id);
        if (entry) unshareEntry(entry, btn);
      });
    });
    box.querySelectorAll('.subs-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const entry = rows.find((r) => r.id === btn.dataset.id);
        if (entry) deleteEntry(entry);
      });
    });
    // 查看：弹出窗口（20261017 令"预览改为弹出窗口"）——遮罩+居中对话框，× 或点遮罩关闭
    box.querySelectorAll('.subs-view').forEach((btn) => {
      btn.addEventListener('click', () => {
        const entry = rows.find((r) => r.id === btn.dataset.id);
        if (entry) openPreviewPopup(entry);
      });
    });
    // 下载：有 cues（20261017 起入库带时间戳段）→ 标准 SRT；旧条目无时间戳回落 .txt
    box.querySelectorAll('.subs-download').forEach((btn) => {
      btn.addEventListener('click', () => {
        const entry = rows.find((r) => r.id === btn.dataset.id);
        if (!entry) return;
        const baseName = String(entry.title || entry.videoId || entry.id).replace(/[\\/:*?"<>|]/g, '_');
        let blob; let ext;
        if (Array.isArray(entry.cues) && entry.cues.length) {
          blob = new Blob([buildSrt(entry.cues)], { type: 'application/x-subrip;charset=utf-8' });
          ext = 'srt';
        } else {
          blob = new Blob([entry.content || ''], { type: 'text/plain;charset=utf-8' });
          ext = 'txt';
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${baseName}.${ext}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      });
    });
    // 视频标题回填（20261022 令"链接后面放上视频标题"）：fire-and-forget，取到
    // 写回条目后就地更新该行 span（不整表重渲染，避免闪烁/丢滚动）
    backfillTitles(rows);
  }).catch((e) => {
    box.innerHTML = `<div class="subs-empty">${esc(m('subsLoadFail'))}</div>`;
    log('[VocabRadar][subs] 列表读取失败:', e);
  });
}

// ---- 视频标题回填（20261022 令"链接后面放上视频标题"）----
// 存量条目 title 普遍为空（后端导入 title:''、侧栏收割/云端消费未带页面标题），
// 列表对无标题且可出链的 bilibili/youtube 条目按平台公开接口取标题（SW 不经手——
// 引导页有 <all_urls> host 权限，跨域直取不涉 CORS）：
//   bilibili  /x/web-interface/view（bvid 或 ep_id，番剧 ep 返回所属季标题）
//   youtube   oembed（公开无 Key，watch 与 shorts 路径都认）
// 取到写回条目（title 上限同 makeEntry 200 字）就地更新；失败本会话不重试，
// 下次打开再试。web/local 无可靠标题源，不取。
const _titleTried = new Set();

function fetchVideoTitle(entry) {
  const url = urlForEntry(entry);
  if (!url) return Promise.resolve('');
  if (entry.platform === 'youtube') {
    return fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`)
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => (d && d.title ? String(d.title) : ''))
      .catch(() => '');
  }
  if (entry.platform === 'bilibili') {
    const bv = url.match(/\/video\/(BV[0-9A-Za-z]+)/);
    const ep = url.match(/\/bangumi\/play\/ep(\d+)/);
    const q = bv ? `bvid=${bv[1]}` : (ep ? `ep_id=${ep[1]}` : '');
    if (!q) return Promise.resolve('');
    return fetch(`https://api.bilibili.com/x/web-interface/view?${q}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => (d && d.data && d.data.title ? String(d.data.title) : ''))
      .catch(() => '');
  }
  return Promise.resolve('');
}

function backfillTitles(rows) {
  for (const r of rows) {
    if (r.title || _titleTried.has(r.id)) continue;
    if (r.platform !== 'bilibili' && r.platform !== 'youtube') continue;
    _titleTried.add(r.id);
    fetchVideoTitle(r).then((title) => {
      if (!title) return;
      // 读-改-写（不用取标题前的快照整条覆盖）：取标题期间条目可能被分享
      //   （shareState/cloudId 已回填）或删除——只补 title，其余以库内现值为准；
      //   已删除不复活
      getSub(r.id).then((cur) => {
        if (!cur) return;
        cur.title = title.slice(0, 200);
        return saveSub(cur).then(() => {
          const el = document.querySelector(`.subs-item[data-id="${CSS.escape(r.id)}"] .subs-item-title`);
          if (el) el.textContent = cur.title;
        });
      }).catch((e) => log('[VocabRadar][subs] 标题回写失败:', r.id, e));
    });
  }
}

export function initSubs() {
  if (_inited) return;
  _inited = true;
  const btn = $('g-asr-save-subs');
  if (btn) btn.addEventListener('click', saveFromAsr);
  const shareAllBtn = $('btnSubsShareAll');
  if (shareAllBtn) shareAllBtn.addEventListener('click', () => shareAll(shareAllBtn));
  const importBtn = $('btnSubsImport');
  if (importBtn) importBtn.addEventListener('click', () => importFromBackend(importBtn));
  purgeNoCues().then(() => render()); // 先清无时间戳旧条目再渲染（非法字幕不显示）
}

// 非法字幕不显示（20261018 令，撤"删除旧条目"按钮改为加载即清）：无 cues（无
// 时间戳）的条目直接删除，不渲染——垃圾条目没有存在的意义
async function purgeNoCues() {
  try {
    const rows = await listSubs();
    const victims = rows.filter((r) => !Array.isArray(r.cues) || !r.cues.length);
    for (const v of victims) {
      try { await deleteSub(v.id); } catch (e) { log('[VocabRadar][subs] 清理旧条目失败:', v.id, e); }
    }
    if (victims.length) log('[VocabRadar][subs] 已清理无时间戳旧条目:', victims.length);
  } catch (e) { log('[VocabRadar][subs] 清理旧条目异常:', e); }
}

// 预览弹窗（20261017 令"预览改为弹出窗口"）：遮罩+居中对话框，懒创建复用，
// × 或点遮罩空白处关闭；正文 textContent 注入防注入。
// P5（20261018）：云端消费落库条目（cloudId）在弹窗内可评价（👍/👎/★，经 SW 投票
// 代理）与纠错（逐行编辑、行数须与时间轴一致 → derivedFrom 新版本上传成为分享者）
function openPreviewPopup(entry) {
  let overlay = document.getElementById('subsPreviewOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'subsPreviewOverlay';
    overlay.className = 'subs-preview-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
    document.body.appendChild(overlay);
  }
  const isCloud = Number.isInteger(entry.cloudId) && entry.cloudId > 0;
  const canFix = isCloud && Array.isArray(entry.cues) && entry.cues.length > 0;
  overlay.innerHTML = `<div class="subs-preview-dialog">`
    + `<div class="subs-preview-bar">`
    + `<span class="subs-preview-title">${esc(entry.title || entry.videoId || entry.id)}</span>`
    + (canFix ? `<button type="button" class="mw-btn subs-preview-correct">${esc(m('subsCorrect'))}</button>` : '')
    + `<button type="button" class="mw-btn subs-preview-close">×</button>`
    + `</div>`
    + `<div class="subs-preview-vote" style="display:none"></div>`
    + `<div class="subs-preview-body"></div>`
    + `<div class="subs-preview-edit" style="display:none"></div>`
    + `</div>`;
  overlay.querySelector('.subs-preview-body').textContent =
    // 20261018 用户令"预览也改成srt"：有 cues 显示标准 SRT（与下载件一致），无 cues 回落纯文本
    Array.isArray(entry.cues) && entry.cues.length ? buildSrt(entry.cues) : (entry.content || '');
  overlay.style.display = 'flex';
  overlay.querySelector('.subs-preview-close').addEventListener('click', () => {
    overlay.style.display = 'none';
  });
  const fixBtn = overlay.querySelector('.subs-preview-correct');
  if (fixBtn) fixBtn.addEventListener('click', () => openCorrectEditor(entry, overlay));
  if (isCloud) loadVoteBar(entry, overlay);
}

// 评价条：GET 票态预填；👍/👎 再点取消、★ 点同值清除。投票经 SW 代理
// （vocabradar:subs-vote），响应即服务端最新计数——单往返、无乐观更新不撒谎
async function loadVoteBar(entry, overlay) {
  const box = overlay.querySelector('.subs-preview-vote');
  if (!box) return;
  const res = await sendMsg('vocabradar:subs-vote', { id: entry.cloudId });
  if (!box.isConnected || overlay.style.display === 'none') return;
  box.style.display = 'block';
  if (!res || !res.ok) {
    // 各结局如实一行（不静默）：未连接给引导，其余给失败
    box.innerHTML = `<div style="font-size:.85em;opacity:.6;margin-bottom:4px">`
      + `${esc(res && res.error === 'not-connected' ? m('subsVoteConnect') : m('subsVoteFail'))}</div>`;
    if (res && res.error !== 'not-connected') log('[VocabRadar][subs] 票态读取失败:', res && res.error);
    return;
  }
  renderVoteBar(box, res, entry);
}

// 评价图标（20261018 用户令"谁让你用 svg 了"——彩色 emoji：👍 👎 ⭐）
const THUMB_UP = '👍';
const THUMB_DOWN = '👎';
const STAR = '⭐';

function renderVoteBar(box, st, entry) {
  const stars = [1, 2, 3, 4, 5].map((n) =>
    `<span class="subs-vote-star" data-n="${n}" style="cursor:pointer;${n <= (st.myStars || 0) ? '' : 'opacity:.35;filter:grayscale(1)'}">${STAR}</span>`).join('');
  const thumbBtn = (ic, cls, active) =>
    `<button type="button" class="mw-btn ${cls}" style="${active ? 'color:#0a7d4f;font-weight:700' : ''}">${ic}</button>`;
  box.innerHTML = `<div style="font-size:.9em;margin-bottom:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">`
    + `<span>${THUMB_UP}${st.upVotes || 0} ${THUMB_DOWN}${st.downVotes || 0} · ${STAR}${st.starAvg || 0}(${st.starCount || 0})</span>`
    + thumbBtn(THUMB_UP, 'subs-vote-up', st.myVote === 1)
    + thumbBtn(THUMB_DOWN, 'subs-vote-down', st.myVote === -1)
    + `<span class="subs-vote-stars" style="display:inline-flex;align-items:center;gap:1px;font-size:15px">${stars}</span>`
    + `</div>`;
  box.querySelector('.subs-vote-up').addEventListener('click', () =>
    castVote(entry, box, { vote: st.myVote === 1 ? 0 : 1 }));
  box.querySelector('.subs-vote-down').addEventListener('click', () =>
    castVote(entry, box, { vote: st.myVote === -1 ? 0 : -1 }));
  box.querySelectorAll('.subs-vote-star').forEach((el) => {
    el.addEventListener('click', () => {
      const n = Number(el.dataset.n);
      castVote(entry, box, { stars: st.myStars === n ? 0 : n });
    });
  });
}

async function castVote(entry, box, ballot) {
  const res = await sendMsg('vocabradar:subs-vote', { id: entry.cloudId, ...ballot });
  if (!res || !res.ok) {
    toast(`${m('subsVoteFail')}${res && res.error ? ' (' + res.error + ')' : ''}`);
    return;
  }
  renderVoteBar(box, res, entry);
}

// 纠错编辑器（方案 §5「纠错 = 上传新版本」）：cues 为权威行源（预填即逐段时间轴
// 文本，行数天然对齐）；提交校验行数一致 → SW subs-correct（derivedFrom=cloudId）。
// 成功后纠错版另存为本地"我分享的"新条目（cloudId=新行 id）；原消费条目保持不动
function openCorrectEditor(entry, overlay) {
  const cues = Array.isArray(entry.cues) ? entry.cues : [];
  const bodyEl = overlay.querySelector('.subs-preview-body');
  const voteEl = overlay.querySelector('.subs-preview-vote');
  const editEl = overlay.querySelector('.subs-preview-edit');
  bodyEl.style.display = 'none';
  if (voteEl) voteEl.style.display = 'none';
  editEl.style.display = 'block';
  editEl.innerHTML = `<div style="font-size:.85em;opacity:.7;margin-bottom:4px">${esc(m('subsCorrectHint'))}</div>`
    + `<textarea class="subs-preview-editor" style="width:100%;min-height:220px;box-sizing:border-box;font-family:inherit;font-size:inherit"></textarea>`
    + `<div style="margin-top:6px;display:flex;gap:8px">`
    + `<button type="button" class="mw-btn subs-correct-upload">${esc(m('subsCorrectUpload'))}</button>`
    + `<button type="button" class="mw-btn subs-correct-cancel">${esc(m('subsCorrectCancel'))}</button></div>`;
  const ta = editEl.querySelector('.subs-preview-editor');
  ta.value = cues.map((c) => String(c.text || '').trim()).join('\n');
  const backToBody = () => {
    editEl.style.display = 'none';
    bodyEl.style.display = '';
    if (voteEl) voteEl.style.display = '';
  };
  editEl.querySelector('.subs-correct-cancel').addEventListener('click', backToBody);
  editEl.querySelector('.subs-correct-upload').addEventListener('click', async function () {
    const lines = ta.value.split('\n');
    if (lines.length !== cues.length) {
      // 行数与时间轴不一致：如实拒绝（不均匀铺时间瞎编，也不丢段错位）
      toast(m('subsCorrectLineMismatch')
        .replace('{lines}', String(lines.length)).replace('{cues}', String(cues.length)));
      return;
    }
    const newCues = cues.map((c, i) => ({ start: c.start, end: c.end, text: lines[i].trim() }))
      .filter((c) => c.text);
    const content = newCues.map((c) => c.text).join('\n').trim();
    if (!content) { toast(m('subsShareFail')); return; }
    this.disabled = true;
    this.textContent = m('subsCorrectUploading');
    const res = await sendMsg('vocabradar:subs-correct', {
      payload: {
        platform: entry.platform, videoId: entry.videoId, lang: entry.lang,
        kind: entry.kind || 'asr',
        model: `manual-fix/${entry.model || 'unknown'}`,
        durationSec: entry.durationSec, content, cues: newCues,
        title: entry.title || '', derivedFrom: entry.cloudId,
      },
    });
    this.disabled = false;
    this.textContent = m('subsCorrectUpload');
    if (!res || !res.ok || !res.subtitle) {
      toast(`${m('subsShareFail')}${res && res.error ? ' (' + res.error + ')' : ''}`);
      log('[VocabRadar][subs] 纠错上传失败:', res && res.error);
      return;
    }
    try {
      const ne = makeEntry({
        platform: entry.platform, videoId: entry.videoId, lang: entry.lang,
        kind: entry.kind || 'asr', title: entry.title || '',
        durationSec: entry.durationSec,
        model: `manual-fix/${entry.model || 'unknown'}`,
        content, cues: newCues, cloudId: res.subtitle.id,
      });
      await saveSub(ne);
      // 仅当云端行属于我（内容撞车他人先行分享时不回填，同 publishEntry 口径）
      if (res.mine) await markShared(ne.id, res.subtitle.id, res.subtitle.content_hash);
    } catch (e) {
      log('[VocabRadar][subs] 纠错版入库失败:', e);
    }
    toast(m('subsCorrectDone'));
    backToBody();
    render();
  });
}

// 从本地后端导入（20261017 用户令"本地后端有很多字幕，扩展只有三条"）：
// 清单/详情/去重/无人声门控全在 SW（vocabradar:subs-backend-import），这里只触发+汇报。
// 手动（按钮）/自动（打开列表）两路共用：_importBusy 并发只跑一个（自动撞上手动
//   在跑则本次静默跳过——手动路本身会汇报+刷新）
function sendMsg(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
        const err = chrome.runtime.lastError; // 必须读，防未处理 lastError 告警
        resolve(err ? { ok: false, error: err.message } : (res || { ok: false, error: 'no-response' }));
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message || e) });
    }
  });
}

async function requestBackendImport() {
  if (_importBusy) return null;
  _importBusy = true;
  const res = await sendMsg('vocabradar:subs-backend-import');
  _importBusy = false;
  return res;
}

async function importFromBackend(btn) {
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = m('subsImporting');
  const res = await requestBackendImport();
  btn.disabled = false;
  btn.textContent = oldText;
  if (res && res.ok) {
    toast(m('subsImportDone').replace('{ok}', String(res.imported || 0)).replace('{skip}', String(res.skipped || 0)));
  } else {
    toast(`${m('subsShareFail')}${res && res.error ? ' (' + res.error + ')' : ''}`);
  }
  render();
}

// 打开字幕列表自动导入一次（20261022 令）：每页面会话首个打开触发；自动动作
// 不刷屏——仅真有新导入（imported>0）才 toast+刷新，后端不可达等失败只
// console.warn（手动「从后端导入」按钮保留完整汇报）
export function autoImportOnce() {
  if (_autoImported) return;
  _autoImported = true;
  requestBackendImport().then((res) => {
    if (res && res.ok) {
      if ((res.imported || 0) > 0) {
        toast(m('subsImportDone').replace('{ok}', String(res.imported || 0)).replace('{skip}', String(res.skipped || 0)));
        render();
      }
    } else if (res) {
      console.warn('[VocabRadar][subs] 自动导入失败:', res.error); // 恒可见
    }
  });
}

// ASR 转写结果一键入库（方案 §3.1：先落本地库，审阅后上传）。
// platform=local；videoId 用时间戳（本地文件无平台视频号）；时长取末段 end，
// 无时间戳时按段数估算（P3 权宜，上传定价精度在 P4 收口）；模型声明取当前
// ASR 引擎配置（如实声明所用引擎，不臆造）。
async function saveFromAsr() {
  const segs = (S.asrResults || []).filter((s) => s && s.text);
  const content = segs.map((s) => s.text).join('\n').trim();
  if (!content) return;
  const last = segs[segs.length - 1];
  const durationSec = last && Number.isFinite(last.end) && last.end > 0
    ? Math.ceil(last.end)
    : segs.length * 3;
  const st = await new Promise((res) => {
    chrome.storage.local.get(
      { learnLanguage: 'en', asrLlmProvider: 'local-backend', asrLlmModel: '' },
      (r) => res(r),
    );
  });
  const model = [st.asrLlmProvider, st.asrLlmModel].filter(Boolean).join('/') || 'unknown';
  const entry = makeEntry({
    platform: 'local',
    videoId: 'local-' + Date.now().toString(36),
    lang: st.learnLanguage,
    kind: 'asr',
    title: `${m('subsAsrTitle')} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    durationSec,
    model,
    content,
    cues: segs.map((s) => ({ start: s.start || 0, end: s.end || 0, text: (s.text || '').trim() }))
      .filter((c) => c.text),
  });
  try {
    await saveSub(entry);
    toast(m('subsSaveOk'));
    render();
  } catch (e) {
    log('[VocabRadar][subs] 入库失败:', e);
  }
}

export function refreshSubs() {
  if (_inited) render();
}

export function disposeSubs() {
  _inited = false;
}
