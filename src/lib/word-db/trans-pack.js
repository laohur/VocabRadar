// =============================================================================
// 站点 CDN 翻译包引擎（第561次起，src/lib/word-db/trans-pack.js；第563次改站点源）
// 职责：把站点 CDN 的离线翻译包
//   （data/<learn>/translations_<meaning>.json.gz，明文 JSON {word:[defs...]}）
//   下载、校验、解码后批量写入词典 d_trans 分表（translationLang=meaning）——
//   此后 translator 首层词典缓存即命中（getWordCached 按 translationLang 校验语言对）。
//   泛化内置英中翻译包（loadBuiltinEnZh，本地 en→zh）到全语言对。
// 权威源口径（分轮裁定）：
//   en→zh 用内置包（第561次五轮"英中翻译包用之前的"，本引擎对该语言对直接跳过）；
//   其余语言对站点 CDN 包覆盖写为权威（"新增的放 CDN，之前文件依旧在"），
//   内置包仅覆盖 en→zh。
// 分发依据：VocabRadar/docs/data-pipeline.md §7.4——HF 只做构建期数据源，
//   端上运行时一律从自有域名消费；网站随站部署 web/public/data/<lang>/。
//   gz 容器（Firefox DecompressionStream 不支持 brotli），与近邻表同因。
// 三态（每语言对一个 state，_inflight 去重）：
//   ① d_trans 该语言对计数达标 + rawfiles 原件在手且未过期 → 快速返回（零网络）；
//   ② 原件在手（计数不足或包更新）→ 解码回填（无网络）；
//   ③ 全无 → 拉 manifest（条目数基准）→ 拉 .json.gz → 解码回填。
// 校验（用户裁定"站点单源 + manifest 字节数/结构校验"）：站点无 sha256，
//   故以 manifest.totalEntries 与解包后键数严格相等为完整性闸门（截断/换包即拒），
//   外加 gzip 解压、JSON 对象、defs 数组三重结构校验；校验失败不覆盖旧原件。
// 30 天过期（用户裁定"原始文件过期时间设定为30天"）：原件 ts 超 30 天时重取
//   manifest——generatedAt 未变仅续期时间戳，变了重新下载回填；对账失败保守保留
//   旧包（下轮再对账，不遮蔽：日志明示）。
// 仅 SW 上下文实际执行（db-ops getDB 的 isSW 守卫拒绝 CS 调用）；
//   CS 经 sw-channel WORD_DB_TRANS_PACK 消息路由到 ensureTransPack。
// =============================================================================
import {
  idbRawGet, idbRawPut, idbBulkTrans, idbCountTransPair
} from './db-ops.js';
import { isSW } from './env.js';

// 原始文件过期时长（用户裁定 30 天）
export const RAW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// 语言对回填判缺阈值（对齐内置英中包补装口径 <1000）：包为 2.8万~6.5万词级，
//   在线缓存一般数百——低于阈值即视为该语言对缺数据。
const TRANS_FILL_MIN = 1000;
// d_trans 单事务写入分片（对齐 sw-channel bulkWriteTranslations CHUNK 1200 量级）
const TRANS_CHUNK = 2000;
// 失败退避：下载/解码失败后 10 分钟内快速失败（防页面反复触发重试风暴）
const FAIL_BACKOFF_MS = 10 * 60 * 1000;
// 数据文件超时（翻译包 0.2~1.1MB gz，30s 足够；弱网也够）
const PACK_FETCH_TIMEOUT_MS = 30000;
// manifest 小文件超时（10s，同 wf.js 的小 json 口径）
const MANIFEST_TIMEOUT_MS = 10000;
// 站点只发布 en/zh 两种释义语言的翻译包（契约 §7.1 数据集边界）；
//   其余释义语言端点上本就无包，直接跳过，不去打 404（避免 10min 退避噪声）。
const PACK_DST = new Set(['en', 'zh']);

// 站点数据源判定（与 embeddings-engine.js / content/ws/draft-export.js 同一推导，
//   三处常量需同步）：商店安装（manifest 带 update_url）→ 线上站；本地开发 → 本地站。
const SITE_URL_LOCAL = 'https://localhost:3001';
const SITE_URL_ONLINE = 'https://vocabradar.com';
function siteUrl() {
  try {
    const m = chrome.runtime.getManifest();
    return (m && m.update_url) ? SITE_URL_ONLINE : SITE_URL_LOCAL;
  } catch (_) { return SITE_URL_LOCAL; }
}

// 会话级状态：pair -> Promise 去重；成功完成 pair 集合；pair -> 失败冷却截止
const _inflight = new Map();
const _done = new Set();
const _failUntil = new Map();

/** 带超时 fetch → ArrayBuffer（错误信息带 URL，失败不遮蔽；同 embeddings-engine 口径） */
async function fetchBuf(url, timeoutMs, what) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0) throw new Error('empty response');
    return buf;
  } catch (e) {
    const why = (e && e.name === 'AbortError') ? ('超时 ' + timeoutMs + 'ms') : ((e && e.message) || String(e));
    throw new Error(what + ' 拉取失败: ' + why + '（' + url + '）');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取翻译包清单（明文 JSON，供条目数校验与 30 天对账）
 * @returns {Promise<{totalEntries:number, generatedAt:number}>}
 */
async function fetchPackManifest(src, dst) {
  const url = siteUrl() + '/data/' + src + '/translations_' + dst + '.manifest.json';
  const buf = await fetchBuf(url, MANIFEST_TIMEOUT_MS, src + '→' + dst + ' manifest');
  let j;
  try {
    j = JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
  } catch (e) {
    throw new Error('manifest 非 JSON（' + url + '）: ' + ((e && e.message) || e));
  }
  const total = j && Number.isFinite(j.totalEntries) ? j.totalEntries : -1;
  if (total < 0) throw new Error('manifest 缺 totalEntries（' + url + '）');
  if (j.pair && String(j.pair).toLowerCase() !== (src + '_' + dst)) {
    throw new Error('manifest 语言对不符（' + j.pair + ' ≠ ' + src + '_' + dst + '，' + url + '）');
  }
  return { totalEntries: total, generatedAt: Number.isFinite(j.generatedAt) ? j.generatedAt : 0 };
}

/**
 * 解码站点翻译包（gzip JSON 对象 {word:[defs]}）→ d_trans 条目
 * 口径对齐 loadBuiltinEnZh：translations 数组去重取前 5，join(' | ')（splitTransLines
 * 按词性段拆行渲染）；word 统一小写（词典主键口径）。坏行跳过计数。
 * @param {ArrayBuffer} gzBuf gzip 原件
 * @param {number} totalEntries manifest 条目数基准（键数必须严格相等）
 * @returns {Promise<{entries:Array<{word:string,translation:string}>, bad:number, keys:number}>}
 */
async function decodeSitePack(gzBuf, totalEntries) {
  const stream = new Response(new Uint8Array(gzBuf)).body.pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error('翻译包解压后非 JSON: ' + ((e && e.message) || e));
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('翻译包结构异常（应为 {word:[defs]} 对象）');
  }
  const keys = Object.keys(obj);
  if (keys.length !== totalEntries) {
    throw new Error('翻译包条目数不符: 解包 ' + keys.length + ' ≠ manifest ' + totalEntries + '（截断/换包？）');
  }
  const entries = [];
  let bad = 0;
  for (const rawWord of keys) {
    const w = String(rawWord).trim().toLowerCase();
    const trs = Array.isArray(obj[rawWord]) ? obj[rawWord] : null;
    if (!w || !trs) { bad += 1; continue; }
    const items = [];
    for (const t of trs) {
      if (typeof t !== 'string') continue;
      const v = t.trim();
      if (v && items.indexOf(v) === -1) items.push(v);
      if (items.length >= 5) break;
    }
    if (items.length > 0) entries.push({ word: w, translation: items.join(' | ') });
    else bad += 1;
  }
  return { entries, bad, keys: keys.length };
}

/** 分片写 d_trans（块间让出事件循环，SW 保持可响应；对齐 sw-channel 批量节奏） */
async function fillTrans(learn, entries, meaning) {
  let written = 0;
  for (let i = 0; i < entries.length; i += TRANS_CHUNK) {
    await idbBulkTrans(learn, entries.slice(i, i + TRANS_CHUNK), meaning);
    written += Math.min(TRANS_CHUNK, entries.length - i);
    if (i + TRANS_CHUNK < entries.length) await new Promise((r) => setTimeout(r, 25));
  }
  return written;
}

/**
 * 确保翻译包就绪（下载/回填/过期对账），详见文件头三态。
 * @param {string} learn 源语言（学习语言）
 * @param {string} meaning 释义语言（目标语言）
 * @returns {Promise<{ok:boolean, filled?:boolean, cached?:boolean, skipped?:string,
 *                    words?:number, error?:string}>}
 */
export async function ensureTransPack(learn, meaning) {
  const src = String(learn || '').toLowerCase();
  const dst = String(meaning || '').toLowerCase();
  if (!/^[a-z]{2,3}$/.test(src) || !/^[a-z]{2,3}$/.test(dst)) {
    return { ok: false, error: 'transPack: bad lang pair: ' + src + '->' + dst };
  }
  if (src === dst) return { ok: true, skipped: 'same-lang' };
  // 第561次五轮（用户裁定"英中翻译包用之前的"）：en→zh 恢复内置 ECDICT+LLM 定稿包
  //   （src/data/en/translations_zh.jsonl 随包，projection.js 装载），站点翻译包不再
  //   下载/覆盖该语言对；其余语言对（含 zh→en）照旧走站点 CDN。
  if (src === 'en' && dst === 'zh') return { ok: true, skipped: 'builtin-en-zh' };
  if (!PACK_DST.has(dst)) return { ok: true, skipped: 'no-pack-for-meaning:' + dst };
  if (!isSW) return { ok: false, error: 'transPack: SW only' };
  const pair = src + '_' + dst;
  if (_done.has(pair)) {
    // 第561次：完成标记可能因 clearByLang（词频源更新/词典重建）清掉 d_trans 而失效，
    //   同会话内直接返回会留下“标记在、数据没了”的空窗——按当前语言对实际计数复核，
    //   计数不足即撤回标记走正常回填（索引计数毫秒级，每轮词典装载至多一两次）。
    const cnt = await idbCountTransPair(src, dst);
    if (cnt >= TRANS_FILL_MIN) return { ok: true, filled: true, cached: true, words: cnt };
    _done.delete(pair);
  }
  if (_inflight.has(pair)) return _inflight.get(pair);
  if (Date.now() < (_failUntil.get(pair) || 0)) {
    return { ok: false, error: 'transPack: 近期失败退避中（' + Math.ceil(((_failUntil.get(pair) || 0) - Date.now()) / 1000) + 's）' };
  }
  const p = (async () => {
    const file = 'data/' + src + '/translations_' + dst + '.json.gz';
    // 新键前缀 wts|（站点源）：旧版 HF 原件 wt| 不再命中，切换后自然重拉一次；
    //   旧记录保留在 rawfiles 不主动删（无删除原语，属可复取缓存）。
    const rawKey = 'wts|' + pair;
    const url = siteUrl() + '/' + file;
    let rec = await idbRawGet(rawKey);
    if (rec && rec.gz) {
      // ① 快路：d_trans 该语言对已满 + 原件未过期 → 零网络返回
      const expired = !rec.ts || (Date.now() - rec.ts > RAW_TTL_MS);
      if (!expired) {
        const cnt = await idbCountTransPair(src, dst);
        if (cnt >= TRANS_FILL_MIN) {
          _done.add(pair);
          return { ok: true, filled: true, cached: true, words: cnt };
        }
      } else {
        // 30 天过期对账（用户裁定）：generatedAt 未变仅续期；变了重拉重填；
        //   对账失败保守保留旧包继续用（下轮再对账）。
        try {
          const mf = await fetchPackManifest(src, dst);
          if (mf.generatedAt && rec.generatedAt && mf.generatedAt === rec.generatedAt) {
            await idbRawPut(Object.assign({}, rec, { ts: Date.now() }));
            const cnt = await idbCountTransPair(src, dst);
            if (cnt >= TRANS_FILL_MIN) {
              _done.add(pair);
              return { ok: true, filled: true, cached: true, words: cnt, renewed: true };
            }
          } else {
            const buf = await fetchBuf(url, PACK_FETCH_TIMEOUT_MS, pair + ' 翻译包（过期重拉）');
            rec = { k: rawKey, kind: 'wts', gz: buf, bytes: buf.byteLength, generatedAt: mf.generatedAt, totalEntries: mf.totalEntries, ts: Date.now() };
            await idbRawPut(rec);
          }
        } catch (e) {
          console.warn('[VocabRadar][word-db] transPack ' + pair + ' 30天对账失败（保留旧包）: ' + ((e && e.message) || e));
        }
      }
    } else {
      // ③ 全无：manifest（条目数基准）→ 下载 → 落 rawfiles
      const mf = await fetchPackManifest(src, dst);
      const buf = await fetchBuf(url, PACK_FETCH_TIMEOUT_MS, pair + ' 翻译包');
      rec = { k: rawKey, kind: 'wts', gz: buf, bytes: buf.byteLength, generatedAt: mf.generatedAt, totalEntries: mf.totalEntries, ts: Date.now() };
      await idbRawPut(rec);
    }
    // ② 解码回填 d_trans（覆盖写：站点 CDN 包为翻译权威源，用户裁定"翻译采用此"）
    if (!Number.isFinite(rec.totalEntries)) {
      throw new Error('transPack 原件缺条目数基准（' + rawKey + '），无法完整性校验，拒绝回填');
    }
    const { entries, bad, keys } = await decodeSitePack(rec.gz, rec.totalEntries);
    if (entries.length === 0) throw new Error('transPack 解码为空（' + file + '，键 ' + keys + '，坏行 ' + bad + '）');
    const written = await fillTrans(src, entries, dst);
    _done.add(pair);
    console.log('[VocabRadar][word-db] transPack ' + pair + ' 回填完成: ' + written + ' 词（键 ' + keys + '，坏行 ' + bad + '，d_trans tlang=' + dst + '），翻译缓存即席命中，在线只补缺词');
    return { ok: true, filled: true, words: written };
  })();
  _inflight.set(pair, p);
  try {
    return await p;
  } catch (e) {
    _failUntil.set(pair, Date.now() + FAIL_BACKOFF_MS);
    console.warn('[VocabRadar][word-db] transPack ' + pair + ' 失败（10min 退避，期间词典缓存/在线渠道照常）: ' + ((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    _inflight.delete(pair);
  }
}
