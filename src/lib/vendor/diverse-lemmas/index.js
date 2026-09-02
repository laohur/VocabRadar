/**
 * @hg0428/diverse-lemmas
 * 
 * Offline multilingual lemmatization for browser and Node.js
 * 50+ languages, on-demand downloads, local caching
 * 
 * @example
 * ```js
 * import { loadLanguage, lemmatize, LANGUAGES } from '@hg0428/diverse-lemmas';
 * 
 * // Load a language (downloads and caches if needed)
 * const es = await loadLanguage('es');
 * 
 * // Lemmatize
 * es.lemmatizeWord('hablando');  // { lemmas: ['hablar'], method: 'direct' }
 * es.lemmatizeText('Los niños van');  // [{ word: 'Los', lemmas: ['el'], ... }, ...]
 * 
 * // Check what's cached
 * const cached = await getCachedLanguages();
 * ```
 */

// 反思（2026-08-02 修复上游 bug）：
//   原版用 `export { X } from './y.js'` re-export，但下方 `export default { X, ... }`
//   引用了这些 re-export 的标识符。re-export 的标识符不在当前模块作用域，
//   导致 default export 求值时 ReferenceError: getSupportedLanguages is not defined。
//   修复：改为 import + export，使标识符在本地作用域可用。
import { LANGUAGES, getSupportedLanguages, isLanguageSupported, getLanguageInfo, getLargeLanguages } from './languages.js';
import { storage } from './storage.js';
import { downloadLanguage, downloadLanguages, isLanguageCached, getCachedLanguages, removeLanguage, clearCache, getCacheInfo, setCDN, getCDN } from './downloader.js';
import { createLemmatizer } from './lemmatizer.js';

export { LANGUAGES, getSupportedLanguages, isLanguageSupported, getLanguageInfo, getLargeLanguages };
export { storage };
export { downloadLanguage, downloadLanguages, isLanguageCached, getCachedLanguages, removeLanguage, clearCache, getCacheInfo, setCDN, getCDN };
export { createLemmatizer };

// Cache of loaded lemmatizers (in-memory)
const loadedLemmatizers = new Map();

/**
 * Load a language lemmatizer
 * Downloads and caches if not already cached
 * 
 * @param {string} lang - Language code (e.g., 'en', 'es', 'he')
 * @param {object} options - Options
 * @param {boolean} options.force - Force re-download even if cached
 * @param {function} options.onProgress - Progress callback
 * @returns {Promise<Lemmatizer>}
 */
export async function loadLanguage(lang, options = {}) {
  if (!LANGUAGES[lang]) {
    throw new Error(`Unsupported language: ${lang}. Use LANGUAGES or getSupportedLanguages() to see available languages.`);
  }

  // Check in-memory cache first
  if (!options.force && loadedLemmatizers.has(lang)) {
    return loadedLemmatizers.get(lang);
  }

  // Download (or get from local cache)
  const { wordDict, ambiguityMap } = await downloadLanguage(lang, options);
  
  // Create lemmatizer
  const lemmatizer = createLemmatizer({ lang, wordDict, ambiguityMap });
  
  // Cache in memory
  loadedLemmatizers.set(lang, lemmatizer);
  
  return lemmatizer;
}

/**
 * Load multiple languages
 * @param {string[]} langs - Array of language codes
 * @param {object} options - Options
 * @returns {Promise<Map<string, Lemmatizer>>}
 */
export async function loadLanguages(langs, options = {}) {
  const results = new Map();
  await Promise.all(langs.map(async (lang) => {
    const lem = await loadLanguage(lang, options);
    results.set(lang, lem);
  }));
  return results;
}

/**
 * Get a loaded lemmatizer (returns null if not loaded)
 * @param {string} lang - Language code
 * @returns {Lemmatizer | null}
 */
export function getLemmatizer(lang) {
  return loadedLemmatizers.get(lang) || null;
}

/**
 * Unload a language from memory (keeps local cache)
 * @param {string} lang - Language code
 */
export function unloadLanguage(lang) {
  loadedLemmatizers.delete(lang);
}

/**
 * Unload all languages from memory
 */
export function unloadAll() {
  loadedLemmatizers.clear();
}

/**
 * Quick lemmatize - loads language if needed
 * @param {string} lang - Language code
 * @param {string} word - Word to lemmatize
 * @returns {Promise<{ lemmas: string[], method: string }>}
 */
export async function lemmatize(lang, word) {
  const lem = await loadLanguage(lang);
  return lem.lemmatizeWord(word);
}

/**
 * Quick lemmatize text - loads language if needed
 * @param {string} lang - Language code
 * @param {string} text - Text to lemmatize
 * @returns {Promise<Array<{ word: string, lemmas: string[], method: string }>>}
 */
export async function lemmatizeText(lang, text) {
  const lem = await loadLanguage(lang);
  return lem.lemmatizeText(text);
}

// Default export
export default {
  // Core
  loadLanguage,
  loadLanguages,
  getLemmatizer,
  unloadLanguage,
  unloadAll,
  lemmatize,
  lemmatizeText,
  
  // Language info
  LANGUAGES,
  getSupportedLanguages,
  isLanguageSupported,
  getLanguageInfo,
  getLargeLanguages,
  
  // Cache management
  isLanguageCached,
  getCachedLanguages,
  removeLanguage,
  clearCache,
  getCacheInfo,
  
  // Configuration
  setCDN,
  getCDN,
};

