// ============================================================
// 文件职责：词典共享状态与源语言监听（src/lib/dictionary/state.js）
// 来源：拆分自 src/lib/dictionary.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// 跨模块共享状态唯一属主（拆分铁律：绝不复制两份）：
//   dictState = { loadedLang, dictMap, loadPromise, currentLearnLang, quietBatch,
//     ranksReadyLang, ranksPromise, _settleRanks }
//   分阶段投影（2026-09-04）：ranks 先行——ranksReadyLang 记录 rank-only 就绪的语言，
//   ranksPromise 供扫描侧先重扫出高亮；_settleRanks 是 ranks 承诺的 resolve 函数暂存
//   （loadPromise 异常时兜底 resolve null，承诺永不悬空）。
//   原单文件的模块级 let 变量（_loadedLang/_dictMap/_loadPromise/_currentLearnLang/
//   _quietBatch）收拢为导出可变对象，word-loader.js / projection.js / query.js
//   经 import 引用同一实例读写，与原单文件行为完全一致。
// 本文件还含：DEFAULT_SOURCE_LANG 常量、_ts() 时间戳辅助、setQuietBatch/
//   getLearnLang 导出、chrome.storage 源语言初始读取与变更监听（模块加载时
//   注册一次，ESM 模块缓存保证副作用只执行一次）。
// ============================================================

// 默认源语言（与 popup.js DEFAULTS.learnLanguage 一致）
export const DEFAULT_SOURCE_LANG = 'en';

// === 加载状态 ===
// 当前已加载的语言（缓存 key），避免同语言重复加载
// 统一词典（2026-08-21 第八十九次）：Map<word_lower, entry>，entry 含单词全部属性--
//   { rank, tags, lemma, translation, translationLang, phonetic }
// 反思（2026-08-21 第八十九次）：用户明确"词典只有一个，所有关于单词的属性都在其中"。
//   - rank/tags：装载/投影时全量就位；lemma：投影带出已持久化的词形（跨会话不再重还原）；
//   - translation/translationLang/phonetic：体积大，词条保留字段、首次 lookupFull 按需直读
//     IDB 懒填充，此后直读内存词典（不再每次查 IDB）。
//   - 旧 _wordfreqMap/_wordlistsMap 两张表与 _lemmaCache 词形镜像全部废除，只此一表。
// 加载 Promise（避免并发加载）
// 批量处理静音开关（2026-08-19 第八十次）：分屏扫描/整句注释等批量路径在批内置静音，
//   使"一屏扫描只打印一条统计"（logBatch 汇总），①②③逐词日志仅在用户主动查词时打印。
export const dictState = {
  loadedLang: null,                    // 原 _loadedLang
  dictMap: null,                       // 原 _dictMap
  loadPromise: null,                   // 原 _loadPromise
  currentLearnLang: DEFAULT_SOURCE_LANG, // 原 _currentLearnLang
  quietBatch: false,                   // 原 _quietBatch
  ranksReadyLang: null,                // 分阶段 Stage 1 就绪语言（rank-only 可扫）
  ranksPromise: null,                  // 分阶段 Stage 1 承诺（同语言复用）
  _settleRanks: null,                  // ranks 承诺 resolve 暂存（异常兜底用）
  maxRank: 0                           // 词频表上界（当前语言 wordfreq 最大 rank = 词数），
                                       //   词频范围上界默认值来源；装载/投影构建时维护
};

/** 设置/取消词典逐词日志静音（批量处理期间置 true，结束置 false）
 * 反思（2026-08-28 第一百六十八次）：旧版是**全局布尔**，多个批量路径并发时
 *   （text-hint 分屏扫描 processBatch 与 annotator 整句注释 getAnnotations 交错），
 *   任一路径的 finally setQuietBatch(false) 会提前解除其它仍在进行批次的静音，
 *   导致 ①②③ 逐词日志在扫描期间刷屏（用户："后台一直打印查询词典"）。
 *   修正：改为引用计数——置 true 计数加一，置 false 减一，计数为 0 才真正解除静音。
 */
let _quietDepth = 0;
export function setQuietBatch(v) {
  if (v) _quietDepth += 1;
  else _quietDepth = Math.max(0, _quietDepth - 1);
  dictState.quietBatch = _quietDepth > 0;
}

// === 时间戳辅助 ===
export function _ts() {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// === 读取当前 learnLanguage（chrome.storage.local） ===
// 缓存值 + 监听变化，避免每次 lookup 都读 storage
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get({ learnLanguage: DEFAULT_SOURCE_LANG }, (res) => {
    dictState.currentLearnLang = res.learnLanguage || DEFAULT_SOURCE_LANG;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.learnLanguage && changes.learnLanguage.newValue !== dictState.currentLearnLang) {
      console.log(`[VocabRadar][dictionary][${_ts()}] learnLanguage 变更: ${dictState.currentLearnLang} -> ${changes.learnLanguage.newValue}, 重新加载词频`);
      dictState.currentLearnLang = changes.learnLanguage.newValue;
      // 切换语言时清空缓存，触发懒重载（分阶段字段一并清，否则旧语言 ranks 承诺残留）
      dictState.loadedLang = null;
      dictState.dictMap = null;
      dictState.loadPromise = null;
      dictState.ranksReadyLang = null;
      dictState.ranksPromise = null;
      dictState._settleRanks = null;
      dictState.maxRank = 0;
    }
  });
}

// 反思（2026-08-21 第八十九次）：旧 _lemmaCache 词形镜像已废除--lemma 是词条属性，
//   直接存于 _dictMap 词条的 lemma 字段（用户："词典只有一个，所有关于单词的属性都在其中"）。

/**
 * 读取当前源语言（统一词典 key 前缀用）
 * @returns {string}
 */
export function getLearnLang() {
  return dictState.currentLearnLang || DEFAULT_SOURCE_LANG;
}
