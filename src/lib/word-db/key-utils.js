// ============================================================
// 文件职责：词典分表主键构造/还原工具（src/lib/word-db/key-utils.js）
// 来源：拆分自 src/lib/word-db.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// makeKey(lang, word) 生成 `${lang}|${word_lower}`（五张属性分表 d_rank/d_tags/
//   d_lemma/d_trans/d_phon 与旧 words 表共用的主键），splitKey(key) 反向还原。
// 历史铁律（第一百五十五次重大教训）：makeKey 曾在 119 分表重构中被弄丢（未定义），
//   所有写入路径调用即 ReferenceError ⇒ 词典从未成功持久化一条记录。本次拆分
//   makeKey/splitKey 只在此定义一次并导出，db-ops.js（idbBulkWrite/idbUpdate/
//   idbGet/idbGetBatch/idbPut/idbGetLangProjection）与 sw-channel.js（getWord/
//   getWordsBatch/updateFields/handleWordDbMessage）全部经 import 引用同一实例。
// ============================================================

// === 分表迁移（第一百一十九次）：旧统一 words 表 -> 五张分表，仅执行一次 ===
// 第一百五十五次·总根因修复：makeKey 在 119 重构中丢失定义，而所有写入路径
// （idbBulkWrite/idbUpdate）都在调用它 ⇒ ReferenceError ⇒ 词典从未成功持久化
// 一条记录（读路径走游标+splitKey 不受影响）＝"每次都要重建"的最终根源。
export function makeKey(lang, word) {
  return lang + '|' + String(word || '').toLowerCase();
}
export function splitKey(key) {
  const i = String(key).indexOf('|');
  if (i < 0) return null;
  return { lang: String(key).slice(0, i), word: String(key).slice(i + 1) };
}
