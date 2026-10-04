// =============================================================================
// vs/build.js —— 侧栏骨架构建与 i18n 应用子模块
// -----------------------------------------------------------------------------
// 职责：buildSidebar()（DOM 骨架模板，含顶行/语言浮层/tabs/工具栏/面板/底栏/设定
//       浮层）、applyInlineOrder()（内联 order 作 CSS 缓存克星）、closeAllPopups()
//       （统一关闭设定/语言浮层）、applyI18n()（[data-i18n] 全量应用 + loading 文案）。
// 关系：依赖 ../../lib/sidebar-topbar.js（buildTopbarHTML）、../../lib/i18n.js（t/getLang）、
//       ./logger.js（log）；因需读取门面 _root，经 getRoot() 对门面构成受控循环
//       import——本模块顶层仅函数声明，绝不触碰门面绑定，getRoot() 调用全部发生
//       在函数体内（运行时门面已初始化完毕，安全）。
//       门面 startSidebar 调 buildSidebar/applyInlineOrder/applyI18n；
//       closeAllPopups 由 bindEvents 与 document click 监听调用。
// =============================================================================

import { buildTopbarHTML } from '../../lib/sidebar-topbar.js';
import { t, getLang } from '../../lib/i18n.js';
import { log } from './logger.js';
import { getRoot } from '../video-sidebar.js';

// === 构建 DOM 骨架 ===
export function buildSidebar() {
  const root = document.createElement('div');
  root.className = 'beaver-sidebar';
  root.id = 'beaver-sidebar';
  root.innerHTML = `
    ${buildTopbarHTML({ form: 'video' })}
    <!-- 语言设置浮层：点击🌐按钮展开，含三种语言下拉菜单 -->
    <!-- 参照 BeaverWord/web AppTopBar.vue 三种语言设计 -->
    <!-- 界面语言(UI_LANGS 10种) + 目标语言(TRANSLATE_LANGS 42种) + 释义语言(42种) -->
    <div class="beaver-lang-panel" id="beaver-lang-panel">
      <div class="beaver-lang-row">
        <label class="beaver-lang-label" data-i18n="popup.learnLang">Target Language</label>
        <select class="beaver-lang-select" id="beaver-learn-lang"></select>
      </div>
      <div class="beaver-lang-row">
        <label class="beaver-lang-label" data-i18n="popup.meaningLang">Definition Language</label>
        <select class="beaver-lang-select" id="beaver-meaning-lang"></select>
      </div>
      <div class="beaver-lang-row">
        <label class="beaver-lang-label" data-i18n="lang.ui">UI Language</label>
        <select class="beaver-lang-select" id="beaver-ui-lang"></select>
      </div>
    </div>
    <div class="beaver-tabs">
      <div class="beaver-tab active" data-tab="subtitle" data-i18n="tab.subtitle">🎬 Subtitles</div>
      <div class="beaver-tab" data-tab="words" data-i18n="tab.words">📖 Word List</div>
      <!-- learn 标签（原 mp 练习页）改 query——与文本侧栏同构（输入行+右键搜索卡片） -->
      <div class="beaver-tab" data-tab="query" data-i18n="tab.query">🔍 Query</div>
    </div>
    <!-- 标签页按钮分组：字母页(subtitle)：注释/详情/字幕样式；词汇页(words)：词表按钮 -->
    <div class="beaver-toolbar" data-tab-toolbar="subtitle">
      <button class="beaver-tool-btn active" id="beaver-annotation" data-i18n="tool.annotation">Annotation</button>
      <button class="beaver-tool-btn" id="beaver-detail" data-i18n="tool.detail">Detail</button>
      <!-- 用户要求"视频侧栏的『字幕样式』改为『视频叠加字幕』切换按钮"：
           此前为字幕样式样例卡选择器，现改为视频内叠加字幕（overlay）开/关切换按钮，
           样式选择保留在引导页（subtitleStyle 全局 key 仍有效）。 -->
      <button class="beaver-tool-btn active" id="beaver-overlay-toggle" data-i18n="tool.overlayToggle">${t('tool.overlayToggle')}</button>
      <!-- 第514次（用户"视频叠加字幕的按钮后面增加双语标签按钮，目标语言在上，
           释义语言在下。有了双语字幕，自然就不用注释了"）：叠加字幕双语子开关——
           开启后 overlay 原文在上、整句译文在下，注释管线整体旁路。
           独立 storage key overlayBilingual（默认关），渲染归 subtitle-overlay.js。 -->
      <button class="beaver-tool-btn" id="beaver-bilingual-toggle" data-i18n="tool.bilingual">${t('tool.bilingual')}</button>
    </div>
    <div class="beaver-toolbar hidden" data-tab-toolbar="words">
      <button class="beaver-tool-btn" id="beaver-export" data-i18n="tool.export">Export</button>
    </div>
    <div class="beaver-panel" id="beaver-subtitle-panel"></div>
    <div class="beaver-panel hidden" id="beaver-word-panel"></div>
    <!-- query 标签面板（原 mp 练习页移除，学习跳转并入底部 learn 按钮）——
         输入行 + 结果区（Shadow DOM 承载右键搜索卡片，复用 th/panel.js 唯一定义） -->
    <div class="beaver-panel hidden" id="beaver-query-panel">
      <div class="beaver-qrow">
        <input class="beaver-qinput" id="beaver-vs-query-input" type="text" spellcheck="false"
               placeholder="${t('ws.queryPh')}">
        <button class="beaver-qrun" id="beaver-vs-query-run" title="${t('tab.query')}">🔍</button>
      </div>
      <div class="beaver-query-result" id="beaver-vs-query-result">
        <div class="beaver-loading-tip" data-i18n="ws.queryTip">Type above and press Enter.</div>
      </div>
    </div>
    <div class="beaver-asr-progress" id="beaver-asr-progress" style="display:none;">
      <div class="beaver-asr-progress-info">
        <span class="beaver-asr-progress-stage" id="beaver-asr-progress-stage">准备中...</span>
        <span class="beaver-asr-progress-detail" id="beaver-asr-progress-detail"></span>
      </div>
      <div class="beaver-asr-progress-bar">
        <div class="beaver-asr-progress-fill" id="beaver-asr-progress-fill" style="width:0%"></div>
      </div>
    </div>
    <div class="beaver-footer">
      <div class="beaver-footer-row" id="beaver-track-row">
        <select id="beaver-track-select" class="beaver-track-select" title="Track"></select>
        <button class="beaver-asr-toggle-btn" id="beaver-asr-toggle" data-i18n="asr.realtime">🎤 ASR(Live)</button>
        <button id="beaver-copy" data-i18n="btn.copy">📋 Copy</button>
        <!-- export 改 learn（🎯 用户裁定图标）——导入视频草稿（字幕正文+生词）
             到扩展缓存并跳转网站「我的卷轴」，参照文本侧栏底部 learn 按钮同语义；
             跳转按本地/线上构建自动判定（getSiteUrl）。原导出文件功能移除 -->
        <button id="beaver-learn-btn" data-i18n="btn.learn" title="Import draft & open My Scrolls">🎯 <span data-i18n="btn.learn">Learn</span></button>
      </div>
      <div class="beaver-footer-row">
        <button class="beaver-icon-btn" id="beaver-ocr" data-i18n="btn.ocr" data-i18n-title="btn.ocrTitle" title="OCR current frame">📷</button>
        <!-- 评论按钮左侧新增对话按钮 -->
        <button id="beaver-chat" data-i18n="btn.chat">💬 Chat</button>
        <button id="beaver-comment" data-i18n="btn.comment">📝 Comment</button>
      </div>
    </div>
    <div class="beaver-settings-pop" id="beaver-settings-pop">
      <label><input type="checkbox" id="beaver-sync" checked> <span data-i18n="btn.sync">Sync display</span></label>
      <!-- 用户："⋯改为下拉，点击选项后再跳转"：⋯ 恢复下拉展开，
           引导页/诊断窗口降级为菜单项 -->
      <button class="beaver-settings-item" id="beaver-deactivate-item">⏸ <span data-i18n="ws.deactivate">Deactivate on this site</span></button>
      <button class="beaver-settings-item" id="beaver-guide-item">📖 <span data-i18n="ws.openGuide">Open guide page</span></button>
      <!-- 诊断菜单改名「诊断中心」（ws.diagCenter），打开诊断中心路由窗 -->
      <button class="beaver-settings-item" id="beaver-diag-item">🩺 <span data-i18n="ws.diagCenter">Diagnostics Hub</span></button>
      <!-- ↺ 重置位置与尺寸——拖动/调尺寸被接管（_userPlaced）后
           自动对位/同步永久停写，历史小尺寸每页复活即"很矮"；给用户一个自愈出口
           （与文本侧栏 ⋯ 菜单同名同功能，i18n 键 ws.resetLayout 已有）。 -->
      <button class="beaver-settings-item" id="beaver-reset-layout">↺ <span data-i18n="ws.resetLayout">Reset position & size</span></button>
      <button class="beaver-settings-item" id="beaver-close">✕ <span data-i18n="btn.close">Close (refresh to restore)</span></button>
    </div>
    <!-- 右下角调整大小手柄——仅浮动形态显示（CSS data-mode 控制），
         拖拽调宽高，尺寸持久化（videoSidebarSize），对标文本侧栏 Win 窗口式手柄 -->
    <div class="beaver-resize-handle" id="beaver-resize-handle"></div>
  `;
  return root;
}

/**
 * 内联 order 作为 CSS 缓存双保险
 * 用户反馈"词表标签页却反了"问题依旧：CSS order 规则已正确写入 sidebar.css
 * 并同步到 dist，但浏览器可能缓存旧版 CSS。
 * 内联 style.order 优先级高于 CSS 类规则，确保布局顺序无论 CSS 是否加载都正确。
 * 顺序：header(1) → tabs(2) → toolbar(3) → panel(4) → asr-progress(5) → footer(6)
 * track-row 合并到 footer 第一排，footer order 从 7 改为 6。
 */
export function applyInlineOrder(root) {
  const orderMap = [
    ['.beaver-header', 1],
    ['.beaver-tabs', 2],
    ['.beaver-toolbar', 3],
    ['.beaver-asr-progress', 5],
    ['.beaver-footer', 6]
  ];
  for (const [selector, order] of orderMap) {
    const el = root.querySelector(selector);
    if (el) el.style.order = String(order);
  }
  // 所有面板（字幕/生词/练习）统一 order=4
  root.querySelectorAll('.beaver-panel').forEach((p) => { p.style.order = '4'; });
}

// === 关闭所有浮层（菜单失焦退回）===
// 用户要求"展开的菜单若有别处点击，表示失去焦点，应当退回去"。
//   旧问题：三个浮层（设定/语言/字幕样式）各自注册 document click 关闭，
//   但按钮 click 调 stopPropagation 阻止冒泡，导致点一个按钮时其他已展开的浮层无法关闭。
//   修正：统一 closeAllPopups() 关闭全部浮层，每个按钮点击前先关其他浮层再 toggle 自身。
// 字幕样式选择已移到引导页，浮层只剩设定/语言两个。
export function closeAllPopups() {
  const _root = getRoot();
  if (!_root) return;
  _root.querySelector('#beaver-settings-pop')?.classList.remove('show');
  const langPanel = _root.querySelector('#beaver-lang-panel');
  const langBtn = _root.querySelector('#beaver-lang-btn');
  if (langPanel) langPanel.classList.remove('show');
  if (langBtn) langBtn.classList.remove('active');
}

// === 应用 i18n 到视频提示所有 [data-i18n] 元素 ===
export function applyI18n() {
  const _root = getRoot();
  if (!_root) return;
  const lang = getLang();
  _root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    // innerHTML 支持 <br> 等
    el.innerHTML = t(key);
  });
  _root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    el.title = t(key);
  });
  // UI 语言下拉菜单：同步当前选中项（select 同步 value）
  // 下拉菜单的 option 文本已是各语言本地化名称，无需 i18n 替换
  //   只需同步 select.value 为当前 getLang()，避免显示与实际不符
  const uiLangSelect = _root.querySelector('#beaver-ui-lang');
  if (uiLangSelect) uiLangSelect.value = getLang();
  // loading 提示文字（如有 spin + 文字结构则更新文字）
  const loadEl = _root.querySelector('.beaver-loading');
  if (loadEl && loadEl.dataset.loadingKey) {
    const spin = loadEl.querySelector('.beaver-loading-spin');
    loadEl.innerHTML = '';
    if (spin) loadEl.appendChild(spin);
    const span = document.createElement('span');
    span.textContent = t(loadEl.dataset.loadingKey);
    loadEl.appendChild(span);
  }
  log('i18n applied, lang=', lang);
}
