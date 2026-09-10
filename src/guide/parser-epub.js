// VocabRadar 引导页 Parser 文档侧：EPUB 纯文本提取（第二百五十八次新增，用户实测 .epub 报
// "Unsupported type" 后要求支持）。

import { t } from '../lib/i18n.js';

// 方案（不加第三方依赖，vendor 无 zip 库；mammoth 内置 zip 不外露）：
//   自研最小 ZIP 读取器——EOCD 定位 → 中央目录遍历 → local header 取数据 →
//   stored(0)/deflate(8) 两种压缩（deflate 用 DecompressionStream('deflate-raw')，
//   Chrome 80+/FF 113+ 原生支持，epub 实际均为 deflate）→
//   META-INF/container.xml → OPF（manifest+spine）→ 按 spine 顺序逐章 XHTML 提文本。
// 边界（如实报错，不静默）：
//   - DRM 加密 epub（META-INF/encryption.xml 存在）→ 明确报错不支持
//   - 非 epub zip / 无 container.xml → 报"不是有效 epub"
//   - ZIP64 / 分卷 不支持（电子书远小于 4GB 边界，如实抛错）

const SIG_EOCD = 0x06054b50;      // End of Central Directory
const SIG_CEN = 0x02014b50;       // Central directory entry
const SIG_LFH = 0x04034b50;       // Local file header

/** DataView 小端读 u16/u32 */
function u16(dv, off) { return dv.getUint16(off, true); }
function u32(dv, off) { return dv.getUint32(off, true); }

/** 解压单个 entry（method 0=stored 直取；8=deflate-raw 流式解压） */
async function inflateEntry(data, method, uncompressedSize) {
  if (method === 0) return data;
  if (method !== 8) throw new Error('zip method ' + method + ' not supported');
  if (typeof DecompressionStream !== 'function') {
    throw new Error('DecompressionStream unavailable in this browser');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  const out = new Uint8Array(buf);
  // 尺寸校验（中央目录声明的 uncompressedSize；防截断/损坏——不匹配如实报）
  if (uncompressedSize > 0 && out.length !== uncompressedSize) {
    throw new Error('zip entry size mismatch: ' + out.length + ' != ' + uncompressedSize);
  }
  return out;
}

/**
 * 最小 ZIP 读取：文件名 → 解压后字节
 * @param {Uint8Array} u8 zip 原始字节
 * @returns {Promise<Map<string, Uint8Array>>} 全部条目（目录项自动跳过）
 */
export async function unzip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // 从尾部扫 EOCD（注释区最长 64KB；找不到即非 zip）
  let eocd = -1;
  const min = Math.max(0, u8.length - 22 - 65535);
  for (let i = u8.length - 22; i >= min; i--) {
    if (u32(dv, i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (EOCD not found)');
  let count = u16(dv, eocd + 10);
  let cdOff = u32(dv, eocd + 16);
  if (cdOff === 0xFFFFFFFF || count === 0xFFFF) throw new Error('zip64 not supported');

  const entries = new Map();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (u32(dv, p) !== SIG_CEN) throw new Error('zip central directory corrupt at #' + i);
    const method = u16(dv, p + 10);
    const csize = u32(dv, p + 20);
    const usize = u32(dv, p + 24);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    const lfhOff = u32(dv, p + 42);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;   // 目录项
    // local header：名字/extra 长度可能与中央目录不同，须按 LFH 自己的字段定位数据
    if (u32(dv, lfhOff) !== SIG_LFH) throw new Error('zip local header corrupt: ' + name);
    const lfhNameLen = u16(dv, lfhOff + 26);
    const lfhExtraLen = u16(dv, lfhOff + 28);
    const dataStart = lfhOff + 30 + lfhNameLen + lfhExtraLen;
    const raw = u8.subarray(dataStart, dataStart + csize);
    entries.set(name, await inflateEntry(raw, method, usize));
  }
  return entries;
}

/** 章节 XHTML → 纯文本（去 script/style，块级标签转行，实体解码，行内空白归一） */
function xhtmlToText(xhtml) {
  const doc = new DOMParser().parseFromString(xhtml, 'text/html');
  doc.querySelectorAll('script,style,head').forEach((n) => n.remove());
  const root = doc.body || doc.documentElement;
  let raw = root.innerHTML
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article|figcaption|td|th|header|footer)>/gi, '\n');
  raw = raw.replace(/<[^>]+>/g, ' ');
  const dec = document.createElement('textarea');
  dec.innerHTML = raw;   // 实体解码（&amp; 等标准安全通道，不引外链）
  return dec.value.split(/\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)
    .join('\n');
}

/** 相对路径解析（OPF 所在目录 + item href；仅路径拼接，不做 URL 语义） */
function joinPath(baseDir, href) {
  const clean = String(href || '').split('#')[0];
  if (!baseDir) return decodeURIComponent(clean);
  return decodeURIComponent(baseDir.replace(/\/?$/, '/') + clean);
}

/**
 * EPUB → 纯文本（按 spine 顺序逐章，章间空行分隔）
 * @param {File|Blob} file epub 文件
 * @param {(stage: string, detail: string) => void} [onStatus] 进度回调
 * @returns {Promise<string>}
 */
export async function parseEpub(file, onStatus) {
  const report = typeof onStatus === 'function' ? onStatus : () => {};
  const u8 = new Uint8Array(await file.arrayBuffer());
  let zip;
  try {
    zip = await unzip(u8);
  } catch (e) {
    throw new Error('EPUB 容器解析失败: ' + String(e.message || e));
  }
  // DRM 甄别：Adobe 加密的 epub 会有 encryption.xml（解出来是密文，如实拒）
  if (zip.has('META-INF/encryption.xml')) {
    throw new Error('epub 含加密（DRM），暂不支持');
  }
  const containerXml = zip.get('META-INF/container.xml');
  if (!containerXml) throw new Error('不是有效的 epub（缺 META-INF/container.xml）');
  const containerDoc = new DOMParser().parseFromString(new TextDecoder().decode(containerXml), 'application/xml');
  const rootfile = containerDoc.querySelector('rootfile');
  const opfPath = rootfile && rootfile.getAttribute('full-path');
  if (!opfPath || !zip.has(opfPath)) throw new Error('不是有效的 epub（container.xml 无 rootfile）');

  const opfDoc = new DOMParser().parseFromString(new TextDecoder().decode(zip.get(opfPath)), 'application/xml');
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const manifest = new Map();   // id → {href, type}
  opfDoc.querySelectorAll('manifest > item').forEach((item) => {
    manifest.set(item.getAttribute('id'), {
      href: item.getAttribute('href') || '',
      type: item.getAttribute('media-type') || ''
    });
  });
  const spine = [...opfDoc.querySelectorAll('spine > itemref')]
    .map((ref) => manifest.get(ref.getAttribute('idref')))
    .filter(Boolean);
  if (spine.length === 0) throw new Error('不是有效的 epub（spine 为空）');

  const parts = [];
  for (let i = 0; i < spine.length; i++) {
    const item = spine[i];
    const path = joinPath(baseDir, item.href);
    const entry = zip.get(path);
    if (!entry) continue;   // spine 引用缺失条目：跳过（容错，如实留空该章）
    report(t('parser.parsing'), `EPUB ${i + 1}/${spine.length}`);
    const text = xhtmlToText(new TextDecoder().decode(entry));
    if (text.trim()) parts.push(text);
  }
  return parts.join('\n\n');
}
