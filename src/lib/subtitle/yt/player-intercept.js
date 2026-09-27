// =============================================================================
// yt/player-intercept.js —— 播放器 API 触发 + 页面拦截路径0
// -----------------------------------------------------------------------------
// 职责：sleep()、isYouTubeAdShowing()（广告判据）、getYouTubePlayer()（标准 API
//       宿主探测链）、checkPageCache()（按 lang/tlang/v 匹配缓存）、
//       triggerAndInterceptSubtitle()（等广告→等播放器→setOption 切轨→轮询拦截，
//       含原生轨/翻译轨两分支与 finally 恢复轨道）。
// 来源：拆分自 src/lib/subtitle/youtube-fetcher.js（2026-09-27 拆分第三刀，机械搬移）。
// 关系：依赖 ./page-context.js（injectPageScript/syncPageTimedtextCache/
//       getTimedtextCache——缓存数组身份恒定，函数顶捕获即与原直读等价）。
// 消费方：./track-download.js（路径0）。
// =============================================================================

import { injectPageScript, syncPageTimedtextCache, getTimedtextCache } from './page-context.js';

/**
 * 睡眠若干毫秒（第一百七十八次新增，等价 VideoSeek 的 CommonHelper.sleep）。
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 判断当前是否正在播放贴片/前置广告（第一百七十八次新增）。
 *
 * 为什么必需：广告播放期间播放器的字幕轨道尚未挂载，此时 setOption('captions','track')
 * 不会触发任何 timedtext 请求 → 白等到超时。VideoSeek 的做法是先轮询等广告结束
 * （最多 30 次 × 1000ms），仍在播则直接抛 NeedSkipAdError 放弃本次抓取。
 * 判据与 VideoSeek 完全一致：存在 .video-ads 元素且其计算样式可见
 * （display≠none && visibility≠hidden && opacity≠'0'）。
 * @returns {boolean} true=正在播广告
 */
function isYouTubeAdShowing() {
  try {
    const el = document.querySelector('.video-ads');
    if (!el) return false;
    const st = window.getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  } catch {
    return false;
  }
}

/**
 * 获取 YouTube 播放器对象
 * @returns {Object|null}
 */
function getYouTubePlayer() {
  try {
    const isShort = location.pathname.includes('/shorts/');
    // 第一百五十次：选择器放宽——旧版仅认 ytd-player#ytd-player，部分布局/实验分支
    // 无此元素 → path0 恒"播放器不可用"→ 全渠道死。按优先级探测标准 API 宿主：
    const candidates = isShort
      ? ['#shorts-player', '#movie_player', 'div.html5-video-player']
      : ['ytd-player#ytd-player', '#movie_player', 'div.html5-video-player'];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const p = el.player_ || el;
      if (p && typeof p.setOption === 'function') return p;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 检查页面主世界缓存中是否有匹配语言的 timedtext 响应。
 * @param {string} languageCode 语言代码
 * @param {string} videoId 视频 ID
 * @returns {string|null} 匹配的响应文本，无匹配返回 null
 */
function checkPageCache(languageCode, videoId) {
  const _pageTimedtextCache = getTimedtextCache();
  for (let i = _pageTimedtextCache.length - 1; i >= 0; i--) {
    const item = _pageTimedtextCache[i];
    try {
      const u = new URL(item.url, 'https://www.youtube.com');
      const urlLang = u.searchParams.get('lang');
      const urlTlang = u.searchParams.get('tlang');
      const urlV = u.searchParams.get('v');
      // 匹配条件：lang 匹配且无翻译(tlang)，videoId 匹配（或 URL 中无 v 参数）
      if (!urlTlang && urlLang === languageCode && (!urlV || urlV === videoId)) {
        console.log('[VocabRadar][youtube] 页面缓存命中: lang=', urlLang, 'v=', urlV, 'resp长度=', (item.resp || '').length);
        return item.resp;
      }
    } catch (e) {
      console.warn('[VocabRadar][youtube] 页面缓存 URL 解析失败', e.message);
    }
  }
  return null;
}

/**
 * 用 YouTube 播放器 API 触发字幕加载，然后等待页面主世界拦截器捕获响应。
 *
 * 流程（第一百七十八次按 VideoSeek getSubtitles 主流程重排）：
 *   1. 回查页面主世界 timedtext 缓存（document_start 拦截到的早期请求）
 *   2. 检查本世界缓存（播放器可能已加载过该语言字幕）
 *   3. 等广告播完（最多 30×1000ms），仍在播则放弃本路径
 *   4. 等播放器就绪 → toggleSubtitlesOn → 等轨道挂载
 *   5. 切轨前先回查一次缓存（对应 VideoSeek 的第一次 waitForInject）
 *   6. 构造目标轨道配置（captionTracks 命中走原生轨；否则走 translationLanguages 翻译轨）
 *   7. setOption → sleep(1000) → 轮询等待拦截
 *
 * @param {string} languageCode 语言代码（如 'en'）
 * @param {string} videoId 视频 ID
 * @param {number} timeout 超时秒数，默认 8
 * @param {{kind?:string, vss_id?:string, name?:string}} [track=null] 原轨道元数据——
 *        自动生成轨（kind='asr'）必须带 kind 且 vss_id 为 'a.xx' 形态；旧版固定 '.xx'
 *        手动轨配置对纯 ASR 视频无效，setOption 不被播放器接受 → 白等 8s 必空。
 * @returns {Promise<string|null>} 拦截到的字幕响应文本
 */
export async function triggerAndInterceptSubtitle(languageCode, videoId, timeout = 8, track = null) {
  // 拆分接驳：缓存数组身份恒定（仅 push 不重赋），函数顶捕获与原模块直读等价
  const _pageTimedtextCache = getTimedtextCache();
  injectPageScript();

  // 第一百七十八次：先向页面主世界索取整批 timedtext 缓存。
  // Chrome 下 page-fetch.js 于 document_start 就位，播放器自发的字幕请求早已被捕获，
  // 但那时本内容脚本还没建立监听 → 广播丢失，只能主动回查。这是本轮决定性一步：
  // 播放器对已加载轨道不会重复请求，不回查就只能白等超时。
  await syncPageTimedtextCache();

  // 先检查缓存——播放器可能已经加载过字幕
  const cached = checkPageCache(languageCode, videoId);
  if (cached) return cached;

  // 第一百七十八次（借鉴 VideoSeek）：等前置广告播完。广告期间字幕轨道未挂载，
  // setOption 不触发任何 timedtext 请求。最多等 30 秒，仍在播则放弃路径0
  // （VideoSeek 此处抛 NeedSkipAdError；本项目下游有 A/B 免 POT 通道，返回 null 让其接手）。
  if (isYouTubeAdShowing()) {
    for (let i = 0; i < 30 && isYouTubeAdShowing(); i++) {
      if (i === 0) console.log('[VocabRadar][youtube] 页面拦截: 检测到广告播放中，等待广告结束');
      await sleep(1000);
    }
    if (isYouTubeAdShowing()) {
      console.warn('[VocabRadar][youtube] 页面拦截: 广告等待 30s 超时，放弃路径0');
      return null;
    }
    console.log('[VocabRadar][youtube] 页面拦截: 广告已结束，继续触发');
  }

  // 第一百三十七次（用户反馈"en generate 空，切轨再回来才有；你重试有啥用，咋不模仿用户操作"）：
  // 手动切换之所以总成功，是因为用户操作时播放器早已就绪。旧版此处"播放器不可用→立即放弃"，
  // 首取必然落在空窗期。改为**等播放器就绪再触发**（轮询 500ms，至多 waitMs）——时机对齐用户操作。
  // 第一百四十九次（用户反馈"现在切换也不行"）：等待播放器就绪 12s 过长——手动
  // 切轨被拖慢、A/B 免 POT 通道迟迟接手不了。收敛为 3.5s：等不到就让 A/B 上，
  // path0 的完整机会留到模拟切轨轮次（彼时播放器早已就绪，秒过等待）。
  const waitMs = 3500;
  let player = getYouTubePlayer();
  if (!player || typeof player.setOption !== 'function') {
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      await new Promise((r) => setTimeout(r, 500));
      player = getYouTubePlayer();
      if (player && typeof player.setOption === 'function') break;
    }
    if (!player || typeof player.setOption !== 'function') {
      console.warn('[VocabRadar][youtube] 页面拦截: 等待', waitMs, 'ms 后播放器仍不可用，放弃路径0');
      return null;
    }
    console.log('[VocabRadar][youtube] 页面拦截: 播放器经', Date.now() - t0, 'ms 就绪，继续触发');
  }

  // 记录拦截前的数据量，用于判断新增
  const beforeCount = _pageTimedtextCache.length;
  console.log('[VocabRadar][youtube] 页面拦截: 播放器就绪, beforeCount=', beforeCount);

  // 保存当前字幕轨道，稍后恢复
  const prevTrack = player.getOption?.('captions', 'track');
  const wasSubtitlesOn = player.isSubtitlesOn?.();
  console.log('[VocabRadar][youtube] 页面拦截: 原轨道=', prevTrack?.languageCode, '字幕开启=', wasSubtitlesOn);

  try {
    // 确保字幕开启
    if (typeof player.toggleSubtitlesOn === 'function') {
      console.log('[VocabRadar][youtube] 页面拦截: toggleSubtitlesOn() 确保开启');
      player.toggleSubtitlesOn();
    }

    // 等待播放器准备好字幕轨道
    let currentTrack = player.getOption?.('captions', 'track');
    console.log('[VocabRadar][youtube] 页面拦截: 等待轨道就绪, currentTrack=', currentTrack?.languageCode);
    for (let i = 0; i < 5 && (!currentTrack?.languageCode); i++) {
      await new Promise(r => setTimeout(r, 1000));
      currentTrack = player.getOption?.('captions', 'track');
      console.log('[VocabRadar][youtube] 页面拦截: 第', (i+1), '次等待, track=', currentTrack?.languageCode);
    }

    // 第一百七十八次（借鉴 VideoSeek 的第一次 waitForInject）：切轨之前先回查一次。
    // toggleSubtitlesOn() 本身就可能让播放器把默认轨道拉下来；若恰好是目标语言，
    // 直接用即可，不必再切轨（切轨反而扰动用户的字幕设置）。
    await syncPageTimedtextCache();
    const cachedAfterToggle = checkPageCache(languageCode, videoId);
    if (cachedAfterToggle) {
      console.log('[VocabRadar][youtube] 页面拦截: toggleSubtitlesOn 后缓存已命中，无需切轨');
      return cachedAfterToggle;
    }

    // 构造目标轨道配置，触发 YouTube 播放器请求该语言的字幕
    // 第一百三十三次：自动生成轨（kind='asr'）必须带 kind 且 vss_id 用 'a.xx' 形态，
    // 否则播放器不认这份手动轨配置、不发起请求（"en 自动生成轨加载为空"的路径0根因）。
    // 第一百七十八次（借鉴 VideoSeek）：优先**在播放器当前轨道对象上就地改字段**再回设，
    // 而不是凭空造一个新对象——当前对象里有播放器自己塞的内部字段，凭空造的配置
    // 常被静默丢弃。currentTrack 拿不到时才退回自造。
    const playerResp = (() => {
      try { return player.getPlayerResponse?.(); } catch { return null; }
    })();
    const respTracks = playerResp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const respTransLangs = playerResp?.captions?.playerCaptionsTracklistRenderer?.translationLanguages || [];
    // VideoSeek 读的是驼峰 vssId（getPlayerResponse 原始字段名），而播放器 setOption
    // 要的是下划线 vss_id——两边字段名不同，此前混用是"配置不被接受"的隐性根因之一。
    const nativeTrack = respTracks.find((t) => t.languageCode === languageCode);
    const isAsr = (track && track.kind === 'asr') || nativeTrack?.kind === 'asr';

    const trackConfig = (currentTrack && typeof currentTrack === 'object')
      ? Object.assign({}, currentTrack)
      : {
        languageCode: languageCode,
        vss_id: (track && track.vss_id) || (isAsr ? `a.${languageCode}` : `.${languageCode}`),
        kind: (track && track.kind) || '',
        displayName: languageCode,
        languageName: languageCode,
        translationLanguage: null
      };

    if (nativeTrack) {
      // 分支一：目标语言在原生 captionTracks 中，直接切原生轨
      const dn = nativeTrack.name?.simpleText || nativeTrack.name?.runs?.[0]?.text || languageCode;
      trackConfig.languageCode = languageCode;
      trackConfig.vss_id = nativeTrack.vssId || nativeTrack.vss_id
        || (track && track.vss_id) || (isAsr ? `a.${languageCode}` : `.${languageCode}`);
      trackConfig.kind = nativeTrack.kind || (track && track.kind) || '';
      trackConfig.displayName = dn;
      trackConfig.languageName = dn;
      trackConfig.translationLanguage = null;
      console.log('[VocabRadar][youtube] 页面拦截: 走原生轨分支', languageCode, 'vss_id=', trackConfig.vss_id, 'kind=', trackConfig.kind);
    } else {
      // 分支二（第一百七十八次新增，此前完全缺失）：目标语言不在 captionTracks 中，
      // 必须走 translationLanguages 翻译轨——保留当前轨道的 languageCode/vss_id 不变，
      // 只改 displayName 与 translationLanguage。旧实现把 languageCode 直接改成目标语言、
      // vss_id 瞎拼 '.xx'，播放器一律不接受 → 白等 8s 必空。
      const tl = respTransLangs.find((t) => t.languageCode === languageCode);
      if (!tl) {
        console.warn('[VocabRadar][youtube] 页面拦截:', languageCode, '既不在 captionTracks 也不在 translationLanguages，放弃路径0');
        return null;
      }
      const tlName = tl.languageName?.simpleText || tl.languageName?.runs?.[0]?.text || languageCode;
      // displayName 形如 "English >> 简体中文"；原名若已含 ">>" 先截掉旧的后半段
      let baseName = String(trackConfig.languageName || trackConfig.displayName || '');
      if (baseName.includes('>>')) baseName = baseName.split('>>')[0].trim();
      trackConfig.displayName = baseName + ' >> ' + tlName;
      trackConfig.translationLanguage = { languageCode: languageCode, languageName: tlName };
      console.log('[VocabRadar][youtube] 页面拦截: 走翻译轨分支 →', trackConfig.displayName);
    }

    console.log('[VocabRadar][youtube] 页面拦截: setOption captions track →', languageCode, 'kind=', trackConfig.kind, 'vss_id=', trackConfig.vss_id);
    player.setOption('captions', 'track', trackConfig);

    // 第一百七十八次（借鉴 VideoSeek）：setOption 后先固定睡 1 秒再进轮询。
    // 播放器切轨是异步的：立刻轮询会在轨道尚未发起请求时空转，且 200ms 一轮的
    // 日志噪声掩盖真实时序。VideoSeek 此处同样是 sleep(1e3)。
    await sleep(1000);

    // 等待页面主世界拦截器捕获响应
    const startTime = Date.now();
    const maxWait = timeout * 1000;

    while (Date.now() - startTime < maxWait) {
      // 检查是否有新增的拦截数据
      if (_pageTimedtextCache.length > beforeCount) {
        console.log('[VocabRadar][youtube] 页面拦截: 新增', (_pageTimedtextCache.length - beforeCount), '条记录, 共', _pageTimedtextCache.length, '条');
        // 查找匹配的拦截数据
        const matched = checkPageCache(languageCode, videoId);
        if (matched) return matched;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // 超时前最后向页面侧回查一次——广播可能因时序落空，但页面缓存里有
    await syncPageTimedtextCache();
    const lastChance = checkPageCache(languageCode, videoId);
    if (lastChance) {
      console.log('[VocabRadar][youtube] 页面拦截: 超时前回查命中');
      return lastChance;
    }

    console.warn('[VocabRadar][youtube] 页面拦截: 等待超时（', timeout, '秒），最终共', _pageTimedtextCache.length, '条记录');
    return null;
  } finally {
    // 恢复原始字幕轨道和状态
    setTimeout(() => {
      try {
        if (prevTrack && typeof player.setOption === 'function') {
          player.setOption('captions', 'track', prevTrack);
        }
        if (wasSubtitlesOn && !player.isSubtitlesOn?.()) {
          player.toggleSubtitlesOn?.();
        } else if (!wasSubtitlesOn && player.isSubtitlesOn?.()) {
          player.toggleSubtitles?.();
        }
      } catch { /* 恢复失败不影响主流程 */ }
    }, 2000);
  }
}
