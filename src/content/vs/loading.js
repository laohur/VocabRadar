// =============================================================================
// vs/loading.js —— 加载态（骨架屏/超时兜底/无字幕提示）子模块
// -----------------------------------------------------------------------------
// 职责：showLoading()（骨架屏 + 15s 超时兜底）、clearLoading()（去 loading 态并清
//       超时计时器）、showNoSubtitle(msg)（无字幕/超时/错误提示，保留 tabs 可切换）、
//       自动加载链路活动标记 _autoChainActive（期间超时兜底不抢跳）。
// 关系：依赖 ./logger.js（log）、./dom-utils.js（escapeHtml）、../../lib/i18n.js（t）；
//       因需读取门面 _root/_subtitles，经 getRoot/getSubtitlesRef 对门面构成受控
//       循环 import——本模块顶层仅自身状态与函数声明，getRoot()/getSubtitlesRef()
//       调用全部发生在函数体内（运行时门面已初始化完毕，安全）。
//       状态内聚：_loadingTimeout（含 clearLoadingTimeout()，门面 destroySidebar 调用）、
//       _autoChainActive（tracks 子模块经 setAutoChainActive() 接驳写入）。
//       等价改写：showLoading 超时回调内原直读活模块变量 `_root`，改走 getRoot()
//       （同一时点语义等价——回调执行时按当时引用判断）。
//       门面经 export 接驳 clearLoading/showNoSubtitle（subtitle-renderer、
//       vc/controller、guide-common 引用方符号不变）。
// =============================================================================

import { log } from './logger.js';
import { escapeHtml, makeVideoKey, parsePlatformVideo } from './dom-utils.js';
import { t } from '../../lib/i18n.js';
import { toast } from './toast.js';
import { getRoot, getSubtitlesRef, getActiveVideo, getVideoLearnLang, updateSubtitles } from '../video-sidebar.js';

// === 加载提示（字幕到达前显示） ===
// 加载态：仅显示 header + 骨架动画，隐藏 tabs/toolbar/footer
// 仿 videoseek 的 Skeleton active 样式（渐变呼吸动画条）
// 加载超时计时器（用户反馈"有的视频你一直转转转还不自知"）
// showLoading 后 15 秒未收到字幕/错误，自动 showNoSubtitle 兜底，避免 loading 永转。
let _loadingTimeout = null;
const LOADING_TIMEOUT_MS = 15000;
// 用户裁定"抓取字幕都是后台操作，不要干扰正常操作"：
// 自动加载链路活动标记——期间 15s 超时兜底不再抢跳超时提示（链路自有终态），
// 且 onTrackSelect 不重复刷骨架屏。
let _autoChainActive = false;

/** 自动加载链路活动标记写入（tracks 子模块：链路各轮次切换与结束时置位） */
export function setAutoChainActive(v) { _autoChainActive = !!v; }

export function showLoading(msg) {
  const _root = getRoot();
  if (!_root) return;
  const panel = _root.querySelector('#beaver-subtitle-panel');
  // 后台化——面板已在 loading 态或已有真实字幕时不重绘不闪动
  if (panel && panel.querySelector('.beaver-loading')) return;
  const _subtitles = getSubtitlesRef();
  if (panel && _subtitles && _subtitles.length > 0) return;
  _root.classList.add('loading');
  if (!panel) return;
  const txt = msg || t('loading');
  // 骨架屏：模拟字幕列表（时间条 + 文本行），仿 videoseek 的 Skeleton
  panel.innerHTML = `<div class="beaver-loading skeleton" data-loading-key="loading">
    <div class="beaver-skeleton-row"><div class="beaver-skeleton-bar time"></div><div class="beaver-skeleton-bar long"></div></div>
    <div class="beaver-skeleton-row"><div class="beaver-skeleton-bar time"></div><div class="beaver-skeleton-bar medium"></div></div>
    <div class="beaver-skeleton-row"><div class="beaver-skeleton-bar time"></div><div class="beaver-skeleton-bar full"></div></div>
    <div class="beaver-skeleton-row"><div class="beaver-skeleton-bar time"></div><div class="beaver-skeleton-bar long"></div></div>
    <div class="beaver-skeleton-row"><div class="beaver-skeleton-bar time"></div><div class="beaver-skeleton-bar short"></div></div>
    <div style="text-align:center;color:#9499a0;font-size:13px;margin-top:8px"><span class="beaver-loading-spin"></span> ${escapeHtml(txt)}</div>
  </div>`;
  // 超时兜底：字幕获取卡死（网络不响应/API 异常未抛错）时，
  // showLoading 不会被 clearLoading 清除，loading 永转。15秒后自动 showNoSubtitle。
  if (_loadingTimeout) clearTimeout(_loadingTimeout);
  _loadingTimeout = setTimeout(() => {
    _loadingTimeout = null;
    if (_autoChainActive) {
      // 自动链路进行中：不抢跳超时提示（链路 22s 自有终态），仅解除 loading 态防永转样式
      const rootNow = getRoot();
      if (rootNow) rootNow.classList.remove('loading');
      return;
    }
    const rootNow = getRoot();
    if (rootNow && rootNow.classList.contains('loading')) {
      log('loading 超时 ' + (LOADING_TIMEOUT_MS / 1000) + 's，自动显示超时提示');
      showNoSubtitle('subtitleTimeoutTip');
    }
  }, LOADING_TIMEOUT_MS);
}

// 加载完成：去掉 loading class，恢复 tabs/toolbar/footer 显示（由 vs/subtitle-renderer 的 renderSubtitlePanel 调用）
export function clearLoading() {
  const _root = getRoot();
  if (!_root) return;
  _root.classList.remove('loading');
  // 清除超时计时器，避免字幕正常到达后超时提示仍触发
  if (_loadingTimeout) {
    clearTimeout(_loadingTimeout);
    _loadingTimeout = null;
  }
}

/** 清 loading 超时计时器（门面 destroySidebar 清理序列调用；无计时器时为空操作） */
export function clearLoadingTimeout() {
  if (_loadingTimeout) {
    clearTimeout(_loadingTimeout);
    _loadingTimeout = null;
  }
}

// === 显示"无字幕"提示 ===
// 用户要求"有啥显示啥"：只更新字幕 panel 显示提示，保留 _subtitles/_subEntries/
// _allAnnotations 旧数据（此前清空导致 tabs 无法切换查看已收集的生词，且字幕
// panel 内容全无），tabs（字幕/生词表/练习）仍可点击，生词表保留已收集的生词。
export function showNoSubtitle(msg) {
  const _root = getRoot();
  if (!_root) return;
  // 不清空 _subtitles/_subEntries/_allAnnotations：保留旧数据供 tabs 切换
  clearLoading();
  const panel = _root.querySelector('#beaver-subtitle-panel');
  if (panel) {
    // msg 为已知 i18n key 时按 key 渲染（标记 data-i18n，切换 UI 语言时 applyI18n 自动更新）；
    // msg 为普通文本（动态错误信息）时直接显示不跟随切换；不传 msg 默认 noSubtitleTip。
    const knownKeys = ['noSubtitleTip', 'subtitleTimeoutTip'];
    const key = (!msg) ? 'noSubtitleTip' : (knownKeys.includes(msg) ? msg : null);
    const tip = key ? t(key) : msg;
    const i18nAttr = key ? `data-i18n="${key}"` : '';
    panel.innerHTML = `<div class="beaver-loading" style="padding:40px 16px">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" style="opacity:.35"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6zm0 4h8v2H6zm10 0h2v2h-2zm-6-4h8v2h-8z" fill="currentColor"/></svg>
      <span ${i18nAttr} style="font-size:1em">${escapeHtml(tip)}</span>
    </div>
    <div class="beaver-subs-cloud" style="padding:0 16px 16px;text-align:center"></div>`;
    attachCloudOffer(panel.querySelector('.beaver-subs-cloud'));
  }
  log('显示无字幕提示（保留 tabs 可切换）');
  // 用户裁定"有时候还会自动折叠"=不可接受：撤销无字幕自动折叠。
  // 启动折叠/首批内容展开一次的既定策略不变；此后任何时刻都尊重用户当前展开态。
}

// === P4 云端获取（2026-10-17，方案 §3.2 消费体系） ===
// 无字幕面板自动查云端（SW 'vocabradar:subs-cloud-lookup'）：
//   30 天缓存命中 → 免计直接上屏；未命中 → 报价按钮，用户确认后
//   'vocabradar:subs-cloud-download' 扣分获取（扣分前必经确认，无"惊喜扣分"）。
// 未连接账号/云端没有/查询失败 → 静默不显示（提示文案本身已说明两条路）。
function sendSubsMsg(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
        const err = chrome.runtime.lastError; // 必须读，防未处理 lastError 告警
        resolve(err ? { ok: false, error: err.message } : (res || { ok: false, error: 'no-response' }));
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message || e) });
    }
  });
}

// 云端正文 → 侧栏段：20261017 二次令"都没有时间戳咋能用，瞎编？"——**不再均匀铺
// 时间编造**：有真时间戳段（cues，20261017 起云端随下载下发）才上屏；无 cues 的
// 旧数据如实放弃（返回 0，调用方 toast 说明）
function cloudRender(content, durationSec, cues) {
  if (!Array.isArray(cues) || !cues.length) return 0;
  const segs = cues.map((c) => ({ start: Number(c.s ?? c.start) || 0, end: Number(c.e ?? c.end) || 0, text: String((c.t ?? c.text) || '').trim() }))
    .filter((s) => s.text)
    .sort((a, b) => a.start - b.start);
  if (!segs.length) return 0;
  updateSubtitles(segs); // 内部走 showLoading→rerender，本面板被正常字幕面板替换
  return segs.length;
}

function attachCloudOffer(box) {
  if (!box) return;
  const meta = parsePlatformVideo();
  const lang = (getVideoLearnLang() || 'en').split('-')[0].toLowerCase();
  const videoKey = makeVideoKey();
  sendSubsMsg('vocabradar:subs-cloud-lookup', {
    videoKey, platform: meta.platform, videoId: meta.videoId, lang,
  }).then((res) => {
    if (!box.isConnected) return; // 面板已被替换（缓存命中上屏/换集）则不再渲染
    if (res && res.ok && res.cached) { // 30 天缓存命中：免计直接上屏
      if (!cloudRender(res.content, res.durationSec, res.cues)) {
        box.innerHTML = `<span style="font-size:.85em;opacity:.7">${escapeHtml(t('subsNoTiming'))}</span>`;
      }
      return;
    }
    if (!res || !res.ok) {
      // 20261017 用户报"其他账号不能获取"后去静默：各结局都给一行可见反馈，
      // 让取不到的原因自证（此前 not-connected/查询失败全静默，排查无从下手）
      if (res && res.error === 'none') {
        box.innerHTML = `<span style="font-size:.85em;opacity:.55">${escapeHtml(t('subsCloudNone'))}</span>`;
      } else if (res && res.error === 'not-connected') {
        box.innerHTML = `<span style="font-size:.85em;color:#0a7d4f">${escapeHtml(t('subsCloudConnect'))}</span>`;
      } else {
        box.innerHTML = `<span style="font-size:.85em;opacity:.7">${escapeHtml(t('subsCloudFail'))}</span>`;
        console.warn('[VocabRadar][subs-cloud] 查询失败:', res && res.error); // 恒可见（log 受 debug 门控）
      }
      return;
    }
    renderCloudOffer(box, videoKey, res, meta, lang);
  }).catch(() => { /* 查询异常静默：无字幕提示本身成立 */ });
}

// 报价 UI（P5 扩展为多版本切换）：默认渲染服务端 Wilson 排序的第一版；
// 多版本时「N 个版本」可展开逐版列表（评分/星级/时长/价格），点「取用」切换
// 报价目标。他人版本首次点击展示扣分确认（扣分前必经确认，无"惊喜扣分"），
// 自己分享的版本免费（20261017 用户裁定，Worker 侧不扣分）→ 免确认直取。
// requestId 生成后沿用至成功，重试不重扣。meta/lang 随下载消息带给 SW——
// 消费结果落本地字幕库（P5：投票/纠错/SRT 的持久载体）需要平台与视频号
function renderCloudOffer(box, videoKey, res, meta, lang) {
  const items = (Array.isArray(res.items) && res.items.length) ? res.items : [res.item].filter(Boolean);
  if (!items.length) return;
  const offerBtnStyle = 'margin-top:8px;padding:6px 14px;border:1px solid currentColor;border-radius:16px;background:transparent;color:inherit;cursor:pointer;font-size:.9em';

  const doFetch = (item, btn) => {
    const requestId = (crypto.randomUUID ? crypto.randomUUID() : 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    btn.disabled = true;
    btn.textContent = t('subsCloudFetching');
    sendSubsMsg('vocabradar:subs-cloud-download', {
      videoKey, id: item.id, requestId,
      platform: meta.platform, videoId: meta.videoId, lang,
    }).then((dres) => {
      if (!box.isConnected) return;
      if (dres && dres.ok) {
        // 自动拉取下实扣可见（20261018 用户令取代"扣分前必经确认"）：扣了几分如实播报
        if (Number(dres.charged) > 0) toast(t('subsCloudCharged').replace('{n}', String(dres.charged)));
        if (!cloudRender(dres.content, dres.durationSec, dres.cues)) {
          // 旧数据无时间戳：不渲染（不均匀铺时间瞎编），如实说明；内容已缓存不重复扣分
          btn.disabled = false;
          btn.textContent = t('subsNoTiming');
        }
        return; // 成功即缓存于 SW 并落库，渲染成功时本面板被字幕面板替换
      }
      btn.disabled = false;
      btn.textContent = (dres && dres.error === 'insufficient-points') ? t('subsCloudPoor')
        : (dres && dres.error === 'not-connected' ? t('subsCloudConnect') : t('subsCloudFail'));
      console.warn('[VocabRadar][subs-cloud] 获取失败:', dres && (dres.message || dres.error)); // 恒可见
    });
  };

  // 版本行摘要：▲x ▼y · ★均分(n) · 价/免费 · 修正链标记 · 我的标记
  // （20261018 用户批"图示字符太瘦"——弃 emoji，用实心三角/星，窄屏不糊）
  const verSummary = (it) => {
    const min = it.durationSec ? Math.max(1, Math.round(it.durationSec / 60)) : '—';
    const stars = it.starCount ? `★${it.starAvg}(${it.starCount})` : '★—';
    const cost = it.mine ? t('subsCloudFree') : t('subsCloudPts').replace('{n}', it.price || 1);
    const fix = it.derivedFrom ? '↳' : '';
    return `#${it.id} ${it.kind || 'asr'} · ${String(it.model || '').slice(0, 40)} · ${min}min · ▲${it.upVotes || 0} ▼${it.downVotes || 0} · ${stars} · ${cost}${fix}${it.mine ? ' · ' + t('subsCloudMine') : ''}`;
  };

  const renderOffer = (item) => {
    const min = item.durationSec ? Math.max(1, Math.round(item.durationSec / 60)) : 0;
    const verNote = (items.length > 1)
      ? `<span class="beaver-subs-cloud-vers" style="font-size:.8em;opacity:.6;margin-left:8px;cursor:pointer;text-decoration:underline">`
        + `${escapeHtml(t('subsCloudVersions').replace('{count}', items.length))} ▸</span>` : '';
    box.innerHTML = `<button type="button" class="beaver-subs-cloud-btn" style="${offerBtnStyle}">`
      + `${escapeHtml(t('subsCloudFetch'))}</button>${verNote}`;
    bindVersionToggle();
    const mainBtn = box.querySelector('.beaver-subs-cloud-btn');
    if (item.mine || item.consumed) {
      // 免费版自动拉取（20261018 用户令"消费方还是没能自动拉去"）：自己分享的或
      // 已购（服务端 lookup 带 consumed 标记，重取不扣分）——价格 0，无"惊喜扣分"
      // 问题，渲染即直取；他人新版本仍走报价确认
      mainBtn.disabled = true;
      mainBtn.textContent = t('subsCloudFetching');
      doFetch(item, mainBtn);
      return;
    }
    mainBtn.addEventListener('click', function () {
      // 确认态：价格明细 + 获取按钮（用户点击"获取"才扣分）
      const price = item.price || 1;
      box.innerHTML = `<div style="font-size:.9em">${escapeHtml(
        t('subsCloudConfirm').replace('{points}', price).replace('{kind}', item.kind || 'asr').replace('{min}', min || '—')
      )}</div>`
        + `<button type="button" class="beaver-subs-cloud-btn" style="margin-top:8px;padding:6px 14px;border:none;border-radius:16px;background:#0a7d4f;color:#fff;cursor:pointer;font-size:.9em">`
        + `${escapeHtml(t('subsCloudGet'))}</button>`;
      bindVersionToggle();
      box.querySelector('.beaver-subs-cloud-btn').addEventListener('click', function () { doFetch(item, this); });
    });
  };

  // 「N 个版本」展开/收起：逐版摘要 + 取用按钮，取用后回到该版本的报价/直取。
  // bindVersionToggle 在每次重绘后重绑（innerHTML 覆盖旧节点）
  function bindVersionToggle() {
    const tg = box.querySelector('.beaver-subs-cloud-vers');
    if (!tg) return;
    tg.addEventListener('click', () => {
      const list = box.querySelector('.beaver-subs-cloud-vlist');
      if (list) { list.remove(); tg.textContent = tg.textContent.replace('▾', '▸'); return; }
      const div = document.createElement('div');
      div.className = 'beaver-subs-cloud-vlist';
      div.style.cssText = 'margin-top:6px;text-align:left;font-size:.8em;opacity:.9;border:1px solid rgba(128,128,128,.3);border-radius:8px;padding:6px 8px';
      div.innerHTML = items.map((it, idx) => `<div style="display:flex;align-items:center;gap:6px;padding:3px 0">`
        + `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(verSummary(it))}">${escapeHtml(verSummary(it))}</span>`
        + `<button type="button" data-vi="${idx}" class="beaver-subs-cloud-use" style="flex:none;padding:2px 10px;border:1px solid currentColor;border-radius:12px;background:transparent;color:inherit;cursor:pointer">`
        + `${escapeHtml(t('subsCloudVerUse'))}</button></div>`).join('');
      tg.textContent = tg.textContent.replace('▸', '▾');
      tg.after(div);
      div.querySelectorAll('.beaver-subs-cloud-use').forEach((b) => {
        b.addEventListener('click', () => {
          const it = items[Number(b.dataset.vi)];
          if (it) renderOffer(it); // 切换报价目标：他人版回确认态，我的版点获取直取
        });
      });
    });
  }

  renderOffer(items[0]);
}

// P5（20261018 用户令"应当asr时候能够拉取"）：ASR 启动前先探云端——有共享版本
// 先取云端（缓存/免费版渲染即直取；付费版在面板内确认，含"跳过，直接识别"出口），
// 云端没有/用户跳过/下载失败才回落本地转写。ASR 的语义由此成为"获取字幕"。
// 返回 true=已接管（字幕已上屏或确认块待用户决定），false=云端没有，走转写。
// 调用方（asr-flow toggleASR）负责 skipReplay 场景的面板还原
export async function tryCloudForAsr() {
  const _root = getRoot();
  const panel = _root && _root.querySelector('#beaver-subtitle-panel');
  if (!panel) return false;
  const meta = parsePlatformVideo();
  const lang = (getVideoLearnLang() || 'en').split('-')[0].toLowerCase();
  const videoKey = makeVideoKey();
  const res = await sendSubsMsg('vocabradar:subs-cloud-lookup', {
    videoKey, platform: meta.platform, videoId: meta.videoId, lang,
  });
  if (!res || !res.ok) return false; // 未连接/云端没有/查询失败：如实回落转写
  if (res.cached) {
    return cloudRender(res.content, res.durationSec, res.cues) > 0;
  }
  const items = (Array.isArray(res.items) && res.items.length) ? res.items : [res.item].filter(Boolean);
  const item = items[0];
  if (!item) return false;
  // 免费版（自己的/已购）：渲染即直取（与无字幕面板同口径，服务端不重复扣分）
  if (item.mine || item.consumed) {
    const requestId = (crypto.randomUUID ? crypto.randomUUID() : 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    const dres = await sendSubsMsg('vocabradar:subs-cloud-download', {
      videoKey, id: item.id, requestId, platform: meta.platform, videoId: meta.videoId, lang,
    });
    if (dres && dres.ok) return cloudRender(dres.content, dres.durationSec, dres.cues) > 0;
    console.warn('[VocabRadar][subs-cloud] ASR 前免费获取失败:', dres && (dres.message || dres.error)); // 恒可见
    return false; // 失败回落转写
  }
  // 付费版：面板内确认（获取 / 跳过直接识别）。确认块临时替换面板内容——
  // 跳过/失败由调用方还原（rerenderPanelOnly 或 ASR 流程清空），获取成功由
  // cloudRender 经 updateSubtitles 整面板替换
  const min = item.durationSec ? Math.max(1, Math.round(item.durationSec / 60)) : '—';
  return new Promise((resolve) => {
    panel.innerHTML = `<div class="beaver-loading" style="padding:28px 16px;text-align:center">`
      + `<div style="font-size:.9em">${escapeHtml(t('subsCloudConfirm').replace('{points}', item.price || 1).replace('{kind}', item.kind || 'asr').replace('{min}', min))}</div>`
      + `<div style="margin-top:10px;display:flex;gap:8px;justify-content:center">`
      + `<button type="button" id="beaver-asr-cloud-get" style="padding:6px 14px;border:none;border-radius:16px;background:#0a7d4f;color:#fff;cursor:pointer;font-size:.9em">${escapeHtml(t('subsCloudGet'))}</button>`
      + `<button type="button" id="beaver-asr-cloud-skip" style="padding:6px 14px;border:1px solid currentColor;border-radius:16px;background:transparent;color:inherit;cursor:pointer;font-size:.9em">${escapeHtml(t('subsAsrSkip'))}</button>`
      + `</div></div>`;
    panel.querySelector('#beaver-asr-cloud-get').addEventListener('click', async function () {
      this.disabled = true;
      this.textContent = t('subsCloudFetching');
      const requestId = (crypto.randomUUID ? crypto.randomUUID() : 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2));
      const dres = await sendSubsMsg('vocabradar:subs-cloud-download', {
        videoKey, id: item.id, requestId, platform: meta.platform, videoId: meta.videoId, lang,
      });
      if (dres && dres.ok && cloudRender(dres.content, dres.durationSec, dres.cues) > 0) {
        resolve(true);
        return;
      }
      console.warn('[VocabRadar][subs-cloud] ASR 前获取失败:', dres && (dres.message || dres.error)); // 恒可见
      resolve(false); // 失败回落转写（调用方负责面板还原）
    });
    panel.querySelector('#beaver-asr-cloud-skip').addEventListener('click', () => resolve(false));
  });
}
