// 分词模块
//
// 功能：
//   1. simpleTokenize：将文本拆分为各类 token（CJK 字符、emoji、英文单词等）
//   2. selectEnglishTokens：从 token 列表中筛选英文单词
//   3. extractEnglishWords：分词 + 选词 + 过滤单字母/音效标注
//
// 反思（2026-08-08）：用户反馈"为啥不用 Intl.Segmenter？"。
//   旧版用手写正则分词，存在以下问题：
//   - 正则 [^\W_]+(?:['\u2019\-][^\W_]+)* 无法正确处理所有缩写/所有格边界
//   - 对 CJK 语言只能按单字符切，无法做中文分词
//   - Intl.Segmenter（Chrome 87+ 内置，零依赖）原生支持词级分词，
//     正确处理缩写（don't）、所有格（child's）、连字符词、CJK 分词
//   修正：优先使用 Intl.Segmenter 进行分词，不支持时回退到正则。
//
// 正则回退方案（与旧版完全一致，保留兼容性）
// 必须带 g flag：String.match(无g) 只返回首个匹配，导致整句只取第一个词
// （历史 bug：字幕 "it's the muffin man" 只返回 ["it's"]，丢失 muffin/man）
const TOKENIZE_PATTERN = new RegExp(
  '\\p{Script=Han}|[\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]+|\\p{Extended_Pictographic}+|[^\\W_]+(?:[\'\\u2019\\-][^\\W_]+)*',
  'gu'
);

// 选词：首尾是字母，中间允许连字符和撇号组合，撇号总计至多1个
const SELECT_PATTERN = new RegExp(
  "^(?!(?:[^'\\u2019]*['\\u2019]){2})[A-Za-z]+(?:[-'\\u2019]+[A-Za-z]+)*$"
);

// Intl.Segmenter 实例缓存（按 granularity 复用，避免重复创建）
let _wordSegmenter = null;
let _graphemeSegmenter = null;

/**
 * 检查 Intl.Segmenter 是否可用（Chrome 87+ / Safari 14.1+ / Firefox 125+）
 * @returns {boolean}
 */
function hasSegmenter() {
  return typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
}

/**
 * 获取或创建词级 Segmenter 实例
 * @returns {Intl.Segmenter|null}
 */
function getWordSegmenter() {
  if (!_wordSegmenter && hasSegmenter()) {
    _wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  }
  return _wordSegmenter;
}

/** 分词：将文本拆分为各类 token
 *
 * 反思（2026-08-08 第二次）：用户再次反馈"你咋分词的，为啥不用 Intl.Segmenter？"。
 *   上一版虽加了 Intl.Segmenter，但过滤逻辑有误：
 *   仅检查 trimmed && /[^\s]/ 保留了标点符号 token，
 *   导致 selectEnglishTokens 的 SELECT_PATTERN 匹配异常。
 *   修正：使用 Intl.Segmenter 的 isWordLike 属性过滤，
 *   仅保留词级 token（排除标点、空白、符号）。
 */
export function simpleTokenize(text) {
  if (!text) return [];

  // 优先使用 Intl.Segmenter（Chrome 87+ 内置，零依赖）
  const seg = getWordSegmenter();
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

  // 回退：正则分词（与旧版完全一致）
  return text.match(TOKENIZE_PATTERN) || [];
}

/** 选词：从 token 列表中筛选英文单词 */
export function selectEnglishTokens(tokens) {
  return tokens.filter((tok) => SELECT_PATTERN.test(tok));
}

/** 分词+选词：从文本中提取英文单词
 *  反思（2026-07-05）：用户要求"字幕内的非内容而是符号，不作为单词"。
 *  字幕中常见的 [Music]、(applause) 等标注是音效描述，不是台词内容，
 *  其中的英文词不应作为生词提取。在分词前先剥离方括号/圆括号内的内容。
 *  反思（2026-07-05）：用户要求"不要递归注释。本工具、字幕内的非内容而是符号，不作为单词"。
 *  单字母（I, a）不是有意义的生词，过滤掉。最小词长 2 字符。
 */
export function extractEnglishWords(text) {
  // 剥离方括号 [...] 和圆括号 (...) 内的内容（音效/说话人标注，非台词）
  const cleaned = text.replace(/\[[^\]\n]{0,50}\]/g, ' ').replace(/\([^)\n]{0,50}\)/g, ' ');
  const tokens = simpleTokenize(cleaned);
  const selected = selectEnglishTokens(tokens);
  // 过滤单字母（I, a 等不是有意义的生词）
  return selected.filter((w) => w.length >= 2);
}
