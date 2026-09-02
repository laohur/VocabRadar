// ============================================================
// 文件职责：B站字幕获取（wbi 签名、view API 取 aid/cid、轨道挑选与字幕下载）
// 来源：拆分自 src/lib/subtitle-fetcher.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-27
// 符号：getBilibiliSubtitles / fetchBilibiliTrack（由 index.js 统一 re-export）
// import 由原文件 L22 迁入，层级从 ./wbi.js 调整为 ../wbi.js
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
  // 反思（2026-07-09）：用户反馈"视频自动切换，字幕、单词本依旧不动"。
  //   根因：B站多P视频自动连播换P时 URL 从 ?p=1 变 ?p=2，但 getBilibiliIds
  //   只传 bvid 不传 page，view API 默认返回第一P的 cid → 字幕仍是第一P的。
  //   修正：从 URL 提取 p 参数，多P时从 pages 数组取对应P的 cid。
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
 * 选字幕轨道：优先级 ai-en > en-* > ai-zh > zh-* > 第一条。
 * 反思（2026-07-09 #70）：用户反馈「有中文字幕为何没抓出来？」。
 *   旧版（2026-07-07 回滚）只选英文，无英文返回 null，中文字幕完全不可用。
 *   修正：无英文时回退到中文字幕（ai-zh > zh-*），再无则取第一条。
 *   有字幕总比无字幕好，用户可在轨道下拉框切换。
 * @param {Array} list
 */
function pickSubtitleTrack(list) {
  if (!list || list.length === 0) return null;
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

/**
 * 获取 B站字幕（自动选英文轨道，ai-en 优先，无英文回退中文）
 * 反思（2026-07-09 #72）：用户反馈「既然加载的是中文字幕，轨道咋还是asr？」。
 *   根因：旧版只返回 subtitles 数组，不返回 tracks 信息，video-controller.js
 *   把 Array 当 B站结果，tracks=null → setTracks 不调用 → 下拉框只有 ASR。
 *   修正：返回 {tracks, subtitles, pickedIndex} 格式（与 YouTube 一致），
 *   tracks 含 languageCode(lan) + name(lan_doc) + subtitle_url，
 *   setTracks 据此填充下拉框显示字幕轨道名（如"中文（自动生成）"）。
 * @returns {Promise<{tracks:Array, subtitles:Array, pickedIndex:number}|null>}
 */
export async function getBilibiliSubtitles() {
  console.log('[VocabRadar][bilibili] 开始获取字幕');
  const ids = await getBilibiliIds();
  if (!ids) {
    console.warn('[VocabRadar][bilibili] 未取到 aid/cid');
    return null;
  }

  const list = await getBilibiliSubtitleList(ids.aid, ids.cid);
  if (!list || list.length === 0) {
    console.warn('[VocabRadar][bilibili] 字幕列表为空（可能未登录/无字幕/需 wbi 签名）');
    return null;
  }
  // 打印所有轨道便于排查
  console.log('[VocabRadar][bilibili] 所有字幕轨道:', list.map((s) => `${s.lan}=${s.lan_doc}${s.ai ? '(AI)' : ''}`).join(', '));

  const track = pickSubtitleTrack(list);
  if (!track) return null;

  const subs = await fetchBilibiliSubtitle(track.subtitle_url);
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
  if (!track || !track.subtitle_url) return null;
  return await fetchBilibiliSubtitle(track.subtitle_url);
}
