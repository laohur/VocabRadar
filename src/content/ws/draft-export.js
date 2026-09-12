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

// 站点地址（「并且打开」跳转目标）。
// 274次（用户裁定"本地版本跳本地，线上版本跳线上"）：按安装来源动态判定——
//   商店/AMO 正式安装的扩展 manifest 带 update_url → 线上站 vocabradar.com；
//   本地开发/解包加载（无 update_url）→ 本地站 https://localhost:3001。
//   之前是单一常量（本地 localhost），线上安装的用户点 learn 会跳到打不开的 localhost。
// 281次修正：3005 是 274 次凭空定的端口，未核对网站侧 vite.config.js（port:3001+
//   mkcert https）——以网站实际端口 3001 为准，别再臆造。
const SITE_URL_LOCAL = 'https://localhost:3001';
const SITE_URL_ONLINE = 'https://vocabradar.com';
let _siteUrl = null;
export function getSiteUrl() {
  if (_siteUrl) return _siteUrl;
  let online = false;
  try {
    const m = chrome.runtime.getManifest();
    online = !!(m && m.update_url);
  } catch (e) {
    console.warn('[VocabRadar][draft-export] getManifest 失败，按本地站处理:', e);
  }
  _siteUrl = online ? SITE_URL_ONLINE : SITE_URL_LOCAL;
  log('[VocabRadar][draft-export] 站点判定:', _siteUrl, '(update_url=', online, ')');
  return _siteUrl;
}

// 草稿缓存 key（扩展 camelCase 风格，语义对齐网站侧 vocabradar_local_scrolls）
export const DRAFT_CACHE_KEY = 'vocabradarDraftScrolls';

// djb2 字符串哈希（仅用于稳定 id，非安全用途）
// 274次：导出别名供视频侧栏草稿（id 前缀 ext-v-）复用同一哈希。
// 275次修复：上一轮重构误删了 djb2 函数本体导致 importCurrentSidebarDraft 抛
// ReferenceError: djb2 is not defined（草稿导入全挂）——本体回归，教训：删函数
// 前先 grep 全部调用点，"只是加导出别名"也必须保留被别名的原函数。
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
export function djb2Hash(str) {
  return djb2(str);
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