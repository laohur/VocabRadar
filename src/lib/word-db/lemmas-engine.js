// ============================================================
// 文件职责：SW 词形数据装载与逐词还原引擎（src/lib/word-db/lemmas-engine.js）
// 来源：拆分自 src/lib/word-db.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// LEMMAS_GET（整表装载：扩展数据域 IDB 缓存命中 -> 未命中 CDN 下载 -> 写回
//   IDB，在途请求按语言去重 _lemmasInflight）与 LEMMATIZE_WORD（逐词还原，
//   lemmatizer 实例按语言会话级缓存 _swLemmatizers）的实现，供 sw-channel.js
//   的 handleWordDbMessage 相应消息分支调用。跨模块共享状态（两个 Map）均与
//   使用者同模块，绝不复制两份。
// ============================================================

// 反思（2026-08-16 第六十七次）：逐词词形还原--页面不再经 LEMMAS_GET 拉取 13.9 万词整表，
//   改为发 LEMMATIZE_WORD 单次查询。SW 侧用本模块 createLemmatizer 构建/复用 lemmatizer
//   （数据源=扩展统一 IDB，首次从 CDN 下载并写回，见 lemmasLoad），返回该词 lemma+候选原形。
//   自包含、无副作用（不触发 downloader/缓存逻辑），可安全在 SW 导入。
import { createLemmatizer } from '../vendor/diverse-lemmas/lemmatizer.js';
import { idbDictGet, idbDictMerge } from './db-ops.js';

// diverse-lemmas 词形数据 CDN（与 vendor/diverse-lemmas/downloader.js DEFAULT_CDN 保持一致）
// 反思（2026-08-14 第五十七次）：词形数据首次下载后存入扩展数据域 IDB（本文件 dictCache store 的
//   lemmas/ambiguity 字段），之后各网站按需调用，不再重复下载、也不打包进扩展包体。
const LEMMAS_CDN = 'https://unpkg.com/@hg0428/diverse-lemmas-data@1';
// 词形数据最少词数（正常英文 139,070 词，<100 视为残缺数据拒绝缓存）
const LEMMAS_MIN_WORDS = 100;

// 反思（2026-08-14 第五十七次）：词形数据的下载/缓存/持久化全部在 SW（扩展数据域）内完成，
//   content script 只发一次 LEMMAS_GET 消息获取词形数据（SW->CS 巨型响应已被 FETCH_URL 验证可行）。
//   旧版在 CS 侧 getDictCache -> FETCH_URL 代理下载 -> DICT_CACHE_SET 把 13.9 万词对象传回 SW 持久化，
//   CS->SW 巨型消息不可靠（常静默失败），导致换站重新下载，用户判断"并未实现统一词典"。
// 在途请求去重：多站点同时首次请求同语言时只下载一次
const _lemmasInflight = new Map();

/**
 * SW 专用：确保指定语言的词形数据就绪（读扩展数据域 IDB -> 未命中则 CDN 下载 -> 写回 IDB）
 * 反思（2026-08-14 第五十七次）：用户要求"首次下载后，存入扩展数据域内，之后词典缺数据就按需调用，
 *   而不是打包进入扩展"。
 * @param {string} lang 语言代码
 * @returns {Promise<{source:'unified'|'download', wordDict:object, ambiguityMap:object|null}>}
 */
export async function lemmasLoad(lang) {
  if (!lang) throw new Error('empty lang');
  if (_lemmasInflight.has(lang)) return _lemmasInflight.get(lang);
  const p = lemmasLoadInner(lang).finally(() => _lemmasInflight.delete(lang));
  _lemmasInflight.set(lang, p);
  return p;
}

async function lemmasLoadInner(lang) {
  // 1. 扩展数据域缓存命中
  const cache = await idbDictGet(lang);
  if (cache && cache.lemmas && Object.keys(cache.lemmas).length >= LEMMAS_MIN_WORDS) {
    console.log(`[VocabRadar][词形数据] 语言 ${lang} 词形数据直接从本地扩展存储加载（${Object.keys(cache.lemmas).length} 词，无需下载）`);
    return { source: 'unified', wordDict: cache.lemmas, ambiguityMap: cache.ambiguity || null };
  }

  // 2. CDN 下载（SW 有 host_permissions，不受页面 CSP 限制）
  const url = LEMMAS_CDN + '/' + lang + '/lemmas.json';
  console.log(`[VocabRadar][词形数据] 首次下载语言 ${lang} 词形数据: ${url}`);
  const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  const data = await res.json();
  const wordDict = (data && data.word_dict) || data;
  const count = wordDict ? Object.keys(wordDict).length : 0;
  if (count < LEMMAS_MIN_WORDS) throw new Error('词形数据过少: ' + count);

  // 3. 歧义表（可选，失败忽略；无歧义的语言该 URL 返回 404）
  let ambiguityMap = null;
  try {
    const ambUrl = LEMMAS_CDN + '/' + lang + '/ambiguity_map.json';
    const ares = await fetch(ambUrl, { credentials: 'omit', cache: 'no-store' });
    if (ares.ok) ambiguityMap = await ares.json();
  } catch (_) { /* 歧义表可选 */ }

  // 4. 写入扩展数据域 IDB（读-合并-写，不影响 words 字段）
  await idbDictMerge(lang, { lemmas: wordDict, ambiguity: ambiguityMap });
  console.log(`[VocabRadar][词形数据] 语言 ${lang} 词形数据已下载并存入本地扩展存储（${count} 词）`);
  return { source: 'download', wordDict, ambiguityMap };
}

// SW 侧逐词词形还原（2026-08-16 第六十七次）：lemmatizer 实例缓存，每 SW 会话每个语言只构建一次
const _swLemmatizers = new Map();  // lang -> lemmatizer instance

/**
 * SW 专用：返回某词的原形 lemma + 候选原形列表（页面按词按需调用）
 * 数据源 = 扩展统一 IDB（首次从 CDN 下载并写回）；未命中/失败按"原词即原形"返回。
 * @param {string} word 单词
 * @param {string} [lang='en'] 语言代码
 * @returns {Promise<{ok:boolean, lemma:string, candidates:string[]}>}
 */
export async function swLemmatizeWord(word, lang) {
  const lower = (word || '').toLowerCase();
  if (!lower) return { ok: true, lemma: lower, candidates: [lower] };
  const key = lang || 'en';
  let lem = _swLemmatizers.get(key);
  if (!lem) {
    // 首次按需构建：lemmasLoad 读扩展 IDB（已缓存则免下载），仅在完全没有缓存时走 CDN
    const r = await lemmasLoad(key);
    lem = createLemmatizer({ lang: key, wordDict: r.wordDict, ambiguityMap: r.ambiguityMap || null });
    _swLemmatizers.set(key, lem);
    console.log(`[VocabRadar][词形引擎] 语言 ${key} 词形引擎已就绪（${lem.dictSize} 词），供逐词查询`);
  }
  // 候选原形 = 原词 + diverse-lemmas 全部候选（任何 method 都纳入，用于词表标签匹配）
  const candidates = new Set([lower]);
  let lemma = lower;
  let res = null;
  try {
    res = lem.lemmatizeWord(lower);
    if (res && res.lemmas && res.lemmas.length > 0) {
      for (const lm of res.lemmas) candidates.add(String(lm).toLowerCase());
      // lemma 仅用 direct 命中结果（与第九次"仅用词典结果"一致）
      if (res.method === 'direct') lemma = String(res.lemmas[0]).toLowerCase();
    }
  } catch (e) {
    // 反思（2026-08-16 第六十八次）：失败明示（③：不能讳疾忌医，错误要报出来）
    console.warn(`[VocabRadar][词形引擎] 查询 "${lower}"(${key}) 词形还原失败: ${e && e.message}, 按原词即原形`);
  }
  // 2026-09-08 第二百四十次（日志降噪，用户批复）：删逐词成功日志（第六十八次曾恢复，
  //   实际页面批量查询时仍逐词刷屏，用户裁定删除）
  return { ok: true, lemma, candidates: Array.from(candidates) };
}

// 同族反查缓存（2026-09-04）：key=lang|lemmalower → 全量同族词数组（已排序，调用方按 limit 截断）
const _familyCache = new Map();  // key -> string[]
const FAMILY_CACHE_LIMIT = 500;  // 兜底：不同 lemma 缓存条目上限，超了清掉最旧（Map 插入序）
const FAMILY_STORE_CAP = 200;    // 单 lemma 存储上限（防超大词族吃内存）

/**
 * SW 专用：查某原形的全部同族词（页面展开原形折叠时调用）
 *
 * 反思（2026-09-04）：用户反馈展开只列出一个（词表内同页同形才一组，高频原形如 run
 *   早被阈值滤掉，永不进组）。"列出所有同原词形的单词"只能走词形整表反查：
 *   SW 侧 lemmasLoad 已有全量 wordDict（word→lemma），此处反向扫描收集。
 *   13.9 万条目内存扫描一次约数毫秒，按 lang|lemma 缓存，后续 O(1)。
 * @param {string} lemma 原形（小写）
 * @param {string} [lang='en'] 语言代码
 * @param {number} [limit=20] 返回上限
 * @returns {Promise<{ok:boolean, lemma:string, words:string[], total:number}>}
 */
export async function swLemmaFamily(lemma, lang, limit) {
  const target = String(lemma || '').toLowerCase();
  const key = (lang || 'en');
  const cap = (typeof limit === 'number' && limit > 0 && limit <= 100) ? Math.floor(limit) : 20;
  if (!target) return { ok: true, lemma: target, words: [], total: 0 };
  const cacheKey = key + '|' + target;
  const hit = _familyCache.get(cacheKey);
  if (hit) return { ok: true, lemma: target, words: hit.slice(0, cap), total: hit.length };
  // 确保词形数据就绪（已缓存则免下载；整表在 SW 会话内复用，不发页面）
  const r = await lemmasLoad(key);
  const dict = (r && r.wordDict) || {};
  const out = [];
  for (const w in dict) {
    if (!Object.prototype.hasOwnProperty.call(dict, w)) continue;
    try {
      if (String(dict[w]).toLowerCase() === target) out.push(w);
    } catch (_) { /* 脏行跳过 */ }
  }
  // 排序：短词优先（基础形通常最短）→ 字母序；稳定可预期
  out.sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
  if (_familyCache.size >= FAMILY_CACHE_LIMIT) {
    const oldest = _familyCache.keys().next();
    if (!oldest.done) _familyCache.delete(oldest.value);
  }
  _familyCache.set(cacheKey, out.slice(0, FAMILY_STORE_CAP));
  return { ok: true, lemma: target, words: out.slice(0, cap), total: out.length };
}
