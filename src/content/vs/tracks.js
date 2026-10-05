// =============================================================================
// vs/tracks.js —— 字幕轨道选择子模块
// -----------------------------------------------------------------------------
// 职责：setTracks()（填充轨道下拉框 + 自动加载链路：直取 → 9s/22s 模拟切轨，
//       至多 4 次可见尝试）、ensureASRTrackOption()（无多轨道时保底 ASR 选项）、
//       onTrackSelect()（用户切换轨道：ASR 轨道按覆盖率启动识别，常规轨道下载字幕）。
// 状态内聚：_tracks（轨道列表）、_trackFetchFn（按轨道下载函数）、
//       setTracks._retryTimer/onTrackSelect._selToken（函数属性令牌）随函数迁入，
//       仅本模块读写；_asrTrackIndex/_userPickedASR 仍属门面（asr-flow 同用），
//       经 getAsrTrackIndex/setAsrTrackIndex/getUserPickedASR/setUserPickedASR 接驳。
// 关系：依赖 ./asr-flow.js（toggleASR/stopASRInternal/loadASRCacheIfAny）、
//       ./loading.js（showLoading/showNoSubtitle/setAutoChainActive）、./logger.js、
//       ./dom-utils.js（makeVideoKey）、../../lib/asr-client.js（getASRCoverage）、
//       ./sidebar-layout.js（getSidebarCollapsedFlag/toggleSidebarCollapse）；
//       因需读写门面状态，经受控循环 import 对门面——本模块顶层仅状态与函数声明，
//       门面绑定调用全部发生在函数体内（运行时门面已初始化完毕，安全）。
//       等价改写：闭包内原直读活模块变量 `_root`/`_asrActive`（异步时点），
//       改走 getRoot()/isASRActive() 即时读取（同一时点语义等价）；
//       onTrackSelect 原 `_video` 直读改走 getActiveVideo()（vs/* 拆分约定）。
//       门面经 export 接驳 setTracks（vc/controller 引用方符号不变）。
// =============================================================================

import { getASRCoverage } from '../../lib/asr-client.js';
import { makeVideoKey } from './dom-utils.js';
import { log } from './logger.js';
import { showLoading, showNoSubtitle, setAutoChainActive } from './loading.js';
import { toggleASR, stopASRInternal, loadASRCacheIfAny } from './asr-flow.js';
import { getSidebarCollapsedFlag, toggleSidebarCollapse } from './sidebar-layout.js';
import {
  getRoot, getSubtitlesRef, getActiveVideo, isASRActive, updateSubtitles,
  getUserPickedASR, setUserPickedASR, getAsrTrackIndex, setAsrTrackIndex,
  getAsrCacheLoaded, getUserPickedTrack, setUserPickedTrack
} from '../video-sidebar.js';

// === 模块状态（仅本模块读写，随函数自门面迁入） ===
let _tracks = null;           // 字幕轨道列表（YouTube 有多轨道）
let _trackFetchFn = null;     // 按轨道下载字幕的函数（fetchYouTubeTrack）

// 轨道身份串：手选恢复的匹配键（vss_id 最唯一，languageCode/kind 兜底）
const trackIdentity = (t) => [t.vss_id || '', t.languageCode || '', t.kind || ''].join('|');

// === 设置字幕轨道选择器 ===
// tracks: 轨道列表, pickedIndex: 默认选中, fetchFn: 按轨道下载字幕的函数
// 用户要求"字幕虚空轨道，要真实"——去掉"空(None)"选项，只列真实轨道；
//   onTrackSelect 不处理 idx=-1（选空）分支。
// ASR 按钮移入 #beaver-track-row 与轨道同行；行始终显示（无轨道时
//   只显示 ASR 按钮，select/label 隐藏），保证 ASR 按钮始终可用。
// ASR 作为最后一个轨道选项添加（🎤 ASR），用户可从下拉框选择：
//   选择 ASR 轨道时启动 ASR（先回放缓存再实时识别），选择其他轨道时
//   停止 ASR 并加载对应字幕。
// 用户要求"只有一种 asr，先取本地缓存，若在 asr 及时补充"：Live/Cached
//   双轨道合并为单一 ASR 轨道，点击时 startASR 内部先回放缓存段再实时
//   识别接续（replayCachedSegs + 实时识别）。
export function setTracks(tracks, pickedIndex, fetchFn) {
  _tracks = tracks ? [...tracks] : [];
  _trackFetchFn = fetchFn;
  setAsrTrackIndex(-1);
  const _root = getRoot();
  if (!_root) return;
  const row = _root.querySelector('#beaver-track-row');
  const sel = _root.querySelector('#beaver-track-select');
  const label = _root.querySelector('#beaver-track-label');
  if (!row || !sel) return;

  sel.innerHTML = '';

  // 添加常规轨道
  if (_tracks.length > 0) {
    _tracks.forEach((tr, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${tr.languageCode}${tr.name ? ' - ' + tr.name : ''}`;
      sel.appendChild(opt);
    });
  }

  // 添加 ASR 轨道
  setAsrTrackIndex(_tracks.length);
  const _asrTrackIndex = getAsrTrackIndex();
  _tracks.push({ languageCode: 'asr', name: 'ASR', isASR: true });
  const asrOpt = document.createElement('option');
  asrOpt.value = String(_asrTrackIndex);
  asrOpt.textContent = 'ASR';
  sel.appendChild(asrOpt);

  // 始终显示 select 和 label（因为有 ASR 选项）
  sel.style.display = '';
  if (label) label.style.display = '';
  // 用户手动选了 ASR 轨道后，字幕异步到达触发 setTracks 时
  //   不能覆盖用户的 ASR 选中态（否则"过一会又自己改成中文轨道"）。
  //   _userPickedASR=true 时保持 ASR 选中，否则用 pickedIndex。
  if (getUserPickedASR() && _asrTrackIndex >= 0) {
    sel.value = String(_asrTrackIndex);
    log('轨道选择器已设置:', _tracks.length, '条轨道(含ASR), 保持用户已选 ASR');
  } else {
    // 第421次：用户手选的常规轨道优先恢复（身份串匹配；不在当前列表则失效走默认链）
    //   ——setTracks 会因 ASR 字幕异步到达等场景被再次调用，此前 sel.value=pickedIndex
    //   会把用户手选覆盖回默认链选轨（"用户手选最高优先"被打破）。
    const up = getUserPickedTrack();
    let wantIdx = -1;
    if (up) {
      wantIdx = _tracks.findIndex((t) => !t.isASR && trackIdentity(t) === up);
      if (wantIdx < 0) setUserPickedTrack(null);  // 手选轨道不在列表（换集/轨源变化），失效
    }
    sel.value = String(wantIdx >= 0 ? wantIdx : (pickedIndex || 0));
    log('轨道选择器已设置:', _tracks.length, '条轨道(含ASR), 选中=', wantIdx >= 0 ? `${wantIdx}(手选恢复)` : pickedIndex);
  }
  row.style.display = 'flex';

  // 用户裁定"咋不模仿用户操作切换轨道？等很久还在刷"：
  // 废除同调用反复重试。改为**模拟用户动作**：直取一次 → 9s 后模拟"切走再切回"
  // （走与手动完全相同的 onTrackSelect 路径，含其内部二重试与 path0 播放器等待）
  // → 22s 再模拟一轮 → 仍空则展开显示状态并停止（不再无限刷）。全程至多 4 次可见尝试。
  clearTimeout(setTracks._retryTimer);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** 模拟用户切走再切回目标轨道 */
  const __mimicSwitch = async (targetIdx) => {
    if (!getRoot() || isASRActive()) return false;
    // 找一个非目标的普通轨道；纯 ASR 视频则用 ASR 项当"另一轨"
    let other = -1;
    for (let i = 0; i < _tracks.length; i++) {
      if (i !== targetIdx && !_tracks[i].isASR) { other = i; break; }
    }
    const _asrTrackIndex2 = getAsrTrackIndex();
    if (other < 0 && _asrTrackIndex2 >= 0 && _asrTrackIndex2 !== targetIdx) other = _asrTrackIndex2;
    if (other < 0 || other === targetIdx) return false;
    log('模拟用户操作: 切走 →', other, _tracks[other] && _tracks[other].languageCode);
    sel.value = String(other);
    await onTrackSelect(other);
    await sleep(800); // 停顿如真人
    if (!getRoot() || getUserPickedASR()) return false; // 切走时用户/系统已改选，放弃接管
    log('模拟用户操作: 切回 →', targetIdx);
    sel.value = String(targetIdx);
    await onTrackSelect(targetIdx);
    return true;
  };
  const __ROUNDS = [
    { at: 0, mimic: false },
    { at: 9000, mimic: true },
    { at: 22000, mimic: true }
  ];
  let __round = -1;
  let __startedAt = 0;
  const __tick = async () => {
    try {
      __round++;
      setAutoChainActive(__round < __ROUNDS.length); // 链路活动标记
      if (__round >= __ROUNDS.length) {
        setAutoChainActive(false);
        // 链路走完仍空：展开亮出状态 + 单条汇总告警（不再刷）
        const _subtitles = getSubtitlesRef();
        if (getSidebarCollapsedFlag() && !(_subtitles && _subtitles.length > 0)) {
          const rootNow = getRoot();
          try { if (rootNow && rootNow.classList.contains('beaver-collapsed')) toggleSidebarCollapse(false); } catch (e) { /* ignore */ }
        }
        // 模块段归一——[youtube] 专属 lib/subtitle/youtube-fetcher.js，
        //   本文件的日志一律用 [video-sidebar]，避免同名前缀跨文件混淆。
        console.warn('[VocabRadar][video-sidebar] YouTube 自动加载链路(含模拟切轨)走完仍未命中——请点侧栏徽标贴日志');
        return;
      }
      if (!getRoot() || isASRActive()) { setAutoChainActive(false); return; }
      const _subtitles = getSubtitlesRef();
      if (_subtitles && _subtitles.length > 0) { setAutoChainActive(false); return; }
      const cur = parseInt(sel.value, 10);
      if (!(cur >= 0 && cur < _tracks.length)) { setAutoChainActive(false); return; }
      const trk = _tracks[cur];
      if (!trk || trk.isASR || !_trackFetchFn) { setAutoChainActive(false); return; }
      const round = __ROUNDS[__round];
      log(`setTracks 自动加载(${__round + 1}/${__ROUNDS.length}${round.mimic ? ' ·模拟切轨' : ''}):`, cur, trk.languageCode);
      if (round.mimic) await __mimicSwitch(cur);
      else await onTrackSelect(cur);
      const _subtitles2 = getSubtitlesRef();
      if (_subtitles2 && _subtitles2.length > 0) {
        log('setTracks 自动加载成功(第', __round + 1, '轮)');
        setAutoChainActive(false);
        return;
      }
      const next = __ROUNDS[__round + 1];
      if (next) {
        const wait = Math.max(200, next.at - (Date.now() - __startedAt));
        clearTimeout(setTracks._retryTimer);
        setTracks._retryTimer = setTimeout(__tick, wait);
      }
    } catch (e) { /* ignore */ }
  };
  __startedAt = Date.now();
  setTracks._retryTimer = setTimeout(__tick, __ROUNDS[0].at);
}

/**
 * 确保 ASR 轨道选项在下拉框中可用。
 * 当 setTracks 尚未被调用（如 B站无多轨道）时，仍需显示 ASR 选项供用户选择。
 * 在 startSidebar 中调用，setTracks 调用后会被覆盖（setTracks 内部也添加 ASR）。
 */
export function ensureASRTrackOption() {
  const _root = getRoot();
  if (!_root) return;
  const sel = _root.querySelector('#beaver-track-select');
  const label = _root.querySelector('#beaver-track-label');
  const row = _root.querySelector('#beaver-track-row');
  if (!sel || !row) return;
  // setTracks 已设置过 ASR 选项则跳过
  if (getAsrTrackIndex() >= 0) return;
  _tracks = [];
  setAsrTrackIndex(0);
  _tracks = [{ languageCode: 'asr', name: 'ASR', isASR: true }];
  sel.innerHTML = '';
  const opt = document.createElement('option');
  opt.value = '0';
  opt.textContent = 'ASR';
  sel.appendChild(opt);
  sel.style.display = '';
  if (label) label.style.display = '';
  row.style.display = 'flex';
  log('ensureASRTrackOption: 已添加 ASR 轨道选项');
}

// 用户切换字幕轨道
// ASR 作为轨道之一，选择 ASR 轨道时启动实时识别，
// 选择其他轨道时停止 ASR（如运行中）并加载对应字幕。
// Live/Cached 双轨道合并为单一 ASR 轨道，点击时
//   startASR 内部先回放缓存段再实时识别接续（replayCachedSegs + 实时识别）。
// opts.fromUser：仅 bind-events 的 change 事件（真实用户手选）传 true——
//   手选记录/清除只认它；自动链路与模拟切轨内部调用缺省，不冒充用户意图。
export async function onTrackSelect(idx, opts = {}) {
  const _root = getRoot();
  if (!_root) return;
  const panel = _root.querySelector('#beaver-subtitle-panel');
  // 防御性拦截
  if (idx === -1) return;

  // === ASR 轨道被选中：按缓存覆盖率决定是否启动 ASR 继续识别 ===
  // 用户反馈「轨道切换asr之后，为啥asr按钮也按下去了？」：
  //   根因：此前调用 toggleASR（toggle 语义），ASR 已运行时会误停止。
  //   现行为：ASR 已运行时不重复触发（仅同步轨道选中态），未运行时才启动。
  // 用户要求「选择asr轨道后，若识别区间未覆盖全文，则继续识别，
  //   asr按钮此时才默认选中」。即：缓存完整时仅选中轨道不启动 ASR（按钮不选中），
  //   缓存不完整时才启动 ASR 继续识别（按钮选中）。
  if (_tracks && _tracks[idx] && _tracks[idx].isASR) {
    // 用户手动选 ASR 轨道，置标记防止后续 setTracks 覆盖选中态
    setUserPickedASR(true);
    if (opts.fromUser) setUserPickedTrack(null);  // ASR 与常规手选互斥，只留一个
    if (isASRActive()) {
      log('用户选择 ASR 轨道, ASR 已运行, 仅同步选中态');
      return;
    }
    // 检查 ASR 缓存覆盖率，决定是否需要继续识别
    const videoKey = makeVideoKey();
    const v = getActiveVideo();
    const duration = (v && v.duration && !isNaN(v.duration)) ? v.duration : 0;
    const coverage = await getASRCoverage(videoKey, duration);
    if (coverage >= 1) {
      // 缓存完整：仅选中 ASR 轨道，不启动 ASR
      log('用户选择 ASR 轨道, 缓存完整(coverage=' + coverage.toFixed(2) + '), 仅选中轨道');
      // 若面板未显示缓存字幕，加载之
      if (!getAsrCacheLoaded() && getSubtitlesRef().length === 0) {
        await loadASRCacheIfAny();
      }
      return;
    }
    // 缓存不完整或无缓存：启动 ASR 继续识别
    log('用户选择 ASR 轨道, 缓存不完整(coverage=' + coverage.toFixed(2) + '), 启动 ASR');
    const asrBtn = _root.querySelector('#beaver-asr-toggle');
    if (asrBtn) {
      const rect = asrBtn.getBoundingClientRect();
      toggleASR(rect.left, rect.top);
    } else {
      toggleASR(0, 0);
    }
    return;
  }

  // === 常规轨道：如 ASR 运行中则先停止（跳过恢复，新轨道会自己加载字幕）===
  // 用户切换到常规轨道，清除 ASR 选中标记
  setUserPickedASR(false);
  if (isASRActive()) {
    stopASRInternal(true);
  }
  // 用户手动切轨 = 立即接管，后台自动链路停止（不与用户抢）
  clearTimeout(setTracks._retryTimer);
  setAutoChainActive(false);

  if (!_tracks || !_tracks[idx] || !_trackFetchFn) return;
  // 第421次：真实用户手选（opts.fromUser）记录轨道身份，供 setTracks 重建下拉时恢复
  //   选中态（用户手选最高优先，不被默认链覆盖）；自动链路/模拟切轨不记录。
  if (opts.fromUser) setUserPickedTrack(trackIdentity(_tracks[idx]));
  log('用户切换轨道:', idx, _tracks[idx].languageCode);
  if (panel) showLoading();
  try {
    // 空结果自动重试×2（1.5s/4s）——手动"切走再切回"能成功证明
    // 多为时序问题（播放器/单例未热），不应让用户手动救。选轨令牌防过期重试覆盖。
    if (!onTrackSelect._selToken) onTrackSelect._selToken = 0;
    const selToken = ++onTrackSelect._selToken;
    const trk = _tracks[idx];
    const delays = [1500, 4000];
    let subs = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      subs = await _trackFetchFn(trk);
      if (subs && subs.length > 0) break;
      if (selToken !== onTrackSelect._selToken) { log('轨道重试作废(已换轨)', trk.languageCode); return; }
      if (attempt < delays.length) {
        log('轨道下载为空, 重试', attempt + 1, '/', delays.length, ':', trk.languageCode);
        await new Promise((r) => setTimeout(r, delays[attempt]));
        if (selToken !== onTrackSelect._selToken) return;
      }
    }
    if (subs && subs.length > 0) {
      await updateSubtitles(subs);
    } else {
      if (panel) showNoSubtitle();
      log('轨道下载为空(含2次重试):', trk.languageCode);
    }
  } catch (e) {
    console.error('[VocabRadar][video-sidebar][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] 轨道切换失败:', e);
    if (panel) showNoSubtitle('Error: ' + e.message);
  }
}
