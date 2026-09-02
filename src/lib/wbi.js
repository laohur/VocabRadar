// WBI 签名模块（B站 API 鉴权）
// 用于 player wbi/v2 等接口签名，参数含 w_rid + wts
// 参考：SocialSisterYi/bilibili-API-collect docs/misc/sign/wbi.md
//
// 流程：
//   1. 从 nav 接口取 img_url/sub_url，提取 img_key/sub_key
//   2. 用 mixin_key 重排表对 img_key+sub_key 重排，取前32位作 mixin_key
//   3. 参数加 wts（秒级时间戳），按 key 字典序排序
//   4. 拼接 query + mixin_key，做 MD5 得 w_rid
//   5. 把 w_rid 加到请求参数

// === MD5 实现（紧凑版，RFC 1321）===
// 浏览器无原生 MD5（crypto.subtle 仅支持 SHA 系列），故自行实现

function safeAdd(x, y) {
  const lsw = (x & 0xffff) + (y & 0xffff);
  const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
  return (msw << 16) | (lsw & 0xffff);
}

function bitRol(num, cnt) {
  return (num << cnt) | (num >>> (32 - cnt));
}

function md5cmn(q, a, b, x, s, t) {
  return safeAdd(bitRol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
}
function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & ~d), a, b, x, s, t); }
function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }

function binlMD5(x, len) {
  x[len >> 5] |= 0x80 << (len % 32);
  x[(((len + 64) >>> 9) << 4) + 14] = len;
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const olda = a, oldb = b, oldc = c, oldd = d;
    a = md5ff(a, b, c, d, x[i], 7, -680876936);
    d = md5ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = md5ff(c, d, a, b, x[i + 2], 17, 606105819);
    b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = md5ff(a, b, c, d, x[i + 4], 7, -176418897);
    d = md5ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341);
    b = md5ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = md5ff(a, b, c, d, x[i + 8], 7, 1770035416);
    d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = md5ff(c, d, a, b, x[i + 10], 17, -42063);
    b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = md5ff(a, b, c, d, x[i + 12], 7, 1804603682);
    d = md5ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290);
    b = md5ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = md5gg(a, b, c, d, x[i + 1], 5, -165796510);
    d = md5gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = md5gg(c, d, a, b, x[i + 11], 14, 643717713);
    b = md5gg(b, c, d, a, x[i], 20, -373897657);
    a = md5gg(a, b, c, d, x[i + 5], 5, -701558691);
    d = md5gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = md5gg(c, d, a, b, x[i + 15], 14, -660478335);
    b = md5gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = md5gg(a, b, c, d, x[i + 9], 5, 568446438);
    d = md5gg(d, a, b, c, x[i + 14], 9, -1019803794);
    c = md5gg(c, d, a, b, x[i + 3], 14, -187363961);
    b = md5gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = md5gg(a, b, c, d, x[i + 13], 5, -1444681467);
    d = md5gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = md5gg(c, d, a, b, x[i + 7], 14, 1735328473);
    b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = md5hh(a, b, c, d, x[i + 5], 4, -378558);
    d = md5hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = md5hh(c, d, a, b, x[i + 11], 16, 1839030562);
    b = md5hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = md5hh(a, b, c, d, x[i + 1], 4, -1530992060);
    d = md5hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = md5hh(c, d, a, b, x[i + 7], 16, -155497632);
    b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = md5hh(a, b, c, d, x[i + 13], 4, 681279174);
    d = md5hh(d, a, b, c, x[i], 11, -358537222);
    c = md5hh(c, d, a, b, x[i + 3], 16, -722521979);
    b = md5hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = md5hh(a, b, c, d, x[i + 9], 4, -640364487);
    d = md5hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = md5hh(c, d, a, b, x[i + 15], 16, 530742520);
    b = md5hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = md5ii(a, b, c, d, x[i], 6, -198630844);
    d = md5ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905);
    b = md5ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = md5ii(a, b, c, d, x[i + 12], 6, 1700485571);
    d = md5ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = md5ii(c, d, a, b, x[i + 10], 15, -1051523);
    b = md5ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = md5ii(a, b, c, d, x[i + 8], 6, 1873313359);
    d = md5ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = md5ii(c, d, a, b, x[i + 6], 15, -1560198380);
    b = md5ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = md5ii(a, b, c, d, x[i + 4], 6, -145523070);
    d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = md5ii(c, d, a, b, x[i + 2], 15, 718787259);
    b = md5ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = safeAdd(a, olda);
    b = safeAdd(b, oldb);
    c = safeAdd(c, oldc);
    d = safeAdd(d, oldd);
  }
  return [a, b, c, d];
}

function rstrMD5(s) {
  const input = utf8Encode(s);
  const x = [];
  for (let i = 0; i < input.length * 8; i += 8) {
    x[i >> 5] |= (input[i >> 3] & 0xff) << (i % 32);
  }
  const out = binlMD5(x, input.length * 8);
  let result = '';
  for (let i = 0; i < 4 * 4; i++) {
    result += String.fromCharCode((out[i >> 2] >> ((i % 4) * 8 + 0)) & 0xff);
  }
  return result;
}

function utf8Encode(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 128) {
      out.push(c);
    } else if (c < 2048) {
      out.push((c >> 6) | 192);
      out.push((c & 63) | 128);
    } else {
      out.push((c >> 12) | 224);
      out.push(((c >> 6) & 63) | 128);
      out.push((c & 63) | 128);
    }
  }
  return out;
}

/** 对字符串做 MD5，返回32位小写hex */
export function md5Hex(s) {
  const rstr = rstrMD5(s);
  let hex = '';
  for (let i = 0; i < rstr.length; i++) {
    let b = rstr.charCodeAt(i);
    hex += ((b & 0xff) + 0x100).toString(16).slice(1);
  }
  return hex;
}

// === WBI mixin_key 重排表 ===
// 固定表，取自 bilibili-API-collect，注意取前32位作 mixin_key
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 36, 25, 40, 26, 6, 24, 51, 16, 22, 44, 11, 20, 30, 21, 53,
  55, 7, 17, 4, 52, 48, 34, 57, 56, 1, 54, 0, 59, 61, 60, 63,
  62, 64
];

let _imgKey = null;
let _subKey = null;

/** 从 nav 接口获取 img_key/sub_key（带缓存，10分钟过期） */
let _keysExpire = 0;
async function getWbiKeys() {
  const now = Date.now();
  if (_imgKey && _subKey && now < _keysExpire) {
    return { imgKey: _imgKey, subKey: _subKey };
  }
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
  const data = await res.json();
  if (data.code !== 0 || !data.data?.wbi_img?.img_url) {
    throw new Error('nav 接口未返回 wbi_img');
  }
  const imgUrl = data.data.wbi_img.img_url;
  const subUrl = data.data.wbi_img.sub_url;
  _imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1, imgUrl.lastIndexOf('.'));
  _subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1, subUrl.lastIndexOf('.'));
  _keysExpire = now + 10 * 60 * 1000; // 10分钟
  console.log(`[VocabRadar][wbi] imgKey=${_imgKey} subKey=${_subKey}`);
  return { imgKey: _imgKey, subKey: _subKey };
}

/** 对 img_key+sub_key 重排，取前32位作 mixin_key */
function getMixinKey(orig) {
  let temp = '';
  for (const i of MIXIN_KEY_ENC_TAB) {
    if (i < orig.length) temp += orig[i];
  }
  return temp.slice(0, 32);
}

/**
 * 用 WBI 签名参数
 * @param {Object} params 业务参数（不含 wts/w_rid）
 * @returns {Promise<Object>} 加好 wts + w_rid 的参数对象
 */
export async function signWbi(params) {
  const { imgKey, subKey } = await getWbiKeys();
  const mixinKey = getMixinKey(imgKey + subKey);
  const currTime = Math.round(Date.now() / 1000);
  const chrFilter = /[!'()*]/g;
  const merged = { ...params, wts: currTime };
  // 按 key 字典序排序拼接
  const sortedKeys = Object.keys(merged).sort();
  const parts = [];
  for (const k of sortedKeys) {
    const v = String(merged[k]).replace(chrFilter, '');
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  const queryString = parts.join('&');
  const w_rid = md5Hex(queryString + mixinKey);
  console.log(`[VocabRadar][wbi] wts=${currTime} w_rid=${w_rid} query=${queryString}`);
  return { ...merged, w_rid };
}

/**
 * 构造带签名的完整 URL
 * @param {string} baseUrl 形如 https://api.bilibili.com/x/player/wbi/v2
 * @param {Object} params
 * @returns {Promise<string>}
 */
export async function buildSignedUrl(baseUrl, params) {
  const signed = await signWbi(params);
  const qs = new URLSearchParams(signed).toString();
  return `${baseUrl}?${qs}`;
}
