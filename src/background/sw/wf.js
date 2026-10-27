// =============================================================================
// SW 词频数据（VocabFreq）
// 职责：多源中转拉取（每源 files.json bytes+SHA-256 自校验）、meta.json 词数基准、
//   在途去重 + 30s 结果缓存、7天 alarms 源更新轮询（checkWfUpdates）。
// 白名单：文件名限 data/small_xx(yy).msgpack.gz（VocabFreq 111 语，扩展暴露 110 语），
//   防借道 SSRF。
// 源沿革（2026-10-26）：vocabradar/wordfreq（42 语，wordfreq 3.0.2 派生，600 cB 桶）→
//   vocabradar/VocabFreq（自建管线 FineWeb2-HQ+/UltraFineWeb-L3/Wikipedia，111 语，
//   700 cB 桶，header 多 lang/sources 字段）。文件布局/cBpack 编码/files.json 结构
//   不变，解码端（word-loader.js）零改动；meta.json 仅 generatedAt→generated_at
//   （本文件未用该字段），languages[<码>].kept 词数基准仍在。
// 源链（2026-10-27 用户裁定"数据源双路，首先hf[mirror]，其次登录后可以从网站拉取
//   更多" + "哪个源出来的用哪个源的校验"）：镜像 → 站点（登录才启用）→ HF 直连。
//   **源自洽**：files.json 清单 / meta.json 词数基准 / 数据文件 / 校验全部取自
//   同一源——文件与其清单同源比对，站点清单可含 HF 没有的文件（"更多"的载体），
//   更新对账亦按安装来源（wfInstalled[lang].src）回同源清单比对。契约见
//   docs/桥接网站.md §九。
// =============================================================================
import { _ts, log } from './log.js';
import { abToB64, fetchWithTimeout } from './util.js';
// 站点登录源（词频第三路，用户裁定 2026-10-27）：token 与站点判定单一属主 auth.js，
//   未连接账号返回 null 即跳过该源；auth.js 无反向依赖，无环。
import { getValidAccessToken, siteUrl } from './auth.js';

// === 词频数据多源中转 ===
// 背景：VocabFreq 111 语 small_*.msgpack.gz 不随包，word-loader.js loadWordfreq 经本
//   消息请求，SW 代理 fetch（host_permissions <all_urls>，不受页面 CSP 限制）并直传
//   ArrayBuffer（base64 分块编码回传，abToB64）。
// 安全：文件名白名单——语言码均 2-3 位小写字母，正则限 data/small_xx(yy).msgpack.gz；
//   域限 hf-mirror.com / huggingface.co / 站点鉴权端点（siteUrl）。即使宿主页面伪造
//   消息，也只能拉到该数据集公开清单内的文件（防借道 SSRF）。
// 校验（用户批复"files.json SHA-256 校验"）：SW 恒为 secure context——http 页面的
//   content script 无 crypto.subtle，故 SHA-256 在 SW 端做：按源拉清单 → 找 entry →
//   bytes + sha256 双比对，不匹配即弃包试下一源，杜绝截断/篡改包入词典。
const WF_BASE = 'datasets/vocabradar/VocabFreq/resolve/main/';
// 正则加捕获组提取语言码——handleWfFetch 拿它查 meta.json 的
//   languages[lang].kept 词数基准（用户裁定：词数基准从远程 meta 拉取，扩展不写死）。
const WF_FILE_RE = /^data\/small_([a-z]{2,3})\.msgpack\.gz$/;
// 源链（用户裁定 2026-10-27"首先hf[mirror]" + "其次登录后可以从网站拉取更多"）：
//   ①hf-mirror（匿名主源，国内可达稳定；huggingface.co 直连常不可达——实测 HTTP 000
//   超时——殿后）②站点登录源（仅已连接账号启用）③HF 直连。
//   站点源（src.site）按登录态惰性求值——镜像命中时零鉴权开销；端点未部署
//   （404/SPA HTML）或未登录均静默落下一源，如实日志不熔断。
const WF_MIRROR_BASE = 'https://hf-mirror.com/' + WF_BASE;
const WF_HF_BASE = 'https://huggingface.co/' + WF_BASE;
const WF_FILE_SOURCES = [
  { key: 'mirror', base: WF_MIRROR_BASE },
  { key: 'site', site: true },
  { key: 'hf', base: WF_HF_BASE },
];
// 站点登录源端点（契约 docs/桥接网站.md §九）：GET {site}/api/data/dict/v1/freq/{path}，
//   path ∈ {files.json, meta.json, data/small_xx.msgpack.gz}（HF 数据集相对路径直映，
//   站点为完整数据集镜像、可含 HF 没有的文件），Bearer=Supabase access_token
//   （对齐方案 L1"登录即可不扣分"）。
const WF_SITE_API = '/api/data/dict/v1/freq/';

// === files.json / meta.json 逐源缓存 ===
// 源自洽（用户裁定 2026-10-27"哪个源出来的用哪个源的校验"）：清单与文件同源，
//   缓存按源 key 分桶（失败删键允许下次重试；成功 promise 常驻——清单是数据集级
//   元数据，会话内复用）。
const _wfFilesCache = new Map(); // srcKey -> Promise<manifest|null>
const _wfMetaCache = new Map();  // srcKey -> Promise<meta|null>

function getWfFilesJsonFor(src, base, init) {
  let p = _wfFilesCache.get(src.key);
  if (!p) {
    p = (async () => {
      try {
        // 黑洞防护（与 lemmas-engine 同类）：fetch 无 signal 时源网络挂起会拖死
        //   整条词频装载链，改用带超时 fetch（小 json 10s 足够）。
        const res = await fetchWithTimeout(base + 'files.json',
          Object.assign({ credentials: 'omit', cache: 'no-store' }, init), 10000);
        if (!res.ok) return null;
        const j = await res.json();
        return (j && Array.isArray(j.files) && j.files.length) ? j : null;
      } catch (_) { return null; }
    })().then((j) => {
      if (!j) _wfFilesCache.delete(src.key); // 失败不缓存，允许下次重试
      return j;
    });
    _wfFilesCache.set(src.key, p);
  }
  return p;
}

// meta.json 词数基准（用户裁定："从远程的meta拉取的词数才是正确的，
//   校验词数和sha256不都是一下子，先校验sha256算文件，再读取后校验词数"）。
//   meta.json 在数据集根（不在 files.json 清单内），结构（VocabFreq v7 起）
//   { dataset, version, generated_at, selection, sources_note,
//     languages: { <lang>: { kept, coverage, sources, text_bytes, tokens_total } } }，
//   kept = 入表词数（随库演进，不写死校验）。逐源拉取+失败不缓存，
//   与 getWfFilesJsonFor 同款模式；**与文件同源**（源自洽）。
function getWfMetaFor(src, base, init) {
  let p = _wfMetaCache.get(src.key);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetchWithTimeout(base + 'meta.json',
          Object.assign({ credentials: 'omit', cache: 'no-store' }, init), 10000);
        if (!res.ok) return null;
        const j = await res.json();
        return (j && j.languages && typeof j.languages === 'object') ? j : null;
      } catch (_) { return null; }
    })().then((j) => {
      if (!j) _wfMetaCache.delete(src.key); // 失败不缓存，允许下次重试
      return j;
    });
    _wfMetaCache.set(src.key, p);
  }
  return p;
}

// 同一页多个内容脚本上下文（text-hint/侧栏各自冷装词典）或同一上下文竞态下，多个
//   WF_FETCH 消息会并发打进 handleWfFetch 各拉一遍网络。按文件在途 Promise 去重
//   （并发请求共享同一次网络拉取）+ 30s 结果缓存（冷装完成后短时重拉直接命中缓存）。
const _wfFetchInFlight = new Map();   // file -> Promise<result>
const _wfFetchCache = new Map();      // file -> {ts, result}
const WF_FETCH_CACHE_TTL_MS = 30000;  // 30s 结果缓存（小包 base64 数十~百 KB 级，可接受）

export function wfFetchMemoized(file) {
  const hit = _wfFetchCache.get(file);
  if (hit && Date.now() - hit.ts < WF_FETCH_CACHE_TTL_MS) return Promise.resolve(hit.result);
  let p = _wfFetchInFlight.get(file);
  if (!p) {
    p = handleWfFetch(file).then(
      (result) => {
        _wfFetchInFlight.delete(file);
        if (result && result.ok) _wfFetchCache.set(file, { ts: Date.now(), result });
        return result;
      },
      (e) => {
        _wfFetchInFlight.delete(file);
        return { ok: false, error: String((e && e.message) || e) };
      }
    );
    _wfFetchInFlight.set(file, p);
  }
  return p;
}

async function handleWfFetch(file) {
  try {
    if (typeof file !== 'string' || !WF_FILE_RE.test(file)) {
      return { ok: false, error: 'wfFetch: non-whitelisted wordfreq file: ' + file };
    }
    const srcErrs = []; // 逐源失败原因收集（用户裁定：失败要说清哪个链接连不上）
    for (const src of WF_FILE_SOURCES) {
      // 站点登录源惰性求值：未连接账号（getValidAccessToken 返回 null）静默跳过，
      //   匿名双源足够；token 临期满 30s 才触网络（auth.js 续签单一属主）。
      let base;
      let init = { credentials: 'omit' };
      if (src.site) {
        const token = await getValidAccessToken().catch(() => null);
        if (!token) continue;
        base = siteUrl() + WF_SITE_API;
        init.headers = { Authorization: 'Bearer ' + token };
      } else {
        base = src.base;
      }
      try {
        // 源自洽（用户裁定"哪个源出来的用哪个源的校验"）：清单/文件/校验/词数基准
        //   全取同一源——本源清单查不到该文件（站点未发布或 HF 未收录）即落下一源，
        //   不跨源凑对。清单带 10s 超时防源挂起拖死装载链。
        const manifest = await getWfFilesJsonFor(src, base, init);
        if (!manifest) {
          srcErrs.push(base + 'files.json -> unavailable');
          continue;
        }
        const entry = manifest.files.find((f) => f.file === file);
        if (!entry || !entry.sha256) {
          srcErrs.push(base + ' -> no entry in files.json: ' + file);
          continue;
        }
        // 词频主文件（数十~百 KB gzip）fetch 无 signal 在源挂起时永不失败，页面端
        //   只能干等——带超时 15s（逐源最坏 15s 后必有结果，错误沿 srcErrs 上报）。
        const res = await fetchWithTimeout(base + file, init, 15000);
        if (!res.ok) {
          log('[VocabRadar][sw][' + _ts() + '] wfFetch HTTP ' + res.status + ': ' + base + file);
          srcErrs.push(base + file + ' -> HTTP ' + res.status);
          continue;
        }
        const buf = await res.arrayBuffer();
        if (!buf || buf.byteLength === 0) {
          log('[VocabRadar][sw][' + _ts() + '] wfFetch 空响应: ' + base + file);
          srcErrs.push(base + file + ' -> empty response');
          continue;
        }
        if (entry.bytes && buf.byteLength !== entry.bytes) {
          log('[VocabRadar][sw][' + _ts() + '] wfFetch ' + base + file + ' bytes 不符 ' + buf.byteLength + '≠' + entry.bytes + '，弃包');
          srcErrs.push(base + file + ' -> bytes mismatch ' + buf.byteLength + '≠' + entry.bytes);
          continue;
        }
        // SHA-256 校验（SW 恒 secure context，crypto.subtle 可用）——与同源清单比对：
        //   镜像/HF 锚定上游 VocabFreq 发布，站点源锚定站点自己的清单（站点被篡改/
        //   回退版本进不了词典；站点发布 HF 没有的新文件亦按其清单正常通过）。
        const digest = await crypto.subtle.digest('SHA-256', buf);
        const hex = Array.prototype.map.call(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
        if (hex !== String(entry.sha256).toLowerCase()) {
          log('[VocabRadar][sw][' + _ts() + '] wfFetch ' + base + file + ' sha256 不符，弃包');
          srcErrs.push(base + file + ' -> sha256 mismatch');
          continue;
        }
        // 必须 base64 分块编码回传（abToB64）：chrome.runtime 消息默认 JSON 序列化，
        //   ArrayBuffer 直传变空对象 {}；页面端 word-loader.js b64ToU8 解码。
        log('[VocabRadar][sw][' + _ts() + '] wfFetch ' + file + ' ← ' + base.slice(8, 34) + ' ' + (buf.byteLength / 1024).toFixed(1) + 'KB（sha256 校验通过，源 ' + src.key + '）');
        // sha256/bytes/src 随返回值回传：调用方（word-loader.js loadWordfreq）成功后写入
        //   storage.wfInstalled[lang]（含安装来源 src），作为 checkWfUpdates 逐源对账
        //   的基线（用户裁定"哪个源出来的用哪个源的校验"）。
        // 顺手取**同源** meta.json 的 kept 词数基准一并回传（用户裁定："校验词数和
        //   sha256 不都是一下子"）——sha256 验文件在此，词数比对在页面端解码后做。
        //   meta 不可得只告警不阻塞（sha256 已保文件完整性），kept 不匹配才由页面端弃包。
        let kept;
        const langM = WF_FILE_RE.exec(file);
        if (langM && langM[1]) {
          const meta = await getWfMetaFor(src, base, init);
          const rec = meta && meta.languages && meta.languages[langM[1]];
          if (rec && Number.isFinite(rec.kept)) {
            kept = rec.kept;
          } else {
            log('[VocabRadar][sw][' + _ts() + '] wfFetch ' + file + ' 同源 meta.json 词数基准不可得，词数校验本次跳过');
          }
        }
        return { ok: true, b64: abToB64(buf), sha256: hex, bytes: buf.byteLength, kept, src: src.key };
      } catch (e) { srcErrs.push(base + file + ' -> ' + String((e && e.message) || e)); }
    }
    return { ok: false, error: 'wfFetch all sources failed: ' + srcErrs.join(' | ') };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// === wordfreq 源更新轮询（用户批复"主动轮询 files.json 检测更新并自动重建，以后
//   可能支持语言更多"）===
// 机制：chrome.alarms 每 7天（onInstalled/onStartup 创建；onStartup 另行兜底先跑一次；
//   用户裁定 24h→7天"万一有错能补救"）
//   触发 checkWfUpdates：逐语言按**安装来源**（wfInstalled[lang].src，本版起随装载
//   写入；旧基线无该字段按镜像对账——主源口径，一轮重建后即带 src）取同源
//   files.json 比对 sha256，差异写 storage.wfUpdates[lang]。页面侧 projection.js
//   _loadDict 入口（60s 内存节流）检查 wfUpdates → clearByLang 清库 + 失效单例 →
//   正常重建路径自然重拉新数据。
//   跨源比对被有意避免：站点与 HF 清单各自演进（站点可发布"更多"文件），拿 A 源
//   清单查 B 源基线会假报更新。来源清单不可得（站点未登录/网络失败/清单下架）→
//   该语本轮跳过不动基线，如实日志。
//   新增语言无需改此处：轮询按 wfInstalled 实际键遍历，file 名由 WF_FILE_RE 白名单
//   通配（data/small_xx(yy).msgpack.gz），自动覆盖未来语言。
// alarm 创建不放 SW 模块顶层——每次消息唤醒顶层重跑会同名重置计时，alarm 永远
//   不触发；只放 onInstalled/onStartup（浏览器级时机）。
export const WF_UPDATE_ALARM = 'wf-update-check';

export async function checkWfUpdates() {
  try {
    const { wfInstalled = {} } = await chrome.storage.local.get('wfInstalled');
    const langs = Object.keys(wfInstalled);
    if (!langs.length) return; // 尚无已装语言基线，无事可做
    const updates = {};
    for (const lang of langs) {
      const base = wfInstalled[lang];
      const src = WF_FILE_SOURCES.find((s) => s.key === (base.src || 'mirror'));
      if (!src) continue; // 基线来源异常（不应发生）→ 不动基线
      // 站点来源基线需登录态对账：未登录本轮跳过（站点清单取不到，跨源比对会假报）
      let sourceBase = src.base;
      let init = { credentials: 'omit' };
      if (src.site) {
        const token = await getValidAccessToken().catch(() => null);
        if (!token) {
          log('[VocabRadar][sw][' + _ts() + '] checkWfUpdates: ' + lang + ' 安装自站点源但当前未登录，本轮跳过');
          continue;
        }
        sourceBase = siteUrl() + WF_SITE_API;
        init.headers = { Authorization: 'Bearer ' + token };
      }
      const manifest = await getWfFilesJsonFor(src, sourceBase, init);
      if (!manifest || !Array.isArray(manifest.files)) {
        log('[VocabRadar][sw][' + _ts() + '] checkWfUpdates: ' + src.key + ' files.json 不可用，' + lang + ' 本轮跳过');
        continue;
      }
      const entry = manifest.files.find((f) => f.file === 'data/small_' + lang + '.msgpack.gz');
      if (!entry || !entry.sha256) continue; // 清单无该语言（未发布/已下架）→ 不动基线
      if (String(entry.sha256).toLowerCase() !== String(base.sha256 || '').toLowerCase()) {
        updates[lang] = { sha256: entry.sha256, bytes: entry.bytes || 0, detectedAt: Date.now() };
        log('[VocabRadar][sw][' + _ts() + '] checkWfUpdates: ' + lang + ' 源有更新（' + String(base.sha256 || '').slice(0, 8) + '… → ' + String(entry.sha256).slice(0, 8) + '…，源 ' + src.key + '）');
      }
    }
    if (!Object.keys(updates).length) {
      log('[VocabRadar][sw][' + _ts() + '] checkWfUpdates: ' + langs.length + ' 语全部无更新');
      return;
    }
    const { wfUpdates = {} } = await chrome.storage.local.get('wfUpdates');
    await chrome.storage.local.set({ wfUpdates: Object.assign({}, wfUpdates, updates) });
  } catch (e) {
    console.error('[VocabRadar][sw][' + _ts() + '] checkWfUpdates 异常:', e);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WF_UPDATE_ALARM) {
    log('[VocabRadar][sw][' + _ts() + '] 定时器触发 checkWfUpdates');
    checkWfUpdates();
  }
});
