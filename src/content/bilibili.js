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

// 第二百二十五次：删除 SEND_DANMAKU / SEND_COMMENT 死消息监听（《命名清查》裁定）——
//   自动发送时代残留：全库只有本监听、没有任何发送方；评论助手现行路径为
//   vs/comment-fill.js（由侧栏评论按钮直接调用），不经过消息通道。
//   （弹幕模块 src/lib/bilibili-danmaku.js 已随弹幕功能移除而删除。）
