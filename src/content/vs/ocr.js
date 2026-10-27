// =============================================================================
// vs/ocr.js —— OCR 截帧识别子模块
// -----------------------------------------------------------------------------
// 职责：OCR 按钮点击处理（canvas 截取当前视频帧 → OCR_RECOGNIZE 消息经 SW 转发到
//       LLM 视觉识别 → 结果以 {start,text} 条目写入字幕轨道 appendASRSubtitle）。
// 关系：依赖 ./dom-utils.js（flashButton）；因需使用门面的 toast/getActiveVideo/
//       getRoot/getVideoLearnLang（读写 _cfg/_video/_root/_videoLearnLang），
//       对门面构成受控循环 import——本模块顶层仅初始化自身 let 状态与函数声明，
//       绝不触碰门面绑定，门面绑定调用全部发生在异步流程体内（运行时门面已初始
//       化完毕，安全）。原 L2899 `_root.querySelector(...)` 改走 getRoot()、
//       原 L2918 `_videoLearnLang` 改走 getVideoLearnLang()。
// =============================================================================

import { toast, getActiveVideo, getRoot, getVideoLearnLang, isASRActive } from '../video-sidebar.js';
import { appendASRSubtitle } from './subtitle-renderer.js';
import { isOCRTrackSelected, selectOCRTrack } from './tracks.js';
import { saveOCRSegment } from './ocr-store.js';
import { flashButton, makeVideoKey } from './dom-utils.js';
// OCR 用户可见提示走 i18n（用户："英文哪来的中文提示？"）
import { t } from '../../lib/i18n.js';

let _ocrRunning = false;     // OCR 进行中

// === OCR 按钮：点击识别当前视频帧 ===
// 用户裁定"OCR 内容当作字幕而不是孤立窗口"+"OCR 是跟 ASR 并列的字幕轨道"：
//   识别结果不弹孤立面板（#beaver-ocr-panel 已拆除），改入 OCR 独立字幕轨道——
//   段先存 ocr_store（ocr_cache_${videoKey}，唯一真相源），再按当前轨分流上屏：
//   已在 OCR 轨 → appendASRSubtitle 实时上屏（排序/注释/高亮/overlay 全链复用）；
//   ASR 识别中 → 不打断仅存轨提示；其余轨道 → 自动切到 OCR 轨全量展示。
//   时间戳取截帧瞬间 currentTime（等待识别期间播放会继续），end=start+5。
//   流程：canvas 截帧 → dataURL → OCR_RECOGNIZE → SW → LLM 视觉识别 → 返回。
export async function onOcrClick() {
  if (_ocrRunning) {
    console.log('[VocabRadar][video-sidebar] OCR 跳过: 正在运行中');
    return;
  }
  // 前置检查：扩展上下文是否有效（扩展重载后旧 content script 会失效）
  if (!chrome.runtime?.id) {
    console.warn('[VocabRadar][video-sidebar] OCR 跳过: 扩展上下文已失效（chrome.runtime.id 为空）');
    toast(t('ocr.extUpdated'));
    return;
  }
  const video = getActiveVideo();
  if (!video || !video.videoWidth || !video.videoHeight) {
    console.warn('[VocabRadar][video-sidebar] OCR 跳过: 未找到可用视频元素');
    toast(t('ocr.noVideo'));
    return;
  }
  _ocrRunning = true;
  flashButton(getRoot().querySelector('#beaver-ocr'));
  const _ocrStart = Date.now();
  console.log('[VocabRadar][video-sidebar] OCR 开始: video=' + video.videoWidth + 'x' + video.videoHeight + ' time=' + video.currentTime.toFixed(1) + 's');
  try {
    // 截取当前视频帧
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // 时间戳取截帧瞬间的 currentTime：等待识别期间播放会继续，不能用响应时刻
    const ocrTime = video.currentTime;
    const dataUrl = canvas.toDataURL('image/png');
    console.log('[VocabRadar][video-sidebar] OCR 截帧完成: dataUrl 长度=' + dataUrl.length + ' (' + ((dataUrl.length / 1024).toFixed(0)) + 'KB)');

    // 经 SW 转发给 OCR 引擎（LLM 视觉识别）
    console.log('[VocabRadar][video-sidebar] OCR 发送 OCR_RECOGNIZE 消息到 SW');
    const resp = await chrome.runtime.sendMessage({
      type: 'OCR_RECOGNIZE',
      imageDataUrl: dataUrl,
      // OCR 语言随 learnLanguage（zh→chi_sim，其余→eng）
      lang: getVideoLearnLang() || 'en'
    });
    const _ocrCost = ((Date.now() - _ocrStart) / 1000).toFixed(2);
    if (!resp || !resp.ok) {
      const errMsg = resp && resp.error ? resp.error : t('ocr.unknownErr');
      console.warn('[VocabRadar][video-sidebar] OCR 失败: ' + errMsg + ', 耗时=' + _ocrCost + 's, resp=', resp);
      toast(t('ocr.failPrefix') + errMsg);
      return;
    }
    const result = resp.text || '';
    console.log('[VocabRadar][video-sidebar] OCR 响应: 耗时=' + _ocrCost + 's, 结果长度=' + result.length + ', 前50字=' + JSON.stringify(result.slice(0, 50)));

    if (!result.trim()) {
      console.log('[VocabRadar][video-sidebar] OCR 未识别到文字（结果为空）');
      toast(t('ocr.noText'));
      return;
    }

    // OCR 独立字幕轨道写入（见文件头注释）：段入 ocr_store 后按当前轨分流
    const seg = { start: ocrTime, end: ocrTime + 5, text: result };
    try {
      await saveOCRSegment(makeVideoKey(), seg);
    } catch (e) {
      console.warn('[VocabRadar][video-sidebar] OCR 段存轨失败:', e);
    }
    if (isOCRTrackSelected()) {
      // ① 已在 OCR 轨：实时上屏（fire-and-forget，同 asr-flow.js onText 口径）
      appendASRSubtitle(seg).catch((e) =>
        console.warn('[VocabRadar][video-sidebar] OCR 字幕写入轨道失败:', e));
    } else if (isASRActive()) {
      // ② ASR 识别中：不打断当前 ASR 轨显示，仅存轨提示
      toast(t('ocr.storedTrack'));
    } else {
      // ③ 其余轨道：自动切到 OCR 轨全量展示（点 📷 即见结果）
      try { await selectOCRTrack(); } catch (e) {
        console.warn('[VocabRadar][video-sidebar] OCR 自动切轨失败:', e);
      }
    }
  } catch (e) {
    const _ocrCost = ((Date.now() - _ocrStart) / 1000).toFixed(2);
    const errMsg = String(e && e.message ? e.message : e);
    console.error('[VocabRadar][video-sidebar] OCR 异常: 耗时=' + _ocrCost + 's, error=', e, 'stack=', e && e.stack);
    // 扩展上下文失效（扩展重载后旧 content script 仍在页面上）
    if (errMsg.includes('Extension context invalidated')) {
      toast(t('ocr.extUpdated'), { error: true, duration: 8000 });
    } else {
      // OCR 失败改 error 样式 + 8 秒，让用户看到
      toast(t('ocr.failPrefix') + errMsg, { error: true, duration: 8000 });
    }
  } finally {
    _ocrRunning = false;
  }
}
