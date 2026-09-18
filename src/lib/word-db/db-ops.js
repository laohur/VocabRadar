// ============================================================
// 文件职责：IndexedDB 打开/事务/游标读写原语（src/lib/word-db/db-ops.js）
// 来源：拆分自 src/lib/word-db.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// 含：库/表常量（beaver-dict：words 旧表 + 五张属性分表 + meta + dictCache）、
//   IDB 连接单例 _dbPromise（与 getDB 同模块，唯一属主，绝不复制两份）、
//   全部 idbXxx 底层读写（含 idbGetLangProjection 投影整表扫描与 dictCache
//   读-合并-写 idbDictGet/idbDictMerge）。仅 SW 上下文实际执行（getDB 内
//   isSW 守卫拒绝 CS 调用）；CS 侧经 sw-channel.js 消息路由到这些函数。
//   键构造/还原统一走 key-utils.js 的 makeKey/splitKey（唯一实例）。
// ============================================================

import { isSW } from './env.js';
import { makeKey, splitKey } from './key-utils.js';

const DB_NAME = 'beaver-dict';
// 第一百一十九次（用户裁定）：统一词典改分拆词典--每类属性一张小表，天然可整体
// 序列化/按需装载；words 旧表保留只读（一次性迁移数据到分表后不再写入）。
const DB_VERSION = 3;
const STORE_NAME = 'words'; // 旧统一表：仅迁移读取用
// 分拆存储：k=`${lang}|${word_lower}`，均带 by-lang 索引
const S_RANK = 'd_rank';
const S_TAGS = 'd_tags';
const S_LEMMA = 'd_lemma';
const S_TRANS = 'd_trans';
const S_PHON = 'd_phon';
const S_META = 'meta'; // keyPath 'lang'：{lang, built:true} 构建完成标记
const SPLIT_STORES = [S_RANK, S_TAGS, S_LEMMA, S_TRANS, S_PHON];

// 词典整表缓存 store：key=lang，值={lang, version, words:[按频率降序], time}
// 反思（2026-08-13 第五十一次）：用户要求"刷新页面后应从词典加载，只有词典之外的单词才需要重新构建"。
//   wordfreq 每次页面刷新都重新 fetch+解压+msgpack+构建 Map（英文 5 万+ 词），
//   将解码后的单词数组缓存到 IDB，刷新后直接构建 Map（rank=index+1）。
const DICT_CACHE_STORE = 'dictCache';

// === IDB 操作（仅 SW 使用）===
let _dbPromise = null;

/**
 * 打开/创建 IndexedDB（仅 SW 调用）
 * 反思：CS 中 indexedDB 指向页面源（按站点隔离），不能用于扩展级共享。
 *   故仅 SW 中打开 IDB；CS 通过消息请求 SW 代为操作。
 * @returns {Promise<IDBDatabase>}
 */
function getDB() {
  if (!isSW) return Promise.reject(new Error('getDB() only callable in SW'));
  if (!_dbPromise) {
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('by-lang', 'lang', { unique: false });
        }
        // 词典整表缓存 store（DB_VERSION 2 新增；旧库升级时创建）
        if (!db.objectStoreNames.contains(DICT_CACHE_STORE)) {
          db.createObjectStore(DICT_CACHE_STORE, { keyPath: 'lang' });
        }
        // 第一百一十九次：DB_VERSION 3--分拆词典五张属性表 + meta 构建标记
        for (const s of SPLIT_STORES) {
          if (!db.objectStoreNames.contains(s)) {
            const st = db.createObjectStore(s, { keyPath: 'k' });
            st.createIndex('by-lang', 'lang', { unique: false });
          }
        }
        if (!db.objectStoreNames.contains(S_META)) {
          db.createObjectStore(S_META, { keyPath: 'lang' });
        }
      };
    });
    // 反思：IDB 打开失败不应缓存 rejected Promise，否则后续重试仍失败
    _dbPromise.catch(() => { _dbPromise = null; });
  }
  return _dbPromise;
}

/** 单事务读五张分表并组装旧版记录形状（字段缺失语义与旧版一致：存在才带出） */
export async function idbGet(key) {
  const db = await getDB();
  const p = splitKey(key);
  if (!p) return null;
  const k = key;
  const out = await new Promise((resolve, reject) => {
    const tx = db.transaction(SPLIT_STORES, 'readonly');
    const g = (s) => tx.objectStore(s).get(k);
    const rqR = g(S_RANK), rqT = g(S_TAGS), rqL = g(S_LEMMA), rqTr = g(S_TRANS), rqP = g(S_PHON);
    let done = 0;
    const rec = { key, lang: p.lang, word: p.word };
    const finish = () => {
      if (rqR.result && typeof rqR.result.v === 'number') rec.rank = rqR.result.v;
      if (rqT.result && Array.isArray(rqT.result.v)) rec.tags = rqT.result.v;
      if (rqL.result && typeof rqL.result.v === 'string') rec.lemma = rqL.result.v;
      if (rqTr.result && typeof rqTr.result.v === 'string') {
        rec.translation = rqTr.result.v;
        rec.translationLang = rqTr.result.tlang || null;
      }
      if (rqP.result && typeof rqP.result.v === 'string') rec.phonetic = rqP.result.v;
      resolve(rec);
    };
    [rqR, rqT, rqL, rqTr, rqP].forEach((rq) => {
      rq.onsuccess = () => { if (++done === 5) finish(); };
      rq.onerror = () => reject(rq.error);
    });
  });
  // 无任何属性：视为不存在（与旧语义一致）
  const hasAny = ('rank' in out) || ('tags' in out) || ('lemma' in out) || ('translation' in out) || ('phonetic' in out);
  return hasAny ? out : null;
}

export async function idbGetBatch(keys) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SPLIT_STORES, 'readonly');
    const stores = SPLIT_STORES.map((s) => tx.objectStore(s));
    const results = new Array(keys.length).fill(null);
    let pending = keys.length;
    if (pending === 0) { resolve(results); return; }
    keys.forEach((key, i) => {
      const p = splitKey(key);
      if (!p) { if (--pending === 0) resolve(results); return; }
      const rec = { key, lang: p.lang, word: p.word };
      let got = 0;
      const reqs = stores.map((st) => st.get(key));
      reqs.forEach((rq, si) => {
        rq.onsuccess = () => {
          const r = rq.result;
          if (r) {
            if (si === 0 && typeof r.v === 'number') rec.rank = r.v;
            if (si === 1 && Array.isArray(r.v)) rec.tags = r.v;
            if (si === 2 && typeof r.v === 'string') rec.lemma = r.v;
            if (si === 3 && typeof r.v === 'string') { rec.translation = r.v; rec.translationLang = r.tlang || null; }
            if (si === 4 && typeof r.v === 'string') rec.phonetic = r.v;
          }
          if (++got === SPLIT_STORES.length && --pending === 0) {
            for (const o of results) {
              if (o && !('rank' in o) && !('tags' in o) && !('lemma' in o) && !('translation' in o) && !('phonetic' in o)) {
                // 全空：置 null（不存在）
                results[results.indexOf(o)] = null;
              }
            }
            resolve(results);
          }
        };
        rq.onerror = () => reject(rq.error);
      });
    });
  });
}

export async function idbPut(record) {
  const db = await getDB();
  const p = splitKey(record.key);
  if (!p) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SPLIT_STORES, 'readwrite');
    const w = (s, v, extra) => { if (v !== undefined) tx.objectStore(s).put(Object.assign({ k: record.key, lang: p.lang, v }, extra || {})); };
    if (typeof record.rank === 'number') w(S_RANK, record.rank);
    if (Array.isArray(record.tags)) w(S_TAGS, record.tags);
    if (typeof record.lemma === 'string') w(S_LEMMA, record.lemma);
    if (typeof record.translation === 'string') w(S_TRANS, record.translation, { tlang: record.translationLang || null });
    if (typeof record.phonetic === 'string') w(S_PHON, record.phonetic);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbUpdate(key, patch) {
  const db = await getDB();
  const p = splitKey(key);
  if (!p || !patch) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SPLIT_STORES, 'readwrite');
    const w = (s, v, extra) => { if (v !== undefined) tx.objectStore(s).put(Object.assign({ k: key, lang: p.lang, v }, extra || {})); };
    if ('rank' in patch) w(S_RANK, typeof patch.rank === 'number' ? patch.rank : undefined);
    if ('tags' in patch) w(S_TAGS, Array.isArray(patch.tags) ? patch.tags : undefined);
    if ('lemma' in patch) w(S_LEMMA, typeof patch.lemma === 'string' ? patch.lemma : undefined);
    if ('translation' in patch) w(S_TRANS, typeof patch.translation === 'string' ? patch.translation : undefined, { tlang: patch.translationLang || null });
    if ('phonetic' in patch) w(S_PHON, typeof patch.phonetic === 'string' ? patch.phonetic : undefined);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbClearByLang(lang) {
  const db = await getDB();
  let cleared = 0;
  for (const s of SPLIT_STORES) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(s, 'readwrite');
      const idx = tx.objectStore(s).index('by-lang');
      const req = idx.openCursor(IDBKeyRange.only(lang));
      req.onerror = () => reject(req.error);
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur) { cur.delete(); cleared++; cur.continue(); } else resolve();
      };
    });
  }
  try {
    const tx = db.transaction(S_META, 'readwrite');
    tx.objectStore(S_META).delete(lang);
  } catch (e) { /* ignore */ }
  return cleared;
}

export async function idbClearAll() {
  const db = await getDB();
  for (const s of [...SPLIT_STORES, S_META]) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(s, 'readwrite');
      const rq = tx.objectStore(s).clear();
      rq.onsuccess = () => resolve();
      rq.onerror = () => reject(rq.error);
    });
  }
}

export async function idbBulkWrite(lang, entries, expected, dataVersion) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([S_RANK, S_TAGS, S_META], 'readwrite');
    const stR = tx.objectStore(S_RANK);
    const stT = tx.objectStore(S_TAGS);
    const stM = tx.objectStore(S_META);
    for (const e of entries) {
      if (e.word === '__built__') {
        // 第一百四十次（用户裁定）：meta 记录**实际值** expected（本次构建的真实词条数）
        // --完整性校验用它，不用任何拍脑袋阈值。
        // 2026-09-03 源头过滤：meta 记录 dataVersion（= manifest.version，预处理数据的
        // 数据格式版本）--projection.js 比对不一致即判旧数据，清库全量重建
        //（upsert 不清库，过滤后旧词典脏词永远清不掉，必须版本比对触发显式清库）。
        stM.put(Object.assign({ lang, built: true },
          Number.isFinite(expected) ? { expected: Math.round(expected) } : {},
          Number.isFinite(dataVersion) ? { dataVersion: Math.round(dataVersion) } : {}));
        continue;
      }
      const k = makeKey(lang, e.word);
      if (e.rank !== undefined) stR.put({ k, lang, v: e.rank });
      if (e.tags !== undefined) stT.put({ k, lang, v: e.tags });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 批量写入释义（内置翻译包装载用，与 idbBulkWrite 同型：单事务逐块写）
 * 反思（2026-09-04）：小程序内置英中翻译包（VocabRadar/preprocess 产出，ECDICT+LLM）
 *   接入扩展——不走内存直查（违反"业务只从词典读"），而由装载函数经本函数一次性
 *   写入 d_trans 分表（translationLang='zh' 存 tlang 字段），之后 translator 首层
 *   词典缓存即命中。失败只抛错不打标记（调用方 bulkWriteTranslations 负责中止语义）。
 * @param {string} lang 源语言（如 'en'）
 * @param {Array<{word:string,translation:string}>} entries 释义条目（translation 已是定稿字符串）
 * @param {string} [translationLang] 释义语言（存 tlang，供 translator 按语言对校验）
 */
export async function idbBulkTrans(lang, entries, translationLang) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([S_TRANS], 'readwrite');
    const st = tx.objectStore(S_TRANS);
    for (const e of (entries || [])) {
      if (!e || !e.word || typeof e.translation !== 'string' || !e.translation) continue;
      st.put({ k: makeKey(lang, e.word), lang, v: e.translation, tlang: translationLang || null });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 第三百三十九次（用户："各个字段分别统计"）：引导页就绪行要分项显示各字段词典规模，
//   其中翻译字段（d_trans 分表）页侧无现成计数——内置翻译包 40261 词经 idbBulkTrans
//   直接写表、不进内存投影（projection.js 设计如此），dictMap 数不出翻译数。此处新增
//   by-lang 索引 count：一条索引计数即得该语言全部翻译词条数（含运行时 setWordCached
//   写入的在线翻译缓存，属真实状态，如实显示）。仅 SW 执行，CS 经 sw-channel 调用。
export async function idbCountTrans(lang) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([S_TRANS], 'readonly');
    const req = tx.objectStore(S_TRANS).index('by-lang').count(IDBKeyRange.only(lang));
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetLangProjection(lang) {
  // === 第一百九十次：IDB 投影读取内部细分计时 ===
  // 用户实测：词典装载 4448ms 全在投影读取（startHint→词典就绪 4537ms ≈ 投影 4448+Map 85），
  //   需定位连接打开/各表 getAll/meta 各占多少。查看：window.__beaverIdbTiming（实时引用）。
  const _it = { open: 0, ranks: 0, tags: 0, lemmas: 0, meta: 0, rankRows: 0, tagRows: 0, lemmaRows: 0 };
  if (typeof window !== 'undefined') window.__beaverIdbTiming = _it;
  let _t0 = performance.now();
  const db = await getDB();
  _it.open = Math.round(performance.now() - _t0);
  const ranks = {};
  const tags = {};
  const lemmas = {};
  let built = false;
  // 第一百八十七次·性能修复（用户实测 learn.microsoft.com：词典就绪 17093ms＝DCL 后 14.9s）。
  //   旧实现两处硬伤：
  //     ① 用 index('by-lang').openCursor 逐条 cur.continue()——英文约 5 万词条即 5 万次
  //        事件循环回调往返，单表就要几百毫秒到一秒（sw-channel.js 注释亦自承 ~0.9s）；
  //     ② d_rank/d_tags/d_lemma 三张表是 await 串行，三次全表扫描时间直接相加。
  //   改为 index('by-lang').getAll(only(lang)) 一次取回该语言全部记录（IDB 内部批量出栈，
  //   无逐条回调），并三表 Promise.all 并行（三个独立 readonly 事务互不冲突）。
  //   返回结构与语义完全不变（仍经 splitKey 从 k 还原 word）。
  // 第三百四十三次·整投影静默异常显性化（用户实测「整投影缺失」×3 而 ranks 三次全成）：
  //   ranks 直扫 built=true 证明 meta('en').built 为真；整投影与 ranks 共用同一 readMetaFor
  //   同一判据，逻辑上不可能一真一假——唯一自洽解释是整投影路径有异常被上层 catch 吞成
  //   null（getLangProjection 的 catch 静默 / handler 外层 catch 只回 ok:false 且页面侧
  //   丢弃 error）。修复分两层：
  //   ① 逐表容错：单表 getAll/事务失败不再炸整投影——该段置空 + _partial 标记 +
  //      console.error 显性打点，ranks+meta 段照常返回。Stage 2 合并照常、341 词表自愈
  //      照常触发，词典不因单表坏而瘫痪；异常真相直接进日志（哪个表、什么错）。
  //   ② _partial 投影由 loadProjCached 禁止落盘 local（坏段不固化），每次装载重扫重打
  //      error——症状持续可见，逼出根因（不掩耳盗铃）。
  let _partial = false;
  const readSplitAll = (store, fn, name) => new Promise((resolve) => {
    const _ts = performance.now();   // 第一百九十次：单表耗时（含 success 回调内的 splitKey 处理）
    try {
      const tx = db.transaction(store, 'readonly');
      const idx = tx.objectStore(store).index('by-lang');
      const req = idx.getAll(IDBKeyRange.only(lang));
      req.onerror = () => {
        _partial = true;
        console.error(`[VocabRadar][word-db] 整投影分表 ${name} getAll 失败（lang=${lang}）:`, req.error);
        resolve();   // 第三百四十三次：单表失败降级为空段，不炸整投影
      };
      req.onsuccess = () => {
        const rows = req.result || [];
        for (let i = 0; i < rows.length; i++) fn(rows[i]);
        _it[name] = Math.round(performance.now() - _ts);
        _it[name + 'Rows'] = rows.length;
        resolve();
      };
    } catch (e) {
      _partial = true;
      console.error(`[VocabRadar][word-db] 整投影分表 ${name} 事务/索引创建失败（lang=${lang}）:`, e);
      resolve();   // 第三百四十三次：同上（表缺失或 index 缺失在此暴露）
    }
  });
  await Promise.all([
    // 第一百三十七次·重大缺陷修复：分表记录字段是 {k,lang,v}（k=lang|word），没有 word 字段！
    // 旧写法 ranks[r.word]=r.v 即 ranks[undefined]=…，全表塌缩成一条 undefined 键--
    // 投影"built:true 但只有 1 个词"，所有真实单词（含 of）全部误判词典外，
    // 直接造成"网页无提示/词汇空"。必须经 splitKey 从 k 还原 word。
    readSplitAll(S_RANK, (r) => {
      const p = splitKey(r.k);
      if (p) ranks[p.word] = r.v;
    }, 'ranks'),
    readSplitAll(S_TAGS, (r) => {
      if (Array.isArray(r.v) && r.v.length > 0) {
        const p = splitKey(r.k);
        if (p) tags[p.word] = r.v;
      }
    }, 'tags'),
    readSplitAll(S_LEMMA, (r) => {
      if (r.v) {
        const p = splitKey(r.k);
        if (p) lemmas[p.word] = r.v;
      }
    }, 'lemmas')
  ]);
  // 第一百四十次：读 meta（built 标记 + expected 实际值）
  _t0 = performance.now();   // 第一百九十次：meta 段计时
  const meta = await readMetaFor(db, lang);
  _it.meta = Math.round(performance.now() - _t0);
  if (meta) built = !!meta.built;
  const metaExpected = (meta && Number.isFinite(meta.expected)) ? meta.expected : 0;
  // 2026-09-03 源头过滤：带出 dataVersion（构建时的预处理数据版本，0=旧版构建未记录）--
  // projection.js 与 manifest.version 比对，不一致 ⇒ 旧词典数据过期，清库全量重建。
  const metaDataVersion = (meta && Number.isFinite(meta.dataVersion)) ? meta.dataVersion : 0;
  // 带出实际值--ranksCount=库内实数，expected=构建时记录的实际词条数。
  // 第三百四十三次：_partial=true 表示有分表读取失败被降级为空段（消费方据此禁落盘缓存）。
  return { built, ranks, tags, lemmas, ranksCount: Object.keys(ranks).length, expected: metaExpected, dataVersion: metaDataVersion, _partial };
}

/** 读 meta 表单语言记录（idbGetLangProjection 与 idbGetRanksProjection 共用） */
function readMetaFor(db, lang) {
  return new Promise((res) => {
    try {
      const tx = db.transaction(S_META, 'readonly');
      const rq = tx.objectStore(S_META).get(lang);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => {
        // 第三百四十四次：meta 读取失败不再静默当"不存在"——error 返回 null 会伪装成
        //   built=false，与"meta 真缺失"无法区分，排障三轮（340-342）都被它带偏。
        console.error(`[VocabRadar][word-db] meta 表读取失败（lang=${lang}）:`, rq.error);
        res(null);
      };
    } catch (e) {
      console.error(`[VocabRadar][word-db] meta 表事务创建失败（lang=${lang}）:`, e);
      res(null);
    }
  });
}

/**
 * 第三百四十五次：读 meta 表导出（跨模块对账用）。
 * 背景（用户诊断脚本实证）：meta 表全空 + d_rank 仅 2263 条（残库），而 chrome.storage.local
 *   里躺着一远古 built=true 投影（expected 28811/dataVersion 0）——ranks FAST PATH 每次被它
 *   劫持（37929 词假象），库残缺真相被掩盖五轮（340-344）。对账判据：**缓存投影声称
 *   built=true 而 meta 无构建记录 = 远古毒投影**（若库真构建过，meta 必有记录）。
 * 第三百四十四次的 idbTouchMetaBuilt（d_rank>0 盲目重打 built）已删除——方向错误：
 *   残库（2263/37915）标成完好只会掩盖问题，修复应走源重建补全数据，由重建末块打标。
 * @param {string} lang
 * @returns {Promise<object|null>} meta 记录（{lang,built,expected,dataVersion}）或 null
 */
export async function idbReadMeta(lang) {
  const db = await getDB();
  return readMetaFor(db, lang);
}

/**
 * 只读 ranks 投影（分阶段投影 Stage 1，首屏高亮只认 rank）
 * 反思（2026-09-04）：整投影含 ranks+tags+lemmas 三表并行扫＋2MB 消息传输，
 *   首屏高亮却只用 rank。拆出 rank-only 快通道：meta＋d_rank 单表一次 getAll，
 *   约整投影 1/3 数据量。tags/lemma 随后走整投影合并。
 * @param {string} lang 语言代码
 * @returns {Promise<{built:boolean,ranks:object,ranksCount:number,expected:number,dataVersion:number}>}
 */
export async function idbGetRanksProjection(lang) {
  const db = await getDB();
  const tx = db.transaction(S_RANK, 'readonly');
  const idx = tx.objectStore(S_RANK).index('by-lang');
  const rows = await new Promise((resolve, reject) => {
    try {
      const req = idx.getAll(IDBKeyRange.only(lang));
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result || []);
    } catch (e) { reject(e); }
  });
  const ranks = {};
  for (let i = 0; i < rows.length; i++) {
    const p = splitKey(rows[i].k);
    if (p) ranks[p.word] = rows[i].v;
  }
  const meta = await readMetaFor(db, lang);
  const built = !!(meta && meta.built);
  const expected = (meta && Number.isFinite(meta.expected)) ? meta.expected : 0;
  const dataVersion = (meta && Number.isFinite(meta.dataVersion)) ? meta.dataVersion : 0;
  return { built, ranks, ranksCount: Object.keys(ranks).length, expected, dataVersion };
}

// === 词典整表缓存（dictCache store） ===
// 反思（2026-08-13 第五十一次）：wordfreq 解码结果（按频率降序的单词数组）缓存到 IDB，
//   content script 经消息读写，SW 直接操作。version 用于扩展升级时失效旧缓存。
// 反思（2026-08-13 第五十三次）：统一词典落地--词形还原数据（diverse-lemmas wordDict/
//   ambiguityMap）也并入本 store（同一词典记录的一部分），记录结构扩展为：
//   { lang, version?, words?[], lemmas?{}, ambiguity?, time }
//   - words：wordfreq 单词数组（rank=index+1）
//   - lemmas：词形还原词典 {word: lemma}（139,070 词级，直接 createLemmatizer 用）
//   - ambiguity：歧义候选表（可选）
//   写入改为读-合并-写（idbDictMerge），words 与 lemmas 由不同模块写，互不覆盖。
//   好处：刷新/换站不再从 CDN 重新下载+组装词形还原数据（旧版存在页面源 IDB，按站隔离）。

/**
 * IDB 读取词典整表缓存（仅 SW）
 * @param {string} lang
 * @returns {Promise<{lang:string,version?:string,words?:string[],lemmas?:object,ambiguity?:object|null,time:number}|null>}
 */
export async function idbDictGet(lang) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DICT_CACHE_STORE, 'readonly');
    const req = tx.objectStore(DICT_CACHE_STORE).get(lang);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result || null);
  });
}

/**
 * IDB 读-合并-写词典整表缓存（仅 SW）
 * 反思（2026-08-13 第五十三次）：旧版 setDictCache 整体覆盖 {lang,version,words,time}，
 *   若 lemmas 由 lemmatizer 写入后再写 words 会互相清空。改为读-合并-写，
 *   各模块只更新自己负责的字段（words/lemmas），互不干扰。
 * @param {string} lang
 * @param {object} patch {version?, words?, lemmas?, ambiguity?, time?} 待合并字段
 */
export async function idbDictMerge(lang, patch) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DICT_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(DICT_CACHE_STORE);
    const getReq = store.get(lang);
    getReq.onerror = () => reject(getReq.error);
    getReq.onsuccess = () => {
      const existing = getReq.result || {};
      // 合并：existing 为底，patch 覆盖（patch 不含字段不覆盖）
      const merged = Object.assign({}, existing, patch, { lang });
      const putReq = store.put(merged);
      putReq.onerror = () => reject(putReq.error);
      putReq.onsuccess = () => resolve(merged);
    };
  });
}
