// VocabRadar 引导页 功能栏 ASR（语音识别 + 录音/录像/录屏 + 麦克风授权）
// 反思（2026-08-20 第八十六次）：用户要求"asr-ocr.js 拆分为 asr.js + ocr.js + 公共模块"。
//   本文件承载：
//     - ASR 消息监听（START_ASR/ASR_AUDIO_SEGMENT 经 SW 中转，ASR_STATUS/ASR_SEGMENT/
//       ASR_ERROR 回传本页，识别结果渲染见 asr-common.js appendResult）
//     - 文件 ASR（Whisper 离线识别，段式发送）
//     - 录音/录像/录屏（媒体流获取 + 浏览器 ASR 实时识别 / Whisper 流式分段）
//     - 麦克风授权与错误分类（acquireMediaStream 在用户手势内直接 getUserMedia）
//   公共基础设施见 asr-common.js；OCR 见 ocr.js（本文件不 import ocr.js）。

import { t } from '../lib/i18n.js';
import {
  S, $, log, toast, formatFileSize,
  showAsrProgress, hideAsrProgress, updateAsrProgressFill,
  translateStage, clearResults, appendResult, setAsrControls,
  showVideoSidebarEmpty
} from './asr-common.js';

// === ASR 消息监听 ===
function ensureMessageListener() {
  if (S.msgListener) return;
  S.msgListener = (msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;
    // ASR_STATUS 不含 videoKey（offscreen 广播），豁免检查
    if (msg.type === 'ASR_STATUS') {
      if (msg.status === 'ready') {
        if (S.recordingActive) showAsrProgress(t('ws.modelReady'), t('ws.recording'));
        else showAsrProgress(t('ws.modelReady'), '');
      } else if (msg.status === 'loading') {
        const pct = Math.round(msg.progress || 0);
        showAsrProgress(t('ws.modelDownloading', { pct }), msg.file || '');
        updateAsrProgressFill(pct);
      } else if (msg.status === 'stage' && msg.stage) {
        showAsrProgress(translateStage(msg.stage), msg.info || '');
      }
      sendResponse({ ok: true });
      return true;
    }
    if (msg.videoKey !== S.videoKey) return false;
    if (msg.type === 'ASR_SEGMENT') {
      handleAsrResponse(msg);
      if (S.pendingResolve) {
        const resolve = S.pendingResolve;
        S.pendingResolve = null;
        resolve(msg);
      }
      sendResponse({ ok: true });
      return true;
    } else if (msg.type === 'ASR_ERROR') {
      const errStr = String(msg.error || '');
      const isFatal = errStr.includes('模型加载失败') || errStr.includes('whisper load failed');
      showAsrProgress(isFatal ? t('ws.modelError') : t('ws.error'), errStr.slice(0, 60));
      setTimeout(() => { if (!S.asrActive && !S.recordingActive) hideAsrProgress(); }, 5000);
      if (isFatal) {
        S.asrAborted = true;
        toast(t('ws.asrModelFail'), { error: true, duration: 5000 });
      }
      if (S.pendingResolve) {
        const resolve = S.pendingResolve;
        S.pendingResolve = null;
        resolve(null);
      }
      sendResponse({ ok: true });
      return true;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(S.msgListener);
}

function handleAsrResponse(msg) {
  const segStart = msg.start;
  const segEnd = msg.end;
  if (msg.chunks && msg.chunks.length > 0) {
    for (const chunk of msg.chunks) {
      const ts0 = (chunk.timestamp && typeof chunk.timestamp[0] === 'number') ? chunk.timestamp[0] : 0;
      const ts1 = (chunk.timestamp && typeof chunk.timestamp[1] === 'number') ? chunk.timestamp[1] : (ts0 + 5);
      const text = (chunk.text || '').trim();
      if (!text) continue;
      appendResult('asr', { start: segStart + ts0, end: segStart + ts1, text });
    }
  } else if (msg.text) {
    const trimmed = String(msg.text).trim();
    if (trimmed) {
      const lines = trimmed.split(/\n+|[。！？.!?]+/).map((s) => s.trim()).filter(Boolean);
      if (lines.length === 0) {
        appendResult('asr', { start: segStart, end: segEnd, text: trimmed });
      } else {
        const per = (segEnd - segStart) / lines.length;
        lines.forEach((line, i) => {
          appendResult('asr', { start: segStart + i * per, end: segStart + (i + 1) * per, text: line });
        });
      }
    }
  }
}

// === 文件 ASR（Whisper） ===
// 反思（2026-08-14 第五十八次）：录制来源改为单选（录音/录像/录屏 radio），
//   「开始识别」按钮统一触发：有文件→文件ASR；选了录制来源→先录制再识别。
async function onAsrClick() {
  if (S.recordingActive) {
    stopRecording();
    return;
  }
  if (S.asrActive) {
    stopAsr();
    return;
  }
  if (!chrome.runtime?.id) {
    toast(t('ws.extUpdated'), { error: true });
    return;
  }
  // 反思（2026-08-16 第七十一次）：⑨ 在线/离线分离——有文件→离线 Whisper（startAsr）；
  //   无文件→默认录音（浏览器 ASR），radio 选中 audio/video/screen 时用对应来源；
  //   删除 avStartTip 死路（旧版无文件无选择时只弹提示不动作）。
  if (S.currentFile && (S.currentFile.kind === 'video' || S.currentFile.kind === 'audio')) {
    await startAsr();
    return;
  }
  await startRecord(S.selectedRecKind || 'audio');
}

// 反思（2026-08-21 第九十一次）：用户明确"引导页的识别按钮，每次点击都要识别"——
//   第九十次按文件缓存回放的方案撤销，每次点击都完整重新识别。

async function startAsr() {
  const asrBtn = $('g-asr-btn');
  asrBtn.classList.add('active');
  asrBtn.textContent = '⏹ ' + t('ws.stop');

  S.asrAborted = false;
  S.asrSegCount = 0;
  S.asrTotalSegs = 0;
  S.videoKey = 'guide-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  ensureMessageListener();
  showAsrProgress(t('ws.preparing'), '');

  let started = false;
  try {
    const startResp = await chrome.runtime.sendMessage({
      type: 'START_ASR',
      videoKey: S.videoKey
    });
    if (!startResp || !startResp.ok) {
      throw new Error(t('ws.asrStartFail') + (startResp && startResp.error || t('ws.noResponse')));
    }
    S.asrActive = true;
    started = true;

    showAsrProgress(t('ws.decoding'), '');
    const pcm = await decodeFileToPcm(S.currentFile.file);
    if (S.asrAborted) return;
    log('音频解码完成: 采样数=', pcm.length, '时长=', (pcm.length / 16000).toFixed(1) + 's');

    const SAMPLE_RATE = 16000;
    const SEGMENT_SEC = 300;
    const segLen = SEGMENT_SEC * SAMPLE_RATE;
    S.asrTotalSegs = Math.max(1, Math.ceil(pcm.length / segLen));
    S.asrSegCount = 0;

    // 第二百一十五次（用户："asr模型可选本地whisper，也能选llm"；"离线整段，在线分片"）：
    //   LLM 引擎离线＝**整段一个请求**——直接读原始上传文件（wav/mp3/m4a 均可）base64
    //   一次发送，不再本地解码分片；回包（无 chunks 的整段文本）走 handleAsrResponse
    //   既有渲染路径（该函数已兼容无 chunks 的回包）。有错就报（不遮蔽）。
    let asrLlmModel = null;
    try {
      const er = await new Promise((r) => chrome.storage.local.get({ asrEngine: 'local', asrLlmModel: 'whisper-1' }, r));
      // 第二百二十五次：引擎值 'llm' 定名 'api'，读侧兼容旧残留 'llm'
      if (er.asrEngine === 'api' || er.asrEngine === 'llm') asrLlmModel = er.asrLlmModel || 'whisper-1';
    } catch (_) { /* 默认本地 */ }
    if (asrLlmModel) {
      showAsrProgress(t('ws.recognizing'), 'LLM');
      const buf = await S.currentFile.file.arrayBuffer();
      if (S.asrAborted) return;
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'ASR_LLM_FILE',
          fileName: (S.currentFile.file && S.currentFile.file.name) || 'audio.wav',
          audioB64: arrayBufferToBase64(buf),
          model: asrLlmModel
        }).then(resolve).catch((e) => resolve({ ok: false, error: String(e.message || e) }));
      });
      if (S.asrAborted) return;
      if (!resp || !resp.ok) {
        const errMsg = String((resp && resp.error) || 'LLM 转写失败');
        showAsrProgress(t('ws.error'), errMsg.slice(0, 60));
        toast('ASR(LLM): ' + errMsg.slice(0, 100), { error: true, duration: 5000 });
        return;
      }
      const pcmAll = await decodeFileToPcm(S.currentFile.file);   // 仅取时长用于结果时间线
      const duration = pcmAll.length / SAMPLE_RATE;
      handleAsrResponse({ type: 'ASR_SEGMENT', videoKey: S.videoKey, start: 0, end: duration, text: resp.text });
      updateAsrProgressFill(100);
      showAsrProgress(t('ws.recognizeDone'), 'LLM');
      setTimeout(() => { if (!S.asrActive) hideAsrProgress(); }, 2000);
      return;
    }

    for (let i = 0; i < pcm.length; i += segLen) {
      if (S.asrAborted) break;
      const seg = pcm.slice(i, Math.min(i + segLen, pcm.length));
      const start = i / SAMPLE_RATE;
      const end = Math.min((i + segLen) / SAMPLE_RATE, pcm.length / SAMPLE_RATE);
      S.asrSegCount++;
      showAsrProgress(t('ws.recognizing'), `${S.asrSegCount}/${S.asrTotalSegs} ${t('ws.segments')}`);
      updateAsrProgressFill(Math.round(((S.asrSegCount - 1) / S.asrTotalSegs) * 100));
      await sendSegmentAndWait(seg, start, end);
    }

    if (!S.asrAborted) {
      updateAsrProgressFill(100);
      showAsrProgress(t('ws.recognizeDone'), `${S.asrTotalSegs} ${t('ws.segments')}`);
      setTimeout(() => { if (!S.asrActive) hideAsrProgress(); }, 2000);
      // 反思（2026-08-16 第七十一次）：⑧ 离线 ASR 空结果完成态——识别完成但没有识别到语音时，
      //   旧版结果盒仍是初始空态提示"识别出的句子将显示在这里"，看起来像从未开始识别。
      //   修正：换"识别完成：未识别到语音"完成态提示 + 日志，明确"已跑完但无语音"。
      if (S.asrResults.length === 0) {
        // 反思（2026-08-21 第八十九次）：ASR 扁平结果列表已移除（结果展示在视频侧栏），
        //   空结果完成态提示改走视频侧栏空态。
        showVideoSidebarEmpty(t('ws.asrEmptyDone'));
        log('ASR 完成: 未识别到语音（0 句）');
      } else {
        log(`ASR 完成: ${S.asrResults.length} 句`);
      }
    }
  } catch (e) {
    const errMsg = String(e && e.message || e);
    log('ASR 失败:', errMsg);
    if (errMsg.includes('Extension context invalidated')) {
      toast(t('ws.extUpdated'), { error: true });
    } else {
      showAsrProgress(t('ws.error'), errMsg.slice(0, 60));
      toast(t('ws.asrFail') + errMsg.slice(0, 80), { error: true, duration: 5000 });
      setTimeout(() => hideAsrProgress(), 5000);
    }
  } finally {
    if (started) {
      stopAsr();
    } else {
      resetAsrButton();
      if (!S.recordingActive) hideAsrProgress();
    }
  }
}

function resetAsrButton() {
  const asrBtn = $('g-asr-btn');
  if (asrBtn) {
    asrBtn.classList.remove('active');
    asrBtn.textContent = '🎤 ' + t('ws.recognize');
  }
}

export function stopAsr() {
  if (!S.asrActive) return;
  S.asrActive = false;
  S.asrAborted = true;
  if (S.pendingResolve) {
    const resolve = S.pendingResolve;
    S.pendingResolve = null;
    resolve(null);
  }
  try {
    chrome.runtime.sendMessage({ type: 'STOP_ASR' }).catch(() => { /* ignore */ });
  } catch (e) { /* ignore */ }
  if (S.msgListener && !S.recordingActive) {
    try { chrome.runtime.onMessage.removeListener(S.msgListener); } catch (e) { /* ignore */ }
    S.msgListener = null;
  }
  resetAsrButton();
  hideAsrProgress();
  log('ASR 已停止');
}

async function decodeFileToPcm(file) {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    try { audioCtx.close(); } catch (e) { /* ignore */ }
  }
  const targetRate = 16000;
  const offlineLen = Math.ceil(audioBuffer.duration * targetRate);
  const offlineCtx = new OfflineAudioContext(1, offlineLen, targetRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

// 反思（2026-08-16 第七十次）：sendMessage 消息上限 64MiB——旧版 audio: Array.from(pcm)
//   把整段 PCM 转成普通数字数组发送（每采样约 8+ 字节），文件 ASR 段为 300s（480 万元素），
//   序列化后超限，报 "Message exceeded maximum allowed size of 64MiB"。
//   修正：改发紧凑 ArrayBuffer（Float32 每采样 4 字节，300s 段约 19MB，远低于上限）；
//   offscreen 接收端已支持 ArrayBuffer（new Float32Array(msg.audio)）。
//   若 pcm 是共享父 buffer 的视图（subarray），只取视图区间，避免整块父 buffer 一起发送。
function pcmToArrayBuffer(pcm) {
  if (pcm instanceof Float32Array) {
    if (pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength) return pcm.buffer;
    return pcm.slice().buffer;
  }
  return new Float32Array(pcm).buffer;
}

function sendSegmentAndWait(pcm, start, end) {
  return new Promise((resolve) => {
    let settled = false;
    const segDur = Math.max(10, end - start);
    const timeoutMs = Math.max(180000, segDur * 3 * 1000);
    const keepAlive = setInterval(() => {
      if (settled || !S.asrActive) { clearInterval(keepAlive); return; }
      chrome.runtime.sendMessage({ type: 'ASR_CHECK' }).catch(() => {});
    }, 20000);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(keepAlive);
      S.pendingResolve = null;
      log('段识别超时(' + (timeoutMs / 1000) + 's), 跳过:', start + 's-' + end + 's');
      resolve(null);
    }, timeoutMs);
    S.pendingResolve = (msg) => {
      if (settled) return;
      settled = true;
      clearInterval(keepAlive);
      clearTimeout(timeout);
      resolve(msg);
    };
    const send = (retryCount) => {
      chrome.runtime.sendMessage({
        type: 'ASR_AUDIO_SEGMENT',
        videoKey: S.videoKey,
        start: start,
        end: end,
        audio: pcmToArrayBuffer(pcm),
        returnTimestamps: true
      }).catch((e) => {
        if (settled) return;
        log('发送段失败(第' + (retryCount + 1) + '次):', e);
        if (retryCount < 2) {
          setTimeout(() => {
            if (settled || !S.asrActive || S.asrAborted) return;
            log('重试发送段:', start + 's-' + end + 's');
            send(retryCount + 1);
          }, 2000);
        }
      });
    };
    send(0);
  });
}

// === 麦克风未授权处理（2026-08-17 第七十二次补充） ===
// Chromium 扩展页 getUserMedia 曾拒后不再弹授权框（需到 edge://settings/content/cameraAndMic 重置）。
function handleMicDenied() {
  // 反思（2026-08-20 第八十六次补充③）：指引含 3 行重置步骤，8s 不够读完，延长到 12s。
  toast(t('ws.micDenied'), { error: true, duration: 12000 });
  log('麦克风未授权（来源=' + (S.selectedRecKind || 'audio') + '），请检查系统麦克风权限设置');
}

// === 麦克风权限（2026-08-20 第八十二次更正） ===
// 反思：Chrome 扩展页 getUserMedia 必须有 manifest 的 audioCapture（麦克风）/
//   videoCapture（摄像头）权限才可用；缺权限时直接抛 NotAllowedError（"Failed due to
//   shutdown"/"Permission dismissed"），且不弹任何授权框。v80 误删这两个权限（误判
//   "Chrome 安装即静默授权"），导致 v81 无论怎么调 getUserMedia 都立即报错、无请求动作
//   （用户实测："录音按钮并不请求话筒权限。没看到任何请求动作，只看到直接报错
//   NotAllowedError Permission denied"）。v79 的真正问题是 init 时 hidden iframe 预热在
//   页面加载时就把授权弹框消耗掉了，点按钮自然没请求；正确做法=保留权限 + 点击「录制」时
//   在主文档直接 getUserMedia（见 acquireMediaStream）。权限声明后浏览器在首次 getUserMedia
//   时（可见扩展页，如本引导页）弹授权框，之后静默可用；被拒/撤销时 NotAllowedError 由
//   handleAcquireError → handleMicDenied 引导重置。此函数（hidden iframe 方案）已废弃删除。

// === 媒体流获取（2026-08-19 第八十一次重构） ===
// 反思：录音/录像的麦克风授权必须发生在用户手势内。旧版点击处理先 await requestMicPermission()
// （hidden iframe + permission.html 的 getUserMedia），再 startRecord 内再 getUserMedia——
// 但 iframe 无独立用户激活、且 await 消耗手势，Chrome 上主文档 getUserMedia 不再弹授权框
// （用户反馈"录音按钮并不请求话筒权限"）。重构：点击按钮时在主文档直接调用 getUserMedia/
// getDisplayMedia 请求流（授权框必弹），授权成功后再进入 startRecord（复用已获取的流）。
async function acquireMediaStream(kind) {
  if (kind === 'screen') {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      return { err: { type: 'no-get-display-media' } };
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
      });
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stream.getTracks().forEach((tr) => tr.stop());
        return { err: { type: 'no-audio-track' } };
      }
      return { stream };
    } catch (e) { return { err: e }; }
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return { err: { type: 'no-get-user-media' } };
  }
  // 反思（2026-08-20 第八十五次）：Edge/Chrome 扩展页麦克风权限曾拒后 getUserMedia 立即失败、
  //   不弹任何授权框（用户反馈"录音按钮并不请求话筒权限，只是无能报错"）。参考 chromium-extensions
  //   开源组工作流：请求前先查 navigator.permissions.query({name:'microphone'}) 仅作诊断日志——
  //   绝不据此阻断（v67/v74 已实证 Edge 扩展页该查询常误报 denied，阻断会拦掉正常授权）；
  //   真实授权以 getUserMedia 的 NotAllowedError 分支为准（handleAcquireError → handleMicDenied）。
  // 反思（2026-08-20 第八十六次）：诊断查询改为 fire-and-forget（不 await）——
  //   await permissions.query 会把 getUserMedia 推迟到其回调之后，消耗用户手势/瞬态激活，
  //   导致 Edge/Chrome 不再弹授权框（v81 已实证"await 消耗手势导致 getUserMedia 不再弹框"）。
  //   现在 getUserMedia 是 acquireMediaStream 的第一个 await，在点击事件的任务内同步调用，
  //   授权框必弹。
  if (kind !== 'screen' && navigator.permissions && typeof navigator.permissions.query === 'function') {
    navigator.permissions.query({ name: 'microphone' }).then((p) => {
      log('麦克风权限状态（请求前）: state=' + p.state);
    }).catch((e) => log('permissions.query 不支持麦克风:', e.message || e));
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === 'video'
        ? { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }
        : { audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false }
    );
    if (kind === 'video') {
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stream.getTracks().forEach((tr) => tr.stop());
        return { err: { type: 'no-audio-track' } };
      }
    }
    return { stream };
  } catch (e) {
    // 诊断（2026-08-20 第八十二次）：记录浏览器麦克风权限状态，排查"录音按钮不请求权限/直接报错"
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      navigator.permissions.query({ name: 'microphone' }).then((s) => {
        log('麦克风权限状态: name=' + s.name + ' state=' + s.state);
      }).catch(() => { /* 查询不支持忽略 */ });
    }
    return { err: e };
  }
}

// 媒体流获取失败处理（含授权被拒判定，三来源统一复用）
function handleAcquireError(kind, err) {
  const type = (err && err.type) || '';
  const name = (err && err.name) || '';
  const msg = String((err && err.message) || err || '');
  const denied = name === 'NotAllowedError' || name === 'PermissionDeniedError' ||
    msg.includes('Permission denied') || msg.includes('NotAllowedError') || msg.includes('denied');
  if (type === 'no-get-display-media') { toast(t('ws.noGetDisplayMedia'), { error: true }); return; }
  if (type === 'no-get-user-media') { toast(t('ws.noGetUserMedia'), { error: true }); return; }
  if (type === 'no-audio-track') { toast(t('ws.noAudioTrack'), { error: true }); return; }
  log('录制启动失败:', kind, name, msg);
  if (kind === 'screen') {
    if (denied) return;
    toast(t('ws.screenStartFail') + msg, { error: true });
  } else if (kind === 'video') {
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      toast(t('ws.cameraNotFound'), { error: true, duration: 5000 });
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      toast(t('ws.cameraInUse'), { error: true, duration: 5000 });
    } else if (denied) {
      toast(t('ws.cameraDenied'), { error: true });
    } else {
      toast(t('ws.recordStartFail') + msg, { error: true });
    }
  } else {
    if (denied) {
      // 反思（2026-08-17 第七十二次补充）：用户明确"禁止弹窗"——授权被拒只 toast，
      //   不再弹模态框。Edge 扩展页 getUserMedia 曾拒后永久拒绝，需手动重置。
      handleMicDenied();
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      toast(t('ws.micNotFound'), { error: true, duration: 5000 });
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      toast(t('ws.micInUse'), { error: true, duration: 5000 });
    } else {
      toast(t('ws.recordStartFail') + msg, { error: true });
    }
  }
}

// === 录音 / 录像 / 录屏 ===
// 反思（2026-08-14 第五十八次）：三来源合并为一个 startRecord(kind)，由「开始识别」按钮统一触发。
// 反思（2026-08-19 第八十一次）：新增 preStream 参数——点击「录制」按钮已预取媒体流（用户手势内
//   请求权限），startRecord 直接复用，不再二次 getUserMedia（避免手势被 await 消耗导致授权框不弹）。
async function startRecord(kind, preStream) {
  if (S.recordingActive) { stopRecording(); return; }
  if (S.asrActive) { toast(t('ws.asrInProgress')); return; }
  if (!chrome.runtime?.id) { toast(t('ws.extUpdated'), { error: true }); return; }
  let stream = preStream || null;
  if (!stream) {
    // 无预取流（如「开始识别」按钮直接录制）：此时仍在用户手势内，直接获取
    const acq = await acquireMediaStream(kind);
    if (acq.err) { handleAcquireError(kind, acq.err); return; }
    stream = acq.stream;
  }
  await beginRecording(stream, kind);
}

function startBrowserAsr(lang) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    log('浏览器不支持 SpeechRecognition，回退到 Whisper 模型');
    toast(t('ws.browserAsrNotSupported'), { error: true });
    return false;
  }
  try {
    S.browserAsr = new SR();
    S.browserAsr.continuous = true;
    S.browserAsr.interimResults = true;
    S.browserAsr.lang = lang || 'en';
    S.browserAsrFinalText = '';
    let lastAppendTime = 0;

    S.browserAsr.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          S.browserAsrFinalText += result[0].transcript;
          const now = Date.now();
          if (now - lastAppendTime > 500) {
            lastAppendTime = now;
            const text = result[0].transcript.trim();
            if (text) appendResult('asr', { start: 0, end: 0, text });
          }
        } else {
          interim += result[0].transcript;
        }
      }
      if (interim) {
        showAsrProgress(t('ws.browserAsrListening'), interim.slice(0, 60));
      }
    };
    S.browserAsr.onerror = (event) => {
      log('浏览器 ASR 错误:', event.error);
      if (event.error === 'no-speech') {
        // 无语音是正常的，不提示
      } else if (event.error === 'not-allowed') {
        toast(t('ws.browserAsrError') + ' permission denied', { error: true });
      } else {
        showAsrProgress(t('ws.browserAsrError'), event.error);
      }
    };
    S.browserAsr.onend = () => {
      if (S.recordingActive && S.browserAsr) {
        try { S.browserAsr.start(); } catch (e) { /* ignore */ }
      }
    };
    S.browserAsr.start();
    log('浏览器 ASR 已启动, lang=', S.browserAsr.lang);
    showAsrProgress(t('ws.browserAsrListening'), '');
    return true;
  } catch (e) {
    log('浏览器 ASR 启动失败:', e);
    return false;
  }
}

function stopBrowserAsr() {
  if (S.browserAsr) {
    try {
      S.browserAsr.onresult = null;
      S.browserAsr.onerror = null;
      S.browserAsr.onend = null;
      S.browserAsr.stop();
    } catch (e) { /* ignore */ }
    S.browserAsr = null;
  }
  S.browserAsrFinalText = '';
}

async function beginRecording(stream, kind) {
  if (S.asrActive) stopAsr();
  clearResults('asr');

  S.recordingActive = true;
  S.recordingKind = kind;
  S.recordingStream = stream;
  S.recordingPcmBuffer = [];
  S.recordingPcmLength = 0;
  S.recordingSegStart = 0;
  // 反思（2026-08-20 第八十六次）：录制状态挂在「录制」按钮上（录音按钮与「开始识别」
  //   按钮完全独立）——仅此按钮在录制期间显示 ⏹ 停止 + 闪烁。
  S.recordingActiveBtn = $('g-asr-record-btn');

  S.recordingChunks = [];
  if (S.recordingBlobUrl) { try { URL.revokeObjectURL(S.recordingBlobUrl); } catch (e) { /* ignore */ } S.recordingBlobUrl = null; }
  try {
    const mimeCandidates = (kind === 'screen' || kind === 'video')
      ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['audio/webm;codecs=opus', 'audio/webm', ''];
    let pickedMime = '';
    for (const m of mimeCandidates) {
      if (!m || MediaRecorder.isTypeSupported(m)) { pickedMime = m; break; }
    }
    S.recordingMediaRecorder = pickedMime
      ? new MediaRecorder(stream, { mimeType: pickedMime })
      : new MediaRecorder(stream);
    S.recordingMediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) S.recordingChunks.push(e.data);
    };
    S.recordingMediaRecorder.start(1000);
  } catch (e) {
    log('MediaRecorder 初始化失败（不影响 ASR）:', e);
    S.recordingMediaRecorder = null;
  }

  S.videoKey = 'guide-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  ensureMessageListener();
  showAsrProgress(t('ws.preparing'), '');
  // 反思（2026-08-20 第八十六次）：录音按钮与「开始识别」按钮完全独立——
  //   录制期间仅「录制」按钮进入录制状态（⏹ 停止 + 闪烁），「开始识别」按钮
  //   保持"🎤 开始识别"并在录制期间禁用（识别与录制互斥，停止录制用「录制」按钮）。
  const recordBtn = S.recordingActiveBtn || $('g-asr-record-btn');
  if (recordBtn) {
    recordBtn.classList.add('recording');
    recordBtn.textContent = '⏹ ' + t('ws.stop');
  }

  // 第二百二十九次（用户："实时语言识别的模型优先级，LLM 浏览器 本地模型，有啥用啥"）：
  //   录音/录像的实时识别引擎按可用性择优——
  //   ①LLM：引擎选了 API 且已配置 地址/Key → 走下方 START_ASR 分段管线（SW 按
  //     asrEngine='api' 分流到 LLM 转写，实时分片）；
  //   ②浏览器：SpeechRecognition 可用 → 浏览器实时识别（本分支）；
  //   ③本地：其余情况（含浏览器不支持）→ 同一分段管线走本地 whisper。
  //   旧版浏览器不支持时直接 return，识别静默落空（与原注释声称的"回退 Whisper"不符）。
  let llmReady = false;
  try {
    const er = await chrome.storage.local.get({ asrEngine: 'local', asrLlmBaseUrl: '', asrLlmApiKey: '' });
    llmReady = (er.asrEngine === 'api' || er.asrEngine === 'llm') && !!(er.asrLlmBaseUrl || er.asrLlmApiKey);
  } catch (e) { /* 默认本地 */ }
  const srSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  const useBrowserAsr = (kind === 'audio' || kind === 'video') && !llmReady && srSupported;

  if (useBrowserAsr) {
    if (S.msgListener) {
      try { chrome.runtime.onMessage.removeListener(S.msgListener); } catch (e) { /* ignore */ }
      S.msgListener = null;
    }
    const videoEl = $('g-asr-video');
    const asrHint = $('g-asr-hint');
    const asrInfo = $('g-asr-file-info');
    // 反思（2026-08-20 第八十五次）：录音时若隐藏 asrHint（min-height 120px），
    //   媒体区高度塌缩，其下方「开始识别」按钮随之上移（用户反馈"chrome录音时识别按钮跟着动了"）。
    //   修正：录音（audio）保持提示区可见并显示录音状态，视频（video）才由视频元素占据媒体区。
    // 反思（2026-08-20 第八十六次）：记录被覆盖的提示区原始 HTML，stopRecording 时恢复
    //   （修复"录完音后仍显示 🎙 录音中..."）。
    if (asrHint) {
      if (kind === 'video') {
        asrHint.style.display = 'none';
      } else {
        asrHint.style.display = '';
        if (S.recordingHintHtml == null) S.recordingHintHtml = asrHint.innerHTML;
        asrHint.textContent = t('ws.audioRecording');
      }
    }
    if (kind === 'video') {
      videoEl.src = '';
      videoEl.srcObject = new MediaStream(stream.getVideoTracks());
      videoEl.muted = true;
      videoEl.style.display = '';
      asrInfo.textContent = t('ws.videoRecording');
      videoEl.play().catch(() => { /* ignore */ });
    } else {
      videoEl.src = '';
      videoEl.srcObject = null;
      videoEl.style.display = 'none';
      asrInfo.textContent = '';
    }
    // 反思（2026-08-20 第八十六次）：录制期间「开始识别」按钮禁用（识别与录制互斥），
    //   停止录制用「录制」按钮（⏹ 停止）。
    const asrBtn = $('g-asr-btn');
    asrBtn.disabled = true;
    asrBtn.title = t('ws.recordingInProgressShort');

    let asrLang = 'en';
    try {
      const stored = await chrome.storage.local.get({ learnLanguage: 'en' });
      if (stored.learnLanguage) asrLang = stored.learnLanguage;
    } catch (e) { /* ignore */ }

    const asrOk = startBrowserAsr(asrLang);
    showAsrProgress(t('ws.recording'), asrOk ? t('ws.realtimeRecognition') : t('ws.browserAsrNotSupported'));
    log('录音/录像已启动（浏览器ASR）: kind=', kind, 'asrOk=', asrOk);
    return;
  }

  let started = false;
  try {
    const startResp = await chrome.runtime.sendMessage({
      type: 'START_ASR',
      videoKey: S.videoKey
    });
    if (!startResp || !startResp.ok) {
      throw new Error(t('ws.asrStartFail') + (startResp && startResp.error || t('ws.noResponse')));
    }
    started = true;

    S.recordingAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (S.recordingAudioCtx.state === 'suspended') {
      try { await S.recordingAudioCtx.resume(); } catch (e) { /* ignore */ }
    }
    const workletUrl = chrome.runtime.getURL('src/lib/asr-worklet-processor.js');
    await S.recordingAudioCtx.audioWorklet.addModule(workletUrl);

    const audioTracks = stream.getAudioTracks();
    const audioOnlyStream = new MediaStream(audioTracks);
    S.recordingSourceNode = S.recordingAudioCtx.createMediaStreamSource(audioOnlyStream);
    S.recordingProcessor = new AudioWorkletNode(S.recordingAudioCtx, 'asr-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      outputChannelCount: [1]
    });
    S.recordingSilenceGain = S.recordingAudioCtx.createGain();
    S.recordingSilenceGain.gain.value = 0;

    S.recordingProcessor.port.onmessage = (e) => {
      if (!S.recordingActive) return;
      S.recordingPcmBuffer.push(e.data);
      S.recordingPcmLength += e.data.length;
    };

    S.recordingSourceNode.connect(S.recordingProcessor);
    S.recordingProcessor.connect(S.recordingSilenceGain);
    S.recordingSilenceGain.connect(S.recordingAudioCtx.destination);

    const videoEl = $('g-asr-video');
    const asrHint = $('g-asr-hint');
    const asrInfo = $('g-asr-file-info');
    if (asrHint) asrHint.style.display = 'none';
    if (kind === 'screen') {
      videoEl.src = '';
      videoEl.srcObject = new MediaStream(stream.getVideoTracks());
      videoEl.muted = true;
      videoEl.style.display = '';
      asrInfo.textContent = t('ws.screenRecording');
      videoEl.play().catch(() => { /* ignore */ });
    } else {
      videoEl.src = '';
      videoEl.srcObject = null;
      videoEl.style.display = 'none';
      asrInfo.textContent = t('ws.audioRecording');
    }

    // 反思（2026-08-20 第八十六次）：录制期间「开始识别」按钮禁用（识别与录制互斥），
    //   停止录制用「录制」按钮（⏹ 停止）。
    const asrBtn = $('g-asr-btn');
    asrBtn.disabled = true;
    asrBtn.title = t('ws.recordingInProgressShort');

    const SEGMENT_SEC = 10;
    const TARGET_RATE = 16000;
    S.recordingSegTimer = setInterval(async () => {
      if (!S.recordingActive) return;
      if (S.recordingPcmLength === 0) {
        S.recordingSegStart += SEGMENT_SEC;
        return;
      }
      const chunks = S.recordingPcmBuffer;
      const length = S.recordingPcmLength;
      S.recordingPcmBuffer = [];
      S.recordingPcmLength = 0;

      const merged = new Float32Array(length);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }

      const segStart = S.recordingSegStart;
      const segEnd = segStart + SEGMENT_SEC;
      S.recordingSegStart = segEnd;
      S.asrSegCount++;
      showAsrProgress(t('ws.recording'), `${t('ws.segments')} ${S.asrSegCount}`);

      try {
        const sourceRate = S.recordingAudioCtx.sampleRate;
        const offlineLen = Math.ceil(length * TARGET_RATE / sourceRate);
        const offlineCtx = new OfflineAudioContext(1, offlineLen, TARGET_RATE);
        const buf = offlineCtx.createBuffer(1, length, sourceRate);
        buf.copyToChannel(merged, 0);
        const src = offlineCtx.createBufferSource();
        src.buffer = buf;
        src.connect(offlineCtx.destination);
        src.start(0);
        const rendered = await offlineCtx.startRendering();
        const pcm = rendered.getChannelData(0);

        chrome.runtime.sendMessage({
          type: 'ASR_AUDIO_SEGMENT',
          videoKey: S.videoKey,
          start: segStart,
          end: segEnd,
          audio: pcmToArrayBuffer(pcm),
          returnTimestamps: true
        }).catch((e) => log('流式段发送失败:', e));
      } catch (e) {
        log('段重采样失败:', e);
      }
    }, SEGMENT_SEC * 1000);

    showAsrProgress(t('ws.recording'), t('ws.realtimeRecognition'));
    log('录音/录屏已启动: kind=', kind, 'sampleRate=', S.recordingAudioCtx.sampleRate);
  } catch (e) {
    log('录音启动失败:', e);
    toast(t('ws.recordStartFail') + String(e && e.message || e), { error: true });
    S.recordingActive = false;
    S.recordingActiveBtn = null;
    // 反思（2026-08-20 第八十六次）：失败时复原「录制」按钮（录制状态挂在它上面，
    //   「开始识别」按钮从未被改写，无需复原）。
    const recordBtn = $('g-asr-record-btn');
    if (recordBtn) {
      recordBtn.classList.remove('recording');
      recordBtn.textContent = '🎙 ' + t('ws.record');
    }
    const asrHint = $('g-asr-hint');
    if (asrHint && S.recordingHintHtml) {
      asrHint.innerHTML = S.recordingHintHtml;
      S.recordingHintHtml = null;
    }
    if (stream) stream.getTracks().forEach((tr) => tr.stop());
    if (S.recordingMediaRecorder) {
      try { S.recordingMediaRecorder.stop(); } catch (e2) { /* ignore */ }
      S.recordingMediaRecorder = null;
    }
    S.recordingChunks = [];
    if (S.recordingAudioCtx) {
      try { S.recordingAudioCtx.close(); } catch (e2) { /* ignore */ }
      S.recordingAudioCtx = null;
    }
    if (started) {
      try { chrome.runtime.sendMessage({ type: 'STOP_ASR' }).catch(() => {}); } catch (e2) { /* ignore */ }
    }
    if (S.msgListener) {
      try { chrome.runtime.onMessage.removeListener(S.msgListener); } catch (e2) { /* ignore */ }
      S.msgListener = null;
    }
    hideAsrProgress();
  }
}

export async function stopRecording() {
  if (!S.recordingActive) return;
  S.recordingActive = false;

  stopBrowserAsr();

  if (S.recordingSegTimer) {
    clearInterval(S.recordingSegTimer);
    S.recordingSegTimer = null;
  }

  if (S.recordingPcmLength > 0 && S.recordingAudioCtx && S.videoKey) {
    const chunks = S.recordingPcmBuffer;
    const length = S.recordingPcmLength;
    const segStart = S.recordingSegStart;
    const SEGMENT_SEC = 10;
    const TARGET_RATE = 16000;
    S.recordingPcmBuffer = [];
    S.recordingPcmLength = 0;
    try {
      const merged = new Float32Array(length);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }
      const sourceRate = S.recordingAudioCtx.sampleRate;
      const offlineLen = Math.ceil(length * TARGET_RATE / sourceRate);
      const offlineCtx = new OfflineAudioContext(1, offlineLen, TARGET_RATE);
      const buf = offlineCtx.createBuffer(1, length, sourceRate);
      buf.copyToChannel(merged, 0);
      const src = offlineCtx.createBufferSource();
      src.buffer = buf;
      src.connect(offlineCtx.destination);
      src.start(0);
      offlineCtx.startRendering().then((rendered) => {
        const pcm = rendered.getChannelData(0);
        const segEnd = segStart + Math.max(1, Math.round(pcm.length / TARGET_RATE));
        return chrome.runtime.sendMessage({
          type: 'ASR_AUDIO_SEGMENT',
          videoKey: S.videoKey,
          start: segStart,
          end: segEnd,
          audio: pcmToArrayBuffer(pcm),
          returnTimestamps: true
        });
      }).catch((e) => log('残余段发送失败:', e));
    } catch (e) {
      log('残余段处理失败:', e);
    }
  }

  let hadMediaRecorder = false;
  if (S.recordingMediaRecorder && S.recordingMediaRecorder.state !== 'inactive') {
    hadMediaRecorder = true;
    const mr = S.recordingMediaRecorder;
    const kind = S.recordingKind;
    await new Promise((resolve) => {
      let resolved = false;
      const finish = () => { if (!resolved) { resolved = true; resolve(); } };
      mr.onstop = () => {
        if (S.recordingChunks.length > 0) {
          const blobType = (kind === 'screen' || kind === 'video') ? 'video/webm' : 'audio/webm';
          const blob = new Blob(S.recordingChunks, { type: blobType });
          S.recordingChunks = [];
          if (S.recordingBlobUrl) { try { URL.revokeObjectURL(S.recordingBlobUrl); } catch (e) { /* ignore */ } }
          S.recordingBlobUrl = URL.createObjectURL(blob);
          if (S.currentFile && S.currentFile.objectURL) {
            try { URL.revokeObjectURL(S.currentFile.objectURL); } catch (e) { /* ignore */ }
          }
          S.currentFile = {
            file: new File([blob], 'recording.webm', { type: blobType }),
            objectURL: S.recordingBlobUrl,
            kind: (kind === 'screen' || kind === 'video') ? 'video' : 'audio'
          };
          const videoEl = $('g-asr-video');
          const asrMedia = $('g-asr-media');
          const asrInfo = $('g-asr-file-info');
          if (videoEl && S.recordingBlobUrl) {
            videoEl.srcObject = null;
            videoEl.src = S.recordingBlobUrl;
            videoEl.muted = false;
            videoEl.style.display = '';
            videoEl.controls = true;
            if (asrMedia) asrMedia.style.display = '';
            if (asrInfo) asrInfo.textContent = (kind === 'screen' ? '🎬 ' : (kind === 'video' ? '📹 ' : '🎙 ')) + formatFileSize(blob.size);
            videoEl.play().catch(() => { /* ignore */ });
          }
        }
        finish();
      };
      setTimeout(finish, 5000);
      try { mr.stop(); } catch (e) { finish(); }
    });
  }
  S.recordingMediaRecorder = null;

  if (S.recordingStream) {
    S.recordingStream.getTracks().forEach((tr) => tr.stop());
    S.recordingStream = null;
  }

  if (S.recordingProcessor) {
    try { S.recordingProcessor.port.onmessage = null; S.recordingProcessor.disconnect(); } catch (e) { /* ignore */ }
    S.recordingProcessor = null;
  }
  if (S.recordingSourceNode) {
    try { S.recordingSourceNode.disconnect(); } catch (e) { /* ignore */ }
    S.recordingSourceNode = null;
  }
  if (S.recordingSilenceGain) {
    try { S.recordingSilenceGain.disconnect(); } catch (e) { /* ignore */ }
    S.recordingSilenceGain = null;
  }
  if (S.recordingAudioCtx) {
    try { S.recordingAudioCtx.close(); } catch (e) { /* ignore */ }
    S.recordingAudioCtx = null;
  }

  if (S.recordingKind === 'screen') {
    try {
      chrome.runtime.sendMessage({ type: 'STOP_ASR' }).catch(() => { /* ignore */ });
    } catch (e) { /* ignore */ }
  }
  const listenerDelay = (S.recordingKind === 'screen') ? 3000 : 0;
  setTimeout(() => {
    if (S.msgListener && !S.asrActive) {
      try { chrome.runtime.onMessage.removeListener(S.msgListener); } catch (e) { /* ignore */ }
      S.msgListener = null;
    }
  }, listenerDelay);

  // 反思（2026-08-20 第八十六次）：录制状态只挂在「录制」按钮上——停止时仅复原它
  //   （🎙 录制），「开始识别」按钮始终为 🎤 开始识别（是否可用由下方 currentFile/
  //   录制成品决定）。
  const recordBtn = S.recordingActiveBtn || $('g-asr-record-btn');
  if (recordBtn) {
    recordBtn.classList.remove('recording');
    recordBtn.textContent = '🎙 ' + t('ws.record');
  }
  S.recordingActiveBtn = null;

  const videoEl = $('g-asr-video');
  if (videoEl) videoEl.srcObject = null;
  // 反思（2026-08-20 第八十六次）：修复"录完音后仍显示 🎙 录音中..."——
  //   beginRecording 录音分支把 asrHint.textContent 改为 ws.audioRecording，stopRecording
  //   旧版只复原 display 未复原 textContent。现统一恢复原始提示（含 data-key span，
  //   本地化文案保留），并按是否产出媒体决定提示区显隐（有录制成品 → 媒体区展示成品、
  //   提示区隐藏）。
  const asrHint = $('g-asr-hint');
  if (asrHint) {
    if (S.recordingHintHtml) {
      asrHint.innerHTML = S.recordingHintHtml;
      S.recordingHintHtml = null;
    }
    asrHint.style.display = hadMediaRecorder ? 'none' : '';
  }
  if (!hadMediaRecorder && videoEl) {
    videoEl.src = '';
    videoEl.style.display = 'none';
  }

  const asrBtn = $('g-asr-btn');
  if (asrBtn) asrBtn.title = '';
  if (S.currentFile && (S.currentFile.kind === 'video' || S.currentFile.kind === 'audio')) {
    asrBtn.disabled = false;
    asrBtn.textContent = '🎤 ' + t('ws.recognize');
  } else if (S.recordingBlobUrl) {
    asrBtn.disabled = false;
    asrBtn.textContent = '🎤 ' + t('ws.recognize');
  } else {
    asrBtn.disabled = true;
    asrBtn.textContent = '🎤 ' + t('ws.recognize');
  }

  showAsrProgress(t('ws.recordingStopped'), '');
  setTimeout(() => hideAsrProgress(), 2000);
  log('录音/录像/录屏已停止');
}

// === 初始化（ASR 侧：录制按钮 / 录制来源单选 / 开始识别按钮） ===
export function initAsr() {
  // 反思（2026-08-15 第六十二次）：用户反馈"asr 录制音频 提示 Click Upload / Record / Video / Screen to start"。
  //   根因：S.selectedRecKind 初始 null，仅 radio change 时赋值；HTML 中 audio radio 默认 checked
  //   但 S 未同步 → 不碰 radio 直接点「录制」误弹 avStartTip。
  //   修正：启动时把已选中的 radio（默认 audio）同步到 S.selectedRecKind。
  const checkedRadio = document.querySelector('input[name="g-asr-source"]:checked');
  if (checkedRadio) S.selectedRecKind = checkedRadio.value;

  // 注册公共模块跨模块控制钩子（onFileUpload 需停 ASR/录制）
  setAsrControls({ stopAsr, stopRecording });

  // 反思（2026-08-15 第六十次）：按用户要求布局——第一行 上传文件 + 录制两个按钮，
  //   录制按钮后跟 (audio, video, screen) 括号内单选。radio 只作来源选择，
  //   点「录制」按钮按所选来源开始/停止录制。
  $('g-asr-record-btn').addEventListener('click', async () => {
    if (S.recordingActive) { stopRecording(); return; }
    if (S.asrActive) { stopAsr(); return; }
    if (!chrome.runtime?.id) { toast(t('ws.extUpdated'), { error: true }); return; }
    // 反思（2026-08-16 第七十一次）：⑨ 在线识别默认录音——无选择时默认 'audio'，
    //   删除 avStartTip 死路（旧版无选择只弹提示不动作，用户以为坏了）。
    // 清除已选文件，避免与录制来源混淆
    if (S.currentFile && S.currentFile.objectURL) {
      try { URL.revokeObjectURL(S.currentFile.objectURL); } catch (e) { /* ignore */ }
    }
    S.currentFile = null;
    const videoEl = $('g-asr-video');
    const asrHint = $('g-asr-hint');
    const asrInfo = $('g-asr-file-info');
    if (videoEl) { videoEl.pause(); videoEl.src = ''; videoEl.srcObject = null; videoEl.style.display = 'none'; }
    if (asrHint) asrHint.style.display = '';
    if (asrInfo) asrInfo.textContent = '';
    const kind = S.selectedRecKind || 'audio';
    // 反思（2026-08-19 第八十一次）：主文档直接请求媒体流（用户手势内 getUserMedia/
    //   getDisplayMedia，Chrome 必弹授权框）——不再经 hidden iframe requestMicPermission：
    //   iframe 无独立用户激活，Chrome 上静默失败/不弹框，且 await 消耗手势导致 startRecord
    //   的 getUserMedia 也不再弹框（用户反馈"录音按钮并不请求话筒权限"）。
    //   明确拒绝才 toast 引导；授权成功后把已获取的流交给 startRecord（不再二次请求）。
    const acq = await acquireMediaStream(kind);
    if (acq.err) { handleAcquireError(kind, acq.err); return; }
    startRecord(kind, acq.stream);
  });
  // 反思（2026-08-14 第五十八次）：录制来源单选（录音/录像/录屏），
  //   选中后作为「录制」按钮的来源。
  document.querySelectorAll('input[name="g-asr-source"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      if (S.recordingActive) stopRecording();
      if (S.asrActive) stopAsr();
      S.selectedRecKind = radio.value;
      log('选择录制来源:', radio.value);
    });
  });
  $('g-asr-btn').addEventListener('click', onAsrClick);
}

export function disposeAsr() {
  if (S.asrActive) stopAsr();
  if (S.recordingActive) stopRecording();
  if (S.msgListener) {
    try { chrome.runtime.onMessage.removeListener(S.msgListener); } catch (e) { /* ignore */ }
    S.msgListener = null;
  }
  if (S.recordingBlobUrl) {
    try { URL.revokeObjectURL(S.recordingBlobUrl); } catch (e) { /* ignore */ }
    S.recordingBlobUrl = null;
  }
}

// 第二百一十五次：ArrayBuffer → base64（分块拼接，避免大文件 apply 栈溢出）
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
  }
  return btoa(binary);
}
