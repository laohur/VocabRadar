// YouTube 音频流提取模块（第九十六次新建）
//
// 基于 youtubei.js（LuanRT/YouTube.js，MIT，vendor 打包于 src/lib/vendor/youtubei.web.bundle.min.js）：
//   Innertube 会话 → getBasicInfo(videoId) → chooseFormat({type:'audio'}) →
//   format.decipher(session.player)——自动完成 base.js 拉取与签名/n 参数转换
//   （即 @distube/ytdl-core 的活，且上游持续维护，见 docs/plan-full-download-asr.md）。
//
// === 运行环境约束 ===
//   decipher 内部用 new Function 求值：扩展页 CSP（script-src 'self' wasm-unsafe-eval）禁止，
//   页面主世界更严；唯独内容脚本隔离世界不受限。本项目 sidebar/asr-client 均在内容脚本世界
//   动态 import 本模块，满足要求。切勿移入 offscreen/SW。
//
// === 返回结构（与 bilibili-audio.getBilibiliAudioInfo 对齐，供下载按钮与 ASR 管线复用）===
//   { url, backupUrls:[], bandwidth, contentType, title }
//
// 失败返回 null，调用方回退 captureStream。

let _innertubePromise = null;

/**
 * 惰性创建 Innertube 会话（单例；失败可重试）
 * youtube.com 同源页面内默认 fetch 即可（InnerTube 请求同源携带 cookie），无需代理。
 */
async function getInnertube() {
  if (!_innertubePromise) {
    _innertubePromise = (async () => {
      const mod = await import(chrome.runtime.getURL('src/lib/vendor/youtubei.web.bundle.min.js'));
      const { Innertube } = mod;
      return await Innertube.create({ retrieve_player: true });
    })().catch((e) => {
      _innertubePromise = null; // 失败不缓存，下次重试
      throw e;
    });
  }
  return _innertubePromise;
}

/** 从当前 URL 提取视频 ID（watch / shorts / live / youtu.be） */
function extractVideoId() {
  try {
    const m = location.href.match(/(?:[?&]v=|\/shorts\/|\/live\/|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

/**
 * 获取当前 YouTube 视频音频流信息（315次：选最低可用音质）
 * 第一百一十二次：多客户端回退链 WEB→IOS→ANDROID→TV_EMBEDDED——
 *   对标 yt-dlp 客户端矩阵策略（PO Token/SABR 按客户端差异放行，见调研文档 3.2）；
 *   全部失败时聚合各客户端原因抛出（sidebar toast 直接可见具体卡点）。
 * 315次（用户"音频下载识别只需要模型支持的精度"）：quality 'best'→'lowest'——
 *   本链路的消费方全部是 ASR 预识别（asr-client/record-workflow 下载→解码 PCM→
 *   Whisper 重采样 16kHz 单声道），低码率轨（如 opus ~50kbps）对识别精度零影响，
 *   下载体积/耗时显著下降。手动排序回退同步改 bitrate 升序取最低。
 * @returns {Promise<{url:string,backupUrls:string[],bandwidth:number,contentType:string,title:string,client:string}>}
 */
export async function getYoutubeAudioInfo() {
  const videoId = extractVideoId();
  if (!videoId) {
    console.warn('[VocabRadar][youtube-audio] 未解析到视频 ID:', location.href);
    throw new Error('no video id: ' + location.href);
  }
  console.log('[VocabRadar][youtube-audio] 初始化 youtubei.js 会话, videoId=' + videoId);
  const yt = await getInnertube();
  const CLIENTS = ['WEB', 'IOS', 'ANDROID', 'TV_EMBEDDED'];
  const reasons = [];
  for (const client of CLIENTS) {
    try {
      const info = await yt.getBasicInfo(videoId, client);
      // chooseFormat：audio 中选最低码率（ASR 精度下限，见 315 次注释）；个别客户端无 streaming_data 时明确记录
      let fmt = null;
      try {
        fmt = info.chooseFormat({ type: 'audio', quality: 'lowest' });
      } catch (e) {
        const audios = (info.streaming_data?.adaptive_formats || []).filter((f) => String(f.mime_type || '').startsWith('audio/'));
        fmt = audios.sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0))[0] || null;
        if (!fmt && e) reasons.push(client + ': ' + (e.message || e));
      }
      if (!fmt) {
        if (!reasons.some((r) => r.startsWith(client + ':'))) reasons.push(client + ': no audio format' + ((info.playability_status && info.playability_status.status) ? (' playability=' + info.playability_status.status) : ''));
        continue;
      }
      const url = fmt.decipher(yt.session.player);
      if (!url) { reasons.push(client + ': decipher empty'); continue; }
      const title = info.basic_info?.title || info.page?.[0]?.video_details?.title || 'youtube_audio';
      console.log(`[VocabRadar][youtube-audio] 音频就绪 client=${client}:`, title, fmt.mime_type, Math.round((fmt.content_length || 0) / 1024) + 'KB');
      return {
        url,
        backupUrls: [],
        bandwidth: fmt.bitrate || 0,
        contentType: (fmt.mime_type || 'audio/mp4').split(';')[0].trim(),
        title: String(title),
        client
      };
    } catch (e) {
      reasons.push(client + ': ' + String(e && e.message || e).slice(0, 80));
    }
  }
  const msg = 'all clients failed | ' + reasons.join(' | ');
  console.warn('[VocabRadar][youtube-audio]', msg);
  throw new Error(msg);
}
