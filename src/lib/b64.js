// ============================================================
// 文件职责：base64 → 二进制解码工具（src/lib/b64.js）
// 背景（2026-09-08 第二百四十次）：Chrome 扩展消息（chrome.runtime.sendMessage）
//   默认使用 JSON 序列化——官方博客《Unlock Structured Clone for Chrome Extension
//   Messaging》（2026-04-22）：结构化克隆为 Chrome 148 起经 manifest
//   message_serialization="structured_clone" 的可选项，省略/低版本一律 JSON。
//   JSON 下二进制类型丢失：实测 ArrayBuffer → 空对象 {}（byteLength=undefined，
//   wordfreq 词频"压缩大小: NaN"根因）。故 SW 经消息回传二进制一律先转 base64
//   字符串（JSON 100% 安全），页面端经本文件解码。
//   受影响通道：WF_FETCH / KURO_FETCH / FETCH_AUDIO / FETCH_AUDIO_RANGE。
// ============================================================

/**
 * base64 字符串 → Uint8Array（页面端消费 SW 回传二进制的统一入口）
 * @param {string} b64 SW 端 abToB64 产出的 base64 文本
 * @returns {Uint8Array} 原始字节（.buffer 即 ArrayBuffer，可直接喂 Response/解码器）
 */
export function b64ToU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
