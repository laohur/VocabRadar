// =============================================================================
// HF WordEmbedding 相关词汇引擎（第561次，src/lib/word-db/embeddings-engine.js）
// 职责：把 HF 数据集 vocabradar/WordEmbedding（每语一对文件：<lang>.words.txt 词表
//   与 <lang>.int8.vector 384 维 int8 量化向量，逐行对齐、行号=词频排名）下载校验后
//   落 rawfiles 原始文件库；查相关词汇时物化 Int8Array 矩阵，按 Matryoshka 截断
//   前 128 维算余弦（四轮裁定），跳过自身/同族词形（与同族词汇区不重复）/零范数行
//   后排序直取前 5，定稿写词典 d_rel 行（v="w1,w2,w3,w4,w5"），此后同词查询零计算命中。
// 数据格式（数据集 README）：反量化 v=int8/127，量化前已 L2 归一化 → 原地长余弦
//   = dot(a,b)/127²；截断 128 维后向量非单位长，须乘逐行截断范数倒数校正
//   （int8 直接累加 128 维不会溢出 int32：127²×128≈2.1e6）。
// 仅 SW 上下文实际执行；CS 经 sw-channel WORD_DB_RELATED 消息路由到 swRelatedWords。
// 30 天过期（用户裁定"原始文件过期时间设定为30天"）：同 trans-pack——ts 超期重对账
//   files.json sha256，未变续期、变了重拉替换（重拉后物化缓存失效重算）。
// =============================================================================
import {
  idbRawGet, idbRawPut, idbGet, idbUpdate, idbRelClearAll
} from './db-ops.js';
import { makeKey } from './key-utils.js';
import { isSW } from './env.js';
import { EMB_BASE, EMB_FILE_RE, fetchDatasetFile, verifyDatasetFile } from './hf-file.js';
import { swLemmatizeWord, swLemmaFamily } from './lemmas-engine.js';

const EMB_DIM = 384;
// 第561次四轮（用户笔误更正"选出向量最近的五个词汇"）：不再先取 top-10 池——
//   相似度排序单遍扫描，跳过自身/同族词形后直接取前 5。
const EMB_TAKE = 5;
// 速度（用户裁定"速度慢，选多少维好"=128）：bekko 是 Matryoshka 模型（数据集
//   README 官方支持截断 256/128/64），取前 128 维计算余弦——乘加量 1/3，近邻
//   排序质量足够（int8 384 维本身 top-10 重合率实测 98.3%）。截断后向量非单位
//   长，逐行预存截断范数倒数做余弦校正（materialize 一次性算好）。注意：截断
//   只加速计算段；首查大头是向量包首次下载（一次性）与物化，与维度无关。
//   还嫌慢可改 64（近邻开始发糊，不推荐）。
const EMB_DIMS_USED = 128;
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
  const mat = new Int8Array(rec.vec);
  // 截断维度内逐行范数的倒数（Matryoshka 截断后向量非单位长，余弦须除回）；
  //   全零行（数据集 meta.zero_vectors）invNorm=0 天然出局。一次性 N×128，
  //   此后每次查询只做 128 维点积 + 两次乘法校正。
  const invNorm = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    const base = i * EMB_DIM;
    for (let j = 0; j < EMB_DIMS_USED; j++) { const v = mat[base + j]; s += v * v; }
    invNorm[i] = s > 0 ? 1 / Math.sqrt(s) : 0;
  }
  // 小写词表（排序扫描逐行同族过滤用，避免查询时对正分行做 toLowerCase）
  const lowerWords = new Array(N);
  for (let i = 0; i < N; i++) lowerWords[i] = String(words[i] || '').toLowerCase();
  return { lang, mat, words, lowerWords, index, N, invNorm };
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

// 第561次四轮：相关词汇算法变更（top-10 池→排序直取 5 + Matryoshka 128 维截断），
//   d_rel 旧结果一次性清空按需重算（派生缓存）。storage 记版本号，SW 会话内只查一次。
const RELATED_ALGO_VER = 2;
let _relVerChecked = null;
function ensureRelAlgoVer() {
  if (_relVerChecked) return _relVerChecked;
  _relVerChecked = (async () => {
    try {
      const { relAlgoVer = 0 } = await chrome.storage.local.get('relAlgoVer');
      if (relAlgoVer !== RELATED_ALGO_VER) {
        await idbRelClearAll();
        await chrome.storage.local.set({ relAlgoVer: RELATED_ALGO_VER });
        console.log('[VocabRadar][word-db] related 算法升级 v' + RELATED_ALGO_VER + '，d_rel 旧结果已清空（按需重算）');
      }
    } catch (_) { /* 版本校验失败不清缓存（旧值口径旧但仍可用） */ }
  })();
  return _relVerChecked;
}

/**
 * 查相关词汇：d_rel 缓存 → 向量近邻排序直取 5 → 定稿写 d_rel。
 * @param {string} lang 学习语言
 * @param {string} word 查询词（调用方已保证单词；内部仍兜底空格门控）
 * @returns {Promise<{ok:boolean, words:string[], cached?:boolean, reason?:string, error?:string}>}
 *   words 空 = 该词无向量（词表外/全零行）或近邻全为同族——如实返回不写缓存。
 */
export async function swRelatedWords(lang, word) {
  const key = String(lang || '').toLowerCase();
  const lower = String(word || '').trim().toLowerCase();
  if (!key || !lower || /\s/.test(lower)) return { ok: true, words: [] };
  // 算法版本对账（变更时一次性清旧缓存）
  await ensureRelAlgoVer();
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
  // 查询行截断范数（全零行如实返回：分词后无 token 的词无语义）
  let qn = 0;
  for (let j = 0; j < EMB_DIMS_USED; j++) { const v = st.mat[qBase + j]; qn += v * v; }
  const qInv = qn > 0 ? 1 / Math.sqrt(qn) : 0;
  if (!qInv) return { ok: true, words: [], reason: 'zero-vector' };
  // ③ 余弦排序单遍扫描（截断 128 维）：跳过自身/同族词形/零范数行，直接取前 5
  //   （与同族词汇区互不重复；同族反查失败降级为只剔自身）
  const fam = new Set([lower]);
  try {
    const lm = await swLemmatizeWord(lower, key);
    const lemma = (lm && lm.lemma) || lower;
    fam.add(String(lemma).toLowerCase());
    const f = await swLemmaFamily(lemma, key, 100);
    for (const w of ((f && f.words) || [])) fam.add(String(w).toLowerCase());
  } catch (_) { /* 词形引擎不可用不阻塞近邻 */ }
  const best = [];   // [{i, s}] 按 s 升序，长度 ≤ EMB_TAKE
  const mat = st.mat;
  for (let i = 0; i < st.N; i++) {
    const base = i * EMB_DIM;
    let s = 0;
    for (let j = 0; j < EMB_DIMS_USED; j++) s += mat[base + j] * mat[qBase + j];
    if (s <= 0) continue;
    if (fam.has(st.lowerWords[i])) continue;
    s = s * st.invNorm[i] * qInv;
    if (best.length < EMB_TAKE) {
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
  const out = [];
  const seen = new Set();
  for (let b = best.length - 1; b >= 0; b--) {
    const w = String(st.words[best[b].i] || '').trim();
    if (!w) continue;
    const lw = w.toLowerCase();
    // 词内含分隔符会破坏 d_rel 逗号定稿串——此类词跳过不入选
    if (fam.has(lw) || seen.has(lw) || lw.indexOf(',') !== -1) continue;
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
