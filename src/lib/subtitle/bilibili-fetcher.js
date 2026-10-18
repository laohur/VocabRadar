// ============================================================
// 文件职责：B站字幕获取（wbi 签名、view API 取 aid/cid、轨道挑选与字幕下载）
// 符号：getBilibiliSubtitles / fetchBilibiliTrack / fetchBilibiliSecondarySubtitles
//   （由 index.js 统一 re-export；后者为双语第二轨数据源，D1）
// ============================================================
import { buildSignedUrl } from '../wbi.js';

// === B站 ===

/**
 * 从页面获取 B站视频的 aid 和 cid
 * 通过 view API（https://api.bilibili.com/x/web-interface/view）以 bvid 换取。
 * 原先优先读 window.__INITIAL_STATE__，但该路径依赖注入 inline script 读取页面变量，
 * 被 B站 CSP（script-src 不含 'unsafe-inline'）拒绝，且 __INITIAL_STATE__ 含 undefined
 * 等非合法 JSON，难以稳定解析。view API 已验证可用（需登录态走同站 cookie）。
 * @returns {Promise<{aid:number, cid:number, bvid:string}|null>}
 */
async function getBilibiliIds() {
  // 从 URL 取 bvid
  const bvid = location.pathname.match(/(BV[A-Za-z0-9]+)/)?.[0];
  if (!bvid) {
    console.warn('[VocabRadar][bilibili] URL 未匹配到 bvid', location.pathname);
    return null;
  }
  // 多P视频自动连播换P时 URL 从 ?p=1 变 ?p=2：view API 只传 bvid 默认返回
  //   第一P的 cid，字幕会一直是第一P——从 URL 提取 p 参数，多P时从 pages 取对应P。
  const page = parseInt(new URLSearchParams(location.search).get('p') || '1', 10) || 1;
  try {
    // api.bilibili.com 对 www.bilibili.com 的 CORS 允许带 credentials，登录态下返回正确数据
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { credentials: 'include' });
    const data = await res.json();
    console.log(`[VocabRadar][bilibili] view API code=${data.code} page=${page}`);
    if (data.code === 0) {
      // 多P视频：data.cid 默认是第一P，需从 pages 数组取指定P的 cid
      let cid = data.data.cid;
      if (page > 1 && data.data.pages && data.data.pages.length >= page) {
        cid = data.data.pages[page - 1].cid;
        console.log(`[VocabRadar][bilibili] 多P视频: 取第 ${page}P cid=${cid} (默认cid=${data.data.cid})`);
      }
      return { aid: data.data.aid, cid, bvid };
    }
    console.warn(`[VocabRadar][bilibili] view API 错误: ${data.message}`);
  } catch (e) {
    console.warn('[VocabRadar][bilibili] view API 异常', e);
  }
  return null;
}

/**
 * 获取 B站字幕列表（带 wbi 签名）
 * @param {number} aid
 * @param {number} cid
 * @returns {Promise<Array<{lan:string, subtitle_url:string, lan_doc:string, ai:boolean}>|null>}
 */
async function getBilibiliSubtitleList(aid, cid) {
  try {
    // 用 wbi 签名构造 URL
    const url = await buildSignedUrl(
      'https://api.bilibili.com/x/player/wbi/v2',
      { aid, cid }
    );
    console.log(`[VocabRadar][bilibili] player wbi/v2 请求: ${url}`);
    const res = await fetch(url, { credentials: 'include' });
    const data = await res.json();
    console.log(`[VocabRadar][bilibili] player wbi/v2 返回 code=${data.code}`);
    if (data.code !== 0) {
      console.warn('[VocabRadar][bilibili] player wbi/v2 错误:', data.message);
      return null;
    }
    const subs = data.data?.subtitle?.subtitles || [];
    console.log(`[VocabRadar][bilibili] 字幕轨道数: ${subs.length}`);
    return subs.map((s) => ({
      lan: s.lan || '',
      subtitle_url: (s.subtitle_url || '').startsWith('//') ? 'https:' + s.subtitle_url : s.subtitle_url,
      lan_doc: s.lan_doc || '',
      ai: (s.lan || '').startsWith('ai-')
    }));
  } catch (e) {
    console.error('[VocabRadar][bilibili] player wbi/v2 异常', e);
    return null;
  }
}

/**
 * 下载并解析 B站字幕 JSON
 *
 * 关键：必须用 credentials:'omit'。
 *   - 字幕资源域名（aisubtitle.hdslb.com / i0.hdslb.com 等）的 CORS 响应头为
 *     Access-Control-Allow-Origin:*，按规范带 credentials 时不能用通配 *，浏览器会拒绝。
 *   - 字幕 URL 自带 auth_key 鉴权参数（如 ?auth_key=...），不需要 cookie。
 *   - 原 credentials:'include' 导致 AI 字幕下载被 CORS 拦截，字幕条数=0。
 * @param {string} url
 * @returns {Promise<Array<{start, end, text}>|null>}
 */
async function fetchBilibiliSubtitle(url) {
  try {
    const res = await fetch(url, { credentials: 'omit' });
    const data = await res.json();
    if (!data.body) {
      console.warn('[VocabRadar][bilibili] 字幕 JSON 无 body 字段');
      return null;
    }
    return data.body.map((item) => ({
      start: item.from,
      end: item.to,
      text: item.content
    }));
  } catch (e) {
    console.error('[VocabRadar][bilibili] 字幕下载异常', e);
    return null;
  }
}

/**
 * 选字幕轨道（第518次对齐 YouTube 421 裁定链序）：
 *   用户手选轨道最高优（tracks.js 手选恢复，不在本链内）> 默认链：
 *   原始语言 → 目标(learn) → 界面(ui) → 释义(meaning) → 历史回落(ai-en/en/ai-zh/zh) → 首条。
 *   原始语言 = 首条 ai- 轨的语言（B站 ai- 轨由视频音频生成，其语言即视频原生语言，
 *   与 YouTube "首条 ASR 轨" 同理；无 ai- 轨则无原始信号，跳过该层）。
 *   每层先机器轨 ai-<lang> 再人工轨 <lang>（前缀匹配）。历史回落保留：
 *   无英文回退中文字幕（比无字幕好，用户可在下拉手切）。
 * @param {Array} list
 * @param {string} [ui='en'] 界面语言主码（如 en/zh）
 * @param {string} [learn=''] 学习语言（第2层）
 * @param {string} [meaning=''] 释义语言（第4层）
 */
function pickSubtitleTrack(list, ui = 'en', learn = '', meaning = '') {
  if (!list || list.length === 0) return null;
  const pickLayer = (lang) => {
    if (!lang) return null;
    const ai = list.find((s) => s.lan === `ai-${lang}`) || list.find((s) => s.lan.startsWith(`ai-${lang}`));
    if (ai) return ai;
    return list.find((s) => !s.lan.startsWith('ai-') && s.lan.startsWith(lang)) || null;
  };
  // 原始语言层：首条 ai- 轨的语言
  const orig = (list.find((s) => s.ai || s.lan.startsWith('ai-')) || {}).lan || '';
  const origLang = orig.startsWith('ai-') ? orig.slice(3) : orig;
  let track = pickLayer(origLang);
  if (track) {
    console.log(`[VocabRadar][bilibili] 命中轨道(原始): ${track.lan} (${track.lan_doc})`);
    return track;
  }
  track = pickLayer(learn);
  if (track) {
    console.log(`[VocabRadar][bilibili] 命中轨道(目标): ${track.lan} (${track.lan_doc})`);
    return track;
  }
  track = pickLayer(ui);
  if (track) {
    console.log(`[VocabRadar][bilibili] 命中轨道(界面): ${track.lan} (${track.lan_doc})`);
    return track;
  }
  track = pickLayer(meaning);
  if (track) {
    console.log(`[VocabRadar][bilibili] 命中轨道(释义): ${track.lan} (${track.lan_doc})`);
    return track;
  }
  const aiEn = list.find((s) => s.lan === 'ai-en');
  if (aiEn) {
    console.log(`[VocabRadar][bilibili] 命中轨道: ai-en (${aiEn.lan_doc})`);
    return aiEn;
  }
  const en = list.find((s) => s.lan.startsWith('en'));
  if (en) {
    console.log(`[VocabRadar][bilibili] 命中轨道: ${en.lan} (${en.lan_doc})`);
    return en;
  }
  // 中文回退：无英文时选中文字幕（比无字幕好）
  const aiZh = list.find((s) => s.lan === 'ai-zh');
  if (aiZh) {
    console.log(`[VocabRadar][bilibili] 命中轨道（中文回退）: ai-zh (${aiZh.lan_doc})`);
    return aiZh;
  }
  const zh = list.find((s) => s.lan.startsWith('zh'));
  if (zh) {
    console.log(`[VocabRadar][bilibili] 命中轨道（中文回退）: ${zh.lan} (${zh.lan_doc})`);
    return zh;
  }
  // 最终回退：取第一条（有字幕总比无字幕好）
  console.log(`[VocabRadar][bilibili] 命中轨道（最终回退）: ${list[0].lan} (${list[0].lan_doc})`);
  return list[0];
}

// === 页面主世界捕获桥（20261018 用户批"要"：B站字幕捕获重试，对齐 YouTube
// timedtext 机制）=== page-fetch.js（manifest 已在 B站页 document_start 注入 MAIN
// world）拦截播放器自己的 wbi/v2 响应（cid 键控，轨道 lan 齐全）与字幕 JSON
// （p 标记防跨P）。自动链直拉列表为空时回查缓存；捕获信号广播给 controller
// 事件驱动重拉（点开 CC 自动发现字幕）。
window.addEventListener('message', function (event) {
  if (event.source !== window) return;
  const d = event.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'BEAVER_BILI_WBI' || d.type === 'BEAVER_BILI_SUBTITLE') {
    console.log('[VocabRadar][bilibili] 页面捕获:', d.type, d.type === 'BEAVER_BILI_WBI' ? ('cid=' + d.cid) : ('p=' + d.p));
    try {
      window.dispatchEvent(new CustomEvent('vr-bili-subtitle-captured', { detail: { type: d.type } }));
    } catch (e) { /* 广播失败不影响回查主链 */ }
  }
});

// 页面主世界缓存回查（BEAVER_FETCH_REQUEST 特殊 url 指令，page-fetch.js 应答）
function queryPageBili(queryUrl, extra = {}, timeout = 3000) {
  return new Promise((resolve) => {
    const id = 'bili_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const handler = (event) => {
      if (event.source !== window) return;
      if (event.data && event.data.type === 'BEAVER_FETCH_RESPONSE' && event.data.id === id) {
        window.removeEventListener('message', handler);
        resolve(event.data);
      }
    };
    window.addEventListener('message', handler);
    try {
      window.postMessage({ type: 'BEAVER_FETCH_REQUEST', id, url: queryUrl, ...extra }, '*');
    } catch (e) {
      window.removeEventListener('message', handler);
      resolve(null);
    }
    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, timeout);
  });
}

// 空列表救援：回查页面捕获——①播放器自己的 wbi/v2 响应（按 cid 匹配，取
// subtitle.subtitles 权威列表）②字幕 JSON 捕获（按当前 p 过滤，合成兜底轨，
// cues 直嵌避免二次下载）。返回 {list, cuesByUrl} 或 null
async function rescueCapturedTracks(ids) {
  const out = { list: [], cuesByUrl: new Map() };
  try {
    const wbi = await queryPageBili('__beaver_bili_wbi_query__', { cid: String(ids.cid) });
    if (wbi && wbi.ok && wbi.text) {
      const data = JSON.parse(wbi.text);
      const subs = data && data.data && data.data.subtitle && data.data.subtitle.subtitles;
      if (Array.isArray(subs)) {
        for (const s of subs) {
          if (!s || !s.subtitle_url) continue;
          const url = s.subtitle_url.startsWith('//') ? 'https:' + s.subtitle_url : s.subtitle_url;
          out.list.push({ lan: s.lan || '', lan_doc: s.lan_doc || s.lan || '', subtitle_url: url, ai: String(s.lan || '').startsWith('ai-') });
        }
      }
    }
  } catch (e) { /* wbi 回查失败继续走字幕 JSON 兜底 */ }
  try {
    const pageP = new URLSearchParams(location.search).get('p') || '1';
    const cap = await queryPageBili('__beaver_bili_subtitle_query__', { p: pageP });
    if (cap && cap.ok && cap.text) {
      const entries = JSON.parse(cap.text);
      for (const it of Array.isArray(entries) ? entries : []) {
        if (!it || !it.url || !it.resp || out.cuesByUrl.has(it.url)) continue;
        try {
          const data = JSON.parse(it.resp);
          if (!Array.isArray(data.body) || !data.body.length) continue;
          const cues = data.body.map((b) => ({ start: b.from, end: b.to, text: b.content }));
          out.cuesByUrl.set(it.url, cues);
          out.list.push({
            lan: 'cc', lan_doc: '页面捕获字幕', subtitle_url: it.url,
            ai: it.url.indexOf('aisubtitle.hdslb.com') !== -1, cues,
          });
        } catch (e) { /* 单条解析失败跳过 */ }
      }
    }
  } catch (e) { /* 字幕 JSON 回查失败：如实放弃 */ }
  return (out.list.length || out.cuesByUrl.size) ? out : null;
}

/**
 * 获取 B站字幕（第518次：默认选轨对齐 421 裁定链 原始→目标→界面→释义，见 pickSubtitleTrack）。
 * 返回 {tracks, subtitles, pickedIndex} 格式（与 YouTube 一致）：tracks 含
 *   languageCode(lan) + name(lan_doc) + subtitle_url，setTracks 据此填充下拉框
 *   显示字幕轨道名（如"中文（自动生成）"）——只返回字幕数组会使轨道下拉框
 *   只有 ASR 一项。
 * 空列表救援（20261018）：未点开 CC 时 wbi/v2 常返回空——回查页面主世界捕获
 *   （播放器自己的 wbi/v2 响应 + 字幕 JSON），有则并入列表照常走选轨链。
 * @param {string} [uiLanguage='en'] 界面语言（默认链第3层；缺省回落 en）
 * @param {string} [learnLanguage=''] 学习语言（默认链第2层）
 * @param {string} [meaningLanguage=''] 释义语言（默认链第4层）
 * @returns {Promise<{tracks:Array, subtitles:Array, pickedIndex:number}|null>}
 */
export async function getBilibiliSubtitles(uiLanguage = 'en', learnLanguage = '', meaningLanguage = '') {
  console.log('[VocabRadar][bilibili] 开始获取字幕, uiLanguage=' + uiLanguage + ' learnLanguage=' + learnLanguage + ' meaningLanguage=' + meaningLanguage);
  const ids = await getBilibiliIds();
  if (!ids) {
    console.warn('[VocabRadar][bilibili] 未取到 aid/cid');
    return null;
  }

  let list = await getBilibiliSubtitleList(ids.aid, ids.cid);
  let cuesByUrl = null;
  if (!list || list.length === 0) {
    console.warn('[VocabRadar][bilibili] 字幕列表为空（可能未登录/无字幕/需 wbi 签名）→ 回查页面捕获');
    const rescued = await rescueCapturedTracks(ids);
    if (rescued) {
      list = rescued.list;
      cuesByUrl = rescued.cuesByUrl;
      console.log('[VocabRadar][bilibili] 页面捕获救援: 轨道', list.length, '个, cues', cuesByUrl.size, '条 URL');
    }
  }
  if (!list || list.length === 0) {
    console.warn('[VocabRadar][bilibili] 捕获缓存亦无字幕（点开播放器 CC 后会自动重拉）');
    return null;
  }
  // 打印所有轨道便于排查
  console.log('[VocabRadar][bilibili] 所有字幕轨道:', list.map((s) => `${s.lan}=${s.lan_doc}${s.ai ? '(AI)' : ''}`).join(', '));

  const track = pickSubtitleTrack(list, uiLanguage, learnLanguage, meaningLanguage);
  if (!track) return null;

  // 捕获轨 cues 已在手（页面侧连响应一起捕获），免二次下载（auth_key 时效内重取也可，
  // 直用更稳）；API 轨照旧按 URL 下载
  const subs = (track.cues && track.cues.length) ? track.cues : await fetchBilibiliSubtitle(track.subtitle_url);
  console.log(`[VocabRadar][bilibili] 字幕条数: ${subs ? subs.length : 0}`);

  // 构造 tracks 信息（与 YouTube 格式一致），供 sidebar 下拉框显示
  const tracks = list.map((s) => ({
    languageCode: s.lan,
    name: s.lan_doc || s.lan,
    subtitle_url: s.subtitle_url,
    ai: !!s.ai
  }));
  const pickedIndex = list.indexOf(track);
  return { tracks, subtitles: subs || [], pickedIndex: pickedIndex >= 0 ? pickedIndex : 0 };
}

/**
 * 获取 B站指定轨道的字幕（供 sidebar 轨道切换用）
 * @param {object} track - 轨道信息（含 subtitle_url）
 * @returns {Promise<Array<{start, end, text}>|null>}
 */
export async function fetchBilibiliTrack(track) {
  if (!track) return null;
  if (Array.isArray(track.cues) && track.cues.length) return track.cues; // 页面捕获轨：cues 直用
  if (!track.subtitle_url) return null;
  return await fetchBilibiliSubtitle(track.subtitle_url);
}

/**
 * 取 B站站上第二语言字幕文件（双语副行数据源，D1）。
 * 字幕列表滤 lan（剥 ai- 前缀）前缀匹配释义语言：人工轨优先、AI 轨次之，
 * credentials:'omit' 直下 JSON（同 fetchBilibiliSubtitle 口径）。
 * B站 AI/人工两轨同源同一音轨，时间轴天然近似对齐（错轴交给对齐层配对）。
 * 无第二语言轨 → null（调用方回退实时翻译）。
 * 注意参数序与 getBilibiliSubtitles（ui, learn, meaning）不同——本函数无界面语言层。
 * @param {{learn?:string, meaning?:string}} [opts] learn=学习语言、meaning=释义语言
 * @returns {Promise<Array<{start,end,text}>|null>}
 */
export async function fetchBilibiliSecondarySubtitles(opts = {}) {
  const learn = opts.learn || '';
  const meaning = opts.meaning || '';
  if (!meaning || meaning === learn) {
    console.log('[VocabRadar][bilibili] 双语第二轨跳过: 释义语言与学习语言相同或为空 (', learn, '→', meaning, ')');
    return null;
  }
  const ids = await getBilibiliIds();
  if (!ids) return null;
  const list = await getBilibiliSubtitleList(ids.aid, ids.cid);
  if (!list || list.length === 0) return null;

  const isMeaning = (lan) => String(lan || '').replace(/^ai-/, '').startsWith(meaning);
  const cands = list.filter((s) => isMeaning(s.lan));
  const ordered = cands.filter((s) => !s.ai).concat(cands.filter((s) => s.ai));   // 人工轨优先
  for (const pick of ordered) {
    try {
      const cues = await fetchBilibiliSubtitle(pick.subtitle_url);
      if (cues && cues.length > 0) {
        console.log('[VocabRadar][bilibili] 双语第二轨命中:', pick.lan,
          (pick.ai ? '(AI)' : '(人工)'), cues.length, '条');
        return cues;
      }
    } catch (e) {
      console.warn('[VocabRadar][bilibili] 双语第二轨下载异常:', pick.lan, e && e.message);
    }
  }
  console.log('[VocabRadar][bilibili] 双语第二轨未取到（无', meaning, '语言轨），转实时翻译兜底');
  return null;
}
