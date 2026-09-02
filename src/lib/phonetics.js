// VocabRadar 注音模块（phonetics）
//
// 功能：
//   给单词注音，用本语言的注音系统：
//     英语 → IPA（国际音标），如 hello → həˈloʊ
//     汉语 → Pinyin（拼音，带声调），如 你好 → nǐ hǎo
//     日文 → IPA（phonemize 日文 G2P），如 こんにちは → koɴnitiwa
//     韩文 → IPA（phonemize 韩文 G2P），如 안녕 → aɲɲʌŋ
//     其他 → IPA（phonemize 默认处理）
//
// 设计要点：
//   - 懒加载：phonemize-bundle.mjs（5.1MB）仅在首次调用时动态 import，
//     不影响页面启动性能。加载后缓存模块引用，后续调用直接使用。
//   - 结果缓存（两层）：
//     1. 内存缓存 _cache Map（同页面会话内，O(1) 命中）
//     2. 持久化缓存 chrome.storage.local（跨页面刷新，fnv1aHash 100 分桶）
//   - 语言检测：按字符 script 自动判断语言（Han→zh, Hiragana/Katakana→ja, Hangul→ko, Latin→en）。
//
// 反思（2026-08-05）：
//   用户要求"使用 phonemize 给单词注音，用本语言注音，英语用国际音标，
//   汉语用拼音，日文用片假名，韩语用谚文等。用在单词详细注释的时候"。
//   phonemize 对所有语言输出 IPA，但汉语用户要求拼音（非 IPA），
//   故汉语走 pinyin-pro 直接输出拼音，其他语言走 phonemize IPA。
//   日文片假名、韩文谚文需专用 G2P 库（kuroshiro 等），暂以 IPA 兜底。
//
// 反思（2026-08-09 第十次）：用户反馈"音标看见了很多请求，你没有缓存吗？"。
//   根因：旧版仅有内存缓存 _cache Map，页面刷新后丢失，每次刷新都要重新
//   加载 5.1MB bundle 并重新计算每个词的音标。
//   修正：新增持久化缓存（chrome.storage.local + fnv1aHash 100 分桶），
//   与 word-cache.js 同方案。首次计算后写入持久化缓存，后续（含页面刷新）
//   直接读取，无需重新加载 bundle 和计算。

// === 模块状态 ===
let _bundle = null;       // phonemize-bundle 模块引用（懒加载）
let _loading = null;      // 加载 Promise（防止重复加载）
let _loadFailed = 0;      // 加载失败时间戳（0=未失败，>0=失败时间，5秒内不重试）
const _cache = new Map(); // word(lower) → phonetic string（内存缓存，同会话内）

// 反思（2026-08-11 第二十七次）：统一词典存储
//   旧版 pc_* chrome.storage 分桶缓存已移除，音标改存统一 IDB phonetic 字段。
//   phonetic 仅依赖源语言（lang），不依赖目标语言，故无需 translationLang 类校验。
//   key=lang|word，与 rank/lemma/tags/translation 同记录，一次读取得全部属性。
import { getWord, updateFields } from './word-db.js';

/**
 * 从统一词典读取音标
 * @param {string} lang 语言码
 * @param {string} word 小写单词
 * @returns {Promise<string|null>} 音标或 null（未注音/读取失败）
 */
async function getCachedPhonetic(lang, word) {
  try {
    const record = await getWord(lang, word);
    if (!record || record.phonetic === undefined || record.phonetic === null) return null;
    return record.phonetic;
  } catch (e) {
    return null;
  }
}

/**
 * 写入音标到统一词典
 * @param {string} lang 语言码
 * @param {string} word 小写单词
 * @param {string} phonetic 音标
 * @returns {Promise<void>}
 */
async function setCachedPhonetic(lang, word, phonetic) {
  try {
    await updateFields(lang, word, { phonetic });
  } catch (e) { /* 写入失败不阻塞 */ }
}

/**
 * 检测文本的语言（按字符 script）
 * @param {string} text
 * @returns {string} 语言码：'zh'/'ja'/'ko'/'en'
 */
function detectLanguage(text) {
  if (!text) return 'en';
  // 汉字（CJK Unified Ideographs）
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  // 日文假名（平假名 + 片假名）
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return 'ja';
  // 韩文谚文
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  // 默认英语（Latin 等其他文字）
  return 'en';
}

/**
 * 懒加载 phonemize-bundle.mjs
 * 反思：bundle 5.1MB，首次加载需 1-2 秒。加载后缓存，后续调用直接使用。
 * @returns {Promise<object>} phonemize 模块
 */
async function ensureBundle() {
  if (_bundle) return _bundle;
  if (_loading) return _loading;
  _loading = (async () => {
    const url = chrome.runtime.getURL('src/lib/vendor/phonemize-bundle.mjs');
    console.log('[VocabRadar][phonetics] 开始加载 bundle:', url);
    _bundle = await import(url);
    console.log('[VocabRadar][phonetics] bundle 加载成功，导出:', Object.keys(_bundle),
      'phonetizeWord:', typeof _bundle.phonetizeWord);
    return _bundle;
  })();
  return _loading;
}

/**
 * 给单词注音（异步，懒加载 bundle）
 *
 * 缓存策略（两层）：
 *   1. 内存缓存 _cache Map（同会话内 O(1)）
 *   2. 持久化缓存 chrome.storage.local（跨页面刷新）
 *   都未命中时加载 bundle 计算，结果同时写入两层缓存。
 *
 * @param {string} word 单词
 * @param {string} [lang] 语言码（可选，不传则自动检测）
 * @returns {Promise<string>} 注音字符串，失败返回空串
 * 反思（2026-08-05 修正）：用户反馈"没看到音标"。
 *   根因1：bundle 加载失败时缓存空结果，后续调用命中缓存返回空串，不重试。
 *   根因2：bundle 首次加载 5.1MB 需 1-2 秒，期间 fillPhoneticAsync 的 line 可能被重绘移除。
 *   修正：1) 仅缓存非空结果（空结果不缓存，允许后续重试）；
 *         2) 新增 _loadFailed 标志，加载失败时标记，避免重复尝试加载（5秒内）；
 *         3) 新增 console.log 日志，便于诊断。
 * 反思（2026-08-09 第十次）：用户反馈"音标看见了很多请求，你没有缓存吗？"。
 *   修正：新增持久化缓存（chrome.storage.local + fnv1aHash 100 分桶），
 *   内存缓存未命中时先查持久化缓存，命中则直接返回（无需加载 bundle）。
 *   持久化缓存未命中时才加载 bundle 计算，结果同时写入两层缓存。
 */
export async function getPhonetic(word, lang) {
  if (!word) return '';
  const text = String(word).trim();
  if (!text) return '';
  const language = lang || detectLanguage(text);
  const wordLower = text.toLowerCase();
  const cacheKey = language + ':' + wordLower;

  // 1. 内存缓存命中
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  // 2. 持久化缓存命中（无需加载 bundle）
  const persisted = await getCachedPhonetic(language, wordLower);
  if (persisted) {
    // 回填内存缓存
    _cache.set(cacheKey, persisted);
    return persisted;
  }

  // 3. bundle 加载失败标记（5秒内不重试，避免频繁加载失败阻塞）
  if (_loadFailed && Date.now() - _loadFailed < 5000) return '';

  // 4. 加载 bundle 并计算
  let result = '';
  try {
    const mod = await ensureBundle();
    if (!mod || typeof mod.phonetizeWord !== 'function') {
      console.warn('[VocabRadar][phonetics] bundle 加载成功但 phonetizeWord 不可用');
      _loadFailed = Date.now();
      return '';
    }
    result = mod.phonetizeWord(text, language) || '';
  } catch (e) {
    console.warn('[VocabRadar][phonetics] 注音失败:', text, e);
    _loadFailed = Date.now();
    return '';  // 失败不缓存，允许后续重试
  }

  // 仅缓存非空结果（空结果可能是临时失败，允许后续重试）
  if (result) {
    // 写入内存缓存
    _cache.set(cacheKey, result);
    // 写入持久化缓存（异步，不阻塞返回）
    setCachedPhonetic(language, wordLower, result).catch(() => { /* ignore */ });
  }
  return result;
}

/**
 * 批量注音（并行，结果按原顺序返回）
 * @param {string[]} words 单词数组
 * @param {string} [lang] 语言码
 * @returns {Promise<string[]>} 注音数组
 */
export async function getPhoneticsBatch(words, lang) {
  if (!words || words.length === 0) return [];
  return Promise.all(words.map((w) => getPhonetic(w, lang)));
}

/** 清空音标内存缓存（语言切换时调用） */
export function clearPhoneticsCache() {
  _cache.clear();
}
