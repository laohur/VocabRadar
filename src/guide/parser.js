// VocabRadar 引导页 功能栏 Parser（文档解析）——第二百五十三次新增（用户："引导页 asr ocr
// 之后增加 parser … 先实现界面"）。本阶段=界面：左栏大输入框（粘贴文本/链接、拖入/粘贴/
// 上传选文件）+ 底下解析按钮，右栏纯文本结果。Capture / 录制按钮界面占位：点击 toast 明示
// "待接入"，不静默、不伪装（AGENTS：不可遮蔽错误）。
//
// 第二百五十四次（用户反馈）修订：
//   - 「上传文件」按钮按 ASR 栏先例加入第一行（替原"浏览文件"小链接——看不清是啥）；
//   - 右栏移除 Sidebar 切换——本页已有正常侧栏（文本侧栏悬浮球 + ASR 栏内联视频侧栏）；
//   - 网页正文提取用 defuddle 系既有定论（2026-08-31 用户裁定引入 Defuddle，
//     src/lib/vendor/defuddle.js 已落地、main-text.js loadDefuddle()/getAiMainText 主链=
//     Defuddle→密度法→直接解析，见 docs/正文提取替代方案调研.md）——勿再引入 Readability；
//   - vendor 组织规则（project_summary 2026-09-08 起）：单文件库一律平铺 vendor/ 顶层，
//     仅多文件功能保留子目录——mammoth.browser.min.js/pdf.min.mjs/pdf.worker.min.mjs 已
//     自 vendor/parser/ 拉平，多文件的 unpdf/ 保留子目录（勿再建 parser/ 分组目录）。
//
// 解析接线方案（下一步实现；vendor 库已就位，直接消费、不再加封装层）：
//   - 网页/链接 → SW FETCH_URL 拉 HTML + 复用 lib/main-text.js getAiMainText 主链
//     （Defuddle→密度法→直接解析）
//   - PDF  → unpdf（extractText({mergePages:true})，内联 pdf.js worker 免配置）
//   - DOCX → mammoth（extractRawText({arrayBuffer}) 即纯文本）
//   - 纯文本类（txt/md/srt/vtt/json/csv…）→ 直接按文本读
//   - 音视频 → 复用既有 ASR 管线（START_ASR/ASR_AUDIO_SEGMENT）
//   - 图片/拍照 → 复用既有 OCR 管线（OCR_RECOGNIZE）

import { t } from '../lib/i18n.js';
import { $, log, toast, formatFileSize } from './guide-common.js';

// 输入状态机（一个输入框、一个输出框）：
//   { mode:'none' }
//   { mode:'text', text, isUrl }        — 文本/链接（用户键入或粘贴文本）
//   { mode:'file', file, objectURL }    — 文件（拖入 / Ctrl+V / 上传选择）
let _input = { mode: 'none' };

const URL_RE = /^https?:\/\/\S+$/i;

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
  if (btn) btn.disabled = !hasInput();
}

/** 附着文件（拖入/粘贴/上传共用）：撤旧 objectURL，记录文件态 */
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

/** 解析按钮（本阶段占位：输入校验 + 输出区待接入提示，不伪装解析结果） */
function onParseClick() {
  if (!hasInput()) {
    toast(t('parser.noInput'), { error: true });
    return;
  }
  const out = $('g-parser-output');
  if (out) {
    out.innerHTML = '';
    const tip = document.createElement('div');
    tip.className = 'g-empty-tip';
    tip.textContent = t('parser.todoParse');
    out.appendChild(tip);
  }
  const what = (_input.mode === 'file')
    ? `file=${_input.file.name}`
    : `text ${_input.text.trim().length} chars${_input.isUrl ? ' (link)' : ''}`;
  toast(t('parser.todoParse'));
  log('Parser 解析点击（待接线）:', what);
}

/** 初始化（guide.js init 调用；仅绑事件与状态机，不触碰 storage/后台） */
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
  // 解析按钮（占位）
  if (parseBtn) parseBtn.addEventListener('click', onParseClick);
  // Capture / 录制：界面占位（toast 明示待接入，不静默）
  if (captureBtn) {
    captureBtn.addEventListener('click', () => {
      toast(t('parser.todoCapture'));
      log('Parser 拍照点击（待接线）');
    });
  }
  if (recordBtn) {
    recordBtn.addEventListener('click', () => {
      toast(t('parser.todoRecord'));
      log('Parser 录制点击（待接线），来源=',
        (document.querySelector('input[name="g-parser-source"]:checked') || {}).value || 'audio');
    });
  }
  refreshInputUI();
  log('Parser 界面已初始化（界面阶段，解析逻辑待接线）');
}

/** 页面卸载清理（与 disposeAsrCommon 等对称；仅撤本模块持有的 objectURL） */
export function disposeParser() {
  if (_input.mode === 'file' && _input.objectURL) {
    try { URL.revokeObjectURL(_input.objectURL); } catch (e) { /* ignore */ }
  }
  _input = { mode: 'none' };
}
