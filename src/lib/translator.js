// 单词释义查询：多渠道健壮性 + 本地缓存 -- 门面（纯 re-export，零行为变更）
//
// 本模块是纯粹的"翻译函数"--给单词，返回译文。不负责任何开关门控。
//   - 是否需要翻译（如 popup "注释生僻词"开关）由调用方决定（如 annotator.js/sidebar.js）
//   - Translator 模型下载在 content script 启动时自动预加载，独立于任何开关
//
// 渠道优先级：
//   1. 本地缓存（统一词典 word-db.js dbGetWord：key={lang}|{word_lower} 的 translation 字段）-> 命中直接返回
//   2. 浏览器内置 Translator API（Chrome 138+，本地神经网络，最优）
//   3. 经 service worker 转发的在线渠道（MyMemory -> Google -> Youdao -> Baidu -> Bing -> Lingva）
//   4. 任一渠道成功 -> dbUpdateFields 写回词典 translation 字段
//
// 反思（2026-08-02）：
//   - 旧版 translator.js 用 `tx_${word}` 单 key 缓存（每词一 key），
//     chrome.storage.local key 数量受限（约几千），大量生词会超限。
//   - 用户要求"使用散列 fnv1aHash 划分 100 份分桶存储，带上语言对前缀"：
//     (a) 缓存 key 改为 `wc_{src}-{tgt}-{bucket}`（100 个桶 × N 个语言对）
//     (b) 单桶内为 { word_lower: translation_string } 对象
//   - source/target 改为从 storage.local 读取（默认 en -> zh），支持多语言切换
//
// 反思（2026-08-03 修正）：
//   - 用户要求"翻译函数还讲究强制不强制，也不应该在这里控制"。
//   - 旧版 translate(word, {force}) 含开关门控，未勾选"注释生僻词"时直接返回 null。
//   - 这导致 annotator.js getAnnotations 返回的 translations 为空但 word/rank/tags 有效
//     -> 侧栏生词表有词无释义；text-hint-impl.js 用 force=true 绕过门控故有释义。
//   - 修正：translate 仅做翻译，移除 _enabled / force 参数；开关门控由调用方处理。
//     "注释生僻词"开关的语义：sidebar.js collectAnnotations 中 _localTranslateEnabled=false 时
//     过滤 rank=null 的表外词，不收集进生词表（不影响翻译本身）。
//
// 反思（2026-08-12）：统一词典迁移--从 word-cache.js（chrome.storage.local 100分桶）
//   迁移到 word-db.js（IndexedDB 统一存储），实现翻译缓存跨网站共享。
//   word-db.js 在 content script 中通过 chrome.runtime.sendMessage 转发给 SW 操作 IDB。
//
// ===拆分说明（2026-08-28）===
// 本文件原为 625 行单文件，已按功能拆分为 src/lib/translator/ 目录模块（纯机械搬移）：
//   - shared.js：跨模块共享状态唯一属主（transState 语言对/_lastChannel 最近成功渠道/
//     _debug 调试开关）+ 工具（withTimeout/_ts/log）+ getLastTranslateChannel/getMeaningLang
//   - builtin-translator.js：浏览器内置 Translator API（单例状态 _translator/_initPromise/
//     _availability、storage 语言对初始读取与变更监听、preloadTranslator 预热、
//     getAvailability/getTranslator、targetScriptOk 文字系统校验）
//   - online-channels.js：SW 在线渠道消息通道 sendMessage（TRANSLATE_TEXT 转发 + 55 秒超时）
//   - index.js：翻译主流程（getWordCached/setWordCached 词典缓存、优先级队列、
//     translate/_processQueue/_translateInternal/translateWithLemma），并作为目录统一出口
//     re-export shared.js 与 builtin-translator.js 的原导出符号
// 跨模块共享状态铁律：transState（语言对）与 _lastChannel 唯一实例在 shared.js，
//   各子模块经 import 同源引用，绝不复制两份。
// 本门面仅 re-export 全部原导出符号（符号名不变），所有引用方零改动。
// 2026-09-09 第二百四十二次：补 primeTranslator（手势入口 prime，th/panel.js 查词/OCR 面板用）
export { translate, getLastTranslateChannel, getMeaningLang, getAvailability, primeTranslator } from './translator/index.js';
