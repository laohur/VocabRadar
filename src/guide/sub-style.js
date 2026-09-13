// VocabRadar 引导页 字幕样式模块（302次拆分：门面模式）
// 职责：Video Overlay Subtitles 设定栏——正文网格/样例行/个性化行（五控件/CSS代码/
//   右侧卡/加号/用户卡）/位置单选/注释方式单选/横竖屏预览/动态注释/设定同步。
// 说明：由 guide.js 机械拆分而来，代码逐字保留，未改动任何逻辑（syncSubtitleSettings
//   组装除外，见注）。设定页编排（renderAll/init）仍在 guide.js。
// 依赖：shared（$ / m / 语言 / 日志 / 回声戳）+ ann-pool（池选择态只读）+ lib；
//   不依赖 guide.js（无环）。

import { $, m, getLangState, markOwnWrite, log, sanitizeStyleId, sanitizePositionId } from './shared.js';
import { getPoolSel } from './ann-pool.js';
import {
  SUBTITLE_TEXT_STYLES, SUBTITLE_POSITIONS, POOL_STYLES, findStyle, styleLabel, annDecl,
  SUB_FONT_OPTIONS, SUB_FX_OPTIONS, subFontFamily, subFxDecl, buildUserStyleDecl,
  SUBTITLE_REF_H, pxToSizePct, sizePctToPx, subFontSizePct,
  DEFAULT_ANN_TEMPLATE, splitAnnTemplate
} from '../lib/styles.js';
import { getAnnotations } from '../lib/annotator.js';
import { ensureReady } from '../lib/dictionary.js';
import { pickCleanShortTrans } from '../lib/dict-clean.js';

// 当前选中的字幕文字/位置样式 id（渲染样卡与双预览共用，切换时同步刷新）
let _subStyleId = 'none';
let _subPosId = 'b20';   // 第二百二十三次：默认位置统一下 1/5（原 'b10' 与 storage 默认 b20 不一致）
// 290次：样例句子（样式卡与预览共用；持久化 storage.subtitleSample）
// 291次：默认改纯英文句（注释不再硬编码，动态按释义语言/词频注释）；290版旧默认做一次性迁移
const DEFAULT_SUB_SAMPLE = 'VocabRadar is short for vocabulary radar.';
const LEGACY_SUB_SAMPLE_290 = 'VocabRadar is short for vocabulary 词汇 radar(雷达).';
let _subSample = DEFAULT_SUB_SAMPLE;
// 291次：预览动态注释缓存（word_lower → 释义；随样例/阈值/语言变化刷新）
//   预览同步读缓存即时渲染，fetch 回来后再刷一次（数据到达，非交互闪烁）。
let _previewAnns = new Map();
let _previewAnnsTimer = 0;
let _previewAnnsBusy = false;
function schedulePreviewAnns() {
  if (_previewAnnsTimer) clearTimeout(_previewAnnsTimer);
  _previewAnnsTimer = setTimeout(refreshPreviewAnns, 600);
}
async function refreshPreviewAnns() {
  _previewAnnsTimer = 0;
  if (_previewAnnsBusy) { schedulePreviewAnns(); return; }
  _previewAnnsBusy = true;
  const snap = _subSample;
  try {
    // 词频门控要有 rank 必须等词典就绪（否则全词走在线翻译，浪费且慢）
    try { await ensureReady(); } catch (_) { /* 降级：用缓存/空注释 */ }
    if (snap !== _subSample) return;
    const th = await new Promise((resolve) => {
      try { chrome.storage.local.get({ rankThreshold: 5000 }, (r) => resolve(r.rankThreshold)); }
      catch (_) { resolve(5000); }
    });
    const anns = await getAnnotations(snap, th, new Set(), null, false);
    if (snap !== _subSample) return;
    const map = new Map();
    for (const a of anns) {
      // 292次：取短释义（在线长译文进预览会撑破布局；空短串按无注释跳过）
      const t = pickCleanShortTrans(a.translations || []);
      if (t) map.set(String(a.word).toLowerCase(), t);
    }
    _previewAnns = map;
    renderSubPreview();
  } catch (e) {
    console.warn('[VocabRadar][guide] 预览注释获取失败，沿用旧缓存:', e && e.message);
  } finally {
    _previewAnnsBusy = false;
  }
}

// 281次：个性化字幕样式缓存（storage.subtitleCustom，renderAll 回填）。
//   282次：加 fx 特效字段（与 Custom 特效下拉/大加号保存的用户样式共用参数集）
// 283次：默认改为"能直接用"的样式（用户裁定：底色透明、字号不小、投影特效）——
//   透明底白字 + 阴影在任意视频上可读，不再默认黑条压画面。
let _subCustom = { bg: 'transparent', fg: '#ffffff', fontSizePct: 5, fontFamily: 'sans', fx: 'shadow' };
// 282次：用户自建正文样式缓存（storage.subtitleUserStyles，条目 {id,label,bg,fg,fontSizePct,fontFamily,fx}）
// 295次：custom 默认 7%→6%（用户"默认7%高"）；参数名统一 fontSizePct。
// 293次：字号改视频高百分比（旧 fontSize px 按 540 设计高换算，见 pxToSizePct）
let _userStyles = [];
// 282次：预览方向（'landscape'/'portrait'）——本地态不写 storage，仅影响预览窗形状
let _subPreviewOrient = 'landscape';
// 283次：预览 1080p 舞台缩放监听（ResizeObserver）——stage 宽随正文页宽变化时
//   重算 scale（模块级持有，renderSubPreview 重建 stage 后重挂；disconnect 防泄漏）
let _subPreviewRO = null;
// 280 次：视频叠加字幕注释布局缓存（radio 从引导页删除后，renderSubPreview 改读此缓存；
//   renderAll 时从 storage 赋值，非 'detail' 一律按 'side' 渲染预览）
let _overlayAnnMode = 'side';

// 样例网格（三列四行）
function renderStyleGrid(container, items, activeId, renderCard) {
  container.innerHTML = '';
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'style-card' + (item.id === activeId ? ' active' : '');
    card.dataset.id = item.id;
    card.dataset.style = item.id;
    card.appendChild(renderCard(item));
    const label = document.createElement('div');
    label.className = 'card-label';
    label.textContent = styleLabel(item, getLangState());
    card.appendChild(label);
    container.appendChild(card);
  }
}

// 280 次：textCard/annCard 两卡渲染器随旧双网格退役——池卡统一由 poolCardDemo（wordDecl/annDecl
//   生成器输出）渲染，三种指派关系共用同一张样例卡。

// 字幕样式卡：迷你 16:9 视频区 + 按文字样式（在当前位置 ratio 上）渲染的 word(释义) 字幕
const GUIDE_FONTS = {
  sans: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  serif: '"Georgia", "Times New Roman", "SimSun", serif',
  mono: '"Consolas", "Courier New", monospace'
};

// 字幕盒样式（文字样式卡/预览共用）：文字属性 + 背景 + 内边距，不含定位与换行
// 反思（2026-08-19 第八十次）：拆出独立函数——详细模式预览的注释块需与字幕行盒分离
//   （注释独立块不带盒背景，见 subSampleHtml），盒样式与 buildSubMiniCss 保持一致。
// 293次：字号改百分比（refH=换算用视频高：卡片 540 设计高/预览 1080 真实像素），
//   与 overlay 真实渲染同口径（297次：无 clamp，纯比例；298次短边作废改回视频高）。
function buildSubBoxCss(item, s, refH) {
  const parts = [];
  parts.push('color:' + (item.fg || '#ffffff'));
  parts.push('font-size:' + sizePctToPx(subFontSizePct(item), refH) + 'px');
  // 282次：用户样式字体 id（arial/impact 等）不在 GUIDE_FONTS 时回落共享层 SUB_FONTS
  parts.push('font-family:' + (GUIDE_FONTS[item.font] || subFontFamily(item.font)));
  if (item.id === 'none') {
    parts.push('background:rgba(0,0,0,0.75)');
  } else if (item.bg) {
    parts.push('background:' + item.bg);
  }
  // 281次：weight 字段优先（特粗 800，如 edge-white-bold），否则 bold→600（与 overlay 渲染一致）
  if (item.weight) parts.push('font-weight:' + item.weight);
  else if (item.bold) parts.push('font-weight:600');
  if (item.italic) parts.push('font-style:italic');
  if (item.shadow) parts.push('text-shadow:' + (typeof item.shadow === 'string' ? item.shadow : '0 0 4px rgba(0,0,0,.9)'));
  if (item.edge) parts.push('-webkit-text-stroke:1px ' + item.edge);
  // 282次：fx 特效（custom/用户样式卡）——组合样式在预览与样卡中一并体现
  const fxd = subFxDecl(item.fx);
  if (fxd) parts.push(fxd);
  parts.push('padding:2px 6px;border-radius:3px');
  return parts.join(';');
}

// 按字幕文字样式元数据 + 位置 ratio 生成迷你字幕元素 cssText（样卡/双预览共用）
// 反思（2026-08-16 第六十九次）：位置与文字样式解耦——bottom = ratio×100%（距视频底部比例），
//   'none'（默认）= 深色半透明条 + 无文本投影（第六十七次起，与 overlay 基础样式一致）。
// 反思（2026-08-19 第七十九次）：新增 flow 模式——文字样式卡（.sub-stage）不再用
//   绝对定位迷你视频区（与前三个栏目尺寸一致，见 subCard），flow=true 时省略
//   position/left/bottom/transform，按普通流渲染水平文本样例。
// 反思（2026-08-19 第八十次）：位置预览按"中心水平线"对齐——ratio 是字幕框中心线距
//   底部比例（与真实 overlay 一致），transform 加 translateY(50%)：bottom 置于 ratio 线后
//   下移半高，使盒子中心正好落在中心线上（用户："预览窗口的字幕位置并不准，没按中心水平线"）。
function buildSubMiniCss(item, ratio, scale, wrap, flow, refH) {
  const s = (typeof scale === 'number' && scale > 0) ? scale : 1;
  const parts = [];
  if (flow) {
    // 旧省略号分支（292次退役）：行内 span 吃不下 max-width，长样例溢出；292改换行后
    //   样例卡不再走 flow（wrap=true），本分支保留防外部调用回归。
    parts.push('display:block;width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis');
  } else if (wrap) {
    // 292次：卡片换行全显——块级 + 自动换行不断溢出；高度由调用方 height:auto 承接。
    parts.push('display:block;width:100%;white-space:normal;word-break:break-word;line-height:1.35');
  } else {
    // 292次：预览绝对定位单行（wrap 的换行分支已上移，此处 wrap 恒 false，死三元清理）
    parts.push('position:absolute;left:50%;bottom:' + (ratio * 100) + '%;transform:translate(-50%, 50%)');
    parts.push('white-space:nowrap;max-width:94%;overflow:hidden;text-overflow:ellipsis');
  }
  parts.push(buildSubBoxCss(item, s, refH));
  return parts.join(';');
}

// 有意义的样字（2026-08-16 第七十次）：不再用"单词释义"占位符，改用与真实字幕一致的
// 句子样例（styles.js 各字幕样式自带 sample，如 "He passed the quiz(测验)."）——
// 生词 quiz 绿色高亮 + (测验) 释义，detail 模式释义换行为 "quiz 测验" 新行，
// 模拟 subtitle-overlay 的真实渲染（生词绿块 + 释义，所见即所得）。
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// 281次：新增 annStyle 参数——字幕注释行样式改由第四栏池条目（Subtitle hints on video）
//   控制（annDecl 输出与真实 overlay 渲染同源）；缺省/'none' 时沿用旧配色逻辑。
function subSampleHtml(item, ratio, annMode, scale, wrap, flow, plain, annStyle) {
  const sample = item.sample || 'He passed the quiz(测验).';
  // 反思（2026-08-19 第八十一次）：样例解析修正——旧正则以 `(?:\(...\))?` 将括号组设为可选，
  //   且 `(.*?)` 惰性匹配到第一个单词即停：样例 "He passed the quiz(测验)." 解析出的生词是
  //   "He"（高亮错词、释义为空，用户反馈"生词标错/详细模式释义没放正确"）。
  //   修正：括号组必选，先匹配"单词紧邻 (释义)"结构；无括号的旧样例按句中 quiz 兜底高亮；
  //   仍无生词的样例整句原样输出（不虚构高亮与释义）。
  const m = sample.match(/^(.*?)([A-Za-z]+)\(([^)]*)\)(.*)$/);
  let before = m ? m[1] : '';
  let word = m ? m[2] : '';
  let trans = m ? (m[3] || '') : '';
  let after = m ? m[4] : '';
  if (!m) {
    const q = sample.match(/^(.*?)(quiz\b)([^]*)$/i);
    if (q) {
      before = q[1];
      word = q[2];
      trans = '测验';
      after = q[3];
    } else {
      before = '';
      word = '';
      trans = '';
      after = sample;
    }
  }
  const s = (typeof scale === 'number' && scale > 0) ? scale : 1;
  // 281次：注释样式由第四栏池条目控制（annDecl 生成器输出 cssText）；未指派（缺省/'none'）
  //   时沿用旧逻辑：有底色样式（含默认深条）注释用白字，透明底直显样式前景色。
  const annCss = (annStyle && annStyle.id !== 'none') ? annDecl(annStyle).join(';') : '';
  const annFg = item.bg ? '#ffffff' : (item.fg || '#ffffff');
  const wordCss = 'background:#2e6b43;color:#ffffff;border-radius:2px;padding:0 3px;font-weight:600';
  // 注释模式：预览优先用 radio 选中的模式（用户要求"侧邻注释跟详细注释预览中有变化"），
  //   无覆盖时用样式自带默认（annMode 字段）；plain（样式卡）恒为纯文字展示（单行、无注释块）
  const mode = (annMode !== undefined && annMode !== null) ? annMode : item.annMode;
  if (!word) {
    return '<span style="' + buildSubMiniCss(item, ratio, scale, wrap, flow) + '">' + escapeHtml(after) + '</span>';
  }
  const beforeHtml = escapeHtml(before);
  const wordHtml = '<span style="' + wordCss + '">' + escapeHtml(word) + '</span>';
  const afterHtml = escapeHtml(after);
  if (!plain && mode === 'detail') {
    // 反思（2026-08-19 第八十次）：详细模式注释独立成块——与真实 overlay 一致
    //   （subtitle-overlay.js buildDetailAnnotationHtml 的 .beaver-overlay-ann-line 独立元素）。
    //   字幕行盒（盒样式 buildSubBoxCss）与注释块分离为兄弟元素：注释不带盒背景、
    //   位于盒下方独立一行（用户：'详细模式时候，预览窗口的单词注释并没有独立出来'）。
    //   旧版注释嵌在字幕行盒内（受 overflow:hidden 裁剪），故未"独立出来"。
    // 反思（2026-08-19 第八十一次）：注释块补显式 font-size（0.9×字幕字号，与真实 overlay
    //   .beaver-overlay-annotations 的 0.9em 一致）——旧版继承容器字号（约13px），大字号样式
    //   下注释比字幕小、小字号样式下注释比字幕大（用户反馈"文字样式大小不一"）。
    const subCss = (wrap
      ? 'white-space:normal;max-width:100%;word-break:break-word;line-height:1.35'
      : 'white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis') + ';' + buildSubBoxCss(item, s);
    const subBox = '<span style="' + subCss + '">' + beforeHtml + wordHtml + afterHtml + '</span>';
    // 281次：注释行样式由第四栏池条目控制（annCss=annDecl 输出）；annDecl 不含字体/字重，
    //   字体在块级给 sans 基准、词头保持 font-weight:600（与真实 overlay 注释行一致）。
    const annWordCss = annCss || ('color:' + annFg + ';font-weight:600');
    const annTransCss = annCss || ('color:' + annFg);
    // 293次：注释块字号改百分比口径（旧 item.size px 已退役；本分支现仅样例卡 plain 路径外休眠）
    const annBlock = '<div style="margin-top:4px;line-height:1.3;text-align:left;white-space:' + (wrap ? 'normal' : 'nowrap') + ';font-size:' + Math.round(sizePctToPx(subFontSizePct(item), SUBTITLE_REF_H) * s * 0.9) + 'px;font-family:' + GUIDE_FONTS.sans + '">'
      + '<span style="' + annWordCss + '">' + escapeHtml(word) + '</span> '
      + '<span style="' + annTransCss + '">' + escapeHtml(trans) + '</span></div>';
    if (flow) return subBox + annBlock;
    // 预览：外容器绝对定位居中（盒子中心落在 ratio 中心线），字幕行盒 + 注释块竖排
    return '<span style="position:absolute;left:50%;bottom:' + (ratio * 100) + '%;transform:translate(-50%, 50%);display:flex;flex-direction:column;align-items:center;max-width:94%">'
      + subBox + annBlock + '</span>';
  }
  // 侧邻注释模式（或样式卡 plain）：字幕行内生词高亮 + 注释行内。
  //   281次：注释文本按 annTemplate 模板拆出 {meaning} 前后字面量（不再硬编码圆括号），
  //   样式同样由第四栏池条目（annCss）控制。
  //   plain 卡不显示行内释义——样式卡只展示文字样式，注释布局由下方预览负责。
  //   283次：模板分键——字幕注释行读 videoOverlayAnnTemplate（本函数非 plain 调用
  //   只来自 renderSubPreview；plain 样卡不走此分支）。
  const tplParts = splitAnnTemplate(getPoolSel().videoOverlayAnnTemplate || DEFAULT_ANN_TEMPLATE);
  const annSpanCss = annCss || ('color:' + annFg);
  const inner = beforeHtml + wordHtml
    + (!plain && trans ? '<span style="' + annSpanCss + '">' + tplParts.pre + escapeHtml(trans) + tplParts.post + '</span>' : '')
    + afterHtml;
  return '<span style="' + buildSubMiniCss(item, ratio, scale, wrap, flow) + '">' + inner + '</span>';
}

function subCard(item) {
  const demo = document.createElement('div');
  demo.className = 'demo sub-stage';
  // 反思（2026-08-19 第七十九次）：文字样式卡尺寸与前三个栏目一致——
  //   不再用 92×52 迷你视频区 + 绝对定位，改用 flow 模式水平文本样例（同 .demo 卡片）。
  //   位置不再在样卡上体现（有独立位置卡 + 双预览）。
  // 反思（2026-08-19 第八十一次）：plain 纯文字展示——所有样卡统一单行（无注释块），
  //   避免 detail 样式卡出现"字幕+注释"两行（用户反馈"有的出现了两行"）；
  //   注释布局（侧邻/详细）由下方双预览（radio 驱动）展示。
  const mini = document.createElement('div');
  mini.className = 'sub-demo';
  // 反思（2026-08-20 第八十五次）：样卡字号过小——旧 scale=0.45 是残留。
  // 290次（用户"样例字号小，定义要准确"）：改真实尺寸 scale=1.0——卡片即定义本身，
  //   样例句子取用户输入（_subSample），卡片恒纯文字无注释。
  // 292次换行全显（wrap=true 块级，height:auto 承接）→294次 2 列确认→296次一排方案作废回滚至此。
  const it = Object.assign({}, item, { sample: _subSample });
  mini.innerHTML = subSampleHtml(it, 0, undefined, 1, true, false, true);
  demo.appendChild(mini);
  return demo;
}

// 281次：位置样式卡随独立位置网格一并删除（位置改单选行，预览窗内直接体现位置）。

// 281次：个性化样式合成对象——subtitleCustom 参数 → 字幕样式结构（id 'custom'），
//   供样式卡与预览渲染共用（与内置条目同构：font/fg/bg/size 均来自 storage.subtitleCustom）。
//   282次：加 fx 特效字段；样例去 '(测验)' 注释（正文样式卡只渲染正文）。
function buildCustomStyleObj() {
  return {
    id: 'custom',
    label: { en: 'Custom', zh: '个性化' },
    font: _subCustom.fontFamily,
    fg: _subCustom.fg,
    bg: _subCustom.bg,
    fontSizePct: _subCustom.fontSizePct,
    fx: _subCustom.fx,
    edge: null, bold: false, italic: false, shadow: false, annMode: 'side',
    sample: 'He passed the quiz.'
  };
}

// 282次：用户样式条目 → 渲染对象（与内置条目同构，样式卡/预览共用）。
// 293次：字号改百分比（旧 fontSize px 经 pxToSizePct 换算；缺省 5 即 custom 默认）。
function userStyleObj(st) {
  return {
    id: st.id,
    label: st.label || { en: 'User style', zh: '自建样式' },
    font: st.fontFamily || 'sans',
    fg: st.fg || '#ffffff',
    bg: st.bg || null,
    // 295次三级回退：fontSizePct → 过渡 sizePct → 旧 fontSize px 换算
    fontSizePct: (typeof st.fontSizePct === 'number' && isFinite(st.fontSizePct))
      ? Math.min(12, Math.max(2, st.fontSizePct))
      : ((typeof st.sizePct === 'number' && isFinite(st.sizePct))
        ? Math.min(12, Math.max(2, st.sizePct)) : pxToSizePct(st.fontSize)),
    fx: st.fx || 'none',
    edge: null, bold: false, italic: false, shadow: false, annMode: 'side',
    sample: 'He passed the quiz.'
  };
}

// 文字样式网格重渲染：none + 10 内置（renderStyleGrid）+ 用户自建样式卡
//   （282次，右上角删除钮）。active 高亮按 _subStyleId。
//   290次：个性化卡搬出网格（代码右侧独立卡 #subCustomSideCard，原地刷新不闪）。
function renderSubTextGrid() {
  const grid = $('subtitleStyleGrid');
  renderStyleGrid(grid, SUBTITLE_TEXT_STYLES, _subStyleId, subCard);
  // 282次：用户自建正文样式卡（storage.subtitleUserStyles；点击选中=bindStyleGrid 通用逻辑，
  //   删除钮 stopPropagation 不触发选中）
  for (const st of _userStyles) {
    const obj = userStyleObj(st);
    const ucard = document.createElement('div');
    ucard.className = 'style-card' + (_subStyleId === st.id ? ' active' : '');
    ucard.dataset.id = st.id;
    ucard.dataset.style = st.id;
    ucard.appendChild(subCard(obj));
    const del = document.createElement('button');
    del.className = 'sub-card-del';
    del.type = 'button';
    del.textContent = '×';
    del.title = m('subDelStyle');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteUserStyle(st.id);
    });
    ucard.appendChild(del);
    // 283次：名称可编辑——label div 改 input（点击/键盘 stopPropagation 防 bindStyleGrid
    //   容器委托把输入动作当选卡）；change 写回 st.label（en/zh 同值）并 storage 持久化，
    //   不重渲染网格（保输入焦点；预览与左栏不显示用户卡名称）
    const ulabel = document.createElement('input');
    ulabel.type = 'text';
    ulabel.className = 'card-label-input';
    ulabel.value = styleLabel(obj, getLangState());
    ulabel.title = m('subRenameStyle');
    ulabel.addEventListener('click', (e) => e.stopPropagation());
    ulabel.addEventListener('keydown', (e) => e.stopPropagation());
    ulabel.addEventListener('change', () => {
      const v = ulabel.value.trim();
      if (!v) { ulabel.value = styleLabel(obj, getLangState()); return; }
      st.label = { en: v, zh: v };
      markOwnWrite();
      chrome.storage.local.set({ subtitleUserStyles: _userStyles }, () => log('userStyle rename=', st.id));
    });
    ucard.appendChild(ulabel);
    grid.appendChild(ucard);
  }
}

// 290次：样例句注释对解析——括号式 word(trans) 全局提取；掩盖括号段后，空格式
//   word + CJK 注释（如 vocabulary 词汇）按前词归属提取；按出现顺序排序。
//   无注释对时返回空数组（调用方原样输出整句，不虚构注释，与 subSampleHtml 同纪律）。
function parseSamplePairs(text) {
  const pairs = [];
  const src = String(text || '');
  const masked = src.replace(/([A-Za-z]+)\(([^)]*)\)/g, (m0, w, t, off) => {
    pairs.push({ word: w, trans: t, index: off, end: off + m0.length });
    return ' '.repeat(m0.length);
  });
  const re2 = /([A-Za-z]+) ([\u3400-\u4DBF\u4E00-\u9FFF]+)/g;
  let m2;
  while ((m2 = re2.exec(masked))) {
    const raw = src.substr(m2.index, m2[0].length);
    const sp = raw.indexOf(' ');
    pairs.push({ word: raw.slice(0, sp), trans: raw.slice(sp + 1), index: m2.index, end: m2.index + m2[0].length });
  }
  pairs.sort((a, b) => a.index - b.index);
  return pairs;
}

// 288次：预览专用（注释落样例句中各注释词）；290次改通用解析——默认样例
//   'VocabRadar is short for vocabulary 词汇 radar(雷达).' 注释 vocabulary/词汇 与
//   radar/雷达；side 行内、detail 独立多行。样例卡（subCard/plain）仍纯文字无注释。
function subPreviewHtml(style, ratio, annMode, annStyle) {
  const tplParts = splitAnnTemplate(getPoolSel().videoOverlayAnnTemplate || DEFAULT_ANN_TEMPLATE);
  const annCss = (annStyle && annStyle.id !== 'none') ? annDecl(annStyle).join(';') : '';
  const annFg = style.bg ? '#ffffff' : (style.fg || '#ffffff');
  const wordCss = 'background:#2e6b43;color:#ffffff;border-radius:2px;padding:0 3px;font-weight:600';
  // 292次（用户"侧邻模式没有截短释义"）：注释文本截短（超 24 字切…，detail 独立行同口径）；
  //   side 行内注释字号取 0.85em（32px 级字幕下全尺寸注释过大，overlay 注释行基准 0.9em 同理）。
  const shortTrans = (t) => {
    const s = String(t || '');
    return s.length > 24 ? s.slice(0, 24) + '…' : s;
  };
  const annSpan = (t) => '<span style="' + (annCss || ('color:' + annFg)) + ';font-size:0.85em">'
    + tplParts.pre + escapeHtml(shortTrans(t)) + tplParts.post + '</span>';
  const wordHtml = (w) => '<span style="' + wordCss + '">' + escapeHtml(w) + '</span>';
  // 291次：显式注释对（样例内手写）优先；其余拉丁词按动态缓存补注释（释义语言/词频实时链路），
  //   无缓存（首刷/获取中）暂原样，fetch 回来重渲染补上；句内去重（首个为准）。
  const pairs = parseSamplePairs(_subSample);
  const used = {};
  for (const p of pairs) used[String(p.word).toLowerCase()] = true;
  const dynRe = /[A-Za-z]+/g;
  let dm;
  while ((dm = dynRe.exec(_subSample))) {
    const wl = dm[0].toLowerCase();
    if (used[wl]) continue;
    used[wl] = true;
    const t = _previewAnns.get(wl);
    if (t) pairs.push({ word: dm[0], trans: t, index: dm.index, end: dm.index + dm[0].length });
  }
  pairs.sort((a, b) => a.index - b.index);
  if (!pairs.length) {
    return '<span style="' + buildSubMiniCss(style, ratio, 1, false, false, 1080) + '">'
      + escapeHtml(_subSample) + '</span>';
  }
  const mode = (annMode !== undefined && annMode !== null) ? annMode : style.annMode;
  if (mode === 'detail') {
    let boxInner = '';
    let cursor = 0;
    for (const p of pairs) {
      boxInner += escapeHtml(_subSample.slice(cursor, p.index)) + wordHtml(p.word);
      cursor = p.end;
    }
    boxInner += escapeHtml(_subSample.slice(cursor));
    const subBox = '<span style="white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;'
      + buildSubBoxCss(style, 1, 1080) + '">' + boxInner + '</span>';
    const annWordCss = annCss || ('color:' + annFg + ';font-weight:600');
    const annTransCss = annCss || ('color:' + annFg);
    let lines = '';
    for (const p of pairs) {
      lines += '<div><span style="' + annWordCss + '">' + escapeHtml(p.word) + '</span> '
        + '<span style="' + annTransCss + '">' + escapeHtml(shortTrans(p.trans)) + '</span></div>';
    }
    const annBlock = '<div style="margin-top:4px;line-height:1.3;text-align:left;white-space:nowrap;font-size:'
      + Math.round(sizePctToPx(subFontSizePct(style), 1080) * 0.9) + 'px;font-family:' + GUIDE_FONTS.sans + '">'
      + lines + '</div>';
    return '<span style="position:absolute;left:50%;bottom:' + (ratio * 100) + '%;transform:translate(-50%, 50%);display:flex;flex-direction:column;align-items:center;max-width:94%">'
      + subBox + annBlock + '</span>';
  }
  let inner = '';
  let cursor = 0;
  for (const p of pairs) {
    inner += escapeHtml(_subSample.slice(cursor, p.index)) + wordHtml(p.word) + annSpan(p.trans);
    cursor = p.end;
  }
  inner += escapeHtml(_subSample.slice(cursor));
  return '<span style="' + buildSubMiniCss(style, ratio, 1, false, false, 1080) + '">' + inner + '</span>';
}

// 282次：预览重做（用户"少了竖屏""预览的视频大小按照1080p缩放的，注意字体显示比例"）——
//   ①横屏 16:9 / 竖屏 9:16 切换按钮（_subPreviewOrient 本地态，不写 storage）。
//   ②1080p 虚拟舞台：内层按真实 1080p 像素（1920×1080 / 1080×1920）渲染字幕——
//   字号用样式 size 的真实 px（'none' 时真实 overlay 为 clamp(18, 高×4.5%, 40)，
//   1080p 恰取上限 40px），外层横 480×270 / 竖 270×480 整体 transform:scale(0.25)——
//   字体显示比例与真实 1080p 视频完全一致（旧版 scale=0.8 是 480px 小窗比例，失真）。
//   ③正文样式按 _subStyleId（custom/用户样式→合成对象）；注释行按第四栏池条目
//   （getPoolSel().videoOverlayAnnStyle）——正文/位置/注释任一变化调用本函数立即刷新。
function renderSubPreview() {
  const row = $('subPreviewRow');
  if (!row) return;
  let style = (_subStyleId === 'custom') ? buildCustomStyleObj()
    : findStyle(SUBTITLE_TEXT_STYLES, _subStyleId);
  if (!style) {
    const us = _userStyles.find((s) => s.id === _subStyleId);
    style = us ? userStyleObj(us) : SUBTITLE_TEXT_STYLES[0];
  }
  const pos = findStyle(SUBTITLE_POSITIONS, _subPosId) || SUBTITLE_POSITIONS[0];
  const annStyle = findStyle(POOL_STYLES, getPoolSel().videoOverlayAnnStyle);
  // 注释布局缓存（侧邻 side / 详细 detail，renderAll 从 storage.videoOverlayAnnMode 回填）
  const annMode = _overlayAnnMode;
  row.innerHTML = '';
  // 横竖切换按钮行
  const orient = document.createElement('div');
  orient.className = 'sub-orient-btns';
  for (const o of [
    { id: 'landscape', key: 'subOrientLandscape' },
    { id: 'portrait', key: 'subOrientPortrait' }
  ]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sub-orient-btn' + (_subPreviewOrient === o.id ? ' active' : '');
    b.textContent = m(o.key);
    b.addEventListener('click', () => {
      if (_subPreviewOrient === o.id) return;
      _subPreviewOrient = o.id;
      renderSubPreview();
    });
    orient.appendChild(b);
  }
  row.appendChild(orient);
  const portrait = (_subPreviewOrient === 'portrait');
  const stage = document.createElement('div');
  stage.className = 'sub-preview-stage' + (portrait ? ' portrait' : '');
  // 内层 1080p 舞台（真实像素）+ scale(0.25) 缩放（CSS 见 guide.css）
  const stage1080 = document.createElement('div');
  stage1080.className = 'sub-preview-1080' + (portrait ? ' portrait' : '');
  const mini = document.createElement('div');
  mini.className = 'sub-preview-mini';
  // 293次 size:40 特例删除；297次：预览短边恒 1080（横 1920×1080/竖 1080×1920 短边皆 1080），
  //   无 clamp，与真实 overlay 同口径，不再硬编码
  mini.innerHTML = subPreviewHtml(style, pos.ratio, annMode, annStyle);
  stage1080.appendChild(mini);
  stage.appendChild(stage1080);
  row.appendChild(stage);
  // 283次：缩放动态化——stage 宽按正文页宽百分比（横 50%/竖 28.125%，r10 CSS），窗口
  //   宽度变化后固定 scale(0.25) 失真（"预览的横屏半宽，竖屏半高，按照正文页面的宽度算"），
  //   实测 stage.clientWidth/1920 重算（竖屏分母 1080）；guard w>0 防 display:none 时测 0。
  //   ResizeObserver 模块级持有，stage 每次重建后重挂（先 disconnect 防泄漏）。
  const den = portrait ? 1080 : 1920;
  const fit = () => {
    const w = stage.clientWidth;
    if (w > 0) stage1080.style.transform = 'scale(' + (w / den) + ')';
  };
  fit();
  if (typeof ResizeObserver !== 'undefined') {
    if (_subPreviewRO) _subPreviewRO.disconnect();
    _subPreviewRO = new ResizeObserver(fit);
    _subPreviewRO.observe(stage);
  }
}

// 291次：注释方式单选行（side 侧邻/detail 详细；写 storage.videoOverlayAnnMode，
//   与视频侧栏 Detail 按钮同一键，控制字幕注释布局；change 即刷预览）
function renderSubAnnModeRadios() {
  const box = $('subAnnModeRadios');
  if (!box) return;
  box.innerHTML = '';
  for (const o of [
    { id: 'side', key: 'subAnnSide' },
    { id: 'detail', key: 'subAnnDetail' }
  ]) {
    const lab = document.createElement('label');
    lab.className = 'sub-pos-radio';
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = 'subAnnMode';
    r.value = o.id;
    r.checked = (o.id === _overlayAnnMode);
    r.addEventListener('change', () => {
      if (!r.checked) return;
      _overlayAnnMode = o.id;
      markOwnWrite();
      chrome.storage.local.set({ videoOverlayAnnMode: o.id }, () => log('videoOverlayAnnMode=', o.id));
      renderSubPreview();
    });
    const txt = document.createElement('span');
    txt.textContent = m(o.key);
    lab.appendChild(r);
    lab.appendChild(txt);
    box.appendChild(lab);
  }
}

// 281次：位置单选行（radio 组替代旧位置网格；change 即写 storage.subtitlePosition + 刷预览）
function renderSubPosRadios() {
  const box = $('subPosRadios');
  if (!box) return;
  box.innerHTML = '';
  for (const p of SUBTITLE_POSITIONS) {
    const lab = document.createElement('label');
    lab.className = 'sub-pos-radio';
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = 'subPos';
    r.value = p.id;
    r.checked = (p.id === _subPosId);
    r.addEventListener('change', () => {
      if (!r.checked) return;
      _subPosId = p.id;
      markOwnWrite();
      chrome.storage.local.set({ subtitlePosition: p.id }, () => log('subtitlePosition=', p.id));
      renderSubPreview();
    });
    const txt = document.createElement('span');
    txt.textContent = styleLabel(p, getLangState());
    lab.appendChild(r);
    lab.appendChild(txt);
    box.appendChild(lab);
  }
}

// 282次：字体/特效下拉动态填充——选项来自共享层 SUB_FONT_OPTIONS（12 项）/
//   SUB_FX_OPTIONS（5 项），与 overlay 渲染同源；填充后按当前参数回填选中值。
//   renderAll 每轮调用（幂等重建，语言切换时选项文案随之更新）。
function fillSubCustomSelects() {
  const font = $('subCustomFont'), fx = $('subCustomFx');
  if (!font || !fx) return;
  font.innerHTML = '';
  for (const o of SUB_FONT_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = styleLabel(o, getLangState());
    font.appendChild(opt);
  }
  fx.innerHTML = '';
  for (const o of SUB_FX_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = styleLabel(o, getLangState());
    fx.appendChild(opt);
  }
  font.value = _subCustom.fontFamily;
  fx.value = _subCustom.fx;
}

// 282次：大加号——把当前 Custom 参数（底色/字色/字号/字体/特效）保存为新正文样式
//   （storage.subtitleUserStyles 追加一条，id='user-<时间戳>'），保存后自动选中新样式；
//   可连续点击保存多套（用户"最右侧来个大加号，可以新增字幕正文样式"）。
function bindSubCustomAdd() {
  const btn = $('subCustomAdd');
  if (!btn) return;
  btn.title = m('subAddStyle');
  if (btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    const entry = {
      id: 'user-' + Date.now(),
      label: { en: 'Style ' + (_userStyles.length + 1), zh: '样式 ' + (_userStyles.length + 1) },
      bg: _subCustom.bg,
      fg: _subCustom.fg,
      fontSizePct: _subCustom.fontSizePct,
      fontFamily: _subCustom.fontFamily,
      fx: _subCustom.fx
    };
    _userStyles = _userStyles.concat([entry]);
    _subStyleId = entry.id;
    markOwnWrite();
    chrome.storage.local.set({ subtitleUserStyles: _userStyles, subtitleStyle: entry.id },
      () => log('subtitleUserStyles+', entry.id));
    renderSubTextGrid();
    renderSubPreview();
  });
}

// 288次：点击样例卡回填个性化行——把选中卡参数复制进 Custom 五控件（用户"点击后样式
//   代码复制到个性化输入框，再加号会新增"），选中态不变；custom 卡回填即空操作。
//   映射：font/fg/size 直拷；bg 仅 #rrggbb 进取色器，其余（rgba/transparent/null）走透明勾选
//   （color input 不接受 alpha，属实注明）；fx 内置无字段，按 edge→描边、shadow→阴影近似
//   （pop3d 硬阴影→立体），回填后可再手调。写 storage.subtitleCustom（overlay 仅 style='custom'
//   时消费，不影响当前选中渲染）；随后重绘网格刷新 custom 卡样例（选中态按 _subStyleId 保留）。
function backfillSubCustomFrom(obj) {
  if (!obj || obj.id === 'custom') return;
  const fontOk = SUB_FONT_OPTIONS.some((o) => o.id === obj.font);
  _subCustom = {
    bg: (typeof obj.bg === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj.bg)) ? obj.bg : 'transparent',
    fg: (typeof obj.fg === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj.fg)) ? obj.fg : '#ffffff',
    // 293次：回填百分比；295次三级回退（fontSizePct → 过渡 sizePct → fontSize 换算）
    fontSizePct: (typeof obj.fontSizePct === 'number' && isFinite(obj.fontSizePct))
      ? Math.min(12, Math.max(2, obj.fontSizePct))
      : ((typeof obj.sizePct === 'number' && isFinite(obj.sizePct))
        ? Math.min(12, Math.max(2, obj.sizePct)) : pxToSizePct(obj.fontSize)),
    fontFamily: fontOk ? obj.font : 'sans',
    fx: obj.fx || (obj.edge ? 'stroke' : (obj.shadow ? (/4px 4px/.test(obj.shadow) ? '3d' : 'shadow') : 'none'))
  };
  if (!SUB_FX_OPTIONS.some((o) => o.id === _subCustom.fx)) _subCustom.fx = 'none';
  const tr = $('subCustomBgTransparent');
  if (tr) tr.checked = (_subCustom.bg === 'transparent');
  $('subCustomBg').value = (_subCustom.bg === 'transparent') ? '#000000' : _subCustom.bg;
  $('subCustomBg').disabled = (_subCustom.bg === 'transparent');
  $('subCustomFg').value = _subCustom.fg;
  $('subCustomSize').value = _subCustom.fontSizePct;
  fillSubCustomSelects();
  chrome.storage.local.set({ subtitleCustom: _subCustom }, () => log('subtitleCustom 回填<=', obj.id));
  refreshSubCustomCssText();
  updateCustomSideCard();
}

// 282次：删除用户自建样式——从 subtitleUserStyles 移除；若正选中该样式则回落 'none'。
function deleteUserStyle(id) {
  _userStyles = _userStyles.filter((s) => s.id !== id);
  const patch = { subtitleUserStyles: _userStyles };
  if (_subStyleId === id) {
    _subStyleId = 'none';
    patch.subtitleStyle = 'none';
  }
  markOwnWrite();
  chrome.storage.local.set(patch, () => log('subtitleUserStyles-', id));
  renderSubTextGrid();
  renderSubPreview();
}

// 290次：代码右侧个性化样例卡原地刷新（只碰本卡，不重建网格——
//   控件/CSS 改动走全网格重建会"闪一下才到最终态"；选中态按 _subStyleId 同步）。
// 291次（用户"还是会闪"）：demo 重建（innerHTML 替换）本身即一次闪烁——改常驻单 span，
//   只改 style/textContent，不替换节点；卡片恒纯文字无注释（与网格卡同口径）。
function updateCustomSideCard() {
  const card = $('subCustomSideCard');
  if (!card) return;
  card.classList.toggle('active', _subStyleId === 'custom');
  const demo = $('subCustomSideDemo');
  if (demo) {
    const obj = Object.assign(buildCustomStyleObj(), { sample: _subSample });
    const css = buildSubBoxCss(obj, 1)
      + ';display:block;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    let span = demo.firstElementChild;
    if (!span) {
      span = document.createElement('span');
      demo.appendChild(span);
    }
    span.style.cssText = css;
    if (span.textContent !== _subSample) span.textContent = _subSample;
  }
  const lab = $('subCustomSideLabel');
  if (lab) {
    const t = styleLabel(buildCustomStyleObj(), getLangState());
    if (lab.textContent !== t) lab.textContent = t;
  }
}

// 290次：右侧卡点击=选中 custom（网格内无 custom 卡后的唯一入口；不回填，控件即 custom 本身）
function bindCustomSideCard() {
  const card = $('subCustomSideCard');
  if (!card || card.dataset.bound) return;
  card.dataset.bound = '1';
  card.addEventListener('click', () => {
    _subStyleId = 'custom';
    chrome.storage.local.set({ subtitleStyle: 'custom' }, () => log('subtitleStyle= custom（右侧卡）'));
    const grid = $('subtitleStyleGrid');
    if (grid) grid.querySelectorAll('.style-card').forEach((c) => c.classList.remove('active'));
    updateCustomSideCard();
    renderSubPreview();
  });
}

// 290次：样例文字输入框绑定（持久化 storage.subtitleSample + 重绘卡片与预览；
//   空值回落默认并写回，避免空样例卡全空）。
// 291次（用户"更改似乎不生效"）：change 只在失焦/回车触发，键入时 cards/预览纹丝不动
//   观感即"不生效"——改 input 事件实时重绘（卡片+预览同步，动态注释防抖跟进），
//   持久化防抖 500ms（逐键写 storage 会刷 onChanged 风暴），change 时立即落盘。
let _subSampleSaveTimer = 0;
function bindSubSampleText() {
  const input = $('subSampleText');
  if (!input || input.dataset.bound) return;
  input.dataset.bound = '1';
  const repaint = () => {
    renderSubTextGrid();
    updateCustomSideCard();
    renderSubPreview();
    schedulePreviewAnns();
  };
  input.addEventListener('input', () => {
    const v = input.value.trim();
    _subSample = v || DEFAULT_SUB_SAMPLE;
    if (_subSampleSaveTimer) clearTimeout(_subSampleSaveTimer);
    _subSampleSaveTimer = setTimeout(() => {
      _subSampleSaveTimer = 0;
      markOwnWrite();
      chrome.storage.local.set({ subtitleSample: _subSample }, () => log('subtitleSample=', _subSample));
    }, 500);
    repaint();
  });
  input.addEventListener('change', () => {
    if (_subSampleSaveTimer) { clearTimeout(_subSampleSaveTimer); _subSampleSaveTimer = 0; }
    const v = input.value.trim();
    _subSample = v || DEFAULT_SUB_SAMPLE;
    if (!v) input.value = _subSample;
    markOwnWrite();
    chrome.storage.local.set({ subtitleSample: _subSample }, () => log('subtitleSample=', _subSample));
    repaint();
  });
}

// 281次：个性化控件（底色/字色/字号/字体 + 282次特效）——改任一即切 'custom' 卡并写
//   storage.subtitleCustom + subtitleStyle='custom'，随后刷新右侧卡与预览（290次：
//   不再全网格重建，原地刷新去闪；同时清网格 active，选中态唯一）。
//   283次：底色透明勾选（subCustomBgTransparent）——勾选时 bg 写 'transparent' 并禁用
//   取色器（视觉明确），取消恢复取色值；字号缺省对齐新默认 28。
// 292次 storage 回声抑制：本页字幕流写入后即时渲染已是最终态，onChanged 回声再全量
//   renderAll 会"先经过一个样式再到最终"地闪一次；写前打时间戳，回声分支 1200ms 内跳过。
//   他页写入时间戳久远，正常同步。只覆盖字幕流，池分支行为不变。

function bindStyleGrid(container, storageKey, applyPreview) {
  if (container.dataset.bound) return;
  container.dataset.bound = '1';
  container.addEventListener('click', (e) => {
    const card = e.target.closest('.style-card');
    if (!card) return;
    const id = card.dataset.id;
    container.querySelectorAll('.style-card').forEach((c) => c.classList.remove('active'));
    card.classList.add('active');
    const patch = {};
    patch[storageKey] = id;
    // 280 次：textStyle 联动分支删除——网格现仅用于字幕样式/位置（textStyle 指派走池卡 chip），
    //   且 TEXT_STYLES 常量已并入共享池，此分支引用失效。
    chrome.storage.local.set(patch, () => {
      if (applyPreview) applyPreview(id);
      log('已选择 ' + storageKey + ' =', id);
    });
  });
}

// 当前个性化参数只读出口（loadSettings 首次写回用；只读不写）。
export function getSubCustom() { return _subCustom; }

// 302次：字幕设定同步（renderAll 调用；迁移＋回填＋网格＋预览全链路）。
export function syncSubtitleSettings(res) {
  // 280 次：注释布局 radio 移出引导页（控制在各自侧栏与叠加字幕内）——overlay 布局值入
  //   _overlayAnnMode 缓存供 renderSubPreview 用；侧栏两键仍由各自功能页消费，不再回填
  _overlayAnnMode = res.videoOverlayAnnMode === 'detail' ? 'detail' : 'side';
  // 280 次：注释布局 radio 移出引导页（控制在各自侧栏与叠加字幕内）——overlay 布局值入
  //   _overlayAnnMode 缓存供 renderSubPreview 用；侧栏两键仍由各自功能页消费，不再回填
  _overlayAnnMode = res.videoOverlayAnnMode === 'detail' ? 'detail' : 'side';
  // 281次：字幕段回填——正文样式允许 'custom'（个性化）；282次：用户自建样式
  //   （user-* 前缀且存在于 subtitleUserStyles）同样放行，残留已删 id 回落清洗链。
  //   位置改单选行（renderSubPosRadios）；个性化五控件回填并绑定（bindSubCustom）；
  //   预览立即渲染。旧位置网格/位置卡已删。
  // 293次：用户样式字号改百分比——旧条目一次性迁新键并写回
  // 295次：三级回退（fontSizePct → 过渡 sizePct → fontSize px），旧键清扫
  _userStyles = Array.isArray(res.subtitleUserStyles)
    ? res.subtitleUserStyles.filter((s) => s && typeof s.id === 'string' && s.id.indexOf('user-') === 0)
    : [];
  let _userMigrated = false;
  for (const s of _userStyles) {
    if (typeof s.fontSizePct !== 'number' || !isFinite(s.fontSizePct)) {
      s.fontSizePct = (typeof s.sizePct === 'number' && isFinite(s.sizePct))
        ? Math.min(12, Math.max(2, s.sizePct)) : pxToSizePct(s.fontSize);
      delete s.fontSize;
      delete s.sizePct;
      _userMigrated = true;
    } else if ('sizePct' in s || 'fontSize' in s) {
      delete s.fontSize;
      delete s.sizePct;
      _userMigrated = true;
    }
  }
  if (_userMigrated) { markOwnWrite(); chrome.storage.local.set({ subtitleUserStyles: _userStyles }); }
  const subActive = (res.subtitleStyle === 'custom') ? 'custom'
    : (_userStyles.some((s) => s.id === res.subtitleStyle) ? res.subtitleStyle
      : sanitizeStyleId(SUBTITLE_TEXT_STYLES, res.subtitleStyle));
  if (subActive !== (res.subtitleStyle || 'none')) { markOwnWrite(); chrome.storage.local.set({ subtitleStyle: subActive }); }
  const posActive = sanitizePositionId(res.subtitlePosition);
  if (posActive !== (res.subtitlePosition || 'b20')) { markOwnWrite(); chrome.storage.local.set({ subtitlePosition: posActive }); }
  _subStyleId = subActive;
  _subPosId = posActive;
  // 281次：个性化参数回填（storage.subtitleCustom；缺省/非法值回落默认对象）。
  //   282次：加 fx；fontFamily 白名单放宽为 SUB_FONT_OPTIONS 全部 12 项（旧版仅三项）。
  //   283次：bg 'transparent'（透明勾选态）原样保留；勾选态回填 checkbox 并禁用取色器
  //   （color input 不接受非 #rrggbb 值，透明时给占位黑色）。
  // 293次：字号改百分比；295次三级回退（fontSizePct → 过渡 sizePct → fontSize 换算）。
  const sc = res.subtitleCustom || {};
  _subCustom = {
    bg: sc.bg || 'transparent',
    fg: sc.fg || '#ffffff',
    fontSizePct: (typeof sc.fontSizePct === 'number' && isFinite(sc.fontSizePct))
      ? Math.min(12, Math.max(2, sc.fontSizePct))
      : ((typeof sc.sizePct === 'number' && isFinite(sc.sizePct))
        ? Math.min(12, Math.max(2, sc.sizePct)) : pxToSizePct(sc.fontSize)),
    fontFamily: SUB_FONT_OPTIONS.some((o) => o.id === sc.fontFamily) ? sc.fontFamily : 'sans',
    fx: SUB_FX_OPTIONS.some((o) => o.id === sc.fx) ? sc.fx : 'none'
  };
  const bgTransparent = (_subCustom.bg === 'transparent');
  const trCb = $('subCustomBgTransparent');
  if (trCb) trCb.checked = bgTransparent;
  $('subCustomBg').value = bgTransparent ? '#000000' : _subCustom.bg;
  $('subCustomBg').disabled = bgTransparent;
  $('subCustomFg').value = _subCustom.fg;
  $('subCustomSize').value = _subCustom.fontSizePct;
  fillSubCustomSelects();
  // 289次：代码框初始刷新 + 绑定（回填/跨页同步后代码与控件一致）
  bindSubCustomCss();
  refreshSubCustomCssText();
  // 290次：样例文字回填（空/非字符串回落默认；输入框绑定；右侧卡初始刷新走 update）
  // 291次：290版硬编码注释旧默认（LEGACY）一并迁新默认（注释改动态链路）
  _subSample = (typeof res.subtitleSample === 'string' && res.subtitleSample.trim())
    ? res.subtitleSample : DEFAULT_SUB_SAMPLE;
  if (_subSample === LEGACY_SUB_SAMPLE_290) _subSample = DEFAULT_SUB_SAMPLE;
  if (_subSample !== res.subtitleSample) { markOwnWrite(); chrome.storage.local.set({ subtitleSample: _subSample }); }
  $('subSampleText').value = _subSample;
  bindSubSampleText();
  bindCustomSideCard();
  updateCustomSideCard();
  renderSubTextGrid();
  bindStyleGrid($('subtitleStyleGrid'), 'subtitleStyle', (id) => {
    _subStyleId = id;
    // 288次：选中即回填个性化行（内置/自建卡参数→Custom 五控件；custom 卡跳过）
    if (id !== 'custom') {
      let sel = findStyle(SUBTITLE_TEXT_STYLES, id);
      if (!sel) {
        const us = _userStyles.find((s) => s.id === id);
        if (us) sel = userStyleObj(us);
      }
      if (sel) backfillSubCustomFrom(sel);
    }
    renderSubPreview();
  });
  renderSubPosRadios();
  renderSubAnnModeRadios();
  bindSubCustom();
  bindSubCustomAdd();
  renderSubPreview();
  // 291次：动态注释跟进（样例/阈值/语言变化后刷新缓存；防抖+忙互斥在函数内）
  schedulePreviewAnns();
}


// 289次：五控件应用抽出（控件改动与 CSS 代码改动共用同一应用路径）
function applySubCustomControls() {
  const bg = $('subCustomBg'), fg = $('subCustomFg'), size = $('subCustomSize'),
    font = $('subCustomFont'), fx = $('subCustomFx'), tr = $('subCustomBgTransparent');
  if (!bg || !fg || !size || !font || !fx) return;
  _subCustom = {
    bg: (tr && tr.checked) ? 'transparent' : (bg.value || '#000000'),
    fg: fg.value || '#ffffff',
    // 293次：字号控件改百分比（2-12%，步进 0.5）；296次缺省一直默认 7%
    fontSizePct: Math.min(12, Math.max(2, parseFloat(size.value) || 7)),
    fontFamily: font.value || 'sans',
    fx: fx.value || 'none'
  };
  _subStyleId = 'custom';
  markOwnWrite();
  chrome.storage.local.set({ subtitleStyle: 'custom', subtitleCustom: _subCustom },
    () => log('subtitleCustom=', JSON.stringify(_subCustom)));
  // 290次：原地刷新（右侧卡 + 预览），不清焦点不闪网格；网格旧 active 清掉保持选中唯一
  const grid = $('subtitleStyleGrid');
  if (grid) grid.querySelectorAll('.style-card').forEach((c) => c.classList.remove('active'));
  updateCustomSideCard();
  renderSubPreview();
  refreshSubCustomCssText();
}

// 289次：当前个性化参数的 CSS 代码文本（与预览/overlay 同源：buildUserStyleDecl）
// 293次：字号行改百分比形式（font-size:5% ≈27px@540p；解析器认 %，px 按 540 换算；
//   注释内无冒号，解析切分安全）
function subCustomCssText() {
  const px = sizePctToPx(_subCustom.fontSizePct, SUBTITLE_REF_H);
  return buildUserStyleDecl({
    bg: _subCustom.bg,
    fg: _subCustom.fg,
    fontSizePct: _subCustom.fontSizePct,
    fontFamily: _subCustom.fontFamily,
    fx: _subCustom.fx
  }).map((d) => (d.indexOf('font-size') === 0
    ? 'font-size:' + _subCustom.fontSizePct + '% (~' + px + 'px @540p)' : d)).join(';\n') + ';';
}

// 289次：代码框刷新（编辑聚焦时不覆盖，避免打断输入）
function refreshSubCustomCssText() {
  const ta = $('subCustomCss');
  if (!ta) return;
  if (document.activeElement === ta) return;
  ta.value = subCustomCssText();
}

// 289次：CSS 代码解析回填五控件——仅识别本框生成的属性子集（background/color/
//   font-size/font-family/text-shadow/-webkit-text-stroke），未知属性忽略；
//   全无可识别时沿用旧参数（不拿"解析失败"当用户意图，照实打日志）。
//   字体按生成串精确回查选项，找不到按首 token 前缀匹配；阴影按 currentColor→发光、
//   4px 硬偏移→立体、其余→阴影启发；描边→描边。
function parseSubCustomCssText(text) {
  const out = {};
  const seen = { bg: false, fg: false, size: false, font: false, fx: false };
  const normFamily = (v) => String(v).replace(/["']/g, '').replace(/\s+/g, '').toLowerCase();
  for (const part of String(text || '').split(';')) {
    const i = part.indexOf(':');
    if (i === -1) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim();
    if (!val) continue;
    if ((prop === 'background' || prop === 'background-color') && !seen.bg) {
      seen.bg = true;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) out.bg = { transparent: false, color: val };
      else out.bg = { transparent: true };
    } else if (prop === 'color' && !seen.fg) {
      seen.fg = true;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) out.fg = val;
    } else if (prop === 'font-size' && !seen.size) {
      seen.size = true;
      // 293次：认百分比（5% 或生成串 5% (~27px @540p) 取前导数），px 按 540 换算
      const pm = val.match(/^([\d.]+)\s*%/);
      if (pm && isFinite(parseFloat(pm[1]))) {
        out.fontSizePct = Math.min(12, Math.max(2, parseFloat(pm[1])));
      } else {
        const n = parseInt(val, 10);
        if (isFinite(n)) out.fontSizePct = pxToSizePct(n);
      }
    } else if (prop === 'font-family' && !seen.font) {
      seen.font = true;
      const nv = normFamily(val);
      let hit = SUB_FONT_OPTIONS.find((o) => normFamily(subFontFamily(o.id)) === nv);
      if (!hit) {
        const first = nv.split(',')[0];
        hit = SUB_FONT_OPTIONS.find((o) => o.id === first || normFamily(subFontFamily(o.id)).indexOf(first + ',') === 0);
      }
      if (hit) out.fontFamily = hit.id;
    } else if (prop === 'text-shadow' && !seen.fx) {
      seen.fx = true;
      // 注：rgba() 内逗号不能用于计数，硬阴影按 4px 偏移特征识别（与回填同口径）
      out.fx = /currentcolor/i.test(val) ? 'glow' : (/4px 4px/.test(val) ? '3d' : 'shadow');
    } else if (prop === '-webkit-text-stroke' && !seen.fx) {
      seen.fx = true;
      out.fx = 'stroke';
    }
  }
  return out;
}

// 289次：代码框改动应用——解析→写回五控件→走统一应用路径（含预览）；
//   成功后代码框重生成规范文本（往返归一）；全无可识别则回滚显示旧代码并照实打日志。
function applySubCustomCssText() {
  const ta = $('subCustomCss');
  if (!ta) return;
  const parsed = parseSubCustomCssText(ta.value);
  const keys = Object.keys(parsed);
  if (!keys.length) {
    console.warn('[VocabRadar][guide] CSS 代码无可识别声明，沿用旧参数');
    ta.value = subCustomCssText();
    return;
  }
  if (parsed.bg) {
    $('subCustomBgTransparent').checked = parsed.bg.transparent;
    $('subCustomBg').value = parsed.bg.transparent ? '#000000' : parsed.bg.color;
    $('subCustomBg').disabled = parsed.bg.transparent;
  }
  if (parsed.fg) $('subCustomFg').value = parsed.fg;
  if (parsed.fontSizePct) $('subCustomSize').value = parsed.fontSizePct;
  if (parsed.fontFamily) {
    fillSubCustomSelects();
    $('subCustomFont').value = parsed.fontFamily;
  }
  if (parsed.fx) {
    fillSubCustomSelects();
    $('subCustomFx').value = parsed.fx;
  }
  applySubCustomControls();
  ta.value = subCustomCssText();
  try { ta.focus(); } catch (_) { /* ignore */ }
}

// 289次：代码框绑定（只绑一次；change 时应用）
function bindSubCustomCss() {
  const ta = $('subCustomCss');
  if (!ta || ta.dataset.bound) return;
  ta.dataset.bound = '1';
  ta.addEventListener('change', applySubCustomCssText);
}

function bindSubCustom() {
  const bg = $('subCustomBg'), fg = $('subCustomFg'), size = $('subCustomSize'),
    font = $('subCustomFont'), fx = $('subCustomFx'), tr = $('subCustomBgTransparent');
  if (!bg || !fg || !size || !font || !fx || bg.dataset.bound) return;
  bg.dataset.bound = '1';
  const apply = () => applySubCustomControls();
  bg.addEventListener('change', apply);
  fg.addEventListener('change', apply);
  size.addEventListener('change', apply);
  font.addEventListener('change', apply);
  fx.addEventListener('change', apply);
  if (tr) {
    // 283次：勾选切换——透明时取色器置灰（disabled），apply 统一写 storage
    tr.addEventListener('change', () => {
      bg.disabled = tr.checked;
      apply();
    });
  }
}