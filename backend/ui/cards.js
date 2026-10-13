/* 模型卡片编辑器（LLM 页与翻译页共用，plan §3.4）：
   上方卡片清单、下方单一详情表单——点击清单行（或上方模型下拉）即在下方
   显示该卡详情，同一时刻只渲染一张；清单行内直接展示 hf_repo 与模型说明
   （按界面语言取中/英）；内置卡只读（改动走「另存为新卡片」），自定义卡
   可保存可删除；「下载」按钮手动预下载模型进 hub 缓存（hf → hf-mirror）；
   增改删走 /api/llm/models 与 /api/translate/models（同构，见
   backend/api/cards.py）。依赖 admin.js 的 el/field/badge/api 与
   i18n.js 的 t()/currentLang()；文案经 t() 中英双语。 */
'use strict';

// 除 name/command 外的可编辑字符串字段（translate_prompt 仅翻译卡有）
const CARD_TEXT_FIELDS = [
  ['desc', 'Description (中文)', 3],
  ['desc_en', 'Description (English)', 3],
  ['hf_repo', 'HF repo', 1],
  ['fallback_url', 'Fallback URL (GGUF direct link)', 1],
  ['fallback_mmproj_url', 'Fallback mmproj URL', 1],
];
// 采样参数（数值；llm_engine.start 注入 llama-server 启动参数）
const CARD_SAMPLING_KEYS = ['temperature', 'top_p', 'top_k', 'min_p', 'repeat_penalty'];

// 表单 → 提交体（空值不写；采样非数值/空串一律丢弃，白名单同后端）
function cardPayload(inputs) {
  const val = (k) => (inputs[k] ? inputs[k].value.trim() : '');
  const body = { name: val('name'), command: val('command') };
  for (const [k] of CARD_TEXT_FIELDS) {
    if (val(k)) body[k] = val(k);
  }
  if (inputs.translate_prompt && val('translate_prompt')) {
    body.translate_prompt = val('translate_prompt');
  }
  const smp = {};
  for (const k of CARD_SAMPLING_KEYS) {
    const raw = val('smp_' + k);
    if (raw !== '' && Number.isFinite(Number(raw))) smp[k] = Number(raw);
  }
  if (Object.keys(smp).length) body.sampling = smp;
  return body;
}

// 下方详情表单：按所选卡（src=null → 新卡空表单）渲染字段与按钮
function cardDetail(src, opts) {
  const isNew = !src;
  const c = src || { name: '', command: '', builtin: false };
  const inputs = {};
  const hint = el('div', { class: 'hint' });
  const form = el('div', { class: 'mform' });

  const mk = (key, label, rows) => {
    const input = rows > 1 ? el('textarea', { rows }) : el('input', {});
    input.value = c[key] || '';
    inputs[key] = input;
    form.append(field(label, input));
  };
  mk('name', t('Name (unique ID, e.g. org/repo:Q4_K_M)'), 1);
  mk('command', t('Launch command (llama-server …; -hf <repo>:<quant> drives auto-download)'), 2);
  for (const [k, label, rows] of CARD_TEXT_FIELDS) mk(k, label, rows);
  if (opts.withTranslatePrompt) mk('translate_prompt', t('Translation prompt template ({dst} / {text} placeholders)'), 3);

  // HF repo 字段下附镜像链接（后缀 mirror）：启动/手动下载都会经 hf-mirror，
  // 点开可直接核对仓库文件；随输入实时更新
  const mirrorLine = el('div', { class: 'hint mrow-sub' });
  const updMirror = () => {
    const repo = (inputs.hf_repo.value || '').trim().replace(/^\/+|\/+$/g, '');
    mirrorLine.innerHTML = '';
    if (repo) {
      const url = 'https://hf-mirror.com/' + repo;
      mirrorLine.append(t('Mirror') + '：', el('a', { href: url, target: '_blank', rel: 'noreferrer' }, url));
    }
  };
  inputs.hf_repo.addEventListener('input', updMirror);
  updMirror();
  inputs.hf_repo.closest('.field').append(mirrorLine);

  const smpBar = el('div', { class: 'chatbar' });
  for (const k of CARD_SAMPLING_KEYS) {
    const inp = el('input', { type: 'number', step: 'any', placeholder: k });
    const cur = (c.sampling || {})[k];
    if (cur != null) inp.value = String(cur);
    inputs['smp_' + k] = inp;
    smpBar.append(field(k, inp));
  }
  form.append(el('div', { class: 'hint' }, t('Sampling (blank = llama-server default)')), smpBar);

  // 粘贴完整启动命令 → 解析出 name/hf_repo/兜底直链（/api/llm/models/parse，两段同用）
  const cmdInput = el('input', { placeholder: t('Paste a full llama-server command to auto-fill…') });
  form.append(el('div', { class: 'chatbar' }, cmdInput,
    el('button', {
      class: 'btn', onclick: async () => {
        hint.className = 'hint';
        hint.textContent = t('Parsing…');
        try {
          const r = await api('/api/llm/models/parse', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cmd: cmdInput.value }),
          });
          const p = r.parsed || {};
          for (const k of ['name', 'hf_repo', 'fallback_url', 'fallback_mmproj_url']) {
            if (p[k] && inputs[k]) inputs[k].value = p[k];
          }
          hint.textContent = t('Parsed. Review the fields and save.');
        } catch (e) { hint.className = 'error'; hint.textContent = t('Parse failed: {msg}', { msg: e.message }); }
      },
    }, t('Auto-fill from command'))));

  const submit = async (method) => {
    const body = cardPayload(inputs);
    hint.className = 'hint';
    hint.textContent = t('Saving…');
    try {
      const r = await api(opts.base + (method === 'PUT' ? '/' + encodeURI(c.name) : ''), {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(r.error || 'failed');
      opts.onChanged(body.name || c.name);
    } catch (e) {
      hint.className = 'error';
      hint.textContent = e.message === 'builtin_card'
        ? t('Built-in cards are read-only — change the Name to save as a new card.')
        : e.message === 'duplicate_name'
          ? t('That name already exists — pick another one.')
          : t('Save failed: {msg}', { msg: e.message });
    }
  };

  const btns = el('div', { class: 'chatbar' });
  if (c.builtin) {
    form.append(el('div', { class: 'hint' },
      t('Built-in card: read-only. Edits are saved as a NEW card — give it a different Name.')));
    btns.append(el('button', { class: 'btn primary', onclick: () => submit('POST') },
      t('Save')));
  } else if (isNew) {
    btns.append(el('button', { class: 'btn primary', onclick: () => submit('POST') },
      t('Add card')));
  } else {
    btns.append(el('button', { class: 'btn primary', onclick: () => submit('PUT') }, t('Save')));
    btns.append(el('button', {
      class: 'btn', onclick: async () => {
        if (!confirm(t('Delete card {name}? (downloaded weights in the HF cache are kept)', { name: c.name }))) return;
        try {
          const r = await api(opts.base + '/' + encodeURI(c.name), { method: 'DELETE' });
          if (!r.ok) throw new Error(r.error || 'failed');
          opts.onChanged();
        } catch (e) {
          hint.className = 'error';
          hint.textContent = e.message === 'builtin_card'
            ? t('Built-in cards cannot be deleted.')
            : t('Delete failed: {msg}', { msg: e.message });
        }
      },
    }, t('Delete')));
  }
  if (opts.onSetDefault && c.name) {
    btns.append(el('button', {
      class: 'btn', onclick: () => opts.onSetDefault(c.name),
    }, t('Set as default')));
  }
  // 下载按钮（设为默认右侧）：手动预下载模型进 hub 缓存（hf → hf-mirror），
  // 进行中 2s 轮询进度；表单被重渲染/切页后轮询随 form 脱离 DOM 自行停止
  if (c.name) {
    const dlBtn = el('button', { class: 'btn' });
    let poll = null;
    const stopPoll = () => { if (poll) { clearInterval(poll); poll = null; } };
    const tick = async () => {
      if (!form.isConnected) { stopPoll(); return; }  // 表单已重渲染/切走
      let c2 = null;
      try {
        const r = await api(opts.base);
        c2 = (r.cards || []).find((x) => String(x.name) === String(c.name)) || null;
      } catch (_e) { return; /* 下轮重试 */ }
      const d = c2 && c2.download;
      if (d && d.state === 'running') {
        dlBtn.disabled = true;
        const p = t('Downloading {p}%', { p: Math.round(d.progress || 0) });
        dlBtn.textContent = p;
        hint.className = 'hint';
        hint.textContent = p + (d.source ? ' · ' + d.source : '');
        return;  // 继续轮询
      }
      stopPoll();
      if (d && d.state === 'failed') {
        dlBtn.disabled = false;
        dlBtn.textContent = t('Download');
        hint.className = 'error';
        hint.textContent = t('Download failed: {msg}', { msg: d.error || '' });
        return;
      }
      const inst = c2 ? Boolean(c2.installed) : Boolean(c.installed);
      dlBtn.disabled = inst;
      dlBtn.textContent = inst ? t('Downloaded') : t('Download');
      if (d && d.state === 'done') {
        hint.className = 'hint';
        hint.textContent = t('Model downloaded into the HF hub cache.');
      }
    };
    const running = c.download && c.download.state === 'running';
    dlBtn.disabled = Boolean(running) || Boolean(c.installed);
    dlBtn.textContent = running ? t('Downloading {p}%', { p: Math.round(c.download.progress || 0) })
      : (c.installed ? t('Downloaded') : t('Download'));
    dlBtn.addEventListener('click', async () => {
      dlBtn.disabled = true;
      hint.className = 'hint';
      hint.textContent = t('Download started…');
      try {
        await api(opts.base + '/download/' + encodeURI(c.name), { method: 'POST' });
        stopPoll();
        poll = setInterval(tick, 2000);
        await tick();
      } catch (e) {
        dlBtn.disabled = false;
        hint.className = 'error';
        hint.textContent = t('Download failed: {msg}', { msg: e.message });
      }
    });
    btns.append(dlBtn);
  }
  form.append(btns, hint);
  return form;
}

// 编辑器主体：标题 + 提示 + 上方清单 + 「+ 新增卡片」+ 下方详情；
// 暴露 refresh()/expand(name)/cards()
function modelCardEditor(opts) {
  const list = el('div', { class: 'mcards' });
  const detail = el('div', { class: 'mdetail' });
  let cards = [];
  let currentName = null;  // 所选卡名（null=未选）
  let adding = false;      // 「+ 新增卡片」态：详情区渲染新卡空表单

  const showDetail = () => detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  const head = el('div', { class: 'chatbar' },
    el('button', {
      class: 'btn', onclick: () => {
        adding = true; currentName = null;
        renderList(); renderDetail(); showDetail();
      },
    }, t('+ New card')));

  // 上方清单：整行可点，点击即在下方显示该卡详情；行内直接展示 hf_repo
  // 与模型说明（按界面语言取中文/英文，缺一边回落另一边）——说明在卡片上可见
  function renderList() {
    list.innerHTML = '';
    if (!cards.length) {
      list.append(el('div', { class: 'hint' }, t('No cards yet — add one with "+ New card".')));
      return;
    }
    const desc = (c) => (currentLang() === 'zh'
      ? (c.desc || c.desc_en || '') : (c.desc_en || c.desc || ''));
    for (const c of cards) {
      const sel = !adding && currentName != null && String(c.name) === currentName;
      const info = el('div', { class: 'grow' },
        el('div', {},
          el('strong', {}, c.name), ' ',
          ...(c.is_default ? [badge(true, t('Default'))] : []),
          ...(c.builtin ? [badge(true, t('Built-in'))] : [badge(false, '', t('Custom'))]),
          ...(c.installed == null ? [] : [badge(c.installed, t('Downloaded'), t('Not downloaded'))])));
      if (c.hf_repo) info.append(el('div', { class: 'hint mrow-sub' }, c.hf_repo));
      const d = desc(c);
      if (d) info.append(el('div', { class: 'hint mrow-sub' }, d));
      const row = el('div', { class: 'mcard' + (sel ? ' sel' : '') },
        el('div', { class: 'mrow' }, info));
      row.addEventListener('click', () => {
        adding = false;
        currentName = String(c.name);
        renderList(); renderDetail(); showDetail();
      });
      list.append(row);
    }
  }

  // 下方详情：所选卡表单 / 新卡空表单 / 未选提示
  function renderDetail() {
    detail.innerHTML = '';
    if (adding) { detail.append(cardDetail(null, opts)); return; }
    const c = currentName == null ? null : cards.find((x) => String(x.name) === currentName);
    detail.append(c ? cardDetail(c, opts)
      : el('div', { class: 'mform mform-empty' }, t('Select a card above to view and edit its details.')));
  }

  const card = el('div', { class: 'card' },
    el('h2', {}, t('Model Cards')),
    el('div', { class: 'hint' }, opts.hint || ''),
    head, list, detail);

  async function refresh(selectName) {
    try {
      const r = await api(opts.base);
      cards = r.cards || r.models || [];
      if (selectName != null) {
        currentName = cards.some((c) => String(c.name) === String(selectName)) ? String(selectName) : null;
      } else if (currentName != null && !cards.some((c) => String(c.name) === currentName)) {
        currentName = null;  // 原选中卡已被删除
      }
      adding = false;
      renderList(); renderDetail();
    } catch (e) {
      cards = [];
      currentName = null; adding = false;
      list.innerHTML = ''; detail.innerHTML = '';
      list.append(el('div', { class: 'error' }, t('Failed to load cards: {msg}', { msg: e.message })));
    }
  }

  // 选卡即出卡：清单选中该卡并把详情渲染到下方
  function expand(name) {
    const c = cards.find((x) => String(x.name) === String(name));
    if (!c) return;
    adding = false;
    currentName = String(c.name);
    renderList(); renderDetail(); showDetail();
  }

  return { el: card, refresh, expand, cards: () => cards };
}

window.ModelCardEditor = modelCardEditor;
