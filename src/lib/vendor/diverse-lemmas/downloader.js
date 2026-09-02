/**
 * Language file downloader
 * Fetches dictionaries from CDN/GitHub and caches locally
 */

import { storage } from './storage.js';
import { LANGUAGES } from './languages.js';

// CDN base URL - can be configured
// 反思（2026-08-09 第十次）：jsDelivr 对 @hg0428/diverse-lemmas-data 包返回 403
//   （包体 733MB 超过 jsDelivr 150MB 限制），改用 unpkg（无大小限制）。
//   验证：unpkg 返回 200，word_dict 含 139,070 个英文词条。
const DEFAULT_CDN = 'https://unpkg.com/@hg0428/diverse-lemmas-data@1';

let cdnBase = DEFAULT_CDN;

/**
 * Configure the CDN base URL
 * @param {string} url - Base URL for language files
 */
export function setCDN(url) {
  cdnBase = url.replace(/\/$/, '');
}

/**
 * Get current CDN URL
 */
export function getCDN() {
  return cdnBase;
}

/**
 * Fetch with cross-platform support (browser fetch or node-fetch)
 *
 * 反思（2026-08-09）：content script 受页面 CSP 限制无法直接 fetch CDN，
 *   diverse-lemmas 词典数据下载会失败。修正：检测扩展环境（chrome.runtime），
 *   优先通过 service worker 代理 fetch（SW 有 host_permissions 不受 CSP 限制）。
 *   非扩展环境（Node.js）仍用原生 fetch / node-fetch。
 *
 * 反思（2026-08-09 第七次）：用户再次反馈"词形还原现在又没了，老毛病"。
 *   根因：chrome.runtime.sendMessage 无超时，SW 休眠时回调可能长时间不触发，
 *   导致 fetchJSON 永久挂起 → loadLanguage 永久挂起 → preloadLanguage 的重试无法触发。
 *   修正：给 SW 代理调用加 15 秒超时，超时后 resolve(null) 让重试机制生效。
 *   同时增加详细错误日志，便于诊断。
 */
async function fetchJSON(url) {
  // 扩展环境：通过 service worker 代理（绕过页面 CSP/CORS 限制）
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    try {
      const resp = await new Promise((resolve) => {
        // 反思（2026-08-13 第五十二次）：`settled` 未声明即使用 → ReferenceError。
        //   每次调用重置，超时/回调/sendMessage 异常三方只允许第一个生效。
        let settled = false;
        // 反思（2026-08-12 第四十一次）：15s 超时过长，降为 8s。
        //   SW 休眠时 sendMessage 回调可能延迟，但 8s 足够 SW 唤醒并响应。
        //   超时后 resolve(null) 让上层重试机制生效。
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            console.warn('[VocabRadar][diverse-lemmas] SW 代理超时(8s):', url.slice(0, 80));
            resolve(null);
          }
        }, 8000);
        try {
          chrome.runtime.sendMessage({ type: 'FETCH_URL', url }, (r) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              console.warn('[VocabRadar][diverse-lemmas] SW 代理 lastError:', chrome.runtime.lastError.message);
              resolve(null);
              return;
            }
            resolve(r);
          });
        } catch (sendErr) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            console.warn('[VocabRadar][diverse-lemmas] SW 代理 sendMessage 异常:', sendErr && sendErr.message);
            resolve(null);
          }
        }
      });
      if (resp && resp.ok && resp.data !== undefined) {
        return resp.data;
      }
      throw new Error(resp && resp.error ? `SW proxy: ${resp.error}` : `SW proxy failed: ${url}`);
    } catch (e) {
      // SW 代理失败，尝试直接 fetch（某些页面 CSP 宽松时可能成功）
      console.warn('[VocabRadar][diverse-lemmas] SW 代理失败，尝试直接 fetch:', e && e.message);
    }
  }

  // Browser or Node 18+ with native fetch
  if (typeof fetch === 'function') {
    // 反思（2026-08-10）：加 cache:'no-store' 避免浏览器 HTTP 缓存返回旧响应
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
  }
  
  // Node.js without native fetch - dynamic import
  const { default: nodeFetch } = await import('node-fetch');
  const res = await nodeFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

/**
 * Download and cache a language
 * @param {string} lang - Language code
 * @param {object} options - Download options
 * @param {boolean} options.force - Re-download even if cached
 * @param {function} options.onProgress - Progress callback
 * @returns {Promise<{wordDict: object, ambiguityMap?: object}>}
 */
export async function downloadLanguage(lang, options = {}) {
  const { force = false, onProgress } = options;
  
  // Check if language is supported
  if (!LANGUAGES[lang]) {
    throw new Error(`Unsupported language: ${lang}. Use LANGUAGES to see supported languages.`);
  }

  // Check cache first (unless forcing re-download)
  // 反思（2026-08-09 第十次）：增加缓存数据校验——若 wordDict 条目数过少
  //   （<100），说明之前缓存了错误数据（如 CDN 返回 403 时残留的残缺数据），
  //   视为缓存无效，强制重新下载。
  if (!force) {
    const cached = await storage.get(lang);
    if (cached?.wordDict) {
      const cachedCount = Object.keys(cached.wordDict).length;
      if (cachedCount < 100) {
        console.warn(`[VocabRadar][diverse-lemmas] 缓存数据异常（${lang}: 仅 ${cachedCount} 词），丢弃缓存重新下载`);
        await storage.delete(lang);
      } else {
        console.log(`[VocabRadar][diverse-lemmas] 从缓存加载 ${lang}（${cachedCount} 词）`);
        onProgress?.({ stage: 'cached', lang });
        return { wordDict: cached.wordDict, ambiguityMap: cached.ambiguityMap };
      }
    }
  }

  onProgress?.({ stage: 'downloading', lang, file: 'lemmas.json' });
  
  // Download main dictionary
  const lemmasUrl = `${cdnBase}/${lang}/lemmas.json`;
  console.log(`[VocabRadar][diverse-lemmas] 开始下载: ${lemmasUrl}`);
  const lemmasData = await fetchJSON(lemmasUrl);
  const wordDict = lemmasData.word_dict || lemmasData;
  // 反思（2026-08-10）：诊断日志——记录下载结果，便于排查词典加载异常
  console.log(`[VocabRadar][diverse-lemmas] 下载完成: ${Object.keys(wordDict).length} 词, URL=${lemmasUrl}`);

  // Try to download ambiguity map (optional)
  let ambiguityMap = null;
  if (LANGUAGES[lang]?.hasAmbiguity) {
    onProgress?.({ stage: 'downloading', lang, file: 'ambiguity_map.json' });
    try {
      const ambUrl = `${cdnBase}/${lang}/ambiguity_map.json`;
      ambiguityMap = await fetchJSON(ambUrl);
    } catch {
      // Ambiguity map is optional
    }
  }

  // Cache the downloaded data
  onProgress?.({ stage: 'caching', lang });
  await storage.set(lang, { wordDict, ambiguityMap });

  onProgress?.({ stage: 'complete', lang });
  return { wordDict, ambiguityMap };
}

/**
 * Download multiple languages in parallel
 * @param {string[]} langs - Array of language codes
 * @param {object} options - Download options
 * @returns {Promise<Map<string, {wordDict, ambiguityMap}>>}
 */
export async function downloadLanguages(langs, options = {}) {
  const results = new Map();
  const promises = langs.map(async (lang) => {
    const data = await downloadLanguage(lang, options);
    results.set(lang, data);
  });
  await Promise.all(promises);
  return results;
}

/**
 * Check if a language is cached locally
 * @param {string} lang - Language code
 * @returns {Promise<boolean>}
 */
export async function isLanguageCached(lang) {
  const cached = await storage.get(lang);
  return cached?.wordDict != null;
}

/**
 * Get list of cached languages
 * @returns {Promise<string[]>}
 */
export async function getCachedLanguages() {
  return storage.list();
}

/**
 * Remove a language from cache
 * @param {string} lang - Language code
 */
export async function removeLanguage(lang) {
  return storage.delete(lang);
}

/**
 * Clear all cached languages
 */
export async function clearCache() {
  return storage.clear();
}

/**
 * Get cache info for a language
 * @param {string} lang - Language code
 * @returns {Promise<{cachedAt: number, sizeKB: number} | null>}
 */
export async function getCacheInfo(lang) {
  const cached = await storage.get(lang);
  if (!cached) return null;
  
  // Estimate size from word dict
  const sizeKB = Math.round(JSON.stringify(cached.wordDict).length / 1024);
  return { cachedAt: cached.cachedAt, sizeKB };
}

export default {
  downloadLanguage,
  downloadLanguages,
  isLanguageCached,
  getCachedLanguages,
  removeLanguage,
  clearCache,
  getCacheInfo,
  setCDN,
  getCDN,
};

