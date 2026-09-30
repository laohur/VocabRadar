// =============================================================================
// SW 工具集
// 职责：带超时 fetch、二进制⇄base64、PCM→WAV 编码、md5 包装。
// 跨消息回传的二进制一律先转 base64（chrome.runtime 消息默认 JSON 序列化，
//   ArrayBuffer 直传会变空对象——见 abToB64 注释）。
// =============================================================================
// import md5.js 作为副作用脚本，挂到 self.md5 供 md5Hex 使用
//   （js-md5 非 ESM，只能副作用引入；模块缓存保证只执行一次）
import '../../lib/vendor/md5.js';

// 带超时的 fetch，避免翻译服务器不响应时永久挂起
export async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ArrayBuffer → base64：扩展消息回传二进制的统一出口。
//   根因（官方博客《Unlock Structured Clone for Chrome Extension Messaging》）：
//   chrome.runtime 消息默认 JSON 序列化（结构化克隆为 Chrome 148 起 manifest 可选项），
//   JSON 下 ArrayBuffer 实测变空对象 {}（byteLength=undefined）——wordfreq 词频
//   "压缩大小: NaN KB" 即此根因。凡经消息回传的二进制一律先转 base64 字符串
//   （JSON 100% 安全），页面端 src/lib/b64.js b64ToU8 解码。
//   分块 fromCharCode：apply 单次参数上限约 65k，0x8000 步进防栈溢出。
export function abToB64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64ToUint8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** Float32 PCM → 16bit 单声道 WAV Blob（ASR 分片/整段转写的统一编码出口） */
export function pcmF32ToWavBlob(f32, sampleRate) {
  const n = f32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const wstr = (off, str) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
  wstr(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); wstr(8, 'WAVE'); wstr(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); wstr(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 2) {
    const sv = Math.max(-1, Math.min(1, f32[i]));
    v.setInt16(o, sv < 0 ? sv * 0x8000 : sv * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** 计算 md5 哈希（使用 js-md5 库，已挂到 self.md5） */
export function md5Hex(str) {
  if (typeof self !== 'undefined' && self.md5) {
    return self.md5(str);
  }
  return '';
}
