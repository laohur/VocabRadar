// VocabRadar 视频提示 content script
//
// 注入位置：B站视频页右侧 .right-container 内部顶部。作为文档流元素，不 fixed 不遮盖。
//   以右列首位 + 顺序守卫置顶为准，详见 vs/sidebar-layout.js。
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
//
// ASR 设计：ASR 结果作为"可选轨道"出现在轨道下拉框中（🎤 ASR），与普通字幕
//   完全同源处理——同样的 createEmptySlot 渲染、同样的 getAnnotations 生词
//   注释、同样的 highlightCurrent 同步高亮、同样的复制/OCR/评论按钮。
//   不使用独立的 _asrEntries 数组，ASR 结果直接进入 _subtitles/_subEntries。
//   启动 ASR 时保存当前字幕，清空面板；停止 ASR 时恢复原字幕。

import { setRankMax, setMyWords } from '../lib/annotator.js';
// youtubei 单例预热（与播放器加载并行，消除首取轨道冷启动竞争→空结果）
import { warmYouTubeCaptionInnertube } from '../lib/subtitle/index.js';
// ASR 进度条 DOM 子模块（依赖注入 getRoot，避免循环 import）
import { initAsrProgress } from './vs-asr-progress.js';
// 顶行统一构建器——视频/文本侧栏共用同一代码文件（用户裁定）
import { ensureTopbarCss } from '../lib/sidebar-topbar.js';
// BUILD_STAMP：CSS 缓存克星版本参数（link href 带 ?v= 构建戳，防旧 sidebar.css 缓存）
import { BUILD_STAMP } from '../lib/styles.js';
import { initLang, onLangChange } from '../lib/i18n.js';
// 词典就绪双钩子——字幕渲染可能抢在词典冷装载（1~17s）之前，就绪后需补渲染才能出注释
//   （ensureRanksReady/ensureReady/isLoaded）
import { ensureReady, ensureRanksReady, isLoaded } from '../lib/dictionary.js';

/**
 * 当前视频稳定标识（video-controller 区分真换集与画质切换）
 * makeVideoKey 由 URL 的 bv/v/p/ep_id/cid 等参数组成；B站清晰度自动切换不改这些参数。
 * @returns {string}
 */
export function currentVideoKey() {
  try { return makeVideoKey() || ''; } catch (e) { return ''; }
}

/** ASR 是否运行中（video-controller 伪换集过滤用） */
export function isASRActive() {
  return !!_asrActive;
}
// 视频内字幕 overlay：sidebar 负责启动/同步字幕到 overlay，ASR 新增字幕也实时同步
import { startOverlay, stopOverlay, setSubtitles as overlaySetSubtitles, setOverlayEnabled as overlaySetEnabled, setRankThreshold as overlaySetRank } from './subtitle-overlay.js';
// 停用规则（Deactivate）——「视频叠加字幕」规则对 overlay 生效与否的唯一否决点
//   （init 读值/按钮切换/跨标签同步三处消费 _overlayRuleSup）；
//   匹配/存储逻辑唯一来源 lib/deactivate.js
import { suppressionFor } from '../lib/deactivate.js';
// 本文件为门面（facade）。受控循环 import 说明：vs/playback-gate、vs/asr-stage、vs/ocr
// 需调用本门面导出的函数（getRoot/getActiveVideo/isASRActive/toast/getSubtitlesRef/
// getVideoLearnLang/showNoSubtitle，均为函数声明、提升后可用）；这些子模块顶层仅
// 初始化自身状态，对本门面绑定的调用全部发生在函数体内——运行时安全，无 TDZ 风险。
import { log, setDebug } from './vs/logger.js';
import { makeVideoKey } from './vs/dom-utils.js';
// 布局子模块（注入/高度同步/折叠/拖拽/重注入）：
// 下列符号均为原门面内同名函数/状态接驳
import {
  autoExpandOnce, requestSyncHeightOnce,
  injectIntoPage, startReinjectGuard, startSyncHeight,
  wireUnifiedFormEvents, handleDragResize, stopHeightSync, teardownLayout,
  getSidebarCollapsedFlag,
  setNoSubAutoCollapseDone
} from './vs/sidebar-layout.js';
// 注入时机分档——getInjectTiming 读档位、waitForBiliCommentsThen 档3等待；
// 档位定义与判读矩阵见 vs/inject-timing.js 文件头注释
import { getInjectTiming, waitForBiliCommentsThen } from './vs/inject-timing.js';
// 字幕渲染子模块（字幕/生词表面板渲染、注释获取缓存、ASR 字幕插入、复制/评论/词单）
import {
  rerender, rerenderPanelOnly, rerenderSlotsFromCache,
  highlightCurrent,
  resetRenderState, setDetailMode, getDetailMode
} from './vs/subtitle-renderer.js';
import { toast } from './vs/toast.js';
export { toast };
import { buildSidebar, applyInlineOrder, applyI18n } from './vs/build.js';
// 加载态/超时兜底/无字幕提示与计时状态（showNoSubtitle 经门面接驳导出，
//   subtitle-renderer/vc/controller/guide-common 引用方符号不变）
import { showLoading, clearLoadingTimeout } from './vs/loading.js';
export { clearLoading, showNoSubtitle } from './vs/loading.js';
// 配色写入/注释样式类/统一池样式表（其模块顶层的 injectAnnPoolCss() 注入副作用随本 import 执行）
import { applyColorSettings, applyAnnStyle, refreshAnnPoolCss } from './vs/ann-style.js';
// ASR 开关/停止与缓存加载（loadASRCacheIfAny/loadASRCacheWithCoverage/
//   selectASRTrackAndContinue 经门面 export 接驳导出，vc/controller 引用方符号不变；
//   toggleASR 无门面调用点，bindEvents/tracks/actions 均直接从 asr-flow 导入）
import { stopASRInternal, loadASRCacheIfAny, loadASRCacheWithCoverage, selectASRTrackAndContinue } from './vs/asr-flow.js';
export { loadASRCacheIfAny, loadASRCacheWithCoverage, selectASRTrackAndContinue };
// 轨道下拉/自动加载链路/选轨处理（setTracks 经门面 export 接驳导出）
import { setTracks, ensureASRTrackOption } from './vs/tracks.js';
export { setTracks };
// 朗读/查询/learn 草稿/自动识别
import { autoStartASR } from './vs/actions.js';
export { autoStartASR };
// 全部事件接线（startSidebar 调用）
import { bindEvents } from './vs/bind-events.js';

// === 模块状态 ===
let _root = null;             // 视频提示根元素
// 根元素获取器注入 ASR 进度条子模块（箭头函数延迟取值，规避 TDZ；
// _root 换集重建时子模块自动跟随新引用）
initAsrProgress({ getRoot: () => _root });
let _video = null;            // video 元素
let _subtitles = [];          // [{start, end, text}]
let _rankThreshold = 5000;    // 词频阈值
let _myWords = null;          // My Words 生词/熟词表（storage.myWords；null=未加载，startOverlay 传参用）
// 是否注释表外词（键名 annotateOov，默认不选）
let _annotateOov = false;
// 注释重复生词（默认不选，同一字幕文本内重复词仅注释首次）
let _annotateRepeat = false;
// 侧邻注释模板（vs/subtitle-renderer 消费；与 styles.js DEFAULT_ANN_TEMPLATE 同步）
let _annTemplate = '{target}{annotation}';
// 视频叠加字幕开关：缓存存储值供 startOverlay 启动时使用（不得硬编码覆盖 storage）；
//   默认不选，读取判据严格 === true（未设置=不选）
let _overlayEnabled = false;
// 「视频叠加字幕」停用规则否决位——true 时无论 storage.overlayEnabled 为何，
//   overlay 一律不生效（init 读值/按钮切换/跨标签同步三处 AND 本位）。
//   值在 startSidebar 入口刷新一次（每视频启动时点最新），并由 storage.onChanged
//   的 deactivateRules 分支实时更新。
let _overlayRuleSup = false;
let _activeTab = 'subtitle';  // 当前 tab
let _syncEnabled = true;      // 同步滚动高亮

let _timeListener = null;     // timeupdate 监听器（同步高亮）
let _seekedListener = null;   // seeked 监听器（seek 后立即高亮）
let _cfgReady = null;        // 配置加载 Promise（确保 updateSubtitles 渲染前 _rankThreshold 已就绪）

// === ASR 识别状态 ===
// 预识别架构：asr-client 直接返回视频相对秒数，不需要墙钟偏移反算。
// B站路径从 __playinfo__ 下载音频预识别，回退路径用 captureStream+MediaRecorder。
let _asrActive = false;      // ASR 是否激活
let _asrCacheLoaded = false; // 字幕面板是否由 ASR 缓存预加载（loadASRCacheIfAny 设 true）
// 有缓存时点 ASR 应接续不清空：_asrCacheLoaded 标记面板字幕来源，
//   startASRInternal 检查：true 则不清空 _subtitles + 传 skipReplay:true 直接实时识别接续；
//   false 则正常清空 + replayCachedSegs 回放。换集/重建/destroySidebar 时重置。
let _asrTrackIndex = -1;     // ASR 在轨道下拉框中的索引（-1=未添加）
// 用户手动选择 ASR 轨道标记：字幕异步到达后 video-controller 调 setTracks 时，
//   其内部 sel.value 重置会覆盖用户已手动选择的 ASR 轨道；此标记为 true 时
//   setTracks 保持 ASR 选中态不被覆盖。选常规轨道/停止 ASR/换集时重置 false。
let _userPickedASR = false;
// 用户手动选择的常规字幕轨道（第421次）：存轨道身份串（vss_id|languageCode|kind），
//   setTracks 重建下拉时优先恢复选中（用户手动选轨最高优先，不被默认链覆盖）。
//   仅本页会话内存有效（与 _userPickedASR 同口径）；换集/重建/改语言重拉时重置。
let _userPickedTrack = null;

// config 参数
let _cfg = {
  debug: true,
  commentMaxLen: 1000,
  // 前缀不带 emoji（Windows 10 旧版 Segoe UI Emoji 可能无字形显示为豆腐块），统一 "VocabRadar："
  prefixComment: 'VocabRadar：\n',
  prefixCopy: 'VocabRadar：\n',
  toastDuration: 2500
};

// 模块级状态接驳导出（vs/* 子模块经受控循环 import 读取；
// _root/_subtitles 归属门面，vs/ocr 改读 getter，写仍走门面内部）
export function getRoot() { return _root; }
export function getSubtitlesRef() { return _subtitles; }
// vs/subtitle-renderer 读取的门面模块级状态 getter（只读接驳）
export function getRankThreshold() { return _rankThreshold; }
export function getAnnotateOov() { return _annotateOov; }
export function getAnnotateRepeat() { return _annotateRepeat; }
// 侧邻注释模板 getter（vs/subtitle-renderer 渲染用）
export function getAnnTemplate() { return _annTemplate; }
// storage 监听分支调用，热更新后需 rerenderSlotsFromCache() 重绘
export function setAnnTemplate(v) { _annTemplate = (typeof v === 'string' && v.trim()) ? v : '{target}{annotation}'; }
export function getCfg() { return _cfg; }
export function getActiveTab() { return _activeTab; }
// Sync display 开关读取（vs/subtitle-renderer 点击字幕跳转与门面播放跟随共用）
export function getSyncEnabled() { return _syncEnabled; }
// ASR/轨道状态接驳读写（vs/asr-flow、vs/tracks 经受控循环 import 调用；
//   状态唯一定义仍属门面——单一来源，杜绝双份状态分叉）
export function setSubtitles(arr) { _subtitles = arr; }
export function setAsrActive(v) { _asrActive = !!v; }
export function getAsrCacheLoaded() { return _asrCacheLoaded; }
export function setAsrCacheLoaded(v) { _asrCacheLoaded = !!v; }
export function getUserPickedASR() { return _userPickedASR; }
export function setUserPickedASR(v) { _userPickedASR = !!v; }
export function getUserPickedTrack() { return _userPickedTrack; }
export function setUserPickedTrack(v) { _userPickedTrack = v || null; }
export function getAsrTrackIndex() { return _asrTrackIndex; }
export function setAsrTrackIndex(v) { _asrTrackIndex = v; }
// 状态接驳（vs/bind-events.js 经门面 getter/setter 读写）
export function setActiveTab(v) { _activeTab = v; }
export function setSyncEnabled(v) { _syncEnabled = !!v; }
export function getOverlayRuleSup() { return _overlayRuleSup; }
export function setOverlayEnabled(v) { _overlayEnabled = !!v; }

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
      // 缺 rankThresholdMax/myWords 两键 → 刷新后过滤失效（setMyWords(空)、
      //   上界恒回 Infinity 不限），故默认值必须齐全
      rankThresholdMax: 0,
      myWords: { new: [], known: [] },
      // 生词条目默认透明底绿字；注释条目默认白底绿字（条目显式字段仍优先于此兜底）
      hintFirstBg: 'transparent',
      hintFirstFg: '#2e6b43',
      hintLaterBg: 'transparent',
      hintLaterFg: '#2e6b43',
      hintAnnotationBg: '#ffffff',
      hintAnnotationFg: '#2e6b43',
      annotateOov: false,   // 注释表外词，默认不选
      annotateRepeat: false,  // 注释重复生词，默认不选（仅注释首次出现）
      // 样式兜底默认 'green-background'（storage 空时生效；真值锚点见 lib/styles.js
      //   的 ANN_DEFAULT_STYLE 常量——classic/eager 场景不便 import，字面量为镜像）
      annotationStyle: 'green-background',
      videoAnnotationStyle: 'green-background',
      // 个性化/用户条目缓存（规则表刷新用）
      annotationCustom: null,
      annotationUserStyles: [],
      annTemplate: '{target}{annotation}'
    }, resolve);
  });
}

// === 绑定事件 ===
/**
 * 侧栏事件绑定。
 * @param {{mount?: HTMLElement}} options startSidebar 透传的启动选项（mount 缺失时
 *   函数体内不得引用 options.mount——曾因此抛 ReferenceError 致注入流程整体中断）
 */
// 全部事件接线在 vs/bind-events.js（startSidebar 经 import 调用；
//   _activeTab/_syncEnabled/_overlayRuleSup/_overlayEnabled 经门面接驳 getter/setter 读写）

/**
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
    // 视频叠加字幕开关跨标签同步（引导页/其它标签切换时更新按钮态）。
    // 生效值 = storage 开关值（严格 === true）AND 停用规则否决位
    //   （规则命中时 storage 开关值仅作偏好保存）。
    if (area === 'local' && changes.overlayEnabled) {
      const on = changes.overlayEnabled.newValue === true && !_overlayRuleSup;
      _overlayEnabled = on;
      overlaySetEnabled(on);
      const btn = _root.querySelector('#beaver-overlay-toggle');
      if (btn) btn.classList.toggle('active', on);
    }
    // 停用规则变化——「视频叠加字幕」否决位实时刷新并按 storage
    //   现值重推导生效值（侧栏整体的停/启由 vc/controller.js 的重编排负责）
    if (area === 'local' && changes.deactivateRules) {
      suppressionFor(location).then((sup) => {
        const was = _overlayRuleSup;
        _overlayRuleSup = sup.overlay === true;
        if (was === _overlayRuleSup) return;
        chrome.storage.local.get('overlayEnabled', (res) => {
          // 与本文件 toggle/启动/监听三处同口径：未设置视为关（=== true）
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

// _videoLearnLang 接驳导出（vs/ocr 读语言决定 OCR 引擎）
export function getVideoLearnLang() { return _videoLearnLang; }

// === 启动视频提示（仅骨架） ===
// startSidebar(video) 只显骨架+"字幕加载中..."，字幕到达后由 updateSubtitles(subtitles) 填充。
// 不在启动路径上 await rerender()：首次渲染要下载大词典 + 串行处理字幕 + 表外词同步
//   translate，会让骨架挂载后仍长时间无响应。骨架与字幕获取并行，体感最快。

/**
 * 获取当前活跃 video 元素
 * _video 可能因 SPA 换集失效（旧 video 被移出 DOM），校验是否仍 connected，
 * 失效则重新查找 document.querySelector('video')。
 * 用于字幕点击跳转，避免设置失效元素的 currentTime 无效。
 * 导出供 vs/* 子模块使用（playback-gate/asr-stage/ocr）
 */
export function getActiveVideo() {
  if (_video && document.contains(_video)) return _video;
  // _video 失效，重新查找
  const v = document.querySelector('video');
  if (v) _video = v;  // 顺便更新引用
  return v || null;
}

/**
 * 档4浮动注入：侧栏挂 body 顶层 fixed，不进右列文档流。
 * 目的：隔离「插入右列文档流」这个变量（判读矩阵见 vs/inject-timing.js）。
 * 尺寸简单固定（诊断态不求完美），不 wireMoveResize、不 startSyncHeight；
 * 调用方（档4分支）也不启动重注入守卫——守卫重注入走 injectIntoPage 会把它插回右列，
 * 破坏本档「不进右列」语义。浮动挂 body 顶层，B站 Vue 重渲染不直接触碰 body 顶层节点。
 */
function floatInjectDiag(root) {
  root.dataset.mode = 'float';
  root.style.position = 'fixed';
  root.style.right = '16px';
  root.style.top = '20px';
  const w = Math.min(360, Math.round(window.innerWidth * 0.3));
  root.style.width = w + 'px';
  root.style.maxWidth = w + 'px';
  root.style.height = '60vh';
  root.style.maxHeight = '60vh';
  root.style.zIndex = '2147483000';
  root.style.boxShadow = '-2px 0 8px rgba(0,0,0,0.15)';
  document.body.appendChild(root);
  log('诊断档4: 浮动注入(不进右列文档流)');
}

export async function startSidebar(video, options = {}) {
  // 启动时点刷新「视频叠加字幕」停用规则否决位（storage.onChanged 亦实时更新，
  //   此处兜底覆盖"规则先写、模块后启"的时序）。
  try {
    const _dsup = await suppressionFor(location);
    _overlayRuleSup = _dsup.overlay === true;
  } catch (_) { /* ignore */ }
  // YouTube 页即预热 youtubei 单例（与播放器加载并行）。fire-and-forget。
  if (/youtube\.com/i.test(location.hostname)) {
    warmYouTubeCaptionInnertube();
  }
  // options.hidden=true 时 _root 创建后立即 display:none，避免先显示再隐藏的闪烁，
  //   也确保 SPA 换集时视频提示保持隐藏。
  // _root 可能因 B站 Vue 重新渲染被移出 DOM（document.contains 返回 false），
  //   此时虽 _root 非空但已是失效节点，querySelector 失败 → 字幕无法填充。
  //   换集时必须校验 _root 是否仍在 DOM，失效则重建。
  if (_root && document.contains(_root)) {
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
    _userPickedASR = false;  // 换集重置用户 ASR 选中标记（stopASRInternal 已清，此处双保险）
    _userPickedTrack = null;  // 换集重置用户手选轨道（新集走四层链默认）
    setNoSubAutoCollapseDone(false);  // 换集重置自动折叠配额
    // 换集时立即清空生词表 DOM，与字幕区 showLoading 同步重置——否则若新字幕
    //   未到达（换集检测失败），旧生词条目残留面板，造成「字幕区是新的、生词表是旧的」错位。
    const _wp = _root.querySelector('#beaver-word-panel');
    if (_wp) _wp.innerHTML = '';
    showLoading();
    // 换集须重启高度同步：清旧资源（timers + resize 监听）并重置同步状态后
    //   重新走 0/500/1500/3000ms 测量流程为新视频计算高度；只清内联样式不清状态
    //   会导致 startSyncHeight 直接 return，高度塌陷。
    if (_root.style.display !== 'none') {
      stopHeightSync();
      _root.style.height = '';
      _root.style.maxHeight = '';
      startSyncHeight();
    }
    // 视频提示始终可见；仅当用户之前手动点了 ✕ 关闭（display==='none'）时保持隐藏，
    //   换集不改变用户的手动关闭状态。
    // 换集时重启视频内字幕 overlay（绑定新 video 元素）
    try { stopOverlay(); startOverlay(video, [], { rankThreshold: _rankThreshold, enabled: _overlayEnabled, annotateRepeat: _annotateRepeat }); } catch (e) { console.warn('[VocabRadar][video-sidebar] overlay 启动失败:', e); }
    log('换集: 已清旧字幕, 重算高度, 等待新字幕');
    return;
  }
  // _root 失效（被 Vue 移除）：重置状态走重建流程
  if (_root && !document.contains(_root)) {
    log('换集: _root 已被移出 DOM, 重建骨架');
    // 重建前也需停止 ASR，避免旧 ASR 继续运行
    if (_asrActive) {
      try { stopASRInternal(true); } catch (_) { /* ignore */ }
    }
    _root = null;
    _video = null;
    _timeListener = null;
    _subtitles = [];
    resetRenderState();
    _asrCacheLoaded = false;
    _userPickedASR = false;  // 重建重置用户 ASR 选中标记
    _userPickedTrack = null;  // 重建重置用户手选轨道
  }

  _video = video;
  _root = buildSidebar();
  bindEvents(options);
  // 统一侧栏路由事件（beaver-unified-open）+ 拖动位置视口守卫
  wireUnifiedFormEvents();
  handleDragResize();
  // 启动视频内字幕 overlay（全屏时显示字幕）；字幕到达后由 updateSubtitles 同步
  try { startOverlay(video, [], { rankThreshold: _rankThreshold, enabled: _overlayEnabled, annotateRepeat: _annotateRepeat }); } catch (e) { console.warn('[VocabRadar][video-sidebar] overlay 启动失败:', e); }

  // 注入 CSS（同步，无 IO 等待）。仅注入一次，避免 SPA 换集时重复添加 <link>。
  // critical CSS 必须同步注入：sidebar.css <link> 异步加载，加载前 CSS 变量未定义
  //   → 背景透明、布局错乱；先注入同步 <style> 保证前后外观一致
  //   （与 web-sidebar-impl.js 的 injectCriticalCSS() 同策略）。
  if (!document.getElementById('beaver-sidebar-critical-css')) {
    const criticalStyle = document.createElement('style');
    criticalStyle.id = 'beaver-sidebar-critical-css';
    criticalStyle.textContent = `
      :root{--beaver-primary:#2e6b43;--beaver-primary-light:#a8e6cf;--beaver-on-primary:#fff;--beaver-on-primary-container:#0d2014;--beaver-bg:#fbfdf9;--beaver-bg-soft:#f5f8f3;--beaver-bg-container:#eff3ec;--beaver-bg-container-high:#e9eee7;--beaver-text:#1a1f1a;--beaver-text-soft:#424942;--beaver-text-disabled:#72797a;--beaver-outline:#c2c9bf;--beaver-radius:12px;--beaver-radius-sm:8px;--beaver-shadow-1:0 1px 2px rgba(26,31,26,.10),0 1px 3px rgba(26,31,26,.06);}
      #beaver-sidebar{position:relative;z-index:5;width:100%;min-height:200px;background:var(--beaver-bg,#fbfdf9);border-radius:var(--beaver-radius,12px);box-shadow:var(--beaver-shadow-1);margin:0 0 10px 0;padding:0;display:flex;flex-direction:column;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:16px;color:var(--beaver-text,#1a1f1a);line-height:1.5;overflow:visible;pointer-events:auto;box-sizing:border-box;}
      #beaver-sidebar.beaver-floating{position:fixed;width:min(320px,calc(100vw - 32px));height:min(569px,calc(100vh - 48px));top:20px;right:16px;}
      /* 折叠态清 min-height/height，防空白大块（与 sidebar.css 同步） */
      #beaver-sidebar.beaver-collapsed{min-height:auto;height:auto;max-height:none;}
      #beaver-sidebar .beaver-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--beaver-bg-soft,#f5f8f3);flex-shrink:0;}
      #beaver-sidebar .beaver-tabs{display:flex;background:var(--beaver-bg-soft,#f5f8f3);flex-shrink:0;}
      /* 工具栏 hidden 规则 + 非面板行 flex-shrink:0（与 sidebar.css 一致，防缓存缺规则） */
      #beaver-sidebar [data-tab-toolbar].hidden,#beaver-sidebar .beaver-toolbar.hidden{display:none!important;}
      #beaver-sidebar .beaver-toolbar{flex-shrink:0;}
      #beaver-sidebar .beaver-asr-progress{flex-shrink:0;}
      #beaver-sidebar .beaver-footer{flex-shrink:0;}
      #beaver-sidebar .beaver-tab{flex:1;padding:8px 12px;text-align:center;cursor:pointer;color:var(--beaver-text-soft,#424942);font-size:0.9em;}
      #beaver-sidebar .beaver-tab.active{color:var(--beaver-on-primary-container,#0d2014);background:var(--beaver-primary-light,#a8e6cf);}
    `;
    document.head.appendChild(criticalStyle);
  }
  // CSS 缓存克星：link href 带构建戳版本参数，扩展重载后 URL 必变，浏览器不会
  //   沿用旧缓存——此前词头出血等 sidebar.css 修改多次对用户无效，根因即旧 link
  //   URL 恒定吃缓存（JS 走 content script 不受影响，故版本号/JS 修复一直生效）。
  //   查重选择器须精确到 /sidebar.css（href*="sidebar.css" 会误匹配 web-sidebar.css
  //   ——文本侧栏先注入时视频侧将漏注入本文件）。
  if (!document.querySelector('link[href$="/sidebar.css"], link[href*="/sidebar.css?"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('src/content/sidebar.css') + `?v=${encodeURIComponent(BUILD_STAMP)}`;
    document.head.appendChild(link);
  }
  // 统一顶行样式（sidebar-topbar.js 唯一来源，幂等）
  try { ensureTopbarCss(); } catch (e) { /* ignore */ }

  // 注入到右侧容器（立即挂骨架，MutationObserver 等容器异步插入）
  // 引导页支持——options.mount 提供挂载容器时内联挂载：不注入页面右侧容器
  //   （injectIntoPage）、不启动防消失守卫（B站 Vue 专用）。#beaver-sidebar 基础样式
  //   即 position:relative 文档流；高度同步（startSyncHeight）随 injectIntoPage 一并跳过。
  if (options.mount && typeof options.mount.appendChild === 'function') {
    options.mount.appendChild(_root);
    log('视频提示已内联挂载到指定容器（引导页模式）');
  } else {
    // 内联 order 作为 CSS 缓存克星双保险：即使 CSS 文件被浏览器缓存（旧版本
    //   无 order 规则），内联 style.order 语义也能保证布局正确
    applyInlineOrder(_root);

    // hidden 注入（popup sidebarEnabled=false）也必须广播可见事件：广播让文本侧栏
    //   立即进入互斥状态机（球保持隐藏），后续 showSidebar() 恢复显示时状态机自然放行
    //   ——侧栏在 DOM 且可恢复。不广播则看门狗被豁免标记拦住，整页"啥都没有"。
    // 注入时机按档位调度（getInjectTiming）：只改 injectIntoPage 的执行时机与形态，
    //   其余链路（字幕/ASR/overlay）不变；默认档0=现行立即注入。
    //   档位定义与判读矩阵见 vs/inject-timing.js 文件头注释。
    const timing = getInjectTiming();
    const broadcastVisible = () => {
      try { window.dispatchEvent(new CustomEvent('beaver-video-sidebar-visible')); } catch (e) { /* ignore */ }
    };
    if (timing === 5) {
      // 档5 基线：完全不注入侧栏（等同抑制侧栏对照），仅广播互斥事件让文本侧栏让位
      broadcastVisible();
    } else if (timing === 4) {
      // 档4：浮动注入，不进右列文档流；不启动重注入守卫（语义见 floatInjectDiag 注释）
      floatInjectDiag(_root);
      // 浮动注入完成也补触发自动展开（幂等，见 doInject 注释）
      autoExpandOnce();
      broadcastVisible();
    } else {
      // 档0/1/2/3：右列注入，仅时机不同。
      // 重注入守卫必须与注入同批启动——守卫判「root 在但不在 DOM」会抢先重注入，
      //   延迟档若先启守卫则延迟失效。
      const rootAtSchedule = _root;
      const doInject = () => {
        if (_root !== rootAtSchedule) return;  // 调度等待期间已换集重建，旧闭包作废
        injectIntoPage(_root);
        broadcastVisible();
        startReinjectGuard();
        // 注入完成补触发自动展开：延迟档（1/2/3）等待注入期间字幕常已到达，
        //   autoExpandOnce 触发时 root 未入 DOM 直接 return（配额保留），此后无人再调
        //   → 窗口错过，侧栏永不展开。补调幂等：配额已被消费时入口直接短路。
        autoExpandOnce();
      };
      if (timing === 1) setTimeout(doInject, 2000);
      else if (timing === 2) setTimeout(doInject, 5000);
      else if (timing === 3) waitForBiliCommentsThen(doInject);
      else doInject();
    }
  }
  // 诊断探针——"视频侧栏整体消失"无法远程复现，暴露真实状态供控制台一键取证
  //   （挂载/注入模式/折叠/display），配合 web 侧 __beaverWebSidebarDiag。
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
  // 时序防御：启动强制折叠先于注入执行，Shorts/generic 分支随后写入的内联
  //   width/height 会覆盖折叠态的 height:auto（顶条下残留空白块），此处再断言一次。
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
  // 必须同时监听 seeked：timeupdate 在视频暂停时不触发，用户拖进度条暂停时 seek
  //   后高亮不会更新（"字幕没跟随"）。seeked 在 seek 完成时（无论是否暂停）立即触发。
  // 十版：timeupdate→follow（追赶中走上浮/下沉步进，否则瞬时居中）；
  //   seeked→center（瞬时居中并清追赶；点击引发的同行 seeked 在 highlightCurrent
  //   早退，不会误清追赶）
  _timeListener = () => { if (_syncEnabled) highlightCurrent(_video.currentTime, 'follow'); };
  _seekedListener = () => { if (_syncEnabled) highlightCurrent(_video.currentTime, 'center'); };
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
    // 视频侧栏读 videoAnnTemplate（videoAnnotationStyle 栏专用键，与文本侧栏独立）
    setAnnTemplate(settings.videoAnnTemplate);
    // 完整写入 4 组配色变量（first/later/ann 的 bg+fg），缺任一组则 popup 改色后
    //   sidebar 不更新（仅靠 _cfgReady 一次性写入 + storage 监听双通道）
    applyColorSettings(settings);
    // 三栏（文本/视频/overlay）各自独立选样式，与共享池同 id 集；
    // 个性化/用户条目规则先行注入（类切换即时生效）
    refreshAnnPoolCss(settings.annotationCustom, settings.annotationUserStyles);
    applyAnnStyle(settings.videoAnnotationStyle);
    // 从 storage 读取注释模式（引导页 radio 或 Detail 按钮写入）
    const annMode = settings.videoSidebarAnnMode || (settings.subtitleDetailMode ? 'detail' : 'side');
    setDetailMode(annMode === 'detail');
    const detailBtn2 = _root.querySelector('#beaver-detail');
    if (detailBtn2) detailBtn2.classList.toggle('active', getDetailMode());
    // 同步 rankThreshold 到视频内字幕 overlay
    overlaySetRank(_rankThreshold);
    log('配置加载完成, rankThreshold=', _rankThreshold, 'annotateOov=', _annotateOov, 'annotateRepeat=', _annotateRepeat, '配色 first=', settings.hintFirstBg, 'annotation=自动派生(前后景互换)');
  }).catch((e) => {
    console.warn('[VocabRadar][video-sidebar][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] 配置加载失败', e);
  });

  // 监听 popup 配色变化，实时同步到视频侧栏 CSS 变量（改色后无需刷新页面）。
  // 本模块只响应 videoAnnTemplate（videoAnnotationStyle 栏专用键）。
  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const colorKeys = ['hintFirstBg', 'hintFirstFg', 'hintLaterBg', 'hintLaterFg', 'hintAnnotationBg', 'hintAnnotationFg', 'videoSidebarAnnMode'];
      if (!colorKeys.some((k) => k in changes) && !('videoAnnotationStyle' in changes) && !('videoAnnTemplate' in changes)
        && !('annotationCustom' in changes) && !('annotationUserStyles' in changes)) return;
      // 读取完整设置后应用（避免部分更新遗漏）
      loadSettings().then((s) => {
        applyColorSettings(s);
        // 个性化/用户条目规则先刷新（类切换即时生效）
        refreshAnnPoolCss(s.annotationCustom, s.annotationUserStyles);
        applyAnnStyle(s.videoAnnotationStyle);
        // 注释模板热更新——前后缀变化需重绘（渲染时按模板分段拼装）
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

// === 字幕到达后填充视频提示 ===
// 词典就绪重渲染武装标志（armed 幂等，参照 th/scan.js _dictRescanArmed）。
//   一次武装钩子跨视频存活：触发后 isLoaded 为真不再武装；若触发时字幕尚未渲染则
//   空转一轮无害，后续 updateSubtitles 正常渲染即带注释。
let _dictReadyArmed = false;

/** 武装词典就绪重渲染钩子（ranks 先行 + 整词典两档，见 updateSubtitles 内注释）。
 *  从 updateSubtitles 的内联块提出：语言切换路径要复位 _dictReadyArmed 后重入。 */
function armDictReadyRerender() {
  if (_dictReadyArmed || isLoaded()) return;
  _dictReadyArmed = true;
  try {
    ensureRanksReady().then(() => {
      try { rerenderPanelOnly(); } catch (e) { console.warn('[VocabRadar][video-sidebar] 词频就绪重渲染失败:', e); }
    }).catch((e) => { console.warn('[VocabRadar][video-sidebar] 词频装载失败（等整词典就绪重渲染）:', e); });
    ensureReady().then(() => {
      try { rerenderPanelOnly(); } catch (e) { console.warn('[VocabRadar][video-sidebar] 词典就绪重渲染失败:', e); }
    }).catch((e) => { console.warn('[VocabRadar][video-sidebar] 词典装载失败（按表外继续）:', e); });
  } catch (e) {
    console.warn('[VocabRadar][video-sidebar] 词典就绪钩子调度失败:', e);
  }
}

// 2026-10-05（用户："视频侧栏的生词并没有跟随设定语言"）缺口补修：
//   视频页不跑 text-hint，词典装载全靠上面这组一次性武装的就绪钩子。切换学习语言后
//   dictionary/state.js 清就绪态触发懒重建，但 _dictReadyArmed 已置位 → 无人再调
//   ensureReady → 新语言词频永不装载，新词全按表外被滤（词表空/不跟语言）。
//   此处监听 learnLanguage 变化复位武装标志并重挂钩子（渲染端已有清缓存重渲染逻辑，
//   这里只负责"词典按新语言重建好后补一轮重渲染"）。未就绪时才需要；已就绪空转无害。
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.learnLanguage) return;
    if (!getRoot()) return;   // 侧栏未注入时无需钩子（下次 startSidebar 正常武装）
    if (!isLoaded()) {
      _dictReadyArmed = false;
      armDictReadyRerender();
    }
  });
}

// 词典后台重建完成补渲染——armed 钩子幂等一次，若被假就绪/首建放行提前消耗，
//   真词典就绪后无人重渲染；监听 projection.js 的重建广播兜底（全局只挂一次）。
if (typeof window !== 'undefined' && !window.__vrRebuildRelisten) {
  window.__vrRebuildRelisten = true;
  window.addEventListener('vr-dict-rebuilt', () => {
    try {
      rerenderPanelOnly();
      console.log('[VocabRadar][video-sidebar] 词典后台重建完成：侧栏已补渲染');
    } catch (e) {
      console.warn('[VocabRadar][video-sidebar] 重建完成补渲染失败:', e);
    }
  });
}
export async function updateSubtitles(subtitles) {
  if (!_root) {
    log('updateSubtitles: 骨架未启动, 忽略');
    return;
  }
  // ASR 运行中不得被原生字幕覆盖：原生字幕异步到达时 video-controller 调本函数
  //   整块重绘面板，会把 ASR 结果清掉换成原生轨（用户感知为"擅自切换字幕轨道"）。
  //   真换集时 video-controller 会先 stopASRInternal（_asrActive 已 false），
  //   不会走到这里被拦——守卫只挡"运行中覆盖"。
  if (_asrActive) {
    log('updateSubtitles: ASR 运行中，忽略原生字幕覆盖（', (subtitles || []).length, '条）');
    return;
  }
  // _asrCacheLoaded 重置放这里而非 renderSubtitlePanel：只有字幕被替换时才重置
  //   缓存标记，避免重新渲染时误清导致频繁刷新。
  _asrCacheLoaded = false;
  // 新字幕到达，无字幕自动折叠配额重置（下一集/下次空轨道可再自动折叠）
  setNoSubAutoCollapseDone(false);
  // 换集/首次：先显加载提示（清掉旧字幕条目），再填充新字幕
  showLoading();
  _subtitles = Array.isArray(subtitles) ? subtitles : [];
  // 字幕源不保证严格递增（ASR 缓存段可能乱序、多轨道合并可能打乱），
  //   强制按 start 升序排序，保证 highlightCurrent 和视觉顺序正确。
  if (_subtitles.length > 1) {
    _subtitles.sort((a, b) => (a?.start || 0) - (b?.start || 0));
  }
  // 同步字幕到视频内字幕 overlay（全屏时显示）
  overlaySetSubtitles(_subtitles);
  // 等配置加载完再渲染，避免用默认 rankThreshold=0 误过滤
  // （text-hint 用真实阈值，若字幕窗口用默认值会出现"文本提示有结果而字幕窗口没有"）
  if (_cfgReady) {
    try { await _cfgReady; } catch (e) { /* catch 内已 warn，忽略 */ }
  }
  // 分批渲染（renderSubtitlePanel 内部自带 setTimeout 让出主线程）
  await rerender();
  // 词典冷装载期（最长十几秒）lookup 全 null → 全部词判表外被滤 → 无注释，而侧栏
  //   无 text-hint 那样的就绪重扫钩子，词典装好后永不恢复。修法：渲染后武装双钩子——
  //   ranks 先行重渲染（补词频口径），整词典就绪再重渲染（补 lemma/tags/真表外）；
  //   rerenderPanelOnly 自带清注释缓存+清 seen+遍历全部 slot 重查，即可产出注释。
  //   词典已就绪则无需武装；装载失败 resolve null 时空转一轮无害（与现状一致）。
  //   2026-10-05：武装块提出为 armDictReadyRerender（语言切换监听复用，见其定义处）。
  armDictReadyRerender();
  // 字幕填充后补测一次高度（锚点可能晚于骨架就绪）
  requestSyncHeightOnce();
  // 首批真实字幕到达 → 自动展开一次（启动折叠态的解除）
  if (_subtitles.length > 0) autoExpandOnce();
  log('字幕已填充:', _subtitles.length, '条, rankThreshold=', _rankThreshold,
      '字幕语言样本:', _subtitles.slice(0, 2).map(s => (s && s.text) ? s.text.slice(0, 30) : '(空)'));
}

// === 完全销毁视频提示（SPA 导航到非视频页时调用）===
// 设计约束：处理不了的视频不显示窗口（参照 videoseek）。
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
  // 清理高度同步资源（断开 reinject/heightSync 观察器 + 清 timers +
  //   移除 resize 监听器 + 重置 started/maxH/locked）
  teardownLayout();
  // 移除 video 监听器
  if (_video) {
    if (_timeListener) _video.removeEventListener('timeupdate', _timeListener);
    if (_seekedListener) _video.removeEventListener('seeked', _seekedListener);
  }
  // 销毁视频内字幕 overlay
  try { stopOverlay(); } catch (_) { /* ignore */ }
  // 清 loading 超时（计时状态内聚 vs/loading.js）
  clearLoadingTimeout();
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
  _userPickedASR = false;  // 同步重置用户 ASR 选中标记
  _userPickedTrack = null;  // 同步重置用户手选轨道
}

// popup「视频侧栏」开关的隐藏标记——hideSidebar 置位、showSidebar 复位，
// 供可见性看门狗豁免（用户主动关闭的侧栏不得被自动恢复）。
// 接驳导出：vs/sidebar-layout 的重注入可见性看门狗读取。
let _hiddenByUserSetting = false;
export function getHiddenByUserSetting() { return _hiddenByUserSetting; }

export function hideSidebar() {
  if (_root) _root.style.display = 'none';
  _hiddenByUserSetting = true;
}

export function showSidebar() {
  if (_root) _root.style.display = '';
  _hiddenByUserSetting = false;
}

