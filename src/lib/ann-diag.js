// 第三百七十次：字幕注释诊断记录器（方案A·诊断悬浮窗数据源）。
// 是啥：content 页内轻量环形缓冲，集中记录「词典装载 / 字幕时间线 / 每句注释统计 /
//   翻译通道」四路运行时证据；诊断悬浮窗「字幕」标签经 window.__beaverAnnDiag() 读取。
// 有啥用：定位用户报障「字幕没注释 + 字幕很晚才出现」——
//   ①词典何时就绪、是否空包假就绪（rebuild-empty 事件）
//   ②每条字幕 上屏时刻/算注耗时/词典就绪与否（字幕晚到卡在哪段）
//   ③每句 词数/seen跳过/高频跳过/产出/pending（0 注释是被跳过还是被翻译拖住）
//   ④每次翻译 成败/耗时（翻译通道是否阻塞）。
// 谁上报：projection.js（词典事件+快照）、annotator.js（每句统计+翻译结果）、
//   subtitle-overlay.js（字幕上屏/算注时间线）。
// 设计：纯内存、环形 100 条封顶（丢最旧）、零网络零存储；无数据时诊断窗显示空态。
//   不接 diagLog 阀门：record 调用是对象字面量+数组 push（热路径微开销，与 console
//   模板串构造不可比）；且本记录器正是为默认关日志的打包版取证而生。

const CAP = 100;

const state = {
  page: '',
  dictEvents: [],   // [{t, ev, ...detail}] 词典/词频关键事件
  dictSnap: null,   // 最新词典快照 {t, lang, loaded, size, rebuild}
  subtitles: [],    // [{t, phase:'show'|'ann', start, text, dictReady, cached, out, pending, ms}]
  lines: [],        // [{t, text, words, skipSeen, skipHigh, out, pending, dictReady, ms}]
  translates: [],   // [{t, word, ok, ms, err}]
  // 第三百七十二次：渲染层记录——计算层（getAnnotations）产出 out>0 但侧栏仍无高亮时，
  //   需要区分「译文过滤掉」/「阈值过滤掉」/「noAnn 开关」三段漏斗，旧版无渲染层证据。
  renders: [],      // [{t, text, noAnn, detail, raw, valid, shown}]（vs/subtitle-renderer fillSlotAnnotations 上报）
  // 第三百七十三次：每句统计全页聚合——lines 环形 100 条在长视频（几百句渲染）下
  //   正常句明细被 [music] 类噪音句挤出（用户复测 100 句全词0，「有词 0 句」无法区分
  //   「数据本来就是噪音」还是「正常句被挤出视野」）。聚合计数不受 CAP 挤占，
  //   一次看清全页有词句总量——有词句>0 而明细里看不见=挤出实锤；=0=数据源全是噪音。
  agg: { total: 0, withWords: 0, outPos: 0, pendingPos: 0 }
};

function now() { return Date.now(); }
function push(arr, rec) {
  arr.push(rec);
  if (arr.length > CAP) arr.splice(0, arr.length - CAP);
}

/** 词典/词频事件（projection 装载链路上报：wf-ok/wf-empty/rebuild-done/rebuild-empty 等） */
export function reportDictEvent(ev, detail) {
  try { push(state.dictEvents, { t: now(), ev, ...(detail || {}) }); } catch (_) {}
}

/** 词典状态快照（loadPromise 落定时整体覆盖，诊断窗只看最新态） */
export function reportDictSnap(snap) {
  try { state.dictSnap = { t: now(), ...(snap || {}) }; } catch (_) {}
}

/** 字幕时间线（overlay 上屏 phase='show' / 算注完成 phase='ann'） */
export function reportSubtitle(rec) {
  try { push(state.subtitles, { t: now(), ...(rec || {}) }); } catch (_) {}
}

/** 每句注释统计（annotator getAnnotations 尾部上报） */
export function reportLine(rec) {
  try {
    const r = rec || {};
    push(state.lines, { t: now(), ...r });
    // 第三百七十三次：全页聚合（与环形明细并行累加，Reset 时清零）
    const a = state.agg;
    a.total++;
    if (r.words > 0) a.withWords++;
    if (r.out > 0) a.outPos++;
    if (r.pending > 0) a.pendingPos++;
  } catch (_) {}
}

/** 单词翻译结果（annotator translate 包装上报，ok/err/ms） */
export function reportTranslate(rec) {
  try { push(state.translates, { t: now(), ...(rec || {}) }); } catch (_) {}
}

/** 渲染层漏斗（第三百七十二次：侧栏 fillSlotAnnotations 上报，raw/valid/shown 三段递减） */
export function reportRender(rec) {
  try { push(state.renders, { t: now(), ...(rec || {}) }); } catch (_) {}
}

/** 汇总导出（诊断悬浮窗 window.__beaverAnnDiag() 读取） */
export function getAnnDiag() {
  try {
    if (!state.page && typeof location !== 'undefined') state.page = location.href.slice(0, 120);
    return {
      page: state.page,
      now: now(),
      dictSnap: state.dictSnap,
      dictEvents: state.dictEvents.slice(),
      subtitles: state.subtitles.slice(),
      lines: state.lines.slice(),
      linesAgg: { ...state.agg },
      translates: state.translates.slice(),
      renders: state.renders.slice()
    };
  } catch (e) {
    return { error: String(e && e.message) };
  }
}

if (typeof window !== 'undefined') {
  window.__beaverAnnDiag = getAnnDiag;
  // 第三百七十次：诊断窗「清空」入口——取证可重复（点一次清零重新累积）。
  window.__beaverAnnDiagReset = function () {
    state.dictEvents.length = 0; state.dictSnap = null; state.subtitles.length = 0;
    state.lines.length = 0; state.translates.length = 0; state.renders.length = 0;
    state.agg = { total: 0, withWords: 0, outPos: 0, pendingPos: 0 };
  };
}
