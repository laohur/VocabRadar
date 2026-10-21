// =============================================================================
// 相关词汇近邻表引擎（第561次五轮重构，src/lib/word-db/embeddings-engine.js）
// 契约：VocabRadar/data-pipeline.md §7.3「词向量近邻表」——管线预先算好每词
//   余弦 Top-10 邻居（dot>0、去自身、去全零行，相似度降序），产物
//   data/related/<lang>.bin = 8 字节头（magic 'VRRD' + version u16 + K u16，LE）
//   + N×K uint16 LE。行对齐：第 i 行 = 词频表 rank=i+1 的词（含跨桶重复词占位，
//   与词典 rank 全局递增计数严格一致）；值 = 邻居词的 rank-1，0xFFFF 哨兵。
// 运行时只查表不算向量（用户裁定"运行时不需要再算了"；此前 int8 矩阵物化/
//   点积计算路径随本轮整体删除——向量本体不再下载，内存与速度问题一并消失）。
// 分发（六轮裁定"近邻表从网站中获得"）：按契约 §7.1/§7.4 分层——HF 只做构建期
//   数据源，运行时一律从自有域名消费：网站随站部署 web/public/data/<lang>/
//   related.bin.gz（gz 容器与网站端一致，Firefox DecompressionStream 不支持
//   brotli），扩展拉 <site>/data/<lang>/related.bin.gz 解压校验后落 rawfiles；
//   下载失败静默降级（相关词汇行隐藏，日志明示），不阻塞。
// 链路：词 → 词典 rank（d_rank 行）→ 表行 → 邻居 rank → rank→word 反查（d_rank
//   投影反转，SW 会话缓存，词典重建时失效）→ 滤同族词形（与同族词汇区不重复）
//   取前 5 → 定稿写词典 d_rel 行，此后同词查询零开销命中。
// 仅 SW 上下文实际执行；CS 经 sw-channel WORD_DB_RELATED 消息路由到 swRelatedWords。
// 30 天过期（用户裁定）：ts 超期重新拉取（站点数据随构建更新，无独立 sha 基线，
//   manifest.bytes/K + 表头 VRRD/K/N 双校验保完整性）。
// =============================================================================
import {
  idbRawGet, idbRawPut, idbGet, idbUpdate, idbRelClearAll, idbGetRanksProjection
} from './db-ops.js';
import { makeKey } from './key-utils.js';
import { isSW } from './env.js';
import { swLemmatizeWord, swLemmaFamily } from './lemmas-engine.js';

// 展示条数（用户裁定"选出向量最近的五个词汇"）：表存 Top-10，展示滤同族后取前 5
const EMB_TAKE = 5;
const RAW_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 原始文件 30 天过期（用户裁定）
const FAIL_BACKOFF_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30000;                // 单次拉取超时（几百 KB gz 足够）
// 表头魔数：文件前 4 字节为 ASCII 'V','R','R','D'（0x56,0x52,0x52,0x44），
// 契约"LE u32"= 小端读出 0x44525256（'D' 为最高字节）。第561次七轮修：此前把
// u32 字面量写成大端读法 0x56525244，校验永不通过＝查表恒失败（相近词不显示）。
const TABLE_MAGIC = 0x44525256;

// 站点数据源判定（与 src/content/ws/draft-export.js getSiteUrl 同款推导，双处常量
// 需同步）：商店安装（manifest 带 update_url）→ 线上站；本地开发 → 本地站。
const SITE_URL_LOCAL = 'https://localhost:3001';
const SITE_URL_ONLINE = 'https://vocabradar.com';
function siteUrl() {
  try {
    const m = chrome.runtime.getManifest();
    return (m && m.update_url) ? SITE_URL_ONLINE : SITE_URL_LOCAL;
  } catch (_) { return SITE_URL_LOCAL; }
}

/** 拉取并解压近邻表（站点 gz 容器 → 原始 .bin；带超时防源挂起拖死链路） */
async function fetchRelatedGz(lang) {
  const url = siteUrl() + '/data/' + lang + '/related.bin.gz';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const gz = await res.arrayBuffer();
    if (!gz || gz.byteLength === 0) throw new Error('empty response');
    const stream = new Response(gz).body.pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
  } catch (e) {
    throw new Error(String((e && e.name === 'AbortError') ? ('超时 ' + FETCH_TIMEOUT_MS + 'ms') : ((e && e.message) || e)) + '（' + url + '）');
  } finally {
    clearTimeout(timer);
  }
}

// 每语言近邻表状态：{lang, bin:ArrayBuffer, dv:DataView, K, N}
const _tables = new Map();
// 每语言 rank→word 反查数组（词典 rank 与表行对齐的桥，词典重建时失效）
const _rankIndex = new Map();
const _inflight = new Map();
const _failUntil = new Map();

/** 词典重建后失效 rank→word 反查缓存（sw-channel BULK_WRITE 末块/清库分支调用） */
export function invalidateRelRankIndex(lang) {
  if (lang) _rankIndex.delete(String(lang).toLowerCase());
  else _rankIndex.clear();
}

/**
 * rank→word 反查数组（下标=rank-1；跨桶重复词各占其 rank 位，与管线行对齐一致）。
 * 取数 = d_rank 投影（SW 投影缓存命中则零扫库），反转一次后会话内复用。
 */
async function getRankIndex(lang) {
  const hit = _rankIndex.get(lang);
  if (hit) return hit;
  const proj = await idbGetRanksProjection(lang);
  const ranks = (proj && proj.ranks) || {};
  const arr = [];
  for (const word in ranks) {
    const r = ranks[word];
    if (Number.isInteger(r) && r >= 1) arr[r - 1] = word;
  }
  _rankIndex.set(lang, arr);
  return arr;
}

/** 校验近邻表头并取出 N/K（契约：magic 'VRRD' + version u16 + K u16 + N×K uint16） */
function validateTable(lang, buf) {
  if (!buf || buf.byteLength < 8) throw new Error('relTable ' + lang + ' 文件过小: ' + (buf ? buf.byteLength : 0));
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== TABLE_MAGIC) throw new Error('relTable ' + lang + ' magic 不符: 0x' + magic.toString(16));
  const ver = dv.getUint16(4, true);
  const k = dv.getUint16(6, true);
  if (k < 1 || k > 64) throw new Error('relTable ' + lang + ' K 非法: ' + k);
  const body = buf.byteLength - 8;
  if (body % (k * 2) !== 0) throw new Error('relTable ' + lang + ' 大小非 K×2 整数倍: ' + body);
  return { ver, K: k, N: body / (k * 2) };
}

/**
 * 拉取近邻表清单（related.manifest.json，明文）——字节数/K 校验基准。
 * 清单不可得时返回 null 并告警：表头 VRRD/K/N 严格校验仍在，不阻塞功能。
 */
async function fetchRelManifest(lang) {
  const url = siteUrl() + '/data/' + lang + '/related.manifest.json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    return (j && typeof j === 'object') ? j : null;
  } catch (e) {
    console.warn('[VocabRadar][word-db] relTable ' + lang + ' manifest 不可得，本次仅做表头校验: ' + ((e && e.message) || e));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 从站点拉取近邻表 → rawfiles 记录（表头严格校验 + manifest 字节数/K 对账） */
async function downloadRelTable(lang) {
  const [buf, mf] = await Promise.all([fetchRelatedGz(lang), fetchRelManifest(lang)]);
  const meta = validateTable(lang, buf);
  // 用户裁定"站点单源 + manifest 字节数/结构校验"：站点无 sha256，
  //   以 manifest.bytes（明文 .bin 长度）与 manifest.k 作完整性闸门；不符即拒、不落库。
  if (mf) {
    if (Number.isFinite(mf.bytes) && mf.bytes !== buf.byteLength) {
      throw new Error('relTable ' + lang + ' 字节数不符: ' + buf.byteLength + ' ≠ manifest ' + mf.bytes);
    }
    if (Number.isFinite(mf.k) && mf.k !== meta.K) {
      throw new Error('relTable ' + lang + ' K 不符: ' + meta.K + ' ≠ manifest ' + mf.k);
    }
  }
  const rec = {
    k: 'rel|' + lang, kind: 'rel', bin: buf,
    ver: meta.ver, K: meta.K, N: meta.N,
    bytes: buf.byteLength, ts: Date.now()
  };
  await idbRawPut(rec);
  return rec;
}

/** 30 天过期：站点数据随构建更新、无独立 sha 基线，超期直接重拉（manifest 字节数 + 表头重校验） */
async function refreshRelTableIfExpired(lang, rec) {
  if (rec.ts && Date.now() - rec.ts <= RAW_TTL_MS) return rec;
  console.log('[VocabRadar][word-db] relTable ' + lang + ' 超 30 天，重新拉取');
  return downloadRelTable(lang);
}

/**
 * 确保语言近邻表就绪（下载/过期对账），失败抛错由调用方兜底。
 * @param {string} lang 语言码
 */
export async function ensureRelTable(lang) {
  const key = String(lang || '').toLowerCase();
  if (!/^[a-z]{2,3}$/.test(key)) throw new Error('relTable: bad lang: ' + key);
  if (!isSW) throw new Error('relTable: SW only');
  const hit = _tables.get(key);
  if (hit) return hit;
  if (_inflight.has(key)) return _inflight.get(key);
  if (Date.now() < (_failUntil.get(key) || 0)) {
    throw new Error('relTable: 近期失败退避中（' + Math.ceil(((_failUntil.get(key) || 0) - Date.now()) / 1000) + 's 后自动重试）');
  }
  const p = (async () => {
    let rec = await idbRawGet('rel|' + key);
    if (!rec || !rec.bin) {
      rec = await downloadRelTable(key);
    } else {
      rec = await refreshRelTableIfExpired(key, rec);
    }
    const meta = validateTable(key, rec.bin);
    const st = { lang: key, bin: rec.bin, dv: new DataView(rec.bin), K: meta.K, N: meta.N };
    _tables.set(key, st);
    console.log('[VocabRadar][word-db] relTable ' + key + ' 就绪: ' + meta.N + ' 词 × Top' + meta.K + '（v' + meta.ver + '，' + (rec.bin.byteLength / 1024).toFixed(1) + 'KB）');
    return st;
  })();
  _inflight.set(key, p);
  try {
    return await p;
  } catch (e) {
    _failUntil.set(key, Date.now() + FAIL_BACKOFF_MS);
    throw e;
  } finally {
    _inflight.delete(key);
  }
}

// 第561次五轮：相关词汇改查预计算近邻表（此前为运行时向量点积），d_rel 旧结果
//   一次性清空按需重算（派生缓存）。storage 记版本号，SW 会话内只查一次。
const RELATED_ALGO_VER = 3;
let _relVerChecked = null;
function ensureRelAlgoVer() {
  if (_relVerChecked) return _relVerChecked;
  _relVerChecked = (async () => {
    try {
      const { relAlgoVer = 0 } = await chrome.storage.local.get('relAlgoVer');
      if (relAlgoVer !== RELATED_ALGO_VER) {
        await idbRelClearAll();
        await chrome.storage.local.set({ relAlgoVer: RELATED_ALGO_VER });
        console.log('[VocabRadar][word-db] related 算法升级 v' + RELATED_ALGO_VER + '（预计算近邻表查表），d_rel 旧结果已清空');
      }
    } catch (_) { /* 版本校验失败不清缓存（旧值口径旧但仍可用） */ }
  })();
  return _relVerChecked;
}

/**
 * 查相关词汇：d_rel 缓存 → 近邻表查表（rank 定位行）→ 滤同族取前 5 → 定稿写 d_rel。
 * @param {string} lang 学习语言
 * @param {string} word 查询词（调用方已保证单词；内部仍兜底空格门控）
 * @returns {Promise<{ok:boolean, words:string[], cached?:boolean, reason?:string, error?:string}>}
 *   words 空 = 表外 OOV（无 rank 即无表行，契约 §4）/行越界/近邻全为同族/表未发布
 *   ——如实返回不写缓存。
 */
export async function swRelatedWords(lang, word) {
  const key = String(lang || '').toLowerCase();
  const lower = String(word || '').trim().toLowerCase();
  if (!key || !lower || /\s/.test(lower)) return { ok: true, words: [] };
  // 算法版本对账（变更时一次性清旧缓存）
  await ensureRelAlgoVer();
  // ① d_rel 缓存（词典行直读，含相关词汇定稿串）
  let rec = null;
  try {
    rec = await idbGet(makeKey(key, lower));
    if (rec && typeof rec.related === 'string' && rec.related) {
      return { ok: true, words: rec.related.split(','), cached: true };
    }
  } catch (_) { /* 缓存读失败走查表 */ }
  // ② 词的 rank（词典行自带；表外 OOV 无 rank 即无表行——契约 §7.3 行对齐）
  const rank = (rec && typeof rec.rank === 'number') ? rec.rank : null;
  if (rank == null || rank < 1) return { ok: true, words: [], reason: 'oov' };
  // ③ 近邻表就绪 + 行定位（row = rank-1）
  const table = await ensureRelTable(key);
  const rowIdx = rank - 1;
  if (rowIdx >= table.N) return { ok: true, words: [], reason: 'row-out-of-range' };
  const rankArr = await getRankIndex(key);
  // ④ 同族词形过滤（表按管线规则只去自身；展示端先还原原形再反查同族，与同族
  //   词汇区互不重复；反查失败降级为只剔自身）
  const fam = new Set([lower]);
  try {
    const lm = await swLemmatizeWord(lower, key);
    const lemma = (lm && lm.lemma) || lower;
    fam.add(String(lemma).toLowerCase());
    const f = await swLemmaFamily(lemma, key, 100);
    for (const w of ((f && f.words) || [])) fam.add(String(w).toLowerCase());
  } catch (_) { /* 词形引擎不可用不阻塞查表 */ }
  // ⑤ 读 Top-K 邻居（邻居 rank-1 → 反查词）滤同族取前 5
  const off = 8 + rowIdx * table.K * 2;
  const out = [];
  const seen = new Set();
  for (let i = 0; i < table.K && out.length < EMB_TAKE; i++) {
    const v = table.dv.getUint16(off + i * 2, true);
    if (v === 0xFFFF) continue;   // 哨兵：无更多邻居
    const w = rankArr[v];         // 值 = 邻居 rank-1，反查数组下标即 rank-1
    if (!w) continue;             // 词频表更新后 rank 越界/缺词——跳过（30天对账会刷新表）
    const lw = w.toLowerCase();
    if (fam.has(lw) || seen.has(lw) || lw.indexOf(',') !== -1) continue;
    seen.add(lw);
    out.push(w);
  }
  if (out.length === 0) return { ok: true, words: [] };
  // ⑥ 定稿写 d_rel（派生字段：clearByLang 随词典重建清掉，重建后按需重查）
  try {
    await idbUpdate(makeKey(key, lower), { related: out.join(',') });
  } catch (e) {
    console.warn('[VocabRadar][word-db] related 写缓存失败（本次返回不持久化）:', e && e.message);
  }
  return { ok: true, words: out, cached: false };
}
