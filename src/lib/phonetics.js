// VocabRadar 注音模块（phonetics）
//
// 功能：给单词注音。输出体系按语言分三档（2026-09-04 第一、二梯队落地，ja 片假名随后补齐）：
//     英语/俄文/西/法/葡/瑞典 → IPA（如 hello → həˈɫoʊ，bonjour → bɔ̃ʒuʁ）
//     汉语 → 拼音（如 你好 → nǐ hǎo，pinyin-pro tone symbol）
//     韩文 → 罗马字（如 안녕하세요 → annyeonghaseyo，koroman 国立国语院标准）
//     日文 → 片假名（如 日本語 → ニホンゴ，kuroshiro＋kuromoji 形态分析）
//
// 设计要点：
//   - 只管目标语言（2026-09-04）：注音语种一律取用户设定的 learnLanguage，
//     调用方 getPhonetic(word) 不再按字形自动检测。「语言之外不管」——目标语
//     之外的词不注音，未覆盖语种直接返回空串（不再回退英语规则，避免误导性错读）。
//   - 按语言懒加载：一种语言一个包（scripts/build-phonemize.mjs 的 esbuild 多入口
//     产物，src/lib/vendor/phonemize/phonemize-<lang>.mjs），用到哪国语言才加载哪国
//     的包。单文件最大 en 3.79MB < 5MB（AMO addons-linter 上限）；共享 chunk
//     由浏览器按 import 依赖自动拉取，无需显式管理。
//   - 各包统一暴露 default.toIPA(text, opts)：phonemize 系是 createPhonemizer 实例
//     方法（ko/ru 原生文字必须显式开 anyAscii 才经音译表转拉丁，见下"关键坑"）；
//     zh/ko/es/fr/pt/sv 是本站自写包装（pinyin-pro / koroman / piper-plus G2P），
//     忽略 opts 参数。法语 PUA 鼻化元音在 fr 入口内已解回标准 IPA。
//   - 关键坑（实测定位）：phonemize@2.0.0 的 ko/ru G2P 规则只吃拉丁转写
//     （romaja/西里尔转写），原生谚文/西里尔输入必须显式传 anyAscii: true 才经
//     anyascii.json 转写为拉丁（官方 README pipeline 第 2 步 "if enabled"，默认关闭）；
//     不开则谚文/西里尔原样透传。en/ja 开启后行为不变，故 phonemize 系统一传 true。
//     注：zh/ko 现走 pinyin-pro/koroman，不再经过此路径（PHONEMIZE_OPTS 照传，包装忽略）。
//   - 结果缓存（三层含义，两层存储）：
//     1. 内存缓存 _cache Map（同页面会话内，O(1) 命中，键=lang:word）
//     2. 持久化缓存统一词典 IDB phonetic 字段（跨页面刷新，key=lang|word）
//     3. 引擎版本 phoneticV：zh 切拼音、ko 切罗马字（2026-09-04）后旧 IPA 缓存
//        失效，记录无 phoneticV 或版本不对即判 miss 重算并覆写，避免旧读音阴魂不散。
//   - 空结果永不缓存（加载失败/未覆盖语种允许后续重试）。
//
// 反思（2026-08-05）：
//   用户要求"使用 phonemize 给单词注音，用本语言注音，英语用国际音标，
//   汉语用拼音，日文用片假名，韩语用谚文等。用在单词详细注释的时候"。
//   第一、二梯队落地后：en IPA、zh 拼音、ko 罗马字、ja 片假名已对齐
//   （ja 用 kuroshiro＋kuromoji，词典 17MB 走 CDN 经 SW 中转，见 scripts/phonemize-src/ja.mjs）。
//
// 反思（2026-08-09 第十次）：用户反馈"音标看见了很多请求，你没有缓存吗？"。
//   根因：旧版仅有内存缓存 _cache Map，页面刷新后丢失，每次刷新都要重新
//   加载 bundle 并重新计算每个词的音标。
//   修正：新增持久化缓存（与 word-cache.js 同方案），首次计算后写入持久化缓存，
//   后续（含页面刷新）直接读取，无需重新加载语言包和计算。
//
// 反思（2026-08-11 第二十七次）：统一词典存储
//   旧版 pc_* chrome.storage 分桶缓存已移除，音标改存统一 IDB phonetic 字段。
//   phonetic 仅依赖源语言（lang），不依赖目标语言，故无需 translationLang 类校验。
//
// 反思（2026-09-04 第二百三十二次）：用户否定 gzip 单包方向（"在错误道路上修修补补"），
//   调研定案方案 B 按语言拆包（docs/多语言注音方案调研.md）。本版改动见文件内各函数注释。
//
// 反思（2026-09-04 第一、二梯队落地）：用户拍板三点——①只管目标语言（learnLanguage
//   之外不管）；②实现第一、二梯队（es/fr/pt/sv 新增，zh 改拼音，ko 改罗马字，
//   详见 docs/各语言注音npm包调研.md §4.1-4.2）；③注音有结果才显示（无结果隐藏，
//   显示层改动在各调用方 CSS/JS，本文件只保证"无结果返回空串"）。
//   换引擎备案：zh/ko 注音结果与旧版不同（用户已接受）；旧 IDB 缓存靠 phoneticV=2 自然失效。

// === 模块状态 ===
const _bundles = {};        // lang → 注音实例（按语言懒加载后缓存，统一有 toIPA 方法）
const _loading = {};        // lang → 加载 Promise（防同语言重复加载）
const _loadFailed = {};     // lang → 加载失败时间戳（0/undefined=未失败；失败 5 秒内不重试）
const _cache = new Map();   // cacheKey = lang:word(lower) → phonetic string（内存缓存，同会话内）

// 注音引擎版本（2026-09-04 首版为 2，ja 切片假名后 bump 为 3）：
// zh 切拼音、ko 切罗马字、ja 切片假名，旧 IPA 缓存必须失效。
// 规则：IDB 记录的 phoneticV 与此不一致即判 miss 重算；下次换引擎时 bump 此数字即可。
const PHONETIC_ENGINE_V = 3;

// 目标语言缓存（2026-09-04"只管目标语言"）：模块加载即读一次 storage，之后靠监听跟随。
// 与 ws/core.js 的 _cachedLearnLang 同模式；读不到（非扩展上下文单测等）时默认 'en'。
let _learnLang = 'en';
try {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({ learnLanguage: 'en' }, (res) => {
      if (res && typeof res.learnLanguage === 'string' && res.learnLanguage) {
        _learnLang = res.learnLanguage;
      }
    });
    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.learnLanguage && typeof changes.learnLanguage.newValue === 'string') {
          _learnLang = changes.learnLanguage.newValue || 'en';
          console.log('[VocabRadar][phonetics] 目标语言切换:', _learnLang);
        }
      });
    }
  }
} catch (_) { /* storage 不可用时保持默认 en */ }

// 语言 → 语言包文件（scripts/build-phonemize.mjs 产物）。
// 2026-09-04：chunk 零碎统一为 core——共享引擎定名 core.mjs（无 hash，仅 en/ru
// 引用），语言包以相对路径 import './core.mjs'，浏览器自动连带拉取。
// 新增语言：在此登记 + scripts/phonemize-src/ 加入口 + build-phonemize.mjs languages 数组同步。
// 未登记的语种（第三梯队及以后）走"返回空串"（不回退英语，避免误导性错读）。
const LANG_BUNDLES = {
  en: 'phonemize-en.mjs', // 2757KB：phonemize 英语规则+例外词典（体积大头，另有共享 core.mjs 861KB）
  zh: 'phonemize-zh.mjs', // 295KB：pinyin-pro 直接输出拼音（2026-09-04 由 IPA 改道；utf8 输出由 448KB 降至此）
  ja: 'phonemize-ja.mjs', // 86KB：kuroshiro＋kuromoji 输出片假名（词典 17MB 走 CDN，经 SW KURO_FETCH 中转）
  ko: 'phonemize-ko.mjs', // 7KB：koroman 国立国语院标准输出罗马字（2026-09-04 由 IPA 改道）
  ru: 'phonemize-ru.mjs', // 4KB：phonemize 拉丁转写→IPA 规则（西里尔经 anyAscii 转写进入；引用 core.mjs）
  es: 'phonemize-es.mjs', // 10KB：piper-plus SpanishG2P 规则式（拉美口音 seseo）
  fr: 'phonemize-fr.mjs', // 10KB：piper-plus FrenchG2P 规则式（鼻化元音已解回 IPA）
  pt: 'phonemize-pt.mjs', // 9KB：piper-plus PortugueseG2P（巴西口音，与 pt_BR 对齐）
  sv: 'phonemize-sv.mjs', // 10KB：piper-plus SwedishG2P 规则式
};

// phonemize 系全语言统一选项：anyAscii 转写必须显式开启（见头注释"关键坑"）。
// 自写包装（zh/ko/es/fr/pt/sv）忽略第二个参数，无影响。
const PHONEMIZE_OPTS = { anyAscii: true };

// 反思（2026-08-11 第二十七次）：统一词典存储
import { getWord, updateFields } from './word-db.js';

/**
 * 从统一词典读取音标（命中条件：phonetic 非空且引擎版本一致）
 * @param {string} lang 语言码
 * @param {string} word 小写单词
 * @returns {Promise<string|null>} 音标或 null（未注音/版本过期/读取失败）
 */
async function getCachedPhonetic(lang, word) {
  try {
    const record = await getWord(lang, word);
    if (!record || record.phonetic === undefined || record.phonetic === null) return null;
    // 反思（2026-09-04）：引擎版本不对即判 miss（zh/ko 换引擎后旧 IPA 缓存自动失效重算）
    if (record.phoneticV !== PHONETIC_ENGINE_V) return null;
    return record.phonetic;
  } catch (e) {
    return null;
  }
}

/**
 * 写入音标到统一词典（连带引擎版本，供下次命中校验）
 * @param {string} lang 语言码
 * @param {string} word 小写单词
 * @param {string} phonetic 音标
 * @returns {Promise<void>}
 */
async function setCachedPhonetic(lang, word, phonetic) {
  try {
    await updateFields(lang, word, { phonetic, phoneticV: PHONETIC_ENGINE_V });
  } catch (e) { /* 写入失败不阻塞 */ }
}

/**
 * 懒加载指定语言的语言包
 *
 * 产物由 scripts/build-phonemize.mjs（esbuild 多入口）生成：每语言一个
 * ESM，default 导出含 toIPA 方法的注音实例。加载后缓存实例，后续同语言调用
 * 直接复用；en/ru 引用的共享 core.mjs 由浏览器按相对路径连带拉取。
 *
 * @param {string} lang 语言码（必须在 LANG_BUNDLES 内，调用方已守卫）
 * @returns {Promise<object>} 含 toIPA 方法的注音实例
 */
async function ensureBundle(lang) {
  if (_bundles[lang]) return _bundles[lang];
  if (_loading[lang]) return _loading[lang];
  const url = chrome.runtime.getURL('src/lib/vendor/phonemize/' + LANG_BUNDLES[lang]);
  console.log('[VocabRadar][phonetics] 懒加载语言包:', url);
  const p = (async () => {
    try {
      const mod = await import(url);
      const inst = mod.default;
      if (!inst || typeof inst.toIPA !== 'function') {
        throw new Error('语言包 ' + lang + ' 缺少 toIPA 导出（default 应为含 toIPA 的注音实例）');
      }
      _bundles[lang] = inst;
      return inst;
    } catch (e) {
      console.warn('[VocabRadar][phonetics] 语言包加载失败:', lang, e);
      _loading[lang] = null; // 失败置回 null，允许 _loadFailed 5 秒到期后真正重试
      throw e;
    }
  })();
  _loading[lang] = p;
  return p;
}

/**
 * 给单词注音（异步，按目标语言懒加载语言包）
 *
 * 语种规则（2026-09-04"只管目标语言"）：lang 参数不传时取 learnLanguage；
 * 目标语之外不管——detectLanguage 按字形自动检测已删除（曾导致拉丁系全判 en，
 * 且与"只管目标语言"相悖）；LANG_BUNDLES 未登记的语种直接返回空串。
 *
 * 缓存策略（两层存储＋版本校验）：
 *   1. 内存缓存 _cache Map（同会话内 O(1)）
 *   2. 持久化缓存统一词典 IDB phonetic 字段（跨页面刷新，phoneticV 必须一致）
 *   都未命中时加载对应语言包计算，结果同时写入两层缓存。
 *
 * @param {string} word 单词
 * @param {string} [lang] 语言码（可选，不传则用 learnLanguage）
 * @param {string} [context] 所在整句（可选；目前仅 ja 用——汉字读音依赖上下文，
 *   有 context 走句 parse 取 token 读法，无则单查；其它语言忽略此参数）
 * @returns {Promise<string>} 注音字符串，失败/未覆盖返回空串（调用方隐藏显示）
 * 反思（2026-08-05 修正）：用户反馈"没看到音标"。
 *   根因1：加载失败时缓存空结果，后续调用命中缓存返回空串，不重试。
 *   根因2：首次加载大包需 1-2 秒，期间 fillPhoneticAsync 的 line 可能被重绘移除。
 *   修正：1) 仅缓存非空结果（空结果不缓存，允许后续重试）；
 *         2) _loadFailed 标记避免 5 秒内重复尝试加载；
 *         3) console 日志便于诊断。
 * 反思（2026-08-09 第十次）：新增持久化缓存（见 getPhonetics 头注释）。
 * 反思（2026-09-04 第二百三十二次）：换 2.0.0 按语言包 + toIPA({anyAscii:true})。
 * 反思（2026-09-04 第一、二梯队落地）：只管目标语言＋9 语＋phoneticV 版本校验。
 * 反思（2026-09-04 日文上下文注音）：ja＋context 的结果与句子绑定，不进 IDB
 *   （IDB 键只有 lang|word，会毒化其它句子的同形词）；只走内存缓存，且缓存键带
 *   context 简易哈希。同形多读音取首个命中，属近似。
 */
export async function getPhonetic(word, lang, context) {
  if (!word) return '';
  const text = String(word).trim();
  if (!text) return '';
  const language = lang || _learnLang || 'en';
  // 未覆盖语种直接回空（不回退英语——按英语规则读别国词只会产生错误信息）
  if (!LANG_BUNDLES[language]) return '';
  const ctx = (language === 'ja' && typeof context === 'string' && context.trim()) ? context.trim() : '';
  const wordLower = text.toLowerCase();
  const cacheKey = language + ':' + wordLower + (ctx ? '#' + _strHash(ctx) : '');

  // 1. 内存缓存命中
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  // 2. 持久化缓存命中（无需加载语言包；版本不对视为未命中；ja 上下文结果跳过此层）
  let persisted = null;
  if (!ctx) {
    persisted = await getCachedPhonetic(language, wordLower);
  }
  if (persisted) {
    // 回填内存缓存
    _cache.set(cacheKey, persisted);
    return persisted;
  }

  // 3. 该语言包加载失败标记（5秒内不重试，避免反复加载失败阻塞）
  if (_loadFailed[language] && Date.now() - _loadFailed[language] < 5000) return '';

  // 4. 加载语言包并计算（ja 包的 toIPA 是异步的 kuroshiro.convert，此处统一 await；
  //    context 透传给语言包，非 ja 包忽略该字段）
  let result = '';
  try {
    const inst = await ensureBundle(language);
    result = ((await inst.toIPA(text, ctx ? Object.assign({}, PHONEMIZE_OPTS, { context: ctx }) : PHONEMIZE_OPTS)) || '').trim();
  } catch (e) {
    console.warn('[VocabRadar][phonetics] 注音失败:', text, e);
    _loadFailed[language] = Date.now();
    return '';  // 失败不缓存，允许后续重试
  }

  // 仅缓存非空结果（空结果可能是临时失败，允许后续重试）
  if (result) {
    // 写入内存缓存
    _cache.set(cacheKey, result);
    // 写入持久化缓存（异步，不阻塞返回；ja 上下文结果不写 IDB，防毒化同形词）
    if (!ctx) setCachedPhonetic(language, wordLower, result).catch(() => { /* ignore */ });
  }
  return result;
}

/**
 * 字符串简易哈希（djb2，hex）——ja 上下文内存缓存键用，防长句键膨胀
 * @param {string} s 输入
 * @returns {string} 8 位 hex
 */
function _strHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

/**
 * 批量注音（并行，结果按原顺序返回）
 * @param {string[]} words 单词数组
 * @param {string} [lang] 语言码（不传则用 learnLanguage）
 * @returns {Promise<string[]>} 注音数组
 */
export async function getPhoneticsBatch(words, lang) {
  if (!words || words.length === 0) return [];
  return Promise.all(words.map((w) => getPhonetic(w, lang)));
}

/** 清空音标内存缓存（语言切换时调用；语言包实例不复位，加载一次终身复用） */
export function clearPhoneticsCache() {
  _cache.clear();
}
