/**
 * runaway.js —— 翻译输出失控检测（退化重复输出过滤器）
 *
 * 背景：LLM 渠道（尤其免费直连的小模型）偶发退化输出——HTTP 200 但内容是
 *   单字符无限复读（如 "ooo呜呜呜呜呜呜…" 直至 max_tokens 截断）。这类结果
 *   非空、文字系统也合格，既有"非空 + 原文回显 + 文字系统"三道校验全放行，
 *   会被当成功采纳并展示。本文件给译文加第四道闸：命中任一规则即判"输出失控"。
 *
 * 三条规则（阈值取宽松侧，宁漏勿误伤——误伤会挤掉正常渠道，漏放只是偶尔一条怪译文）：
 *   ① 单字符连跑：同一字符连续 ≥6 个且全文 ≥12 字符 → 失控。
 *      呜×30 一眼即中；"哈哈哈哈哈哈"(6) 因全文不足 12 放行，笑场短句不误伤。
 *   ② 独特字符占比：全文 ≥24 字符且 去重字符数/全长 < 0.25 → 失控。
 *      兜住 "ooo呜呜…"（2/33≈0.06）这类混串，也兜住交替复读（abababab…）。
 *   ③ 长度膨胀：原文 ≥4 字符且 译文长度 > max(原文×6, 60) → 失控。
 *      "只输出译文"约束下正常译文远达不到该倍率；短原文以 60 字符兜底防误伤。
 * 与数据清洗管线的通行做法一致（MT 语料清洗的长度比阈值 + 文档质量过滤的
 *   重复度规则），不引依赖，纯函数零副作用。
 */

/**
 * 判断译文是否为失控输出（退化重复/异常膨胀）
 * @param {string} text 渠道返回的译文
 * @param {string} [src] 原文（供长度膨胀规则比对，可省略）
 * @returns {boolean} true=判定失控，应作无效结果处理（换下一渠道/下一家）
 */
export function isRunawayText(text, src) {
  const t = String(text || '').trim();
  if (!t) return false;

  // 规则①：最长单字符连跑
  let run = 1;
  let maxRun = 1;
  for (let i = 1; i < t.length; i++) {
    run = (t[i] === t[i - 1]) ? run + 1 : 1;
    if (run > maxRun) maxRun = run;
  }
  if (maxRun >= 6 && t.length >= 12) return true;

  // 规则②：独特字符占比（按 UTF-16 码元计，emoji 密集串本就形似失控，误伤可忽略）
  if (t.length >= 24 && (new Set(t)).size / t.length < 0.25) return true;

  // 规则③：相对原文的长度膨胀
  const s = String(src || '').trim();
  if (s.length >= 4 && t.length > Math.max(s.length * 6, 60)) return true;

  return false;
}
