// YouTube 页面逻辑入口（classic script）
// 用动态 import 加载 ES module（详见 bilibili.js 注释）

(async () => {
  console.log('[VocabRadar][content-youtube] YouTube content script 已加载');
  try {
    const url = chrome.runtime.getURL('src/content/video-controller.js');
    const mod = await import(url);
    await mod.startVideoController('youtube');
  } catch (e) {
    console.error('[VocabRadar][content-youtube] 加载 video-controller 失败', e);
  }
})();
