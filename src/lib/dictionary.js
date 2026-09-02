// 词典加载与查询（统一词典：词频 rank + 词表 tags 是同一词条的两个字段）-- 门面（纯 re-export，零行为变更）
//
// 反思（2026-08-20 第八十六次）：角色澄清--本文件=词典的【装载 + 查询门面】。
//   readme.txt:150/152/178 权威设计：
//     "装载词频、词形还原等函数，与词典无关，装载完成之后送入词典。插件初始化时候，
//      装载词频、词表、词形还原等组成词典。之后只有数据损坏不全才会再次启用装载函数。"
//     "业务需要单词数据只能从词典调用。词频、词形等都是扩展刚安装初始化一次性读取，
//      读完之后存入词典，之后不再读取。"
//   对应到代码：
//     - 词典 = word-db.js 的 words store（唯一词典，跟随单词的属性全在此）。
//     - 装载函数（loadWordfreq/loadWordlists）不是词典：仅在 _loadDict 判定
//       词典缺失/不全（getLangProjection 投影 built=false）时启用，读取源文件后经
//       bulkWriteDictionary 送入词典，之后不再读取。
//     - 查询：lookup()/lookupFull() 读内存统一词典 _dictMap，而 _dictMap 由
//       getLangProjection 从词典投影构建（词典已构建时）--即业务数据来源只有词典；
//       装载函数只写词典不供业务直读。
//     - lemma 由 lookupFull/lookupWithLemmatizer 懒填充回写词典 words.lemma 字段。
// 反思（2026-08-21 第八十八次）：词典只有一个--内存只保留一张表 _dictMap
//   （Map<word, {rank, tags}>），wordfreq（rank 字段）与 wordlists（tags 字段）
//   是同一词条的两个属性，不再有 _wordfreqMap/_wordlistsMap 两张表。
//
// 数据来源：
//   1. src/data/wordfreq/small_{lang}.msgpack.gz (wordfreq 数据，10种语言)
//      格式：{ word: frequency }，frequency 为每百万词出现次数（float）
//   2. src/data/wordlists.json (英文词表标签)
//      格式：{ word_lower: [list_ids] }，仅英文，list_ids 如 ["CET4","CET6"]
//
// 查询接口：
//   - lookup(word) 返回 { rank, tags }（不再含 translations，释义改由 translator.js 异步获取）
//   - rank 按 frequency 降序排序后赋值（rank=1 为最高频词，如 "the"）
//   - tags 从 wordlists.json 匹配，匹配前先词形还原（如 "running" -> "run"）
//
// 反思（2026-08-02）：
//   - 旧版加载 wordbank.json (6.8MB，含 translations+rank+tags)，
//     体积大、加载慢、释义静态不可更新。
//   - 用户要求"不再使用词典文件，由在线查询后缓存本地"：
//     (a) 移除 wordbank.json，改加载 wordfreq 的 small_*.msgpack.gz (10个文件共~1.6MB)
//     (b) 释义改由 translator.js 在线查询后 fnv1aHash 100分桶缓存本地
//     (c) tags 保留为 wordlists.json (约200KB)，仅英文词表
//   - wordfreq 各语言独立文件，按 learnLanguage 选择加载
//   - 同语言只加载一次（缓存到内存），切换源语言时重新加载
//
// ===拆分说明（2026-08-28）===
// 本文件原为 785 行单文件，已按功能拆分为 src/lib/dictionary/ 目录模块（纯机械搬移）：
//   - state.js：dictState 共享状态（loadedLang/dictMap/loadPromise/currentLearnLang/
//     quietBatch）+ DEFAULT_SOURCE_LANG + _ts + setQuietBatch/getLearnLang +
//     chrome.storage 源语言监听（模块加载副作用仅此一处，ESM 缓存保证唯一）
//   - word-loader.js：装载函数 loadWordfreq/loadWordlists 与源读取
//     （decompressViaBackground 后台解压回退、msgpack/cBpack 解码）
//   - projection.js：内存投影构建 _loadDict/_rebuildFromSources/getManifestCounts
//     （读词典投影构建 dictState.dictMap；缺失/不全时源装载并送库）
//   - query.js：查询接口 ensureReady/lookup/lookupWithLemmatizer/lookupFull/
//     getTags/isLoaded/getDiagState（含三个一次性日志 Set）
// 本门面仅 re-export 全部原导出符号（符号名不变），所有引用方零改动。
export { setQuietBatch, getLearnLang } from './dictionary/state.js';
export {
  ensureReady, lookup, lookupWithLemmatizer, lookupFull, prefetchFull, isLoaded, getDiagState
} from './dictionary/query.js';
