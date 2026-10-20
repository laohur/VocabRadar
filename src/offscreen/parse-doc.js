// VocabRadar offscreen 文档解析（B2，2026-09-10）：G4 通道 B 的 document kind 实装。
//   EPUB → 复用 src/guide/parser-epub.js（自研 ZIP 读取器，DecompressionStream 原生解压）
// 2026-10-20（用户裁定）：PDF/DOCX 解析整体移除（vendor unpdf/pdfjs 与 mammoth 带
//   eval 告警且包体近 2.4MB），本文件只剩 EPUB 一条路；pdf/docx 如实报不支持。
// 两端同步纪律：本文件与 guide/parser.js 的解析逻辑改动须双向核对（同 extParseChannel 契约先例）。
// 复用而非新引入：EPUB 走包内 parser-epub.js，零第三方依赖。
// 边界：doc/ppt/xls 等老格式明确不支持（ext-fail 透传网站侧）；空文本按失败抛（不静默）。

/**
 * 文档二进制 → 纯文本（offscreen 侧入口，SW 经 b64 中转后调用）
 * @param {Uint8Array} u8 文件字节（b64 还原的完整 buffer）
 * @param {string} docKind 'epub'（编排侧已按扩展名分类）；pdf/docx 已移除支持
 * @param {string} name 文件名（报错定位用）
 * @returns {Promise<string>} 纯文本（非空；空文本由调用方按失败处理）
 */
export async function parseDocBuffer(u8, docKind, name) {
  const tag = name ? ' (' + name + ')' : '';
  if (docKind === 'epub') {
    const { parseEpub } = await import('../guide/parser-epub.js');
    return parseEpub(new Blob([u8], { type: 'application/epub+zip' }), () => {});
  }
  if (docKind === 'pdf' || docKind === 'docx' || docKind === 'doc') {
    throw new Error('document kind no longer supported: ' + docKind + tag
      + ' — PDF/DOCX parsing was removed, convert to text or EPUB first');
  }
  throw new Error('unsupported doc kind: ' + docKind + tag);
}
