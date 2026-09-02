// ============================================================
// 文件职责：视频控制器启动主流程（src/content/vc/controller.js）
// 来源：拆分自 src/content/video-controller.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// 内容：startVideoController（启动入口：设置读取 -> waitForVideo ->
//   sidebar 骨架 -> 字幕获取（B站/YouTube/generic）-> 轨道优先级填充）、
//   reviveSidebarIfPossible（侧栏复活通道）、getSettings、isSupportedPage、
//   removeExistingSidebar、PLATFORM 常量、_requestId 换集竞态保护、
//   _storageListenerRegistered storage.onChanged 监听注册。
// 本地状态（仅本模块使用）：_storageListenerRegistered/_requestId/PLATFORM；
//   跨模块状态（started/currentPlatform/lastInitUrl/lastInitKey）统一存于
//   ./state.js 的 vcState；视频检测与换集监听（waitForVideo/waitForVideoReady/
//   observeVideoChange）在 ./video-detect.js。
// 受控循环 import 说明：本模块 import ./video-detect.js，video-detect.js 反向
//   import 本模块的 startVideoController（triggerReloadGlobal 换集重启用）。
//   两端均为函数声明（提升后可用），顶层不在模块加载时调用对方导出函数，
//   运行时调用安全，无 TDZ 风险（项目先例：vs/* 子模块与 video-sidebar.js 门面）。
// ============================================================

import { getBilibiliSubtitles, fetchBilibiliTrack, getYouTubeSubtitles, fetchYouTubeTrack } from '../../lib/subtitle/index.js';
import { startOverlay, stopOverlay, setOverlayEnabled, setRankThreshold } from '../subtitle-overlay.js';
import { startSidebar, updateSubtitles, showNoSubtitle, setTracks, destroySidebar, loadASRCacheIfAny, loadASRCacheWithCoverage, selectASRTrackAndContinue, currentVideoKey, isASRActive } from '../video-sidebar.js';
import { vcState } from './state.js';
import { waitForVideo, waitForVideoReady, observeVideoChange } from './video-detect.js';

// 反思（2026-07-06 二次修复）：storage.onChanged 监听器注册位置 bug
// 旧版将监听器注册在字幕处理之后（行158），如果字幕为空/失败走 autoStartASR 提前 return，
// 监听器永远不注册，用户在 popup 切换 Subtitle Hints 完全无效。
// 修正：监听器提前到 startVideoController 开头注册，且用 flag 防重复。
let _storageListenerRegistered = false;

const PLATFORM = {
  BILIBILI: 'bilibili',
  YOUTUBE: 'youtube',
  GENERIC: 'generic'  // 反思（2026-07-08 #44）：多站支持，无公开字幕API的站点
};

// 反思（2026-07-07）：用户反馈"字幕乱贴，不是一个视频"。
// 根因：SPA 换集时旧 startVideoController 仍在 await subtitlesPromise，
// 新 startVideoController 已开始，旧字幕后到达会覆盖新字幕（竞态）。
// 修正：每次 startVideoController 递增 _requestId，字幕到达后检查 ID 是否匹配，
// 不匹配则丢弃（过期字幕）。triggerReload 触发的新请求 ID 更大，旧请求被作废。
let _requestId = 0;

/** 读取设置 */
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({
      rankThreshold: 5000,   // 2026-08-14 第五十四次修正：恢复默认 5000
      sourceLanguage: 'en',   // 所学语言（字幕轨道默认首选）
      targetLanguage: 'zh',   // 释义语言
      sidebarEnabled: true    // #88: 侧栏开关，默认显示
    }, resolve);
  });
}

/** 判断当前页面是否为本扩展支持的目标视频页
 * 反思（2026-07-07）：用户要求"处理不了的视频不显示窗口，参照videoseek"。
 * 非目标页面（B站番剧/直播/首页/空间、YouTube非watch页）不注入侧栏，避免"现眼"。
 * B站仅普通视频页 /video/BVxxx 或 /video/avxxx 支持；番剧 /bangumi/、直播 /live/ 不支持。
 * YouTube 仅 /watch 页支持；首页/搜索/频道/shorts 等不支持。
 */
function isSupportedPage(platform) {
  const path = location.pathname;
  if (platform === PLATFORM.BILIBILI) {
    return /\/video\/(BV[\w]+|av\d+)/i.test(path);
  }
  if (platform === PLATFORM.YOUTUBE) {
    return /\/(watch|shorts)($|\?|\/)/i.test(path);
  }
  // 反思（2026-07-08 #44）：generic 平台（TikTok/抖音/小红书/X/FB/IG/流媒体）
  //   无统一 URL 模式判定视频页，放宽为"只要有 video 元素就支持"，
  //   由 waitForVideo 超时兜底（15秒无 video 则不注入侧栏）。
  if (platform === PLATFORM.GENERIC) {
    return true;
  }
  return false;
}

/** 清理已存在的侧栏（SPA 从视频页导航到非视频页时调用）
 * 反思（2026-07-07）：必须调用 destroySidebar 而非简单 remove，
 * 否则 reinjectGuard 的 MutationObserver 会重新插入已移除的 _root。
 */
function removeExistingSidebar() {
  try {
    destroySidebar();
  } catch (e) {
    console.warn('[VocabRadar][video-controller] 销毁侧栏失败:', e);
  }
}

/**
 * 召唤复活视频侧栏（第一百三十六次）
 * 反思：YouTube/B站正片页上若侧栏因任何原因缺席（DOM 被 SPA 重渲染吞掉、
 *   重插失败等），startVideoController 会因 isSupportedPage 通过但 vcState.started（原 _started）守卫
 *   直接 return--用户点悬浮球/🎬 按钮毫无反应，整页"啥都没有"。
 *   此处提供显式复活通道：侧栏还在 DOM 就按状态机语义恢复（清 userClosed +
 *   unified-open 展开）；真缺席则重置启动状态强制重启控制器。
 * @param {string} platform 'bilibili' | 'youtube' | 'generic'
 */
export function reviveSidebarIfPossible(platform) {
  try {
    const vsb = document.querySelector('#beaver-sidebar');
    if (vsb && document.contains(vsb)) {
      // ✕ 关闭残留标记：复活路径统一清除（与 wireUnifiedFormEvents 语义一致）
      if (vsb.dataset && vsb.dataset.userClosed) {
        try { delete vsb.dataset.userClosed; } catch (_) { /* ignore */ }
      }
      window.dispatchEvent(new CustomEvent('beaver-unified-open', { detail: { form: 'video' } }));
      return;
    }
    console.log('[VocabRadar][video-controller] 视频侧栏缺席，强制重启控制器:', platform, location.href);
    stopOverlay();
    vcState.started = false;
    vcState.lastInitUrl = '';
    vcState.lastInitKey = null;
    startVideoController(platform).catch((e) => {
      console.warn('[VocabRadar][video-controller] 复活视频侧栏失败:', e);
    });
  } catch (e) {
    console.warn('[VocabRadar][video-controller] reviveSidebarIfPossible 异常:', e);
  }
}

/**
 * 启动视频控制器
 * @param {string} platform 'bilibili' | 'youtube'
 */
export async function startVideoController(platform) {
  if (vcState.started) return;

  // 反思（2026-07-07 二次修复）：用户反馈"有的视频中没出现侧栏"。
  // 根因：从非视频页（B站首页/搜索/频道）SPA 导航到视频页时，首次 startVideoController
  //   因 isSupportedPage 返回 false 直接 return，history hook 未注册。SPA 导航到视频页后
  //   URL 变化但无监听器触发，侧栏不出现。
  // 修正：1) vcState.currentPlatform（原 _currentPlatform）赋值移到 isSupportedPage 检查之前；
  //       2) 非目标页面也注册 history hook（幂等），确保 SPA 导航到视频页时能触发；
  //       3) triggerReloadGlobal 去掉 if(!started) return，改为根据当前 URL 决定启动/清理。
  vcState.currentPlatform = platform;  // 供 triggerReloadGlobal 用（无论是否目标页都赋值）

  // 反思（2026-07-07）：用户要求"处理不了的视频不显示窗口，参照videoseek"。
  // 非目标页面不注入侧栏，避免在番剧/直播/首页等页面"现眼"。
  // SPA 导航到非目标页时，清理已存在的侧栏。
  if (!isSupportedPage(platform)) {
    console.log('[VocabRadar][video-controller] 非目标视频页，不注入侧栏:', location.href);
    removeExistingSidebar();
    // 反思（2026-07-07 二次修复）：非目标页也注册 history hook，确保 SPA 导航到视频页时能触发
    observeVideoChange();
    return;
  }

  vcState.started = true;
  vcState.lastInitUrl = location.href;  // 记录当前 URL，供 triggerReloadGlobal 比较检测 loadstart 误触发
  vcState.lastInitKey = currentVideoKey(); // 第一百零二次：视频稳定标识（bv/v/p/cid 组合），伪换集过滤基准
  const myRequestId = ++_requestId;
  console.log('[VocabRadar][video-controller] startVideoController 请求 ID:', myRequestId, 'URL:', location.href);

  // 反思（2026-07-09）：用户反馈「依旧不能识别视频切换」。
  //   根因：observeVideoChange()（注册 history hook 检测换集）旧版只在字幕成功/通用路径调用，
  //   字幕失败/无字幕/空字幕等提前 return 的路径均未注册 -> 首个视频无字幕时 hook 永不注册，
  //   后续换集无法检测。修正：在 vcState.started=true 后立即注册（幂等），覆盖所有成功/失败路径。
  //   下方 generic/success 路径的旧调用已移除（此处已注册，重复调用虽幂等但冗余）。
  observeVideoChange();

  try {
    const settings = await getSettings();
    const video = await waitForVideo();

    // 反思（2026-07-06 二次修复）：storage.onChanged 监听器提前注册
    // 旧版在字幕处理成功后才注册，字幕失败/空时提前 return 导致监听器永不注册。
    // 用户在 popup 切换 Subtitle Hints 完全无效。现在提前注册，用 flag 防重复。
    if (!_storageListenerRegistered) {
      _storageListenerRegistered = true;
      chrome.storage.onChanged.addListener((changes) => {
        if (changes.rankThreshold) {
          setRankThreshold(changes.rankThreshold.newValue);
        }
        // 反思（2026-07-10 #88）：用户在 popup 切换侧栏开关时，实时显示/隐藏侧栏。
        if (changes.sidebarEnabled) {
          import('../video-sidebar.js').then(({ showSidebar, hideSidebar }) => {
            if (changes.sidebarEnabled.newValue) showSidebar();
            else hideSidebar();
          }).catch(() => { /* ignore */ });
        }
      });
      console.log('[VocabRadar][video-controller] storage.onChanged 监听器已注册');
    }

    // 检测到 video 立即启动 sidebar 骨架（B站/YouTube），与字幕获取并行
    // 反思（2026-07-09）：subtitleOverlay 已移除（用户要求「去掉字幕提示」），
    //   侧栏始终创建并显示，用户可用 ✕ 按钮手动关闭。
    // 反思（2026-07-10 #88）：根据 sidebarEnabled 决定初始可见性。
    //   sidebarEnabled=false 时 hidden=true，侧栏创建但 display:none。
    const sidebarHidden = settings.sidebarEnabled === false;
    startSidebar(video, { hidden: sidebarHidden }).catch((e) => console.error('[VocabRadar][video-controller] sidebar 骨架启动失败:', e));

    // 反思（2026-07-08 #44）：generic 平台（TikTok/抖音/小红书/X/FB/IG/流媒体）无公开字幕API，
    //   跳过字幕获取，直接走无字幕分支（先尝试 ASR 缓存，无缓存才显示"无字幕"提示）。
    //   用户确认范围「侧栏+ASR无字幕获取」。
    if (platform === PLATFORM.GENERIC) {
      try {
        await waitForVideoReady(video);
      } catch (e) {
        console.warn('[VocabRadar][video-controller] generic: video 未就绪, 降级继续:', e.message);
      }
      if (myRequestId !== _requestId) return;
      console.log('[VocabRadar][video-controller] generic 平台: 跳过字幕获取, 尝试 ASR 缓存');
      if (!await loadASRCacheIfAny()) {
        showNoSubtitle();
      }
      // observeVideoChange() 已在函数开头注册（幂等），此处不再重复
      return;
    }

    // waitForVideoReady 与字幕获取并行：字幕获取不依赖 video.duration
    // 超时降级：video 未就绪仍继续取字幕（overlay 跳转可能延迟，但 sidebar 字幕可显示）
    const subtitlesPromise = (platform === PLATFORM.BILIBILI)
      ? getBilibiliSubtitles()
      : getYouTubeSubtitles(settings.sourceLanguage, settings.targetLanguage);

    try {
      await waitForVideoReady(video);
    } catch (e) {
      console.warn('[VocabRadar][video-controller] video 未就绪, 降级继续取字幕:', e.message);
    }

    // 获取字幕（已与 waitForVideoReady 并行）
    // 反思（2026-07-06）：用户反馈"一直转圈圈加载"。根因：subtitlesPromise 抛异常时
    // 被外层 try-catch 捕获但只 console.error，未调 showNoSubtitle()，侧栏永远停在加载态。
    // 修正：单独 try-catch 包裹 subtitlesPromise，异常时调用 showNoSubtitle() 清除加载态。
    let result;
    try {
      result = await subtitlesPromise;
    } catch (e) {
      console.error('[VocabRadar][video-controller] 字幕获取失败:', e);
      // 反思（2026-07-07）：过期请求的错误也丢弃，避免覆盖新请求的 loading 态
      if (myRequestId !== _requestId) {
        console.log('[VocabRadar][video-controller] 过期请求(换集)，丢弃字幕获取失败');
        return;
      }
      // 反思（2026-07-06 三次修复）：用户反馈"语音识别为啥一直选中，哪怕是刷新网页"。
      // 旧版无字幕时自动启动 ASR（autoStartASR），导致每次刷新都自动选中语音识别按钮。
      // 修正：不再自动启动 ASR，显示"无字幕"提示，用户可手动点击 🎤 按钮启动。
      // 反思（2026-07-08 #41）：无字幕时先尝试加载 ASR 缓存（若有），无缓存才显示"无字幕"提示。
      if (!await loadASRCacheIfAny()) {
        showNoSubtitle();
      }
      return;
    }

    // 反思（2026-07-07）：换集竞态保护。旧请求的字幕到达时，若已换集（ID 不匹配），
    // 直接丢弃，绝不调 updateSubtitles 覆盖新视频的字幕。
    if (myRequestId !== _requestId) {
      console.log('[VocabRadar][video-controller] 字幕到达但已换集，丢弃过期字幕:', result?.length || 0, '条');
      return;
    }

    if (!result) {
      console.warn('[VocabRadar][video-controller] 该视频无字幕');
      // 反思（2026-07-06 三次修复）：不再自动启动 ASR，避免每次刷新都自动选中语音识别
      // 反思（2026-07-08 #41）：先尝试加载 ASR 缓存
      if (!await loadASRCacheIfAny()) {
        showNoSubtitle();
      }
      return;
    }

    // YouTube 返回 {tracks, subtitles, pickedIndex}；B站返回数组（兼容）
    let subtitles, tracks = null, pickedIndex = 0;
    if (Array.isArray(result)) {
      subtitles = result;
    } else {
      subtitles = result.subtitles;
      tracks = result.tracks;
      pickedIndex = result.pickedIndex;
    }

    // 反思（2026-07-28）：用户要求"asr的结果要记住并且应当优先加载"。
    //   旧优先级（#86）：sourceLanguage 匹配轨道 > ASR 缓存 > 其他字幕。
    //   新优先级：ASR 缓存 > sourceLanguage 匹配轨道 > 其他字幕 > fetch 第一条 > 空。
    //   即：有 ASR 缓存时优先加载 ASR 缓存（不完整自动继续识别），
    //   无 ASR 缓存才回退到普通字幕轨道。
    const fetchFn = (platform === PLATFORM.BILIBILI) ? fetchBilibiliTrack : fetchYouTubeTrack;
    const sourceLang = (settings.sourceLanguage || 'en').toLowerCase();
    let preferredIndex = -1;
    if (tracks && tracks.length > 0) {
      for (let i = 0; i < tracks.length; i++) {
        if ((tracks[i].languageCode || '').toLowerCase().startsWith(sourceLang)) {
          preferredIndex = i;
          break;
        }
      }
    }

    try {
      // 1. 优先检查 ASR 缓存（用户要求"asr的结果要记住并且应当优先加载"）
      console.log('[VocabRadar][video-controller] 检查 ASR 缓存');
      const asrResult = await loadASRCacheWithCoverage();
      if (asrResult.loaded) {
        // 有 ASR 缓存：选 ASR 轨道，若不完整自动继续识别
        console.log('[VocabRadar][video-controller] ASR 缓存命中, 优先加载 (coverage=' + asrResult.coverage.toFixed(2) + ')');
        setTracks(tracks, tracks ? tracks.length : 0, fetchFn);
        selectASRTrackAndContinue(asrResult.coverage);
      } else if (preferredIndex >= 0) {
        // 2. 无 ASR 缓存：有 sourceLanguage 匹配轨道，优先使用
        console.log('[VocabRadar][video-controller] 无 ASR 缓存, 首选语言', sourceLang, '匹配轨道 index=', preferredIndex);
        if (preferredIndex !== pickedIndex && fetchFn) {
          try {
            const newSubs = await fetchFn(tracks[preferredIndex]);
            if (newSubs && newSubs.length > 0) subtitles = newSubs;
          } catch (e) {
            console.warn('[VocabRadar][video-controller] 首选轨道下载失败，用默认字幕:', e.message);
          }
        }
        if (subtitles && subtitles.length > 0) {
          await updateSubtitles(subtitles);
        } else {
          showNoSubtitle();
        }
        setTracks(tracks, preferredIndex, fetchFn);
      } else if (subtitles && subtitles.length > 0) {
        // 3. 无 ASR 缓存，无首选语言匹配，但有其他语言字幕
        console.log('[VocabRadar][video-controller] 无 ASR 缓存, 使用其他语言字幕:', subtitles.length, '条');
        await updateSubtitles(subtitles);
        setTracks(tracks, pickedIndex, fetchFn);
      } else if (tracks && tracks.length > 0 && fetchFn) {
        // 4. 有轨道但字幕为空：尝试 fetch 第一条
        console.log('[VocabRadar][video-controller] 字幕为空, 尝试 fetch 第一条轨道');
        try {
          const newSubs = await fetchFn(tracks[0]);
          if (newSubs && newSubs.length > 0) {
            await updateSubtitles(newSubs);
            setTracks(tracks, 0, fetchFn);
          } else {
            showNoSubtitle();
          }
        } catch (e) {
          console.error('[VocabRadar][video-controller] fetch 第一条轨道失败:', e);
          showNoSubtitle();
        }
      } else {
        // 5. 啥都没有
        showNoSubtitle();
      }
    } catch (e) {
      console.error('[VocabRadar][video-controller] sidebar 填充失败:', e);
      // 反思（2026-07-07）：用户反馈"有的视频你一直转转转还不自知"。
      // 旧版 catch 只 console.error，未清 loading 态，侧栏永远停在转圈。
      // 修正：调用 showNoSubtitle 清除 loading 并显示错误提示。
      showNoSubtitle('字幕渲染失败：' + (e && e.message ? e.message : String(e)));
    }

    // observeVideoChange() 已在函数开头注册（幂等），此处不再重复
  } catch (e) {
    console.error('[VocabRadar][video-controller] 启动失败:', e);
    // 反思（2026-07-07）：外层 catch 同样需清 loading，避免任何未预期异常导致永转
    try { showNoSubtitle('启动失败：' + (e && e.message ? e.message : String(e))); } catch (_) { /* ignore */ }
  }
}
