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
//
// 第369次（方案A层3）：SW 消息层故障冷却——旧版超时 30s 且逐词各等各的：SW 冷装载/
//   无响应期间，N 个生词 = N×30s 串行挂起（本次用户报"注释很晚才出现"的根因链一环）。
//   改法：①超时 30s→8s（正常冷装载 1~17s 多数落在 8s 内；368 已给 SW 端 lemmas 引擎
//   加退避快速失败，超时只剩"SW 忙/僵"一种慢场景）；②任一 transport 失败（超时/
//   lastError/发送异常）即进入 60s 冷却，冷却期内消息直接快速降级"原词即原形"，
//   不再逐词重放等满超时；③收到成功响应即解除冷却（SW 恢复后最多再黑 60s）。
//   注意：SW 正常应答（哪怕 ok:false，如词不在词形表）不算故障，不触发冷却。
const SW_MSG_TIMEOUT_MS = 8000;
const SW_FAIL_COOLDOWN_MS = 60000;
let _swFailUntil = 0; // 冷却截止时间戳，0=未冷却（lemmatizeOne/lemmaFamily 共享同一 SW 通道）
function swMsgSend(msg) {
  return new Promise((resolve) => {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve(null);
        return;
      }
      if (Date.now() < _swFailUntil) { resolve(null); return; } // 冷却期：不发消息快速降级
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; _swFailUntil = Date.now() + SW_FAIL_COOLDOWN_MS; resolve(null); }
      }, SW_MSG_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) { _swFailUntil = Date.now() + SW_FAIL_COOLDOWN_MS; resolve(null); return; }
          if (r && r.ok) _swFailUntil = 0; // 成功响应=通道健康，解除冷却
          resolve(r);
        });
      } catch (sendErr) {
        if (!settled) { settled = true; clearTimeout(timer); _swFailUntil = Date.now() + SW_FAIL_COOLDOWN_MS; resolve(null); }
      }
    } catch (e) {
      resolve(null);
    }
  });
}

function lemmatizeOneViaMessage(word, lang) {
  return swMsgSend({ type: 'LEMMATIZE_WORD', word, lang });
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

// 同族反查缓存（2026-09-04）：key=lemmalower|lang|limit → words[]（页面会话内复用，
// SW 侧另有整表扫描缓存；两层都不命中才真正扫表）
const _familyCache = new Map();
const FAMILY_CACHE_LIMIT = 200;

/**
 * 查某原形的同族词（异步，经 SW 反向扫描词形整表）
 * @param {string} lemma 原形（小写）
 * @param {string} [lang='en'] 语言代码
 * @param {number} [limit=20] 返回上限
 * @returns {Promise<string[]>} 同族词数组（失败回空数组，不抛错）
 */
export async function lemmaFamily(lemma, lang = 'en', limit = 20) {
  const target = String(lemma || '').toLowerCase();
  if (!target) return [];
  const key = target + '|' + (lang || 'en') + '|' + (limit || 20);
  const hit = _familyCache.get(key);
  if (hit) return hit;
  const words = await lemmaFamilyViaMessage(target, lang || 'en', limit || 20);
  const out = Array.isArray(words) ? words : [];
  if (_familyCache.size >= FAMILY_CACHE_LIMIT) _familyCache.clear();
  _familyCache.set(key, out);
  return out;
}

// 同族反查消息：SW 侧反向扫描整表（第369次：与 lemmatizeOne 同走 swMsgSend——8s 超时
//   + 60s 故障冷却共享同一通道状态，旧版独立 30s 超时同样存在逐词挂起问题）
function lemmaFamilyViaMessage(lemma, lang, limit) {
  return swMsgSend({ type: 'LEMMATIZE_FAMILY', lemma, lang, limit }).then((r) => {
    return (r && r.ok && Array.isArray(r.words)) ? r.words : [];
  });
}
