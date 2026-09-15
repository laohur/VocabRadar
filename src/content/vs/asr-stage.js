// =============================================================================
// vs/asr-stage.js —— ASR 阶段消息分发子模块
// -----------------------------------------------------------------------------
// 职责：ASR 阶段时间线诊断日志（_diagLines/pushDiagLine/clearDiagLines，第一百零
//       三次起按用户裁定改为仅日志、不渲染 DOM）、内部阶段集合 ASR_INTERNAL_STAGES、
//       模板插值 fmtTpl、把 asr-client 的 onStatus stage 消息分发到进度条
//       （updateASRProgressFromStage）。
// 来源：拆分自 src/content/video-sidebar.js（2026-08-28 拆分第二刀，纯机械搬移）。
// 关系：依赖 ./dom-utils.js（formatTime）、../../lib/i18n.js（t）、
//       ../vs-asr-progress.js（showASRProgress/updateASRProgressFill）、
//       ./playback-gate.js（evaluateGate）；因需读取门面的 getRoot（_root）与
//       getActiveVideo（_video），对门面构成受控循环 import——本模块顶层仅初始化
//       自身 const/function，绝不触碰门面绑定，门面绑定调用全部发生在函数体内
//       （运行时门面已初始化完毕，安全）。原 L3243 `if (!_root || !s) return;`
//       机械等价改写为 `if (!getRoot() || !s) return;`。
//       被门面（toggleASR 内 pushDiagLine/clearDiagLines/updateASRProgressFromStage）
//       与 ./record-workflow.js（fmtTpl）引用。
// =============================================================================

import { getRoot, getActiveVideo } from '../video-sidebar.js';
import { formatTime } from './dom-utils.js';
import { t } from '../../lib/i18n.js';
import { showASRProgress, updateASRProgressFill } from '../vs-asr-progress.js';
import { evaluateGate } from './playback-gate.js';

// === ASR 阶段时间线（第一百零二次引入；第一百零三次按用户裁定改为仅日志）===
// "侧栏展示调试大逆不道，只能日志"——不再渲染任何 DOM，统一打
// console.log('[VocabRadar][asr][diag] …')，可用控制台过滤 'ASR][diag' 查看全链路。
const _diagLines = [];
function pushDiagLine(text) {
  const d = new Date();
  const ts = d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  _diagLines.push('[' + ts + '] ' + text);
  if (_diagLines.length > 200) _diagLines.shift();
  console.log('[VocabRadar][asr][diag][' + ts + '] ' + text);
}

// 接驳导出：门面 toggleASR 开始新会话时清空时间线（原门面内 `_diagLines.length = 0;` 的等价迁移）
function clearDiagLines() {
  _diagLines.length = 0;
}

// === ASR 进度条辅助函数 ===
// 显示音频总长、识别段落进度（当前段/总段数）、当前阶段状态
// 第一百三十八次拆分第一刀：showASRProgress/hideASRProgress/updateASRProgressFill
// 已迁至 vs-asr-progress.js（见文件头 import 与 initAsrProgress 注入）。

/**
 * 从 onStatus 的 stage 消息解析进度并更新进度条
 * asr-client 推送的 stage 消息含以下字段：
 *   B站路径：
 *   - bili-audio-url / bili-download / bili-decode / bili-pcm：音频准备阶段
 *   - bili-start：含 totalRecogSegs 和 duration
 *   - bili-seg：含 segIdx / totalSegs / segStart / segEnd / duration：正在识别某段
 *   - bili-seg-ok：段识别完成
 *   - bili-done：全部完成
 *   回退路径：
 *   - fallback-start：回退采集启动
 *   - fallback-seg：含 segIdx / totalSegs / segStart / segEnd / duration：音频段采集
 *   - fallback-silent：无 PCM（AudioContext 挂起）
 *   - fallback-skip：全静音跳过
 *   - fallback-pcm：段处理中
 * @param {{stage:string, info:string, segIdx?:number, totalSegs?:number, segStart?:number, segEnd?:number, duration?:number, totalRecogSegs?:number}} s
 */
// 第一百零五次（用户裁定）：ASR 进度条只显示对用户有必要的状态；
// 内部过程阶段只写日志（[ASR][diag]），不再驱动进度条文字/百分比刷屏。
const ASR_INTERNAL_STAGES = new Set([
  'seg-recv',                                   // 段结果诊断
  'bili-audio-url', 'bili-meta', 'bili-meta-fail', 'bili-init', 'bili-decode',
  'bili-dl', 'bili-dl-ok', 'bili-dl-retry',     // 后台下载细节
  'bili-backfill', 'bili-backfill-recog',       // 回填细节
  'yt-audio',                                   // YouTube 取流细节
  'fallback', 'fallback-start', 'fallback-snap', 'fallback-silent', 'fallback-skip', 'fallback-pcm'
]);
// 第一百一十次：简单模板插值（'Recognizing {i}/{n}'）
export function fmtTpl(tpl, params) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (params && params[k] !== undefined) ? String(params[k]) : '');
}
export function updateASRProgressFromStage(s) {
  if (!getRoot() || !s) return;
  const stage = s.stage || '';
  const info = s.info || '';
  // 全阶段入诊断日志（仅 console，[ASR][diag] 前缀可过滤）
  pushDiagLine(stage + (info ? ' · ' + info : '') +
    (typeof s.frontier === 'number' && isFinite(s.frontier) && stage === 'gate' ? ' @' + formatTime(s.frontier) : ''));
  // 内部阶段：到此为止，不干扰用户
  if (ASR_INTERNAL_STAGES.has(stage)) return;

  // 音频准备阶段（B站）——第一百一十次：标签全部走 i18n
  // 322次：阶段标题固定英文直文本（同 321 批 detail 串口径，不走 t() 不随界面语言）；
  //   原用 i18n 键已删（孤儿键清理），仅 dlAudioDone/fallbackMode 留有其他消费点
  const prepStages = {
    'bili-audio-url': 'Fetching audio',
    'bili-meta': 'Probing audio',
    'bili-meta-fail': 'Meta probe failed',
    'bili-init': 'Parsing audio header',
    'bili-first-ok': 'First chunk ready',
    'bili-download': 'Downloading audio',
    'bili-download-ok': 'Audio downloaded',
    'bili-download-fail': 'Audio download failed',
    'bili-decode': 'Decoding audio',
    'bili-decode-ok': 'Audio decoded',
    'bili-decode-fail': 'Decode failed',
    'bili-pcm': 'PCM ready',
    'bili-reuse': 'Audio cached, resuming',  // 320次：压缩缓存复用（不重下载直接续识）
    'bili-stream-fail': 'Stream fallback',
    'bili-none': 'Direct download unavailable',
    'yt-audio': 'YouTube audio',
    'bili-start': 'Preparing recognition',
    'fallback': 'Fallback mode'
  };

  // 后台下载进度：只更新文字，不抢占识别段的进度条百分比
  if (stage === 'bili-dl' || stage === 'bili-dl-ok' || stage === 'bili-dl-fail' || stage === 'bili-dl-retry'
      || stage === 'bili-backfill' || stage === 'bili-backfill-recog' || stage === 'bili-seg-retry') {
    const key = stage === 'bili-dl-ok' ? 'asr.dlAudioDone'
      : stage === 'bili-dl-fail' ? 'asr.bgInterrupted'
      : stage === 'bili-dl-retry' ? 'asr.dlRetry'
      : stage === 'bili-backfill' ? 'asr.backfillAudio'
      : stage === 'bili-backfill-recog' ? 'asr.backfillRecog'
      : stage === 'bili-seg-retry' ? 'asr.segRetry'
      : 'asr.bgDownload';
    showASRProgress(t(key), info);
    return;
  }

  // 播放闸门状态（停用中仅作遥测展示）：前沿｜缓冲｜下载速率｜识别倍速
  if (stage === 'gate') {
    const f = (typeof s.frontier === 'number' && isFinite(s.frontier)) ? formatTime(s.frontier) : '';
    const parts = [];
    if (f) parts.push(t('asr.frontier') + ' ' + f);
    const dv = getActiveVideo();
    if (dv && typeof s.frontier === 'number' && isFinite(s.frontier) && isFinite(dv.currentTime)) {
      parts.push(t('asr.buffer') + ' ' + Math.max(0, s.frontier - dv.currentTime).toFixed(0) + 's');
    }
    if (typeof s.dlSpeedKBps === 'number' && s.dlSpeedKBps > 0) {
      parts.push('DL ' + (s.dlSpeedKBps / 1024).toFixed(1) + 'MB/s');
    }
    if (typeof s.recSpeedX === 'number' && s.recSpeedX > 0) {
      parts.push('ASR ' + s.recSpeedX.toFixed(1) + '×');
    }
    showASRProgress(info || t('asr.gating'), parts.join(' | '));
    // 第九十九次：前沿推进时立即评估续播（暂停中无 timeupdate，必须消息驱动）
    evaluateGate();
    return;
  }
  if (stage === 'gate-done') {
    showASRProgress(t('asr.allDone'), t('asr.inSync'));
    evaluateGate();
    return;
  }

  if (prepStages[stage]) {
    let detail = info;
    // 第一百一十次：首段就绪详情用结构化字段拼英文（dur/from/peak 由 asr-client 附带）
    if (stage === 'bili-first-ok' && typeof s.dur === 'number') {
      detail = Math.round(s.dur) + 's @' + formatTime(s.from || 0) + (typeof s.peak === 'number' ? (' · peak ' + s.peak.toFixed(3)) : '');
    } else if (stage === 'bili-none' && typeof s.reason === 'string' && s.reason) {
      // 第一百一十次：直连失败原因（技术性文本保留原文，标题随界面语言）
      detail = s.reason;
    }
    showASRProgress(prepStages[stage], detail);  // 322次：标题已是英文直文本，不再过 t()
    if (stage.endsWith('-ok') || stage === 'bili-pcm') {
      updateASRProgressFill(100);
    } else if (stage.endsWith('-fail')) {
      updateASRProgressFill(0);
    } else {
      updateASRProgressFill(50);
    }
    return;
  }

  // B站识别段进度
  if (stage === 'bili-seg' && typeof s.segIdx === 'number' && isFinite(s.segIdx)
      && typeof s.totalSegs === 'number' && isFinite(s.totalSegs) && s.totalSegs > 0) {
    const pct = Math.round((s.segIdx / s.totalSegs) * 100);
    const duration = s.duration ? formatTime(s.duration) : '';
    showASRProgress(fmtTpl(t('asr.recognizing'), { i: s.segIdx + 1, n: s.totalSegs }),
      (s.segStart !== undefined ? formatTime(s.segStart) + '-' + formatTime(s.segEnd) : '') +
      (duration ? ' · ' + t('asr.total') + ' ' + duration : ''));
    updateASRProgressFill(pct);
    return;
  }

  if (stage === 'bili-seg-ok' && typeof s.segIdx === 'number' && isFinite(s.segIdx)
      && typeof s.totalSegs === 'number' && isFinite(s.totalSegs) && s.totalSegs > 0) {
    const pct = Math.round(((s.segIdx + 1) / s.totalSegs) * 100);
    showASRProgress(fmtTpl(t('asr.segDone'), { i: s.segIdx + 1, n: s.totalSegs }), info);
    updateASRProgressFill(pct);
    return;
  }

  if (stage === 'bili-done') {
    showASRProgress(t('asr.allDone'), '');
    updateASRProgressFill(100);
    return;
  }

  // 回退路径：视频结束，停止采集
  if (stage === 'fallback-done') {
    showASRProgress(t('asr.videoEnded'), t('asr.stopCapture'));
    updateASRProgressFill(100);
    return;
  }

  // 第一百零八次补：回退实时模式的暂停/恢复提示走 i18n（此前中文直达 UI）
  if (stage === 'fallback-paused') {
    showASRProgress(t('asr.fallbackMode'), t('asr.rtPaused'));
    return;
  }
  if (stage === 'fallback-resumed') {
    showASRProgress(t('asr.fallbackMode'), t('asr.rtResumed'));
    return;
  }

  // 回退路径进度（fallback-seg / fallback-silent）
  if ((stage === 'fallback-seg' || stage === 'fallback-silent' || stage === 'fallback-skip')
      && typeof s.segIdx === 'number' && typeof s.totalSegs === 'number' && s.totalSegs > 0) {
    const pct = Math.round((s.segIdx / s.totalSegs) * 100);
    const duration = s.duration ? formatTime(s.duration) : '';
    const stageKey = stage === 'fallback-seg' ? 'asr.capturing' : stage === 'fallback-silent' ? 'asr.noAudioSeg' : 'asr.silentSkip';
    showASRProgress(fmtTpl(t(stageKey), { i: s.segIdx, n: s.totalSegs }),
      (s.segStart !== undefined ? formatTime(s.segStart) + '-' + formatTime(s.segEnd) : '') +
      (duration ? ' · ' + t('asr.total') + ' ' + duration : ''));
    updateASRProgressFill(pct);
    return;
  }

  // 其他 stage：显示原始信息
  // 第一百二十六次：残留中文阶段名兜底显示为 'ASR'（用户裁定 ASR 提示一律英文）
  const enStage = /[\u4e00-\u9fff]/.test(stage) ? 'ASR' : stage;
  showASRProgress(enStage, info);
}

export { pushDiagLine, clearDiagLines };
