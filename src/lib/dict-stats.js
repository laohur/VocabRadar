// 词典层数据处理统计（2026-08-16 第七十次）
//
// 背景：用户要求"要说明数据来源——每次处理要说处理了多少文本、分了多少词、有多少单词、
//       各项属性多少从词典来、多少组装的"，且"要理解词典层的逻辑，而非在日志打印上做文章"。
// 本模块在各处理入口的真实读取/组装/翻译处计数（非日志表面功夫）：
//   - 处理入口：
//     * annotator.getAnnotations（整句注释：视频侧栏/文本侧栏/字幕叠加/ASR/OCR 共用）
//     * text-hint-impl.processTextNode（网页逐块高亮）
//   - 每批统计：
//     * 文本字符数 chars / 分词数 tokens / 去重单词数 unique
//     * 各属性（rank/lemma/tags/释义trans）来源账目：
//       - dict：统一词典（扩展数据域 IDB）直读命中
//       - asm：内存词频表 / 词形引擎 / 在线翻译 临时组装（组装结果会写回 IDB，下次直读）
//     * 各类跳过（skipSeen 重复词 / cacheHit 本次未查词的缓存命中 / highFreq 高频 / oov 表外）
//   - 批次环形保留最近 MAX 批，经各模块 getDiagState 的 stats 字段输出到诊断悬浮窗。
// 同页面内所有处理模块共享本实例（ESM 单例），诊断窗一次看到同一账本。

const MAX = 8;
let batches = [];

// 批次时间戳（HH:MM:SS.mmm，便于诊断窗观察先后）
function nowTs() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w, '0');
  return p(d.getHours(), 2) + ':' + p(d.getMinutes(), 2) + ':' + p(d.getSeconds(), 2) + '.' + p(d.getMilliseconds(), 3);
}

/**
 * 开启一批处理统计。
 * @param {string} source 处理来源标识（'annotator' / 'text-hint'）
 * @param {string} label 批次说明（含图例）
 * @returns {object} 批次账目对象（后续计数函数传入）
 */
export function beginBatch(source, label) {
  const b = {
    source,
    label,
    legend: 'dict=统一词典(IDB)直读 · asm=词频表/词形引擎/在线翻译组装（并写回IDB）',
    ts: nowTs(),
    chars: 0,    // 处理文本字符数
    tokens: 0,   // 分词数（本批所有词）
    unique: 0,   // 去重单词数（本批首次见）
    skipSeen: 0, // 重复词（跨批 seen）跳过
    cacheHit: 0, // 本批未重新查词、命中全局缓存
    highFreq: 0, // 高频词（rank<=阈值）跳过
    oov: 0,      // 表外词（rank=null 且注释表外词未开）跳过
    dict: { rank: 0, lemma: 0, tags: 0, trans: 0 },
    asm: { rank: 0, lemma: 0, tags: 0, trans: 0 }
  };
  batches.unshift(b);
  if (batches.length > MAX) batches.length = MAX;
  return b;
}

export function countChars(b, n) { if (b) b.chars += (n || 0); }
export function countTokens(b, n) { if (b) b.tokens += (n || 0); }
export function countUnique(b, n) { if (b) b.unique += (n || 0); }

/** 属性来源计数：field=rank/lemma/tags/trans，source='dict'（词典直读）或 'asm'（组装） */
export function incField(b, field, source) {
  if (!b || !b[source] || !(field in b[source])) return;
  b[source][field]++;
}

/** 标量跳过计数：key=skipSeen/cacheHit/highFreq/oov */
export function incScalar(b, key) {
  if (!b || typeof b[key] !== 'number') return;
  b[key]++;
}

/** 最近 MAX 批账目（新→旧），供 getDiagState 输出 */
export function getBatches() { return batches.slice(); }

/** 最近一批（无则 null） */
export function getLastBatch() { return batches[0] || null; }

/** 清空账本（诊断需要时调用） */
export function resetBatches() { batches = []; }

/**
 * 批次处理完成时的数据来源账本 console.log（②：词典单例化后每次处理写数据来源日志）。
 * 输出：处理了多少文本 / 分了多少词 / 有多少单词，以及各属性（rank/lemma/tags/释义）
 *   dict（统一词典 IDB 直读）vs asm（词频表/词形引擎/在线翻译组装）的真实数量，
 *   和各类跳过计数。同批次统计对象可多次调用（幂等，重复打印不重复计数）。
 * @param {object} b 批次账目对象（beginBatch 返回值）
 */
export function logBatch(b) {
  if (!b) return;
  const d = b.dict, a = b.asm;
  console.log(
    `[VocabRadar][${b.source}] ${b.label} | ${b.chars}字符 / ${b.tokens}分词 / ${b.unique}单词` +
    ` | rank 词典=${d.rank}/组装=${a.rank} · lemma 词典=${d.lemma}/组装=${a.lemma}` +
    ` | tags 词典=${d.tags}/组装=${a.tags} · 释义 词典=${d.trans}/组装=${a.trans}` +
    ` | 跳过: 跨批重复=${b.skipSeen} 缓存命中=${b.cacheHit} 高频=${b.highFreq} 表外=${b.oov}`
  );
}
