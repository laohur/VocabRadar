// VocabRadar 统一词典存储（IndexedDB）-- 门面（纯 re-export，零行为变更）
//
// 角色定位：本文件=词典【存储层】（readme.txt:150/152/178 权威设计）：
//   "装载词频、词形还原等函数，与词典无关，装载完成之后送入词典。插件初始化时候，
//    装载词频、词表、词形还原等组成词典。之后只有数据损坏不全才会再次启用装载函数。"
//   "只有一个词典，所有跟随单词的属性都存在此，之后读取此缓存。"
//   - words store = 唯一词典（跟随单词的 rank/lemma/tags/translation/phonetic 全在此）。
//   - 装载函数（loadWordfreq/loadWordlists 等，在 dictionary.js）不是词典，仅在
//     初始化或词典缺失/不全时启用，装载完成经 bulkWriteDictionary 送入本词典。
//   - 业务只从词典调用（dictionary.js lookup/lookupFull 经 getLangProjection 读词典投影）。
//   - dictCache store = 词形还原源数据（diverse-lemmas 整表，首次 CDN 下载后存扩展数据域，
//     仅作词形引擎数据源，非跟随单词的属性）；单个单词的词形结果写回 words.lemma 字段。
//
// ===记录结构（沿用）===
//   {
//     key: "en|hello",           // lang|word_lower（主键）
//     lang: "en",                // 源语言
//     word: "hello",             // 小写单词
//     rank: 569,                 // 词频排名 number | null（null=表外词）
//     lemma: null,               // 词形还原原形 string | null（null=原词即原形）
//     tags: ["CET4"],            // 词表标签 string[]（空数组=无标签）
//     translation: "你好",       // 释义 string | null（null=未翻译或失败）
//     translationLang: "zh",     // 释义目标语言（切换 meaningLang 时译文失效）
//     phonetic: "həˈloʊ",        // 注音 string | null（null=未注音或失败）
//     updatedAt: 1699999999999   // 最后更新时间戳
//   }
//
// ===字段缺失语义（沿用）===
//   rank/lemma/tags：record 存在即已填充（lookup 时一次性写入）
//   translation：null=未翻译，非 null=已翻译（含 translationLang 校验）
//   phonetic：null=未注音，非 null=已注音
export {
  getWord, getWordsBatch, putWord, updateFields, clearByLang, clearAll,
  getLangProjection, getRanksProjection, bulkWriteDictionary, bulkWriteTranslations, getDictCache, setDictCache,
  handleWordDbMessage, warmupDictProjection,
  countTranslationEntries, // d_trans 按语言计数（引导页就绪行分项统计用）
  lemmasSize // 词形数据仅读缓存计数（不触发下载，分项统计用）
} from './word-db/sw-channel.js';
