// VocabRadar 引导页 注释池模块（302次拆分：门面模式）
// 职责：Word Annotation 设定栏——左栏选中/候选池网格/池说明/内联复制卡/样例行/
//   个性化行（七控件/CSS代码/右侧卡/加号/用户卡）/模板输入框绑定/设定同步。
// 说明：由 guide.js 机械拆分而来，代码逐字保留，未改动任何逻辑（syncPoolSettings
//   组装与 bindAnnTemplate 除外，见注）。设定页编排（renderAll/init）仍在 guide.js。
// 依赖：shared（$ / m / 语言 / 日志 / 回声戳）+ lib（池/模板/注解/注解链路）；
//   sub-style.js 只读本模块 _poolSel（getPoolSel），本模块不依赖 sub-style（无环）。

import { $, m, getLangState, markOwnWrite, log, sanitizeStyleId } from './shared.js';
import {
  POOL_STYLES, VANN_TO_ANN_MIGRATION, wordDecl, annDecl,
  DEFAULT_ANN_TEMPLATE, splitAnnTemplate, styleLabel, resolveAnnEntry,
  annCustomCssSections, poolPaint, ANN_DEFAULT_STYLE
} from '../lib/styles.js';
import { getAnnotations } from '../lib/annotator.js';
import { ensureReady } from '../lib/dictionary.js';
import { pickCleanShortTrans } from '../lib/dict-clean.js';

// 池选择态只读出口（sub-style.js 预览消费注释样式与模板；只读不写）。
export function getPoolSel() { return _poolSel; }
// 当前选中栏只读出口（renderAll 左栏高亮用；切换只走 bindPoolLeft）。
export function getPoolTarget() { return _poolTarget; }

// 302次：注释模板输入框绑定（原 init 内联，移入本模块；守卫防重复绑定；
//   行为与原来一致：写当前栏键＋重建池网格）。
export function bindAnnTemplate() {
  const input = $('annTemplate');
  if (!input || input.dataset.bound) return;
  input.dataset.bound = '1';
  input.addEventListener('change', (e) => {
    let tpl = e.target.value;
    if (!tpl || !tpl.trim()) {
      tpl = DEFAULT_ANN_TEMPLATE;
      e.target.value = tpl;
    }
    const key = ANN_TPL_KEYS[_poolTarget] || 'annTemplate';
    _poolSel[key] = tpl;
    chrome.storage.local.set({ [key]: tpl }, () => log('注释模板[' + key + ']=', tpl));
    renderPoolGrid();
  });
}

// 280 次：候选池当前选择缓存（四键指派状态 + 注释模板；renderAll 回填）。
//   281次：新增第四键 videoOverlayAnnStyle（视频中字幕的注释行样式）。
//   318次：四键初值=默认代指常量 ANN_DEFAULT_STYLE（default 是代指，绝对值唯一真源
//   在常量，版本变化才改常量值；317 次的 storage 指针键 annDefaultStyle 撤销）。
// 283次：注释模板分键——annTemplate 只归 textStyle 栏（text-hint.js 消费），其余三栏各用
//   独立键（webAnnTemplate=文本侧栏、videoAnnTemplate=视频侧栏、videoOverlayAnnTemplate=
//   叠加字幕注释行），"Annotation template 只会影响当前选中的注释栏目"。
const ANN_TPL_KEYS = {
  textStyle: 'annTemplate',
  annotationStyle: 'webAnnTemplate',
  videoAnnotationStyle: 'videoAnnTemplate',
  videoOverlayAnnStyle: 'videoOverlayAnnTemplate'
};
const _poolSel = {
  textStyle: ANN_DEFAULT_STYLE, annotationStyle: ANN_DEFAULT_STYLE,
  videoAnnotationStyle: ANN_DEFAULT_STYLE, videoOverlayAnnStyle: ANN_DEFAULT_STYLE,
  annTemplate: DEFAULT_ANN_TEMPLATE,
  webAnnTemplate: DEFAULT_ANN_TEMPLATE, videoAnnTemplate: DEFAULT_ANN_TEMPLATE, videoOverlayAnnTemplate: DEFAULT_ANN_TEMPLATE
};
// 281次：左列当前选中栏（点击 .pool-item 切换；池卡点击指派给该栏）
let _poolTarget = 'textStyle';
// 301次：注释个性化参数（Custom 行七控件）＋用户自建缓存
// 302次（用户"注释也应当没有背景色"）：预设改透明底绿字（青瓷深底作废；生词底色待用户定值，暂留）。
let _annCustom = { wordBg: 'transparent', wordFg: '#004d40', annBg: 'transparent', annFg: '#004d40', radius: '4px', bold: true };
let _annUserStyles = [];
// 301次：装饰线形选项（none/underline/wavy/dashed/dotted；颜色取注释字色，见 buildAnnCustomObj）
const ANN_DECO_OPTIONS = [
  { id: 'none', en: 'None', zh: '无' },
  { id: 'underline', en: 'Underline', zh: '下划线' },
  { id: 'wavy', en: 'Wavy', zh: '波浪线' },
  { id: 'dashed', en: 'Dashed', zh: '虚线' },
  { id: 'dotted', en: 'Dotted', zh: '点线' }
];
// 301次：注释样例（池卡共用；默认 vocab radar，只注释末词 radar，注释走动态链路）
const DEFAULT_ANN_SAMPLE = 'vocab radar';
let _annSample = DEFAULT_ANN_SAMPLE;
let _annSampleTrans = new Map();
let _annSampleTimer = 0;
let _annSampleBusy = false;

// 281次：共享样式候选池网格（去 280 次的三指派钮）——每张池卡 = 样例（wordDecl/annDecl
//   生成器输出，与真实渲染同源）+ 名称；active 高亮按左列选中栏的当前指派（_poolSel[_poolTarget]）。
//   网格一次建卡不重建（用户要求"不重渲染"），指派/切栏只更新 active 类。
export function renderPoolGrid() {
  const grid = $('poolStyleGrid');
  grid.innerHTML = '';
  const buildCard = (item) => {
    const card = document.createElement('div');
    card.className = 'style-card' + (_poolSel[_poolTarget] === item.id ? ' active' : '');
    card.dataset.style = item.id;
    card.appendChild(poolCardDemo(item));
    return card;
  };
  const buildLabel = (item, editable) => {
    if (!editable) {
      const label = document.createElement('div');
      label.className = 'card-label';
      label.textContent = styleLabel(item, getLangState());
      return label;
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'card-label-input';
    input.value = styleLabel(item, getLangState());
    input.title = m('subRenameStyle');
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (!v) { input.value = styleLabel(item, getLangState()); return; }
      const st = _annUserStyles.find((s) => s && s.id === item.id);
      if (!st) return;
      st.label = { en: v, zh: v };
      markOwnWrite();
      chrome.storage.local.set({ annotationUserStyles: _annUserStyles }, () => log('annUserStyle rename=', item.id));
    });
    return input;
  };
  // 303次：绘制三组分组（合成/重绘/重排，规则见 styles.poolPaint；custom/用户卡同样归组；
  //   分组 wrapper display:contents 不打断 5 列流，组名占整行；空组显示占位行）。
  const PAINT_GROUPS = [
    { id: 'composite', key: 'poolPaintComposite' },
    { id: 'repaint', key: 'poolPaintRepaint' },
    { id: 'reflow', key: 'poolPaintReflow' }
  ];
  const entries = [];
  // 316次（用户"删除none default样式。都已经指定了默认样式，回落至此，你咋还能回落到其他样式"）：
  //   none（Default）卡删除——默认指派即 green-background（老默认绿底），指派/取消/
  //   脏值回落全部落它，无独立的"默认配色态"卡。315 次的恢复说明作废。
  for (const item of POOL_STYLES) {
    entries.push({ item, kind: 'builtin' });
  }
  // 301次：个性化卡（Custom 行参数的实时样例；点击选中 custom，与内置卡同逻辑）
  entries.push({ item: buildAnnCustomObj(), kind: 'custom' });
  // 301次：用户自建卡（改名 input＋删除钮；点击选中/回填走通用逻辑）
  for (const st of _annUserStyles) entries.push({ item: st, kind: 'user' });
  for (const g of PAINT_GROUPS) {
    const head = document.createElement('div');
    head.className = 'pool-group-name';
    head.textContent = m(g.key);
    grid.appendChild(head);
    const inGroup = entries.filter(({ item }) => poolPaint(item) === g.id);
    // 316次（用户"样式池组内样式顺序改为名称排列"）：组内按当前语言名称排序
    //   （zh→拼音序 / en→字母序，Intl.Collator 地区感知；custom/用户卡用其 label 一起排）。
    const coll = new Intl.Collator(getLangState() === 'zh' ? 'zh' : 'en');
    inGroup.sort((a, b) => coll.compare(styleLabel(a.item, getLangState()), styleLabel(b.item, getLangState())));
    if (!inGroup.length) {
      const em = document.createElement('div');
      em.className = 'pool-group-empty';
      em.textContent = m('poolPaintEmpty');
      grid.appendChild(em);
      continue;
    }
    const wrap = document.createElement('div');
    wrap.className = 'pool-group';
    wrap.dataset.paint = g.id;
    for (const { item, kind } of inGroup) {
      const card = buildCard(item);
      if (kind === 'user') {
        const del = document.createElement('button');
        del.className = 'sub-card-del';
        del.type = 'button';
        del.textContent = '×';
        del.title = m('subDelStyle');
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteAnnUserStyle(item.id);
        });
        card.appendChild(del);
        // 307次：名称挪进 demo 框内新行（用户"样式名称挪进框内，新行"）；删除按钮仍挂卡
        card.querySelector('.demo').appendChild(buildLabel(item, true));
      } else {
        card.querySelector('.demo').appendChild(buildLabel(item, false));
      }
      wrap.appendChild(card);
    }
    grid.appendChild(wrap);
  }
}

// 281次：池顶文本说明（"最上是文本说明"）——随左栏选中项切换，说明该栏样式的用途。
//   282次：按用户"最上是文本说明 不重渲染"重排——本说明=用途+「指派即时生效不重渲染」
//   后缀，位于池卡网格上方（段1）；模板行上方另有一段「触发渲染」说明（段2，静态键）。
//   说明行不重建 DOM，只换文字。
// 283次：段2（poolNoteRerender）改动态——模板已分键只作用于当前选中栏，说明拼当前栏名
//   （"注释模板（网页提示）——修改会触发重渲染该栏候选样例。"）。调用时机：
//   ①renderAll 池段（候选列建卡完成后）②applyTexts 的 fillByDataKey 之后
//   （语言切换会用 data-key 静态文案覆盖此行，必须重跑动态拼接还原栏名）。
export function renderPoolNote() {
  const note = $('poolNoteNoRerender');
  if (!note) return;
  const KEY = {
    textStyle: 'poolNoteTextStyle',
    annotationStyle: 'poolNoteAnnotationStyle',
    videoAnnotationStyle: 'poolNoteVideoAnnotationStyle',
    videoOverlayAnnStyle: 'poolNoteVideoOverlayAnnStyle'
  };
  note.textContent = m(KEY[_poolTarget] || KEY.textStyle) + ' ' + m('poolNoteNoRerenderSuffix');
  const rerender = $('poolNoteRerender');
  if (rerender) {
    const ITEM = {
      textStyle: 'poolItemWebHint',
      annotationStyle: 'poolItemWebSidebar',
      videoAnnotationStyle: 'poolItemSidebar',
      videoOverlayAnnStyle: 'poolItemSubAnn'
    };
    // 中文直连括号内栏名（无空格），英文以空格分词
    const sep = (getLangState() === 'zh') ? '' : ' ';
    rerender.textContent = m('annTplScopePrefix') + sep + m(ITEM[_poolTarget] || ITEM.textStyle) + sep + m('annTplScopeSuffix');
  }
}

// 281次：左栏内联复制卡（用户裁定"选中之后，直接把卡片复制过去"）——把池卡（样例+名称）
//   原样复制进左栏选中项的 .pool-item-demo（未指派时清空显示占位）。
//   复制实现：从池网格中找同 id 卡，cloneNode 其 demo 与 label（"直接把卡片复制过去"）。
export function renderPoolSideDemos() {
  const grid = $('poolStyleGrid');
  document.querySelectorAll('.pool-left .pool-item').forEach((item) => {
    const box = item.querySelector('.pool-item-demo');
    if (!box) return;
    box.innerHTML = '';
    const id = _poolSel[item.dataset.target];
    // 318次：none 卡已于 316 次删除（'none' 作为样式值非法）；当前语义=指派任何具体
    //   样式即复制池卡，仅未指派（!id）时保持占位空显示。
    if (!id) return;
    const src = grid ? grid.querySelector('.style-card[data-style="' + id + '"]') : null;
    if (!src) return;
    // 307次：demo 内已含名称行（.card-label/.card-label-input），clone 后剥除——
    //   左栏复制卡仍用外置 .pool-inline-label，避免与框内名称重复。
    //   顺带修复隐性崩溃：原 src.querySelector('.card-label') 对用户卡返回 null
    //   （用户卡类名是 .card-label-input，token 不同），textContent 读取即崩。
    const srcDemo = src.querySelector('.demo').cloneNode(true);
    const innerLab = srcDemo.querySelector('.card-label, .card-label-input');
    if (innerLab) innerLab.remove();
    box.appendChild(srcDemo);
    const lab = document.createElement('div');
    lab.className = 'pool-inline-label';
    const labEl = src.querySelector('.card-label, .card-label-input');
    lab.textContent = labEl ? ((labEl.value !== undefined) ? labEl.value : labEl.textContent) : '';
    box.appendChild(lab);
  });
}

// 281次：左栏选中态——点击 .pool-item 切换 _poolTarget（高亮 + 池说明 + 池卡 active 跟随）。
//   项内开关/复选的点击同时会选中该栏（操作哪个栏哪个栏高亮，符合直觉且无副作用）。
export function bindPoolLeft() {
  const left = document.querySelector('.pool-left');
  if (!left || left.dataset.bound) return;
  left.dataset.bound = '1';
  left.addEventListener('click', (e) => {
    const item = e.target.closest('.pool-item');
    if (!item || !item.dataset.target) return;
    // 299次：Query 卡无样式指派，不参与选中（豁免；开关照常用）
    if (item.dataset.target === 'query') return;
    if (_poolTarget === item.dataset.target) return;
    _poolTarget = item.dataset.target;
    document.querySelectorAll('.pool-left .pool-item').forEach((it) => {
      it.classList.toggle('selected', it.dataset.target === _poolTarget);
    });
    renderPoolNote();
    // 283次：切栏回填模板输入框——模板分键后每栏独立，输入框始终显示当前选中栏的模板
    const tplInput = $('annTemplate');
    if (tplInput) tplInput.value = _poolSel[ANN_TPL_KEYS[_poolTarget]] || DEFAULT_ANN_TEMPLATE;
    // 池卡 active 跟随新选中栏的当前指派（不重建网格）
    const grid = $('poolStyleGrid');
    grid.querySelectorAll('.style-card').forEach((c) => {
      c.classList.toggle('active', c.dataset.style === _poolSel[_poolTarget]);
    });
  });
}

// 281次：池卡样例——wordDecl/annDecl 生成器输出作 cssText（与真实渲染同源，覆盖渐变/描边/
//   空心/着重号/SVG 波浪等全部新字段）；注释文本按 annTemplate 拆出 {meaning} 前后字面量。
// 301次：样例改用户输入句（_annSample，默认 vocab radar）——前文原样，末拉丁词为注释词，
//   释义取动态缓存（字幕同款链路），无缓存暂不渲染注释行（fetch 回来重绘补上）。
function annSampleModel() {
  const text = _annSample || DEFAULT_ANN_SAMPLE;
  const words = [];
  const re = /[A-Za-z]+/g;
  let m;
  while ((m = re.exec(text))) words.push({ word: m[0], index: m.index, end: m.index + m[0].length });
  const last = words.length ? words[words.length - 1] : null;
  const { pre, post } = splitAnnTemplate(_poolSel[ANN_TPL_KEYS[_poolTarget]] || DEFAULT_ANN_TEMPLATE);
  const trans = (last && _annSampleTrans.get(last.word.toLowerCase())) || '';
  return { text, last, pre, post, trans };
}
function poolCardDemo(item) {
  const demo = document.createElement('div');
  demo.className = 'demo';
  // 307次（用户"样式名称挪进框内，新行"）：样例四段包进 .demo-line 同行流，
  //   名称行（buildLabel）由 renderPoolGrid 追加到 demo，形成「样例行＋名称行」纵向结构
  const line = document.createElement('div');
  line.className = 'demo-line';
  demo.appendChild(line);
  const model = annSampleModel();
  const lead = model.last ? model.text.slice(0, model.last.index) : model.text;
  if (lead) {
    const l = document.createElement('span');
    l.textContent = lead;
    line.appendChild(l);
  }
  if (model.last) {
    const w = document.createElement('span');
    w.className = 'word-demo';
    w.textContent = model.last.word;
    w.style.cssText = wordDecl(item).join(';');
    line.appendChild(w);
    if (model.trans) {
      const a = document.createElement('span');
      a.className = 'ann-demo';
      a.textContent = model.pre + model.trans + model.post;
      a.style.cssText = annDecl(item).join(';');
      line.appendChild(a);
    }
    const tail = model.text.slice(model.last.end);
    if (tail) {
      const t = document.createElement('span');
      t.textContent = tail;
      line.appendChild(t);
    }
  }
  return demo;
}

// 301次：样例末词动态注释（字幕 schedulePreviewAnns 同款：防抖＋忙互斥＋过期丢弃＋失败沿用缓存）。
//   阈值传 0（展示位恒注释，不做词频过滤；释义语言走 translator 当前目标语言）。
function scheduleAnnSample() {
  if (_annSampleTimer) clearTimeout(_annSampleTimer);
  _annSampleTimer = setTimeout(refreshAnnSample, 600);
}
async function refreshAnnSample() {
  _annSampleTimer = 0;
  if (_annSampleBusy) { scheduleAnnSample(); return; }
  _annSampleBusy = true;
  const text = _annSample || DEFAULT_ANN_SAMPLE;
  const words = [];
  const re = /[A-Za-z]+/g;
  let m;
  while ((m = re.exec(text))) words.push(m[0]);
  const last = words.length ? words[words.length - 1] : '';
  try {
    try { await ensureReady(); } catch (_) { /* 降级：用缓存/空注释 */ }
    if (text !== (_annSample || DEFAULT_ANN_SAMPLE)) return;
    const anns = await getAnnotations(last, 0, new Set(), null, false);
    if (text !== (_annSample || DEFAULT_ANN_SAMPLE)) return;
    const hit = (anns || []).find((a) => a && String(a.word).toLowerCase() === last.toLowerCase());
    const t = hit ? pickCleanShortTrans(hit.translations || []) : '';
    const map = new Map(_annSampleTrans);
    if (t) map.set(last.toLowerCase(), t);
    else map.delete(last.toLowerCase());
    _annSampleTrans = map;
    renderPoolGrid();
    renderPoolSideDemos();
    updateAnnCustomSideCard();
  } catch (e) {
    console.warn('[VocabRadar][guide] 池样例注释获取失败，沿用旧缓存:', e && e.message);
  } finally {
    _annSampleBusy = false;
  }
}

// 281次：池卡点击指派——点池卡=指派给左栏选中栏。
//   318次：再点同卡取消，回落默认代指常量 ANN_DEFAULT_STYLE（default 是代指，绝对值
//   唯一真源在常量，版本变化才改常量值）。
//   Web（textStyle）联动写 hintFirstBg/hintFirstFg（池条目 wordBg/wordFg 或默认绿白配色）。
//   更新策略（用户要求"不重渲染"）：只切该卡 active 类 + 刷新左栏复制卡，不重建网格。
export function bindPoolGrid() {
  const grid = $('poolStyleGrid');
  if (grid.dataset.bound) return;   // renderAll 可多次触发，防重复绑定（同 bindStyleGrid 口径）
  grid.dataset.bound = '1';
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.style-card');
    if (!card) return;
    const feat = _poolTarget;
    const next = (_poolSel[feat] === card.dataset.style) ? ANN_DEFAULT_STYLE : card.dataset.style;
    _poolSel[feat] = next;
    // 301次：指派写 storage 即打回声戳——本页已即时切类，跳过回声全量重建（281"不重渲染"本意）。
    markOwnWrite();
    if (feat === 'textStyle') {
      // 301次：联动解析改统一入口（custom/用户条目亦可派生前后景）
      // 318次：恢复三参签名；池外 id 回落由 resolveAnnEntry 内部锚定 ANN_DEFAULT_STYLE
      const st = resolveAnnEntry(next, buildAnnCustomObj(), _annUserStyles);
      chrome.storage.local.set({
        textStyle: next,
        hintFirstBg: (st && st.wordBg) || '#2e6b43',
        hintFirstFg: (st && st.wordFg) || '#ffffff'
      }, () => log('textStyle=', next));
    } else {
      chrome.storage.local.set({ [feat]: next }, () => log(feat + '=', next));
    }
    // 301次：点用户卡回填个性化行（仿字幕；custom 卡即当前控件参数，无需回填）
    if (next !== 'ann-custom') {
      const us = _annUserStyles.find((s) => s && s.id === next);
      if (us) backfillAnnCustomFrom(us);
    }
    grid.querySelectorAll('.style-card').forEach((c) => {
      c.classList.toggle('active', c.dataset.style === _poolSel[feat]);
    });
    renderPoolSideDemos();
  });
}

// 301次：注释个性化对象合成（_annCustom → 池条目结构，id 'ann-custom'）。
//   deco 存 _annCustom 内（select 只是它的编辑器），重载不丢。
function buildAnnCustomObj() {
  return Object.assign(
    { id: 'ann-custom', label: { en: 'Custom', zh: '个性化' } },
    _annCustom
  );
}

// 301次：装饰线 select 值 → deco 对象（颜色取注释字色；none 即无装饰字段）。
function decoFromSelect() {
  const sel = $('annCustomDeco');
  const id = sel ? sel.value : 'none';
  if (!id || id === 'none') return undefined;
  return { line: 'underline', style: id, color: _annCustom.annFg };
}
let _annSampleSaveTimer = 0;

// 301次：装饰线下拉填充（选项双语随界面语言；renderAll 每轮调用，幂等重建）。
function fillAnnCustomDeco() {
  const sel = $('annCustomDeco');
  if (!sel) return;
  sel.innerHTML = '';
  for (const o of ANN_DECO_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = (getLangState() === 'zh') ? o.zh : o.en;
    sel.appendChild(opt);
  }
  sel.value = (_annCustom.deco && _annCustom.deco.style) || $('annCustomDeco').dataset.want || 'none';
}

// 301次：个性化 CSS 代码文本（与 wordDecl/annDecl 同源，见 styles.annCustomCssSections）。
// 306次：单框拆双框——target/annotation 两框各写各段（互不混写）；聚焦框不回写防打断输入。
function refreshAnnCustomCssText() {
  const wt = $('annCustomCssTarget'), at = $('annCustomCssAnn');
  if (!wt && !at) return;
  const secs = annCustomCssSections(buildAnnCustomObj());
  if (wt && document.activeElement !== wt) wt.value = secs.target;
  if (at && document.activeElement !== at) at.value = secs.annotation;
}

// 301次：注释 CSS 解析回填控件——仅识别生成子集（background/color/border-radius/
//   font-weight/font-style/text-decoration），未知忽略；全无可识别沿用旧参数并照实打日志。
// 306次：改单区段解析——双框各含一段 CSS，由调用方传 zone（w=target 框／a=annotation 框）；
//   radius/font-weight/text-decoration 仅在 w 区有意义，a 区忽略（避免两框互覆盖）。
function parseAnnCustomCssText(text, zone) {
  const out = {};
  const scan = (part, z) => {
    for (const seg of String(part || '').split(';')) {
      const i = seg.indexOf(':');
      if (i === -1) continue;
      const prop = seg.slice(0, i).trim().toLowerCase();
      const val = seg.slice(i + 1).trim();
      if (!val || /\/\*/.test(prop)) continue;
      if (prop === 'background' || prop === 'background-color') {
        if (/^#[0-9a-fA-F]{6}$/.test(val) || /^transparent$/i.test(val) || /^rgba?\(/i.test(val)) {
          out[z === 'w' ? 'wordBg' : 'annBg'] = val;
        }
      } else if (prop === 'color') {
        if (/^#[0-9a-fA-F]{6}$/.test(val)) out[z === 'w' ? 'wordFg' : 'annFg'] = val;
      } else if (prop === 'border-radius' && z === 'w' && !out.radius) {
        out.radius = val;
      } else if (prop === 'font-weight' && z === 'w' && !out.boldSet) {
        out.boldSet = true;
        out.bold = /^(600|700|800|bold)$/i.test(val);
      } else if (prop === 'text-decoration' && z === 'w' && !out.decoSet) {
        out.decoSet = true;
        const m = val.match(/underline/i);
        if (m) {
          const st = /wavy/i.test(val) ? 'wavy' : (/dashed/i.test(val) ? 'dashed'
            : (/dotted/i.test(val) ? 'dotted' : 'underline'));
          out.deco = st;
        } else {
          out.deco = 'none';
        }
      }
    }
  };
  scan(text, zone === 'a' ? 'a' : 'w');
  delete out.boldSet;
  delete out.decoSet;
  return out;
}

// 301次：七控件统一应用（Custom 行改动与代码框改动共用）——设参数＋当前栏指派 custom＋
//  持久化（annotationCustom＋目标键，textStyle 联动 hintFirstBg/Fg）＋原地刷新。
function applyAnnCustomControls() {
  const wb = $('annCustomWordBg'), wf = $('annCustomWordFg'),
    ab = $('annCustomAnnBg'), af = $('annCustomAnnFg'),
    ra = $('annCustomRadius'), dc = $('annCustomDeco'), bo = $('annCustomBold'),
    tr = $('annCustomAnnBgTransparent'), tw = $('annCustomWordBgTransparent');
  if (!wb || !wf || !ab || !af || !ra || !dc || !bo) return;
  _annCustom = {
    // 304次：生词底色透明勾选（默认勾选即 transparent，与注释底勾选同模式）
    wordBg: (tw && tw.checked) ? 'transparent' : (wb.value || '#004d40'),
    wordFg: wf.value || '#004d40',
    // 302次：注释底色透明勾选（默认勾选即 transparent）
    annBg: (tr && tr.checked) ? 'transparent' : (ab.value || '#004d40'),
    annFg: af.value || '#004d40',
    radius: (ra.value || '').trim() || '4px',
    bold: !!bo.checked,
    deco: (!dc.value || dc.value === 'none')
      ? undefined : { line: 'underline', style: dc.value, color: (af.value || '#004d40') }
  };
  dc.dataset.want = dc.value;
  assignAnnCustomToTarget();
  markOwnWrite();
  chrome.storage.local.set({ annotationCustom: _annCustom },
    () => log('annotationCustom=', JSON.stringify(_annCustom)));
  updateAnnCustomSideCard();
  refreshAnnCustomCssText();
}

// 301次：当前栏指派 custom（控件改动/代码改动/右侧卡点击共用）——写目标键＋textStyle 联动。
function assignAnnCustomToTarget() {
  const feat = _poolTarget;
  _poolSel[feat] = 'ann-custom';
  const obj = buildAnnCustomObj();
  const patch = {};
  patch[feat] = 'ann-custom';
  if (feat === 'textStyle') {
    patch.hintFirstBg = obj.wordBg || '#2e6b43';
    patch.hintFirstFg = obj.wordFg || '#ffffff';
  }
  markOwnWrite();
  chrome.storage.local.set(patch, () => log(feat + '= ann-custom'));
  const grid = $('poolStyleGrid');
  if (grid) grid.querySelectorAll('.style-card').forEach((c) => {
    c.classList.toggle('active', c.dataset.style === 'ann-custom');
  });
  renderPoolSideDemos();
}

// 301次：代码框改动应用——解析→写回控件→走统一应用路径。
// 306次：双框各自独立应用——按框 id 定区段（annCustomCssAnn=a 区，其余=w 区）解析该框，
//   写回对应控件后 applyAnnCustomControls 统一刷新两框；全无可识别回滚该框旧文本并照实打日志。
function applyAnnCustomCssText(ta) {
  const box = (ta && ta.id) ? ta : $('annCustomCssTarget');
  if (!box) return;
  const zone = box.id === 'annCustomCssAnn' ? 'a' : 'w';
  const parsed = parseAnnCustomCssText(box.value, zone);
  const keys = Object.keys(parsed);
  if (!keys.length) {
    console.warn('[VocabRadar][guide] 注释 CSS 无可识别声明，沿用旧参数');
    box.value = annCustomCssSections(buildAnnCustomObj())[zone === 'a' ? 'annotation' : 'target'];
    return;
  }
  // 304次：生词底色透明同步勾选态（与注释底同模式；仅 w 区声明存在时触发）
  if (parsed.wordBg) {
    const tw = !/^#[0-9a-fA-F]{6}$/.test(parsed.wordBg);
    $('annCustomWordBgTransparent').checked = tw;
    $('annCustomWordBg').value = tw ? '#000000' : parsed.wordBg;
    $('annCustomWordBg').disabled = tw;
  }
  if (parsed.wordFg) $('annCustomWordFg').value = parsed.wordFg;
  // 302次：注释底色透明同步勾选态（仅 a 区声明存在时触发）
  if (parsed.annBg) {
    const t = !/^#[0-9a-fA-F]{6}$/.test(parsed.annBg);
    $('annCustomAnnBgTransparent').checked = t;
    $('annCustomAnnBg').value = t ? '#000000' : parsed.annBg;
    $('annCustomAnnBg').disabled = t;
  }
  if (parsed.annFg) $('annCustomAnnFg').value = parsed.annFg;
  if (parsed.radius) $('annCustomRadius').value = parsed.radius;
  if (parsed.deco) {
    fillAnnCustomDeco();
    $('annCustomDeco').dataset.want = parsed.deco;
    $('annCustomDeco').value = parsed.deco;
  }
  if (typeof parsed.bold === 'boolean') $('annCustomBold').checked = parsed.bold;
  // rgba/transparent 底色取色器放不下：沿用旧色值（上两行已按 #rrggbb 设），如实注明
  applyAnnCustomControls();
  try { box.focus(); } catch (_) { /* ignore */ }
}

// 301次：右侧样例卡原地刷新（常驻 word＋ann 双 span，只改样式与文本，不替换节点去闪）。
//   307次：名称 input 挪进 demo 框内后，刷新目标改为样例行 #annCustomSideLine——
//   若仍清空整个 demo 会把框内 input 一并抹掉。
function updateAnnCustomSideCard() {
  const card = $('annCustomSideCard');
  if (!card) return;
  card.classList.toggle('active', _poolSel[_poolTarget] === 'ann-custom');
  const line = $('annCustomSideLine');
  const model = annSampleModel();
  const obj = buildAnnCustomObj();
  if (line) {
    let w = line.querySelector('.word-demo');
    let a = line.querySelector('.ann-demo');
    if (!w) {
      line.innerHTML = '';
      w = document.createElement('span');
      w.className = 'word-demo';
      line.appendChild(w);
      a = document.createElement('span');
      a.className = 'ann-demo';
      line.appendChild(a);
    }
    w.style.cssText = wordDecl(obj).join(';');
    const word = model.last ? model.last.word : model.text;
    if (w.textContent !== word) w.textContent = word;
    a.style.cssText = annDecl(obj).join(';');
    const annText = model.last && model.trans ? (model.pre + model.trans + model.post) : '';
    if (a.textContent !== annText) a.textContent = annText;
    a.style.display = annText ? '' : 'none';
  }
  const lab = $('annCustomSideLabel');
  if (lab) {
    const t = styleLabel(obj, getLangState());
    // 306次：名称区从 div 改 input（用户可改名后提交），回填写 value 而非 textContent；
    //   用户正在输入名称（聚焦中）不回写防打断（与 CSS 双框同口径）
    if (document.activeElement !== lab && lab.value !== t) lab.value = t;
  }
}

// 301次：七控件＋代码框＋右侧卡＋样例行绑定（各只绑一次）。
function bindAnnCustom() {
  const wb = $('annCustomWordBg');
  if (!wb || wb.dataset.bound) return;
  wb.dataset.bound = '1';
  const apply = () => applyAnnCustomControls();
  for (const id of ['annCustomWordBg', 'annCustomWordFg', 'annCustomAnnBg', 'annCustomAnnFg',
    'annCustomRadius', 'annCustomDeco', 'annCustomBold',
    'annCustomAnnBgTransparent', 'annCustomWordBgTransparent']) {
    const el = $(id);
    if (el) el.addEventListener('change', apply);
  }
  // 302次：透明勾选切换取色器禁用态（仿字幕行）；304次生词底色同模式
  const tr0 = $('annCustomAnnBgTransparent'), ab0 = $('annCustomAnnBg');
  if (tr0 && ab0 && !tr0.dataset.bound) {
    tr0.dataset.bound = '1';
    tr0.addEventListener('change', () => { ab0.disabled = tr0.checked; });
  }
  if (ab0 && tr0) ab0.disabled = tr0.checked;
  const tw0 = $('annCustomWordBgTransparent'), wb0 = $('annCustomWordBg');
  if (tw0 && wb0 && !tw0.dataset.bound) {
    tw0.dataset.bound = '1';
    tw0.addEventListener('change', () => { wb0.disabled = tw0.checked; });
  }
  if (wb0 && tw0) wb0.disabled = tw0.checked;
  // 306次：双 CSS 框绑定——target/annotation 各自 change 按框应用；focus/blur 按
  //   data-css-zone 给对应手动控件组（guide.html label 上标注）加/去 .zone-focus 高亮，
  //   回答"点击哪个框，Word BG 等手动选择器显示哪个值归属"。
  for (const [bid, zone] of [['annCustomCssTarget', 'w'], ['annCustomCssAnn', 'a']]) {
    const box = $(bid);
    if (!box || box.dataset.bound) continue;
    box.dataset.bound = '1';
    box.addEventListener('change', () => applyAnnCustomCssText(box));
    // 307次：选择器泛化 label.sub-custom-item[data-css-zone] → [data-css-zone]——
    //   名称行（guide.html 双框 label）也带 data-css-zone，聚焦时同步高亮
    const zl = '[data-css-zone="' + zone + '"]';
    box.addEventListener('focus', () => {
      document.querySelectorAll(zl).forEach((l) => l.classList.add('zone-focus'));
    });
    box.addEventListener('blur', () => {
      document.querySelectorAll(zl).forEach((l) => l.classList.remove('zone-focus'));
    });
  }
  const card = $('annCustomSideCard');
  if (card && !card.dataset.bound) {
    card.dataset.bound = '1';
    card.addEventListener('click', () => {
      assignAnnCustomToTarget();
      updateAnnCustomSideCard();
    });
    // 306次：名称 input 防冒泡（仿字幕 283次做法）——点击/键盘不触发容器选卡
    const lab = $('annCustomSideLabel');
    if (lab) {
      lab.addEventListener('click', (e) => e.stopPropagation());
      lab.addEventListener('keydown', (e) => e.stopPropagation());
    }
  }
  const sample = $('annSampleText');
  if (sample && !sample.dataset.bound) {
    sample.dataset.bound = '1';
    sample.addEventListener('input', () => {
      const v = sample.value.trim();
      _annSample = v || DEFAULT_ANN_SAMPLE;
      if (_annSampleSaveTimer) clearTimeout(_annSampleSaveTimer);
      _annSampleSaveTimer = setTimeout(() => {
        _annSampleSaveTimer = 0;
        markOwnWrite();
        chrome.storage.local.set({ annotationSample: _annSample }, () => log('annotationSample=', _annSample));
      }, 500);
      renderPoolGrid();
      renderPoolSideDemos();
      updateAnnCustomSideCard();
      scheduleAnnSample();
    });
    sample.addEventListener('change', () => {
      if (_annSampleSaveTimer) { clearTimeout(_annSampleSaveTimer); _annSampleSaveTimer = 0; }
      const v = sample.value.trim();
      _annSample = v || DEFAULT_ANN_SAMPLE;
      if (!v) sample.value = _annSample;
      markOwnWrite();
      chrome.storage.local.set({ annotationSample: _annSample }, () => log('annotationSample=', _annSample));
      renderPoolGrid();
      renderPoolSideDemos();
      updateAnnCustomSideCard();
      scheduleAnnSample();
    });
  }
  const btn = $('annCustomAdd');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.title = m('annAddStyle');
    btn.addEventListener('click', () => {
      // 306次：命名优先读侧卡名称输入框（用户改名后提交）；空回退自动序号
      const labIn = $('annCustomSideLabel');
      const custom = labIn && labIn.value.trim();
      const n = _annUserStyles.length + 1;
      const entry = Object.assign(
        { id: 'ann-user-' + Date.now(), label: custom
          ? { en: custom, zh: custom }
          : { en: 'Style ' + n, zh: '样式 ' + n } },
        _annCustom,
        { deco: buildAnnCustomObj().deco }
      );
      _annUserStyles = _annUserStyles.concat([entry]);
      if (labIn) labIn.value = '';
      const feat = _poolTarget;
      _poolSel[feat] = entry.id;
      const patch = { annotationUserStyles: _annUserStyles };
      patch[feat] = entry.id;
      if (feat === 'textStyle') {
        patch.hintFirstBg = entry.wordBg || '#2e6b43';
        patch.hintFirstFg = entry.wordFg || '#ffffff';
      }
      markOwnWrite();
      chrome.storage.local.set(patch, () => log('annotationUserStyles+', entry.id));
      renderPoolGrid();
      renderPoolSideDemos();
    });
  }
}

// 301次：点击用户卡回填个性化行（仿字幕 backfillSubCustomFrom；选中态不变）。
function backfillAnnCustomFrom(st) {
  if (!st || st.id === 'ann-custom') return;
  const hex = (v, fb) => (/^#[0-9a-fA-F]{6}$/.test(v || '') ? v : fb);
  const decoId = (st.deco && st.deco.style) || 'none';
  _annCustom = {
    wordBg: st.wordBg || 'transparent',
    wordFg: hex(st.wordFg, '#004d40'),
    annBg: st.annBg || 'transparent',
    annFg: hex(st.annFg, '#004d40'),
    radius: st.radius || '4px',
    bold: !!st.bold,
    deco: (decoId === 'none') ? undefined : { line: 'underline', style: decoId, color: hex(st.annFg, '#e0f2f1') }
  };
  // 304次：生词底色透明同步勾选态（与注释底同模式）
  const wordTransparent = (_annCustom.wordBg === 'transparent');
  $('annCustomWordBgTransparent').checked = wordTransparent;
  $('annCustomWordBg').value = wordTransparent ? '#000000' : hex(st.wordBg, '#004d40');
  $('annCustomWordBg').disabled = wordTransparent;
  $('annCustomWordFg').value = _annCustom.wordFg;
  const backTransparent = (_annCustom.annBg === 'transparent');
  $('annCustomAnnBgTransparent').checked = backTransparent;
  $('annCustomAnnBg').value = backTransparent ? '#000000' : hex(st.annBg, '#004d40');
  $('annCustomAnnBg').disabled = backTransparent;
  $('annCustomAnnFg').value = _annCustom.annFg;
  $('annCustomRadius').value = _annCustom.radius;
  fillAnnCustomDeco();
  $('annCustomDeco').dataset.want = ANN_DECO_OPTIONS.some((o) => o.id === decoId) ? decoId : 'none';
  $('annCustomDeco').value = $('annCustomDeco').dataset.want;
  $('annCustomBold').checked = _annCustom.bold;
  markOwnWrite();
  chrome.storage.local.set({ annotationCustom: _annCustom }, () => log('annotationCustom 回填<=', st.id));
  refreshAnnCustomCssText();
  updateAnnCustomSideCard();
}

// 301次：个性化参数回填（renderAll；storage.annotationCustom，缺省好看预设）。
function doAnnCustomBackfill(res) {
  const sc = (res && res.annotationCustom) || {};
  const hex = (v, fb) => (/^#[0-9a-fA-F]{6}$/.test(v || '') ? v : fb);
  _annCustom = {
    wordBg: sc.wordBg || 'transparent',
    wordFg: hex(sc.wordFg, '#004d40'),
    annBg: sc.annBg || 'transparent',
    annFg: hex(sc.annFg, '#004d40'),
    radius: sc.radius || '4px',
    bold: sc.bold !== false,
    // 301次：deco 透传（select 编辑器，见 fillAnnCustomDeco；无即 undefined，生成器跳过）
    deco: (sc.deco && sc.deco.style && sc.deco.style !== 'none') ? sc.deco : undefined
  };
  $('annCustomWordBg').value = hex(sc.wordBg, '#e0f2f1');
  $('annCustomWordFg').value = _annCustom.wordFg;
  // 302次：透明底回填勾选态（取色器放不下 transparent，给占位黑并禁用）
  const annTransparent = (_annCustom.annBg === 'transparent');
  $('annCustomAnnBgTransparent').checked = annTransparent;
  $('annCustomAnnBg').value = annTransparent ? '#000000' : hex(sc.annBg, '#004d40');
  $('annCustomAnnBg').disabled = annTransparent;
  $('annCustomAnnFg').value = _annCustom.annFg;
  $('annCustomRadius').value = _annCustom.radius;
  $('annCustomBold').checked = _annCustom.bold;
  fillAnnCustomDeco();
  refreshAnnCustomCssText();
  updateAnnCustomSideCard();
}

// 301次：删除用户自建注释样式（选中它时回落默认卡）。
//   318次：回落改默认代指常量 ANN_DEFAULT_STYLE（317 次的指针重置块撤销——default 是
//   代指不是指针，没有"被删卡恰是默认指向"一说，常量本身永在池内）。
function deleteAnnUserStyle(id) {
  _annUserStyles = _annUserStyles.filter((s) => s && s.id !== id);
  const patch = { annotationUserStyles: _annUserStyles };
  for (const k of ['textStyle', 'annotationStyle', 'videoAnnotationStyle', 'videoOverlayAnnStyle']) {
    if (_poolSel[k] === id) {
      _poolSel[k] = ANN_DEFAULT_STYLE;
      patch[k] = _poolSel[k];
    }
  }
  markOwnWrite();
  chrome.storage.local.set(patch, () => log('annotationUserStyles-', id));
  renderPoolGrid();
  renderPoolSideDemos();
}

// 302次：池设定同步（renderAll 调用；清洗＋模板＋样例＋个性化回填＋绑定）。
export function syncPoolSettings(res) {
  // 309次第二轮（用户"Theme Underline命名错了，正确是Green Underline"）：
  //   名字定稿回 'green-underline'——上一轮曾向 'theme-underline' 迁移是错误方向，
  //   已升级实测版用户的 storage 可能已被洗成 'theme-underline'，此处反向迁回，
  //   保已选样式不丢；原生 'green-underline' 直通无需迁移。
  if (res.textStyle === 'theme-underline') res.textStyle = 'green-underline';
  // 281次：共享池四键回填（textStyle/annotationStyle/videoAnnotationStyle/videoOverlayAnnStyle）——
  //   sanitizeStyleId 洗脏值（池外 id 回落并回写）；videoAnnotationStyle 特殊：
  //   旧残留若不在池内，经 VANN_TO_ANN_MIGRATION 映射后写回自身（280 次复活语义：
  //   池内同名保留，池外经映射表回落，不再并入 annotationStyle、不再 remove 键）。
  //   第四键 videoOverlayAnnStyle：视频中字幕的注释行样式（无迁移，残留即回落）。
  // 318次：回落目标统一为默认代指常量 ANN_DEFAULT_STYLE（sanitizeStyleId 第三参 +
  //   映射表 miss 兜底 + 回写差值判断；default 是代指，317 次的指针键撤销）。
  // 301次：用户自建注释样式载入（非法条目过滤；残留 custom/用户 id 放行，见下）
  _annUserStyles = Array.isArray(res.annotationUserStyles)
    ? res.annotationUserStyles.filter((s) => s && typeof s.id === 'string' && s.id.indexOf('ann-user-') === 0)
    : [];
  const annStyleOk = (id) => id === 'ann-custom' || _annUserStyles.some((s) => s.id === id);
  for (const key of ['textStyle', 'annotationStyle', 'videoAnnotationStyle', 'videoOverlayAnnStyle']) {
    let val = (res[key] && annStyleOk(res[key])) ? res[key] : sanitizeStyleId(POOL_STYLES, res[key], ANN_DEFAULT_STYLE);
    if (key === 'videoAnnotationStyle' && res[key] && !POOL_STYLES.some((s) => s.id === res[key]) && !annStyleOk(res[key])) {
      val = VANN_TO_ANN_MIGRATION[res[key]] || ANN_DEFAULT_STYLE;
      chrome.storage.local.set({ videoAnnotationStyle: val });
    } else if (val !== (res[key] || ANN_DEFAULT_STYLE)) {
      chrome.storage.local.set({ [key]: val });
    }
    _poolSel[key] = val;
  }
  // 301次：个性化参数回填（缺省好看预设；deco 下拉按 _annCustom.deco 回填）
  // 301次：样例行回填（空回落默认）＋绑定＋动态注释跟进
  doAnnCustomBackfill(res);
  _annSample = (typeof res.annotationSample === 'string' && res.annotationSample.trim())
    ? res.annotationSample : DEFAULT_ANN_SAMPLE;
  if (_annSample !== res.annotationSample) { markOwnWrite(); chrome.storage.local.set({ annotationSample: _annSample }); }
  $('annSampleText').value = _annSample;
  bindAnnCustom();
  scheduleAnnSample();
  // 280 次：注释模板回填（空/非字符串回落默认并回写）
  _poolSel.annTemplate = (typeof res.annTemplate === 'string' && res.annTemplate.trim())
    ? res.annTemplate : DEFAULT_ANN_TEMPLATE;
  // 282次：280 批旧默认残留迁移——'{word}({meaning})' 会让候选样例与真实注释多出一层
  //   括号（用户"候选项的释义不要加()"），统一迁到新默认（下分支回写）。
  // 284次：旧默认 '{word}({meaning})' 与 '{word}{meaning}' 统一迁到 '{target} {annotation}'。
  // 306次：284 批旧默认 '{target} {annotation}'（带空格）迁到无空格新默认 '{target}{annotation}'。
  if (_poolSel.annTemplate === '{word}({meaning})' || _poolSel.annTemplate === '{word}{meaning}'
    || _poolSel.annTemplate === '{target} {annotation}') {
    _poolSel.annTemplate = DEFAULT_ANN_TEMPLATE;
  }
  if (_poolSel.annTemplate !== res.annTemplate) chrome.storage.local.set({ annTemplate: _poolSel.annTemplate });
  // 283次：模板分键——其余三栏各自的注释模板（独立 storage 键；空/非字符串回落默认）。
  //   输入框始终显示当前选中栏的模板（跨标签页 renderAll 与切栏 bindPoolLeft 同口径）。
  for (const k of ['webAnnTemplate', 'videoAnnTemplate', 'videoOverlayAnnTemplate']) {
    _poolSel[k] = (typeof res[k] === 'string' && res[k].trim()) ? res[k] : DEFAULT_ANN_TEMPLATE;
  }
  $('annTemplate').value = _poolSel[ANN_TPL_KEYS[_poolTarget]] || DEFAULT_ANN_TEMPLATE;
  bindAnnTemplate();
}

