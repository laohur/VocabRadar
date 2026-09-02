// VocabRadar 全站网页侧栏 content script（ES module）—— 门面（facade）
// 职责：只保留对外的启停与设置接口（导出集合与拆分前完全一致，外部引用方零改动），
//       具体实现已机械拆分至 ./ws/core.js（共享状态与工具）、./ws/scanner.js（扫描与渲染）、
//       ./ws/ui.js（DOM 与交互）。
// VocabRadar 全站网页侧栏 content script（ES module）
//
// 注入位置：所有网页右侧 position:fixed（与视频提示 #beaver-sidebar 不冲突，
//   本模块使用 #beaver-web-sidebar）。
//
// 反思（2026-08-13 第五十三次）：ASR/OCR 功能已整体迁移到引导页功能栏（src/guide/asr.js / ocr.js），
//   本侧栏只保留 句/词 两个标签（页面文本句子 + 生词表），不再承载上传/录音/录屏/拍照识别。
//
// 结构：折叠球 → 展开后：
//   标题栏(🦫 VocabRadar + 🌐语言 + 收起/关闭)
//   → 标签页(句/词汇)
//   → 工具栏(注释/详细 / 词单)
//   → 标签面板内容区（滚动）
//
// 句标签（主功能）：查询 text-hint 生成的 .beaver-word span → 按句子分组 →
//   非阻塞 getAnnotations 获取生词 → 仅显示含生词的句子；无 span 时 TreeWalker fallback。
//
// 词汇标签：从页面句子收集的生词表。

import { rankToStage, getAnnotations } from '../lib/annotator.js';
// 第二百次：侧栏词典自足——词典装载此前只挂在 text-hint startHint 身上，text-hint
//   一旦启动失败（如 Firefox 上 bundle 链路断裂），侧栏兜底扫描的 getAnnotations
//   全部按表外词处理 → 词表永远为空。此处 fire-and-forget 预热，不阻塞启动。
import { ensureReady } from '../lib/dictionary.js';
import { getPhonetic } from '../lib/phonetics.js';
import { translate } from '../lib/translator.js';
import { TRANSLATE_LANGS, UI_LANGS, LANG_NAMES, t, initLang, setLang, getLang, onLangChange } from '../lib/i18n.js';
// 反思（2026-08-15 第六十四次）：字幕样式类名由元数据生成，避免硬编码白名单漏项
//   （旧版漏掉 bottom-up-white/big-bottom 等 → 选中样式不生效 → 默认半透明黑底）。
import { SUBTITLE_TEXT_STYLES, findStyle } from '../lib/styles.js';
// 反思（2026-08-16 第六十六次）：释义清洗 + 干净短义项选取（去除"原形(释义)的屈折说明"夹杂）
import { pickCleanShortTrans, isBalancedParens } from '../lib/dict-clean.js';
// 第一百二十四次：顶行统一构建器——视频/文本侧栏共用同一代码文件（用户裁定）
import { buildTopbarHTML, ensureTopbarCss } from '../lib/sidebar-topbar.js';
// 反思（2026-08-16 第七十一次）：单次扫描总线——text-hint 是页面唯一扫描器，
//   本侧栏订阅 page-scan-bus 消费扫描结果，不再 querySelectorAll('.beaver-word') 二次扫描
//   （旧版两个 content script 各扫一遍：日志出现两条"页面扫描"，且时序不一致）。
//   text-hint 未产出时侧栏才回退到旧路径（DOM span / 独立 TreeWalker 扫描）。
//   （①：二者用一个扫描，任意一方开关都不影响；总线保留全部历史块供侧栏启动晚时回放。）
import { subscribe, getBlocks, getLastEmitAt } from './page-scan-bus.js';
// 召唤视频侧栏（2026-08-20 第八十六次补充③）：悬浮球右键 / 顶行按钮手动启动视频侧栏。
// 与 generic.js/bilibili.js/youtube.js 动态 import 同一模块实例（同隔离世界模块缓存），
// startVideoController 的 _started 守卫保证重复调用幂等。
import { startVideoController, reviveSidebarIfPossible } from './video-controller.js';

// === 拆分后的实现模块 ===
import { _allAnnotations, _annotateOov, _annotateRepeat, _annotationsCache, _collectedSubs, _detailMode, _pageSentenceEls, _pageSentences, _panelRect, _preExpandPos, _rankThreshold, _root, _scanScheduled, _seenSentences, _seenWords, _wordOnlyMode, applyAnnStyle, applyColors, clampPosToViewport, clampRectToViewport, getInjectionRoot, log, set_allAnnotations, set_annotateOov, set_annotateRepeat, set_annotationsCache, set_collectedSubs, set_detailMode, set_firstSentMap, set_pageSentenceEls, set_pageSentences, set_panelRect, set_preExpandPos, set_rankThreshold, set_root, set_scanScheduled, set_seenSentences, set_seenWords, set_wordOnlyMode, ts } from './ws/core.js';
import { clearPageSentences, ensureScanBusSubscribed, schedulePageScan, startScrollListener, stopScrollListener } from './ws/scanner.js';
import { bindEvents, buildSidebar, collapse, ensureBallSync, expand, injectCSS, injectCriticalCSS, setupReinjectObserver, syncBallWithVideoSidebar } from './ws/ui.js';

let _settings = null;              // 当前设置

// 侧栏注释样式热更新入口（web-sidebar.js storage 监听调用）
export function updateAnnStyle(styleId) {
  applyAnnStyle(styleId);
}

// === 启停接口 ===
// 第一百二十三次：形态切换监听只挂一次的模块级标记
let _formSwitchWired = false;

export async function startWebSidebar(settings) {
  if (_root) {
    _settings = settings || _settings;
  applyColors(_settings);

  // 反思（2026-08-21 第八十九次）：总线订阅提为两路径共用的 ensureScanBusSubscribed()
  //   （旧版仅本分支订阅，首次启动不订阅，实时块会丢）。
  ensureScanBusSubscribed();

    applyAnnStyle(_settings.annotationStyle);
    return;
  }
  // 反思（2026-08-07）：初始化 i18n，使 t() 返回界面语言对应文案（不再硬编码中文）
  initLang().catch(() => { /* ignore */ });
  _settings = settings || {};
  set_rankThreshold((_settings.rankThreshold != null) ? _settings.rankThreshold : 5000);
  set_annotateOov((_settings.annotateOov != null) ? _settings.annotateOov : false);
  // 注释重复生词（2026-08-15 第六十二次：默认不选，同一段文本内重复词仅注释首次）
  set_annotateRepeat((_settings.annotateRepeat != null) ? _settings.annotateRepeat : false);
  // 从 storage 读取注释模式（引导页 radio 或 Detail 按钮写入）
  const annMode = _settings.webSidebarAnnMode || 'side';
  set_detailMode((annMode === 'detail'));

  // 反思（2026-08-12 第四十四次）：用户反馈"Bing 等网站悬浮球缺失"。
  //   根因：部分网站 document_idle 时 body 尚未就绪或被框架替换，
  //   document.body.appendChild 抛异常导致整个 startWebSidebar 中断，悬浮球无法注入。
  //   修正：等待 body 就绪后再注入，超时回退到 document.documentElement。
  set_root(buildSidebar());
  // 反思（2026-08-13 第五十次）：应用引导页选择的侧栏注释样式（root class）
  applyAnnStyle(_settings.annotationStyle);
  // 反思（2026-08-10）：构建后立即加 collapsed class，确保首次 ballRect 为 48x48。
  _root.classList.add('collapsed');
  // 反思（2026-08-07 修正）：用同步 <style> 注入关键 CSS，不依赖 <link> onload。
  injectCriticalCSS();
  injectCSS();
  // 第一百二十四次：统一顶行样式（sidebar-topbar.js 唯一来源，幂等）
  try { ensureTopbarCss(); } catch (e) { /* ignore */ }
  // 反思（2026-08-12 第四十六次）：始终注入到 document.documentElement，
  //   不依赖 body（Bing 等 SPA 会替换 body 导致悬浮球丢失）
  if (!_root) return; // stopWebSidebar 可能在等待中被调用
  try {
    getInjectionRoot().appendChild(_root);
    log('[' + ts() + '] 悬浮球已注入到', getInjectionRoot().tagName, '@', location.href);
  } catch (e) {
    console.error('[VocabRadar][web-sidebar] appendChild 失败:', e);
    // 兜底：尝试直接 append 到 html
    try { document.documentElement.appendChild(_root); } catch (e2) { console.error('[VocabRadar][web-sidebar] 兜底注入也失败:', e2); return; }
  }
  // MutationObserver：监听 _root 被移除时自动重新注入（Bing 等 SPA 会清除未知 DOM）
  setupReinjectObserver();
  try {
    bindEvents();
  } catch (e) {
    console.error('[VocabRadar][web-sidebar] bindEvents 出错（侧栏仍可见）:', e);
  }
  applyColors(_settings);

  // 第一百二十二次：接收视频侧栏 📄 的"切换到文本形态"请求（beaver-toggle-form）。
  // 模块级防重复：startWebSidebar 可能因设置变化多次调用，但 _root 复用，监听只挂一次。
  if (!_formSwitchWired) {
    _formSwitchWired = true;
    window.addEventListener('beaver-toggle-form', (e) => {
      if (!_root || !e || !e.detail || e.detail.to !== 'text') return;
      console.log('[VocabRadar][web-sidebar] 收到形态切换请求 → 展开文本侧栏 @', location.href);
      expand(e.detail.anchor || null);
    });
    // 第一百二十五次：视频侧栏出现即隐藏悬浮球（即时，不等轮询）
    window.addEventListener('beaver-video-sidebar-visible', () => {
      try { syncBallWithVideoSidebar(); } catch (e) { /* ignore */ }
    });
  }

  // 反思（2026-08-13 第五十次）：rank input 已移除（(16) 移入引导页），此处不再同步 input.value。
  // 反思（2026-08-10）：用户反馈"刷新页面后文本侧栏位置变动"。
  //   根因：restoreDraggedPosition（bindEvents 中异步）与 loadState().then(expand/collapse)
  //   两个异步操作竞态：若 loadState 先完成，expand/collapse 基于错误 ballRect 计算位置，
  //   随后 restoreDraggedPosition 又覆盖位置 → 位置跳动。
  //   修正：合并为单个 async 流程——先读位置和状态，先应用位置，再按状态 expand/collapse。
  (async () => {
    // 第一百三十四次：一次读两键——球位（webSidebarPos）+ 面板矩形（shellRectText）
    // 第一百八十七次：两者统一为 **视口坐标**（position:fixed），旧 docX/docY 仅兼容读取
    const [posRes, rectRes] = await new Promise((resolve) => {
      try {
        chrome.storage.local.get(['webSidebarPos', 'shellRectText'], (res) => resolve([res.webSidebarPos || null, res.shellRectText || null]));
      } catch (e) { resolve([null, null]); }
    });
    if (!_root) return; // stopWebSidebar 可能在异步等待中被调用
    // 第一百八十七次（用户："侧栏位置乱跑"）：注水口径改为 **视口坐标优先**。
    //   反思：#beaver-web-sidebar 是 position:fixed，定位基准就是视口，与文档滚动无关。
    //   旧版把存的 docX/docY 再减 **当前** 滚动量，而刷新后滚动量几乎必然与保存时不同
    //   （浏览器恢复滚动、锚点跳转、懒加载撑高），算出的 left/top 与保存时完全不同 ——
    //   这就是位置乱跑的第一因。新数据只有 left/top；docX/docY 仅为读旧数据兼容。
    if (rectRes) {
      const hasVp = Number.isFinite(rectRes.left) && Number.isFinite(rectRes.top);
      const hasDoc = Number.isFinite(rectRes.docX) && Number.isFinite(rectRes.docY);
      if (hasVp || hasDoc) {
        const w = Math.max(280, Math.min(rectRes.width || 420, window.innerWidth - 16));
        const h = Math.max(220, Math.min(rectRes.height || 560, window.innerHeight - 16));
        // 第一百九十六次（用户："火狐中文本框初始打开矮"）：CSS 默认高度是
        //   min(760px, 100vh-24px) 并不矮——矮只可能来自 shellRectText 存的旧矩形
        //   （Firefox 档案独立于 Chrome，旧口径/异常时刻保存的矮矩形会每次刷新
        //   首次展开都恢复出来，钳位下限 220 救不回来）。高度 <400px 视为坏档丢弃，
        //   回落 CSS 默认；用户正常拖拽/调整过的尺寸（≥400）不受影响。
        if (h < 400) {
          console.warn('[VocabRadar][web-sidebar] 忽略过矮的历史面板矩形（高度 '
            + h + ' < 400，疑似坏档），本次展开回落默认尺寸；拖拽调整一次即覆盖旧档');
        } else {
          const rawL = hasVp ? rectRes.left : rectRes.docX - window.scrollX;
          const rawT = hasVp ? rectRes.top : rectRes.docY - window.scrollY;
          // 按面板自身宽高夹取（不是 48px 球口径），保证整块面板留在视口内
          const pr = clampRectToViewport(rawL, rawT, w, h);
          set_panelRect({ left: pr.left, top: pr.top, width: w, height: h });
        }
      }
    }
    // 反思（2026-08-13 第四十七次）：用户要求"位置固定，刷新不动"。
    //   先加 dragged 类并设内联位置，再 collapse。
    //   collapse() 检测到 dragged 类 → 用 _preExpandPos 恢复位置。
    // 反思（2026-08-22 第九十四次）：恢复前夹取到当前视口——跨页面/跨视口残留位置
    //   可能把球定位到屏幕外（用户反馈"过一会儿文本侧栏消失"）。
    if (posRes) {
      // 第一百三十七次：{0,0} 视为历史 bug 固化的脏数据（隐藏态 collapse 保存的全零
      //   rect），忽略并回落 CSS 默认右上角——否则老用户 storage 里已有的 0,0 会
      //   继续把球钉在左上角。
      const zeroDirty = Number.isFinite(posRes.left) || Number.isFinite(posRes.top)
        ? (!posRes.left && !posRes.top)
        : (!posRes.docX && !posRes.docY);
      // 第一百八十七次：球位同样 **视口坐标优先**（position:fixed 与滚动无关），
      //   docX/docY 仅兼容旧数据；旧口径减当前滚动量会把球甩出视口 → 位置乱跑。
      const rawLeft = Number.isFinite(posRes.left) ? posRes.left : posRes.docX - window.scrollX;
      const rawTop = Number.isFinite(posRes.top) ? posRes.top : posRes.docY - window.scrollY;
      if (zeroDirty) {
        console.warn('[VocabRadar][web-sidebar] 检测到 {0,0} 脏位置（历史隐藏态误存），忽略并回落默认右上角');
      } else {
        const p = clampPosToViewport(rawLeft, rawTop);
        _root.classList.add('dragged');
        _root.style.setProperty('left', p.left + 'px', 'important');
        _root.style.setProperty('top', p.top + 'px', 'important');
        _root.style.setProperty('right', 'auto', 'important');
        _root.style.setProperty('bottom', 'auto', 'important');
        _root.style.transform = 'none';
        set_preExpandPos(p);  // 供 collapse() 恢复
      }
    }
    // 反思（2026-08-13 第五十次）：用户要求"悬浮球应当默认有且不展开"。
    //   旧版 loadState 恢复上次展开状态，刷新页面后侧栏自动展开，违背用户预期。
    //   修正：默认始终折叠为悬浮球，展开仅由用户当前会话手动触发。
    collapse();
  })();

  // 启动滚动监听
  startScrollListener();

  // 第一百二十三次：三形态互斥显示轮询
  ensureBallSync();
  // 第一百二十五次：启动即刻同步一次（视频侧栏先于文本侧栏启动的竞态）
  try { syncBallWithVideoSidebar(); } catch (e) { /* ignore */ }

  // 反思（2026-08-21 第八十九次）：首次启动也订阅扫描总线 + 回放历史块
  //   （引导页 OCR 在侧栏启动前后的识别行都能实时进入"句"标签）
  ensureScanBusSubscribed();

  // 第二百次：词典自足预热（fire-and-forget）——text-hint 死亡时侧栏兜底扫描也拿得到 rank/lemma
  try { ensureReady().catch(() => { /* 装载失败静默，查询侧有降级 */ }); } catch (_) { /* ignore */ }

  // 反思（2026-08-17 第七十二次补充）：删除词典预热——词典仅由 text-hint startHint
  //   按需 await loadDictionary() 加载一次（singleton），web-sidebar 不再重复触发。

  log('已启动 @', location.href);
}

export function stopWebSidebar() {
  stopScrollListener();
  if (_root) {
    _root.remove();
    set_root(null);
  }
  set_pageSentences([]);
  set_pageSentenceEls([]);
  set_allAnnotations([]);
  set_seenWords(new Set());
  set_seenSentences(new Set());
  // 第一百九十三次：页级首现句权威表随页级数据一并清空（与 onScanBusReset 同步）
  set_firstSentMap(new Map());
  set_annotationsCache(new Map());
  set_collectedSubs(new WeakSet());
  set_wordOnlyMode(false);
  set_scanScheduled(false);
  log('已停止');
}

// 设置变化热更新接口
export function setRankThreshold(n) {
  set_rankThreshold((typeof n === 'number' && !isNaN(n)) ? n : 5000);
  // 反思（2026-08-13 第五十次）：rank input 已移除，无需同步 input.value。
  // 反思（2026-08-07）：不调用 onRankChange（会导致 storage 循环写入）。
  //   直接清缓存重扫，onRankChange 中已有 chrome.storage.local.set。
  _annotationsCache.clear();
  // 第一百九十三次：阈值/表外/重复三开关都会清库重扫，页级首现句权威表必须同步清空，
  //   否则残留的首现句定格会让重扫后的渲染沿用旧句归属（跨开关状态的脏数据）。
  set_firstSentMap(new Map());
  set_collectedSubs(new WeakSet());
  set_seenWords(new Set());
  set_seenSentences(new Set());
  set_allAnnotations([]);
  clearPageSentences();
  if (_root) {
    const wp = _root.querySelector('#beaver-web-word-panel');
    if (wp) wp.innerHTML = `<div class="beaver-web-empty-tip">${t('ws.noWords')}</div>`;
  }
  schedulePageScan();
}

export function setAnnotateOov(b) {
  set_annotateOov(!!b);
  // 反思（2026-08-14 第五十四次修正）：原 setLocalTranslateEnabled 只改标志不重扫，
  //   导致切换后网页侧栏不同步。改为清缓存重扫，与 setRankThreshold 一致。
  _annotationsCache.clear();
  // 第一百九十三次：阈值/表外/重复三开关都会清库重扫，页级首现句权威表必须同步清空，
  //   否则残留的首现句定格会让重扫后的渲染沿用旧句归属（跨开关状态的脏数据）。
  set_firstSentMap(new Map());
  set_collectedSubs(new WeakSet());
  set_seenWords(new Set());
  set_seenSentences(new Set());
  set_allAnnotations([]);
  clearPageSentences();
  if (_root) {
    const wp = _root.querySelector('#beaver-web-word-panel');
    if (wp) wp.innerHTML = `<div class="beaver-web-empty-tip">${t('ws.noWords')}</div>`;
  }
  schedulePageScan();
}

// 注释重复生词开关（2026-08-15 第六十二次）：清缓存重扫，按新值重渲句子注释
export function setAnnotateRepeat(b) {
  set_annotateRepeat(!!b);
  _annotationsCache.clear();
  // 第一百九十三次：阈值/表外/重复三开关都会清库重扫，页级首现句权威表必须同步清空，
  //   否则残留的首现句定格会让重扫后的渲染沿用旧句归属（跨开关状态的脏数据）。
  set_firstSentMap(new Map());
  set_collectedSubs(new WeakSet());
  set_seenWords(new Set());
  set_seenSentences(new Set());
  set_allAnnotations([]);
  clearPageSentences();
  if (_root) {
    const wp = _root.querySelector('#beaver-web-word-panel');
    if (wp) wp.innerHTML = `<div class="beaver-web-empty-tip">${t('ws.noWords')}</div>`;
  }
  schedulePageScan();
}

// 反思（2026-08-07）：语言设置同步——全局 storage 变化时更新选择器
export function updateLanguages(settings) {
  if (!_root) return;
  const src = _root.querySelector('#beaver-web-source-lang');
  const tgt = _root.querySelector('#beaver-web-target-lang');
  if (src && settings.sourceLanguage) src.value = settings.sourceLanguage;
  if (tgt && settings.targetLanguage) tgt.value = settings.targetLanguage;
}

export function updateColors(settings) {
  _settings = settings || _settings;
  applyColors(_settings);
}

/**
 * 诊断信息（2026-08-14 第五十四次）：供诊断悬浮窗展示网页侧栏运行状态
 */
export function getDiagState() {
  return {
    started: !!_root,
    rankThreshold: _rankThreshold,
    annotateOov: _annotateOov,
    annotateRepeat: _annotateRepeat,
    collected: _allAnnotations ? _allAnnotations.length : 0,
    seenWords: _seenWords ? _seenWords.size : 0,
    annotationCache: _annotationsCache ? _annotationsCache.size : 0,
    rootInjected: !!(_root && _root.isConnected)
  };
}
