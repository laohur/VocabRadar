// 轻量级 msgpack 解码器（仅解码，无编码）
//
// 用途：解码 wordfreq 的 small_*.msgpack.bin 文件（内容仍 gzip）
// 数据格式：dict<string, number>，number 为 float（每百万词出现次数）
//
// 设计原则：
//   1. 仅实现解码，不需要编码（preprocess.mjs 已在 Node 端编码）
//   2. 覆盖 msgpack 全部基础类型（nil/bool/int/float/str/array/map），
//      通用性足以应对任何合法 msgpack 数据
//   3. 零依赖，纯 ES module，避免引入第三方库增加扩展体积
//   4. 不支持 ext/binary 类型（wordfreq 数据不使用这些类型）
//
// 反思（2026-08-02）：选用自实现而非 notepack.io / @msgpack/msgpack，
//   原因：(a) wordfreq 数据格式简单固定，自实现足以覆盖；
//         (b) 避免引入第三方依赖（CSP 限制 + 版本管理复杂度）；
//         (c) 解码器仅约 100 行，可控可审计。
//
// 用法：
//   import { decode } from './msgpack-lite.js';
//   const data = decode(arrayBuffer); // 返回 {word: frequency, ...}

/**
 * 解码 msgpack 二进制数据
 * @param {ArrayBuffer|Uint8Array} buffer 二进制数据
 * @returns {*} 解码后的 JS 值（通常为 object）
 */
export function decode(buffer) {
  // 反思（2026-08-11 第二十四次）：Firefox Xray 彻底根治。
  //   instanceof ArrayBuffer 在 Firefox Xray 下会访问 constructor 属性，
  //   触发 "Permission denied to access property constructor"。
  //   修正：完全不用 instanceof，纯 duck typing + 逐字节复制。
  //   策略：直接用 new Uint8Array(buffer) 创建视图（对 ArrayBuffer/TypedArray 均有效），
  //   失败则逐字节读取（索引访问在 Xray 下始终可用）。
  //   最终创建全新裸 ArrayBuffer（本领域创建，脱离 Xray）。
  let rawBytes;
  try {
    // 方案 1：直接 new Uint8Array(buffer)
    // 对 ArrayBuffer、Uint8Array、Array 均有效
    rawBytes = new Uint8Array(buffer);
    // 验证：如果 rawBytes.length 为 0 但 buffer 有数据，说明构造失败
    if (rawBytes.length === 0 && buffer && (buffer.byteLength || buffer.length) > 0) {
      throw new Error('Uint8Array constructor returned empty');
    }
  } catch (e) {
    // 方案 2：TypedArray-like（有 .buffer + byteOffset + byteLength）
    try {
      if (buffer && buffer.buffer && typeof buffer.byteOffset === 'number' && typeof buffer.byteLength === 'number') {
        rawBytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      } else {
        throw e;
      }
    } catch (e2) {
      // 方案 3（最终回退）：逐字节读取（索引访问在 Xray 下始终可用）
      console.warn('[VocabRadar][msgpack] 标准构造失败，使用逐字节回退:', e2 && e2.message);
      const len = (buffer && (buffer.byteLength || buffer.length)) || 0;
      rawBytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        rawBytes[i] = buffer[i];
      }
    }
  }

  // 创建全新裸 ArrayBuffer（本领域创建，脱离任何 Xray 包装）
  const len = rawBytes.length;
  const cleanBuf = new ArrayBuffer(len);
  const bytes = new Uint8Array(cleanBuf);
  // 先尝试批量复制（快），失败则逐字节复制（慢但稳）
  try {
    bytes.set(rawBytes);
  } catch (e) {
    for (let i = 0; i < len; i++) bytes[i] = rawBytes[i];
  }
  const view = new DataView(cleanBuf);
  let pos = 0;

  function decodeOne() {
    if (pos >= bytes.length) throw new Error('msgpack: unexpected end of buffer');
    const type = bytes[pos++];

    // positive fixint: 0x00-0x7f
    if (type <= 0x7f) return type;
    // fixmap: 0x80-0x8f
    if (type >= 0x80 && type <= 0x8f) {
      const len = type - 0x80;
      return decodeMap(len);
    }
    // fixarray: 0x90-0x9f
    if (type >= 0x90 && type <= 0x9f) {
      const len = type - 0x90;
      return decodeArray(len);
    }
    // fixstr: 0xa0-0xbf
    if (type >= 0xa0 && type <= 0xbf) {
      return decodeStr(type - 0xa0);
    }
    // negative fixint: 0xe0-0xff
    if (type >= 0xe0) return type - 256;

    switch (type) {
      case 0xc0: return null;          // nil
      case 0xc2: return false;        // false
      case 0xc3: return true;         // true
      case 0xca: {                     // float32
        const v = view.getFloat32(pos); pos += 4; return v;
      }
      case 0xcb: {                     // float64
        const v = view.getFloat64(pos); pos += 8; return v;
      }
      case 0xcc: {                     // uint8
        const v = view.getUint8(pos); pos += 1; return v;
      }
      case 0xcd: {                     // uint16
        const v = view.getUint16(pos); pos += 2; return v;
      }
      case 0xce: {                     // uint32
        const v = view.getUint32(pos); pos += 4; return v;
      }
      case 0xcf: {                     // uint64（不安全整数，仍转为 Number）
        const hi = view.getUint32(pos);
        const lo = view.getUint32(pos + 4);
        pos += 8;
        return hi * 0x100000000 + lo;
      }
      case 0xd0: {                     // int8
        const v = view.getInt8(pos); pos += 1; return v;
      }
      case 0xd1: {                     // int16
        const v = view.getInt16(pos); pos += 2; return v;
      }
      case 0xd2: {                     // int32
        const v = view.getInt32(pos); pos += 4; return v;
      }
      case 0xd3: {                     // int64
        const hi = view.getInt32(pos);
        const lo = view.getUint32(pos + 4);
        pos += 8;
        return hi * 0x100000000 + lo;
      }
      case 0xd9: {                     // str8
        const len = view.getUint8(pos); pos += 1;
        return decodeStr(len);
      }
      case 0xda: {                     // str16
        const len = view.getUint16(pos); pos += 2;
        return decodeStr(len);
      }
      case 0xdb: {                     // str32
        const len = view.getUint32(pos); pos += 4;
        return decodeStr(len);
      }
      case 0xdc: {                     // array16
        const len = view.getUint16(pos); pos += 2;
        return decodeArray(len);
      }
      case 0xdd: {                     // array32
        const len = view.getUint32(pos); pos += 4;
        return decodeArray(len);
      }
      case 0xde: {                     // map16
        const len = view.getUint16(pos); pos += 2;
        return decodeMap(len);
      }
      case 0xdf: {                     // map32
        const len = view.getUint32(pos); pos += 4;
        return decodeMap(len);
      }
      default:
        throw new Error('msgpack: unsupported type 0x' + type.toString(16) + ' at pos ' + (pos - 1));
    }
  }

  // 解码字符串：使用共享 TextDecoder（UTF-8）支持多字节字符（CJK、emoji 等）
  // 反思（2026-08-02）：wordfreq 包含 CJK 字符（如 small_zh），必须用 UTF-8 解码
  const _decoder = new TextDecoder('utf-8');
  function decodeStr(len) {
    const s = _decoder.decode(bytes.subarray(pos, pos + len));
    pos += len;
    return s;
  }

  function decodeArray(len) {
    const arr = new Array(len);
    for (let i = 0; i < len; i++) arr[i] = decodeOne();
    return arr;
  }

  function decodeMap(len) {
    const obj = {};
    for (let i = 0; i < len; i++) {
      const k = decodeOne();
      const v = decodeOne();
      obj[k] = v;
    }
    return obj;
  }

  return decodeOne();
}
