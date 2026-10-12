// =============================================================================
// sw/subs-share.js —— 字幕共享 SW 侧（P3 2026-10-08）
// -----------------------------------------------------------------------------
// 两条职责：
// ① 'vocabradar:subs-autopublish'（内容脚本：已完成任务就地入库后的自动上传）——
//    开关门控 → getValidAccessToken → 规范化+SHA-256 与标记比对防重发 → 发布。
// ② 'vocabradar:subs-job-handoff'（内容脚本：ASR 停止时任务仍进行中的交接）——
//    用户令「只有完整识别的字幕才合格」：用户停止/离开后 SW 用 chrome.alarms
//    继续拉取 backend 任务（每 60s）直到 completed，完整字幕入库
//    （lib/subs-library.js，SW 亦可用 IndexedDB），开着自动共享则随即发布。
//    完整字幕缓存周期 30 天：未分享的收割条目超 30 天由 alarm 清扫（已分享的
//    云端有索引，本地条目不受限）。
// 站点按 manifest update_url 判定（draft-export.js getSiteUrl 同规则）。
// =============================================================================

import { getValidAccessToken } from './auth.js';
import { handleAsrJobPoll, submitAsrJobOnce } from './backend.js';
import { makeEntry, saveSub, listSubs, deleteSub } from '../../lib/subs-library.js';

const PROGRESS_MARKER_PREFIX = 'subsPubHash:';
const PENDING_KEY = 'subsPendingJobs';
const ALARM_NAME = 'vocabradar-subs-job-continue';
const ALARM_PERIOD_MIN = 1;
const HARVEST_TTL_MS = 30 * 24 * 3600 * 1000; // 未分享收割条目的缓存周期（用户令：同 30 天）

function siteUrl() {
  try {
    const mf = chrome.runtime.getManifest();
    return mf && mf.update_url ? 'https://vocabradar.com' : 'https://localhost:3001';
  } catch (e) {
    return 'https://localhost:3001';
  }
}

function storageGet(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, (r) => resolve(r)));
}

function normalizeContent(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 发布共享：开关门控 → token → 内容哈希防重发 → POST /api/subs/publish
async function publishContent(payload, videoKey) {
  const st = await storageGet({ subsAutoShare: false });
  if (!st.subsAutoShare) return { ok: false, error: 'disabled' };

  const token = await getValidAccessToken();
  if (!token) return { ok: false, error: 'not-connected' };

  const content = normalizeContent(payload && payload.content);
  if (!content) return { ok: false, error: 'empty-content' };
  if (!videoKey) videoKey = 'k-' + contentHashShort(content);

  const contentHash = await sha256Hex(content);
  const markerKey = PROGRESS_MARKER_PREFIX + videoKey;
  const prev = await storageGet({ [markerKey]: '' });
  if (prev[markerKey] === contentHash) return { ok: true, duplicate: true };

  const res = await fetch(`${siteUrl()}/api/subs/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...(payload || {}), content }),
  });
  const data = await res.json().catch(() => null);
  if (!data || !data.success || !data.subtitle) {
    return { ok: false, error: (data && data.error) || `HTTP ${res.status}` };
  }
  await chrome.storage.local.set({ [markerKey]: data.subtitle.content_hash });
  return { ok: true, duplicate: !!data.duplicate };
}

function contentHashShort(text) {
  return Math.abs(String(text).split('').reduce((a, c) => ((a * 31 + c.charCodeAt(0)) | 0), 7)).toString(36);
}

// ---- ② 任务接续：注册/alarm 轮询/收割入库 ----

async function registerHandoff(msg) {
  const pend = await storageGet({ [PENDING_KEY]: {} });
  const map = pend[PENDING_KEY] || {};
  map[String(msg.videoKey || '')] = {
    videoKey: String(msg.videoKey || ''),
    jobId: msg.jobId,
    cursor: Number(msg.after) || 0,
    meta: msg.meta || {},
    seen: {},      // segKey → 1（backend 全量重发段去重，与 asr-client _segKey 同式）
    texts: [],     // [{start,end,text}] 累积
  };
  await chrome.storage.local.set({ [PENDING_KEY]: map });
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
  return { ok: true };
}

// 与 asr-client _segKey 同式：start|end|text 去重键
function segKey(s) {
  return `${s.start}|${s.end}|${s.text}`;
}

async function pollPendingJobs() {
  const pend = await storageGet({ [PENDING_KEY]: {} });
  const map = pend[PENDING_KEY] || {};
  const keys = Object.keys(map);
  if (keys.length === 0) {
    chrome.alarms.clear(ALARM_NAME);
    return;
  }
  for (const vk of keys) {
    const job = map[vk];
    let resp;
    try {
      resp = await handleAsrJobPoll(job.jobId, job.cursor);
    } catch (e) {
      resp = { ok: false, error: String(e && e.message || e) };
    }
    if (!resp || !resp.ok) {
      // 404 = backend 重启丢内存任务表（job id 随机不落盘）。同 URL 重提可接续
      //   （backend 单飞复用进行中任务），语言与首提一致
      if (resp && resp.error === 'not_found') {
        try {
          const submit = await submitAsrJobOnce(job.meta.sourceUrl || '', job.meta.lang);
          if (submit && submit.ok && submit.id) {
            job.jobId = submit.id;
            job.cursor = 0;
            await chrome.storage.local.set({ [PENDING_KEY]: map });
          }
        } catch (e) { /* 下轮重试 */ }
      }
      continue; // 失联不收场（用户裁定：失败就说失败，继续轮询）
    }

    const segs = Array.isArray(resp.segments) ? resp.segments : [];
    for (const s of segs) {
      const text = (s.text || '').trim();
      if (!text) continue;
      const k = segKey(s);
      if (job.seen[k]) continue;
      job.seen[k] = 1;
      job.texts.push({ start: s.start || 0, end: s.end || 0, text });
    }
    job.cursor += segs.length;

    if (resp.status === 'completed') {
      job.texts.sort((a, b) => (a.start || 0) - (b.start || 0));
      const content = job.texts.map((x) => x.text).join('\n').trim();
      if (content.length >= 20) {
        const last = job.texts[job.texts.length - 1];
        const entry = makeEntry({
          platform: job.meta.platform,
          videoId: job.meta.videoId,
          lang: job.meta.lang,
          kind: 'asr',
          title: job.meta.title || '',
          durationSec: last && Number.isFinite(last.end) ? Math.ceil(last.end) : 0,
          model: `backend/${job.meta.modelSize || 'unknown'}`,
          content,
          harvestedAt: Date.now(),
        });
        try {
          await saveSub(entry);
          await publishContent({
            platform: entry.platform, videoId: entry.videoId, lang: entry.lang,
            kind: entry.kind, model: entry.model, durationSec: entry.durationSec,
            content: entry.content, title: entry.title,
          }, vk);
        } catch (e) { /* 入库/发布失败：条目已在库（或未入库），下轮不再重试本任务 */ }
      }
      delete map[vk]; // 任务终态：完成（无论发布成败，不无限重试——如实缺失待作者手动分享）
    } else if (resp.status === 'failed') {
      delete map[vk]; // backend 报失败：如实放弃
    } else {
      await chrome.storage.local.set({ [PENDING_KEY]: map });
    }
  }
  const rest = Object.keys(map).length;
  if (rest > 0) await chrome.storage.local.set({ [PENDING_KEY]: map });
  else {
    await chrome.storage.local.remove(PENDING_KEY);
    chrome.alarms.clear(ALARM_NAME);
  }
}

// 未分享的收割条目超 30 天清扫（用户令：完整字幕缓存周期同 30 天；
// 作者手动存入的条目无 harvestedAt，不扫）
async function sweepExpiredHarvests() {
  try {
    const rows = await listSubs();
    const cutoff = Date.now() - HARVEST_TTL_MS;
    for (const r of rows) {
      if (r.harvestedAt && r.shareState !== 'shared' && r.harvestedAt < cutoff) {
        await deleteSub(r.id);
      }
    }
  } catch (e) { /* 清扫失败下轮再试 */ }
}

// 顶层副作用：注册内部 onMessage + alarm 监听（service-worker.js import 触发）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'vocabradar:subs-autopublish') {
    publishContent(msg.payload, msg.videoKey).then(sendResponse);
    return true;
  }
  if (msg.type === 'vocabradar:subs-job-handoff') {
    registerHandoff(msg).then(sendResponse);
    return true;
  }
  return false; // 其余放行给其他监听者
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  pollPendingJobs().then(() => sweepExpiredHarvests()).catch(() => {});
});
