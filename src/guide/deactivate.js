// ============================================================
// 文件职责：引导页「Deactivate（停用）」栏逻辑（第二百七十次新建）
// 来源：用户需求——引导页增 deactivate 栏目，默认折叠（折叠骨架在 guide.html，
//   通用折叠绑定在 guide.js init），底下逐条记录停用规则。
// 行结构（用户口径"左侧输入，右侧点击"）：
//   [ 地址输入框（可 * 通配，见 lib/deactivate.js 匹配语义） ]
//   [所有][网页提示][文本侧栏][视频侧栏][视频叠加字幕] [✕]
//   chip 亮=该站停用该功能；「所有」是四项的快捷全开/全关；
//   四项全 true 时「所有」亮（与 lib/deactivate.js getSuppression().all 同口径）。
// 数据：storage.local 'deactivateRules'（唯一来源 src/lib/deactivate.js）。
// 深链：guide.html?deactivate=<地址> —— 两侧栏 ⋯「停用本站」写入规则后经 SW
//   OPEN_GUIDE 跳转至此；本模块负责切到设定栏、展开本组、定位/补建该地址行并聚焦。
// 依赖注入：guide.js 以 initDeactivate({ m, lang }) 传入文案函数与界面语言读取器
//   （本模块文案键统一注册在 guide.js 的 MSG，与静态 HTML 的 data-key 同源）。
// ============================================================

import { DEACTIVATE_KEY, normalizeRule, normalizePattern, getDeactivateRules } from '../lib/deactivate.js';

const $ = (id) => document.getElementById(id);

// chip 定义：data-feature → 文案键（顺序=用户口径：所有、query bar(272次)、网页提示、文本侧栏、视频侧栏、视频叠加字幕）
const CHIPS = [
  ['all', 'deactivateAll'],
  ['query', 'deactivateQuery'],
  ['hint', 'deactivateHint'],
  ['textSidebar', 'deactivateTextSidebar'],
  ['videoSidebar', 'deactivateVideoSidebar'],
  ['overlay', 'deactivateOverlay']
];

// 模块状态（唯一属主=本文件；guide.js 只调 init/dispose）
let _m = null;          // 文案函数 m(key)（guide.js 注入，键在 MSG）
let _langFn = null;     // () => 'zh' | 'en'
let _rules = [];        // 内存中的规则数组（编辑缓冲，变更即写 storage）
let _initialized = false;
let _storageListener = null;

function log(...args) {
  console.log('[VocabRadar][guide-deactivate]', ...args);
}

function t(key) {
  return _m ? (_m(key) || '') : '';
}

/** 五项全停？（「所有」chip 的亮灭口径，与 lib/deactivate.js getSuppression().all 一致） */
function isAllOn(rule) {
  return !!(rule.query && rule.hint && rule.textSidebar && rule.videoSidebar && rule.overlay);
}

/** 渲染单个 chip 按钮的 active 态 */
function syncRowChips(row, rule) {
  row.querySelectorAll('.deactivate-chip').forEach((chip) => {
    const f = chip.dataset.feature;
    const on = (f === 'all') ? isAllOn(rule) : rule[f] === true;
    chip.classList.toggle('active', on);
  });
}

/** 渲染单行 DOM（pat 输入框在左，功能 chip 与删除在右） */
function buildRow(rule) {
  const row = document.createElement('div');
  row.className = 'deactivate-row';
  row.dataset.pat = rule.pat || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'deactivate-pat';
  input.spellcheck = false;
  input.value = rule.pat || '';
  input.placeholder = t('deactivatePatPh');
  input.title = t('deactivatePatTitle') || '';
  row.appendChild(input);
  for (const [feature, key] of CHIPS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'deactivate-chip';
    chip.dataset.feature = feature;
    chip.textContent = t(key);
    row.appendChild(chip);
  }
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'deactivate-del';
  del.textContent = '✕';
  del.title = t('deactivateDel');
  row.appendChild(del);
  syncRowChips(row, rule);
  return row;
}

/** 全量重建列表（增删行/他页变更时调用；行内编辑不经过此函数以免丢焦点） */
function renderAll() {
  const box = $('deactivateList');
  if (!box) return;
  box.innerHTML = '';
  for (const raw of _rules) {
    box.appendChild(buildRow(normalizeRule(raw)));
  }
}

/** 写回 storage（编辑缓冲 → storage；onChanged 回声由 _suppressEcho 抑制重建） */
let _echoUntil = 0;
function save() {
  _echoUntil = Date.now() + 800;   // 自己写入触发的 onChanged 回声窗口内不重建
  try {
    chrome.storage.local.set({ [DEACTIVATE_KEY]: _rules }, () => {
      const err = chrome.runtime.lastError;
      if (err) console.warn('[VocabRadar][guide-deactivate] 规则保存失败:', err.message);
      else log('规则已保存（', _rules.length, '条）');
    });
  } catch (e) {
    console.warn('[VocabRadar][guide-deactivate] storage 写入异常:', e);
  }
}

/** 行容器事件委托（chip 点选 / 地址编辑 / 删除），绑一次 */
function bindListEvents() {
  const box = $('deactivateList');
  if (!box || box.dataset.bound) return;
  box.dataset.bound = '1';
  box.addEventListener('click', (e) => {
    const row = e.target.closest('.deactivate-row');
    if (!row) return;
    const idx = Array.prototype.indexOf.call(box.children, row);
    const rule = _rules[idx];
    if (!rule) return;
    // 删除行
    const del = e.target.closest('.deactivate-del');
    if (del) {
      _rules.splice(idx, 1);
      save();
      renderAll();
      log('已删除规则:', rule.pat || '(空)');
      return;
    }
    // 功能 chip 点选：「所有」= 五项全开/全关；单 feature = 翻转自身
    const chip = e.target.closest('.deactivate-chip');
    if (chip) {
      const f = chip.dataset.feature;
      if (f === 'all') {
        const next = !isAllOn(rule);
        rule.query = rule.hint = rule.textSidebar = rule.videoSidebar = rule.overlay = next;
      } else {
        rule[f] = !rule[f];
      }
      save();
      syncRowChips(row, normalizeRule(rule));
      log('规则更新:', rule.pat || '(空)', JSON.stringify(normalizeRule(rule)));
    }
  });
  // 地址输入：change（失焦/回车）时规范化并保存（空地址=无效规则，恒不命中，行保留待补）
  box.addEventListener('change', (e) => {
    const input = e.target.closest('.deactivate-pat');
    if (!input) return;
    const row = input.closest('.deactivate-row');
    const idx = Array.prototype.indexOf.call(box.children, row);
    const rule = _rules[idx];
    if (!rule) return;
    const norm = normalizePattern(input.value);
    rule.pat = norm;
    input.value = norm;
    row.dataset.pat = norm;
    save();
    log('地址已保存:', norm || '(空)');
  });
}

/** 添加按钮：追加一条空规则行并聚焦其地址输入框 */
function bindAddButton() {
  const btn = $('deactivateAdd');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    _rules.push(normalizeRule({ pat: '' }));
    save();
    renderAll();
    const box = $('deactivateList');
    const last = box && box.lastElementChild;
    if (last) {
      last.querySelector('.deactivate-pat').focus();
      last.scrollIntoView({ block: 'nearest' });
    }
  });
}

/**
 * 深链：guide.html?deactivate=<地址> —— 切设定栏 → 展开本组 → 定位（缺则补建，
 * 补建为四项全停，与侧栏 ⋯「停用本站」写入的规则同形）→ 滚动到位并聚焦地址框。
 */
async function handleDeepLink() {
  let pat = '';
  try {
    pat = new URLSearchParams(location.search).get('deactivate') || '';
  } catch (_) { /* ignore */ }
  if (!pat) return;
  const norm = normalizePattern(pat);
  log('深链定位停用栏:', norm);
  // ① 切到设定栏（guide.js 的 tab 监听在本模块 init 之前已注册，click 即切换）
  const tab = document.querySelector('.guide-tab[data-tab="settings"]');
  if (tab) tab.click();
  // ② 展开本组（复用 guide.js 折叠绑定：组头点击展开；toggle 按钮亦可）
  const group = $('group-deactivate');
  if (group && group.classList.contains('collapsed')) {
    const toggle = group.querySelector('.group-toggle');
    if (toggle) toggle.click();
  }
  // ③ 规则缺则补建（第二百七十二次：默认单停「网页提示」，与 ⋯ 菜单"停用本站"
  //    默认一致——用户裁定"设定抑制默认是抑制网页提示，不是所有"），随后滚动定位并聚焦
  const rules = await getDeactivateRules();
  const hit = rules.find((r) => normalizePattern(r && r.pat) === norm);
  if (!hit) {
    await new Promise((resolve) => {
      _rules = rules.concat([normalizeRule({ pat: norm, hint: true })]);
      try { chrome.storage.local.set({ [DEACTIVATE_KEY]: _rules }, resolve); } catch (_) { resolve(); }
    });
    renderAll();
  } else {
    _rules = rules;
    renderAll();
  }
  const box = $('deactivateList');
  const row = box && Array.prototype.find.call(box.children, (r) => r.dataset.pat === norm);
  if (row) {
    row.scrollIntoView({ block: 'center' });
    row.querySelector('.deactivate-pat').focus();
  }
}

/**
 * 初始化（guide.js init 调用一次；重复调用幂等跳过）
 * @param {{m:(key:string)=>string, lang:()=>string}} opts 文案与界面语言注入
 */
export async function initDeactivate(opts = {}) {
  if (_initialized) return;
  _initialized = true;
  _m = opts.m || null;
  _langFn = opts.lang || null;
  _rules = await getDeactivateRules();
  renderAll();
  bindListEvents();
  bindAddButton();
  // 他标签页/侧栏菜单写入 → 重建列表（本页地址框聚焦时跳过，防打断输入）
  // 272 次：界面语言变化 → 同步重建动态行（chip 文案跟随；组头/说明走 fillByDataKey）
  _storageListener = (changes, area) => {
    if (area !== 'local') return;
    if ('uiLanguage' in changes) {
      renderAll();
      return;
    }
    if (!(DEACTIVATE_KEY in changes)) return;
    if (Date.now() < _echoUntil) return;   // 自己刚写入的回声
    const box = $('deactivateList');
    if (box && box.contains(document.activeElement)) {
      log('他处更新规则，但本页正在编辑，跳过重建（失焦后下次变更生效）');
      return;
    }
    getDeactivateRules().then((rules) => { _rules = rules; renderAll(); });
  };
  try { chrome.storage.onChanged.addListener(_storageListener); } catch (_) { /* ignore */ }
  await handleDeepLink();
  log('停用栏已初始化（', _rules.length, '条规则）');
}

/** 页面卸载清理（guide.js pagehide 调用；与 init 对称） */
export function disposeDeactivate() {
  if (!_initialized) return;
  _initialized = false;
  if (_storageListener) {
    try { chrome.storage.onChanged.removeListener(_storageListener); } catch (_) { /* ignore */ }
    _storageListener = null;
  }
  _rules = [];
}
