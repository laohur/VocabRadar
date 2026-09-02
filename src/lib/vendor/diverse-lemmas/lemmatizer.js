/**
 * Core lemmatization logic
 * Works with any loaded dictionary
 */

/**
 * Language-specific normalization functions
 */
const NORMALIZERS = {
  // Hebrew: strip nikud (vowel points)
  he: (s) => s.normalize('NFC').replace(/[\u05B0-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g, ''),
  
  // Default: NFC normalize + lowercase
  default: (s) => s.normalize('NFC').toLowerCase(),
  
  // Non-Latin scripts: NFC normalize only (no lowercase)
  nonLatin: (s) => s.normalize('NFC'),
};

// Languages that shouldn't be lowercased
const NON_LATIN_LANGS = new Set([
  'he', 'ko', 'ru', 'bg', 'uk', 'mk', 'el', 'ka', 'hy', 'fa', 'hi', 'ar'
]);

/**
 * Get normalizer for a language
 */
function getNormalizer(lang) {
  if (NORMALIZERS[lang]) return NORMALIZERS[lang];
  if (NON_LATIN_LANGS.has(lang)) return NORMALIZERS.nonLatin;
  return NORMALIZERS.default;
}

/**
 * Create a lemmatizer instance from loaded dictionary data
 * @param {object} options
 * @param {string} options.lang - Language code
 * @param {object} options.wordDict - Word form -> lemma mapping
 * @param {object} options.ambiguityMap - Optional ambiguity data
 * @returns {object} Lemmatizer instance
 */
export function createLemmatizer({ lang, wordDict, ambiguityMap = null }) {
  const normalize = getNormalizer(lang);
  
  function rankCandidates(candidates, ambiguityForm) {
    if (!ambiguityMap) return [...candidates];
    
    const amb = ambiguityMap[ambiguityForm];
    const freq = new Map();
    if (amb?.lemmas) {
      for (const [lem, count] of amb.lemmas) freq.set(lem, count);
    }
    return [...candidates].sort((a, b) => (freq.get(b) || 0) - (freq.get(a) || 0));
  }

  /**
   * Lemmatize a single word
   * @param {string} word - Word to lemmatize
   * @returns {{ lemmas: string[], method: 'direct' | 'unknown' }}
   */
  function lemmatizeWord(word) {
    const norm = normalize(word);
    const candidates = new Set();
    let method = 'unknown';

    // Add ambiguity candidates first
    if (ambiguityMap) {
      const amb = ambiguityMap[norm];
      if (amb?.lemmas) {
        for (const [lem] of amb.lemmas) candidates.add(lem);
      }
    }

    // Direct dictionary lookup
    const hit = wordDict[norm];
    if (hit) {
      candidates.add(hit);
      method = 'direct';
    }

    // Fallback to normalized form
    if (candidates.size === 0) {
      candidates.add(norm);
    }

    return { lemmas: rankCandidates(candidates, norm), method };
  }

  /**
   * Lemmatize multiple words
   * @param {string[]} words - Array of words
   * @returns {Array<{ word: string, lemmas: string[], method: string }>}
   */
  function lemmatizeWords(words) {
    return words.map(word => ({
      word,
      ...lemmatizeWord(word)
    }));
  }

  /**
   * Lemmatize text (simple whitespace tokenization)
   * @param {string} text - Text to lemmatize
   * @returns {Array<{ word: string, lemmas: string[], method: string }>}
   */
  function lemmatizeText(text) {
    const words = text.split(/[\s.,!?;:"'()[\]{}،؛؟]+/).filter(Boolean);
    return lemmatizeWords(words);
  }

  return {
    lang,
    wordDict,
    ambiguityMap,
    lemmatizeWord,
    lemmatizeWords,
    lemmatizeText,
    normalize,
    
    // Stats
    get dictSize() { return Object.keys(wordDict).length; },
    get ambiguitySize() { return ambiguityMap ? Object.keys(ambiguityMap).length : 0; },
  };
}

export default createLemmatizer;

