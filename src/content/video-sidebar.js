// VocabRadar 视频提示 content script
//
// 注入位置：B站视频页右侧 .right-container 内部顶部。作为文档流元素，不 fixed 不遮盖。
//   （早期参考 bilibili-subtitle“视频右侧(弹幕列表上方)”；弹幕功能已移除，
//   现以右列首位 + 顺序守卫置顶为准，详见 vs/sidebar-layout.js。）
//
// 结构：顶行(标题+设定) → tabs(字幕/生词表) → 工具栏(词频/无需注释/只看生词/地球)
//       → 面板(字幕标签页+生词表标签页) → 底部(复制/评论 按钮)
//
// 评论按钮：点击即把当前生词注释填入评论输入框，由用户手动发送。
//
// 非致命错误（找不到输入框、复制失败等）用冒泡 toast 提示，不弹 alert。
//
// debug 与参数：读取 src/data/config.json 的 debug /
//   commentMaxLen / prefixComment / prefixCopy / toastDuration。
//   （弹幕三键 danmakuAdvanceSec/danmakuMaxLen/prefixDanmaku 已随弹幕模块删除，不再读取。）
//
// ASR 设计（2026-07-03 修订，2026-07-07 滑动窗口修订）：
//   ASR 结果作为"可选轨道"出现在轨道下拉框中（🎤 ASR），与普通字幕
//   完全同源处理——同样的 createEmptySlot 渲染、同样的 getAnnotations 生词
//   注释、同样的 highlightCurrent 同步高亮、同样的复制/OCR/评论按钮。
//   不再使用独立的 _asrEntries 数组，ASR 结果直接进入 _subtitles/_subEntries。
//   启动 ASR 时保存当前字幕，清空面板；停止 ASR 时恢复原字幕。

import { getAnnotations, rankToStage, resetDiag, setRankMax, setMyWords } from '../lib/annotator.js';
// 280次：统一池样式表生成器（52 条共享样式，参数化选择器注入本容器）
// （280 修正：import 路径写错层级 ../../→../，esbuild 预打包与运行时均解析不到）
import { buildAnnPoolCss } from '../lib/styles.js';
// 第二百零四次：⋯ 下拉菜单新增「诊断窗口」项——正文提取诊断窗与文本侧栏同名同功能
import { openMainTextDiag } from '../lib/main-text.js';
import { getPhonetic } from '../lib/phonetics.js';
// 第一百三十四次：youtubei 单例预热（消除首取轨道冷启动竞争→空结果）
import { warmYouTubeCaptionInnertube } from '../lib/subtitle/index.js';
// 第一百三十八次拆分第一刀：ASR 进度条 DOM 子模块（依赖注入 getRoot，避免循环 import）
import { initAsrProgress, showASRProgress, hideASRProgress, updateASRProgressFill } from './vs-asr-progress.js';
// 第一百二十四次：顶行统一构建器——视频/文本侧栏共用同一代码文件（用户裁定）
import { buildTopbarHTML, ensureTopbarCss } from '../lib/sidebar-topbar.js';
import { initLang, getLang, setLang, onLangChange, t, UI_LANGS, TRANSLATE_LANGS, LANG_NAMES, LANG_NAMES_EN } from '../lib/i18n.js';
import { summarize } from '../lib/summarizer.js';
import { startASR, stopASR, isASRReady, hasASRCache, getCachedSubtitles, getASRCoverage, getASRFrontier, getASRStats } from '../lib/asr-client.js';
// 第九十六次：下载音频按钮——B站音轨信息（urls[]/标题）；YouTube 走 youtube-audio.js 按需动态 import
import { getBilibiliAudioInfo } from '../lib/bilibili-audio.js';

/**
 * 当前视频稳定标识（第一百零二次：video-controller 区分真换集与画质切换）
 * makeVideoKey 由 URL 的 bv/v/p/ep_id/cid 等参数组成；B站清晰度自动切换不改这些参数。
 * @returns {string}
 */
export function currentVideoKey() {
  try { return makeVideoKey() || ''; } catch (e) { return ''; }
}

/** ASR 是否运行中（第一百零二次：video-controller 伪换集过滤） */
export function isASRActive() {
  return !!_asrActive;
}
// 反思（2026-08-06）：重新启用视频内字幕 overlay（之前被移除导致全屏无字幕）。
//   sidebar 负责启动/同步字幕到 overlay，ASR 新增字幕也实时同步。
import { startOverlay, stopOverlay, setSubtitles as overlaySetSubtitles, addSubtitle as overlayAddSubtitle, setOverlayEnabled as overlaySetEnabled, setRankThreshold as overlaySetRank } from './subtitle-overlay.js';
// 第二百七十次：停用规则（Deactivate）——「视频叠加字幕」规则对 overlay 生效与否的
// 唯一否决点（init 读值/按钮切换/跨标签同步三处消费 _overlayRuleSup）；
// 匹配/存储逻辑唯一来源 lib/deactivate.js；⋯ 菜单「停用本站」用 upsertDeactivateRule。
import { suppressionFor, upsertDeactivateRule } from '../lib/deactivate.js';
// 第二百二十五次：删除本门面未使用的导入（pickCleanShortTrans/isBalancedParens 曾导入零调用）
// 2026-08-28 拆分第二刀：按功能拆出 vs/* 子模块，本文件保留为门面（facade）。
// 受控循环 import 说明：vs/playback-gate、vs/asr-stage、vs/record-workflow、vs/ocr
// 需调用本门面导出的函数（getRoot/getActiveVideo/isASRActive/toast/getSubtitlesRef/
// getVideoLearnLang/showNoSubtitle，均为函数声明、提升后可用）；这些子模块顶层仅
// 初始化自身状态，对本门面绑定的调用全部发生在函数体内——运行时安全，无 TDZ 风险。
import { log, setDebug } from './vs/logger.js';
import { makeVideoKey, copyToClipboard, flashButton, formatTime, escapeHtml, escapeReg, cssEscape } from './vs/dom-utils.js';
import { pickRandomLinesForComment, findMainCommentContainer, expandCommentBox, fillCommentInput, scrollMinIntoView } from './vs/comment-fill.js';
import { startYTReorderGuard } from './vs/yt-reorder.js';
// 2026-08-28 拆分第三刀：布局子模块（注入/高度同步/折叠/拖拽/重注入）；
// 下列符号均为原门面内同名函数/状态接驳（机械搬移，行为不变）
import {
  toggleSidebarCollapse, armAutoExpand, autoExpandOnce, requestSyncHeightOnce,
  injectIntoPage, startReinjectGuard, startSyncHeight, resetSidebarLayout,
  wireUnifiedFormEvents, handleDragResize, stopHeightSync, teardownLayout,
  setSidebarCollapsedFlag, getSidebarCollapsedFlag, setSizeFrozen,
  setNoSubAutoCollapseDone, setHiddenByFormSwitch
} from './vs/sidebar-layout.js';
import { installPlaybackGate, uninstallPlaybackGate } from './vs/playback-gate.js';
import { pushDiagLine, clearDiagLines, updateASRProgressFromStage } from './vs/asr-stage.js';
import { onDownloadAudioClick, getRecordedBlobForASR, setRecordedBlobForASR } from './vs/record-workflow.js';
import { onOcrClick } from './vs/ocr.js';
// 2026-08-28 拆分第三刀：字幕渲染子模块（字幕/生词表面板渲染、注释获取缓存、
// ASR 字幕插入、复制/评论/词单）；下列符号均为原门面内同名函数/状态接驳（机械搬移，行为不变）
import {
  rerender, rerenderPanelOnly, rerenderSlotsFromCache, onWordListToggle,
  onCopy, onCommentClick, highlightCurrent, appendASRSubtitle,
  resetRenderState, setNoAnnotation, setDetailMode, getDetailMode,
  // 274次：底部「导出文件」按钮改 learn——onExportFile 退役；learn 草稿用
  //   buildSubtitleBody（字幕正文）与 getAllAnnotations（生词本只读快照）
  onChatClickVs, buildSubtitleBody, getAllAnnotations,
  // 2026-09-04：生词表原形折叠开关（实现在子模块，门面仅接线）
  toggleLemmaGroup
} from './vs/subtitle-renderer.js';
// 274次：query 标签复用右键搜索卡片（唯一定义 th/panel.js，ESM 按 URL 单实例共享）
import { buildPanelCss, buildCardInnerHTML, renderQueryCard, bindLemmaChipClick } from './th/panel.js';
// 274次：learn 草稿——复用 ws/draft-export 的缓存 upsert（vocabradarDraftScrolls
// 与网站同一幂等流）与 djb2Hash/getSiteUrl（本地构建跳本地、商店安装跳线上）
import { saveDraftToCache, djb2Hash, getSiteUrl } from './ws/draft-export.js';

// === 模块状态 ===
let _root = null;             // 视频提示根元素
// 第一百三十八次拆分第一刀：把根元素获取器注入 ASR 进度条子模块（箭头函数延迟取值，
// 规避 TDZ；_root 换集重建时子模块自动跟随新引用）
initAsrProgress({ getRoot: () => _root });
let _video = null;            // video 元素
let _subtitles = [];          // [{start, end, text}]
let _rankThreshold = 5000;    // 词频阈值（2026-08-14 第五十四次修正：恢复默认 5000）
let _myWords = null;          // My Words 生词/熟词表（storage.myWords；null=未加载，startOverlay 传参用）
// 是否注释表外词（2026-08-14 第五十四次：键名改 annotateOov，默认不选）
let _annotateOov = false;
// 注释重复生词（2026-08-15 第六十二次：默认不选，同一字幕文本内重复词仅注释首次）
let _annotateRepeat = false;
// 280次：侧邻注释模板（annBrackets 布尔退役；vs/subtitle-renderer 消费）
// 284次：默认组合 {target} {annotation}（与 styles.js DEFAULT_ANN_TEMPLATE 同步）
// 306次：默认去空格 '{target}{annotation}'
let _annTemplate = '{target}{annotation}';
// 视频叠加字幕开关（2026-08-14 第五十四次修正）：startOverlay 曾硬编码 enabled:true，
//   覆盖 storage overlayEnabled 导致"取消叠加字幕后仍显示"。改为缓存存储值供启动时使用。
// 反思（2026-08-21 第九十次）：用户要求"视频叠加字幕应当默认不选"——默认值改 false，
//   读取判据同步改为严格 === true（未设置=不选，不再 !==false 宽松判真）。
let _overlayEnabled = false;
// 第二百七十次：「视频叠加字幕」停用规则否决位——true 时无论 storage.overlayEnabled
//   为何，overlay 一律不生效（init 读值/按钮切换/跨标签同步三处 AND 本位）。
//   值在 startSidebar 入口刷新一次（每视频启动时点最新），并由 storage.onChanged
//   的 deactivateRules 分支实时更新。
let _overlayRuleSup = false;
// 第二百二十五次：删除死变量 _langPair（初始化后从未使用，《命名清查》裁定）
let _activeTab = 'subtitle';  // 当前 tab
let _syncEnabled = true;      // 同步滚动高亮

let _timeListener = null;     // timeupdate 监听器（同步高亮）
let _seekedListener = null;   // seeked 监听器（seek 后立即高亮）
let _tracks = null;           // 字幕轨道列表（YouTube 有多轨道）
let _trackFetchFn = null;     // 按轨道下载字幕的函数（fetchYouTubeTrack）
let _cfgReady = null;        // 配置加载 Promise（确保 updateSubtitles 渲染前 _rankThreshold 已就绪）

// === ASR 识别状态 ===
// 2026-07-04 重构：预识别架构，asr-client 直接返回视频相对秒数，
// 不再需要墙钟偏移反算。B站路径从 __playinfo__ 下载音频预识别，
// 回退路径用 captureStream+MediaRecorder 替代废弃的 ScriptProcessor。
let _asrActive = false;      // ASR 是否激活
let _asrUnsub = null;        // ASR 字幕回调取消订阅
// 第二百二十五次：删除死变量 _savedSubtitles（只写不读，《命名清查》裁定）
let _videoKey = '';          // 当前视频缓存 key（URL-based）
let _asrCacheLoaded = false; // 字幕面板是否由 ASR 缓存预加载（loadASRCacheIfAny 设 true）
let _lastAsrCacheCoverage = 0; // 上次 ASR 缓存的覆盖率（避免重复加载时重新计算）
// 反思（2026-07-08）：用户批评「谁给你的胆子清空asr结果的！那还要缓存干啥！」。
//   有缓存时点ASR应接续不清空。_asrCacheLoaded 标记面板字幕来源，
//   startASRInternal 检查：true 则不清空 _subtitles + 传 skipReplay:true 直接实时识别接续；
//   false 则正常清空 + replayCachedSegs 回放。换集/重建/destroySidebar 时重置。
let _asrTrackIndex = -1;     // ASR 在轨道下拉框中的索引（-1=未添加）
// 反思（2026-07-10 #85）：用户反馈「虽然选了asr，但是过一会又自己改成中文轨道」「识别到中途，又自己改回中文轨道了」。
//   根因：字幕异步到达后 video-controller 调用 setTracks(tracks, pickedIndex)，
//   setTracks 内部 sel.value = String(pickedIndex||0) 无条件重置下拉框选中项，
//   覆盖了用户已手动选择的 ASR 轨道（pickedIndex 通常指向中文字幕）。
//   修正：新增 _userPickedASR 标记，用户手动选 ASR 轨道或点 ASR 按钮启动时置 true，
//   setTracks 检测到此标记时保持 ASR 选中态不被覆盖；选常规轨道/停止 ASR/换集时重置为 false。
let _userPickedASR = false;

// config 参数（弹幕三键 danmakuAdvanceSec/danmakuMaxLen/prefixDanmaku 已随弹幕模块删除）
let _cfg = {
  debug: true,
  commentMaxLen: 1000,
  // 第一百七十七次：前缀去掉 🦫（Windows 10 旧版 Segoe UI Emoji 无该字形，显示为豆腐块）
  //   并去掉"提示"二字，统一为 "VocabRadar："
  prefixComment: 'VocabRadar：\n',
  prefixCopy: 'VocabRadar：\n',
  toastDuration: 2500
};

// 2026-08-28 拆分第二刀：log 移至 vs/logger.js（debug 开关经 setDebug() 同步）

// 2026-08-28 拆分第二刀：模块级状态接驳导出（vs/* 子模块经受控循环 import 读取；
// _root/_subtitles 归属门面，vs/record-workflow 与 vs/ocr 改读 getter，写仍走门面内部）
export function getRoot() { return _root; }
export function getSubtitlesRef() { return _subtitles; }
// 2026-08-28 拆分第三刀：vs/subtitle-renderer 读取的门面模块级状态 getter（只读接驳）
export function getRankThreshold() { return _rankThreshold; }
export function getAnnotateOov() { return _annotateOov; }
export function getAnnotateRepeat() { return _annotateRepeat; }
// 280次：侧邻注释模板 getter（vs/subtitle-renderer 渲染用，原 getAnnBrackets）
export function getAnnTemplate() { return _annTemplate; }
// 280次：storage 监听分支调用，热更新后需 rerenderSlotsFromCache() 重绘（原 setAnnBrackets）
// 284次：回落默认同步 {target} {annotation}；306次去空格 '{target}{annotation}'
export function setAnnTemplate(v) { _annTemplate = (typeof v === 'string' && v.trim()) ? v : '{target}{annotation}'; }
export function getCfg() { return _cfg; }
export function getActiveTab() { return _activeTab; }
// Sync display 开关读取（vs/subtitle-renderer 点击字幕跳转与门面播放跟随共用）
export function getSyncEnabled() { return _syncEnabled; }

// === 冒泡提示（替代 alert，非致命错误用） ===
// msg: 文本；opts: {x,y,duration,error} —— x,y 为屏幕坐标，缺省居中底部
export function toast(msg, opts) {
  const o = (typeof opts === 'number') ? { duration: opts } : (opts || {});
  const el = document.createElement('div');
  el.className = 'beaver-toast' + (o.error ? ' error' : '');
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  // 关闭按钮：点击立即移除，便于复制后手动关
  const close = document.createElement('span');
  close.className = 'beaver-toast-close';
  close.textContent = '×';
  close.addEventListener('click', () => el.remove());
  el.appendChild(close);

  // 定位
  let x = o.x, y = o.y;
  if (typeof x !== 'number' || typeof y !== 'number') {
    // 默认：屏幕底部居中
    el.style.left = '50%';
    el.style.bottom = '30px';
    el.style.transform = 'translateX(-50%)';
  } else {
    // 点击位置下方，避免遮挡原内容 + 避免溢出屏幕
    el.style.left = Math.min(Math.max(8, x - 160), window.innerWidth - 332) + 'px';
    // 优先放点击点下方；若接近屏幕底部则放上方
    const belowY = y + 24;
    if (belowY > window.innerHeight - 80) {
      el.style.top = Math.max(8, y - 60) + 'px';
    } else {
      el.style.top = belowY + 'px';
    }
  }
  document.body.appendChild(el);
  // 反思（2026-08-15 第六十五次）：错误提示至少展示 5 秒；鼠标悬停/键盘焦点进入时
  //   计时暂停（不自动消失），离开后按剩余时间继续，便于读完报错信息。
  const dur = Math.max(o.duration || _cfg.toastDuration, o.error ? 5000 : 0);
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

// === 读取 config.json ===
async function loadConfig() {
  try {
    const url = chrome.runtime.getURL('src/data/config.json');
    const res = await fetch(url);
    const cfg = await res.json();
    _cfg = { ..._cfg, ...cfg };
    setDebug(!!cfg.debug);
    log('config loaded:', _cfg);
    return cfg;  // 返回 cfg，供 _cfgReady 的 then 使用
  } catch (e) {
    console.warn('[VocabRadar][video-sidebar][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] 读取 config 失败，使用默认值', e);
    return {};  // 失败返回空对象，避免外层 then 访问 undefined.debug
  }
}

// === 读取设置 ===
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({
      rankThreshold: 5000,
      // 340次（My Words 过滤失效修复）：此前缺两键 → 刷新后 settings.myWords=undefined →
      //   video-sidebar.js:1419 setMyWords(空) 过滤失效；controller 转发 startOverlay 的
      //   myWords/rankThresholdMax 也为 undefined（subtitle-overlay 真值守卫不清空但从不生效）
      rankThresholdMax: 0,
      myWords: { new: [], known: [] },
      // 反思（2026-08-18 第七十三次修正）：默认配色曾是单词绿底白字。
      // 304次（用户"默认无底色"）：改透明底绿字。
      hintFirstBg: 'transparent',
      hintFirstFg: '#2e6b43',
      hintLaterBg: 'transparent',
      hintLaterFg: '#2e6b43',
      hintAnnotationBg: '#ffffff',
      hintAnnotationFg: '#2e6b43',
      // 反思（2026-08-14 第五十四次）：注释表外词默认不选（键名 annotateOov）
      annotateOov: false,
      // 注释重复生词（2026-08-15 第六十二次：默认不选，仅注释首次出现）
      annotateRepeat: false,
      // 反思（2026-08-13 第五十次）：引导页侧栏注释样式默认 none
      // 280次：videoAnnotationStyle 复活——三功能独立选样式（多对多），与共享池同 id 集
      // 309次第五轮（用户四栏统一裁定）：兜底默认改 'green-background'（storage 空时生效）
      // 318次：'green-background' 是代指常量 ANN_DEFAULT_STYLE 的镜像兜底（classic
      //   script 不便 import styles.js；代指=常量锚定无指针键，版本变化才改常量值，
      //   锚点见 lib/styles.js）
      annotationStyle: 'green-background',
      videoAnnotationStyle: 'green-background',
      // 301次：个性化/用户条目缓存（规则表刷新用）
      annotationCustom: null,
      annotationUserStyles: [],
      // 280次：侧邻注释模板（annBrackets 布尔退役；284次默认 {target} {annotation}）
      // 306次：默认去空格 '{target}{annotation}'
      annTemplate: '{target}{annotation}'
    }, resolve);
  });
}

// === 构建 DOM 骨架 ===
function buildSidebar() {
  const root = document.createElement('div');
  root.className = 'beaver-sidebar';
  root.id = 'beaver-sidebar';
  root.innerHTML = `
    ${buildTopbarHTML({ form: 'video' })}
    <!-- 语言设置浮层：点击🌐按钮展开，含三种语言下拉菜单 -->
    <!-- 反思（2026-08-02）：参照 BeaverWord/web AppTopBar.vue 三种语言设计 -->
    <!-- 界面语言(UI_LANGS 10种) + 目标语言(TRANSLATE_LANGS 42种) + 释义语言(42种) -->
    <div class="beaver-lang-panel" id="beaver-lang-panel">
      <div class="beaver-lang-row">
        <label class="beaver-lang-label" data-i18n="popup.learnLang">Target Language</label>
        <select class="beaver-lang-select" id="beaver-learn-lang"></select>
      </div>
      <div class="beaver-lang-row">
        <label class="beaver-lang-label" data-i18n="popup.meaningLang">Definition Language</label>
        <select class="beaver-lang-select" id="beaver-meaning-lang"></select>
      </div>
      <div class="beaver-lang-row">
        <label class="beaver-lang-label" data-i18n="lang.ui">UI Language</label>
        <select class="beaver-lang-select" id="beaver-ui-lang"></select>
      </div>
    </div>
    <div class="beaver-tabs">
      <div class="beaver-tab active" data-tab="subtitle" data-i18n="tab.subtitle">🎬 Subtitles</div>
      <div class="beaver-tab" data-tab="words" data-i18n="tab.words">📖 Word List</div>
      <!-- 274次：learn 标签（原 mp 练习页）改 query——与文本侧栏同构（输入行+右键搜索卡片） -->
      <div class="beaver-tab" data-tab="query" data-i18n="tab.query">🔍 Query</div>
    </div>
    <!-- 反思（2026-08-13 第四十七次）：标签页按钮分组——
         字母页(subtitle)：注释/详情/字幕样式；词汇页(words)：词表按钮 -->
    <div class="beaver-toolbar" data-tab-toolbar="subtitle">
      <button class="beaver-tool-btn active" id="beaver-annotation" data-i18n="tool.annotation">Annotation</button>
      <button class="beaver-tool-btn" id="beaver-detail" data-i18n="tool.detail">Detail</button>
      <!-- 反思（2026-08-13 第五十二次）：用户要求"视频侧栏的『字幕样式』改为『视频叠加字幕』切换按钮"。
           旧版为字幕样式样例卡选择器，改为视频内叠加字幕（overlay）开/关切换按钮，
           样式选择保留在引导页（subtitleStyle 全局 key 仍有效）。 -->
      <button class="beaver-tool-btn active" id="beaver-overlay-toggle" data-i18n="tool.overlayToggle">${t('tool.overlayToggle')}</button>
    </div>
    <div class="beaver-toolbar hidden" data-tab-toolbar="words">
      <button class="beaver-tool-btn" id="beaver-export" data-i18n="tool.export">Export</button>
    </div>
    <div class="beaver-panel" id="beaver-subtitle-panel"></div>
    <div class="beaver-panel hidden" id="beaver-word-panel"></div>
    <!-- 274次：query 标签面板（原 mp 练习页移除，学习跳转并入底部 learn 按钮）——
         输入行 + 结果区（Shadow DOM 承载右键搜索卡片，复用 th/panel.js 唯一定义） -->
    <div class="beaver-panel hidden" id="beaver-query-panel">
      <div class="beaver-qrow">
        <input class="beaver-qinput" id="beaver-vs-query-input" type="text" spellcheck="false"
               placeholder="${t('ws.queryPh')}">
        <button class="beaver-qrun" id="beaver-vs-query-run" title="${t('tab.query')}">🔍</button>
      </div>
      <div class="beaver-query-result" id="beaver-vs-query-result">
        <div class="beaver-loading-tip" data-i18n="ws.queryTip">Type above and press Enter.</div>
      </div>
    </div>
    <div class="beaver-asr-progress" id="beaver-asr-progress" style="display:none;">
      <div class="beaver-asr-progress-info">
        <span class="beaver-asr-progress-stage" id="beaver-asr-progress-stage">准备中...</span>
        <span class="beaver-asr-progress-detail" id="beaver-asr-progress-detail"></span>
      </div>
      <div class="beaver-asr-progress-bar">
        <div class="beaver-asr-progress-fill" id="beaver-asr-progress-fill" style="width:0%"></div>
      </div>
    </div>
    <div class="beaver-footer">
      <div class="beaver-footer-row" id="beaver-track-row">
        <select id="beaver-track-select" class="beaver-track-select" title="Track"></select>
        <button class="beaver-asr-toggle-btn" id="beaver-asr-toggle" data-i18n="asr.realtime">🎤 ASR(Live)</button>
        <button id="beaver-copy" data-i18n="btn.copy">📋 Copy</button>
        <!-- 274次：export 改 learn（🎯 用户裁定图标）——导入视频草稿（字幕正文+生词）
             到扩展缓存并跳转网站「我的卷轴」，参照文本侧栏底部 learn 按钮同语义；
             跳转按本地/线上构建自动判定（getSiteUrl）。原导出文件功能移除 -->
        <button id="beaver-learn-btn" data-i18n="btn.learn" title="Import draft & open My Scrolls">🎯 <span data-i18n="btn.learn">Learn</span></button>
      </div>
      <div class="beaver-footer-row">
        <!-- 第二百七十一次：⬇️ 下载音频按钮移除（用户裁定"挪到诊断窗口中"）——
             入口迁至 ⋯ 菜单「正文提取诊断」窗顶栏动作区（openMainTextDiag actions 注入，
             见 bindEvents 的 #beaver-diag-item 绑定）；功能本体 vs/record-workflow.js 不动 -->
        <button class="beaver-icon-btn" id="beaver-ocr" data-i18n="btn.ocr" data-i18n-title="btn.ocrTitle" title="OCR current frame">📷</button>
        <!-- 第一百七十一次：评论按钮左侧新增对话按钮 -->
        <button id="beaver-chat" data-i18n="btn.chat">💬 Chat</button>
        <button id="beaver-comment" data-i18n="btn.comment">📝 Comment</button>
      </div>
    </div>
    <div class="beaver-settings-pop" id="beaver-settings-pop">
      <label><input type="checkbox" id="beaver-sync" checked> <span data-i18n="btn.sync">Sync display</span></label>
      <!-- 第二百零四次（用户："⋯改为下拉，点击选项后再跳转"）：⋯ 恢复下拉展开，
           引导页/诊断窗口降级为菜单项（171 次的"点 ⋯ 直接跳引导页"撤销） -->
      <button class="beaver-settings-item" id="beaver-deactivate-item">⏸ <span data-i18n="ws.deactivate">Deactivate on this site</span></button>
      <button class="beaver-settings-item" id="beaver-guide-item">📖 <span data-i18n="ws.openGuide">Open guide page</span></button>
      <button class="beaver-settings-item" id="beaver-diag-item">⏱ <span data-i18n="ws.mainTextDiag">Main-text extraction diag</span></button>
      <!-- 第一百三十二次：↺ 重置位置与尺寸——拖动/调尺寸被接管（_userPlaced）后
           自动对位/同步永久停写，历史小尺寸每页复活即"很矮"；给用户一个自愈出口
           （与文本侧栏 ⋯ 菜单同名同功能，i18n 键 ws.resetLayout 已有）。 -->
      <button class="beaver-settings-item" id="beaver-reset-layout">↺ <span data-i18n="ws.resetLayout">Reset position & size</span></button>
      <button class="beaver-settings-item" id="beaver-close">✕ <span data-i18n="btn.close">Close (refresh to restore)</span></button>
    </div>
    <!-- 第一百二十二次：右下角调整大小手柄——仅浮动形态显示（CSS data-mode 控制），
         拖拽调宽高，尺寸持久化（videoSidebarSize），对标文本侧栏 Win 窗口式手柄 -->
    <div class="beaver-resize-handle" id="beaver-resize-handle"></div>
  `;
  return root;
}

/**
 * 内联 order 作为 CSS 缓存双保险
 * 反思（2026-07-06 二次修复）：用户反馈"词表标签页却反了"问题依旧。
 * CSS order 规则已正确写入 sidebar.css 并同步到 dist，但浏览器可能缓存旧版 CSS。
 * 内联 style.order 优先级高于 CSS 类规则，确保布局顺序无论 CSS 是否加载都正确。
 * 顺序：header(1) → tabs(2) → toolbar(3) → panel(4) → asr-progress(5) → footer(6)
 * 反思（2026-07-07）：track-row 合并到 footer 第一排，footer order 从 7 改为 6。
 */
function applyInlineOrder(root) {
  const orderMap = [
    ['.beaver-header', 1],
    ['.beaver-tabs', 2],
    ['.beaver-toolbar', 3],
    ['.beaver-asr-progress', 5],
    ['.beaver-footer', 6]
  ];
  for (const [selector, order] of orderMap) {
    const el = root.querySelector(selector);
    if (el) el.style.order = String(order);
  }
  // 所有面板（字幕/生词/练习）统一 order=4
  root.querySelectorAll('.beaver-panel').forEach((p) => { p.style.order = '4'; });
}

// === 关闭所有浮层（菜单失焦退回）===
// 反思（2026-08-13 第四十八次）：用户要求"展开的菜单若有别处点击，表示失去焦点，应当退回去"。
//   旧问题：三个浮层（设定/语言/字幕样式）各自注册 document click 关闭，
//   但按钮 click 调 stopPropagation 阻止冒泡，导致点一个按钮时其他已展开的浮层无法关闭。
//   修正：统一 closeAllPopups() 关闭全部浮层，每个按钮点击前先关其他浮层再 toggle 自身。
// 反思（2026-08-13 第五十二次）：字幕样式选择已移到引导页，浮层只剩设定/语言两个。
function closeAllPopups() {
  if (!_root) return;
  _root.querySelector('#beaver-settings-pop')?.classList.remove('show');
  const langPanel = _root.querySelector('#beaver-lang-panel');
  const langBtn = _root.querySelector('#beaver-lang-btn');
  if (langPanel) langPanel.classList.remove('show');
  if (langBtn) langBtn.classList.remove('active');
}

// === 应用 i18n 到视频提示所有 [data-i18n] 元素 ===
function applyI18n() {
  if (!_root) return;
  const lang = getLang();
  _root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    // innerHTML 支持 <br> 等
    el.innerHTML = t(key);
  });
  _root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    el.title = t(key);
  });
  // UI 语言下拉菜单：同步当前选中项（旧版 button 显示"文A"，新版 select 同步 value）
  // 反思（2026-08-02）：下拉菜单的 option 文本已是各语言本地化名称，无需 i18n 替换
  //   只需同步 select.value 为当前 getLang()，避免显示与实际不符
  const uiLangSelect = _root.querySelector('#beaver-ui-lang');
  if (uiLangSelect) uiLangSelect.value = getLang();
  // loading 提示文字（如有 spin + 文字结构则更新文字）
  const loadEl = _root.querySelector('.beaver-loading');
  if (loadEl && loadEl.dataset.loadingKey) {
    const spin = loadEl.querySelector('.beaver-loading-spin');
    loadEl.innerHTML = '';
    if (spin) loadEl.appendChild(spin);
    const span = document.createElement('span');
    span.textContent = t(loadEl.dataset.loadingKey);
    loadEl.appendChild(span);
  }
  log('i18n applied, lang=', lang);
}

// === 绑定事件 ===
/**
 * 侧栏事件绑定。
 * 第一百三十七次（用户反馈"视频网站中直接视频侧栏消失，啥都没有"+日志实证
 * `ReferenceError: options is not defined at bindEvents`）：第一百三十三次引入
 * 引导页 mount 模式时在函数体内使用了 options.mount，但本函数从未声明该参数
 * ——startSidebar 每次构建骨架都在此处抛 ReferenceError，注入流程整体中断，
 * 正片页什么都不剩。补上形参并由调用点透传。
 * @param {{mount?: HTMLElement}} options startSidebar 透传的启动选项
 */
function bindEvents(options = {}) {
  // tab 切换：字幕 / 生词表 / query
  _root.querySelectorAll('.beaver-tab').forEach((tab) => {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      _root.querySelectorAll('.beaver-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      _activeTab = tab.dataset.tab;
      _root.querySelector('#beaver-subtitle-panel').classList.toggle('hidden', _activeTab !== 'subtitle');
      _root.querySelector('#beaver-word-panel').classList.toggle('hidden', _activeTab !== 'words');
      // 274次：mp 练习页改 query 标签（同文本侧栏：右键搜索卡片）
      _root.querySelector('#beaver-query-panel').classList.toggle('hidden', _activeTab !== 'query');
      // 反思（2026-08-13 第四十七次）：标签页按钮分组——
      //   字母页(subtitle)：注释/详情/字幕样式；词汇页(words)：词表按钮；query 页：无工具栏
      _root.querySelectorAll('[data-tab-toolbar]').forEach((tb) => {
        tb.classList.toggle('hidden', tb.dataset.tabToolbar !== _activeTab);
      });
    });
  });

  // Annotation 按钮（原 notes）：背景色表示选中（active=显示注释，非 active=不显示注释）
  // 反思（2026-07-07）：用户要求"复选按钮用背景色改变表示选中而不是复选框"，
  //   "无注释改为注释，默认选中"。逻辑反转：按钮 active = 显示注释 = _noAnnotation=false。
  // 反思（2026-07-22）：用户要求「notes 改称 Annotation」。仅改名，逻辑不变。
  const annotationBtn = _root.querySelector('#beaver-annotation');
  annotationBtn.addEventListener('click', () => {
    const isActive = annotationBtn.classList.toggle('active');
    setNoAnnotation(!isActive);  // active=显示注释 → _noAnnotation=false
    log('注释:', isActive ? '显示' : '隐藏');
    rerenderPanelOnly();
  });

  // Detail 按钮：详略切换。默认非 active=简略模式（注释跟在生词后不另起一行），
  //   active=详细模式（注释另起一行，老版本格式）。
  // 反思（2026-07-22）：用户要求「之右是详略切换按钮，默认简略模式」。
  //   简略模式：注释直接跟在字幕正文中的生词后（高亮 span 之后），不另起一行。
  //   详细模式：注释独立成行（老版本格式）。
  // 反思（2026-07-22 二次修复）：用户反馈「点击 detail 并没有切换」。
  //   根因：旧版 detail 点击调 rerenderPanelOnly，该函数清 _annotationsCache 后调 highlightCurrent，
  //   但 highlightCurrent 不重绘注释，rerenderSlotsFromCache 从已清的缓存取不到 anns，无重绘。
  //   修正：detail 切换不需要清缓存（注释数据不变，仅渲染方式变），直接调 rerenderSlotsFromCache
  //   从现有缓存取 anns 重绘，立即应用新 _detailMode。
  const detailBtn = _root.querySelector('#beaver-detail');
  detailBtn.addEventListener('click', () => {
    setDetailMode(detailBtn.classList.toggle('active'));
    log('详略模式:', getDetailMode() ? '详细' : '简略');
    // 同步到 storage，视频内字幕（subtitle-overlay.js）监听并同步切换注释模式
    // 反思（2026-08-05）：视频提示与视频内字幕共用 subtitleDetailMode
    //   false=侧邻注释（简略），true=详细注释
    try {
      chrome.storage.local.set({
        subtitleDetailMode: getDetailMode(),
        videoSidebarAnnMode: getDetailMode() ? 'detail' : 'side',
        videoOverlayAnnMode: getDetailMode() ? 'detail' : 'side'
      });
    } catch (_) { /* ignore */ }
    rerenderSlotsFromCache();
  });

  // 词单按钮：点击切换词单模式（只剩单词，移走所有注释）
  const exportBtn = _root.querySelector('#beaver-export');
  exportBtn.addEventListener('click', onWordListToggle);

  // 设定浮层
  // 第二百零四次（用户："⋯改为下拉，点击选项后再跳转而不是点击...就跳转"）：
  //   171 次的"点 ⋯ 直接跳引导页"撤销——⋯ 恢复下拉展开（先关其他浮层再 toggle 自身），
  //   引导页/诊断窗口降级为菜单项，点击选项才执行（诊断窗经 lib/main-text 懒加载，不影响首屏）。
  const settingsBtn = _root.querySelector('.beaver-settings-btn');
  const settingsPop = _root.querySelector('#beaver-settings-pop');
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !settingsPop.classList.contains('show');
    closeAllPopups();
    if (opening) settingsPop.classList.add('show');
  });
  // 菜单项：打开引导页（原 ⋯ 直跳行为降级至此）
  _root.querySelector('#beaver-guide-item').addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllPopups();
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_GUIDE' });
      log('⋯菜单 → 打开引导页');
    } catch (err) {
      log('⋯菜单 打开引导页失败：' + String(err && err.message || err));
    }
  });
  // 菜单项：停用本站（第二百七十次；第二百七十二次默认改单停「网页提示」——用户裁定
  //   "设定抑制默认是抑制网页提示，不是所有"）：写当前域 hint 停用规则，规则写入即经
  //   storage.onChanged 撤本页高亮/侧注（视频页上 text-hint 同样在跑）；视频侧栏自身
  //   与其余三项不受影响，随后跳引导页停用栏（地址=当前域名）供改范围与勾选四项。
  _root.querySelector('#beaver-deactivate-item').addEventListener('click', async (e) => {
    e.stopPropagation();
    closeAllPopups();
    const pat = location.hostname;
    try {
      await upsertDeactivateRule(pat, { hint: true });
      log('⋯菜单 → 停用本站网页提示（' + pat + '）规则已写入');
    } catch (err) {
      log('⋯菜单 写停用规则失败：' + String((err && err.message) || err));
    }
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_GUIDE', section: 'deactivate', pattern: pat });
      log('⋯菜单 → 打开引导页停用栏（' + pat + '）');
    } catch (err) {
      log('⋯菜单 打开引导页失败：' + String((err && err.message) || err));
    }
  });
  // 菜单项：正文提取诊断窗（与文本侧栏 ⋯ 菜单同名同功能）
  // 第二百七十一次：诊断窗顶栏注入「⬇️ 音频」动作——下载音频按钮自侧栏底部挪入
  //   （用户裁定）。动作闭包调 vs/record-workflow 的 onDownloadAudioClick（同页
  //   上下文，getActiveVideo 取当前视频），进度条/报错仍走原链路；文本侧栏打开
  //   诊断窗不注入（无视频语境）。
  _root.querySelector('#beaver-diag-item').addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllPopups();
    openMainTextDiag({
      actions: [{
        label: '⬇️ ' + t('btn.downloadAudio'),
        title: t('btn.downloadAudioTitle') || 'Download audio',
        onClick: () => {
          try { onDownloadAudioClick(); } catch (err) {
            log('诊断窗下载音频异常：' + String((err && err.message) || err));
          }
        }
      }]
    }).catch((err) => {
      log('⋯菜单 诊断打开失败：' + String(err && err.message || err));
    });
  });
  settingsPop.addEventListener('click', (e) => e.stopPropagation());
  _root.querySelector('#beaver-sync').addEventListener('change', (e) => {
    _syncEnabled = e.target.checked;
  });
  // 第一百三十二次：↺ 重置位置与尺寸（见 buildSidebar 模板注释）
  const resetLayoutBtn = _root.querySelector('#beaver-reset-layout');
  if (resetLayoutBtn) resetLayoutBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    resetSidebarLayout();
    settingsPop.classList.remove('show');
  });

  // 底部按钮：点击即触发
  // 第九十六次：弹幕按钮移除。第二百七十一次：下载音频按钮移除——挪入诊断窗动作区，
  //   此处不再查询 #beaver-dlaudio（模板与点击诊断数组同步移除）。
  const btnCopy = _root.querySelector('#beaver-copy');
  const btnOcr = _root.querySelector('#beaver-ocr');
  const btnComment = _root.querySelector('#beaver-comment');
  // 274次：底部 learn 按钮（🎯）——导入视频草稿并跳转网站「我的卷轴」，
  //   替换原「导出文件」（onExportFile 移除，参照文本侧栏 272 次同语义改造）
  const btnLearn = _root.querySelector('#beaver-learn-btn');
  const btnChat = _root.querySelector('#beaver-chat');
  btnCopy.addEventListener('click', onCopy);
  btnOcr.addEventListener('click', onOcrClick);
  btnComment.addEventListener('click', onCommentClick);
  if (btnLearn) btnLearn.addEventListener('click', onLearnClickVs);
  if (btnChat) btnChat.addEventListener('click', onChatClickVs);

  // 274次：query 标签——查询按钮与 Enter（与文本侧栏 query 标签同构）
  const _vsQRun = _root.querySelector('#beaver-vs-query-run');
  const _vsQInput = _root.querySelector('#beaver-vs-query-input');
  if (_vsQRun) _vsQRun.addEventListener('click', () => {
    runVideoQuery(_vsQInput ? String(_vsQInput.value || '').trim() : '');
  });
  if (_vsQInput) _vsQInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    runVideoQuery(String(_vsQInput.value || '').trim());
  });

  // 语言设置浮层：🌐按钮展开/收起三种语言下拉菜单
  // 反思（2026-08-02 修正）：用户要求"视频提示应该用符号，展开三种选择"
  //   旧版为 select#beaver-ui-lang 直接显示在 header
  //   新版为 button#beaver-lang-btn 点击展开面板，含界面/目标/释义三种语言
  // 反思（2026-08-02 二次）：参照项目约定"右键查询菜单点击别处自动消失"，
  //   语言浮层同样点击外部自动关闭，并同步按钮 .active 状态。
  const langBtn = _root.querySelector('#beaver-lang-btn');
  const langPanel = _root.querySelector('#beaver-lang-panel');
  langBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willShow = !langPanel.classList.contains('show');
    closeAllPopups();
    langPanel.classList.toggle('show', willShow);
    langBtn.classList.toggle('active', willShow);
  });
  langPanel.addEventListener('click', (e) => e.stopPropagation());

  // 填充三种语言下拉菜单选项
  // 界面语言：UI_LANGS（前10种）；目标/释义语言：TRANSLATE_LANGS（42种）
  const uiLangSel = _root.querySelector('#beaver-ui-lang');
  const srcLangSel = _root.querySelector('#beaver-learn-lang');
  const tgtLangSel = _root.querySelector('#beaver-meaning-lang');

  // 填充界面语言选项（10种）
  for (const lang of UI_LANGS) {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = LANG_NAMES[lang] || lang;
    uiLangSel.appendChild(opt);
  }
  // 填充目标/释义语言选项（42种）
  // 第二百二十八次（用户："释义语言统一英文名称"）：释义下拉用英文名，学习下拉仍本地化名
  for (const lang of TRANSLATE_LANGS) {
    const opt1 = document.createElement('option');
    opt1.value = lang;
    opt1.textContent = LANG_NAMES[lang] || lang;
    srcLangSel.appendChild(opt1);

    const opt2 = document.createElement('option');
    opt2.value = lang;
    opt2.textContent = LANG_NAMES_EN[lang] || lang;
    tgtLangSel.appendChild(opt2);
  }

  // 从 storage 读取当前语言设置并同步到下拉菜单
  chrome.storage.local.get({ learnLanguage: 'en', meaningLanguage: 'zh' }, (res) => {
    srcLangSel.value = res.learnLanguage || 'en';
    tgtLangSel.value = res.meaningLanguage || 'zh';
  });
  uiLangSel.value = getLang();

  // 界面语言切换
  uiLangSel.addEventListener('change', (e) => {
    e.stopPropagation();
    const lang = e.target.value;
    if (UI_LANGS.includes(lang)) {
      setLang(lang);
    }
  });

  // 目标语言切换
  srcLangSel.addEventListener('change', (e) => {
    e.stopPropagation();
    chrome.storage.local.set({ learnLanguage: e.target.value });
    log('目标语言切换:', e.target.value);
  });

  // 释义语言切换
  tgtLangSel.addEventListener('change', (e) => {
    e.stopPropagation();
    chrome.storage.local.set({ meaningLanguage: e.target.value });
    log('释义语言切换:', e.target.value);
  });

  // 关闭视频提示按钮（仅本次会话生效，刷新页面恢复）
  // 反思（2026-07-06）：用户反馈会员专属视频无作者，视频提示挤不进去。
  // 解决办法之一：设置弹出有关闭选项，仅单次生效。
  // 关闭按钮隐藏视频提示 DOM，不修改 storage（仅本次会话，不持久化），
  // 刷新页面后视频提示重新出现。
  _root.querySelector('#beaver-close').addEventListener('click', (e) => {
    e.stopPropagation();
    // 2026-09-08（用户："扩展侧栏中关闭后，影响并未消失"）：✕ 关闭时若 ASR 仍在转录
    //   必须一并停掉——旧版只藏 DOM，拾音/网络请求继续跑（影响残留）。
    //   与 destroySidebar 同口径（_asrActive 判定后才停）。
    if (_asrActive) { try { stopASRInternal(true); } catch (err) { /* ignore */ } }
    _root.style.display = 'none';
    // 第一百三十二次（用户状态机）：✕ 是显式关闭——打标记后文本悬浮球恢复为唯一入口
    // （syncBallWithVideoSidebar 靠该标记区分"关闭"与"📄切走"，前者放行球、后者不放）。
    try { _root.dataset.userClosed = '1'; } catch (err) { /* ignore */ }
    log('用户关闭视频提示（仅本次会话，刷新恢复；悬浮球已恢复）');
  });

  // 反思（2026-08-12 第四十六次）：折叠/展开按钮，状态持久化
  const collapseBtn = _root.querySelector('#beaver-sidebar-collapse');
  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSidebarCollapse();
  });
  // 第一百三十三次（用户裁定"侧栏先折叠，有内容了再展开，而不是先展开空着"）：
  // 启动一律折叠——不再恢复 storage.sidebarCollapsed（旧版"先展开 loading/空面板"
  // 即源于此）。首批真实内容到达时由 updateSubtitles/appendASRSubtitle 自动展开一次。
  // 引导页 mount 模式例外：预览容器需要直接可见内容。
  // 第二百二十五次：连带删除 sidebarCollapsed 的两处只写不读写入（《命名清查》裁定）。
  if (!options.mount) {
    setSidebarCollapsedFlag(true);
    _root.classList.add('beaver-collapsed');
    collapseBtn.textContent = '▶';
    // 折叠态清 height/maxHeight，防空白大块（与 toggleSidebarCollapse 折叠分支一致）
    _root.style.height = 'auto';
    _root.style.maxHeight = 'none';
    armAutoExpand();
  }

  // 第一百二十二次：📄 切换形态按钮——视频侧栏 → 文本侧栏（统称"侧栏"，内容照旧）。
  // 第一百二十四次（用户裁定"文本侧栏与视频侧栏选其一"）：切换后自身 **display:none
  // 整体隐藏**（不是折叠成顶条——顶条与文本侧栏同屏仍算"同时出现"）。
  // 派发 window 事件给 web-sidebar-impl 在本位置附近展开文本形态；
  // 回程经 beaver-unified-open（球/🎬）恢复显示。
  const formBtn = _root.querySelector('#beaver-form-btn');
  if (formBtn) {
    formBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = _root.getBoundingClientRect();
      window.dispatchEvent(new CustomEvent('beaver-toggle-form', {
        detail: { to: 'text', anchor: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } }
      }));
      setHiddenByFormSwitch(true);
      _root.style.display = 'none';
      log('切换形态 → 文本侧栏（视频侧栏整体隐藏）');
    });
  }

  // 反思（2026-08-13 第五十二次）：视频叠加字幕开关。
  //   用户要求"视频侧栏的『字幕样式』改为『视频叠加字幕』切换按钮"。
  //   点击切换 overlay 文字层显隐（写 storage.overlayEnabled，全标签同步），
  //   按钮 active class 表示"视频叠加字幕已开启"。
  //   subtitleStyle 样式选择已移到引导页，此处不再提供入口。
  const overlayToggleBtn = _root.querySelector('#beaver-overlay-toggle');
  const applyOverlayToggleBtn = (on) => {
    if (overlayToggleBtn) overlayToggleBtn.classList.toggle('active', !!on);
  };
  overlayToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // 反思（2026-08-21 第九十次）：默认不选——277次（用户"视频叠加字幕默认选中"）改默认开；
    //   308次（用户"视频叠加字幕默认关"）改回默认关：未设置视为关闭（=== true）
    chrome.storage.local.get({ overlayEnabled: false }, (res) => {
      const next = res.overlayEnabled === true;
      const toggled = !next;
      // 第二百七十次：停用规则否决——全局偏好照写 storage，但本页生效值被
      //   「视频叠加字幕」停用规则压制（按钮态按生效值显示，忠实反映现状）
      const effective = toggled && !_overlayRuleSup;
      _overlayEnabled = effective;
      overlaySetEnabled(effective);
      applyOverlayToggleBtn(effective);
      try { chrome.storage.local.set({ overlayEnabled: toggled }); } catch (_) { /* ignore */ }
      log('视频叠加字幕:', toggled ? '开启' : '关闭',
        _overlayRuleSup ? '（被停用规则压制，本页不生效）' : '');
    });
  });
  // 恢复上次叠加字幕开关（第二百七十次：生效值 AND 停用规则否决位）
  // 309次第四轮（用户"默认视频叠加字幕关着，但播放时候发现依旧开启"）根因实锤：
  //   308 次默认关口径（未设置视为关闭 === true）只改了 toggle/停用规则监听两处，
  //   本处恢复上次开关仍是旧口径 res.overlayEnabled !== false——chrome.storage.local.get
  //   不带默认值对象时，storage 无键返回 undefined，undefined !== false === true → 默认开。
  //   修为 === true（与 guide.js:461 / video-sidebar.js:804/908 同口径）。
  chrome.storage.local.get('overlayEnabled', (res) => {
    const on = res.overlayEnabled === true && !_overlayRuleSup;
    _overlayEnabled = on;
    overlaySetEnabled(on);
    applyOverlayToggleBtn(on);
  });
  // 统一注册：点击任意非浮层区域关闭所有浮层（菜单失焦退回）
  document.addEventListener('click', closeAllPopups);

  // ASR 开关按钮（独立于字幕轨道，不互斥）
  const asrToggleBtn = _root.querySelector('#beaver-asr-toggle');
  asrToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleASR(e.clientX, e.clientY);
  });

  // 字幕轨道选择器
  const trackSelect = _root.querySelector('#beaver-track-select');
  trackSelect.addEventListener('change', (e) => {
    e.stopPropagation();
    const idx = parseInt(e.target.value, 10);
    onTrackSelect(idx);
  });

  // 点击诊断：capture 阶段记录点击是否到达按钮，排查"点不动"
  // （第二百七十一次：btnDlAudio 随下载按钮挪入诊断窗，数组同步移除）
  [_root, btnCopy, btnOcr, btnComment].forEach((el, i) => {
    el.addEventListener('click', (e) => {
      log('click 捕获到:', el.id || el.className, 'target=', e.target.id || e.target.className, 'isTrusted=', e.isTrusted);
    }, true);
  });

  // 反思（2026-08-08）：喇叭按钮朗读（Web Speech API）。
  //   事件委托：所有 .beaver-w-speak 和 .beaver-ann-speak 按钮统一处理。
  // 反思（2026-09-04）：生词表原形折叠按钮（.beaver-w-lemma-toggle）同委托处理，
  //   归组查询在展开瞬间发生（toggleLemmaGroup 内部读 _allAnnotations 现场值）。
  _root.addEventListener('click', (e) => {
    const tgl = e.target.closest('.beaver-w-lemma-toggle');
    if (tgl) {
      e.stopPropagation();
      e.preventDefault();
      const item = tgl.closest('.beaver-word-item');
      if (item) toggleLemmaGroup(item);
      return;
    }
    const btn = e.target.closest('.beaver-w-speak, .beaver-ann-speak');
    if (btn) {
      e.stopPropagation();
      e.preventDefault();
      const word = btn.dataset.word;
      if (word) speakWordVideo(word);
    }
  });
}

/**
 * 反思（2026-08-08）：用户要求"音标前加一个喇叭按钮"。
 * 视频侧栏朗读单词（Web Speech API），使用 learnLanguage 设置语音。
 * @param {string} word 要朗读的单词
 */
let _videoLearnLang = 'en';
try {
  chrome.storage.local.get({ learnLanguage: 'en' }, (res) => {
    _videoLearnLang = res.learnLanguage || 'en';
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.learnLanguage) {
      _videoLearnLang = changes.learnLanguage.newValue || 'en';
    }
    // 反思（2026-08-13 第五十二次）：视频叠加字幕开关跨标签同步（引导页/其它标签切换时更新按钮态）
    // 反思（2026-08-21 第九十次）：默认不选——277次改默认开（!== false）；
    //   308次（用户"视频叠加字幕默认关"）改回默认关（=== true），与引导页一致
    // 第二百七十次：生效值 AND 停用规则否决位（规则命中时 storage 开关值仅作偏好保存）
    if (area === 'local' && changes.overlayEnabled) {
      const on = changes.overlayEnabled.newValue === true && !_overlayRuleSup;
      _overlayEnabled = on;
      overlaySetEnabled(on);
      const btn = _root.querySelector('#beaver-overlay-toggle');
      if (btn) btn.classList.toggle('active', on);
    }
    // 第二百七十次：停用规则变化——「视频叠加字幕」否决位实时刷新并按 storage
    // 现值重推导生效值（侧栏整体的停/启由 vc/controller.js 的重编排负责）
    if (area === 'local' && changes.deactivateRules) {
      suppressionFor(location).then((sup) => {
        const was = _overlayRuleSup;
        _overlayRuleSup = sup.overlay === true;
        if (was === _overlayRuleSup) return;
        chrome.storage.local.get('overlayEnabled', (res) => {
          // 300次：与本文件 toggle/启动/监听三处同口径；308次（用户"视频叠加字幕默认关"）
          //   全链路改回"未设置视为关"（=== true）——300次注已失效，历史见本段注释
          const on = res.overlayEnabled === true && !_overlayRuleSup;
          _overlayEnabled = on;
          overlaySetEnabled(on);
          const btn = _root.querySelector('#beaver-overlay-toggle');
          if (btn) btn.classList.toggle('active', on);
          log('停用规则变化（视频叠加字幕', _overlayRuleSup ? '命中→不生效' : '解除→按开关生效', '）');
        });
      }).catch(() => { /* ignore */ });
    }
  });
} catch (_) { /* ignore */ }

// 2026-08-28 拆分第二刀：_videoLearnLang 接驳导出（vs/ocr 读语言决定 OCR 引擎）
export function getVideoLearnLang() { return _videoLearnLang; }

function speakWordVideo(word) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(word);
    utter.lang = _videoLearnLang === 'zh' ? 'zh-CN' : _videoLearnLang;
    utter.rate = 0.9;
    window.speechSynthesis.speak(utter);
  } catch (_) { /* ignore */ }
}

// === ASR 识别：切换开关（预识别架构，与普通字幕同源处理） ===
// 2026-07-04 重构：从实时采集改为预识别方案。
//   B站路径：从 __playinfo__ 提取音频 URL → 下载 → 解码 → 按当前分钟开始预识别
//   回退路径：captureStream + MediaRecorder 替代废弃的 ScriptProcessor
// 点击 ASR 按钮时触发：
//   启动：保存当前字幕 → 清空面板 → asr-client 自动识别当前所在分钟并预识别后续分钟
//   停止：停止识别 → 保留 ASR 字幕不清空
// ASR 识别结果直接进入 _subtitles/_subEntries（与普通字幕同源），
// 复制/总结/评论按钮和 highlightCurrent 同步高亮自动生效。

async function toggleASR(clickX, clickY) {
  if (_asrActive) {
    // 停止：保留 ASR 字幕不清空，仅停止识别
    // 反思（2026-07-04）：旧版停止时弹 toast，用户要求“除非报错否则不浮窗”。
    stopASRInternal();
    return;
  }
  // 启动
  const v = getActiveVideo();
  if (!v) {
    toast(t('toast.noVideo'), { x: clickX, y: clickY });
    return;
  }
  // 反思（2026-07-08）：用户批评「谁给你的胆子清空asr结果的！那还要缓存干啥！」。
  //   若面板字幕已由 loadASRCacheIfAny 预加载缓存，点ASR应接续不清空，直接实时识别。
  //   skipReplay=true 时：不清空 _subtitles，startASR 跳过 replayCachedSegs（已预加载）。
  const skipReplay = _asrCacheLoaded && _subtitles.length > 0;
  _asrCacheLoaded = false;  // 决策完毕，重置（换集/重建时也会重置）
  if (!skipReplay) {
    _videoKey = makeVideoKey();
  }
  // 2026-07-04 重构：不再记录墙钟偏移。
  // asr-client 的 onText 回调直接返回视频相对秒数（B站路径通过 PCM 偏移计算，
  // 回退路径通过 video.currentTime 跟踪），appendASRSubtitle 直接使用。
  // 选中态：背景色
  const asrBtn = _root.querySelector('#beaver-asr-toggle');
  if (asrBtn) asrBtn.classList.add('active');
  _asrActive = true;
  // 第一百一十五次：漂浮提示每会话一次——新会话重置
  toggleASR._rtTipShown = false;
  // #85: 用户点 ASR 按钮启动，置标记防止后续 setTracks 覆盖轨道选中态
  _userPickedASR = true;
  // 同步轨道下拉框到 ASR 轨道（点击按钮启动时，下拉框也应切到 ASR）
  if (_asrTrackIndex >= 0) {
    const sel = _root.querySelector('#beaver-track-select');
    if (sel && sel.value !== String(_asrTrackIndex)) sel.value = String(_asrTrackIndex);
  }
  // 显示 ASR 进度条
  showASRProgress(t('asr.preparing'), '');
  // 第一百零二次：清空阶段时间线，开始新会话（第一百零三次起仅日志通道）
  clearDiagLines();
  pushDiagLine('—— 开始识别 ——');
  // 【第一百零一次 用户裁定】移除第九十八次的"点击识别立即暂停"——恢复原交互：
  // 点击识别不改变播放状态，识别在后台进行（直连下载或回退采集）。
  // ASR 结果直接进入 _subtitles/_subEntries（与普通字幕同源），
  // 复制/总结/评论按钮和 highlightCurrent 同步高亮自动生效。
  // 非缓存预加载场景：清空面板准备接收 ASR 结果；缓存预加载场景：保留缓存字幕接续实时识别。
  if (!skipReplay) {
    _subtitles = [];
    // 第一百二十八次（用户反馈"选的是asr，叠加字幕却是其他轨道的时间戳错乱"）：
    //   根因：此处清空了侧栏 _subtitles，但视频叠加字幕（subtitle-overlay）从未同步清空——
    //   overlay 里仍留着切换前的原生轨道字幕，继续按其时间戳渲染，与 ASR 侧栏字幕
    //   两套来源并存 → 视频上显示的是旧轨道内容且时间戳对不上。同步清空 overlay。
    try { overlaySetSubtitles([]); } catch (e) { /* ignore */ }
    resetRenderState();
    // 反思（2026-07-09）：用户反馈"字幕区空白，生词表倒是一大堆"。
    //   根因：清空 _subtitles 但没清 _windowSlots/_activeSubIdx/面板 DOM，
    //   appendASRSubtitle 检查 _windowSlots.length===0 来决定是否初始化面板，
    //   旧槽位不为空 → 不调 renderSubtitlePanel → 面板保留旧 DOM 不更新。
    //   collectAnnotations 仍 push 生词到 _allAnnotations + appendWordPanelItems → 生词表有数据。
    //   修正：同步清 _windowSlots + _activeSubIdx + 面板 DOM，让首批 ASR 结果正确初始化面板。
    // 反思（2026-07-09 #71）：用户反馈"点了一下asr按钮，结果字幕清空了，生词表还一长串"。
    //   根因：_allAnnotations=[] 清了数组但 #beaver-word-panel DOM 未清，旧生词条目残留。
    //   修正：同步清 #beaver-word-panel DOM。
    const panel = _root.querySelector('#beaver-subtitle-panel');
    if (panel) panel.innerHTML = '';
    const wp = _root.querySelector('#beaver-word-panel');
    if (wp) wp.innerHTML = '';
  }
  try {
    _asrUnsub = await startASR({
      videoKey: _videoKey,
      videoElement: v,
      skipReplay,
      // 第一百一十三次：录制工作流——若有留存录音，本次 ASR 直接解码识别（一次性消费）
      recordedBlob: getRecordedBlobForASR(),
      onText: (seg) => {
        // appendASRSubtitle 为 async（getAnnotations 异步翻译），fire-and-forget + catch 防止 unhandledrejection
        appendASRSubtitle(seg).catch((e) => console.warn('[VocabRadar][asr][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] appendASRSubtitle 失败:', e));
      },
      onStatus: (s) => {
        // 反思（2026-07-04）：用户要求“除非报错，否则不要给用户浮窗”。
        // 旧版对 loading/ready/stage 多种状态都弹 toast，干扰严重。
        // 修正：所有非错误状态仅打印日志 + 更新进度条，错误由 onError 回调处理。
        const _t = new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0');
        if (s.status === 'loading') {
          const pct = Math.round(s.progress || 0);
          console.log('[VocabRadar][asr][' + _t + '] model:', (s.file || ''), pct + '%');
          showASRProgress(t('asr.modelDownloading'), (s.file || '') + ' ' + pct + '%');
          updateASRProgressFill(pct);
        } else if (s.status === 'ready') {
          console.log('[VocabRadar][asr][' + _t + '] model ready');
          showASRProgress(t('asr.modelReady'), '');
          updateASRProgressFill(0);
        } else if (s.status === 'stage') {
          console.log('[VocabRadar][asr][' + _t + ']', '[' + s.stage + ']', s.info || '');
          // 第一百一十三次（用户裁定）：回退实时模式时漂浮几秒提示——即时识别落后播放，
          // 建议先下载识别再播放（下载失败可用录制工作流）。仅提示一次/会话。
          if (s.stage === 'fallback-start' && !toggleASR._rtTipShown) {
            toggleASR._rtTipShown = true;
            try { toast(t('asr.rtSlowTip'), { duration: 8000 }); } catch (e) { /* ignore */ }
          }
          updateASRProgressFromStage(s);
        }
      },
      onError: (err) => {
        console.warn('[VocabRadar][asr][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] ASR 错误:', err);
        // 反思（2026-07-07）：用户要求"偶然局部问题进度条那报错5秒"，不弹 toast。
        // ASR 运行中的局部错误（如某段识别失败）仅在进度条显示5秒，不打断 ASR 运行。
        showASRProgress(t('asr.errorLabel'), String(err.message || err).slice(0, 60));
        setTimeout(() => { if (_asrActive) hideASRProgress(); }, 5000);
      }
    });
    console.log('[VocabRadar][asr][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] 已启动');
    // 第一百三十四次：ASR 启动成功 → 本页会话冻结自动重塑（startSyncHeight/对位/补测停写）。
    // 不随 ASR 停止解冻——用户裁定"不因 asr 等活动重塑窗口"，解冻会让停止瞬间再次改写。
    setSizeFrozen(true);
    setRecordedBlobForASR(null); // 录音已消费
    // 【第一百零一次 用户裁定】闸门停用——不再安装（原第九十六次行为，恢复见 _gateEnabled）
    installPlaybackGate();
  } catch (e) {
    console.warn('[VocabRadar][asr][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] ASR 启动失败:', e);
    const msg = String(e.message || e);
    // 扩展上下文失效（扩展被重载/更新后旧 content script 仍在页面上）
    if (msg.includes('CONTEXT_INVALIDATED') || msg.includes('Extension context invalidated')) {
      toast(t('asr.ctxInvalidated'), { x: clickX, y: clickY, error: true, duration: 10000 });
      stopASRInternal();
      return;
    }
    // 反思（2026-07-07）：用户要求"整个处理不了直接不显示窗口，别现眼"。
    // ASR 启动失败（如无音轨、captureStream 不可用、B站音频下载失败且回退失败）
    // 静默退出，不弹 toast。仅控制台保留 warn 日志供诊断。
    stopASRInternal();
  }
}

// 停止 ASR 识别，保留 ASR 字幕结果
// 反思（2026-07-04）：旧版停止 ASR 时恢复原字幕（清空 ASR 结果），
// 用户反馈"关停asr发现你清理字幕，大错"。修正：停止 ASR 仅停止识别，
// ASR 识别出来的字幕保留在面板中，不清空、不恢复旧字幕。
// 反思（2026-07-28）：用户反馈"asr中途退出"。添加调用栈日志，
//   记录 stopASRInternal 的调用来源，便于诊断自动停止的根因。
function stopASRInternal(skipRestore) {
  // 打印调用栈，诊断 ASR 中途退出的根因
  const _stack = new Error().stack;
  const _caller = _stack ? _stack.split('\n').slice(2, 5).map(s => s.trim()).join(' <- ') : 'unknown';
  console.log('[VocabRadar][asr][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] stopASRInternal 被调用, skipRestore=' + !!skipRestore + ', 调用来源: ' + _caller);
  if (_asrUnsub) { try { _asrUnsub(); } catch (e) { /* ignore */ } _asrUnsub = null; }
  try { stopASR(); } catch (e) { /* ignore */ }
  _asrActive = false;
  // 第九十六次：卸载播放闸门；若暂停由闸门所为则恢复播放（不把用户卡在暂停态）
  uninstallPlaybackGate(true);
  // #85: ASR 停止后清除用户选中标记，后续 setTracks 可正常按 pickedIndex 选轨
  _userPickedASR = false;
  const asrBtn = _root.querySelector('#beaver-asr-toggle');
  if (asrBtn) asrBtn.classList.remove('active');
  // 隐藏 ASR 进度条
  hideASRProgress();
  // 第一百零二次：会话结束标注（仅日志）
  pushDiagLine('—— 已停止 ——');
  // 保留 ASR 字幕，不恢复旧字幕，不清理面板（第二百二十五次：连带删除死变量 _savedSubtitles）
  console.log('[VocabRadar][asr][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] 已停止，字幕保留');
}

// === 加载提示（字幕到达前显示） ===
// 加载态：仅显示 header + 骨架动画，隐藏 tabs/toolbar/footer
// 仿 videoseek 的 Skeleton active 样式（渐变呼吸动画条）
// 加载超时计时器（反思 2026-07-07：用户反馈"有的视频你一直转转转还不自知"）
// showLoading 后 15 秒未收到字幕/错误，自动 showNoSubtitle 兜底，避免 loading 永转。
let _loadingTimeout = null;
const LOADING_TIMEOUT_MS = 15000;
// 第一百四十五次（用户裁定"抓取字幕都是后台操作，不要干扰正常操作"）：
// 自动加载链路活动标记——期间 15s 超时兜底不再抢跳超时提示（链路自有终态），
// 且 onTrackSelect 不重复刷骨架屏。
let _autoChainActive = false;

function showLoading(msg) {
  if (!_root) return;
  const panel = _root.querySelector('#beaver-subtitle-panel');
  // 第一百四十五次：后台化——面板已在 loading 态或已有真实字幕时不重绘不闪动
  if (panel && panel.querySelector('.beaver-loading')) return;
  if (panel && _subtitles && _subtitles.length > 0) return;
  _root.classList.add('loading');
  if (!panel) return;
  const txt = msg || t('loading');
  // 骨架屏：模拟字幕列表（时间条 + 文本行），仿 videoseek 的 Skeleton
  panel.innerHTML = `<div class="beaver-loading skeleton" data-loading-key="loading">
    <div class="beaver-skeleton-row"><div class="beaver-skeleton-bar time"></div><div class="beaver-skeleton-bar long"></div></div>
    <div class="beaver-skeleton-row"><div class="beaver-skeleton-bar time"></div><div class="beaver-skeleton-bar medium"></div></div>
    <div class="beaver-skeleton-row"><div class="beaver-skeleton-bar time"></div><div class="beaver-skeleton-bar full"></div></div>
    <div class="beaver-skeleton-row"><div class="beaver-skeleton-bar time"></div><div class="beaver-skeleton-bar long"></div></div>
    <div class="beaver-skeleton-row"><div class="beaver-skeleton-bar time"></div><div class="beaver-skeleton-bar short"></div></div>
    <div style="text-align:center;color:#9499a0;font-size:13px;margin-top:8px"><span class="beaver-loading-spin"></span> ${escapeHtml(txt)}</div>
  </div>`;
  // 反思（2026-07-07）：超时兜底。字幕获取卡死（网络不响应/API 异常未抛错）时，
  // showLoading 不会被 clearLoading 清除，loading 永转。15秒后自动 showNoSubtitle。
  if (_loadingTimeout) clearTimeout(_loadingTimeout);
  _loadingTimeout = setTimeout(() => {
    _loadingTimeout = null;
    if (_autoChainActive) {
      // 自动链路进行中：不抢跳超时提示（链路 22s 自有终态），仅解除 loading 态防永转样式
      if (_root) _root.classList.remove('loading');
      return;
    }
    if (_root && _root.classList.contains('loading')) {
      log('loading 超时 ' + (LOADING_TIMEOUT_MS / 1000) + 's，自动显示超时提示');
      showNoSubtitle('subtitleTimeoutTip');
    }
  }, LOADING_TIMEOUT_MS);
}

// 加载完成：去掉 loading class，恢复 tabs/toolbar/footer 显示
// （2026-08-28 拆分第三刀：vs/subtitle-renderer 的 renderSubtitlePanel 调用，加 export 接驳）
export function clearLoading() {
  if (!_root) return;
  _root.classList.remove('loading');
  // 反思（2026-07-07）：清除超时计时器，避免字幕正常到达后超时提示仍触发
  if (_loadingTimeout) {
    clearTimeout(_loadingTimeout);
    _loadingTimeout = null;
  }
}

// === 启动视频提示（仅骨架） ===
// 改造说明（性能优化）：
//   原 startSidebar(video, subtitles) 会 await rerender()，首次要下载 7.86MB 词典 +
//   串行处理所有字幕 + 表外单词同步 translate，导致骨架虽已挂载但要等 5 秒才"算启动完"。
//   现拆分为 startSidebar(video) 只显骨架+"字幕加载中..."，字幕到达后由
//   updateSubtitles(subtitles) 填充。骨架与字幕获取并行，体感最快。

/**
 * 获取当前活跃 video 元素
 * _video 可能因 SPA 换集失效（旧 video 被移出 DOM），校验是否仍 connected，
 * 失效则重新查找 document.querySelector('video')。
 * 用于字幕点击跳转，避免设置失效元素的 currentTime 无效。
 * 2026-08-28 拆分第二刀：导出供 vs/* 子模块使用（playback-gate/asr-stage/record-workflow/ocr）
 */
export function getActiveVideo() {
  if (_video && document.contains(_video)) return _video;
  // _video 失效，重新查找
  const v = document.querySelector('video');
  if (v) _video = v;  // 顺便更新引用
  return v || null;
}

export async function startSidebar(video, options = {}) {
  // 第二百七十次：启动时点刷新「视频叠加字幕」停用规则否决位（storage.onChanged
  // 亦实时更新，此处兜底覆盖"规则先写、模块后启"的时序）。
  try {
    const _dsup = await suppressionFor(location);
    _overlayRuleSup = _dsup.overlay === true;
  } catch (_) { /* ignore */ }
  // 第一百三十四次：YouTube 页即预热 youtubei 单例（vendor import+create 与播放器
  // 加载并行）——消除"首取轨道空、手动切轨才成功"的冷启动竞争。fire-and-forget。
  if (/youtube\.com/i.test(location.hostname)) {
    warmYouTubeCaptionInnertube();
  }
  // 反思（2026-07-06 二次修复）：新增 options.hidden 参数控制初始可见性。
  // options.hidden=true 时 _root 创建后立即 display:none，
  // 避免先显示再隐藏的闪烁，也确保 SPA 换集时视频提示保持隐藏。
  // （第二百二十五次：原注释提及的 subtitleOverlay 存储键已随死键清理删除。）
  // _root 可能因 B站 Vue 重新渲染被移出 DOM（document.contains 返回 false），
  // 此时虽 _root 非空但已是失效节点，querySelector 失败 → 字幕无法填充。
  // 换集时必须校验 _root 是否仍在 DOM，失效则重建。
  if (_root && document.contains(_root)) {
    // 反思（2026-07-07）：用户反馈"视频换了，依然asr还在"。
    // 换集时必须停止 ASR，否则旧集的语音识别继续运行，与新视频不匹配。
    if (_asrActive) {
      try { stopASRInternal(true); } catch (_) { /* ignore */ }
      log('换集: 已停止 ASR');
    }
    // 已存在且仍在 DOM（SPA 换集）：更新 video 引用 + 重绑 timeupdate/seeked listener + 清旧字幕显加载提示
    if (_video && _timeListener) {
      _video.removeEventListener('timeupdate', _timeListener);
    }
    if (_video && _seekedListener) {
      _video.removeEventListener('seeked', _seekedListener);
    }
    _video = video;
    if (_timeListener) {
      _video.addEventListener('timeupdate', _timeListener);
    }
    if (_seekedListener) {
      _video.addEventListener('seeked', _seekedListener);
    }
    // 换集：立即清旧字幕显示加载提示，新字幕到达后由 updateSubtitles 填充
    _subtitles = [];
    resetRenderState();
    _asrCacheLoaded = false;
    _userPickedASR = false;  // #85: 换集重置用户 ASR 选中标记（stopASRInternal 已清，此处双保险）
    setNoSubAutoCollapseDone(false);  // 第一百二十二次：换集重置自动折叠配额
    // 反思（2026-07-09）：用户反馈「生词表一如既往地比子区多很多内容」「二者来自不同内容」。
    //   根因：换集时 _allAnnotations=[] 清了数组，但 #beaver-word-panel 的 DOM 未清，
    //   旧生词条目仍留在面板。新字幕到达后 rerender→renderWordPanel 才清空重建，
    //   但若新字幕未到达（换集检测失败）则旧生词永久残留，造成「字幕区是新的、生词表是旧的」错位。
    //   修正：换集时立即清空生词表 DOM，与字幕区 showLoading 同步重置。
    const _wp = _root.querySelector('#beaver-word-panel');
    if (_wp) _wp.innerHTML = '';
    showLoading();
    // 反思（2026-07-10 #84）：用户反馈「换集后高度缩小」「视频提示高度还变化」。
    //   根因：换集分支只清除了 height/maxHeight 内联样式，但未重置 _heightSyncStarted，
    //   也未重调 startSyncHeight()。由于 _heightSyncStarted 仍为 true，startSyncHeight 直接 return，
    //   换集后视频提示高度彻底失去同步约束（依赖旧的内联样式，但已被清除 → 高度塌陷/缩小）。
    //   修正：换集时清理旧的高度同步资源（timers + resize listener），重置 _heightSyncStarted=false
    //   和 _heightSyncMaxH=0，清除旧内联高度，然后重调 startSyncHeight() 走 0/500/1500/3000ms 流程
    //   为新视频重新计算并固定高度。换集时确保视频提示可见（除非用户手动关闭）。
    if (_root.style.display !== 'none') {
      // 第一百三十八次：换集解锁，新集重新测量一次（清 timers/resize 监听并重置同步状态）
      stopHeightSync();
      _root.style.height = '';
      _root.style.maxHeight = '';
      startSyncHeight();
    }
    // 反思（2026-07-06 六次修复）：视频提示始终可见，不再用 hidden 控制显隐。
    // 仅当用户之前手动点了 ✕ 关闭按钮（_root.style.display==='none'）时保持隐藏。
    // 换集不应改变用户的手动关闭状态。
    // 反思（2026-08-06）：换集时重启视频内字幕 overlay（绑定新 video 元素）
    try { stopOverlay(); startOverlay(video, [], { rankThreshold: _rankThreshold, enabled: _overlayEnabled, annotateRepeat: _annotateRepeat }); } catch (e) { console.warn('[VocabRadar][video-sidebar] overlay 启动失败:', e); }
    log('换集: 已清旧字幕, 重算高度, 等待新字幕');
    return;
  }
  // _root 失效（被 Vue 移除）：重置状态走重建流程
  if (_root && !document.contains(_root)) {
    log('换集: _root 已被移出 DOM, 重建骨架');
    // 反思（2026-07-07）：重建前也需停止 ASR，避免旧 ASR 继续运行
    if (_asrActive) {
      try { stopASRInternal(true); } catch (_) { /* ignore */ }
    }
    _root = null;
    _video = null;
    _timeListener = null;
    _subtitles = [];
    resetRenderState();
    _asrCacheLoaded = false;
    _userPickedASR = false;  // #85: 重建重置用户 ASR 选中标记
  }

  _video = video;
  _root = buildSidebar();
  bindEvents(options);
  // 第一百二十二次：统一侧栏路由事件（beaver-unified-open）+ 拖动位置视口守卫
  wireUnifiedFormEvents();
  handleDragResize();
  // 反思（2026-08-06）：启动视频内字幕 overlay（全屏时显示字幕）
  //   字幕到达后由 updateSubtitles 同步到 overlay，ASR 字幕由 appendASRSubtitle 同步
  try { startOverlay(video, [], { rankThreshold: _rankThreshold, enabled: _overlayEnabled, annotateRepeat: _annotateRepeat }); } catch (e) { console.warn('[VocabRadar][video-sidebar] overlay 启动失败:', e); }

  // 反思（2026-07-06 六次修复）：视频提示始终可见，不再用 hidden 控制显隐

  // 注入 CSS（同步，无 IO 等待）
  // 反思（2026-07-06）：仅注入一次，避免 SPA 换集时重复添加 <link>
  // 反思（2026-08-11 第三十六次）：用户反馈"点击视频侧栏标签，底色透明了，样式也变了"。
  //   根因：sidebar.css 通过 <link> 异步加载，加载前 #beaver-sidebar 无 background/样式，
  //   --beaver-bg 等 CSS 变量未定义 → 背景透明、布局错乱。
  //   修正：先注入同步 <style> 关键 CSS（background/尺寸/字体等），确保 sidebar.css
  //   加载前后外观一致。与 web-sidebar-impl.js 的 injectCriticalCSS() 同策略。
  if (!document.getElementById('beaver-sidebar-critical-css')) {
    const criticalStyle = document.createElement('style');
    criticalStyle.id = 'beaver-sidebar-critical-css';
    criticalStyle.textContent = `
      :root{--beaver-primary:#2e6b43;--beaver-primary-light:#a8e6cf;--beaver-on-primary:#fff;--beaver-on-primary-container:#0d2014;--beaver-bg:#fbfdf9;--beaver-bg-soft:#f5f8f3;--beaver-bg-container:#eff3ec;--beaver-bg-container-high:#e9eee7;--beaver-text:#1a1f1a;--beaver-text-soft:#424942;--beaver-text-disabled:#72797a;--beaver-outline:#c2c9bf;--beaver-radius:12px;--beaver-radius-sm:8px;--beaver-shadow-1:0 1px 2px rgba(26,31,26,.10),0 1px 3px rgba(26,31,26,.06);}
      #beaver-sidebar{position:relative;z-index:5;width:100%;min-height:200px;background:var(--beaver-bg,#fbfdf9);border-radius:var(--beaver-radius,12px);box-shadow:var(--beaver-shadow-1);margin:0 0 10px 0;padding:0;display:flex;flex-direction:column;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:16px;color:var(--beaver-text,#1a1f1a);line-height:1.5;overflow:visible;pointer-events:auto;box-sizing:border-box;}
      #beaver-sidebar.beaver-floating{position:fixed;width:min(320px,calc(100vw - 32px));height:min(569px,calc(100vh - 48px));top:20px;right:16px;}
      /* 反思（2026-08-13 第五十三次）：折叠态清 min-height/height，防空白大块（与 sidebar.css 同步） */
      #beaver-sidebar.beaver-collapsed{min-height:auto;height:auto;max-height:none;}
      #beaver-sidebar .beaver-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--beaver-bg-soft,#f5f8f3);flex-shrink:0;}
      #beaver-sidebar .beaver-tabs{display:flex;background:var(--beaver-bg-soft,#f5f8f3);flex-shrink:0;}
      /* 第一百二十二次同步：工具栏 hidden 规则 + 非面板行 flex-shrink:0（与 sidebar.css 一致，防缓存缺规则） */
      #beaver-sidebar [data-tab-toolbar].hidden,#beaver-sidebar .beaver-toolbar.hidden{display:none!important;}
      #beaver-sidebar .beaver-toolbar{flex-shrink:0;}
      #beaver-sidebar .beaver-asr-progress{flex-shrink:0;}
      #beaver-sidebar .beaver-footer{flex-shrink:0;}
      #beaver-sidebar .beaver-tab{flex:1;padding:8px 12px;text-align:center;cursor:pointer;color:var(--beaver-text-soft,#424942);font-size:0.9em;}
      #beaver-sidebar .beaver-tab.active{color:var(--beaver-on-primary-container,#0d2014);background:var(--beaver-primary-light,#a8e6cf);}
    `;
    document.head.appendChild(criticalStyle);
  }
  if (!document.querySelector('link[href*="sidebar.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('src/content/sidebar.css');
    document.head.appendChild(link);
  }
  // 第一百二十四次：统一顶行样式（sidebar-topbar.js 唯一来源，幂等）
  try { ensureTopbarCss(); } catch (e) { /* ignore */ }

  // 注入到右侧容器（立即挂骨架，MutationObserver 等容器异步插入）
  // 反思（2026-08-21 第八十九次）：引导页支持——options.mount 提供挂载容器时内联挂载：
  //   不注入页面右侧容器（injectIntoPage）、不启动防消失守卫（B站 Vue 专用）。
  //   #beaver-sidebar 基础样式即 position:relative 文档流，嵌入容器自然排布；
  //   高度同步（startSyncHeight）随 injectIntoPage 一并跳过，高度由内容决定。
  if (options.mount && typeof options.mount.appendChild === 'function') {
    options.mount.appendChild(_root);
    log('视频提示已内联挂载到指定容器（引导页模式）');
  } else {
    // 反思（2026-07-06 二次修复）：内联 order 作为 CSS 缓存克星双保险
    // 即使 CSS 文件被浏览器缓存（旧版本无 order 规则），内联 style.order 语义也能保证布局正确
    applyInlineOrder(_root);

    // 第一百三十八次：hidden 注入（popup sidebarEnabled=false）也必须广播可见事件。
    //   反思：旧版仅在非 mount 分支末尾统一广播，hidden 时球被"预判藏球"隐藏后，
    //   看门狗又被 _hiddenByUserSetting 豁免标记拦住 → 整页"啥都没有"（用户复测实证）。
    //   广播让文本侧栏立即进入互斥状态机（球保持隐藏），后续 showSidebar() 恢复显示
    //   时状态机自然放行——侧栏在 DOM 且可恢复，不再是"消失"。
    injectIntoPage(_root);
    try { window.dispatchEvent(new CustomEvent('beaver-video-sidebar-visible')); } catch (e) { /* ignore */ }

    // 防消失：B站 Vue 重新渲染右侧容器时会移除 sidebar，监听并重新注入
    startReinjectGuard();
  }
  // 第一百三十五次：诊断探针——"视频侧栏整体消失"无法远程复现，暴露真实状态供
  //   控制台一键取证（挂载/注入模式/折叠/display），配合 web 侧 __beaverWebSidebarDiag。
  try {
    window.__beaverVsDiag = () => ({
      url: location.href,
      mounted: !!(_root && document.contains(_root)),
      mode: _root ? (_root.dataset.mode || '(none)') : null,
      collapsed: getSidebarCollapsedFlag(),
      display: _root ? (_root.style.display || '(default)') : null,
      height: _root ? _root.style.height : null,
      rect: _root ? (() => { const r = _root.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
      userClosed: !!(_root && _root.dataset && _root.dataset.userClosed === '1')
    });
  } catch (e) { /* ignore */ }
  // 第一百三十三次：时序防御——启动强制折叠先于注入执行，Shorts/generic 分支随后写入的
  // 内联 width/height 会覆盖折叠态的 height:auto（顶条下残留空白块）。此处再断言一次。
  if (!options.mount && getSidebarCollapsedFlag()) {
    _root.style.height = 'auto';
    _root.style.maxHeight = 'none';
  }

  // 初始化界面语言（默认英文），应用 i18n，并订阅语言变更
  await initLang();
  applyI18n();
  onLangChange(() => applyI18n());

  // 显示加载提示（字幕到达前）
  showLoading();

  // 确保 ASR 轨道选项在下拉框中可用（B站等无多轨道时仍需显示 ASR 选项）
  ensureASRTrackOption();

  // 监听 timeupdate + seeked 高亮当前字幕（字幕到达后生效）
  // 反思（2026-07-04）：旧版只监听 timeupdate，但 timeupdate 在视频暂停时不触发。
  // 用户拖进度条暂停时 seek，timeupdate 不触发 → 高亮不更新 → "字幕没跟随"。
  // 新增 seeked 事件：seek 完成（无论是否暂停）立即触发，保证拖进度条后高亮即时更新。
  _timeListener = () => { if (_syncEnabled) highlightCurrent(_video.currentTime); };
  _seekedListener = () => { if (_syncEnabled) highlightCurrent(_video.currentTime); };
  _video.addEventListener('timeupdate', _timeListener);
  _video.addEventListener('seeked', _seekedListener);

  log('视频提示骨架已挂载, 等待字幕...');

  // 配置/设置异步加载，不阻塞骨架（loadConfig 是 fetch config.json，loadSettings 是 chrome.storage）
  // Promise 存为 _cfgReady：updateSubtitles 渲染字幕前 await 它，
  // 确保用真实 rankThreshold 而非默认 0（避免误过滤导致"字幕窗口无生词而文本提示有"）
  _cfgReady = Promise.all([loadConfig(), loadSettings()]).then(([cfg, settings]) => {
    _cfg = { ..._cfg, ...cfg };
    setDebug(!!cfg.debug);
    _rankThreshold = settings.rankThreshold;
    // 词频范围上界（storage.rankThresholdMax；0/缺省=不限制），annotator 模块级生效
    setRankMax(settings.rankThresholdMax);
    // My Words（用户生词/熟词表，优先级高于词频范围；storage.myWords={new:[],known:[]}）
    _myWords = settings.myWords || { new: [], known: [] };
    setMyWords(_myWords.new, _myWords.known);
    _annotateOov = settings.annotateOov === true;
    _annotateRepeat = settings.annotateRepeat === true;
    // 280次：侧邻注释模板初始化（annBrackets 布尔退役，默认 {word}({meaning})）
    // 283次：模板分键——视频侧栏读 videoAnnTemplate（videoAnnotationStyle 栏专用键）
    setAnnTemplate(settings.videoAnnTemplate);
    // 反思（2026-08-05 修正）：用户反馈"浏览器工具栏设定的样式并没有影响视频侧栏字幕区"。
    //   根因：sidebar 仅在 _cfgReady 写入 --beaver-first-bg/--beaver-later-bg，
    //   未写入 --beaver-first-fg/--beaver-ann-bg/--beaver-ann-fg，且无 storage 监听器，
    //   popup 改色后 sidebar 不更新。修正：完整写入 4 组配色变量 + 监听 storage 变化。
    applyColorSettings(settings);
    // 280次：videoAnnotationStyle 复活——三功能独立选样式（多对多），与共享池同 id 集；
    //   （279 次曾并入 annotationStyle，本轮引导页重组后文本侧栏/视频侧栏各自独立选择）
    // 301次：个性化/用户条目规则先行注入（类切换即时生效）
    refreshAnnPoolCss(settings.annotationCustom, settings.annotationUserStyles);
    applyAnnStyle(settings.videoAnnotationStyle);
    // 从 storage 读取注释模式（引导页 radio 或 Detail 按钮写入）
    const annMode = settings.videoSidebarAnnMode || (settings.subtitleDetailMode ? 'detail' : 'side');
    setDetailMode(annMode === 'detail');
    const detailBtn2 = _root.querySelector('#beaver-detail');
    if (detailBtn2) detailBtn2.classList.toggle('active', getDetailMode());
    // 反思（2026-08-06）：同步 rankThreshold 到视频内字幕 overlay
    overlaySetRank(_rankThreshold);
    log('配置加载完成, rankThreshold=', _rankThreshold, 'annotateOov=', _annotateOov, 'annotateRepeat=', _annotateRepeat, '配色 first=', settings.hintFirstBg, 'annotation=自动派生(前后景互换)');
  }).catch((e) => {
    console.warn('[VocabRadar][video-sidebar][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] 配置加载失败', e);
  });

  // 反思（2026-08-05 新增）：监听 popup 配色变化，实时同步到视频侧栏 CSS 变量。
  //   用户在浏览器工具栏 popup 改色后，sidebar 无需刷新即可生效。
  // 280次：监听 videoAnnotationStyle（三功能独立）与注释模板 annTemplate（替代 annBrackets）。
  // 283次：模板分键——本模块只响应 videoAnnTemplate（videoAnnotationStyle 栏专用键）。
  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const colorKeys = ['hintFirstBg', 'hintFirstFg', 'hintLaterBg', 'hintLaterFg', 'hintAnnotationBg', 'hintAnnotationFg', 'videoSidebarAnnMode'];
      if (!colorKeys.some((k) => k in changes) && !('videoAnnotationStyle' in changes) && !('videoAnnTemplate' in changes)
        && !('annotationCustom' in changes) && !('annotationUserStyles' in changes)) return;
      // 读取完整设置后应用（避免部分更新遗漏）
      loadSettings().then((s) => {
        applyColorSettings(s);
        // 301次：个性化/用户条目规则先刷新（类切换即时生效）
        refreshAnnPoolCss(s.annotationCustom, s.annotationUserStyles);
        applyAnnStyle(s.videoAnnotationStyle);
        // 280次：注释模板热更新——前后缀变化需重绘（渲染时按模板分段拼装）
        // 283次：模板分键——annTemplate → videoAnnTemplate
        if ('videoAnnTemplate' in changes) {
          setAnnTemplate(s.videoAnnTemplate);
          rerenderSlotsFromCache();
        }
        // 注释模式同步（引导页 radio 或 Detail 按钮写入）
        if ('videoSidebarAnnMode' in changes) {
          const mode = s.videoSidebarAnnMode || 'side';
          setDetailMode(mode === 'detail');
          const detailBtn3 = _root.querySelector('#beaver-detail');
          if (detailBtn3) detailBtn3.classList.toggle('active', getDetailMode());
          rerenderSlotsFromCache();
        }
      }).catch(() => {});
    });
  }
}

/**
 * 把配色设置写入 :root CSS 变量（视频侧栏字幕区 + 视频内字幕复用）
 * 反思（2026-08-05）：提取为独立函数，_cfgReady 和 storage 监听器共用。
 *   旧版只写 first-bg/later-bg，漏了 first-fg/ann-bg/ann-fg，导致字色和注释色不跟随 popup。
 * 反思（2026-08-06 修正）：用户要求"注释为单词的前后景互换，总共两种颜色"。
 *   旧版注释配色独立配置且 fallback 为旧值 #e0e0e0/#616161，导致"设定栏暗底亮字但实际暗底暗字"。
 *   修正：注释配色自动派生自单词配色（annBg=firstFg, annFg=firstBg），不再独立配置。
 *   这样无论 storage 中 hintAnnotationBg/Fg 是什么旧值，注释始终是单词的前后景互换。
 * @param {object} settings
 */
function applyColorSettings(settings) {
  const rootStyle = document.documentElement.style;
  // 反思（2026-08-18 第七十三次修正）：默认曾是绿底白字。
  // 304次（用户"默认无底色"）：生词默认透明底绿字（注释见上）。
  const firstBg = settings.hintFirstBg || 'transparent';
  const firstFg = settings.hintFirstFg || '#2e6b43';
  rootStyle.setProperty('--beaver-first-bg', firstBg);
  rootStyle.setProperty('--beaver-first-fg', firstFg);
  rootStyle.setProperty('--beaver-later-bg', settings.hintLaterBg || firstBg);
  rootStyle.setProperty('--beaver-later-fg', settings.hintLaterFg || firstFg);
  // 注释配色 = 单词配色的前后景互换（annFg=单词底色）。
  // 302次（用户"注释也应当没有背景色"）：annBg 默认改透明（显式 popup 色此前已不读，保持）。
  rootStyle.setProperty('--beaver-ann-bg', 'transparent');
  rootStyle.setProperty('--beaver-ann-fg', firstBg);
}

/**
 * 应用视频侧栏注释样式预设（引导页选择，52 条统一共享池样式）
 * 280次：videoAnnotationStyle 复活——三功能独立选样式（多对多），与共享池同 id 集；
 *   root 加/换 beaver-ann-style-{id} 类（实际声明由注入的统一池样式表提供，
 *   buildAnnPoolCss 按 POOL_STYLES 生成，取代 sidebar.css 手写 16 条）。
 * @param {string} styleId 'none' 或其他样式 id
 */
function applyAnnStyle(styleId) {
  if (!_root) return;
  const id = (typeof styleId === 'string' && styleId !== 'none') ? styleId : '';
  for (const cls of Array.from(_root.classList)) {
    if (cls.startsWith('beaver-ann-style-')) _root.classList.remove(cls);
  }
  if (id) _root.classList.add('beaver-ann-style-' + id);
}

// 280次：注入统一池样式表（52 条共享样式声明，逐容器参数化选择器）。
//   挂 document.head（不依赖 _root 时点），选择器以 #beaver-sidebar 为根；
//   取代 sidebar.css 手写 16 条（文本侧栏 web-sidebar-impl.js 亦同源注入）。
injectAnnPoolCss();

/** 注入统一池样式表（style id 带 -vs 后缀，与文本侧栏 -ws 区分，二者可能共存一页） */
// 301次：个性化/用户条目规则刷新（独立覆盖写 textContent；空即只剩内置池）。
function refreshAnnPoolCss(customObj, userList) {
  let el = document.getElementById('beaver-ann-pool-css-vs');
  const extra = [];
  if (customObj && typeof customObj === 'object') {
    extra.push(Object.assign({ id: 'ann-custom' }, customObj));
  }
  if (Array.isArray(userList)) {
    for (const st of userList) {
      if (st && typeof st.id === 'string' && st.id.indexOf('ann-user-') === 0) extra.push(st);
    }
  }
  const css = buildAnnPoolCss({
    root: '#beaver-sidebar',
    word: '.beaver-sub-text .beaver-word',
    annInline: '.beaver-ann-inline',
    annWord: '.beaver-ann-line .beaver-ann-word',
    extra
  });
  if (!el) {
    el = document.createElement('style');
    el.id = 'beaver-ann-pool-css-vs';
    document.head.appendChild(el);
  }
  el.textContent = css;
}
function injectAnnPoolCss() {
  refreshAnnPoolCss(null, null);
}

// === 字幕到达后填充视频提示 ===
export async function updateSubtitles(subtitles) {
  if (!_root) {
    log('updateSubtitles: 骨架未启动, 忽略');
    return;
  }
  // 反思（第九十九次）：用户反馈"识别一小会儿就擅自切换到别的字幕轨道"。
  //   根因：ASR 运行中原生字幕异步到达，video-controller 调本函数整块覆盖面板，
  //   把 ASR 结果清掉换成原生轨。真换集时 video-controller 会先 stopASRInternal
  //   （_asrActive 已 false），不会走到这里被拦——守卫只挡"运行中覆盖"。
  if (_asrActive) {
    log('updateSubtitles: ASR 运行中，忽略原生字幕覆盖（', (subtitles || []).length, '条）');
    return;
  }
  // 反思（2026-07-28）：_asrCacheLoaded 重置从 renderSubtitlePanel 移到这里，
  //   只有字幕被替换时才重置缓存标记，避免重新渲染时误清导致频繁刷新。
  _asrCacheLoaded = false;
  // 第一百二十二次：新字幕到达，无字幕自动折叠配额重置（下一集/下次空轨道可再自动折叠）
  setNoSubAutoCollapseDone(false);
  // 换集/首次：先显加载提示（清掉旧字幕条目），再填充新字幕
  showLoading();
  _subtitles = Array.isArray(subtitles) ? subtitles : [];
  // 反思（2026-07-28 #bug2）：字幕未按时间顺序排列。B站/YouTube/ASR 缓存字幕虽通常有序，
  //   但不保证严格递增（ASR 缓存段可能乱序，多轨道合并也可能打乱）。强制按 start 升序排序
  //   保证 highlightCurrent 和视觉顺序正确。
  if (_subtitles.length > 1) {
    _subtitles.sort((a, b) => (a?.start || 0) - (b?.start || 0));
  }
  // 反思（2026-08-06）：同步字幕到视频内字幕 overlay（全屏时显示）
  overlaySetSubtitles(_subtitles);
  // 等配置加载完再渲染，避免用默认 rankThreshold=0 误过滤
  // （text-hint 用真实阈值，若字幕窗口用默认值会出现"文本提示有结果而字幕窗口没有"）
  if (_cfgReady) {
    try { await _cfgReady; } catch (e) { /* catch 内已 warn，忽略 */ }
  }
  // 分批渲染（renderSubtitlePanel 内部自带 setTimeout 让出主线程）
  await rerender();
  // 第一百二十五次：字幕填充后补测一次高度（锚点可能晚于骨架就绪）
  requestSyncHeightOnce();
  // 第一百三十三次：首批真实字幕到达 → 自动展开一次（启动折叠态的解除）
  if (_subtitles.length > 0) autoExpandOnce();
  log('字幕已填充:', _subtitles.length, '条, rankThreshold=', _rankThreshold,
      '字幕语言样本:', _subtitles.slice(0, 2).map(s => (s && s.text) ? s.text.slice(0, 30) : '(空)'));
}

/**
 * 无字幕时自动加载 ASR 缓存（若有）。
 * 反思（2026-07-08）：用户反馈「asr缓存结果并没有出现在轨道，只有识别后才出现」。
 *   用户确认期望「有缓存自动加载显示」，时机「仅无字幕时自动加载」
 *   （符合约束「字幕加载优先级：优先显示找到的字幕内容，其次显示ASR结果」）。
 *   流程：生成 videoKey → 查 hasASRCache → 有则 getCachedSubtitles 取字幕数组
 *   → 按 start 排序 → updateSubtitles 填充字幕面板。
 *   点 ASR 按钮时走 startASRInternal 清空重建（startASR 内部 replayCachedSegs 回放+实时接续）。
 * @returns {Promise<boolean>} 是否成功加载了缓存字幕
 */
export async function loadASRCacheIfAny() {
  if (!_video) {
    log('loadASRCacheIfAny: 无 video, 跳过');
    return false;
  }
  const videoKey = makeVideoKey();
  const has = await hasASRCache(videoKey);
  if (!has) {
    log('loadASRCacheIfAny: 无 ASR 缓存, videoKey=', videoKey);
    return false;
  }
  const subs = await getCachedSubtitles(videoKey);
  if (!subs || subs.length === 0) {
    log('loadASRCacheIfAny: 缓存为空, videoKey=', videoKey);
    return false;
  }
  // 按 start 排序（缓存段顺序未必严格递增，highlightCurrent 假定有序）
  subs.sort((a, b) => (a.start || 0) - (b.start || 0));
  _videoKey = videoKey;  // 保存供后续 ASR 按钮复用
  log('loadASRCacheIfAny: 检测到 ASR 缓存, 自动加载', subs.length, '条, videoKey=', videoKey);
  await updateSubtitles(subs);  // 内部 renderSubtitlePanel 会重置 _asrCacheLoaded=false
  _asrCacheLoaded = true;  // updateSubtitles 之后再设 true，标记面板字幕来源为缓存预加载
  return true;
}

/**
 * 加载 ASR 缓存并返回覆盖率，供 video-controller 判断是否需自动继续识别。
 * 反思（2026-07-10 #86）：用户要求「若是用户首选英语，而且已经有asr缓存，
 *   那么应当优先加载asr轨道，不足之处还要自动识别」。
 *   本函数加载缓存字幕到面板，同时返回覆盖率供调用方决定是否自动启动 ASR。
 * @returns {Promise<{loaded:boolean, coverage:number}>}
 */
export async function loadASRCacheWithCoverage() {
  // 反思（2026-07-28）：用户反馈"经常刷新字幕区"。
  //   根因：video-controller 每次 handleSubtitlesArrived 都调用本函数，
  //   每次都 updateSubtitles 清空当前字幕重新加载缓存，导致频繁刷新。
  //   修正：若缓存已加载，跳过，返回上次的覆盖率。
  if (_asrCacheLoaded) {
    log('loadASRCacheWithCoverage: 缓存已加载, 跳过, coverage=', _lastAsrCacheCoverage.toFixed(2));
    return { loaded: true, coverage: _lastAsrCacheCoverage };
  }
  if (!_video) {
    log('loadASRCacheWithCoverage: 无 video, 跳过');
    return { loaded: false, coverage: 0 };
  }
  const videoKey = makeVideoKey();
  const has = await hasASRCache(videoKey);
  if (!has) {
    log('loadASRCacheWithCoverage: 无 ASR 缓存, videoKey=', videoKey);
    return { loaded: false, coverage: 0 };
  }
  const subs = await getCachedSubtitles(videoKey);
  if (!subs || subs.length === 0) {
    log('loadASRCacheWithCoverage: 缓存为空, videoKey=', videoKey);
    return { loaded: false, coverage: 0 };
  }
  subs.sort((a, b) => (a.start || 0) - (b.start || 0));
  _videoKey = videoKey;
  log('loadASRCacheWithCoverage: 加载 ASR 缓存', subs.length, '条, videoKey=', videoKey);
  await updateSubtitles(subs);
  _asrCacheLoaded = true;
  const duration = (_video.duration && !isNaN(_video.duration)) ? _video.duration : 0;
  const coverage = await getASRCoverage(videoKey, duration);
  _lastAsrCacheCoverage = coverage;  // 保存覆盖率，供后续跳过时返回
  log('loadASRCacheWithCoverage: 覆盖率=', coverage.toFixed(2), 'duration=', duration.toFixed(1));
  return { loaded: true, coverage };
}

/**
 * 选中 ASR 轨道并按需自动继续识别。
 * 反思（2026-07-10 #86）：用户要求「选择asr轨道后，若识别区间未覆盖全文，则继续识别，
 *   asr按钮此时才默认选中」。本函数检查 ASR 缓存覆盖率，不完整时调 toggleASR 启动增量识别
 *   （asr-client 的 biliRecognizeLoop 自动跳过已监听段，只识别未覆盖部分）。
 * @param {number} coverage - 缓存覆盖率 0-1，<1 视为不完整
 */
export function selectASRTrackAndContinue(coverage) {
  if (!_root) return;
  // 同步轨道下拉框到 ASR
  if (_asrTrackIndex >= 0) {
    const sel = _root.querySelector('#beaver-track-select');
    if (sel) sel.value = String(_asrTrackIndex);
  }
  if (coverage < 1) {
    // 缓存不完整，自动启动 ASR 继续识别未覆盖部分
    log('selectASRTrackAndContinue: 缓存不完整(coverage=' + coverage.toFixed(2) + '), 自动启动 ASR');
    // 置标记防止后续 setTracks 覆盖 ASR 选中态
    _userPickedASR = true;
    if (!_asrActive) {
      const asrBtn = _root.querySelector('#beaver-asr-toggle');
      if (asrBtn) {
        const rect = asrBtn.getBoundingClientRect();
        toggleASR(rect.left, rect.top);
      } else {
        toggleASR(0, 0);
      }
    }
  } else {
    log('selectASRTrackAndContinue: 缓存完整(coverage=' + coverage.toFixed(2) + '), 仅选中 ASR 轨道');
  }
}

// === 设置字幕轨道选择器 ===
// tracks: 轨道列表, pickedIndex: 默认选中, fetchFn: 按轨道下载字幕的函数
// 反思（2026-07-03）：
//   1) 用户要求"字幕虚空轨道，要真实"——去掉"空(None)"选项，只列真实轨道。
//      onTrackSelect 不再处理 idx=-1（选空）分支。
//   2) ASR 按钮已移入 #beaver-track-row 与轨道同行；行始终显示（无轨道时
//      只显示 ASR 按钮，select/label 隐藏），保证 ASR 按钮始终可用。
//   3) ASR 作为最后一个轨道选项添加（🎤 ASR），用户可从下拉框选择。
//      选择 ASR 轨道时启动 ASR（先回放缓存再实时识别），选择其他轨道时
//      停止 ASR 并加载对应字幕。
// 反思（2026-07-08）：用户要求"只有一种 asr，先取本地缓存，若在 asr 及时
//   补充"。合并 Live/Cached 双轨道为单一 ASR 轨道，点击时 startASR 内部
//   先回放缓存段再实时识别接续（replayCachedSegs + 实时识别）。
export function setTracks(tracks, pickedIndex, fetchFn) {
  _tracks = tracks ? [...tracks] : [];
  _trackFetchFn = fetchFn;
  _asrTrackIndex = -1;
  if (!_root) return;
  const row = _root.querySelector('#beaver-track-row');
  const sel = _root.querySelector('#beaver-track-select');
  const label = _root.querySelector('#beaver-track-label');
  if (!row || !sel) return;

  sel.innerHTML = '';

  // 添加常规轨道
  if (_tracks.length > 0) {
    _tracks.forEach((tr, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${tr.languageCode}${tr.name ? ' - ' + tr.name : ''}`;
      sel.appendChild(opt);
    });
  }

  // 添加 ASR 轨道
  _asrTrackIndex = _tracks.length;
  _tracks.push({ languageCode: 'asr', name: 'ASR', isASR: true });
  const asrOpt = document.createElement('option');
  asrOpt.value = String(_asrTrackIndex);
  asrOpt.textContent = 'ASR';
  sel.appendChild(asrOpt);

  // 始终显示 select 和 label（因为有 ASR 选项）
  sel.style.display = '';
  if (label) label.style.display = '';
  // 反思（2026-07-10 #85）：用户手动选了 ASR 轨道后，字幕异步到达触发 setTracks 时
  //   不能覆盖用户的 ASR 选中态（否则"过一会又自己改成中文轨道"）。
  //   _userPickedASR=true 时保持 ASR 选中，否则用 pickedIndex。
  if (_userPickedASR && _asrTrackIndex >= 0) {
    sel.value = String(_asrTrackIndex);
    log('轨道选择器已设置:', _tracks.length, '条轨道(含ASR), 保持用户已选 ASR');
  } else {
    sel.value = String(pickedIndex || 0);
    log('轨道选择器已设置:', _tracks.length, '条轨道(含ASR), 选中=', pickedIndex);
  }
  row.style.display = 'flex';

  // 第一百四十四次（用户裁定"咋不模仿用户操作切换轨道？等很久还在刷"）：
  // 废除同调用反复重试。改为**模拟用户动作**：直取一次 → 9s 后模拟"切走再切回"
  // （走与手动完全相同的 onTrackSelect 路径，含其内部二重试与 path0 播放器等待）
  // → 22s 再模拟一轮 → 仍空则展开显示状态并停止（不再无限刷）。全程至多 4 次可见尝试。
  clearTimeout(setTracks._retryTimer);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** 模拟用户切走再切回目标轨道 */
  const __mimicSwitch = async (targetIdx) => {
    if (!_root || _asrActive) return false;
    // 找一个非目标的普通轨道；纯 ASR 视频则用 ASR 项当"另一轨"
    let other = -1;
    for (let i = 0; i < _tracks.length; i++) {
      if (i !== targetIdx && !_tracks[i].isASR) { other = i; break; }
    }
    if (other < 0 && _asrTrackIndex >= 0 && _asrTrackIndex !== targetIdx) other = _asrTrackIndex;
    if (other < 0 || other === targetIdx) return false;
    log('模拟用户操作: 切走 →', other, _tracks[other] && _tracks[other].languageCode);
    sel.value = String(other);
    await onTrackSelect(other);
    await sleep(800); // 停顿如真人
    if (!_root || _userPickedASR) return false; // 切走时用户/系统已改选，放弃接管
    log('模拟用户操作: 切回 →', targetIdx);
    sel.value = String(targetIdx);
    await onTrackSelect(targetIdx);
    return true;
  };
  const __ROUNDS = [
    { at: 0, mimic: false },
    { at: 9000, mimic: true },
    { at: 22000, mimic: true }
  ];
  let __round = -1;
  let __startedAt = 0;
  const __tick = async () => {
    try {
      __round++;
      _autoChainActive = (__round < __ROUNDS.length); // 第一百四十五次：链路活动标记
      if (__round >= __ROUNDS.length) {
        _autoChainActive = false;
        // 链路走完仍空：展开亮出状态 + 单条汇总告警（不再刷）
        if (getSidebarCollapsedFlag() && !(_subtitles && _subtitles.length > 0)) {
          try { if (_root.classList.contains('beaver-collapsed')) toggleSidebarCollapse(false); } catch (e) { /* ignore */ }
        }
        // 第一百八十二次：模块段归一——[youtube] 专属 lib/subtitle/youtube-fetcher.js，
        //   本文件的日志一律用 [video-sidebar]，避免同名前缀跨文件混淆。
        console.warn('[VocabRadar][video-sidebar] YouTube 自动加载链路(含模拟切轨)走完仍未命中——请点侧栏徽标贴日志');
        return;
      }
      if (!_root || _asrActive) { _autoChainActive = false; return; }
      if (_subtitles && _subtitles.length > 0) { _autoChainActive = false; return; }
      const cur = parseInt(sel.value, 10);
      if (!(cur >= 0 && cur < _tracks.length)) { _autoChainActive = false; return; }
      const trk = _tracks[cur];
      if (!trk || trk.isASR || !_trackFetchFn) { _autoChainActive = false; return; }
      const round = __ROUNDS[__round];
      log(`setTracks 自动加载(${__round + 1}/${__ROUNDS.length}${round.mimic ? ' ·模拟切轨' : ''}):`, cur, trk.languageCode);
      if (round.mimic) await __mimicSwitch(cur);
      else await onTrackSelect(cur);
      if (_subtitles && _subtitles.length > 0) {
        log('setTracks 自动加载成功(第', __round + 1, '轮)');
        _autoChainActive = false;
        return;
      }
      const next = __ROUNDS[__round + 1];
      if (next) {
        const wait = Math.max(200, next.at - (Date.now() - __startedAt));
        clearTimeout(setTracks._retryTimer);
        setTracks._retryTimer = setTimeout(__tick, wait);
      }
    } catch (e) { /* ignore */ }
  };
  __startedAt = Date.now();
  setTracks._retryTimer = setTimeout(__tick, __ROUNDS[0].at);
}

/**
 * 确保 ASR 轨道选项在下拉框中可用。
 * 当 setTracks 尚未被调用（如 B站无多轨道）时，仍需显示 ASR 选项供用户选择。
 * 在 startSidebar 中调用，setTracks 调用后会被覆盖（setTracks 内部也添加 ASR）。
 */
function ensureASRTrackOption() {
  if (!_root) return;
  const sel = _root.querySelector('#beaver-track-select');
  const label = _root.querySelector('#beaver-track-label');
  const row = _root.querySelector('#beaver-track-row');
  if (!sel || !row) return;
  // setTracks 已设置过 ASR 选项则跳过
  if (_asrTrackIndex >= 0) return;
  _tracks = [];
  _asrTrackIndex = 0;
  _tracks = [{ languageCode: 'asr', name: 'ASR', isASR: true }];
  sel.innerHTML = '';
  const opt = document.createElement('option');
  opt.value = '0';
  opt.textContent = 'ASR';
  sel.appendChild(opt);
  sel.style.display = '';
  if (label) label.style.display = '';
  row.style.display = 'flex';
  log('ensureASRTrackOption: 已添加 ASR 轨道选项');
}

// 用户切换字幕轨道
// 反思（2026-07-03）：ASR 作为轨道之一，选择 ASR 轨道时启动实时识别，
// 选择其他轨道时停止 ASR（如运行中）并加载对应字幕。
// 反思（2026-07-08）：合并 Live/Cached 双轨道为单一 ASR 轨道，点击时
//   startASR 内部先回放缓存段再实时识别接续（replayCachedSegs + 实时识别）。
async function onTrackSelect(idx) {
  if (!_root) return;
  const panel = _root.querySelector('#beaver-subtitle-panel');
  // 防御性拦截
  if (idx === -1) return;

  // === ASR 轨道被选中：按缓存覆盖率决定是否启动 ASR 继续识别 ===
  // 反思（2026-07-09）：用户反馈「轨道切换asr之后，为啥asr按钮也按下去了？」。
  //   根因：旧版调用 toggleASR（toggle 语义），ASR 已运行时会误停止。
  //   修正：ASR 已运行时不重复触发（仅同步轨道选中态），未运行时才启动。
  // 反思（2026-07-10 #86）：用户要求「选择asr轨道后，若识别区间未覆盖全文，则继续识别，
  //   asr按钮此时才默认选中」。即：缓存完整时仅选中轨道不启动 ASR（按钮不选中），
  //   缓存不完整时才启动 ASR 继续识别（按钮选中）。
  if (_tracks && _tracks[idx] && _tracks[idx].isASR) {
    // #85: 用户手动选 ASR 轨道，置标记防止后续 setTracks 覆盖选中态
    _userPickedASR = true;
    if (_asrActive) {
      log('用户选择 ASR 轨道, ASR 已运行, 仅同步选中态');
      return;
    }
    // 检查 ASR 缓存覆盖率，决定是否需要继续识别
    const videoKey = makeVideoKey();
    const duration = (_video && _video.duration && !isNaN(_video.duration)) ? _video.duration : 0;
    const coverage = await getASRCoverage(videoKey, duration);
    if (coverage >= 1) {
      // 缓存完整：仅选中 ASR 轨道，不启动 ASR
      log('用户选择 ASR 轨道, 缓存完整(coverage=' + coverage.toFixed(2) + '), 仅选中轨道');
      // 若面板未显示缓存字幕，加载之
      if (!_asrCacheLoaded && _subtitles.length === 0) {
        await loadASRCacheIfAny();
      }
      return;
    }
    // 缓存不完整或无缓存：启动 ASR 继续识别
    log('用户选择 ASR 轨道, 缓存不完整(coverage=' + coverage.toFixed(2) + '), 启动 ASR');
    const asrBtn = _root.querySelector('#beaver-asr-toggle');
    if (asrBtn) {
      const rect = asrBtn.getBoundingClientRect();
      toggleASR(rect.left, rect.top);
    } else {
      toggleASR(0, 0);
    }
    return;
  }

  // === 常规轨道：如 ASR 运行中则先停止（跳过恢复，新轨道会自己加载字幕）===
  // #85: 用户切换到常规轨道，清除 ASR 选中标记
  _userPickedASR = false;
  if (_asrActive) {
    stopASRInternal(true);
  }
  // 第一百四十五次：用户手动切轨 = 立即接管，后台自动链路停止（不与用户抢）
  clearTimeout(setTracks._retryTimer);
  _autoChainActive = false;

  if (!_tracks || !_tracks[idx] || !_trackFetchFn) return;
  log('用户切换轨道:', idx, _tracks[idx].languageCode);
  if (panel) showLoading();
  try {
    // 第一百三十四次：空结果自动重试×2（1.5s/4s）——手动"切走再切回"能成功证明
    // 多为时序问题（播放器/单例未热），不应让用户手动救。选轨令牌防过期重试覆盖。
    if (!onTrackSelect._selToken) onTrackSelect._selToken = 0;
    const selToken = ++onTrackSelect._selToken;
    const trk = _tracks[idx];
    const delays = [1500, 4000];
    let subs = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      subs = await _trackFetchFn(trk);
      if (subs && subs.length > 0) break;
      if (selToken !== onTrackSelect._selToken) { log('轨道重试作废(已换轨)', trk.languageCode); return; }
      if (attempt < delays.length) {
        log('轨道下载为空, 重试', attempt + 1, '/', delays.length, ':', trk.languageCode);
        await new Promise((r) => setTimeout(r, delays[attempt]));
        if (selToken !== onTrackSelect._selToken) return;
      }
    }
    if (subs && subs.length > 0) {
      await updateSubtitles(subs);
    } else {
      if (panel) showNoSubtitle();
      log('轨道下载为空(含2次重试):', trk.languageCode);
    }
  } catch (e) {
    console.error('[VocabRadar][video-sidebar][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] 轨道切换失败:', e);
    if (panel) showNoSubtitle('Error: ' + e.message);
  }
}

// === 显示"无字幕"提示 ===
// 反思（2026-07-07）：用户要求"有啥显示啥"。
//   旧版清空 _subtitles/_subEntries/_allAnnotations，导致 tabs 无法切换查看
//   已收集的生词，且字幕 panel 内容全无。修正：只更新字幕 panel 显示提示，
//   保留旧数据，tabs（字幕/生词表/练习）仍可点击，生词表保留已收集的生词。
export function showNoSubtitle(msg) {
  if (!_root) return;
  // 不清空 _subtitles/_subEntries/_allAnnotations：保留旧数据供 tabs 切换
  clearLoading();
  const panel = _root.querySelector('#beaver-subtitle-panel');
  if (panel) {
    // msg 为已知 i18n key 时按 key 渲染（标记 data-i18n，切换 UI 语言时 applyI18n 自动更新）；
    // msg 为普通文本（动态错误信息）时直接显示不跟随切换；不传 msg 默认 noSubtitleTip。
    const knownKeys = ['noSubtitleTip', 'subtitleTimeoutTip'];
    const key = (!msg) ? 'noSubtitleTip' : (knownKeys.includes(msg) ? msg : null);
    const tip = key ? t(key) : msg;
    const i18nAttr = key ? `data-i18n="${key}"` : '';
    panel.innerHTML = `<div class="beaver-loading" style="padding:40px 16px">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" style="opacity:.35"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6zm0 4h8v2H6zm10 0h2v2h-2zm-6-4h8v2h-8z" fill="currentColor"/></svg>
      <span ${i18nAttr} style="font-size:1em">${escapeHtml(tip)}</span>
    </div>`;
  }
  log('显示无字幕提示（保留 tabs 可切换）');
  // 第一百四十七次（用户裁定"有时候还会自动折叠"=不可接受）：撤销无字幕自动折叠。
  // 启动折叠/首批内容展开一次的既定策略不变；此后任何时刻都尊重用户当前展开态。
}

// === 完全销毁视频提示（SPA 导航到非视频页时调用）===
// 反思（2026-07-07）：用户要求"处理不了的视频不显示窗口，参照videoseek"。
// 第二百二十五次：删除上方已失效的"视频提示显隐控制（由 subtitleOverlay 设置驱动）"注释块——
//   subtitleOverlay 键已随死键清理删除（SW install 写入、全库零读取），显隐由 overlayEnabled
//   与侧栏关闭按钮接管。
// SPA 从视频页导航到非视频页（番剧/直播/首页）时，需完全清理视频提示：
// 断开所有 observer（否则 reinjectGuard 会重新插入已移除的 _root）、
// 停止 ASR、移除监听器、清 loading 超时、移除 DOM、重置状态。
export function destroySidebar() {
  if (!_root) {
    log('destroySidebar: 无视频提示可销毁');
    return;
  }
  log('销毁视频提示，清理 observer/ASR/监听器/DOM');
  // 停止 ASR（如在运行）
  if (_asrActive) {
    try { stopASRInternal(true); } catch (_) { /* ignore */ }
  }
  // 断开 observer（关键：否则 reinjectGuard 会重新插入移除的 _root）
  // 拆分第三刀：清理高度同步资源（断开 reinject/heightSync 观察器 + 清 timers +
  //   移除 resize 监听器 + 重置 started/maxH/locked），等价提取自原内联序列
  teardownLayout();
  // 移除 video 监听器
  if (_video) {
    if (_timeListener) _video.removeEventListener('timeupdate', _timeListener);
    if (_seekedListener) _video.removeEventListener('seeked', _seekedListener);
  }
  // 反思（2026-08-06）：销毁视频内字幕 overlay
  try { stopOverlay(); } catch (_) { /* ignore */ }
  // 清 loading 超时
  if (_loadingTimeout) { clearTimeout(_loadingTimeout); _loadingTimeout = null; }
  // 移除 DOM
  try { if (_root.parentNode) _root.parentNode.removeChild(_root); } catch (_) { /* ignore */ }
  // 重置模块状态
  _root = null;
  _video = null;
  _timeListener = null;
  _seekedListener = null;
  _subtitles = [];
  resetRenderState();
  _asrCacheLoaded = false;
  _asrActive = false;
  _userPickedASR = false;  // #85: 同步重置用户 ASR 选中标记
}

// 第一百三十六次：popup「视频侧栏」开关的隐藏标记——hideSidebar 置位、showSidebar 复位，
// 供可见性看门狗豁免（用户主动关闭的侧栏不得被自动恢复）。
let _hiddenByUserSetting = false;
// 2026-08-28 拆分第三刀：_hiddenByUserSetting 接驳导出（vs/sidebar-layout 的
// 重注入可见性看门狗读取，等价于原同模块直接读）
export function getHiddenByUserSetting() { return _hiddenByUserSetting; }

export function hideSidebar() {
  if (_root) _root.style.display = 'none';
  _hiddenByUserSetting = true;
}

export function showSidebar() {
  if (_root) _root.style.display = '';
  _hiddenByUserSetting = false;
}

// === 274次：query 标签 + learn 草稿（与文本侧栏同构） ===

/**
 * query 标签查询：结果卡复用右键搜索唯一定义（th/panel.js），Shadow DOM 承载
 * 防卡片 CSS 泄漏宿主页；与文本侧栏 runSidebarQuery 同构。
 * @param {string} text 查询文本（空则回空态提示）
 */
async function runVideoQuery(text) {
  const box = _root.querySelector('#beaver-vs-query-result');
  if (!box) return;
  const trimmed = String(text || '').trim();
  const input = _root.querySelector('#beaver-vs-query-input');
  if (input && trimmed) input.value = trimmed;
  if (!trimmed) {
    box.innerHTML = '<div class="beaver-query-tip">' + t('ws.queryTip') + '</div>';
    return;
  }
  box.innerHTML = '';
  const host = document.createElement('div');
  box.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  // 309次第六轮（用户"查询窗口只有 https://localhost:3001 字号才会偏大"）：本内嵌卡
  //   与文本侧栏 query 标签同构——嵌套 host 被 `#beaver-sidebar * { font-size: inherit }`
  //   锁死继承侧栏宿主 16px，卡根节点写死 14px 与右键面板/tooltip 同基准（同修详见 ws/ui.js）
  shadow.innerHTML = '<style>' + buildPanelCss() + '</style>'
    + '<div class="beaver-query-card" style="padding:10px 12px;background:#fbfdf9;border-radius:8px;font-size:14px;line-height:1.5;">'
    + buildCardInnerHTML() + '</div>';
  bindLemmaChipClick(shadow);
  try {
    await renderQueryCard(shadow, trimmed);
  } catch (e) {
    console.error('[VocabRadar][video-sidebar] query 标签查询失败:', e);
  }
}

/**
 * learn 按钮（🎯）：视频侧栏草稿导入——字幕正文（buildSubtitleBody）+ 生词
 * （getAllAnnotations，trim+小写去重）组装草稿，id 前缀 ext-v- 与网页草稿区分
 * （同视频换集/换页各自成稿），复用 ws/draft-export 的缓存 upsert（网站按
 * id+version 幂等）；成功后跳转站点「我的卷轴」（getSiteUrl：本地构建跳本地、
 * 商店安装跳线上）。无正文 toast 提示不静默，失败 toast 原因。
 */
async function onLearnClickVs() {
  try {
    const body = await buildSubtitleBody();
    const text = String(body || '').trim();
    if (!text) { toast(t('learn.noContent')); return; }
    const title = (document.title || '').trim() || location.hostname;
    const words = [];
    const seen = new Set();
    for (const a of getAllAnnotations()) {
      const w = (a && typeof a.word === 'string') ? a.word.trim() : '';
      if (!w) continue;
      const k = w.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      words.push(w);
    }
    const draft = {
      id: 'ext-v-' + djb2Hash(currentVideoKey() + '|' + title),
      title: title,
      lang: _videoLearnLang || 'en',
      text: text,
      words: words,
      source: { type: 'extension-video', url: location.href },
      version: 1,
      createdAt: Date.now()
    };
    await saveDraftToCache(draft);
    log('learn 草稿已入缓存 id=' + draft.id + ' words=' + words.length);
    toast(t('learn.importOk'));
    window.open(getSiteUrl() + '/#/my-scrolls', '_blank');
  } catch (e) {
    console.error('[VocabRadar][video-sidebar] learn 草稿导入失败:', e);
    toast(t('learn.importFail'));
  }
}

// === 自动启动 ASR（已废弃，保留函数供未来需要时恢复）===
// 反思（2026-07-06 三次修复）：用户反馈"语音识别为啥一直选中，哪怕是刷新网页"。
// 旧版在无字幕时自动调用 autoStartASR()，导致每次刷新页面都自动启动 ASR，
// 语音识别按钮一直处于选中态。修正：video-controller 不再调用此函数，
// 改为显示"无字幕"提示，用户可手动点击 🎤 按钮或选择 ASR 轨道启动。
// 函数保留不删除，以防未来需要恢复自动启动行为。
export function autoStartASR() {
  if (!_root) return;
  if (_asrActive) return;  // 已在运行则不重复启动
  // sidebar 被隐藏（display:none，关闭按钮/隐藏参数所致）时不自动启动 ASR
  if (_root.style.display === 'none') return;
  log('无常规字幕，自动启动 ASR 作为字幕轨道');
  toggleASR(0, 0);
}
