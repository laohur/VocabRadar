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

// 2026-09-27 拆分第四刀终审：删除门面死导入（getAnnotations/rankToStage/resetDiag/
//   openDiagCenter/getPhonetic/summarize/startASR 系等——均已迁至 vs/* 子模块自身导入）
import { setRankMax, setMyWords } from '../lib/annotator.js';
// 第一百三十四次：youtubei 单例预热（消除首取轨道冷启动竞争→空结果）
import { warmYouTubeCaptionInnertube } from '../lib/subtitle/index.js';
// 第一百三十八次拆分第一刀：ASR 进度条 DOM 子模块（依赖注入 getRoot，避免循环 import）
// 2026-09-27：进度条显隐已随 toggleASR 迁 vs/asr-flow.js，门面仅留初始化副作用
import { initAsrProgress } from './vs-asr-progress.js';
// 第一百二十四次：顶行统一构建器——视频/文本侧栏共用同一代码文件（用户裁定）
import { ensureTopbarCss } from '../lib/sidebar-topbar.js';
import { initLang, onLangChange } from '../lib/i18n.js';
// 第三百六十六次：词典就绪双钩子——YouTube 立即注入（第365次）后字幕渲染抢在词典
//   冷装载（1~17s）之前，就绪后需补渲染才能出注释（ensureRanksReady/ensureReady/isLoaded）
import { ensureReady, ensureRanksReady, isLoaded } from '../lib/dictionary.js';

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
import { startOverlay, stopOverlay, setSubtitles as overlaySetSubtitles, setOverlayEnabled as overlaySetEnabled, setRankThreshold as overlaySetRank } from './subtitle-overlay.js';
// 第二百七十次：停用规则（Deactivate）——「视频叠加字幕」规则对 overlay 生效与否的
// 唯一否决点（init 读值/按钮切换/跨标签同步三处消费 _overlayRuleSup）；
// 匹配/存储逻辑唯一来源 lib/deactivate.js（⋯ 菜单 upsertDeactivateRule 已随
// bindEvents 迁 vs/bind-events.js，由其自行导入）
import { suppressionFor } from '../lib/deactivate.js';
// 第二百二十五次：删除本门面未使用的导入（pickCleanShortTrans/isBalancedParens 曾导入零调用）
// 2026-08-28 拆分第二刀：按功能拆出 vs/* 子模块，本文件保留为门面（facade）。
// 受控循环 import 说明：vs/playback-gate、vs/asr-stage、vs/ocr
// 需调用本门面导出的函数（getRoot/getActiveVideo/isASRActive/toast/getSubtitlesRef/
// getVideoLearnLang/showNoSubtitle，均为函数声明、提升后可用）；这些子模块顶层仅
// 初始化自身状态，对本门面绑定的调用全部发生在函数体内——运行时安全，无 TDZ 风险。
import { log, setDebug } from './vs/logger.js';
import { makeVideoKey } from './vs/dom-utils.js';
// 2026-09-27 拆分第四刀终审：comment-fill/yt-reorder 死导入删除
// （评论填充随 onCommentClick 迁 subtitle-renderer，YT 防重排随布局迁 sidebar-layout，
//   两者由其各自导入方继续加载）
// 2026-08-28 拆分第三刀：布局子模块（注入/高度同步/折叠/拖拽/重注入）；
// 下列符号均为原门面内同名函数/状态接驳（机械搬移，行为不变）
import {
  autoExpandOnce, requestSyncHeightOnce,
  injectIntoPage, startReinjectGuard, startSyncHeight,
  wireUnifiedFormEvents, handleDragResize, stopHeightSync, teardownLayout,
  getSidebarCollapsedFlag,
  setNoSubAutoCollapseDone
} from './vs/sidebar-layout.js';
// 第361次（诊断）：注入时机分档——getInjectTiming 读档位、waitForBiliCommentsThen 档3等待；
// 档位定义与判读矩阵见 vs/inject-timing.js 文件头注释
import { getInjectTiming, waitForBiliCommentsThen } from './vs/inject-timing.js';
// 2026-09-27 拆分第四刀终审：playback-gate/asr-stage/ocr 死导入删除
// （闸门随 toggleASR 迁 vs/asr-flow.js，阶段时间线随 ASR 迁 asr-flow，
//   OCR 按钮接线随 bindEvents 迁 vs/bind-events.js——各由子模块自行导入）
// 2026-08-28 拆分第三刀：字幕渲染子模块（字幕/生词表面板渲染、注释获取缓存、
// ASR 字幕插入、复制/评论/词单）；下列符号均为原门面内同名函数/状态接驳（机械搬移，行为不变）
// 2026-09-27 拆分第四刀终审：死导入删除（onWordListToggle/onCopy/onCommentClick/
//   appendASRSubtitle/setNoAnnotation/onChatClickVs/buildSubtitleBody/getAllAnnotations/
//   toggleLemmaGroup——接线随 bindEvents 迁 vs/bind-events.js，learn 草稿随
//   onLearnClickVs 迁 vs/actions.js，各自导入）
import {
  rerender, rerenderPanelOnly, rerenderSlotsFromCache,
  highlightCurrent,
  resetRenderState, setDetailMode, getDetailMode
} from './vs/subtitle-renderer.js';
// 2026-09-27 拆分第四刀终审：th/panel、ws/draft-export 死导入删除
// （query 卡片随 runVideoQuery 迁 vs/actions.js，learn 草稿随 onLearnClickVs 迁之）
// 2026-09-27 拆分第四刀：toast 移至 vs/toast.js（经门面接驳导出，外部引用方符号不变）
import { toast } from './vs/toast.js';
export { toast };
// 2026-09-27 拆分第四刀：骨架构建/内联 order/i18n 应用移至 vs/build.js
// （closeAllPopups 接线随 bindEvents 迁 vs/bind-events.js，由其自行导入）
import { buildSidebar, applyInlineOrder, applyI18n } from './vs/build.js';
// 2026-09-27 拆分第四刀：加载态/超时兜底/无字幕提示与计时状态移至 vs/loading.js
// （clearLoading/showNoSubtitle 经门面接驳导出，subtitle-renderer/vc/controller/
//   guide-common 引用方符号不变；showNoSubtitle 门面无调用点，仅 from-re-export）
import { showLoading, clearLoadingTimeout } from './vs/loading.js';
export { clearLoading, showNoSubtitle } from './vs/loading.js';
// 2026-09-27 拆分第四刀：配色写入/注释样式类/统一池样式表移至 vs/ann-style.js
// （其模块顶层的 injectAnnPoolCss() 注入副作用随本 import 一并执行）
import { applyColorSettings, applyAnnStyle, refreshAnnPoolCss } from './vs/ann-style.js';
// 2026-09-27 拆分第四刀：ASR 开关/停止与缓存加载移至 vs/asr-flow.js
// （loadASRCacheIfAny/loadASRCacheWithCoverage/selectASRTrackAndContinue 经门面
//   export 接驳导出，vc/controller 引用方符号不变；toggleASR 门面无调用点，
//   bindEvents/tracks/actions 均直接从 asr-flow 导入）
import { stopASRInternal, loadASRCacheIfAny, loadASRCacheWithCoverage, selectASRTrackAndContinue } from './vs/asr-flow.js';
export { loadASRCacheIfAny, loadASRCacheWithCoverage, selectASRTrackAndContinue };
// 2026-09-27 拆分第四刀：轨道下拉/自动加载链路/选轨处理移至 vs/tracks.js
// （setTracks 经门面 export 接驳导出，vc/controller 引用方符号不变）
import { setTracks, ensureASRTrackOption } from './vs/tracks.js';
export { setTracks };
// 2026-09-27 拆分第四刀：朗读/查询/learn 草稿/自动识别移至 vs/actions.js
// （autoStartASR 经门面 export 接驳导出）
import { autoStartASR } from './vs/actions.js';
export { autoStartASR };
// 2026-09-27 拆分第四刀：全部事件接线移至 vs/bind-events.js（startSidebar 调用）
import { bindEvents } from './vs/bind-events.js';

// === 模块状态 ===
let _root = null;             // 视频提示根元素
// 第一百三十八次拆分第一刀：把根元素获取器注入 ASR 进度条子模块（箭头函数延迟取值，
// 规避 TDZ；_root 换集重建时子模块自动跟随新引用）
initAsrProgress({ getRoot: () => _root });
let _video = null;            // video 元素
let _subtitles = [];          // [{start, end, text}]
let _rankThreshold = 4000;    // 词频阈值（2026-09-29 用户："默认提示4000-5000词频"：默认改 4000，配 rankThresholdMax=5000）
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
// 2026-09-27 拆分第四刀：_tracks/_trackFetchFn 随 setTracks/ensureASRTrackOption/
//   onTrackSelect 移至 vs/tracks.js（仅该模块读写）
let _cfgReady = null;        // 配置加载 Promise（确保 updateSubtitles 渲染前 _rankThreshold 已就绪）

// === ASR 识别状态 ===
// 2026-07-04 重构：预识别架构，asr-client 直接返回视频相对秒数，
// 不再需要墙钟偏移反算。B站路径从 __playinfo__ 下载音频预识别，
// 回退路径用 captureStream+MediaRecorder 替代废弃的 ScriptProcessor。
let _asrActive = false;      // ASR 是否激活
// 2026-09-27 拆分第四刀：_asrUnsub/_videoKey/_lastAsrCacheCoverage 随函数
//   迁入 vs/asr-flow.js（仅该模块读写，状态唯一定义仍在该模块）
let _asrCacheLoaded = false; // 字幕面板是否由 ASR 缓存预加载（loadASRCacheIfAny 设 true）
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
// _root/_subtitles 归属门面，vs/ocr 改读 getter，写仍走门面内部）
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
// 2026-09-27 拆分第四刀：ASR/轨道状态接驳读写（vs/asr-flow、vs/tracks 经受控
//   循环 import 调用；状态唯一定义仍属门面——单一来源，杜绝双份状态分叉）
export function setSubtitles(arr) { _subtitles = arr; }
export function setAsrActive(v) { _asrActive = !!v; }
export function getAsrCacheLoaded() { return _asrCacheLoaded; }
export function setAsrCacheLoaded(v) { _asrCacheLoaded = !!v; }
export function getUserPickedASR() { return _userPickedASR; }
export function setUserPickedASR(v) { _userPickedASR = !!v; }
export function getAsrTrackIndex() { return _asrTrackIndex; }
export function setAsrTrackIndex(v) { _asrTrackIndex = v; }
// 2026-09-27 拆分第四刀：bindEvents 移至 vs/bind-events.js 后的状态接驳
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
      rankThreshold: 4000,
      // 340次（My Words 过滤失效修复）：此前缺两键 → 刷新后 settings.myWords=undefined →
      //   video-sidebar.js:1419 setMyWords(空) 过滤失效；controller 转发 startOverlay 的
      //   myWords/rankThresholdMax 也为 undefined（subtitle-overlay 真值守卫不清空但从不生效）
      rankThresholdMax: 5000,
      myWords: { new: [], known: [] },
      // 反思（2026-08-18 第七十三次修正）：默认配色曾是单词绿底白字。
      // 304次（用户"默认无底色"）：改透明底绿字。
      // 第502次回退第501次误改的 'inherit'（条目显式字段仍优先——G1 结构保留）。
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
      // 第501次曾移 green-wave；第502次（用户"默认样式改回绿背景"）镜像同步回。
      // 第503次曾随误判移 green-wave；
      // 第504次（用户纠错"默认是绿色背景"）：常量回 green-background，镜像同步。
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

// 2026-09-27 拆分第四刀：buildSidebar/applyInlineOrder/closeAllPopups/applyI18n
//   移至 vs/build.js（门面经 import 调用，符号与行为不变）

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
// 2026-09-27 拆分第四刀：bindEvents（全部事件接线）移至 vs/bind-events.js
//   （startSidebar 经 import 调用；_activeTab/_syncEnabled/_overlayRuleSup/
//     _overlayEnabled 经门面接驳 getter/setter 读写）

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

// 2026-09-27 拆分第四刀：speakWordVideo 移至 vs/actions.js（bindEvents 经 import 调用）

// 2026-09-27 拆分第四刀：toggleASR/stopASRInternal（含 _asrUnsub/_videoKey 状态）
//   移至 vs/asr-flow.js（门面 startSidebar/destroySidebar/bindEvents 经 import 调用）

// 2026-09-27 拆分第四刀：showLoading/clearLoading/showNoSubtitle 与
//   _loadingTimeout/_autoChainActive 计时状态移至 vs/loading.js（门面接驳调用）

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
 * 2026-08-28 拆分第二刀：导出供 vs/* 子模块使用（playback-gate/asr-stage/ocr）
 */
export function getActiveVideo() {
  if (_video && document.contains(_video)) return _video;
  // _video 失效，重新查找
  const v = document.querySelector('video');
  if (v) _video = v;  // 顺便更新引用
  return v || null;
}

/**
 * 第361次（诊断）：档4浮动注入——侧栏挂 body 顶层 fixed，不进右列文档流。
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
    // 第361次（诊断）：B站评论区消失排查——按注入时机分档调度（用户指令「按页面加载
    //   时间线划分阶段，看哪一步失败」）。只改 injectIntoPage 的执行时机与形态，
    //   其余链路（字幕/ASR/overlay）不变；默认档0=现行立即注入，线上行为不变。
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
      // 第363次：与右列档位同理——浮动注入完成也补触发自动展开（幂等，见 doInject 注释）
      autoExpandOnce();
      broadcastVisible();
    } else {
      // 档0/1/2/3：右列注入，仅时机不同。
      // 重注入守卫必须与注入同批启动——守卫判「root 在但不在 DOM」会抢先重注入
      // （sidebar-layout.js startReinjectGuard），延迟档若先启守卫则延迟失效。
      const rootAtSchedule = _root;
      const doInject = () => {
        if (_root !== rootAtSchedule) return;  // 调度等待期间已换集重建，旧闭包作废
        injectIntoPage(_root);
        broadcastVisible();
        startReinjectGuard();
        // 第363次（用户反馈"视频侧栏不能自动展开"）：注入完成补触发自动展开。
        //   根因：autoExpandOnce 只在首批字幕/ASR 到达时被调一次；延迟档（1/2/3）
        //   等待注入期间字幕常已到达，触发时 root 未入 DOM 直接 return（配额保留），
        //   此后注入完成无人再调 → 触发窗口错过，配额永远无人消费，侧栏永不展开。
        //   补调幂等：配额已被正常路径消费时入口直接短路，无副作用。
        autoExpandOnce();
      };
      if (timing === 1) setTimeout(doInject, 2000);
      else if (timing === 2) setTimeout(doInject, 5000);
      else if (timing === 3) waitForBiliCommentsThen(doInject);
      else doInject();
    }
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

// 2026-09-27 拆分第四刀：applyColorSettings/applyAnnStyle/refreshAnnPoolCss/
//   injectAnnPoolCss（含模块加载时的池样式注入副作用）移至 vs/ann-style.js

// === 字幕到达后填充视频提示 ===
// 第三百六十六次：词典就绪重渲染武装标志（armed 幂等，参照 th/scan.js _dictRescanArmed）。
//   一次武装钩子跨视频存活：触发后 isLoaded 为真不再武装；若触发时字幕尚未渲染则
//   空转一轮无害，后续 updateSubtitles 正常渲染即带注释。
let _dictReadyArmed = false;
// 第三百七十次（方案A·堵洞④）：词典后台重建完成补渲染——armed 钩子幂等一次，若被
//   假就绪/首建放行提前消耗，真词典就绪后无人重渲染；监听 projection.js 的重建广播兜底。
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
  // 第三百六十六次（YouTube 侧栏字幕无注释·层1）：第365次起 YouTube 立即注入，字幕渲染
  //   抢在词典冷装载（1~17s）之前——冷装载期 lookup 全 null → 全部词判表外被滤 → 无注释，
  //   而侧栏此前无 text-hint 那样的就绪重扫钩子，词典装好后永不恢复。修法：渲染后武装
  //   双钩子——ranks 先行重渲染（补词频口径），整词典就绪再重渲染（补 lemma/tags/真表外）；
  //   rerenderPanelOnly 自带清注释缓存+清 seen+遍历全部 slot 重查，即可产出注释。
  //   词典已就绪则无需武装；装载失败 resolve null 时空转一轮无害（与现状一致）。
  if (!_dictReadyArmed && !isLoaded()) {
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
  // 第一百二十五次：字幕填充后补测一次高度（锚点可能晚于骨架就绪）
  requestSyncHeightOnce();
  // 第一百三十三次：首批真实字幕到达 → 自动展开一次（启动折叠态的解除）
  if (_subtitles.length > 0) autoExpandOnce();
  log('字幕已填充:', _subtitles.length, '条, rankThreshold=', _rankThreshold,
      '字幕语言样本:', _subtitles.slice(0, 2).map(s => (s && s.text) ? s.text.slice(0, 30) : '(空)'));
}

// 2026-09-27 拆分第四刀：loadASRCacheIfAny/loadASRCacheWithCoverage/
//   selectASRTrackAndContinue（含 _lastAsrCacheCoverage 状态）移至 vs/asr-flow.js
//   （门面经 export 接驳导出，vc/controller 引用方符号不变）

// 2026-09-27 拆分第四刀：setTracks/ensureASRTrackOption/onTrackSelect（含
//   _tracks/_trackFetchFn 状态）移至 vs/tracks.js（门面经 import 使用、
//   export 接驳导出 setTracks，vc/controller 引用方符号不变）


// 2026-09-27 拆分第四刀：showNoSubtitle 移至 vs/loading.js（门面接驳导出，
//   vc/controller、guide-common、subtitle-renderer 引用方符号不变）

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
  // 清 loading 超时（2026-09-27：计时状态已内聚 vs/loading.js）
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

// 2026-09-27 拆分第四刀：runVideoQuery/onLearnClickVs/autoStartASR 移至
//   vs/actions.js（bindEvents 经 import 调用；autoStartASR 经门面 export 接驳）

