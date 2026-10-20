// =============================================================================
// HF 数据集文件中转原语（第561次，src/lib/word-db/hf-file.js）
// 职责：vocabradar/WordTranslation / vocabradar/WordEmbedding 两个 HF 数据集的
//   文件拉取（files.json bytes+SHA-256 校验、双源回退），返回 ArrayBuffer——
//   仅 SW 侧引擎消费（翻译包解码回填 d_trans、向量包落 rawfiles），不过消息
//   通道，无需 base64。
// 模式与 background/sw/wf.js（wordfreq 词频拉取）同款；wf.js 服务页面侧装载链
//   （base64 回传、meta 词数基准），本文件服务 SW 侧引擎——互不复用，以免牵动
//   词频敏感链路（用户裁定 wf 轮询/校验语义保持原样）。
// 白名单：文件名逐数据集正则限定，域限 huggingface.co / hf-mirror.com 两源（防借道）。
// =============================================================================

// 两数据集 resolve 根与文件名白名单
// WordTranslation：data/<src>_<dst>.jsonl.gz（162 包，语言码 2-3 位小写字母）
// WordEmbedding：data/<lang>.words.txt + data/<lang>.int8.vector（42 语 84 文件）
export const WT_BASE = 'datasets/vocabradar/WordTranslation/resolve/main/';
export const EMB_BASE = 'datasets/vocabradar/WordEmbedding/resolve/main/';
export const WT_FILE_RE = /^data\/([a-z]{2,3})_([a-z]{2,3})\.jsonl\.gz$/;
export const EMB_FILE_RE = /^data\/([a-z]{2,3})\.(words\.txt|int8\.vector)$/;

const HF_HOSTS = ['https://huggingface.co/', 'https://hf-mirror.com/'];

/** 带超时 fetch（AbortController；与 sw/util.js fetchWithTimeout 同款内联，避免跨层依赖） */
async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    // 必须 await 后再 clearTimeout：同步 try/finally 会在 fetch 尚未完成时清掉计时器，
    //   超时永不触发（源挂起即拖死引擎链路）。与 sw/util.js 的 await 写法保持一致。
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function _ts() {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// files.json 清单缓存（每数据集一份；失败不缓存允许重试——wf.getWfFilesJson 同语义）
const _filesJsonCache = new Map(); // base -> Promise<manifest|null>

function getFilesJson(base) {
  if (!_filesJsonCache.has(base)) {
    const p = (async () => {
      for (const host of HF_HOSTS) {
        try {
          // 带超时（小 json 10s 足够）——防源挂起拖死引擎链路（wf.js 同款黑洞防护）
          const res = await fetchWithTimeout(host + base + 'files.json', { credentials: 'omit', cache: 'no-store' }, 10000);
          if (!res.ok) continue;
          const j = await res.json();
          if (j && Array.isArray(j.files) && j.files.length) return j;
        } catch (_) { /* 该源异常，试下一源 */ }
      }
      return null;
    })().then((j) => {
      if (!j) _filesJsonCache.delete(base); // 失败不缓存，允许下次重试
      return j;
    });
    _filesJsonCache.set(base, p);
  }
  return _filesJsonCache.get(base);
}

/**
 * 拉取数据集文件（files.json bytes+SHA-256 双校验 + 双源回退）
 * @param {string} base 数据集 resolve 根（WT_BASE / EMB_BASE）
 * @param {RegExp} fileRe 文件名白名单
 * @param {string} file 相对路径（如 data/en_zh.jsonl.gz）
 * @param {number} [timeoutMs] 单源 fetch 超时（默认 60s：向量包 10-24MB 弱网偏慢）
 * @returns {Promise<{ok:true,buf:ArrayBuffer,sha256:string,bytes:number}|{ok:false,error:string}>}
 */
export async function fetchDatasetFile(base, fileRe, file, timeoutMs = 60000) {
  try {
    if (typeof file !== 'string' || !fileRe.test(file)) {
      return { ok: false, error: 'hfFetch: non-whitelisted dataset file: ' + file };
    }
    const manifest = await getFilesJson(base);
    if (!manifest) return { ok: false, error: 'hfFetch: files.json failed on all sources (' + base + 'files.json)' };
    const entry = manifest.files.find((f) => f.file === file);
    if (!entry || !entry.sha256) return { ok: false, error: 'hfFetch: no entry in files.json: ' + file };
    const srcErrs = []; // 逐源失败原因收集（失败要说清哪个链接连不上）
    for (const host of HF_HOSTS) {
      try {
        const res = await fetchWithTimeout(host + base + file, { credentials: 'omit' }, timeoutMs);
        if (!res.ok) { srcErrs.push(host + base + file + ' -> HTTP ' + res.status); continue; }
        const buf = await res.arrayBuffer();
        if (!buf || buf.byteLength === 0) { srcErrs.push(host + base + file + ' -> empty response'); continue; }
        if (entry.bytes && buf.byteLength !== entry.bytes) {
          srcErrs.push(host + base + file + ' -> bytes mismatch ' + buf.byteLength + '≠' + entry.bytes);
          continue;
        }
        // SHA-256 校验（SW 恒 secure context，crypto.subtle 可用）
        const digest = await crypto.subtle.digest('SHA-256', buf);
        const hex = Array.prototype.map.call(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
        if (hex !== String(entry.sha256).toLowerCase()) {
          srcErrs.push(host + base + file + ' -> sha256 mismatch');
          continue;
        }
        console.log('[VocabRadar][word-db][' + _ts() + '] hfFetch ' + file + ' ← ' + host.slice(8, 24) + ' ' + (buf.byteLength / 1024).toFixed(1) + 'KB（sha256 校验通过）');
        return { ok: true, buf, sha256: hex, bytes: buf.byteLength };
      } catch (e) {
        srcErrs.push(host + base + file + ' -> ' + String((e && e.message) || e));
      }
    }
    return { ok: false, error: 'hfFetch all sources failed: ' + srcErrs.join(' | ') };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 30 天过期对账：比对 files.json 中该文件当前 sha256 与本机基线。
 * @param {string} base 数据集 resolve 根
 * @param {RegExp} fileRe 文件名白名单
 * @param {string} file 相对路径
 * @param {string} baselineSha 本机已存记录的 sha256
 * @returns {Promise<{ok:boolean, changed?:boolean, sha256?:string, bytes?:number, error?:string}>}
 *   ok=false 对账失败（网络等）——调用方保守起见保留旧包不续期（下轮再对账）；
 *   ok=true changed=false 基线未变（仅续期时间戳）；changed=true 须重新 fetchDatasetFile。
 */
export async function verifyDatasetFile(base, fileRe, file, baselineSha) {
  try {
    if (typeof file !== 'string' || !fileRe.test(file)) return { ok: false, error: 'non-whitelisted: ' + file };
    const manifest = await getFilesJson(base);
    if (!manifest) return { ok: false, error: 'files.json failed on all sources (' + base + 'files.json)' };
    const entry = manifest.files.find((f) => f.file === file);
    if (!entry || !entry.sha256) return { ok: false, error: 'no entry in files.json: ' + file };
    const sha = String(entry.sha256).toLowerCase();
    return { ok: true, changed: sha !== String(baselineSha || '').toLowerCase(), sha256: sha, bytes: entry.bytes || 0 };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
