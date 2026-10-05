// =============================================================================
// vs/bind-events.js —— 侧栏事件接线子模块
// -----------------------------------------------------------------------------
// 职责：bindEvents(options)——tab 切换、注释/详略/词单/设定浮层（引导/停用/
//       诊断菜单）、同步滚动开关、重置布局、底部按钮（复制/OCR/评论/learn/聊天）、
//       query 标签、语言浮层三语下拉、✕ 关闭、折叠、形态切换、视频叠加字幕开关、
//       ASR 开关、轨道选择、点击捕获诊断、喇叭/生词折叠事件委托。
// 状态接驳：_activeTab/_syncEnabled/_overlayRuleSup/_overlayEnabled 仍属门面，
//       经 setActiveTab/setSyncEnabled/getOverlayRuleSup/setOverlayEnabled 读写；
//       _asrActive 经 isASRActive() 读。
// 关系：依赖 ./build.js、./subtitle-renderer.js、./ocr.js、./asr-flow.js、
//       ./tracks.js、./actions.js、./sidebar-layout.js、./logger.js、
//       ../subtitle-overlay.js、../diag-window.js、../../lib/deactivate.js、
//       ../../lib/i18n.js；经受控循环 import 对门面——本模块顶层仅 import 与
//       函数声明，门面绑定调用仅在 bindEvents 函数体内发生（运行时安全）。
//       等价改写：函数顶 `const _root = getRoot();` 捕获本次接线的根（监听器
//       附着于该根的元素，根销毁即随元素卸载，事件不可再达，读取时点等价）。
// =============================================================================

import { getLang, setLang, UI_LANGS, TRANSLATE_LANGS, LANG_NAMES } from '../../lib/i18n.js';
import { upsertDeactivateRule } from '../../lib/deactivate.js';
import { openDiagCenter } from '../diag-window.js';
import { setOverlayEnabled as overlaySetEnabled, setOverlayBilingual } from '../subtitle-overlay.js';
import { log } from './logger.js';
import { closeAllPopups } from './build.js';
import {
  setNoAnnotation, rerenderPanelOnly, setDetailMode, getDetailMode,
  rerenderSlotsFromCache, onWordListToggle, onCopy, onCommentClick,
  onChatClickVs, toggleLemmaGroup
} from './subtitle-renderer.js';
import { onOcrClick } from './ocr.js';
import { toggleASR, stopASRInternal } from './asr-flow.js';
import { onTrackSelect } from './tracks.js';
import { speakWordVideo, runVideoQuery, onLearnClickVs } from './actions.js';
import {
  toggleSidebarCollapse, armAutoExpand, resetSidebarLayout,
  setSidebarCollapsedFlag, setHiddenByFormSwitch
} from './sidebar-layout.js';
import {
  getRoot, getActiveTab, setActiveTab, setSyncEnabled,
  getOverlayRuleSup, setOverlayEnabled, isASRActive
} from '../video-sidebar.js';

export function bindEvents(options = {}) {
  const _root = getRoot();
  // tab 切换：字幕 / 生词表 / query
  _root.querySelectorAll('.beaver-tab').forEach((tab) => {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      _root.querySelectorAll('.beaver-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      setActiveTab(tab.dataset.tab);
      _root.querySelector('#beaver-subtitle-panel').classList.toggle('hidden', getActiveTab() !== 'subtitle');
      _root.querySelector('#beaver-word-panel').classList.toggle('hidden', getActiveTab() !== 'words');
      // mp 练习页改 query 标签（同文本侧栏：右键搜索卡片）
      _root.querySelector('#beaver-query-panel').classList.toggle('hidden', getActiveTab() !== 'query');
      // 标签页按钮分组：
      //   字母页(subtitle)：注释/详情/字幕样式；词汇页(words)：词表按钮；query 页：无工具栏
      _root.querySelectorAll('[data-tab-toolbar]').forEach((tb) => {
        tb.classList.toggle('hidden', tb.dataset.tabToolbar !== getActiveTab());
      });
    });
  });

  // Annotation 按钮（原 notes）：背景色表示选中（active=显示注释，非 active=不显示注释）
  // 用户要求"复选按钮用背景色改变表示选中而不是复选框"，
  //   "无注释改为注释，默认选中"。逻辑反转：按钮 active = 显示注释 = _noAnnotation=false。
  // 用户要求「notes 改称 Annotation」。仅改名，逻辑不变。
  const annotationBtn = _root.querySelector('#beaver-annotation');
  annotationBtn.addEventListener('click', () => {
    const isActive = annotationBtn.classList.toggle('active');
    setNoAnnotation(!isActive);  // active=显示注释 → _noAnnotation=false
    log('注释:', isActive ? '显示' : '隐藏');
    rerenderPanelOnly();
  });

  // Detail 按钮：详略切换。默认非 active=简略模式（注释跟在生词后不另起一行），
  //   active=详细模式（注释另起一行，老版本格式）。
  // 用户要求「之右是详略切换按钮，默认简略模式」。
  //   简略模式：注释直接跟在字幕正文中的生词后（高亮 span 之后），不另起一行。
  //   详细模式：注释独立成行（老版本格式）。
  // 用户反馈「点击 detail 并没有切换」。
  //   根因：此前 detail 点击调 rerenderPanelOnly，该函数清 _annotationsCache 后调 highlightCurrent，
  //   但 highlightCurrent 不重绘注释，rerenderSlotsFromCache 从已清的缓存取不到 anns，无重绘。
  //   detail 切换不需要清缓存（注释数据不变，仅渲染方式变），直接调 rerenderSlotsFromCache
  //   从现有缓存取 anns 重绘，立即应用新 _detailMode。
  const detailBtn = _root.querySelector('#beaver-detail');
  detailBtn.addEventListener('click', () => {
    setDetailMode(detailBtn.classList.toggle('active'));
    log('详略模式:', getDetailMode() ? '详细' : '简略');
    // 同步到 storage，视频内字幕（subtitle-overlay.js）监听并同步切换注释模式
    // 视频提示与视频内字幕共用 subtitleDetailMode
    //   false=侧邻注释（简略），true=详细注释
    try {
      chrome.storage.local.set({
        subtitleDetailMode: getDetailMode(),
        videoSidebarAnnMode: getDetailMode() ? 'detail' : 'side',
        videoOverlayAnnMode: getDetailMode() ? 'detail' : 'side'
      });
    } catch (_) { /* ignore */ }
    rerenderSlotsFromCache();
  });

  // 词单按钮：点击切换词单模式（只剩单词，移走所有注释）
  const exportBtn = _root.querySelector('#beaver-export');
  exportBtn.addEventListener('click', onWordListToggle);

  // 设定浮层
  // 用户："⋯改为下拉，点击选项后再跳转而不是点击...就跳转"——
  //   ⋯ 恢复下拉展开（先关其他浮层再 toggle 自身），
  //   引导页/诊断窗口降级为菜单项，点击选项才执行（诊断窗经 lib/main-text 懒加载，不影响首屏）。
  const settingsBtn = _root.querySelector('.beaver-settings-btn');
  const settingsPop = _root.querySelector('#beaver-settings-pop');
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !settingsPop.classList.contains('show');
    closeAllPopups();
    if (opening) settingsPop.classList.add('show');
  });
  // 菜单项：打开引导页（原 ⋯ 直跳行为降级至此）
  _root.querySelector('#beaver-guide-item').addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllPopups();
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_GUIDE' });
      log('⋯菜单 → 打开引导页');
    } catch (err) {
      log('⋯菜单 打开引导页失败：' + String(err && err.message || err));
    }
  });
  // 菜单项：停用本站（默认单停「网页提示」——用户裁定
  //   "设定抑制默认是抑制网页提示，不是所有"）：写当前域 hint 停用规则，规则写入即经
  //   storage.onChanged 撤本页高亮/侧注（视频页上 text-hint 同样在跑）；视频侧栏自身
  //   与其余三项不受影响，随后跳引导页停用栏（地址=当前域名）供改范围与勾选四项。
  _root.querySelector('#beaver-deactivate-item').addEventListener('click', async (e) => {
    e.stopPropagation();
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
  // 菜单项：诊断中心路由窗（由「正文提取诊断」改名而来）
  _root.querySelector('#beaver-diag-item').addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllPopups();
    openDiagCenter().catch((err) => {
      log('⋯菜单 诊断打开失败：' + String(err && err.message || err));
    });
  });
  settingsPop.addEventListener('click', (e) => e.stopPropagation());
  _root.querySelector('#beaver-sync').addEventListener('change', (e) => {
    setSyncEnabled(e.target.checked);
  });
  // ↺ 重置位置与尺寸（见 buildSidebar 模板注释）
  const resetLayoutBtn = _root.querySelector('#beaver-reset-layout');
  if (resetLayoutBtn) resetLayoutBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    resetSidebarLayout();
    settingsPop.classList.remove('show');
  });

  // 底部按钮：点击即触发
  const btnCopy = _root.querySelector('#beaver-copy');
  const btnOcr = _root.querySelector('#beaver-ocr');
  const btnComment = _root.querySelector('#beaver-comment');
  // 底部 learn 按钮（🎯）——导入视频草稿并跳转网站「我的卷轴」
  const btnLearn = _root.querySelector('#beaver-learn-btn');
  const btnChat = _root.querySelector('#beaver-chat');
  btnCopy.addEventListener('click', onCopy);
  btnOcr.addEventListener('click', onOcrClick);
  btnComment.addEventListener('click', onCommentClick);
  if (btnLearn) btnLearn.addEventListener('click', onLearnClickVs);
  if (btnChat) btnChat.addEventListener('click', onChatClickVs);

  // query 标签——查询按钮与 Enter（与文本侧栏 query 标签同构）
  const _vsQRun = _root.querySelector('#beaver-vs-query-run');
  const _vsQInput = _root.querySelector('#beaver-vs-query-input');
  if (_vsQRun) _vsQRun.addEventListener('click', () => {
    runVideoQuery(_vsQInput ? String(_vsQInput.value || '').trim() : '');
  });
  if (_vsQInput) _vsQInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    runVideoQuery(String(_vsQInput.value || '').trim());
  });

  // 语言设置浮层：🌐按钮展开/收起三种语言下拉菜单
  // 用户要求"视频提示应该用符号，展开三种选择"：button#beaver-lang-btn 点击展开面板，
  //   含界面/目标/释义三种语言（此前为 select#beaver-ui-lang 直接显示在 header）。
  // 参照项目约定"右键查询菜单点击别处自动消失"，
  //   语言浮层同样点击外部自动关闭，并同步按钮 .active 状态。
  const langBtn = _root.querySelector('#beaver-lang-btn');
  const langPanel = _root.querySelector('#beaver-lang-panel');
  langBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willShow = !langPanel.classList.contains('show');
    closeAllPopups();
    langPanel.classList.toggle('show', willShow);
    langBtn.classList.toggle('active', willShow);
  });
  langPanel.addEventListener('click', (e) => e.stopPropagation());

  // 填充三种语言下拉菜单选项
  // 界面语言：UI_LANGS（前10种）；目标/释义语言：TRANSLATE_LANGS（42种）
  const uiLangSel = _root.querySelector('#beaver-ui-lang');
  const srcLangSel = _root.querySelector('#beaver-learn-lang');
  const tgtLangSel = _root.querySelector('#beaver-meaning-lang');
  // 第514次（用户"侧栏的语言列表的语言名称参照引导页的"）：三组标签统一
  //   「两位代码 + 空格 + 语言自称」（LANG_NAMES），与引导页 renderLangSelect 同口径；
  //   释义下拉"统一英文名称"（LANG_NAMES_EN）旧决策撤销。
  // 第517次（用户令"侧栏中的语言顺序改为代码顺序"）：展示序与引导页同口径，
  //   按两位代码字典序排——[...].sort() 只排展示副本，i18n.js 原序与默认值不动。
  const langLabel = (lang) => (LANG_NAMES[lang] ? `${lang} ${LANG_NAMES[lang]}` : lang);
  for (const lang of [...UI_LANGS].sort()) {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = langLabel(lang);
    uiLangSel.appendChild(opt);
  }
  // 填充目标/释义语言选项（42种）
  for (const lang of [...TRANSLATE_LANGS].sort()) {
    const opt1 = document.createElement('option');
    opt1.value = lang;
    opt1.textContent = langLabel(lang);
    srcLangSel.appendChild(opt1);

    const opt2 = document.createElement('option');
    opt2.value = lang;
    opt2.textContent = langLabel(lang);
    tgtLangSel.appendChild(opt2);
  }

  // 从 storage 读取当前语言设置并同步到下拉菜单
  chrome.storage.local.get({ learnLanguage: 'en', meaningLanguage: 'zh' }, (res) => {
    srcLangSel.value = res.learnLanguage || 'en';
    tgtLangSel.value = res.meaningLanguage || 'zh';
  });
  uiLangSel.value = getLang();

  // 界面语言切换
  uiLangSel.addEventListener('change', (e) => {
    e.stopPropagation();
    const lang = e.target.value;
    if (UI_LANGS.includes(lang)) {
      setLang(lang);
    }
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

  // 关闭视频提示按钮（仅本次会话生效，刷新页面恢复）
  // 用户反馈会员专属视频无作者，视频提示挤不进去。
  // 解决办法之一：设置弹出有关闭选项，仅单次生效。
  // 关闭按钮隐藏视频提示 DOM，不修改 storage（仅本次会话，不持久化），
  // 刷新页面后视频提示重新出现。
  _root.querySelector('#beaver-close').addEventListener('click', (e) => {
    e.stopPropagation();
    // 用户："扩展侧栏中关闭后，影响并未消失"：✕ 关闭时若 ASR 仍在转录
    //   必须一并停掉——此前只藏 DOM，拾音/网络请求继续跑（影响残留）。
    //   与 destroySidebar 同口径（isASRActive() 判定后才停）。
    if (isASRActive()) { try { stopASRInternal(true); } catch (err) { /* ignore */ } }
    _root.style.display = 'none';
    // 用户状态机：✕ 是显式关闭——打标记后文本悬浮球恢复为唯一入口
    // （syncBallWithVideoSidebar 靠该标记区分"关闭"与"📄切走"，前者放行球、后者不放）。
    try { _root.dataset.userClosed = '1'; } catch (err) { /* ignore */ }
    log('用户关闭视频提示（仅本次会话，刷新恢复；悬浮球已恢复）');
  });

  // 折叠/展开按钮，状态持久化
  const collapseBtn = _root.querySelector('#beaver-sidebar-collapse');
  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSidebarCollapse();
  });
  // 用户裁定"侧栏先折叠，有内容了再展开，而不是先展开空着"：启动一律折叠，
  // 不恢复 storage.sidebarCollapsed（此前"先展开 loading/空面板"即源于此）。
  // 首批真实内容到达时由 updateSubtitles/appendASRSubtitle 自动展开一次。
  // 引导页 mount 模式例外：预览容器需要直接可见内容。
  if (!options.mount) {
    setSidebarCollapsedFlag(true);
    _root.classList.add('beaver-collapsed');
    collapseBtn.textContent = '▶';
    // 折叠态清 height/maxHeight，防空白大块（与 toggleSidebarCollapse 折叠分支一致）
    _root.style.height = 'auto';
    _root.style.maxHeight = 'none';
    armAutoExpand();
  }

  // 📄 切换形态按钮——视频侧栏 → 文本侧栏（统称"侧栏"，内容照旧）。
  // 用户裁定"文本侧栏与视频侧栏选其一"：切换后自身 **display:none
  // 整体隐藏**（不是折叠成顶条——顶条与文本侧栏同屏仍算"同时出现"）。
  // 派发 window 事件给 web-sidebar-impl 在本位置附近展开文本形态；
  // 回程经 beaver-unified-open（球/🎬）恢复显示。
  const formBtn = _root.querySelector('#beaver-form-btn');
  if (formBtn) {
    formBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = _root.getBoundingClientRect();
      window.dispatchEvent(new CustomEvent('beaver-toggle-form', {
        detail: { to: 'text', anchor: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } }
      }));
      setHiddenByFormSwitch(true);
      _root.style.display = 'none';
      log('切换形态 → 文本侧栏（视频侧栏整体隐藏）');
    });
  }

  // 视频叠加字幕开关。
  //   用户要求"视频侧栏的『字幕样式』改为『视频叠加字幕』切换按钮"。
  //   点击切换 overlay 文字层显隐（写 storage.overlayEnabled，全标签同步），
  //   按钮 active class 表示"视频叠加字幕已开启"。
  //   subtitleStyle 样式选择已移到引导页，此处不再提供入口。
  const overlayToggleBtn = _root.querySelector('#beaver-overlay-toggle');
  const applyOverlayToggleBtn = (on) => {
    if (overlayToggleBtn) overlayToggleBtn.classList.toggle('active', !!on);
  };
  overlayToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // 默认关（用户裁定"视频叠加字幕默认关"，此前曾默认开）：未设置视为关闭（=== true）
    chrome.storage.local.get({ overlayEnabled: false }, (res) => {
      const next = res.overlayEnabled === true;
      const toggled = !next;
      // 停用规则否决——全局偏好照写 storage，但本页生效值被
      //   「视频叠加字幕」停用规则压制（按钮态按生效值显示，忠实反映现状）
      const effective = toggled && !getOverlayRuleSup();
      setOverlayEnabled(effective);
      overlaySetEnabled(effective);
      applyOverlayToggleBtn(effective);
      try { chrome.storage.local.set({ overlayEnabled: toggled }); } catch (_) { /* ignore */ }
      log('视频叠加字幕:', toggled ? '开启' : '关闭',
        getOverlayRuleSup() ? '（被停用规则压制，本页不生效）' : '');
    });
  });
  // 恢复上次叠加字幕开关（生效值 AND 停用规则否决位）
  // 用户"默认视频叠加字幕关着，但播放时候发现依旧开启"根因实锤：
  //   默认关口径（未设置视为关闭 === true）只改了 toggle/停用规则监听两处，
  //   本处恢复上次开关仍是旧口径 res.overlayEnabled !== false——chrome.storage.local.get
  //   不带默认值对象时，storage 无键返回 undefined，undefined !== false === true → 默认开。
  //   修为 === true（与 guide.js:461 / video-sidebar.js:804/908 同口径）。
  chrome.storage.local.get('overlayEnabled', (res) => {
    const on = res.overlayEnabled === true && !getOverlayRuleSup();
    setOverlayEnabled(on);
    overlaySetEnabled(on);
    applyOverlayToggleBtn(on);
  });

  // 双语字幕开关（叠加字幕子开关，storage.overlayBilingual 默认关）。
  //   第514次（用户"视频叠加字幕的按钮后面增加双语标签按钮，目标语言在上，
  //   释义语言在下。有了双语字幕，自然就不用注释了"）：按钮态持久于 storage；
  //   渲染归 subtitle-overlay.js——直接调用（即时生效）+ 其 storage 监听
  //   （跨标签同步）双通道，与叠加开关同口径。
  const bilingualBtn = _root.querySelector('#beaver-bilingual-toggle');
  const applyBilingualBtn = (on) => {
    if (bilingualBtn) bilingualBtn.classList.toggle('active', !!on);
  };
  if (bilingualBtn) bilingualBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.storage.local.get({ overlayBilingual: false }, (res) => {
      const toggled = !(res.overlayBilingual === true);
      try { chrome.storage.local.set({ overlayBilingual: toggled }); } catch (_) { /* ignore */ }
      setOverlayBilingual(toggled);
      applyBilingualBtn(toggled);
      log('双语字幕:', toggled ? '开启' : '关闭');
    });
  });
  // 恢复上次双语开关（未设置视为关闭 === true）
  chrome.storage.local.get('overlayBilingual', (res) => {
    const on = res.overlayBilingual === true;
    setOverlayBilingual(on);
    applyBilingualBtn(on);
  });
  // 统一注册：点击任意非浮层区域关闭所有浮层（菜单失焦退回）
  document.addEventListener('click', closeAllPopups);

  // ASR 开关按钮（独立于字幕轨道，不互斥）
  const asrToggleBtn = _root.querySelector('#beaver-asr-toggle');
  asrToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleASR(e.clientX, e.clientY);
  });

  // 字幕轨道选择器
  const trackSelect = _root.querySelector('#beaver-track-select');
  trackSelect.addEventListener('change', (e) => {
    e.stopPropagation();
    const idx = parseInt(e.target.value, 10);
    // fromUser=true：真实用户手选（onTrackSelect 据此记录手选轨道，自动链/模拟切轨不传）
    onTrackSelect(idx, { fromUser: true });
  });

  // 点击诊断：capture 阶段记录点击是否到达按钮，排查"点不动"
  [_root, btnCopy, btnOcr, btnComment].forEach((el, i) => {
    el.addEventListener('click', (e) => {
      log('click 捕获到:', el.id || el.className, 'target=', e.target.id || e.target.className, 'isTrusted=', e.isTrusted);
    }, true);
  });

  // 喇叭按钮朗读（Web Speech API）。
  //   事件委托：所有 .beaver-w-speak 和 .beaver-ann-speak 按钮统一处理。
  // 生词表原形折叠按钮（.beaver-w-lemma-toggle）同委托处理，
  //   归组查询在展开瞬间发生（toggleLemmaGroup 内部读 _allAnnotations 现场值）。
  _root.addEventListener('click', (e) => {
    const tgl = e.target.closest('.beaver-w-lemma-toggle');
    if (tgl) {
      e.stopPropagation();
      e.preventDefault();
      const item = tgl.closest('.beaver-word-item');
      if (item) toggleLemmaGroup(item);
      return;
    }
    const btn = e.target.closest('.beaver-w-speak, .beaver-ann-speak');
    if (btn) {
      e.stopPropagation();
      e.preventDefault();
      const word = btn.dataset.word;
      if (word) speakWordVideo(word);
    }
  });
}
