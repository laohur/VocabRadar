// ============================================================
// 文件职责：词典分表主键构造/还原工具（src/lib/word-db/key-utils.js）
// makeKey(lang, word) 生成 `${lang}|${word_lower}`（五张属性分表 d_rank/d_tags/
//   d_lemma/d_trans/d_phon 与旧 words 表共用的主键），splitKey(key) 反向还原。
// makeKey/splitKey 只在此定义一次并导出：db-ops.js 与 sw-channel.js 全部经
//   import 引用同一实例（历史上曾因多处定义/漏定义导致词典无法持久化）。
// ============================================================

// makeKey 是所有写入路径的主键来源，一旦漏定义词典即无法持久化
//   （读路径走游标+splitKey 不受影响）。
export function makeKey(lang, word) {
  return lang + '|' + String(word || '').toLowerCase();
}
export function splitKey(key) {
  const i = String(key).indexOf('|');
  if (i < 0) return null;
  return { lang: String(key).slice(0, i), word: String(key).slice(i + 1) };
}
