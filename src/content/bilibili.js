// B站页面逻辑入口（classic script）
//
// 重要：content_scripts 是 classic script，不能用静态 import。
// 这里用动态 import(chrome.runtime.getURL(...)) 加载 ES module。
// 加载后的 module 内部可互相静态 import（在 module 上下文）。
// 这是 Chrome 扩展 MV3 content_scripts 使用 ES modules 的可靠做法。
//
// 第二百七十次：停用规则（Deactivate）gate——命中「视频侧栏」+「视频叠加字幕」
//   双停规则时本页尽量不活动：不加载 video-controller 模块图（侧栏/overlay/ASR
//   全在它的模块图里），仅留轻量解除观察监听；任一功能解除后自动补启。
//   只停其一不在此拦截（细分编排由 vc/controller.js 按抑制表执行）。
//   匹配/存储逻辑唯一来源 src/lib/deactivate.js（非打包入口文件，原样进 dist）。

(async () => {
  console.log('[VocabRadar][content-bilibili] B站 content script 已加载');
  // 反思（2026-08-17 第七十二次补充）：删除词典预热——词典仅由 text-hint startHint
  //   按需 await loadDictionary() 加载一次（singleton），bilibili.js 不再重复触发。
  try {
    let deact = null;
    try {
      deact = await import(chrome.runtime.getURL('src/lib/deactivate.js'));
    } catch (e) {
      // 不遮蔽：规则库加载失败按"未停用"处理并出声
      console.warn('[VocabRadar][content-bilibili] 停用规则库加载失败，按未停用处理:', e);
    }
    const sup = deact
      ? await deact.suppressionFor(location)
      : { videoSidebar: false, overlay: false };
    if (sup.videoSidebar && sup.overlay) {
      console.log('[VocabRadar][content-bilibili] 命中停用规则（视频侧栏+叠加字幕全停），不加载视频链路（规则解除后自动恢复）');
      // 解除观察：任一功能解除即补启 controller（监听残留无害——补启后细分编排归 controller）
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !('deactivateRules' in changes)) return;
        deact.suppressionFor(location).then((s2) => {
          if (!(s2.videoSidebar && s2.overlay)) {
            console.log('[VocabRadar][content-bilibili] 停用规则解除，加载 video-controller');
            import(chrome.runtime.getURL('src/content/video-controller.js'))
              .then((mod) => mod.startVideoController('bilibili'))
              .catch((e) => console.error('[VocabRadar][content-bilibili] 加载 video-controller 失败', e));
          }
        });
      });
      return;
    }
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
