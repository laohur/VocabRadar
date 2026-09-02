// ============================================================
// 文件职责：SW 消息通道与 DIRECT_IDB 路由（src/lib/word-db/sw-channel.js）
// 来源：拆分自 src/lib/word-db.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// 原 word-db.js 的全部 11 个对外导出符号集中在本文件（门面 word-db.js 仅
//   re-export，符号名不变，所有引用方零改动）：
//   getWord / getWordsBatch / putWord / updateFields / clearByLang / clearAll /
//   getLangProjection / bulkWriteDictionary / getDictCache / setDictCache /
//   handleWordDbMessage
// 路由规则（与拆分前完全一致）：DIRECT_IDB（现恒 false）直连优先 -> isSW 直接
//   操作 IDB（db-ops.js）-> runtimeValid 时 chrome.runtime.sendMessage 经 SW
//   代为操作。handleWordDbMessage 为 SW 侧 WORD_DB_*/DICT_CACHE_*/LEMMAS_*/
//   LEMMATIZE_WORD 消息分发器（service-worker.js 注册调用），消息类型字符串
//   逐字保留未动。
// ============================================================

import { isSW, DIRECT_IDB, runtimeValid } from './env.js';
import { makeKey } from './key-utils.js';
import {
  idbGet, idbGetBatch, idbPut, idbUpdate, idbClearByLang, idbClearAll,
  idbBulkWrite, idbGetLangProjection, idbDictGet, idbDictMerge
} from './db-ops.js';
import { _projCache } from './projection-cache.js';
import { lemmasLoad, swLemmatizeWord } from './lemmas-engine.js';

export async function getWord(lang, word) {
  if (!lang || !word) return null;
  const key = makeKey(lang, word);
  // 第一百五十二次：直连优先
  if (DIRECT_IDB) {
    try { return await idbGet(key); } catch (e) { /* SW 兜底 */ }
  }
  if (isSW) {
    try { return await idbGet(key); } catch (e) { return null; }
  }
  if (!runtimeValid()) return null;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'WORD_DB_GET', lang, word });
    return resp && resp.ok ? resp.record : null;
  } catch (e) {
    return null;
  }
}

/**
 * 批量读取单词记录（减少消息往返）
 * @param {string} lang
 * @param {string[]} words
 * @returns {Promise<Array<object|null>>}
 */
export async function getWordsBatch(lang, words) {
  if (!lang || !words || words.length === 0) return [];
  if (isSW) {
    const keys = words.map((w) => makeKey(lang, w));
    try { return await idbGetBatch(keys); } catch (e) {
      return words.map(() => null);
    }
  }
  if (!runtimeValid()) return words.map(() => null);
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'WORD_DB_GET_BATCH', lang, words });
    return resp && resp.ok ? resp.records : words.map(() => null);
  } catch (e) {
    return words.map(() => null);
  }
}

/**
 * 写入完整记录（覆盖）
 * @param {object} record 必须含 key/lang/word
 */
export async function putWord(record) {
  if (!record || !record.key) return;
  if (isSW) {
    try { await idbPut(record); } catch (e) { /* ignore */ }
    return;
  }
  if (!runtimeValid()) return;
  try {
    await chrome.runtime.sendMessage({ type: 'WORD_DB_PUT', record });
  } catch (e) { /* ignore */ }
}

/**
 * 部分更新（合并 patch 到现有记录，不存在则创建）
 * 反思：用于 translation/phonetic 等字段的独立更新。
 *   rank/lemma/tags 由 lookupFull 一次性写入，不通过此函数。
 * @param {string} lang
 * @param {string} word
 * @param {object} patch 待合并字段（如 { translation: "你好", translationLang: "zh" }）
 */
export async function updateFields(lang, word, patch) {
  if (!lang || !word || !patch) return;
  const key = makeKey(lang, word);
  // 第一百五十二次：直连优先
  if (DIRECT_IDB) {
    try { await idbUpdate(key, patch); } catch (e) { /* ignore */ }
    return;
  }
  if (isSW) {
    try { await idbUpdate(key, patch); } catch (e) { /* ignore */ }
    return;
  }
  if (!runtimeValid()) return;
  try {
    await chrome.runtime.sendMessage({ type: 'WORD_DB_UPDATE', lang, word, patch });
  } catch (e) { /* ignore */ }
}

/**
 * 清空指定语言的记录
 * @param {string} lang
 * @returns {Promise<number>} 删除条数
 */
export async function clearByLang(lang) {
  if (!lang) return 0;
  if (isSW) {
    try { return await idbClearByLang(lang); } catch (e) { return 0; }
  }
  if (!runtimeValid()) return 0;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'WORD_DB_CLEAR_LANG', lang });
    return resp && resp.ok ? resp.cleared : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * 清空全部记录
 * @returns {Promise<void>}
 */
export async function clearAll() {
  if (isSW) {
    try { await idbClearAll(); } catch (e) { /* ignore */ }
    return;
  }
  if (!runtimeValid()) return;
  try {
    await chrome.runtime.sendMessage({ type: 'WORD_DB_CLEAR_ALL' });
  } catch (e) { /* ignore */ }
}

// === 词典批量写入与投影读取（2026-08-20 第八十五次）===
// 用户设计（readme："只有词典会缓存，词频等不会缓存，因为词频等会存入词典中，
//   是词典的字段之一""装载词频、词表等送入词典，之后只有数据损坏不全才会再次启用装载函数"）。
// 故 wordfreq 的 rank / wordlists 的 tags 一次性写入 words store 记录字段（词典字段），
//   页面每次加载从词典（words store）读取投影构建 Map，不再有独立的词频/词表缓存（dictCache）。
// 词典构建完成标记：word='__built__' 的记录（rank=0），投影读取时置 built=true。

/**
 * SW：批量写入/合并词典字段（仅 SW，内存读-合并后单事务写）
 * 反思：IDB 不支持部分字段更新；旧版逐条 get->merge->put 在 5 万+ 词条时过慢。
 *   先经 by-lang 游标把 lang 全部现有记录读入内存 Map，合并 rank/tags 后单事务 put，
 *   保留已存在的 translation/phonetic/lemma 字段，互不覆盖。
 * @param {string} lang
 * @param {Array<{word:string, rank?:number, tags?:string[]}>} entries
 */
// （第一百一十九次：idbBulkWrite / idbGetLangProjection 已上移为分表实现）
export async function getLangProjection(lang) {
  if (!lang) return null;
  // 第一百五十二次：直连优先（Chromium CS/扩展页共享扩展源 IDB）
  if (DIRECT_IDB) {
    try { return await idbGetLangProjection(lang); } catch (e) { /* 落入 SW 兜底 */ }
  }
  if (isSW) {
    try { return await idbGetLangProjection(lang); } catch (e) { return null; }
  }
  if (!runtimeValid()) return null;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'WORD_DB_GET_LANG_PROJ', lang });
    return resp && resp.ok ? resp.proj : null;
  } catch (e) { return null; }
}

// === 词典投影预热（第一百九十一次）===
// 用户两问：「IndexedDB 必须每个网页打开一个吗？能一打开网页就读取而不是等到网页加载完？」
// 架构事实（env.js L52，154 次勘误）：IDB 唯一属主 = SW，页面经消息取投影；但 MV3 SW
// 闲置 ~30s 休眠即清空 _projCache（内存态），下一页首请求要付「SW 冷启动 + 全表扫描 +
// 大消息传输」全价（实测 4448ms）。预热策略（调研 Dark Reader 等 MV3 开源实践：唤醒即
// 重建内存态）：
//   1. warmupDictProjection：SW 每次被唤醒，service-worker.js 顶层立即后台装载当前源
//      语言投影填 _projCache——扫库与页面加载并行，请求到达时通常已热。
//   2. WORD_DB_PROJ_PREFETCH：document_start 预取脚本（dict-prefetch.js）在网页打开
//      瞬间发消息唤醒 SW——比 document_idle 主脚本提前数秒触发预热（「一打开网页就读取」）。
// 防并发：同一唤醒周期共用一个 in-flight Promise；失败静默（预热失败不影响按需读取）。

// === 第二百零三次引入、第二百零六次升级：投影的 chrome.storage.local 二级缓存 ===
// storage.session 只跨 SW 重启，每浏览器会话仍要首次扫库（Firefox 实测 5.8~11.2s，
//   且"第一个页面一直在扫"即此）；改 storage.local 跨会话存活——词典内容变化经四处
//   失效点删键，此后首开页面即命中（读 ~2MB 键 + 消息传输，百 ms 级）。
// 单键分语言桶：projCache = { en: {...}, ... }，读写都在 SW 单线程内无竞态；
// 配额受限（Firefox local ~5MB / Chrome 10MB，投影约 2MB/语言）时静默跳过，回退扫库。
const PROJ_LOCAL_KEY = 'projCache';

async function projLocalReadAll() {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
    const res = await chrome.storage.local.get(PROJ_LOCAL_KEY);
    const v = res && res[PROJ_LOCAL_KEY];
    return (v && typeof v === 'object') ? v : {};
  } catch (e) { return null; }
}

function projLocalWriteAll(all) {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    const r = chrome.storage.local.set({ [PROJ_LOCAL_KEY]: all });
    if (r && typeof r.catch === 'function') r.catch(() => { /* 配额受限等静默 */ });
  } catch (e) { /* ignore */ }
}

async function projLocalGet(lang) {
  const all = await projLocalReadAll();
  const v = all && all[lang];
  // 第二百一十次（火狐重症根因）：缓存命中必须带 **built** 标记——meta 读取偶发失败
  //   会产出缺 built 的残缺投影，一旦落盘，每个页面都判"缺 __built__"而触发源重建，
  //   重建的逐块写库把 SW 埋掉（实测：词典就绪永不到来、查询饿死、词表 0）。
  //   读侧拒绝无 built 条目＝毒缓存自愈（按 miss 走新扫库，built 后覆盖写回）。
  return (v && v.built && v.ranks && Object.keys(v.ranks).length > 0) ? v : null;
}

function projLocalDel(lang) {
  projLocalReadAll().then((all) => {
    if (!all || !(lang in all)) return;
    delete all[lang];
    projLocalWriteAll(all);
  }).catch(() => { /* ignore */ });
}

function projLocalClearAll() {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    const r = chrome.storage.local.remove(PROJ_LOCAL_KEY);
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (e) { /* ignore */ }
}

/** 投影读取唯一入口：_projCache 命中直返 → storage.local 二级缓存次之 → 扫库并填两级缓存
 * （warmup 与消息路径共用） */
async function loadProjCached(lang) {
  let proj = _projCache.get(lang);
  if (!proj) {
    // 第二百零六次：先查 storage.local（跨会话存活），未命中才扫库
    proj = await projLocalGet(lang);
  }
  if (!proj) {
    proj = await idbGetLangProjection(lang);
    try {
      // 第二百一十次：只落盘 **built** 投影（meta 读取偶发失败产出的残缺投影绝不落盘，
      //   否则每个页面都会判"缺 __built__"而重建，SW 被逐块写库埋掉——火狐重症根因）
      if (!proj || !proj.built) {
        console.warn('[VocabRadar][word-db] 投影缺 built 标记，跳过 local 缓存（防毒化）');
      } else {
        // 第二百零九次：写入前体积保险——单语言投影超 4MB（JSON 序列化后）不写
        //   storage.local（Firefox local 配额约 5MB，超限写入行为不可控），只留内存缓存
        const probe = JSON.stringify(proj);
        if (probe.length <= 4 * 1024 * 1024) {
          const all = (await projLocalReadAll()) || {};
          all[lang] = proj;
          projLocalWriteAll(all);
        } else {
          console.warn('[VocabRadar][word-db] 投影过大（' + probe.length + ' 字符）跳过 local 缓存，仅内存');
        }
      }
    } catch (e) { /* ignore */ }
  }
  _projCache.set(lang, proj);
  return proj;
}

let _warmupPromise = null; // in-flight 预热 Promise（防同一唤醒周期重复扫库）

/**
 * SW 唤醒即预热词典投影（service-worker.js 顶层调用 + WORD_DB_PROJ_PREFETCH 消息触发）
 * @returns {Promise<{lang:string, ok:boolean, ms:number}>} 预热结果（仅诊断用）
 */
export async function warmupDictProjection() {
  if (_warmupPromise) return _warmupPromise;
  _warmupPromise = (async () => {
    let lang = 'en';
    try {
      const res = await chrome.storage.local.get(['learnLanguage']);
      lang = (res && res.learnLanguage) || 'en';
    } catch (e) { /* storage 不可用时用默认语言 */ }
    const t0 = Date.now();
    try {
      await loadProjCached(lang);
      return { lang, ok: true, ms: Date.now() - t0 };
    } catch (e) {
      return { lang, ok: false, ms: Date.now() - t0 };
    }
  })();
  return _warmupPromise;
}

/** 写库成功后通知 SW 失效其内存投影缓存（fire-and-forget，失败忽略） */
function notifyProjDirty(lang) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'WORD_DB_PROJ_CACHE_INVALIDATE', lang }, () => { void chrome.runtime.lastError; });
    }
  } catch (e) { /* ignore */ }
}

// SW 侧批量构建会话缓存（分块累积，final=true 时一次性写库并打构建标记）
// 反思（2026-08-20 第八十五次）：CS->SW 巨型消息不可靠（第五十七次教训），
//   批量写入分块（约 3000 条/块）累积到 SW，最后一块才真正写 IDB，避免逐块重复全量读。
const _bulkSessions = new Map(); // buildId -> { lang, entries: Map<word, {rank?,tags?}> }

/**
 * 将词频 rank / 词表 tags 送入词典（跨上下文）
 * 反思（2026-08-20 第八十五次）：装载函数（loadWordfreq/loadWordlists）与词典无关，
 *   只在词典缺失/不全时启用，装载完成后经本函数把 rank/tags 写入词典（words store），
 *   并写入 '__built__' 标记。此后页面每次加载只从词典读投影，不再读源文件。
 * 反思（2026-08-21 第八十八次）：词典只有一个--调用方只传一个统一词典 Map
 *   （Map<word, {rank?, tags?}>），rank/tags 是同一词条的两个字段，不再分两张表。
 * @param {string} lang
 * @param {Map<string,{rank?:number|null,tags?:string[]}>|null} dictMap 统一词典 Map
 */
export async function bulkWriteDictionary(lang, dictMap, expected) {
  if (!lang) return;
  const buildId = lang + ':' + Date.now();
  const entries = [];
  if (dictMap) for (const [word, e] of dictMap) entries.push({ word, rank: e && e.rank, tags: e && e.tags });
  const CHUNK = 1200; // 第一百五十四次：3000->1200，小事务降低事件页长任务风险
  // 第一百三十九次·致命缺陷修复：任一块失败立即中止且不打标记；
  // 标记条目并入最后一个数据块同一事务（原子：数据与标记同生共死）。
  // 第一百四十次：expected（实际词条数）随末块写入 meta，供完整性校验用实际值。
  // 第一百五十四次：块间 yield 25ms 防 SW 长任务饥饿；失败透传底层 error。
  let allOk = true;
  let lastErr = '';
  const nChunks = Math.max(1, Math.ceil(entries.length / CHUNK));
  for (let i = 0, ci = 0; i < entries.length || ci === 0; i += CHUNK, ci++) {
    const chunk = entries.slice(i, i + CHUNK);
    const isFinal = (i + CHUNK >= entries.length);
    if (isFinal) chunk.push({ word: '__built__', rank: 0 }); // 原子标记
    let ok = false;
    try {
      if (isSW) {
        await idbBulkWrite(lang, chunk, isFinal ? expected : undefined);
        ok = true;
      } else if (runtimeValid()) {
        const resp = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({
              type: 'WORD_DB_BULK_WRITE', lang, entries: chunk, final: isFinal,
              expected: isFinal ? expected : undefined
            }, (r) => {
              if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
              resolve(r || { ok: false, error: 'no response' });
            });
          } catch (err) { resolve({ ok: false, error: String((err && err.message) || err) }); }
        });
        ok = !!(resp && resp.ok);
        if (!ok && resp && resp.error) lastErr = resp.error;
      }
    } catch (e) {
      ok = false;
      lastErr = String((e && e.message) || e);
    }
    if (!ok) {
      allOk = false;
      console.warn(`[VocabRadar][word-db][bulkWrite] 分块 ${ci + 1}/${nChunks} 写入失败--中止且不打构建标记。原因: ${lastErr || '(未知)'}`);
      break;
    }
    if (ci < nChunks - 1) await new Promise((r) => setTimeout(r, 25)); // 块间让出
  }
  if (!allOk || entries.length === 0) return false;
  // 直写成功：让 SW 失效其内存投影缓存（后台仅刷新缓存--用户架构裁定）
  notifyProjDirty(lang);
  return true;
}

// === 词典整表缓存（遗留） ===
// 反思（2026-08-20 第八十六次）：getDictCache/setDictCache 及其消息分支（DICT_CACHE_GET/SET）
//   是 v85 词典架构更正前的"整表缓存"遗留（wordfreq 源词表数组曾缓存于此）。
//   v85 起 wordfreq/wordlists 改为经 bulkWriteDictionary 直接写入 words store（唯一词典），
//   dictionary.js 已不再调用本组函数--保留导出仅为兼容旧消息/旧代码路径，无活跃调用方。
/**
 * 读取词典整表缓存（跨上下文）
 * @param {string} lang
 * @returns {Promise<{version?:string,words?:string[],lemmas?:object,ambiguity?:object|null,time:number}|null>}
 */
export async function getDictCache(lang) {
  if (!lang) return null;
  if (isSW) {
    try { return await idbDictGet(lang); } catch (e) { return null; }
  }
  if (!runtimeValid()) return null;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'DICT_CACHE_GET', lang });
    return resp && resp.ok ? resp.cache : null;
  } catch (e) {
    return null;
  }
}

/**
 * 写入/合并词典整表缓存（跨上下文）
 * 反思（2026-08-13 第五十三次）：统一词典--调用方传 patch 对象（读-合并-写），
 *   兼容旧签名 (lang, version, words)。
 * @param {string} lang
 * @param {object|string} patchOrVersion
 *   - 新签名：{ version?, words?[], lemmas?{}, ambiguity?, time? }（words/lemmas 至少其一）
 *   - 旧签名：version 字符串 + words 数组（内部转为 patch）
 * @param {string[]} [maybeWords] 旧签名用：按频率降序的单词数组（rank=index+1）
 */
export async function setDictCache(lang, patchOrVersion, maybeWords) {
  if (!lang) return;
  let patch;
  if (typeof patchOrVersion === 'string') {
    // 旧签名 (lang, version, words)
    if (!Array.isArray(maybeWords) || maybeWords.length === 0) return;
    patch = { version: patchOrVersion, words: maybeWords };
  } else if (patchOrVersion && typeof patchOrVersion === 'object') {
    patch = patchOrVersion;
  } else {
    return;
  }
  // 至少含 words 或 lemmas 才写入（空 patch 直接忽略）
  if (!patch.words && !patch.lemmas) return;
  const value = Object.assign({}, patch, { time: Date.now() });
  if (isSW) {
    try { await idbDictMerge(lang, value); } catch (e) { /* ignore */ }
    return;
  }
  if (!runtimeValid()) return;
  try {
    await chrome.runtime.sendMessage({ type: 'DICT_CACHE_SET', lang, value });
  } catch (e) { /* ignore */ }
}

/**
 * SW 消息处理器注册（仅 SW 调用）
 * 在 service-worker.js 的 onMessage 监听器中调用此函数处理 WORD_DB_* 消息。
 * 反思：将消息分发逻辑放在 word-db.js 中，service-worker.js 只需一行调用，
 *   保持 SW 主文件简洁。
 * @param {object} msg
 * @param {object} sender
 * @param {function} sendResponse
 * @returns {boolean} true 表示异步响应
 */
export async function handleWordDbMessage(msg, sender, sendResponse) {
  if (!isSW) return false;
  try {
    switch (msg.type) {
      case 'WORD_DB_GET': {
        const record = await idbGet(makeKey(msg.lang, msg.word));
        sendResponse({ ok: true, record });
        return true;
      }
      case 'WORD_DB_GET_BATCH': {
        const keys = (msg.words || []).map((w) => makeKey(msg.lang, w));
        const records = await idbGetBatch(keys);
        sendResponse({ ok: true, records });
        return true;
      }
      case 'WORD_DB_PUT':
        await idbPut(msg.record);
        sendResponse({ ok: true });
        return true;
      case 'WORD_DB_UPDATE': {
        await idbUpdate(makeKey(msg.lang, msg.word), msg.patch);
        sendResponse({ ok: true });
        return true;
      }
      case 'WORD_DB_CLEAR_LANG': {
        const cleared = await idbClearByLang(msg.lang);
        _projCache.delete(msg.lang);
        projLocalDel(msg.lang);   // 第二百零六次：local 二级缓存同步失效
        sendResponse({ ok: true, cleared });
        return true;
      }
      case 'WORD_DB_GET_LANG_PROJ': {
        // 反思（2026-08-20 第八十五次）：页面从词典读投影构建词频/词表 Map，
        //   不再有独立的词频/词表缓存（dictCache 仅存 lemmas 词形数据）。
        // 反思（2026-08-20 第八十七次）：投影读取是整表扫描（~0.9s），每页都扫很浪费且
        //   词典日志反复出现。SW 内存缓存：SW 会话内同语言只扫一次；bulkWrite/清库时失效。
        // 第一百九十一次：扫库+填缓存抽为 loadProjCached（与 warmupDictProjection 共用，
        //   预热过的请求直接命中缓存，页面侧只剩一次消息传输）。
        const proj = await loadProjCached(msg.lang);
        sendResponse({ ok: true, proj });
        return true;
      }
      case 'WORD_DB_BULK_WRITE': {
        // 第一百五十四次·可靠性重构：废除"SW 内存攒批+末块巨事务"（事件页休眠/
        // 大事务失败即前功尽弃且无错误可见）。改为**逐块即时小事务**：
        // 每条消息直接写 IDB（3000->1200 行/块），末块自带 __built__+expected 原子标记；
        // 任一块异常把 error 串回传 CS，绝不静默、绝不打半截标记。
        try {
          await idbBulkWrite(msg.lang, msg.entries || [], msg.final ? msg.expected : undefined);
          if (msg.lang) { _projCache.delete(msg.lang); projLocalDel(msg.lang); }   // 第二百零六次：两级缓存同步失效
          sendResponse({ ok: true, written: (msg.entries || []).length });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
        return true;
      }
      case 'WORD_DB_PROJ_CACHE_INVALIDATE': {
        // 第一百五十二次（用户架构"前端直写 DB，后台仅刷新缓存"）：CS 直写成功后
        // 通知 SW 失效该语言内存投影缓存--SW 只做缓存一致性，不再承担数据通道。
        if (msg.lang) { _projCache.delete(msg.lang); projLocalDel(msg.lang); }   // 第二百零六次：两级缓存同步失效
        sendResponse({ ok: true });
        return true;
      }
      case 'WORD_DB_PROJ_PREFETCH': {
        // 第一百九十一次：document_start 预取脚本（dict-prefetch.js）在网页打开瞬间
        // 唤醒 SW 触发预热；await 完成后回执（预取方 fire-and-forget，回执仅供诊断）。
        const warm = await warmupDictProjection();
        sendResponse({ ok: true, warm });
        return true;
      }
      case 'WORD_DB_CLEAR_ALL':
        await idbClearAll();
        _projCache.clear();
        projLocalClearAll();   // 第二百零六次：local 二级缓存同步整清
        sendResponse({ ok: true });
        return true;
      case 'DICT_CACHE_GET': {
        const cache = await idbDictGet(msg.lang);
        sendResponse({ ok: true, cache });
        return true;
      }
      case 'DICT_CACHE_SET':
        // 反思（2026-08-13 第五十三次）：统一词典--写改为读-合并-写，
        //   words 与 lemmas 由不同模块写，旧版整体覆盖会互相清空。
        await idbDictMerge(msg.lang, msg.value);
        sendResponse({ ok: true });
        return true;
      // 第二百二十五次：删除 DICT_CACHE_STAT 死分支（《命名清查》裁定——
      //   dict-stats.js 已不发此消息，全库无发送方；同族 DICT_CACHE_GET/SET 保留）。
      case 'LEMMAS_GET': {
        // 反思（2026-08-14 第五十七次）：词形数据按需获取--SW 读扩展数据域 IDB，
        //   未命中则直接下载并写回，content script 一次消息拿到词形数据（noData 时只回统计）。
        const r = await lemmasLoad(msg.lang);
        if (msg.noData) {
          sendResponse({ ok: true, source: r.source, size: r.wordDict ? Object.keys(r.wordDict).length : 0 });
        } else {
          sendResponse({ ok: true, source: r.source, wordDict: r.wordDict, ambiguityMap: r.ambiguityMap });
        }
        return true;
      }
      case 'LEMMATIZE_WORD':
        // 反思（2026-08-16 第六十七次）：逐词词形还原--页面不拉整表，
        //   每次只查一个词（首次构建 lemmatizer 可能读 IDB/首次下载，走 try/catch 兜底）。
        sendResponse(await swLemmatizeWord(msg.word, msg.lang || 'en'));
        return true;
      default:
        return false;
    }
  } catch (e) {
    sendResponse({ ok: false, error: String(e && e.message || e) });
    return true;
  }
}
