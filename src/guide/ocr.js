// VocabRadar 引导页 功能栏 OCR（文字识别 + 拍照）
// 反思（2026-08-20 第八十六次）：用户要求"asr-ocr.js 拆分为 asr.js + ocr.js + 公共模块"。
//   本文件承载：
//     - 拍照（getUserMedia 摄像头 → 截帧为 dataURL）
//     - 图片载入（loadOcrImage：上传图片/拍照共用，载入展示区并启用「开始识别」）
//     - 文字识别（OCR_RECOGNIZE 经 SW 中转至 offscreen Tesseract，语言随 sourceLanguage）
//   ASR/录制控制从 asr.js 导入（loadOcrImage 需停 ASR/录制），公共基础设施见 asr-common.js。

import { t } from '../lib/i18n.js';
import { S, $, log, toast, flashButton, clearResults, appendResult, formatFileSize } from './asr-common.js';
import { stopAsr, stopRecording } from './asr.js';

// === 拍照（摄像头） ===
async function onCapturePhotoClick() {
  if (!chrome.runtime?.id) { toast(t('ws.extUpdated'), { error: true }); return; }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    toast(t('ws.noGetUserMedia'), { error: true });
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
  } catch (e) {
    const msg = String(e && e.message || e);
    const errName = e && e.name || '';
    log('摄像头启动失败:', errName, msg);
    if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
      toast(t('ws.cameraNotFound'), { error: true, duration: 5000 });
    } else if (errName === 'NotReadableError' || errName === 'TrackStartError') {
      toast(t('ws.cameraInUse'), { error: true, duration: 5000 });
    } else if (msg.includes('Permission denied') || msg.includes('NotAllowedError') || msg.includes('denied')) {
      toast(t('ws.cameraDenied'), { error: true });
    } else {
      toast(t('ws.cameraStartFail') + msg, { error: true });
    }
    return;
  }
  showCameraModal(stream);
}

function showCameraModal(stream) {
  let modal = document.getElementById('g-camera-modal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'g-camera-modal';
  modal.className = 'g-camera-modal';

  const video = document.createElement('video');
  video.className = 'g-camera-video';
  video.srcObject = stream;
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  modal.appendChild(video);

  const actions = document.createElement('div');
  actions.className = 'g-camera-actions';

  const captureBtn = document.createElement('button');
  captureBtn.className = 'g-camera-capture';
  captureBtn.textContent = t('ws.captureRecognize');
  captureBtn.addEventListener('click', async () => {
    if (!video.videoWidth || !video.videoHeight) {
      toast(t('ws.cameraNotReady'));
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    stream.getTracks().forEach((tr) => tr.stop());
    modal.remove();
    // 反思（2026-08-14 第五十八次）：拍照只载入展示区并启用「开始识别」，
    //   不再自动识别，与上传图片流程一致（OCR 同构：输入→展示→识别→结果）。
    loadOcrImage(dataUrl, `${t('ws.photo')} (${canvas.width}x${canvas.height})`);
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'g-camera-close';
  closeBtn.textContent = t('ws.cancel');
  closeBtn.addEventListener('click', () => {
    stream.getTracks().forEach((tr) => tr.stop());
    modal.remove();
  });

  actions.appendChild(captureBtn);
  actions.appendChild(closeBtn);
  modal.appendChild(actions);
  document.body.appendChild(modal);
  video.play().catch(() => { /* ignore */ });

  const escHandler = (e) => {
    if (e.key === 'Escape') {
      stream.getTracks().forEach((tr) => tr.stop());
      modal.remove();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

// === OCR ===
// 载入图片到展示区并启用「开始识别」（上传/拍照共用）
function loadOcrImage(dataUrl, fileInfo) {
  if (S.asrActive) stopAsr();
  if (S.recordingActive) stopRecording();
  S.selectedRecKind = null;
  document.querySelectorAll('input[name="g-asr-source"]').forEach((r) => { r.checked = false; });
  if (S.currentFile && S.currentFile.objectURL) {
    try { URL.revokeObjectURL(S.currentFile.objectURL); } catch (e) { /* ignore */ }
  }
  if (S.recordingBlobUrl) {
    try { URL.revokeObjectURL(S.recordingBlobUrl); } catch (e) { /* ignore */ }
    S.recordingBlobUrl = null;
  }
  // dataURL 直接作为 objectURL（同一扩展页内可播放/绘制）
  S.currentFile = { file: null, objectURL: dataUrl, kind: 'image' };

  const imageEl = $('g-ocr-image');
  const videoEl = $('g-asr-video');
  const ocrHint = $('g-ocr-hint');
  const asrHint = $('g-asr-hint');
  const ocrInfo = $('g-ocr-file-info');
  if (imageEl) { imageEl.src = dataUrl; imageEl.style.display = ''; }
  if (videoEl) { videoEl.pause(); videoEl.src = ''; videoEl.srcObject = null; videoEl.style.display = 'none'; }
  if (ocrHint) ocrHint.style.display = 'none';
  if (asrHint) asrHint.style.display = '';
  if (ocrInfo) ocrInfo.textContent = fileInfo || '';
  const asrBtn = $('g-asr-btn');
  const ocrBtn = $('g-ocr-btn');
  if (asrBtn) asrBtn.disabled = true;
  if (ocrBtn) { ocrBtn.disabled = false; ocrBtn.textContent = '📷 ' + t('ws.recognize'); }
  clearResults('ocr');
  log('图片已载入展示区');
}

async function onOcrClick() {
  if (S.ocrRunning) return;
  if (!S.currentFile || S.currentFile.kind !== 'image') {
    toast(t('ws.ocrBtnTitle'));
    return;
  }
  if (!chrome.runtime?.id) { toast(t('ws.extUpdated'), { error: true }); return; }
  const img = $('g-ocr-image');
  if (!img || !img.naturalWidth) {
    toast(t('ws.imgNotLoaded'));
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/png');
  log('OCR 截帧完成: dataUrl 长度=' + dataUrl.length);

  const fname = (S.currentFile && S.currentFile.file) ? S.currentFile.file.name : '';
  const fsize = (S.currentFile && S.currentFile.file) ? S.currentFile.file.size : 0;
  await runOcrFromDataUrl(dataUrl, `${fname} (${formatFileSize(fsize)})`);
}

async function runOcrFromDataUrl(dataUrl, fileInfo) {
  if (S.ocrRunning) {
    toast(t('ws.ocrRunning'));
    return;
  }
  if (!chrome.runtime?.id) { toast(t('ws.extUpdated'), { error: true }); return; }
  S.ocrRunning = true;
  const ocrBtn = $('g-ocr-btn');
  if (ocrBtn) {
    flashButton(ocrBtn);
    ocrBtn.disabled = true;
  }
  const start = Date.now();
  log('OCR 开始 (dataUrl)');
  try {
    const imageEl = $('g-ocr-image');
    const videoEl = $('g-asr-video');
    const ocrHint = $('g-ocr-hint');
    const asrHint = $('g-asr-hint');
    if (ocrHint) ocrHint.style.display = 'none';
    if (asrHint) asrHint.style.display = '';
    imageEl.src = dataUrl;
    imageEl.style.display = '';
    videoEl.style.display = 'none';
    videoEl.srcObject = null;
    const ocrInfo = $('g-ocr-file-info');
    if (ocrInfo) ocrInfo.textContent = fileInfo || '';

    const resp = await chrome.runtime.sendMessage({
      type: 'OCR_RECOGNIZE',
      imageDataUrl: dataUrl,
      // 反思（2026-08-16 第六十六次）：OCR 语言随 sourceLanguage（zh→chi_sim，其余→eng）
      lang: S.sourceLang || 'en'
    });
    const cost = ((Date.now() - start) / 1000).toFixed(2);
    if (!resp || !resp.ok) {
      const errMsg = resp && resp.error ? resp.error : '未知错误';
      log('OCR 失败:', errMsg, '耗时=' + cost + 's');
      toast(t('ws.ocrFail') + errMsg, { error: true });
      return;
    }
    const result = resp.text || '';
    log('OCR 响应: 耗时=' + cost + 's, 结果长度=' + result.length);
    if (!result.trim()) {
      toast(t('ws.ocrNoText'));
      return;
    }
    clearResults('ocr');
    const lines = result.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
      appendResult('ocr', { text: line });
    }
    toast(t('ws.ocrDone') + lines.length + ' ' + t('ws.ocrLines'));
  } catch (e) {
    const errMsg = String(e && e.message ? e.message : e);
    log('OCR 异常:', errMsg);
    if (errMsg.includes('Extension context invalidated')) {
      toast(t('ws.extUpdated'), { error: true });
    } else {
      toast(t('ws.ocrFail') + errMsg, { error: true });
    }
  } finally {
    S.ocrRunning = false;
    if (ocrBtn) {
      ocrBtn.disabled = !(S.currentFile && S.currentFile.kind === 'image');
    }
  }
}

// === 初始化（OCR 侧：拍照按钮 / 开始识别按钮） ===
export function initOcr() {
  $('g-capture-photo').addEventListener('click', onCapturePhotoClick);
  $('g-ocr-btn').addEventListener('click', onOcrClick);
}

export function disposeOcr() {
  S.ocrRunning = false;
}