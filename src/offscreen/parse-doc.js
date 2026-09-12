// VocabRadar offscreen 文档解析（B2，2026-09-10）：G4 通道 B 的 document kind 实装。
// 与 src/guide/parser.js 同源——guide 页 Parser 栏实测稳定的解析实现平移精简（Buffer 形态）：
//   PDF  → vendor/unpdf（getDocumentProxy + extractText mergePages）
//   DOCX → vendor/mammoth.browser.min.js（UMD script 注入取 window.mammoth）
//   EPUB → 复用 src/guide/parser-epub.js（自研 ZIP 读取器，DecompressionStream 原生解压）
// 两端同步纪律：本文件与 guide/parser.js 的加载/解析逻辑改动须双向核对（同 extParseChannel 契约先例）。
// 复用而非新引入：vendor 两库已在扩展包内，零新增下载；本文件零第三方依赖。
// 边界：doc/ppt/xls 等老格式两库均不支持，明示报错（ext-fail 透传网站侧）；空文本按失败抛（不静默）。

let _unpdfMod = null;  // unpdf 模块级缓存（同 guide/parser.js _unpdfMod）
let _mammoth = null;   // mammoth 全局缓存

// 加载 unpdf：ESM 动态 import + definePDFJSModule 注入 pdfjs（同 guide/parser.js loadUnpdf）
async function loadUnpdf() {
  if (_unpdfMod) return _unpdfMod;
  const base = chrome.runtime.getURL('src/lib/vendor/unpdf/');
  const mod = await import(base + 'index.mjs');
  await mod.definePDFJSModule(() => import(base + 'pdfjs.mjs'));
  _unpdfMod = mod;
  return mod;
}

// 加载 mammoth：UMD script 注入取 window.mammoth（同 guide/parser.js loadMammoth）
async function loadMammoth() {
  if (_mammoth) return _mammoth;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('src/lib/vendor/mammoth.browser.min.js');
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load mammoth.browser.min.js'));
    document.head.appendChild(s);
  });
  if (!window.mammoth) throw new Error('mammoth global not found after script load');
  _mammoth = window.mammoth;
  return _mammoth;
}

/**
 * 文档二进制 → 纯文本（offscreen 侧入口，SW 经 b64 中转后调用）
 * @param {Uint8Array} u8 文件字节（b64 还原的完整 buffer）
 * @param {string} docKind 'pdf'|'docx'|'epub'（编排侧已按扩展名分类；其余 kind 明示不支持）
 * @param {string} name 文件名（报错定位用）
 * @returns {Promise<string>} 纯文本（非空；空文本由调用方按失败处理）
 */
export async function parseDocBuffer(u8, docKind, name) {
  const tag = name ? ' (' + name + ')' : '';
  if (docKind === 'pdf') {
    const mod = await loadUnpdf();
    const pdf = await mod.getDocumentProxy(u8);
    const { text } = await mod.extractText(pdf, { mergePages: true });
    return text || '';
  }
  if (docKind === 'docx') {
    const mammoth = await loadMammoth();
    const { value } = await mammoth.extractRawText({ arrayBuffer: u8.buffer });
    return value || '';
  }
  if (docKind === 'epub') {
    const { parseEpub } = await import('../guide/parser-epub.js');
    return parseEpub(new Blob([u8], { type: 'application/epub+zip' }), () => {});
  }
  throw new Error('unsupported doc kind: ' + docKind + tag);
}
