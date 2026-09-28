// =============================================================================
// 引导页「渠道状态」行模块（2026-09-28 第461次·新增）
// 职责：向 SW 请求 CHANNEL_STATUS 消息（sw/translate.js 登记簿快照），
//   渲染进 guide.html #transChHealthDetail（标签 #transChHealth 走 i18n data-key）。
// 拆分原因：guide.js 已 1200+ 行、超 AGENTS.md 1000 行上限，新逻辑独立成模块
//   （同 my-words.js / deactivate.js 先例），guide.js 只留两处接线：
//   renderAll → refreshChHealth()（打开即刷）、init 时 initChHealth()（周期刷）。
// 展示口径（语言中立，只用记号不造句）：
//   - 活跃渠道（有过成功或失败）按渠道表序列出：`Bing 5/2`（ok/fail）；
//   - 冷却中追加 `·cool42s`；无任何记录 → `—`；
//   - 单渠道详情（最近错误/耗时/最近成功）放 title 悬浮，不挤行宽。
// 数据随 SW 生命周期存内存，SW 重启即清零——这是预期行为（新进程新账本）。
// =============================================================================
const $id = (id) => document.getElementById(id);

let _log = () => { };
let _timer = 0;
let _seq = 0;   // 请求序号：迟到的旧响应不覆盖新结果

/** 单渠道详情 title（错误/耗时/最近成功，语言中立的键值对） */
function _title(c) {
  const parts = ['ok=' + c.ok, 'fail=' + c.fail];
  if (c.consec) parts.push('consec=' + c.consec);
  if (c.coolingMs) parts.push('cool=' + Math.ceil(c.coolingMs / 1000) + 's');
  if (c.lastErr) parts.push('lastErr=' + c.lastErr);
  if (c.lastMs) parts.push('lastMs=' + c.lastMs + 'ms');
  if (c.lastOk) parts.push('lastOk=' + new Date(c.lastOk).toLocaleTimeString());
  return c.name + ' ' + parts.join(' · ');
}

/**
 * 拉取并渲染渠道状态（fire-and-forget；SW 未就绪/消息失败时保持占位不动）。
 * @param {Object} [opts] { log } —— 仅错误路径打日志（成功不刷屏）
 */
export function refreshChHealth(opts) {
  const el = $id('transChHealthDetail');
  if (!el) return;
  const mySeq = ++_seq;
  try {
    chrome.runtime.sendMessage({ type: 'CHANNEL_STATUS' }, (resp) => {
      if (mySeq !== _seq || !$id('transChHealthDetail')) return;   // 已被更新的请求取代
      const err = chrome.runtime.lastError;
      if (err || !resp || resp.ok !== true || !Array.isArray(resp.channels)) {
        if (opts && opts.log) opts.log('渠道状态拉取失败:', (err && err.message) || (resp && resp.ok));
        return;
      }
      const act = resp.channels.filter((c) => c.ok || c.fail);
      el.textContent = act.length
        ? act.map((c) => c.name + ' ' + c.ok + '/' + c.fail + (c.coolingMs ? '·cool' + Math.ceil(c.coolingMs / 1000) + 's' : '')).join(' · ')
        : '—';
      el.title = resp.channels.map(_title).join('\n');
    });
  } catch (e) {
    if (opts && opts.log) opts.log('渠道状态 sendMessage 异常:', e);
  }
}

/**
 * init 接线：周期刷新（6 秒；页面不可见时暂停，免得引导页挂着空转）。
 * @param {Object} opts { log } —— guide.js 的日志（避免跨模块依赖）
 */
export function initChHealth(opts) {
  if (opts && opts.log) _log = opts.log;
  if (_timer) return;
  refreshChHealth({ log: _log });
  _timer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshChHealth({ log: _log });
  }, 6000);
  // 引导页关闭时停表（beforeunload 覆盖 iframe/正常关闭两种路径）
  window.addEventListener('beforeunload', () => {
    if (_timer) { clearInterval(_timer); _timer = 0; }
  });
}
