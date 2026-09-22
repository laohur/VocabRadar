/**
 * diag-window.js —— 诊断中心路由窗（唯一诊断入口，第364次拆分）
 *
 * 用户指令（逐字）："诊断窗口十个路由窗口，点击哪个标签显示哪个。侧栏的诊断菜单改名，
 *   大杂烩的诊断窗口也拆分独立。都从一个诊断路由窗口启动。分别是视频侧栏注入时机、
 *   加载耗时、正文提取、AI上下文、下载音频。"
 *
 * 五个标签（点击标签显示对应内容，记忆上次所在标签）：
 *   1. 注入时机 —— vs/inject-timing.js 六档切换（原右下角独立浮窗撤除，档位能力并入此）
 *   2. 加载耗时 —— 提示链路分段时间线（原 main-text.js renderHintTiming 迁入，
 *      数据源 window.__beaverHintTiming / __beaverHintBoot / __beaverWsDedup 等全局）
 *   3. 正文提取 —— 四方案耗时对比 + 预览（原 main-text.js renderDiagRows 迁入，
 *      测量本体 measureMainTextExtractors 仍留在 main-text.js——迁走的是窗，留下的是测量）
 *   4. AI 上下文 —— 当前送给 AI 的正文来源/耗时/全文预览（同一次测算的 ai* 字段）
 *   5. 下载音频 —— 视频侧栏 ⋯ 菜单打开时注入 onDownloadAudioClick 回调；无视频语境
 *      （文本侧栏入口）显示说明
 *
 * 显隐语义（沿第363次）：菜单调用（缺省）→ 强制显示并重测；快捷键 Ctrl+Shift+V
 *   （reveal:false）→ 纯切换，仅唤出时重测。原 main-text 窗与 inject-timing 浮窗
 *   「同键双开」缺陷就此消除——本窗是 Ctrl+Shift+V 的唯一接收方。
 *
 * 容器 id = beaver-diag-center，已同步列入 main-text.js 的 OWN_UI_SELECTOR
 *   （正文提取必须跳过自家 UI，否则诊断窗文字会被当成正文喂给模型）。
 */

import { measureMainTextExtractors } from '../lib/main-text.js';
import { getBatches } from '../lib/dict-stats.js'; // 时序表聚合 text-hint 扫描挡量（随 renderHintTiming 迁入）
import { TIMING_LABELS, readInjectTiming, setInjectTiming } from './vs/inject-timing.js';
import { t } from '../lib/i18n.js';

const DIAG_HOST_ID = 'beaver-diag-center';

// 标签表：key ↔ i18n 键；前两个不需测算，后两个共用一次 measureMainTextExtractors()
const TABS = [
  ['timing', 'diag.tabTiming'],
  ['load', 'diag.tabLoad'],
  ['extract', 'diag.tabExtract'],
  ['ai', 'diag.tabAi'],
  ['audio', 'diag.tabAudio']
];

// 记忆上次所在标签（页面刷新即回默认 extract——原大杂烩窗的主打内容）
let _curTab = 'extract';
// 音频下载动作（视频侧栏 ⋯ 菜单打开时经 opts.audioDownload 注入；每次打开重建）
let _audioDownload = null;

// HTML 转义 / 毫秒格式化（各标签渲染共用）
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function ms(v) {
  return (typeof v === 'number') ? v.toFixed(1) + ' ms' : '—';
}

// === 标签 1：视频侧栏注入时机（六档切换，点击写 storage 并刷新生效） ===
async function renderTimingTab() {
  const cur = await readInjectTiming();
  let html = '<div class="pv"><b>【视频侧栏注入时机】当前档 ' + esc(cur) + '</b>'
    + '<div class="pvt">背景：评论区挂载前把侧栏插入右列文档流，会打断 B站 Vue 初始 hydration'
    + '（第362次实锤：只有档0 致评论区消失）。默认档 3＝评论区挂载后再注入，30 秒超时兜底。</div></div>';
  html += '<div class="tgbar">';
  for (const [val, label, tip] of TIMING_LABELS) {
    html += '<button class="tgb' + ((val | 0) === cur ? ' cur' : '') + '" data-timing="' + esc(val)
      + '" title="' + esc(tip) + '">' + esc(label) + '</button>';
  }
  html += '</div>';
  html += '<div class="tip">点击档位写 storage（vsInjectTiming）并刷新页面生效；档0 仅留作对照，勿当默认用。</div>';
  return html;
}

// === 标签 2：加载耗时（提示链路分段时间线 + 扫描挡量 + 去重/对账/词典分段） ===
// 自 main-text.js renderHintTiming 原样迁入（数据源全是 window 全局，与测算结果无关）
function renderLoadTab() {
  let t = null;
  try { t = (typeof window.__beaverHintTiming === 'function') ? window.__beaverHintTiming() : null; }
  catch (e) { return '<div class="err">提示链路计时读取失败：' + esc(e && e.message || e) + '</div>'; }
  if (!t) return '<div class="pv"><b>【网页提示链路耗时】</b><div class="pvt">未取到（text-hint 未在本页启动）</div></div>';
  // 展示顺序＝链路先后；名称给中文说明，避免只有代号看不懂
  const ORDER = [
    ['hint:scriptStart', '内容脚本 classic 入口开跑（注入完成，import 之前）'],
    ['hint:start', 'startHint 入口（ESM 模块图装载完成）'],
    ['hint:bodyReady', 'body 就绪（waitForBody 返回）'],
    ['hint:sched', '扫描进入空闲队列'],
    ['hint:runStart', '扫描真正开跑（等空闲回调，最长 2000ms）'],
    ['hint:walkStart', 'TreeWalker 遍历开始'],
    ['hint:walkEnd', 'TreeWalker 遍历结束'],
    ['hint:firstHighlight', '★首个高亮出现（用户看见提示）'],
    ['hint:firstAnn', '★首条侧注释出现'],
    ['hint:ranksReady', '词频先行就绪（分阶段 Stage 1，只认 rank）'],
    ['hint:ranksRescan', '词频先行重扫（高亮先出，tags/lemma 随后补）'],
    ['hint:dictReady', '词典就绪'],
    ['hint:dictRescan', '词典就绪后重扫'],
    ['hint:scanDone', '本轮扫描全部批次完成']
  ];
  const base = (typeof t.dcl === 'number') ? t.dcl : null;
  let html = '<div class="pv"><b>【网页提示链路耗时】DOMContentLoaded＝'
    + (base != null ? ms(base) : '取不到') + '，快照时刻 ' + ms(t.now) + '</b>';
  html += '<table><tbody>';
  // 启动链路 boot 行（text-hint.js 写入 window.__beaverHintBoot）：import 挂起/失败此前零痕迹
  let boot = null;
  try { boot = (typeof window !== 'undefined') ? window.__beaverHintBoot : null; } catch (e) { /* ignore */ }
  if (boot) {
    const bad = (boot.ok === false) || (boot.state === 'error') || (boot.state === 'hang');
    html += '<tr><td class="k">启动链路 boot</td><td class="' + (bad ? 'v err' : 'v') + '">'
      + esc(String(boot.state || (boot.ok ? 'ok' : '未知')))
      + '</td><td class="n">' + esc(String(boot.error || (boot.ok ? '模块图装载成功' : '（无错误信息）'))) + '</td></tr>';
  }
  for (const [key, label] of ORDER) {
    const v = t.marks[key];
    if (typeof v !== 'number') {
      // 首条侧注释未发生时读 __beaverSideAnnOn（th/core.js getter）区分「预期」与「需查」
      let note = '—';
      if (key === 'hint:firstAnn') {
        let annOn = null;
        try { annOn = (typeof window !== 'undefined') ? window.__beaverSideAnnOn : undefined; } catch (e) { /* ignore */ }
        note = (annOn === true) ? '侧注开关开着却未见——需查'
          : (annOn === false) ? '侧注开关关着＝预期现象' : 'text-hint 未在本页启动';
      }
      html += '<tr><td class="k">' + esc(label) + '</td><td class="v err">未发生</td><td class="n">' + esc(note) + '</td></tr>';
      continue;
    }
    const rel = base != null ? ('DCL 后 ' + ms(v - base)) : '—';
    const cnt = t.counts[key] || 1;
    html += '<tr><td class="k">' + esc(label) + '</td><td class="v">' + ms(v)
      + '</td><td class="n">' + esc(rel) + (cnt > 1 ? ' ｜ 共 ' + cnt + ' 次' : '') + '</td></tr>';
  }
  const ex = t.extra || {};
  html += '<tr><td class="k">文本节点 / 批次 / 串行查词</td><td class="v">'
    + esc((ex.nodes || 0) + ' / ' + (ex.batches || 0) + ' / ' + (ex.queries || 0))
    + '</td><td class="n">批间还各等一次空闲回调（最长 250ms/批，第207次 1000→250）</td></tr>';
  // 扫描挡量：dict-stats 环形账本（最多 8 批）聚合 text-hint 批次的挡量
  const thBatches = getBatches().filter((b) => b && b.source === 'text-hint');
  const agg = thBatches.reduce((s, b) => ({
    tokens: s.tokens + (b.tokens || 0),
    skipSeen: s.skipSeen + (b.skipSeen || 0),
    cacheHit: s.cacheHit + (b.cacheHit || 0),
    highFreq: s.highFreq + (b.highFreq || 0),
    oov: s.oov + (b.oov || 0)
  }), { tokens: 0, skipSeen: 0, cacheHit: 0, highFreq: 0, oov: 0 });
  html += '<tr><td class="k">扫描挡量（text-hint 最近' + thBatches.length + ' 批）</td><td class="v">'
    + '分词 ' + agg.tokens + ' ｜ 高频挡 ' + agg.highFreq + ' ｜ 表外挡 ' + agg.oov
    + '</td><td class="n">跨批重复 ' + agg.skipSeen + ' / 缓存命中 ' + agg.cacheHit
    + '（dict-stats 账本，最多保留 8 批）</td></tr>';
  // 词表去重诊断（计数器在 ws/scanner.js 的 _wsDiag，实时读 window.__beaverWsDedup）
  const dd = (typeof window !== 'undefined' && window.__beaverWsDedup) ? window.__beaverWsDedup : null;
  if (dd) {
    const dupHit = (dd.dupOnInsert > 0) || (dd.domDupBlocked > 0) || (dd.resortDupRemoved > 0);
    html += '<tr><td class="k">词表去重诊断（重复调查）</td><td class="' + (dupHit ? 'v err' : 'v') + '">'
      + '收词 ' + (dd.collectCalls || 0) + ' 次 / 递词 ' + (dd.offered || 0)
      + ' ｜ 入表 ' + (dd.accepted || 0) + ' / 实插 ' + (dd.inserted || 0)
      + '</td><td class="n">'
      + '★重复实锤 ' + (dd.dupOnInsert || 0)
      + ' ｜ 键集DOM失联 ' + (dd.domDupBlocked || 0)
      + ' ｜ 重排清重 ' + (dd.resortDupRemoved || 0)
      + ' ｜ 挡：键集 ' + (dd.blockedKey || 0) + ' / 批内 ' + (dd.blockedBatch || 0)
      + ' / 高频 ' + (dd.blockedHighRank || 0) + ' / 表外 ' + (dd.blockedOov || 0)
      + '</td></tr>';
  }
  // 侧栏现状行：词表条目数/同 data-word 直读重复/句子条目数（window.__beaverWsPanelStats）
  const ps = (typeof window !== 'undefined' && typeof window.__beaverWsPanelStats === 'function') ? window.__beaverWsPanelStats() : null;
  if (ps && !ps.err) {
    html += '<tr><td class="k">侧栏现状（重复直读）</td><td class="' + (ps.dupCount > 0 ? 'v err' : 'v') + '">'
      + '词表 ' + ps.words + ' 条（唯一 ' + ps.uniq + '）｜ 句子 ' + ps.sentences + ' 条'
      + '</td><td class="n">'
      + (ps.dupCount > 0 ? '★同键重复 ' + ps.dupCount + ' 组：' + esc(ps.dupKeys) : '同键重复 0 ｜ 词表数组 ' + ps.arrLen)
      + '</td></tr>';
  }
  // 词集对账：网页 .beaver-word 高亮全集 vs 侧栏词表 data-word 互差（window.__beaverWordCompare）
  const wc = (typeof window !== 'undefined' && typeof window.__beaverWordCompare === 'function') ? window.__beaverWordCompare() : null;
  if (wc && !wc.err) {
    const bad = (wc.onlyPageTotal > 0) || (wc.onlyPanelTotal > 0);
    html += '<tr><td class="k">词集对账（网页 vs 侧栏）</td><td class="' + (bad ? 'v err' : 'v') + '">'
      + '网页 ' + wc.pageCount + ' 词 ｜ 侧栏 ' + wc.panelCount + ' 词'
      + '</td><td class="n">'
      + (bad
        ? ('仅网页 ' + wc.onlyPageTotal + '：' + esc((wc.onlyPage || []).join('、'))
          + ' ｜ 仅侧栏 ' + wc.onlyPanelTotal + '：' + esc((wc.onlyPanel || []).join('、')))
        : '两侧一致')
      + '</td></tr>';
  }
  // 词典装载分段（window.__beaverDictTiming + __beaverIdbTiming 细分）
  const dt = (typeof window !== 'undefined' && window.__beaverDictTiming) ? window.__beaverDictTiming : null;
  if (dt && (dt.proj > 0 || dt.rebuild > 0)) {
    const it = (typeof window !== 'undefined' && window.__beaverIdbTiming) ? window.__beaverIdbTiming : null;
    const idbNote = it
      ? ('IDB: 连接 ' + (it.open || 0) + 'ms ｜ rank表 ' + (it.ranks || 0) + 'ms/' + (it.rankRows || 0) + '行'
        + ' ｜ tags表 ' + (it.tags || 0) + 'ms/' + (it.tagRows || 0) + '行'
        + ' ｜ lemma表 ' + (it.lemmas || 0) + 'ms/' + (it.lemmaRows || 0) + '行'
        + ' ｜ meta ' + (it.meta || 0) + 'ms')
      : '';
    html += '<tr><td class="k">词典装载分段</td><td class="v">'
      + '投影读取 ' + (dt.proj || 0) + 'ms / Map构建 ' + (dt.map || 0) + 'ms'
      + ' / manifest对账 ' + (dt.manifest || 0) + 'ms / 重建补齐 ' + (dt.rebuild || 0) + 'ms'
      + '</td><td class="n">合计 ' + (dt.total || 0) + 'ms（对照"词典就绪"行）' + (idbNote ? '<br>' + esc(idbNote) : '') + '</td></tr>';
  }
  html += '</tbody></table></div>';
  // 重复现场事件块（scanner.js 的 _wsDupEvents，旧→新，上限 10 条）
  if (dd && Array.isArray(dd.events) && dd.events.length > 0) {
    html += '<div class="pv"><b>【重复现场记录】（旧→新，最多 10 条）</b><div class="pvt">'
      + esc(dd.events.join('\n')) + '</div></div>';
  }
  return html;
}

// === 标签 3：正文提取（四方案对比表 + 各方案预览；对比维度说明沿用第194/206次口径） ===
function renderExtractTab(r) {
  let html = '<table><tbody>';
  html += '<tr><td class="k">对比维度说明</td><td class="v" colspan="2">'
    + '①喂法对比＝同一个 Readability 喂入范围不同（整页克隆 / 子树克隆）；'
    + '②替代对比＝换掉 Readability 本体（方案五/六＝Defuddle 的整页/子树两种喂法；'
    + '自研密度法为零依赖候选）。整页克隆只是喂法，不是替代。'
    + '选型（第206次用户裁定）：给 AI 的主链路＝方案五 Defuddle（整页克隆喂入），'
    + '自研密度法兜底、直接解析保底；Readability 退出主链，仅存本表对比。</td></tr>';
  html += '<tr><td class="k">Readability 模块加载</td><td class="v">' + ms(r.loadMs)
    + '</td><td class="n">首次约 90KB，之后走缓存</td></tr>';
  // 四方案逐行：耗时 / 字符数 / 备注，失败则显示原始错误（不遮蔽）
  for (const p of (r.plans || [])) {
    if (p.error) {
      html += '<tr><td class="k">' + esc(p.name) + '</td><td class="v err">失败</td><td class="n">'
        + esc(p.error) + '</td></tr>';
      continue;
    }
    html += '<tr><td class="k">' + esc(p.name) + '</td><td class="v">' + ms(p.ms)
      + '</td><td class="n">' + esc(p.chars) + ' 字符 ｜ ' + esc(p.note || '') + '</td></tr>';
  }
  html += '</tbody></table>';
  // 各方案正文预览：预览 300 字符是展示口径不是提取上限，「展开全文」看提取全文
  let _pi = -1;
  for (const p of (r.plans || [])) {
    _pi++;
    if (p.error || !p.preview) continue;
    html += '<div class="pv"><b>' + esc(p.name) + '</b>'
      + '<button class="pvtg" data-pv="' + _pi + '">展开全文</button>'
      + '<div class="pvt" data-pv="' + _pi + '">' + esc(p.preview) + '…</div></div>';
  }
  return html;
}

// === 标签 4：AI 上下文（当前送给 AI 的正文：来源/字符数/耗时 + 全文预览） ===
function renderAiTab(r) {
  if (r.aiError) {
    return '<div class="err">当前送 AI 的正文获取失败：' + esc(r.aiError) + '</div>';
  }
  if (r.aiPreview === undefined) {
    return '<div class="pv"><div class="pvt">未取到（本页无送 AI 的正文）</div></div>';
  }
  return '<div class="pv"><b>【当前送给 AI 的上下文】来源=' + esc(r.aiSource) + '，'
    + esc(r.aiChars) + ' 字符，' + ms(r.aiMs) + '</b>'
    + (r.aiFull ? '<button class="pvtg" data-pv="ai">展开全文</button>' : '')
    + '<div class="pvt" data-pv="ai">' + esc(r.aiPreview) + '…</div></div>';
}

// === 标签 5：下载音频（视频语境＝动作按钮；无视频语境＝说明） ===
function renderAudioTab() {
  if (_audioDownload) {
    return '<div class="pv"><b>⬇️ 下载音频</b><div class="pvt">功能本体在 vs/record-workflow.js'
      + '（onDownloadAudioClick，取当前视频），进度条/报错走原链路。</div></div>'
      + '<div class="tgbar"><button class="tgb" id="beaver-diag-audio-btn">'
      + esc(_audioDownload.label || '⬇️ 下载音频') + '</button></div>';
  }
  return '<div class="pv"><b>⬇️ 下载音频</b><div class="pvt">本入口无视频语境——'
    + '从视频侧栏 ⋯ 菜单 →「诊断中心」打开本窗，此标签才有下载动作。</div></div>';
}

// 按当前标签渲染内容区（extract/ai 依赖测算结果，timing 依赖 storage 实读）。
// 注意：各分支先拼完整 html 再一次性赋 innerHTML——若先赋值再绑定事件，后续
// innerHTML += 会重新解析 DOM 把刚绑的监听器干掉（音频按钮即此坑）。
async function renderTab(shadow, tab) {
  const bd = shadow.querySelector('.bd');
  let html;
  if (tab === 'extract' || tab === 'ai') {
    bd.innerHTML = '<div class="tip">测算中…</div>';
    try {
      if (!shadow.__r) shadow.__r = await measureMainTextExtractors();
    } catch (e) {
      // 不遮蔽错误：连测算本身都抛了，就把异常原文摆出来
      bd.innerHTML = '<div class="err">测算异常：' + esc(String((e && e.stack) || e)) + '</div>';
      return;
    }
    html = (tab === 'extract') ? renderExtractTab(shadow.__r) : renderAiTab(shadow.__r);
  } else if (tab === 'timing') {
    html = await renderTimingTab();
  } else if (tab === 'load') {
    html = renderLoadTab();
  } else {
    html = renderAudioTab();
  }
  html += '<div class="tip">页面：' + esc(location.host) + ' ｜ ' + new Date().toLocaleTimeString()
    + ' ｜ 标题栏拖动移动 ｜ 右下角拖拽调大小 ｜ 「展开全文」看提取全文</div>';
  bd.innerHTML = html;
  if (tab === 'audio' && _audioDownload) {
    const btn = bd.querySelector('#beaver-diag-audio-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        try {
          if (typeof _audioDownload.onClick === 'function') _audioDownload.onClick();
        } catch (err) {
          // 不遮蔽：动作自身抛错必须出声（窗内可见 + 控制台留痕）
          console.error('[VocabRadar][diag-window] 下载音频动作执行失败:', err);
        }
      });
    }
  }
}

// 切标签 + 更新高亮 + 记忆
function switchTab(shadow, tab) {
  _curTab = tab;
  shadow.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('cur', b.dataset.tab === tab);
  });
  renderTab(shadow, tab).catch((e) => {
    console.error('[VocabRadar][diag-window] 标签渲染失败:', e);
  });
}

/**
 * 打开/复用「诊断中心」路由窗
 * @param {{audioDownload?: {label:string, title?:string, onClick:Function},
 *   reveal?: boolean}} opts
 *   audioDownload —— 视频侧栏入口注入的下载音频动作（点击回调走原 record-workflow 链路）；
 *   reveal=false（快捷键调用）→ 纯切换显隐；缺省（菜单调用）→ 强制显示并重测。
 * @returns {Promise<void>}
 */
export async function openDiagCenter(opts = {}) {
  let host = document.getElementById(DIAG_HOST_ID);
  let shadow;
  if (host && host.shadowRoot) {
    shadow = host.shadowRoot;
  } else {
    host = document.createElement('div');
    host.id = DIAG_HOST_ID;
    // 创建即隐藏（诊断窗默认不可见，仅 Ctrl+Shift+V / 菜单唤出——第363次语义）
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;display:none;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        /* 样式承自原 main-text 诊断窗：resize:both + 拖动 + 视口宽松钳位（第195/213次） */
        .box { width: 520px; height: calc(50vh + 78px); min-width: 340px; min-height: 220px;
               max-width: 96vw; max-height: 94vh;
               display: flex; flex-direction: column; resize: both; overflow: hidden;
               background: #1f2430; color: #e8eaed;
               font: 12px/1.6 -apple-system, "Segoe UI", sans-serif; border-radius: 10px;
               box-shadow: 0 8px 28px rgba(0,0,0,.45); }
        .hd { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #2b3242; }
        .hd .ttl { flex: 1; font-weight: 600; }
        .hd button { background: #3a4457; color: #e8eaed; border: 0; border-radius: 6px;
                     padding: 4px 10px; cursor: pointer; font-size: 12px; }
        .hd button:hover { background: #4a566e; }
        /* 路由标签条：点哪个标签显示哪个 */
        .tabs { flex: 0 0 auto; display: flex; gap: 4px; padding: 0 10px 8px;
                background: #2b3242; flex-wrap: wrap; }
        .tabs button { background: #3a4457; color: #c8cfdd; border: 0; border-radius: 6px;
                       padding: 3px 9px; cursor: pointer; font-size: 11px; }
        .tabs button:hover { background: #4a566e; }
        .tabs button.cur { background: #1a7f4b; color: #fff; font-weight: 600; }
        .bd { flex: 1 1 auto; min-height: 0; padding: 8px 10px; overflow: auto; }
        table { width: 100%; border-collapse: collapse; }
        td { padding: 3px 4px; vertical-align: top; border-bottom: 1px solid #2f3646; }
        td.k { white-space: nowrap; color: #b8c0cf; }
        td.v { white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; color: #7ee2a8; }
        td.n { color: #8b93a3; font-size: 11px; }
        td.v.err { color: #ff9a9a; }
        .err { margin-top: 6px; color: #ff9a9a; word-break: break-all; }
        .tip { margin-top: 6px; color: #8b93a3; font-size: 11px; }
        .pv { margin-top: 8px; }
        .pv b { color: #cfd6e4; font-weight: 600; }
        .pvt { margin-top: 3px; padding: 5px 6px; background: #171b24; border-radius: 5px;
               color: #9aa5b8; font-size: 11px; max-height: 90px; overflow: auto;
               white-space: pre-wrap; word-break: break-word; }
        .pvt.pvfull { max-height: 44vh; }
        .pvtg { float: right; background: #3a4457; color: #e8eaed; border: 0; border-radius: 5px;
                padding: 2px 8px; cursor: pointer; font-size: 11px; }
        .pvtg:hover { background: #4a566e; }
        /* 注入时机档位按钮组（原独立浮窗档位样式并入） */
        .tgbar { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
        .tgb { background: #3a3a3a; color: #eee; border: 0; border-radius: 4px;
               padding: 4px 8px; cursor: pointer; font-size: 11px; }
        .tgb:hover { background: #555; }
        .tgb.cur { background: #1a7f4b; color: #fff; font-weight: 600; }
      </style>
      <div class="box">
        <div class="hd">
          <span class="ttl"></span>
          <button class="run">重新测算</button>
          <button class="close">关闭</button>
        </div>
        <div class="tabs"></div>
        <div class="bd"><div class="tip">测算中…</div></div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);
    // 标题与标签文案走 i18n（随界面语言），窗内调试内容保持中文（先例）
    shadow.querySelector('.ttl').textContent = t('ws.diagCenter');
    const tabsEl = shadow.querySelector('.tabs');
    for (const [key, i18nKey] of TABS) {
      const b = document.createElement('button');
      b.dataset.tab = key;
      b.textContent = t(i18nKey);
      b.addEventListener('click', () => switchTab(shadow, key));
      tabsEl.appendChild(b);
    }
    shadow.querySelector('.close').addEventListener('click', () => { host.style.display = 'none'; });
    // 重新测算 = 丢弃缓存结果，重跑当前标签（extract/ai 才真正重跑测量）
    shadow.querySelector('.run').addEventListener('click', () => {
      shadow.__r = null;
      renderTab(shadow, _curTab).catch((e) => {
        console.error('[VocabRadar][diag-window] 重测渲染失败:', e);
      });
    });
    // 标题栏拖拽移动（原窗同款：right/bottom 切 left/top，宽松钳位，setPointerCapture 跟手）
    const hd = shadow.querySelector('.hd');
    hd.style.cursor = 'move';
    let dragState = null;
    hd.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = host.getBoundingClientRect();
      dragState = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try { hd.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      e.preventDefault();
    });
    hd.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      const grab = hd.offsetHeight || 40;
      const x = Math.min(Math.max(e.clientX - dragState.dx, 8 - host.offsetWidth), window.innerWidth - 8);
      const y = Math.min(Math.max(e.clientY - dragState.dy, 8 - grab), window.innerHeight - 8);
      host.style.left = x + 'px';
      host.style.top = y + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    });
    const endDrag = () => { dragState = null; };
    hd.addEventListener('pointerup', endDrag);
    hd.addEventListener('pointercancel', endDrag);
    // 「展开全文/收起」委托监听（.bd 常驻，innerHTML 重建不影响；全文挂 shadow.__r）
    const bdEl = shadow.querySelector('.bd');
    bdEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.pvtg');
      if (!btn) return;
      const key = btn.dataset.pv;
      const div = bdEl.querySelector('.pvt[data-pv="' + key + '"]');
      if (!div) return;
      const full = (key === 'ai')
        ? (shadow.__r || {}).aiFull
        : (((shadow.__r || {}).plans || [])[Number(key)] || {}).full;
      if (!full) return;
      const expandNow = !div.classList.contains('pvfull');
      if (expandNow) {
        div.dataset.prev = div.textContent.replace(/…$/, '');
        div.textContent = full;
      } else {
        div.textContent = (div.dataset.prev || '') + '…';
      }
      div.classList.toggle('pvfull', expandNow);
      btn.textContent = expandNow ? '收起' : '展开全文';
    });
  }
  _audioDownload = (opts.audioDownload && typeof opts.audioDownload.onClick === 'function')
    ? opts.audioDownload : null;
  // 显隐统一出口：菜单调用（缺省）→ 强制显示并重测；快捷键（reveal:false）→ 纯切换，仅唤出时重测
  const reveal = (opts.reveal === false) ? (host.style.display === 'none') : true;
  host.style.display = reveal ? 'block' : 'none';
  if (reveal) {
    // 唤出即重测（第363次语义）：丢缓存，按当前标签重渲染
    shadow.__r = null;
    switchTab(shadow, _curTab);
    // await renderTab 交给 switchTab 内部 catch，这里无需 await（显隐已定，渲染自跑）
  }
}

// Ctrl+Shift+V 唤出/隐藏（本窗是唯一接收方——原 main-text 窗与 inject-timing 浮窗同键双开已消除）。
// 注册守卫：仅网页环境；window 幂等标记防同页多个 content script 入口重复绑定。
if (typeof window !== 'undefined' && typeof document !== 'undefined'
    && location.protocol.startsWith('http')
    && !window.__vrDiagCenterKeyBound) {
  window.__vrDiagCenterKeyBound = true;
  window.addEventListener('keydown', (ev) => {
    try {
      if (!ev.ctrlKey || !ev.shiftKey) return;
      if ((ev.key || '').toLowerCase() !== 'v') return;
      const tg = ev.target;  // 命名避开模块导入的 i18n t（遮蔽易误导）
      if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
      openDiagCenter({ reveal: false }).catch(() => { /* 诊断窗异常不外溢按键链 */ });
    } catch (e) { /* ignore */ }
  }, true);
}
