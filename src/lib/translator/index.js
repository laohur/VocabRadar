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
// 第447次（用户裁定）：新增 backend 渠道——勾选后经后端翻译路由 POST /api/translate
//   （对话行所选后端组来源的地址/Key，非 /v1/chat/completions 大模型路由）；默认不选。
// 第460次（用户裁定）：-lingva（公共实例不稳定已摘除）；+reverso（默认启用）；mymemory 默认不选
//   （质量差且 5000 字符/天限流，仅末位手工兜底）。
// 第461次（用户裁定「撤销需要 key 的翻译接口」）：-deepl/-mstrans（渠道与 Key 全删）。
const DEFAULT_TRANS_CHANNELS = { llm: false, backend: false, builtin: true, baidusug: true, youdaodict: true, reverso: true, mymemory: false, google: true, youdao: true, baidu: true, bing: true };
// 当前勾选状态整表（发 SW 的 channels 形参；单渠道判定即 out[id]）。
// 第二百一十九次：LLM 缺省不选，其余缺省启用。第447次：backend 同为缺省不选——
//   storage 里的旧表没有 backend 键，必须与缺省表合并后再判
//   （直接拿旧表判 `!== false` 会让未升级用户默认全开）。
// 第447次·修正历史瑕疵：原形回退 translateWithLemma 此前不传 channels——SW 的 chGate
//   缺省全开，用户取消勾选的渠道在回退路径照样被调，本次补传，backend 缺省不选同受其约束。
function curTransChannels() {
  const st = Object.assign({}, DEFAULT_TRANS_CHANNELS, _transChannels || {});
  const out = {};
  for (const k of Object.keys(st)) out[k] = st[k] !== false;
  return out;
}

/**
 * 从统一词典读取翻译缓存
 * 反思（2026-08-12）：替代 word-cache.js 的 getWordCached。
 *   word-db.js 按 lang|word_lower 主键存储，translation 字段缓存译文，translationLang 校验语言对。
 * 反思（2026-09-27）：补 targetScriptOk 文字系统校验——旧版渠道缺陷曾把中文释义写成
 *   任意 translationLang（存量脏缓存），仅语言对校验拦不住；校验不过视为无缓存，
 *   走在线重翻后以正确语言覆盖写回，存量自动修复。
 * @param {string} src 源语言
 * @param {string} tgt 目标语言
 * @param {string} word 小写单词
 * @returns {Promise<string|null>} 译文或 null
 */
async function getWordCached(src, tgt, word) {
  try {
    const record = await dbGetWord(src, word);
    if (record && record.translation && record.translationLang === tgt && targetScriptOk(record.translation, tgt)) {
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

// 第461次（用户裁定「视频网站先处理视频侧栏，其次网页正文；悬停/查词仍最前」）：
//   原二档队列升四档——3=交互（网页/侧栏悬停、查词面板：用户正盯着等的单个词）→
//   2=视频侧栏/字幕层批量（vs/subtitle-renderer、subtitle-overlay）→ 1=网页正文批量
//   （ws/scanner、th/scan）→ 0=其他（引导页预览/OCR）。档内仍串行（同词去重、
//   单任务 45s 上限不变，用户裁定渠道分发保持串行）。布尔兼容：旧调用点 true→3、
//   false/缺省→0（未改到的调用点不回退，仍是"高/最低"两极语义）。常量对外导出，
//   调用方（vs/subtitle-renderer、subtitle-overlay、ws/scanner、th/scan）按档传值。
export const PRIO_INTERACT = 3, PRIO_VIDEO = 2, PRIO_WEB = 1, PRIO_LOW = 0;
const _prioQueues = [[], [], [], []];  // 下标=档位；_processQueue 高档先出
let _queueProcessing = false;

/** priority 归一到档位：true→3，false/null→0，数值夹取 0..3（向下取整） */
function _prioLevel(priority) {
  if (priority === true) return PRIO_INTERACT;
  if (priority === false || priority == null) return PRIO_LOW;
  const n = Number(priority);
  if (!isFinite(n)) return PRIO_LOW;
  return Math.max(PRIO_LOW, Math.min(PRIO_INTERACT, Math.floor(n)));
}

/**
 * 翻译单词（带本地缓存 + 多渠道兜底）
 *
 * 纯翻译函数：给单词返回译文，不包含任何开关门控。
 * 是否需要翻译由调用方决定（如"注释生僻词"开关控制是否收集表外词到生词表）。
 *
 * 反思（2026-08-09）：添加 priority 参数，页面生词优先于 ASR/OCR 生词。
 * 第461次：priority 升为档位（见上方 PRIO_* 常量），布尔仍兼容。
 *
 * @param {string} word 待翻译的单词
 * @param {boolean|number} [priority=false] 优先级档：true/3=交互（悬停/查词），
 *   2=视频侧栏批量，1=网页正文批量，false/0=其他
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

  // 优先级队列（第461次起四档，高档先出）
  const level = _prioLevel(priority);
  const promise = new Promise((resolve) => {
    _prioQueues[level].push({ word: normalizedWord, resolve });
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
 * 处理队列：按档位从高到低取任务，串行执行
 */
async function _processQueue() {
  if (_queueProcessing) return;
  _queueProcessing = true;
  try {
    for (;;) {
      let task = null;
      for (let lv = PRIO_INTERACT; lv >= PRIO_LOW; lv--) {
        if (_prioQueues[lv].length) { task = _prioQueues[lv].shift(); break; }
      }
      if (!task) break;
      try {
        // 第三百七十五次：单任务加总超时——诊断实测单个黑洞词（TCP 挂起类无 signal 源，
        //   各渠道超时叠加＋原形回退）可拖 112~126s，串行队列队头一卡全队列陪葬，
        //   侧栏 5540 行低优先级直接饿死。45s 仍未回则判失败让位（正常慢词：内置 10s＋在线数秒，远到不了 45s）。
        const result = await withTimeout(_translateInternal(task.word), 45000, 'translate:' + task.word);
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
  const _chOn = curTransChannels();
  // 第460次（同形词跨渠道共识）：浏览器内置给出的同形结果不再直接丢——暂存于此，
  //   随 TRANSLATE_TEXT 下传 SW 作先验票（content 侧与 SW 里再凑 1 票即采纳）。
  let builtinPrior = null;
  // 第461次（用户裁定「若有缺口必然调用浏览器内置」）：内置被拒结果（同形/文字系统
  //   不符）暂存到 .text，在线/LLM/原形全败时回收兜底（见函数尾「缺口兜底」块）。
  const builtinFb = { text: null };
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
          stepBuiltin = '返回原文未翻译(记先验票待印证)';
          builtinPrior = { text: trimmed, channel: '浏览器内置' };
          builtinFb.text = trimmed;   // 第461次：同形结果兜底候选（在线全败时回收）
          log(`[VocabRadar][translator][${_ts()}] 渠道[浏览器内置翻译] "${word}" 返回原文，记先验票转在线渠道共识`);
        } else if (transState.learnLang !== transState.meaningLang && !targetScriptOk(trimmed, transState.meaningLang)) {
          stepBuiltin = '译文不含目标语言(' + transState.meaningLang + ')文字';
          builtinFb.text = trimmed;   // 第461次：文字系统不符结果兜底候选（缺口时回收，不写缓存）
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

  // 3. 渠道 2：经 service worker 的在线渠道（第461次序：backend -> 词典快渠道 ->
  //   Reverso -> Bing -> Google -> Youdao -> Baidu -> MyMemory）
  // 第447次：backend 为 SW 内渠道0（POST /api/translate 后端翻译路由），排在最前；
  //   勾了 backend 时即便免费渠道全关，本消息仍须发出
  // 第461次：下方"全关"判定随 CHANNEL_TABLE 增删（-lingva -deepl -mstrans +reverso）
  // 反思（2026-08-05）：service-worker.js handleTranslateText 已对每个渠道做 isUntranslated 校验，
  //   返回的成功结果必然非原文。此处仅校验非空即可。
  if (!result) {
    try {
      if (!_chOn.backend && !_chOn.baidusug && !_chOn.youdaodict
          && !_chOn.reverso && !_chOn.mymemory && !_chOn.google
          && !_chOn.youdao && !_chOn.baidu && !_chOn.bing) {
        stepOnline = '未启用（在线渠道均未勾选）';
      } else {
        const resp = await sendMessage({
          type: 'TRANSLATE_TEXT',
          word,
          source: transState.learnLang,
          target: transState.meaningLang,
          channels: _chOn,
          prior: builtinPrior   // 第460次：builtin 同形先验票（SW 计入跨渠道共识）
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
      // 用 lemma 重新走所有渠道（Translator API + 在线）；第461次：传 builtinFb 收集
      //   lemma 自己被拒的内置结果（原词与 lemma 的候选都留作缺口兜底）
      const lemmaResult = await translateWithLemma(lemma, builtinFb);
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

  // 6. 缺口兜底（第461次，用户裁定「若有缺口必然调用浏览器内置」——内置本地推理、
  //   无网络配额，可充分优先利用）：在线/LLM/原形全败后，内置若曾产出非空结果
  //   （同形或文字系统不符被拒、存于 builtinFb.text）直接回收；若一次都没产出
  //   （当时未就绪/超时），此处必然再调一次（本地、无第三方限流；Firefox 无
  //   Translator API 则 getTranslator 为空，兜底同样为空——浏览器限制，无法承诺必然成功）。
  //   采纳结果标注'浏览器内置(兜底)'；文字系统不合格的兜底结果只本次返回、不写缓存
  //   （防错误脚本译文驻留词典被反复读出），合格则照常回写。
  if (!result && _chOn.builtin) {
    try {
      let cand = builtinFb.text;
      if (!cand) {
        const tr = await getTranslator();
        if (tr) {
          const t2 = await withTimeout(tr.translate(word), 10000, 'Translator.translate(fallback)');
          if (t2 && t2.trim()) cand = t2.trim();
        }
      }
      if (cand) {
        result = cleanDictEntry(cand);
        _setLastChannel('浏览器内置(兜底)');
        log(`[VocabRadar][translator][${_ts()}] 缺口兜底：采纳内置译文 "${word}"->"${result}"`);
        if (targetScriptOk(result, transState.meaningLang)) {
          await setWordCached(transState.learnLang, transState.meaningLang, word, result);
        }
        return result;
      }
    } catch (e) {
      console.warn(`[VocabRadar][translator][${_ts()}] 缺口兜底（内置）失败:`, e);
    }
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
 * @param {{text:string|null}} [fb] 第461次：缺口兜底候选收集器——lemma 被拒的内置
 *   结果写入 fb.text（仅首个非空候选，调用方在线全败时回收）
 * @returns {Promise<string|null>}
 */
async function translateWithLemma(word, fb) {
  // 渠道 1：Translator API
  let result = null;
  let lemmaPrior = null;   // 第460次：lemma 的 builtin 同形先验票（随消息下传 SW）
  try {
    const translator = await getTranslator();
    if (translator) {
      // 反思（2026-08-12）：lemma 翻译也加 10 秒超时
      const translated = await withTimeout(translator.translate(word), 10000, 'Translator.translate(lemma)');
      if (translated && translated.trim()) {
        const trimmed = translated.trim();
        if (transState.learnLang !== transState.meaningLang &&
            trimmed.toLowerCase() === word.trim().toLowerCase()) {
          lemmaPrior = { text: trimmed, channel: '浏览器内置' };
          if (fb && !fb.text) fb.text = trimmed;   // 第461次：缺口兜底候选
          log(`[VocabRadar][translator][${_ts()}] 渠道[浏览器内置翻译] lemma "${word}" 返回原文，记先验票待印证`);
        } else if (transState.learnLang !== transState.meaningLang && !targetScriptOk(trimmed, transState.meaningLang)) {
          if (fb && !fb.text) fb.text = trimmed;   // 第461次：缺口兜底候选
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
        target: transState.meaningLang,
        channels: curTransChannels(),   // 第447次：补传勾选状态（此前不传=SW 全渠道缺省开）
        prior: lemmaPrior               // 第460次：builtin 同形先验票
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
// 2026-09-27：targetScriptOk 缓存读侧文字系统校验（annotator.js 经门面取用）
export { getAvailability, primeTranslator, targetScriptOk } from './builtin-translator.js';
