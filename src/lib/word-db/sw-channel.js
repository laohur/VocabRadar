// ============================================================
// 文件职责：SW 消息通道与 DIRECT_IDB 路由（src/lib/word-db/sw-channel.js）
// 来源：拆分自 src/lib/word-db.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// 原 word-db.js 的对外导出符号集中在本文件（门面 word-db.js 仅
//   re-export，符号名不变，所有引用方零改动）：
//   getWord / getWordsBatch / putWord / updateFields / clearByLang / clearAll /
//   getLangProjection / bulkWriteDictionary / handleWordDbMessage
// 第515次（用户裁定"死分支删除"）：DICT_CACHE_GET/SET 与 LEMMAS_GET 消息
//   分支及 getDictCache/setDictCache 函数删除——全库无发送方（第225次删 DICT_CACHE_STAT 同源裁定）。
// 路由规则（与拆分前完全一致）：DIRECT_IDB（现恒 false）直连优先 -> isSW 直接
//   操作 IDB（db-ops.js）-> runtimeValid 时 chrome.runtime.sendMessage 经 SW
//   代为操作。handleWordDbMessage 为 SW 侧 WORD_DB_*/LEMMATIZE_* 消息分发器
//   （service-worker.js 注册调用），消息类型字符串逐字保留未动。
// ============================================================

import { isSW, DIRECT_IDB, runtimeValid } from './env.js';
import { makeKey } from './key-utils.js';
import {
  idbGet, idbGetBatch, idbPut, idbUpdate, idbClearByLang, idbClearAll,
  idbBulkWrite, idbBulkTrans, idbCountTrans, idbGetLangProjection, idbGetRanksProjection,
  idbReadMeta
} from './db-ops.js';
import { _projCache } from './projection-cache.js';
import { lemmasSizeCached, swLemmatizeWord, swLemmaFamily, scheduleHotRebuild } from './lemmas-engine.js';

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

// 第三百三十九次：翻译分表（d_trans）按语言计数——引导页就绪行分项统计的取数管道。
//   路由同 getWord：isSW 直调 IDB -> runtimeValid 时经 SW 代查（WORD_DB_COUNT_TRANS）。
//   失败/不可用一律回 0（计数只是展示信息，不允许影响页面流程）。
export async function countTranslationEntries(lang) {
  if (!lang) return 0;
  if (isSW) {
    try { return await idbCountTrans(lang); } catch (e) { return 0; }
  }
  if (!runtimeValid()) return 0;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'WORD_DB_COUNT_TRANS', lang });
    return resp && resp.ok ? (resp.count || 0) : 0;
  } catch (e) {
    return 0;
  }
}

// 第三百三十九次：词形数据（扩展数据域 dictCache.lemmas）按语言计数——同上分项统计用。
//   走 lemmasSizeCached：仅读缓存绝不触发 CDN 下载；未装载如实回 0。
export async function lemmasSize(lang) {
  if (!lang) return 0;
  if (isSW) {
    try { return (await lemmasSizeCached(lang)).size || 0; } catch (e) { return 0; }
  }
  if (!runtimeValid()) return 0;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'WORD_DB_LEMMAS_SIZE', lang });
    return resp && resp.ok ? (resp.size || 0) : 0;
  } catch (e) {
    return 0;
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
// 第三百七十二次（方案A·堵死"假首建"入口）：投影读取消息通道瞬断重试。SW 冷死/被 MV3
//   杀掉的瞬间，sendMessage 以 "message channel closed / Receiving end does not exist"
//   抛错，旧实现直接返回 null——_loadDict 无法区分"读失败"与"真无 __built__ 标记"，把
//   完好 IDB 误判为缺标记，踢起 67s 全量源重建（wordfreq 双源串行超时最坏 ~70s），重建
//   写回又被同一死通道打断，__built__ 永远写不上 -> 每次打开重演（用户 2026-10-12 实测）。
//   重试一次：sendMessage 本身会重新唤醒 SW，监听器注册后即可达；仍失败才抛回调用方
//   按原语义回 null。
function _projSendWithRetry(msg) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const send = () => {
      attempts++;
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) {
            const m = String(chrome.runtime.lastError.message || '');
            if (attempts < 2 && /Receiving end does not exist|message channel closed|message port closed/i.test(m)) {
              setTimeout(send, 300);
              return;
            }
            reject(new Error(m));
            return;
          }
          resolve(r);
        });
      } catch (e) { reject(e); }
    };
    send();
  });
}

// 第三百七十二次（方案D·堵死"循环闭合点"）：写库分块消息的通道瞬断重试。SW 被杀瞬间
//   发出的 WORD_DB_BULK_WRITE/BULK_TRANS 会以 "Could not establish connection. Receiving
//   end does not exist" 失败（启动竞态），旧实现立即中止且不打 __built__ 标记——词频
//   拉取失败的那次重建，写回总被同一死通道打断，标记永远写不上，下次打开又判"缺标记"
//   假首建（67s 死循环）。重试一次：sendMessage 会重新唤醒 SW，监听器注册后即可达；仍
//   失败按原语义返回 ok:false（调用方中止不打标记，不遮蔽）。
function _chunkSendWithRetry(msg) {
  return new Promise((resolve) => {
    let attempts = 0;
    const send = () => {
      attempts++;
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) {
            const m = String(chrome.runtime.lastError.message || '');
            if (attempts < 2 && /Receiving end does not exist|message channel closed|message port closed/i.test(m)) {
              setTimeout(send, 500);
              return;
            }
            resolve({ ok: false, error: m });
            return;
          }
          resolve(r || { ok: false, error: 'no response' });
        });
      } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); }
    };
    send();
  });
}

export async function getLangProjection(lang) {
  if (!lang) return null;
  // 第三百四十三次：各失败路径显性打点——此前 SW 直调异常静默吞成 null、消息通道
  //   失败（ok:false/error/异常）也静默吞成 null，页面侧只见「整投影缺失」，异常真相
  //   全程不可见（违反"不遮蔽错误"）。修复后每条失败路径都有日志。
  if (DIRECT_IDB) {
    try { return await idbGetLangProjection(lang); } catch (e) {
      console.error('[VocabRadar][word-db] 整投影直连读取异常，落入 SW 兜底:', e);
    }
  }
  if (isSW) {
    try { return await idbGetLangProjection(lang); } catch (e) {
      console.error('[VocabRadar][word-db] 整投影读取异常（SW 直调）:', e);
      return null;
    }
  }
  if (!runtimeValid()) return null;
  try {
    // 第三百七十二次：消息通道改走 _projSendWithRetry（瞬断重试一次）——此前单发即弃，
    //   SW 冷死瞬间读投影必失败，直接诱发假首建（见 helper 注释）。
    const resp = await _projSendWithRetry({ type: 'WORD_DB_GET_LANG_PROJ', lang });
    if (resp && resp.ok) return resp.proj;
    // 第三百四十三次：SW 回 ok:false（handler 外层 catch 的 error）——透出异常真相
    console.error('[VocabRadar][word-db] 整投影消息返回失败:', (resp && resp.error) || '(无 error 字段)');
    return null;
  } catch (e) {
    console.error('[VocabRadar][word-db] 整投影消息通道异常（SW 未响应/上下文失效，已重试仍失败）:', e);
    return null;
  }
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
//   且"第一个页面一直在扫"即此）；改 storage.local 跨会话存活——词典内容变化经
//   失效点删键，此后首开页面即命中（读 ~2MB 键 + 消息传输，百 ms 级）。
// 2026-10-13 重构（用户实测 1.6MB 单键 get 26.2s，ranks 一跳累计 196s）：
//   旧设计所有语言塞一个键 projCache={en,pt,...}，每次读缓存都全量 get+JSON 解析，
//   失效更是"读全量→删一桶→写全量"（重建每 1200 条写块触发一次，40+ 次读改写）。
//   新设计每语言一键 'projCache:<lang>'：读只解一个语言、失效走单键 remove。
//   旧单键 projCache 不做迁移（数据可从 IDB 重扫复取），后台一次性删除（见
//   cleanupLegacyProjCache），新键由 IDB 扫库后自然回填。
// 慢存储熔断：单键读取超过 PROJ_LOCAL_SLOW_MS 即判定本机 storage.local 后端病态
//   （LevelDB 膨胀/杀软扫盘等，正常 1.6MB 应为几十 ms），本会话投影缓存整体出局，
//   全走 IDB+内存——在健康机器上缓存照常生效（火狐慢盘用户仍靠它省 5~11s 扫库）。
// 配额受限（Firefox local ~5MB / Chrome 10MB，投影约 2MB/语言）时静默跳过，回退扫库。
const PROJ_LOCAL_PREFIX = 'projCache:';
const PROJ_LOCAL_SLOW_MS = 3000;
let _projLocalDisabled = false;   // 熔断标记（SW 会话级；SW 重醒重新探测）

async function projLocalGet(lang) {
  if (_projLocalDisabled) return null;
  // 第二百一十次（火狐重症根因）：缓存命中必须带 **built** 标记——meta 读取偶发失败
  //   会产出缺 built 的残缺投影，一旦落盘，每个页面都判"缺 __built__"而触发源重建，
  //   重建的逐块写库把 SW 埋掉（实测：词典就绪永不到来、查询饿死、词表 0）。
  //   读侧拒绝无 built 条目＝毒缓存自愈（按 miss 走新扫库，built 后覆盖写回）。
  const key = PROJ_LOCAL_PREFIX + lang;
  const _t = performance.now();
  try {
    const res = await chrome.storage.local.get(key);
    const _cost = performance.now() - _t;
    if (_cost > PROJ_LOCAL_SLOW_MS) {
      _projLocalDisabled = true;
      console.warn(`[VocabRadar][word-db] storage.local 投影读取 ${Math.round(_cost)}ms > ${PROJ_LOCAL_SLOW_MS}ms（${key}）——本会话熔断投影 local 缓存，改走 IDB+内存（健康机器应为百 ms 内；检查磁盘/杀软对扩展 LevelDB 的扫描）`);
      return null;
    }
    const v = res && res[key];
    return (v && v.built && v.ranks && Object.keys(v.ranks).length > 0) ? v : null;
  } catch (e) { return null; }
}

function projLocalSet(lang, proj) {
  if (_projLocalDisabled) return;
  try {
    const r = chrome.storage.local.set({ [PROJ_LOCAL_PREFIX + lang]: proj });
    if (r && typeof r.catch === 'function') r.catch(() => { /* 配额受限等静默 */ });
  } catch (e) { /* ignore */ }
}

function projLocalDel(lang) {
  if (_projLocalDisabled) return Promise.resolve();
  try {
    const r = chrome.storage.local.remove(PROJ_LOCAL_PREFIX + lang);
    if (r && typeof r.catch === 'function') { r.catch(() => {}); return r; }
    return Promise.resolve();
  } catch (e) { return Promise.resolve(); }
}

async function projLocalClearAll() {
  if (_projLocalDisabled) return;
  try {
    // 每语言一键后无全量桶可删：get(null) 过滤本前缀键批量 remove（仅手动清库用，罕见）。
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all || {}).filter((k) => k.indexOf(PROJ_LOCAL_PREFIX) === 0);
    if (keys.length) await chrome.storage.local.remove(keys);
  } catch (e) { /* ignore */ }
}

// 旧版单键 blob（projCache={en,...}）一次性清理：不读不迁，直接删键——数据可由 IDB
//   重扫复取，旧 blob 在新代码里永远不会再被读。storage 标记 projCacheV2 防 SW 反复
//   重醒重复发删除；模块布尔防本 SW 会话重复。清理本身在 warmup 末尾 fire-and-forget，
//   绝不阻塞投影取数（即便删除操作在病态 storage 上排队，也只占后台）。
let _legacyCleanupStarted = false;
function cleanupLegacyProjCache() {
  if (_legacyCleanupStarted) return;
  _legacyCleanupStarted = true;
  Promise.resolve().then(async () => {
    try {
      const flag = await chrome.storage.local.get('projCacheV2');
      if (flag && flag.projCacheV2) return;
      await chrome.storage.local.remove('projCache');
      await chrome.storage.local.set({ projCacheV2: 1 });
      console.log('[VocabRadar][word-db] 旧版单键 projCache blob 已清理（改每语言一键）');
    } catch (e) { /* SW 重醒后重试，幂等 */ }
  });
}

/** 投影读取唯一入口：_projCache 命中直返 → storage.local 二级缓存次之 → 扫库并填两级缓存
 * （warmup 与消息路径共用）。同语言在途去重：warmup 与消息路径共用一个 Promise，
 * 避免两条路径并发各读一次 storage.local（2026-10-13 用户实测两次 26s 串行叠加）。 */
const _loadProjInflight = new Map();
function loadProjCached(lang) {
  let p = _loadProjInflight.get(lang);
  if (!p) {
    p = _loadProjCachedInner(lang);
    _loadProjInflight.set(lang, p);
    p.finally(() => { _loadProjInflight.delete(lang); }).catch(() => {});
  }
  return p;
}

async function _loadProjCachedInner(lang) {
  // 2026-10-13：分段计时——用户实测 ranks 一跳 196s（页面侧只见"投影读取"总账，
  //   SW 内部 storage.local 读 / meta 对账 / IDB 扫库 / local 回写各占多少是黑盒）。
  //   结果随 proj._diag.ms 回传页面诊断窗，SW 控制台另打一行汇总。
  const _ms = { localRead: 0, meta: 0, idb: 0, localWrite: 0, total: 0 };
  let _idbDetail = null;
  const _tAll = performance.now();
  let proj = _projCache.get(lang);
  let _src = 'mem';
  // 第三百四十四次：内存命中过矛盾态检查（声称 built 却无数据才弃用）；345 起 built=false
  //   投影（库的真实写照）合法缓存内存，防每次重复扫库。
  if (proj && proj.built && !(proj.ranks && Object.keys(proj.ranks).length > 0)) {
    console.warn('[VocabRadar][word-db] 内存缓存投影矛盾（built=true 但无数据），弃用重取');
    proj = null;
  }
  if (proj) console.log(`[VocabRadar][word-db] 整投影命中内存缓存（${proj.built ? Object.keys(proj.ranks).length + ' 词' : '未构建态'}）`);
  if (!proj) {
    // 第二百零六次：先查 storage.local（跨会话存活），未命中才扫库
    let _t = performance.now();
    proj = await projLocalGet(lang);
    _ms.localRead = Math.round(performance.now() - _t);
    _src = 'local';
    if (proj) console.log(`[VocabRadar][word-db] 整投影命中 local 缓存（${Object.keys(proj.ranks).length} 词，读取 ${_ms.localRead}ms）`);
  }
  // 第三百四十五次：meta 对账——缓存投影声称 built=true 而 meta 无构建记录 = 远古毒投影。
  //   实证（用户诊断脚本）：meta 表全空、d_rank 仅 2263 条（残库），而 local 躺着 built=true
  //   投影（expected 28811/dv 0）劫持 ranks FAST PATH 五轮（340-334），库残缺真相被掩盖。
  //   判据唯一且可靠：库若真构建过，重建末块必同事务写 meta；meta 无记录 = 从未成功
  //   构建过 = 投影是远古残物。对账通过（meta.built=true）才放行。
  let _metaBuilt = null;
  if (proj && proj.built) {
    let meta = null;
    const _t = performance.now();
    try { meta = await idbReadMeta(lang); } catch (e) { console.error('[VocabRadar][word-db] meta 对账读取失败:', e); }
    _ms.meta = Math.round(performance.now() - _t);
    _metaBuilt = !!(meta && meta.built);
    if (!_metaBuilt) {
      console.warn(`[VocabRadar][word-db] 缓存投影称 built=true 但 meta 无构建记录（${meta ? '有记录缺标记' : 'meta 缺失'}）——判远古毒投影，弃用改扫库（345 对账）`);
      proj = null;
    }
  }
  if (!proj) {
    _src = 'idb';
    _idbDetail = {};
    const _t = performance.now();
    try {
      proj = await idbGetLangProjection(lang, _idbDetail);
    } catch (e) {
      // 第三百四十三次：扫库异常显性化（此前静默上抛→handler 外层 catch→页面只见「整投影缺失」）
      console.error('[VocabRadar][word-db] 整投影扫库异常（loadProjCached）:', e);
      throw e;
    }
    _ms.idb = Math.round(performance.now() - _t);
    try {
      // 第二百一十次：只落盘 **built** 投影（meta 读取偶发失败产出的残缺投影绝不落盘，
      //   否则每个页面都会判"缺 __built__"而重建，SW 被逐块写库埋掉——火狐重症根因）
      // 第三百四十三次：_partial（分表读取降级）投影同样禁止落盘——坏段不固化，
      //   每次装载重扫重打 error，症状持续可见（不掩耳盗铃）；内存照常缓存（会话内不重扫）。
      if (!proj || !proj.built) {
        console.warn('[VocabRadar][word-db] 投影缺 built 标记，跳过 local 缓存（防毒化）');
      } else if (proj._partial) {
        console.warn('[VocabRadar][word-db] 投影含降级空段(_partial)，跳过 local 缓存（坏段不固化，见上方 error 日志）');
      } else {
        // 第二百零九次：写入前体积保险——单语言投影超 4MB（JSON 序列化后）不写
        // storage.local（Firefox local 配额约 5MB，超限写入行为不可控），只留内存缓存。
        // 2026-10-13：每语言单键直写（不再读全量 blob 改一桶写回）；_diag 瞬时测量不落盘。
        const _tW = performance.now();
        const probe = JSON.stringify(proj);
        if (probe.length <= 4 * 1024 * 1024) {
          const { _diag, ...persist } = proj;
          void _diag;
          projLocalSet(lang, persist);
        } else {
          console.warn('[VocabRadar][word-db] 投影过大（' + probe.length + ' 字符）跳过 local 缓存，仅内存');
        }
        _ms.localWrite = Math.round(performance.now() - _tW);
      }
    } catch (e) { /* ignore */ }
  }
  _ms.total = Math.round(performance.now() - _tAll);
  // 第三百四十五次：诊断载荷随投影回传页面（SW 控制台页面看不到，五轮排障盲区）——
  //   Stage 2 据此打一行日志，命中来源（mem/local/idb）与 meta 对账结果一步可见。
  //   2026-10-13：再加 ms 分段账（local读/meta对账/IDB扫库/local写/总），IDB 扫库
  //   另带连接/三表/meta 明细——196s 卡哪一跳直接可读。
  if (proj) proj._diag = { src: _src, metaBuilt: _metaBuilt, ms: _ms, idbDetail: _idbDetail };
  _projCache.set(lang, proj);
  try {
    const _o = _idbDetail || {};
    console.log(`[VocabRadar][word-db] 投影取数(${lang}) 源=${_src} 总${_ms.total}ms ｜ local读 ${_ms.localRead}ms ｜ meta对账 ${_ms.meta}ms ｜ IDB ${_ms.idb}ms`
      + (_idbDetail ? `（连接 ${_o.open || 0}/rank ${_o.ranks || 0}/tags ${_o.tags || 0}/lemma ${_o.lemmas || 0}/meta ${_o.meta || 0}ms，${_o.rankRows || 0}+${_o.tagRows || 0}+${_o.lemmaRows || 0} 行）` : '')
      + ` ｜ local写 ${_ms.localWrite}ms`);
  } catch (e) { /* ignore */ }
  return proj;
}

/** 第三百四十五次：ranks 切片候选的 meta 对账（loadProjCached/getRanksProjection/handler 三处共用）。
 * 候选必须满足：built=true + ranks 非空 + meta 确有构建记录（三条全过才可信——
 * local 远古毒投影 built=true 但库从未成功构建，实证见 loadProjCached 对账注释）。 */
async function _sliceProjValidated(lang, proj) {
  if (!(proj && proj.built && proj.ranks && Object.keys(proj.ranks).length > 0)) return null;
  let meta = null;
  try { meta = await idbReadMeta(lang); } catch (e) { /* 对账失败从严：当无构建记录处理 */ }
  if (!(meta && meta.built)) {
    console.warn('[VocabRadar][word-db] ranks 切片候选称 built 但 meta 无构建记录——判远古毒投影弃用（345 对账）');
    return null;
  }
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
    } finally {
      // 旧版单键 blob 后台清理（不 await，不阻塞预热回执）
      cleanupLegacyProjCache();
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

/**
 * 只读 ranks 投影（分阶段 Stage 1，跨上下文）
 * 反思（2026-09-04）：首屏高亮只认 rank。优先复用内存里的整投影切片（SW 热时零扫描）；
 *   未命中直接扫 d_rank 单表，ranks-only 结果不写缓存（防残缺投影毒化整投影缓存）。
 * 2026-10-13：ranks 快道与 storage.local 脱钩——旧版内存未命中要读整个多语言 blob
 *   切 ranks（用户机器上 1.6MB blob get 实测 26.2s，两次并发叠加成 196s），而 IDB
 *   d_rank 单表 getAll 本就是亚秒级真相源，built 标记也随 meta 同读，无需任何缓存对账。
 * @param {string} lang 语言代码
 * @returns {Promise<{built:boolean,ranks:object,ranksCount:number,expected:number,dataVersion:number}|null>}
 */
export async function getRanksProjection(lang) {
  if (!lang) return null;
  if (isSW) {
    try {
      // 第三百四十五次：内存切片候选过 meta 对账（远古毒投影曾劫持 FAST PATH 五轮）
      const proj = await _sliceProjValidated(lang, _projCache.get(lang));
      if (proj) {
        return {
          built: true, ranks: proj.ranks, ranksCount: Object.keys(proj.ranks).length,
          expected: proj.expected || 0, dataVersion: proj.dataVersion || 0
        };
      }
      return await idbGetRanksProjection(lang);
    } catch (e) { return null; }
  }
  if (!runtimeValid()) return null;
  try {
    // 第三百七十二次：与 getLangProjection 同款——消息通道瞬断重试一次 + 失败显性打点
    //   （此前静默 null，与"ranks 缺失"不可区分，同为假首建诱因）。
    const resp = await _projSendWithRetry({ type: 'WORD_DB_GET_RANKS_PROJ', lang });
    return (resp && resp.ok) ? resp.proj : null;
  } catch (e) {
    console.error('[VocabRadar][word-db] ranks 投影消息通道异常（SW 未响应/上下文失效，已重试仍失败）:', e);
    return null;
  }
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
 * 2026-09-03 源头过滤：新增 dataVersion 参数（= manifest.version），随末块写入
 *   meta（SW/CS 两条路径都透传）；projection.js 据此与 manifest.version 比对，
 *   不一致即判旧词典数据过期，清库全量重建。
 * @param {string} lang
 * @param {Map<string,{rank?:number|null,tags?:string[]}>|null} dictMap 统一词典 Map
 * @param {number} [expected] 本次构建的真实词条数（meta.expected 实际值基准）
 * @param {number} [dataVersion] 预处理数据版本（manifest.version，meta.dataVersion）
 */
export async function bulkWriteDictionary(lang, dictMap, expected, dataVersion) {
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
        await idbBulkWrite(lang, chunk, isFinal ? expected : undefined, isFinal ? dataVersion : undefined);
        ok = true;
      } else if (runtimeValid()) {
        // 第三百七十二次：消息通道改走 _chunkSendWithRetry（瞬断重试一次）——此前单发
        //   即弃，SW 被杀瞬间 __built__ 标记永远写不上，诱发下次打开假首建死循环。
        const resp = await _chunkSendWithRetry({
          type: 'WORD_DB_BULK_WRITE', lang, entries: chunk, final: isFinal,
          expected: isFinal ? expected : undefined,
          dataVersion: isFinal ? dataVersion : undefined   // 2026-09-03：数据版本透传
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

/**
 * 将内置翻译包释义送入词典 d_trans 分表（跨上下文）
 * 反思（2026-09-04）：与 bulkWriteDictionary 同可靠性口径——分块 1200、任一块失败
 *   立即中止（已写块保留，下次版本重建覆盖；不打任何"完成"标记，失败靠日志明示）。
 *   translation 是定稿字符串（调用方已 join），translationLang 决定 translator 哪对语言能命中。
 * @param {string} lang 源语言（如 'en'）
 * @param {Map<string,string>|null} transMap Map<word_lower, translation定稿字符串>
 * @param {string} [translationLang] 释义语言（如 'zh'）
 * @returns {Promise<boolean>} 全块成功 true
 */
export async function bulkWriteTranslations(lang, transMap, translationLang) {
  if (!lang) return false;
  const entries = [];
  if (transMap) for (const [word, translation] of transMap) {
    if (word && typeof translation === 'string' && translation) entries.push({ word, translation });
  };
  if (entries.length === 0) return false;
  const CHUNK = 1200;
  let allOk = true;
  let lastErr = '';
  const nChunks = Math.max(1, Math.ceil(entries.length / CHUNK));
  for (let i = 0, ci = 0; i < entries.length || ci === 0; i += CHUNK, ci++) {
    const chunk = entries.slice(i, i + CHUNK);
    let ok = false;
    try {
      if (isSW) {
        await idbBulkTrans(lang, chunk, translationLang);
        ok = true;
      } else if (runtimeValid()) {
        // 第三百七十二次：与 BULK_WRITE 同款瞬断重试（内置翻译包回填常与 SW 被杀撞车）。
        const resp = await _chunkSendWithRetry({
          type: 'WORD_DB_BULK_TRANS', lang, entries: chunk, translationLang
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
      console.warn(`[VocabRadar][word-db][bulkTrans] 分块 ${ci + 1}/${nChunks} 写入失败--中止（已写块保留，下次版本重建覆盖）。原因: ${lastErr || '(未知)'}`);
      break;
    }
    if (ci < nChunks - 1) await new Promise((r) => setTimeout(r, 25)); // 块间让出
  }
  if (!allOk) return false;
  return true;
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
      case 'WORD_DB_GET_RANKS_PROJ': {
        // 分阶段投影 Stage 1（2026-09-04）：只读 ranks，供首屏先扫。内存整投影命中
        //   零扫描；未命中直接扫 d_rank 单表（getAll+meta，亚秒级），ranks-only 结果
        //   不写缓存。
        // 2026-10-13：快道与 storage.local 彻底脱钩——旧版未命中要读整个多语言 blob
        //   （用户机器实测 26.2s/次），首屏高亮被病态 storage 后端绑死 196s。IDB 是
        //   真相源，built 随 meta 同读，毒投影对账也不再需要。分段计时随 _diag 回传。
        try {
          const _ms = { localRead: 0, meta: 0, idb: 0, total: 0 };
          let _idbDetail = null;
          const _tAll = performance.now();
          // 第三百四十五次：内存切片候选过 meta 对账（远古毒投影曾劫持 FAST PATH 五轮）
          const _tMem = performance.now();
          const memProj = await _sliceProjValidated(msg.lang, _projCache.get(msg.lang));
          _ms.meta = Math.round(performance.now() - _tMem);
          if (memProj) {
            _ms.total = Math.round(performance.now() - _tAll);
            sendResponse({
              ok: true,
              proj: {
                built: true, ranks: memProj.ranks, ranksCount: Object.keys(memProj.ranks).length,
                expected: memProj.expected || 0, dataVersion: memProj.dataVersion || 0,
                _diag: { src: 'mem', metaBuilt: true, ms: _ms, idbDetail: null }
              }
            });
            console.log(`[VocabRadar][word-db] ranks 取数(${msg.lang}) 源=mem 总${_ms.total}ms（meta对账 ${_ms.meta}ms，${Object.keys(memProj.ranks).length} 词）`);
            return true;
          }
          _idbDetail = {};
          const _t = performance.now();
          const rp = await idbGetRanksProjection(msg.lang, _idbDetail);
          _ms.idb = Math.round(performance.now() - _t);
          _ms.total = Math.round(performance.now() - _tAll);
          rp._diag = { src: 'idb', metaBuilt: !!rp.built, ms: _ms, idbDetail: _idbDetail };
          sendResponse({ ok: true, proj: rp });
          try {
            const _o = _idbDetail;
            console.log(`[VocabRadar][word-db] ranks 取数(${msg.lang}) 源=idb 总${_ms.total}ms ｜ 连接 ${_o.open || 0}ms ｜ rank表 ${_o.ranks || 0}ms（${_o.rows || 0} 行）｜ meta ${_o.meta || 0}ms ｜ built=${rp.built}`);
          } catch (e) { /* ignore */ }
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
        return true;
      }
      case 'WORD_DB_BULK_WRITE': {        // 第一百五十四次·可靠性重构：废除"SW 内存攒批+末块巨事务"（事件页休眠/
        // 大事务失败即前功尽弃且无错误可见）。改为**逐块即时小事务**：
        // 每条消息直接写 IDB（3000->1200 行/块），末块自带 __built__+expected 原子标记；
        // 任一块异常把 error 串回传 CS，绝不静默、绝不打半截标记。
        // 2026-09-03：dataVersion（预处理数据版本）随末块写入 meta。
        try {
          await idbBulkWrite(msg.lang, msg.entries || [], msg.final ? msg.expected : undefined,
            msg.final ? msg.dataVersion : undefined);
          // 2026-10-13：缓存失效只在末块做一次。旧版每个 1200 条写块都失效——
          //   projLocalDel 当年是"读全量 blob→删一桶→写全量"，全量重建 40+ 块即
          //   40+ 次全量读改写（用户病态 storage 上单次 26s，累计十几分钟占满 storage
          //   队列）；即便新单键 remove，逐块删也无必要——写库中途 local 里是上一版
          //   完整投影，被读到是可用旧数据，末块随即失效并回填新版。
          if (msg.final && msg.lang) {
            _projCache.delete(msg.lang);
            // await 删除完成再回填：否则回填的 local 读可能抢先读到旧键（旧版数据
            //   同样能过 meta 对账），把新投影覆盖成旧数据（2026-10-13 顺手修竞态）。
            await projLocalDel(msg.lang);
          }
          // P0-②（2026-09-04）：末块写完后主动 loadProjCached 回填两级缓存——建完即回填，
          //   避免重建后首个页面全表扫库。此处 SW 正热，扫一次填缓存（await，代价落进
          //   重建后台，对用户不可见）；之后首载命中 storage.local 单键（百 ms 级）。
          if (msg.final && msg.lang) {
            const _tRefill = Date.now();
            try {
              await loadProjCached(msg.lang);
              console.log(`[VocabRadar][word-db] 重建末块回填投影缓存完成: ${msg.lang} (${Date.now() - _tRefill}ms)`);
            } catch (e) {
              console.warn('[VocabRadar][word-db] 重建末块回填投影缓存失败（下次加载时扫描回填）:', e && e.message);
            }
            // 第515次：词频表换代后重建词形热集（热集=词频表∩词形行）——
            //   无状态/行未就绪为 no-op；fire-and-forget，不阻塞重建回执。
            scheduleHotRebuild(msg.lang);
          }
          sendResponse({ ok: true, written: (msg.entries || []).length });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
        return true;
      }
      case 'WORD_DB_BULK_TRANS': {
        // 反思（2026-09-04）：内置翻译包逐块即时写 d_trans（与 BULK_WRITE 同口径，
        //   不打构建标记——释义回填失败不阻塞词典构建，靠日志明示＋下次版本重建覆盖）。
        try {
          await idbBulkTrans(msg.lang, msg.entries || [], msg.translationLang);
          sendResponse({ ok: true, written: (msg.entries || []).length });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
        return true;
      }
      case 'WORD_DB_COUNT_TRANS': {
        // 第三百三十九次：d_trans by-lang 索引计数（引导页就绪行分项统计用）。
        try {
          const count = await idbCountTrans(msg.lang);
          sendResponse({ ok: true, count });
        } catch (e) {
          sendResponse({ ok: false, count: 0, error: String((e && e.message) || e) });
        }
        return true;
      }
      case 'WORD_DB_LEMMAS_SIZE': {
        // 第三百三十九次：词形数据仅读缓存计数（绝不触发 CDN 下载，见 lemmas-engine.js）。
        try {
          const r = await lemmasSizeCached(msg.lang);
          sendResponse({ ok: true, size: r.size || 0 });
        } catch (e) {
          sendResponse({ ok: false, size: 0, error: String((e && e.message) || e) });
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
      // 第515次：DICT_CACHE_GET/SET 与 LEMMAS_GET 死分支删除（用户裁定）——
      //   全库无发送方；词形数据权威存储已是 d_lform 行+热集（lemmas-engine.js），
      //   整表 blob 仅作迁移/续传凭据，不再经消息对外暴露。
      // 第225次：DICT_CACHE_STAT 死分支删除（同源裁定）。
      case 'LEMMATIZE_WORD':
        // 反思（2026-08-16 第六十七次）：逐词词形还原--页面不拉整表，
        //   每次只查一个词（首次构建 lemmatizer 可能读 IDB/首次下载，走 try/catch 兜底）。
        sendResponse(await swLemmatizeWord(msg.word, msg.lang || 'en'));
        return true;
      case 'LEMMATIZE_FAMILY':
        // 反思（2026-09-04）：同族反查--页面展开原形折叠时查某原形的全部同族词。
        //   类型名带 LEMMATIZE_ 前缀，沿用 service-worker.js 既有前缀转发，无需改路由。
        sendResponse(await swLemmaFamily(msg.lemma, msg.lang || 'en', msg.limit));
        return true;
      default:
        return false;
    }
  } catch (e) {
    sendResponse({ ok: false, error: String(e && e.message || e) });
    return true;
  }
}
