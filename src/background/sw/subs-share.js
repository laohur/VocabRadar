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
// ③ 云端消费（P4）：'vocabradar:subs-cloud-lookup'（缓存/索引查询）与
//    'vocabradar:subs-cloud-download'（扣分下载，成功同时落 30 天缓存 + 本地库）。
// ④ 评价与纠错（P5）：'vocabradar:subs-vote'（GET 票态/POST 投票代理）、
//    'vocabradar:subs-correct'（纠错=带 derivedFrom 的新版本发布，显式动作不走
//    自动共享开关但必须登录）。
// 站点按 manifest update_url 判定（draft-export.js getSiteUrl 同规则）。
// =============================================================================

import { getValidAccessToken } from './auth.js';
import { handleAsrJobPoll, submitAsrJobOnce, BACKEND_BASE_DEFAULT } from './backend.js';
import { makeEntry, saveSub, listSubs, deleteSub, isGarbageAsr } from '../../lib/subs-library.js';
import { _ts, log } from './log.js';

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
      // 无人声门控（20261017 用户报无人声视频也产出了字幕）：whisper 对静音会幻觉
      //   出文本，正文长度拦不住——按快照里的 VAD 覆盖区间算覆盖率，<2% 视为无人声，
      //   不入库不上传，任务照常收场
      const cov = Array.isArray(resp.coverage) ? resp.coverage : null
      if (cov) {
        const covered = cov.reduce((a, r) => a + Math.max(0, (r[1] || 0) - (r[0] || 0)), 0)
        const span = cov.length ? Math.max(...cov.map((r) => r[1] || 0)) : 0
        if (span > 0 && covered / span < 0.02) {
          console.warn(`[VocabRadar][sw][${_ts()}] 无人声（覆盖 ${(covered / span * 100).toFixed(1)}%）——不入库不上传:`, vk)
          delete map[vk]
          continue
        }
      }
      job.texts.sort((a, b) => (a.start || 0) - (b.start || 0));
      const content = job.texts.map((x) => x.text).join('\n').trim();
      const last = job.texts[job.texts.length - 1];
      const durSec = last && Number.isFinite(last.end) ? Math.ceil(last.end) : 0;
      // 反幻觉门控（20261017）：语速超限/复读文本不入库不上传（任务照常收场）
      if (content.length >= 20 && isGarbageAsr(content, durSec)) {
        console.warn(`[VocabRadar][sw][${_ts()}] 疑似幻觉文本（语速/复读异常）——不入库不上传:`, vk);
        delete map[vk];
        continue;
      }
      if (content.length >= 20) {
        const entry = makeEntry({
          platform: job.meta.platform,
          videoId: job.meta.videoId,
          lang: job.meta.lang,
          kind: 'asr',
          title: job.meta.title || '',
          durationSec: durSec,
          model: `backend/${job.meta.modelSize || 'unknown'}`,
          content,
          cues: job.texts.map((x) => ({ start: x.start || 0, end: x.end || 0, text: x.text })),
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

// ---- ③ 云端消费（P4 2026-10-17）：无字幕页「获取云端字幕」----
// 通道（内容脚本 loading.js → SW）：
//   'vocabradar:subs-cloud-lookup'  {videoKey, platform, videoId, lang}
//     → 先查本地 subs_cloud_{videoKey} 缓存（30 天，方案 §3.2「缓存命中免计」），
//       命中直接返回 content（不扣分）；未命中调 GET /api/subs/lookup 报价。
//   'vocabradar:subs-cloud-download' {videoKey, id, requestId}
//     → POST /api/subs/download（settle_consumption 扣分+分成在 Worker 侧完成）
//       → 成功即写 30 天缓存。requestId 由内容脚本生成并沿用至成功，网络重试不重扣。
// 与 ASR 缓存（asr_client asr_cache_）刻意分命名空间：ASR 缓存按模型失效且有
//   自动续识别逻辑，云端字幕混入会被误判模型不符/触发续转。
const CLOUD_CACHE_PREFIX = 'subs_cloud_'
const CLOUD_TTL_MS = 30 * 24 * 3600 * 1000

// 消费字幕落库（P5 20261018）：下载与缓存命中共用——本地库是评价/纠错/SRT 的
// 持久载体（用户实测：B 的消费条目从未出现在字幕库，根因是缓存命中路径不落库，
// 而 B 的视频全在缓存里）。同 cloudId 已在库则跳过（内容同源，不堆重复行）。
// 旧缓存条目无 kind（当时的下载未缓存该字段），如实按 'asr' 兜底
async function saveConsumedEntry(msg, src) {
  if (!src || !src.subtitleId || !src.content) return;
  try {
    const existing = (await listSubs()).find((r) => r.cloudId === src.subtitleId);
    if (existing) return;
    const entry = makeEntry({
      platform: msg.platform || '',
      videoId: msg.videoId || '',
      lang: msg.lang || 'en',
      kind: src.kind || 'asr',
      title: msg.title || '',
      durationSec: src.durationSec || 0,
      model: src.model || '',
      content: src.content || '',
      cues: Array.isArray(src.cues) ? src.cues : null,
      harvestedAt: Date.now(),
      cloudId: src.subtitleId,
    });
    await saveSub(entry);
  } catch (e) {
    console.warn(`[VocabRadar][sw][${_ts()}] 消费字幕落库失败（不影响上屏）:`, String(e && e.message || e));
  }
}

async function cloudCacheGet(videoKey) {
  if (!videoKey) return null;
  try {
    const key = CLOUD_CACHE_PREFIX + videoKey;
    const res = await storageGet({ [key]: null });
    const c = res[key];
    if (!c || !c.content) return null;
    if (Date.now() - (c.fetchedAt || 0) > CLOUD_TTL_MS) return null; // 超期视为未命中
    return c;
  } catch (e) {
    return null;
  }
}

async function cloudLookup(msg) {
  log(`[VocabRadar][sw][${_ts()}] subs-cloud lookup:`, msg.platform, msg.videoId, msg.lang);
  // 缓存仅在带时间轴时可用（20261018 用户报"消费方还是没能自动拉去"链路真相：
  // 升级前下载的旧缓存无 cues——命中即拒绝渲染并 return，升级后的云端对象永远
  // 轮不到下载）。无 cues 的旧缓存视同未命中，落到 lookup 取新对象
  const cached = await cloudCacheGet(msg.videoKey);
  if (cached && Array.isArray(cached.cues) && cached.cues.length) {
    await saveConsumedEntry(msg, cached); // 缓存命中同样落库（P5）
    return { ok: true, cached: true, content: cached.content, cues: cached.cues || null, durationSec: cached.durationSec, model: cached.model };
  }
  const token = await getValidAccessToken();
  if (!token) return { ok: false, error: 'not-connected' };
  const qs = `platform=${encodeURIComponent(msg.platform || '')}` +
    `&video_id=${encodeURIComponent(msg.videoId || '')}` +
    `&lang=${encodeURIComponent(msg.lang || 'en')}`;
  // 失败必留痕（log 受 debug 门控，错误走 console.warn 恒可见——log.js 约定）
  let res, data = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    res = await fetch(`${siteUrl()}/api/subs/lookup?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[VocabRadar][sw][${_ts()}] subs-cloud lookup 网络失败:`, String(e && e.message || e));
    return { ok: false, error: 'network', message: String(e && e.message || e) };
  }
  clearTimeout(timer);
  if (!data || !data.success) {
    console.warn(`[VocabRadar][sw][${_ts()}] subs-cloud lookup 失败: HTTP ${res && res.status}`, data && data.error);
    return { ok: false, error: (data && data.error) || `HTTP ${res && res.status}` };
  }
  if (!data.count) return { ok: false, error: 'none' };
  // P5：回传全版本数组（服务端已按 Wilson 排序，items[0] 默认最高分）——
  // 版本切换 UI（loading.js）按 id 取用，逐版显示 评分/星级/时长/是否我的
  return { ok: true, cached: false, item: data.items[0], items: data.items, versions: data.count };
}

async function cloudDownload(msg) {
  log(`[VocabRadar][sw][${_ts()}] subs-cloud download: id=`, msg.id, 'requestId=', msg.requestId);
  // 同 lookup：无时间轴的旧缓存视同未命中（服务端已购免费重取，落到网络不重复扣分）
  const cached = await cloudCacheGet(msg.videoKey);
  if (cached && Array.isArray(cached.cues) && cached.cues.length) { // 双击/并发竞态：缓存已写入则不再扣分
    return { ok: true, cached: true, content: cached.content, cues: cached.cues || null, durationSec: cached.durationSec, model: cached.model };
  }
  const token = await getValidAccessToken();
  if (!token) return { ok: false, error: 'not-connected' };
  let res, data = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    res = await fetch(`${siteUrl()}/api/subs/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: msg.id, requestId: msg.requestId }),
      signal: ctrl.signal,
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[VocabRadar][sw][${_ts()}] subs-cloud download 网络失败:`, String(e && e.message || e));
    return { ok: false, error: 'network', message: String(e && e.message || e) };
  }
  clearTimeout(timer);
  if (!data || !data.success) {
    console.warn(`[VocabRadar][sw][${_ts()}] subs-cloud download 失败: HTTP ${res && res.status}`, data && (data.code || data.error));
    return { ok: false, error: (data && data.code) || (data && data.error) || `HTTP ${res && res.status}`, message: data && data.error };
  }
  await chrome.storage.local.set({
    [CLOUD_CACHE_PREFIX + msg.videoKey]: {
      content: data.content,
      cues: Array.isArray(data.cues) ? data.cues : null,
      subtitleId: msg.id,
      kind: data.kind || '',
      model: data.model || '',
      durationSec: data.durationSec || 0,
      charged: data.charged || 0,
      fetchedAt: Date.now(),
    },
  });
  log(`[VocabRadar][sw][${_ts()}] subs-cloud download 成功: charged=`, data.charged, 'bytes=', (data.content || '').length);
  await saveConsumedEntry(msg, { ...data, subtitleId: msg.id, kind: data.kind });
  return { ok: true, cached: false, content: data.content, cues: data.cues || null, charged: data.charged, durationSec: data.durationSec, model: data.model };
}

// 侧栏评价入口（P5）：查当前视频的云端行 id（缓存条目的 subtitleId）——
// null=非云端版本（本地 ASR/官方轨道），侧栏如实提示无可评价对象
async function cloudMeta(msg) {
  const cached = await cloudCacheGet(msg.videoKey);
  return { ok: true, subtitleId: cached && cached.subtitleId ? cached.subtitleId : null };
}

// ---- ⑤ 评价与纠错（P5 2026-10-18） ----
// 投票代理：GET 读票态 / POST 投票（{id, vote?, stars?}，vote/stars 缺省=只读）。
// 错误恒留痕（console.warn），不吞
async function subsVote(msg) {
  const token = await getValidAccessToken();
  if (!token) return { ok: false, error: 'not-connected' };
  const hasBallot = msg.vote != null || msg.stars != null;
  let res, data = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    res = await fetch(`${siteUrl()}/api/subs/${encodeURIComponent(msg.id)}/vote`, {
      method: hasBallot ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: hasBallot ? JSON.stringify({ vote: msg.vote ?? null, stars: msg.stars ?? null }) : undefined,
      signal: ctrl.signal,
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[VocabRadar][sw][${_ts()}] subs-vote 网络失败:`, String(e && e.message || e));
    return { ok: false, error: 'network', message: String(e && e.message || e) };
  }
  clearTimeout(timer);
  if (!data || !data.success) {
    console.warn(`[VocabRadar][sw][${_ts()}] subs-vote 失败: HTTP ${res && res.status}`, data && data.error);
    return { ok: false, error: (data && data.error) || `HTTP ${res && res.status}` };
  }
  return { ok: true, ...data };
}

// 纠错上传（方案 §5「纠错 = 上传新版本」）：显式动作不走自动共享开关，但必须登录。
// 服务端校验被修订轨存在且同 (platform,video_id,lang)
async function subsCorrect(msg) {
  const token = await getValidAccessToken();
  if (!token) return { ok: false, error: 'not-connected' };
  const p = msg.payload || {};
  let res, data = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    res = await fetch(`${siteUrl()}/api/subs/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        platform: p.platform, videoId: p.videoId, lang: p.lang,
        kind: p.kind || 'asr', model: p.model || 'manual-fix',
        durationSec: p.durationSec, content: p.content,
        cues: Array.isArray(p.cues) ? p.cues : null,
        title: p.title || '', derivedFrom: p.derivedFrom,
      }),
      signal: ctrl.signal,
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[VocabRadar][sw][${_ts()}] subs-correct 网络失败:`, String(e && e.message || e));
    return { ok: false, error: 'network', message: String(e && e.message || e) };
  }
  clearTimeout(timer);
  if (!data || !data.success) {
    console.warn(`[VocabRadar][sw][${_ts()}] subs-correct 失败: HTTP ${res && res.status}`, data && data.error);
    return { ok: false, error: (data && data.error) || `HTTP ${res && res.status}` };
  }
  // mine 如实透传：内容与既有行撞车（duplicate）且行属他人时，库端不得回填
  // shared 态（否则本地条目挂到别人行上，取消分享必报 not-owner）
  return { ok: true, subtitle: data.subtitle, duplicate: !!data.duplicate, mine: !!data.mine };
}

// ---- ④ 从后端导入（20261017 用户令：本地后端攒了很多字幕，字幕库只有三条）----
// GET /api/asr/cache 清单 + /api/asr/cache/<key> 详情 → 逐条入本地库。
// 门控：engine='official'（平台字幕直出，非 ASR 产物）跳过；VAD 覆盖率 <2% 视为
//   无人声（whisper 对静音会幻觉出文本）跳过；正文 <20 字符跳过；同 (平台,视频号,
//   语言) 已在库跳过。缓存键形如 `bilibili-BV..`（platform-videoId）或文件任务
//   的内容哈希（无平台语义 → local）。
async function backendImport() {
  let items = []
  try {
    const res = await fetch(BACKEND_BASE_DEFAULT + '/api/asr/cache', { cache: 'no-store' })
    const data = await res.json().catch(() => null)
    if (!data || !data.ok || !Array.isArray(data.items)) {
      console.warn(`[VocabRadar][sw][${_ts()}] subs-import 清单失败: HTTP ${res.status}`);
      return { ok: false, error: `HTTP ${res.status}` }
    }
    items = data.items
  } catch (e) {
    console.warn(`[VocabRadar][sw][${_ts()}] subs-import 后端不可达:`, String(e && e.message || e));
    return { ok: false, error: String(e && e.message || e) }
  }
  const existing = await listSubs()
  const seen = new Set(existing.map((r) => `${r.platform}|${r.videoId}|${r.lang}`))
  let imported = 0, skipped = 0
  for (const it of items) {
    try {
      if (it.engine === 'official') { skipped++; continue }
      const cov = Array.isArray(it.coverage) ? it.coverage : null
      if (cov && it.duration > 0) {
        const covered = cov.reduce((a, r) => a + Math.max(0, (r[1] || 0) - (r[0] || 0)), 0)
        if (covered / it.duration < 0.02) { skipped++; continue } // 无人声
      }
      const det = await fetch(BACKEND_BASE_DEFAULT + '/api/asr/cache/' + encodeURIComponent(it.key), { cache: 'no-store' })
        .then((r) => r.json()).catch(() => null)
      const entry0 = det && det.ok && det.entry
      const segs = (entry0 && Array.isArray(entry0.segments)) ? entry0.segments : []
      const content = segs.map((s) => (s.text || '').trim()).filter(Boolean).join('\n').trim()
      if (content.length < 20) { skipped++; continue }
      // 反幻觉门控（20261017）：语速超限/复读文本不导入
      if (isGarbageAsr(content, Number(entry0?.duration || it.duration) || 0)) { skipped++; continue }
      const dash = String(it.key || '').indexOf('-')
      let platform = dash > 0 ? it.key.slice(0, dash) : 'local'
      let videoId = dash > 0 ? it.key.slice(dash + 1) : it.key
      if (!['bilibili', 'youtube'].includes(platform)) { platform = 'local'; videoId = 'local-' + it.key }
      const lang = String(entry0?.language || it.language || 'en').split('-')[0].toLowerCase()
      const dedupe = `${platform}|${videoId}|${lang}`
      if (seen.has(dedupe)) { skipped++; continue }
      seen.add(dedupe)
      await saveSub(makeEntry({
        platform, videoId, lang, kind: 'asr',
        title: '',
        durationSec: Math.ceil(Number(entry0?.duration || it.duration) || 0),
        model: `backend/${it.engine || ''}`,
        content,
        cues: segs.map((s) => ({ start: s.start || 0, end: s.end || 0, text: (s.text || '').trim() }))
          .filter((c) => c.text),
        harvestedAt: Date.now(),
      }))
      imported++
    } catch (e) {
      console.warn(`[VocabRadar][sw][${_ts()}] subs-import 单条失败:`, it && it.key, String(e && e.message || e));
      skipped++
    }
  }
  log(`[VocabRadar][sw][${_ts()}] subs-import 完成: imported=`, imported, 'skipped=', skipped)
  return { ok: true, imported, skipped }
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
  if (msg.type === 'vocabradar:subs-cloud-lookup') {
    cloudLookup(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'vocabradar:subs-cloud-download') {
    cloudDownload(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'vocabradar:subs-cloud-meta') {
    cloudMeta(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'vocabradar:subs-vote') {
    subsVote(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'vocabradar:subs-correct') {
    subsCorrect(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'vocabradar:subs-backend-import') {
    backendImport().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  return false; // 其余放行给其他监听者
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  pollPendingJobs().then(() => sweepExpiredHarvests()).catch(() => {});
});
