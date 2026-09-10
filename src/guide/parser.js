// VocabRadar 引导页 功能栏 Parser（文档解析）——第二百五十三次新增界面，第二百五十五次接线。
// 职责：左栏输入（粘贴文本/链接、拖入/粘贴/上传文件、拍照、录制）→ 解析 → 右栏纯文本。
//
// 解析分发（只提纯文本，全部复用既有能力，不加封装层）：
//   - 文本      → 直接输出
//   - 链接      → 页面直接 fetch（host_permissions=<all_urls> 实证，免 SW 中转）
//                 → lib/main-text.js extractDefuddleFromHtml 主链（Defuddle→密度法→直接解析）
//   - PDF       → vendor/unpdf（extractText mergePages，自包含 ESM）
//   - DOCX      → vendor/mammoth.browser.min.js（UMD，script 注入取 window.mammoth，
//                 extractRawText 即纯文本）
//   - HTML 文件 → 同链接（extractDefuddleFromHtml）
//   - 文本类    → file.text() 直读（txt/md/csv/srt/vtt/json/xml…）
//   - 图片      → OCR_RECOGNIZE（后台 offscreen Tesseract/视觉 API，语言随 learnLanguage）
//   - 音视频    → parser-media.js transcribeAvFile（与 asr.js 文件 ASR 同消息协议：
//                 START_ASR→分段/ASR_LLM_FILE→STOP_ASR），本地 Whisper / API 引擎随设定栏
//   - 拍照      → ocr.js openCamera（复用相机模态）→ 图片 OCR
//   - 录制      → parser-media.js（MediaRecorder 收录）→ 音视频转写
//   - epub/rtf 等未支持类型 → toast 如实提示（accept列表已收窄，不虚假承诺）
//   vendor 组织守则（project_summary 2026-09-08 起）：单文件库平铺 vendor/ 顶层，多文件
//   功能保留子目录；直接消费第三方库，不再建分组目录/封装层。

import { t } from '../lib/i18n.js';
import { extractDefuddleFromHtml } from '../lib/main-text.js';
import { $, log, toast, formatFileSize, escapeHtml } from './guide-common.js';
import { openCamera } from './ocr.js';
import {
  isParserRecording, startParserRecording, stopParserRecording, transcribeAvFile
} from './parser-media.js';

// 输入状态机（一个输入框、一个输出框）：
//   { mode:'none' }
//   { mode:'text', text, isUrl }        — 文本/链接（用户键入或粘贴文本）
//   { mode:'file', file, objectURL }    — 文件（拖入 / Ctrl+V / 上传选择 / 录制成品）
let _input = { mode: 'none' };
let _parsing = false;   // 解析中标志（解析/拍照互斥，按钮防重入）

const URL_RE = /^https?:\/\/\S+$/i;
// 文本类扩展名（直读）；html/htm 走 Defuddle 链、pdf/docx/媒体各有专路
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'srt', 'vtt', 'log', 'nfo']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus', 'weba']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'flv', 'ts']);

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

// === 输出区渲染（纯文本；状态/错误用 g-empty-tip 行） ===
function setStatus(stage, detail) {
  const out = $('g-parser-output');
  if (!out) return;
  out.innerHTML = `<div class="g-empty-tip">${escapeHtml(stage || '')}`
    + (detail ? `<br><span style="font-size:12px">${escapeHtml(String(detail).slice(0, 120))}</span>` : '')
    + '</div>';
}
function setResult(text) {
  const out = $('g-parser-output');
  if (!out) return;
  const plain = String(text || '').trim();
  if (!plain) {
    out.innerHTML = `<div class="g-empty-tip">${escapeHtml(t('parser.empty'))}</div>`;
    return;
  }
  out.textContent = plain;
}
function setFail(msg) {
  const out = $('g-parser-output');
  if (!out) return;
  out.innerHTML = `<div class="g-empty-tip" style="color:#b23a2e">${escapeHtml(t('parser.fail') + String(msg).slice(0, 200))}</div>`;
}

// === 各类型解析器 ===

/** 链接：页面直连抓取（<all_urls> 主机权限）→ Defuddle 主链提正文 */
async function parseLink(url) {
  setStatus(t('parser.fetching'), url);
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 80)}`);
  const html = await res.text();
  const { text } = await extractDefuddleFromHtml(html, url);
  return text;
}

/** PDF：unpdf extractText（mergePages 合并全页） */
async function parsePdf(file) {
  const mod = await import(chrome.runtime.getURL('src/lib/vendor/unpdf/index.mjs'));
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

/** 解析按钮：按输入态分发 */
function onParseClick() {
  if (!hasInput()) {
    toast(t('parser.noInput'), { error: true });
    return;
  }
  runJob(async () => {
    if (_input.mode === 'text') {
      const plain = _input.text.trim();
      setStatus(t('parser.parsing'), '');
      return plain;
    }
    const kind = detectParserKind(_input.file);
    if (kind === 'audio' || kind === 'video') {
      // 音视频 → ASR 转写（本地 Whisper / API 引擎随设定栏；进度经 setStatus 进输出区）
      return transcribeAvFile(_input.file, (stage, detail) => setStatus(stage, detail));
    }
    if (kind === 'image') {
      setStatus(t('parser.parsing'), 'OCR');
      return parseImageOcr(await fileToDataUrl(_input.file));
    }
    if (kind === 'pdf') {
      setStatus(t('parser.parsing'), 'PDF');
      return parsePdf(_input.file);
    }
    if (kind === 'docx') {
      setStatus(t('parser.parsing'), 'DOCX');
      return parseDocx(_input.file);
    }
    if (kind === 'html') {
      setStatus(t('parser.parsing'), 'HTML');
      return (await extractDefuddleFromHtml(await _input.file.text(), '')).text;
    }
    if (kind === 'text') {
      setStatus(t('parser.parsing'), '');
      return _input.file.text();
    }
    // 未支持类型：如实报错（epub/rtf 等）
    throw new Error(t('parser.unsupported', { what: _input.file.name || 'unknown' }));
  });
}

// === 输入状态机 ===

/** 输入是否可解析（文本非空或已附文件） */
function hasInput() {
  if (_input.mode === 'file') return true;
  if (_input.mode === 'text') return _input.text.trim().length > 0;
  return false;
}

/** 刷新输入状态行 + 解析按钮可用态（唯一入口，任何输入变化后调用） */
function refreshInputUI() {
  const info = $('g-parser-input-info-text');
  const btn = $('g-parser-btn');
  if (info) {
    if (_input.mode === 'file') {
      const f = _input.file;
      info.textContent = `${t('parser.fileAttached')}: ${f.name} (${formatFileSize(f.size)})`;
    } else if (_input.mode === 'text' && _input.text.trim()) {
      const n = _input.text.trim().length;
      info.textContent = _input.isUrl
        ? `${t('parser.linkDetected')} · ${n} ${t('parser.chars')}`
        : `${n} ${t('parser.chars')}`;
    } else {
      info.textContent = '';
    }
  }
  if (btn) btn.disabled = _parsing || !hasInput();
}

/** 附着文件（拖入/粘贴/上传/录制成品共用）：撤旧 objectURL，记录文件态 */
function attachFile(file) {
  if (!file) return;
  if (_input.mode === 'file' && _input.objectURL) {
    try { URL.revokeObjectURL(_input.objectURL); } catch (e) { /* ignore */ }
  }
  _input = { mode: 'file', file, objectURL: URL.createObjectURL(file) };
  refreshInputUI();
  log('Parser 文件已附着:', file.name, formatFileSize(file.size));
}

/** 切回文本态（textarea 输入/文本粘贴时） */
function setText(text) {
  if (_input.mode === 'file' && _input.objectURL) {
    try { URL.revokeObjectURL(_input.objectURL); } catch (e) { /* ignore */ }
  }
  _input = { mode: 'text', text: String(text || ''), isUrl: URL_RE.test(String(text || '').trim()) };
  refreshInputUI();
}

// === 初始化（guide.js init 调用） ===
export function initParser() {
  const input = $('g-parser-input');
  const upload = $('g-parser-upload');
  const fileInput = $('g-parser-file-input');
  const parseBtn = $('g-parser-btn');
  const captureBtn = $('g-parser-capture');
  const recordBtn = $('g-parser-record-btn');

  // 文本输入/文本粘贴 → 文本态（有文件时键入即切回文本态，输入框内容为准）
  if (input) {
    input.addEventListener('input', () => setText(input.value));
    // Ctrl+V 粘贴文件：剪贴板带文件时拦截，转文件附着（文本粘贴走 input 事件）
    input.addEventListener('paste', (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length > 0) {
        e.preventDefault();
        attachFile(files[0]);
      }
    });
    // 拖拽文件：dragover 高亮，drop 附着首个文件
    input.addEventListener('dragover', (e) => {
      e.preventDefault();
      input.classList.add('dragover');
    });
    input.addEventListener('dragleave', () => input.classList.remove('dragover'));
    input.addEventListener('drop', (e) => {
      e.preventDefault();
      input.classList.remove('dragover');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) attachFile(files[0]);
    });
  }
  // 「上传文件」按钮（ASR 栏先例）→ 隐藏 file input
  if (upload && fileInput) {
    upload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) attachFile(f);
      fileInput.value = '';
    });
  }
  // 解析按钮
  if (parseBtn) parseBtn.addEventListener('click', onParseClick);
  // 拍照：复用 ocr.js 相机模态，快照转 OCR 出纯文本
  if (captureBtn) {
    captureBtn.addEventListener('click', async () => {
      await openCamera((dataUrl, w, h) => {
        runJob(async () => {
          setStatus(t('parser.parsing'), `OCR ${w}x${h}`);
          return parseImageOcr(dataUrl);
        });
      });
    });
  }
  // 录制：点击开始（⏹ 停止态），再点停止 → 成品 File 附着并自动转写
  if (recordBtn) {
    recordBtn.addEventListener('click', async () => {
      if (isParserRecording()) {
        const out = await stopParserRecording();
        if (out && out.file) {
          attachFile(out.file);
          onParseClick();
        }
        return;
      }
      if (_parsing) { toast(t('parser.parsing')); return; }
      const kind = (document.querySelector('input[name="g-parser-source"]:checked') || {}).value || 'audio';
      await startParserRecording(kind);
    });
  }
  refreshInputUI();
  log('Parser 已初始化（文本/链接/PDF/DOCX/HTML/文本类/图片OCR/音视频ASR）');
}

/** 页面卸载清理（与 disposeAsrCommon 等对称；仅撤本模块持有的 objectURL） */
export function disposeParser() {
  if (_input.mode === 'file' && _input.objectURL) {
    try { URL.revokeObjectURL(_input.objectURL); } catch (e) { /* ignore */ }
  }
  _input = { mode: 'none' };
}
