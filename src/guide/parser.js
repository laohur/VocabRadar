// VocabRadar 引导页 功能栏 Parser（文档解析）——253 界面 / 255 接线 / 256·257·258 按用户实测修订。
// 职责：左栏输入（粘贴文本/链接、拖入/粘贴/上传文件、拍照、录制）→ 解析 → 右栏纯文本
//       （底部复制/导出按钮）。
//
// 258 次修订清单（用户实测反馈逐条）：
//   - 清除策略定型（用户口径）："输入框有啥，解析识别啥"——输入态=文本+文件列表统一容器，
//     不再互斥；"一个接一个上传，只要输入框有这个文件"→ 上传/拖/贴改为**累积**（257 的
//     替换语义废除）；"清除按钮可以清除所有"→ ✕ 清文本+文件+预览全部
//   - 拍照/录制预览位：输入区内唯一预览槽（#g-parser-media），下次拍照/录制**占用替换**；
//     成品同时进文件列表留档（⬇ 可取），"其他方法不是清除"——上传/拖入不动预览槽
//   - EPUB 支持（新 parser-epub.js：自研最小 ZIP 读取+DecompressionStream+spine 逐章）；
//     旧版 .doc 无法浏览器端解析（mammoth 仅 docx）→ 如实报"请另存为 .docx"
//   - 链接失败隔离：批链接逐条 try/catch（单链接失败不拖垮整批），失败带 URL 定位
//   - 录制按钮红色闪动恢复（红↔亮红背景动画，见 guide.css——旧 opacity 闪法透绿是根因）
//
// 解析分发（只提纯文本，全部复用既有能力，不加封装层）：
//   - 文本      → 直接输出
//   - 链接      → SW FETCH_TEXT（30s 超时）→ lib/main-text.js extractDefuddleFromHtml 主链
//   - PDF       → vendor/unpdf（definePDFJSModule 预解析 vendor pdfjs.mjs）
//   - DOCX      → vendor/mammoth.browser.min.js（UMD，script 注入取 window.mammoth）
//   - EPUB      → parser-epub.js（自研最小 zip + spine 逐章）
//   - HTML 文件 → 同链接（extractDefuddleFromHtml）
//   - 文本类    → file.text() 直读（txt/md/csv/srt/vtt/json/xml…）
//   - 图片      → OCR_RECOGNIZE（后台 offscreen，语言随 learnLanguage）
//   - 音视频    → parser-media.js transcribeAvFile（与 asr.js 文件 ASR 同消息协议）
//   - .doc 等未支持类型 → 按类型给可行动指引（.doc→另存 docx），不虚假承诺

import { t } from '../lib/i18n.js';
import { extractDefuddleFromHtml } from '../lib/main-text.js';
import { $, log, toast, formatFileSize, escapeHtml } from './guide-common.js';
import { openCamera } from './ocr.js';
import {
  isParserRecording, startParserRecording, stopParserRecording, transcribeAvFile
} from './parser-media.js';

// 输入态（统一容器——"输入框有啥，解析识别啥"）：文本与文件列表共存，
//   解析=文本（链接批或纯文本）+ 全部文件 顺序拼接
let _input = { text: '', items: [] };       // items: [{file, objectURL}]
let _preview = null;                        // 拍照/录制预览槽 {url, file, kind}（仅一个，占用替换）
let _parsing = false;                       // 解析中标志（解析/拍照互斥，按钮防重入）
let _lastResult = '';                       // 最近一次解析结果（复制/导出用）
let _liveTexts = [];                        // 录制实时识别句缓存（停止后并入结果）

const URL_RE = /^https?:\/\/\S+$/i;
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'srt', 'vtt', 'log', 'nfo']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus', 'weba']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'flv', 'ts']);
// 输入/输出框高度上限（与输出框一致，到底再内部滚动）
const BOX_MAX_HEIGHT = 560;
// 输入框收起态=一行高（261 次：无内容/有预览时收一行；与 .g-parser-ph line-height 保持一致）
const ONE_LINE_HEIGHT = 38;

/** 文件类型判定（mime 优先，扩展名兜底）→ pdf|docx|doc|epub|html|text|image|audio|video|null */
function detectParserKind(file) {
  const mt = (file.type || '').toLowerCase();
  const ext = ((file.name || '').split('.').pop() || '').toLowerCase();
  if (mt === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mt.includes('officedocument.wordprocessingml.document') || ext === 'docx') return 'docx';
  if (mt === 'application/msword' || ext === 'doc') return 'doc';
  if (mt === 'application/epub+zip' || ext === 'epub') return 'epub';
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
  } else {
    out.textContent = plain;
  }
  // 261 次（用户"应当在结果框末尾显示，就是导出按钮行靠右"）：元信息行（字符数+字节数）
  //   从结果框顶部移到复制/导出按钮行右端
  renderResultMeta();
}

/** 结果元信息（字符数 + UTF-8 字节数）：渲染在导出按钮行右端（有结果才显示） */
function renderResultMeta() {
  const row = $('g-parser-out-actions');
  if (!row) return;
  let meta = row.querySelector('.g-parser-meta');
  if (!_lastResult) {
    if (meta) meta.remove();
    return;
  }
  if (!meta) {
    meta = document.createElement('span');
    meta.className = 'g-parser-meta';
    row.appendChild(meta);
  }
  const bytes = new TextEncoder().encode(_lastResult).length;
  meta.textContent = `${_lastResult.length} ${t('parser.chars')} · ${bytes} ${t('parser.bytes')}`;
}
function setFail(msg) {
  const out = $('g-parser-output');
  if (!out) return;
  out.innerHTML = `<div class="g-parser-center g-empty-tip" style="color:#b23a2e">${escapeHtml(t('parser.fail') + String(msg).slice(0, 200))}</div>`;
}
/** 换输入清旧结果（文案走 i18n 随界面语言） */
function resetOutput() {
  _lastResult = '';
  const out = $('g-parser-output');
  if (out) out.innerHTML = `<div class="g-parser-center g-empty-tip">${escapeHtml(t('parser.outputTip'))}</div>`;
  renderResultMeta();
}
/** 录制中实时画面预览（260 次：摄像/录屏录制期间在预览槽看实时流；
 *  muted 防麦克风回声；停止后由 setPreview 用成片文件替换本元素） */
function showLivePreview(stream, kind) {
  const box = $('g-parser-media');
  if (!box) return;
  box.innerHTML = '';
  const video = document.createElement('video');
  video.className = 'g-parser-media-video';
  video.srcObject = stream;
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  box.appendChild(video);
  box.hidden = false;
  log('Parser 实时预览已开启:', kind);
}

/** 录制实时识别句流入（parser-media onLiveText 回调） */
function appendLiveText(text) {  if (!text) return;
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

/** 链接：SW FETCH_TEXT 中转（扩展页 CSP connect-src 白名单不含任意站点）→ Defuddle 主链 */
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

/** 单文件解析（批循环体；kind 判定 + 分发，未支持按类型给可行动指引） */
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
  if (kind === 'epub') {
    // EPUB：自研最小 zip + spine 逐章（parser-epub.js，无第三方依赖）
    const { parseEpub } = await import('./parser-epub.js');
    return parseEpub(file, (stage, detail) => setStatus(tag + stage, detail));
  }
  if (kind === 'html') {
    setStatus(tag + t('parser.parsing'), 'HTML');
    return (await extractDefuddleFromHtml(await file.text(), '')).text;
  }
  if (kind === 'text') {
    setStatus(tag + t('parser.parsing'), '');
    return file.text();
  }
  if (kind === 'doc') {
    // 旧版二进制 .doc：浏览器端无成熟解析器（mammoth 仅 docx），如实给转存指引
    throw new Error(t('parser.needDocx'));
  }
  throw new Error(t('parser.unsupported', { what: file.name || 'unknown' }));
}

/** 解析按钮："输入框有啥，解析识别啥"——文本（批链接或纯文本）+ 全部文件 顺序拼接；
 *  批链接逐条容错（单链接失败不拖垮整批），文件逐个容错，失败汇总定位到条目 */
function onParseClick() {
  if (!hasInput()) {
    toast(t('parser.noInput'), { error: true });
    return;
  }
  runJob(async () => {
    const parts = [];
    const failed = [];
    const links = extractLinks(_input.text);
    if (links) {
      for (const link of links) {
        try {
          parts.push(await parseLink(link));
        } catch (e) {
          log('单链接解析失败:', link, e);
          failed.push(`${link.slice(0, 60)}: ${String((e && e.message) || e).slice(0, 60)}`);
        }
      }
    } else if (_input.text.trim()) {
      setStatus(t('parser.parsing'), '');
      parts.push(_input.text.trim());
    }
    const items = _input.items;
    for (let i = 0; i < items.length; i++) {
      try {
        parts.push(await parseSingleFile(items[i].file, i, items.length));
      } catch (e) {
        log('单文件解析失败:', items[i].file.name, e);
        failed.push(`${items[i].file.name}: ${String((e && e.message) || e).slice(0, 60)}`);
      }
    }
    if (parts.length === 0 && failed.length > 0) {
      throw new Error(failed.join(' | '));
    }
    if (failed.length > 0) {
      toast(t('parser.fail') + failed.join(' | ').slice(0, 120), { error: true, duration: 6000 });
    }
    return parts.join('\n\n');
  });
}

// === 输入状态机（统一容器） ===

/** 输入是否可解析（文本非空或本批有文件） */
function hasInput() {
  return _input.text.trim().length > 0 || _input.items.length > 0;
}

/** 占位符覆盖层显隐（textarea 有值即隐） */
function updatePh() {
  const ta = $('g-parser-input');
  const ph = document.querySelector('.g-parser-ph');
  if (ta && ph) ph.style.display = ta.value ? 'none' : 'flex';
}

/** 刷新输入状态行/预览/文件列表/清空钮/解析按钮可用态（唯一入口，任何输入变化后调用） */
function refreshInputUI() {
  const info = $('g-parser-input-info-text');
  const btn = $('g-parser-btn');
  const clearBtn = $('g-parser-clear');
  if (info) {
    const segs = [];
    if (_input.items.length > 0) {
      segs.push(`${t('parser.multiFiles', { n: _input.items.length })} · ${formatFileSize(_input.items.reduce((s, it) => s + it.file.size, 0))}`);
    }
    if (_input.text.trim()) {
      const links = extractLinks(_input.text);
      segs.push(links ? t('parser.linksCount', { n: links.length })
        : `${_input.text.trim().length} ${t('parser.chars')}`);
    }
    info.textContent = segs.join(' · ');
  }
  renderFileList();
  if (clearBtn) clearBtn.hidden = !hasInput();
  if (btn) btn.disabled = _parsing || !hasInput();
  updatePh();
}

/** 本批文件列表（显示在输入区——缩略图(图片)+文件名+大小+保存(⬇)+删除(✕)；逐个可移） */
function renderFileList() {
  const box = $('g-parser-filelist');
  if (!box) return;
  box.innerHTML = '';
  if (_input.items.length === 0) {
    // 261 次（用户"只有自己没内容时候就一行"）：空列表收为一行虚线提示（也是拖放目标指引）
    const empty = document.createElement('div');
    empty.className = 'g-parser-file-empty';
    empty.textContent = t('parser.fileListEmpty');
    box.appendChild(empty);
    return;
  }
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

/** 移除本批中单个文件（撤 objectURL；仅删列表，不动文本与预览槽） */
function removeFile(idx) {
  if (!_input.items[idx]) return;
  try { URL.revokeObjectURL(_input.items[idx].objectURL); } catch (e) { /* ignore */ }
  _input.items.splice(idx, 1);
  refreshInputUI();
  log('Parser 文件已移除, 剩余', _input.items.length);
}

/** 附着一批文件（258 次口径："一个接一个上传，只要输入框有这个文件"——**累积**追加，
 *  不替换不叠加冲突；换输入的清场走 ✕ 清除全部）。拖入/粘贴/上传/录制成品/拍照共用 */
function attachFiles(fileList) {
  const files = [...(fileList || [])].filter(Boolean);
  if (files.length === 0) return;
  for (const f of files) {
    _input.items.push({ file: f, objectURL: URL.createObjectURL(f) });
  }
  resetOutput();
  refreshInputUI();
  log('Parser 文件已追加:', files.map((f) => `${f.name}(${formatFileSize(f.size)})`).join(', '),
    '本批共', _input.items.length, '个');
}

/** 切回文本态（textarea 输入/文本粘贴时；文件列表保留——统一容器不互斥） */
function setText(text) {
  _input.text = String(text || '');
  resetOutput();
  refreshInputUI();
}

/** 拍照/录制预览槽（仅一个，下次拍照/录制占用替换；文件列表全量留档） */
function setPreview(file) {
  const box = $('g-parser-media');
  if (!box) return;
  clearPreview();
  const url = URL.createObjectURL(file);
  const kind = detectParserKind(file);
  _preview = { url, file, kind };
  box.innerHTML = '';
  if (kind === 'image') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = file.name;
    box.appendChild(img);
  } else if (kind === 'audio') {
    const audio = document.createElement('audio');
    audio.className = 'g-parser-media-video';
    audio.src = url;
    audio.controls = true;
    box.appendChild(audio);
  } else {
    const video = document.createElement('video');
    video.className = 'g-parser-media-video';
    video.src = url;
    video.controls = true;
    box.appendChild(video);
  }
  // 259 次：右上角 ✕——仅撤预览显示（文件删除仍由列表逐项 ✕ 管）
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'g-parser-media-del';
  del.textContent = '✕';
  del.title = t('parser.fileDelete');
  del.addEventListener('click', clearPreview);
  box.appendChild(del);
  box.hidden = false;
  autosizeInput();   // 261 次：预览占用后输入框收一行
  log('Parser 预览已更新:', file.name);
}

function clearPreview() {
  if (_preview) {
    try { URL.revokeObjectURL(_preview.url); } catch (e) { /* ignore */ }
    _preview = null;
  }
  const box = $('g-parser-media');
  if (box) { box.innerHTML = ''; box.hidden = true; }
  autosizeInput();   // 261 次：预览撤除后输入框按内容恢复
}

/** 清空输入（✕ 清除所有——用户"清除按钮可以清除所有"）：文本+文件批+预览槽 */
function clearInput() {
  for (const it of _input.items) {
    try { URL.revokeObjectURL(it.objectURL); } catch (e) { /* ignore */ }
  }
  _input = { text: '', items: [] };
  const ta = $('g-parser-input');
  if (ta) { ta.value = ''; autosizeInput(); }
  clearPreview();
  resetOutput();
  refreshInputUI();
  log('Parser 输入已全部清空');
}

/** 输入框高度（261 次规则）：有内容→按内容延高（上限 560，到底内部滚动）；
 *  自己没内容→收一行；有预览槽时也收一行（文本保留在 value 里照常参与解析，
 *  仅显示收起——用户"有预览时输入框也缩短为一行"） */
function autosizeInput() {
  const ta = $('g-parser-input');
  if (!ta) return;
  if (!ta.value || _preview) {
    ta.style.height = ONE_LINE_HEIGHT + 'px';
    return;
  }
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, BOX_MAX_HEIGHT) + 'px';
}

/** dataURL → File（拍照成品入列+预览）
 *  259 次：不能用 fetch(dataUrl) 解码——data: URL 同受扩展页 CSP connect-src 管辖
 *  （实测 "Connecting to 'data:image/png...' violates CSP"），改 atob 纯解码零网络零 CSP */
function dataUrlToFile(dataUrl, name) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const mime = (/data:([^;]+)/.exec(meta) || [])[1] || 'application/octet-stream';
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return Promise.resolve(new File([u8], name, { type: mime }));
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

  // 初始空态（i18n 文案 + 居中）
  resetOutput();

  // 文本输入/文本粘贴 → 文本态（多链接规范化；文件列表保留，统一容器）
  if (input) {
    input.addEventListener('input', () => { setText(input.value); autosizeInput(); });
    // Ctrl+V 粘贴文件：剪贴板带文件时拦截，追加进本批（文本粘贴走 input 事件）
    input.addEventListener('paste', (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length > 0) {
        e.preventDefault();
        attachFiles(files);
      }
    });
    // 拖拽文件：dragover 高亮，drop 追加进本批（可多个）
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
  // 「上传文件」按钮（ASR 栏先例）→ 隐藏 file input（multiple 一批多选，累积追加）
  if (upload && fileInput) {
    upload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) attachFiles(fileInput.files);
      fileInput.value = '';
    });
  }
  // 解析按钮
  if (parseBtn) parseBtn.addEventListener('click', onParseClick);
  // 清空按钮：清除所有（文本+文件批+预览槽）
  if (clearBtn) clearBtn.addEventListener('click', clearInput);
  // 复制/导出（结果栏底下）
  if (copyBtn) copyBtn.addEventListener('click', copyResult);
  if (exportBtn) exportBtn.addEventListener('click', exportResult);
  // 拍照：复用 ocr.js 相机模态；成品入列（留档）+ 占用预览槽 + 自动 OCR
  if (captureBtn) {
    captureBtn.addEventListener('click', async () => {
      await openCamera(async (dataUrl, w, h) => {
        try {
          const file = await dataUrlToFile(dataUrl, `capture-${Date.now()}.png`);
          attachFiles([file]);
          setPreview(file);
          log('拍照成品已入列:', file.name, `${w}x${h}`);
        } catch (e) {
          log('拍照成品转 File 失败:', e);
        }
        // 262 次（用户"拍照不应当自动解析"）：去掉自动 OCR——是否解析、何时解析
        // 由用户点「解析」决定，拍照只负责入列+预览
      });
    });
  }
  // 录制：点击开始（⏹ 停止态 + 实时识别流入），再点停止→有实时文本即收编，否则转写成品
  if (recordBtn) {
    recordBtn.addEventListener('click', async () => {
      if (isParserRecording()) {
        const out2 = await stopParserRecording();
        // 260 次：成片无条件入列表+占预览槽（258 版在有实时文本时把成片丢了——用户
        // "录制完也没见"根因），文件与结果两不误
        if (out2 && out2.file) {
          attachFiles([out2.file]);
          setPreview(out2.file);
        }
        if (_liveTexts.length > 0) {
          const text = _liveTexts.join('\n');
          _liveTexts = [];
          setResult(text);
        } else if (out2 && out2.file) {
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
      await startParserRecording(kind, appendLiveText, showLivePreview);
    });
  }
  refreshInputUI();
  autosizeInput();
  log('Parser 已初始化（文本/批链接/PDF/DOCX/EPUB/HTML/文本类/图片OCR/音视频ASR；统一输入态可累积）');
}

/** 页面卸载清理（撤本批全部 objectURL 与预览槽） */
export function disposeParser() {
  for (const it of _input.items) {
    try { URL.revokeObjectURL(it.objectURL); } catch (e) { /* ignore */ }
  }
  clearPreview();
  _input = { text: '', items: [] };
}
