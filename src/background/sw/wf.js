// =============================================================================
// SW wordfreq 词频数据
// 职责：HF dataset 中转拉取（带 files.json bytes+SHA-256 校验）、meta.json 词数基准、
//   在途去重 + 30s 结果缓存、7天 alarms 源更新轮询（checkWfUpdates）。
// 白名单：文件名限 data/small_xx(yy).msgpack.gz（42 语），域限两源（防借道 SSRF）。
// =============================================================================
import { _ts, log } from './log.js';
import { abToB64, fetchWithTimeout } from './util.js';

// === wordfreq 词频数据 HF dataset 中转 ===
// 背景：42 语 small_*.msgpack.gz 不随包，word-loader.js loadWordfreq 经本消息请求，
//   SW 代理 fetch（host_permissions <all_urls>，不受页面 CSP 限制）并直传
//   ArrayBuffer（base64 分块编码回传，abToB64）。
// 安全：文件名白名单——42 语语言码均 2-3 位小写字母，正则限 data/small_xx(yy).msgpack.gz；
//   域限 huggingface.co / hf-mirror.com 两源。即使宿主页面伪造消息，也只能拉到
//   这 42 个公开数据文件（防借道 SSRF）。
// 校验（用户批复"files.json SHA-256 校验"）：SW 恒为 secure context——http 页面的
//   content script 无 crypto.subtle，故 SHA-256 在 SW 端做：逐源拉 files.json →
//   找 entry → bytes + sha256 双比对，不匹配即弃包试下一源，杜绝截断/篡改包入词典。
const WF_BASE = 'datasets/vocabradar/wordfreq/resolve/main/';
// 正则加捕获组提取语言码——handleWfFetch 拿它查 meta.json 的
//   languages[lang].kept 词数基准（用户裁定：词数基准从远程 meta 拉取，扩展不写死）。
const WF_FILE_RE = /^data\/small_([a-z]{2,3})\.msgpack\.gz$/;
const WF_SOURCES = ['https://huggingface.co/' + WF_BASE, 'https://hf-mirror.com/' + WF_BASE];
let _wfFilesCache = null; // files.json promise 缓存（失败置空允许下次重试）

function getWfFilesJson() {
  if (!_wfFilesCache) {
    _wfFilesCache = (async () => {
      for (const base of WF_SOURCES) {
        try {
          // 黑洞防护（与 lemmas-engine 同类）：fetch 无 signal 时 hf 源网络
          //   挂起会拖死整条词频装载链，改用带超时 fetch（小 json 10s 足够）。
          const res = await fetchWithTimeout(base + 'files.json', { credentials: 'omit', cache: 'no-store' }, 10000);
          if (!res.ok) continue;
          const j = await res.json();
          if (j && Array.isArray(j.files) && j.files.length) return j;
        } catch (_) { /* 该源异常，试下一源 */ }
      }
      return null;
    })().then((j) => {
      if (!j) _wfFilesCache = null; // 失败不缓存，允许下次重试
      return j;
    });
  }
  return _wfFilesCache;
}

// meta.json 词数基准（用户裁定："从远程的meta拉取的词数才是正确的，
//   校验词数和sha256不都是一下子，先校验sha256算文件，再读取后校验词数"）。
//   meta.json 在 HF 数据集根（不在 files.json 清单内），结构
//   { version, generatedAt, languages: { <lang>: { total, removed, kept } } }，
//   kept = clean 过滤后词数（en=28811，与本地解码实测一致）。双源拉取+失败不缓存，
//   与 getWfFilesJson 同款模式。
let _wfMetaCache = null;

function getWfMeta() {
  if (!_wfMetaCache) {
    _wfMetaCache = (async () => {
      for (const base of WF_SOURCES) {
        try {
          // 同 files.json，带超时防源挂起拖死 meta 装载（小 json 10s 足够）。
          const res = await fetchWithTimeout(base + 'meta.json', { credentials: 'omit', cache: 'no-store' }, 10000);
          if (!res.ok) continue;
          const j = await res.json();
          if (j && j.languages && typeof j.languages === 'object') return j;
        } catch (_) { /* 该源异常，试下一源 */ }
      }
      return null;
    })().then((j) => {
      if (!j) _wfMetaCache = null; // 失败不缓存，允许下次重试
      return j;
    });
  }
  return _wfMetaCache;
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
      return { ok: false, error: 'wfFetch: 非白名单词频文件: ' + file };
    }
    const manifest = await getWfFilesJson();
    if (!manifest) return { ok: false, error: 'wfFetch: files.json 全源失败: ' + WF_SOURCES.map((b) => b + 'files.json').join(' | ') };
    const entry = manifest.files.find((f) => f.file === file);
    if (!entry || !entry.sha256) return { ok: false, error: 'wfFetch: files.json 无记录: ' + file };
    const srcErrs = []; // 逐源失败原因收集（用户裁定：失败要说清哪个链接连不上）
    for (const base of WF_SOURCES) {
      try {
        // 词频主文件（数十~百 KB gzip）fetch 无 signal 在源挂起时永不失败，页面端
        //   只能干等——带超时 15s（两源最坏 30s 后必有结果，错误沿 srcErrs 上报）。
        const res = await fetchWithTimeout(base + file, { credentials: 'omit' }, 15000);
        if (!res.ok) {
          log('[VocabRadar][sw][' + _ts() + '] wfFetch HTTP ' + res.status + ': ' + base + file);
          srcErrs.push(base + file + ' -> HTTP ' + res.status);
          continue;
        }
        const buf = await res.arrayBuffer();
        if (!buf || buf.byteLength === 0) {
          log('[VocabRadar][sw][' + _ts() + '] wfFetch 空响应: ' + base + file);
          srcErrs.push(base + file + ' -> 空响应');
          continue;
        }
        if (entry.bytes && buf.byteLength !== entry.bytes) {
          log('[VocabRadar][sw][' + _ts() + '] wfFetch ' + base + file + ' bytes 不符 ' + buf.byteLength + '≠' + entry.bytes + '，弃包');
          srcErrs.push(base + file + ' -> bytes 不符 ' + buf.byteLength + '≠' + entry.bytes);
          continue;
        }
        // SHA-256 校验（SW 恒 secure context，crypto.subtle 可用）
        const digest = await crypto.subtle.digest('SHA-256', buf);
        const hex = Array.prototype.map.call(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
        if (hex !== String(entry.sha256).toLowerCase()) {
          log('[VocabRadar][sw][' + _ts() + '] wfFetch ' + base + file + ' sha256 不符，弃包');
          srcErrs.push(base + file + ' -> sha256 不符');
          continue;
        }
        // 必须 base64 分块编码回传（abToB64）：chrome.runtime 消息默认 JSON 序列化，
        //   ArrayBuffer 直传变空对象 {}；页面端 word-loader.js b64ToU8 解码。
        log('[VocabRadar][sw][' + _ts() + '] wfFetch ' + file + ' ← ' + base.slice(8, 24) + ' ' + (buf.byteLength / 1024).toFixed(1) + 'KB（sha256 校验通过）');
        // sha256/bytes 随返回值回传：调用方（word-loader.js loadWordfreq）成功后写入
        //   storage.wfInstalled[lang]，作为 HF files.json 轮询比对（checkWfUpdates）的基线
        // 顺手取 meta.json 的 kept 词数基准一并回传（用户裁定："校验词数和sha256不都
        //   是一下子"）——sha256 验文件在此，词数比对在页面端解码后做。
        //   meta 不可得只告警不阻塞（sha256 已保文件完整性），kept 不匹配才由页面端弃包。
        let kept;
        const langM = WF_FILE_RE.exec(file);
        if (langM && langM[1]) {
          const meta = await getWfMeta();
          const rec = meta && meta.languages && meta.languages[langM[1]];
          if (rec && Number.isFinite(rec.kept)) {
            kept = rec.kept;
          } else {
            log('[VocabRadar][sw][' + _ts() + '] wfFetch ' + file + ' meta.json 词数基准不可得，词数校验本次跳过');
          }
        }
        return { ok: true, b64: abToB64(buf), sha256: hex, bytes: buf.byteLength, kept };
      } catch (e) { srcErrs.push(base + file + ' -> ' + String((e && e.message) || e)); }
    }
    return { ok: false, error: 'wfFetch 全源失败: ' + srcErrs.join(' | ') };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// === wordfreq 源更新轮询（用户批复"主动轮询 files.json 检测更新并自动重建，以后
//   可能支持语言更多"）===
// 机制：chrome.alarms 每 7天（onInstalled/onStartup 创建；onStartup 另行兜底先跑一次；
//   用户裁定 24h→7天"万一有错能补救"）
//   触发 checkWfUpdates：逐语言比对 storage.wfInstalled[lang].sha256（本机已装基线，
//   由 word-loader.js loadWordfreq 成功后写入）与 HF files.json 的 sha256，差异写
//   storage.wfUpdates[lang]。页面侧 projection.js _loadDict 入口（60s 内存节流）检查
//   wfUpdates → clearByLang 清库 + 失效单例 → 正常重建路径自然重拉新数据。
//   无 wfInstalled 记录（未装过的语言）跳过——新语言首装走正常缺失重建路径。
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
    const manifest = await getWfFilesJson();
    if (!manifest || !Array.isArray(manifest.files)) {
      log('[VocabRadar][sw][' + _ts() + '] checkWfUpdates: files.json 不可用，本次跳过');
      return;
    }
    const updates = {};
    for (const lang of langs) {
      const base = wfInstalled[lang];
      const entry = manifest.files.find((f) => f.file === 'data/small_' + lang + '.msgpack.gz');
      if (!entry || !entry.sha256) continue; // files.json 无该语言（未发布/已下架）→ 不动基线
      if (String(entry.sha256).toLowerCase() !== String(base.sha256 || '').toLowerCase()) {
        updates[lang] = { sha256: entry.sha256, bytes: entry.bytes || 0, detectedAt: Date.now() };
        log('[VocabRadar][sw][' + _ts() + '] checkWfUpdates: ' + lang + ' 源有更新（' + String(base.sha256 || '').slice(0, 8) + '… → ' + String(entry.sha256).slice(0, 8) + '…）');
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
