// 注解组装（基于 wordfreq 词频 + translator 在线释义）
//
// 反思（2026-08-02）：
//   - 旧版基于 wordbank.json（含静态 translations），词典命中时直接返回 translations
//   - 新版 dictionary.js lookup 仅返回 { rank, tags }（不再含 translations），
//     所有词的释义都通过 translator.js 在线查询后 fnv1aHash 100分桶缓存本地
//   - lookupWord 统一返回 pending=true（释义待异步获取），由调用方决定阻塞/非阻塞模式
//   - getAnnotations 中"词典命中"和"表外"分支合并为统一的异步翻译流程

import { lookup, lookupWithLemmatizer, getLearnLang, setQuietBatch, isLoaded } from './dictionary.js';
// 第一百九十九次：hasCachedLemma 守卫已删除（自败守卫，见 getAnnotationsInner 内注释）
import { extractEnglishWords } from './tokenizer.js';
import { translate, getMeaningLang } from './translator.js';
import { getWordsBatch, updateFields } from './word-db.js';
// 反思（2026-08-16 第七十次）：词典层数据来源账本——getAnnotations 每次处理
//   真实计数 文本字符/分词/去重单词 与 各属性(rank/lemma/tags/释义) 来自统一词典(IDB)
//   直读 还是 临时组装，供诊断悬浮窗展示（详见 dict-stats.js）。
import { beginBatch, countChars, countTokens, countUnique, incField, incScalar, logBatch } from './dict-stats.js';
// 反思（2026-08-16 第六十六次）：释义清洗——统一词典中可能缓存了早期未清洗的
//   "原形(释义)的屈折说明"脏数据（如 "v. 促进( facilitate的第三人称单数 ); ..."），
//   读缓存时清洗一次，旧脏数据不再污染页面/侧栏注释。
import { cleanDictEntry } from './dict-clean.js';

// 已打印词形日志的词（2026-08-18 第七十三次）：词形日志仅第一次打印，
//   避免 IDB 写回失败/页面刷新后"首次查询词形"反复刷屏。
// 反思（2026-08-18 第七十四次）：本 Set 已移除——词形日志统一由 dictionary.js
//   按用户三种情形（①首次查词典 ②词典外单词 ③词典缺属性组装）打印，此处不再重复。

// === 词频范围上界（唯一属主，模块级） ===
// 默认 Infinity = 不限制（仅用下界，兼容全部既有行为）；消费方启动/设置变更时
//   经 setRankMax 写入（storage.rankThresholdMax，0/缺省=不限制）。
let _rankMax = Infinity;

/** 设置词频上界（0/无效值=不限制）。供各消费方读取配置后写入 */
export function setRankMax(v) {
  _rankMax = (typeof v === 'number' && isFinite(v) && v > 0) ? v : Infinity;
  return _rankMax;
}

/** 读当前词频上界（±Infinity=不限制）。供显示口径再过滤（filterByCurrentRank 等） */
export function getRankMax() {
  return _rankMax;
}

/**
 * 查单个词的核心逻辑（词典命中+rank>阈值 → 返回 pending 占位；高频词 → null）
 * 这是文本提示与字幕提示共享的底层查词函数，杜绝两处重复代码导致行为不一致。
 *
 * 返回值：
 *   - 词典命中且超阈值：{isWord:true, rank, tags, lemma, translations:[], pending:true}
 *     （释义需调用方通过 translator.js 异步获取，translations 暂为空数组占位）
 *   - 表外单词（词典未命中）：{isWord:true, rank:null, tags:[], lemma:null, translations:[], pending:true}
 *     （与词典命中行为一致，rank=null 区分）
 *   - 词典命中但 rank<=阈值（高频词）：null
 *
 * 反思（2026-08-02）：
 *   - 旧版词典命中返回 pending:false + 静态 translations（来自 wordbank.json）
 *   - 新版移除 wordbank.json，所有词的释义都改为在线查询后缓存本地
 *   - 故所有"待显示词"统一返回 pending:true，由调用方异步获取 translations
 *   - tags 仍来自 wordlists.jsonl（仅英文，2026-09-18 改 JSONL），与 rank 同步返回
 *
 * 反思（2026-08-02 修正）：传递 lemma 字段（词形还原原形）供浮层显示
 *   - 词典直接命中：lemma=null
 *   - 词形还原后命中（running→run）：lemma='run'
 *   - 表外词：lemma=null
 *
 * NaN 防御：entry.rank 非有限数字时视为表外（rank=null），避免 NaN 参与比较
 *
 * @param {string} word 小写单词
 * @param {number} threshold 词频阈值
 * @returns {{isWord:boolean,rank:number|null,tags:string[],lemma:string|null,translations:string[],pending:boolean}|null}
 */
export function lookupWord(word, threshold = 0) {
  const entry = lookup(word);
  // 词典命中且 rank 在阈值范围内（>下界 且 <=上界）
  if (entry && typeof entry.rank === 'number' && isFinite(entry.rank)
      && entry.rank > threshold && entry.rank <= _rankMax) {
    return {
      isWord: true,
      rank: entry.rank,
      tags: entry.tags || [],
      lemma: entry.lemma || null,  // 词形还原原形（直接命中为 null，词形还原后命中为原形）
      translations: [],  // 反思（2026-08-02）：释义改由 translator 异步获取，暂返回空数组
      pending: true      // 标记释义待异步获取
    };
  }
  // 表外单词（wordfreq 无记录，或词形还原后仍未命中）
  if (!entry) {
    return {
      isWord: true,
      rank: null,
      tags: [],
      lemma: null,
      translations: [],
      pending: true
    };
  }
  // 词典命中但 rank <= 阈值（高频词，不显示）
  return null;
}

/**
 * 对一条字幕文本提取注解
 *
 * 流程：
 *   1. extractEnglishWords(text.lower()) 分词+选词
 *   2. 对每个 word：
 *      - lookupWord 判定是否需要显示（高频词跳过）
 *      - 需要显示 → 通过 translator.translate(word) 异步获取释义
 *        - 词典命中：保留 rank + tags（来自 wordfreq + wordlists）
 *        - 表外：rank=null, tags=[]（仍尝试翻译，结果存入缓存）
 *   3. 去重（seen 集合，跨多次调用需传入外部 seen）
 *
 * 释义获取有两种模式：
 *   - 阻塞模式（onAsyncTranslate 不传）：await translate(word)，翻译完才返回。
 *     首次触发会下载 Translator 模型（几十 MB），可能拖慢渲染。text-hint-impl 用此模式。
 *   - 非阻塞模式（onAsyncTranslate 传入）：先返回 translations:[] + pending:true 占位，
 *     translate 在后台执行，完成后调 onAsyncTranslate(ann)。sidebar 用此模式避免阻塞首屏。
 *
 * 反思（2026-08-02）：
 *   - 旧版区分"词典命中"（直接返回静态 translations）和"表外"（异步翻译）两个分支
 *   - 新版统一为异步翻译流程：所有词都需通过 translator 获取释义（在线查询后缓存本地）
 *   - 简化代码：合并分支，统一调用 translate(word)
 *
 * @param {string} text 字幕文本
 * @param {number} rankThreshold 词频阈值（默认 0=显示所有词典词）
 * @param {Set<string>} seen 去重集合（跨字幕共享，由调用方维护）
 * @param {(ann:{word,tags,translations,rank,pending:boolean})=>void} [onAsyncTranslate]
 *        单词异步翻译完成回调（非阻塞模式）。不传则用阻塞模式。
 * @param {boolean} [priority=false] 翻译优先级（页面文本=true 优先于 ASR/OCR=false）
 * @returns {Promise<Array<{word, tags, translations, rank, pending?}>>}
 */
export async function getAnnotations(text, rankThreshold = 0, seen = new Set(), onAsyncTranslate = null, priority = false) {
  // 反思（2026-08-19 第八十次）：整句注释属批量路径（视频侧栏/文本侧栏/字幕叠加/ASR/OCR），
  //   处理期间置词典静音，使 ①②③ 逐词日志不刷屏；logBatch 统计统一由 text-hint 分屏扫描输出。
  setQuietBatch(true);
  try {
    return await getAnnotationsInner(text, rankThreshold, seen, onAsyncTranslate, priority);
  } finally {
    setQuietBatch(false);
  }
}

/** getAnnotations 实际实现（批量静音包裹外层，见上方 wrapper） */
async function getAnnotationsInner(text, rankThreshold = 0, seen = new Set(), onAsyncTranslate = null, priority = false) {
  // 反思（2026-08-16 第七十二次）：词典只加载一次——startHint/web-sidebar 启动时已加载，
  //   此处不再逐句调 loadDictionary()（用户反馈"每次都加载 wordfreq/wordlists"）。
  //   若 Maps 未就绪（极端竞态），lookup 返回 null，走表外分支。
  // rankThreshold 防御：非数字或 NaN 时回退默认值 5000。
  // 第一百八十五次（用户："也不知道你咋选词的…有高频词"）：旧版回退 0 等于"不过滤高频词"，
  //   与全仓默认阈值 5000（popup/service-worker/th/core/ws/core/video-sidebar 等）不一致；
  //   一旦调用方漏传或传入 NaN（配置未就绪的竞态），高频词就整批漏进词表。统一为 5000。
  const threshold = (typeof rankThreshold === 'number' && !isNaN(rankThreshold)) ? rankThreshold : 5000;
  const words = extractEnglishWords(text.toLowerCase());
  const annotations = [];
  // 反思（2026-08-16 第七十次）：每批处理的真实账本——文本字符数 / 分词数 / 去重单词数，
  //   以及各属性 词典直读 vs 临时组装 的数量（计数点在下方真实读取/翻译处）。
  const stats = beginBatch('annotator', '整句注释（字幕/侧栏 逐句）');
  countChars(stats, text.length);
  countTokens(stats, words.length);
  const batchUnique = new Set();

  // 反思（2026-08-13 第五十次）：用户要求"统一词典——刷新页面/换网站后应从词典加载，
  //   只有词典之外的词才重新构建（词频/词形/翻译），还遗漏了注音"。
  //   根因：旧版 lookupWord 只查内存 Maps（wordfreq/wordlists），翻译只查 word-cache
  //   （chrome.storage.local 分桶），均未走 word-db（IndexedDB 统一词典）：
  //   每次刷新页面都重新解压 wordfreq、重新词形还原、重新组装 rank/lemma/tags，
  //   phonetic 也不进统一词典。
  //   修正：getAnnotations 主路径改为从统一词典 IDB 批量读取完整记录
  //   （rank/lemma/tags/translation/phonetic），命中直接用、不再重建；
  //   仅词典之外的词才从 Maps 组装 rank/lemma/tags 并写回 IDB；
  //   翻译命中 IDB（translationLang 匹配）则不再调 translate。
  //   word-db 放在 SW 层（扩展源 IDB），跨页面/跨网站共享（详见 word-db.js）。
  const lang = getLearnLang();
  let idbRecords = [];
  try {
    idbRecords = await getWordsBatch(lang, words);
  } catch (e) { /* IDB 失败降级：全部走 Maps */ }
  const idbByWord = new Map();
  for (let i = 0; i < words.length; i++) {
    if (idbRecords[i]) idbByWord.set(words[i], idbRecords[i]);
  }

  // 诊断：首批打印词典状态 + 每词 lookup 结果，排查"字幕0生词"
  const _diag = [];
  for (const word of words) {
    if (seen.has(word)) { incScalar(stats, 'skipSeen'); _diag.push(`${word}:skip(seen)`); continue; }
    // 反思（2026-08-30 第一百八十二次）：用户报障「视频侧栏的句子…生词重复高亮注释」。
    //   根因是本函数对 seen 的用法是 check-then-act（TOCTOU）：上一行做 has() 检查，
    //   而 seen.add() 原先分散在下方三个 push 分支里，两者之间横跨
    //   getWordsBatch / lookupWithLemmatizer / updateFields / translate 四个 await。
    //   vs/subtitle-renderer.js#renderSubtitlePanel 对所有字幕槽同步 fire
    //   collectAnnotationsForSlot（不 await），N 个并发调用共享同一个 _seenWords Set：
    //   句 A 还卡在 await 时句 B 已通过 has() 检查 → 同一个词被多个句子同时收录 → 跨句重复注释。
    //   修正：检查通过即刻占位登记（同步语义），把 check 与 act 之间的窗口压到零。
    //   高频词/无译文等后续 continue 分支也已登记：这些词本就不产注释，登记后其他句子
    //   同样不产注释，与单线程顺序执行的结果一致，不改变可见行为。
    // 第二百四十七次（用户 13:33 github.com 日志：0命中诊断 words 与 lookup 全是
    //   skip(seen)，词典加载=否）：词典冷装载（1~17s）期间的首批扫描把整页词都写进
    //   共享 seen（check-then-act 占位），但词典未就绪时 lookup 全 null → 全部"表外"假象
    //   被滤掉（annotateOov=false）→ 0 注释且词已被占位 → 词典就绪后同会话 skip(seen)
    //   永不再查 → 侧栏/提示永久为空。修法：词典未就绪时不登记 seen（本轮不产注释也不
    //   占位），词典就绪后的重扫可重新查词，桌面条目正常产出。
    if (isLoaded()) {
      seen.add(word);
      if (!batchUnique.has(word)) { batchUnique.add(word); countUnique(stats, 1); }
    }

    // 1. rank/lemma/tags：IDB 有则直接用（词典内单词不重建）；否则 Maps 组装并写回
    // 反思（2026-08-16 第六十九次）：完备性 = 词典记录已带词形字段（lemma 为字符串）。
    //   旧版把 lemma===null（基础形词典词，如 the/run，原词即原形）判为不完备，每次刷新
    //   页面都重新词形还原、逐个组装词形。现首次遇到某词即写回 lemma 字段（变形词存原形、
    //   基础形存小写原词；显示守卫 lemma!==word 不会误显示"原形"行），之后刷新直接读词典字段。
    const rec = idbByWord.get(word);
    let rank = null;
    let lemma = null;
    let tags = [];
    if (rec && rec.rank !== undefined && typeof rec.lemma === 'string' && rec.tags !== undefined) {
      // 统一词典(IDB)直读命中：三个属性都来自词典
      rank = rec.rank;
      lemma = rec.lemma;
      tags = rec.tags || [];
      incField(stats, 'rank', 'dict');
      incField(stats, 'lemma', 'dict');
      incField(stats, 'tags', 'dict');
    } else {
      // 仅首次遇到的单词（IDB 未命中/无词形字段）才组装一次，结果写回词典供后续直读
      let mapResult = lookup(word);
      // 反思（2026-08-15 第六十四次）：统一词典按需--词形未缓存且 IDB 无记录时，
      //   查词 miss 可能是"变形词未还原"（如 ran/children），按需补词形后重查一次。
      // 第一百九十九次：去掉 `!hasCachedLemma(word, lang)` 守卫（自败守卫：缓存暖
      //   ≠ 词条 lemma 正确；lemmatizeOne 自带逐词缓存，重复调用零开销）。
      if (!mapResult || (mapResult.lemma === null && mapResult.rank !== null)) {
        mapResult = await lookupWithLemmatizer(word) || mapResult;
      }
      // 组装账：无论词频表命中/词形还原/纯表外，rank/lemma/tags 都属"临时组装"来源
      rank = mapResult ? mapResult.rank : null;
      lemma = (mapResult && mapResult.lemma) ? mapResult.lemma : word;
      tags = mapResult ? mapResult.tags : [];
      incField(stats, 'rank', 'asm');
      incField(stats, 'lemma', 'asm');
      incField(stats, 'tags', 'asm');
      // 组装结果写回统一词典：之后刷新/换站直接读词典字段，不再逐词组装
      try { await updateFields(lang, word, { rank, lemma, tags }); } catch (e) { /* 写回失败不阻塞 */ }
    }
    _diag.push(`${word}:${rank !== null ? `r${rank}` : '表外'}`);

    // 2. 阈值范围过滤（下界：rank<=阈值不高亮；上界：rank>上界=极生僻词不显示）
    if (rank !== null && typeof rank === 'number' && isFinite(rank)
        && (rank <= threshold || rank > _rankMax)) {
      incScalar(stats, 'highFreq');
      _diag[_diag.length - 1] += ':高频跳过';
      continue;
    }

    // 3. 释义：优先用统一词典缓存的翻译（translationLang 匹配则无需再调 translate）
    // 反思（2026-08-15 第六十次修正）：旧版用源语言 lang 比对 translationLang，
    //   translationLang 记录的是"目标语言"（释义语言），与源语言永不等 → IDB 翻译
    //   缓存永远视为未命中 → 每次都走异步 translate（即使词典已有译文）。
    //   修正：用 translator 当前目标语言比对，命中则直接取词典译文，符合
    //   "找单词数据只有找词典，词典是缓存层，找不着了再去原始渠道并回填"。
    const meaningLang = getMeaningLang();
    const idbTrans = (rec && rec.translation && rec.translationLang === meaningLang) ? rec.translation : null;
    if (idbTrans) {
      const cleanTrans = cleanDictEntry(idbTrans);
      if (cleanTrans) {
        // 释义来自统一词典(IDB)缓存译文（语言匹配）
        incField(stats, 'trans', 'dict');
        annotations.push({
          word,
          lemma,          // 词形还原原形（2026-08-14 第五十四次：透传给词汇表展示"词形"）
          tags,
          translations: [cleanTrans],
          rank,
          pending: false
        });
        continue;
      }
    }

    // 4. 词典中无缓存翻译（或语言不匹配）：翻译（translator 成功后写回 IDB）
    // 释义账：词典无目标语言译文 → 需在线翻译组装（结果写回 IDB，下次直读）
    incField(stats, 'trans', 'asm');
    if (onAsyncTranslate) {
      // 非阻塞模式：先返回占位，异步翻译完成后回填
      const ann = {
        word,
        lemma,          // 词形还原原形（2026-08-14 第五十四次）
        tags,
        translations: [],
        rank,
        pending: true      // 标记翻译进行中
      };
      annotations.push(ann);
      translate(word, priority).then((translated) => {
        ann.translations = translated ? [translated] : [];
        ann.pending = false;
        onAsyncTranslate(ann);
      }).catch((e) => {
        ann.pending = false;
        console.warn(`[VocabRadar][annotator] 单词翻译失败: ${word}`, e);
        onAsyncTranslate(ann);
      });
    } else {
      // 阻塞模式：await translate，翻译完才返回
      const translated = await translate(word, priority);
      annotations.push({
        word,
        lemma,          // 词形还原原形（2026-08-14 第五十四次）
        tags,
        translations: translated ? [translated] : [],
        rank
      });
    }
  }

  // 空结果诊断：words 非空但 0 命中时，打印词典状态 + 前10词 lookup 结果
  // 排查"字幕0生词"——若 wordfreq 未加载，所有词都走表外分支
  // 仅首次 0 命中打印一次，避免多字幕刷屏
  if (words.length > 0 && annotations.length === 0 && !_0HitLogged) {
    _0HitLogged = true;
    const the = lookup('the');  // 用已知词探测词典是否加载
    const sample = words.slice(0, 10).join(',') + (words.length > 10 ? ` ...共${words.length}词` : '');
    const diagSample = _diag.slice(0, 10).join('|');
    console.warn('[VocabRadar][annotator] 0命中诊断(仅首次):',
      '词典加载=', the ? `是(the:rank${the.rank})` : '否(lookup(the)=null)',
      'threshold=', threshold,
      'words(前10)=', sample,
      'lookup(前10)=', diagSample);
  }

  // 反思（2026-08-16 第七十二次）：annotator 逐句调用——不再每句打印 logBatch，
  //   避免侧栏/字幕路径大量刷屏；仅保留 0 命中诊断（上方已打印）。
  //   logBatch 统计由 text-hint processBatch（分屏扫描批次级）统一输出。

  return annotations;
}

// 0命中诊断只打印一次的标志（模块级，避免每条字幕都刷屏）
let _0HitLogged = false;

/** 重置 0 命中诊断标志（rerender 时由 sidebar 调用，允许下次再打印一次） */
export function resetDiag() { _0HitLogged = false; }

/**
 * 阶显示：rank//1000 阶，表外显示"表外"
 * NaN 防御：rank 非Finite 数字时显示"表外"，避免出现"NaN阶"
 * @param {number|null|undefined} rank
 * @returns {string}
 */
export function rankToStage(rank) {
  if (rank === null || rank === undefined) return '表外';
  if (typeof rank !== 'number' || !isFinite(rank)) return '表外';
  if (rank <= 0) return '表外';
  // 反思（2026-08-05 修正）：用户反馈"右键查询咋还有0阶"。
  //   旧版 Math.floor(rank/1000) 对 rank 1-999 返回"0阶"，不符合直觉。
  //   改为 1-based：rank 1-1000 → 1阶，rank 1001-2000 → 2阶，以此类推。
  // 第二百一十三次（用户："无论界面啥语言，x阶都改为 Levelx"）：词阶统一英文 Level 形态，
  //   英文界面不再出现中文"阶"；"表外"仍按原样（调用方按需处理）。
  return `Level${Math.floor((rank - 1) / 1000) + 1}`;
}
