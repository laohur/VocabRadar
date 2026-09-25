/* 管理界面：公共工具 + 总览页（状态/基础设定）+ hash 路由。
   五功能页在 pages.js（全局 Pages），原生 JS 无构建。文案经 t()（i18n.js）中英双语。 */
'use strict';

// ---- 公共工具（pages.js 依赖） ----

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);  // null/undefined 跳过（如 checked: null）
  }
  for (const c of children) {
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

function badge(on, onText, offText) {
  return el('span', { class: `badge ${on ? 'on' : 'off'}` },
    on ? (onText || t('Running')) : (offText || t('Stopped')));
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}

// 第425次：恢复 extraQuery（如 'no_reload=1' 旁路热重载）；返回响应体供调用方判断
// llm_reloading/restart_required（第431次：撤 llm_downloading——模型改 -hf 自动下载）
async function saveCfg(section, patch, hintEl, doneText, extraQuery) {
  try {
    const r = await api(`/api/config${extraQuery ? `?${extraQuery}` : ''}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(section ? { [section]: patch } : patch),
    });
    hintEl.textContent = r.llm_reloading
      ? t('Saved. Reloading llama-server with the new model…')
      : r.restart_required
        ? t('Saved. Port/host changes require a backend restart to take effect.')
        : t(doneText || 'Saved.');
    hintEl.className = 'hint';
    return r;
  } catch (e) {
    hintEl.textContent = t('Save failed: {msg}', { msg: e.message });
    hintEl.className = 'error';
    return null;
  }
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function field(labelText, input, hint) {
  const wrap = el('label', { class: 'field' }, el('span', {}, labelText), input);
  if (hint) wrap.append(el('small', {}, hint));
  return wrap;
}

function select(options, value, attrs = {}) {
  return el('select', attrs, ...options.map(([v, text]) =>
    el('option', { value: v, ...(v === value ? { selected: '' } : {}) }, text)));
}

// 设定卡通用组装：fields = [[label, input, hint?], ...]
function settingsCard(title, fields, onSave, saveText = 'Save Settings') {
  const hint = el('div', { class: 'hint' });
  const inputs = fields.map((f) => f[1]);
  const card = el('div', { class: 'card' },
    el('h2', {}, title),
    ...fields.map((f) => field(f[0], f[1], f[2])),
    el('button', { class: 'btn', onclick: () => onSave(inputs, hint) }, saveText),
    hint);
  return card;
}

// ---- 总览页 ----

// 引擎加载/关停（第408次：模型服务可选化，/api/engine/<name>/start|stop）
async function engineToggle(name, action, btn, errEl) {
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '…';
  if (errEl) errEl.textContent = '';
  try {
    await api(`/api/engine/${name}/${action}`, { method: 'POST' });
    renderOverview(document.getElementById('main'));  // 成功即重拉状态刷新整页
  } catch (e) {
    btn.textContent = orig;
    btn.disabled = false;
    if (errEl) errEl.textContent = e.message;
  }
}

function statusRow(name, st, engine, running, detail, toggle) {
  const ops = el('td');
  if (toggle) {
    const loading = Boolean(st && st.loading);
    const on = Boolean(running);
    const errEl = el('span', { class: 'error engine-err' });
    const start = el('button', {
      class: 'btn btn-sm', disabled: on || loading ? '' : null,
      onclick: (e) => engineToggle(toggle, 'start', e.target, errEl),
    }, t('Start'));
    const stop = el('button', {
      class: 'btn btn-sm', disabled: !on || loading ? '' : null,
      onclick: (e) => engineToggle(toggle, 'stop', e.target, errEl),
    }, t('Stop'));
    ops.append(start, ' ', stop, ' ', errEl);
    if (loading) ops.append(' ', t('loading…'));
  }
  return el('tr', {},
    el('td', {}, t(name)),
    el('td', {}, engine),
    el('td', {}, badge(Boolean(running))),
    el('td', { class: 'hint' }, detail || st.detail || ''),
    ops);
}

async function renderOverview(main) {
  main.innerHTML = '';
  main.append(el('h1', {}, t('Overview / Status')));
  main.append(el('div', { class: 'hint' }, t('Loading…')));
  let data;
  try {
    data = await api('/api/status');
  } catch (e) {
    main.innerHTML = '';
    main.append(el('h1', {}, t('Overview / Status')));
    main.append(el('div', { class: 'error' }, t('Failed to load status: {msg}', { msg: e.message })));
    return;
  }
  main.innerHTML = '';
  const eng = data.engines || {};

  if (data.needs_setup) {
    // 第431次：needs_setup 语义改为「未配置模型卡片」（models/ 撤销，「未安装」概念消失）
    main.append(el('div', { class: 'notice' },
      t('No model cards configured. Open the LLM page and pick a default model — it auto-downloads on first use.')));
  }

  const rows = [
    ['LLM', eng.llm, eng.llm && eng.llm.engine, eng.llm && (eng.llm.running ?? eng.llm.loaded),
      eng.llm && (t('mode={m} · internal port {p}', { m: eng.llm.mode, p: eng.llm.port })
        + (eng.llm.model ? ' ' + t('· model {m}', { m: eng.llm.model }) : '')), 'llm'],
    ['ASR', eng.asr, eng.asr && eng.asr.engine, eng.asr && (eng.asr.loaded || eng.asr.loading),
      eng.asr && (t('mode={m}', { m: eng.asr.mode })
        + (eng.asr.loaded ? ' ' + t('· loaded {e}', { e: eng.asr.loaded_engine || '' }) : '')
        + (eng.asr.model ? ' · ' + eng.asr.model : '')), 'asr'],
    ['OCR', eng.ocr, eng.ocr && eng.ocr.engine, eng.ocr && (eng.ocr.loaded || eng.ocr.loading),
      eng.ocr && t('mode={m}', { m: eng.ocr.mode }) + (eng.ocr.loaded ? ' · loaded' : ''), 'ocr'],
    ['Translate', eng.translate, eng.translate && eng.translate.engine,
      eng.translate && eng.translate.llm && (eng.translate.llm.running ?? eng.translate.llm.loaded),
      eng.translate && (eng.translate.llm && eng.translate.llm.running
        ? t('llama-server running') : t('Uses the LLM engine; start/stop on the LLM row'))],
    ['Downloader', eng.ytdl, 'yt-dlp' + (eng.ytdl && eng.ytdl.version ? ` v${eng.ytdl.version}` : ''), true,
      eng.ytdl && (t('default format {f}', { f: eng.ytdl.format })
        + (eng.ytdl.cookiefile ? ' ' + t('· cookie configured') : ''))],
  ];
  main.append(el('table', {},
    el('tr', {}, el('th', {}, t('Feature')), el('th', {}, t('Engine')), el('th', {}, t('Status')),
      el('th', {}, t('Details')), el('th', {}, t('Action'))),
    ...rows.map((r) => statusRow(...r))));

  // 第431次：升级中心撤除——模型交 llama-server -hf 自动下载（HF hub 缓存），
  // llama.cpp/yt-dlp 升级暂无 UI 入口（后端 scripts/upgrade.py 保留，去留待定）

  // ---- 基础设定 ----
  let cfg0 = {};
  try {
    cfg0 = (await api('/api/config')).config || {};
  } catch (_e) { /* 配置读失败仍可看状态 */ }
  const port = el('input', { type: 'number', value: cfg0.port ?? 7777 });
  const host = el('input', { value: cfg0.host ?? '127.0.0.1' });
  const gpu = select([['auto', 'auto'], ['vulkan', 'vulkan'], ['cuda', 'cuda'], ['cpu', 'cpu']],
    (cfg0.binaries && cfg0.binaries.gpu) || 'auto');
  const cfgHint = el('div', { class: 'hint' });
  const basics = el('div', { class: 'card' },
    el('h2', {}, t('Basic Settings')),
    field(t('Port'), port, t('After changing the port and restarting, the extension auto-scans 7777–7827 to find the new address')),
    field(t('Listen Address'), host, t('Keep 127.0.0.1 (do not expose to the LAN)')),
    field(t('GPU Backend'), gpu, t('llama.cpp asset selection; takes effect after restart')),
    el('button', {
      class: 'btn',
      onclick: () => saveCfg(null, {
        port: Number(port.value) || 7777,
        host: host.value.trim() || '127.0.0.1',
        binaries: { gpu: gpu.value },
      }, cfgHint),
    }, t('Save Basic Settings')),
    cfgHint);

  main.append(basics);

  // ---- 后端日志（第409次：引擎输出/对话/反代日志可见化，GET /api/logs；
  //       第410次：3s 自动轮询，路由切换时经 logTimer 清理） ----
  const uplog = el('pre', { class: 'uplog' });
  const loadLogs = async () => {
    try {
      const r = await api('/api/logs?tail=200');
      uplog.textContent = (r.lines || []).join('\n') || t('(log is empty)');
      uplog.scrollTop = uplog.scrollHeight;
    } catch (e) { uplog.textContent = t('Failed: {msg}', { msg: e.message }); }
  };
  // 异步渲染完成时可能已切走（route 已清 logTimer），此时不再起轮询
  if ((location.hash || '#overview').slice(1) === 'overview') {
    loadLogs();
    logTimer = setInterval(loadLogs, 3000);
  }
  main.append(el('div', { class: 'card' },
    el('h2', {}, t('Backend Logs')),
    el('div', { class: 'chatbar' }, el('button', { class: 'btn', onclick: loadLogs }, t('Refresh'))),
    uplog));
}

// ---- 路由 ----

const TITLES = { llm: 'LLM', translate: 'Translate', asr: 'ASR', ocr: 'OCR', ytdl: 'Downloader' };
let logTimer = null;  // 第410次：总览日志卡自动刷新句柄——路由切换时清理，防 interval 泄漏

function route() {
  const page = (location.hash || '#overview').slice(1);
  document.querySelectorAll('.sidebar button').forEach((b) => {
    b.classList.toggle('active', b.dataset.page === page);
  });
  clearInterval(logTimer);  // 离开总览页即停日志轮询
  const main = document.getElementById('main');
  if (page === 'overview') renderOverview(main);
  else if (window.Pages && Pages[page]) Pages[page](main);
  else {
    main.innerHTML = '';
    main.append(el('h1', {}, TITLES[page] || page));
    main.append(el('div', { class: 'placeholder' }, t('Not implemented.')));
  }
}

// 侧栏切换：路由只监听 hashchange，此处把点击翻译成 hash（事件委托，按钮含分组标题也不误触）
document.querySelector('.sidebar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-page]');
  if (b) location.hash = '#' + b.dataset.page;
});

window.addEventListener('hashchange', route);
// 第414次：初始路由推迟到 DOMContentLoaded——本文件先于 pages.js 加载，
// 同步 route() 时 window.Pages 尚未挂载，非总览 hash 直达（含语言切换按钮
// 的 location.reload）会落到「Not implemented」占位页。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', route);
} else {
  route();
}
