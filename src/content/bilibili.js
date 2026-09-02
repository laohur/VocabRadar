// B站页面逻辑入口（classic script）
//
// 重要：content_scripts 是 classic script，不能用静态 import。
// 这里用动态 import(chrome.runtime.getURL(...)) 加载 ES module。
// 加载后的 module 内部可互相静态 import（在 module 上下文）。
// 这是 Chrome 扩展 MV3 content_scripts 使用 ES module 的可靠做法。

(async () => {
  console.log('[VocabRadar][content-bilibili] B站 content script 已加载');
  // 反思（2026-08-17 第七十二次补充）：删除词典预热——词典仅由 text-hint startHint
  //   按需 await loadDictionary() 加载一次（singleton），bilibili.js 不再重复触发。
  try {
    const url = chrome.runtime.getURL('src/content/video-controller.js');
    const mod = await import(url);
    await mod.startVideoController('bilibili');
  } catch (e) {
    console.error('[VocabRadar][content-bilibili] 加载 video-controller 失败', e);
  }
})();

// 消息处理（弹幕/评论按钮触发，右键查词等）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SEND_DANMAKU') {
    import(chrome.runtime.getURL('src/lib/bilibili-danmaku.js'))
      .then(({ sendDanmaku }) => sendDanmaku())
      .catch((e) => console.error('[VocabRadar][content-bilibili] 加载 bilibili-danmaku 失败', e));
  } else if (msg.type === 'SEND_COMMENT') {
    import(chrome.runtime.getURL('src/lib/bilibili-comment.js'))
      .then(({ sendComment }) => sendComment())
      .catch((e) => console.error('[VocabRadar][content-bilibili] 加载 bilibili-comment 失败', e));
  }
  sendResponse({ ok: true });
  return true;
});
