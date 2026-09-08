// ========== G3（2026-09-08）：learn 面板「导入到我的卷轴」草稿导出 ==========
// 契约：docs/网站升级阶段二-边界与原型.md §4.3（卷轴草稿协议）+ §6.2（learn 面板按钮行）
// 桥协议：网站侧 src/utils/draftBridge.js 头注释（内容脚本桥推送，两端同步约束）
//
// 数据源（./core.js 共享状态，scanner 已去重；沿用 ui.js 头注释约束不另存副本）：
//   text  = _pageSentences 各句拼接（无正文返回 null，调用方 toast 提示，不静默）
//   words = _allAnnotations 词面（保持出现序，trim+小写去重）
//   lang  = _cachedLearnLang；title = 页面 title（网站侧对空 title 有正文首行兜底）
// 缓存：chrome.storage.local['vocabradarDraftScrolls']（数组，无条数上限，D5）
// 幂等：id = 'ext-' + djb2(href|title) 稳定 id；同 id 重存 version+1——网站侧
//   importDrafts 按 id+version 幂等（桥重复推送不重复计数，内容变化才更新卡片）

import { _allAnnotations, _cachedLearnLang, _pageSentences, log } from './core.js';

// 网站地址（「并且打开」跳转目标；生产域名定稿时单点改此常量）
export const SITE_URL = 'https://localhost:3005';

// 草稿缓存 key（扩展 camelCase 风格，语义对齐网站侧 vocabradar_local_scrolls）
export const DRAFT_CACHE_KEY = 'vocabradarDraftScrolls';

// djb2 字符串哈希（仅用于稳定 id，非安全用途）
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// buildDraftFromSidebar：当前侧栏正文+生词 → §4.3 草稿投影；无正文返回 null
export function buildDraftFromSidebar() {
  const text = _pageSentences.map((s) => String((s && s.text) || '')).join('\n').trim();
  if (!text) return null;
  const title = (document.title || '').trim() || location.hostname;
  const words = [];
  const seen = new Set();
  for (const a of _allAnnotations) {
    const w = (a && typeof a.word === 'string') ? a.word.trim() : '';
    if (!w) continue;
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    words.push(w);
  }
  return {
    id: 'ext-' + djb2(location.href + '|' + title),
    title: title,
    lang: _cachedLearnLang || 'en',
    text: text,
    words: words,
    source: { type: 'extension', url: location.href },
    version: 1,
    createdAt: Date.now(),
  };
}

// saveDraftToCache：草稿 upsert 进扩展缓存（同 id：version+1 并保留首建时间）
// storage 异常直接抛出（调用方 catch 后 toast「导入失败」，R1 不静默）
export async function saveDraftToCache(draft) {
  const res = await chrome.storage.local.get({ [DRAFT_CACHE_KEY]: [] });
  const list = Array.isArray(res[DRAFT_CACHE_KEY]) ? res[DRAFT_CACHE_KEY].slice() : [];
  const idx = list.findIndex((d) => d && d.id === draft.id);
  if (idx >= 0) {
    draft.version = (Number(list[idx].version) || 0) + 1;
    if (Number.isFinite(list[idx].createdAt)) draft.createdAt = list[idx].createdAt;
    list[idx] = draft;
  } else {
    list.push(draft);
  }
  await chrome.storage.local.set({ [DRAFT_CACHE_KEY]: list });
  return draft;
}

// importCurrentSidebarDraft：learn 面板按钮入口——组装+落缓存
// 返回 { ok:true, draft } 或 { ok:false, reason:'empty' }；storage 失败直接抛出
export async function importCurrentSidebarDraft() {
  const draft = buildDraftFromSidebar();
  if (!draft) return { ok: false, reason: 'empty' };
  const saved = await saveDraftToCache(draft);
  log('[VocabRadar][draft-export] 已写入扩展缓存 id=' + saved.id + ' version=' + saved.version + ' words=' + saved.words.length);
  return { ok: true, draft: saved };
}