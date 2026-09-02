// B站音频流提取模块
// 从页面 __playinfo__ 解析 DASH 音频轨 URL，用于 ASR 预识别。
//
// 核心思路（2026-07-04 重构）：
//   旧方案用 ScriptProcessor 实时采集 <video> 音频，只能识别正在播放的内容。
//   新方案通过 __playinfo__ 拿到纯音频流 URL，直接下载完整音频文件，
//   解码为 PCM 后按 60 秒分段送 Whisper 识别，实现"提前识别"——
//   不依赖播放进度，用户点击后立即识别当前分钟，并继续预识别后续分钟。
//
// __playinfo__ 结构（B站 DASH 格式）：
//   {
//     data: {
//       dash: {
//         audio: [
//           { id: 30280, baseUrl: "https://...m4s?...", bandwidth: 308119, codecs: "mp4a.40.2" },
//           { id: 30232, baseUrl: "https://...m4s?...", bandwidth: 134532, codecs: "mp4a.40.2" }
//         ]
//       }
//     }
//   }
//   id=30280 为高品质（192kbps），30232 为标准（64kbps），取 bandwidth 最高即可。

// 第一百零七次（P1 方案C，借鉴 VideoSeek injectXhr）：主世界桥注入与 playurl 钩子消费。
// page-fetch.js 在页面主世界拦截播放器自身的 /x/player/wbi/playurl 请求（签名/cookie/referer
// 天然合法），按 cid 缓存并 postMessage 上报；此处优先消费钩子数据，回退 __playinfo__ 两级提取。
// 第一百零九次（P3）：MAIN world 经 chrome.scripting 执行（不受页面 CSP 管，直接拿返回值）。
// 失败（Firefox 旧版无 world 选项 / scripting 不可用）自动回退旧的内联/script-src 注入路径。
function mainExec(name) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'MAIN_WORLD_EXEC', name }, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp || null);
      });
    } catch (e) { resolve(null); }
  });
}

let _bridgeInjected = false;
function ensureBiliBridge() {
  if (_bridgeInjected) return;
  _bridgeInjected = true;
  // P3：优先 chrome.scripting 注入 page-fetch.js（不受页面 CSP 管）
  try {
    chrome.runtime.sendMessage({ type: 'MAIN_WORLD_INJECT_FILE', file: 'src/lib/page-fetch.js' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        console.warn('[VocabRadar][bilibili-audio] MAIN world 注入失败，回退 script 标签:', (resp && resp.error) || chrome.runtime.lastError?.message);
        injectBridgeScriptTag();
      }
    });
  } catch (e) { injectBridgeScriptTag(); }
}

/** 旧路径：<script src> 标签注入（受页面 CSP 约束，作兜底） */
function injectBridgeScriptTag() {
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('src/lib/page-fetch.js');
    (document.head || document.documentElement).appendChild(s);
    s.addEventListener('load', () => s.remove());
  } catch (e) { /* ignore */ }
}

/**
 * 等待钩子上报的 playurl 响应（被动 BEAVER_BILI_PLAYURL 或主动查询缓存）
 * @param {number} waitMs 最长等待毫秒
 * @returns {Promise<object|null>} playurl JSON 的 data 部分（含 dash.audio），失败 null
 */
function consumeHookedPlayinfo(waitMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; window.removeEventListener('message', h); clearTimeout(timer); resolve(v); };
    const pick = (respText) => {
      try {
        const j = JSON.parse(respText);
        if (j && j.data && j.data.dash && Array.isArray(j.data.dash.audio) && j.data.dash.audio.length > 0) return j.data;
      } catch (e) { /* ignore */ }
      return null;
    };
    const h = (e) => {
      if (e.source !== window || !e.data) return;
      if (e.data.type === 'BEAVER_BILI_PLAYURL' && e.data.resp) {
        const d = pick(e.data.resp);
        if (d) finish(d);
      }
    };
    window.addEventListener('message', h);
    // 主动查一次页面世界缓存（覆盖"钩子在内容脚本监听前已上报"的时序）
    const qid = '__beaver_puq_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const qh = (e) => {
      if (e.source !== window || !e.data || e.data.type !== 'BEAVER_FETCH_RESPONSE' || e.data.id !== qid) return;
      window.removeEventListener('message', qh);
      if (e.data.ok && e.data.text) {
        const d = pick(e.data.text);
        if (d) { finish(d); return; }
      }
    };
    window.addEventListener('message', qh);
    try {
      window.postMessage({ type: 'BEAVER_FETCH_REQUEST', id: qid, url: '__beaver_bili_playurl_query__', cid: '' }, '*');
    } catch (e) { /* ignore */ }
    const timer = setTimeout(() => finish(null), waitMs);
  });
}

/**
 * 从文本中提取平衡花括号的 JSON 字符串
 * @param {string} text - 源文本
 * @param {number} start - '{' 的下标
 * @returns {string|null} 完整的 {...} 字符串，失败返回 null
 */
function extractBalancedJson(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/**
 * 从页面 <script> 标签中提取 __playinfo__ 变量
 * B站将播放信息以 window.__playinfo__ = {...} 形式嵌入页面 HTML。
 * content script 运行在隔离世界，无法直接访问 window.__playinfo__，
 * 需遍历 <script> 标签 textContent 正则定位赋值语句，按花括号配对提取 JSON。
 * 与 subtitle-fetcher.js 的 extractVarFromScripts 同源思路（只读不执行，不违反 CSP）。
 * @returns {object|null}
 */
function extractPlayinfo() {
  const scripts = document.getElementsByTagName('script');
  for (const s of scripts) {
    const text = s.textContent || '';
    if (!text.includes('__playinfo__')) continue;
    // 匹配 __playinfo__ = 形式（可能有空格）
    const re = /__playinfo__\s*=\s*/;
    const m = text.match(re);
    if (!m) continue;
    const braceStart = text.indexOf('{', m.index + m[0].length);
    if (braceStart === -1) continue;
    const jsonStr = extractBalancedJson(text, braceStart);
    if (!jsonStr) continue;
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      // 当前 script 不匹配，继续尝试下一个
    }
  }
  return null;
}

/**
 * 通过注入页面脚本读取 window.__playinfo__（获取最新数据）
 * 反思（2026-07-09 #76）：用户反馈「点击asr按钮，有时候bilibili音频下载失败」。
 *   根因：extractPlayinfo 只搜 <script> 标签 textContent，SPA 换集后 B站通过 AJAX
 *   更新 window.__playinfo__ 但不重新插入 <script> 标签 → 读到的是旧集 playinfo →
 *   音频 URL 是旧集的，可能已过期（B站 URL 有时效）→ 下载失败。
 *   修正：注入页面脚本读取 window.__playinfo__（主世界），获取最新数据。
 *   content script 在隔离世界无法直接访问 window.__playinfo__，需通过 postMessage 回传。
 *   CSP 兜底：若注入脚本被 CSP 阻止，postMessage 不回传，超时后返回 null，
 *   调用方回退到 extractPlayinfo（script 标签方式）。
 * 第一百零七次（P0 诊断补强）：区分两种失败——注入脚本有回信（变量不存在）vs 超时无回信
 *   （inline 注入被页面 CSP 拦截或异常），返回 {via:'window'|'timeout', playinfo}，
 *   供 bili-none 原因文案精确到"该修哪一层"（调研文档 H1）。
 * @returns {Promise<{via:string, playinfo:object|null}>}
 */
function extractPlayinfoFromWindow() {
  return new Promise((resolve) => {
    // 第一百零九次（P3）：优先 chrome.scripting MAIN world 直读（不受页面 CSP 管，直接拿返回值）
    mainExec('readPlayinfo').then((resp) => {
      if (resp && resp.ok) {
        resolve({ via: 'window', playinfo: resp.result || null });
        return;
      }
      // 旧路径：内联 <script> 注入 + postMessage 回传（受页面 CSP 约束，兜底）。
      // 注意（第一百零四次教训）：本串为单引号 JS 串，内部空串一律用双引号，禁裸单引号
      const msgId = '__beaver_playinfo_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      let done = false;
      const finish = (via, val) => {
        if (done) return;
        done = true;
        window.removeEventListener('message', handler);
        resolve({ via, playinfo: val || null });
      };
      const handler = (e) => {
        if (e.source !== window || !e.data || e.data.type !== msgId) return;
        finish('window', e.data.playinfo || null);
      };
      window.addEventListener('message', handler);
      const script = document.createElement('script');
      script.textContent = '(function(){try{var p=window.__playinfo__;var v=p?JSON.parse(JSON.stringify(p)):null;window.postMessage({type:' + JSON.stringify(msgId) + ',playinfo:v},"*")}catch(e){window.postMessage({type:' + JSON.stringify(msgId) + ',playinfo:null},"*")}})();';
      (document.head || document.documentElement).appendChild(script);
      script.remove();
      setTimeout(() => finish('timeout', null), 300);
    });
  });
}

/**
 * 读取页面标题（第九十六次：下载音频按钮的文件命名用）
 * 优先主世界 window.__INITIAL_STATE__（普通视频 videoData.title / 番剧 epInfo / pgc 页 h1），
 * 回退 document.title 去除站名后缀。非法文件名字符替换为空格。
 * @returns {Promise<string>}
 */
export async function getBilibiliVideoTitle() {
  let title = '';
  // 第一百零九次（P3）：优先 MAIN world 直读 __INITIAL_STATE__（不受页面 CSP 管，直接拿返回值）
  const r = await mainExec('readBiliTitle');
  if (r && r.ok && r.result) {
    title = String(r.result);
  } else {
    // 旧路径兜底：内联注入 + postMessage（串内禁裸单引号，空串一律双引号——第九十六次回归教训）
    try {
      const state = await new Promise((resolve) => {
        const msgId = '__beaver_state_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        let done = false;
        const finish = (v) => { if (done) return; done = true; window.removeEventListener('message', h); resolve(v || null); };
        const h = (e) => { if (e.source !== window || !e.data || e.data.type !== msgId) return; finish(e.data.state); };
        window.addEventListener('message', h);
        const s = document.createElement('script');
        s.textContent = '(function(){try{var st=window.__INITIAL_STATE__;var v=st?{t:(st.videoData&&st.videoData.title)||(st.epInfo&&(st.epInfo.showTitle||st.epInfo.long_title||st.epInfo.title))||(st.h1Title&&st.h1Title.title)||""}:null;window.postMessage({type:' + JSON.stringify(msgId) + ',state:v},"*")}catch(e){window.postMessage({type:' + JSON.stringify(msgId) + ',state:null},"*")}})();';
        (document.head || document.documentElement).appendChild(s);
        s.remove();
        setTimeout(() => finish(null), 300);
      });
      if (state && state.t) title = String(state.t);
    } catch (e) { /* ignore */ }
  }
  if (!title) {
    try { title = document.title || ''; } catch (e) { /* ignore */ }
  }
  // 去除常见站名后缀与非法文件名字符
  title = title.replace(/_哔哩哔哩_bilibili.*$/i, '').replace(/_bilibili.*$/i, '').replace(/[\\/:*?"<>|]/g, ' ').trim();
  return title.slice(0, 120) || 'bilibili_audio';
}

/**
 * 诊断 B站直连不可用的原因（第九十九次：用户反馈"回退实时模式"却不知为何）
 * 复用与 getBilibiliAudioInfo 相同的提取链，返回人话原因；可用时返回空串。
 * @returns {Promise<string>}
 */
export async function getBilibiliAudioUnavailableReason() {
  try {
    const r1 = await extractPlayinfoFromWindow();
    let playinfo = r1.playinfo;
    let via = r1.via;
    if (!playinfo) {
      playinfo = extractPlayinfo();
      via = via + '+script';
    }
    if (!playinfo) {
      // 第一百零七次（P0）：区分注入被 CSP 拦（超时无回信）与变量确实不存在
      if (r1.via === 'timeout') return '主世界注入超时（疑似页面CSP拦截内联脚本，H1）且 script 标签亦未找到 __playinfo__';
      return '页面未找到 __playinfo__';
    }
    const audioTracks = playinfo?.data?.dash?.audio;
    if (!audioTracks || audioTracks.length === 0) {
      const hasDash = !!playinfo?.data?.dash;
      const hasDurl = !!playinfo?.data?.durl;
      return hasDash ? 'dash.audio 为空（VIP 专属/试看/音轨未加载）'
        : hasDurl ? 'DURL 格式（非 DASH，无独立音轨）'
        : 'playinfo 结构异常';
    }
    const best = [...audioTracks].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    if (!best || !(best.baseUrl || best.base_url)) return '音频轨缺 baseUrl';
    return ''; // 可用
  } catch (e) {
    return '提取异常: ' + String(e && e.message || e).slice(0, 60);
  }
}

/**
 * 从 __playinfo__ 提取最高品质音频流信息（第九十五次扩展；第九十六次补 backupUrls/title）
 * B站 DASH 格式：data.dash.audio[] 数组，含 baseUrl/base_url、backupUrl(s)、bandwidth、codecs
 * 按 bandwidth 降序排序，取最高品质（通常 id=30280, 192kbps）
 * bandwidth 用于流式下载的字节位置估算：字节偏移 ≈ bandwidth/8 × 秒数。
 * 反思（2026-07-09 #76）：优先通过 window.__playinfo__ 读取最新数据，
 *   SPA 换集后 script 标签里的 playinfo 是旧集 → URL 过期。
 * 第九十六次（借鉴 videoseek/bilibili-evolved）：返回 baseUrl+backupUrl 全列表供 SW 依序回退；
 *   附视频标题供「下载音频」按钮命名文件。
 * @returns {Promise<{url:string, backupUrls:string[], bandwidth:number, codecs:string, title:string}|null>} 失败返回 null
 */
export async function getBilibiliAudioInfo() {
  try {
    // 第一百零七次（P1）：优先消费主世界钩子捕获的官方 playurl 响应（最新、字段最全），
    // 回退 window.__playinfo__ 两级提取。来源写入日志供归因。
    ensureBiliBridge();
    let srcVia = 'hook';
    const hooked = await consumeHookedPlayinfo(1200);
    if (hooked) {
      var playinfo = { data: hooked };
      console.log('[VocabRadar][bilibili-audio] 音频信息来源=playurl钩子');
    } else {
      const r1 = await extractPlayinfoFromWindow();
      srcVia = 'window';
      if (!r1.playinfo) {
        if (r1.via === 'timeout') {
          console.warn('[VocabRadar][bilibili-audio] 主世界注入 300ms 无回信——疑似页面 CSP 拦截内联脚本（H1），回退 script 标签');
        } else {
          console.log('[VocabRadar][bilibili-audio] window.__playinfo__ 不存在，回退 script 标签提取');
        }
        srcVia = 'script';
        var playinfo = extractPlayinfo();
        if (!playinfo && r1.via === 'timeout') {
          console.warn('[VocabRadar][bilibili-audio] script 标签也未找到 __playinfo__');
        }
      } else {
        var playinfo = r1.playinfo;
      }
    }
    if (!playinfo) {
      console.warn('[VocabRadar][bilibili-audio] 未找到 __playinfo__（来源=' + srcVia + '）');
      return null;
    }
    const audioTracks = playinfo?.data?.dash?.audio;
    if (!audioTracks || audioTracks.length === 0) {
      // 反思（2026-07-05）：会员专属视频可能无 dash.audio（仅 DURL 格式或需 VIP cookie）。
      // 明确区分原因，便于诊断“为何回退到 captureStream”。
      const hasDash = !!playinfo?.data?.dash;
      const hasDurl = !!playinfo?.data?.durl;
      const reason = hasDash ? 'dash.audio 为空（可能 VIP 专属或音频轨未加载）'
        : hasDurl ? 'DURL 格式（非 DASH，无独立音频轨）'
        : '无 dash 也无 durl（playinfo 结构异常）';
      console.warn('[VocabRadar][bilibili-audio] __playinfo__ 中无 dash.audio:', reason);
      return null;
    }
    // 按 bandwidth 降序，取最高品质
    const sorted = [...audioTracks].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    const best = sorted[0];
    const url = best.baseUrl || best.base_url;
    if (!url) {
      console.warn('[VocabRadar][bilibili-audio] 音频轨无 baseUrl/base_url');
      return null;
    }
    // 第九十六次：收集备用 URL（backupUrl/backup_url 可能为数组或字符串），主 URL 在前
    const rawBackup = best.backupUrl || best.backup_url || [];
    const backupUrls = (Array.isArray(rawBackup) ? rawBackup : [rawBackup]).filter((u) => typeof u === 'string' && u && u !== url);
    console.log(`[VocabRadar][bilibili-audio] 选中音频轨: id=${best.id} bandwidth=${best.bandwidth} codecs=${best.codecs} 备用=${backupUrls.length}`);
    const title = await getBilibiliVideoTitle();
    return { url, backupUrls, bandwidth: best.bandwidth || 0, codecs: best.codecs || '', title };
  } catch (e) {
    console.warn('[VocabRadar][bilibili-audio] 提取失败:', e);
    return null;
  }
}

/**
 * 从 __playinfo__ 提取最高品质音频流 URL（兼容旧调用方）
 * 第九十五次：内部改走 getBilibiliAudioInfo（附带 bandwidth 供流式下载估算字节位置）。
 * @returns {Promise<string|null>} 音频流 URL（.m4s 格式），失败返回 null
 */
export async function getBilibiliAudioUrl() {
  const info = await getBilibiliAudioInfo();
  return info ? info.url : null;
}

/**
 * 检测当前页面是否为 B站视频页（有 __playinfo__ 可用）
 * @returns {boolean}
 */
export function isBilibiliAudioAvailable() {
  try {
    const scripts = document.getElementsByTagName('script');
    for (const s of scripts) {
      if ((s.textContent || '').includes('__playinfo__')) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}
