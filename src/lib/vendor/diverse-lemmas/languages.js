/**
 * Language metadata (no dictionary data - that's downloaded on demand)
 */

export const LANGUAGES = {
  // Full support (with ambiguity maps)
  he: { name: 'Hebrew', source: 'custom+stanza', hasAmbiguity: true, sizeKB: 677, script: 'hebrew' },
  ko: { name: 'Korean', source: 'ud-lexicon', hasAmbiguity: true, sizeKB: 3072, script: 'hangul' },
  es: { name: 'Spanish', source: 'simplemma', hasAmbiguity: true, sizeKB: 15360 },
  fr: { name: 'French', source: 'simplemma', hasAmbiguity: true, sizeKB: 6144 },
  it: { name: 'Italian', source: 'simplemma', hasAmbiguity: true, sizeKB: 9728 },
  
  // Simplemma languages
  ast: { name: 'Asturian', source: 'simplemma', hasAmbiguity: false, sizeKB: 3589 },
  bg: { name: 'Bulgarian', source: 'simplemma', hasAmbiguity: false, sizeKB: 8233, script: 'cyrillic' },
  ca: { name: 'Catalan', source: 'simplemma', hasAmbiguity: false, sizeKB: 15897 },
  cs: { name: 'Czech', source: 'simplemma', hasAmbiguity: false, sizeKB: 4754 },
  cy: { name: 'Welsh', source: 'simplemma', hasAmbiguity: false, sizeKB: 8207 },
  da: { name: 'Danish', source: 'simplemma', hasAmbiguity: false, sizeKB: 16134 },
  de: { name: 'German', source: 'simplemma', hasAmbiguity: false, sizeKB: 20891 },
  el: { name: 'Greek', source: 'simplemma', hasAmbiguity: false, sizeKB: 7855, script: 'greek' },
  en: { name: 'English', source: 'simplemma', hasAmbiguity: false, sizeKB: 3109 },
  enm: { name: 'Middle English', source: 'simplemma', hasAmbiguity: false, sizeKB: 821 },
  et: { name: 'Estonian', source: 'simplemma', hasAmbiguity: false, sizeKB: 3451 },
  fa: { name: 'Persian', source: 'simplemma', hasAmbiguity: false, sizeKB: 364, script: 'arabic' },
  fi: { name: 'Finnish', source: 'simplemma', hasAmbiguity: false, sizeKB: 99931, large: true },
  ga: { name: 'Irish', source: 'simplemma', hasAmbiguity: false, sizeKB: 10418 },
  gd: { name: 'Scottish Gaelic', source: 'simplemma', hasAmbiguity: false, sizeKB: 1334 },
  gl: { name: 'Galician', source: 'simplemma', hasAmbiguity: false, sizeKB: 10295 },
  gv: { name: 'Manx', source: 'simplemma', hasAmbiguity: false, sizeKB: 1706 },
  hbs: { name: 'Serbo-Croatian', source: 'simplemma', hasAmbiguity: false, sizeKB: 21179 },
  hi: { name: 'Hindi', source: 'simplemma', hasAmbiguity: false, sizeKB: 2406, script: 'devanagari' },
  hu: { name: 'Hungarian', source: 'simplemma', hasAmbiguity: false, sizeKB: 13041 },
  hy: { name: 'Armenian', source: 'simplemma', hasAmbiguity: false, sizeKB: 9760, script: 'armenian' },
  id: { name: 'Indonesian', source: 'simplemma', hasAmbiguity: false, sizeKB: 432 },
  is: { name: 'Icelandic', source: 'simplemma', hasAmbiguity: false, sizeKB: 4255 },
  ka: { name: 'Georgian', source: 'simplemma', hasAmbiguity: false, sizeKB: 3551, script: 'georgian' },
  la: { name: 'Latin', source: 'simplemma', hasAmbiguity: false, sizeKB: 21618 },
  lb: { name: 'Luxembourgish', source: 'simplemma', hasAmbiguity: false, sizeKB: 9125 },
  lt: { name: 'Lithuanian', source: 'simplemma', hasAmbiguity: false, sizeKB: 6476 },
  lv: { name: 'Latvian', source: 'simplemma', hasAmbiguity: false, sizeKB: 4395 },
  mk: { name: 'Macedonian', source: 'simplemma', hasAmbiguity: false, sizeKB: 2599, script: 'cyrillic' },
  ms: { name: 'Malay', source: 'simplemma', hasAmbiguity: false, sizeKB: 371 },
  nb: { name: 'Norwegian Bokmål', source: 'simplemma', hasAmbiguity: false, sizeKB: 17377 },
  nl: { name: 'Dutch', source: 'simplemma', hasAmbiguity: false, sizeKB: 9769 },
  nn: { name: 'Norwegian Nynorsk', source: 'simplemma', hasAmbiguity: false, sizeKB: 1474 },
  pl: { name: 'Polish', source: 'simplemma', hasAmbiguity: false, sizeKB: 99168, large: true },
  pt: { name: 'Portuguese', source: 'simplemma', hasAmbiguity: false, sizeKB: 23055 },
  ro: { name: 'Romanian', source: 'simplemma', hasAmbiguity: false, sizeKB: 8375 },
  ru: { name: 'Russian', source: 'simplemma', hasAmbiguity: false, sizeKB: 27471, script: 'cyrillic' },
  se: { name: 'Northern Sami', source: 'simplemma', hasAmbiguity: false, sizeKB: 2775 },
  sk: { name: 'Slovak', source: 'simplemma', hasAmbiguity: false, sizeKB: 23724 },
  sl: { name: 'Slovenian', source: 'simplemma', hasAmbiguity: false, sizeKB: 3670 },
  sq: { name: 'Albanian', source: 'simplemma', hasAmbiguity: false, sizeKB: 787 },
  sv: { name: 'Swedish', source: 'simplemma', hasAmbiguity: false, sizeKB: 20437 },
  sw: { name: 'Swahili', source: 'simplemma', hasAmbiguity: false, sizeKB: 113562, large: true },
  tl: { name: 'Tagalog', source: 'simplemma', hasAmbiguity: false, sizeKB: 895 },
  tr: { name: 'Turkish', source: 'simplemma', hasAmbiguity: false, sizeKB: 29375 },
  uk: { name: 'Ukrainian', source: 'simplemma', hasAmbiguity: false, sizeKB: 16023, script: 'cyrillic' },
};

/**
 * Get list of supported language codes
 */
export function getSupportedLanguages() {
  return Object.keys(LANGUAGES);
}

/**
 * Check if a language is supported
 */
export function isLanguageSupported(lang) {
  return lang in LANGUAGES;
}

/**
 * Get language info
 */
export function getLanguageInfo(lang) {
  return LANGUAGES[lang] || null;
}

/**
 * Get all large languages (>50MB)
 */
export function getLargeLanguages() {
  return Object.entries(LANGUAGES)
    .filter(([_, info]) => info.large)
    .map(([code]) => code);
}

export default LANGUAGES;

