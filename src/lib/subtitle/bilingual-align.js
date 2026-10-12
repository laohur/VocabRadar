// =============================================================================
// subtitle/bilingual-align.js —— 双语两份字幕文件的时间轴对齐（D2）
// -----------------------------------------------------------------------------
// 职责：站上两份独立制作的字幕文件（主轨 + 释义语言第二轨）时间轴有偏差时的
//       配对算法，纯函数无 I/O，供 lib/bilingual-track.js 编排层调用。
// 算法（依据 video/docs/专题调研-双语字幕对齐.md §四）：
//   1) estimateOffset —— 4.1 全局偏移预校：网格搜索 ±20s（粗 0.5s → 细 0.05s
//      两级），目标函数 = 两轨成对区间重叠总量（双指针），平局偏向 0
//      （候选按 0,±d 顺序、严格大于才更新）。消掉"片头多几秒/剪辑点"这类固定
//      偏差，让逐行配对在无偏基线上进行。（不合并区间：轨内微重叠合并后会把
//      "齿对齿"的尖锐峰抹成平顶，真实字幕轨内基本不相交，成对求和即覆盖范围对齐度。）
//   2) prepareSecondary —— 副轨按 start 排序 + maxDur 预计算，产出配对索引。
//   3) pairSecondaryText —— 4.3 时间重叠法（学界字幕对齐最优解）：二分定位候选
//      窗（下界 = cue.start - offset - maxDur，超窗即断），取与主 cue 时间重叠
//      最大的副 cue 文本；配对门槛 min(1.5s, max(0.25s, 0.3×主cue时长))——
//      最大重叠都够不着门槛说明该主 cue 在副轨没有真对应行，返回 null 转实时翻译，
//      宁缺勿错配。副 cue 覆盖多条主 cue 时各主 cue 共用其全文（副行不配独立轴，
//      行业常态，见调研 §一类1/§二管线 _pair_secondary）。
// 关系：无依赖（叶子模块）；消费方 lib/bilingual-track.js。
// =============================================================================

/** cue 是否为可用的定时条目（start/end 数值且 start<=end） */
function validCue(c) {
  return c && isFinite(c.start) && isFinite(c.end) && c.end >= c.start && typeof c.text === 'string' && c.text.trim();
}

/** 按 start 升序拷贝（不改入参） */
function sortedCopy(list) {
  return (Array.isArray(list) ? list : [])
    .filter(validCue)
    .map((c) => ({ start: c.start, end: c.end, text: c.text }))
    .sort((a, b) => a.start - b.start);
}

/**
 * 两轨在给定偏移下的区间总重叠量（双指针，两入参须按 start 升序）。
 * @param {Array<{start,end}>} main 已排序主轨
 * @param {Array<{start,end}>} sec 已排序副轨
 * @param {number} off 加到副轨的偏移（秒）
 */
function totalOverlap(main, sec, off) {
  let i = 0, j = 0, total = 0;
  while (i < main.length && j < sec.length) {
    const m = main[i], s = sec[j];
    const ov = Math.min(m.end, s.end + off) - Math.max(m.start, s.start + off);
    if (ov > 0) total += ov;
    if (m.end <= s.end + off) i++; else j++;
  }
  return total;
}

/**
 * 估计全局偏移（秒）：应加到副轨上与主轨对齐的固定偏移。
 * 主/副任一为空 → 0（无信号不硬猜）。
 * @param {Array<{start,end}>} mainCues 主轨（当前显示字幕，未排序亦可）
 * @param {Array<{start,end}>} secCues 副轨（第二语言字幕）
 * @param {{maxOffset?:number}} [opts] 搜索半径，默认 ±20s
 * @returns {number}
 */
export function estimateOffset(mainCues, secCues, opts = {}) {
  const maxOffset = isFinite(opts.maxOffset) ? Math.abs(opts.maxOffset) : 20;
  const main = sortedCopy(mainCues);
  const sec = sortedCopy(secCues);
  if (main.length === 0 || sec.length === 0) return 0;

  // 候选顺序 0, +d, -d, +2d, -2d…（严格大于才更新 → 平局偏向 0/小偏移）
  const build = (step, radius) => {
    const list = [0];
    for (let k = step; k <= radius + 1e-9; k += step) {
      list.push(+k.toFixed(3), +(-k).toFixed(3));
    }
    return list;
  };

  // 粗搜：0.5s 步进、全半径
  let best = 0, bestScore = totalOverlap(main, sec, 0);
  for (const s of build(0.5, maxOffset)) {
    if (s === 0) continue;
    const score = totalOverlap(main, sec, s);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  // 细搜：0.05s 步进、粗搜结果 ±0.5s 邻域
  for (const s of build(0.05, 0.5)) {
    const cand = +(best + s).toFixed(3);
    if (Math.abs(cand) > maxOffset) continue;
    const score = totalOverlap(main, sec, cand);
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  return best;
}

/**
 * 构建副轨配对索引。
 * @param {Array<{start,end,text}>} secCues 副轨条目
 * @param {number} [offset=0] 已估全局偏移（秒，加到副轨）
 * @returns {{cues:Array<{start,end,text}>, offset:number, maxDur:number}|null} 空轨返回 null
 */
export function prepareSecondary(secCues, offset = 0) {
  const cues = sortedCopy(secCues);
  if (cues.length === 0) return null;
  let maxDur = 0;
  for (const c of cues) maxDur = Math.max(maxDur, c.end - c.start);
  return { cues, offset: isFinite(offset) ? offset : 0, maxDur };
}

/**
 * 为一条主 cue 配副行文本（时间重叠最大者）。
 * @param {{start:number,end:number}} cue 主 cue
 * @param {{cues:Array, offset:number, maxDur:number}} prepared prepareSecondary 产物
 * @returns {string|null} 副行文本；配不上/门槛不足 → null（调用方转实时翻译）
 */
export function pairSecondaryText(cue, prepared) {
  if (!prepared || !cue || !isFinite(cue.start) || !isFinite(cue.end) || cue.end <= cue.start) return null;
  const { cues, offset, maxDur } = prepared;
  if (!cues || cues.length === 0) return null;

  // 二分下界：与主 cue 可能相交的副 cue 必须 start+maxDur > cue.start（平移后）
  const bound = cue.start - offset - maxDur;
  let lo = 0, hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cues[mid].start < bound) lo = mid + 1; else hi = mid;
  }

  let best = null, bestOv = 0;
  for (let i = lo; i < cues.length; i++) {
    const c = cues[i];
    const cs = c.start + offset;
    if (cs >= cue.end) break;                 // 后续全在主 cue 之后（按 start 有序）
    const ov = Math.min(cue.end, c.end + offset) - Math.max(cue.start, cs);
    if (ov > bestOv) { bestOv = ov; best = c; }
  }
  if (!best) return null;

  // 配对门槛：小 cue 至少覆盖 30%（下限 0.25s），长 cue 至少 1.5s——
  //   最大重叠都够不着 = 副轨无真对应行，宁缺勿错配。
  const mainDur = cue.end - cue.start;
  const thr = Math.min(1.5, Math.max(0.25, 0.3 * mainDur));
  if (bestOv < thr) return null;

  const text = String(best.text || '').trim();
  return text || null;
}
