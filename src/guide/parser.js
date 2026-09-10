// VocabRadar 引导页 功能栏 Parser（文档解析）——253 界面 / 255 接线 / 256·257 按用户实测修订。
// 职责：左栏输入（粘贴文本/链接、拖入/粘贴/上传**一批**多文件、拍照、录制）→ 解析 → 右栏纯文本
//       （底部复制/导出按钮）。
//
// 257 次修订清单（用户实测反馈逐条）：
//   - 批次语义纠正（256 次理解错）：多文件/多链接 = **解析前一次输入**的一批；换输入
//     （再拖/再传/再贴/拍照/录制成品）要**替换**旧批，不叠加——attachFiles 改替换语义
//   - 链接抓取改走 SW FETCH_TEXT 中转：扩展页 CSP connect-src 是固定白名单，页面直
//     fetch 任意站点被拒（实测 usepomo.ai）；SW 无页面 CSP 且 host_permissions=<all_urls>
//   - 文件列表显示在输入区：每项 缩略图(图片)+文件名+大小+保存(⬇)+删除(✕)；删除逐个可移
//   - 录音/拍照成品留档可取：进文件列表，⬇ 可保存原文件
//   - 占位符与空态提示上下左右居中：输入框占位符改绝对定位覆盖层；输出区空态/进度/失败
//     提示经 .g-parser-center（margin:auto）居中
//   - 空态提示 i18n 化（t('parser.outputTip')）——修复"解析出的纯文本将显示在这里"语言混杂
//   - 录制按钮常亮红（CSS 层，见 guide.css .func-btn.recording）
//
// 解析分发（只提纯文本，全部复用既有能力，不加封装层）：
//   - 文本      → 直接输出
//   - 链接      → SW FETCH_TEXT（30s 超时）→ lib/main-text.js extractDefuddleFromHtml
//                 主链（Defuddle→密度法→直接解析，勿引 Readability）
//   - PDF       → vendor/unpdf（definePDFJSModule 预解析 vendor pdfjs.mjs，绕过裸 specifier）
//   - DOCX      → vendor/mammoth.browser.min.js（UMD，script 注入取 window.mammoth）
//   - HTML 文件 → 同链接（extractDefuddleFromHtml）
//   - 文本类    → file.text() 直读（txt/md/csv/srt/vtt/json/xml…）
//   - 图片      → OCR_RECOGNIZE（后台 offscreen，语言随 learnLanguage）
//   - 音视频    → parser-media.js transcribeAvFile（与 asr.js 文件 ASR 同消息协议）
//   - 拍照      → ocr.js openCamera → 成品转 File 入本批（列表留档）→ OCR
//   - 录制      → parser-media.js（MediaRecorder + 实时识别）→ 停止后按需转写
//   - epub/rtf 等未支持类型 → toast 如实提示（accept 列表已收窄，不虚假承诺）

import { t } from '../lib/i18n.js';
import { extractDefuddleFromHtml } from '../lib/main-text.js';
import { $, log, toast, formatFileSize, escapeHtml } from './guide-common.js';
import { openCamera } from './ocr.js';
import {
  isParserRecording, startParserRecording, stopParserRecording, transcribeAvFile
} from './parser-media.js';

// 输入状态机（一批输入 = 一次解析单元）：
//   { mode:'none' }
//   { mode:'text', text, links|null }   — 文本；规范化后每行都是链接则 links=URL 数组（批链接）
//   { mode:'file', items:[{file, objectURL}] } — 一批文件（可多个；换输入整体替换，不叠加）
let _input = { mode: 'none' };
let _parsing = false;     // 解析中标志（解析/拍照互斥，按钮防重入）
let _lastResult = '';     // 最近一次解析结果（复制/导出用）
let _liveTexts = [];      // 录制实时识别句缓存（停止后并入结果）

const URL_RE = /^https?:\/\/\S+$/i;
// 文本类扩展名（直读）；html/htm 走 Defuddle 链、pdf/docx/媒体各有专路
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'srt', 'vtt', 'log', 'nfo']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus', 'weba']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'flv', 'ts']);
// 输入/输出框高度上限（与输出框一致，到底再内部滚动）
const BOX_MAX_HEIGHT = 560;

/** 文件类型判定（mime 优先，扩展名兜底）→ pdf|docx|html|text|image|audio|video|null */
function detectParserKind(file) {
  const mt = (file.type || '').toLowerCase();
  const ext = ((file.name || '').split('.').pop() || '').toLowerCase();
  if (mt === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mt.includes('officedocument.wordprocessingml.document') || ext === 'docx') return 'docx';
  if (mt === 'text/html' || ['html', 'htm', 'xhtml'].includes(ext)) return 'html';
  if (mt.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(ext)) return 'image';
  if (mt.startsWith('audio/') || AUDIO_EXTS.has(ext)) return 'audio';
  if (mt.startsWith('video/') || VIDEO_EXTS.has(ext)) return 'video';
  if (mt.startsWith('text/') || TEXT_EXTS.has(ext)) return 'text';
  return null;
}

/** 输入规范化：按行 trim 去空后，每行都是 URL → 视为链接列表（批链接） */
function extractLinks(text) {
  const lines = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  return lines.every((l) => URL_RE.test(l)) ? lines : null;
}

/** 动态加载 UMD 版 mammoth（script 注入取 window.mammoth；ESM import 对 UMD 无效） */
function loadMammoth() {
  if (window.mammoth) return Promise.resolve(window.mammoth);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('src/lib/vendor/mammoth.browser.min.js');
    s.onload = () => {
      if (window.mammoth) resolve(window.mammoth);
      else reject(new Error('mammoth loaded but global missing'));
    };
    s.onerror = () => reject(new Error('mammoth.script load failed'));
    document.head.appendChild(s);
  });
}

// unpdf 模块缓存（模块命名空间冻结不可挂标志，模块级变量持有；pdfjs 已 definePDFJSModule 预解析）
let _unpdfMod = null;
/** unpdf：先经官方逃生口 definePDFJSModule 绑定 vendor pdfjs.mjs——
 *  修复"Failed to resolve module specifier 'unpdf/pdfjs'"（裸 specifier 浏览器不可解析） */
async function loadUnpdf() {
  if (_unpdfMod) return _unpdfMod;
  const base = chrome.runtime.getURL('src/lib/vendor/unpdf/');
  const mod = await import(base + 'index.mjs');
  await mod.definePDFJSModule(() => import(base + 'pdfjs.mjs'));
  _unpdfMod = mod;
  return mod;
}

// === 输出区渲染（纯文本；空态/进度/失败提示经 .g-parser-center 上下左右居中） ===
function setStatus(stage, detail) {
  const out = $('g-parser-output');
  if (!out) return;
  out.innerHTML = `<div class="g-parser-center g-empty-tip">${escapeHtml(stage || '')}`
    + (detail ? `<br><span style="font-size:12px">${escapeHtml(String(detail).slice(0, 120))}</span>` : '')
    + '</div>';
}
function setResult(text) {
  const out = $('g-parser-output');
  if (!out) return;
  const plain = String(text || '').trim();
  _lastResult = plain;
  if (!plain) {
    out.innerHTML = `<div class="g-parser-center g-empty-tip">${escapeHtml(t('parser.empty'))}</div>`;
    return;
  }
  out.textContent = plain;
}
function setFail(msg) {
  const out = $('g-parser-output');
  if (!out) return;
  out.innerHTML = `<div class="g-parser-center g-empty-tip" style="color:#b23a2e">${escapeHtml(t('parser.fail') + String(msg).slice(0, 200))}</div>`;
}
/** 换输入清旧结果（257 次：文案走 i18n，随界面语言——修复"语言混杂"） */
function resetOutput() {
  _lastResult = '';
  const out = $('g-parser-output');
  if (out) out.innerHTML = `<div class="g-parser-center g-empty-tip">${escapeHtml(t('parser.outputTip'))}</div>`;
}
/** 录制实时识别句流入（parser-media onLiveText 回调） */
function appendLiveText(text) {
  if (!text) return;
  _liveTexts.push(text);
  const out = $('g-parser-output');
  if (!out) return;
  let live = out.querySelector('.g-parser-live');
  if (!live) {
    out.innerHTML = '';
    live = document.createElement('div');
    live.className = 'g-parser-live';
    out.appendChild(live);
  }
  const line = document.createElement('div');
  line.textContent = text;
  live.appendChild(line);
  out.scrollTop = out.scrollHeight;
}

// === 各类型解析器 ===

/** 链接：SW FETCH_TEXT 中转（257 次——扩展页 CSP connect-src 白名单不含任意站点，
 *  页面直 fetch 被拒；SW 无页面 CSP 且 host_permissions=<all_urls>）→ Defuddle 主链提正文 */
async function parseLink(url) {
  setStatus(t('parser.fetching'), url);
  const resp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FETCH_TEXT', url })
      .then(resolve)
      .catch((e) => resolve({ ok: false, error: String(e.message || e) }));
  });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'FETCH_TEXT failed');
  const { text } = await extractDefuddleFromHtml(resp.text || '', resp.finalUrl || url);
  return text;
}

/** PDF：unpdf extractText（mergePages 合并全页；pdfjs 经 definePDFJSModule 预解析） */
async function parsePdf(file) {
  const mod = await loadUnpdf();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await mod.getDocumentProxy(data);
  const { text } = await mod.extractText(pdf, { mergePages: true });
  return text || '';
}

/** DOCX：mammoth extractRawText */
async function parseDocx(file) {
  const mammoth = await loadMammoth();
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return value || '';
}

/** File/Blob → dataURL（图片 OCR 输入） */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

/** 图片 OCR（后台 OCR_RECOGNIZE，语言随 learnLanguage，与 OCR 栏同消息） */
async function parseImageOcr(dataUrl) {
  const { learnLanguage } = await chrome.storage.local.get({ learnLanguage: 'en' });
  const resp = await chrome.runtime.sendMessage({
    type: 'OCR_RECOGNIZE',
    imageDataUrl: dataUrl,
    lang: learnLanguage || 'en'
  });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || t('ocr.unknownErr'));
  return resp.text || '';
}

// === 统一执行壳：状态/结果/失败渲染 + 防重入 ===
async function runJob(job) {
  if (_parsing) { toast(t('parser.parsing')); return; }
  _parsing = true;
  const btn = $('g-parser-btn');
  if (btn) btn.disabled = true;
  const started = Date.now();
  try {
    const text = await job();
    setResult(text);
    if (text && String(text).trim()) {
      toast(t('parser.done', { n: String(text).trim().length }));
    }
    log('Parser 完成:', String(text || '').trim().length, 'chars,',
      ((Date.now() - started) / 1000).toFixed(1) + 's');
  } catch (e) {
    const msg = String((e && e.message) || e);
    setFail(msg);
    toast(t('parser.fail') + msg.slice(0, 120), { error: true, duration: 6000 });
    log('Parser 解析失败:', e);
  } finally {
    _parsing = false;
    refreshInputUI();
  }
}

/** 单文件解析（批循环体；kind 判定 + 分发，未支持如实抛错） */
async function parseSingleFile(file, idx, total) {
  const kind = detectParserKind(file);
  const tag = (total > 1) ? `(${idx + 1}/${total}) ` : '';
  if (kind === 'audio' || kind === 'video') {
    return transcribeAvFile(file, (stage, detail) => setStatus(tag + stage, detail));
  }
  if (kind === 'image') {
    setStatus(tag + t('parser.parsing'), 'OCR');
    return parseImageOcr(await fileToDataUrl(file));
  }
  if (kind === 'pdf') {
    setStatus(tag + t('parser.parsing'), 'PDF');
    return parsePdf(file);
  }
  if (kind === 'docx') {
    setStatus(tag + t('parser.parsing'), 'DOCX');
    return parseDocx(file);
  }
  if (kind === 'html') {
    setStatus(tag + t('parser.parsing'), 'HTML');
    return (await extractDefuddleFromHtml(await file.text(), '')).text;
  }
  if (kind === 'text') {
    setStatus(tag + t('parser.parsing'), '');
    return file.text();
  }
  throw new Error(t('parser.unsupported', { what: file.name || 'unknown' }));
}

/** 解析按钮：按输入态分发（批链接/批文件循环拼接；部分失败继续并汇总报错） */
function onParseClick() {
  if (!hasInput()) {
    toast(t('parser.noInput'), { error: true });
    return;
  }
  runJob(async () => {
    if (_input.mode === 'text') {
      if (_input.links) {
        const texts = [];
        for (const link of _input.links) {
          texts.push(await parseLink(link));
        }
        return texts.join('\n\n');
      }
      setStatus(t('parser.parsing'), '');
      return _input.text.trim();
    }
    const items = _input.items;
    const texts = [];
    const failed = [];
    for (let i = 0; i < items.length; i++) {
      try {
        texts.push(await parseSingleFile(items[i].file, i, items.length));
      } catch (e) {
        log('单文件解析失败:', items[i].file.name, e);
        failed.push(`${items[i].file.name}: ${String((e && e.message) || e).slice(0, 60)}`);
      }
    }
    if (texts.length === 0 && failed.length > 0) {
      throw new Error(failed.join(' | '));
    }
    if (failed.length > 0) {
      toast(t('parser.fail') + failed.join(' | ').slice(0, 120), { error: true, duration: 6000 });
    }
    return texts.join('\n\n');
  });
}

// === 输入状态机 ===

/** 输入是否可解析（文本非空/有链接/本批有文件） */
function hasInput() {
  if (_input.mode === 'file') return _input.items.length > 0;
  if (_input.mode === 'text') return _input.text.trim().length > 0;
  return false;
}

/** 占位符覆盖层显隐（textarea 有值即隐——257 次居中占位符） */
function updatePh() {
  const ta = $('g-parser-input');
  const ph = document.querySelector('.g-parser-ph');
  if (ta && ph) ph.style.display = ta.value ? 'none' : 'flex';
}

/** 刷新输入状态行/文件列表/清空钮/解析按钮可用态（唯一入口，任何输入变化后调用） */
function refreshInputUI() {
  const info = $('g-parser-input-info-text');
  const btn = $('g-parser-btn');
  const clearBtn = $('g-parser-clear');
  if (info) {
    if (_input.mode === 'file') {
      const items = _input.items;
      info.textContent = `${t('parser.multiFiles', { n: items.length })} · ${formatFileSize(items.reduce((s, it) => s + it.file.size, 0))}`;
    } else if (_input.mode === 'text' && _input.text.trim()) {
      if (_input.links) {
        info.textContent = t('parser.linksCount', { n: _input.links.length });
      } else {
        info.textContent = `${_input.text.trim().length} ${t('parser.chars')}`;
      }
    } else {
      info.textContent = '';
    }
  }
  renderFileList();
  if (clearBtn) clearBtn.hidden = !hasInput();
  if (btn) btn.disabled = _parsing || !hasInput();
  updatePh();
}

/** 本批文件列表（257 次：显示在输入区——缩略图(图片)+文件名+大小+保存(⬇)+删除(✕)） */
function renderFileList() {
  const box = $('g-parser-filelist');
  if (!box) return;
  box.innerHTML = '';
  if (_input.mode !== 'file') return;
  _input.items.forEach((it, idx) => {
    const row = document.createElement('div');
    row.className = 'g-parser-file';
    const kind = detectParserKind(it.file);
    if (kind === 'image') {
      const img = document.createElement('img');
      img.className = 'g-parser-file-thumb';
      img.src = it.objectURL;
      img.alt = it.file.name;
      row.appendChild(img);
    }
    const name = document.createElement('span');
    name.className = 'g-parser-file-name';
    name.textContent = it.file.name;
    name.title = it.file.name;
    row.appendChild(name);
    const size = document.createElement('span');
    size.className = 'g-parser-file-size';
    size.textContent = formatFileSize(it.file.size);
    row.appendChild(size);
    // 保存（⬇）：录音/拍照/任意附件留档可取（objectURL 直下原名）
    const dl = document.createElement('a');
    dl.className = 'g-parser-file-act dl';
    dl.textContent = '⬇';
    dl.title = t('parser.fileSave');
    dl.href = it.objectURL;
    dl.download = it.file.name;
    row.appendChild(dl);
    // 删除（✕）：逐个移出本批
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'g-parser-file-act del';
    del.textContent = '✕';
    del.title = t('parser.fileDelete');
    del.addEventListener('click', () => removeFile(idx));
    row.appendChild(del);
    box.appendChild(row);
  });
}

/** 移除本批中单个文件（撤 objectURL；删空则回空态并清旧结果） */
function removeFile(idx) {
  if (_input.mode !== 'file' || !_input.items[idx]) return;
  try { URL.revokeObjectURL(_input.items[idx].objectURL); } catch (e) { /* ignore */ }
  _input.items.splice(idx, 1);
  if (_input.items.length === 0) {
    _input = { mode: 'none' };
    resetOutput();
  }
  refreshInputUI();
  log('Parser 文件已移除, 剩余', (_input.mode === 'file') ? _input.items.length : 0);
}

/** 附着一批文件（257 次语义纠正：多文件/多链接=一次输入的一批；换输入**替换**旧批，
 *  不叠加——撤全部旧 objectURL 后建新批）。拖入/粘贴/上传/录制成品/拍照共用 */
function attachFiles(fileList) {
  const files = [...(fileList || [])].filter(Boolean);
  if (files.length === 0) return;
  if (_input.mode === 'file') {
    for (const it of _input.items) {
      try { URL.revokeObjectURL(it.objectURL); } catch (e) { /* ignore */ }
    }
  }
  _input = { mode: 'file', items: files.map((f) => ({ file: f, objectURL: URL.createObjectURL(f) })) };
  resetOutput();
  refreshInputUI();
  log('Parser 本批文件（替换）:', files.map((f) => `${f.name}(${formatFileSize(f.size)})`).join(', '));
}

/** 切回文本态（textarea 输入/文本粘贴时；多链接规范化在此；文件批撤销） */
function setText(text) {
  if (_input.mode === 'file') {
    for (const it of _input.items) {
      try { URL.revokeObjectURL(it.objectURL); } catch (e) { /* ignore */ }
    }
  }
  _input = { mode: 'text', text: String(text || ''), links: extractLinks(text) };
  resetOutput();
  refreshInputUI();
}

/** 清空输入（✕ 按钮）：撤全部 objectURL、清 textarea、清输出 */
function clearInput() {
  if (_input.mode === 'file') {
    for (const it of _input.items) {
      try { URL.revokeObjectURL(it.objectURL); } catch (e) { /* ignore */ }
    }
  }
  _input = { mode: 'none' };
  const ta = $('g-parser-input');
  if (ta) { ta.value = ''; autosizeInput(); }
  resetOutput();
  refreshInputUI();
  log('Parser 输入已清空');
}

/** 输入框自动延高（256 次）：随内容长高至上限（与输出框同 560px），到底再内部滚动 */
function autosizeInput() {
  const ta = $('g-parser-input');
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, BOX_MAX_HEIGHT) + 'px';
}

/** dataURL → File（拍照成品入本批，列表留档可取） */
async function dataUrlToFile(dataUrl, name) {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, { type: blob.type || 'image/png' });
}

/** 复制结果到剪贴板（clipboard API 优先，execCommand 兜底） */
async function copyResult() {
  if (!_lastResult) { toast(t('parser.empty'), { error: true }); return; }
  try {
    await navigator.clipboard.writeText(_lastResult);
    toast(t('parser.copied'));
  } catch (e) {
    // 兜底：隐藏 textarea + execCommand（扩展页 clipboard API 被拒时仍可用）
    try {
      const ta = document.createElement('textarea');
      ta.value = _lastResult;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast(t('parser.copied'));
    } catch (e2) {
      toast(t('parser.copyFail') + String((e2 && e2.message) || e2), { error: true });
    }
  }
}

/** 导出结果为 .txt 下载 */
function exportResult() {
  if (!_lastResult) { toast(t('parser.empty'), { error: true }); return; }
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const blob = new Blob([_lastResult], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vocabradar-parse-${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 3000);
  log('Parser 已导出: vocabradar-parse-' + stamp + '.txt (' + _lastResult.length + ' chars)');
}

// === 初始化（guide.js init 调用） ===
export function initParser() {
  const input = $('g-parser-input');
  const upload = $('g-parser-upload');
  const fileInput = $('g-parser-file-input');
  const parseBtn = $('g-parser-btn');
  const captureBtn = $('g-parser-capture');
  const recordBtn = $('g-parser-record-btn');
  const clearBtn = $('g-parser-clear');
  const copyBtn = $('g-parser-copy');
  const exportBtn = $('g-parser-export');

  // 初始空态（i18n 文案 + 居中；替代静态 HTML 提示——修复语言混杂）
  resetOutput();

  // 文本输入/文本粘贴 → 文本态（多链接规范化；换输入即清旧结果）
  if (input) {
    input.addEventListener('input', () => { setText(input.value); autosizeInput(); });
    // Ctrl+V 粘贴文件：剪贴板带文件时拦截，替换本批（文本粘贴走 input 事件）
    input.addEventListener('paste', (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length > 0) {
        e.preventDefault();
        attachFiles(files);
      }
    });
    // 拖拽文件：dragover 高亮，drop 替换本批（可多个）
    input.addEventListener('dragover', (e) => {
      e.preventDefault();
      input.classList.add('dragover');
    });
    input.addEventListener('dragleave', () => input.classList.remove('dragover'));
    input.addEventListener('drop', (e) => {
      e.preventDefault();
      input.classList.remove('dragover');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) attachFiles(files);
    });
  }
  // 「上传文件」按钮（ASR 栏先例）→ 隐藏 file input（multiple 一批多选，替换旧批）
  if (upload && fileInput) {
    upload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) attachFiles(fileInput.files);
      fileInput.value = '';
    });
  }
  // 解析按钮
  if (parseBtn) parseBtn.addEventListener('click', onParseClick);
  // 清空按钮：主动清场（文件 objectURL + 输入框 + 输出区）
  if (clearBtn) clearBtn.addEventListener('click', clearInput);
  // 复制/导出（结果栏底下）
  if (copyBtn) copyBtn.addEventListener('click', copyResult);
  if (exportBtn) exportBtn.addEventListener('click', exportResult);
  // 拍照：复用 ocr.js 相机模态；成品转 File 替换本批（列表留档可取）并自动 OCR
  if (captureBtn) {
    captureBtn.addEventListener('click', async () => {
      await openCamera(async (dataUrl, w, h) => {
        try {
          const file = await dataUrlToFile(dataUrl, `capture-${Date.now()}.png`);
          attachFiles([file]);
        } catch (e) {
          log('拍照成品转 File 失败:', e);
        }
        runJob(async () => {
          setStatus(t('parser.parsing'), `OCR ${w}x${h}`);
          return parseImageOcr(dataUrl);
        });
      });
    });
  }
  // 录制：点击开始（⏹ 停止态 + 实时识别流入），再点停止→有实时文本即收编，否则转写成品
  if (recordBtn) {
    recordBtn.addEventListener('click', async () => {
      if (isParserRecording()) {
        const out2 = await stopParserRecording();
        if (_liveTexts.length > 0) {
          // 实时识别已产出：直接收编为结果（避免重复转写）
          const text = _liveTexts.join('\n');
          _liveTexts = [];
          setResult(text);
          toast(t('parser.done', { n: text.length }));
        } else if (out2 && out2.file) {
          attachFiles([out2.file]);
          onParseClick();
        } else {
          resetOutput();
        }
        return;
      }
      if (_parsing) { toast(t('parser.parsing')); return; }
      const kind = (document.querySelector('input[name="g-parser-source"]:checked') || {}).value || 'audio';
      _liveTexts = [];
      resetOutput();
      setStatus('🎙 ' + t('ws.recording'), t('ws.realtimeRecognition'));
      await startParserRecording(kind, appendLiveText);
    });
  }
  refreshInputUI();
  autosizeInput();
  log('Parser 已初始化（文本/批链接/PDF/DOCX/HTML/文本类/图片OCR/音视频ASR；批次=替换语义）');
}

/** 页面卸载清理（与 disposeAsrCommon 等对称；撤本批持有的全部 objectURL） */
export function disposeParser() {
  if (_input.mode === 'file') {
    for (const it of _input.items) {
      try { URL.revokeObjectURL(it.objectURL); } catch (e) { /* ignore */ }
    }
  }
  _input = { mode: 'none' };
}
