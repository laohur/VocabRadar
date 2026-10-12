// =============================================================================
// vs/auto-share.js —— ASR 停止时分流（P3 2026-10-08 用户裁定交互）
// -----------------------------------------------------------------------------
// 规则（用户令）：只有**完整识别**的字幕才算合格——用户中途停止 ASR 或离开视频时，
//   backend 任务不废弃：① 任务已完成 → 从缓存收割完整字幕就地入本地库，
//   开着「自动共享字幕」则随即自动上传；② 任务进行中 → 把 jobId 交接给 SW
//   （sw/subs-share.js，alarm 续拉 backend 直到完整，完整后入库/按开关上传）。
// 上传资格由字幕作者判定：字幕库页顶部的自动共享开关只是"完成后是否自动上传"的
//   快捷方式，作者随时可按条 分享/取消分享/删除。
// 通道：入库走 lib/subs-library.js（IndexedDB）；上传经 SW 消息
//   'vocabradar:subs-autopublish'（token 续签与站点 fetch 全在 SW）。
// =============================================================================

import { getCachedSubtitles } from '../../lib/asr-client.js';
import { makeVideoKey } from './dom-utils.js';
import { makeEntry, saveSub } from '../../lib/subs-library.js';
import { log } from './logger.js';

// location → {platform, videoId}：bilibili 取 BV 号，youtube 取 v 参数，其余用 videoKey
function parsePlatformVideo() {
  try {
    const u = new URL(location.href);
    if (/(^|\.)bilibili\.com$/.test(u.hostname)) {
      const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
      if (m) return { platform: 'bilibili', videoId: m[1] };
      const ep = u.searchParams.get('ep_id');
      if (ep) return { platform: 'bilibili', videoId: 'ep' + ep };
    }
    if (/(^|\.)youtube\.com$/.test(u.hostname) || u.hostname === 'youtu.be') {
      const v = u.searchParams.get('v') || u.pathname.slice(1);
      if (v) return { platform: 'youtube', videoId: v };
    }
  } catch (e) { /* 解析失败走兜底 */ }
  return { platform: 'web', videoId: makeVideoKey() };
}

function storageGet(defaults) {
  return new Promise((res) => chrome.storage.local.get(defaults, (r) => res(r)));
}

// 从 ASR 缓存收割完整字幕并入库（shareState=local；上传由调用方按开关决定）
async function harvestAndIngest(videoKey, meta) {
  const cached = await getCachedSubtitles(videoKey);
  const segs = (cached && cached.segments) || [];
  const lines = segs.map((s) => (s && s.text) || '').filter(Boolean);
  const content = lines.join('\n').trim();
  if (content.length < 20) return null; // 过短内容不入库（误触/无有效语音）
  const last = segs[segs.length - 1];
  const durationSec = last && Number.isFinite(last.speechEnd) && last.speechEnd > 0
    ? Math.ceil(last.speechEnd)
    : (last && Number.isFinite(last.listenEnd) && last.listenEnd > 0 ? Math.ceil(last.listenEnd) : 0);
  const entry = makeEntry({
    platform: meta.platform,
    videoId: meta.videoId,
    lang: meta.lang,
    kind: 'asr',
    title: meta.title,
    durationSec,
    model: `backend/${meta.modelSize || 'unknown'}`,
    content,
  });
  await saveSub(entry);
  return entry;
}

// stopASRInternal 在 stopASR() **之前**取快照、清理之后调用本函数（fire-and-forget）
export function onAsrStopped(handoff) {
  (async () => {
    try {
      const h = handoff || {};
      const videoKey = makeVideoKey();
      const { platform, videoId } = parsePlatformVideo();
      const st = await storageGet({ learnLanguage: 'en' });
      const meta = {
        platform,
        videoId,
        lang: st.learnLanguage,
        modelSize: h.modelSize || '',
        title: '',
      };

      if (h.completed) {
        // 任务已完成：缓存即完整字幕，就地入库
        const entry = await harvestAndIngest(videoKey, meta);
        if (!entry) return;
        log('[VocabRadar][auto-share] 完整字幕已入库:', platform + '/' + videoId);
        // 开关开着 → 自动上传（SW 门控再校验一次开关，双端一致）
        chrome.runtime.sendMessage(
          {
            type: 'vocabradar:subs-autopublish',
            videoKey,
            payload: {
              platform: entry.platform,
              videoId: entry.videoId,
              lang: entry.lang,
              kind: entry.kind,
              model: entry.model,
              durationSec: entry.durationSec,
              content: entry.content,
              title: entry.title,
            },
          },
          (res) => {
            const err = chrome.runtime.lastError; // 必须读
            if (err) { log('[VocabRadar][auto-share] 发布消息失败:', err.message); return; }
            if (res && res.ok) log('[VocabRadar][auto-share] 已自动共享:', res.duplicate ? '(内容未变跳过)' : platform + '/' + videoId);
            else log('[VocabRadar][auto-share] 未自动共享:', res && res.error);
          },
        );
        return;
      }

      if (h.jobId) {
        // 任务进行中：交接 SW 续拉到完整（用户已停止/离开也不中断）
        chrome.runtime.sendMessage(
          {
            type: 'vocabradar:subs-job-handoff',
            videoKey,
            jobId: h.jobId,
            after: h.after || 0,
            meta: { ...meta, sourceUrl: location.href },
          },
          (res) => {
            const err = chrome.runtime.lastError; // 必须读
            if (err) { log('[VocabRadar][auto-share] 交接失败:', err.message); return; }
            log('[VocabRadar][auto-share] backend 任务已交接 SW 续拉:', h.jobId);
          },
        );
      }
    } catch (e) {
      log('[VocabRadar][auto-share] 异常:', e);
    }
  })();
}
