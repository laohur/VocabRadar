// ============================================================
// 文件职责：SW 词形数据装载与逐词还原引擎（src/lib/word-db/lemmas-engine.js）
// 来源：拆分自 src/lib/word-db.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// 第515次·用户裁定方案（本轮重构）："词频表中的装入内存，找不到的找索引"：
//   词形数据的权威存储 = d_lform 行（IDB，db-ops.js），内存只保留
//   ① 热集：词频表（d_rank）∩ 词形行 的 form→lemma 映射；
//   ② 冷词晋升缓存：热集未命中经索引取回后写入 view 自有属性（上限可重置）；
//   ③ 歧义表 ambiguityMap（仅 he/ko/es/fr/it 有，体积小）；
//   ④ 迁移/下载窗口期整表 full（先服务查询，行后台分块写完才释放）。
// 状态机（每语言一个 state，_states Map 独占，绝不复制两份）：
//   rowsReady（行已完整）→ 热集后台构建，查询两级：view/热集 → d_lform 索引；
//   blob 在手（旧版迁移/续传凭据）→ full 服务查询，行后台写，写完原子换 ready；
//   全无 → CDN 下载（双源+超时+退避）→ 写 blob → 同上窗口期迁移。
// 热集是纯缓存：陈旧只影响命中率不影响正确性（冷路径索引取回同样结果）。
// ============================================================

// 反思（2026-08-16 第六十七次）：逐词词形还原--页面不再整表拉取 13.9 万词，
//   改为发 LEMMATIZE_WORD 单次查询。SW 侧用本模块构建/复用 lemmatizer（数据源=
//   扩展统一 IDB 行+热集，首次从 CDN 下载后落行），返回该词 lemma+候选原形。
//   自包含、无副作用（不触发 downloader/缓存逻辑），可安全在 SW 导入。
import { createLemmatizer } from '../vendor/diverse-lemmas/lemmatizer.js';
import {
  idbDictGet, idbDictMerge, idbLformPutBatch, idbLformGet, idbLformCount,
  idbLformFamily, idbRankKeys, idbLformGetByKeys
} from './db-ops.js';
import { splitKey } from './key-utils.js';

// diverse-lemmas 词形数据 CDN（与 vendor/diverse-lemmas/downloader.js DEFAULT_CDN 保持一致）
// 反思（2026-08-14 第五十七次）：词形数据首次下载后存入扩展数据域 IDB（dictCache store 的
//   lemmas/ambiguity 字段），之后各网站按需调用，不再重复下载、也不打包进扩展包体。
// 第368次（用户报"扫描 30s 门闸卡死+YouTube 侧栏字幕无注释"）：单源 unpkg 改双源回退
//   +单源 12s 超时+失败 60s 退避——双源全败时退避期保证逐词查询快速降级（原词即原形）。
const LEMMAS_CDNS = [
  'https://unpkg.com/@hg0428/diverse-lemmas-data@1',
  'https://fastly.jsdelivr.net/npm/@hg0428/diverse-lemmas-data@1'
];
// 词形数据最少词数（正常英文 139,070 词，<100 视为残缺数据拒绝落库）
const LEMMAS_MIN_WORDS = 100;
// 第368次：单源 fetch 超时（ms）——两源最坏 24s < 页面侧 lemmatizeOne 30s 超时
const LEMMAS_FETCH_TIMEOUT_MS = 12000;
// 第368次：双源全失败后的重试退避（ms）——冷却期内直接快速失败
const LEMMAS_RETRY_BACKOFF_MS = 60000;
let _lemmasFailUntil = 0;
// 行后台分块大小（每块一事务，块间让出事件循环，SW 保持可响应）
const LEMMAS_ROW_CHUNK = 5000;
// 冷词晋升上限：view 自有属性超过该值即原地清空重来（热集在原型上不受影响）
const COLD_PROMOTE_CAP = 4000;
// dictCache 记录字段：行写完后的完成标记（行数达标才认；lemmasRowCount 与 lemmas:null 同一次 merge）
const ROW_COUNT_FIELD = 'lemmasRowCount';

// 第368次：带超时的 fetch（AbortController）——词形整表/歧义表下载共用
async function lemmasFetch(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LEMMAS_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { credentials: 'omit', cache: 'no-store', signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// === 每语言状态机 ===
// state: { lang, hot(空原型对象，后台填充), hotCount, view(=Object.create(hot)，
//   冷晋升写自有属性), coldCount, lem(词形引擎实例), amb(歧义表),
//   full(窗口期整表，写完释放), rowsReady }
const _states = new Map();        // lang -> state（SW 会话级，绝不复制两份）
const _ensureInflight = new Map(); // lang -> Promise（在途去重，多站点同时首查只装载一次）

/**
 * 确保指定语言词形状态就绪（行已完整/窗口期整表/触发下载三态），返回 state。
 * 失败（网络退避等）抛错——沿 handleWordDbMessage catch 回 ok:false，
 * 页面 lemmatizeOne 降级"原词即原形"（与旧 lemmasLoad 抛错语义一致）。
 * @param {string} lang
 * @returns {Promise<object>} state
 */
async function ensureLangState(lang) {
  if (!lang) throw new Error('empty lang');
  const st = _states.get(lang);
  if (st) return st;
  if (_ensureInflight.has(lang)) return _ensureInflight.get(lang);
  const p = (async () => {
    const ns = await initState(lang);
    _states.set(lang, ns);
    // 热集后台构建在 state 注册后启动（buildHot 的换代守卫按 _states 判定）；
    // 构建完成前查询走冷路径（索引取回后晋升），结果同样正确，不阻塞首查。
    if (ns.rowsReady && !ns.full) ns.hotBuild = buildHot(lang, ns);
    return ns;
  })().finally(() => _ensureInflight.delete(lang));
  _ensureInflight.set(lang, p);
  return p;
}

async function initState(lang) {
  const cache = await idbDictGet(lang);
  const st = {
    lang,
    hot: Object.create(null), hotCount: 0, hotBuild: null,
    view: null, coldCount: 0, lem: null,
    amb: (cache && cache.ambiguity) || null,
    full: null, rowsReady: false
  };
  // 态 1：行已完整（lemmasRowCount 达标）——正常会话路径，O(1) 判定不碰 blob
  if (cache && typeof cache[ROW_COUNT_FIELD] === 'number' && cache[ROW_COUNT_FIELD] >= LEMMAS_MIN_WORDS) {
    st.rowsReady = true;
    enterReady(st);
    return st;
  }
  // 态 2：旧版迁移窗口——blob 整表在手（行尚未写完），先服务查询，行后台分块写
  const blob = cache && cache.lemmas;
  if (blob) {
    const blobCount = Object.keys(blob).length;
    if (blobCount >= LEMMAS_MIN_WORDS) {
      st.full = blob;
      st.lem = createLemmatizer({ lang, wordDict: st.full, ambiguityMap: st.amb });
      console.log(`[VocabRadar][词形数据] 语言 ${lang} 词形整表在手（${blobCount} 词），先服务查询，后台分块落行`);
      startRowWrite(lang, st).catch((e) => {
        // 写行失败：full/blob 均仍在——本会话照常服务，下次会话凭 blob 续传重写
        console.error(`[VocabRadar][词形数据] 语言 ${lang} 后台落行失败（保留整表，下次会话重试）:`, e && e.message);
      });
      return st;
    }
  }
  // 态 3：全无——CDN 下载（退避检查放此处：态 1/2 命中不被退避拖累）
  if (Date.now() < _lemmasFailUntil) {
    throw new Error('词形数据下载近期失败，退避中（' + Math.ceil((_lemmasFailUntil - Date.now()) / 1000) + 's 后自动重试）');
  }
  const { wordDict, ambiguityMap, count } = await downloadLemmas(lang);
  // 写回 blob（续传凭据）——行没写完之前 blob 就是恢复点
  await idbDictMerge(lang, { lemmas: wordDict, ambiguity: ambiguityMap });
  // 第462次（修"引导页 lemmas 0 而引擎已就绪 139070"）：写入成功后广播——
  //   就绪行分项统计（lemmasSizeCached 仅读缓存、不触发下载）在下载前取数必为 0，
  //   且取数只有一次、无重取钩子；引导页监听 LEMMAS_READY 即重取。
  //   无接收方时 lastError 吞掉。
  try {
    chrome.runtime.sendMessage({ type: 'LEMMAS_READY', lang, count }, () => { void chrome.runtime.lastError; });
  } catch (_) { /* 无监听上下文不报错 */ }
  st.amb = ambiguityMap;
  st.full = wordDict;
  st.lem = createLemmatizer({ lang, wordDict: st.full, ambiguityMap: st.amb });
  console.log(`[VocabRadar][词形数据] 语言 ${lang} 词形数据已下载并存入本地扩展存储（${count} 词），后台分块落行`);
  startRowWrite(lang, st).catch((e) => {
    console.error(`[VocabRadar][词形数据] 语言 ${lang} 后台落行失败（保留整表，下次会话重试）:`, e && e.message);
  });
  return st;
}

/** 行就绪态切换：view=热集原型视图，引擎重建。调用方须已置 st.rowsReady=true */
function enterReady(st) {
  st.full = null;
  st.view = Object.create(st.hot);
  st.lem = createLemmatizer({ lang: st.lang, wordDict: st.view, ambiguityMap: st.amb });
}

// CDN 下载（双源回退）：主源失败（HTTP 错/超时/网络错）换备源，两源全败置 60s
// 退避并抛错（错误串带各源失败原因，与词频 handleWfFetch 的 srcErrs 口径一致）。
async function downloadLemmas(lang) {
  const srcErrs = [];
  let data = null;
  for (const cdn of LEMMAS_CDNS) {
    const url = cdn + '/' + lang + '/lemmas.json';
    console.log(`[VocabRadar][词形数据] 首次下载语言 ${lang} 词形数据: ${url}`);
    try {
      const res = await lemmasFetch(url);
      if (!res.ok) { srcErrs.push(cdn + ' -> HTTP ' + res.status); continue; }
      data = await res.json();
      break;
    } catch (e) {
      srcErrs.push(cdn + ' -> ' + ((e && e.name === 'AbortError') ? ('超时 ' + LEMMAS_FETCH_TIMEOUT_MS + 'ms') : String((e && e.message) || e)));
    }
  }
  const wordDict = (data && data.word_dict) || data;
  const count = wordDict ? Object.keys(wordDict).length : 0;
  if (count < LEMMAS_MIN_WORDS) {
    _lemmasFailUntil = Date.now() + LEMMAS_RETRY_BACKOFF_MS;
    throw new Error('词形数据下载失败（' + (srcErrs.join(' | ') || '词形数据过少: ' + count) + '）');
  }
  // 歧义表（可选，失败忽略；无歧义的语言该 URL 返回 404）——同样加超时，防挂
  let ambiguityMap = null;
  try {
    const ambUrl = LEMMAS_CDNS[0] + '/' + lang + '/ambiguity_map.json';
    const ares = await lemmasFetch(ambUrl);
    if (ares.ok) ambiguityMap = await ares.json();
  } catch (_) { /* 歧义表可选 */ }
  return { wordDict, ambiguityMap, count };
}

/**
 * 后台把整表分块写入 d_lform，全部写完才原子换就绪（lemmasRowCount+清 blob
 * 同一次 merge）并释放 full。中断/失败不打标记——下次会话凭 blob 续传重写（幂等）。
 * 大语言（fi/pl 约 99MB/350 万词）窗口期内 full 继续服务查询（峰值内存=旧行为），
 * 写完释放全表，之后内存只剩热集+晋升缓存。
 */
async function startRowWrite(lang, st) {
  const wordDict = st.full;
  const keys = Object.keys(wordDict);
  const total = keys.length;
  for (let i = 0; i < keys.length; i += LEMMAS_ROW_CHUNK) {
    const slice = keys.slice(i, i + LEMMAS_ROW_CHUNK);
    const entries = slice.map((w) => ({ word: w, lemma: wordDict[w] }));
    await idbLformPutBatch(lang, entries);
  }
  await idbDictMerge(lang, { [ROW_COUNT_FIELD]: total, lemmas: null });
  // 单同步块内完成状态切换：观察者只见"切换前（full）"或"切换后（view）"两态
  st.rowsReady = true;
  enterReady(st);
  st.hotBuild = buildHot(lang, st);
  console.log(`[VocabRadar][词形数据] 语言 ${lang} 词形已全部落行（${total} 行），整表已释放`);
}

/**
 * 热集后台构建：词频表键（d_rank）∩ 词形行（d_lform）。按 4000 键/事务分片
 * 取回，填入 st.hot（view 的原型），不阻塞查询。词频表未构建时热集暂空——
 * 冷路径索引照样取回，只是命中率暂缺，正确性不受影响。
 */
async function buildHot(lang, st) {
  try {
    const rankKeys = await idbRankKeys(lang);
    if (!rankKeys.length) return;
    const hits = await idbLformGetByKeys(rankKeys);
    if (_states.get(lang) !== st) return; // 会话状态已换代，丢弃
    for (const h of hits) {
      const p = splitKey(h.k);
      if (!p || (p.word in st.hot)) continue;
      st.hot[p.word] = h.v;
      st.hotCount++;
    }
    console.log(`[VocabRadar][词形引擎] 语言 ${lang} 热集就绪（词频∩词形 ${st.hotCount} 词）`);
  } catch (e) {
    // 构建失败只降级命中率：查询走冷路径（索引），仍正确
    console.error(`[VocabRadar][词形引擎] 语言 ${lang} 热集构建失败（降级为索引查询）:`, e && e.message);
  }
}

/**
 * 词典批量写入完成后重建热集钩子（sw-channel BULK_WRITE 末块调用）：
 * 新构建的词频表可能新增此前不在热集的词——重建一次让热集跟上词单。
 * 无状态/非行就绪态为 no-op；与在途构建并发时靠 hot 幂等填充去重。
 */
export function scheduleHotRebuild(lang) {
  const st = _states.get(lang);
  if (!st || !st.rowsReady || st.full) return;
  st.hotBuild = buildHot(lang, st);
}

/**
 * 两级查找的冷段：view（自有属性=晋升缓存，原型=热集）未命中 → d_lform 索引
 * 取回并晋升；确认不存在则负缓存（写 undefined，`in` 判真，避免重复查索引）。
 * 窗口期（full 在手）跳过——full 即引擎字典，miss 就是真 miss。
 */
async function resolveCold(st, lower) {
  if (st.full || !st.view) return;
  const norm = st.lem.normalize(lower);
  if (norm in st.view) return; // 晋升缓存（含负缓存）或热集命中
  let v = null;
  try {
    v = await idbLformGet(st.lang, norm);
  } catch (e) {
    console.error(`[VocabRadar][词形引擎] 语言 ${st.lang} 索引查询失败（本词不缓存，下次重试）:`, e && e.message);
    return;
  }
  st.view[norm] = (v == null ? undefined : String(v).toLowerCase());
  if (v != null) st.coldCount++;
  if (st.coldCount > COLD_PROMOTE_CAP) {
    // 原地重置：清掉 view 全部自有属性（热集在原型上不受影响），对象身份不变——
    // 在途/复用中的 lemmatizer 引用同一对象，无换实例竞态
    for (const k of Object.keys(st.view)) delete st.view[k];
    st.coldCount = 0;
  }
}

// 第三百三十九次（用户："各个字段分别统计"）：词形字段规模查询——仅读扩展数据域
//   计数，绝不触发 CDN 下载。取数源优先级：lemmasRowCount 标记（行就绪，O(1)）→
//   blob 整表（迁移窗口期）→ d_lform 索引 count 兜底。未装载如实回 0。
//   旧实现每次反序列化 99MB blob 做 Object.keys，现标记判定零成本。
export async function lemmasSizeCached(lang) {
  try {
    const cache = await idbDictGet(lang);
    if (cache && typeof cache[ROW_COUNT_FIELD] === 'number' && cache[ROW_COUNT_FIELD] >= LEMMAS_MIN_WORDS) {
      return { ok: true, size: cache[ROW_COUNT_FIELD] };
    }
    if (cache && cache.lemmas) {
      const n = Object.keys(cache.lemmas).length;
      if (n >= LEMMAS_MIN_WORDS) return { ok: true, size: n };
    }
    const n = await idbLformCount(lang);
    if (n >= LEMMAS_MIN_WORDS) return { ok: true, size: n };
  } catch (_) { /* 缓存读失败按未装载处理 */ }
  return { ok: true, size: 0 };
}

/**
 * SW 专用：返回某词的原形 lemma + 候选原形列表（页面按词按需调用）
 * 两级查找：view/热集（内存）→ 未命中回 d_lform 索引取回并晋升；
 * 未命中/失败按"原词即原形"返回。
 * @param {string} word 单词
 * @param {string} [lang='en'] 语言代码
 * @returns {Promise<{ok:boolean, lemma:string, candidates:string[]}>}
 */
export async function swLemmatizeWord(word, lang) {
  const lower = (word || '').toLowerCase();
  if (!lower) return { ok: true, lemma: lower, candidates: [lower] };
  const key = lang || 'en';
  const st = await ensureLangState(key);
  await resolveCold(st, lower);
  // 候选原形 = 原词 + diverse-lemmas 全部候选（任何 method 都纳入，用于词表标签匹配）
  const candidates = new Set([lower]);
  let lemma = lower;
  let res = null;
  try {
    res = st.lem.lemmatizeWord(lower);
    if (res && res.lemmas && res.lemmas.length > 0) {
      for (const lm of res.lemmas) candidates.add(String(lm).toLowerCase());
      // lemma 仅用 direct 命中结果（与第九次"仅用词典结果"一致）
      if (res.method === 'direct') lemma = String(res.lemmas[0]).toLowerCase();
    }
  } catch (e) {
    // 反思（2026-08-16 第六十八次）：失败明示（③：不能讳疾忌医，错误要报出来）
    console.warn(`[VocabRadar][词形引擎] 查询 "${lower}"(${key}) 词形还原失败: ${e && e.message}, 按原词即原形`);
  }
  // 2026-09-08 第二百四十次（日志降噪，用户批复）：删逐词成功日志
  return { ok: true, lemma, candidates: Array.from(candidates) };
}

// 同族反查缓存（2026-09-04）：key=lang|lemmalower → 全量同族词数组（已排序，调用方按 limit 截断）
const _familyCache = new Map();  // key -> string[]
const FAMILY_CACHE_LIMIT = 500;  // 兜底：不同 lemma 缓存条目上限，超了清掉最旧（Map 插入序）
const FAMILY_STORE_CAP = 200;    // 单 lemma 存储上限（防超大词族吃内存）

/**
 * SW 专用：查某原形的全部同族词（页面展开原形折叠时调用）
 *
 * 反思（2026-09-04）：用户反馈展开只列出一个——"列出所有同原词形的单词"只能走词形
 *   全集反查。行就绪态走 d_lform 复合索引 ['lang','v']（行=词形全集，热集是行子集，
 *   索引查询天然完整，不再扫内存）；迁移窗口期（full 在手、行未齐）扫 full 与旧行为一致。
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
  const st = await ensureLangState(key);
  let out;
  if (st.full) {
    // 迁移窗口期：行未齐，扫在手整表（与旧行为一致）
    const dict = st.full;
    out = [];
    for (const w in dict) {
      if (!Object.prototype.hasOwnProperty.call(dict, w)) continue;
      try {
        if (String(dict[w]).toLowerCase() === target) out.push(w);
      } catch (_) { /* 脏行跳过 */ }
    }
  } else {
    out = await idbLformFamily(key, target);
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
