// VocabRadar 引导页 字幕库 模块（2026-10-08 P3：独立标签 panel-subs，仿 account.js）
// 职责（方案 §3.1 生产体系；管理面在网站「我的分享」——扩展保持薄、稳定）：
//   - 列表：本地字幕库（IndexedDB vocabradar-subs，lib/subs-library.js）按时间倒序，
//     每条显示 标题/平台/语言/时长/模型 + 状态（本地/已分享）
//   - 上传分享：chrome.runtime.sendMessage('vocabradar:auth-get-token') 取有效 token
//     （续签在 SW，auth.js 单一属主）→ POST <站点>/api/subs/publish → 回填 shared
//   - 删除本地：仅删本地记录，云端一概不动（20261008 用户裁定）；confirm 防误删
//   - 未连接账号时上传按钮提示先到「账号」标签连接
import { $, m, log } from './shared.js';
import { S, toast } from './guide-common.js';
import { listSubs, deleteSub, markShared, makeEntry, saveSub } from '../lib/subs-library.js';

let _inited = false;

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

async function publishEntry(entry, token) {
  const res = await fetch(`${siteUrl()}/api/subs/publish`, {
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
      title: entry.title,
    }),
  });
  const data = await res.json();
  if (data && data.success && data.subtitle) {
    await markShared(entry.id, data.subtitle.id, data.subtitle.content_hash);
    return true;
  }
  log('[VocabRadar][subs] 上传失败:', data && data.error);
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
  btn.textContent = m('subsUploading');
  let ok = 0;
  for (const entry of locals) {
    try {
      if (await publishEntry(entry, token)) ok++;
    } catch (e) {
      log('[VocabRadar][subs] 共享全部异常:', entry.id, e);
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
    const res = await fetch(`${siteUrl()}/api/subs/${entry.cloudId}/unshare`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data && data.success) {
      entry.shareState = 'local';
      entry.cloudId = null;
      const lib = await import('../lib/subs-library.js');
      await lib.saveSub(entry);
      render();
    } else {
      btn.disabled = false;
      btn.textContent = m('subsUnshareFail');
      log('[VocabRadar][subs] 取消分享失败:', data && data.error);
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = m('subsUnshareFail');
    log('[VocabRadar][subs] 取消分享异常:', e);
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
      // 每条右侧三分钮（用户 20261008 令）：本地=分享+删除；已分享=取消分享+删除
      const actions = r.shareState === 'local'
        ? `<button type="button" class="mw-btn subs-upload" data-id="${esc(r.id)}">${esc(m('subsUpload'))}</button> `
        : `<button type="button" class="mw-btn subs-unshare" data-id="${esc(r.id)}">${esc(m('subsUnshare'))}</button> `;
      return `<div class="subs-item">`
        + `<div class="subs-item-main">`
        + `<div class="subs-item-title">${esc(r.title || r.videoId || r.id)}</div>`
        + `<div class="subs-item-meta">${esc(r.platform)} · ${esc(r.lang)} · ${esc(r.kind)} · ${esc(min)}${esc(r.model)}</div>`
        + `</div>`
        + `${status}`
        + `<div class="subs-item-actions">${actions}`
        + `<button type="button" class="mw-btn subs-del" data-id="${esc(r.id)}">${esc(m('subsDelete'))}</button>`
        + `</div></div>`;
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
  }).catch((e) => {
    box.innerHTML = `<div class="subs-empty">${esc(m('subsLoadFail'))}</div>`;
    log('[VocabRadar][subs] 列表读取失败:', e);
  });
}

export function initSubs() {
  if (_inited) return;
  _inited = true;
  const btn = $('g-asr-save-subs');
  if (btn) btn.addEventListener('click', saveFromAsr);
  const shareAllBtn = $('btnSubsShareAll');
  if (shareAllBtn) shareAllBtn.addEventListener('click', () => shareAll(shareAllBtn));
  render();
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
