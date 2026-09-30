// 单词释义查询：多渠道健壮性 + 本地缓存 -- 门面（纯 re-export，零行为变更）
//
// 本模块是纯粹的"翻译函数"--给单词，返回译文。不负责任何开关门控。
//   - 是否需要翻译（如 popup "注释生僻词"开关）由调用方决定（如 annotator.js/sidebar.js）
//   - Translator 模型下载在 content script 启动时自动预加载，独立于任何开关
//
// 渠道优先级：
//   1. 本地缓存（统一词典 word-db.js dbGetWord：key={lang}|{word_lower} 的 translation 字段）-> 命中直接返回
//   2. 浏览器内置 Translator API（Chrome 138+，本地神经网络，最优）
//   3. 经 service worker 转发的在线渠道（Backend -> 词典快渠道 -> Reverso -> Bing ->
//      Google -> Youdao -> Baidu -> MyMemory；见 sw/translate.js）
//   4. 任一渠道成功 -> dbUpdateFields 写回词典 translation 字段
//
// 存储现状：词典缓存 = IndexedDB 统一词典（word-db.js translation 字段），跨网站共享，
//   content script 中经 chrome.runtime.sendMessage 转发给 SW 操作 IDB
//   （早期 chrome.storage.local 100 分桶方案已废弃）。
//
// 模块结构（src/lib/translator/ 目录）：
//   - shared.js：跨模块共享状态唯一属主（transState 语言对/_lastChannel 最近成功渠道/
//     _debug 调试开关）+ 工具（withTimeout/_ts/log）+ getLastTranslateChannel/getMeaningLang
//   - builtin-translator.js：浏览器内置 Translator API（单例状态 _translator/_initPromise/
//     _availability、storage 语言对初始读取与变更监听、preloadTranslator 预热、
//     getAvailability/getTranslator、targetScriptOk 文字系统校验）
//   - online-channels.js：SW 在线渠道消息通道 sendMessage（TRANSLATE_TEXT 转发 + 80 秒超时）
//   - index.js：翻译主流程（getWordCached/setWordCached 词典缓存、优先级队列、
//     translate/_processQueue/_translateInternal/translateWithLemma），并作为目录统一出口
//     re-export shared.js 与 builtin-translator.js 的原导出符号
// 跨模块共享状态铁律：transState（语言对）与 _lastChannel 唯一实例在 shared.js，
//   各子模块经 import 同源引用，绝不复制两份。
// 本门面仅 re-export 全部原导出符号（符号名不变），所有引用方零改动。
export {
  translate, getLastTranslateChannel, getMeaningLang, getAvailability, primeTranslator, targetScriptOk,
  // 翻译优先级档常量（调用方按来源传档：2=视频侧栏，1=网页正文；true/3=交互）
  PRIO_INTERACT, PRIO_VIDEO, PRIO_WEB, PRIO_LOW
} from './translator/index.js';
