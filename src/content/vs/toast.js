// =============================================================================
// vs/toast.js —— 冒泡提示子模块
// -----------------------------------------------------------------------------
// 职责：toast() 冒泡提示（替代 alert，非致命错误用；含错误态 ≥5s、悬停暂停计时）。
// 关系：因需读取门面 _cfg.toastDuration，经 getCfg() 对门面构成受控循环 import
//       ——本模块顶层仅函数声明，绝不触碰门面绑定，getCfg() 调用全部发生在
//       toast 函数体内（运行时门面已初始化完毕，安全）。
//       toastDuration 改走 `getCfg().toastDuration`。
//       门面经 `export { toast } from './vs/toast.js'` 接驳导出，
//       外部引用方（vs/ocr.js 等）路径与符号不变。
// =============================================================================

import { getCfg } from '../video-sidebar.js';

// === 冒泡提示（替代 alert，非致命错误用） ===
// msg: 文本；opts: {x,y,duration,error} —— x,y 为屏幕坐标，缺省居中底部
export function toast(msg, opts) {
  const o = (typeof opts === 'number') ? { duration: opts } : (opts || {});
  const el = document.createElement('div');
  el.className = 'beaver-toast' + (o.error ? ' error' : '');
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  // 关闭按钮：点击立即移除，便于复制后手动关
  const close = document.createElement('span');
  close.className = 'beaver-toast-close';
  close.textContent = '×';
  close.addEventListener('click', () => el.remove());
  el.appendChild(close);

  // 定位
  let x = o.x, y = o.y;
  if (typeof x !== 'number' || typeof y !== 'number') {
    // 默认：屏幕底部居中
    el.style.left = '50%';
    el.style.bottom = '30px';
    el.style.transform = 'translateX(-50%)';
  } else {
    // 点击位置下方，避免遮挡原内容 + 避免溢出屏幕
    el.style.left = Math.min(Math.max(8, x - 160), window.innerWidth - 332) + 'px';
    // 优先放点击点下方；若接近屏幕底部则放上方
    const belowY = y + 24;
    if (belowY > window.innerHeight - 80) {
      el.style.top = Math.max(8, y - 60) + 'px';
    } else {
      el.style.top = belowY + 'px';
    }
  }
  document.body.appendChild(el);
  // 错误提示至少展示 5 秒；鼠标悬停/键盘焦点进入时
  //   计时暂停（不自动消失），离开后按剩余时间继续，便于读完报错信息。
  const dur = Math.max(o.duration || getCfg().toastDuration, o.error ? 5000 : 0);
  let timer = null;
  let deadline = Date.now() + dur;
  let remaining = dur;
  function schedule(millis) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { try { el.remove(); } catch (e) { /* ignore */ } }, millis);
  }
  schedule(dur);
  el.addEventListener('mouseenter', () => {
    if (timer) clearTimeout(timer);
    remaining = Math.max(0, deadline - Date.now());
  });
  el.addEventListener('mouseleave', () => {
    deadline = Date.now() + remaining;
    schedule(remaining);
  });
  el.addEventListener('focusin', () => {
    if (timer) clearTimeout(timer);
    remaining = Math.max(0, deadline - Date.now());
  });
  el.addEventListener('focusout', () => {
    deadline = Date.now() + remaining;
    schedule(remaining);
  });
}
