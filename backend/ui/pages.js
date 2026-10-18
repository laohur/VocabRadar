/* 管理界面五功能页（左设定、右试用，plan-backend §3.4）：LLM/翻译/ASR/OCR/下载器。
   依赖 admin.js 的公共工具（el/badge/api/saveCfg/field/select/fmtSize/settingsCard）。
   文案经 t()（i18n.js）中英双语；语言表与扩展端 i18n.js TRANSLATE_LANGS 对齐（42 种）。 */
'use strict';

const PAGES = {};

// ===== LLM =====

PAGES.llm = async function (main) {
  main.innerHTML = '';
  main.append(el('h1', {}, t('LLM (llama.cpp)')));
  const wrap = el('div', { class: 'cols' });
  const left = el('div', { class: 'col-left' });
  const right = el('div', { class: 'col-right' });
  wrap.append(left, right);

  const cfg = (await api('/api/config')).config || {};
  const st = await api('/api/llm/status').catch(() => ({}));
  // 卡片清单由下方编辑器统一拉取（/api/llm/models），此处只留引用供下拉回填
  let cards = [];

  // ---- 通用设定（默认模型 + 内部端口 + ctx + 并行槽位 + mode + idle） ----
  let selTouched = false;
  const port = el('input', { type: 'number', value: cfg.llm?.port ?? 7788 });
  const ctx = el('input', { type: 'number', value: cfg.llm?.ctx ?? 16384 });
  const par = el('input', { type: 'number', value: cfg.llm?.parallel ?? 4, min: '1' });
  const mode = select([['resident', t('resident (always on)')], ['on-demand', t('on-demand')]],
    cfg.llm?.mode ?? 'resident');
  const idle = el('input', { type: 'number', value: cfg.llm?.idle_timeout ?? 600 });
  const modelSel = el('select', { onchange: () => { selTouched = true; editor.expand(modelSel.value); } });
  function fillModelSel() {
    // 轮询重绘不重置用户选择：动过下拉后以当前值为准
    const cur = selTouched ? modelSel.value : (cfg.llm?.model || '').toLowerCase();
    modelSel.innerHTML = '';
    for (const c of cards) {
      modelSel.append(el('option', {
        value: c.name,
        ...(String(cur).toLowerCase() === String(c.name).toLowerCase() ? { selected: '' } : {}),
      }, c.name));  // 下拉只显卡片名；说明/下载状态看下方「模型卡片」区
    }
  }
  const setCard = settingsCard(t('General Settings'), [
    [t('Default model'), modelSel],
    [t('Internal port'), port],
    [t('Context length (ctx)'), ctx, t('Per-request context; total context sent to llama-server = ctx × parallel slots')],
    [t('Parallel slots'), par, t('Concurrent inference slots (-np) on llama-server; requests beyond this queue')],
    [t('Run mode'), mode],
    [t('Idle exit (seconds, on-demand only)'), idle],
  ], (inputs, hint) => saveCfg('llm', {
    model: inputs[0].value,
    port: Number(inputs[1].value) || 7788,
    ctx: Number(inputs[2].value) || 16384,
    parallel: Math.max(1, Number(inputs[3].value) || 4),
    mode: inputs[4].value,
    idle_timeout: Number(inputs[5].value) || 600,
  }, hint));
  setCard.prepend(el('div', { class: 'hint' },
    t('Status: {s} · internal port {p} · saving General Settings auto-reloads llama-server', {
      // 三态——running=探活 200；starting=进程活但未就绪（下载/加载模型中）
      s: st.running ? t('llama-server running')
        : st.starting ? t('llama-server starting') : t('not running'),
      p: st.port ?? cfg.llm?.port ?? 7788,
    })));
  left.append(setCard);

  // ---- 模型卡片（可编辑；ui/cards.js 共用组件）：选上方下拉即展开该卡 ----
  const editor = ModelCardEditor({
    base: '/api/llm/models',
    hint: t('Pick "Default model" above or click a card in the list — its details show in the form below. Built-in cards are read-only — edits are saved as a new card. Models auto-download at llama-server startup (HF → hf-mirror → fallback URL) into the HF hub cache.'),
    onChanged: async (name) => {
      await editor.refresh(name);
      cards = editor.cards();
      fillModelSel();
    },
    onSetDefault: async (name) => {
      const r = await saveCfg('llm', { model: name }, setCard.hint);
      if (!r) return;
      modelSel.value = name;  // 下拉与「默认」徽标同步
      selTouched = true;
      await editor.refresh(name);
      cards = editor.cards();
      fillModelSel();
    },
  });
  left.append(editor.el);
  editor.refresh().then(() => {
    cards = editor.cards();
    fillModelSel();
    editor.expand(cfg.llm?.model);  // 默认展开当前所选卡
  });

  // ---- 试用（对话 + 图片上传，OpenAI 兼容 /v1/chat/completions 流式） ----
  const msgs = [];
  const list = el('div', { class: 'chat' });
  let imageData = null;  // dataURL，附加到下一条 user 消息
  const fileInput = el('input', { type: 'file', accept: 'image/*' });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { imageData = reader.result; preview.src = imageData; };
    reader.readAsDataURL(f);
  });
  const preview = el('img', { class: 'thumb hidden', alt: 'preview' });
  const clearImg = el('button', {
    class: 'btn ghost hidden',
    onclick: () => { imageData = null; preview.src = ''; preview.classList.add('hidden'); clearImg.classList.add('hidden'); },
  }, t('Remove image'));
  const input = el('textarea', { rows: 8, placeholder: t('Type a message (optionally attach an image)…') });
  // 思考开关（默认不思考）——llama.cpp /v1/chat/completions 支持请求级
  // chat_template_kwargs 硬开关；Qwen3/Qwen3.5 系模板默认 enable_thinking=true 须显式关，
  // 其他模板忽略未知 kwargs 无害
  const thinkChk = el('input', { type: 'checkbox' });
  const send = el('button', {
    class: 'btn primary',
    onclick: async () => {
      const text = input.value.trim();
      if (!text && !imageData) return;
      const content = imageData
        ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: imageData } }]
        : text;
      msgs.push({ role: 'user', content });
      renderMsgs();
      input.value = ''; imageData = null;
      preview.classList.add('hidden'); clearImg.classList.add('hidden');
      send.disabled = true;
      const bubble = el('div', { class: 'msg assistant hint' }, t('Generating…'));
      list.append(bubble);
      try {
        // 流式：SSE data: 行逐 delta 追加（reasoning_content=思考过程，content=正文）
        const resp = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // max_tokens 兜底——不传时 llama-server 默认无限生成
          // （n_predict=-1），部分模型 EOS 收敛不干脆会输出超长；4096 给
          // thinking 模型留思考空间。请求级思考硬开关——默认不思考
          // （thinkChk 未勾传 false），勾选后 Qwen3/Qwen3.5 系模板输出 reasoning_content
          body: JSON.stringify({ model: 'local', messages: msgs, stream: true, max_tokens: 4096,
            chat_template_kwargs: { enable_thinking: thinkChk.checked } }),
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          throw new Error(data.error?.message || data.message || data.error || `HTTP ${resp.status}`);
        }
        bubble.classList.remove('hint');
        // --jinja 把 <think> 内容放 delta.reasoning_content——灰字实时滚动，
        // 完成后折叠进「思考过程」区
        const thinkBox = el('div', { class: 'msg-think hidden' });
        const mainBox = el('div', {});
        bubble.append(thinkBox, mainBox);
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let acc = '';
        let think = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            const s = line.trim();
            if (!s.startsWith('data:')) continue;
            const payload = s.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              const d = j.choices?.[0]?.delta || {};
              think += d.reasoning_content || '';
              acc += d.content || '';
              if (think) {
                thinkBox.textContent = think;
                thinkBox.classList.remove('hidden');
              }
              mainBox.textContent = acc;
              list.scrollTop = list.scrollHeight;
            } catch (_e) { /* 忽略不完整 JSON 行 */ }
          }
        }
        bubble.remove();
        const out = { role: 'assistant', content: acc };
        if (think) out.reasoning = think;  // 思考过程随气泡保留（历史折叠显示）
        msgs.push(out);
        renderMsgs();
      } catch (e) {
        bubble.classList.add('hint');
        bubble.textContent = t('Failed: {msg}', { msg: e.message });
      }
      send.disabled = false;
    },
  }, t('Send'));
  function renderMsgs() {
    list.innerHTML = '';
    for (const m of msgs) {
      const text = typeof m.content === 'string'
        ? m.content
        : m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
          + (m.content.some((p) => p.type === 'image_url') ? t(' [image]') : '');
      if (m.role === 'assistant' && m.reasoning) {
        // 带思考过程的消息——思考折叠区（默认收起，点击展开）+ 正文
        list.append(el('div', { class: 'msg assistant' },
          el('details', { class: 'msg-think' },
            el('summary', {}, t('Thought process')),
            el('div', {}, m.reasoning)),
          el('div', {}, text)));
      } else {
        list.append(el('div', { class: `msg ${m.role}` }, text));
      }
    }
    list.scrollTop = list.scrollHeight;
  }
  const chatCard = el('div', { class: 'card' },
    el('h2', {}, t('Playground · Chat')),
    list, preview, clearImg,
    el('div', { class: 'chatbar' }, fileInput,
      el('span', { class: 'hint' }, t('Attach image (multimodal image_url)'))),
    input,
    el('div', { class: 'chatbar' },
      el('label', { class: 'hint' }, thinkChk, t('Think')),
      send,
      el('button', { class: 'btn ghost', onclick: () => { msgs.length = 0; renderMsgs(); } }, t('Clear chat'))));
  right.append(chatCard);
  main.append(wrap);
};

// ===== 翻译 =====

// 42 种语言，顺序与扩展端 src/lib/i18n.js TRANSLATE_LANGS 一致
const LANGS = [
  ['en', 'English'], ['zh', 'Chinese'], ['hi', 'Hindi'], ['es', 'Spanish'], ['fr', 'French'],
  ['ar', 'Arabic'], ['bn', 'Bengali'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['ur', 'Urdu'],
  ['id', 'Indonesian'], ['de', 'German'], ['ja', 'Japanese'], ['tr', 'Turkish'], ['fil', 'Filipino'],
  ['vi', 'Vietnamese'], ['ta', 'Tamil'], ['ko', 'Korean'], ['fa', 'Persian'], ['it', 'Italian'],
  ['ms', 'Malay'], ['pl', 'Polish'], ['uk', 'Ukrainian'], ['nl', 'Dutch'], ['ro', 'Romanian'],
  ['sh', 'Serbo-Croatian'], ['el', 'Greek'], ['hu', 'Hungarian'], ['cs', 'Czech'], ['sv', 'Swedish'],
  ['he', 'Hebrew'], ['bg', 'Bulgarian'], ['da', 'Danish'], ['fi', 'Finnish'], ['nb', 'Norwegian Bokmål'],
  ['sk', 'Slovak'], ['ca', 'Catalan'], ['lt', 'Lithuanian'], ['sl', 'Slovenian'], ['mk', 'Macedonian'],
  ['lv', 'Latvian'], ['is', 'Icelandic'],
];

PAGES.translate = async function (main) {
  main.innerHTML = '';
  main.append(el('h1', {}, t('Translate')));
  // 双栏同 LLM 页：左列设定+模型卡片上下堆叠（不并排挤成窄条），右列试用
  const wrap = el('div', { class: 'cols' });
  const left = el('div', { class: 'col-left' });
  const right = el('div', { class: 'col-right' });
  wrap.append(left, right);

  // ---- 设定（下拉元素=模型，标签=模型名）+ 模型卡片（可编辑，ui/cards.js） ----
  const cfg = (await api('/api/config')).config || {};
  const chosen = cfg.translate?.model ?? '';
  const modelSel = el('select', { onchange: () => editor.expand(modelSel.value) });
  const par = el('input', { type: 'number', min: '1',
    value: cfg.translate_llm?.parallel ?? 4 });
  function fillSel(models) {
    // 下拉只显卡片名；说明/下载状态看下方「模型卡片」区（选卡即展开该卡）
    const cur = modelSel.value || chosen;
    modelSel.innerHTML = '';
    for (const m of models) {
      modelSel.append(el('option', {
        value: m.name,
        ...(m.name === cur ? { selected: '' } : {}),
      }, m.name));
    }
  }
  const setCard = settingsCard(t('Settings'), [
    [t('Translation model'), modelSel,
     t('All entries are llama.cpp cards served by the dedicated Translate LLM engine (independent start/stop on the Overview page; first request may cold-start it).')],
    [t('Parallel slots'), par, t('Concurrent inference slots (-np) on the translate LLM engine; requests beyond this queue')],
  ], (_i, hint) => {
    const v = modelSel.value;
    // 联动写入：translate.model=路由选择，同时同步 translate_llm.model（实例按卡启动）
    const patch = { translate: { model: v },
      translate_llm: { model: v, parallel: Math.max(1, Number(par.value) || 4) } };
    return saveCfg(null, patch, hint);
  });
  left.append(setCard);

  const editor = ModelCardEditor({
    base: '/api/translate/models',
    withTranslatePrompt: true,
    hint: t('Pick the translation model above or click a card in the list — its details show in the form below. Built-in cards are read-only — edits are saved as a new card.'),
    onChanged: async (name) => {
      await editor.refresh(name);
      fillSel(editor.cards());
    },
    onSetDefault: async (name) => {
      const patch = { translate: { model: name }, translate_llm: { model: name } };
      const r = await saveCfg(null, patch, setCard.hint);
      if (!r) return;
      modelSel.value = name;
      await editor.refresh(name);
      fillSel(editor.cards());
    },
  });
  left.append(editor.el);
  await editor.refresh(chosen);
  fillSel(editor.cards());

  // ---- 试用 ----
  const from = select([['auto', t('Auto detect')], ...LANGS], 'auto');
  const to = select(LANGS, 'zh');
  const text = el('textarea', { rows: 4, placeholder: t('Enter text to translate…') });
  const out = el('div', { class: 'result' });
  right.append(el('div', { class: 'card' },
    el('h2', {}, t('Playground')),
    el('div', { class: 'hint' }, t('Model follows the Settings card; start/stop the serving engine on the Overview page.')),
    el('div', { class: 'chatbar' }, field(t('Source language'), from), field(t('Target language'), to)),
    text,
    el('button', {
      class: 'btn primary',
      onclick: async (e) => {
        out.textContent = t('Translating…');
        try {
          const r = await api('/api/translate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text.value, from: from.value, to: to.value }),
          });
          out.textContent = r.text;
        } catch (err) { out.textContent = t('Failed: {msg}', { msg: err.message }); }
      },
    }, t('Translate')),
    out));
  main.append(wrap);
};

// ===== ASR =====

PAGES.asr = async function (main) {
  main.innerHTML = '';
  main.append(el('h1', {}, t('ASR (Speech-to-Text)')));
  // 双栏：左列 通用设定 / 模型卡（引擎清单，点行展开详情、「设为默认」切换
  // 引擎；GPU 设定并入 faster-whisper 展开区）/ 结果缓存；右列试用
  const wrap = el('div', { class: 'cols' });
  const left = el('div', { class: 'col-left' });
  const right = el('div', { class: 'col-right' });
  wrap.append(left, right);

  const cfg = (await api('/api/config')).config || {};
  const st = await api('/api/asr/status').catch(() => ({}));
  const gpu = st.gpu || {};
  let curEngine = cfg.asr?.engine ?? 'faster-whisper';  // 默认引擎（实际生效；行上「默认」徽标）
  let viewEngine = curEngine;                           // 当前点开查看的引擎（行高亮、下方详情）

  // ---- 各引擎私有设定元素（常驻，随所查看引擎渲染进下方详情区） ----
  const wmodel = select([['large-v3-turbo', 'large-v3-turbo'], ['tiny', 'tiny'],
    ['base', 'base'], ['small', 'small'], ['medium', 'medium'],
    ['large-v3', 'large-v3']],
    cfg.asr?.whisper_model ?? 'large-v3-turbo');
  const qsize = select([['0.6b', '0.6B'], ['1.7b', '1.7B']],
    cfg.asr?.qwen3_size ?? '0.6b');
  const mquant = select([['q4_K_M', 'q4_K_M'], ['q8_0', 'q8_0']],
    cfg.asr?.moss_quant ?? 'q4_K_M');
  const mpath = el('input', { value: cfg.asr?.moss_model_path || '',
    placeholder: 'models/MOSS-Transcribe-Diarize-<quant>.gguf' });
  const wcquant = select([['q5_0', 'q5_0']], cfg.asr?.wcpp_quant ?? 'q5_0');
  const dev = select([['auto', t('auto (use CUDA when detected)')], ['cpu', 'cpu'],
    ['cuda', 'cuda']], st.whisper_device || 'auto');
  const ct = select([['', t('auto (int8 on CPU, float16 on CUDA)')], ['int8', 'int8'],
    ['int8_float16', 'int8_float16'], ['float16', 'float16'], ['bfloat16', 'bfloat16']],
    cfg.asr?.whisper_compute_type ?? '');

  // ---- 通用设定（运行模式/结果缓存/转写并发，全引擎共用） ----
  const mode = select([['resident', t('resident (always on)')], ['on-demand', t('on-demand')]],
    cfg.asr?.mode ?? 'resident');
  const cacheOn = el('input', { type: 'checkbox', checked: cfg.asr?.cache !== false ? '' : null });
  const jslots = el('input', { type: 'number', min: '1', value: cfg.asr?.job_slots ?? 4 });
  const asrPatch = () => ({
    engine: curEngine, mode: mode.value, cache: cacheOn.checked,
    job_slots: Math.max(1, Number(jslots.value) || 4),
    whisper_model: wmodel.value, qwen3_size: qsize.value,
    moss_quant: mquant.value, moss_model_path: mpath.value.trim(),
    wcpp_quant: wcquant.value,
  });
  const setCard = settingsCard(t('Settings'), [
    [t('Run mode'), mode],
    [t('Result cache'), cacheOn, t('Deduplicate by video_id or audio content hash')],
    [t('Concurrent transcription slots'), jslots,
     t('Max simultaneous transcriptions (URL jobs + uploads share the pool); CPU is near-saturated at 1, tune up mainly for CUDA')],
  ], (_i, hint) => saveCfg('asr', asrPatch(), hint));
  left.append(setCard);

  // ---- 模型卡（参照 LLM 模型卡片）：引擎行清单 + 下方所点引擎详情。
  //      行点击只展开详情不写配置；切换默认引擎用详情区「设为默认」按钮，
  //      默认引擎的行带「默认」徽标，查看中的行高亮 ----
  const ENGINE_ROWS = [
    ['faster-whisper', 'faster-whisper',
     t('Default engine, falls back to CPU without GPU')],
    ['qwen3-asr', 'qwen3-asr',
     t('Haujet GGUF, GPU only (DML+Vulkan)')],
    ['moss', 'MOSS-Transcribe-Diarize',
     t('GPU, with speaker diarization; gguf auto-downloads on first use')],
    ['whisper-cpp', 'whisper.cpp (large-v3-turbo q5_0)',
     t('GPU CUDA, fastest tier (RTFx ~36x, ~1GB VRAM); binary & weights auto-download on first use')],
  ];
  const engineList = el('div', { class: 'mcards' });
  const engineDetail = el('div', { class: 'mform' });
  const detailHint = el('div', { class: 'hint' });

  function renderEngineList() {
    engineList.innerHTML = '';
    for (const [id, name] of ENGINE_ROWS) {
      const row = el('div', { class: 'mcard' + (id === viewEngine ? ' sel' : ''),
        'data-engine': id },
        el('div', { class: 'mrow' },
          el('div', { class: 'grow' },
            el('div', {}, el('strong', {}, name), ' ',
              ...(id === curEngine ? [badge(true, t('Default'))] : [])))));
      row.addEventListener('click', () => pickEngine(id));
      engineList.append(row);
    }
  }

  // ---- 预下载（fw/qwen3/moss 详情区「下载」按钮）----
  // 按钮代表当前所选档位：初渲染与换档时按 /api/asr/downloads 刷新态
  // （cached→已缓存置灰；running→进度置灰），点击起 2s 轮询直至终态
  let dlTimer = null;
  const stopDlPoll = () => { if (dlTimer) { clearInterval(dlTimer); dlTimer = null; } };
  function applyDlBtn(btn, d) {
    if (d && d.state === 'running') {
      btn.disabled = true;
      btn.textContent = d.progress > 0
        ? t('Downloading {p}%', { p: d.progress }) : t('Downloading…');
    } else if (d && (d.state === 'done' || d.cached)) {
      btn.disabled = true;
      btn.textContent = t('Cached');
    } else {
      btn.disabled = false;
      btn.textContent = t('Download');
    }
  }
  async function refreshDl(engine, tier, btn) {
    try {
      const r = await api('/api/asr/downloads');
      if (btn.isConnected) applyDlBtn(btn, (r.downloads || {})[engine + ':' + tier]);
    } catch (_e) { /* 状态未知保持可点 */ }
  }
  function startDl(engine, tier, btn) {
    btn.disabled = true;
    btn.textContent = t('Downloading…');
    detailHint.className = 'hint';
    detailHint.textContent = t('Download started…');
    api('/api/asr/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine, tier }),
    }).then(() => {
      stopDlPoll();
      const tick = async () => {
        if (!engineDetail.isConnected) { stopDlPoll(); return; }  // 页面已切走
        try {
          const r = await api('/api/asr/downloads');
          const d = (r.downloads || {})[engine + ':' + tier];
          applyDlBtn(btn, d);
          if (d && d.state === 'failed') {
            stopDlPoll();
            detailHint.className = 'error';
            detailHint.textContent = t('Download failed: {msg}', { msg: d.error || '' });
          } else if (d && (d.state === 'done' || d.cached)) {
            stopDlPoll();
            detailHint.className = 'hint';
            detailHint.textContent = t('Model cached. Ready for transcription.');
          }
        } catch (_e) { /* 下轮重试 */ }
      };
      dlTimer = setInterval(tick, 2000);
      return tick();
    }).catch((e) => {
      btn.disabled = false;
      btn.textContent = t('Download');
      detailHint.className = 'error';
      detailHint.textContent = t('Download failed: {msg}', { msg: e.message });
    });
  }

  function renderEngineDetail() {
    engineDetail.innerHTML = '';
    engineDetail.append(el('div', { class: 'hint' },
      ENGINE_ROWS.find((e) => e[0] === viewEngine)[2]));
    let dlBtn = null;
    if (viewEngine === 'faster-whisper') {
      engineDetail.append(field(t('whisper tier'), wmodel));
      // GPU 设备/精度归 faster-whisper：原独立 GPU 卡并入此展开区
      engineDetail.append(el('div', { class: 'hint' }, t('GPU (faster-whisper)')));
      if (gpu.installed || gpu.cuda_devices > 0) {
        engineDetail.append(field(t('Device'), dev,
          t('auto = use GPU when a CUDA device and cuBLAS are available; otherwise CPU. Takes effect on next engine start/unload (no hot switch)')));
        engineDetail.append(field(t('Compute type'), ct,
          t('Leave empty for automatic (CPU int8 / CUDA float16)')));
        // 环境与生效状态行（回落原因可见，不遮蔽错误）
        let line = t('CUDA devices: {n} · cuBLAS runtime: {lib}', {
          n: gpu.cuda_devices ?? 0,
          lib: gpu.installed ? (gpu.version || t('installed')) : t('not installed'),
        });
        if (st.device_effective) {
          line += ' · ' + t('Effective device: {d}', { d: st.device_effective });
        }
        if (st.device_note) {
          line += ' · ' + t('fell back to CPU: {msg}', { msg: st.device_note });
        }
        engineDetail.append(el('div', { class: 'hint' }, line));
      } else {
        engineDetail.append(el('div', { class: 'hint' },
          t('whisper GPU support not installed. Install with: {cmd}',
            { cmd: 'python backend/scripts/install.py --whisper-gpu yes' })));
      }
      dlBtn = el('button', { class: 'btn',
        onclick: () => startDl('faster-whisper', wmodel.value, dlBtn) }, t('Download'));
      wmodel.addEventListener('change', () => {
        stopDlPoll();
        refreshDl('faster-whisper', wmodel.value, dlBtn);
      });
      refreshDl('faster-whisper', wmodel.value, dlBtn);
    } else if (viewEngine === 'qwen3-asr') {
      engineDetail.append(field(t('Qwen3-ASR tier'), qsize,
        t('0.6B = default tier (~1.35GB); 1.7B = quality tier (~2.15GB). First use downloads the tool (~103MB) and model from GitHub releases; GPU (DML+Vulkan) required — falls back to faster-whisper on CPU-only machines.')));
      dlBtn = el('button', { class: 'btn',
        onclick: () => startDl('qwen3-asr', qsize.value, dlBtn) }, t('Download'));
      qsize.addEventListener('change', () => {
        stopDlPoll();
        refreshDl('qwen3-asr', qsize.value, dlBtn);
      });
      refreshDl('qwen3-asr', qsize.value, dlBtn);
    } else if (viewEngine === 'whisper-cpp') {
      engineDetail.append(field(t('whisper.cpp quant'), wcquant,
        t('q5_0 = only tier (~574MB weights + ~685MB CUDA runtime, DLLs bundled — no pip cuBLAS needed). NVIDIA GPU required — falls back to faster-whisper on CPU-only machines. Weights from HuggingFace (hf-mirror fallback); binary from whisper.cpp release b5454; both auto-download on first use.')));
      dlBtn = el('button', { class: 'btn',
        onclick: () => startDl('whisper-cpp', wcquant.value, dlBtn) }, t('Download'));
      wcquant.addEventListener('change', () => {
        stopDlPoll();
        refreshDl('whisper-cpp', wcquant.value, dlBtn);
      });
      refreshDl('whisper-cpp', wcquant.value, dlBtn);
    } else {
      engineDetail.append(field(t('MOSS quant'), mquant,
        t('q4_K_M = default, fastest tier; q8_0 = higher quality, larger file.')));
      engineDetail.append(field(t('MOSS model path (optional)'), mpath,
        t('Leave empty for models/ inside the backend directory; the gguf auto-downloads on first use (HuggingFace, hf-mirror fallback). Or fill in a local file path.')));
      dlBtn = el('button', { class: 'btn',
        onclick: () => startDl('moss', mquant.value, dlBtn) }, t('Download'));
      mquant.addEventListener('change', () => {
        stopDlPoll();
        refreshDl('moss', mquant.value, dlBtn);
      });
      refreshDl('moss', mquant.value, dlBtn);
    }
    const btns = el('div', { class: 'chatbar' },
      el('button', {
        class: 'btn', onclick: () => saveCfg('asr', asrPatch(), detailHint),
      }, t('Save Settings')));
    if (viewEngine !== curEngine) {  // 已是默认引擎时不出按钮（行上「默认」徽标即标识）
      btns.append(el('button', { class: 'btn', onclick: setDefault }, t('Set as default')));
    }
    if (dlBtn) btns.append(dlBtn);
    engineDetail.append(btns, detailHint);
  }

  function pickEngine(id) {
    viewEngine = id;  // 只切换查看，不写配置
    renderEngineList();
    renderEngineDetail();
  }

  async function setDefault() {
    curEngine = viewEngine;
    renderEngineList();
    renderEngineDetail();  // 「设为默认」按钮随已默认消失
    await saveCfg('asr', asrPatch(), detailHint);
  }

  left.append(el('div', { class: 'card' },
    el('h2', {}, t('Models')),
    el('div', { class: 'hint' }, t('Click a card to expand its details; use "Set as default" to switch the engine.')),
    engineList, engineDetail));
  renderEngineList();
  renderEngineDetail();

  // ---- 缓存管理 ----
  const cacheCard = el('div', { class: 'card' }, el('h2', {}, t('Result Cache')));
  async function renderCache() {
    cacheCard.innerHTML = '';
    cacheCard.append(el('h2', {}, t('Result Cache')));
    const r = await api('/api/asr/cache').catch(() => ({ items: [] }));
    const items = r.items || [];
    cacheCard.append(el('div', { class: 'hint' }, t('{n} entries', { n: items.length })));
    if (items.length) {
      // 条目 ID 完整显示不截断——key 自带站点前缀（bilibili-BVxx / youtube-<v> /
      // 站点路径哈希），旧条目无 key 时回落 video_id
      cacheCard.append(el('ul', { class: 'models' },
        ...items.slice(0, 20).map((it) => el('li', {}, it.key || it.video_id || ''))));
      cacheCard.append(el('button', {
        class: 'btn ghost',
        onclick: async () => {
          await api('/api/asr/cache', { method: 'DELETE' });
          renderCache();
        },
      }, t('Clear cache')));
    }
  }
  cacheCard.append(el('div', { class: 'hint' }, t('Loading…')));
  renderCache();
  left.append(cacheCard);

  // ---- 试用（上传即建 job，1s 增量轮询——转写过程流式出部分结果，
  //      长音频不用等全部完成；协议与 URL 任务同构 /api/asr/jobs?after=N） ----
  const lang = el('input', { placeholder: t('Optional, e.g. en / ja / zh') });
  const out = el('div', { class: 'result' });
  const prog = el('div', { class: 'hint' });
  const file = el('input', { type: 'file', accept: 'audio/*,video/*' });
  let jobTimer = null;
  let cursor = 0;  // 段游标：只拉新增段

  const fmtTs = (sec) => {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return (h ? String(h).padStart(2, '0') + ':' : '')
      + String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };

  function stopPoll() { clearInterval(jobTimer); jobTimer = null; }

  function pollJob(id) {
    stopPoll();
    cursor = 0;
    out.textContent = '';
    const tick = async () => {
      try {
        const s = await api(`/api/asr/jobs/${id}?after=${cursor}`);
        for (const seg of s.segments || []) {
          out.textContent += (out.textContent ? '\n' : '')
            + `[${fmtTs(seg.start)}] ${seg.text}`;
        }
        cursor = s.segments_total ?? cursor;
        out.scrollTop = out.scrollHeight;
        if (s.status === 'downloading') {
          prog.textContent = t('Downloading… {p}%', { p: s.progress?.download ?? 0 });
        } else if (s.status === 'transcribing') {
          prog.textContent = t('Transcribing… {p}%', { p: s.progress?.transcribe ?? 0 });
        } else if (s.status === 'queued') {
          prog.textContent = t('Queued…');
        } else if (s.status === 'completed') {
          prog.textContent = (s.cached ? t('[cache hit] ') : '')
            + t('Done. {n} segments', { n: s.segments_total ?? 0 });
          stopPoll();
        } else if (s.status === 'failed') {
          prog.textContent = t('Failed: {msg}', { msg: s.error || t('unknown error') });
          stopPoll();
        }
      } catch (_e) { /* 下轮重试 */ }
    };
    tick();
    jobTimer = setInterval(tick, 1000);
  }

  right.append(el('div', { class: 'card' },
    el('h2', {}, t('Playground · Upload Audio to Transcribe')),
    field(t('Audio file (mp3/m4a/wav/webm…)'), file),
    field(t('Language hint'), lang, t('Leave empty for auto-detect')),
    el('button', {
      class: 'btn primary',
      onclick: async () => {
        const f = file.files[0];
        if (!f) { out.textContent = t('Select a file first.'); return; }
        out.textContent = '';
        prog.textContent = t('Uploading…');
        const fd = new FormData();
        fd.append('file', f);
        if (lang.value.trim()) fd.append('language', lang.value.trim());
        try {
          const r = await api('/api/asr/jobs', { method: 'POST', body: fd });
          pollJob(r.id);
        } catch (err) { prog.textContent = t('Failed: {msg}', { msg: err.message }); }
      },
    }, t('Transcribe')),
    prog, out));
  main.append(wrap);
};

// ===== OCR =====

PAGES.ocr = async function (main) {
  main.innerHTML = '';
  main.append(el('h1', {}, t('OCR (Image Text Recognition)')));
  // 双栏：左列 模型卡（引擎清单，选中的才在下方展开说明与设定），右列试用
  const wrap = el('div', { class: 'cols' });
  const left = el('div', { class: 'col-left' });
  const right = el('div', { class: 'col-right' });
  wrap.append(left, right);

  const cfg = (await api('/api/config')).config || {};
  const st = await api('/api/llm/status').catch(() => null);
  const cur = st && Array.isArray(st.cards)
    ? (st.cards.find((c) => c.name === st.model) || null) : null;
  const curDesc = cur ? (currentLang() === 'zh'
    ? (cur.desc || cur.desc_en || '') : (cur.desc_en || cur.desc || '')) : '';
  let curEngine = cfg.ocr?.engine ?? 'rapidocr';  // 默认引擎（实际生效；行上「默认」徽标）
  let viewEngine = curEngine;                     // 当前点开查看的引擎（行高亮、下方详情）
  const mode = select([['resident', t('resident (always on)')], ['on-demand', t('on-demand')]],
    cfg.ocr?.mode ?? 'resident');

  // ---- 模型卡（参照 LLM 模型卡片）：引擎行清单 + 下方所点引擎详情。
  //      行点击只展开详情不写配置；切换默认引擎用详情区「设为默认」按钮 ----
  const ENGINE_ROWS = [
    ['llm', 'llm', t('Vision model — uses the model selected on the LLM page. Current: {m}',
      { m: (st && st.model) || t('not selected') })],
    ['rapidocr', 'rapidocr',
     t('Local lightweight (rapidocr-onnxruntime), CPU-friendly, no GPU')],
  ];
  const engineList = el('div', { class: 'mcards' });
  const engineDetail = el('div', { class: 'mform' });
  const detailHint = el('div', { class: 'hint' });
  const saveOcr = (hint) => saveCfg('ocr', { engine: curEngine, mode: mode.value }, hint);

  function renderEngineList() {
    engineList.innerHTML = '';
    for (const [id, name] of ENGINE_ROWS) {
      const row = el('div', { class: 'mcard' + (id === viewEngine ? ' sel' : ''),
        'data-engine': id },
        el('div', { class: 'mrow' },
          el('div', { class: 'grow' },
            el('div', {}, el('strong', {}, name), ' ',
              ...(id === curEngine ? [badge(true, t('Default'))] : [])))));
      row.addEventListener('click', () => pickEngine(id));
      engineList.append(row);
    }
  }

  function renderEngineDetail() {
    engineDetail.innerHTML = '';
    engineDetail.append(el('div', { class: 'hint' },
      ENGINE_ROWS.find((e) => e[0] === viewEngine)[2]));
    if (viewEngine === 'llm') {
      if (curDesc) engineDetail.append(el('div', { class: 'hint' }, curDesc));
      engineDetail.append(el('div', { class: 'hint' },
        t('Pick and start the model on the LLM page — OCR follows it.')));
      // 无本地字段；选择/启停都归 LLM 页
    } else {
      engineDetail.append(field(t('Run mode'), mode));
    }
    const btns = el('div', { class: 'chatbar' });
    if (viewEngine !== 'llm') {  // llm 无本地字段，无保存按钮
      btns.append(el('button', {
        class: 'btn', onclick: () => saveOcr(detailHint),
      }, t('Save Settings')));
    }
    if (viewEngine !== curEngine) {  // 已是默认引擎时不出按钮（行上「默认」徽标即标识）
      btns.append(el('button', { class: 'btn', onclick: setDefault }, t('Set as default')));
    }
    if (btns.children.length) engineDetail.append(btns, detailHint);
  }

  function pickEngine(id) {
    viewEngine = id;  // 只切换查看，不写配置
    renderEngineList();
    renderEngineDetail();
  }

  async function setDefault() {
    curEngine = viewEngine;
    renderEngineList();
    renderEngineDetail();  // 「设为默认」按钮随已默认消失
    await saveOcr(detailHint);
  }

  left.append(el('div', { class: 'card' },
    el('h2', {}, t('Models')),
    el('div', { class: 'hint' }, t('Click a card to expand its details; use "Set as default" to switch the engine.')),
    engineList, engineDetail));
  renderEngineList();
  renderEngineDetail();

  const file = el('input', { type: 'file', accept: 'image/*' });
  const preview = el('img', { class: 'thumb hidden', alt: 'preview' });
  const out = el('div', { class: 'result' });
  right.append(el('div', { class: 'card' },
    el('h2', {}, t('Playground · Image Recognition')),
    field(t('Image file'), file),
    preview,
    el('button', {
      class: 'btn primary',
      onclick: async () => {
        const f = file.files[0];
        if (!f) { out.textContent = t('Select an image first.'); return; }
        preview.src = URL.createObjectURL(f);
        preview.classList.remove('hidden');
        out.textContent = t('Recognizing…');
        const fd = new FormData();
        fd.append('file', f);
        try {
          const r = await api('/api/ocr', { method: 'POST', body: fd });
          out.textContent = r.text || t('(no text recognized)');
        } catch (err) { out.textContent = t('Failed: {msg}', { msg: err.message }); }
      },
    }, t('Recognize')),
    out));
  main.append(wrap);
};

// ===== 下载器 =====

// yt-dlp --cookies-from-browser 支持的浏览器
const YTDL_BROWSERS = [
  ['', 'off'], ['firefox', 'firefox'], ['chrome', 'chrome'], ['edge', 'edge'],
  ['brave', 'brave'], ['chromium', 'chromium'], ['vivaldi', 'vivaldi'],
  ['opera', 'opera'], ['safari', 'safari (macOS)'],
];

PAGES.ytdl = async function (main) {
  main.innerHTML = '';
  main.append(el('h1', {}, t('Downloader (yt-dlp)')));
  const wrap = el('div', { class: 'cols' });

  const cfg = (await api('/api/config')).config || {};
  const fmt = select([['m4a', t('m4a (native audio stream)')], ['bestaudio', t('bestaudio (best audio)')]],
    cfg.ytdl?.format ?? 'm4a');
  const cookiefile = el('input', { value: cfg.ytdl?.cookiefile ?? '' });
  const cfb = select(YTDL_BROWSERS.map(([v, label]) => [v, label === 'off' ? t('off') : label]),
    cfg.ytdl?.cookies_from_browser ?? '');
  wrap.append(settingsCard(t('Settings'), [
    [t('Default format'), fmt, t('Only for callers that do not pass an explicit format (e.g. the extension). The buttons below always send their own format')],
    [t('Cookie file path'), cookiefile, t('Netscape format; relative paths resolve against backend/. Only needed for login-walled content; export from a throwaway account. Takes priority over browser cookies')],
    [t('Cookies from browser'), cfb, t('Auto-pick cookies from a logged-in browser (yt-dlp --cookies-from-browser). Chrome 127+ on Windows fails due to App-Bound Encryption — Firefox is the most reliable; requires the target site to be logged in')],
  ], (_i, hint) => saveCfg('ytdl', {
    format: fmt.value,
    cookiefile: cookiefile.value.trim(),
    cookies_from_browser: cfb.value,
  }, hint)));

  // ---- 试用（解析结果数据驱动 参数下拉——分辨率/音质/字幕轨道） ----
  const url = el('input', { placeholder: t('Video page URL (Bilibili/YouTube etc.)') });
  const heightSel = select([['', t('Best (no limit)')]], '');
  const abrSel = select([['', t('Best (no limit)')]], '');
  const subSel = select([['', t('Default (original language)')]], '');
  // 解析成功后重填数值下拉（首个空档=不限）
  const fillSel = (sel, opts) => {
    sel.innerHTML = '';
    for (const [v, label] of opts) sel.append(el('option', { value: v }, label));
  };
  // 字幕轨道下拉：optgroup 手动/机器，值带 manual:/auto: 前缀（提交前剥掉）。
  // 默认项「原始语言」由 backend 取视频原声语言轨（无该字段落首个）。
  // 解析成功后预选界面语言轨道（zh/en 按主语言码匹配，如 zh-Hans→zh），无匹配保持「默认」
  const fillSubs = (subs) => {
    subSel.innerHTML = '';
    subSel.append(el('option', { value: '' }, t('Default (original language)')));
    const manual = subs?.manual || [];
    const auto = subs?.auto || [];
    if (manual.length) {
      const g = el('optgroup', { label: t('manual') });
      for (const lang of manual) g.append(el('option', { value: `manual:${lang}` }, lang));
      subSel.append(g);
    }
    if (auto.length) {
      const g = el('optgroup', { label: t('auto (machine)') });
      for (const lang of auto) g.append(el('option', { value: `auto:${lang}` }, lang));
      subSel.append(g);
    }
    if (!manual.length && !auto.length) {
      subSel.append(el('option', { value: '', disabled: '' }, t('No subtitles')));
    }
    const ui = currentLang();
    // 先剥 ai- 机器轨前缀再取主码——B站轨道 ai-zh 原判成 'ai'，匹配不上界面语言 zh
    const primary = (v) => v.split(':')[1].toLowerCase().replace(/^ai-/, '').split('-')[0];
    const all = [...manual.map((l) => `manual:${l}`), ...auto.map((l) => `auto:${l}`)];
    const hit = all.find((v) => primary(v) === ui);
    if (hit) subSel.value = hit;
  };
  const info = el('div', { class: 'result hidden' });
  const prog = el('div', { class: 'hint' });
  const save = el('div');  // 完成后的保存文件链接
  const player = el('video', { controls: '', class: 'hidden' });  // video 兼容音频/视频产物
  let taskId = null;
  let timer = null;

  const resolveBtn = el('button', {
    class: 'btn',
    onclick: async () => {
      if (!url.value.trim()) { info.classList.remove('hidden'); info.textContent = t('Enter a URL first.'); return; }
      info.classList.remove('hidden');
      info.textContent = t('Resolving…');
      try {
        const q = new URLSearchParams({ url: url.value.trim() });
        const r = await api(`/api/ytdl/resolve?${q}`);
        fillSel(heightSel, [['', t('Best (no limit)')], ...(r.heights || []).map((h) => [String(h), `${h}p`])]);
        fillSel(abrSel, [['', t('Best (no limit)')], ...(r.abrs || []).map((a) => [String(a), `${a} kbps`])]);
        fillSubs(r.subs);
        const nSubs = ((r.subs?.manual || []).length) + ((r.subs?.auto || []).length);
        info.innerHTML = '';
        const kv = el('div', { class: 'kv' });
        const row = (k, v) => { if (v) kv.append(el('span', {}, k), el('span', {}, v)); };
        row(t('Title'), r.title);
        row(t('Uploader'), r.uploader);
        row(t('Duration'), r.duration != null ? t('{d}s', { d: r.duration }) : '');
        row(t('Container'), r.ext);
        row(t('Approx. size'), r.filesize ? fmtSize(r.filesize) : '');
        row(t('Subtitle tracks'), nSubs ? String(nSubs) : t('none'));
        row(t('Resolutions'), (r.heights || []).map((h) => `${h}p`).join(' · ') || t('none'));
        row(t('Audio qualities'), (r.abrs || []).map((a) => `${a} kbps`).join(' · ') || t('none'));
        info.append(kv);
        if (r.thumbnail) info.append(el('img', { src: r.thumbnail, class: 'thumb', alt: 'thumbnail' }));
      } catch (e) { info.textContent = t('Resolve failed: {msg}', { msg: e.message }); }
    },
  }, t('Resolve'));

  // 统一下载提交：params 由各按钮按当前下拉给出（video→height，audio→abr）
  async function startTask(format, params) {
    if (!url.value.trim()) { prog.textContent = t('Enter a URL first.'); return; }
    prog.textContent = t('Submitting download…');
    save.innerHTML = '';
    player.classList.add('hidden');
    try {
      const body = { url: url.value.trim(), format, ...params };
      const r = await api('/api/ytdl/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      taskId = r.id;
      prog.textContent = t('Task {id} · queued', { id: r.id });
      clearInterval(timer);
      timer = setInterval(poll, 1000);
    } catch (e) { prog.textContent = t('Failed: {msg}', { msg: e.message }); }
  }

  const dlAudio = el('button', { class: 'btn primary',
    onclick: () => startTask('m4a', abrSel.value ? { abr: Number(abrSel.value) } : {}) }, t('Audio (m4a)'));
  const dlVideo = el('button', { class: 'btn primary',
    onclick: () => startTask('mp4', heightSel.value ? { height: Number(heightSel.value) } : {}) }, t('Video (mp4)'));
  const dlSubs = el('button', {
    class: 'btn',
    onclick: async () => {
      if (!url.value.trim()) { prog.textContent = t('Enter a URL first.'); return; }
      prog.textContent = t('Fetching subtitles…');
      try {
        const q = new URLSearchParams({ url: url.value.trim() });
        if (subSel.value) q.set('lang', subSel.value.split(':')[1] || '');  // 剥 manual:/auto: 前缀
        const r = await api(`/api/ytdl/subtitles?${q}`);
        // cues 拼成 SRT 存为文件（timestamps 取整毫秒，标准 SRT 序号块）
        const ts = (s) => {
          const total = Math.max(0, s);
          const ms = Math.round((total - Math.floor(total)) * 1000);
          const h = String(Math.floor(total / 3600)).padStart(2, '0');
          const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
          const sec = String(Math.floor(total % 60)).padStart(2, '0');
          return `${h}:${m}:${sec},${String(ms).padStart(3, '0')}`;
        };
        const srt = r.cues.map((c, i) =>
          `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n');
        const a = el('a', {
          href: URL.createObjectURL(new Blob([srt], { type: 'text/plain' })),
          download: 'subtitles.srt',
        }, t('Save subtitles.srt ({lang}, {kind}, {n} cues)', { lang: r.lang, kind: r.kind, n: r.cues.length }));
        save.innerHTML = '';
        save.append(a);
        a.click();  // 直接触发浏览器下载
        prog.textContent = t('Subtitles ready: {lang} ({kind}), {n} cues.',
          { lang: r.lang, kind: r.kind, n: r.cues.length });
      } catch (e) { prog.textContent = t('Failed: {msg}', { msg: e.message }); }
    },
  }, t('Subtitles'));

  async function poll() {
    if (!taskId) return;
    try {
      const r = await api(`/api/ytdl/status?id=${taskId}`);
      const task = r.task || {};  // 命名避开全局翻译函数 t()
      if (task.state === 'running') {
        prog.textContent = t('Downloading {p}%', { p: task.progress ?? 0 });
      } else if (task.state === 'done') {
        clearInterval(timer);
        prog.textContent = t('Done: {name}', { name: task.filename });
        player.src = `/media/${taskId}`;
        player.classList.remove('hidden');
        save.innerHTML = '';
        save.append(el('a', { href: `/media/${taskId}`, download: task.filename || '' }, t('Save file')));
      } else if (task.state === 'error') {
        clearInterval(timer);
        prog.textContent = t('Failed: {msg}', { msg: task.error || t('unknown error') });
      }
    } catch (_e) { /* 下轮重试 */ }
  }

  wrap.append(el('div', { class: 'card' },
    el('h2', {}, t('Playground · Resolve → Download')),
    field(t('Video URL'), url),
    el('div', { class: 'chatbar' }, resolveBtn),
    el('div', { class: 'chatbar' },
      field(t('Resolution (video only)'), heightSel),
      field(t('Audio quality (abr cap)'), abrSel),
      field(t('Subtitle language'), subSel)),
    el('div', { class: 'chatbar' }, dlAudio, dlVideo, dlSubs),
    info, prog, save, player));
  main.append(wrap);
};

window.Pages = PAGES;
