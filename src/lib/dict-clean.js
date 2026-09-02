// 释义清洗：去除在线词典渠道返回的夹杂信息，保留干净的释义文本
//
// 反思（2026-08-16 第六十六次）：用户反馈页面/侧栏释义混乱——
//   "that facilitates(v. 促进( facilitate(vt. 帮助; 促进，助长; 使容易)的第三人称单数 ); 使便利; 推进; 帮助（某人）进步) the"
//   根因：百度联想 sug（fanyi.baidu.com/sug）与有道词典（dict.youdao.com/jsonapi）对
//   屈折形式（第三人称单数/过去式等）返回"原形(释义)的屈折说明"夹杂在释义里的条目，
//   例如 facilitate 的 v 字段实测为：
//     "v. 促进( facilitate的第三人称单数 ); 使便利; 推进; 帮助（某人）进步"
//   该夹杂信息既不是译文也不是词义，进入释义后污染页面注释（全文 join）与
//   侧栏注释（随机分片 → 拆出 "facilitate(vt. 帮助" 等残片）。
//   修正：统一在本模块清洗释义字符串，写缓存前/读缓存后/渲染前都过一遍（幂等）。

// 屈折说明（词形变化标注）：出现在"原形的第三人称单数"这类条目里
const INFLECTION_NOTE = '(?:第三人称单数|过去式|过去分词|现在分词|复数|所有格|比较级|最高级)';

/**
 * 清洗一条释义字符串
 * @param {string} str 原始释义（可能含 "原形(释义)的屈折说明" 夹杂）
 * @returns {string} 清洗后的释义；无有效内容返回空串
 */
export function cleanDictEntry(str) {
  if (!str) return '';
  let s = String(str);
  // 1. 整段"原形(释义)的屈折说明"（如 facilitate(vt. 帮助; 促进，助长; 使容易)的第三人称单数）
  s = s.replace(new RegExp('[\\u4e00-\\u9fffA-Za-z][\\u4e00-\\u9fffA-Za-z .\\\'-]*\\s*\\([^()]*\\)\\s*的' + INFLECTION_NOTE, 'g'), '');
  // 2. 整段"原形的屈折说明"（如 facilitate的第三人称单数）
  s = s.replace(new RegExp('[\\u4e00-\\u9fffA-Za-z][\\u4e00-\\u9fffA-Za-z .\\\'-]*\\s*的' + INFLECTION_NOTE, 'g'), '');
  // 3. 全角括注（原形 的屈折说明）整组删除（有道实测 "（facilitate 的第三人称单数）"）
  s = s.replace(new RegExp('（[^（）]*的' + INFLECTION_NOTE + '[^（）]*）', 'g'), '');
  // 4. 半角括注 (原形 的屈折说明) 整组删除（百度实测 "( facilitate的第三人称单数 )"）
  s = s.replace(new RegExp('\\([^()]*的' + INFLECTION_NOTE + '[^()]*\\)', 'g'), '');
  // 5. 残留的空括注清理（如上一步把括注内容清空后剩 "()"）
  s = s.replace(/[（(]\s*[）)]/g, '');
  // 6. 分隔符规整 + 去重
  const parts = s
    .split(/[;；]/)
    .map((x) => x.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  const uniq = [];
  for (const p of parts) {
    if (!uniq.includes(p)) uniq.push(p);
  }
  return uniq.join('；');
}

/**
 * 取一个短义项（侧栏/字幕行内注释用，即"非详细/简略模式"的释义）
 * 反思（2026-08-16 第六十六次）：先过 cleanDictEntry 再分片，避免切到
 *   "facilitate(vt. 帮助" 这类残片；并剥离词性前缀（"v. 促进" → "促进"），
 *   侧栏注释只显示词义本身（用户反馈"侧栏释义拆行拆多样式"）。
 * 第一百二十三次（用户反馈"释义缺右括号：短裤( shor"）：新增括号平衡守卫——
 *   半/全角括号不配对的候选一律跳过（上游分段截断的残片），全不配对时退回首条。
 * 第一百七十九次（用户细则"详细全列，非详细只列出第一项"）：去掉两级随机——
 *   旧版先随机取一条 translations 再随机取一个短义项，导致同一个词在不同句子/
 *   不同次渲染显示不同释义（用户实测 CSS 依次显示 "Cast Semi-Steel 半铸钢"、
 *   "Cascading Style"、"钢性铸铁"），既像重复又常命中冷僻义。
 *   改为确定性取第一项：translations[0] 的第一个短义项（词典按常用度排序，
 *   首项即常用义）；首条无有效内容时才顺序回退到后续条目。
 * @param {string[]} translations 释义数组
 * @returns {string} 单个短义项；无可用释义返回空串
 */
/**
 * 第一百二十三次：括号平衡检测（半/全角）。
 * 导出供各展示端过滤历史缓存中的截断残片（如 "短裤( shor"）。
 * @param {string} s
 * @returns {boolean}
 */
export function isBalancedParens(s) {
  if (!s) return true;
  const open = (s.match(/[（(]/g) || []).length;
  const close = (s.match(/[）)]/g) || []).length;
  return open === close;
}

export function pickCleanShortTrans(translations) {
  if (!Array.isArray(translations) || translations.length === 0) return '';
  // 顺序遍历：优先用第一条释义；仅当它清洗后无有效短义项时才试下一条
  for (const full of translations) {
    if (!full) continue;
    const parts = cleanDictEntry(full).split('；').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) continue;
    // 括号平衡守卫：截断残片（如 "短裤( shor"）不进注释
    const balanced = parts.filter(isBalancedParens);
    const pool = balanced.length > 0 ? balanced : parts;
    const picked = pool[0].replace(/^[a-z]{1,4}\.\s*/i, '').trim();
    if (picked) return picked;
  }
  return '';
}
