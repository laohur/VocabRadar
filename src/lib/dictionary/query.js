// ============================================================
// 文件职责：词典同步/异步查询接口（src/lib/dictionary/query.js）
// 来源：拆分自 src/lib/dictionary.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// 原 dictionary.js 的 6 个查询类导出集中在本文件（门面 dictionary.js 仅
//   re-export，符号名不变，所有引用方零改动）：
//   ensureReady / lookup / lookupWithLemmatizer / lookupFull / isLoaded / getDiagState
// lookup 同步读内存统一词典 dictState.dictMap（投影构建见 projection.js）；
//   lookupWithLemmatizer 按需经词形引擎组装 lemma 后重查；lookupFull 组装词条并
//   懒直读 IDB 补全 translation/phonetic（getWord/updateFields 经 word-db.js）。
// 三个一次性日志 Set（_firstLookupLogged/_oovLogged/_asmLogged）仅本模块使用。
// ============================================================

import { dictState, DEFAULT_SOURCE_LANG } from './state.js';
import { _loadDict } from './projection.js';
// 反思（2026-08-08 第三次）：用户要求直接改 lemmatizer.js，不保留错误逻辑。
//   lemmatizer.js 已重写为基于 diverse-lemmas，不再有自制后缀剥离规则。
//   此处直接从 lemmatizer.js 导入。
import { lemmatize as lemmatizeMulti, lemmatizeAllCandidates, lemmatizeOne } from '../lemmatizer.js';
// 反思（2026-08-11 第二十七次）：统一词典存储
//   lookup() 仍同步读 Maps（高频调用，不能 async）；
//   lookupFull() 异步读 IDB 完整记录，缺失的 rank/lemma/tags 从 Maps 回填并写回 IDB。
//   translation/phonetic 字段由 translator.js/phonetics.js 各自读写。
import { getWord, getWordsBatch, updateFields, countTranslationEntries, lemmasSize } from '../word-db.js';
// 反思（2026-08-16 第七十次）：词典层数据来源账本--lookupFull 在真实的
//   needsMaps 决策点（IDB 直读 vs Maps 组装写回）计数 rank/lemma/tags 来源，
//   由调用方把当前批次账本传进来（可选，其他调用方不传即不计数）。
import { incField } from '../dict-stats.js';

// 反思（2026-08-18 第七十四次）：打印只按用户定的三种情形：
//   ①第一次查询词典（_firstLookupLogged）②词典外单词（_oovLogged）③词典中没有的属性（_asmLogged）
const _firstLookupLogged = new Set();
const _oovLogged = new Set();
const _asmLogged = new Set();
// 第一百九十九次：词条 lemma 自愈记录（lower|lang，每词每会话至多核对一次）
const _lemmaHealDone = new Set();

function _ensureInit() {
  if (!dictState.loadPromise) _loadDict().catch(() => {});
}

// 词典初始化（2026-08-18 第七十三次）：插件初始化时由 startHint/web-sidebar 等入口
//   await 本函数，确保扫描前词典已装载（wordfreq/wordlists 送入词典）。
//   装载函数只在初始化或数据损坏不全时启用；之后业务只查词典。
export function ensureReady() {
  if (!dictState.loadPromise) {
    // 2026-09-09 第二百四十一次竞态修复（用户："OCR failed: Cannot read properties of
    //   null (reading 'catch')"）：_loadDict 是 async，同步段在 projection.js L42
    //   await storage.get(wfUpdates 检查) 处让出，L67 dictState.loadPromise=... 尚未执行；
    //   旧实现此处直接 return dictState.loadPromise → 首个调用者拿到 null。
    //   第二百四十次删 startGuideVideoSidebar 词典预载后，引导页 OCR 场景本句注释链
    //   （asr-common L442 ensureReady().catch）成为首调用者 → null.catch 同步炸 →
    //   异常沿 appendResult 抛到 guide/ocr.js catch → toast 报错。
    //   修法：把本次装载 Promise 同步持有为 loadPromise 兜底（与 projection.js 后续
    //   自赋值共存——_loadDict 恢复后 L63 复用检查不匹配即覆盖为内部 Promise 并打
    //   _lang 标记，本 Promise resolve 值即其 return，语义不变）。对照组
    //   ensureRanksReady 同形态（有 || Promise.resolve(null) 兜底不炸但首轮空转，
    //   自愈）——第二百四十四次已同款修复，见下方。同批受益：scan.js L112 /
    //   web-sidebar-impl L229 同形态链式调用。
    dictState.loadPromise = _loadDict().catch(() => {});
  }
  return dictState.loadPromise;
}

/**
 * 等待词频先行就绪（分阶段投影 Stage 1，2026-09-04）
 * ranks 到即 resolve（rank-only dictMap 可扫出高亮），tags/lemma 随后 Stage 2 合并。
 * 承诺永不悬空：装载总失败时 resolve null，调用方按无词典继续（与 ensureReady 失败语义一致）。
 * @returns {Promise<Map|null>} rank-only 或完整词典 Map（失败 null）
 */
export function ensureRanksReady() {
  if (dictState.ranksReadyLang && dictState.dictMap) return Promise.resolve(dictState.dictMap);
  if (!dictState.ranksPromise) {
    // 第二百四十四次竞态修复（同 ensureReady 第二百四十一次形态，用户拍板"修ensureRanksReady"）：
    //   _loadDict 是 async，同步段在 projection.js L42 await storage.get(wfUpdates) 处
    //   让出，L83 dictState.ranksPromise=new Promise(...) 尚未执行；旧实现
    //   return dictState.ranksPromise || Promise.resolve(null) → 首个调用者
    //   （scan.js L103 ensureRanksReady().then）拿到立即 resolve 的 null，
    //   首轮按"无词典"空转一轮（自愈但白跑，第二次起才正常）。
    // 第二百四十五次修正（用户拍板）：上式兜底把整装载 Promise 赋给 ranksPromise 后，
    //   首调者（scan.js L103）被绑死在"完整装载完成"上，Stage 1 分阶段收益丢失
    //   （实测词频先行就绪与词典就绪仅差 0.9ms，Stage 2 整投影 116ms 被吞进等待）。
    //   projection.js _loadDict 已把 Stage 1 ranksPromise 注册上移至同步段（首个 await
    //   之前）——本函数现在只需触发装载再读回同步段注册的承诺；仅当 _loadDict 因
    //   "已装载命中"快速返回未注册（SLOW 首装完成后 ranksReadyLang 未标记的窗口）时，
    //   才用本次整装载结果兜底，承诺永不悬空（原语义保留）。
    const _p = _loadDict().catch(() => null);
    if (!dictState.ranksPromise) dictState.ranksPromise = _p;
  }
  return dictState.ranksPromise;
}

/**
 * 词频是否先行就绪（rank-only 可扫）
 * @returns {boolean}
 */
export function isRanksLoaded() {
  return !!(dictState.ranksReadyLang && dictState.dictMap);
}

/**
 * 查询单词，返回 { rank, tags, lemma }
 *
 * 查询逻辑：
 *   1. 词典命中：rank 为词频排名（1-N）
 *   2. 词典未命中：rank 为 null（表外词，由 translator 在线查询释义）
 *   3. tags 从词典 tags 字段查询（仅英文，需词形还原后匹配）
 *
 * 反思（2026-08-02）：
 *   - 旧版返回 { word, translations, rank, tags }（含静态释义）
 *   - 新版移除 translations 字段，释义改为 translator.js 异步获取并缓存
 *   - annotator.js / text-hint-impl.js 调用方需适配：lookup 不再返回 translations
 *
 * 反思（2026-08-02 修正）：新增 lemma 字段，用于浮层/面板显示词形还原原形
 *   - 直接命中：lemma=null（原词即原形，无需显示）
 *   - 词形还原后命中（如 running -> run）：lemma='run'，浮层显示"原形: run"
 *   - 表外词（未命中）：返回 null（无 lemma）
 *
 * @param {string} word 单词（不区分大小写）
 * @returns {{rank: number, tags: string[], lemma: string|null}|null} 词条或 null
 *   - 词典命中（rank 有记录）：{rank, tags, lemma}
 *   - 表外词（词典无记录）：null（由调用方判定是否在线翻译）
 */
export function lookup(word) {
  // 反思（2026-08-17 第七十二次补充）：词典自初始化--词典未就绪时触发异步加载，
  //   本次返回 null（调用方按表外词处理），下次命中。
  if (!dictState.dictMap) {
    _ensureInit();
    return null;
  }
  const lower = (word || '').toLowerCase();
  if (!lower) return null;

  // 反思（2026-08-21 第八十九次）：lemma 是词条属性，直接读统一词典（旧 _lemmaCache 已废除）。
  //   缺失时按"原词即原形"，不调词形引擎（用户："词形还原不从词典中查询？你为啥每次都要查"）。
  const entry = dictState.dictMap.get(lower);
  const lemma = (entry && typeof entry.lemma === 'string') ? entry.lemma : null;
  const isVariant = lemma !== null && lemma !== lower;

  // 1. 词典查询：rank（rank/tags/lemma 在同一词条内；rank 仅数值有效）
  const rank = (entry && typeof entry.rank === 'number') ? entry.rank : undefined;

  if (rank === undefined) {
    // 词典未命中：表外词
    if (isVariant) {
      // 词形还原后查词典
      const lemEntry = dictState.dictMap.get(lemma);
      const lemmaRank = (lemEntry && typeof lemEntry.rank === 'number') ? lemEntry.rank : undefined;
      if (lemmaRank !== undefined) {
        const result = { rank: lemmaRank, tags: getTags(lemma), lemma };
        // ① 第一次查询词典
        if (!dictState.quietBatch && !_firstLookupLogged.has(lower)) { _firstLookupLogged.add(lower); console.log(`[VocabRadar][dictionary] 词典条目 "${lower}" ->`, result); }
        return result;
      }
    }
    // ② 词典外单词（词典无记录，词形还原后也无记录）
    if (!dictState.quietBatch && !_oovLogged.has(lower)) { _oovLogged.add(lower); console.log(`[VocabRadar][dictionary] 词典外单词 "${lower}"`); }
    return null;
  }

  const result = {
    rank,
    tags: getTags(isVariant ? lemma : lower),
    lemma: isVariant ? lemma : null
  };
  // ① 第一次查询词典
  if (!dictState.quietBatch && !_firstLookupLogged.has(lower)) { _firstLookupLogged.add(lower); console.log(`[VocabRadar][dictionary] 词典条目 "${lower}" ->`, result); }
  return result;
}

/**
 * 词形还原按需重查（2026-08-15 第六十四次，2026-08-16 第六十七次改逐词）
 * 扫描/查询主路径不等待词形数据（页面不再持有词形整表）。
 * 仅当某词在词形缓存未命中时直接查询 miss，才调用本函数：经 SW 逐词组装该词的
 * lemma 后重查一次，使"变形词未还原导致的 miss"（如 ran/children）能通过词形还原命中。
 * @param {string} word 单词
 * @returns {Promise<{rank:number, tags:string[], lemma:string|null}|null>} 重查结果或 null
 */
export async function lookupWithLemmatizer(word) {
  const lower = (word || '').toLowerCase();
  if (!lower) return null;
  // 反思（2026-08-17 第七十二次补充）：不再逐词调 loadDictionary()--
  //   词典仅由 startHint 一处 await loadDictionary() 加载（singleton），
  //   此处若词典未就绪直接返回 null，调用方降级到在线翻译。
  if (!dictState.dictMap) return null;
  const lang = dictState.loadedLang || dictState.currentLearnLang || DEFAULT_SOURCE_LANG;
  // 缺哪个词的原形，就经 SW 组装哪个词（lemmatizeOne 查过会写回 _wordCache，lookup 同步复用）
  try { await lemmatizeOne(lower, lang); } catch (e) { /* 组装失败按原词即原形 */ }
  // 反思（2026-08-21 第八十九次）：组装结果直接写入统一词典词条的 lemma 字段
  //   （旧 _lemmaCache 镜像已废除），之后 lookup() 从同一词典读 lemma。
  // 第一百九十九次（用户："注释没有词形还原"）：旧判据 `typeof entry.lemma !== 'string'`
  //   只在词条 lemma 缺失时才写回——历史坏档（lemma=词面本身，早期版本在词形缓存
  //   已暖时跳过组装所致）是字符串，永不纠正，且每次重查都把错误值再落库一次。
  //   现改为：引擎给出不同原形即采纳并写回（真基础形引擎返回词面，零改动）。
  let entry = dictState.dictMap.get(lower);
  const lem = lemmatizeMulti(lower, lang); // lemmatizeOne 已写回 _wordCache，此处同步读缓存
  if (lem && lem !== lower) {
    if (!entry) {
      entry = { rank: null, tags: [], lemma: lem, translation: undefined, translationLang: undefined, phonetic: undefined };
      dictState.dictMap.set(lower, entry);
    } else if (entry.lemma !== lem) {
      entry.lemma = lem;
    }
    // 词形是新组装的：fire-and-forget 写回 IDB 词典（跨会话不再重还原）
    try { updateFields(lang, lower, { lemma: lem }).catch(() => {}); } catch (e) { /* ignore */ }
  }
  // 词形已按需组装：重查（变形词此时可还原）
  const result = lookup(lower);
  // 反思（2026-08-18 第七十四次）：③ 词典中没有的属性--词形还原后命中词典，
  //   属"词典缺该词原形属性，经词形引擎组装"情形，每个词只打一次。
  if (!dictState.quietBatch && result && result.lemma && result.lemma !== lower && !_asmLogged.has(lower)) {
    _asmLogged.add(lower);
    console.log(`[VocabRadar][dictionary] 词典缺原形属性 "${lower}" -> 原形="${result.lemma}"（经词形引擎组装，rank=${result.rank}）`);
  }
  return result;
}

/**
 * 查询单词完整记录（异步，含 translation/phonetic）
 *
 * 反思（2026-08-11 第二十七次）：用户要求"所有跟随单词的属性只存一个词典"。
 * 反思（2026-08-21 第八十九次）：词典只有一个且含全部属性--本函数直接读写统一词典
 *   _dictMap 词条（rank/tags/lemma/translation/translationLang/phonetic）：
 *   - 词条未组装（无记录或 lemma 非字符串）：从词频表组装并写回词典（内存 + IDB）；
 *   - translation/translationLang/phonetic 未直读过（undefined）：按需读一次 IDB 补全，
 *     之后同词查询直接走内存词典（不再每次查 IDB）；字段为 null 时调用方（tooltip）
 *     自行调 translate()/getPhonetic() 获取并写回。
 *
 * 返回字段说明：
 *   - rank：number|null；tags：string[]；lemma：string（原词即原形时与词面相同）
 *   - translation：string|null（null=未翻译或 translationLang 不匹配）
 *   - translationLang：string|null（用于调用方判断译文是否过期）
 *   - phonetic：string|null（null=未注音）
 *
 * @param {string} word 单词
 * @param {object} [stats] 当前批次数据来源账本（可选；第七十次起由文本提示路径传入，
 *   在组装决策点真实计数 rank/lemma/tags 来自统一词典直读还是组装）
 * @returns {Promise<{rank: number|null, tags: string[], lemma: string|null, translation: string|null, translationLang: string|null, phonetic: string|null}|null>}
 *   词典命中（rank 有记录或表外词已登记）：完整记录
 *   表外词且词形还原后也未命中：返回 null（与 lookup 行为一致）
 */
export async function lookupFull(word, stats) {
  if (!word) return null;
  const lower = (word || '').toLowerCase();
  if (!lower) return null;
  const lang = dictState.loadedLang || dictState.currentLearnLang || DEFAULT_SOURCE_LANG;

  // 反思（2026-08-16 第七十二次）：词典只加载一次--startHint / web-sidebar 启动时
  //   已 await loadDictionary()，此处不再重复加载；若词典未就绪（极端竞态），
  //   直接返回 null，调用方降级到 lookupWord（同步内存词典组装）。
  if (!dictState.dictMap) return null;

  let entry = dictState.dictMap.get(lower);

  // 1) 词条未组装（无记录或 lemma 非字符串--与旧 needsMaps 判据一致：
  //    基础形词首次组装后 lemma=小写原词字符串，之后不再重复还原）
  if (!entry || typeof entry.lemma !== 'string') {
    if (stats) { incField(stats, 'rank', 'asm'); incField(stats, 'lemma', 'asm'); incField(stats, 'tags', 'asm'); }
    let mapResult = lookup(lower);
    // 反思（2026-08-15 第六十四次）：统一词典按需--直接查询 miss 可能是"变形词未还原"
    //   （如 ran/children），异步补齐词形后重查一次，写回词典供后续直读。
    // 第一百九十九次：去掉 `!hasCachedLemma(lower, lang)` 守卫——它是自败的：
    //   词形缓存暖（此前 lemmatizeOne 查过该词）≠ 词条 lemma 正确（坏档 lemma=词面
    //   是字符串、缺失也是"不需要补"的假象）；且 lemmatizeOne 自带逐词缓存，
    //   重复调用本就零开销，该守卫只会阻止纠错。
    if (!mapResult || (mapResult.lemma === null && mapResult.rank !== null)) {
      mapResult = await lookupWithLemmatizer(lower) || mapResult;
    }
    // lookup 返回 null 表示表外词（词典未命中且词形还原后也未命中）
    // 表外词也写入词典（rank=null），避免反复组装
    const rank = mapResult ? mapResult.rank : null;
    const lemma = (mapResult && mapResult.lemma) ? mapResult.lemma : lower;
    const tags = mapResult ? mapResult.tags : [];
    if (!entry) {
      entry = { rank, tags, lemma, translation: undefined, translationLang: undefined, phonetic: undefined };
      dictState.dictMap.set(lower, entry);
    } else {
      entry.rank = rank;
      entry.tags = tags;
      entry.lemma = lemma;
    }
    // 写回 IDB 词典：之后刷新/换站直接读词典字段，不再逐词组装。
    // 第一百八十七次·性能修复：这里原本是 await —— 但写回的目的只是"下次更快"，
    //   本次查询结果（rank/lemma/tags）已在上面写进内存词条，不依赖写回完成。
    //   而首屏扫描是 for + await 串行，每个首见词多等一次 SW 写往返（本次实测
    //   1069 次串行查词），高亮就被硬生生推后数秒。改为 fire-and-forget，
    //   失败仍静默（原 catch 语义不变），不吞异常到控制台以外的地方。
    try {
      updateFields(lang, lower, { rank, lemma, tags }).catch(() => {});
    } catch (e) { /* 写回失败不阻塞 */ }
    if (!dictState.quietBatch && lemma !== lower && !_asmLogged.has(lower)) {
      _asmLogged.add(lower);
      console.log(`[VocabRadar][dictionary] 词典缺原形属性 "${lower}" -> lemma="${lemma}"（从词频表组装并已写回词典）`);
    }
  } else {
    // 数据源账本：统一词典词条直读命中
    if (stats) { incField(stats, 'rank', 'dict'); incField(stats, 'lemma', 'dict'); incField(stats, 'tags', 'dict'); }
  }

  // 1.5) 第一百九十九次（用户："注释没有词形还原"）：词条自愈——词典内词（rank 数值）
  //    的 lemma 若等于词面本身，多为历史坏档（早期版本在词形缓存已暖时跳过组装，
  //    把 lemma=词面 写进了词典，而 lookupWithLemmatizer 旧判据对字符串 lemma 永不纠正）。
  //    经词形引擎核对一次：先读逐词缓存（免费），未缓存才 lemmatizeOne（每词每会话
  //    至多一次 SW 消息，_lemmaHealDone 防重）；引擎给出不同原形即采纳并写回 IDB，
  //    给出词面本身（真基础形）则零改动。自愈后后续会话直读词典即正确。
  if (entry && entry.lemma === lower && typeof entry.rank === 'number') {
    const healKey = lower + '|' + lang;
    if (!_lemmaHealDone.has(healKey)) {
      _lemmaHealDone.add(healKey);
      try {
        let lem = lemmatizeMulti(lower, lang);   // 仅读逐词缓存（免费）
        if (!lem || lem === lower) {
          await lemmatizeOne(lower, lang);
          lem = lemmatizeMulti(lower, lang);
        }
        if (lem && lem !== lower) {
          entry.lemma = lem;
          try { updateFields(lang, lower, { lemma: lem }).catch(() => {}); } catch (e) { /* ignore */ }
          if (!dictState.quietBatch) {
            console.log(`[VocabRadar][dictionary] 词条自愈 "${lower}" -> lemma="${lem}"（历史坏档修正，已写回词典）`);
          }
        }
      } catch (e) { /* 自愈失败不阻塞查询 */ }
    }
  }

  // 2) 完整属性（translation/translationLang/phonetic）未直读过（undefined）-> 读一次 IDB 补全；
  //    已补全过的词条直接走内存词典（自愈：IDB 有更强值时回填词条）
  if (entry.translation === undefined || entry.phonetic === undefined) {
    let record = null;
    try {
      record = await getWord(lang, lower);
    } catch (e) { /* IDB 失败不阻塞 */ }
    if (record) {
      if (!(typeof entry.rank === 'number') && typeof record.rank === 'number') entry.rank = record.rank;
      if ((!Array.isArray(entry.tags) || entry.tags.length === 0) && Array.isArray(record.tags) && record.tags.length > 0) entry.tags = record.tags;
      if (typeof record.lemma === 'string' && record.lemma) entry.lemma = record.lemma;
    }
    entry.translation = (record && record.translation !== undefined) ? record.translation : null;
    entry.translationLang = (record && record.translationLang) ? record.translationLang : null;
    entry.phonetic = (record && record.phonetic !== undefined) ? record.phonetic : null;
  }

  const result = {
    rank: entry.rank,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    lemma: entry.lemma,
    translation: entry.translation,
    translationLang: entry.translationLang,
    phonetic: entry.phonetic
  };
  if (!dictState.quietBatch && !_firstLookupLogged.has(lower)) { _firstLookupLogged.add(lower); console.log(`[VocabRadar][dictionary] 词典条目 "${lower}" ->`, result); }
  return result;
}

/**
 * 第一百八十七次·批量预取（症状⑥性能修复）
 *
 * 用户实测（learn.microsoft.com）：一次首屏扫描"串行查词 1069 次"，而 lookupFull 对
 *   每个首见词要走 1~2 次 SW 消息往返（updateFields 写 + getWord 读），
 *   processBatch 又是 for + await 串行 —— 往返次数 × 单次往返延迟直接叠成秒级，
 *   这就是"扫描早已走完（4105ms）却迟迟不见提示"的另一半原因。
 *
 * 本函数在每批扫描开始前，用**一次** getWordsBatch（WORD_DB_GET_BATCH，SW 侧单事务
 *   并发 get）把该批词的完整记录取回，写进内存词条的 translation/translationLang/
 *   phonetic 字段。随后 lookupFull 的第 2 段（entry.translation===undefined）即全部
 *   命中内存，不再逐词 getWord。
 *
 * 语义保持：写入的字段值与 lookupFull 第 2 段完全一致（缺失置 null，并做同样的
 *   rank/tags/lemma 自愈回填）；词典未就绪（dictMap 为 null）时直接返回，不建表、
 *   不写"假值"，与第一百六十九次"假 null 绝不入缓存"的约束一致。
 *
 * @param {string[]} words 本批出现的小写单词（可含重复，内部去重）
 * @returns {Promise<void>} 失败静默（预取只是加速，失败退回逐词路径）
 */
export async function prefetchFull(words) {
  if (!dictState.dictMap || !words || words.length === 0) return;
  const lang = dictState.loadedLang || dictState.currentLearnLang || DEFAULT_SOURCE_LANG;
  // 只预取"尚未直读过完整属性"的词：已补全过的词条本就走内存，无需再读。
  const need = [];
  const seen = new Set();
  for (const w of words) {
    const lower = (w || '').toLowerCase();
    if (!lower || seen.has(lower)) continue;
    seen.add(lower);
    const e = dictState.dictMap.get(lower);
    if (e && e.translation !== undefined && e.phonetic !== undefined) continue;
    need.push(lower);
  }
  if (need.length === 0) return;
  let records = [];
  try {
    records = await getWordsBatch(lang, need);
  } catch (e) { return; /* 预取失败：退回 lookupFull 逐词路径，行为不变 */ }
  if (!Array.isArray(records)) return;
  for (let i = 0; i < need.length; i++) {
    const lower = need[i];
    const record = records[i] || null;
    let entry = dictState.dictMap.get(lower);
    // 词典里还没有该词条时不新建（新建会让 lookupFull 第 1 段误判"已组装"而跳过
    //   rank/lemma/tags 的组装与写回）；仅当 IDB 已有记录时才建，且字段照抄记录。
    if (!entry) {
      if (!record) continue;
      entry = {
        rank: (typeof record.rank === 'number') ? record.rank : null,
        tags: Array.isArray(record.tags) ? record.tags : [],
        lemma: (typeof record.lemma === 'string') ? record.lemma : undefined,
        translation: undefined, translationLang: undefined, phonetic: undefined
      };
      dictState.dictMap.set(lower, entry);
    } else if (record) {
      if (!(typeof entry.rank === 'number') && typeof record.rank === 'number') entry.rank = record.rank;
      if ((!Array.isArray(entry.tags) || entry.tags.length === 0) && Array.isArray(record.tags) && record.tags.length > 0) entry.tags = record.tags;
      if (typeof record.lemma === 'string' && record.lemma) entry.lemma = record.lemma;
    }
    entry.translation = (record && record.translation !== undefined) ? record.translation : null;
    entry.translationLang = (record && record.translationLang) ? record.translationLang : null;
    entry.phonetic = (record && record.phonetic !== undefined) ? record.phonetic : null;
  }
}

/**
 * 查询单词的词表标签
 * 词形还原后匹配（如 "running" -> "run" 匹配 CET4）
 * @param {string} word 已小写的单词
 * @returns {string[]} 标签数组（无标签返回空数组）
 *
 * 反思（2026-08-02）：用户要求"用 js 原生的分词办法，规范化，
 *   词形还原后匹配单词词表标签"。词表（CET4 等）按原形存储，
 *   字幕中的变形必须先还原为原形才能命中。
 *   匹配顺序：原形 -> 词形还原后的所有候选原形
 */
function getTags(word) {
  if (!dictState.dictMap) return [];

  // 1. 直接匹配原形（同一词条的 tags 字段）
  const directEntry = dictState.dictMap.get(word);
  if (directEntry && directEntry.tags && directEntry.tags.length > 0) return directEntry.tags.slice();

  // 2. 词形还原后匹配（取所有候选原形，任一命中即返回）
  // 例：running -> 候选 [running, run]
  //     walked -> 候选 [walked, walk]
  // 反思（2026-08-08 第二次）：lemmatizeAllCandidates 改用 diverse-lemmas，
  //   传入当前语言 _loadedLang 以查对应词典。
  const candidates = lemmatizeAllCandidates(word, dictState.loadedLang);
  for (const candidate of candidates) {
    if (candidate === word) continue; // 已尝试过原形
    const entry = dictState.dictMap.get(candidate);
    if (entry && entry.tags && entry.tags.length > 0) return entry.tags.slice();
  }

  return [];
}

/**
 * 词典是否已加载（兼容旧接口，但新接口返回词典加载状态）
 * @returns {boolean}
 */
export function isLoaded() {
  return dictState.dictMap !== null;
}

/**
 * 词频表上界（当前语言 wordfreq 最大 rank = 词数，装载/投影构建时维护）
 * 供词频范围上界默认值：词典未就绪返回 0，引导页据此回退到词频表上界。
 * @returns {number}
 */
export function getMaxRank() {
  return dictState.maxRank || 0;
}

/**
 * 诊断信息（2026-08-14 第五十四次）：供诊断悬浮窗展示词典加载状态
 * 反思（2026-08-14 第五十五次修正）：旧版含 learnLangs: LANGUAGES 字段，但本模块
 *   未定义/未导入 LANGUAGES，getDiagState() 抛 ReferenceError -> 诊断窗显示
 *   "LANGUAGES is not defined"。移除该字段。
 * 反思（2026-08-21 第八十八次）：词典只有一个--诊断只报一个词条数（dictSize），
 *   不再分 wordfreq/wordlists 两个数字。
 * 第三百四十六次（用户裁定方案 A"有啥就出啥"）：新增 rebuildPending 字段——库残缺时
 *   源重建改后台跑（projection.js 不再 await 阻塞就绪），引导页轮询此字段：非空 =
 *   后台构建中（就绪行 ◑◒◐◓ 轮播提示），清空 = 重建结束（停轮播 + 重取分项数字）。
 * @returns {{loadedLang:string|null, dictSize:number, loadPending:boolean, currentLearnLang:string|null, rebuildPending:string|null}}
 */
export function getDiagState() {
  return {
    loadedLang: dictState.loadedLang,
    dictSize: dictState.dictMap ? dictState.dictMap.size : 0,
    loadPending: !!(dictState.loadPromise && !dictState.loadedLang),
    currentLearnLang: dictState.currentLearnLang || null,
    rebuildPending: dictState.rebuildPending || null
  };
}

// 第三百三十九次（用户："各个字段分别统计"）：词典各字段分项规模统计——引导页就绪行
//   分项显示的取数接口。四个字段各自的计数口径（不是并集一个数）：
//   ① 词频 rankCount：内存 dictMap 中 rank 为 number 的词条数；
//   ② 词表 tagCount：内存 dictMap 中 tags 数组非空的词条数；
//   ③ 翻译 transCount：d_trans 分表 by-lang 索引计数（内置翻译包 40261 词设计上不进
//      内存投影、直接写 d_trans 懒读，dictMap 数不出，必须经 SW 查 IDB；另含运行时
//      在线翻译缓存写入的词条，属真实状态如实显示）；
//   ④ 词形 lemmaCount：扩展数据域词形缓存计数（lemmasSize 仅读缓存绝不触发 CDN 下载，
//      词形数据从未装载过则如实回 0）。
//   ①② 同步遍历 dictMap（3.8 万条目毫秒级）；③④ 异步经 SW 消息。失败一律按 0 兜底
//   （两个计数函数内部已 try/catch），不允许统计失败影响页面。
// @returns {Promise<{lang, total, rankCount, tagCount, transCount, lemmaCount}>}
export async function getDictFieldStats() {
  let rankCount = 0, tagCount = 0;
  const dm = dictState.dictMap;
  if (dm) {
    for (const e of dm.values()) {
      if (typeof e.rank === 'number') rankCount++;
      if (Array.isArray(e.tags) && e.tags.length > 0) tagCount++;
    }
  }
  const lang = dictState.loadedLang || dictState.currentLearnLang || DEFAULT_SOURCE_LANG;
  let transCount = 0, lemmaCount = 0;
  try {
    [transCount, lemmaCount] = await Promise.all([countTranslationEntries(lang), lemmasSize(lang)]);
  } catch (_) { /* 兜底：保持 0 */ }
  return { lang, total: dm ? dm.size : 0, rankCount, tagCount, transCount, lemmaCount };
}

// 330次：按词表标签取整表单词（My Words 词表快捷选择器并入文本框用）——
//   同步遍历内存 dictMap（3.8 万条目毫秒级，与 getDictFieldStats 同口径）；
//   词典未就绪时返回空数组（调用方先 await ensureReady 保证就绪）。
//   tags 是 string[]（wordlists.jsonl 装载时反转组装 Map<word_lower, [tags]>），
//   匹配为精确元素匹配；返回词表原词（即原形），按字母排序便于阅读。
export function getWordsByTag(tag) {
  const dm = dictState.dictMap;
  const out = [];
  if (!dm || !tag) return out;
  for (const [word, e] of dm) {
    if (Array.isArray(e.tags) && e.tags.indexOf(tag) !== -1) out.push(word);
  }
  out.sort();
  return out;
}
