// =============================================================================
// vs/playback-gate.js —— ASR 播放闸门子模块
// -----------------------------------------------------------------------------
// 职责：ASR 识别期间对播放位置与识别前沿的干预（暂停等缓冲 / 前沿推进自动续播）。
//       【第一百零一次 用户裁定：停用】_gateEnabled=false 使安装/判定均为空操作，
//       代码完整保留以便日后经用户申明后恢复（置 _gateEnabled=true 并恢复门面
//       toggleASR 内 installPlaybackGate() 调用等两处调用即可）。
// 来源：拆分自 src/content/video-sidebar.js（2026-08-28 拆分第二刀，纯机械搬移）。
// 关系：依赖 ./dom-utils.js（formatTime）、../../lib/asr-client.js（getASRFrontier/
//       getASRStats）、../vs-asr-progress.js（showASRProgress）；因需读取门面的
//       getActiveVideo/isASRActive（读写 _video/_asrActive），对门面构成受控循环
//       import——本模块顶层仅初始化自身 let 状态与函数声明，绝不触碰门面绑定，
//       门面绑定调用全部发生在事件回调/函数体内（运行时门面已初始化完毕，安全）。
//       原 L2991 `if (!_asrActive) return;` 机械等价改写为 `if (!isASRActive()) return;`。
// =============================================================================

import { getActiveVideo, isASRActive } from '../video-sidebar.js';
import { formatTime } from './dom-utils.js';
import { getASRFrontier, getASRStats } from '../../lib/asr-client.js';
import { showASRProgress } from '../vs-asr-progress.js';

// === 播放闸门（第九十六次引入）===
// 【第一百零一次 用户裁定：停用】"除非我申明更改，恢复之前交互，不得暂停，识别要回退"——
// 点击识别不再暂停视频、不因追上识别前沿而暂停；_gateEnabled=false 使安装/判定均为空操作。
// 保留全部代码以便日后经用户申明后恢复：置 _gateEnabled=true 并恢复 toggleASR 内
// installPlaybackGate() 调用与 updateASRProgressFromStage 中 evaluateGate() 两处调用即可。
let _gatePausedByUs = false;   // 当前暂停是否为闸门所为（停用态恒 false）
let _gateTimeHandler = null;   // timeupdate 监听器（停用态恒 null）
let _gateEnabled = false;      // 闸门总开关（用户裁定停用）

// === 播放闸门（第九十六次）===
// 安装：ASR 启动成功后挂到当前活动 video（timeupdate）；卸载：stopASRInternal。
// 行为：
//   - frontier=-1（captureStream 回退）：不干预播放；
//   - frontier=Infinity（全部识别完成）：解除干预；
//   - 播放位置追上前沿（cur >= frontier-0.25）→ pause + 缓冲提示；
//   - 前沿推进越过播放位置（frontier > cur+0.5）且暂停由闸门所为 → 自动续播。
// 用户手动暂停（_gatePausedByUs=false）绝不代播，尊重用户意图。
export function installPlaybackGate() {
  // 【第一百零一次 用户裁定停用】见 _gateEnabled 注释
  if (!_gateEnabled) return;
  const v = getActiveVideo();
  if (!v || _gateTimeHandler) return;
  _gatePausedByUs = false;
  // 第九十九次：判定逻辑抽为 evaluateGate 共享——
  // 暂停中的视频不触发 timeupdate，若只靠 timeupdate 驱动，首批识别完成后
  // 没有任何事件去执行续播 → 视频永远停住。改为「timeupdate + gate 消息到达」双驱动。
  _gateTimeHandler = () => evaluateGate();
  v.addEventListener('timeupdate', _gateTimeHandler);
  console.log('[VocabRadar][asr][gate] 播放闸门已安装');
}

/** 闸门判定：暂停追前沿 / 前沿推进自动续播（timeupdate 与 gate 消息双驱动；停用态直接返回） */
export function evaluateGate() {
  if (!_gateEnabled) return;
  if (!isASRActive()) return;
  const dv = getActiveVideo();
  if (!dv) return;
  const frontier = getASRFrontier();
  if (frontier === -1) return;                       // 闸门不生效
  const cur = (isFinite(dv.currentTime)) ? dv.currentTime : 0;
  if (_gatePausedByUs) {
    // 自适应滞回（第九十七次）：识别越慢，需越大提前缓冲才续播，
    // 避免"续播即撞墙"的反复启停卡顿。margin=clamp(4/识别倍速, 2.5s, 15s)
    // 第九十八次：尚无识别样本时按 base≈4× 取默认，避免初始呆等 15s。
    const st = getASRStats();
    const rx = (st.recSpeedX > 0) ? st.recSpeedX : 4;
    const margin = Math.min(15, Math.max(2.5, 4 / Math.max(rx, 0.1)));
    if (frontier > cur + margin) {
      _gatePausedByUs = false;
      dv.play().catch(() => { /* ignore */ });
      console.log('[VocabRadar][asr][gate] 缓冲完成（margin=' + margin.toFixed(1) + 's ASR ' + rx.toFixed(1) + '×），自动续播 @' + cur.toFixed(1) + 's');
      // 第一百二十六次（用户裁定"ASR 提示都要用英文"）：闸门残留中文改英文
    showASRProgress('Resuming playback', '');
    }
    return;
  }
  if (frontier !== Infinity && !dv.paused && cur >= frontier - 0.25) {
    _gatePausedByUs = true;
    try { dv.pause(); } catch (e) { /* ignore */ }
    showASRProgress('Buffering', 'recognized up to ' + formatTime(frontier) + ', waiting for recognition to catch up');
    console.log('[VocabRadar][asr][gate] 追上识别前沿 ' + frontier.toFixed(1) + 's，暂停等待缓冲 @' + cur.toFixed(1) + 's');
  }
}

/** 卸载播放闸门；resume=true 且暂停为闸门所为时恢复播放 */
export function uninstallPlaybackGate(resume) {
  const v = getActiveVideo();
  if (_gateTimeHandler && v) {
    try { v.removeEventListener('timeupdate', _gateTimeHandler); } catch (e) { /* ignore */ }
  }
  _gateTimeHandler = null;
  if (resume && _gatePausedByUs && v) {
    try { v.play().catch(() => {}); } catch (e) { /* ignore */ }
  }
  _gatePausedByUs = false;
}
