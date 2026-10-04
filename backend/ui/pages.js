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
  const left = el('div', { class: 'llm-left' });
  const right = el('div', { class: 'llm-right' });
  wrap.append(left, right);

  const cfg = (await api('/api/config')).config || {};
  const st = await api('/api/llm/status').catch(() => ({}));
  // /api/llm/models 返回 cards（含 installed/is_default）与安装状态
  let cards = [];
  const data0 = await api('/api/llm/models').catch(() => null);
  if (data0) cards = data0.cards || [];

  // ---- 通用设定（默认模型 + 内部端口 + ctx + mode + idle） ----
  let selTouched = false;
  const port = el('input', { type: 'number', value: cfg.llm?.port ?? 7788 });
  const ctx = el('input', { type: 'number', value: cfg.llm?.ctx ?? 16384 });
  const mode = select([['resident', t('resident (always on)')], ['on-demand', t('on-demand')]],
    cfg.llm?.mode ?? 'resident');
  const idle = el('input', { type: 'number', value: cfg.llm?.idle_timeout ?? 600 });
  const modelSel = el('select', { onchange: () => { selTouched = true; } });
  function fillModelSel() {
    // 轮询重绘不重置用户选择：动过下拉后以当前值为准
    const cur = selTouched ? modelSel.value : (cfg.llm?.model || '').toLowerCase();
    modelSel.innerHTML = '';
    for (const c of cards) {
      modelSel.append(el('option', {
        value: c.name,
        ...(String(cur).toLowerCase() === String(c.name).toLowerCase() ? { selected: '' } : {}),
      }, c.name + (c.installed ? '' : ` (${t('Not downloaded')})`)));
    }
  }
  const setCard = settingsCard(t('General Settings'), [
    [t('Default model'), modelSel],
    [t('Internal port'), port],
    [t('Context length (ctx)'), ctx],
    [t('Run mode'), mode],
    [t('Idle exit (seconds, on-demand only)'), idle],
  ], (inputs, hint) => saveCfg('llm', {
    model: inputs[0].value,
    port: Number(inputs[1].value) || 7788,
    ctx: Number(inputs[2].value) || 16384,
    mode: inputs[3].value,
    idle_timeout: Number(inputs[4].value) || 600,
  }, hint));
  setCard.prepend(el('div', { class: 'hint' },
    t('Status: {s} · internal port {p} · saving General Settings auto-reloads llama-server · MiniCPM is text-only (no vision OCR; use Qwen for vision)', {
      // 三态——running=探活 200；starting=进程活但未就绪（下载/加载模型中）
      s: st.running ? t('llama-server running')
        : st.starting ? t('llama-server starting') : t('not running'),
      p: st.port ?? cfg.llm?.port ?? 7788,
    })));
  left.append(setCard);

  // ---- 模型卡片列表（只读） ----
  const cardsBody = el('div', {});
  left.append(el('div', { class: 'card' },
    el('h2', {}, t('Model Cards')),
    el('div', { class: 'hint' },
      t('Cards are read-only. Models auto-download at llama-server startup (order: HF → hf-mirror → fallback URL) into the HF hub cache.')),
    cardsBody));

  function renderCards() {
    // 卡片只读——选卡走上方「Default model」下拉；模型下载交 llama-server -hf 三源自动补拉
    cardsBody.innerHTML = '';
    for (const c of cards) {
      const descLine = [c.desc, c.desc_en].filter(Boolean).join(' / ');
      const subs = [];
      if (c.hf_repo) subs.push(el('div', { class: 'mrow-sub hint' }, c.hf_repo));
      if (descLine) subs.push(el('div', { class: 'mrow-sub hint' }, descLine));
      cardsBody.append(el('div', { class: 'mrow' },
        el('div', { class: 'grow' },
          el('strong', {}, c.name), ' ',
          ...(c.is_default ? [badge(true, t('Default'))] : []),
          ' ', badge(c.installed, t('Downloaded'), t('Not downloaded'))),
        ...subs));
    }
  }

  fillModelSel();
  renderCards();

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
  const wrap = el('div', { class: 'cols' });

  // ---- 设定（下拉元素=模型，标签=模型名；数据源 /api/translate/models）----
  const cfg = (await api('/api/config')).config || {};
  const data = await api('/api/translate/models').catch(() => ({ models: [] }));
  const models = data.models || [];
  const chosen = cfg.translate?.model ?? 'nllb';
  const modelSel = select(models.map((m) => [m.name,
    m.name + (m.name === 'nllb' ? '' : (m.installed ? '' : ` (${t('Not downloaded')})`))]),
    models.some((m) => m.name === chosen) ? chosen : 'nllb');
  wrap.append(settingsCard(t('Settings'), [
    [t('Translation model'), modelSel,
     t('nllb = built-in NLLB-200-distilled-600M (in-process CT2, fast). Any other entry is a llama.cpp card served by the dedicated Translate LLM engine (independent start/stop on the Overview page; first request may cold-start it).')],
  ], (_i, hint) => {
    const v = modelSel.value;
    // 联动写入：translate.model=路由选择；选 llama.cpp 卡时同步 translate_llm.model
    // （实例按卡启动）；切回 nllb 不动 translate_llm 选卡（保留，随时切回）
    const patch = { translate: { model: v } };
    if (v !== 'nllb') patch.translate_llm = { model: v };
    return saveCfg(null, patch, hint);
  }));

  // ---- 试用 ----
  const from = select([['auto', t('Auto detect')], ...LANGS], 'auto');
  const to = select(LANGS, 'zh');
  const text = el('textarea', { rows: 4, placeholder: t('Enter text to translate…') });
  const out = el('div', { class: 'result' });
  wrap.append(el('div', { class: 'card' },
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
  const wrap = el('div', { class: 'cols' });

  const cfg = (await api('/api/config')).config || {};
  const engine = select([['faster-whisper', 'faster-whisper']],
    cfg.asr?.engine ?? 'faster-whisper');
  const mode = select([['resident', t('resident (always on)')], ['on-demand', t('on-demand')]],
    cfg.asr?.mode ?? 'resident');
  const cacheOn = el('input', { type: 'checkbox', checked: cfg.asr?.cache !== false ? '' : null });
  const wmodel = select([['large-v3-turbo', 'large-v3-turbo'], ['tiny', 'tiny'],
    ['base', 'base'], ['small', 'small'], ['medium', 'medium'],
    ['large-v3', 'large-v3']],
    cfg.asr?.whisper_model ?? 'large-v3-turbo');
  wrap.append(settingsCard(t('Settings'), [
    [t('Engine'), engine],
    [t('Run mode'), mode],
    [t('Result cache'), cacheOn, t('Deduplicate by video_id or audio content hash')],
    [t('whisper tier (faster-whisper only)'), wmodel],
  ], (_i, hint) => saveCfg('asr', {
    engine: engine.value, mode: mode.value,
    cache: cacheOn.checked, whisper_model: wmodel.value,
  }, hint)));

  // ---- 缓存管理 ----
  const cacheCard = el('div', { class: 'card' }, el('h2', {}, t('Result Cache')));
  async function renderCache() {
    cacheCard.innerHTML = '';
    cacheCard.append(el('h2', {}, t('Result Cache')));
    const r = await api('/api/asr/cache').catch(() => ({ items: [] }));
    const items = r.items || [];
    cacheCard.append(el('div', { class: 'hint' }, t('{n} entries', { n: items.length })));
    if (items.length) {
      cacheCard.append(el('ul', { class: 'models' },
        ...items.slice(0, 20).map((it) => el('li', {},
          it.video_id ? t('video {id}', { id: it.video_id }) : (it.key || '').slice(0, 16) + '…'))));
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
  wrap.append(cacheCard);

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

  wrap.append(el('div', { class: 'card' },
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
  const wrap = el('div', { class: 'cols' });

  const cfg = (await api('/api/config')).config || {};
  const engine = select([['llm', t('llm (vision model)')], ['rapidocr', t('rapidocr (local lightweight)')]],
    cfg.ocr?.engine ?? 'rapidocr');
  const mode = select([['resident', t('resident (always on)')], ['on-demand', t('on-demand')]],
    cfg.ocr?.mode ?? 'resident');
  wrap.append(settingsCard(t('Settings'), [
    [t('Engine'), engine],
    [t('Run mode (rapidocr only; llm is managed on the LLM page)'), mode],
  ], (_i, hint) => saveCfg('ocr', { engine: engine.value, mode: mode.value }, hint)));

  const file = el('input', { type: 'file', accept: 'image/*' });
  const preview = el('img', { class: 'thumb hidden', alt: 'preview' });
  const out = el('div', { class: 'result' });
  wrap.append(el('div', { class: 'card' },
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
