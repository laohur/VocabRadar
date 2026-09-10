// ============================================================
// 文件职责：释义查询主流程与目录统一出口（src/lib/translator/index.js）
// 来源：拆分自 src/lib/translator.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// 内容：词典缓存读写（getWordCached/setWordCached）、翻译请求优先级队列
//   （_pendingMap 同词去重 + 高/低优先级串行队列）、translate 主入口（原导出）、
//   _translateInternal 渠道串联（缓存 -> 内置 Translator -> SW 在线 -> 原形回退，
//   含失败根因汇总日志）、translateWithLemma（原形回退全渠道重试）。
//   同时作为目录统一出口 re-export：getLastTranslateChannel/getMeaningLang
//   （shared.js）与 getAvailability（builtin-translator.js）；
//   门面 src/lib/translator.js 经本文件 re-export，符号名不变、引用方零改动。
// 语言对经 shared.js 的 transState（唯一实例）读写。
// ============================================================
import { getWord as dbGetWord, updateFields as dbUpdateFields } from '../word-db.js';
// 反思（2026-08-12）：统一词典迁移--从 word-cache.js（chrome.storage.local 100分桶）
//   迁移到 word-db.js（IndexedDB 统一存储），实现翻译缓存跨网站共享。
//   word-db.js 在 content script 中通过 chrome.runtime.sendMessage 转发给 SW 操作 IDB。
import { lookup as dictLookup } from '../dictionary.js';
// 反思（2026-08-06）：用户要求"options实在查不出来,就用原形去查"。
//   翻译失败时用词形还原原形（lemma）重试，如 running->run, boxes->box。
//   dictionary.js 的 lookup 返回 lemma 字段（词形还原原形）。
import { cleanDictEntry } from '../dict-clean.js';
// 反思（2026-08-16 第六十六次）：释义清洗（去除"原形(释义)的屈折说明"夹杂），
//   读缓存（旧脏数据）与写缓存（新渠道结果）都过一遍，保证统一词典内释义干净。
import { withTimeout, log, _ts, transState, _setLastChannel, getLastTranslateChannel } from './shared.js';
import { getTranslator, targetScriptOk } from './builtin-translator.js';
import { sendMessage } from './online-channels.js';

// 第二百一十六次（用户："引导页增加翻译一行，后跟LLM、几个api、浏览器自身复选框，
//   这里LLM只有文本，直接用聊天的LLM配置"）：翻译渠道勾选状态（模块级缓存 +
//   onChanged 跟随；缺省全启用＝既有行为）。
let _transChannels = null;
try {
  chrome.storage.local.get({ translationChannels: null }, (r) => {
    _transChannels = (r && r.translationChannels) || null;
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.translationChannels) {
      _transChannels = ch.translationChannels.newValue || null;
    }
  });
} catch (e) { /* ignore */ }
const DEFAULT_TRANS_CHANNELS = { llm: false, builtin: true, baidusug: true, youdaodict: true, mymemory: true, google: true, youdao: true, baidu: true, bing: true, lingva: true };
function transChEnabled(id) {
  // 第二百一十九次：llm 渠道默认不选（用户：LLM 行"默认没选"），其余缺省启用
  const st = _transChannels || DEFAULT_TRANS_CHANNELS;
  return st[id] !== false;
}

/**
 * 从统一词典读取翻译缓存
 * 反思（2026-08-12）：替代 word-cache.js 的 getWordCached。
 *   word-db.js 按 lang|word_lower 主键存储，translation 字段缓存译文，translationLang 校验语言对。
 * @param {string} src 源语言
 * @param {string} tgt 目标语言
 * @param {string} word 小写单词
 * @returns {Promise<string|null>} 译文或 null
 */
async function getWordCached(src, tgt, word) {
  try {
    const record = await dbGetWord(src, word);
    if (record && record.translation && record.translationLang === tgt) {
      return record.translation;
    }
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * 写入翻译缓存到统一词典
 * 反思（2026-08-12）：替代 word-cache.js 的 setWordCached。
 *   用 updateFields 部分更新，不影响同词的 rank/lemma/tags/phonetic 字段。
 * @param {string} src 源语言
 * @param {string} tgt 目标语言
 * @param {string} word 小写单词
 * @param {string} translation 译文
 */
async function setWordCached(src, tgt, word, translation) {
  try {
    await dbUpdateFields(src, word, { translation, translationLang: tgt });
  } catch (_) { /* ignore */ }
}

// 反思（2026-08-08）：用户反馈"为啥没用缓存而是总是请求？而且没有规范化"。
//   根因：同一单词在短时间内被多次调用 translate（如 ASR 实时流中重复出现），
//   word-cache 的 chrome.storage.local 写入是异步的，第一次调用还没写完缓存，
//   第二次调用读缓存命中不了，又发在线请求。日志中 "whisper" 被重复翻译多次。
//   修正：(1) 添加内存级 pending Map，同一单词正在翻译时复用 Promise；
//         (2) 翻译前规范化（toLowerCase + trim），确保缓存 key 一致。
//
// 反思（2026-08-08 第二次）：用户反馈"为啥要并发请求单词？api接口支持吗？
//   若是不支持，就一个一个来，降低风险"。
//   在线翻译 API（MyMemory 等）通常有速率限制，并发请求容易被封。
//   修正：添加串行队列 _translateQueue，所有翻译请求排队执行（一个完成后才发下一个）。
//   _pendingMap 仍保留（同词去重），但不同词也串行执行。
//
// 反思（2026-08-09 第三次）：用户反馈"生词很多，优先请求查询当前页面的生词"。
//   根因：所有来源（页面文本/ASR/OCR）的翻译请求在同一个 FIFO 队列中排队，
//   ASR/OCR 的词可能排在页面文本词前面，导致页面生词翻译延迟。
//   修正：将串行队列改为优先级队列。页面文本生词 priority=true 插队到高优先级队列，
//   ASR/OCR 生词 priority=false 走普通队列。高优先级队列优先处理。
const _pendingMap = new Map();  // word_lower -> Promise<string|null>

// 优先级队列：高优先级（页面生词）先处理，低优先级（ASR/OCR）后处理
const _highPriorityQueue = [];
const _lowPriorityQueue = [];
let _queueProcessing = false;

/**
 * 翻译单词（带本地缓存 + 多渠道兜底）
 *
 * 纯翻译函数：给单词返回译文，不包含任何开关门控。
 * 是否需要翻译由调用方决定（如"注释生僻词"开关控制是否收集表外词到生词表）。
 *
 * 反思（2026-08-09）：添加 priority 参数，页面生词优先于 ASR/OCR 生词。
 *
 * @param {string} word 待翻译的单词
 * @param {boolean} [priority=false] 是否高优先级（页面文本生词=true，ASR/OCR=false）
 * @returns {Promise<string|null>} 译文或 null（所有渠道失败时返回 null）
 */
export async function translate(word, priority = false) {
  // 规范化（2026-08-08）：统一小写 + trim，确保缓存 key 一致
  const normalizedWord = (word || '').trim().toLowerCase();
  if (!normalizedWord) return null;

  // 内存级去重（2026-08-08）：同一单词正在翻译时复用 Promise
  if (_pendingMap.has(normalizedWord)) {
    return _pendingMap.get(normalizedWord);
  }

  // 优先级队列（2026-08-09）：高优先级（页面生词）插队到高优先级队列
  const promise = new Promise((resolve) => {
    const task = { word: normalizedWord, resolve };
    if (priority) {
      _highPriorityQueue.push(task);
    } else {
      _lowPriorityQueue.push(task);
    }
    _processQueue();
  });
  _pendingMap.set(normalizedWord, promise);
  try {
    return await promise;
  } finally {
    _pendingMap.delete(normalizedWord);
  }
}

/**
 * 处理队列：高优先级先处理，然后低优先级，串行执行
 */
async function _processQueue() {
  if (_queueProcessing) return;
  _queueProcessing = true;
  try {
    while (_highPriorityQueue.length > 0 || _lowPriorityQueue.length > 0) {
      // 高优先级队列优先
      const task = _highPriorityQueue.length > 0
        ? _highPriorityQueue.shift()
        : _lowPriorityQueue.shift();
      try {
        const result = await _translateInternal(task.word);
        task.resolve(result);
      } catch (e) {
        task.resolve(null);
      }
    }
  } finally {
    _queueProcessing = false;
  }
}

/**
 * 翻译内部实现（已被 translate 去重包装）
 * @param {string} word 已规范化的单词（小写 + trim）
 * @returns {Promise<string|null>}
 */
async function _translateInternal(word) {
  // 反思（2026-08-13 第四十九次）：用户要求"instantly 翻译失败的根因要查清，可在 translator 里加日志"。
  //   旧版各渠道失败只有零散 console.warn，最终返回 null 时无汇总，调用方难定位根因。
  //   修正：收集各步骤结果到状态变量，返回 null 前输出根因汇总（错误信息，不依赖 _debug 开关）。
  let stepCache = '未命中';   // 缓存：命中 / 未命中
  let stepBuiltin = '未尝试'; // 浏览器内置翻译：成功 / 失败原因
  let stepOnline = '未尝试';  // 在线渠道：成功(渠道) / 失败原因 / SW未响应
  let stepLemma = '未尝试';   // 原形回退：成功 / 失败原因 / 无原形
  let stepLlm = '未尝试';   // 第二百一十六次：LLM 渠道（文本）

  // 1. 本地缓存（统一词典 word-db translation 字段）命中
  const cached = await getWordCached(transState.learnLang, transState.meaningLang, word);
  if (cached !== null) {
    _setLastChannel('本地缓存');
    return cleanDictEntry(cached);
  }
  stepCache = '未命中';

  // 2. 渠道 1：浏览器内置 Translator API
  // 反思（2026-08-05 修正）：用户反馈"有些释义结果不正常，还是原来语言"。
  //   Translator API 在某些语言对下可能返回原文未翻译（模型未下载或语言不支持），
  //   需校验 result 与 word 是否相同（src!==tgt 时），相同则置 null 继续在线渠道。
  // 反思（2026-08-06 修正）：精确匹配不够，需加文字系统校验。
  //   en->zh 时 running->run 仍是英文，精确匹配不成立但确实未翻译。
  //   新增 targetScriptOk：译文须含目标语言代表性字符。
  let result = null;
  const _chOn = { llm: transChEnabled('llm'), builtin: transChEnabled('builtin'),
    baidusug: transChEnabled('baidusug'), youdaodict: transChEnabled('youdaodict'),
    mymemory: transChEnabled('mymemory'), google: transChEnabled('google'),
    youdao: transChEnabled('youdao'), baidu: transChEnabled('baidu'),
    bing: transChEnabled('bing'), lingva: transChEnabled('lingva') };
  try {
    if (!_chOn.builtin) throw new Error('渠道未启用（翻译渠道未勾选）');
    const translator = await getTranslator();
    if (translator) {
      // 反思（2026-08-12）：translate 加 10 秒超时，防止模型推理永久挂起
      const translated = await withTimeout(translator.translate(word), 10000, 'Translator.translate');
      if (translated && translated.trim()) {
        const trimmed = translated.trim();
        if (transState.learnLang !== transState.meaningLang &&
            trimmed.toLowerCase() === word.trim().toLowerCase()) {
          stepBuiltin = '返回原文未翻译';
          log(`[VocabRadar][translator][${_ts()}] 渠道[浏览器内置翻译] "${word}" 返回原文未翻译，切换在线渠道`);
        } else if (transState.learnLang !== transState.meaningLang && !targetScriptOk(trimmed, transState.meaningLang)) {
          stepBuiltin = '译文不含目标语言(' + transState.meaningLang + ')文字';
          log(`[VocabRadar][translator][${_ts()}] 渠道[浏览器内置翻译] "${word}"->"${trimmed}" 不含目标语言(${transState.meaningLang})文字，切换在线渠道`);
        } else {
          result = cleanDictEntry(trimmed);
          stepBuiltin = '成功';
          _setLastChannel('浏览器内置翻译');
          // 2026-09-08 第二百四十次（日志降噪，用户批复）：删逐词成功日志（渠道见 UI）
        }
      } else {
        stepBuiltin = '返回空结果';
      }
    } else {
      stepBuiltin = 'API 不可用/未就绪';
    }
  } catch (e) {
    stepBuiltin = '异常: ' + String(e && e.message || e);
    console.warn(`[VocabRadar][translator][${_ts()}] 渠道[浏览器内置翻译] 翻译 "${word}" 失败:`, e);
  }

  // 3. 渠道 2：经 service worker 的在线渠道（MyMemory -> Google -> Youdao -> Baidu -> Bing -> Lingva）
  // 反思（2026-08-05）：service-worker.js handleTranslateText 已对每个渠道做 isUntranslated 校验，
  //   返回的成功结果必然非原文。此处仅校验非空即可。
  if (!result) {
    try {
      if (!_chOn.baidusug && !_chOn.youdaodict && !_chOn.mymemory && !_chOn.google
          && !_chOn.youdao && !_chOn.baidu && !_chOn.bing && !_chOn.lingva) {
        stepOnline = '未启用（在线渠道均未勾选）';
      } else {
        const resp = await sendMessage({
          type: 'TRANSLATE_TEXT',
          word,
          source: transState.learnLang,
          target: transState.meaningLang,
          channels: _chOn
        });
        if (resp && resp.ok && resp.text) {
          result = cleanDictEntry(resp.text.trim());
          stepOnline = '成功(渠道:' + resp.channel + ')';
          _setLastChannel('在线:' + resp.channel);
          // 2026-09-08 第二百四十次（日志降噪，用户批复）：删逐词成功日志（渠道信息
          //   已由 _setLastChannel 呈现到 UI），控制台不再逐词刷屏
        } else if (resp && resp.error) {
          stepOnline = '失败: ' + resp.error;
          // 2026-09-08 第二百四十次（修转义 bug）：旧串 \${...} 反斜杠转义致模板不插值，
          //   控制台原样打出 "${resp.error}"（用户贴的"乱码日志"即此）
          console.warn(`[VocabRadar][translator][${_ts()}] 渠道[在线翻译] 翻译 "${word}" 失败: ${resp.error}`);
        } else {
          // 反思（2026-08-13 第四十九次）：sendMessage 超时/异常返回 null 时旧版静默跳过。
          //   这正是"翻译一直没结果"的隐蔽根因之一，补日志定位。
          stepOnline = 'SW 未响应或返回空';
          console.warn(`[VocabRadar][translator][${_ts()}] 渠道[在线翻译] 翻译 "${word}" 失败: service worker 未响应或返回空`);
        }
      }
    } catch (e) {
      stepOnline = '异常: ' + String(e && e.message || e);
      console.warn(`[VocabRadar][translator][\${_ts()}] 渠道[在线翻译] 翻译 "${word}" 异常:`, e);
    }
  }
  // 4. 渠道 3：LLM 文本翻译（第二百一十六次——文本形态，直接用聊天的 LLM 配置）
  if (!result && _chOn.llm) {
    try {
      const resp = await sendMessage({ type: 'LLM_TRANSLATE', text: word, target: transState.meaningLang });
      if (resp && resp.ok && resp.text) {
        result = cleanDictEntry(resp.text.trim());
        _setLastChannel('LLM');
        // 2026-09-08 第二百四十次（日志降噪，用户批复）：删逐词成功日志（同前）
      } else {
        stepLlm = '失败: ' + String((resp && resp.error) || '空响应');
        console.warn(`[VocabRadar][translator][${_ts()}] 渠道[LLM] 翻译 "${word}" 失败:`, stepLlm);
      }
    } catch (e) {
      stepLlm = '异常: ' + String(e && e.message || e);
      console.warn(`[VocabRadar][translator][${_ts()}] 渠道[LLM] 翻译 "${word}" 异常:`, e);
    }
  }

  // 5. 写回本地缓存并返回
  if (result) {
    await setWordCached(transState.learnLang, transState.meaningLang, word, result);
    return result;
  }

  // 5. 原形回退（2026-08-06）：所有渠道都翻译失败时，尝试用词形还原原形重试
  //   用户要求"options实在查不出来,就用原形去查"。
  //   如 running->run, boxes->box, went->go。
  //   仅当 lemma 存在且与原词不同时重试，避免无限递归。
  // 反思（2026-08-17 第七十二次补充）：不再逐词调 loadDictionary()--
  //   词典仅由 startHint 一处 await loadDictionary() 加载（singleton）。
  try {
    const entry = dictLookup(word);
    const lemma = entry && entry.lemma ? entry.lemma : null;
    if (lemma && lemma.toLowerCase() !== word.toLowerCase()) {
      // 2026-09-08 第二百四十次（日志降噪，用户批复）：删原形回退三处逐词日志
      //   （回退过程/缓存命中/成功，状态已由 stepLemma 记录），控制台不再刷屏
      // 查 lemma 的缓存
      const lemmaCached = await getWordCached(transState.learnLang, transState.meaningLang, lemma);
      if (lemmaCached !== null) {
        // lemma 缓存命中，写入原词缓存并返回
        const lemmaClean = cleanDictEntry(lemmaCached);
        await setWordCached(transState.learnLang, transState.meaningLang, word, lemmaClean);
        stepLemma = '缓存命中(' + lemma + ')';
        _setLastChannel('原形回退:缓存');
        return lemmaClean;
      }
      // 用 lemma 重新走所有渠道（Translator API + 在线）
      const lemmaResult = await translateWithLemma(lemma);
      if (lemmaResult) {
        // 写入原词和 lemma 的缓存
        const lemmaClean = cleanDictEntry(lemmaResult);
        await setWordCached(transState.learnLang, transState.meaningLang, word, lemmaClean);
        await setWordCached(transState.learnLang, transState.meaningLang, lemma, lemmaClean);
        stepLemma = '渠道成功(' + lemma + ')';
        _setLastChannel('原形回退:' + (getLastTranslateChannel() || ''));
        return lemmaClean;
      }
      stepLemma = '渠道失败(' + lemma + ')';
    } else {
      stepLemma = '无原形(' + String(lemma || 'null') + ')';
    }
  } catch (e) {
    stepLemma = '异常: ' + String(e && e.message || e);
    console.warn(`[VocabRadar][translator][${_ts()}] 原形回退失败:`, e);
  }
  // 反思（2026-08-13 第四十九次）：用户要求"instantly 翻译失败的根因要查清"。
  //   返回 null 前输出各步骤汇总，一条日志定位根因（错误信息，不依赖 _debug）。
  console.warn(`[VocabRadar][translator][${_ts()}] 翻译失败根因 "${word}" -> 缓存=${stepCache} | 内置API=${stepBuiltin} | 在线=${stepOnline} | LLM=${stepLlm} | 原形回退=${stepLemma}`);
  return null;
}

/**
 * 用指定词走所有翻译渠道（Translator API + 在线），不递归原形回退
 * 供 translate 函数的原形回退逻辑调用，避免无限递归
 * @param {string} word
 * @returns {Promise<string|null>}
 */
async function translateWithLemma(word) {
  // 渠道 1：Translator API
  let result = null;
  try {
    const translator = await getTranslator();
    if (translator) {
      // 反思（2026-08-12）：lemma 翻译也加 10 秒超时
      const translated = await withTimeout(translator.translate(word), 10000, 'Translator.translate(lemma)');
      if (translated && translated.trim()) {
        const trimmed = translated.trim();
        if (transState.learnLang !== transState.meaningLang &&
            trimmed.toLowerCase() === word.trim().toLowerCase()) {
          log(`[VocabRadar][translator][${_ts()}] 渠道[浏览器内置翻译] lemma "${word}" 返回原文未翻译`);
        } else if (transState.learnLang !== transState.meaningLang && !targetScriptOk(trimmed, transState.meaningLang)) {
          log(`[VocabRadar][translator][${_ts()}] 渠道[浏览器内置翻译] lemma "${word}"->"${trimmed}" 不含目标文字`);
        } else {
          result = cleanDictEntry(trimmed);
          _setLastChannel('浏览器内置翻译');
          // 2026-09-08 第二百四十次（日志降噪，用户批复）：删逐词成功日志（同前）
        }
      }
    }
  } catch (e) {
    console.warn(`[VocabRadar][translator][${_ts()}] 渠道[浏览器内置翻译] lemma 翻译 "${word}" 失败:`, e);
  }
  // 渠道 2：在线
  if (!result) {
    try {
      const resp = await sendMessage({
        type: 'TRANSLATE_TEXT',
        word,
        source: transState.learnLang,
        target: transState.meaningLang
      });
      if (resp && resp.ok && resp.text) {
        result = cleanDictEntry(resp.text.trim());
        _setLastChannel('在线:' + resp.channel);
        // 2026-09-08 第二百四十次（日志降噪，用户批复）：删逐词成功日志（同前）
      }
    } catch (e) {
      console.warn(`[VocabRadar][translator][${_ts()}] 渠道[在线翻译] lemma 翻译 "${word}" 异常:`, e);
    }
  }
  return result;
}

// === 目录统一出口：re-export 其余原导出符号（符号名不变） ===
export { getLastTranslateChannel, getMeaningLang } from './shared.js';
// 2026-09-09 第二百四十二次：primeTranslator 手势入口 prime（th/panel.js 查词/OCR 面板用）
export { getAvailability, primeTranslator } from './builtin-translator.js';
