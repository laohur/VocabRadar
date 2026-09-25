// =============================================================================
// vs/asr-stage.js —— ASR 阶段消息分发子模块
// -----------------------------------------------------------------------------
// 职责：ASR 阶段时间线诊断日志（_diagLines/pushDiagLine/clearDiagLines，第一百零
//       三次起按用户裁定改为仅日志、不渲染 DOM）、内部阶段集合 ASR_INTERNAL_STAGES、
//       把 asr-client 的 onStatus stage 消息分发到进度条
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
//       引用；fmtTpl 随消费方退役删除（record-workflow 第398次、fallback 分支第399次）。
// =============================================================================

import { getRoot, getActiveVideo } from '../video-sidebar.js';
import { formatTime } from './dom-utils.js';
import { t } from '../../lib/i18n.js';
import { showASRProgress, updateASRProgressFill } from '../vs-asr-progress.js';
import { evaluateGate } from './playback-gate.js';
// 第367次：[asr][diag] 时间线 console 接 diagLog 阀门（引导页「诊断日志」开关）；
//   _diagLines 环形缓冲保留（诊断窗/日志无依赖，仅 console 输出受阀门控制）。
import { isDiagLog } from '../../lib/log-flag.js';

// === ASR 阶段时间线（第一百零二次引入；第一百零三次按用户裁定改为仅日志）===
// "侧栏展示调试大逆不道，只能日志"——不再渲染任何 DOM，统一打
// console.log('[VocabRadar][asr][diag] …')，可用控制台过滤 'ASR][diag' 查看全链路。
const _diagLines = [];
function pushDiagLine(text) {
  const d = new Date();
  const ts = d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  _diagLines.push('[' + ts + '] ' + text);
  if (_diagLines.length > 200) _diagLines.shift();
  if (isDiagLog()) console.log('[VocabRadar][asr][diag][' + ts + '] ' + text);
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
 *   job 主路径（backend yt-dlp 任务式转写，第398次）：
 *   - job-submitted / job-poll-fail：任务提交与轮询细节（仅日志）
 *   - job-queued：排队中；job-download：yt-dlp 下载（info 含 'n%'）
 *   - job-transcribe：faster-whisper 转写（info 含 'n%'）
 *   - gate / gate-done：识别前沿推进遥测 / 全部完成
 * @param {{stage:string, info:string, frontier?:number}} s
 */
// 第一百零五次（用户裁定）：ASR 进度条只显示对用户有必要的状态；
// 内部过程阶段只写日志（[ASR][diag]），不再驱动进度条文字/百分比刷屏。
const ASR_INTERNAL_STAGES = new Set([
  'job-submitted', 'job-poll-fail'              // 第398次：job 提交/轮询细节（仅日志）
  // 第398次：旧 B站/YouTube 下载管线阶段（bili-*、yt-audio、switch-download）随管线退役移除
  // 第399次：captureStream 回退阶段（seg-recv、switch-job、fallback-*）随回退删除移除
]);
export function updateASRProgressFromStage(s) {
  if (!getRoot() || !s) return;
  const stage = s.stage || '';
  const info = s.info || '';
  // 全阶段入诊断日志（仅 console，[ASR][diag] 前缀可过滤）
  pushDiagLine(stage + (info ? ' · ' + info : '') +
    (typeof s.frontier === 'number' && isFinite(s.frontier) && stage === 'gate' ? ' @' + formatTime(s.frontier) : ''));
  // 内部阶段：到此为止，不干扰用户
  if (ASR_INTERNAL_STAGES.has(stage)) return;

  // 音频准备/任务进度阶段——第一百一十次：标签全部走英文直文本（322次口径）
  // 第398次：job 主路径三阶段（queued/download/transcribe）；
  //   旧 B站管线 prepStages 随管线退役删除，fallback 随第399次回退删除移除。
  const prepStages = {
    'job-queued': 'Queued',
    'job-download': 'Downloading audio',
    'job-transcribe': 'Transcribing'
  };

  if (prepStages[stage]) {
    let detail = info;
    showASRProgress(prepStages[stage], detail);  // 322次：标题已是英文直文本，不再过 t()
    // 第398次：job-download/job-transcribe 的 info 含 'n%' 时驱动进度条
    const m = (stage === 'job-download' || stage === 'job-transcribe') ? /(\d{1,3})%/.exec(detail) : null;
    if (m) {
      updateASRProgressFill(Math.min(100, parseInt(m[1], 10)));
    } else {
      updateASRProgressFill(50);
    }
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

  // 第398次：旧 B站管线 bili-seg/bili-seg-ok/bili-done 分支随管线退役删除
  // 第399次：回退路径分支（fallback-done/paused/resumed/seg/silent/skip）随回退删除

  // 其他 stage：显示原始信息
  // 第一百二十六次：残留中文阶段名兜底显示为 'ASR'（用户裁定 ASR 提示一律英文）
  const enStage = /[\u4e00-\u9fff]/.test(stage) ? 'ASR' : stage;
  showASRProgress(enStage, info);
}

export { pushDiagLine, clearDiagLines };
