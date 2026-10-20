// =============================================================================
// 卡片公共构建（第561次自 panel.js 拆出，src/content/th/card-build.js）
// 职责：悬浮提示 / 右键面板 / 侧栏内嵌查询卡共用的卡片静态构建——
//   buildPanelCss（唯一样式定义）、buildPanelHTML（header 卡）、
//   buildCardInnerHTML（卡体，悬浮/面板/内嵌三处复用）、
//   renderLemmaInto（原形行 + 同族词汇组渲染，原形 chip 已退役）、
//   fillFamilyGroup（同族词汇组填充，自动免点击）。
// 与 panel.js 的关系：panel.js 门面 re-export 本文件导出符号，既有引用方
//   （tooltip.js / ws/ui.js / vs/actions.js）import 路径不变。
// =============================================================================

// 词形还原覆盖语种名单（纯数据无依赖）——无覆盖语种不显示同族组（中/日原形即本身）。
import { LANGUAGES } from '../../lib/vendor/diverse-lemmas/languages.js';
import { t } from '../../lib/i18n.js';
// 用户裁定（"图示字符显示不出来，换成小图标"）：品牌行内联 SVG 小图标由
//   sidebar-topbar.js 唯一定义。
import { brandIconSVG } from '../../lib/sidebar-topbar.js';
// 同族反查（SW LEMMATIZE_FAMILY 消息）：同族词汇组自动填充的数据源
import { lemmaFamily } from '../../lib/lemmatizer.js';

// 目标语言缓存自建（th 模块各自读 storage，不跨模块搬状态）。
let _thLearnLang = 'en';
try {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({ learnLanguage: 'en' }, (res) => {
      if (res && typeof res.learnLanguage === 'string' && res.learnLanguage) _thLearnLang = res.learnLanguage;
    });
    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.learnLanguage && typeof changes.learnLanguage.newValue === 'string' && changes.learnLanguage.newValue) {
          _thLearnLang = changes.learnLanguage.newValue;
        }
      });
    }
  }
} catch (_) { /* 非扩展上下文默认 en */ }

/** 本文件内小 HTML 转义 */
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 目标语是否有词形还原覆盖（diverse-lemmas LANGUAGES 名单为准）
 * @param {string} lang 语言码
 * @returns {boolean}
 */
function supportsLemmaLang(lang) {
  if (!LANGUAGES) return false;
  return Object.prototype.hasOwnProperty.call(LANGUAGES, String(lang || '').toLowerCase());
}

/**
 * 渲染卡片原形行 + 同族词汇组（悬浮提示与右键面板共用，tooltip.js 也调此函数）
 *
 * 第561次二轮（用户裁定"Word family 都默认展开了，还带标签按钮干啥"）：
 *   原形 chip（可点击按钮）退役——同族词汇组常显免点击。第561次三轮（用户裁定
 *   "字段多，都改键值对格式"）：本函数只写各行的 .kv-value 值单元格，字段名在
 *   buildCardInnerHTML 的 .kv-label 静态列。
 * 口径：①有覆盖语种且单词查询 → 同族组常显（查询词加粗置顶 + SW 反查同族异步追加），
 *   原形≠词面时"原形"行显示原形；
 *   ②"首字母大写"——历史 IDB 表层大小写坏档到显示层统一小写（词典惯例）；
 *   ③无覆盖语种仅 lemma≠词面时保留"原形"行（同族组无从反查，不显示）。
 * @param {ShadowRoot} shadow 卡片 shadow root
 * @param {string} word 查询词面
 * @param {string|null} lemma 原形（可空）
 */
export function renderLemmaInto(shadow, word, lemma) {
  if (!shadow) return;
  const row = shadow.querySelector('.lemma-row');
  const box = shadow.querySelector('.lemma-group');
  if (!row || !box) return;
  const rowVal = row.querySelector('.kv-value');
  const boxVal = box.querySelector('.kv-value');
  if (!rowVal || !boxVal) return;
  let lem = String(lemma || '').trim().toLowerCase();
  const wordLower = String(word || '').trim().toLowerCase();
  const single = /^\S+$/.test(String(word || '').trim());
  if (!lem && supportsLemmaLang(_thLearnLang) && single) lem = wordLower;
  if (supportsLemmaLang(_thLearnLang) && lem && single) {
    // 原形行：原形≠词面才显示（原形即词面时信息为零）
    if (lem !== wordLower) {
      rowVal.innerHTML = `<b>${escHtml(lem)}</b>`;
      row.style.display = '';
    } else {
      row.style.display = 'none';
      rowVal.innerHTML = '';
    }
    box.dataset.lemma = lem;
    fillFamilyGroup(box, lem, wordLower);
  } else if (lem && lem !== wordLower) {
    rowVal.innerHTML = `<b>${escHtml(lem)}</b>`;
    row.style.display = '';
    box.style.display = 'none';
    boxVal.innerHTML = '';
  } else {
    row.style.display = 'none';
    rowVal.innerHTML = '';
    box.style.display = 'none';
    boxVal.innerHTML = '';
  }
}

// 同族词预览条数（用户裁定"同族词若过多，那就先显示五个，多了之外再展开"）
const FAMILY_PREVIEW = 5;
// 同族反查上限（swLemmaFamily 硬上限 100；源表更大时展开后以 ", …" 明示截断）
const FAMILY_LIMIT = 100;

/**
 * 填充同族词汇组（renderLemmaInto 常显调用；面板与悬浮共用）
 *
 * 第561次三轮（用户裁定）：先显示五个（查询词/原形置顶加粗计入），超出部分收进
 *   "展开全部（N）"按钮，点击原位展开全量（反查上限 100；源表更大时尾缀 ", …"
 *   如实截断不遮蔽）。
 * 数据源只有词形整表家族（卡片是单查询词，无词表上下文）：lemmaFamily 只要词，
 * 失败保留置顶词预览不报错。
 * @param {HTMLElement} box .lemma-group 行（内含 .kv-value 值单元格）
 * @param {string} key 原形（小写，反查键）
 * @param {string} wordLower 查询词小写（置顶加粗；与 key 不同时两项都列）
 */
function fillFamilyGroup(box, key, wordLower) {
  const boxVal = box.querySelector('.kv-value');
  if (!boxVal) return;
  // 显示本行（二轮回归修复：初始 style="display:none"，漏切则同族词整行不见）
  box.style.display = '';
  const seenF = new Set();
  const head = [];   // 置顶加粗段（查询词/原形）；家族词进 extra，两段互不混写
  const pushHead = (w) => {
    const s = String(w || '').trim().toLowerCase();
    if (!s || seenF.has(s)) return;
    seenF.add(s);
    head.push(s);
  };
  pushHead(wordLower);
  pushHead(key);
  const bold = (w) => `<b>${escHtml(w)}</b>`;
  // 预览渲染：head + 家族词补足到 FAMILY_PREVIEW；剩余数进展开按钮，点击原位展开
  const renderPreview = (extra, total) => {
    const preview = extra.slice(0, Math.max(0, FAMILY_PREVIEW - head.length));
    let html = head.map(bold).join(', ');
    if (preview.length) html += ', ' + preview.map(escHtml).join(', ');
    const shown = head.length + preview.length;
    const remaining = Math.max(0, (total || shown) - shown);
    if (remaining > 0) {
      html += ` <button type="button" class="family-expand">${escHtml(t('th.familyExpand'))}（${remaining}）</button>`;
    }
    boxVal.innerHTML = html;
    const btn = boxVal.querySelector('.family-expand');
    if (btn) {
      btn.onclick = () => {
        let full = head.map(bold).join(', ');
        if (extra.length) full += ', ' + extra.map(escHtml).join(', ');
        if (total > head.length + extra.length) full += '<span class="lemma-more">, …</span>';
        boxVal.innerHTML = full;
      };
    }
  };
  renderPreview([], head.length);
  lemmaFamily(key, _thLearnLang, FAMILY_LIMIT).then((fam) => {
    if (!box.isConnected || box.style.display === 'none') return;
    const extra = [];
    const total = (fam && typeof fam.total === 'number') ? fam.total : head.length;
    for (const w of ((fam && fam.words) || [])) {
      const s = String(w || '').trim().toLowerCase();
      if (!s || seenF.has(s)) continue;
      seenF.add(s);
      extra.push(s);
    }
    renderPreview(extra, total);
  }).catch(() => {
    /* 反查失败保留置顶词预览，无展开按钮 */
  });
}

// === 卡片样式与结构（原 panel.js 段整体平移） ===

/**
 * 查询卡片样式（唯一定义处）：
 * 右键浮动面板、悬浮提示与侧栏 query 标签的内嵌卡片共用同一份 CSS。
 * @returns {string} CSS 文本（不含 <style> 标签）
 */
export function buildPanelCss() {
  return `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .panel-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 14px; background: #f5f8f3; border-radius: 16px 16px 0 0; }
      .panel-header .title { font-size: inherit; color: #1a1f1a; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
      /* 品牌小图标（内联 SVG，替代无字形的 🦫）。本面板是 Shadow DOM，
         顶行样式表（sidebar-topbar.js）不会穿透进来，故此处须自带一份尺寸规则。 */
      .panel-header .title .beaver-brand-icon { width: 16px; height: 16px; flex: 0 0 auto; display: block; color: inherit; }
      .panel-header .title > span { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
      .panel-header .header-stage { display: inline-block; padding: 2px 8px; background: #2e6b43; color: #ffffff; border-radius: 8px; font-size: 12px; white-space: nowrap; flex-shrink: 0; }
      .panel-content { padding: 12px 14px; max-height: var(--panel-max-h, 80vh); overflow-y: auto; }
      .word-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
      .word { font-size: 16px; color: #1a1f1a; font-weight: 600; }
      /* 词阶 header 卡只在 header 右侧显示一次（不挤生词），正文重复的 .stage 隐藏——
         作用域收窄到 .panel-content（第561次二轮）：侧栏内嵌查询卡无 header，此前被
         本规则连带隐藏＝"词频序不见了"，现内嵌卡 .stage 在词行右侧可见 */
      .panel-content .word-row .stage { display: none; }
      .stage { display: inline-block; padding: 2px 8px; background: #2e6b43; color: #ffffff; border-radius: 8px; font-size: 12px; white-space: nowrap; }
      .phonetic-row { font-size: 13px; color: #424942; margin-bottom: 6px;
        /* 用户反馈"注音用的啥字体，咋看不懂"：注音 span 未指定字体时 Shadow DOM 内
           继承宿主页面字体，缺 IPA 扩展区字形即显示豆腐块。统一指定系统字体栈
           （扩展装不到字体文件，只能用系统栈；Segoe UI 是 Win10 默认且 IPA/变音符号
           覆盖最好，其余为回退）。无结果时隐藏整行（"注音有结果才显示"；
           加载中占位符 … 非空故仍显示）。 */
        font-family: "Segoe UI", "Microsoft YaHei", "Noto Sans", "Charis SIL", "Doulos SIL", "Arial Unicode MS", Arial, sans-serif; }
      .phonetic-row:empty { display: none; }
      /* 第561次三轮（用户裁定"字段多，都改键值对格式：左侧字段名、右侧字段内容"）：
         .kv-table 统一两列网格，行 display:contents 铺进网格——所有 .kv-label 落左列、
         .kv-value 落右列，两列边界逐行对齐（不画线，三轮复批：分割线撤除）；
         行的显示/隐藏由 JS 切 style.display（none / '' 回落 contents） */
      .kv-table { display: grid; grid-template-columns: minmax(76px, auto) 1fr; }
      .kv-row { display: contents; }
      .kv-label { font-size: 12px; color: #5a6b5e; padding: 3px 12px 3px 0; display: flex; align-items: flex-start; justify-content: space-between; gap: 4px; }
      .kv-value { padding: 3px 0 3px 10px; font-size: 13px; color: #1a1f1a; line-height: 1.7; word-break: break-word; min-width: 0; }
      .kv-value b { color: #1a1f1a; font-weight: 500; }
      /* 同族词展开按钮（用户裁定"先显示五个，多了之外再展开"） */
      .family-expand { border: 0; background: transparent; color: #2e6b43; cursor: pointer; font-size: 12px; padding: 0 2px; text-decoration: underline; }
      .family-expand:hover { filter: brightness(1.1); }
      .lemma-more { color: #8a918a; }
      /* My Words 标记按钮（🏁=生词/✓=熟词）。默认低调半透明，
         hover 浅绿底；active（该词已在对应表）浅绿底＋描边常亮，一眼可辨当前归属。
         第561次二轮：侧栏内嵌查询卡不再渲染此二按钮（buildCardInnerHTML
         markButtons:false）——侧栏自有 🎯 学词流，卡片标记收敛到悬浮/右键卡 */
      .mark-fresh, .mark-known { border: 0; background: transparent; cursor: pointer; font-size: 13px; line-height: 1; padding: 2px 6px; border-radius: 6px; opacity: 0.8; }
      .mark-fresh:hover, .mark-known:hover { background: #e4efe6; opacity: 1; }
      .mark-fresh.active, .mark-known.active { background: #d1e8d8; opacity: 1; box-shadow: inset 0 0 0 1px rgba(13,32,20,.22); }
      .trans-row { color: #1a1f1a; line-height: 1.7;
        /* 用户反馈"文本侧栏的字号正常，查询窗口可以参考"：trans-row 未指定字号时
           Shadow DOM 内继承宿主页面字号（网页正文字号多大释义就多大）；对齐文本侧栏
           sidebar.css 正文 16px 写死方案，查询卡不再随网页缩放。 */
        font-size: 16px; }
      .trans-row div { margin-bottom: 6px; }
      .tags-row { display: flex; flex-wrap: wrap; gap: 4px; }
      /* 词表标签浅色底（用户："词表标签用浅色底，就跟侧栏中那样"）——对齐侧栏
         beaver-w-tags/beaver-ann-tags（sidebar.css --beaver-secondary-container
         #d1e8d8 / on #0d2014），不用深绿底白字 */
      /* 用户报障"词表标签……现在直接消失了"：加 1px 深绿描边增强 chip 与浅底的对比
         （防"浅底淹没在卡片底色里"的视觉消失），渲染处另有 console 诊断日志 */
      .tag { display: inline-block; padding: 3px 10px; background: #d1e8d8; color: #0d2014; border: 1px solid rgba(13,32,20,.22); border-radius: 8px; font-size: 12px; }
      .footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid #e9eee7; margin-top: 6px; }
      .speak { padding: 8px 16px; background: #2e6b43; color: #fff; border: 0; border-radius: 8px; cursor: pointer; font-size: inherit; white-space: nowrap; }
      .speak:hover { filter: brightness(1.1); }
      /* footer 右侧 chat 按钮（与朗读按钮同视觉，footer 为 space-between 故左右分列） */
      .chat { padding: 8px 16px; background: #2e6b43; color: #fff; border: 0; border-radius: 8px; cursor: pointer; font-size: inherit; white-space: nowrap; }
      .chat:hover { filter: brightness(1.1); }
      /* 用户要求"底部中间增加按钮 show in page，将释义插入页面"：footer 三按钮
         space-between 自动左中右分布。用户裁定"所有查询表面一律绑定插入并显示按钮" */
      .show-page { padding: 8px 16px; background: #2e6b43; color: #fff; border: 0; border-radius: 8px; cursor: pointer; font-size: inherit; white-space: nowrap; }
      .show-page:hover { filter: brightness(1.1); }
      .dots { display: inline-flex; gap: 4px; align-items: center; padding: 4px 0; }
      .dots i { width: 5px; height: 5px; border-radius: 50%; background: #424942; opacity: 0.25; animation: beaver-dots 1.2s infinite ease-in-out; }
      .dots i:nth-child(2) { animation-delay: 0.2s; }
      .dots i:nth-child(3) { animation-delay: 0.4s; }
      @keyframes beaver-dots { 0%, 60%, 100% { opacity: 0.25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }
    `;
}

export function buildPanelHTML() {
  return `
    <style>${buildPanelCss()}</style>
    <div class="panel-header">
      <div class="title">${brandIconSVG()}<span>${t('th.brand')}</span></div>
      <div class="header-stage"></div>
    </div>
    <div class="panel-content">
      ${buildCardInnerHTML()}
    </div>
  `;
}

/**
 * 公共内容结构（面板/悬浮提示/侧栏内嵌查询卡共用）
 * @param {{markButtons?: boolean}} [opts] markButtons=false 时不渲染 🏁/✓
 *   My Words 标记按钮（第561次二轮，用户裁定"多了一个添加生词按钮"：侧栏内嵌
 *   查询卡不再带标记按钮——侧栏自有生词管理，标记收敛到悬浮/右键卡；
 *   缺省渲染，右键面板与悬浮提示不受影响）
 * @returns {string}
 */
export function buildCardInnerHTML(opts) {
  const mark = !(opts && opts.markButtons === false);
  return `
    <div class="word-row">
      <span class="word"></span>
      <span class="stage"></span>
      ${mark ? `<button type="button" class="mark-fresh" title="${t('th.markFresh')}">🏁</button>` : ''}
    </div>
    <div class="phonetic-row"></div>
    <!-- 第561次三轮（用户裁定"字段多，都改键值对格式"）：字段名左列（.kv-label）、
         内容右列（.kv-value），label 右描边为对齐分割线；行显隐由各渲染方切 display -->
    <div class="kv-table">
      <div class="kv-row lemma-row" style="display:none">
        <div class="kv-label">${t('th.lemma')}</div>
        <div class="kv-value"></div>
      </div>
      <div class="kv-row lemma-group" style="display:none">
        <div class="kv-label">${t('th.familyWords')}</div>
        <div class="kv-value"></div>
      </div>
      <div class="kv-row related-row" style="display:none">
        <div class="kv-label">${t('th.relatedWords')}</div>
        <div class="kv-value"></div>
      </div>
      <div class="kv-row trans-section">
        <div class="kv-label">${t('th.definition')}${mark ? `<button type="button" class="mark-known" title="${t('th.markKnown')}">✓</button>` : ''}</div>
        <div class="kv-value"><div class="trans-row"></div></div>
      </div>
      <div class="kv-row tags-section" style="display:none">
        <div class="kv-label">${t('th.tags')}</div>
        <div class="kv-value"><div class="tags-row"></div></div>
      </div>
    </div>
    <div class="footer">
      <button class="speak">🔊</button>
      <!-- footer 中部 show in page。用户裁定"按钮应当是便签图标🗒️。图标不需要翻译"：emoji 图标，语义进 title -->
      <button class="show-page" title="${t('btn.showInPage')}">🗒️</button>
      <button class="chat" title="${t('btn.chat')}">💬</button>
    </div>
  `;
}
