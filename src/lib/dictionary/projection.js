// ============================================================
// 文件职责：词典内存投影构建与源重建（src/lib/dictionary/projection.js）
// 来源：拆分自 src/lib/dictionary.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// _loadDict（懒加载主流程：getLangProjection 读词典投影 -> 已构建则合并为内存
//   统一词条表 dictState.dictMap；缺 __built__ 标记或投影不完整则 _rebuildFromSources）
// 与 _rebuildFromSources（装载函数唯一入口：loadWordfreq/loadWordlists 源装载 ->
//   内存合并 -> bulkWriteDictionary 分块 upsert 送入词典 + __built__/expected
//   原子标记 + 写后校验）。getManifestCounts（preprocess manifest 会话级缓存）
//   仅本模块使用故保持私有。共享状态经 state.js 的 dictState 可变对象读写。
// ============================================================

import { dictState, DEFAULT_SOURCE_LANG, _ts } from './state.js';
import { getLangProjection, bulkWriteDictionary } from '../word-db.js';
import { loadWordfreq, loadWordlists } from './word-loader.js';

/**
 * 加载词典（懒加载，按 learnLanguage 选择 wordfreq 文件）
 * 反思（2026-08-20 第八十五次）：词频/词表不是独立缓存，而是词典字段。
 *   页面每次加载优先从词典（words store）投影构建 Map（getLangProjection）；
 *   仅当词典缺失/不全（built=false，如首次安装或切换语言后该语言词典尚未构建）时，
 *   才启用装载函数（loadWordfreq/loadWordlists）读取源文件并送入词典。
 * 反思（2026-08-21 第八十八次）：词典只有一个--rank/tags 合入同一 Map<word, {rank,tags}>，
 *   不再有 wordfreq/wordlists 两张表；装载函数也只是把同一词典的字段合起来。
 * @param {string} [lang] 强制指定语言（默认读 storage.currentLearnLang）
 * @returns {Promise<Map<string,{rank:number|null,tags:string[]}>>} 统一词典
 */
export async function _loadDict(lang) {
  const meaningLang = lang || dictState.currentLearnLang || DEFAULT_SOURCE_LANG;

  // 已加载相同语言：直接返回（不打日志--用户反馈"每次都要加载 wordfreq/wordlists"，
  //   实际是单例缓存命中，只是多处调用触发了日志）。
  if (dictState.loadedLang === meaningLang && dictState.dictMap) {
    return dictState.dictMap;
  }

  // 已有加载中 Promise：复用
  if (dictState.loadPromise && dictState.loadPromise._lang === meaningLang) {
    return dictState.loadPromise;
  }

  dictState.loadPromise = (async () => {
    const startTime = Date.now();
    console.log(`[VocabRadar][dictionary][${_ts()}] 开始加载词典, lang=${meaningLang}`);

    // 反思（2026-08-20 第八十五次）：从词典读词频/词表（rank/tags 字段）--
    //   只有词典会缓存，词频等不是独立缓存；词典已构建（__built__ 标记）即直接读词典。
    let proj = null;
    // 第一百八十八次：分段计时 —— 上轮实测词典就绪仍剩 5.5s（DCL 后），
    //   需定位耗时落在：投影读取(IDB) / Map 构建 / manifest 对账 / 源重建哪一段。
    //   查看：控制台 window.__beaverDictTiming（实时引用）。
    const _seg = { proj: 0, map: 0, manifest: 0, rebuild: 0, total: 0 };
    if (typeof window !== 'undefined') window.__beaverDictTiming = _seg;
    let _t0 = performance.now();
    try {
      proj = await getLangProjection(meaningLang);
    } catch (e) {
      proj = null;
    }
    _seg.proj = Math.round(performance.now() - _t0);
    if (proj && proj.built) {
      // 投影对象是同一词典的字段（rank/tags/lemma），合并为一张全属性词条表。
      // 第一百八十七次·性能修复（用户实测：词典就绪 17093ms＝DCL 后 14.9s）：
      //   旧实现三轮 Object.keys(...) 各分配一个约 5 万元素的字符串数组，且第二、三轮
      //   还要各做一次 Map.get + 可能的对象改写。改为 for...in 直接枚举（无中间数组），
      //   并在第一轮就把 tags/lemma 一并填入（tags/lemmas 基本是 ranks 的子集），
      //   后两轮只补 ranks 里没有的孤词。合并结果与语义完全不变。
      const projRanks = proj.ranks || {};
      const projTags = proj.tags || {};
      const projLemmas = proj.lemmas || {};
      _t0 = performance.now();   // 第一百八十八次：Map 构建段计时
      dictState.dictMap = new Map();
      for (const word in projRanks) {
        dictState.dictMap.set(word, { rank: projRanks[word], tags: projTags[word] || [], lemma: projLemmas[word] || null, translation: undefined, translationLang: undefined, phonetic: undefined });
      }
      for (const word in projTags) {
        if (dictState.dictMap.has(word)) continue;
        dictState.dictMap.set(word, { rank: null, tags: projTags[word] || [], lemma: projLemmas[word] || null, translation: undefined, translationLang: undefined, phonetic: undefined });
      }
      for (const word in projLemmas) {
        if (dictState.dictMap.has(word)) continue;
        dictState.dictMap.set(word, { rank: null, tags: [], lemma: projLemmas[word], translation: undefined, translationLang: undefined, phonetic: undefined });
      }
      dictState.loadedLang = meaningLang;
      _seg.map = Math.round(performance.now() - _t0);   // 第一百八十八次
      const cost = ((Date.now() - startTime) / 1000).toFixed(2);
      // 第一百四十一次（用户裁定）：完整性用**实际值**校验，基准优先级：
      //   ① meta.expected（上次成功构建同事务写入的真实数）② preprocess manifest
      //   （装包期逐语言解码统计的词表长度和，如 en=28917）。库内实数 ranksCount 比对：
      //   不足 ⇒ 增量补齐（upsert 不清库）；足够 ⇒ 直接用。读操作全程不受影响。
      let expected = proj.expected || 0;
      if (!expected) {
        _t0 = performance.now();   // 第一百八十八次：manifest 对账段计时（含首次 fetch manifest.json）
        const mc = await getManifestCounts();
        _seg.manifest = Math.round(performance.now() - _t0);
        expected = Number(mc[meaningLang]) || 0;
      }
      // 第一百九十次修复：total 原用 performance.now() 减 Date.now() 的 startTime（epoch 值），
      //   得出 -1.78e12 的负数（用户实测"合计 -1788164723852ms"）。统一用 Date.now 口径。
      _seg.total = Math.round(Date.now() - startTime);   // 第一百八十八次：总耗时
      console.log(`[VocabRadar][dictionary][${_ts()}] 词典装载分段耗时: 投影读取 ${_seg.proj}ms / Map构建 ${_seg.map}ms / manifest对账 ${_seg.manifest}ms / 合计 ${_seg.total}ms`);
      const cnt = proj.ranksCount || 0;
      if (!expected || cnt >= expected) {
        if (Number(cost) >= 0.25) {
          console.log(`[VocabRadar][dictionary][${_ts()}] 词典已就绪(投影): ${dictState.dictMap.size} 词 (${cost}s)`);
        }
        return dictState.dictMap;
      }
      console.warn(`[VocabRadar][dictionary][${_ts()}] 投影不完整: 库内 ${cnt} / 基准 ${expected} -> 增量补齐(upsert，不清库)`);
      _t0 = performance.now();   // 第一百八十八次：增量补齐段计时
      await _rebuildFromSources(meaningLang);
      _seg.rebuild = Math.round(performance.now() - _t0);
      return dictState.dictMap;
    }

    // 词典缺 __built__ 标记 -> 首次构建
    _t0 = performance.now();   // 第一百八十八次：首次构建段计时
    await _rebuildFromSources(meaningLang);
    _seg.rebuild = Math.round(performance.now() - _t0);
    return dictState.dictMap;
  })();
  dictState.loadPromise._lang = meaningLang;

  return dictState.loadPromise;
}

/**
 * 第一百四十次：从源文件重建/增量补齐词典（装载函数唯一入口）。
 * 流程：解压解码源文件 -> 内存合并为统一词条表（供本页同步查询）-> 分块 upsert 送入
 * 词典库（**不清库**：已有 translation/phonetic/lemma 字段保留，缺失条目被补上）->
 * 末块同事务写入 __built__ + expected 实际值。
 * @param {string} lang
 */
async function _rebuildFromSources(lang) {
  const startTime = Date.now();
  const [wf, wl] = await Promise.all([
    loadWordfreq(lang),
    loadWordlists()
  ]);
  // 第一百四十一次：与 preprocess manifest 对账（实际值 vs 实际值），不一致只告警不阻塞
  try {
    const mc = await getManifestCounts();
    const mCount = Number(mc[lang]) || 0;
    if (mCount && mCount !== wf.size) {
      console.warn(`[VocabRadar][dictionary][${_ts()}] 源词条数与 manifest 不一致: 实际 ${wf.size} / manifest ${mCount}（以源为准）`);
    }
  } catch (e) { /* ignore */ }
  // 两个源文件是同一词典的字段：wordfreq 给 rank、wordlists 给 tags，合为一张全属性词条表
  dictState.dictMap = new Map();
  for (const [word, rank] of wf) {
    dictState.dictMap.set(word, { rank, tags: [], lemma: null, translation: undefined, translationLang: undefined, phonetic: undefined });
  }
  for (const [word, tags] of wl) {
    const e = dictState.dictMap.get(word);
    if (e) e.tags = tags;
    else dictState.dictMap.set(word, { rank: null, tags, lemma: null, translation: undefined, translationLang: undefined, phonetic: undefined });
  }

  dictState.loadedLang = lang;
  const cost = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`[VocabRadar][dictionary][${_ts()}] 源装载完成并送入词典: lang=${lang} ${dictState.dictMap.size} 词 (rank 基准 ${wf.size}) (${cost}s)`);

  // 装载完成送入词典--分块 upsert + 末块原子标记（含 expected 实际值）。
    try {
      const ok = await bulkWriteDictionary(lang, dictState.dictMap, wf.size);
      if (ok === false) {
        console.warn(`[VocabRadar][dictionary][${_ts()}] 送入词典部分失败（未打构建标记，下次加载将重装）`);
      } else {
        console.log(`[VocabRadar][dictionary][${_ts()}] 词典已存入词典库（upsert 不清库 + __built__/expected=${wf.size} 同事务原子）`);
        // 第一百五十三次：写后校验--直读投影确认持久化真实生效（cnt 应≈wf.size）
        try {
          const proj2 = await getLangProjection(lang);
          const cnt2 = proj2 ? (proj2.ranksCount || 0) : -1;
          console.log(`[VocabRadar][dictionary][${_ts()}] 写后校验: 库内 ${cnt2} / 期望 ${wf.size}${cnt2 >= wf.size ? ' ✅' : ' ❌ 未持久化!'}`);
        } catch (e) { /* ignore */ }
      }
  } catch (e) {
    console.warn(`[VocabRadar][dictionary][${_ts()}] 送入词典失败（忽略，本次内存词典仍可用）:`, e && e.message);
  }
  return dictState.dictMap;
}

/**
 * 第一百四十一次：preprocess 生成的 manifest（各语言真实词条数，装包期统计）。
 * 会话级缓存；缺失返回空对象（退回 meta.expected 基准）。
 */
let _manifestCounts = null;
async function getManifestCounts() {
  if (_manifestCounts) return _manifestCounts;
  try {
    const res = await fetch(chrome.runtime.getURL('src/data/wordfreq/manifest.json'));
    if (res.ok) {
      const j = await res.json();
      _manifestCounts = (j && j.wordCounts) || {};
    } else {
      _manifestCounts = {};
    }
  } catch (e) { _manifestCounts = {}; }
  return _manifestCounts;
}
