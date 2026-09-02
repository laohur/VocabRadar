// fMP4（fragmented MP4 / ISO-BMFF）最小解析器
// 第九十五次新建：支撑 ASR 流式音频下载——按字节 Range 分块拉取 B站 DASH 音频（.m4s），
// 需要在任意字节窗口内找到「电影片段」边界并换算媒体时间，才能把分块解码出的 PCM
// 精确映射回视频时间轴。
//
// === 调研依据 ===
//   1. videoseek-2.5.6-prod 的 ChunkedDownloader：先取 content-length，再按固定块发
//      `Range: bytes=start-end`（重试×3、并发限制、总长校验）。本扩展借鉴其分块 Range 思路。
//   2. mp4box.js 的盒遍历思想：ISO-BMFF 由顶层 box 线性串联 [size(4B 大端)][type(4B)]，
//      size===1 时后随 8B largesize，size===0 表示延伸到文件尾。遍历到不完整 box 即停。
//   3. B站 DASH .m4s 为 fMP4：文件头是初始化块（ftyp[+free]+moov，含 AAC 解码配置 esds），
//      其后为若干「电影片段」[moof][mdat]。初始化块 + 任意一段连续完整片段可拼成独立可解码
//      文件（Chrome decodeAudioData 对整文件可解码已在线上验证；init+连续片段即最小合法 fMP4）。
//
// === 关键换算 ===
//   - moov/trak/mdia/mdhd 携带 timescale（媒体时间每秒刻度数）
//   - moof/traf/tfdt 携带 baseMediaDecodeTime（该片段在媒体时间轴上的起点刻度）
//   → 片段起始秒 = baseMediaDecodeTime / timescale。用它把每个下载批次解码出的 PCM
//     锚定到视频时间轴，带宽估算误差只影响「从哪个字节开始取」，不影响时间戳精度。

/** 递归下降时允许进入的容器盒类型（仅列本模块需要穿越的） */
const CONTAINER_BOXES = new Set(['moov', 'trak', 'edts', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex']);

/**
 * 遍历 [from, to) 内的顶层盒序列
 * 反思（第九十五次）：窗口起点可能落在某盒中间（字节估算 seek），此时首个 size 字段是乱数，
 * 会得到非法尺寸——直接停止返回已解析部分；调用方应先用 findMoofSync 同步到可靠边界再遍历。
 * @param {ArrayBuffer} ab 目标缓冲
 * @param {number} [from] 起始偏移
 * @param {number} [to] 结束偏移（不含）
 * @returns {Array<{type:string,start:number,size:number,end:number,truncated:boolean}>}
 */
export function walkBoxes(ab, from = 0, to = ab.byteLength) {
  const dv = new DataView(ab);
  const boxes = [];
  let off = from;
  while (off + 8 <= to) {
    let size = dv.getUint32(off);
    const type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7));
    if (size === 1) {
      // 64 位 largesize：高 32 位 ×2^32 + 低 32 位（音频文件远用不到，但按规范支持）
      if (off + 16 > to) break;
      size = dv.getUint32(off + 8) * 4294967296 + dv.getUint32(off + 12);
    } else if (size === 0) {
      // size=0：最后一个盒，延伸到 to
      size = to - off;
    }
    if (size < 8) break; // 非法尺寸：数据不对齐或损坏，停止
    const end = off + size;
    if (end > to) {
      // 尾部被截断（窗口边界切在盒中间）：记录但不作为完整边界使用
      boxes.push({ type, start: off, size, end, truncated: true });
      break;
    }
    boxes.push({ type, start: off, size, end, truncated: false });
    off = end;
  }
  return boxes;
}

/**
 * 在可能不对齐的字节窗口内搜索第一个可靠的 moof 盒起点（模式同步）
 * 用于 Range 窗口起点落在片段中间的场景：扫描 'moof' 四字节签名，
 * 并校验其前导 size 字段合法、且后续盒链至少一步自洽，排除正文里碰巧出现的字节组合。
 * @param {Uint8Array} u8 窗口数据
 * @param {number} [from] 起始扫描偏移
 * @returns {number} 可靠 moof 盒起始偏移（含 8 字节盒头），找不到返回 -1
 */
export function findMoofSync(u8, from = 0) {
  const n = u8.length;
  if (n < 20) return -1;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // 盒类型必须为 4 个可打印字符（字母/数字/空格），用于校验下一盒合法性
  const printable = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 32;
  for (let i = Math.max(4, from); i + 8 <= n; i++) {
    if (u8[i] !== 0x6D || u8[i + 1] !== 0x6F || u8[i + 2] !== 0x6F || u8[i + 3] !== 0x66) continue; // 'moof'
    const bs = i - 4; // 盒头起点（size 字段处）
    const size = dv.getUint32(bs);
    if (size < 8 || bs + size > n) continue;
    const p = bs + size;
    if (p === n) return bs; // moof 恰好收尾于窗口末尾，视为有效
    if (p + 8 > n) continue; // 下一盒头不完整，无法验证
    const sz2 = dv.getUint32(p);
    if (sz2 < 8 || p + sz2 > n) continue;
    if (!printable(u8[p + 4]) || !printable(u8[p + 5]) || !printable(u8[p + 6]) || !printable(u8[p + 7])) continue;
    return bs;
  }
  return -1;
}

/**
 * 在 [from,to) 内按容器链定位目标盒（返回所有匹配的载荷偏移）
 * 例如 chain=['trak','mdia','mdhd'] 会先找 trak，再在其载荷内找 mdia，再找 mdhd。
 * 只沿链下降，不展开无关兄弟盒，避免误匹配深层同名盒。
 * @param {ArrayBuffer} ab
 * @param {number} from
 * @param {number} to
 * @param {string[]} chain 盒类型链（首元素起）
 * @param {number[]} acc 递归累积结果（载荷起始偏移）
 * @returns {number[]}
 */
function locateChain(ab, from, to, chain, acc = []) {
  for (const b of walkBoxes(ab, from, to)) {
    if (b.truncated) break;
    if (b.type !== chain[0]) continue;
    if (chain.length === 1) {
      acc.push(b.start + 8); // 载荷起始（跳过 size+type 盒头）
    } else {
      locateChain(ab, b.start + 8, b.end, chain.slice(1), acc);
    }
  }
  return acc;
}

/**
 * 从初始化块解析音轨 timescale
 * mdhd 布局：[ver:1][flags:3] 后 v0 为 creation4+mod4+timescale4，
 * v1 为 creation8+mod8+timescale4（大端）。
 * @param {ArrayBuffer} initAb 初始化块（ftyp..moov，第一个 moof 之前的全部字节）
 * @returns {number|null} timescale（刻度/秒），失败返回 null
 */
export function parseMdhdTimescale(initAb) {
  try {
    const hits = locateChain(initAb, 0, initAb.byteLength, ['moov', 'trak', 'mdia', 'mdhd']);
    for (const p of hits) {
      const dv = new DataView(initAb);
      if (p + 4 > initAb.byteLength) continue;
      const version = dv.getUint8(p);
      const tsOff = p + 4 + (version === 1 ? 16 : 8);
      if (tsOff + 4 > initAb.byteLength) continue;
      const ts = dv.getUint32(tsOff);
      if (ts > 0 && ts < 0xFFFFFFFF) return ts;
    }
  } catch (e) { /* 结构异常按失败处理 */ }
  return null;
}

/**
 * 从电影片段解析 tfdt baseMediaDecodeTime 并换算为秒
 * tfdt 布局：[ver:1][flags:3] 后 v0 为 uint32、v1 为 uint64 的基准解码时刻。
 * @param {Uint8Array} fragU8 片段数据（至少含一个完整 moof）
 * @param {number} timescale mdhd 时标（刻度/秒）
 * @returns {number|null} 片段起始媒体时间（秒），失败返回 null
 */
export function parseTfdtSeconds(fragU8, timescale) {
  if (!timescale) return null;
  try {
    const hits = locateChain(fragU8.buffer, fragU8.byteOffset, fragU8.byteOffset + fragU8.byteLength, ['moof', 'traf', 'tfdt']);
    for (const absP of hits) {
      const relP = absP - fragU8.byteOffset;
      const dv = new DataView(fragU8.buffer, fragU8.byteOffset, fragU8.byteLength);
      if (relP + 4 > fragU8.length) continue;
      const version = dv.getUint8(relP);
      let ticks;
      if (version === 1) {
        if (relP + 12 > fragU8.length) continue;
        ticks = dv.getUint32(relP + 4) * 4294967296 + dv.getUint32(relP + 8);
      } else {
        if (relP + 8 > fragU8.length) continue;
        ticks = dv.getUint32(relP + 4);
      }
      return ticks / timescale;
    }
  } catch (e) { /* 结构异常按失败处理 */ }
  return null;
}

/**
 * 计算盒列表中的「完整前缀终点」：最后一个非截断盒的 end（无完整盒则返回起点）
 * @param {Array<{start:number,end:number,truncated:boolean}>} boxes walkBoxes 结果
 * @param {number} fallback 无完整盒时的回退值
 * @returns {number}
 */
export function completePrefixEnd(boxes, fallback) {
  let end = fallback;
  for (const b of boxes) {
    if (b.truncated) break;
    end = b.end;
  }
  return end;
}
