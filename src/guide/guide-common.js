// VocabRadar 引导页 功能栏 公共模块（ASR / OCR / Parser 共享基础设施）
// 反思（2026-08-20 第八十六次）：用户要求"asr-ocr.js 拆分为 asr.js + ocr.js + 公共模块"。
// 第二百五十三次（用户："asr-common.js 名实不符，改名"）：asr-common.js → guide-common.js——
//   本文件实为引导页功能栏（ASR/OCR，及后续 Parser）共享基础设施，并非 ASR 专属；
//   import 路径同步 guide.js/asr.js/ocr.js 三处。
//   本文件承载两者共用的：
//     - 模块状态 S（asr/recording/ocr 共用状态）
//     - 工具函数（log/toast/时间/转义/闪灯/随机短释义）
//     - 进度条、ASR 阶段名翻译
//     - 识别结果渲染（appendResult/renderHighlighted/注释 chips/展示注释结果汇总）
//     - 文件上传分发（onFileUpload：音视频→ASR 侧、图片→OCR 侧）
//   识别逻辑分属：asr.js（消息监听/文件ASR/录音录像录屏/麦克风授权）、
//   ocr.js（拍照/图片载入/文字识别）。
//   跨模块控制钩子：onFileUpload 需停 ASR/录制 → setAsrControls 注册（asr.js 提供），
//   避免 common ↔ asr 循环依赖（本文件不 import asr/ocr）。

import { t } from '../lib/i18n.js';
import { getAnnotations } from '../lib/annotator.js';
// 第二百二十五次：短义项选取统一收敛到 lib 版（原本地独立实现已漂移，见下方删除说明）
import { pickCleanShortTrans } from '../lib/dict-clean.js';
// 反思（2026-08-21 第九十二次）：引导页没有 startHint 等 await ensureReady 的入口，
//   快速识别（小文件）在词典装载完成前就推句/推侧栏 → 注释全落空
//   （用户反馈"asr 的结果视频侧栏并没有提取生词"）。识别与挂载前先 await 词典就绪。
import { ensureReady } from '../lib/dictionary.js';

export const $ = (id) => document.getElementById(id);

// 第一百八十次（2026-08-30）：原先这里有 ASR_FALLBACK_IFRAME 监听器，由引导页创建
//   隐藏 iframe 承载 Firefox 的 whisper 宿主。宿主已统一改建在后台 event page 自身
//   document 内（src/background/service-worker.js#ensureFallbackIframe），
//   无需页面侧参与，故整段删除（旧实现同样存在"超时也 resolve ok"的遮蔽错误问题）。

// === 引导页真实侧栏支持（2026-08-21 第八十九次）===
// 反思：用户要求"引导页面也有文本侧栏和视频侧栏——让文本侧栏和视频侧栏支持引导页，
//   这是最小工作量"。不新建任何侧栏 UI，直接复用两个真实侧栏组件：
//   - 视频侧栏（content/sidebar.js）：startSidebar 新增 options.mount 内联挂载到
//     ASR 标签页预览框右侧容器；识别句经既有 updateSubtitles 进入其字幕面板
//     （注释/生词表/练习标签全复用）。
//   - 文本侧栏（content/web-sidebar-impl.js）：按网页同款方式启动（悬浮球）；
//     OCR 识别行经单次扫描总线（page-scan-bus.emitBlock）喂入其"句"标签，
//     词条形状与 text-hint 推送完全一致（word/rank/tags/translations/lemma）。
let _guideSidebarMod = null;    // video-sidebar.js 模块引用（动态 import 单例）
let _videoSubsTimer = null;     // updateSubtitles 防抖（逐句到达，合并推送）

async function startGuideVideoSidebar() {
  try {
    // 2026-09-08 第二百四十次（用户批复"引导页后台咋还跑那么多"）：删第九十二次的
    //   await ensureReady() 词典预载——用户只在 OCR 标签页时不点视频侧栏注释，
    //   不该为挂侧栏预载整本词典（实测引导页冷装载 11.2s+ 网络拉词频）。
    //   改懒加载：首句注释时 L439 ensureReady().then(getAnnotations) 幂等触发
    //   （query.js loadPromise 缓存，重复调用安全），OCR-only 场景后台零词典工作。
    const mount = $('g-asr-sidebar-mount');
    const video = $('g-asr-video');
    if (!mount || !video) return;
    _guideSidebarMod = await import('../content/video-sidebar.js');
    await _guideSidebarMod.startSidebar(video, { mount });
    // 识别前先给空态提示（showNoSubtitle 接受普通文本）
    _guideSidebarMod.showNoSubtitle(t('ws.asrResultTip'));
    // 反思（2026-08-21 第八十九次）：时序兜底——侧栏加载期间用户可能已识别出句
    //   （pushVideoSubtitles 当时因模块未就绪而跳过），启动完成后补推一次。
    pushVideoSubtitles();
    log('视频侧栏已内联挂载到 ASR 标签页');
  } catch (e) {
    console.warn('[VocabRadar][guide] 视频侧栏启动失败:', e && e.message);
  }
}

async function startGuideWebSidebar() {
  try {
    const webMod = await import('../content/web-sidebar-impl.js');
    const settings = await new Promise((resolve) => {
      chrome.storage.local.get({
        rankThreshold: 5000,
        annotateOov: false,
        annotateRepeat: false,
        annotationStyle: 'none',
        webSidebarAnnMode: 'side'
      }, resolve);
    });
    await webMod.startWebSidebar(settings);
    log('文本侧栏已在引导页启动（悬浮球，OCR 结果经扫描总线喂入）');
  } catch (e) {
    console.warn('[VocabRadar][guide] 文本侧栏启动失败:', e && e.message);
  }
}

/** 启动引导页两侧栏（initAsrCommon 调用，fire-and-forget） */
export function startGuideSidebars() {
  startGuideVideoSidebar();
  startGuideWebSidebar();
}

/** 视频侧栏空态提示（识别完成无语音等场景，asr.js 调用） */
export function showVideoSidebarEmpty(msg) {
  if (!_guideSidebarMod) return;
  _guideSidebarMod.showNoSubtitle(msg || t('ws.asrResultTip'));
}

/** ASR 句增量推送（防抖）：把累积识别句喂给视频侧栏字幕面板 */
function pushVideoSubtitles() {
  if (!_guideSidebarMod) return;
  if (_videoSubsTimer) clearTimeout(_videoSubsTimer);
  _videoSubsTimer = setTimeout(() => {
    _videoSubsTimer = null;
    if (!_guideSidebarMod) return;
    const subs = S.asrResults.map((seg) => {
      const st = (typeof seg.start === 'number' && isFinite(seg.start)) ? seg.start : 0;
      return {
        start: st,
        end: (typeof seg.end === 'number' && isFinite(seg.end)) ? seg.end : (st + 2),
        text: seg.text || ''
      };
    }).filter((s) => s.text);
    if (subs.length === 0) {
      // 空态：显示提示而非空面板（识别完成无语音/清空结果时）
      _guideSidebarMod.showNoSubtitle(t('ws.asrResultTip'));
      return;
    }
    _guideSidebarMod.updateSubtitles(subs).catch(() => {});
  }, 300);
}

/** OCR 行喂入文本侧栏：经单次扫描总线 emitBlock（词条形状与 text-hint 推送一致）
 * 反思（2026-08-22 第九十三次）：带 all:true——整行必收（用户反馈"抓取的内容少，
 *   即便降低词频也无动于衷"：旧语义只收含生词的句子，OCR 常用词句子几乎全被丢弃）。
 *   生词提取展示由文本侧栏承担，无生词的行以纯文本句子收录。 */
function emitOcrBlock(text, anns) {
  import('../content/page-scan-bus.js').then(({ emitBlock }) => {
    try {
      emitBlock({
        text: text || '',
        all: true,
        words: (anns || []).map((a) => ({
          word: a.word,
          rank: a.rank,
          tags: a.tags || [],
          translations: a.translations || [],
          lemma: a.lemma || '',
          isFirst: true
        }))
      });
    } catch (e) { /* ignore */ }
  }).catch(() => {});
}

// === 模块状态 ===
export const S = {
  asrActive: false,
  asrAborted: false,
  asrSegCount: 0,
  asrTotalSegs: 0,
  videoKey: null,
  pendingResolve: null,
  msgListener: null,
  currentFile: null,          // {file, objectURL, kind}
  recordingActive: false,
  recordingKind: null,        // 'audio'|'video'|'screen'
  selectedRecKind: null,      // 单选选中的录制来源（radio value），null=未选
  recordingStream: null,
  recordingAudioCtx: null,
  recordingSourceNode: null,
  recordingProcessor: null,
  recordingSilenceGain: null,
  recordingSegTimer: null,
  recordingSegStart: 0,
  recordingPcmBuffer: [],
  recordingPcmLength: 0,
  recordingChunks: [],
  recordingMediaRecorder: null,
  recordingBlobUrl: null,
  recordingActiveBtn: null,
  // 反思（2026-08-20 第八十六次）：录音时被覆盖的提示区原始 HTML（含 data-key span，
  //   本地化文案随 fillByDataKey 保留），stopRecording 时恢复，修复"录完音后仍显示 🎙 录音中..."。
  recordingHintHtml: null,
  browserAsr: null,
  browserAsrFinalText: '',
  ocrRunning: false,
  asrResults: [],             // [{start,end,text}]
  ocrResults: [],             // [{text}]
  asrEls: [],
  ocrEls: [],
  // 反思（2026-08-16 第六十九次）：已注释生词汇总（结果栏下方"展示注释结果"块）——
  //   Map<word, {count, translations}>，随识别实时累计，count=该词被注释的次数。
  asrAnnWords: new Map(),
  ocrAnnWords: new Map(),
  rankThreshold: 5000,
  annotateOov: false,
  learnLang: 'en'
};

// === 工具 ===
export function log(...args) {
  console.log('[VocabRadar][guide]', ...args);
}

export function toast(msg, opts) {
  const o = opts || {};
  const el = document.createElement('div');
  el.className = 'g-toast' + (o.error ? ' error' : '');
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  const close = document.createElement('span');
  close.className = 'g-toast-close';
  close.textContent = '×';
  close.addEventListener('click', () => el.remove());
  el.appendChild(close);
  document.body.appendChild(el);
  // 反思（2026-08-15 第六十五次）：错误提示至少展示 5 秒；鼠标悬停/键盘焦点进入时
  //   计时暂停（不自动消失），离开后按剩余时间继续，便于读完报错信息。
  const dur = Math.max(o.duration || 2500, o.error ? 5000 : 0);
  let timer = null;
  let deadline = Date.now() + dur;
  let remaining = dur;
  function schedule(millis) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { try { el.remove(); } catch (e) { /* ignore */ } }, millis);
  }
  schedule(dur);
  el.addEventListener('mouseenter', () => {
    if (timer) clearTimeout(timer);
    remaining = Math.max(0, deadline - Date.now());
  });
  el.addEventListener('mouseleave', () => {
    deadline = Date.now() + remaining;
    schedule(remaining);
  });
  el.addEventListener('focusin', () => {
    if (timer) clearTimeout(timer);
    remaining = Math.max(0, deadline - Date.now());
  });
  el.addEventListener('focusout', () => {
    deadline = Date.now() + remaining;
    schedule(remaining);
  });
}

export function formatTime(sec) {
  if (sec == null || isNaN(sec)) return '0:00';
  const total = Math.max(0, Math.floor(sec));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function flashButton(btn) {
  if (!btn) return;
  const orig = btn.style.background;
  btn.style.background = 'var(--g-primary)';
  setTimeout(() => { btn.style.background = orig; }, 300);
}

// 第二百二十五次：删除本地独立实现 pickRandomShortTrans（《命名清查》裁定）——
//   原实现只按标点切片、不剥词性前缀，与 lib/dict-clean.js#pickCleanShortTrans 漂移
//   （project_summary 早有"须同步"约定，实际已不同步）。改为直接导入 lib 版统一口径。

// === ASR 阶段名翻译 ===
const STAGE_I18N_MAP = {
  'model加载': 'ws.stageModelLoading',
  '模型重试': 'ws.stageModelRetry',
  '识别段': 'ws.stageRecognizingSeg',
  'whisper未就绪': 'ws.stageWhisperNotReady',
  '识别结果': 'ws.stageRecognizeResult',
  '修正后为空': 'ws.stageCorrectedEmpty',
  'whisper失败': 'ws.stageWhisperFail',
  'start': 'ws.stageStart'
};
export function translateStage(stage) {
  if (!stage) return '';
  const key = STAGE_I18N_MAP[stage];
  return key ? t(key) : stage;
}

// === 进度条 ===
export function showAsrProgress(stage, detail) {
  const bar = $('g-asr-progress');
  if (bar) bar.style.display = '';
  const stageEl = $('g-asr-progress-stage');
  if (stageEl) stageEl.textContent = stage || '';
  const detailEl = $('g-asr-progress-detail');
  if (detailEl) detailEl.textContent = detail || '';
}
export function hideAsrProgress() {
  const bar = $('g-asr-progress');
  if (bar) bar.style.display = 'none';
}
export function updateAsrProgressFill(pct) {
  const safePct = (typeof pct === 'number' && isFinite(pct)) ? pct : 0;
  const fill = $('g-asr-progress-fill');
  if (fill) fill.style.width = Math.max(0, Math.min(100, safePct)) + '%';
}

// === 结果渲染（识别句子 + 生词释义） ===
// 高亮生词并插入 (释义) 行内注释，与网页侧栏 fillSlotAnnotations 同思路
export function renderHighlighted(text, anns) {
  if (!anns || anns.length === 0) return escapeHtml(text);
  const sorted = [...anns].sort((a, b) => b.word.length - a.word.length);
  let result = escapeHtml(text);
  const placeholders = [];
  for (const a of sorted) {
    const re = new RegExp(`\\b${escapeReg(a.word)}\\b`, 'i');
    const ph = `\x00${placeholders.length}\x00`;
    const shortTrans = pickCleanShortTrans(a.translations);
    let replacement = `<b class="g-w">${escapeHtml(a.word)}</b>`;
    if (shortTrans) replacement += `<span class="g-trans">(${escapeHtml(shortTrans)})</span>`;
    placeholders.push(replacement);
    result = result.replace(re, ph);
  }
  for (let i = 0; i < placeholders.length; i++) {
    result = result.split(`\x00${i}\x00`).join(placeholders[i]);
  }
  return result;
}

// 渲染注释 chips 行（每个生词一条）
export function renderAnnChips(anns) {
  if (!anns || anns.length === 0) return '';
  return anns.map((a) => {
    const trans = (a.translations && a.translations.length > 0)
      ? a.translations.join('；')
      : (a.pending ? t('ws.translating') : t('ws.noDef'));
    return `<span class="g-chip"><b class="g-w">${escapeHtml(a.word || '')}</b> ${escapeHtml(trans)}</span>`;
  }).join('');
}

// 把一批注释并入"展示注释结果"汇总 Map。
// 反思（2026-08-16 第六十九次）：count 只在句子级（.then）累计一次，异步翻译回调
//   （单词）只回填 translations 不累加，避免同一句子多次回调导致重复计数。
export function mergeAnnWords(kind, anns, incCount) {
  const words = (kind === 'asr') ? S.asrAnnWords : S.ocrAnnWords;
  if (!anns) return;
  for (const a of anns) {
    const lower = String(a.word || '').toLowerCase();
    if (!lower) continue;
    const prev = words.get(lower);
    if (prev) {
      if (incCount) prev.count++;
      if (a.translations && a.translations.length > 0) prev.translations = a.translations;
    } else {
      words.set(lower, { count: 1, translations: (a.translations || []).slice() });
    }
  }
}

// 渲染结果栏下方的"展示注释结果"汇总块（有词才显示，无词隐藏）
export function renderAnnSummary(kind) {
  const box = (kind === 'asr') ? $('g-asr-ann-summary') : $('g-ocr-ann-summary');
  const body = (kind === 'asr') ? $('g-asr-ann-summary-body') : $('g-ocr-ann-summary-body');
  if (!box || !body) return;
  const words = (kind === 'asr') ? S.asrAnnWords : S.ocrAnnWords;
  if (words.size === 0) {
    box.hidden = true;
    body.innerHTML = '';
    return;
  }
  box.hidden = false;
  const items = [...words.entries()].sort((a, b) => b[1].count - a[1].count);
  body.innerHTML = items.map(([w, info]) => {
    const trans = (info.translations && info.translations.length > 0)
      ? info.translations.join('；')
      : t('ws.noDef');
    return `<span class="g-chip"><b class="g-w">${escapeHtml(w)}</b> ${escapeHtml(trans)}<span class="g-chip-count">×${info.count}</span></span>`;
  }).join('');
}

export function clearResults(kind) {
  const results = (kind === 'asr') ? S.asrResults : S.ocrResults;
  const els = (kind === 'asr') ? S.asrEls : S.ocrEls;
  results.length = 0;
  els.length = 0;
  // 反思（2026-08-16 第六十九次）：清结果同时清空"展示注释结果"汇总
  const words = (kind === 'asr') ? S.asrAnnWords : S.ocrAnnWords;
  words.clear();
  renderAnnSummary(kind);
  // 反思（2026-08-21 第八十九次）：同步清真实侧栏——ASR 推空句列表给视频侧栏；
  //   OCR 重置扫描总线（文本侧栏收到 reset 清空句子等新一批）。
  if (kind === 'asr') {
    pushVideoSubtitles();
  } else {
    import('../content/page-scan-bus.js').then(({ resetScan }) => resetScan()).catch(() => {});
  }
  const box = (kind === 'asr') ? $('g-asr-results') : $('g-ocr-results');
  if (box) box.innerHTML = `<div class="g-empty-tip">${(kind === 'asr') ? t('ws.asrResultTip') : t('ws.ocrResultTip')}</div>`;
}

export function appendResult(kind, seg) {
  const results = (kind === 'asr') ? S.asrResults : S.ocrResults;
  const els = (kind === 'asr') ? S.asrEls : S.ocrEls;
  const box = (kind === 'asr') ? $('g-asr-results') : $('g-ocr-results');
  results.push(seg);
  // 反思（2026-08-21 第八十九次）：识别结果输入真实侧栏——ASR 句推视频侧栏字幕面板；
  //   OCR 行在注释就绪后经扫描总线推文本侧栏（见下方 .then 内）。
  //   ASR 标签页已移除扁平结果列表（结果展示在视频侧栏），box 可为 null，不再作前置返回。
  if (kind === 'asr') pushVideoSubtitles();
  if (!box) {
    // 无结果列表容器（ASR）：OCR 行仍需喂文本侧栏（无注释也推，侧栏按词条过滤句子）
    if (kind === 'ocr') emitOcrBlock(seg.text || '', []);
    return;
  }
  const emptyTip = box.querySelector('.g-empty-tip');
  if (emptyTip) emptyTip.remove();

  // 反思（2026-08-21 第九十一次）：OCR 行为纯文本——不渲染注释 chips 行
  //   （g-result-anns），生词注释以文本提示样式（生词(释义)行内高亮，
  //   renderHighlighted）直接作用于句子本身；"Annotated Words"汇总栏已删。
  const isOcr = (kind === 'ocr');
  const item = document.createElement('div');
  item.className = 'g-result-item';
  const hasTime = (typeof seg.start === 'number' && isFinite(seg.start) && seg.start > 0);
  item.innerHTML = `
    <div class="g-result-text">${hasTime ? `<span class="g-time">${formatTime(seg.start)} </span>` : ''}<span class="g-result-content">${escapeHtml(seg.text || '')}</span></div>
    ${isOcr ? '' : '<div class="g-result-anns"></div>'}
  `;
  box.appendChild(item);
  els.push(item);
  box.scrollTop = box.scrollHeight;

  // 用独立 seenSet 确保所有生词都被注释（不跳过已见词）
  const freshSeen = new Set();
  const contentSpan = item.querySelector('.g-result-content');
  const annsEl = item.querySelector('.g-result-anns');
  // 反思（2026-08-14 第五十四次修正）：annotateOov=false 时过滤表外词（rank=null），
  //   与文本提示/侧栏行为一致。
  const filterAnn = (arr) => (S.annotateOov ? (arr || []) : (arr || []).filter((a) => a.rank !== null));
  // 反思（2026-08-16 第六十九次）：句内已注释词缓存（含异步翻译回填），供"展示注释结果"汇总；
  //   同时修复旧回调引用未定义 anns 的隐患（异步单词回调按单条并入，不再整句清空重画）。
  let resolvedAnns = [];
  const applyAnnRender = () => {
    if (!item.isConnected) return;
    if (annsEl) annsEl.innerHTML = renderAnnChips(resolvedAnns);
    // 反思（2026-08-21 第九十二次）：OCR 行纯文本——不在行内画生词(释义)，
    //   提取生词是文本侧栏的活（注释仅用于喂扫描总线，见下方 emitOcrBlock）。
    if (!isOcr && contentSpan) contentSpan.innerHTML = renderHighlighted(seg.text || '', resolvedAnns);
  };
  // 反思（2026-08-21 第九十二次）：先 await 词典就绪再注释——引导页无其他装载入口，
  //   未就绪时 lookup 全走表外分支，生词提取落空（视频侧栏/文本侧栏均受影响）。
  ensureReady().catch(() => {}).then(() => getAnnotations(seg.text || '', S.rankThreshold, freshSeen, (ann) => {
    // 异步翻译完成后回填该句注释（单个单词）
    if (!ann) return;
    const single = filterAnn([ann]);
    if (single.length === 0) return;
    const lower = String(single[0].word || '').toLowerCase();
    resolvedAnns = resolvedAnns.filter((a) => String(a.word || '').toLowerCase() !== lower).concat(single);
    applyAnnRender();
    if (!isOcr) {
      mergeAnnWords(kind, single, false);
      renderAnnSummary(kind);
    }
  }, false).then((anns) => {
    if (!item.isConnected) return;
    resolvedAnns = filterAnn(anns);
    applyAnnRender();
    if (!isOcr) {
      // 次数只在句子级累计一次；异步单词回调只回填释义不累加
      mergeAnnWords(kind, resolvedAnns, true);
      renderAnnSummary(kind);
    }
    // 反思（2026-08-21 第八十九次）：OCR 行注释就绪后喂文本侧栏（经扫描总线）
    if (isOcr) emitOcrBlock(seg.text || '', resolvedAnns);
  }).catch((e) => log('句子注释失败:', e)));
}

// === 文件上传 ===
export function detectFileKind(file) {
  const mt = file.type || '';
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt.startsWith('image/')) return 'image';
  const ext = (file.name || '').split('.').pop().toLowerCase();
  if (['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(ext)) return 'image';
  return null;
}

export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + 'GB';
}

// 跨模块控制钩子（asr.js 注册 stopAsr/stopRecording，common 调用避免循环依赖）
const _asrControls = { stopAsr: null, stopRecording: null };
export function setAsrControls(ctl) {
  if (ctl && typeof ctl.stopAsr === 'function') _asrControls.stopAsr = ctl.stopAsr;
  if (ctl && typeof ctl.stopRecording === 'function') _asrControls.stopRecording = ctl.stopRecording;
}

export function onFileUpload(file) {
  if (S.asrActive && _asrControls.stopAsr) _asrControls.stopAsr();
  if (S.recordingActive && _asrControls.stopRecording) _asrControls.stopRecording();
  // 反思（2026-08-16 第七十一次）：⑨ 在线识别默认录音——上传文件不再清除录制来源单选
  //   （旧版 selectedRecKind=null + 取消 radio 勾选，导致再次点击"录制"默认值丢失、回到不确定态）。
  //   上传文件时保留来源选择：无文件默认录音（audio），有文件走 startAsr（离线 Whisper）。

  if (S.currentFile && S.currentFile.objectURL) {
    try { URL.revokeObjectURL(S.currentFile.objectURL); } catch (e) { /* ignore */ }
  }
  if (S.recordingBlobUrl) {
    try { URL.revokeObjectURL(S.recordingBlobUrl); } catch (e) { /* ignore */ }
    S.recordingBlobUrl = null;
  }

  const kind = detectFileKind(file);
  if (!kind) {
    toast(t('ws.unsupportedFileType'), { error: true });
    return;
  }

  const objectURL = URL.createObjectURL(file);
  S.currentFile = { file, objectURL, kind };

  const videoEl = $('g-asr-video');
  const imageEl = $('g-ocr-image');
  const asrHint = $('g-asr-hint');
  const ocrHint = $('g-ocr-hint');
  const asrInfo = $('g-asr-file-info');
  const ocrInfo = $('g-ocr-file-info');
  const asrBtn = $('g-asr-btn');
  const ocrBtn = $('g-ocr-btn');
  if (videoEl) videoEl.srcObject = null;

  if (kind === 'video' || kind === 'audio') {
    if (asrHint) asrHint.style.display = 'none';
    if (ocrHint) ocrHint.style.display = '';
    videoEl.src = objectURL;
    videoEl.style.display = '';
    imageEl.src = '';
    imageEl.style.display = 'none';
    asrInfo.textContent = `${file.name} (${formatFileSize(file.size)})`;
    asrBtn.disabled = false;
    asrBtn.textContent = '🎤 ' + t('ws.recognize');
    ocrBtn.disabled = true;
    clearResults('asr');
  } else if (kind === 'image') {
    if (ocrHint) ocrHint.style.display = 'none';
    if (asrHint) asrHint.style.display = '';
    imageEl.src = objectURL;
    imageEl.style.display = '';
    videoEl.src = '';
    videoEl.style.display = 'none';
    ocrInfo.textContent = `${file.name} (${formatFileSize(file.size)})`;
    asrBtn.disabled = true;
    ocrBtn.disabled = false;
    ocrBtn.textContent = '📷 ' + t('ws.recognize');
    clearResults('ocr');
  }
  log('文件已上传:', file.name, 'kind=', kind);
}

// === 初始化（公共部分：运行参数 + 上传按钮绑定） ===
export function initAsrCommon() {
  // 反思（2026-08-19 第八十次 / 2026-08-20 第八十二次更正）：不再在 init 时预热麦克风权限
  //   （hidden iframe 无用户手势，页面加载时即把授权弹框消耗掉，点按钮无感知）。
  //   改为点击「录制」按钮时（用户手势内）在主文档直接 getUserMedia（acquireMediaStream，见 asr.js）。
  //   前提：manifest 保留 audioCapture/videoCapture 权限（v82 已恢复）。

  // 读取运行参数（rank 阈值 / 注释开关 / 源语言）
  chrome.storage.local.get({
    rankThreshold: 5000,
    annotateOov: false,
    learnLanguage: 'en'
  }, (res) => {
    S.rankThreshold = (typeof res.rankThreshold === 'number' && !isNaN(res.rankThreshold)) ? res.rankThreshold : 5000;
    S.annotateOov = res.annotateOov === true;
    S.learnLang = res.learnLanguage || 'en';
  });

  // 反思（2026-08-22 第九十三次）：设置变更实时同步到本页——旧版只在页面加载读一次，
  //   用户在设定栏改词频阈值后不刷新页面即识别，注释仍按旧阈值（"降低词频也无动于衷"）。
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.rankThreshold && typeof changes.rankThreshold.newValue === 'number') {
        S.rankThreshold = changes.rankThreshold.newValue;
        log('词频阈值已同步:', S.rankThreshold);
      }
      if (changes.annotateOov && typeof changes.annotateOov.newValue === 'boolean') {
        S.annotateOov = changes.annotateOov.newValue;
        log('注释表外词已同步:', S.annotateOov);
      }
      if (changes.learnLanguage && typeof changes.learnLanguage.newValue === 'string') {
        S.learnLang = changes.learnLanguage.newValue;
        log('源语言已同步:', S.learnLang);
      }
    });
  } catch (e) { /* ignore */ }

  $('g-upload-av').addEventListener('click', () => $('g-av-input').click());
  $('g-av-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) onFileUpload(file);
    e.target.value = '';
  });
  $('g-upload-img').addEventListener('click', () => $('g-img-input').click());
  $('g-img-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) onFileUpload(file);
    e.target.value = '';
  });

  // 反思（2026-08-21 第八十九次）：启动引导页真实侧栏（视频侧栏内联挂载 + 文本侧栏悬浮球）
  startGuideSidebars();
}

export function disposeAsrCommon() {
  if (S.currentFile && S.currentFile.objectURL) {
    try { URL.revokeObjectURL(S.currentFile.objectURL); } catch (e) { /* ignore */ }
    S.currentFile = null;
  }
}