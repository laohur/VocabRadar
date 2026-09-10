// =============================================================================
// vs/record-workflow.js —— 下载音频 / 录音工作流子模块
// -----------------------------------------------------------------------------
// 职责：下载音频按钮全流程（B站音轨信息 → 同源整文件拉取/SW 分块 Range 下载 →
//       Blob 保存）、下载失败后的录制工作流（录制卡片三态 offer/recording/done、
//       全量录制 MediaRecorder、倍率强制原速、完成后留存 Blob 给 ASR）、SW 消息
//       与同源 fetch 小工具（sendMessageSafe/contentWholeFetchDirect）。
// 来源：拆分自 src/content/video-sidebar.js（2026-08-28 拆分第二刀，纯机械搬移）。
// 关系：依赖 ./dom-utils.js（formatTime）、./asr-stage.js（fmtTpl）、
//       ../../lib/i18n.js（t）、../vs-asr-progress.js（showASRProgress/hideASRProgress）、
//       ../../lib/bilibili-audio.js（getBilibiliAudioInfo）、./logger.js（log）；
//       因需使用门面的 toast/getActiveVideo/getRoot/isASRActive/getSubtitlesRef/
//       showNoSubtitle（读写 _cfg/_video/_root/_asrActive/_subtitles 等核心状态），
//       对门面构成受控循环 import——本模块顶层仅初始化自身 let 状态与函数声明，
//       绝不触碰门面绑定，门面绑定调用全部发生在事件回调/异步流程体内（运行时
//       门面已初始化完毕，安全）。原直接引用 _root/_asrActive/_subtitles 的
//       renderRecordCard/restorePanelAfterRecord/removeRecordBar/setRecordCardText
//       机械等价改走 getRoot()/isASRActive()/getSubtitlesRef()。
//       _recordedBlobForASR 状态内聚于本模块，并导出 getter/setter 供门面
//       toggleASR 读写（原 L3116/L3158 的等价接驳）。
// =============================================================================

import { toast, getActiveVideo, getRoot, isASRActive, getSubtitlesRef, showNoSubtitle } from '../video-sidebar.js';
import { formatTime } from './dom-utils.js';
import { fmtTpl } from './asr-stage.js';
import { t } from '../../lib/i18n.js';
import { showASRProgress, hideASRProgress } from '../vs-asr-progress.js';
import { getBilibiliAudioInfo } from '../../lib/bilibili-audio.js';
import { b64ToU8 } from '../../lib/b64.js';
import { log } from './logger.js';

// ⬇️下载音频按钮（第九十六次，替代弹幕按钮）：保存当前视频最高音质原格式音轨文件
// B站：getBilibiliAudioInfo() 取 urls[]（主+备用）；YouTube：youtube-audio.js（ytdl 式）按需动态 import；
// 经 SW FETCH_AUDIO_META + FETCH_AUDIO_RANGE 分块下载（进度条显示百分比），Blob + <a download>
// 锚点保存——无需 chrome.downloads 权限。文件名=视频标题+原容器扩展名。
let _dlAudioBusy = false;
let _recordedBlobForASR = null;   // 第一百一十三次：录制的音频 Blob，留给下次 ASR 使用
let _fullRecorder = null;         // MediaRecorder（全量录制）
let _fullChunks = [];             // 录制数据块
export async function onDownloadAudioClick() {
  const v = getActiveVideo();
  if (!v) {
    toast(t('toast.noVideo'));
    return;
  }
  if (_dlAudioBusy) {
    toast(t('toast.dlAudioBusy'));
    return;
  }
  _dlAudioBusy = true;
  try {
    showASRProgress(t('asr.dlAudioFile'), t('asr.dlGetInfo'));
    const host = location.hostname;
    let info = null;
    if (host.includes('bilibili.com')) {
      info = await getBilibiliAudioInfo();
      if (!info || !info.url) throw new Error(t('dl.noTrack'));
    } else if (host.includes('youtube.com')) {
      const m = await import(chrome.runtime.getURL('src/lib/youtube-audio.js'));
      info = await m.getYoutubeAudioInfo();
      if (!info || !info.url) throw new Error(t('dl.ytFail'));
    } else {
      throw new Error(t('dl.unsupportedSite'));
    }
    // 修复过程自纠（第一百二十六次）：此处原为 `urls.length=0; urls.push(...urls2)`，
    // 但 urls 声明已在上次会话的损坏区段中丢失 → 每次下载必抛 ReferenceError（用户日志实证）。
    // 直接用完整候选列表声明。
    const urls = [info.url, ...(info.backupUrls || [])];
    const parts = [];
    // 第一百零八次：优先内容脚本同源整文件拉取（referer/Origin 与播放器一致，绕开
    // SW 扩展来源被 bilivideo CDN 拒绝的 "Failed to fetch"）；失败回退 SW meta+Range 老路。
    const cWhole = await contentWholeFetchDirect(urls);
    if (cWhole.ok) {
      parts.push(cWhole.ab);
      showASRProgress(t('asr.dlAudioFile'), '100%（' + Math.round(cWhole.ab.byteLength / 1024 / 1024) + 'MB）· ' + t('asr.sameOrigin'));
    } else {
      console.warn('[VocabRadar][video-sidebar] 同源整文件失败，转SW分块:', cWhole.error);
      // 总大小
      const meta = await sendMessageSafe({ type: 'FETCH_AUDIO_META', url: info.url, urls });
      if (!meta || !meta.ok || !meta.size) throw new Error((meta && meta.error) || t('dl.metaProbeFail'));
      // 分块 Range 顺序下载（4MB 块），进度条显示百分比
      const CHUNK = 4 * 1024 * 1024;
      for (let pos = 0; pos < meta.size; pos += CHUNK) {
        const end = Math.min(pos + CHUNK, meta.size) - 1;
        const r = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ type: 'FETCH_AUDIO_RANGE', url: info.url, urls, start: pos, end }, (resp) => {
              if (chrome.runtime.lastError) resolve(null);
              else resolve(resp);
            });
          } catch (e) { resolve(null); }
        });
        // 2026-09-08 第二百四十次：SW 通道返回 base64（chrome.runtime 消息默认 JSON
        //   序列化，ArrayBuffer 直传变 {}），解码为 ArrayBuffer 追加分块
        if (!r || !r.ok || !r.b64) throw new Error((r && r.error) || fmtTpl(t('dl.chunkFail'), { pos }));
        const u8 = b64ToU8(r.b64);
        parts.push(u8.buffer);
        showASRProgress(t('asr.dlAudioFile'), Math.round(((pos + u8.byteLength) / meta.size) * 100) + '%（' + Math.round(meta.size / 1024 / 1024) + 'MB）');
      }
    }
    // 原格式保存：audio/mp4→.m4a；audio/webm→.webm；其余取 mime 子型
    const mime = (info.contentType || info.mime || 'audio/mp4').split(';')[0].trim();
    const ext = mime.includes('webm') ? '.webm' : mime.includes('mp4') ? '.m4a' : mime.includes('mpeg') ? '.mp3' : '.bin';
    const blob = new Blob(parts, { type: mime });
    const filename = ((info.title || 'audio').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 120)) + ext;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    (document.head || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast(t('toast.dlAudioOk'));
    showASRProgress(t('asr.audioSaved'), filename);
    setTimeout(() => { hideASRProgress(); }, 4000);
    log('音频已保存:', filename, Math.round(blob.size / 1024) + 'KB');
  } catch (e) {
    console.warn('[VocabRadar][video-sidebar] 下载音频失败:', e);
    hideASRProgress();
    // 第一百二十六次（用户裁定"失败了也不说"）：失败必须可见——toast 说明原因，
    // 有视频时同时给出录制替代方案条
    const reason = String((e && e.message) || e).slice(0, 80);
    toast(t('toast.dlAudioFail') + reason, { error: true, duration: 6000 });
    if (getActiveVideo()) showRecordOffer();
  } finally {
    _dlAudioBusy = false;
  }
}

/** 下载失败后的录制窗——第一百二十三次改版：字幕区**底部绝对定位单行条**，
 *  提示一行（超长省略），不再滚动面板、不清空字幕内容；三态：offer/recording/done */
let _recPrevRate = null; // 录制前播放倍率，结束后还原
let _recProgTimer = null; // 录制进度刷新定时器
function renderRecordCard(mode, detailText) {
  if (!getRoot()) return;
  const panel = getRoot().querySelector('#beaver-subtitle-panel');
  if (!panel) return;
  let bar = panel.querySelector('#beaver-record-card');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'beaver-record-card';
    // 第一百二十四次（用户裁定）：完整一句话显示，不用省略号压缩——
    // 允许自然折行（flex-wrap），文本占满可用宽度，按钮不被挤走
    bar.style.cssText = [
      'position:absolute', 'left:0', 'right:0', 'bottom:0', 'z-index:3',
      'display:flex', 'flex-wrap:wrap', 'gap:6px 10px', 'align-items:center',
      'padding:8px 12px', 'margin:0',
      'font-size:1em', 'line-height:1.55',
      'border-radius:0',
      'background:var(--beaver-bg-container-high,#f0f3f1)',
      'color:var(--beaver-text,#222)',
      'box-shadow:0 -2px 6px rgba(0,0,0,.10)'
    ].join(';');
    const span = document.createElement('span');
    span.id = 'beaver-record-card-text';
    span.style.cssText = 'flex:1 1 100%;min-width:0;line-height:1.55;';
    bar.appendChild(span);
    panel.appendChild(bar);
  }
  const span = bar.querySelector('#beaver-record-card-text');
  if (span) {
    span.textContent = detailText || t('asr.recordOffer');
  }
  // 按钮区重建（recording/offer 各自按钮集）——紧凑单行尺寸，换行后独占下方
  bar.querySelectorAll('button').forEach((b) => b.remove());
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;flex-shrink:0;';
  if (mode === 'offer') {
    const bRec = document.createElement('button');
    bRec.className = 'beaver-tool-btn';
    bRec.style.cssText = 'font-size:.95em;padding:4px 10px;';
    bRec.textContent = '⏺ ' + t('asr.recordBtn');
    bRec.addEventListener('click', () => { restoreRecRateKeep(); startFullRecording(); });
    const bBack = document.createElement('button');
    bBack.className = 'beaver-tool-btn';
    bBack.style.cssText = 'font-size:.95em;padding:4px 10px;';
    bBack.textContent = t('asr.backBtn');
    bBack.addEventListener('click', () => { restoreRecRate(); restorePanelAfterRecord(); });
    row.appendChild(bRec);
    row.appendChild(bBack);
  } else if (mode === 'recording') {
    const bStop = document.createElement('button');
    bStop.className = 'beaver-tool-btn';
    bStop.style.cssText = 'font-size:.95em;padding:4px 10px;';
    bStop.textContent = '⏹ ' + t('asr.recStop');
    bStop.addEventListener('click', () => {
      try { if (_fullRecorder && _fullRecorder.state !== 'inactive') _fullRecorder.stop(); } catch (e) { /* ignore */ }
    });
    row.appendChild(bStop);
  } else if (mode === 'done') {
    const bClose = document.createElement('button');
    bClose.className = 'beaver-tool-btn';
    bClose.style.cssText = 'font-size:.9em;padding:3px 8px;';
    bClose.textContent = t('asr.backBtn');
    bClose.addEventListener('click', () => { restorePanelAfterRecord(); });
    row.appendChild(bClose);
    setTimeout(() => { restorePanelAfterRecord(); }, 6000);
  }
  bar.appendChild(row);
}

/**
 * 第一百二十三次新增：录制条关闭后的面板恢复——仅在确实无字幕时才显示"无字幕"提示。
 * 反思（用户反馈"点击下载音频后，原来的字幕轨道内容会成空白，不论是自带的还是asr之后的"）：
 * 根因=旧版 offer/done 三态的 [返回]/[关闭]/6s 自动消失一律调 showNoSubtitle()，
 * 该函数把 #beaver-subtitle-panel 整块替换为"无字幕"占位——把下载/录制前已有的
 * 原生或 ASR 字幕全部清掉。修正：有真实字幕时只摘除录制条，面板原样保留。
 */
function restorePanelAfterRecord() {
  removeRecordBar();
  const subsRef = getSubtitlesRef();
  if (getRoot() && !isASRActive() && (!subsRef || subsRef.length === 0)) {
    showNoSubtitle();
  }
}

function removeRecordBar() {
  if (!getRoot()) return;
  const bar = getRoot().querySelector('#beaver-record-bar, #beaver-record-card');
  if (bar) bar.remove();
}

function setRecordCardText(text) {
  if (!getRoot()) return;
  const el = getRoot().querySelector('#beaver-record-card-text');
  if (el) el.textContent = text;
}

/** 录制取消/完成后的倍率还原（保留 _recPrevRate 值由调用方清） */
function restoreRecRateKeep() {
  const v = getActiveVideo();
  if (v && _recPrevRate !== null && isFinite(_recPrevRate)) {
    try { v.playbackRate = _recPrevRate; } catch (e) { /* ignore */ }
    console.log('[VocabRadar][video-sidebar] 播放倍率已还原:', _recPrevRate);
  }
}
function restoreRecRate() {
  restoreRecRateKeep();
  _recPrevRate = null;
}

/** 对外入口（下载失败 catch 调用） */
function showRecordOffer() {
  _recPrevRate = null;
  renderRecordCard('offer', t('asr.recordOffer'));
}

/** 记录并应用录制倍率：返回用户改前的倍率以便结束后还原 */

// 修复过程自纠（第一百二十三次）：上次会话在此遗留"外壳截断的 startFullRecording"
// （声明到 addEventListener('ended') 即断，完整实现被嵌在其内部作为第二个同名函数）
// ——运行时外层先行返回，_fullRecorder.start(1000) 永不执行=录制功能静默失效。
// 本次删除残壳，保留唯一完整实现于下。

/** 全量录制：第一百一十七次——跳回开头完整录制；ended 或手动停止生成文件；
 *  长视频(>90min)在卡片内给出内存/耗时警示；进度百分比实时刷新 */
async function startFullRecording() {
  const v = getActiveVideo();
  if (!v) { toast(t('toast.noVideo')); return; }
  try {
    if (typeof v.captureStream !== 'function') throw new Error('captureStream unavailable');
    // 完整录制：先回到开头再开始采集
    try { v.currentTime = 0; } catch (e) { /* ignore */ }
    try { await v.play(); } catch (e) { /* 自动播放被拦则等用户点播放，采集随播放继续 */ }
    const tracks = v.captureStream().getAudioTracks();
    if (!tracks || tracks.length === 0) throw new Error('no audio track');
    // 记住用户倍率并**强制原速录制**——倍速采集会把变速音频送进模型，识别质量不可用；倍速仅用于"看"，不进录音。
    _recPrevRate = (isFinite(v.playbackRate) && v.playbackRate > 0) ? v.playbackRate : 1;
    try { v.playbackRate = 1; } catch (e) { /* ignore */ }
    _fullChunks = [];
    _fullRecorder = new MediaRecorder(new MediaStream(tracks), { mimeType: 'audio/webm' });
    _fullRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) _fullChunks.push(ev.data); };
    _fullRecorder.onstop = () => finalizeFullRecording();
    // 第一百一十九次：暂停/恢复联动——避免把静音段录进文件
    v.addEventListener('pause', () => { try { if (_fullRecorder && _fullRecorder.state === 'recording') _fullRecorder.pause(); } catch (e) {} });
    v.addEventListener('play', () => { try { if (_fullRecorder && _fullRecorder.state === 'paused') _fullRecorder.resume(); } catch (e) {} });
    const onFinish = () => {
      try { if (_fullRecorder && _fullRecorder.state !== 'inactive') _fullRecorder.stop(); } catch (e) { /* ignore */ }
    };
    v.addEventListener('ended', onFinish, { once: true });
    _fullRecorder.start(1000);
    // 长视频守卫：>90min 提示解码/识别内存与时耗
    const dur = (isFinite(v.duration) && v.duration > 0) ? v.duration : 0;
    renderRecordCard('recording', '⏺ ' + t('asr.recordingUntilEnd') + (dur > 5400 ? (' · ' + t('asr.longWarn')) : ''));
    // 进度实时刷新（500ms）：00:12 / 31:20 (38%)
    if (_recProgTimer) clearInterval(_recProgTimer);
    _recProgTimer = setInterval(() => {
      const vv = getActiveVideo();
      if (!vv || !isFinite(vv.currentTime)) return;
      const cur = vv.currentTime, tot = (isFinite(vv.duration) && vv.duration > 0) ? vv.duration : 0;
      const pct = tot ? Math.round((cur / tot) * 100) : 0;
      const dur = isFinite(vv.duration) && vv.duration > 0 ? vv.duration : 0;
      const warn = dur > 5400 ? (' · ' + t('asr.longWarn')) : '';
      setRecordCardText('⏺ ' + formatTime(cur) + ' / ' + (tot ? formatTime(tot) : '--:--') +
        (tot ? ` (${pct}%)` : '') + (dur > 5400 ? (' · ' + t('asr.longWarn')) : ''));
    }, 500);
    console.log('[VocabRadar][video-sidebar] 全量录制已启动（从0开始，ended/手动停止生成），倍率', _recPrevRate);
  } catch (e) {
    console.warn('[VocabRadar][video-sidebar] 录制启动失败:', e);
    restoreRecRate();
    restorePanelAfterRecord();
  }
}

/** 录制完成：生成 webm 文件保存 + 留存 Blob 给 ASR（不丢弃）+ 还原倍率 */
function finalizeFullRecording() {
  try {
    restoreRecRate();
    if (_recProgTimer) { clearInterval(_recProgTimer); _recProgTimer = null; }
    const blob = new Blob(_fullChunks, { type: 'audio/webm' });
    _fullChunks = [];
    _fullRecorder = null;
    if (!blob.size) { restorePanelAfterRecord(); return; } // 第一百二十三次：不清空已有字幕
    _recordedBlobForASR = blob; // 留给 ASR：下次点击 🎤 直接解码识别
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'beaver_rec_' + Date.now() + '.webm';
    (document.head || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    renderRecordCard('done', t('asr.audioSaved') + ' · ' + t('asr.recSavedForAsr'));
    setTimeout(() => { restorePanelAfterRecord(); }, 6000); // 第一百二十三次：仅摘条不清字幕
    console.log('[VocabRadar][video-sidebar] 录音已生成并存留:', Math.round(blob.size / 1024) + 'KB');
  } catch (e) {
    console.warn('[VocabRadar][video-sidebar] 录音生成失败:', e);
    restorePanelAfterRecord();
  }
}

/** SW 消息小包装（下载音频用；与 asr-client.sendMessage 同风格但独立避免耦合） */
function sendMessageSafe(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp);
      });
    } catch (e) { resolve(null); }
  });
}

/**
 * 内容脚本同源整文件拉取（第一百零八次，与 asr-client contentWholeFetch 同思路）：
 * fetch 于内容脚本世界发起——referer/Origin 与页面播放器自身取流完全一致，
 * 绕开 SW 扩展来源被 bilivideo CDN 拒绝的 "Failed to fetch"。urls 循环回退。
 */
async function contentWholeFetchDirect(urls) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 110000);
  try {
    let lastErr = 'unknown';
    for (const u of urls) {
      if (ctrl.signal.aborted) break;
      try {
        const res = await fetch(u, { credentials: 'omit', signal: ctrl.signal });
        if (res.ok) {
          clearTimeout(timer);
          return { ok: true, ab: await res.arrayBuffer() };
        }
        try { if (res.body) await res.body.cancel(); } catch (e) { /* ignore */ }
        lastErr = 'HTTP ' + res.status;
      } catch (e) {
        if (ctrl.signal.aborted) { lastErr = '超时(110s)'; break; }
        lastErr = String(e && e.message || e);
      }
    }
    clearTimeout(timer);
    return { ok: false, error: lastErr };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: String(e && e.message || e) };
  }
}

// 接驳导出：门面 toggleASR 读取留存录音（原 L3116 `recordedBlob: _recordedBlobForASR`）
function getRecordedBlobForASR() {
  return _recordedBlobForASR;
}

// 接驳导出：门面 toggleASR 消费后清空（原 L3158 `_recordedBlobForASR = null`）
function setRecordedBlobForASR(v) {
  _recordedBlobForASR = v;
}

// 注：onDownloadAudioClick 已在上方以 export async function 声明导出
export { getRecordedBlobForASR, setRecordedBlobForASR };
