// VocabRadar 全站网页侧栏 —— 界面交互模块（ui）
// 职责：侧栏 DOM 构建与 CSS 注入、事件与语言面板绑定、展开/收起、拖拽/缩放及位置尺寸持久化、
//       标签切换、朗读/复制/详略/词单等交互、弹层关闭与覆盖层样式、重注入观察器、
//       悬浮球与视频侧栏的存在性同步。
// 说明：由 web-sidebar-impl.js 机械拆分而来，代码逐字保留，未改动任何逻辑。
//       跨模块共享状态一律来自 ./core.js，写入走 core 导出的 set_xxx 接缝，绝不另存副本。

import { LANG_NAMES, LANG_NAMES_EN, TRANSLATE_LANGS, UI_LANGS, setLang, t } from '../../lib/i18n.js';
// 第二百四十三次：expand 是侧栏扫描回填翻译（ws/scanner.js schedulePendingTranslate）的手势源头，
//   展开点击（click 手势）同步链上 prime 内置翻译，扫描回填的 translate 即可复用实例。
import { primeTranslator } from '../../lib/translator.js';
// 272次：顶行构建器同源的品牌小图标（搜索栏左端）
import { brandIconSVG, buildTopbarHTML, ensureTopbarCss } from '../../lib/sidebar-topbar.js';
import { SUBTITLE_TEXT_STYLES, findStyle } from '../../lib/styles.js';
// 272次：query 标签复用右键搜索卡片（唯一定义 th/panel.js：同 CSS/同结构/同渲染核心；
// ES module 按 URL 单实例，与 text-hint bundle 共享同一 thState/模块状态）
import { buildPanelCss, buildCardInnerHTML, renderQueryCard, bindLemmaChipClick } from '../th/panel.js';
// 272次：Query 可用性 = 全局开关 queryEnabled + 停用规则「搜索栏」项（与网页提示解耦）
import { suppressionFor } from '../../lib/deactivate.js';
import { reviveSidebarIfPossible, startVideoController } from '../video-controller.js';
import { _activeTab, _allAnnotations, _cachedLearnLang, _detailMode, _pageSentences, _panelRect, _preExpandPos, _root, _wordOnlyMode, clampPosToViewport, clampRectToViewport, formatTime, getInjectionRoot, log, saveState, set_activeTab, set_detailMode, set_noAnnotation, set_panelRect, set_preExpandPos, set_wordOnlyMode, toast, ts } from './core.js';
import { rerenderAllSlots, schedulePageScan, toggleLemmaGroup } from './scanner.js';
// 第一百七十一次：文本侧栏底部对话按钮 —— 对话面板唯一实现在 lib/chat.js
import { openChatPanel } from '../../lib/chat.js';
// 第一百八十五次：给 AI 的正文提取（Readability 优先）与耗时诊断，唯一实现在 lib/main-text.js
import { getAiMainText, openMainTextDiag } from '../../lib/main-text.js';
// G3（2026-09-08）：learn 面板草稿导入（§6.2）——组装+落缓存唯一实现在 ./draft-export.js
import { importCurrentSidebarDraft, getSiteUrl } from './draft-export.js';
// 第二百七十次：⋯ 菜单「停用本站」——写当前域「网页提示」停用规则（272 次默认由
//   四项全停改单停提示；匹配/存储唯一实现 lib/deactivate.js）
import { upsertDeactivateRule } from '../../lib/deactivate.js';

// === 构建 DOM 骨架 ===
export function buildSidebar() {
  const root = document.createElement('div');
  root.className = 'beaver-web-sidebar collapsed';
  root.id = 'beaver-web-sidebar';
  root.innerHTML = `
    <!-- 折叠球：悬浮球，扩展图标，点击展开 -->
    <!-- 反思（2026-08-12 第四十六次）：img 元素在多浏览器中有原生拖拽行为，
         导致 mousedown 被拦截、悬浮球拖不动。改用 div+CSS背景图彻底消除原生拖拽。 -->
    <!-- 第一百七十一次（用户裁定"悬浮球不补充圆边，而是裁剪原图"）：
         图标由「32px 居中 + 绿色圆底留白」改为铺满 48px 圆（background-size:cover），
         溢出部分由 border-radius:50% + overflow:hidden 裁掉，不再出现绿色圆环。 -->
    <!-- 272次：悬浮球改为搜索栏；275次（用户"移除三角，颜色用淡主题色"）——
         只剩左品牌图标（点击展开侧栏/右键召唤视频侧栏）+ 短搜索框（聚焦变长，
         Enter=输入完成→query 标签）；条底色用淡主题色；276次曾裁定"折叠态不显示
         占位符"，278次用户改口径：折叠搜索栏输入前也显示占位符 query word for
         translations...（ws.queryPh，en/zh 同文）；Query 关闭时只剩图标 -->
    <div class="beaver-web-collapse-tab" id="beaver-web-collapse-tab">
      <span class="beaver-qbar-icon" id="beaver-qbar-icon" title="${t('ws.expand')}">${brandIconSVG()}</span>
      <input class="beaver-qbar-input" id="beaver-qbar-input" type="text" spellcheck="false" placeholder="${t('ws.queryPh')}">
    </div>
    <!-- 展开面板 -->
    <div class="beaver-web-panel" id="beaver-web-panel">
      <!-- 第一百二十四次：顶行统一构建器（src/lib/sidebar-topbar.js 唯一来源）——
           视频/文本两形态同结构同顺序；ids 映射保留既有事件绑定；✕ 仅文本侧栏 -->
      ${buildTopbarHTML({ form: 'text', showClose: true, ids: {
        form: 'beaver-web-video-btn',
        lang: 'beaver-web-lang-btn',
        settings: 'beaver-web-settings-btn',
        collapse: 'beaver-web-collapse-btn',
        close: 'beaver-web-close-btn'
      }, titles: { form: t('ws.videoSidebar'), settings: t('ws.settings'), collapse: t('ws.collapse'), close: t('ws.close') } })}
      <!-- 语言设置浮层 -->
      <!-- 反思（2026-08-09）：用户要求"侧栏语言设定包括界面，界面有十大语言"。 -->
      <!--   新增界面语言下拉框（UI_LANGS 10种），切换后实时刷新侧栏界面文案。 -->
      <div class="beaver-web-lang-panel" id="beaver-web-lang-panel">
        <div class="beaver-web-lang-row">
          <label class="beaver-web-lang-label">${t('lang.ui')}</label>
          <select class="beaver-web-lang-select" id="beaver-web-ui-lang"></select>
        </div>
        <div class="beaver-web-lang-row">
          <label class="beaver-web-lang-label">${t('ws.learnLang')}</label>
          <select class="beaver-web-lang-select" id="beaver-web-learn-lang"></select>
        </div>
        <div class="beaver-web-lang-row">
          <label class="beaver-web-lang-label">${t('ws.meaningLang')}</label>
          <select class="beaver-web-lang-select" id="beaver-web-meaning-lang"></select>
        </div>
      </div>
      <!-- 第一百二十三次：⋯ 设定浮层（与视频侧栏顶行对齐） -->
      <!-- 第二百零四次（用户："⋯改为下拉，点击选项后再跳转"；"原来诊断窗口入口按钮移除"）：
           171 次的"点 ⋯ 直接跳引导页"撤销——⋯ 恢复下拉展开，菜单项＝引导页/诊断窗口/重置/关闭；
           工具栏的 ⏱ 诊断入口按钮移除，其功能并入本菜单（openMainTextDiag 绑定随之迁来）。 -->
      <div class="beaver-web-lang-panel beaver-web-settings-pop" id="beaver-web-settings-pop">
        <!-- 第二百七十次：⋯ 菜单「停用本站」——写当前域全停规则并跳引导页停用栏微调 -->
        <button class="beaver-web-settings-item" id="beaver-web-deactivate-item">⏸ ${t('ws.deactivate')}</button>
        <button class="beaver-web-settings-item" id="beaver-web-guide-item">📖 ${t('ws.openGuide')}</button>
        <button class="beaver-web-settings-item" id="beaver-web-diag-item">⏱ ${t('ws.mainTextDiag')}</button>
        <button class="beaver-web-settings-item" id="beaver-web-reset">↺ ${t('ws.resetLayout')}</button>
        <button class="beaver-web-settings-item" id="beaver-web-close-item">✕ ${t('ws.close')}</button>
      </div>
      <div class="beaver-web-tabs">
        <div class="beaver-web-tab active" data-tab="sentences">${t('ws.tabSentences')}</div>
        <div class="beaver-web-tab" data-tab="words">${t('ws.tabWords')}</div>
        <!-- 272次：learn 标签改为 query——页面如同右键搜索（卡片复用 th/panel.js 唯一实现）；
             原练习页（草稿导入按钮行+小程序码）整体移除，功能并入底部 learn 按钮 -->
        <div class="beaver-web-tab" data-tab="query">${t('tab.query')}</div>
      </div>
      <!-- 句标签工具栏：第二百三十九次加回注释总开关（用户："在detail之前 也加Annotation标签按钮"）——
           active=网页提示（text-hint 高亮/侧邻注释）+ 侧栏句子注释标记；
           取消=撤掉网页提示（stopForPage，本页会话停用）+ 句子面板渲染 defuddle 提取的纯正文（_noAnnotation=true）。
           初始 active 态由 textHintEnabled 校正（见绑定区 storage.get）。 -->
      <div class="beaver-web-toolbar" data-tab-toolbar="sentences">
        <button class="beaver-web-tool-btn active" id="beaver-web-annotation" title="${t('ws.annotation')}">${t('ws.annotation')}</button>
        <button class="beaver-web-tool-btn" id="beaver-web-detail" title="${t('ws.detail')}">${t('ws.detail')}</button>
      </div>
      <!-- 词汇标签工具栏：词表按钮 -->
      <div class="beaver-web-toolbar hidden" data-tab-toolbar="words">
        <button class="beaver-web-tool-btn" id="beaver-web-export" title="${t('ws.wordList')}">${t('ws.wordList')}</button>
      </div>
      <!-- 句标签面板：页面文本句子 -->
      <div class="beaver-web-tab-panel" data-tab="sentences" id="beaver-web-tab-sentences">
        <div class="beaver-web-panel-scroll" id="beaver-web-sentence-panel">
          <div class="beaver-web-empty-tip">${t('ws.scanning')}</div>
        </div>
      </div>
      <!-- 词汇标签面板：生词表 -->
      <div class="beaver-web-tab-panel hidden" data-tab="words" id="beaver-web-tab-words">
        <div class="beaver-web-panel-scroll" id="beaver-web-word-panel">
          <div class="beaver-web-empty-tip">${t('ws.noWords')}</div>
        </div>
      </div>
      <!-- 272次：query 标签面板——输入行 + 结果卡（Shadow DOM 承载右键搜索卡片，样式不漏宿主页）；
           275次：搜索框 Enter 与右键菜单（无选中）落到这里。276次：占位符 query... 只在
           展开后的本输入框显示（折叠搜索条不显示）；🔍 查询按钮按裁定不加背景色 -->
      <div class="beaver-web-tab-panel hidden" data-tab="query" id="beaver-web-tab-query">
        <div class="beaver-web-qrow">
          <input class="beaver-web-qinput" id="beaver-web-query-input" type="text" spellcheck="false"
                 placeholder="${t('ws.queryPh')}">
          <button class="beaver-web-qrun" id="beaver-web-query-run" title="${t('tab.query')}">🔍</button>
        </div>
        <div class="beaver-web-panel-scroll" id="beaver-web-query-result">
          <div class="beaver-web-empty-tip">${t('ws.queryTip')}</div>
        </div>
      </div>
      <!-- 底部工具栏：复制按钮
           反思（2026-08-16 第六十八次）："注释按钮移走"——原句子工具栏的注释开关
           与详情按钮并排，用户要求移走，曾移至底部工具栏挨着复制。
           反思（2026-08-16 第六十九次）：用户再次要求"注释按钮移走"→ 彻底移除注释
           开关按钮（含 HTML/绑定/onAnnotationClick），注释常显（_noAnnotation 恒为 false）。
           第二百三十九次：用户要求加回——注释开关恢复到句标签工具栏（detail 之前，
           与视频侧栏 Annotation 按钮同语义），并联动 text-hint 网页提示启停。 -->
      <div class="beaver-web-footer">
        <button class="beaver-web-action-btn" id="beaver-web-copy" title="${t('ws.copy')}">📋 ${t('ws.copy')}</button>
        <!-- 272次：export 改 learn——导入卷轴草稿并跳转网站「我的卷轴」（原 learn 标签
             「Import and Open」行为）；274次：图标 📱→🎯（用户裁定），跳转按本地/线上
             构建自动判定（getSiteUrl）；原导出文件功能移除 -->
        <button class="beaver-web-action-btn" id="beaver-web-learn-btn" title="${t('btn.learn')}">🎯 ${t('btn.learn')}</button>
        <button class="beaver-web-action-btn" id="beaver-web-chat" title="${t('btn.chat')}">💬</button>
        <!-- 第二百零四次（用户："原来诊断窗口入口按钮移除"）：⏱ 诊断入口按钮移除，
             功能并入 ⋯ 下拉菜单（#beaver-web-diag-item） -->
      </div>
      <!-- 可调尺寸手柄（右下角，Win 窗口风格） -->
      <div class="beaver-web-resize-handle" id="beaver-web-resize-handle"></div>
      <!-- 第一百三十四次：三向命中热区——右缘(ew)/下缘(ns)整条，角手柄(nwse)加大到20px -->
      <div class="beaver-web-resize-edge-r" id="beaver-web-resize-edge-r"></div>
      <div class="beaver-web-resize-edge-b" id="beaver-web-resize-edge-b"></div>
    </div>
  `;
  return root;
}

// === 绑定事件 ===
// 第一百七十一次（用户反馈"文本侧栏不要双击就消失"）：
//   根因——展开态面板锚点与悬浮球完全重合（同为 right:16px/top:20px），双击悬浮球时
//   第一击展开面板，第二击正好落在顶行右上角的 ◀/✕ 按钮上（球心与按钮几何重叠），
//   侧栏立刻被折叠/关闭 = "双击就消失"。本文件从未绑定 dblclick，纯属误触。
//   对策：展开后设 400ms 保护窗，期间忽略顶行折叠/关闭动作（含 ⋯ 内关闭项）。
const EXPAND_GUARD_MS = 400;
let _expandGuardUntil = 0;
/** 展开保护窗内？（用于抑制双击第二击误触折叠/关闭） */
function inExpandGuard() {
  return Date.now() < _expandGuardUntil;
}
/** 由 expand() 调用，开启保护窗 */
function markExpandGuard() {
  _expandGuardUntil = Date.now() + EXPAND_GUARD_MS;
}

export function bindEvents() {
  // 272次：搜索栏两件套（275次移除三角）——
  //   左图标点击=展开侧栏（沿用原悬浮球点击，含拖拽误触保护）；
  //   输入框 Enter=输入完成→展开到 query 标签并查询（query 标签内另有 🔍 按钮）。
  _root.querySelector('#beaver-qbar-icon').addEventListener('click', (e) => {
    e.stopPropagation();
    // 拖动后不触发展开
    if (_dragMoved) { _dragMoved = false; return; }
    expand();
  });

  // 输入完成（Enter）→ query 标签
  const qbarInput = _root.querySelector('#beaver-qbar-input');
  qbarInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    expandToQuery(String(qbarInput.value || '').trim());
  });

  // 图标右键 → 召唤视频侧栏（2026-08-20 第八十六次补充③；272次收窄到图标本体，
  //   输入框右键保留浏览器原生文本菜单）
  // 反思：右键菜单（contextmenu）在拖拽场景下也应保留；不拦截整个文档
  //   （文档级 contextmenu 由 text-hint.js capture 阶段记录坐标，互不影响）。
  _root.querySelector('#beaver-qbar-icon').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    summonVideoSidebar();
  });

  // 顶行 🎬 按钮 → 切换到视频形态（第一百二十二次：统称"侧栏"，双向切换）
  // 已有视频侧栏时派发 beaver-unified-open 让其展开；否则召唤 generic 视频侧栏；
  // 自身收起为悬浮球——一次只呈现一种形态。
  // 第一百三十六次（用户反馈"点击视频侧栏按钮，没有提示就变为悬浮球了"）：
  //   收起改为**条件执行**——仅当视频侧栏确实在场/成功召唤时才收起为球。
  //   召唤失败（页面无 video：toast 提示后保持展开）不再收起，恢复"提示无视频，
  //   本身不动"的历史行为；YouTube/B站正片页经 reviveSidebarIfPossible 复活成功后才收起。
  _root.querySelector('#beaver-web-video-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const vsb = document.querySelector('#beaver-sidebar');
    if (vsb && document.contains(vsb)) {
      window.dispatchEvent(new CustomEvent('beaver-unified-open', { detail: { form: 'video' } }));
      collapse();
      return;
    }
    if (!document.querySelector('video')) {
      // 无视频：toast 提示且保持展开（不收起为球）
      console.log('[VocabRadar][web-sidebar] 🎬: 页面无 video 元素，保持文本侧栏展开', location.href);
      toast(t('ws.noVideoOnPage'), { error: true });
      return;
    }
    const host = location.hostname;
    const isYt = /(^|\.)youtube\.com$/i.test(host);
    const isBili = /(^|\.)bilibili\.com$/i.test(host);
    if (isYt || isBili) {
      reviveSidebarIfPossible(isYt ? 'youtube' : 'bilibili');
      // 复活路径：侧栏在 DOM 会立即恢复显示，可安全收起；缺席则强制重启中
      // （重启完成前先收起为球，避免双形态同屏）
      collapse();
      return;
    }
    summonVideoSidebar();
    collapse();
  });

  // 收起/关闭按钮
  // 第一百七十一次：保护窗内（刚展开 400ms）忽略——防双击悬浮球第二击误触
  _root.querySelector('#beaver-web-collapse-btn').addEventListener('click', () => {
    if (inExpandGuard()) { log('展开保护窗内忽略折叠点击（疑双击误触）'); return; }
    collapse();
  });
  _root.querySelector('#beaver-web-close-btn').addEventListener('click', () => {
    if (inExpandGuard()) { log('展开保护窗内忽略关闭点击（疑双击误触）'); return; }
    close();
  });

  // 第一百二十三次：⋯ 设定浮层（重置位置与尺寸 / 关闭）
  // 第二百零四次（用户："⋯改为下拉，点击选项后再跳转而不是点击...就跳转"）：
  //   171 次的"点 ⋯ 直接跳引导页"撤销——⋯ 恢复下拉展开（先关其他浮层再 toggle 自身），
  //   引导页/诊断窗口降级为菜单项，点击选项才执行。
  const setBtn = _root.querySelector('#beaver-web-settings-btn');
  const setPop = _root.querySelector('#beaver-web-settings-pop');
  setBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !setPop.classList.contains('show');
    closeAllPopups();
    if (opening) {
      setPop.classList.add('show');
      setBtn.classList.add('active');
    }
  });
  // 菜单项：打开引导页（原 ⋯ 直跳行为降级至此）
  _root.querySelector('#beaver-web-guide-item').addEventListener('click', () => {
    closeAllPopups();
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_GUIDE' });
      log('⋯菜单 → 打开引导页');
    } catch (err) {
      log('⋯菜单 打开引导页失败：' + String(err && err.message || err));
    }
  });
  // 菜单项：停用本站（第二百七十次；第二百七十二次默认改单停「网页提示」——用户裁定
  //   "设定抑制默认是抑制网页提示，不是所有"）：写当前域 hint 停用规则，规则写入即经
  //   storage.onChanged 撤本页高亮/侧注；文本侧栏自身与其余三项不受影响，随后跳引导页
  //   停用栏（地址=当前域名）供改通配范围与勾选四大选项。
  _root.querySelector('#beaver-web-deactivate-item').addEventListener('click', async () => {
    closeAllPopups();
    const pat = location.hostname;
    try {
      await upsertDeactivateRule(pat, { hint: true });
      log('⋯菜单 → 停用本站网页提示（' + pat + '）规则已写入');
    } catch (err) {
      log('⋯菜单 写停用规则失败：' + String((err && err.message) || err));
    }
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_GUIDE', section: 'deactivate', pattern: pat });
      log('⋯菜单 → 打开引导页停用栏（' + pat + '）');
    } catch (err) {
      log('⋯菜单 打开引导页失败：' + String((err && err.message) || err));
    }
  });
  // 菜单项：正文提取诊断窗（原工具栏 ⏱ 按钮的功能，入口按钮已移除）
  _root.querySelector('#beaver-web-diag-item').addEventListener('click', () => {
    closeAllPopups();
    openMainTextDiag().catch((e) => {
      // 不遮蔽错误：诊断窗自身挂了也要出声
      toast('诊断打开失败：' + String((e && e.message) || e), { error: true });
    });
  });
  setPop.addEventListener('click', (e) => e.stopPropagation());
  _root.querySelector('#beaver-web-reset').addEventListener('click', () => {
    resetLayout();
    closeAllPopups();
  });
  _root.querySelector('#beaver-web-close-item').addEventListener('click', () => {
    closeAllPopups();
    close();
  });

  // 反思（2026-08-08）：用户要求"悬浮球、侧栏都应当可拖动"。
  //   悬浮球（折叠态）和标题栏（展开态）均可拖动，拖动时切换为自由定位（脱离右侧/顶部固定）。
  makeDraggable();
makeResizable();

  // 272次：搜索栏可用性（Query 开关/停用规则）初始化 + 实时刷新 + 右键菜单跳转监听
  ensureQueryAvailabilityWatcher();
  applyQueryAvailability();

  // 标签页切换
  _root.querySelectorAll('.beaver-web-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // 工具栏（第二百三十九次：加回注释总开关，与详情/词表按钮并列）
  _root.querySelector('#beaver-web-annotation').addEventListener('click', onAnnotationClick);
  _root.querySelector('#beaver-web-detail').addEventListener('click', onDetailClick);
  _root.querySelector('#beaver-web-export').addEventListener('click', onWordListToggle);

  // 272次：query 标签——查询按钮（输入行内），Enter 在输入框 keydown 里另行处理
  _root.querySelector('#beaver-web-query-run').addEventListener('click', () => {
    const input = _root.querySelector('#beaver-web-query-input');
    runSidebarQuery(input ? String(input.value || '').trim() : '');
  });
  const _qTabInput = _root.querySelector('#beaver-web-query-input');
  if (_qTabInput) _qTabInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    runSidebarQuery(String(_qTabInput.value || '').trim());
  });

  // 第二百三十九次：Annotation 按钮初始态对齐 text-hint 全局开关（与 scanner.js 口径
  //   一致：仅显式 false 才算关）。全局关提示的用户按钮置 inactive 且侧栏走纯正文，
  //   保证"按钮态=实际行为"；读回后重绘一次覆盖首帧（HTML 模板默认 active）。
  try {
    chrome.storage.local.get({ textHintEnabled: true }, (res) => {
      const on = res.textHintEnabled !== false;
      const btn = _root.querySelector('#beaver-web-annotation');
      if (btn) btn.classList.toggle('active', on);
      set_noAnnotation(!on);
      rerenderAllSlots();
    });
  } catch (e) { /* ignore */ }

  // 反思（2026-08-14 第五十八次）：移除 web-sidebar 字幕样式按钮（原 bindSubtitleStylePanel）。
  //   字幕样式选择集中在引导页，启动时恢复已保存的 overlay 字幕样式 class 保留。

  // 反思（2026-08-13 第五十次）：启动时恢复已保存的 overlay 字幕样式 class
  try {
    chrome.storage.local.get({ subtitleStyle: 'none' }, (res) => {
      const saved = res.subtitleStyle || 'none';
      applyOverlayStyleClass(saved);
    });
  } catch (e) { /* ignore */ }

  // 语言面板
  bindLanguagePanel();

  // 复制按钮：复制当前标签页的全部句子文本
  _root.querySelector('#beaver-web-copy').addEventListener('click', onCopyClick);
  // 272次：底部 learn 按钮——导入卷轴草稿并跳转网站「我的卷轴」（原 learn 标签
  //   「Import and Open」行为 + 📱 手机图标）；原导出文件按钮移除
  _root.querySelector('#beaver-web-learn-btn').addEventListener('click', onDraftImportAndOpenClick);
  _root.querySelector('#beaver-web-chat').addEventListener('click', onChatClick);
  // G3（2026-09-08）：learn 面板按钮行已随 learn 标签整体移除（272次并入底部 learn 按钮）
  // 第二百零四次：⏱ 正文提取耗时诊断按钮移除——入口并入 ⋯ 下拉菜单
  //   （#beaver-web-diag-item，openMainTextDiag 绑定迁至该处）

  // 反思（2026-08-08）：喇叭按钮朗读（Web Speech API）。
  //   事件委托：所有 .beaver-w-speak 和 .beaver-web-ann-speak 按钮统一处理。
  // 反思（2026-09-04）：生词表原形折叠按钮（.beaver-w-lemma-toggle）同委托处理，
  //   归组查询在展开瞬间发生（toggleLemmaGroup 内部读 _allAnnotations 现场值）。
  _root.addEventListener('click', (e) => {
    const tgl = e.target.closest('.beaver-w-lemma-toggle');
    if (tgl) {
      e.stopPropagation();
      e.preventDefault();
      const item = tgl.closest('.beaver-web-word-item');
      if (item) toggleLemmaGroup(item);
      return;
    }
    const btn = e.target.closest('.beaver-w-speak, .beaver-web-ann-speak');
    if (btn) {
      e.stopPropagation();
      e.preventDefault();
      const word = btn.dataset.word;
      if (word) speakWord(word);
    }
  });
}

// === 语言面板（复用 sidebar.js 模式）===
// 反思（2026-08-09）：用户要求"侧栏语言设定包括界面，界面有十大语言"。
//   新增界面语言下拉框（UI_LANGS 10种），切换后调用 setLang() 实时刷新界面文案。
function bindLanguagePanel() {
  const langBtn = _root.querySelector('#beaver-web-lang-btn');
  const langPanel = _root.querySelector('#beaver-web-lang-panel');
  const uiLangSel = _root.querySelector('#beaver-web-ui-lang');
  const srcLangSel = _root.querySelector('#beaver-web-learn-lang');
  const tgtLangSel = _root.querySelector('#beaver-web-meaning-lang');

  // 填充界面语言选项（10大语言）
  for (const lang of UI_LANGS) {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = LANG_NAMES[lang] || lang;
    uiLangSel.appendChild(opt);
  }

  // 填充目标/释义语言选项（42种）
  // 第二百二十八次（用户："释义语言统一英文名称"）：释义下拉用英文名，学习下拉仍本地化名
  for (const lang of TRANSLATE_LANGS) {
    const opt1 = document.createElement('option');
    opt1.value = lang;
    opt1.textContent = LANG_NAMES[lang] || lang;
    srcLangSel.appendChild(opt1);

    const opt2 = document.createElement('option');
    opt2.value = lang;
    opt2.textContent = LANG_NAMES_EN[lang] || lang;
    tgtLangSel.appendChild(opt2);
  }

  // 从 storage 读取当前语言设置
  chrome.storage.local.get({ learnLanguage: 'en', meaningLanguage: 'zh', uiLanguage: 'en' }, (res) => {
    uiLangSel.value = res.uiLanguage || 'en';
    srcLangSel.value = res.learnLanguage || 'en';
    tgtLangSel.value = res.meaningLanguage || 'zh';
  });

  // 🌐 按钮展开/收起
  langBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willShow = !langPanel.classList.contains('show');
    closeAllPopups();
    langPanel.classList.toggle('show', willShow);
    langBtn.classList.toggle('active', willShow);
  });
  langPanel.addEventListener('click', (e) => e.stopPropagation());
  // 统一注册：点击任意非浮层区域关闭所有浮层（菜单失焦退回）
  document.addEventListener('click', closeAllPopups);

  // 界面语言切换：调用 setLang 后刷新整个侧栏界面
  uiLangSel.addEventListener('change', (e) => {
    e.stopPropagation();
    setLang(e.target.value);
    log('界面语言切换:', e.target.value);
    // 刷新页面以应用新界面语言（最可靠的方式）
    setTimeout(() => location.reload(), 200);
  });

  // 目标语言切换
  srcLangSel.addEventListener('change', (e) => {
    e.stopPropagation();
    chrome.storage.local.set({ learnLanguage: e.target.value });
    log('目标语言切换:', e.target.value);
  });

  // 释义语言切换
  tgtLangSel.addEventListener('change', (e) => {
    e.stopPropagation();
    chrome.storage.local.set({ meaningLanguage: e.target.value });
    log('释义语言切换:', e.target.value);
  });
}

// === 注入关键 CSS（同步，确保搜索栏立即可见）===
// 反思（2026-08-07）：用户反馈"悬浮球依旧没有"。
//   <link> 异步加载 CSS，加载前悬浮球无样式不可见。
//   修正：用 <style> 同步注入 collapsed 态关键样式，不依赖 <link>。
// 272次：折叠态由 48px 圆球改为搜索栏；274次（用户"搜索栏太张扬，本来就是为了
//   轻量加的"）降噪——去绿底改中性半透明白、默认宽度收到 icon+一单词输入框+三角
//   （约 150px，:focus-within 展到 300px）、三角去底色；.query-off（Query 关）48px 圆。
// 282次（用户"你现在错得离谱，重新画"）：根因终于查清——本层与 web-sidebar.css
//   的 .collapsed 规则特异性同为 (1,1,0) 且都带 !important，异步 <link> 后加载
//   胜出，本层非激活视觉（透明底+半透明边框）一直被 web-sidebar.css 的淡绿实底
//   覆盖，此前四轮改动全部白做。修正：视觉全部收敛到本层独占（同步注入必胜）——
//   非激活=104px 透明底+半透明边框 rgba(28,77,50,0.30)+无阴影+占位符隐藏；
//   激活（:focus-within）=延长 300px+白底+边框近不透明 rgba(28,77,50,0.9)+
//   占位符显现；输入框自身样式也钉进本层（透明底/无边框/无描边），
//   web-sidebar.css 删除全部 .collapsed 与 .beaver-qbar-input 冲突块。
// 283次（用户"改为半透明，无绿边，中间输入框透明；查询栏跟文本侧栏转换尽量位置
//   不动，左上角算位置"）：三处修正——
//   1. 半透明底（用户澄清"主题色，马卡龙绿，浅色，半透明"）：折叠 rgba(198,233,208,0.50)、
//      激活 rgba(198,233,208,0.90)，输入框保持透明（绿底透出即输入区）；
//   2. 无绿边：border 全部去除（282 的半透明绿边即用户所说"绿边"）；
//   3. 左上角锚定：展开侧栏左缘 = 100vw − 16 − min(380, 100vw−24)
//      = min(calc(100vw − 396px), 8px)（web-sidebar.css .expanded 右 16px 反推），
//      折叠条 left 锚定同值（宽视口=100vw−396px；窄视口≤404px 收边 8px），
//      折叠↔展开切换时左上角坐标不动；折叠条向右生长（left 定位 + width 过渡）。
export function injectCriticalCSS() {
  if (document.getElementById('beaver-web-critical-css')) return;
  const style = document.createElement('style');
  style.id = 'beaver-web-critical-css';
style.textContent = `
#beaver-web-sidebar{position:fixed !important;z-index:2147483646 !important;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif !important;font-size:16px !important;box-sizing:border-box !important;margin:0 !important;padding:0 !important;border:none !important;}
#beaver-web-sidebar.collapsed{width:104px !important;height:40px !important;left:min(calc(100vw - 396px), 8px) !important;top:20px !important;right:auto !important;bottom:auto !important;border-radius:20px !important;background:rgba(198,233,208,0.50) !important;border:none !important;box-shadow:none !important;cursor:default !important;overflow:hidden !important;display:flex !important;align-items:center !important;transition:width .18s ease,background .18s ease,box-shadow .18s ease !important;}
#beaver-web-sidebar.collapsed:focus-within{width:300px !important;background:rgba(198,233,208,0.90) !important;border:none !important;box-shadow:0 1px 4px rgba(28,77,50,0.18) !important;}
#beaver-web-sidebar.collapsed .beaver-qbar-input{flex:1 1 auto !important;min-width:0 !important;height:28px !important;background:transparent !important;border:none !important;outline:none !important;border-radius:14px !important;padding:0 8px !important;font-size:13px !important;color:var(--beaver-text,#1a1f1a) !important;user-select:text !important;-webkit-user-select:text !important;}
#beaver-web-sidebar.collapsed .beaver-qbar-input::placeholder{color:transparent !important;transition:color .15s ease !important;}
#beaver-web-sidebar.collapsed:focus-within .beaver-qbar-input::placeholder{color:#5f7a6b !important;}
#beaver-web-sidebar.collapsed .beaver-web-panel{display:none !important;}
#beaver-web-sidebar.collapsed .beaver-web-collapse-tab{display:flex !important;width:100% !important;height:100% !important;align-items:center !important;gap:4px !important;padding:0 5px !important;}
#beaver-web-sidebar.collapsed.query-off{width:48px !important;height:48px !important;border-radius:50% !important;cursor:pointer !important;}
#beaver-web-sidebar.collapsed.query-off .beaver-qbar-input{display:none !important;}
#beaver-web-sidebar.collapsed.query-off .beaver-web-collapse-tab{justify-content:center !important;}
`;
  // 反思（2026-08-12 第四十四次）：head 可能不存在（frameset 等特殊页面），
  //   回退到 document.documentElement
  (document.head || document.documentElement).appendChild(style);
}

// === 注入完整 CSS（异步 <link>）===
export function injectCSS() {
  const links = document.querySelectorAll('link[rel="stylesheet"]');
  let hasSidebar = false, hasWebSidebar = false;
  links.forEach((l) => {
    if (l.href.endsWith('/sidebar.css')) hasSidebar = true;
    if (l.href.endsWith('/web-sidebar.css')) hasWebSidebar = true;
  });
  if (!hasSidebar) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('src/content/sidebar.css');
    (document.head || document.documentElement).appendChild(link);
  }
  if (!hasWebSidebar) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('src/content/web-sidebar.css');
    (document.head || document.documentElement).appendChild(link);
  }
}

// 召唤视频侧栏（2026-08-20 第八十六次补充③）
// 仅 bilibili/youtube 自动出现视频侧栏；其他站点视频侧栏不自动出现（generic.js
// hasMeaningfulVideo 检测不通过或未启动），用户可经悬浮球右键 / 顶行 🎬 按钮手动召唤。
function summonVideoSidebar() {
  // 第一百三十二次：页面已有视频侧栏（含被 ✕ 关闭或 📄 切走的）——直接派发复活事件
  // （video-sidebar wireUnifiedFormEvents 负责清 userClosed/恢复显示/展开）。
  // 旧逻辑依赖 startVideoController 幂等 no-op，✕ 关闭后点球右键会毫无反应。
  const vsb = document.querySelector('#beaver-sidebar');
  if (vsb && document.contains(vsb)) {
    window.dispatchEvent(new CustomEvent('beaver-unified-open', { detail: { form: 'video' } }));
    return;
  }
  if (!document.querySelector('video')) {
    console.log('[VocabRadar][web-sidebar] 召唤视频侧栏: 页面无 video 元素', location.href);
    toast(t('ws.noVideoOnPage'), { error: true });
    return;
  }
  console.log('[VocabRadar][web-sidebar] 召唤视频侧栏, platform=generic', location.href);
  // 第一百三十六次：分平台复活——YouTube/B站正片页侧栏缺席时，旧逻辑走
  //   startVideoController('generic')，被 _started 守卫吞掉（无任何反馈即死路）；
  //   改走 reviveSidebarIfPossible：在 DOM 则恢复、缺席则强制重启控制器。
  //   generic 站点维持原路径（控制器未启动，startVideoController 正常生效）。
  const host = location.hostname;
  if (/(^|\.)youtube\.com$/i.test(host) || /(^|\.)bilibili\.com$/i.test(host)) {
    reviveSidebarIfPossible(/(^|\.)youtube\.com$/i.test(host) ? 'youtube' : 'bilibili');
    return;
  }
  // 反思：startVideoController 有 _started 守卫——bilibili/youtube 已启动时为幂等 no-op；
  //   其他站 generic 未启动则真正启动（waitForVideo 找 video，无字幕走 ASR 缓存/无字幕提示）。
  startVideoController('generic').catch((e) => {
    console.warn('[VocabRadar][web-sidebar] 召唤视频侧栏失败:', e);
  });
}

function savePanelRect() {
  if (!_root || !_root.classList.contains('expanded')) return;
  const r = _root.getBoundingClientRect();
  if (!(r.width > 50) || !(r.height > 50)) return;
  set_panelRect({ left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
  try {
    // 第一百八十七次（用户："侧栏位置乱跑"）：改存 **视口坐标**。
    //   反思：#beaver-web-sidebar 是 position:fixed，定位基准永远是视口，与文档滚动无关。
    //   旧版存 docX/docY（= 视口坐标 + 当时滚动量），恢复时再减 **当前** 滚动量。
    //   刷新后滚动位置几乎必然不同（浏览器恢复滚动、锚点跳转、懒加载撑高），
    //   得到的 left/top 与保存时完全不同 —— 这就是"位置乱跑"的第一因。
    //   保留 docX/docY 仅为兼容旧数据读取路径，权威值是 left/top。
    chrome.storage.local.set({ shellRectText: {
      left: _panelRect.left,
      top: _panelRect.top,
      width: _panelRect.width,
      height: _panelRect.height,
      vw: window.innerWidth,
      vh: window.innerHeight
    } });
  } catch (e) { /* ignore */ }
}

function applyPanelRect(rect) {
  // 尺寸原样（仅钳进视口上限），位置夹回视口——外形一个像素不变（除非视口装不下）
  const w = Math.max(280, Math.min(Math.round(rect.width), window.innerWidth - 16));
  const h = Math.max(220, Math.min(Math.round(rect.height), window.innerHeight - 16));
  // 第一百八十七次：面板必须按 **自身宽高** 夹取。旧版用 clampPosToViewport（48px 球的
  //   夹取口径，maxT=视口高-48），380×760 的面板 top 稍大就被压到视口底边只剩一条，
  //   视觉上等于"侧栏跑了"。
  const p = clampRectToViewport(Math.round(rect.left), Math.round(rect.top), w, h);
  _root.classList.add('dragged');
  _root.style.left = p.left + 'px';
  _root.style.top = p.top + 'px';
  _root.style.right = 'auto';
  _root.style.bottom = 'auto';
  _root.style.transform = 'none';
  _root.style.width = w + 'px';
  _root.style.height = h + 'px';
  const panel = _root.querySelector('.beaver-web-panel');
  if (panel) panel.style.width = w + 'px';
}

export function expand(anchor) {
  // 第二百四十三次：温和 prime 内置翻译（不清冷却）——本次展开点击即 user activation，
  //   同步链上发起 create；后续扫描回填的 translate 复用实例。冷却期内快速跳过。
  primeTranslator();
  // 第一百二十一次：统一侧栏路由——页面存在视频侧栏且有 <video> 时，点球直接展开视频形态；
  // 文本形态改由视频侧栏头部 📄 按钮进入（或无视频时默认）。
  // 278次：用户手动展开=兜底已达成——置 sticky（_absentConcluded），同一 URL 上看门狗
  //   不再重进 12s 宽限把刚展开的文本侧栏藏回去。旧版只清零计时器，下一次 700ms tick
  //   重新进入宽限 → 展开面板被整体 display:none（"搜索框一点刚换成文本侧栏就消失"）
  _absentSince = 0;
  _absentConcluded = true;
  try {
    const vsb = document.querySelector('#beaver-sidebar');
    const hasVideo = !!document.querySelector('video');
    if (vsb && hasVideo && !anchor) {
      window.dispatchEvent(new CustomEvent('beaver-unified-open', { detail: { form: 'video' } }));
      return;
    }
  } catch (e) { /* ignore */ }
  // 反思（2026-08-13）：用户要求"悬浮球向右下方展开为文本侧栏，悬浮球在右上角"。
  //   展开态 CSS 已设 right:16px top:20px（与悬浮球一致），从右上角向下展开。
  //   拖动后 .dragged 态由 JS 设 left/top 自由定位，展开时保持 dragged 位置。
  const ballRect = _root.getBoundingClientRect();
  set_preExpandPos({ left: ballRect.left, top: ballRect.top });

  _root.classList.remove('collapsed');
  _root.classList.add('expanded');
  // 第一百七十一次：开启展开保护窗——双击悬浮球时第二击会落在刚出现的顶行 ◀/✕ 上
  markExpandGuard();
  // 第二百三十九次：重开侧栏时恢复网页提示——✕ 关闭曾 stopForPage（本页会话停用），
  //   按 Annotation 按钮当前态复活（active 才调 start：清 _sessionStop + startOrReport，
  //   诊断窗同款幂等入口）；按钮 inactive（全局关提示）则不碰。否则按钮亮着网页却无提示。
  if (_hintStoppedForPage) {
    _hintStoppedForPage = false;
    try {
      const annBtn = _root.querySelector('#beaver-web-annotation');
      if (annBtn && annBtn.classList.contains('active')) window.__beaverHintCtl?.start?.();
    } catch (e) { /* ignore */ }
  }
  // 第一百二十八次：防御性重注顶行样式（幂等）——用户反馈"球展开后无顶行"，
  //   若宿主页面清除了 <style id=beaver-topbar-css> 则顶行失去布局；展开时补一次。
  try { ensureTopbarCss(); } catch (e) { /* ignore */ }

  // 第一百三十四次：矩形决策三优先级（见 savePanelRect 注释）。
  // anchor=📄 形态切换：**整个矩形原样沿用视频侧栏现矩形**（用户裁定"切换外形不变"），
  // 撤销第一百三十三次的"复用文本旧尺寸+锚点位置"折中——两形态共享同一矩形最直观。
  if (anchor && anchor.width && anchor.height) {
    applyPanelRect(anchor);
    set_panelRect(null); // 由 expand 尾部 savePanelRect 以实际渲染值重建
  }
  else if (_panelRect) {
    // 第二百零七次（用户："悬浮球跟文本侧栏的位置无关了，应当一致"）：就地还原撤销——
    //   展开位置一律取悬浮球当前位置（折叠态球在面板右上角是既定形态，与就地还原在
    //   会话内本就一致，跨会话两份存储不再各回各家）；尺寸沿用记忆值。
    const w = Math.max(280, Math.min(Math.round(_panelRect.width), window.innerWidth - 16));
    const h = Math.max(220, Math.min(Math.round(_panelRect.height), window.innerHeight - 16));
    const p = clampRectToViewport(Math.round(ballRect.right) - w, Math.round(ballRect.top), w, h);
    _root.classList.add('dragged');
    _root.style.left = p.left + 'px';
    _root.style.top = p.top + 'px';
    _root.style.right = 'auto';
    _root.style.bottom = 'auto';
    _root.style.transform = 'none';
    _root.style.width = w + 'px';
    _root.style.height = h + 'px';
    const panel = _root.querySelector('.beaver-web-panel');
    if (panel) panel.style.width = w + 'px';
    set_panelRect(null); // 尾部 savePanelRect 以渲染结果重建
  }
  // 如果之前拖动过，保持拖动位置；否则用 CSS 默认 right:16px top:20px
  else if (!_root.classList.contains('dragged')) {
    // 未拖动：移除内联定位样式，用 CSS 默认
    _root.style.left = '';
    _root.style.top = '';
    _root.style.right = '';
    _root.style.bottom = '';
    _root.style.transform = '';
    } else {
      // 已拖动：保持拖动位置，侧栏从球位置展开（首次无历史矩形的兜底路径）
      // 第一百三十七次（用户裁定）：默认身形 1:2（380×760 基准，视口钳制）
      const p = clampPosToViewport(ballRect.left, ballRect.top);
      const panelW = Math.min(380, window.innerWidth - 24);
      const panelH = Math.max(300, Math.min(panelW * 2, window.innerHeight - 24));
      _root.style.left = p.left + 'px';
      _root.style.top = p.top + 'px';
      _root.style.right = 'auto';
      _root.style.bottom = 'auto';
      _root.style.transform = 'none';
      _root.style.width = panelW + 'px';
      _root.style.height = panelH + 'px';
      const panel = _root.querySelector('.beaver-web-panel');
      if (panel) panel.style.width = panelW + 'px';
    }

  // 第一百三十四次：以渲染结果为准确存面板矩形（第一百八十七次起为视口坐标）
  requestAnimationFrame(() => { try { savePanelRect(); } catch (e) { /* ignore */ } });
  saveState(true);
  // 展开时立即扫描页面文本
  schedulePageScan();
}

export function collapse() {
  // 第一百四十三次（用户裁定"折叠前后位置变动"）：先记住面板矩形，再把球放到
  // **面板原位右上角**——视觉上面板原地缩成球，展开时经 _panelRect 回到同一矩形，
  // 实现"就地"闭环（旧版球回到自己上一次的位置＝与面板位置脱节，看起来乱跳）。
  savePanelRect();
  const wasDragged = _root.classList.contains('dragged');
  let ballTarget = _preExpandPos;
  if (wasDragged) {
    const r = _root.getBoundingClientRect();
    // 272次：就地收拢锚点=把手宽（275次去三角后 104px 搜索栏）
    ballTarget = clampPosToViewport(Math.round(r.right) - 104, Math.round(r.top));
  }
  // 反思（2026-08-13）：恢复 expand 前的球位置，不基于侧栏 rect 计算。
  //   球位置固定（保存位置或默认右上角），不随侧栏移动。
  //   未拖动时用 CSS 默认 right:16px top:20px，不需要内联样式。
  _root.classList.remove('expanded');
  _root.classList.add('collapsed');

  // 清除展开态尺寸内联样式，恢复 48px 悬浮球
  _root.style.width = '';
  _root.style.height = '';
  const panel = _root.querySelector('.beaver-web-panel');
  if (panel) panel.style.width = '';

  if (wasDragged && ballTarget) {
    // 第一百四十三次：就地——球落在面板原位右上角（important 压过 collapsed 关键 CSS）
    _root.style.setProperty('left', ballTarget.left + 'px', 'important');
    _root.style.setProperty('top', ballTarget.top + 'px', 'important');
    _root.style.setProperty('right', 'auto', 'important');
    _root.style.setProperty('bottom', 'auto', 'important');
    _root.style.transform = 'none';
    set_preExpandPos(ballTarget);
  } else if (_preExpandPos && _root.classList.contains('dragged')) {
    // 拖动过：恢复 expand 前的球位置（内联 important 压过 collapsed 关键 CSS）
    _root.style.setProperty('left', _preExpandPos.left + 'px', 'important');
    _root.style.setProperty('top', _preExpandPos.top + 'px', 'important');
    _root.style.setProperty('right', 'auto', 'important');
    _root.style.setProperty('bottom', 'auto', 'important');
    _root.style.transform = 'none';
  } else {
    // 未拖动或无保存位置：移除 dragged 类和内联样式，用 CSS 默认 right:16px top:20px
    _root.classList.remove('dragged');
    _root.style.left = '';
    _root.style.top = '';
    _root.style.right = '';
    _root.style.bottom = '';
    _root.style.transform = '';
  }

  // 保存悬浮球位置（供下次刷新恢复）
  // 反思（2026-08-22 第九十四次）：保存前同样夹取到视口内，杜绝屏幕外残留位置
  // 第一百三十七次（用户反馈"悬浮球默认位置应当在右上角而不是左上角"）：
  //   YouTube 等正片页上球被"预判藏球"整体 display:none(important) 后，本函数
  //   若被调用，getBoundingClientRect 返回 {0,0,0,0}——把全零坐标写进 storage，
  //   之后所有普通页面都从左上角恢复。修正：仅当球当前真实可见（宽高>0）才保存；
  //   隐藏态跳过持久化，保住用户既有位置或 CSS 默认右上角。
  try {
    const rect = _root.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      chrome.storage.local.set({
        webSidebarPos: clampPosToViewport(rect.left, rect.top)
      });
    } else {
      console.warn('[VocabRadar][web-sidebar] collapse: 球处于隐藏态（宽高为0），跳过位置保存以防固化左上角');
    }
  } catch (e) { /* ignore */ }

  saveState(false);
}

/**
 * 反思（2026-08-08）：用户要求"悬浮球、侧栏都应当可拖动"。
 * 拖动悬浮球（折叠态）或标题栏（展开态）时，切换为自由定位模式。
 * 拖动位置保存到 chrome.storage.local，下次加载时恢复。
 */
let _dragging = false;

let _dragMoved = false;

let _dragOffsetX = 0;

let _dragOffsetY = 0;

let _activePointerId = null;

function makeDraggable() {
  // 悬浮球（折叠态）拖动
  const collapseTab = _root.querySelector('#beaver-web-collapse-tab');
  // 标题栏（展开态）拖动
  // 第一百二十四次：顶行统一后类名为共享的 .beaver-header（sidebar-topbar.js）
  const header = _root.querySelector('.beaver-header');

  // 反思（2026-08-13 第四十九次）：用户反馈"几个浏览器文本侧栏悬浮球拖不动"。
  //   根因：旧版为鼠标(mousedown/mousemove/mouseup) + 触摸(touchstart/touchmove/touchend)
  //   双套监听。火狐/Edge 某些版本对 mousedown 后原生拖拽、页面 CSS user-select、
  //   以及 touch-action 行为差异，导致拖动失效或指针丢失。
  //   修正：改用统一 Pointer Events（pointerdown/move/up/cancel），
  //   一套代码同时覆盖鼠标/触摸/笔；pointer capture 锁定目标防止指针逃逸。
  //   CSS 侧补 touch-action:none + user-select:none（在 web-sidebar.css 中）。
  const startDrag = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // 鼠标仅左键
    // 排除标题栏内的按钮点击
    if (e.target.closest('button')) return;
    // 272次：折叠态=搜索栏——输入框上起手不拖拽（保留光标定位与文本选择）
    if (e.target.closest('input')) return;
    _dragging = true;
    _dragMoved = false;
    _activePointerId = e.pointerId;
    const rect = _root.getBoundingClientRect();
    _dragOffsetX = e.clientX - rect.left;
    _dragOffsetY = e.clientY - rect.top;
    // pointer capture：锁定指针，避免拖出悬浮球后指针逃逸丢失
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
  };

  const onMove = (e) => {
    if (!_dragging || e.pointerId !== _activePointerId) return;
    _dragMoved = true;
    let x = e.clientX - _dragOffsetX;
    let y = e.clientY - _dragOffsetY;
    // 第二百四十六次（用户："侧栏不能拖动太低"；拍板"把手可见即可"）：边界从
    //   "整栏不出屏"放宽为"把手可见即可"——把手（展开态=标题栏，折叠态=悬浮球）
    //   留 8px 在视口内可抓，主体允许探出屏沿。旧版 y 上限 innerHeight - 全高：
    //   侧栏 75vh 时顶部最多拖到 25vh 处，"拖不低"即此。
    const w = _root.offsetWidth;
    const h = _root.offsetHeight;
    const grab = (header && header.offsetHeight) || 40;
    x = Math.max(8 - w, Math.min(x, window.innerWidth - 8));
    y = Math.max(8 - grab, Math.min(y, window.innerHeight - 8));
    _root.classList.add('dragged');
    // 反思（2026-08-13 第五十二次）：折叠态 critical CSS 用 !important 钉死
    //   right/top/left/bottom，普通内联样式被覆盖 → 悬浮球拖不动。
    //   修正：内联也加 !important（inline important 优先级最高，可压过 author !important）。
    _root.style.setProperty('left', x + 'px', 'important');
    _root.style.setProperty('top', y + 'px', 'important');
    _root.style.setProperty('right', 'auto', 'important');
    _root.style.setProperty('bottom', 'auto', 'important');
    _root.style.transform = 'none';
    // 反思（2026-08-09）：拖动后不再强制设置高度，保持用户自定义尺寸或默认 75vh
    e.preventDefault();
  };

  const endDrag = (e) => {
    if (!_dragging || e.pointerId !== _activePointerId) return;
    _dragging = false;
    _activePointerId = null;
    if (_dragMoved) {
      // 第一百三十六次：保存键位分离——旧版拖动一律写 webSidebarPos（球位键），
      // 展开态拖面板也把面板坐标写进去 → 下次折叠球被放回面板位置 = "位置乱窜"实锤之一。
      // 现在：展开态只存面板矩形（shellRectText）；折叠态才存球位（webSidebarPos，视口坐标）。
      try {
        if (_root.classList.contains('expanded')) {
          savePanelRect();
        } else {
          // 第一百八十七次：球位同样只存视口坐标（position:fixed 与滚动无关）；
          //   docX/docY 的"文档坐标"口径会在刷新后被当前滚动量污染 → 位置乱跑。
          const rect = _root.getBoundingClientRect();
          chrome.storage.local.set({
            webSidebarPos: { left: Math.round(rect.left), top: Math.round(rect.top) }
          });
        }
      } catch (e) { /* ignore */ }
    }
  };

  if (collapseTab) {
    collapseTab.addEventListener('pointerdown', startDrag);
  }
  if (header) {
    header.addEventListener('pointerdown', startDrag);
  }
  // 无条件阻止原生拖拽（火狐中 img/button 可能触发 dragstart）
  _root.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
  // 统一 Pointer Events：window 层兜底（capture 阶段），确保拖出边界仍能跟踪
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', endDrag, true);
  window.addEventListener('pointercancel', endDrag, true);

  // 位置恢复统一在 web-sidebar-impl.js 启动流程里做（读 webSidebarPos/shellRectText 后
  //   再 collapse），此处不再另起异步恢复，避免竞态覆盖。
}

/**
 * 第一百八十七次：删除 restoreDraggedPosition() 与 applyDraggedPosition() 两个**死函数**。
 *   前者自 2026-08-10 起已无任何调用点（位置恢复搬到 web-sidebar-impl.js 启动流程），
 *   但它会无条件给 _root 加 .dragged 并把「球位」写成内联 left/top —— 留着只会误导排查
 *   「侧栏位置乱跑」；后者是个空壳（只有一个空 if 分支）。按"不留死代码"清除。
 */

/**
 * 可调尺寸（2026-08-09 原版 / 第一百三十四次重写）
 * 反思：用户反馈"右下角调整反人类"——旧版仅 16px 角块+mousedown 双缺陷。
 *   重写为 Pointer Events + 三向命中（角 nwse / 右缘 ew / 下缘 ns，见模板与 CSS），
 *   setPointerCapture 防指针逃逸；约束 280×300 ~ 视口-16；
 *   结束后 savePanelRect() 持久化（文档坐标），就地展开折叠与形态切换共用此矩形。
 */
let _resizing = false;

function makeResizable() {
  const zones = [
    { el: _root.querySelector('#beaver-web-resize-handle'), axis: 'se' },
    { el: _root.querySelector('#beaver-web-resize-edge-r'), axis: 'e' },
    { el: _root.querySelector('#beaver-web-resize-edge-b'), axis: 's' }
  ];
  const startResize = (axis) => (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    _resizing = true;
    const rect = _root.getBoundingClientRect();
    // 切换自由定位模式（普通内联即可——CSS !important 已于本轮移除）
    _root.classList.add('dragged');
    _root.style.left = rect.left + 'px';
    _root.style.top = rect.top + 'px';
    _root.style.right = 'auto';
    _root.style.bottom = 'auto';
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = rect.width;
    const startH = rect.height;
    const maxW = window.innerWidth - 16;
    const maxH = window.innerHeight - 16;
    const onMove = (ev) => {
      if (!_resizing) return;
      let w = startW;
      let h = startH;
      if (axis === 'se' || axis === 'e') w = Math.max(280, Math.min(startW + (ev.clientX - startX), maxW));
      if (axis === 'se' || axis === 's') h = Math.max(300, Math.min(startH + (ev.clientY - startY), maxH));
      _root.style.width = w + 'px';
      _root.style.height = h + 'px';
      const panel = _root.querySelector('.beaver-web-panel');
      if (panel) panel.style.width = w + 'px';
      ev.preventDefault();
    };
    const endResize = () => {
      _resizing = false;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', endResize, true);
      window.removeEventListener('pointercancel', endResize, true);
      // 尺寸持久化：面板矩形（文档坐标）+ 兼容旧键
      try {
        savePanelRect();
        const r2 = _root.getBoundingClientRect();
        _cachedWebSize = { width: Math.round(r2.width), height: Math.round(r2.height) };
        chrome.storage.local.set({
          webSidebarSize: { width: Math.round(r2.width), height: Math.round(r2.height) }
        });
      } catch (e) { /* ignore */ }
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', endResize, true);
    window.addEventListener('pointercancel', endResize, true);
  };
  for (const z of zones) {
    if (z.el) z.el.addEventListener('pointerdown', startResize(z.axis));
  }

  // 恢复保存的尺寸
  restoreSidebarSize();

  // 窗口 resize 时保持侧栏可见——**只移回，不重置**。
  // 第一百四十三次（用户反馈"浏览器窗口已有变化就变为初始状态"）：旧版部分超出
  // 视口就把宽高缩到视口内、完全出视口还清空全部内联样式回默认＝用户尺寸/位置丢失。
  // 新策略：完全出视口才回默认（防真丢）；部分超出仅把位置钳回视口（尺寸原样保留）。
  window.addEventListener('resize', () => {
    if (!_root || _root.classList.contains('closed')) return;
    const rect = _root.getBoundingClientRect();
    if (rect.left >= window.innerWidth || rect.top >= window.innerHeight ||
        rect.right <= 0 || rect.bottom <= 0) {
      _root.classList.remove('dragged');
      _root.style.left = '';
      _root.style.top = '';
      _root.style.right = '';
      _root.style.bottom = '';
      _root.style.width = '';
      _root.style.height = '';
      _root.style.transform = '';
      const panel = _root.querySelector('.beaver-web-panel');
      if (panel) panel.style.width = '';
    } else if (_root.classList.contains('dragged')) {
      // 只移回不缩尺寸：保证面板至少 40px 可见即可
      const w = rect.width, h = rect.height;
      let x = Math.max(-(w - 40), Math.min(rect.left, window.innerWidth - 40));
      let y = Math.max(-(h - 40), Math.min(rect.top, window.innerHeight - 40));
      if (x !== rect.left) _root.style.left = x + 'px';
      if (y !== rect.top) _root.style.top = y + 'px';
    }
  });
}

/** 恢复保存的自定义尺寸（仅在展开态应用） */
// 第一百三十三次：内存缓存——形态切换时 expand(anchor) 复用文本侧栏自己的尺寸
let _cachedWebSize = null;

function restoreSidebarSize() {
  try {
    chrome.storage.local.get('webSidebarSize', (res) => {
      if (res.webSidebarSize && _root.classList.contains('expanded')) {
        const sz = res.webSidebarSize;
        _cachedWebSize = { width: Math.round(sz.width), height: Math.round(sz.height) };
        if (sz.width) _root.style.width = sz.width + 'px';
        if (sz.height) _root.style.height = sz.height + 'px';
        const panel = _root.querySelector('.beaver-web-panel');
        if (panel && sz.width) panel.style.width = sz.width + 'px';
      }
    });
  } catch (e) { /* ignore */ }
}

function speakWord(word) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(word);
    utter.lang = _cachedLearnLang === 'zh' ? 'zh-CN' : _cachedLearnLang;
    utter.rate = 0.9;
    window.speechSynthesis.speak(utter);
  } catch (_) { /* ignore */ }
}

// 第二百三十九次：✕ 关闭是否停用过本页 text-hint（expand 重开时按此恢复网页提示，
//   避免每次展开都对正常运行的 text-hint 多打一次 startHint）
let _hintStoppedForPage = false;

function close() {
  _root.classList.remove('expanded', 'collapsed');
  _root.classList.add('closed');
  saveState(false);
  // 2026-09-08（用户："扩展侧栏中关闭后，影响并未消失"）：✕ 关闭侧栏时连带撤掉
  //   text-hint 在页面上的全部影响（高亮包裹/侧邻注释/hover 提示）——text-hint-impl
  //   的 stopHint+unwrapAll。只影响本页（不写 storage），刷新后随侧栏一并恢复；
  //   stopForPage 会拦住 reconcile 的 5s 自动复活路径。text-hint impl 尚未就绪时
  //   钩子缺席，可选链静默跳过（此时注解本就尚未生成）。
  try { window.__beaverHintCtl?.stopForPage?.(); } catch (e) { console.warn('[VocabRadar][web-sidebar] stopForPage 调用失败:', e); }
  _hintStoppedForPage = true;
}

// === 第一百二十三次：重置位置与尺寸（⋯ 设定菜单项）===
// 清除拖动定位/自定义尺寸的内联样式与持久化，回落 CSS 默认（右上角）。
function resetLayout() {
  // 第一百八十七次：补上 shellRectText（展开态面板矩形）。旧版只清球位与尺寸，
  //   面板矩形还留在 storage 里，下次展开又被搬回老位置 —— 用户点了"重置"却没真重置。
  try { chrome.storage.local.remove(['webSidebarPos', 'webSidebarSize', 'shellRectText']); } catch (e) { /* ignore */ }
  _root.classList.add('dragged'); // 先保证内联可覆盖，再统一清空
  ['left', 'top', 'right', 'bottom', 'width', 'height', 'transform'].forEach((k) => {
    _root.style.removeProperty(k);
    _root.style.setProperty(k, '');
  });
  _root.classList.remove('dragged');
  const panel = _root.querySelector('.beaver-web-panel');
  if (panel) panel.style.width = '';
  set_preExpandPos(null);
  set_panelRect(null);   // 第一百八十七次：内存权威也要清，否则展开仍走 _panelRect 分支
  console.log('[VocabRadar][web-sidebar] 已重置位置与尺寸（默认右上角）');
}

// === 标签页切换 ===
function switchTab(tab) {
  set_activeTab(tab);
  _root.querySelectorAll('.beaver-web-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  _root.querySelectorAll('.beaver-web-tab-panel').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.tab !== tab);
  });
  // 反思（2026-08-12 第四十六次）：标签页按钮分布——
  //   句标签：注释/详情/字幕样式；词汇标签：词表按钮
  _root.querySelectorAll('[data-tab-toolbar]').forEach((tb) => {
    tb.classList.toggle('hidden', tb.dataset.tabToolbar !== tab);
  });
  // 切其他标签时自动退出词单模式
  if (_wordOnlyMode && tab !== 'words') {
    exitWordOnlyMode();
  }
  // 272次：learn 标签已改 query（结果卡随查询即用即渲，无需懒加载钩子）
  // 切到句标签时触发扫描
  if (tab === 'sentences') {
    schedulePageScan();
  }
}

// === 272次：query 标签——查询执行 ===
// 结果卡复用右键搜索的唯一定义（th/panel.js：buildPanelCss/buildCardInnerHTML/
// renderQueryCard/bindLemmaChipClick），承载在 Shadow DOM 内——卡片 CSS 不漏宿主页。
// @param {string} text 查询文本（空则回空态提示）
async function runSidebarQuery(text) {
  const box = _root.querySelector('#beaver-web-query-result');
  if (!box) return;
  const trimmed = String(text || '').trim();
  const input = _root.querySelector('#beaver-web-query-input');
  if (input && trimmed) input.value = trimmed;
  if (!trimmed) {
    box.innerHTML = '<div class="beaver-web-empty-tip">' + t('ws.queryTip') + '</div>';
    return;
  }
  box.innerHTML = '';
  const host = document.createElement('div');
  box.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>' + buildPanelCss() + '</style>'
    + '<div class="beaver-query-card" style="padding:10px 12px;background:#fbfdf9;border-radius:8px;">'
    + buildCardInnerHTML() + '</div>';
  bindLemmaChipClick(shadow);
  try {
    // 内嵌卡片：无定位回调、恒可写（后两参缺省即 no-op/恒 true）
    await renderQueryCard(shadow, trimmed);
  } catch (e) {
    console.error('[VocabRadar][web-sidebar] query 标签查询失败:', e);
  }
}

// === 272次：搜索栏输入完成/点三角 → 展开为文本侧栏并落到 query 标签（有词即查） ===
function expandToQuery(text) {
  // expand(true)：跳过"视频侧栏在场即展开视频形态"的路由——搜索明确要文本形态
  expand(true);
  switchTab('query');
  const input = _root.querySelector('#beaver-web-query-input');
  if (input && text) input.value = text;
  runSidebarQuery(text);
  try { if (input) input.focus(); } catch (_) { /* ignore */ }
}

// === 272次：搜索栏可用性——Query 全局开关（queryEnabled）+ 停用规则「搜索栏」项 ===
// 不可用时折叠条只剩品牌图标（.query-off，CSS 收回 48px 圆球形态），图标点击仍可展开侧栏。
// 与网页提示解耦：提示关/停不影响搜索栏；Query 关/停也不影响提示。
async function applyQueryAvailability() {
  if (!_root || !document.contains(_root)) return;
  let off = false;
  try {
    const enabled = await new Promise((resolve) => {
      try { chrome.storage.local.get({ queryEnabled: true }, (r) => resolve(r.queryEnabled !== false)); } catch (_) { resolve(true); }
    });
    const sup = await suppressionFor(location);
    off = !enabled || sup.query === true;
  } catch (e) {
    off = false; // 读取异常按可用处理（不遮蔽）
    console.warn('[VocabRadar][web-sidebar] Query 可用性读取失败，按可用处理:', e);
  }
  _root.classList.toggle('query-off', off);
  log('Query 可用性:', off ? '不可用（搜索栏隐藏为图标）' : '可用');
}

// 272次：Query 可用性实时刷新（全局开关/停用规则变化；模块级只注册一次）
let _queryAvailListenerInstalled = false;
function ensureQueryAvailabilityWatcher() {
  if (_queryAvailListenerInstalled) return;
  _queryAvailListenerInstalled = true;
  // 274次：初装即刷一次视频侧栏停用规则缓存（看门狗同步判定用）
  refreshVsRuleSup();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if ('queryEnabled' in changes || 'deactivateRules' in changes) {
        applyQueryAvailability();
        refreshVsRuleSup();
      }
    });
  } catch (e) { /* ignore */ }
  // 右键菜单（无选中文本）→ SW OPEN_QUERY_BAR → text-hint 转发本事件 → 跳到搜索框输入
  window.addEventListener('beaver-open-query-bar', () => {
    try {
      if (!_root || !document.contains(_root)) return;
      if (_root.classList.contains('closed')) return;
      if (_root.classList.contains('collapsed')) {
        const input = _root.querySelector('#beaver-qbar-input');
        if (input) { input.focus(); return; }
      }
      expand(true);
      switchTab('query');
      const qi = _root.querySelector('#beaver-web-query-input');
      if (qi) qi.focus();
    } catch (e) { /* ignore */ }
  });
}

// === G3（2026-09-08）：learn 面板草稿导入（§6.2） ===
// 272次：doImportDraft——组装+落缓存+三态提示（成功/无内容/失败，R1 不静默）；
// 期间 learn 按钮禁用防重复点击，结束后恢复（原 learn 标签两按钮已并入底部 learn 按钮）
async function doImportDraft() {
  const btn = _root.querySelector('#beaver-web-learn-btn');
  try {
    if (btn) btn.disabled = true;
    const r = await importCurrentSidebarDraft();
    if (!r.ok) { toast(t('learn.noContent')); return { ok: false }; }
    toast(t('learn.importOk'));
    return { ok: true };
  } catch (e) {
    console.error('[VocabRadar][web-sidebar] 草稿导入失败', e);
    toast(t('learn.importFail'));
    return { ok: false };
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 272次：底部 learn 按钮——导入成功才打开网站「我的卷轴」（hash 路由）。
// 274次：跳转规则=getSiteUrl()（本地构建跳本地、商店安装跳线上）；图标 📱→🎯
async function onDraftImportAndOpenClick() {
  const r = await doImportDraft();
  if (r.ok) window.open(getSiteUrl() + '/#/my-scrolls', '_blank');
}
// === 工具栏 ===
// 第二百三十九次：注释总开关（与视频侧栏 Annotation 按钮同语义，active=显示注释）。
//   开：__beaverHintCtl.start() 复活网页提示（诊断窗同款入口：清 _sessionStop +
//   startOrReport），_noAnnotation=false 恢复侧栏注释标记。
//   取消：__beaverHintCtl.stopForPage() 撤掉网页提示（本页会话停用，不写 storage，
//   reconcile 不复活；与 ✕ 关侧栏同一路径），_noAnnotation=true → 句子面板渲染
//   defuddle 提取的纯正文（scanner.js：highlightWords 空注释数组、无注释条）。
function onAnnotationClick() {
  const btn = _root.querySelector('#beaver-web-annotation');
  const isActive = btn.classList.toggle('active');
  set_noAnnotation(!isActive);
  try {
    if (isActive) {
      window.__beaverHintCtl?.start?.();
    } else {
      window.__beaverHintCtl?.stopForPage?.();
    }
  } catch (e) { console.warn('[VocabRadar][web-sidebar] 切换网页提示失败:', e); }
  log('注释开关:', isActive ? '开（网页提示+侧栏注释）' : '关（网页提示撤除+纯正文）');
  rerenderAllSlots();
}

function onDetailClick() {
  set_detailMode(!_detailMode);
  const btn = _root.querySelector('#beaver-web-detail');
  btn.classList.toggle('active', _detailMode);
  try { chrome.storage.local.set({ webSidebarAnnMode: _detailMode ? 'detail' : 'side' }); } catch (_) { /* ignore */ }
  // 从缓存重绘（注释数据不变，仅渲染方式变）
  rerenderAllSlots();
}

// === 词单模式（与 sidebar.js 同模式） ===
function onWordListToggle() {
  if (_allAnnotations.length === 0) {
    toast(t('ws.noWords'));
    return;
  }
  set_wordOnlyMode(!_wordOnlyMode);
  const btn = _root.querySelector('#beaver-web-export');
  const wordPanel = _root.querySelector('#beaver-web-word-panel');
  // 反思（2026-08-09）：用户要求"词单都用深色表示选中了，就不要再 √ 了"。
  //   .active 类已通过 --beaver-primary 深色背景表示选中状态，无需再在文字后加 ✓。
  if (_wordOnlyMode) {
    btn.classList.add('active');
    btn.textContent = t('ws.wordList');
    switchTab('words');
    if (wordPanel) wordPanel.classList.add('beaver-web-word-only');
  } else {
    btn.classList.remove('active');
    btn.textContent = t('ws.wordList');
    if (wordPanel) wordPanel.classList.remove('beaver-web-word-only');
  }
}

function exitWordOnlyMode() {
  set_wordOnlyMode(false);
  const btn = _root.querySelector('#beaver-web-export');
  if (btn) {
    btn.classList.remove('active');
    btn.textContent = t('ws.wordList');
  }
  const wordPanel = _root.querySelector('#beaver-web-word-panel');
  if (wordPanel) wordPanel.classList.remove('beaver-web-word-only');
}

// === MutationObserver：防止 SPA 框架移除悬浮球 ===
// 反思（2026-08-12 第四十六次）：Bing 等 SPA 会替换 document.body 或清除其子节点，
//   导致 appendChild 到 body 的悬浮球被移除。注入到 documentElement 后仍可能被移除。
//   新增 MutationObserver 监听 _root.parentNode，若 _root 被移除则自动重新注入。
let _reinjectObserver = null;

export function setupReinjectObserver() {
  if (_reinjectObserver) _reinjectObserver.disconnect();
  _reinjectObserver = new MutationObserver(() => {
    if (!_root) return;
    if (!_root.parentNode || !_root.parentNode.contains(_root)) {
      log('[' + ts() + '] 悬浮球被移除，自动重新注入');
      try {
        getInjectionRoot().appendChild(_root);
      } catch (e) {
        console.error('[VocabRadar][web-sidebar] 重新注入失败:', e);
      }
    }
  });
  // 监听 documentElement 的子节点变化
  _reinjectObserver.observe(document.documentElement, { childList: true, subtree: false });
}

// === 关闭所有浮层（菜单失焦退回）===
// 反思（2026-08-13 第四十八次）：用户要求"展开的菜单若有别处点击，表示失去焦点，应当退回去"。
// 第一百二十三次：新增 ⋯ 设定浮层，一并纳入统一关闭。
function closeAllPopups() {
  if (!_root) return;
  const langPanel = _root.querySelector('#beaver-web-lang-panel');
  const langBtn = _root.querySelector('#beaver-web-lang-btn');
  if (langPanel) langPanel.classList.remove('show');
  if (langBtn) langBtn.classList.remove('active');
  const setPop = _root.querySelector('#beaver-web-settings-pop');
  const setBtn = _root.querySelector('#beaver-web-settings-btn');
  if (setPop) setPop.classList.remove('show');
  if (setBtn) setBtn.classList.remove('active');
}

// 反思（2026-08-13 第五十次）：文本侧栏与视频侧栏共用同一 overlay 样式。
//   与 sidebar.js setSubtitleOverlayStyle 同逻辑（清除 11 种 class + 加当前 class）。
// 反思（2026-08-15 第六十四次）：类名列表由 SUBTITLE_STYLES 动态生成，不再硬编码。
// 反思（2026-08-15 第六十五次）：样式校验——storage 中已被移除的样式 id（旧版曾删
//   right-vertical/center-vertical）不再挂死类（挂死类 → 无对应 CSS → 回落黑底），
//   未知 id 优雅回退 'none' 并清理 storage。
// 反思（2026-08-16 第六十九次）：字幕样式改为"文字样式×位置样式"两维；overlay 元素由
//   subtitle-overlay.js 管理（位置按 subtitlePosition 内联计算），本函数只同步文字样式类。
function applyOverlayStyleClass(style) {
  const overlay = document.getElementById('beaver-subtitle-overlay');
  if (!overlay) return;
  const styleClasses = SUBTITLE_TEXT_STYLES
    .filter((s) => s.id !== 'none')
    .map((s) => 'style-' + s.id);
  overlay.classList.remove(...styleClasses);
  let id = (style && style !== 'none') ? style : 'none';
  if (id !== 'none' && !findStyle(SUBTITLE_TEXT_STYLES, id)) {
    console.warn(`[VocabRadar][web-sidebar] 字幕样式 "${id}" 已不存在，回退默认样式并清理 storage`);
    id = 'none';
    try {
      chrome.storage.local.set({ subtitleStyle: 'none' });
    } catch (e) { /* 清理失败忽略 */ }
  }
  if (id !== 'none') {
    overlay.classList.add('style-' + id);
  }
}

/**
 * 复制当前标签页的全部句子文本到剪切板
 * 反思（2026-08-08）：用户反馈"没有复制按钮"。
 *   文本侧栏缺少复制功能，视频侧栏（sidebar.js）已有 #beaver-copy。
 * 反思（2026-08-13 第五十三次）：ASR/OCR 已迁移引导页，仅剩页面句子标签。
 */
async function onCopyClick() {
  const built = buildSidebarText();
  if (!built.text) {
    toast(t('ws.noContent'));
    return;
  }
  const text = built.text;
  const sentences = built.sentences;

  try {
    await navigator.clipboard.writeText(text);
    toast(t('ws.copied') + ` (${sentences.length} ${t('ws.segments')})`);
  } catch (e) {
    // 回退：用 textarea + execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      getInjectionRoot().appendChild(ta);
      ta.select();
      document.execCommand('copy');
      try { ta.remove(); } catch (_) { /* ignore */ }
      toast(t('ws.copied') + ` (${sentences.length} ${t('ws.segments')})`);
    } catch (e2) {
      toast(t('ws.copyFail'), { error: true });
    }
  }
}

/**
 * 第一百七十一次：拼装当前侧栏文本（复制与导出共用，避免两处格式分叉）
 * @returns {{text: string, sentences: Array}} text 为空表示无内容
 */
function buildSidebarText() {
  const sentences = _pageSentences || [];
  if (sentences.length === 0) return { text: '', sentences: [] };
  // 拼接句子文本（每句一行；有时间戳的加 [mm:ss] 前缀）
  const lines = sentences.map((s) => {
    const text = (s.text || '').trim();
    if (typeof s.start === 'number' && s.start > 0) {
      return `[${formatTime(s.start)}] ${text}`;
    }
    return text;
  });
  return { text: lines.join('\n'), sentences };
}

/* 272次：onExportFileClick（导出为 .txt 文件）已删除——底部「导出文件」按钮
 * 改为 learn（导入卷轴草稿并跳转网站）；buildSidebarText 仍服务复制按钮与
 * getAiMainText 兜底，保留。如需恢复导出功能参考 git 历史。 */

/**
 * 第一百七十一次：文本侧栏底部对话按钮 —— 就当前页面正文发起对话
 * 第一百七十四次：按用户要求"没有内容也能唤起"——取不到正文不再 toast 拦截，
 *   直接打开空面板由用户自由提问（openChatPanel 内部对空文本隐藏引用区）。
 * 第一百八十四次：传 kind='sidebar' —— 用 chatSidebarPrompt（"总结上文"），
 *   正文（视口 TreeWalker 自提的网页正文）由面板顶部「The context is」上下文区承载。
 * 第一百八十五次（用户："回装 Readability，仅仅用在给AI提取正文"）：
 *   给 AI 的正文改由 lib/main-text.js 的 getAiMainText() 产出（Readability 优先，
 *   失败或正文过短自动回退整页直接解析）。旧的 buildSidebarText()（侧栏可视句子拼接）
 *   只是"当前视口扫到的句子"，既不完整又混入导航碎片，正是"上下文内容胡来"的来源；
 *   它仍服务于复制/导出，故保留，并在 getAiMainText 也拿不到文本时作为最后兜底。
 */
async function onChatClick() {
  let text = '';
  try {
    const m = await getAiMainText();
    text = (m && m.text) || '';
    log(`对话正文来源=${(m && m.source) || 'none'}，${text.length} 字符`);
  } catch (e) {
    // 不遮蔽错误：正文提取异常照实打日志，再退回侧栏句子拼接
    console.warn('[VocabRadar][web-sidebar] 正文提取失败，退回侧栏句子:', e);
  }
  if (!text) {
    const built = buildSidebarText();
    text = (built && built.text) || '';
  }
  openChatPanel(text, 'sidebar');
}

// 第一百二十三次（用户裁定）：悬浮球、文本侧栏、视频侧栏不同时出现。
// 轻量轮询（700ms）覆盖 SPA 动态插拔/✕关闭/样式切换；expand/collapse/close 时即时同步。
// 第一百三十二次（用户状态机裁定"只有一个侧栏→选文本或视频→折叠态是否展开"）重构：
//   视频侧栏元素在 DOM 即互斥——不看 display（折叠/展开都算在场），文本展开态不再豁免
//   （豁免导致"文本面板与视频侧栏同屏"）。两个出口：
//   1) ✕ 显式关闭：video-sidebar ✕ 处打 dataset.userClosed='1'，悬浮球回归作为唯一入口；
//   2) 📄 切到文本形态：视频侧栏 display:none + 内部 _hiddenByFormSwitch 标记，
//      此时文本面板（同一根元素）在场，球保持隐藏即可。
// 隐藏必须用 setProperty('display','none','important')！根因反思：injectCriticalCSS 有
//   #beaver-web-sidebar.collapsed{display:flex !important}，author !important 声明
//   优先级高于普通内联 style.display='none'——旧版"隐藏悬浮球"从未真正生效过
//   （用户反复反馈"视频侧栏仍然出现了文本悬浮球"的本根因）。
let _ballSyncTimer = null;

// 第一百三十五次：正片页空窗期起始时刻（0=不处于空窗），供 12s 兜底闸门判定
let _absentSince = 0;
// 278次：空窗兜底 sticky——本 URL 上 12s 宽限到期完成过一次兜底（或用户手动展开）后置位。
//   旧版 expand() 只清零 _absentSince，下一次 700ms tick 重新进入 12s 宽限 → shouldHideRoot
//   再次为 true → 刚展开的文本侧栏被整体 display:none（用户报"搜索框一点刚换成文本侧栏
//   就消失"的直接根因）。置位后同一 URL 不再重进宽限；URL 变化或侧栏重新在场时复位。
let _absentConcluded = false;
let _syncLastUrl = '';
// 274次：告警限频——正片页缺席超过 12s 后旧版每个同步周期都 warn（用户实测刷屏）
let _lastAbsentWarn = 0;
// 274次：「视频侧栏」停用规则缓存——true 时正片页无侧栏=规则停用的预期行为，
// 看门狗不得兜底恢复（对抗规则）也不得刷日志。276次：不再完全静默——压住时按
// 60s 限频打一条带规则地址的说明（用户报"视频侧栏不可见"时日志直接给出原因）。
// 值由 refreshVsRuleSup 异步刷新（初装+deactivateRules 变化，见 ensureQueryAvailabilityWatcher）。
let _vsRuleSup = false;
let _vsRuleSupPats = [];
async function refreshVsRuleSup() {
  try {
    const sup = await suppressionFor(location);
    _vsRuleSup = sup.videoSidebar === true;
    _vsRuleSupPats = Array.isArray(sup.matchedPats) ? sup.matchedPats : [];
  } catch (_) { _vsRuleSup = false; _vsRuleSupPats = []; }
}

// 第一百三十四次（用户反馈"目前在视频网站中显示的是悬浮球"）：视频正片页在侧栏
// 注入完成前存在空窗期，球会先闪出来——按 URL 预判：B站/watch/shorts 正片页，
// 视频侧栏缺席且未被 ✕ 关闭时同样藏球（注入后 presence 变 active 自然衔接）。
function isVideoWatchPage() {
  const path = location.pathname;
  const host = location.hostname;
  if (host.includes('bilibili.com')) return /\/video\/(BV[\w]+|av\d+)/i.test(path);
  if (host.includes('youtube.com')) return /\/(watch|shorts)($|\?|\/)/i.test(path);
  return false;
}

function getVideoSidebarPresence() {
  // 返回 'absent' | 'closed'(✕显式关闭,球回归) | 'formSwitched'(文本形态接管) | 'active'(视频形态在场)
  try {
    const vsb = document.querySelector('#beaver-sidebar');
    if (!vsb || !document.contains(vsb)) return 'absent';
    if (vsb.dataset && vsb.dataset.userClosed === '1') return 'closed';
    if (vsb.style.display === 'none') return 'formSwitched';
    return 'active';
  } catch (e) { return 'absent'; }
}

export function syncBallWithVideoSidebar() {
  if (!_root) return;
  // 278次：URL 变化=新页面——复位空窗计时与 sticky，重新走正常 12s 宽限
  if (location.href !== _syncLastUrl) {
    _syncLastUrl = location.href;
    _absentSince = 0;
    _absentConcluded = false;
  }
  const presence = getVideoSidebarPresence();
  // active=视频侧栏在场；absent 且正片页=侧栏即将注入的空窗期——两者都藏球。
  // closed（✕ 显式关闭）是唯一放行球的出口；formSwitched 时文本面板在场不额外处理。
  // 第一百三十五次：空窗期藏球加 **12s 兜底闸门**——侧栏因任何原因注入失败时，
  // 球自动恢复（宁可多显示也不能"啥都没有"），并打告警引导用户贴日志归因。
  const ABSENT_GRACE_MS = 12000;
  let shouldHideRoot = (presence === 'active');
  let hideReason = (presence === 'active') ? '视频侧栏在场' : '';
  // 274次：规则停用优先——「视频侧栏」被停时正片页无侧栏是预期，不进空窗判定
  // （放行搜索栏、复位计时）；276次：不再完全静默，60s 限频打一条带规则地址的说明，
  // 用户报"视频侧栏不可见"时日志直接给出原因与修改入口。
  if (!shouldHideRoot && presence === 'absent' && isVideoWatchPage()) {
    if (_vsRuleSup) {
      _absentSince = 0;
      if (Date.now() - _lastAbsentWarn > 60000) {
        _lastAbsentWarn = Date.now();
        console.warn('[VocabRadar][web-sidebar] 视频侧栏被停用规则关闭（规则='
          + (_vsRuleSupPats.join(',') || '(未知)') + '），本页不注入——如需恢复请到引导页'
          + '「设定栏 → Deactivate（停用）」把该行的"视频侧栏"点掉或删除该行');
      }
    } else {
      if (!_absentSince) _absentSince = Date.now();
      // 278次：sticky 兜底——本 URL 已兜底恢复过（_absentConcluded）就不再重进宽限，
      //   球保持可见（宁可多显示也不把用户刚展开的面板藏回去）
      if (!_absentConcluded && Date.now() - _absentSince < ABSENT_GRACE_MS) {
        shouldHideRoot = true;
        hideReason = '视频正片页待注入';
      } else if (!_absentConcluded) {
        _absentConcluded = true;
      }
      if (Date.now() - _lastAbsentWarn > 60000) {
        _lastAbsentWarn = Date.now();
        console.warn('[VocabRadar][web-sidebar] 视频侧栏超过12s未出现在正片页(注入可能失败)，悬浮球兜底恢复。'
          + '诊断: window.__beaverVsDiag() ；请贴控制台 [VocabRadar] 全部日志（60s 限频）');
      }
    }
  } else {
    _absentSince = 0;
    // 278次：侧栏重新在场/被✕显式关闭 → sticky 复位（下次真缺席重新走完整宽限）
    if (presence === 'active' || presence === 'closed') _absentConcluded = false;
  }
  if (shouldHideRoot && _root.classList.contains('expanded')) {
    // 视频形态在场：先把文本面板收成球再整体退场（下次回归时符合"默认折叠"约定）
    try { collapse(); } catch (e) { /* ignore */ }
  }
  const isHidden = _root.style.getPropertyValue('display') === 'none'
    && _root.style.getPropertyPriority('display') === 'important';
  if (isHidden !== shouldHideRoot) {
    if (shouldHideRoot) {
      _root.style.setProperty('display', 'none', 'important');
      console.log('[VocabRadar][web-sidebar]', hideReason, '→ 悬浮球整体隐藏(important)');
    } else {
      _root.style.removeProperty('display');
      console.log('[VocabRadar][web-sidebar] 视频侧栏', presence === 'closed' ? '已被✕关闭' : '不在场/超时兜底', '→ 悬浮球恢复');
    }
  }
}

export function ensureBallSync() {
  if (_ballSyncTimer) return;
  _ballSyncTimer = setInterval(() => {
    try { syncBallWithVideoSidebar(); } catch (e) { /* ignore */ }
  }, 700);
}
