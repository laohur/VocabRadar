// =============================================================================
// vs/ocr.js —— OCR 截帧识别子模块
// -----------------------------------------------------------------------------
// 职责：OCR 按钮点击处理（canvas 截取当前视频帧 → OCR_RECOGNIZE 消息经 SW 转发到
//       offscreen Tesseract.js → 结果以 'beaver-ocr-result' 自定义事件发给
//       text-hint.js 显示）。
// 来源：拆分自 src/content/video-sidebar.js（2026-08-28 拆分第二刀，纯机械搬移）。
// 关系：依赖 ./dom-utils.js（flashButton）；因需使用门面的 toast/getActiveVideo/
//       getRoot/getVideoLearnLang（读写 _cfg/_video/_root/_videoLearnLang），
//       对门面构成受控循环 import——本模块顶层仅初始化自身 let 状态与函数声明，
//       绝不触碰门面绑定，门面绑定调用全部发生在异步流程体内（运行时门面已初始
//       化完毕，安全）。原 L2899 `_root.querySelector(...)` 改走 getRoot()、
//       原 L2918 `_videoLearnLang` 改走 getVideoLearnLang()。
// =============================================================================

import { toast, getActiveVideo, getRoot, getVideoLearnLang } from '../video-sidebar.js';
import { flashButton } from './dom-utils.js';
// 第二百三十九次：OCR 用户可见提示走 i18n（用户："英文哪来的中文提示？"）
import { t } from '../../lib/i18n.js';

let _ocrRunning = false;     // OCR 进行中

// === OCR 按钮：点击识别当前视频帧 ===
// 反思（2026-08-05 修正）：用户要求"ocr改为之前，点击识别当前帧，受文本提示影响"。
//   旧版改为上传图片识别，但很多视频无法右键识别，且用户要求回归点击截帧。
//   修正：改回截取当前视频帧（canvas.drawImage(video)），结果通过自定义事件
//   发送到 text-hint.js 显示在 OCR 结果面板（不自动消失，生词受文本提示注释）。
//   流程：canvas 截帧 → dataURL → OCR_RECOGNIZE → SW → offscreen Tesseract.js → 返回
//   结果通过 window.dispatchEvent 发送 'beaver-ocr-result' 事件，text-hint.js 监听
//   并调用 showOcrResultPanel 显示（light DOM 面板，生词被 processTextNode 注释）。
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
    const dataUrl = canvas.toDataURL('image/png');
    console.log('[VocabRadar][video-sidebar] OCR 截帧完成: dataUrl 长度=' + dataUrl.length + ' (' + ((dataUrl.length / 1024).toFixed(0)) + 'KB)');

    // 通过 SW 转发到 offscreen 运行 Tesseract.js
    console.log('[VocabRadar][video-sidebar] OCR 发送 OCR_RECOGNIZE 消息到 SW');
    const resp = await chrome.runtime.sendMessage({
      type: 'OCR_RECOGNIZE',
      imageDataUrl: dataUrl,
      // 反思（2026-08-16 第六十六次）：OCR 语言随 learnLanguage（zh→chi_sim，其余→eng）
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

    // 通过自定义事件发送到 text-hint.js（同页面 content script 通信）
    // text-hint.js 监听 'beaver-ocr-result' 事件，调用 showOcrResultPanel 显示结果
    // 结果面板为 light DOM，生词受文本提示注释（高亮+侧邻注释），不自动消失
    window.dispatchEvent(new CustomEvent('beaver-ocr-result', {
      detail: {
        text: result,
        info: result.trim() ? '' : t('ocr.noText')
      }
    }));
    if (!result.trim()) {
      console.log('[VocabRadar][video-sidebar] OCR 未识别到文字（结果为空）');
    }
  } catch (e) {
    const _ocrCost = ((Date.now() - _ocrStart) / 1000).toFixed(2);
    const errMsg = String(e && e.message ? e.message : e);
    console.error('[VocabRadar][video-sidebar] OCR 异常: 耗时=' + _ocrCost + 's, error=', e, 'stack=', e && e.stack);
    // 扩展上下文失效（扩展重载后旧 content script 仍在页面上）
    if (errMsg.includes('Extension context invalidated')) {
      toast(t('ocr.extUpdated'), { error: true, duration: 8000 });
    } else {
      // 第一百七十八次：同上——OCR 失败改 error 样式 + 8 秒，让用户看到
      toast(t('ocr.failPrefix') + errMsg, { error: true, duration: 8000 });
    }
  } finally {
    _ocrRunning = false;
  }
}
