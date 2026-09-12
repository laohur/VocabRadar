// 图片等比缩放工具（第二百六十六次，2026-09-10，用户裁定："图片短边最长1280"）
// 背景：网站 Creator/引导页/右键识别把原始截图（如 VLC 4K 快照，PNG 5-10MB）整包
//   透传到 OCR（Tesseract offscreen / LLM 视觉 API），白耗传输且超视觉 API 预算。
// 阈值依据（调研）：Tesseract.js 社区预处理惯例把图片控制在千像素级；
//   主流视觉 API 各有图片预算（Anthropic 建议长边≤1568、OpenAI 高清档按 768 短边切块，
//   超限内部自行下采样）——本扩展按用户裁定统一"短边 ≤1280"，短边未超限原图不动。
// 环境自适应：Service Worker 无 DOM → OffscreenCanvas + convertToBlob；
//   扩展页/offscreen document 有 DOM → 普通 canvas + toBlob。createImageBitmap 两端皆可用。
// CSP 纪律（同 guide/parser.js dataUrlToFile 第259次教训）：dataURL 一律 atob/btoa 手动
//   编解码，不用 fetch(dataUrl)——扩展页 connect-src 对 data: 依 CSP 配置可拒。
// 失败不抛：任何一步失败都原样返回输入（scaled=false + error 说明），绝不阻断 OCR 主链路。

/**
 * dataURL 等比缩放（短边超限时缩到短边 = maxShortSide，否则原样返回）
 * @param {string} dataUrl 图片 dataURL（须 base64 形态；非图片/非 base64 原样返回）
 * @param {number} maxShortSide 短边上限（像素，当前调用方传 1280）
 * @returns {Promise<{dataUrl: string, scaled: boolean, width: number, height: number,
 *   origWidth: number, origHeight: number, bytes: number, origBytes: number, error?: string}>}
 *   dataUrl 为缩放后（或原样）的 dataURL；bytes/origBytes 为近似字节（base64 解码后计）；
 *   失败时 scaled=false 且带 error，dataUrl=输入原值。
 */
export async function downscaleImageDataUrl(dataUrl, maxShortSide) {
  const failed = (error) => ({
    dataUrl, scaled: false, width: 0, height: 0, origWidth: 0, origHeight: 0,
    bytes: 0, origBytes: 0, error
  });
  try {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      return failed('not a dataURL');
    }
    const comma = dataUrl.indexOf(',');
    if (comma < 0 || !dataUrl.slice(0, comma).includes(';base64')) {
      return failed('not base64 dataURL');
    }
    const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
    const b64 = dataUrl.slice(comma + 1);
    const origBytes = Math.floor(b64.length * 3 / 4);
    // 解码 → Blob → createImageBitmap 取原始尺寸（SW/页面均可用，零网络零 CSP）
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([u8], { type: mime || 'image/png' }));
    const origW = bitmap.width;
    const origH = bitmap.height;
    const short = Math.min(origW, origH);
    if (short <= 0 || !isFinite(short)) {
      bitmap.close();
      return failed('invalid image dimensions');
    }
    if (short <= maxShortSide) {
      // 短边未超限：原样返回（尺寸信息照报，调用方可日志对账）
      const r = {
        dataUrl, scaled: false, width: origW, height: origH,
        origWidth: origW, origHeight: origH, bytes: origBytes, origBytes
      };
      bitmap.close();
      return r;
    }
    const scale = maxShortSide / short;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    // 画布：有 DOM 用普通 canvas（toBlob），无 DOM（SW）用 OffscreenCanvas（convertToBlob）
    let outBlob;
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      outBlob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
          outMime(mime), 0.92);
      });
    } else {
      if (typeof OffscreenCanvas === 'undefined') return failed('no canvas available');
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      outBlob = await canvas.convertToBlob({ type: outMime(mime), quality: 0.92 });
    }
    const outBuf = new Uint8Array(await outBlob.arrayBuffer());
    // 分块 btoa：整串 String.fromCharCode 大图会 "Maximum call stack size exceeded"
    const CHUNK = 0x8000;
    const parts = [];
    for (let i = 0; i < outBuf.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, outBuf.subarray(i, i + CHUNK)));
    }
    const outDataUrl = 'data:' + outMime(mime) + ';base64,' + btoa(parts.join(''));
    return {
      dataUrl: outDataUrl, scaled: true, width: w, height: h,
      origWidth: origW, origHeight: origH,
      bytes: outBuf.length, origBytes
    };
  } catch (e) {
    return failed(String((e && e.message) || e));
  }
}

// 输出格式：jpeg/webp 保留原格式（有损重压 0.92 可控），其余（png/gif/bmp）统一 PNG
// （截图/文本类图 PNG 无损利于 OCR；gif/bmp 编码器不保证支持，回 PNG 最稳）
function outMime(mime) {
  return (mime === 'image/jpeg' || mime === 'image/webp') ? mime : 'image/png';
}
