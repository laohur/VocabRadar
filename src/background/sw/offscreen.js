// =============================================================================
// offscreen 宿主生命周期（2026-09-27 拆分自 service-worker.js）
// 职责：Chromium chrome.offscreen 文档 / Firefox 后台页内回退 iframe 二选一宿主，
//   加上 PING 就绪探针。OCR（EXTRACT_TEXT/PARSE_DOC/AUDIO_DECODE）三族消息共用。
// 唯一状态：_asrFallbackFrame（Firefox 回退 iframe 引用）只在本文件读写。
// =============================================================================
import { _ts, log } from './log.js';

// === ASR 宿主生命周期（offscreen document / Firefox 回退 iframe）===
// 第三百九十四次（plan 阶段二③，用户裁定「扩展不再保留这两个模型」）：whisper 会话
//   状态机（_asrActive/_asrTabId/persistAsrState/restoreAsrState/handleStartASR/
//   handleStopASR）随本地模型推理一并移除；仅保留宿主生命周期管理（OCR/EXTRACT_TEXT/
//   PARSE_DOC 三路共用）与 PING 就绪探针（waitOffscreenReady）。
// Firefox 回退（2026-08-15 第六十四次；2026-08-30 第一百八十次改宿主位置）：
//   Firefox 无 chrome.offscreen，offscreen.js 宿主运行于**后台 event page 自身 document** 内的
//   隐藏 iframe（旧版建在网页 DOM 里，被网页 CSP 拦，详见 ensureFallbackIframe）。
// 第二百二十五次：删除死变量 _asrFallbackMode（五处赋值、零读取，《命名清查》裁定）。
// 后台页内的 ASR 宿主 iframe 引用（仅 Firefox；Chromium 后台为 SW 无 DOM，恒为 null）
let _asrFallbackFrame = null;

/**
 * 第一百七十九次：轮询 OFFSCREEN_PING，等待宿主（offscreen.js）注册好消息监听器
 * @param {number} timeoutMs 总超时（毫秒）
 * @returns {Promise<boolean>} 就绪返回 true
 */
async function waitOffscreenReady(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  let tries = 0;
  while (Date.now() < deadline) {
    tries++;
    const r = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' }).catch(() => null);
    // 只认 offscreen.js 的应答签名（ready:true），避免其他扩展页监听器误认为就绪
    if (r && r.ok && r.ready === true) {
      log('[VocabRadar][sw][' + _ts() + '] ASR 宿主已就绪（PING 第 ' + tries + ' 次应答）');
      return true;
    }
    await new Promise((rs) => setTimeout(rs, 200));
  }
  console.warn('[VocabRadar][sw][' + _ts() + '] ASR 宿主 PING 超时，共尝试 ' + tries + ' 次');
  return false;
}

/**
 * Firefox 回退：在**后台页自身 document** 内创建隐藏 iframe（offscreen.html）承载 whisper
 *
 * 反思（2026-08-30 第一百八十次，用户报障"asr 重装后依旧：Firefox 回退 iframe 内的
 *   ASR 宿主未就绪（8 秒内无 PING 应答）"）：
 *   - 旧实现把隐藏 iframe 建在**网页 DOM**里（由 content script / 引导页创建）。
 *     Firefox 自 76 起对内容脚本发起的 DOM 加载施加**网页** CSP。实测报障页
 *     learn.microsoft.com 的响应头 CSP 为 `default-src *`（且无 frame-src），
 *     而 CSP 的 `*` 只匹配网络 scheme、**不匹配 moz-extension:** →
 *     `<iframe src="moz-extension://…/offscreen.html">` 直接被拦，offscreen.js
 *     从未运行，OFFSCREEN_PING 永无应答。web_accessible_resources 已含
 *     src/offscreen/*，故不是权限问题；offscreen.js 顶层无 import/无 top-level await、
 *     onMessage 注册很早，故也不是"监听器注册晚于 load"（第 179 次的判断有误，此处纠正）。
 *   - 且旧的页面侧创建函数无论 load 还是 4 秒超时都 resolve({ok:true})，
 *     把失败遮蔽成成功，SW 侧只能等到 PING 超时才报错，掩盖了真实错因。
 * 修正：Firefox MV3 的后台**不是** Service Worker，而是带 DOM 的 event page
 *   （scripts/build.mjs#patchManifestForFirefox 把 background.service_worker
 *   改写为 background.scripts），后台页自身适用**扩展** CSP（含 wasm-unsafe-eval），
 *   因此把隐藏 iframe 建在后台页自己的 document 内即可完全绕开网页 CSP，
 *   与 Chromium 的 offscreen document 等价，OFFSCREEN 与 ASR 两族消息协议零改动。
 * @returns {Promise<{ok:boolean, error?:string}>} 真实结果，失败即报错，不做假成功
 */
async function ensureFallbackIframe() {
  // Chromium 的后台是无 DOM 的 Service Worker；本函数仅在 chrome.offscreen 缺失
  // （即 Firefox event page）时调用，此处仅作真实诊断，不静默成功。
  if (typeof document === 'undefined' || !document.documentElement) {
    return { ok: false, error: '后台环境无 DOM（Service Worker），无法承载 ASR 回退 iframe' };
  }
  // 幂等：已存在且文档仍在则复用（event page 未被回收时模型缓存可复用）
  if (_asrFallbackFrame && _asrFallbackFrame.isConnected && _asrFallbackFrame.contentWindow) {
    log('[VocabRadar][sw][' + _ts() + '] Firefox 回退 iframe 复用（后台页内已存在）');
    return { ok: true };
  }
  try {
    const frame = document.createElement('iframe');
    frame.id = 'beaver-asr-host';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'display:none;width:0;height:0;border:0;';
    const loaded = new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      frame.addEventListener('load', () => done({ ok: true }), { once: true });
      frame.addEventListener('error', () => done({ ok: false, error: 'iframe load 事件报错' }), { once: true });
      // 超时不再假装成功：真实回报"未触发 load"
      setTimeout(() => done({ ok: false, error: '后台页内 iframe 10 秒内未触发 load' }), 10000);
    });
    frame.src = chrome.runtime.getURL('src/offscreen/offscreen.html');
    document.documentElement.appendChild(frame);
    _asrFallbackFrame = frame;
    const r = await loaded;
    if (!r.ok) {
      // 失败即拆除，避免残留的坏 iframe 被下次幂等分支复用（否则用户永远重试不好）
      try { frame.remove(); } catch (e2) { /* ignore */ }
      _asrFallbackFrame = null;
      console.warn('[VocabRadar][sw][' + _ts() + '] Firefox 回退 iframe 加载失败: ' + r.error);
      return r;
    }
    log('[VocabRadar][sw][' + _ts() + '] Firefox 回退 iframe 已在后台页内加载完成（offscreen.js 宿主）');
    return { ok: true };
  } catch (e) {
    const error = String((e && e.message) || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] Firefox 回退 iframe 创建异常: ' + error);
    return { ok: false, error };
  }
}

/**
 * 第一百八十次：回退 iframe 的运行时诊断快照（PING 超时时并入错误文案，
 * 便于区分"iframe 未加载"与"加载了但消息不通"两类失败，不再只给一句笼统超时）
 * @returns {string}
 */
function describeFallbackFrame() {
  if (typeof document === 'undefined') return '后台无 DOM';
  const f = _asrFallbackFrame;
  if (!f) return 'iframe 未创建';
  if (!f.isConnected) return 'iframe 已脱离后台页';
  let state = '未知';
  let href = '未知';
  try { state = (f.contentDocument && f.contentDocument.readyState) || '无 contentDocument'; } catch (e) { state = '跨源不可读'; }
  try { href = (f.contentWindow && f.contentWindow.location && f.contentWindow.location.href) || '无'; } catch (e) { href = '跨源不可读'; }
  return 'readyState=' + state + ' url=' + href;
}

async function ensureOffscreen() {
  // 反思（2026-08-15 第六十四次）：Firefox 无 chrome.offscreen，直接返回 false
  //   （旧版访问 chrome.offscreen.hasDocument 抛 TypeError，被调用方 .catch 吞掉）。
  if (typeof chrome.offscreen === 'undefined') return false;
  // 检查是否已有 offscreen document（hasDocument 在 Chrome 116+/Edge 116+ 可用）
  if (typeof chrome.offscreen.hasDocument === 'function') {
    try {
      const existing = await chrome.offscreen.hasDocument();
      if (existing) {
        log('[VocabRadar][sw][' + _ts() + '] offscreen 已存在（复用）');
        return true;
      }
    } catch (e) { /* 忽略，尝试创建 */ }
  }
  log('[VocabRadar][sw][' + _ts() + '] offscreen 不存在，创建新 document');
  try {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['BLOBS', 'DOM_PARSER', 'WORKERS'],
      justification: 'Audio decode/resample for LLM transcription, main-text extraction, and document (pdf/docx/epub) parsing',
    });
    return true;
  } catch (e) {
    console.warn('[VocabRadar][sw][' + _ts() + '] createDocument 失败:', e);
    // 可能已被其他调用创建，再次检查
    if (typeof chrome.offscreen.hasDocument === 'function') {
      try { return !!(await chrome.offscreen.hasDocument()); } catch (e2) { /* ignore */ }
    }
    // 没有 hasDocument API 时，若 createDocument 报 "already exists" 视为成功
    if (String(e.message || e).includes('already exist') || String(e.message || e).includes('Only a single')) {
      return true;
    }
    return false;
  }
}

// === F1（2026-09-10，用户报 Firefox 传图「offscreen API 不可用」）：OCR/链接/文档宿主统一选择 ===
// Chromium：chrome.offscreen 建 offscreen document（ensureOffscreen 返 boolean，此处统一包
//   成 {ok, error}）；Firefox：无 chrome.offscreen，但 MV3 后台是带 DOM 的 event page
//   （build.mjs#patchManifestForFirefox），复用 ASR 先例 ensureFallbackIframe 在后台页内建
//   隐藏 iframe（src=offscreen.html 本体，与 offscreen document 等价），OFFSCREEN_* 消息
//   协议零改动（OCR/链接提取/文档解析与 ASR 同族）。
export async function ensureOffscreenHost() {
  if (typeof chrome.offscreen !== 'undefined') {
    const ok = await ensureOffscreen();
    if (!ok) return { ok: false, error: 'offscreen 创建失败' };
    // 第二百六十六次（用户报障：网站传 PNG 报 "Could not establish connection.
    //   Receiving end does not exist."）：建好宿主 ≠ 监听器就绪——createDocument 返回时
    //   offscreen.js（ES module）的 onMessage 可能尚未注册，紧接着的 OFFSCREEN_*
    //   正是这个报错。复用 ASR 先例 waitOffscreenReady（PING 握手，见 179/180 次），
    //   OCR/链接/文档三路共用本函数，握手一次全部生效。
    const ready = await waitOffscreenReady(8000);
    if (!ready) return { ok: false, error: 'offscreen 宿主 8 秒内无 PING 应答（监听器未就绪）' };
    return { ok: true };
  }
  const fr = await ensureFallbackIframe();
  if (!fr.ok) return fr;
  // Firefox 回退 iframe：load 事件后同样握手确认 offscreen.js 监听器已注册（附诊断快照）
  const ready = await waitOffscreenReady(8000);
  if (!ready) {
    return { ok: false, error: '回退 iframe 宿主 8 秒内无 PING 应答（' + describeFallbackFrame() + '）' };
  }
  return { ok: true };
}
