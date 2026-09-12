// YouTube 页面逻辑入口（classic script）
// 用动态 import 加载 ES module（详见 bilibili.js 注释）
//
// 第二百七十次：停用规则（Deactivate）gate——与 bilibili.js 同构：命中
//   「视频侧栏」+「视频叠加字幕」双停规则时不加载 video-controller 模块图
//   （尽量不活动），仅留解除观察监听，任一功能解除后自动补启。
//   只停其一不在此拦截（细分编排由 vc/controller.js 按抑制表执行）。

(async () => {
  console.log('[VocabRadar][content-youtube] YouTube content script 已加载');
  try {
    let deact = null;
    try {
      deact = await import(chrome.runtime.getURL('src/lib/deactivate.js'));
    } catch (e) {
      // 不遮蔽：规则库加载失败按"未停用"处理并出声
      console.warn('[VocabRadar][content-youtube] 停用规则库加载失败，按未停用处理:', e);
    }
    const sup = deact
      ? await deact.suppressionFor(location)
      : { videoSidebar: false, overlay: false };
    if (sup.videoSidebar && sup.overlay) {
      console.log('[VocabRadar][content-youtube] 命中停用规则（视频侧栏+叠加字幕全停），不加载视频链路（规则解除后自动恢复）');
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !('deactivateRules' in changes)) return;
        deact.suppressionFor(location).then((s2) => {
          if (!(s2.videoSidebar && s2.overlay)) {
            console.log('[VocabRadar][content-youtube] 停用规则解除，加载 video-controller');
            import(chrome.runtime.getURL('src/content/video-controller.js'))
              .then((mod) => mod.startVideoController('youtube'))
              .catch((e) => console.error('[VocabRadar][content-youtube] 加载 video-controller 失败', e));
          }
        });
      });
      return;
    }
    const url = chrome.runtime.getURL('src/content/video-controller.js');
    const mod = await import(url);
    await mod.startVideoController('youtube');
  } catch (e) {
    console.error('[VocabRadar][content-youtube] 加载 video-controller 失败', e);
  }
})();
