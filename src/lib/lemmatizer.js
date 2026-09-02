// 词形还原（Lemmatization）—— 逐词按需经 SW 查询，页面不持有 13.9 万词整表
//
// 用途：将单词的变形形式还原为原形（lemma）
//   例：running → run, walked → walk, mice → mouse, children → child
//   用于词表标签匹配（CET4 等按原形存储）和 wordfreq rank 查询
//
// 反思（2026-08-09 第九次）：用户明确要求"谁让你设定规则了，禁用，哪怕是没有，日志里面说"。
//   移除全部内置英文规则（IRREGULAR / IRREGULAR_NOUNS / SUFFIX_RULES / lemmatizeEnRule），
//   lemmatize() 仅使用 diverse-lemmas 词典，未加载或未命中时返回原词。
//
// 反思（2026-08-16 第六十七次）：用户裁定"如果每次都要加载原始数据，那还要词典干啥"。
//   ===根因===
//   旧版 preloadLanguage 把 diverse-lemmas 整表（139,070 词）经 LEMMAS_GET 一次拉到页面
//   构建 lemmatizer，每次页面加载都出现"词形还原数据就绪（来源=unified，139070 词）"，
//   与用户原则"词典是缓冲层，查单词所有属性先词典，缺啥字段再组装该字段，
//   缺啥单词再组装该单词。不是预先加载词形还原表"相悖。
//   ===修正方案===
//   1. 页面不再加载词形整表，只维护逐词缓存 _wordCache（查过的词）：
//      lemmatize()/lemmatizeAllCandidates() 同步读缓存，未命中返回原词/仅原词。
//   2. 首次遇到某词需要词形还原时，lemmatizeOne() 发 LEMMATIZE_WORD 消息给 SW；
//      SW 侧在自身内存一次性加载/复用整表（数据源=扩展统一 IDB，仅首次从 CDN 下载并写回），
//      返回该词的 lemma+候选原形；页面写回 _wordCache 供本会话同步复用。
//   3. 词典（统一 IDB 逐词记录）后续直接提供 lemma，不再依赖页面内存整表。

// 逐词词形缓存：key=word_lower|lang，value={lemma, candidates}
// 词典是缓冲层：查过的词缓存下来，重复查词不再发消息
const _wordCache = new Map();
const WORD_CACHE_LIMIT = 2000;

/**
 * 词形还原（同步，仅读逐词缓存）
 * 未缓存（该词尚未经 SW 查询）时返回原词；调用方如需该词原形应先 lemmatizeOne()
 * @param {string} word 单词
 * @param {string} [lang='en'] 语言代码
 * @returns {string} 词形还原后的原形（lemma），未缓存/未还原则返回原词
 */
export function lemmatize(word, lang = 'en') {
  if (!word) return word;
  const w = word.toLowerCase();
  const entry = _wordCache.get(w + '|' + lang);
  return entry ? entry.lemma : w;
}

/**
 * 获取词形还原的所有候选原形（同步，仅读逐词缓存）
 * 用于 wordlists 标签匹配：变形词可能有多个原形候选，任一命中即可
 * @param {string} word 单词
 * @param {string} [lang='en'] 语言代码
 * @returns {string[]} 候选原形数组（含原词）
 */
export function lemmatizeAllCandidates(word, lang = 'en') {
  if (!word) return [word];
  const w = word.toLowerCase();
  const entry = _wordCache.get(w + '|' + lang);
  return entry && entry.candidates && entry.candidates.length ? entry.candidates : [w];
}

/**
 * 该词是否已缓存词形数据（供调用方判断是否还需异步补齐）
 * @param {string} word 单词
 * @param {string} [lang='en'] 语言代码
 * @returns {boolean}
 */
export function hasCachedLemma(word, lang = 'en') {
  if (!word) return false;
  return _wordCache.has(word.toLowerCase() + '|' + lang);
}

/**
 * 逐词词形还原（异步）：首次遇到某词时经 SW 查询，结果写回 _wordCache
 * @param {string} word 单词
 * @param {string} [lang='en'] 语言代码
 * @returns {Promise<{lemma:string, candidates:string[]}>}
 */
export async function lemmatizeOne(word, lang = 'en') {
  const w = (word || '').toLowerCase();
  if (!w) return { lemma: w, candidates: [w] };
  const key = w + '|' + lang;
  const hit = _wordCache.get(key);
  if (hit) return hit;
  const r = await lemmatizeOneViaMessage(w, lang);
  const entry = (r && r.ok && r.lemma)
    ? { lemma: r.lemma, candidates: (r.candidates && r.candidates.length) ? r.candidates : [r.lemma] }
    : { lemma: w, candidates: [w] };
  if (_wordCache.size >= WORD_CACHE_LIMIT) _wordCache.clear();
  _wordCache.set(key, entry);
  // 反思（2026-08-18 第七十四次）：词形引擎不再自行打印日志——
  //   用户要求查单词只按三种情形打印：①第一次查询词典 ②词典外单词 ③词典中没有的属性。
  //   词形引擎（lemmatizeOne）是低层数据补齐工具，打印由 dictionary.js 统一负责
  //   （词典条目/表外/缺属性组装），此处静默，避免与词典层重复刷屏。
  return entry;
}

// 逐词词形还原消息：SW 侧内存持有整表（每 SW 会话一次），页面只取该词的 lemma+候选原形
// 反思（2026-08-16 第六十七次）：不再把 13.9 万词整表经 LEMMAS_GET 传给页面，
//   SW→CS 巨型消息既慢又占内存，且与"缺啥单词再组装该单词"原则相悖。
function lemmatizeOneViaMessage(word, lang) {
  return new Promise((resolve) => {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve(null);
        return;
      }
      let settled = false;
      // SW 首次构建 lemmatizer 需读扩展 IDB（4-8MB），最慢情况下还要首次 CDN 下载，超时给 30s
      const timer = setTimeout(() => {
        if (!settled) { settled = true; resolve(null); }
      }, 30000);
      try {
        chrome.runtime.sendMessage({ type: 'LEMMATIZE_WORD', word, lang }, (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r);
        });
      } catch (sendErr) {
        if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
      }
    } catch (e) {
      resolve(null);
    }
  });
}

/**
 * 诊断信息（2026-08-16 第六十七次）：逐词按需模式，页面不持有整表
 * @returns {{mode:string, cachedWords:number, loadedLangs:string[]}}
 */
export function getDiagState() {
  return {
    mode: 'per-word-via-sw',
    cachedWords: _wordCache.size,
    loadedLangs: []
  };
}
