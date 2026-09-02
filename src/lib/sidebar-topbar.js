// VocabRadar 统一侧栏顶行构建器（第一百二十四次新建）
//
// 用户裁定："侧栏顶部用一个代码文件。"——视频侧栏（video-sidebar.js）与文本侧栏
// （web-sidebar-impl.js）的顶行结构、按钮顺序、样式全部由本文件唯一定义；
// 两形态顶行从此不可能长歪。
//
// 顶行结构（统称"侧栏"，内容照旧）：
//   [◎ VocabRadar] ······ [切换形态][🌐][⋯][◀][✕(仅文本)]
//   - 左端 ◎ 为内联 SVG 小图标（brandIconSVG），第一百七十六次由 🦫 替换而来
//   - 切换形态：视频形态显示 📄（切去文本），文本形态显示 🎬（切回视频）
//   - 折叠态约定：视频侧栏折叠=仅剩本顶行；文本侧栏折叠=悬浮球
//
// 样式以 <style> 注入（ensureTopbarCss，幂等），选择器同时覆盖两个根：
//   #beaver-sidebar（视频）与 #beaver-web-sidebar（文本）
// 各侧栏原有语言/设定浮层不属顶行本体，仍留各自文件（内部 select 数据绑定不同）。

/** 表单形态常量 */
export const TOPBAR_FORM = { VIDEO: 'video', TEXT: 'text' };

/**
 * 品牌小图标（内联 SVG）
 * 第一百七十六次（用户："侧栏顶行左端的图示字符显示不出来，换成小图标"）：
 *   原先标题前是 🦫（U+1F9AB，Emoji 11.0）。Windows 10 的旧版 Segoe UI Emoji 无此字形，
 *   渲染成空白方块（豆腐块），这正是用户看到"显示不出来"的原因。
 * 为何用内联 SVG 而不是 <img src=chrome.runtime.getURL(icon16.png)>：
 *   1) 不依赖 web_accessible_resources 与网络/协议加载，任何宿主页面都必现；
 *   2) 无 <img> 的原生拖拽行为（ws/ui.js 曾因此踩坑，见该文件注释）；
 *   3) stroke 用 currentColor，随标题颜色/主题自动变化，不会在深色页面糊成一团。
 * 图形取"雷达"意象（同心圆 + 中心点 + 扫描线），与产品名 VocabRadar 对应。
 * 导出原因：图片翻译面板（th/panel.js）等扩展自身界面同样需要这枚图标，
 *   由本文件唯一定义，避免各处各画一版。
 * @returns {string} SVG 字符串
 */
export function brandIconSVG() {
  return `<svg class="beaver-brand-icon" viewBox="0 0 24 24" width="18" height="18" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"
  ><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="4.5"></circle
  ><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"></circle
  ><path d="M12 12 L18.4 5.6"></path></svg>`;
}

/**
 * 构建顶行 HTML。
 * 通过 ids 映射保留各侧栏既有元素 id——事件绑定代码零改动。
 * @param {{form:'video'|'text', title?:string, ids?:Object<string,string>, showClose?:boolean}} opts
 *   form:       当前形态（决定切换形态按钮图标指向另一形态）
 *   title:      标题文本（默认 VocabRadar；左侧小图标由本文件统一加，调用方不必传）
 *   ids:        {form,lang,settings,collapse,close} 元素 id 覆盖（缺省用通用 id）
 *   showClose:  是否显示 ✕ 快捷关闭（文本侧栏 true，视频侧栏走 ⋯ 内关闭项）
 * @returns {string} HTML 字符串
 */
export function buildTopbarHTML(opts) {
  const form = (opts && opts.form === 'text') ? 'text' : 'video';
  const title = (opts && opts.title) || 'VocabRadar';
  const ids = (opts && opts.ids) || {};
  const idOf = (key, dflt) => (ids[key] || dflt);
  const showClose = !!(opts && opts.showClose);
  // 标题文案可由调用方按界面语言传入（缺省英文兜底；data-i18n-title 供有
  // applyI18n 的侧栏（视频）在语言切换时自动刷新）
  const tt = (opts && opts.titles) || {};
  const T = {
    form: tt.form || (form === 'video' ? 'Text Sidebar' : 'Video Sidebar'),
    settings: tt.settings || 'Settings',
    collapse: tt.collapse || 'Collapse',
    close: tt.close || 'Close'
  };
  // 切换形态按钮：图标指向"另一个形态"
  const formBtnId = form === 'video'
    ? idOf('form', 'beaver-form-btn')
    : idOf('form', 'beaver-web-video-btn');
  const formIcon = form === 'video' ? '📄' : '🎬';
  const formKey = form === 'video' ? 'ws.textSidebar' : 'ws.videoSidebar';
  // settings 按钮视频侧栏历史上无 id（按类查询）——id 为空时省略属性
  const settingsId = idOf('settings', form === 'video' ? '' : 'beaver-web-settings-btn');
  const settingsAttr = settingsId ? ` id="${settingsId}"` : '';
  return `
    <div class="beaver-header">
      <span class="beaver-title">${brandIconSVG()}<span class="beaver-title-text">${title}</span></span>
      <div class="beaver-header-actions">
        <button class="beaver-form-btn" id="${formBtnId}" data-i18n-title="${formKey}" title="${T.form}">${formIcon}</button>
        <button class="beaver-lang-btn" id="${idOf('lang', form === 'video' ? 'beaver-lang-btn' : 'beaver-web-lang-btn')}" title="🌐">🌐</button>
        <button class="beaver-settings-btn"${settingsAttr} data-i18n-title="btn.settings" title="${T.settings}">⋯</button>
        <button class="beaver-collapse-btn" id="${idOf('collapse', form === 'video' ? 'beaver-sidebar-collapse' : 'beaver-web-collapse-btn')}" title="${T.collapse}">◀</button>
        ${showClose ? `<button class="beaver-close-btn" id="${idOf('close', 'beaver-web-close-btn')}" data-i18n-title="ws.close" title="${T.close}">✕</button>` : ''}
      </div>
    </div>`;
}

/**
 * 注入顶行统一样式（幂等：重复调用只更新同一 <style> 内容）。
 * 选择器双根并列，特异性高于各侧栏旧规则；末位注入天然覆盖同优先级旧样式。
 */
export function ensureTopbarCss() {
  const STYLE_ID = 'beaver-topbar-css';
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(el);
  }
  el.textContent = `
/* === 统一侧栏顶行（sidebar-topbar.js 唯一来源）=== */
#beaver-sidebar .beaver-header,
#beaver-web-sidebar .beaver-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--beaver-bg-soft, #f5f8f3);
  flex-shrink: 0;
  gap: 8px;
}
/* 产品名（第一百七十四次）：用户反馈"文本侧栏顶部的产品名不明显"。
   原为 1.15em/600/棕色 #6d4c41，在浅绿顶栏底上对比度弱、字号也不够。
   改为 1.34em/700 + 主色深绿（对比度更高）+ 轻微字距。
   第一百七十六次：标题由 [小图标 + 文字] 两块组成（原 🦫 emoji 在 Win10 无字形），
   故改 inline-flex 让图标与文字垂直居中且留 6px 间距；省略号只加在文字块上，
   避免容器过窄时把图标一起截掉。
   注意：本处是顶栏标题样式的唯一来源（id 选择器优先级高于 sidebar.css 的 .beaver-header .beaver-title）。 */
#beaver-sidebar .beaver-title,
#beaver-web-sidebar .beaver-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 1.2em;   // 第二百一十二次（用户："产品名字号略大"）1.34→1.2
  font-weight: 700;
  letter-spacing: 0.3px;
  line-height: 1.25;
  color: var(--beaver-primary-dark, #1c4d32);
  white-space: nowrap;
  overflow: hidden;
}
#beaver-sidebar .beaver-title .beaver-title-text,
#beaver-web-sidebar .beaver-title .beaver-title-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 品牌小图标：不参与压缩（flex-shrink:0），描边用 currentColor 随标题色 */
#beaver-sidebar .beaver-title .beaver-brand-icon,
#beaver-web-sidebar .beaver-title .beaver-brand-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  display: block;
  color: inherit;
}
#beaver-sidebar .beaver-header-actions,
#beaver-web-sidebar .beaver-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
#beaver-sidebar .beaver-form-btn,
#beaver-sidebar .beaver-lang-btn,
#beaver-sidebar .beaver-settings-btn,
#beaver-sidebar .beaver-collapse-btn,
#beaver-sidebar .beaver-close-btn,
#beaver-web-sidebar .beaver-form-btn,
#beaver-web-sidebar .beaver-lang-btn,
#beaver-web-sidebar .beaver-settings-btn,
#beaver-web-sidebar .beaver-collapse-btn,
#beaver-web-sidebar .beaver-close-btn {
  background: var(--beaver-btn-bg, #eff3ec);
  border: none;
  border-radius: var(--beaver-radius-sm, 8px);
  padding: 4px 10px;
  min-width: 30px;
  font-size: 15px;
  line-height: 1.4;
  color: var(--beaver-text-soft, #424942);
  cursor: pointer;
  box-shadow: var(--beaver-shadow-1, 0 1px 2px rgba(26,31,26,.10));
  transition: background 0.15s;
}
#beaver-sidebar .beaver-form-btn:hover,
#beaver-sidebar .beaver-lang-btn:hover,
#beaver-sidebar .beaver-settings-btn:hover,
#beaver-sidebar .beaver-collapse-btn:hover,
#beaver-sidebar .beaver-close-btn:hover,
#beaver-web-sidebar .beaver-form-btn:hover,
#beaver-web-sidebar .beaver-lang-btn:hover,
#beaver-web-sidebar .beaver-settings-btn:hover,
#beaver-web-sidebar .beaver-collapse-btn:hover,
#beaver-web-sidebar .beaver-close-btn:hover {
  background: var(--beaver-btn-bg-hover, #e9eee7);
  color: var(--beaver-text, #1a1f1a);
}
#beaver-sidebar .beaver-lang-btn.active,
#beaver-web-sidebar .beaver-lang-btn.active {
  background: var(--beaver-primary-light, #a8e6cf);
  color: var(--beaver-on-primary-container, #0d2014);
}
/* 文本侧栏顶行承担拖动（视频侧栏仅 float 形态可拖，见 sidebar.css） */
#beaver-web-sidebar .beaver-header {
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
/* 第一百三十二次：防御性 order——sidebar.css 曾有无作用域 .beaver-header{order:1}
 * （该文件被文本侧栏在所有页面加载以共用令牌），会把文本面板顶行排到最后。
 * 本规则 ID 特异性 + order:-1 保证文本侧栏顶行永远在最前（视频侧栏各行
 * 由 applyInlineOrder 写内联 style.order，不受影响）。 */
#beaver-web-sidebar .beaver-web-panel > .beaver-header { order: -1; }
`;
}
