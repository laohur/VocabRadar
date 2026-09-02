// 文本提示 · 面板模块（右键查词面板 + OCR 结果面板）
//
// === 拆分说明（2026-08-28）===
// 来源：src/content/text-hint-impl.js（2390 行）机械拆分，逻辑与行为零改动。
// 本文件职责：
//   1. 右键查词面板（#beaver-context-panel，Shadow DOM）：结构构建、创建、
//      显示/隐藏、定位（两遍法 + 动态 max-height）、面板用词条查询
//   2. OCR 结果面板（#beaver-ocr-panel，light DOM 便于 TreeWalker 扫描）：
//      创建、显示/隐藏、定位、视频截帧 OCR 入口
//   3. 卡片公共内容结构 buildCardInnerHTML（悬浮提示复用）
//
// 共享状态一律取自 core.js 的 thState（唯一属主），本文件不再声明任何同名变量。
// 模块级副作用：ensurePanel 的 document mousedown(capture)/keydown、
//   ensureOcrPanel 的 document mousedown(capture)/keydown——均由 `if (_xxx) return`
//   幂等守卫保证只注册一次，与拆分前完全一致。
//
// 跨模块调用（受控循环 import，两端均为函数声明，顶层不调用）：
//   → tooltip.js: hideTooltip（ensurePanel 的 mousedown 同时管 tooltip 与 panel）
//   → scan.js: processTextNode（OCR 文本注释生词）
import { lookupFull } from '../../lib/dictionary.js';
import { translate, getLastTranslateChannel } from '../../lib/translator.js';
import { t } from '../../lib/i18n.js';
import { getPhonetic } from '../../lib/phonetics.js';
import {
  thState, PANEL_ID, OCR_PANEL_ID, HIGHLIGHT_CLASS, PROCESSED_ATTR,
  formatStage, isContextValid, syncBodyFontSize, speak
} from './core.js';
import { hideTooltip } from './tooltip.js';
import { processTextNode } from './scan.js';
// 第一百七十一次：右键查词面板底部 chat 按钮 —— 对话面板唯一实现在 lib/chat.js
import { CHAT_PANEL_ID, openChatPanel } from '../../lib/chat.js';
// 第一百八十六次：对话上下文的网页正文来源（Readability 优先），唯一实现在 lib/main-text.js
import { getAiMainText } from '../../lib/main-text.js';
// 第一百七十六次（用户："图示字符显示不出来，换成小图标"，裁定范围含扩展自身界面标题）：
//   原品牌前缀 🦫（U+1F9AB）在 Windows 10 旧版 Segoe UI Emoji 无字形，渲染成豆腐块；
//   改用侧栏顶行同款内联 SVG 小图标，由 sidebar-topbar.js 唯一定义。
import { brandIconSVG } from '../../lib/sidebar-topbar.js';

/**
 * 显示右键菜单查词面板
 * @param {string} text 用户选中的文本
 */
export function showContextPanel(text, clientX, clientY) {
  const trimmed = text.trim();
  if (!trimmed) return;
  ensurePanel();
  syncBodyFontSize(thState.panel);

  let word = trimmed;
  // 第一百一十一次（用户裁定算法，撤销第一百一十次的"空白/长度即句子"启发式）：
  // ①先查词典 ②词典外才翻译 ③翻译后分词——多词仅翻译；单词则翻译入词典并补全其他属性。
  // word 不再预抽取：词典命中用选区原文；词典外走翻译分支。
  // 反思（2026-08-13）：用户要求"日志应当有意义，写当前有啥，还要查啥"。
  //   旧日志 "右键查词: learning (选区: learning)" 是废话——选区就是词本身。
  //   修正：先查 IDB 已有数据，日志输出已有字段 + 待查字段。
  //   实际查询在下面的 async 块中完成，此处仅记录入口。

  const shadow = thState.panel.shadowRoot;
  // 反思（2026-08-13 第四十九次）：panel-header 固定显示品牌（左）+ 词阶（右，靠右不挤生词）。
  //   品牌只此一处，footer 品牌已移除，消除 Edge 中"两个产品名称"问题。
  //   正文 .word 显示查询词；正文 .word-row 的 .stage 由 CSS 隐藏（词阶只在 header 出现一次）。
  shadow.querySelector('.panel-header .header-stage').textContent = '';
  shadow.querySelector('.word').textContent = word;
  // 反思（2026-08-13）：用户禁止"Querying..."/"No definition"等歧义文案。
  //   翻译未到时留空，不显示占位文字。翻译失败也留空，不自作主张。
  shadow.querySelector('.phonetic-row').textContent = '';
  shadow.querySelector('.stage').textContent = '';
  shadow.querySelector('.lemma-row').innerHTML = '';
  shadow.querySelector('.tags-row').innerHTML = '';
  const tagsSection = shadow.querySelector('.tags-section');
  if (tagsSection) tagsSection.style.display = 'none';
  shadow.querySelector('.trans-row').textContent = '';

  thState.panel.style.display = 'block';
  positionPanel(clientX, clientY);

  // 音标异步加载（词典命中路径用；词典外分支在 async 块内自行处理/清空）
  if (word && isContextValid()) {
    getPhonetic(word).then((phon) => {
      if (thState.panel && thState.panel.style.display !== 'none') {
        shadow.querySelector('.phonetic-row').textContent = phon || '';
        if (clientX !== null && clientX !== undefined) positionPanel(clientX, clientY);
      }
    }).catch(() => {
      shadow.querySelector('.phonetic-row').textContent = '';
    });
  }

  (async () => {
    const lower = word.toLowerCase();
    // 第一百一十一次：①先查词典（lookupFull 含词形还原重试；OOV 返回 null）
    let fullRec = null;
    try { fullRec = await lookupFull(lower); } catch (e) { fullRec = null; }

    if (!fullRec) {
      // ②词典外 → 翻译整个选区
      shadow.querySelector('.phonetic-row').textContent = '';
      shadow.querySelector('.trans-row').innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
      let translated = null;
      try { translated = isContextValid() ? await translate(trimmed, true) : null; } catch (e) { translated = null; }
      if (thState.panel && thState.panel.style.display !== 'none') {
        shadow.querySelector('.trans-row').textContent = translated || '';
        const ch = getLastTranslateChannel();
        console.log(`[VocabRadar][text-hint] 右键翻译(词典外, len=${trimmed.length}): ${translated ? '成功' : '失败'}${ch ? ' 渠道:' + ch : ''}`);
      }
      // ③翻译后分词：多词仅翻译；单词则入词典并补全属性
      //   （translate 已把译文写回统一词典；queryWordForPanel 组装 rank/lemma/tags 写回 IDB；getPhonetic 补音标）
      const tokens = String(trimmed).split(/[\s\u3000]+/).filter((s) => /[A-Za-z\u00C0-\u024F]/.test(s));
      const isMultiWord = tokens.length > 1 || trimmed.length > 24;
      if (!isMultiWord && translated && isContextValid()) {
        const info = await queryWordForPanel(lower, trimmed);
        if (info && info.isWord && thState.panel && thState.panel.style.display !== 'none') {
          let stg = formatStage(info.rank);
          if (stg.indexOf('NaN') !== -1) stg = t('th.outside');
          shadow.querySelector('.stage').textContent = stg;
          shadow.querySelector('.panel-header .header-stage').textContent = stg;
          const lemmaEl2 = shadow.querySelector('.lemma-row');
          const lemma2 = (info.lemma || '').trim();
          lemmaEl2.innerHTML = (lemma2 && lemma2.toLowerCase() !== trimmed.toLowerCase()) ? `${t('th.lemma')}: <b>${lemma2}</b>` : '';
          if (info.phonetic) {
            shadow.querySelector('.phonetic-row').textContent = info.phonetic;
          } else {
            getPhonetic(trimmed).then((phon) => {
              if (thState.panel && thState.panel.style.display !== 'none') shadow.querySelector('.phonetic-row').textContent = phon || '';
            }).catch(() => {});
          }
        }
      }
      if (clientX !== null && clientX !== undefined) positionPanel(clientX, clientY);
      return;
    }

    // ④词典命中：沿用单词面板流程
    // 反思（2026-08-12 第四十二次）：queryWordForPanel 从统一词典 IDB 读取完整记录，
    //   返回时 rank/tags/lemma/phonetic 已就绪，translation 可能是缓存的或 pending。
    //   不再阻塞等待翻译完成——有啥先显示啥，翻译异步填充。
    const info = await queryWordForPanel(lower, word);
    if (info && info.isWord) {
      // === 立即显示 rank/tags/lemma（来自 IDB，不等待翻译）===
      let stage = formatStage(info.rank);
      if (stage.indexOf('NaN') !== -1) stage = t('th.outside');
      shadow.querySelector('.stage').textContent = stage;
      shadow.querySelector('.panel-header .header-stage').textContent = stage;
      // 词形还原原形
      const lemmaEl = shadow.querySelector('.lemma-row');
      const lemma = (info.lemma || '').trim();
      if (lemma && lemma.toLowerCase() !== word.toLowerCase()) {
        lemmaEl.innerHTML = `${t('th.lemma')}: <b>${lemma}</b>`;
      } else {
        lemmaEl.innerHTML = '';
      }
      // 标签
      const tagsEl = shadow.querySelector('.tags-row');
      tagsEl.innerHTML = '';
      const tags = info.tags || [];
      if (tagsSection) tagsSection.style.display = tags.length > 0 ? '' : 'none';
      tags.forEach((tag) => {
        const span = document.createElement('span');
        span.className = 'tag';
        span.textContent = tag;
        tagsEl.appendChild(span);
      });
      // 反思（2026-08-13）：翻译结果显示——
      //   已缓存则直接显示；pending 则显示浮动省略号（动画三点），翻译完成替换；
      //   翻译失败移除省略号留空，不显示"No definition"。
      const trans = info.translations || [];
      if (trans.length > 0) {
        shadow.querySelector('.trans-row').innerHTML = trans.map(tr => `<div>${tr}</div>`).join('');
      } else if (info.pending) {
        shadow.querySelector('.trans-row').innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
        if (clientX !== null && clientX !== undefined) positionPanel(clientX, clientY);
        if (isContextValid()) {
          translate(word, true).then((translated) => {
            if (thState.panel && thState.panel.style.display !== 'none') {
              if (translated) {
                shadow.querySelector('.trans-row').innerHTML = `<div>${translated}</div>`;
                // 反思（2026-08-13 第五十二次）：日志标注翻译渠道（本地缓存/内置翻译/在线:xxx），
                //   用户要求"日志能看出翻译渠道"。
                const ch = getLastTranslateChannel();
                console.log(`[VocabRadar][text-hint] 右键查词 "${lower}": 翻译完成 → "${translated}"${ch ? ` (渠道:${ch})` : ''}`);
              } else {
                shadow.querySelector('.trans-row').textContent = '';
                console.warn(`[VocabRadar][text-hint] 右键查词 "${lower}": 翻译失败（所有渠道均未返回结果）`);
              }
              if (clientX !== null && clientX !== undefined) positionPanel(clientX, clientY);
            }
          }).catch(() => {
            if (thState.panel && thState.panel.style.display !== 'none') {
              shadow.querySelector('.trans-row').textContent = '';
            }
          });
        }
      } else {
        shadow.querySelector('.trans-row').textContent = '';
      }
    } else {
      shadow.querySelector('.stage').textContent = t('th.notWord');
      shadow.querySelector('.panel-header .header-stage').textContent = t('th.notWord');
      shadow.querySelector('.trans-row').textContent = '';
    }
    if (clientX !== null && clientX !== undefined) {
      positionPanel(clientX, clientY);
    }
  })();

  shadow.querySelector('.speak').onclick = () => speak(word);
  // 第一百七十一次：chat 按钮就"选区原文"发起对话（不是词元，保留用户实际选中的上下文）
  // 第一百八十四次：传 kind='word' —— 右键查询属"单词类查询"，用 chatWordPrompt 模板
  // 第一百八十六次（用户："对话框的上下文依旧胡说。老毛病，并不是第一次出现。
  //   你复述一遍我的要求上下文来源。"）：按 note.txt 原始规定，上下文框的正文**只有两种来源**
  //   —— Readability 提取的网页正文，或字幕。选区原文只能进提问语的 {}，绝不能当上下文。
  //   故此处第三参传 getAiMainText() 的网页正文；提取失败则退回选区原文（不静默留空）。
  const chatBtn = shadow.querySelector('.chat');
  if (chatBtn) chatBtn.onclick = async () => {
    let ctxBody = '';
    try {
      const m = await getAiMainText();
      ctxBody = String((m && m.text) || '');
    } catch (e) {
      console.warn('[VocabRadar][th-panel] 取网页正文失败，上下文退回选区原文:', e);
    }
    openChatPanel(trimmed, 'word', ctxBody || trimmed);
  };
}

// 反思（2026-07-07）：用户要求"右键查询弹出框应当在当前位置"。
// 旧版 left = clientX - rect.width/2（水平居中于点击点），不符合"在当前位置"的预期。
// 修正：面板左上角放在右键点击位置（如系统右键菜单），右侧/下方溢出时翻转到左侧/上方。
// panel 已改为 position:fixed，clientX/clientY 是视口坐标，无需加 scrollX/scrollY。
// 反思（2026-08-06 修正）：用户反馈"右键查询，边上窗口显示不全"，并要求
//   "页面底部向上展示，页面顶部向下展示"。
//   根因：1) 面板无 max-height，释义多时高度超过视口底部被裁切；
//         2) 异步内容（释义/标签）加载后面板变高，未重新定位 → 底部溢出。
//   修正：比较点击点上下可用空间，空间大的一侧作为展开方向（顶部→向下，底部→向上）；
//         动态 max-height 限制面板高度，内容区滚动；两遍法定位（设 max-height → 重排
//         → 测实际高度 → 锚定点击点）。异步内容加载后需再次调用本函数重定位。
export function positionPanel(clientX, clientY) {
  if (!thState.panel) return;
  const MARGIN = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = (typeof clientX === 'number') ? clientX : MARGIN;
  let top = (typeof clientY === 'number') ? clientY : MARGIN;

  // 水平：测宽度后右侧溢出翻转到左侧 + 兜底
  let rect = thState.panel.getBoundingClientRect();
  if (left + rect.width > vw - MARGIN) left = left - rect.width;
  left = Math.max(MARGIN, Math.min(left, vw - rect.width - MARGIN));

  // 垂直方向：比较点击点上下可用空间，空间大的一侧展开
  //   下方空间大（点击在上半部）→ 向下展开，顶部锚定点击点
  //   上方空间大（点击在下半部）→ 向上展开，底部锚定点击点
  const spaceBelow = vh - top - MARGIN;
  const spaceAbove = top - MARGIN;
  const downward = spaceBelow >= spaceAbove;
  const maxH = Math.max(120, downward ? spaceBelow : spaceAbove);

  // 第一遍：设 max-height 触发重排，临时定位避免闪烁
  thState.panel.style.setProperty('--panel-max-h', maxH + 'px');
  thState.panel.style.left = left + 'px';
  thState.panel.style.top = (downward ? top : Math.max(MARGIN, top - maxH)) + 'px';

  // 第二遍：重测受 max-height 约束后的实际高度，锚定到点击点
  rect = thState.panel.getBoundingClientRect();
  if (downward) {
    // 向下：顶锚定点击点，底部不超出视口
    top = Math.min(top, vh - rect.height - MARGIN);
    if (top < MARGIN) top = MARGIN;
  } else {
    // 向上：底锚定点击点
    top = top - rect.height;
    if (top < MARGIN) top = MARGIN;
  }
  thState.panel.style.top = top + 'px';
}

/**
 * 查询单词（右键面板用），返回完整信息（不受词频阈值限制）
 *
 * 反思（2026-08-12 第四十二次）：右键查词面板不再阻塞等待翻译。
 * 此函数不阻塞翻译：返回时 rank/tags/lemma/phonetic 已就绪，
 *   translation 可能是缓存的（pending=false）或待查询的（pending=true）。
 *   调用方根据 pending 决定是否显示"查询中…"并异步获取翻译。
 *
 * @param {string} lower 小写单词
 * @param {string} original 原始大小写
 * @returns {Promise<{isWord,rank,tags,lemma,translations,pending,phonetic}>}
 */
export async function queryWordForPanel(lower, original) {
  // 从统一词典 IDB 读取完整记录（rank/lemma/tags/translation/phonetic）
  const full = await lookupFull(lower);
  const rank = full ? full.rank : null;
  const tags = full ? (full.tags || []) : [];
  const lemma = full ? full.lemma : null;
  const phonetic = full ? full.phonetic : null;

  // 检查 IDB 中是否已有有效翻译（语言匹配）
  if (full && full.translation && full.translationLang === thState.targetLang) {
    // 翻译缓存命中，直接返回
    console.log(`[VocabRadar][text-hint] 右键查词 "${lower}": IDB缓存命中 (rank=${rank}, tags=[${tags.join(',')}], lemma=${lemma || '无'}, phonetic=${phonetic ? '已缓存' : '无'}, translation="${full.translation}")`);
    return { isWord: true, rank, tags, lemma, translations: [full.translation], pending: false, phonetic };
  }

  // 翻译未缓存或语言不匹配，标记 pending
  const known = [];
  if (rank !== null) known.push(`rank=${rank}`);
  if (tags.length > 0) known.push(`tags=[${tags.join(',')}]`);
  if (lemma) known.push(`lemma=${lemma}`);
  if (phonetic) known.push(`phonetic=已缓存`);
  console.log(`[VocabRadar][text-hint] 右键查词 "${lower}": 已知=[${known.join(', ') || '无'}], 待查翻译(${thState.targetLang})`);
  return { isWord: true, rank, tags, lemma, translations: [], pending: true, phonetic };
}

// === 面板 HTML 构建 ===
// 反思（2026-08-13 第四十九次）：header 显示品牌 + 词阶（右上角，靠右不挤生词）。
//   正文重复的 .stage 用 CSS .word-row .stage { display:none } 隐藏（词阶只显示一次）。
// 反思（2026-08-13 第四十九次）：用户要求"翻译结果若在查询中，则应当是浮动省略号"。
//   修正：新增 .dots 三点跳动动画，pending 时插入 trans-row，翻译完成移除。
export function buildPanelHTML() {
  return `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .panel-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 14px; background: #f5f8f3; border-radius: 16px 16px 0 0; }
      .panel-header .title { font-size: inherit; color: #1a1f1a; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
      /* 第一百七十六次：品牌小图标（内联 SVG，替代无字形的 🦫）。本面板是 Shadow DOM，
         顶行样式表（sidebar-topbar.js）不会穿透进来，故此处须自带一份尺寸规则。 */
      .panel-header .title .beaver-brand-icon { width: 16px; height: 16px; flex: 0 0 auto; display: block; color: inherit; }
      .panel-header .title > span { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
      .panel-header .header-stage { display: inline-block; padding: 2px 8px; background: #2e6b43; color: #ffffff; border-radius: 8px; font-size: 0.85em; white-space: nowrap; flex-shrink: 0; }
      .panel-content { padding: 12px 14px; max-height: var(--panel-max-h, 80vh); overflow-y: auto; }
      .word-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
      .word { font-size: 1.15em; color: #1a1f1a; font-weight: 600; }
      /* 反思（2026-08-13 第四十九次）：词阶只在 header 右侧显示一次（不挤生词），正文重复的 .stage 隐藏 */
      .word-row .stage { display: none; }
      .stage { display: inline-block; padding: 2px 8px; background: #2e6b43; color: #ffffff; border-radius: 8px; font-size: 0.85em; white-space: nowrap; }
      .phonetic-row { font-size: 0.95em; color: #424942; margin-bottom: 6px; }
      .lemma-row { font-size: 0.85em; color: #424942; margin-bottom: 8px; }
      .lemma-row b { color: #1a1f1a; font-weight: 500; }
      .section { margin-bottom: 10px; }
      .section-label { font-size: 0.85em; color: #424942; margin-bottom: 4px; }
      .trans-row { color: #1a1f1a; line-height: 1.7; }
      .trans-row div { margin-bottom: 6px; }
      .tags-row { display: flex; flex-wrap: wrap; gap: 4px; }
      .tag { display: inline-block; padding: 3px 10px; background: #2e6b43; color: #ffffff; border-radius: 8px; font-size: 0.85em; }
      .footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid #e9eee7; margin-top: 6px; }
      .speak { padding: 8px 16px; background: #2e6b43; color: #fff; border: 0; border-radius: 8px; cursor: pointer; font-size: inherit; white-space: nowrap; }
      .speak:hover { filter: brightness(1.1); }
      /* 第一百七十一次：footer 右侧新增 chat 按钮（与朗读按钮同视觉，footer 为 space-between 故左右分列） */
      .chat { padding: 8px 16px; background: #2e6b43; color: #fff; border: 0; border-radius: 8px; cursor: pointer; font-size: inherit; white-space: nowrap; }
      .chat:hover { filter: brightness(1.1); }
      .dots { display: inline-flex; gap: 4px; align-items: center; padding: 4px 0; }
      .dots i { width: 5px; height: 5px; border-radius: 50%; background: #424942; opacity: 0.25; animation: beaver-dots 1.2s infinite ease-in-out; }
      .dots i:nth-child(2) { animation-delay: 0.2s; }
      .dots i:nth-child(3) { animation-delay: 0.4s; }
      @keyframes beaver-dots { 0%, 60%, 100% { opacity: 0.25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }
    </style>
    <div class="panel-header">
      <div class="title">${brandIconSVG()}<span>${t('th.brand')}</span></div>
      <div class="header-stage"></div>
    </div>
    <div class="panel-content">
      ${buildCardInnerHTML()}
    </div>
  `;
}
// 公共内容结构（面板和悬浮提示共用）
export function buildCardInnerHTML() {
  return `
    <div class="word-row">
      <span class="word"></span>
      <span class="stage"></span>
    </div>
    <div class="phonetic-row"></div>
    <div class="lemma-row"></div>
    <div class="section">
      <div class="section-label">${t('th.definition')}</div>
      <div class="trans-row"></div>
    </div>
    <div class="section tags-section">
      <div class="section-label">${t('th.tags')}</div>
      <div class="tags-row"></div>
    </div>
    <div class="footer">
      <button class="speak">🔊</button>
      <button class="chat" title="${t('btn.chat')}">💬</button>
    </div>
  `;
}

export function ensurePanel() {
  if (thState.panel) return;
  thState.panel = document.createElement('div');
  thState.panel.id = PANEL_ID;
  thState.panel.style.cssText = `
    position: fixed !important;
    z-index: 2147483647 !important;
    background: #fbfdf9 !important;
    color: #1a1f1a !important;
    border-radius: 16px !important;
    box-shadow: 0 4px 12px rgba(26,31,26,.12), 0 1px 3px rgba(26,31,26,.08) !important;
    padding: 0 !important;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif !important;
    font-size: inherit;
    line-height: 1.5 !important;
    min-width: 280px !important;
    max-width: 400px !important;
    display: none !important;
  `;
  const shadow = thState.panel.attachShadow({ mode: 'open' });
  shadow.innerHTML = buildPanelHTML();
  document.documentElement.appendChild(thState.panel);
  // 反思（2026-07-07）：用户反馈"右键的查询菜单无法消失，应当点击别处自动消失"。
  // 旧版只有 e.target === thState.panel（几乎不触发，因 thState.panel 内有 shadow DOM 子元素）
  // 和 Escape 键关闭。新增 document mousedown 监听器（capture 阶段），
  // 点击面板外部时自动关闭。用 composedPath 处理 shadow DOM boundary。
  // 反思（2026-08-05 修正）：用户反馈"右键查询，点击播放之后浮窗消失了"。
  //   根因：旧版 thState.panel.addEventListener('click', (e) => { if (e.target === thState.panel) hidePanel(); })
  //   当点击 shadow DOM 内的 🔊 speak 按钮时，click 事件冒泡到 thState.panel 时 e.target 被
  //   重定向到 shadow host（即 thState.panel 本身），导致 e.target === thState.panel 为 true，
  //   错误调用 hidePanel() 关闭面板。
  //   修正：移除该监听器。点击外部关闭已由 document mousedown capture 监听器处理
  //   （使用 composedPath 正确识别 shadow DOM 内部点击），不需要重复监听。
  // 反思（2026-07-07 → 2026-07-26 修正）：
  //   旧版把 _panelHideDelay（hover tooltip 的 mouseleave 延迟）错误复用到 panel 点击外部，
  //   导致点击外部延迟5秒才关闭，用户感觉"点击别处不消失"。
  //   用户明确："右键的查询菜单应当点击别处自动消失"——立即关闭。
  //   _panelHideDelay 仅用于 hover tooltip 的 mouseleave（onWordLeave），不再用于 panel。
  // 反思（2026-07-26 二次修正）：用户反馈"依旧点别处不消失"。
  //   根因：上版只给 panel 加了点击外部关闭，但 hover tooltip（飘窗）没有该逻辑——
  //   点击别处只靠 mouseleave 5秒延迟，用户感觉"不消失"。
  //   优先级：点击外部=主动操作，立即隐藏；mouseleave=默认操作，5秒延迟。
  //   点击生词 span 不隐藏 tooltip（让 onWordHover/onWordClick 处理，避免点击朗读时 tooltip 闪掉）。
  document.addEventListener('mousedown', (e) => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    // 第一百七十一次：点击 Chat 面板（独立 fixed 浮层，不在 panel/tooltip 的 DOM 内）
    //   不应关闭右键面板与悬浮提示，否则用户在对话框里打字会把来源卡片关掉。
    const onChat = path.some((el) => el && el.id === CHAT_PANEL_ID);
    if (onChat) return;
    // hover tooltip：点击 tooltip 内部或生词 span 不隐藏；其他点击立即隐藏
    if (thState.tooltip && thState.tooltip.style.display !== 'none') {
      const onTooltip = path.indexOf(thState.tooltip) !== -1;
      const onWord = path.some((el) => el && el.classList && el.classList.contains(HIGHLIGHT_CLASS));
      if (!onTooltip && !onWord) hideTooltip();
    }
    // 右键面板：点击 panel 内部不隐藏；其他点击立即隐藏
    if (thState.panel && thState.panel.style.display !== 'none') {
      if (path.indexOf(thState.panel) === -1) hidePanel();
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && thState.panel.style.display !== 'none') hidePanel();
  });
}

export function hidePanel() {
  if (thState.panel) thState.panel.style.display = 'none';
}

// === OCR 结果面板（2026-08-05）===
// 右键图片/视频 OCR 识别结果展示，light DOM（非 Shadow），文本节点可被 TreeWalker 扫描注释生词
// 不自动消失（onScrollHide 不隐藏 thState.ocrPanel），仅关闭按钮/Escape/点击外部关闭
// 反思：用户要求"识别结果受文本提示，不自动消失"——OCR 文本经过生词高亮+侧邻注释

/**
 * 创建 OCR 结果面板（light DOM）
 * 结构：header(标题+关闭按钮) + content(.beaver-ocr-text 文本节点)
 * 文本节点会被 processTextNode 注释生词（手动调 scanSubtree）
 */
export function ensureOcrPanel() {
  if (thState.ocrPanel) return;
  thState.ocrPanel = document.createElement('div');
  thState.ocrPanel.id = OCR_PANEL_ID;
  thState.ocrPanel.style.cssText = `
    position: fixed !important;
    z-index: 2147483647 !important;
    background: #fbfdf9 !important;
    color: #1a1f1a !important;
    border-radius: 16px !important;
    box-shadow: 0 4px 12px rgba(26,31,26,.12), 0 1px 3px rgba(26,31,26,.08) !important;
    padding: 0 !important;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif !important;
    font-size: 14px !important;
    line-height: 1.6 !important;
    min-width: 300px !important;
    max-width: 480px !important;
    display: none !important;
    overflow: hidden !important;
    flex-direction: column !important;
  `;
  thState.ocrPanel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#f5f8f3;border-radius:16px 16px 0 0;flex-shrink:0;">
      <span style="font-size:0.95em;color:#424942;display:inline-flex;align-items:center;gap:6px;">${brandIconSVG()}<span>VocabRadar · OCR 识别结果</span></span>
      <button class="beaver-ocr-close" style="background:none;border:0;cursor:pointer;font-size:18px;color:#424942;padding:0 4px;">✕</button>
    </div>
    <div class="beaver-ocr-text" style="padding:12px 14px;overflow-y:auto;flex:1 1 auto;white-space:pre-wrap;word-break:break-word;"></div>
  `;
  document.documentElement.appendChild(thState.ocrPanel);
  // 关闭按钮
  thState.ocrPanel.querySelector('.beaver-ocr-close').addEventListener('click', () => hideOcrPanel());
  // 点击外部关闭（mousedown capture 阶段，与 thState.panel 一致）
  document.addEventListener('mousedown', (e) => {
    if (thState.ocrPanel && thState.ocrPanel.style.display !== 'none') {
      const path = e.composedPath ? e.composedPath() : [e.target];
      if (path.indexOf(thState.ocrPanel) === -1) hideOcrPanel();
    }
  }, true);
  // Escape 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && thState.ocrPanel && thState.ocrPanel.style.display !== 'none') hideOcrPanel();
  });
}

export function hideOcrPanel() {
  if (thState.ocrPanel) thState.ocrPanel.style.display = 'none';
}

/**
 * 显示 OCR 结果面板
 * @param {string} text OCR 识别文本
 * @param {number} clientX 右键点击 X（视口坐标）
 * @param {number} clientY 右键点击 Y
 * @param {string} info 提示信息（如"未识别到文字"，text 为空时显示）
 * 反思（2026-08-05）：识别文本放入 .beaver-ocr-text 文本节点，手动调 scanSubtree
 *   注释生词（侧邻注释+高亮）。不自动消失，关闭按钮/Escape/点击外部关闭。
 */
export function showOcrResultPanel(text, clientX, clientY, info = '') {
  ensureOcrPanel();
  const textEl = thState.ocrPanel.querySelector('.beaver-ocr-text');
  // 清空旧内容（含已注释的 .beaver-word span）
  textEl.innerHTML = '';
  if (!text || !text.trim()) {
    textEl.textContent = info || '未识别到文字';
    textEl.style.color = '#72797a';
    textEl.style.fontStyle = 'italic';
  } else {
    textEl.textContent = text.trim();
    textEl.style.color = '';
    textEl.style.fontStyle = '';
    // 手动调 scanSubtree 注释生词（侧邻注释+高亮）
    // 反思：scanSubtree 跳过 #beaver-ocr-panel（防递归），但这里直接对 textEl 调用
    //   processTextNode 注释其文本节点。若文本提示未启用（thState.enabled=false）则不注释。
    if (thState.enabled) {
      // 标记 textEl 未处理，让 TreeWalker 接受
      textEl.removeAttribute(PROCESSED_ATTR);
      // 遍历 textEl 的文本节点并注释
      const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      // processTextNode 是 async，串行处理
      (async () => {
        for (const tn of nodes) {
          if (!thState.enabled) break;
          if (!tn.isConnected) continue;
          await processTextNode(tn);
        }
        // 反思（2026-08-06）：注释生词后面板高度变化，重新定位避免溢出
        if (clientX !== null && clientX !== undefined) {
          positionOcrPanel(clientX, clientY);
        }
      })();
    }
  }
  thState.ocrPanel.style.display = 'flex';
  positionOcrPanel(clientX, clientY);
}

// 反思（2026-08-06 修正）：与 positionPanel 同步采用方向定位 + 动态 max-height。
//   OCR 文本经 scanSubtree 异步注释生词后面板高度变化，需重新定位。
//   比较点击点上下空间：上方大→向上展开（底锚定），下方大→向下展开（顶锚定）。
export function positionOcrPanel(clientX, clientY) {
  if (!thState.ocrPanel) return;
  const MARGIN = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = (typeof clientX === 'number') ? clientX : MARGIN;
  let top = (typeof clientY === 'number') ? clientY : MARGIN;

  // 水平：测宽度后右侧溢出翻转到左侧 + 兜底
  let rect = thState.ocrPanel.getBoundingClientRect();
  if (left + rect.width > vw - MARGIN) left = left - rect.width;
  left = Math.max(MARGIN, Math.min(left, vw - rect.width - MARGIN));

  // 垂直方向：比较上下空间，空间大的一侧展开
  const spaceBelow = vh - top - MARGIN;
  const spaceAbove = top - MARGIN;
  const downward = spaceBelow >= spaceAbove;
  const maxH = Math.max(120, downward ? spaceBelow : spaceAbove);

  // 第一遍：设 max-height 触发重排，临时定位避免闪烁
  thState.ocrPanel.style.maxHeight = maxH + 'px';
  thState.ocrPanel.style.left = left + 'px';
  thState.ocrPanel.style.top = (downward ? top : Math.max(MARGIN, top - maxH)) + 'px';

  // 第二遍：重测受 max-height 约束后的实际高度，锚定到点击点
  rect = thState.ocrPanel.getBoundingClientRect();
  if (downward) {
    top = Math.min(top, vh - rect.height - MARGIN);
    if (top < MARGIN) top = MARGIN;
  } else {
    top = top - rect.height;
    if (top < MARGIN) top = MARGIN;
  }
  thState.ocrPanel.style.top = top + 'px';
}

/**
 * 右键视频 OCR：截取右键位置 video 当前帧 → OCR → 显示结果面板
 * @param {number} clientX 右键点击 X（用于定位 video 和面板）
 * @param {number} clientY 右键点击 Y
 * 反思（2026-08-05）：用 elementFromPoint 找右键位置的 video 元素，
 *   找不到回退 document.querySelector('video')。截帧后走 OCR_RECOGNIZE 流程。
 */
export async function ocrVideoFrame(clientX, clientY) {
  // 找右键位置的 video 元素
  let video = null;
  if (typeof clientX === 'number' && typeof clientY === 'number') {
    const el = document.elementFromPoint(clientX, clientY);
    if (el && el.tagName === 'VIDEO') video = el;
  }
  // 回退：页面中最大的可见 video
  if (!video) {
    const videos = Array.from(document.querySelectorAll('video'));
    video = videos.find((v) => v.videoWidth > 0 && v.videoHeight > 0);
  }
  if (!video) {
    showOcrResultPanel('', clientX, clientY, '未找到视频元素，无法 OCR');
    return;
  }
  // 显示加载提示
  showOcrResultPanel('', clientX, clientY, '正在识别视频帧...');
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    // 反思（2026-08-16 第六十六次）：OCR 语言随 sourceLanguage（zh→chi_sim，其余→eng）
    const ocrLang = await new Promise((resolve) => {
      chrome.storage.local.get({ sourceLanguage: 'en' }, (res) => resolve(res.sourceLanguage || 'en'));
    });
    const resp = await chrome.runtime.sendMessage({
      type: 'OCR_RECOGNIZE',
      imageDataUrl: dataUrl,
      lang: ocrLang
    });
    if (!resp || !resp.ok) {
      const errMsg = resp && resp.error ? resp.error : '未知错误';
      showOcrResultPanel('', clientX, clientY, 'OCR 失败: ' + errMsg);
      return;
    }
    const result = resp.text || '';
    showOcrResultPanel(result, clientX, clientY, result.trim() ? '' : '未识别到文字');
  } catch (e) {
    const errMsg = String(e && e.message ? e.message : e);
    showOcrResultPanel('', clientX, clientY, 'OCR 失败: ' + errMsg);
  }
}
