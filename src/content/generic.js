// 通用视频站点入口（classic script）
// 反思（2026-07-08 #44）：用户要求「videoseek支持多个视频网站，你也一样」。
//   覆盖 TikTok/抖音/小红书/X/FB/IG + Netflix/Disney+/Prime Video 流媒体站。
//   这些站点无公开字幕 API，仅注入侧栏 + ASR（无字幕时用 ASR）。
//   参照 Language Reactor / Trancy：检测视频元素，浮动注入侧栏。
//   用动态 import 加载 ES module（详见 bilibili.js 注释）。
//
// 反思（2026-08-11 第二十一次）：用户反馈「默认展开视频侧栏，错误」。
//   根因：generic.js 在所有 <all_urls> 站点加载 video-controller.js，
//   isSupportedPage('generic') 总返回 true，导致非视频页只要有 <video> 元素
//   （广告视频/背景视频/教程视频）就创建视频侧栏，覆盖了文本侧栏的悬浮球。
//   修正：先检测页面是否有「有意义的视频」，无意义视频则不加载 video-controller。
//
// 反思（2026-08-12 第四十次）：用户反馈"火狐中默认多显示了视频侧栏"。
//   根因：hasMeaningfulVideo 检测过于宽松——width>=200 且 height>=120 即判定为正片视频，
//   但很多网站的小广告视频、自动播放 muted 背景视频也满足此尺寸，导致误判。
//   修正：增强检测条件——
//   1. 尺寸阈值提高到 width>=480 且 height>=270（接近 480p，排除小广告）
//   2. 增加时长检查 duration>=60 秒（排除短视频广告/预告片）
//   3. 排除典型广告/背景视频特征（muted && autoplay && !controls）
//   4. 初始检测延迟从 1.5 秒增加到 5 秒，二次检测从 3.5 秒增加到 10 秒
//      给 SPA 页面足够渲染时间，避免页面未完全加载时误判
function hasMeaningfulVideo() {
  const videos = document.querySelectorAll('video');
  for (const v of videos) {
    const rect = v.getBoundingClientRect();
    // 排除隐藏的视频
    if (rect.width < 10 || rect.height < 10) continue;

    // 排除典型广告/背景视频：muted + autoplay + 无 controls
    // 这类视频通常是装饰性背景或自动播放广告，不是用户要学习的正片
    if (v.muted && v.autoplay && !v.controls) continue;

    // 尺寸阈值：width>=480 且 height>=270（约 480p，排除小广告视频）
    if (rect.width >= 480 && rect.height >= 270) {
      // 时长检查：duration>=60 秒（排除短视频广告/预告片）
      // duration 为 NaN 时（流媒体未确定时长）放宽条件，仅靠尺寸判定
      if (!isFinite(v.duration) || v.duration >= 60) return true;
    }

    // video 有 src 且不是 about:blank，readyState>=1（有元数据），尺寸虽未达标但有 src
    // 放宽条件：仅当视频有 controls（用户可操控）且有时长时才算
    if (v.src && v.src !== 'about:blank' && v.readyState >= 1 && v.controls) {
      if (!isFinite(v.duration) || v.duration >= 60) return true;
    }
  }
  return false;
}

(async () => {
  console.log('[VocabRadar][content-generic] 通用站点 content script 已加载:', location.hostname);
  // 反思（2026-08-17 第七十二次补充）：删除词典预热——词典仅由 text-hint startHint
  //   按需 await loadDictionary() 加载一次（singleton），generic.js 不再重复触发。

  // 第二百七十次：停用规则（Deactivate）gate——与 bilibili.js/youtube.js 同构：
  //   命中「视频侧栏」+「视频叠加字幕」双停规则时不启动视频检测与 controller
  //   加载（尽量不活动），仅留解除观察监听，任一功能解除后重新走视频检测。
  //   只停其一不在此拦截（细分编排由 vc/controller.js 按抑制表执行）。
  try {
    let deact = null;
    try {
      deact = await import(chrome.runtime.getURL('src/lib/deactivate.js'));
    } catch (e) {
      // 不遮蔽：规则库加载失败按"未停用"处理并出声
      console.warn('[VocabRadar][content-generic] 停用规则库加载失败，按未停用处理:', e);
    }
    const sup = deact
      ? await deact.suppressionFor(location)
      : { videoSidebar: false, overlay: false };
    if (sup.videoSidebar && sup.overlay) {
      console.log('[VocabRadar][content-generic] 命中停用规则（视频侧栏+叠加字幕全停），不启动视频链路（规则解除后自动恢复）');
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !('deactivateRules' in changes)) return;
        deact.suppressionFor(location).then((s2) => {
          if (!(s2.videoSidebar && s2.overlay)) {
            console.log('[VocabRadar][content-generic] 停用规则解除，重新开始视频检测');
            checkAndStart(1000, false);
          }
        });
      });
      return;
    }
  } catch (e) {
    console.warn('[VocabRadar][content-generic] 停用规则检查异常，按未停用继续:', e);
  }

  // 反思（2026-08-12）：增强视频检测条件 + 延长检测延迟
  //   初始延迟 5 秒，二次延迟 10 秒，给 SPA 充分渲染时间
  const checkAndStart = (delay, isFinal) => {
    setTimeout(() => {
      if (hasMeaningfulVideo()) {
        console.log('[VocabRadar][content-generic] 检测到有意义的视频，加载 video-controller');
        try {
          import(chrome.runtime.getURL('src/content/video-controller.js'))
            .then((mod) => mod.startVideoController('generic'))
            .catch((e) => console.error('[VocabRadar][content-generic] 加载 video-controller 失败', e));
        } catch (e) {
          console.error('[VocabRadar][content-generic] 加载 video-controller 失败', e);
        }
      } else if (!isFinal) {
        checkAndStart(10000, true);
      } else {
        console.log('[VocabRadar][content-generic] 无有意义的视频，不加载 video-controller');
      }
    }, delay);
  };
  checkAndStart(5000, false);
})();
