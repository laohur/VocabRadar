// === 第361次（诊断）建：B站侧栏注入时机分档开关；第362次转正为默认档3+隐藏浮窗 ===
// 背景：用户缺陷「开启扩展，若不抑制视频侧栏，bilibili 评论区消失」，多次盲修失败。
// 用户指令：按页面加载时间线划分注入时机档位，逐档实测评论区是否消失，锁定失败步骤。
//
// 实测结论（用户六档回传，第362次实锤根因）：
//   只有档0（立即注入）评论区消失；档1/2/3/4/5 全部正常。
//   根因 = 评论区挂载前把侧栏插入右列文档流，打断 B站 Vue 初始 hydration（评论区挂壳不填）。
//
// 档位定义（storage 键 vsInjectTiming，默认 3=第362次修复值）：
//   0 = 立即注入右列（原线上行为，实锤致评论区消失，仅留作对照档）
//   1 = 延迟 2 秒注入右列
//   2 = 延迟 5 秒注入右列
//   3 = 评论区挂载后再注入右列（waitForBiliCommentsThen，30 秒超时兜底照常注入）【默认】
//   4 = 浮动注入（挂 body 顶层 fixed，不进右列文档流——隔离「插入位置」变量）
//   5 = 不注入（基线，等同抑制侧栏对照）
//
// 第362次修复（用户确认方案「默认档3+收紧信号」）：
//   ① 默认档 0→3，避开「评论区挂载前注入打断 hydration」竞争窗口；
//   ② 信号收紧：等评论区选择器去掉 #commentapp（可能静态存在于初始 HTML，命中过早=弱信号），
//     只认 bili-comments web component（一定动态挂载）；
//   ③ 诊断浮窗默认隐藏，Ctrl+Shift+V 唤出/隐藏（用户裁定「所有诊断窗口都隐藏，用特别按键调出」），
//     输入框/可编辑焦点时不响应，避免与浏览器「粘贴纯文本」冲突。
//   本文件保留为隐藏诊断开关（修复验证/回归排查用），六档切换能力不变。

// 档位值预取：模块求值即读 storage，注入发生在页面加载数百 ms 后，通常已就绪；
// 未就绪时 getInjectTiming() 返回默认 3（第362次修复值）。
// 注意：测试期切过档的用户 storage 里存有旧档值，会覆盖此默认（用诊断键打开浮窗核对档位）。
let _timing = 3;
try {
  chrome.storage.local.get({ vsInjectTiming: 3 }, (r) => { _timing = r.vsInjectTiming | 0; });
} catch (e) { /* 非扩展环境忽略 */ }

/** 读当前注入时机档位（0-5，见文件头注释） */
export function getInjectTiming() {
  return _timing;
}

/**
 * 档3：等 B 站评论区挂载后执行 fn。
 * 评论区为嵌套 shadow DOM 的 web component（bili-comments），宿主容器 #commentapp；
 * 诊断工具不追求优雅，500ms 轮询足够；30 秒超时兜底执行 fn（关评论区视频兜底，避免永不注入卡死）。
 */
export function waitForBiliCommentsThen(fn) {
  // 第362次收紧：去掉 #commentapp——该容器可能静态存在于初始 HTML，命中过早使档3退化成
  // 「只延迟~500ms」的弱信号；只认 bili-comments / .bili-comments（web component 本体，一定动态挂载）。
  const SEL = 'bili-comments, .bili-comments';
  const startedAt = Date.now();
  const timer = setInterval(() => {
    let mounted = false;
    try { mounted = !!document.querySelector(SEL); } catch (e) { mounted = false; }
    if (mounted || Date.now() - startedAt > 30000) {
      clearInterval(timer);
      try {
        console.log('[VocabRadar][inject-timing] 档3 评论区'
          + (mounted ? '已挂载' : '30s超时兜底') + '，执行注入 @'
          + Math.round((Date.now() - startedAt) / 100) / 10 + 's');
      } catch (e) { /* ignore */ }
      fn();
    }
  }, 500);
}

/**
 * 右下角迷你浮窗（第362次起默认隐藏，Ctrl+Shift+V 唤出/隐藏）：
 * 六个档位按钮，点击写 storage 并刷新页面生效。
 * 仅 B站视频页创建（本缺陷只在该场景复现）；幂等（startVideoController 换集会重跑）。
 */
export function startTimingSwitcher() {
  try {
    if (window.__vrTimingSwitcher) return;  // 幂等：换集重启不重复建窗
    if (!/(^|\.)bilibili\.com$/.test(location.hostname)) return;  // 仅 B站
    if (!/\/video\/(BV[\w]+|av\d+)/i.test(location.pathname)) return;  // 仅普通视频页

    const LABELS = [
      ['0', '0 立即注入', '立即注入右列——原默认行为，实锤致评论区消失，仅作对照'],
      ['1', '1 +2秒', '延迟 2 秒注入右列'],
      ['2', '2 +5秒', '延迟 5 秒注入右列'],
      ['3', '3 评论区后（默认）', '等评论区挂载后再注入右列（30s 超时兜底）——修复默认档'],
      ['4', '4 浮动', '浮动注入：挂 body 顶层，不进右列文档流'],
      ['5', '5 不注入', '基线：完全不注入侧栏（等同抑制侧栏对照）']
    ];

    const host = document.createElement('div');
    host.id = 'vr-inject-timing-host';
    // 第362次：display:none 默认隐藏（用户裁定「所有诊断窗口都隐藏，用特别按键调出」）
    host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;display:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .bar { display:flex; align-items:center; gap:4px; padding:4px 6px;
               background:rgba(20,20,20,.92); border-radius:6px;
               font:11px/1.4 sans-serif; color:#eee; box-shadow:0 2px 8px rgba(0,0,0,.4); }
        .bar b { margin-right:2px; font-weight:600; color:#9fe; }
        button { all:unset; cursor:pointer; padding:2px 6px; border-radius:4px;
                 background:#3a3a3a; color:#eee; font:11px/1.4 sans-serif; }
        button:hover { background:#555; }
        button.cur { background:#1a7f4b; color:#fff; font-weight:600; }
      </style>
      <div class="bar"><b>注入档位</b></div>`;
    const bar = shadow.querySelector('.bar');
    LABELS.forEach(([val, label, tip]) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.title = tip;
      btn.dataset.timing = val;
      if ((val | 0) === _timing) btn.classList.add('cur');
      btn.addEventListener('click', () => {
        try {
          chrome.storage.local.set({ vsInjectTiming: val | 0 }, () => location.reload());
        } catch (e) { /* ignore */ }
      });
      bar.appendChild(btn);
    });
    document.documentElement.appendChild(host);
    // 第362次：Ctrl+Shift+V 唤出/隐藏浮窗（用户裁定「所有诊断窗口都隐藏，用特别按键调出」）。
    // 监听器全局只绑一次（__vrTimingKeyBound 幂等，换集重跑不重复绑）；
    // 输入框/可编辑焦点时忽略，避免与浏览器「粘贴纯文本」冲突。
    if (!window.__vrTimingKeyBound) {
      window.__vrTimingKeyBound = true;
      window.addEventListener('keydown', (ev) => {
        try {
          if (!ev.ctrlKey || !ev.shiftKey) return;
          if ((ev.key || '').toLowerCase() !== 'v') return;
          const t = ev.target;
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
          host.style.display = host.style.display === 'none' ? '' : 'none';
        } catch (e) { /* ignore */ }
      }, true);
    }
    window.__vrTimingSwitcher = host;
  } catch (e) { /* 诊断工具自身异常不影响主链路 */ }
}
