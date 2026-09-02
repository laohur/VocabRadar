// VocabRadar 统一词典存储（IndexedDB）-- 门面（纯 re-export，零行为变更）
//
// 反思（2026-08-20 第八十六次）：角色澄清--本文件=词典【存储层】。
//   readme.txt:150/152/178 权威设计：
//     "装载词频、词形还原等函数，与词典无关，装载完成之后送入词典。插件初始化时候，
//      装载词频、词表、词形还原等组成词典。之后只有数据损坏不全才会再次启用装载函数。"
//     "只有一个词典，所有跟随单词的属性都存在此，之后读取此缓存。"
//   对应到代码：
//     - words store = 唯一词典（跟随单词的 rank/lemma/tags/translation/phonetic 全在此）。
//     - 装载函数（loadWordfreq/loadWordlists 等，在 dictionary.js）不是词典，只在
//       初始化或词典缺失/不全时启用，装载完成经 bulkWriteDictionary 送入本词典后不再读取。
//     - 业务只从词典调用（dictionary.js lookup/lookupFull 经 getLangProjection 读词典投影）。
//     - dictCache store = 词形还原源数据（diverse-lemmas 整表，首次 CDN 下载后存扩展数据域，
//       仅作词形引擎数据源，非跟随单词的属性）；单个单词的词形结果写回 words.lemma 字段。
//
// ===拆分说明（2026-08-28）===
// 本文件原为 1002 行单文件，已按功能拆分为 src/lib/word-db/ 目录模块（纯机械搬移）：
//   - key-utils.js：makeKey/splitKey 主键构造/还原（唯一实例，历史铁律见该文件头）
//   - env.js：isSW/DIRECT_IDB/runtimeValid 环境检测 + 站点库清污副作用
//   - projection-cache.js：SW 投影内存缓存 _projCache（唯一 Map 实例）
//   - db-ops.js：IDB 打开/事务/游标读写原语（含库/表常量与 _dbPromise 连接单例）
//   - lemmas-engine.js：词形数据装载与逐词还原引擎
//   - sw-channel.js：SW 消息通道与 DIRECT_IDB 路由（全部 11 个对外导出在此实现）
// 本门面仅 re-export 全部原导出符号（符号名不变），所有引用方零改动。
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
//     translationLang: "zh",     // 释义目标语言（切换 targetLang 时译文失效）
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
  getLangProjection, bulkWriteDictionary, getDictCache, setDictCache,
  handleWordDbMessage, warmupDictProjection
} from './word-db/sw-channel.js';
