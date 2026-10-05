// 分词模块
//
// 功能：
//   1. simpleTokenize：将文本拆分为各类 token（CJK 字符、emoji、英文单词等）
//   2. selectTokens：按学习语言筛选候选生词 token
//   3. extractWords：分词 + 选词 + 按语言过滤过短词
//
// 分词优先使用 Intl.Segmenter（Chrome 87+ 内置，零依赖）：原生支持词级分词，
//   正确处理缩写（don't）、所有格（child's）、连字符词、CJK 分词；手写正则无法
//   正确处理所有缩写/所有格边界，对 CJK 只能按单字符切。不支持时回退到正则。
//
// 2026-10-05（用户："改了语言，并不生效，还是按照英语扫"）反思：
//   选词层原为英文专用（SELECT_PATTERN 纯 ASCII），非英语字幕在此被整批滤光，
//   词典 wordfreq 42 语 rank 形同虚设——词典侧早已按语言路由（getWordsBatch(lang)），
//   唯独分词卡死。修正为按学习语言分三档：
//     en：维持原英文模式（撇号至多1个的缩写/所有格约束）；
//     其他非 CJK（法/德/西/俄/印地…）：Unicode 字母 \p{L}（重音字母/西里尔/天城文等），
//       撇号/连字符规则同英文；
//     CJK（zh/ja/ko）：Intl.Segmenter 词级 token 直通（词面与 wordfreq 分词键同源），
//       仅要求 token 由字母/变音符组成（排除数字、emoji），单字词合法（HSK1"我"），
//       查不到 rank 按表外词处理，宁多勿漏。
//
// 正则回退方案
// 必须带 g flag：String.match(无g) 只返回首个匹配，导致整句只取第一个词
// （历史 bug：字幕 "it's the muffin man" 只返回 ["it's"]，丢失 muffin/man）
const TOKENIZE_PATTERN = new RegExp(
  '\\p{Script=Han}|[\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]+|\\p{Extended_Pictographic}+|[^\\W_]+(?:[\'\\u2019\\-][^\\W_]+)*',
  'gu'
);

// 英文选词：首尾是字母，中间允许连字符和撇号组合，撇号总计至多1个
const SELECT_PATTERN = new RegExp(
  "^(?!(?:[^'\\u2019]*['\\u2019]){2})[A-Za-z]+(?:[-'\\u2019]+[A-Za-z]+)*$"
);

// 非 CJK 语言选词：Unicode 字母（重音字母/西里尔/天城文等），撇号/连字符规则同英文
const SELECT_UNICODE_PATTERN = new RegExp(
  "^(?!(?:[^'\\u2019]*['\\u2019]){2})\\p{L}+(?:[-'\\u2019]+\\p{L}+)*$",
  'u'
);

// CJK 选词：token 须全部由字母/变音符组成（排除纯数字、emoji；うー类的长音符属 Lm 会被保留）
const SELECT_CJK_PATTERN = new RegExp('^[\\p{L}\\p{M}]+$', 'u');

// CJK 语言集合（Intl.Segmenter 词级分词即目标词面；语言码为简单 ISO 码，与 popup 设置一致）
const CJK_LANGS = new Set(['zh', 'ja', 'ko']);

/** 是否 CJK 学习语言 */
export function isCjkLang(lang) {
  return CJK_LANGS.has(lang);
}

// Intl.Segmenter 实例缓存（按 locale 复用，避免重复创建）
const _wordSegmenters = new Map();   // locale 串 -> Segmenter
let _graphemeSegmenter = null;

/**
 * 检查 Intl.Segmenter 是否可用（Chrome 87+ / Safari 14.1+ / Firefox 125+）
 * @returns {boolean}
 */
function hasSegmenter() {
  return typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
}

/**
 * 获取或创建词级 Segmenter 实例（按语言各建一个：ICU 对 zh/ja/ko 按 locale 词典
 * 切分，locale 缺省取浏览器 UI 语言，切错词典会劣化日/中词界——2026-10-05 修正）
 * @param {string} [lang] 学习语言 ISO 码；非法值回退默认 locale
 * @returns {Intl.Segmenter|null}
 */
function getWordSegmenter(lang) {
  if (!hasSegmenter()) return null;
  const key = lang || '';
  let seg = _wordSegmenters.get(key);
  if (!seg) {
    try {
      seg = new Intl.Segmenter(lang || undefined, { granularity: 'word' });
    } catch (e) {
      seg = new Intl.Segmenter(undefined, { granularity: 'word' });
    }
    _wordSegmenters.set(key, seg);
  }
  return seg;
}

/** 分词：将文本拆分为各类 token
 *
 * 优先使用 Intl.Segmenter（按学习语言 locale，见 getWordSegmenter），按 isWordLike
 *   属性过滤，仅保留词级 token（排除标点、空白、符号——若只按非空白过滤，保留的
 *   标点 token 会使 selectTokens 的选词正则匹配异常）。
 */
export function simpleTokenize(text, lang) {
  if (!text) return [];

  // 优先使用 Intl.Segmenter（Chrome 87+ 内置，零依赖）
  const seg = getWordSegmenter(lang);
  if (seg) {
    const tokens = [];
    for (const { segment, isWordLike } of seg.segment(text)) {
      // isWordLike=true 表示该段是词（含英文单词、CJK 字符等）
      // isWordLike=false 表示标点、空白、符号等
      if (isWordLike) {
        tokens.push(segment);
      }
    }
    return tokens;
  }

  // 回退：正则分词
  return text.match(TOKENIZE_PATTERN) || [];
}

/** 单 token 是否通过学习语言的选词模式（selectTokens 与 extractWordMatches 共用，防口径漂移） */
export function isAcceptedToken(tok, lang) {
  if (isCjkLang(lang)) {
    return SELECT_CJK_PATTERN.test(tok);
  }
  if (!lang || lang === 'en') {
    return SELECT_PATTERN.test(tok);
  }
  return SELECT_UNICODE_PATTERN.test(tok);
}

/** 选词：按学习语言从 token 列表中筛选候选生词
 * @param {string[]} tokens simpleTokenize 输出
 * @param {string} lang 学习语言 ISO 码（'en'/'ja'/'zh'/'ko'/'fr'…）
 */
export function selectTokens(tokens, lang) {
  return tokens.filter((tok) => isAcceptedToken(tok, lang));
}

/** 分词+选词：从文本中提取学习语言的候选生词
 *  字幕中常见的 [Music]、(applause) 等标注是音效描述，不是台词内容，
 *  其中的词不作为生词提取（用户要求"字幕内的非内容而是符号，不作为单词"）：
 *  分词前先剥离方括号/圆括号内的内容。
 *  最小词长按语言：CJK 单字词是合法词面（HSK1"我"、JLPT"森"），下限 1；
 *  其他语言单字母（I, a）不是有意义的生词，最小 2。
 * @param {string} text 待分词文本
 * @param {string} lang 学习语言 ISO 码，缺省按英文
 */
export function extractWords(text, lang = 'en') {
  // 剥离方括号 [...] 和圆括号 (...) 内的内容（音效/说话人标注，非台词）
  const cleaned = text.replace(/\[[^\]\n]{0,50}\]/g, ' ').replace(/\([^)\n]{0,50}\)/g, ' ');
  const tokens = simpleTokenize(cleaned, lang);
  const selected = selectTokens(tokens, lang);
  const minLen = isCjkLang(lang) ? 1 : 2;
  return selected.filter((w) => w.length >= minLen);
}

/**
 * 分词+选词（带原文下标）：text-hint 页面包裹用——需要 matchAll 式位置来包 span。
 * 与 extractWords 同一套 分词(locale Segmenter)/选词(isAcceptedToken)/最短长端口径，
 * 差异仅两点（均为页面扫描既有行为，保持不变）：
 *   ①不剥离 [...] (...) 音效标注（页面正文非字幕，位置必须与传入文本 1:1 对齐）；
 *   ②不过滤最短词长（单字母交由词频阈值过滤，与旧 WORD_G_PATTERN+SELECT_PATTERN 口径一致）。
 * 2026-10-05（用户："改了语言，并不生效，还是按照英语扫"）：th/scan 原自有
 *   WORD_G_PATTERN+SELECT_PATTERN（纯 ASCII 英文）选词，tokenizer 按语言修正没覆盖到
 *   这层——网页端非英语 token 在此被整批滤光。统一收口到本函数。
 * @param {string} text 原始文本（未转义；返回下标相对此文本）
 * @param {string} lang 学习语言 ISO 码
 * @returns {Array<{word:string,start:number,end:number}>}
 */
export function extractWordMatches(text, lang = 'en') {
  if (!text) return [];
  const out = [];
  const seg = getWordSegmenter(lang);
  if (seg) {
    for (const s of seg.segment(text)) {
      if (!s.isWordLike) continue;
      if (!isAcceptedToken(s.segment, lang)) continue;
      out.push({ word: s.segment, start: s.index, end: s.index + s.segment.length });
    }
    return out;
  }
  // 回退：正则分词（TOKENIZE_PATTERN 与旧 WORD_G_PATTERN 同款，带 g 可 matchAll）
  for (const m of text.matchAll(TOKENIZE_PATTERN)) {
    if (!isAcceptedToken(m[0], lang)) continue;
    out.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// === 渲染端词面定位（高亮/删除判定共用，2026-10-05） ===
// JS 的 \b 词界只认 [A-Za-z0-9_]：重音词（café/être）与 CJK 词永远失配——高亮
//   不亮/边界被吃的根因之一。此处统一口径：
//   非 CJK 词 → Unicode 词界 lookaround（\p{L}\p{M}\p{N}_，u 标志）；
//   CJK 词   → 无词界概念，直接子串定位（词面本就来自同段文本的 Segmenter）。
// 正则回退路径（无 Intl.Segmenter）产出的 CJK 单字词同样适用。

const CJK_WORD_CHAR = new RegExp('[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]', 'u');

/** 词内含 CJK 字符（含日语假名/韩文）即走子串定位 */
export function isCjkWord(word) {
  return CJK_WORD_CHAR.test(String(word || ''));
}

/** 正则元字符转义（本文件局部，避免渲染端各自手写漂移） */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 在原文中定位单词的全部出现位置（词面级，非字符级模糊匹配）
 * @param {string} text 原始文本（未 HTML 转义）
 * @param {string} word 生词（小写词面；匹配大小写不敏感）
 * @param {boolean} [global=false] false=只返回首个出现
 * @returns {Array<{start:number,end:number}>} 原文下标区间（end 不含）
 */
export function findWordPositions(text, word, global = false) {
  const src = String(text || '');
  const w = String(word || '');
  if (!src || !w) return [];
  const positions = [];
  if (isCjkWord(w)) {
    // 大小写不敏感对 CJK 无意义；直接子串查找（词面来自同文本分词，子串必在）
    let idx = src.indexOf(w);
    while (idx >= 0) {
      positions.push({ start: idx, end: idx + w.length });
      if (!global) break;
      idx = src.indexOf(w, idx + 1);
    }
    return positions;
  }
  // Unicode 词界：左侧禁 \p{L}\p{M}\p{N}_，右侧禁 \p{L}\p{M}\p{N}
  //   （右侧放宽含 _ 与左侧一致更严——保持与旧 \b 相同的"数字/下划线邻接不算独立词"口径，
  //   右侧不含 _ 是历史行为，维持不变）
  let re;
  try {
    re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escapeRegExp(w)}(?![\\p{L}\\p{M}\\p{N}])`, 'giu');
  } catch (e) {
    // 极旧内核不支持 lookbehind：退回 \b（英文口径，重音/CJK 已由上方子串分支承接大半）
    re = new RegExp(`\\b${escapeRegExp(w)}\\b`, 'gi');
  }
  let m;
  while ((m = re.exec(src)) !== null) {
    positions.push({ start: m.index, end: m.index + m[0].length });
    if (!global) break;
    if (m[0].length === 0) re.lastIndex++;  // 防零宽异常死循环
  }
  return positions;
}
