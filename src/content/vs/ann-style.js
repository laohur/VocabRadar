// =============================================================================
// vs/ann-style.js —— 配色写入与注释池样式子模块
// -----------------------------------------------------------------------------
// 职责：applyColorSettings()（配色 storage → :root CSS 变量）、applyAnnStyle()
//       （侧栏根加/换 beaver-ann-style-{id} 类）、refreshAnnPoolCss()/
//       injectAnnPoolCss()（52 条统一共享池样式表注入与个性化规则刷新，
//       style id 带 -vs 后缀与文本侧栏 -ws 区分）。
// 来源：拆分自 src/content/video-sidebar.js（2026-09-27 拆分第四刀，纯机械搬移）。
// 关系：依赖 ../../lib/styles.js（buildAnnPoolCss）；因 applyAnnStyle 需读取门面
//       _root，经 getRoot() 对门面构成受控循环 import——本模块顶层仅函数声明与
//       一次 injectAnnPoolCss() 副作用调用（挂 document.head，不触碰门面绑定，
//       运行时安全），getRoot() 调用全部发生在 applyAnnStyle 函数体内。
//       门面 _cfgReady 与 storage.onChanged 监听器调
//       applyColorSettings/refreshAnnPoolCss/applyAnnStyle。
// =============================================================================

import { buildAnnPoolCss } from '../../lib/styles.js';
import { getRoot } from '../video-sidebar.js';

/**
 * 把配色设置写入 :root CSS 变量（视频侧栏字幕区 + 视频内字幕复用）
 * 反思（2026-08-05）：提取为独立函数，_cfgReady 和 storage 监听器共用。
 *   旧版只写 first-bg/later-bg，漏了 first-fg/ann-bg/ann-fg，导致字色和注释色不跟随 popup。
 * 反思（2026-08-06 修正）：用户要求"注释为单词的前后景互换，总共两种颜色"。
 *   旧版注释配色独立配置且 fallback 为旧值 #e0e0e0/#616161，导致"设定栏暗底亮字但实际暗底暗字"。
 *   修正：注释配色自动派生自单词配色（annBg=firstFg, annFg=firstBg），不再独立配置。
 *   这样无论 storage 中 hintAnnotationBg/Fg 是什么旧值，注释始终是单词的前后景互换。
 * @param {object} settings
 */
export function applyColorSettings(settings) {
  const rootStyle = document.documentElement.style;
  // 反思（2026-08-18 第七十三次修正）：默认曾是绿底白字。
  // 304次（用户"默认无底色"）：生词默认透明底绿字（注释见上）。
  const firstBg = settings.hintFirstBg || 'transparent';
  const firstFg = settings.hintFirstFg || '#2e6b43';
  rootStyle.setProperty('--beaver-first-bg', firstBg);
  rootStyle.setProperty('--beaver-first-fg', firstFg);
  rootStyle.setProperty('--beaver-later-bg', settings.hintLaterBg || firstBg);
  rootStyle.setProperty('--beaver-later-fg', settings.hintLaterFg || firstFg);
  // 378次（用户"注释没有跟随样式，而是变成了无色"）：删除本函数对
  //   --beaver-ann-bg/fg 的硬写（旧值 transparent/firstBg）。
  //   此处与 th/core.js applyColorVars 写同一 documentElement 节点，storage 监听
  //   异步后写覆盖了条目样式（pickColors 条目优先）已写的注释色，导致有色条目注释无色。
  //   默认值由 sidebar.css :root 兜底，注释色完全交由条目样式/pool CSS 提供。
}

/**
 * 应用视频侧栏注释样式预设（引导页选择，52 条统一共享池样式）
 * 280次：videoAnnotationStyle 复活——三功能独立选样式（多对多），与共享池同 id 集；
 *   root 加/换 beaver-ann-style-{id} 类（实际声明由注入的统一池样式表提供，
 *   buildAnnPoolCss 按 POOL_STYLES 生成，取代 sidebar.css 手写 16 条）。
 * @param {string} styleId 'none' 或其他样式 id
 */
export function applyAnnStyle(styleId) {
  const _root = getRoot();
  if (!_root) return;
  const id = (typeof styleId === 'string' && styleId !== 'none') ? styleId : '';
  for (const cls of Array.from(_root.classList)) {
    if (cls.startsWith('beaver-ann-style-')) _root.classList.remove(cls);
  }
  if (id) _root.classList.add('beaver-ann-style-' + id);
}

// 280次：注入统一池样式表（52 条共享样式声明，逐容器参数化选择器）。
//   挂 document.head（不依赖 _root 时点），选择器以 #beaver-sidebar 为根；
//   取代 sidebar.css 手写 16 条（文本侧栏 web-sidebar-impl.js 亦同源注入）。
injectAnnPoolCss();

/** 注入统一池样式表（style id 带 -vs 后缀，与文本侧栏 -ws 区分，二者可能共存一页） */
// 301次：个性化/用户条目规则刷新（独立覆盖写 textContent；空即只剩内置池）。
export function refreshAnnPoolCss(customObj, userList) {
  let el = document.getElementById('beaver-ann-pool-css-vs');
  const extra = [];
  if (customObj && typeof customObj === 'object') {
    extra.push(Object.assign({ id: 'ann-custom' }, customObj));
  }
  if (Array.isArray(userList)) {
    for (const st of userList) {
      if (st && typeof st.id === 'string' && st.id.indexOf('ann-user-') === 0) extra.push(st);
    }
  }
  const css = buildAnnPoolCss({
    root: '#beaver-sidebar',
    word: '.beaver-sub-text .beaver-word',
    annInline: '.beaver-ann-inline',
    annWord: '.beaver-ann-line .beaver-ann-word',
    extra
  });
  if (!el) {
    el = document.createElement('style');
    el.id = 'beaver-ann-pool-css-vs';
    document.head.appendChild(el);
  }
  el.textContent = css;
}
function injectAnnPoolCss() {
  refreshAnnPoolCss(null, null);
}
