// VocabRadar 引导页 My Words 模块（330次：guide.js 已超行限，独立成文件）
// 职责（用户需求："引导页 setting 之后增加 My Words，下设左右两栏 New Words / Known
//   Words，一行一个单词，顶行统计词数/复制/导出；生词表头顶词表快捷选择器 GRE/TOEFL/
//   IELTS 等，默认都不选"）：
//   - 两栏 textarea 是唯一真源：手动编辑即时写 storage.myWords={new:[],known:[]}
//     （小写单词数组），复制/导出所见即所得；
//   - 词表快捷选择器 chips（wordlists.jsonl 的 10 个标签）：勾选→该表全部单词并入
//     生词文本框（去重）；取消→移除"仅属于该表"的词（仍属其他勾选词表的词保留）；
//     勾选态持久化 storage.myWordsPresetSel，默认全不选；
//   - 复制=clipboard 写入；导出=txt 文件下载；
//   - onChanged 外部变化（查询窗 🏁/✓ 标记按钮写 myWords）→ 回填两栏（本模块写前打
//     回声戳，1200ms 内的回声跳过，防打断输入——与 sub-style.js 同款纪律）。
//   - 行号列＋中央占位（342次，用户需求"文本框占位符挪到中央，带上行号"）：gutter 按
//     行数渲染、随 textarea 滚动同步；空内容时 .mw-ph 覆盖层居中显示提示文案。
//   词表过滤语义（消费端 annotator.js）：熟词一律跳过、生词绕过词频范围强制标注，
//   My Words 优先级高于词频范围。

import { $, log, markOwnWrite } from './shared.js';
import { ensureReady, getWordsByTag } from '../lib/dictionary.js';

// 词表快捷选择器标签清单（wordlists.jsonl 2026-09-18 现有 10 个标签，专有名词不做 i18n）
const PRESET_TAGS = ['CET4', 'CET6', 'TEM4', 'TEM8', 'GRADUATE', 'IELTS', 'TOEFL', 'GRE', 'GMAT', 'SAT'];
const ECHO_MS = 1200;           // 自写回声抑制窗口（与 sub-style.js 同款）
const SAVE_DEBOUNCE_MS = 500;   // 逐键写 storage 防抖（与 subSampleText 同款）

let _taNew = null, _taKnown = null;
let _cntNew = null, _cntKnown = null;
let _presetSel = [];        // 勾选中的词表标签（storage.myWordsPresetSel）
let _saveTimer = 0;         // 文本框输入防抖定时器
let _lastWriteAt = 0;       // 本模块最近一次写 storage 时刻（回声抑制）
let _inited = false;

// 文本框内容 → 规范化单词数组：按行拆、trim、小写、去空行、保序去重
function parseWords(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const w = line.trim().toLowerCase();
    if (!w || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

// 单词数组 → 文本框文本（一行一词）
function wordsToText(words) { return words.join('\n'); }

// 写 storage（myWords + 勾选态一并落盘；写前打回声戳，suppress 自写回声）
function saveMyWords() {
  _lastWriteAt = Date.now();
  markOwnWrite();
  const patch = {
    myWords: { new: parseWords(_taNew.value), known: parseWords(_taKnown.value) },
    myWordsPresetSel: _presetSel.slice()
  };
  chrome.storage.local.set(patch, () => log('myWords 保存: 生词', patch.myWords.new.length,
    '熟词', patch.myWords.known.length, '勾选词表', _presetSel.join('+') || '无'));
}

// 顶行统计刷新
function updateCounts() {
  if (_cntNew) _cntNew.textContent = String(parseWords(_taNew.value).length);
  if (_cntKnown) _cntKnown.textContent = String(parseWords(_taKnown.value).length);
}

// 词表 chips 渲染（幂等重建；active 按 _presetSel）
function renderChips() {
  const box = $('mwNewPresets');
  if (!box) return;
  box.innerHTML = '';
  for (const tag of PRESET_TAGS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'mw-chip' + (_presetSel.indexOf(tag) !== -1 ? ' active' : '');
    chip.textContent = tag;
    chip.addEventListener('click', () => onChipClick(tag, chip));
    box.appendChild(chip);
  }
}

// chip 点击（用户已确认交互语义）：
//   勾选 → ensureReady 后整表单词并入生词文本框（去重，原词在前新词在后按字母序）；
//   取消 → 移除「属于该表且不属于其他仍勾选词表」的词；文本框始终唯一真源。
async function onChipClick(tag, chipEl) {
  try { await ensureReady(); } catch (_) { /* 装载失败按空表处理，不掩饰：log 已打 */ }
  const idx = _presetSel.indexOf(tag);
  if (idx === -1) {
    const tagWords = getWordsByTag(tag);
    const cur = parseWords(_taNew.value);
    const curSet = new Set(cur);
    const merged = cur.concat(tagWords.filter((w) => !curSet.has(w)));
    _taNew.value = wordsToText(merged);
    _presetSel = _presetSel.concat([tag]);
    log('词表并入', tag, ':', tagWords.length, '词');
  } else {
    const others = _presetSel.filter((t) => t !== tag);
    const tagSet = new Set(getWordsByTag(tag));
    const otherSets = others.map((t) => new Set(getWordsByTag(t)));
    const kept = parseWords(_taNew.value)
      .filter((w) => !(tagSet.has(w) && !otherSets.some((s) => s.has(w))));
    _taNew.value = wordsToText(kept);
    _presetSel = others;
    log('词表移除', tag);
  }
  if (chipEl) chipEl.classList.toggle('active', _presetSel.indexOf(tag) !== -1);
  updateCounts();
  saveMyWords();
}

// 复制：clipboard API 失败降级 execCommand（扩展页面 clipboard 通常可用）
async function copyText(ta, btn) {
  const text = ta.value;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (e) {
    try {
      ta.focus();
      ta.select();
      ok = document.execCommand('copy');
    } catch (_) { /* 照实失败 */ }
  }
  log(ok ? '已复制' : '复制失败', btn && btn.id);
  if (btn) {
    btn.classList.add('ok');
    setTimeout(() => btn.classList.remove('ok'), 1000);
  }
}

// 导出：一行一词 txt 下载
function exportText(ta, filename) {
  const blob = new Blob([ta.value], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  log('已导出', filename);
}

// 行号列＋空态占位（342次，用户需求"文本框占位符挪到中央，带上行号"）：
//   gutter 行号随 textarea 行数重建、scroll 同步（textarea 原生无行号）；
//   空内容时 .mw-twrap 挂 .is-empty → .mw-ph 中央占位显示；render 挂 ta._renderLines
//   供程序化改值处（change 规范化回填 / fillFromStorage）复用。
function bindLineNumbers(ta) {
  const wrap = ta.closest('.mw-twrap');
  const gutter = wrap ? wrap.querySelector('.mw-gutter') : null;
  if (!wrap || !gutter || ta.dataset.linesBound) return;
  ta.dataset.linesBound = '1';
  const render = () => {
    const lines = ta.value.split('\n').length;
    if (gutter.dataset.n !== String(lines)) {
      gutter.dataset.n = String(lines);
      let s = '';
      for (let i = 1; i <= lines; i++) s += i + '\n';
      gutter.textContent = s;
    }
    wrap.classList.toggle('is-empty', ta.value.length === 0);
  };
  ta._renderLines = render;
  ta.addEventListener('input', render);
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  render();
}

// 文本框绑定：input 即时计数 + 防抖落盘；change（失焦/回车）规范化回填（去重/小写）
function bindTextarea(ta) {
  if (!ta || ta.dataset.bound) return;
  ta.dataset.bound = '1';
  ta.addEventListener('input', () => {
    updateCounts();
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => { _saveTimer = 0; saveMyWords(); }, SAVE_DEBOUNCE_MS);
  });
  ta.addEventListener('change', () => {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = 0; }
    ta.value = wordsToText(parseWords(ta.value));
    updateCounts();
    if (ta._renderLines) ta._renderLines();   // 342次：规范化改值后行号/空态同步
    saveMyWords();
  });
}

// storage → 两栏回填（初始/外部变化共用；chips 选中态同步重渲染）
function fillFromStorage(mw, presetSel) {
  if (!_taNew || !_taKnown) return;
  _taNew.value = wordsToText(Array.isArray(mw && mw.new) ? mw.new : []);
  _taKnown.value = wordsToText(Array.isArray(mw && mw.known) ? mw.known : []);
  _presetSel = (Array.isArray(presetSel) ? presetSel : []).filter((t) => PRESET_TAGS.indexOf(t) !== -1);
  renderChips();
  updateCounts();
  if (_taNew._renderLines) _taNew._renderLines();     // 342次：回填改值后行号/空态同步
  if (_taKnown._renderLines) _taKnown._renderLines();
}

// 外部变化同步入口（guide.js storage.onChanged 调用）：自写回声窗口内跳过，
//   他页写入（查询窗 🏁/✓ 标记按钮）时间戳久远，正常同步。
export function syncMyWordsFromStorage() {
  if (Date.now() - _lastWriteAt < ECHO_MS) return;
  chrome.storage.local.get({ myWords: { new: [], known: [] }, myWordsPresetSel: [] }, (res) => {
    fillFromStorage(res.myWords, res.myWordsPresetSel);
  });
}

// 初始化（guide.js renderAll 调用；幂等）：元素引用、文本框/按钮绑定、chips、初始读取
export function initMyWords() {
  if (_inited) return;
  _inited = true;
  _taNew = $('mwNewText');
  _taKnown = $('mwKnownText');
  _cntNew = $('mwNewCount');
  _cntKnown = $('mwKnownCount');
  if (!_taNew || !_taKnown) return;   // 元素缺失照实返回（不掩饰，控制台可见缺 DOM）
  bindTextarea(_taNew);
  bindTextarea(_taKnown);
  bindLineNumbers(_taNew);            // 342次：行号列＋空态中央占位
  bindLineNumbers(_taKnown);
  const bindBtn = (id, fn) => {
    const b = $(id);
    if (b) b.addEventListener('click', fn);
  };
  bindBtn('mwNewCopy', () => copyText(_taNew, $('mwNewCopy')));
  bindBtn('mwNewExport', () => exportText(_taNew, 'my-words-new.txt'));
  bindBtn('mwKnownCopy', () => copyText(_taKnown, $('mwKnownCopy')));
  bindBtn('mwKnownExport', () => exportText(_taKnown, 'my-words-known.txt'));
  renderChips();
  chrome.storage.local.get({ myWords: { new: [], known: [] }, myWordsPresetSel: [] }, (res) => {
    fillFromStorage(res.myWords, res.myWordsPresetSel);
  });
  log('My Words 模块已初始化');
}
