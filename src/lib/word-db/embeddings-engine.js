// =============================================================================
// HF WordEmbedding 相关词汇引擎（第561次，src/lib/word-db/embeddings-engine.js）
// 职责：把 HF 数据集 vocabradar/WordEmbedding（每语一对文件：<lang>.words.txt 词表
//   与 <lang>.int8.vector 384 维 int8 量化向量，逐行对齐、行号=词频排名）下载校验后
//   落 rawfiles 原始文件库；查相关词汇时物化 Int8Array 矩阵做 int8 点积取 top-10
//   近邻，剔除同族词形（与同族词汇区不重复）后取前 5，定稿写词典 d_rel 行
//   （v="w1,w2,w3,w4,w5"），此后同词查询零计算命中。
// 数据格式（数据集 README）：反量化 v=int8/127，量化前已 L2 归一化 → 余弦相似度
//   = dot(a,b)/127²（int8 直接累加 384 维不会溢出 int32：127²×384≈6.2e6）。
// 仅 SW 上下文实际执行；CS 经 sw-channel WORD_DB_RELATED 消息路由到 swRelatedWords。
// 30 天过期（用户裁定"原始文件过期时间设定为30天"）：同 trans-pack——ts 超期重对账
//   files.json sha256，未变续期、变了重拉替换（重拉后物化缓存失效重算）。
// =============================================================================
import {
  idbRawGet, idbRawPut, idbGet, idbUpdate
} from './db-ops.js';
import { makeKey } from './key-utils.js';
import { isSW } from './env.js';
import { EMB_BASE, EMB_FILE_RE, fetchDatasetFile, verifyDatasetFile } from './hf-file.js';
import { swLemmatizeWord, swLemmaFamily } from './lemmas-engine.js';

const EMB_DIM = 384;
const EMB_TOPK = 10;      // 用户裁定：展开选出十个向量最近的词汇
const EMB_TAKE = 5;       // 用户裁定：从其中取五个（剔同族词形后按相似度取前 5）
const RAW_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 原始文件 30 天过期（用户裁定）
const STATE_CAP = 1;      // 物化矩阵内存缓存语言数上限（第561次三轮用户裁定"内存里面要两个词向量干啥"：
                          // 一次只驻留一种语言，切语言即淘汰重物化；结果已落 d_rel，重复查询零计算）
const FAIL_BACKOFF_MS = 10 * 60 * 1000;

// 每语言物化状态：{lang, mat:Int8Array(N*384), words:string[], index:Map<lower,i>, N}
const _states = new Map();
const _inflight = new Map();
const _failUntil = new Map();

/** 淘汰最旧物化语言（Map 插入序=装载序） */
function _evictStates() {
  while (_states.size > STATE_CAP) {
    const oldest = _states.keys().next();
    if (oldest.done) break;
    _states.delete(oldest.value);
  }
}

/** rawfiles 记录 → 物化矩阵态（split 词表 + 小写索引，首见优先=高频优先） */
function materialize(lang, rec) {
  const N = Math.floor(rec.vec.byteLength / EMB_DIM);
  if (N <= 0 || rec.vec.byteLength % EMB_DIM !== 0) {
    throw new Error('embPack ' + lang + ' 向量文件大小非 ' + EMB_DIM + ' 的整数倍: ' + rec.vec.byteLength);
  }
  const words = String(rec.words).split('\n');
  const index = new Map();
  for (let i = 0; i < words.length; i++) {
    const w = words[i].trim();
    if (!w) continue;
    const lw = w.toLowerCase();
    if (!index.has(lw)) index.set(lw, i);
  }
  return { lang, mat: new Int8Array(rec.vec), words, index, N };
}

/** 下载该语言两文件（词表+向量，并行）→ rawfiles 单记录（双 sha256 过期基线） */
async function downloadEmb(lang) {
  const fw = 'data/' + lang + '.words.txt';
  const fv = 'data/' + lang + '.int8.vector';
  const [rw, rv] = await Promise.all([
    fetchDatasetFile(EMB_BASE, EMB_FILE_RE, fw),
    fetchDatasetFile(EMB_BASE, EMB_FILE_RE, fv)
  ]);
  if (!rw.ok) throw new Error('embPack 词表下载失败: ' + rw.error);
  if (!rv.ok) throw new Error('embPack 向量下载失败: ' + rv.error);
  const rec = {
    k: 'emb|' + lang, kind: 'emb',
    vec: rv.buf, words: new TextDecoder('utf-8').decode(rw.buf),
    sha256Vec: rv.sha256, sha256Words: rw.sha256,
    bytes: (rv.bytes || 0) + (rw.bytes || 0), ts: Date.now()
  };
  await idbRawPut(rec);
  return rec;
}

/** 30 天过期对账（双文件各自比对；任一变化即整记录重拉） */
async function refreshIfExpired(lang, rec) {
  const expired = !rec.ts || (Date.now() - rec.ts > RAW_TTL_MS);
  if (!expired) return rec;
  const fw = 'data/' + lang + '.words.txt';
  const fv = 'data/' + lang + '.int8.vector';
  const [vw, vv] = await Promise.all([
    verifyDatasetFile(EMB_BASE, EMB_FILE_RE, fw, rec.sha256Words),
    verifyDatasetFile(EMB_BASE, EMB_FILE_RE, fv, rec.sha256Vec)
  ]);
  if (!vw.ok || !vv.ok) {
    // 对账失败保守保留旧包不续期（下轮再对账），日志明示不遮蔽
    console.warn('[VocabRadar][word-db] embPack ' + lang + ' 30天对账失败（保留旧包）: '
      + [vw.error, vv.error].filter(Boolean).join(' | '));
    return rec;
  }
  if (!vw.changed && !vv.changed) {
    const kept = Object.assign({}, rec, { ts: Date.now() });
    await idbRawPut(kept);
    return kept;
  }
  console.log('[VocabRadar][word-db] embPack ' + lang + ' 源有更新（30天对账 sha256 变化），重拉');
  return downloadEmb(lang);
}

/**
 * 确保语言向量态就绪（下载/过期对账/物化），失败抛错由调用方兜底。
 * @param {string} lang 语言码
 */
export async function ensureEmbState(lang) {
  const key = String(lang || '').toLowerCase();
  if (!/^[a-z]{2,3}$/.test(key)) throw new Error('embPack: bad lang: ' + key);
  if (!isSW) throw new Error('embPack: SW only');
  const hit = _states.get(key);
  if (hit) return hit;
  if (_inflight.has(key)) return _inflight.get(key);
  if (Date.now() < (_failUntil.get(key) || 0)) {
    throw new Error('embPack: 近期失败退避中（' + Math.ceil(((_failUntil.get(key) || 0) - Date.now()) / 1000) + 's 后自动重试）');
  }
  const p = (async () => {
    let rec = await idbRawGet('emb|' + key);
    if (!rec || !rec.vec || typeof rec.words !== 'string') {
      rec = await downloadEmb(key);
    } else {
      rec = await refreshIfExpired(key, rec);
    }
    const st = materialize(key, rec);
    _states.set(key, st);
    _evictStates();
    console.log('[VocabRadar][word-db] embPack ' + key + ' 就绪: ' + st.N + ' 词 × ' + EMB_DIM + ' 维 int8（内存物化 ' + (rec.vec.byteLength / 1048576).toFixed(1) + 'MiB）');
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

/** int8 点积 top-K（只收正分；零行/负相关天然不入选） */
function topK(st, qBase, k) {
  const best = [];   // [{i, s}] 按 s 升序，长度 ≤ k
  const mat = st.mat;
  for (let i = 0; i < st.N; i++) {
    let s = 0;
    const base = i * EMB_DIM;
    for (let j = 0; j < EMB_DIM; j++) s += mat[base + j] * mat[qBase + j];
    if (s <= 0) continue;
    if (best.length < k) {
      best.push({ i, s });
      for (let b = best.length - 1; b > 0 && best[b].s < best[b - 1].s; b--) {
        const t = best[b]; best[b] = best[b - 1]; best[b - 1] = t;
      }
    } else if (s > best[0].s) {
      best[0] = { i, s };
      for (let b = 0; b + 1 < best.length && best[b].s > best[b + 1].s; b++) {
        const t = best[b]; best[b] = best[b + 1]; best[b + 1] = t;
      }
    }
  }
  return best;   // 升序存储，读取时从尾（最高分）向头取
}

/**
 * 查相关词汇：d_rel 缓存 → 向量近邻 top-10 → 剔同族词形取前 5 → 定稿写 d_rel。
 * @param {string} lang 学习语言
 * @param {string} word 查询词（调用方已保证单词；内部仍兜底空格门控）
 * @returns {Promise<{ok:boolean, words:string[], cached?:boolean, reason?:string, error?:string}>}
 *   words 空 = 该词无向量（词表外/全零行）或近邻全为同族——如实返回不写缓存。
 */
export async function swRelatedWords(lang, word) {
  const key = String(lang || '').toLowerCase();
  const lower = String(word || '').trim().toLowerCase();
  if (!key || !lower || /\s/.test(lower)) return { ok: true, words: [] };
  // ① d_rel 缓存（词典行直读，含相关词汇定稿串）
  try {
    const rec = await idbGet(makeKey(key, lower));
    if (rec && typeof rec.related === 'string' && rec.related) {
      return { ok: true, words: rec.related.split(','), cached: true };
    }
  } catch (_) { /* 缓存读失败走计算 */ }
  // ② 向量态就绪（首次含下载，卡片侧异步等待不阻塞交互）
  const st = await ensureEmbState(key);
  const qi = st.index.get(lower);
  if (qi == null) return { ok: true, words: [], reason: 'oov' };
  const qBase = qi * EMB_DIM;
  // 全零行（分词后无 token 的词，数据集 meta.zero_vectors）无语义，直接如实返回
  let qNonZero = false;
  for (let j = 0; j < EMB_DIM; j++) { if (st.mat[qBase + j] !== 0) { qNonZero = true; break; } }
  if (!qNonZero) return { ok: true, words: [], reason: 'zero-vector' };
  // ③ top-10 近邻 → 剔同族词形取前 5（与同族词汇区互不重复；同族反查失败降级为只剔自身）
  const fam = new Set([lower]);
  try {
    const lm = await swLemmatizeWord(lower, key);
    const lemma = (lm && lm.lemma) || lower;
    fam.add(String(lemma).toLowerCase());
    const f = await swLemmaFamily(lemma, key, 100);
    for (const w of ((f && f.words) || [])) fam.add(String(w).toLowerCase());
  } catch (_) { /* 词形引擎不可用不阻塞近邻 */ }
  const best = topK(st, qBase, EMB_TOPK);
  const out = [];
  const seen = new Set();
  for (let b = best.length - 1; b >= 0 && out.length < EMB_TAKE; b--) {
    const w = String(st.words[best[b].i] || '').trim();
    if (!w) continue;
    const lw = w.toLowerCase();
    if (fam.has(lw) || seen.has(lw)) continue;
    // 词内含分隔符会破坏 d_rel 逗号定稿串——此类词跳过不入选
    if (lw.indexOf(',') !== -1) continue;
    seen.add(lw);
    out.push(w);
  }
  if (out.length === 0) return { ok: true, words: [] };
  // ④ 定稿写 d_rel（派生字段：clearByLang 随词典重建清掉，重建后按需重算）
  try {
    await idbUpdate(makeKey(key, lower), { related: out.join(',') });
  } catch (e) {
    console.warn('[VocabRadar][word-db] related 写缓存失败（本次返回不持久化）:', e && e.message);
  }
  return { ok: true, words: out, cached: false };
}
