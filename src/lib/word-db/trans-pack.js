// =============================================================================
// HF WordTranslation 翻译包引擎（第561次，src/lib/word-db/trans-pack.js）
// 职责：把 HF 数据集 vocabradar/WordTranslation 的离线翻译包
//   （data/<learn>_<meaning>.jsonl.gz，每行 {"word":"house","translations":["casa",...]}）
//   下载、校验、解码后批量写入词典 d_trans 分表（translationLang=meaning）——
//   此后 translator 首层词典缓存即命中（getWordCached 按 translationLang 校验语言对），
//   在线渠道只补真正的缺词。泛化内置英中翻译包（loadBuiltinEnZh，本地 en→zh）到
//   全语言对：HF 包成功覆盖写（用户裁定"翻译采用此"=数据集权威），内置包继续装载
//   作下载失败时的本地兜底。
// 三态（每语言对一个 state，_inflight 去重）：
//   ① d_trans 该语言对计数达标 + rawfiles 原件在手且未过期 → 快速返回（零网络）；
//   ② 原件在手（计数不足或包更新）→ 解码回填（无网络）；
//   ③ 全无 → fetchDatasetFile 下载（SHA-256 校验）→ 落 rawfiles → 解码回填。
// 30 天过期（用户裁定"原始文件过期时间设定为30天"）：原件 ts 超 30 天时经
//   verifyDatasetFile 重对账 files.json sha256——未变仅续期时间戳，变了重新下载回填；
//   对账失败保守保留旧包（下轮再对账，不遮蔽：日志明示）。
// 仅 SW 上下文实际执行（db-ops getDB 的 isSW 守卫拒绝 CS 调用）；
//   CS 经 sw-channel WORD_DB_TRANS_PACK 消息路由到 ensureTransPack。
// =============================================================================
import {
  idbRawGet, idbRawPut, idbBulkTrans, idbCountTransPair
} from './db-ops.js';
import { isSW } from './env.js';
import { WT_BASE, WT_FILE_RE, fetchDatasetFile, verifyDatasetFile } from './hf-file.js';

// 原始文件过期时长（用户裁定 30 天）
export const RAW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// 语言对回填判缺阈值（对齐内置英中包补装口径 <1000）：包为 2.8万~6.5万词级，
//   在线缓存一般数百——低于阈值即视为该语言对缺数据。
const TRANS_FILL_MIN = 1000;
// d_trans 单事务写入分片（对齐 sw-channel bulkWriteTranslations CHUNK 1200 量级）
const TRANS_CHUNK = 2000;
// 失败退避：双源全败/解码失败后 10 分钟内快速失败（防页面反复触发重试风暴）
const FAIL_BACKOFF_MS = 10 * 60 * 1000;

// 会话级状态：pair -> Promise 去重；成功完成 pair 集合；pair -> 失败冷却截止
const _inflight = new Map();
const _done = new Set();
const _failUntil = new Map();

/**
 * 解码翻译包 gzip JSONL → d_trans 条目
 * 口径对齐 loadBuiltinEnZh：translations 数组去重取前 5，join(' | ')（splitTransLines
 * 按词性段拆行渲染）；word 统一小写（词典主键口径）。坏行跳过计数。
 * @param {ArrayBuffer} gzBuf gzip 原件
 * @returns {Promise<{entries:Array<{word:string,translation:string}>, bad:number}>}
 */
async function decodeWtPack(gzBuf) {
  const stream = new Response(new Uint8Array(gzBuf)).body.pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  const entries = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { bad += 1; continue; }
    const w = (obj && typeof obj.word === 'string') ? obj.word.trim().toLowerCase() : '';
    const trs = (obj && Array.isArray(obj.translations)) ? obj.translations : [];
    const items = [];
    for (const t of trs) {
      if (typeof t !== 'string') continue;
      const v = t.trim();
      if (v && items.indexOf(v) === -1) items.push(v);
      if (items.length >= 5) break;
    }
    if (w && items.length > 0) entries.push({ word: w, translation: items.join(' | ') });
    else bad += 1;
  }
  return { entries, bad };
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
    const file = 'data/' + pair + '.jsonl.gz';
    const rawKey = 'wt|' + pair;
    let rec = await idbRawGet(rawKey);
    let needFill = true;
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
        // 30 天过期对账（用户裁定）：sha 未变仅续期；变了重拉重填；对账失败保守保留
        const v = await verifyDatasetFile(WT_BASE, WT_FILE_RE, file, rec.sha256);
        if (v.ok && !v.changed) {
          await idbRawPut(Object.assign({}, rec, { ts: Date.now() }));
          const cnt = await idbCountTransPair(src, dst);
          if (cnt >= TRANS_FILL_MIN) {
            _done.add(pair);
            return { ok: true, filled: true, cached: true, words: cnt, renewed: true };
          }
        } else if (v.ok && v.changed) {
          const r = await fetchDatasetFile(WT_BASE, WT_FILE_RE, file);
          if (!r.ok) throw new Error('transPack 过期重拉失败: ' + r.error);
          rec = { k: rawKey, kind: 'wt', gz: r.buf, sha256: r.sha256, bytes: r.bytes, ts: Date.now() };
          await idbRawPut(rec);
        } else {
          // v.ok=false：files.json 对账失败——保留旧包继续用（数据仍 sha 校验过），
          // 不续期（下轮触发再对账）。日志明示不遮蔽。
          console.warn('[VocabRadar][word-db] transPack ' + pair + ' 30天对账失败（保留旧包）: ' + v.error);
        }
      }
    } else {
      // ③ 全无：下载（SHA-256 校验）→ 落 rawfiles
      const r = await fetchDatasetFile(WT_BASE, WT_FILE_RE, file);
      if (!r.ok) throw new Error('transPack 下载失败: ' + r.error);
      rec = { k: rawKey, kind: 'wt', gz: r.buf, sha256: r.sha256, bytes: r.bytes, ts: Date.now() };
      await idbRawPut(rec);
    }
    // ② 解码回填 d_trans（覆盖写：HF 数据集为翻译权威源，用户裁定"翻译采用此"）
    const { entries, bad } = await decodeWtPack(rec.gz);
    if (entries.length === 0) throw new Error('transPack 解码为空（' + file + '，坏行 ' + bad + '）');
    const written = await fillTrans(src, entries, dst);
    _done.add(pair);
    console.log('[VocabRadar][word-db] transPack ' + pair + ' 回填完成: ' + written + ' 词（坏行 ' + bad + '，d_trans tlang=' + dst + '），翻译缓存即席命中，在线只补缺词');
    return { ok: true, filled: true, words: written };
  })();
  _inflight.set(pair, p);
  try {
    return await p;
  } catch (e) {
    _failUntil.set(pair, Date.now() + FAIL_BACKOFF_MS);
    console.warn('[VocabRadar][word-db] transPack ' + pair + ' 失败（10min 退避，期间词典缓存/在线渠道照常）: ' + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    _inflight.delete(pair);
  }
}
