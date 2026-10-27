// =============================================================================
// 查询渲染核心与页面插入（第561次自 panel.js 拆出，src/content/th/query-card.js）
// 职责：renderQueryCard（右键面板/悬浮内嵌/两侧栏 query 卡共用的查询渲染）、
//   queryWordForPanel（统一词典完整记录读取）、insertMeaningIntoPage
//   （show in page 页面插入，A/B/C/F 四路径）、analyzeRangeLayout（选区布局
//   投票）、showInsertFeedback（插入结果反馈行）、extractCleanSelText/
//   isMultiWordText（选段清洗与多词判定）。
// 查询短释缓存（lastQueryTranslations/lastQueryIsSegment）与插入锚点
//   （lastQueryRange）为本模块私有状态——渲染与插入是一对读写方，同文件共存
//   免跨模块搬状态。
// =============================================================================

import { lookupFull } from '../../lib/dictionary.js';
import { translate, getLastTranslateChannel } from '../../lib/translator.js';
// primeTranslator：查词/OCR 面板打开即用户手势上下文，此时机创建内置翻译实例
//   （Chrome Translator API 的 create() 需 user activation），创建后自动注释场景复用
//   （translate 无需手势）——prime 入口仍在 panel.js（showContextPanel/OCR）。
// 用户裁定"本应该只插入短释义"：插入口径为 pickCleanShortTrans 首条短义项
import { pickCleanShortTrans, splitTransLines } from '../../lib/dict-clean.js';
import { getPhonetic } from '../../lib/phonetics.js';
import { t } from '../../lib/i18n.js';
import { thState, PANEL_ID, formatStage, isContextValid, speak } from './core.js';
// 结构自愈需要整卡重建（2026-10-27 右键报障，见 renderQueryCard 内守卫注释）
import { renderLemmaInto, buildPanelHTML, buildCardInnerHTML } from './card-build.js';
import { fillRelated } from './card-related.js';
import { bindMarkButtons } from './card-mark.js';
// 卡内 chat 按钮——对话面板唯一实现在 lib/chat.js（lib 层，无循环）
import { openChatPanel } from '../../lib/chat.js';
// 对话上下文的网页正文来源（Readability 优先），唯一实现在 lib/main-text.js
import { getAiMainText } from '../../lib/main-text.js';

// show in page 插入锚点——showContextPanel 时保存的选区 Range 克隆（模块级单查询生效）
let lastQueryRange = null;
// 整段插入时认定的块级元素集合（选区起点向上找最近块级，段落后新行插译文；
//   与 scan.js getBlockOriginText 的 BLOCK_TAGS 同口径精简）
const TH_BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'DD', 'DT', 'SECTION', 'ARTICLE', 'MAIN', 'FIGCAPTION', 'CAPTION']);
// 用户裁定"插入的释义应当是短释义"：showContextPanel/renderQueryCard 数据流中
//   解析出的释义数组缓存（每次新查询重置）——插入时经 pickCleanShortTrans 取首条短义项，
//   与侧邻注释同一口径；无数组时回退 .trans-row 首行文本。
let lastQueryTranslations = [];
// 用户裁定"你禁止了文段翻译差异"：来源标记——词典外选区走整段翻译（true），
//   词典释义/词典词翻译回填（false）。插入时文段插整段译文，词典插短释义，二者有别。
let lastQueryIsSegment = false;

/**
 * 多词/长文判定（与 renderQueryCard/insertMeaningIntoPage 口径统一）：
 * 含 ≥2 个拉丁词元，或整体长度 >24 视为整段。
 * 用户裁定"查询到非单词，多个词的时候，不要注音，不要词形还原"。
 * @param {string} text 查询文本
 * @returns {boolean}
 */
function isMultiWordText(text) {
  const tokens = String(text).split(/[\s\u3000]+/).filter((s) => /[A-Za-z\u00C0-\u024F]/.test(s));
  return tokens.length > 1 || String(text).length > 24;
}

/**
 * 选段过滤辅助——按 Range 逐文本节点重建选区文本，跳过 .beaver-page-insert
 * （本扩展插入页面的释义节点，见 insertMeaningIntoPage）祖先内的文本，只保留原文。
 * 处理 start/end offset 切片；被跳过节点处以空格占位防跨块文字粘连；
 * 结果多空白归一，异常/空串返回 ''（调用方退回原始 selectionText）。
 * @param {Range} range 页面选区 Range
 * @returns {string}
 */
function extractCleanSelText(range) {
  try {
    const anc = range.commonAncestorContainer;
    const walkerRoot = (anc.nodeType === 1) ? anc : anc.parentElement;
    if (!walkerRoot) return '';
    const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT, null);
    const sc = range.startContainer;
    const ec = range.endContainer;
    const parts = [];
    let n;
    while ((n = walker.nextNode())) {
      if (!range.intersectsNode(n)) continue;
      const el = n.parentElement;
      if (el && el.closest && el.closest('.beaver-page-insert')) { parts.push(' '); continue; }
      let txt = n.textContent || '';
      const isStart = (n === sc && sc.nodeType === 3);
      const isEnd = (n === ec && ec.nodeType === 3);
      if (isStart && isEnd) txt = txt.slice(range.startOffset, range.endOffset);
      else if (isStart) txt = txt.slice(range.startOffset);
      else if (isEnd) txt = txt.slice(0, range.endOffset);
      parts.push(txt);
    }
    return parts.join('').replace(/\s+/g, ' ').trim();
  } catch (_) {
    return '';
  }
}

export { extractCleanSelText };

/**
 * 保存/清除 show in page 插入锚点（panel.js showContextPanel 克隆当前选区时调用）。
 * lastQueryRange 是本模块私有状态（渲染与插入一对读写方），此函数是唯一外部写入口。
 * @param {Range|null} range 克隆的选区 Range（无选区传 null）
 */
export function setLastQueryRange(range) { lastQueryRange = range; }

/**
 * 查询渲染核心（右键面板与内嵌卡片共用）
 * 把查询文本的 词典/翻译 结果渲染进 root。root 的 DOM 结构 = buildCardInnerHTML()
 * （.word/.stage/.phonetic-row/.lemma-row/.lemma-group/.related-row/.trans-row/
 * .tags-row/.footer），右键浮动面板的 shadowRoot、悬浮卡 shadowRoot 与侧栏 query
 * 标签的内嵌卡片容器皆满足。
 * 算法（用户裁定）：①先查词典 ②词典外才翻译 ③翻译后分词——多词仅翻译；
 * 单词则翻译入词典并补全其他属性。
 * @param {Element|ShadowRoot} root 渲染目标（内含 buildCardInnerHTML 结构）
 * @param {string} trimmed 查询文本（已 trim 非空）
 * @param {() => void} [onUpdate] 异步内容到达后的位置刷新回调（浮动面板=positionPanel；内嵌卡片缺省 no-op）
 * @param {() => boolean} [isAlive] 写入守卫（浮动面板=display!==none；内嵌卡片缺省恒 true）
 * @param {{showInPage?: boolean}} [opts] 保留形参（历史口径：show in page 按钮
 *   按用户裁定已在所有查询表面常显，本参数不再影响渲染）
 */
export async function renderQueryCard(root, trimmed, onUpdate, isAlive, opts) {
  const refresh = (typeof onUpdate === 'function') ? onUpdate : () => {};
  const alive = (typeof isAlive === 'function') ? isAlive : () => true;
  const q = (sel) => root.querySelector(sel);

  // === 结构自愈守卫（2026-10-27 右键报障"Cannot set properties of null (setting
  //   'textContent')"，卡片拉不起来）===
  //   本函数硬性假设 root 含 buildCardInnerHTML() 骨架（.word/.phonetic-row/.stage/
  //   .trans-row/.tags-row 五处无守卫直写）。用户环境出现过骨架缺失——扩展多次重载后
  //   旧页面模块注册表新旧混居、或宿主页面/其他扩展动过注入 DOM 时，thState.panel 的
  //   影子内容可能与运行代码错位，缺失即整卡渲染中断（"拉不起来"且只有一行难懂的
  //   TypeError）。处置：渲染前探测五处骨架，缺失则如实 console.error 列明缺哪些，
  //   并**就地重建**（面板/悬浮有 .panel-header 用整卡 buildPanelHTML；侧栏内嵌卡用
  //   buildCardInnerHTML）后继续渲染——运行代码自建的结构必与自身假设一致，自愈即根治。
  const _missing = ['.word', '.phonetic-row', '.stage', '.trans-row', '.tags-row']
    .filter((sel) => !q(sel));
  if (_missing.length) {
    console.error('[VocabRadar][text-hint] 查询卡结构不完整（缺失: ' + _missing.join(', ') + '），就地重建 root 后继续渲染');
    // 重建按 root 身份取整卡/卡体：面板与悬浮的影子 root 带 .panel-header + 样式表，
    //   影子为空时选择器判不出，须按 thState 身份判定——否则右键面板会重建成无样式卡体
    const _shellRoot = root === (thState.panel && thState.panel.shadowRoot)
      || root === (thState.tooltip && thState.tooltip.shadowRoot);
    root.innerHTML = (_shellRoot || q('.panel-header')) ? buildPanelHTML() : buildCardInnerHTML();
  }

  let word = trimmed;
  // panel-header 固定显示品牌（左）+ 词阶（右）。
  // 正文 .word 显示查询词；header 卡的 .word-row .stage 由 CSS 隐藏（词阶只在 header
  // 出现一次）；侧栏内嵌卡无 .panel-header，.stage 在词行右侧显示（第561次二轮）。
  const headerStage = q('.panel-header .header-stage');
  if (headerStage) headerStage.textContent = '';
  q('.word').textContent = word;
  // 用户禁止"Querying..."/"No definition"等歧义文案：翻译未到/失败均留空，不显示
  // 占位文字，不自作主张。
  q('.phonetic-row').textContent = '';
  q('.stage').textContent = '';
  // 第561次三轮：卡片改键值对布局后，行内是静态字段名（.kv-label）+值单元格
  //   （.kv-value）——重置只清值单元格并把行藏起，绝不清空整行（会删掉字段名列）
  const lemmaRow = q('.lemma-row');
  if (lemmaRow) {
    lemmaRow.style.display = 'none';
    const lv = lemmaRow.querySelector('.kv-value');
    if (lv) lv.innerHTML = '';
  }
  const lemmaGroup = q('.lemma-group');
  if (lemmaGroup) {
    lemmaGroup.style.display = 'none';
    const gv = lemmaGroup.querySelector('.kv-value');
    if (gv) gv.innerHTML = '';
  }
  q('.tags-row').innerHTML = '';
  // 第561次：相关词汇行重置（新查询先隐藏，单词路径再异步填充）
  const relRow = q('.related-row');
  if (relRow) {
    relRow.style.display = 'none';
    const rv = relRow.querySelector('.kv-value');
    if (rv) rv.innerHTML = '';
  }
  const tagsSection = q('.tags-section');
  if (tagsSection) tagsSection.style.display = 'none';
  q('.trans-row').innerHTML = '';

  // 音标异步加载（词典命中路径用；词典外分支在 async 块内自行处理/清空）
  // 用户裁定"查询到非单词，多个词的时候，不要注音，不要词形还原"：
  //   多词/整段不注音——多词无对应单词条目音标，异步回填会覆盖词典外分支的清空
  if (word && isContextValid() && !isMultiWordText(word)) {
    getPhonetic(word).then((phon) => {
      if (alive()) {
        q('.phonetic-row').textContent = phon || '';
        refresh();
      }
    }).catch(() => {
      q('.phonetic-row').textContent = '';
    });
  }

  (async () => {
    const lower = word.toLowerCase();
    // ①先查词典（lookupFull 含词形还原重试；OOV 返回 null）
    // 用户报障"便签按钮插你似乎把翻译也像短释义那样截断了"：多词/长文跳过词典
    //   查询——lookupFull 对表外文段也返回占位词条（query.js 尾部无条件 return result），
    //   导致文段恒走"词典命中"路径、lastQueryIsSegment 恒 false，show in page 便签被
    //   pickCleanShortTrans 按短释口径截断。跳过后文段直接落"词典外→翻译整段"分支。
    let fullRec = null;
    if (!isMultiWordText(word)) {
      try { fullRec = await lookupFull(lower); } catch (e) { fullRec = null; }
    }
    // 第561次：相关词汇异步填充（仅单词；与词典命中与否无关——表外词若在向量词表内
    //   同样有近邻。空结果/失败整行隐藏，见 card-related.js）
    if (!isMultiWordText(word)) fillRelated(root, word, { alive, refresh });

    if (!fullRec) {
      // ②词典外 → 翻译整个选区
      q('.phonetic-row').textContent = '';
      q('.trans-row').innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
      let translated = null;
      try { translated = isContextValid() ? await translate(trimmed, true) : null; } catch (e) { translated = null; }
      if (alive()) {
        q('.trans-row').textContent = translated || '';
        // 词典外＝文段翻译路径——整段译文入缓存，标记来源（插入时插整段）
        lastQueryTranslations = translated ? [translated] : [];
        lastQueryIsSegment = true;
        const ch = getLastTranslateChannel();
        console.log(`[VocabRadar][text-hint] 右键翻译(词典外, len=${trimmed.length}): ${translated ? '成功' : '失败'}${ch ? ' 渠道:' + ch : ''}`);
      }
      // ③翻译后分词：多词仅翻译；单词则入词典并补全属性
      const tokens = String(trimmed).split(/[\s\u3000]+/).filter((s) => /[A-Za-z\u00C0-\u024F]/.test(s));
      const isMultiWord = tokens.length > 1 || trimmed.length > 24;
      if (!isMultiWord && translated && isContextValid()) {
        const info = await queryWordForPanel(lower, trimmed);
        if (info && info.isWord && alive()) {
          let stg = formatStage(info.rank);
          if (stg.indexOf('NaN') !== -1) stg = t('th.outside');
          q('.stage').textContent = stg;
          if (headerStage) headerStage.textContent = stg;
          // 原形行 + 同族组常显（共用 renderLemmaInto，悬浮共用）
          renderLemmaInto(root, trimmed, info.lemma);
          if (info.phonetic) {
            q('.phonetic-row').textContent = info.phonetic;
          } else {
            getPhonetic(trimmed).then((phon) => {
              if (alive()) q('.phonetic-row').textContent = phon || '';
            }).catch(() => {});
          }
        }
      }
      refresh();
      return;
    }

    // ④词典命中：沿用单词面板流程
    // queryWordForPanel 从统一词典 IDB 读取完整记录，返回时
    //   rank/tags/lemma/phonetic 已就绪，translation 可能是缓存的或 pending。
    //   不阻塞等待翻译完成——有啥先显示啥，翻译异步填充。
    const info = await queryWordForPanel(lower, word);
    if (info && info.isWord) {
      // === 立即显示 rank/tags/lemma（来自 IDB，不等待翻译）===
      let stage = formatStage(info.rank);
      if (stage.indexOf('NaN') !== -1) stage = t('th.outside');
      q('.stage').textContent = stage;
      if (headerStage) headerStage.textContent = stage;
      // 词形还原原形 + 同族组常显（多词/整段不显示词形还原——用户裁定）
      if (!isMultiWordText(word)) renderLemmaInto(root, word, info.lemma);
      // 标签
      const tags = info.tags || [];
      console.log(`[VocabRadar][text-hint] 查询卡词表标签: isWord=${info.isWord} tags=${tags.length}`, tags);
      const tagsEl = q('.tags-row');
      tagsEl.innerHTML = '';
      if (tagsSection) tagsSection.style.display = tags.length > 0 ? '' : 'none';
      tags.forEach((tag) => {
        const span = document.createElement('span');
        span.className = 'tag';
        span.textContent = tag;
        tagsEl.appendChild(span);
      });
      // 翻译结果显示：已缓存直接显示；pending 显示浮动省略号（动画三点），翻译完成替换；
      //   翻译失败移除省略号留空，不显示"No definition"。
      const trans = info.translations || [];
      // 缓存释义数组供 show in page 取短释；词典命中＝非文段来源
      lastQueryTranslations = trans;
      lastQueryIsSegment = false;
      if (trans.length > 0) {
        // 用户报障"查询卡片释义没有分拆"：单条释义内按 | 词性段拆行（letter 案例）
        q('.trans-row').innerHTML = splitTransLines(trans).map(row => `<div>${row}</div>`).join('');
      } else if (info.pending) {
        q('.trans-row').innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
        refresh();
        if (isContextValid()) {
          translate(word, true).then((translated) => {
            if (alive()) {
              if (translated) {
                // 词典词翻译回填同样按 | 拆行（来源仍为词典路径，非文段）
                q('.trans-row').innerHTML = splitTransLines([translated]).map(row => `<div>${row}</div>`).join('');
                // 翻译完成后同步短释缓存（词典路径保持 lastQueryIsSegment=false）
                lastQueryTranslations = [translated];
                const ch = getLastTranslateChannel();
                console.log(`[VocabRadar][text-hint] 右键查词 "${lower}": 翻译完成 → "${translated}"${ch ? ` (渠道:${ch})` : ''}`);
              } else {
                q('.trans-row').textContent = '';
                console.warn(`[VocabRadar][text-hint] 右键查词 "${lower}": 翻译失败（所有渠道均未返回结果）`);
              }
              refresh();
            }
          }).catch(() => {
            if (alive()) {
              q('.trans-row').textContent = '';
            }
          });
        }
      } else {
        q('.trans-row').textContent = '';
      }
    } else {
      q('.stage').textContent = t('th.notWord');
      if (headerStage) headerStage.textContent = t('th.notWord');
      q('.trans-row').textContent = '';
    }
    refresh();
  })();

  const speakBtn = q('.speak');
  if (speakBtn) speakBtn.onclick = () => speak(word);
  // 🏁/✓ 标记按钮（右键面板/悬浮卡有按钮；内嵌卡已不渲染，bindMarkButtons 自行短路）
  bindMarkButtons(root, word);
  // chat 按钮就"选区原文"发起对话（不是词元，保留用户实际选中的上下文）；
  // kind='word'——右键查询属"单词类查询"，用 chatWordPrompt 模板。
  // 上下文框的正文只有两种来源——Readability 提取的网页正文，或字幕。选区原文
  //   只能进提问语的 {}，绝不能当上下文。第三参传 getAiMainText() 的网页正文；
  //   提取失败则退回选区原文（不静默留空）。
  const chatBtn = q('.chat');
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

  // 底部按钮 show in page——把释义插入页面。整段新换行、单词插入续接。
  // 用户裁定：所有查询表面一律绑定插入并显示按钮。侧栏内嵌卡点击时锚点已失效
  //   则走实时选区回落（见 insertMeaningIntoPage），无选区给卡片内反馈行。
  const showPageBtn = q('.show-page');
  if (showPageBtn) {
    showPageBtn.onclick = () => insertMeaningIntoPage(trimmed, q);
  }
}

// openChatPanel / getAiMainText 已在文件头静态导入（lib 层模块，与本模块无循环）。

/**
 * 选区布局分析——译文样式「跟随原文多数」（用户裁定：跟随原文多数而不是
 * 开头一个字；多段的逐段跟随）。TreeWalker 遍历选区覆盖的文本节点（跳过扩展
 * UI/已插入译文/侧邻注释），按最近块级容器（TH_BLOCK_TAGS）分组，以字符数为权重
 * 对五项样式（字色/字族/字号/斜体/粗细）投票：
 * - global：全选区多数 → 单处插入的译文样式；
 * - blocks：各块多数（文档序）→ 多段译文逐段插入各块末尾时的该段样式。
 * 生词高亮 span 内文本仍算原文，但样式取高亮容器的父元素（原文容器口径）。
 * 必须在任何 DOM 变更（B 路径 splitText）之前调用；分析失效（选区丢失/落在
 * 扩展 UI 内/无文本）返回 null，调用方回落旧口径（起点元素锁定）。
 * @param {Range} range 插入锚点选区
 * @returns {{blocks: Array<{el: Element, style: Object}>, global: Object}|null}
 */
function analyzeRangeLayout(range) {
  try {
    if (!range || !range.commonAncestorContainer) return null;
    const root = range.commonAncestorContainer;
    const rootEl = root.nodeType === 1 ? root : root.parentElement;
    if (!rootEl || !rootEl.isConnected || rootEl.getRootNode() !== document) return null;
    const SKIP = '.beaver-page-insert, .beaver-side-ann, #' + PANEL_ID
      + ', #beaver-sidebar, #beaver-web-sidebar, #beaver-subtitle-overlay, #beaver-debug-panel';
    if (rootEl.closest && rootEl.closest(SKIP)) return null;
    const STYLE_PROPS = ['color', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight'];
    const byBlk = new Map();   // 块元素 -> Map<样式签名,{style,chars}>
    const global = new Map();  // 签名 -> {style,chars}
    const addVote = (map, style, chars) => {
      const sig = STYLE_PROPS.map((k) => style[k]).join('|');
      const cur = map.get(sig);
      if (cur) cur.chars += chars;
      else map.set(sig, { style, chars });
    };
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || !p.closest || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        if (!range.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      let styleEl = p;
      const wordWrap = p.closest('.beaver-word');
      if (wordWrap && wordWrap.parentElement) styleEl = wordWrap.parentElement;
      const cs = getComputedStyle(styleEl);
      const style = {};
      for (const k of STYLE_PROPS) style[k] = cs[k];
      const chars = n.nodeValue.replace(/\s+/g, '').length;
      // 归块：向上找最近块级容器；到 body 未命中则该文本不参与逐段（无块可插），
      //   但仍计入整体多数
      let blk = p;
      while (blk && blk !== document.body && blk !== document.documentElement
        && !TH_BLOCK_TAGS.has(blk.tagName)) {
        blk = blk.parentElement;
      }
      if (blk && blk !== document.body && blk !== document.documentElement
        && TH_BLOCK_TAGS.has(blk.tagName)) {
        let m = byBlk.get(blk);
        if (!m) { m = new Map(); byBlk.set(blk, m); }
        addVote(m, style, chars);
      }
      addVote(global, style, chars);
    }
    if (global.size === 0) return null;
    const majorityOf = (m) => {
      let best = null;
      m.forEach((v) => { if (!best || v.chars > best.chars) best = v; });
      return best ? best.style : null;
    };
    const blocks = [];
    byBlk.forEach((m, el) => {
      const style = majorityOf(m);
      if (style) blocks.push({ el, style });
    });
    return { blocks, global: majorityOf(global) };
  } catch (e) {
    console.warn('[VocabRadar][text-hint] 选区布局分析失败，回落起点样式:', e);
    return null;
  }
}

/**
 * show in page——把查询卡片释义插回页面原文处。
 * 整段（多词或长文，同 renderQueryCard 的 isMultiWord 口径）→ 块级 div 新起一行；
 * 单词 → 行内 span 续接在选区词后（空格分隔）。插入点 = showContextPanel 保存的
 * 选区 Range（折叠到选区末尾＝原词后）。插入节点带主题绿字色，便于与正文区分。
 * 用户报障"无反应"：失败只写 console 用户不可见——所有结果（成功/失败原因）
 *   均显示在卡片内反馈行（showInsertFeedback，footer 上方，5 秒自动消失）；
 *   保存的 Range 可能因页面重渲染脱离文档（detached），插入前检测
 *   startContainer.isConnected，失效则回落实时选区（排除扩展 UI 内的选区）。
 * @param {string} trimmed 查询原文
 * @param {(sel: string) => Element|null} q 卡片内选择器（读释义用）
 */
function insertMeaningIntoPage(trimmed, q) {
  // 用户裁定：词典来源取短释义首条 pickCleanShortTrans（"只插一段翻译的前几个
  //   字"即短释义口径，是预期行为非截断 bug）；文段翻译来源插整段译文（保留差异，不切分）。
  let text = lastQueryIsSegment
    ? (lastQueryTranslations[0] || '').trim()
    : pickCleanShortTrans(lastQueryTranslations);
  if (!text) {
    const transRow = q('.trans-row');
    const firstLine = transRow && transRow.firstElementChild ? transRow.firstElementChild.textContent : '';
    text = String(firstLine || (transRow ? transRow.textContent : '') || '').trim();
  }
  if (!text) {
    console.warn('[VocabRadar][text-hint] show in page：释义未就绪，跳过插入');
    showInsertFeedback(q, false, t('th.insertNoDef'));
    return;
  }
  // 锚点有效性——保存的 Range 引用节点若已被页面移除（SPA 重渲染等），
  //   对 detached range insertNode 会把节点插进孤立子树，页面看不到＝"无反应"。
  let range = lastQueryRange;
  if (!range || !range.startContainer || !range.startContainer.isConnected) {
    const sel = window.getSelection();
    const live = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0) : null;
    // 回落条件：实时选区存在、在主文档（非扩展 shadow UI）、且不在本面板内
    const liveOk = live && live.startContainer && live.startContainer.isConnected
      && live.startContainer.getRootNode() === document
      && !(live.startContainer.nodeType === 1
        ? live.startContainer.closest(`#${PANEL_ID}`)
        : live.startContainer.parentElement && live.startContainer.parentElement.closest(`#${PANEL_ID}`));
    if (liveOk) {
      console.warn('[VocabRadar][text-hint] show in page：保存锚点已失效，回落实时选区');
      range = live;
    } else {
      console.warn('[VocabRadar][text-hint] show in page：无可用插入锚点（选区已丢失），跳过插入');
      showInsertFeedback(q, false, t('th.insertNoAnchor'));
      return;
    }
  }
  // 插入护栏——保存的锚点落在已插入的译文/注释节点内部（用户先翻译一个词
  //   再选中一段翻译）时，再插入会把新译文嵌进旧译文。命中即中止并提示重选原文。
  const guardEl = range.startContainer.nodeType === 3
    ? range.startContainer.parentElement : range.startContainer;
  if (guardEl && guardEl.closest && guardEl.closest('.beaver-page-insert, .beaver-side-ann')) {
    console.warn('[VocabRadar][text-hint] show in page：锚点在已插入译文/注释内，中止插入');
    showInsertFeedback(q, false, t('th.insertInsideAnn'));
    return;
  }
  try {
    // 多词口径统一走 isMultiWordText
    const isMultiWord = isMultiWordText(trimmed);
    const node = document.createElement(isMultiWord ? 'div' : 'span');
    node.className = 'beaver-page-insert';
    // 译文样式＝"原文"样式（用户裁定）：继承插入点后文样式是错的，原文与后文
    //   字体/字色不同时会错。在折叠/外移前锁定选区起点元素的 computedStyle 五项
    //   （字色/字族/字号/斜体/粗细）内联，样式随原文走。
    // 译文样式跟随原文「多数」——先 analyzeRangeLayout（必须在任何 DOM 变更之前）
    //   按字符权重投票取整体多数；分析失效回落起点元素锁定五项（起点在标注容器内
    //   取标注父元素＝原文容器）。
    let fallbackEl = null;
    const layout = analyzeRangeLayout(range);
    if (!layout) {
      fallbackEl = range.startContainer.nodeType === 3
        ? range.startContainer.parentElement
        : range.startContainer;
      const srcAnn = fallbackEl && fallbackEl.closest
        ? fallbackEl.closest('.beaver-word, .beaver-side-ann') : null;
      if (srcAnn && srcAnn.parentElement) fallbackEl = srcAnn.parentElement;
      if (fallbackEl && !fallbackEl.isConnected) fallbackEl = null;
    }
    const baseStyle = layout ? layout.global
      : (fallbackEl ? getComputedStyle(fallbackEl) : null);
    node.style.cssText = (isMultiWord ? 'margin-top:4px;' : 'margin-left:2px;');
    if (baseStyle) {
      node.style.color = baseStyle.color;
      node.style.fontFamily = baseStyle.fontFamily;
      node.style.fontSize = baseStyle.fontSize;
      node.style.fontStyle = baseStyle.fontStyle;
      node.style.fontWeight = baseStyle.fontWeight;
    }
    node.textContent = isMultiWord ? text : ` ${text}`;
    // 插入路径（调研 kiss-translator 后重写；用户反馈"跑到下一个元素位置插入前面"）：
    //   不可信任跨 DOM 变更的 live Range 端点——lastQueryRange 保存后 text-hint 扫描
    //   用 surroundContents 把词包进 .beaver-word，浏览器把端点自动重映射成
    //   (父元素P, 词span相邻下标N)，closest 不命中时 insertNode 落在 (P,N)＝
    //   下一个元素之前。kiss-translator 的做法是不信任跨 DOM 变更的 Range，
    //   以原文节点为锚插兄弟节点。四路径：A 词span紧后 / B 单词文本节点切分紧后 /
    //   C 多词最近块级元素后新行 / F 旧 collapse 序列兜底。
    let pathTag = 'F-Range兜底';
    // 解析词锚——起点在文本节点：父链 closest 找 .beaver-word，文本节点即
    //   B 的操作对象；起点漂移成 (元素,offset)：看 offset 处与前一子节点是否
    //   .beaver-word（修复重映射 (P,N) 场景）或文本节点（B 可继续）。
    const scEl = range.startContainer.nodeType === 3
      ? range.startContainer.parentElement : range.startContainer;
    let wordSpan = scEl && scEl.closest ? scEl.closest('.beaver-word') : null;
    let wordNode = range.startContainer.nodeType === 3 ? range.startContainer : null;
    if (!wordSpan && scEl && scEl.nodeType === 1 && range.startContainer.nodeType !== 3) {
      const kids = scEl.childNodes;
      const c0 = range.startOffset > 0 ? kids[range.startOffset - 1] : null;
      const c1 = kids[range.startOffset] || null;
      if (c0 && c0.nodeType === 1 && c0.classList && c0.classList.contains('beaver-word')) wordSpan = c0;
      else if (c1 && c1.nodeType === 1 && c1.classList && c1.classList.contains('beaver-word')) wordSpan = c1;
      if (!wordNode && c1 && c1.nodeType === 3) wordNode = c1;
      else if (!wordNode && c0 && c0.nodeType === 3) wordNode = c0;
    }
    let inserted = false;
    // 多段逐段跟随——译文按换行拆出的段数与选区覆盖的块数一致时，逐段插到
    //   各块末尾（各段用该块多数样式），优先于 A/B 单点插入。
    const layoutBlocks = (layout && isMultiWord) ? layout.blocks : [];
    const segs = layoutBlocks.length > 1
      ? text.split(/\n+/).map((s) => s.trim()).filter(Boolean) : [];
    if (layoutBlocks.length > 1 && segs.length === layoutBlocks.length) {
      pathTag = 'C-逐段末尾';
      layoutBlocks.forEach((b, i) => {
        const seg = document.createElement(isMultiWord ? 'div' : 'span');
        seg.className = 'beaver-page-insert';
        seg.style.cssText = 'margin-top:4px;';
        seg.style.color = b.style.color;
        seg.style.fontFamily = b.style.fontFamily;
        seg.style.fontSize = b.style.fontSize;
        seg.style.fontStyle = b.style.fontStyle;
        seg.style.fontWeight = b.style.fontWeight;
        seg.textContent = segs[i];
        if (!(b.el.lastElementChild && b.el.lastElementChild.tagName === 'BR')) {
          b.el.appendChild(document.createElement('br'));
        }
        b.el.appendChild(seg);
      });
      inserted = true;
    }
    // A：词 span 命中→紧贴其后插；紧邻已是注释节点（.beaver-side-ann）则排其后，
    //   不插进"词与注释"中间（tooltip.js 同规则，避免夹心观感）。
    if (wordSpan && wordSpan.parentNode) {
      pathTag = 'A-词span紧后';
      const sib = wordSpan.nextElementSibling;
      if (sib && sib.classList && sib.classList.contains('beaver-side-ann')) {
        sib.parentNode.insertBefore(node, sib.nextSibling);
      } else {
        wordSpan.parentNode.insertBefore(node, wordSpan.nextSibling);
      }
      inserted = true;
    }
    // B：单词且拿到起点文本节点→在该节点内定位选中文本，splitText 切出独立节点后
    //   紧后插（kiss 式以原文为锚）；定位失败保持 inserted=false 落 F 兜底。
    if (!inserted && !isMultiWord && wordNode && wordNode.nodeValue) {
      const txt = wordNode.nodeValue;
      let idx = range.startContainer === wordNode
        ? txt.indexOf(trimmed, Math.min(range.startOffset, txt.length)) : -1;
      if (idx < 0) idx = txt.indexOf(trimmed);
      if (idx >= 0) {
        pathTag = 'B-文本切分紧后';
        wordNode.splitText(idx + trimmed.length);
        const mid = idx > 0 ? wordNode.splitText(idx) : wordNode;
        mid.parentNode.insertBefore(node, mid.nextSibling);
        inserted = true;
      }
    }
    // C：多词/整段→自起点向上找最近块级元素（TH_BLOCK_TAGS，与 scan.js BLOCK_TAGS
    //   同口径），插到块级之后＝新行；到 body 仍未命中块级则不动（不插 body 层级）。
    if (!inserted && isMultiWord) {
      let blk = scEl;
      while (blk && blk !== document.body && blk !== document.documentElement
        && !TH_BLOCK_TAGS.has(blk.tagName)) {
        blk = blk.parentElement;
      }
      if (blk && blk !== document.body
        && blk !== document.documentElement && TH_BLOCK_TAGS.has(blk.tagName)) {
        pathTag = 'C-块内末尾新行';
        // 用户裁定（"没从下一行开始而是从右边格子开始……"）：插到块级之后在
        //   表格/网格布局下是同级并排块。改为原文块内末尾追加 <br>＋译文：
        //   译文永远在原文文本流末尾换行，与外层布局无关。
        if (!(blk.lastElementChild && blk.lastElementChild.tagName === 'BR')) {
          blk.appendChild(document.createElement('br'));
        }
        blk.appendChild(node);
        inserted = true;
      }
    }
    // F 兜底：折叠到选区末尾；折叠点落在标注 span 内部时外移到
    //   标注之后，避免释义插进标注继承生词样式（"字体变粗"根因）。
    if (!inserted) {
      range.collapse(false);
      let anchor = range.startContainer;
      if (anchor.nodeType === 3) anchor = anchor.parentElement;
      const ann = anchor && anchor.closest ? anchor.closest('.beaver-word, .beaver-side-ann') : null;
      if (ann && ann.parentNode) range.setStartAfter(ann);
      range.insertNode(node);
    }
    console.log(`[VocabRadar][text-hint] show in page：已插入（${isMultiWord ? '整段新行' : '单词续接'}，锚点${pathTag}）→ ${text.slice(0, 40)}`);
    // 成功不显示反馈行（用户裁定），失败反馈保留。
    // 用户裁定"撤销任何禁止插入"：成功后不禁用本卡按钮——按钮永远可点，允许重复插入。
  } catch (e) {
    console.error('[VocabRadar][text-hint] show in page 插入失败:', e);
    showInsertFeedback(q, false, `${t('th.insertFail')}${e && e.message ? `：${e.message}` : ''}`);
  }
}

/**
 * show in page 插入结果反馈行（卡片内可见，替代静默 + console）。
 * 插入在 footer 上方，成功绿/失败红，5 秒后自动移除；重复点击复用同一行。
 * tooltip 语境也复用（export）——悬浮提示与右键面板共用卡片结构，
 *   两边的 show-page 都需要把插入结果显示给用户。
 * @param {(sel: string) => Element|null} q 卡片内选择器
 * @param {boolean} ok 是否成功
 * @param {string} msg 文案（已翻译）
 */
export function showInsertFeedback(q, ok, msg) {
  const footer = q('.footer');
  if (!footer || !footer.parentElement) return;
  const card = footer.parentElement;
  let tip = card.querySelector('.insert-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'insert-tip';
    card.insertBefore(tip, footer);
  }
  tip.style.cssText = 'font-size:12px;line-height:1.5;margin-top:2px;padding:2px 0;'
    + (ok ? 'color:#2e6b43;' : 'color:#b3261e;');
  tip.textContent = msg;
  clearTimeout(tip._beaverTimer);
  tip._beaverTimer = setTimeout(() => { tip.remove(); }, 5000);
}

/**
 * 查询单词（右键面板用），返回完整信息（不受词频阈值限制）
 *
 * 此函数不阻塞翻译：返回时 rank/tags/lemma/phonetic 已就绪，
 *   translation 可能是缓存的（pending=false）或待查询的（pending=true）。
 *   调用方根据 pending 决定是否显示占位省略号并异步获取翻译。
 *
 * @param {string} lower 小写单词
 * @param {string} original 原始大小写
 * @returns {Promise<{isWord,rank,tags,lemma,translations,pending,phonetic}>}
 */
export async function queryWordForPanel(lower, original) {
  // 从统一词典 IDB 读取完整记录（rank/lemma/tags/translation/phonetic/related）
  const full = await lookupFull(lower);
  const rank = full ? full.rank : null;
  const tags = full ? (full.tags || []) : [];
  const lemma = full ? full.lemma : null;
  const phonetic = full ? full.phonetic : null;

  // 检查 IDB 中是否已有有效翻译（语言匹配）
  if (full && full.translation && full.translationLang === thState.meaningLang) {
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
  console.log(`[VocabRadar][text-hint] 右键查词 "${lower}": 已知=[${known.join(', ') || '无'}], 待查翻译(${thState.meaningLang})`);
  return { isWord: true, rank, tags, lemma, translations: [], pending: true, phonetic };
}
