// VocabRadar 引导页逻辑（五子标签：设定栏 / ASR / OCR / Parser / 说明栏，默认设定栏）。
// 本文件保留编排（renderAll/init/loadSettings/模型栏）：共享底座 → shared.js，
//   注释池 → ann-pool.js，字幕 → sub-style.js，ASR/OCR/Parser 见各自模块（依赖无环）。
// 设定栏承载：
//   - Word Annotation 单组：左列三功能卡（网页提示/文本侧栏/视频侧栏开关），右列共享样式
//     候选池 POOL_STYLES，每张池卡带 Web/Text/Video 指派钮（多对多，写 storage 对应键）；
//   - 注释模板 annTemplate（{target} {annotation}，旧 {word}/{meaning} 兼容）；
//   - 字幕样式（文字外观×位置 两维 + 横屏 16:9 / 竖屏 9:16 双预览，overlay 实时应用）；
//   - 各功能开关 / 学习语言 / 释义语言 / 词频阈值 / 注释表外词开关 → 写 storage 对应键。
// 文案全部经 data-key 属性由本地化字典填充，跟随界面语言。

import {
  initLang, setLang,
  LANG_NAMES, UI_LANGS, TRANSLATE_LANGS
} from '../lib/i18n.js';
import { DEFAULT_ANN_TEMPLATE, BUILD_STAMP, ANN_DEFAULT_STYLE, VANN_DEFAULT_STYLE, SUB_DEFAULT_STYLE } from '../lib/styles.js';
import { $, m, log, getLangState, setLangState, ownWriteAt } from './shared.js';
import {
  syncPoolSettings, getPoolTarget, renderPoolGrid, bindPoolGrid, bindPoolLeft,
  renderPoolNote, renderPoolSideDemos
} from './ann-pool.js';
import { syncSubtitleSettings, getSubCustom } from './sub-style.js';
import { initAsrCommon, disposeAsrCommon } from './guide-common.js';
import { initAsr, disposeAsr } from './asr.js';
import { initOcr, disposeOcr } from './ocr.js';
import { initParser, disposeParser } from './parser.js';
// Deactivate 停用栏（逐条规则行渲染/编辑/深链，见该文件头注释）
import { initDeactivate, disposeDeactivate } from './deactivate.js';
// My Words（生词/熟词两栏，设定栏 group-global 后）独立模块
import { initMyWords, syncMyWordsFromStorage, setMyWordsLearnLang } from './my-words.js';
// 渠道状态行模块 ch-health.js（状态拉取/渲染独立成模块，控制本文件行数）
import { initChHealth, refreshChHealth } from './ch-health.js';
// 对话大模型来源预置表（与后台共用同一份，避免地址/模型名两处不一致）
// LLM_FORMAT_GROUPS：下拉按 API 格式 <optgroup> 分组（免费直连 / 河狸后端 / OpenAI Chat
//   Completion 格式 / Anthropic Messages 格式），让"要不要账号"一眼可辨
import {
  LLM_PROVIDERS, LLM_FORMAT_GROUPS, LLM_DEFAULT_PROVIDER, CHAT_WORD_PROMPT, CHAT_SIDEBAR_PROMPT, LLM_TRANSLATE_PROMPT, getProvider
} from '../lib/llm.js';
// 词典装载状态行——ensureReady 幂等（IDB 已构建走投影快通道秒回，
//   缺数据才就地从源装载 = 更新/安装后引导页静默初始化的点名入口），getDiagState 读装载态。
import { ensureReady, getDiagState, getMaxRank, getDictFieldStats } from '../lib/dictionary.js';

// LLM 翻译渠道提示词默认模板（{text}=原文，{lang}=释义语言）——常量 LLM_TRANSLATE_PROMPT
//   在 lib/llm.js（与后台/config.json 共用一份）；后台 handleLlmTranslate 为哑管道直发
//   content 侧组装的提示词（见 translator/index.js）。

// 翻译渠道缺省表（与 lib/translator/index.js 的 DEFAULT_TRANS_CHANNELS 一致：LLM 与 Backend 默认不选；
//   MyMemory 质量差且有 5000 字符/天限流，仅末位手工兜底故默认不选）。
// renderAll 回填与 loadSettings 默认共用；跨标签页 get(null) 拿不到默认键时也以它兜底。
const DEFAULT_TRANS_CH = { llm: false, backend: false, builtin: true, baidusug: true, youdaodict: true, reverso: true, mymemory: false, google: true, youdao: true, baidu: true, bing: true };

// 翻译渠道复选框清单（元素 id ↔ translationChannels 键），回填与保存监听共用一份
// （Backend 排首：回退顺序上它在最前，见 sw/translate.js CHANNEL_TABLE；其余按 guide.html 分组行序：
//  免配置组 → 免费在线组）
const TRANS_CH_IDS = [['transChLlm', 'llm'], ['transChBackend', 'backend'], ['transChBuiltin', 'builtin'], ['transChBaidusug', 'baidusug'],
  ['transChYoudaodict', 'youdaodict'],
  ['transChReverso', 'reverso'], ['transChBing', 'bing'], ['transChGoogle', 'google'],
  ['transChYoudao', 'youdao'], ['transChBaidu', 'baidu'], ['transChMymemory', 'mymemory']];

// 使用说明（说明栏），分节渲染
const HELP = [
  {
    title: { en: 'Web Hints', zh: '网页提示' },
    items: [
      { en: 'After enabling, hover over a word to see its meaning, and click to hear pronunciation.', zh: '开启后，网页上悬停生词即可查看释义，点击可发音。' },
      { en: 'Highlight style is set in Settings → Web Hints.', zh: '高亮样式在「设定栏 → 网页提示」中设置。' },
      { en: 'Frequency threshold filters how rare a word must be to get a meaning.', zh: '词频阈值用于过滤：只有足够生僻的词才会被标注。' }
    ]
  },
  {
    title: { en: 'Text sidebar', zh: '文本侧栏' },
    items: [
      { en: 'Collects sentences of the current page; click any word in a sentence to look it up.', zh: '汇总当前页面的句子，点击句子中的任意生词可查词。' },
      { en: 'Sentence / Word tabs switch between two views.', zh: '句 / 词 两个标签切换视图。' },
      { en: 'New-word (meaning) annotation style is set in Settings → Text Sidebar.', zh: '生词(释义) 注释样式在「设定栏 → 文本侧栏」中设置。' }
    ]
  },
  {
    title: { en: 'Video sidebar', zh: '视频侧栏' },
    items: [
      { en: 'On video pages, shows subtitle sentences of the current video with word meanings.', zh: '在视频页面显示当前视频的逐句字幕并标注生词释义。' },
      { en: 'Sentence / Word tabs switch between views; click a sentence to jump the video.', zh: '句 / 词 两个标签切换视图，点击句子可跳转视频。' },
      { en: 'Annotation style is set in Settings → Video Sidebar.', zh: '注释样式在「设定栏 → 视频侧栏」中设置。' }
    ]
  },
  {
    title: { en: 'Video overlay subtitles', zh: '视频叠加字幕' },
    items: [
      { en: 'Renders the current subtitle onto the video; position / color / font / size / edge are fully configurable.', zh: '将当前字幕叠加到视频画面上，位置/颜色/字体/字号/边缘均可配置。' },
      { en: 'Preview and apply styles in Settings → Video Overlay Subtitles.', zh: '在「设定栏 → 视频叠加字幕」中预览并应用样式。' }
    ]
  },
  {
    title: { en: 'Speech recognition (ASR)', zh: '语音识别（ASR）' },
    items: [
      { en: 'In the ASR tab, upload audio/video, or record audio / video / screen; sentences are recognized and annotated with word meanings.', zh: '在「ASR 栏」上传音视频或录音/录像/录屏，实时识别句子并标注生词释义。' },
      { en: 'Recognition runs locally (Whisper) or via an OpenAI-compatible transcription API, chosen in Settings → Models. Progress and results are shown in the ASR tab.', zh: '识别在本地（Whisper）或 OpenAI 兼容转写 API 运行，于「设定栏 → 模型」选择；进度与结果在「ASR 栏」查看。' }
    ]
  },
  {
    title: { en: 'Text recognition (OCR)', zh: '文字识别（OCR）' },
    items: [
      { en: 'In the OCR tab, upload an image or capture from camera to recognize text in it.', zh: '在「OCR 栏」上传图片或拍照，识别画面中的文字。' },
      { en: 'Recognized lines are annotated with word meanings for your vocabulary.', zh: '识别出的每行文字会标注生词释义。' }
    ]
  },
  {
    title: { en: 'Document parser', zh: '文档解析（Parser）' },
    items: [
      { en: 'In the Parser tab, paste text or a link, or upload / drop / paste a file (web page HTML, PDF, DOCX, txt/md/srt…, image, audio/video); the parsed plain text shows on the right.', zh: '在「Parser 栏」粘贴文本或链接，或上传/拖入/粘贴文件（网页 HTML、PDF、DOCX、txt/md/srt 等文本类、图片、音视频），解析出的纯文本显示在右栏。' },
      { en: 'Images are recognized by OCR and audio/video by speech recognition (engine chosen in Settings → Models); Capture uses the camera, Record uses microphone/camera/screen.', zh: '图片走 OCR 识别、音视频走语音识别（引擎在「设定栏 → 模型」选择）；「拍照」用摄像头，「录制」来源为麦克风/摄像头/屏幕。' }
    ]
  },
  {
    title: { en: 'Dictionary & translation', zh: '词典与翻译' },
    items: [
      { en: 'Meanings come from the built-in dictionary; rare words are auto-inverted via the annotation color.', zh: '释义来自内置词典，生词注释色自动与高亮前后景互换。' },
      { en: 'Offscreen translation is used when the local dictionary has no entry.', zh: '本地词典缺词时，后台使用离线翻译补充。' }
    ]
  }
];



// === 渲染函数 ===

function renderLangSelect(selectEl, langs, selected, names) {
  // 三组语言下拉（界面/学习/释义）统一口径：两位代码 + 空格 + 语言自称（LANG_NAMES）；
  // 20260930 用户令「语言列表的语言自称之前加上两位代码和空格」+ 纠错「释义语言全是英文全称」——
  // 原释义语言传 LANG_NAMES_EN（Chinese/Japanese 英文全称）已撤销，names 参数仅留作个例兜底。
  // 用户令「引导页语言顺序改为两位代码顺序，默认值不变」——仅本页展示按代码字典序排，
  //   不改 i18n.js UI_LANGS/TRANSLATE_LANGS 的顺序（其余端展示序与 loadSettings 默认值原样）。
  const nameOf = names || LANG_NAMES;
  selectEl.innerHTML = '';
  for (const code of [...langs].sort()) {
    const opt = document.createElement('option');
    opt.value = code;
    const label = nameOf[code] || code;
    opt.textContent = nameOf[code] ? `${code} ${label}` : label;
    opt.selected = (code === selected);
    selectEl.appendChild(opt);
  }
}



// 说明栏内容
function renderHelp() {
  const box = $('helpBody');
  if (!box) return;
  box.innerHTML = '';
  for (const sec of HELP) {
    const title = document.createElement('h3');
    title.className = 'help-title';
    title.textContent = sec.title[getLangState()] || sec.title.en;
    box.appendChild(title);
    const ul = document.createElement('ul');
    ul.className = 'help-list';
    for (const item of sec.items) {
      const li = document.createElement('li');
      li.textContent = item[getLangState()] || item.en;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  appendLogFlags(box);
}

// 日志双开关（debugLog=侧栏逐条流水日志阀门；diagLog=诊断类日志阀门）。
//   勾选写 storage.local，content script 经 lib/log-flag.js 的 onChanged 镜像
//   即时生效（无需刷新页面）；config.json debug 仍是打包期默认（现 false，静默）。
const LOG_FLAG_DEFS = [
  { key: 'debugLog', zh: '调试日志（侧栏逐条流水日志）', en: 'Debug logs (sidebar per-event logs)' },
  { key: 'diagLog', zh: '诊断日志（0命中诊断、词典账本、ASR 时间线）', en: 'Diagnostic logs (0-hit diag, dict ledger, ASR timeline)' }
];
function appendLogFlags(box) {
  const wrap = document.createElement('div');
  wrap.className = 'help-logflags';
  const hint = document.createElement('div');
  hint.className = 'help-logflag-hint';
  hint.textContent = (getLangState() === 'zh')
    ? '日志开关（勾选即时生效，无需刷新页面）：'
    : 'Log switches (take effect immediately, no reload needed):';
  wrap.appendChild(hint);
  chrome.storage.local.get(LOG_FLAG_DEFS.map((d) => d.key), (res) => {
    if (chrome.runtime.lastError) return;
    for (const def of LOG_FLAG_DEFS) {
      const label = document.createElement('label');
      label.className = 'help-logflag';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!(res && res[def.key]);
      cb.addEventListener('change', () => {
        chrome.storage.local.set({ [def.key]: cb.checked });
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + (def[getLangState()] || def.en)));
      wrap.appendChild(label);
    }
    box.appendChild(wrap);
  });
}

// 通用 data-key 文案填充：
//   保留前导图标（📁/🎙 等 emoji）——仅当元素文本以 emoji 开头时保留"emoji + 空格 + i18n 文案"；
//   支持 data-title-key（悬浮提示也走 i18n）与 data-ph-key（textarea/input 占位符本地化，
//   placeholder 是属性而非文本内容，data-key 的 textContent 路径不适用）。
function fillByDataKey() {
  document.querySelectorAll('[data-key]').forEach((el) => {
    const key = el.dataset.key;
    const txt = m(key);
    if (txt !== '') {
      const icon = (el.textContent || '').match(/^\s*\p{So}/u);
      el.textContent = icon ? icon[0] + ' ' + txt : txt;
    }
  });
  document.querySelectorAll('[data-title-key]').forEach((el) => {
    const key = el.dataset.titleKey;
    const txt = m(key);
    if (txt !== '') el.title = txt;
  });
  // data-ph-key：占位符本地化（Parser 输入框用）
  document.querySelectorAll('[data-ph-key]').forEach((el) => {
    const key = el.dataset.phKey;
    const txt = m(key);
    if (txt !== '') el.placeholder = txt;
  });
}

// 词典初始化状态行（设定栏顶部 #gDictStatus）：引导页打开即触发 ensureReady——IDB 已构建
//   （__built__ 标记，如 SW onInstalled 已建）走投影快通道秒回；IDB 缺数据才就地从源装载
//   （词频网络拉取只在缺数据时发生），完成翻转「已就绪」。失败示红（网页按无词典降级，不
//   遮蔽错误——AGENTS.md）。文案按界面语言取，不走 data-key/i18n 字典。
// 就绪行四字段各显各的规模（词频/词表标签/翻译/词形还原），计数经 getDictFieldStats()
//   分项取得：词频/词表遍历内存 dictMap，翻译查 d_trans 分表 IDB 计数（含运行时在线翻译
//   缓存），词形查扩展数据域缓存（仅读不下载）。就绪先翻转（不阻塞），分项数字异步到账后刷新。
const _fmt = (n) => Number(n || 0).toLocaleString('en-US');
// 渐进式就绪视觉：◑◒◐◓ 四帧 120ms 字符轮播用于两处——装载中（ensureReady 未落定）、
//   后台构建中（projection.js 库残缺不再 await 重建，放行就绪后源构建后台跑）。
//   句柄模块级持有：renderDictStatus 重入（语言切换）先停旧轮播防 interval 泄漏。
//   rebuildPending 观察器 2s 轮询 getDiagState，清空（重建结束/失败）即停轮播并
//   applyStats(3) 重取分项终值；重建失败时 rebuildPending 同样清空，分项数字如实
//   显示当前残值（控制台有 projection.js 的 warn 详情），不遮蔽错误。
const _SPIN_FRAMES = ['◑', '◒', '◐', '◓'];
let _spinEl = null;
let _spinTimer = null;
function _stopDictSpin() {
  if (_spinTimer) { try { clearInterval(_spinTimer); } catch (_) { /* ignore */ } _spinTimer = null; }
  if (_spinEl) { try { _spinEl.remove(); } catch (_) { /* ignore */ } _spinEl = null; }
}
function _startDictSpin(el, baseText) {
  _stopDictSpin();
  el.textContent = baseText + ' ';
  const span = document.createElement('span');
  span.className = 'g-dict-spin';
  span.textContent = _SPIN_FRAMES[0];
  el.appendChild(span);
  _spinEl = span;
  let _i = 0;
  _spinTimer = setInterval(() => { span.textContent = _SPIN_FRAMES[(++_i) % _SPIN_FRAMES.length]; }, 120);
}
// textContent 赋值会整体替换子节点（轮播 span 被摘下、interval 仍在往脱管节点写字符），
//   故数字刷新后轮播仍活跃即把 span 重新挂回行尾（appendChild 自动从脱管状态移回），
//   构建中的渐进数字刷新与轮播可共存。
function _reattachSpin(el) {
  if (_spinEl && _spinTimer) el.appendChild(_spinEl);
}
// 就绪行分项重取句柄（renderDictStatus 装载时注册；LEMMAS_READY 监听调用）
let _refreshDictStats = null;
function renderDictStatus() {
  const el = $('gDictStatus');
  if (!el) return;
  const zh = getLangState() === 'zh';
  const statusReady = (s) => (zh
    ? `词典已就绪 · 词频 ${_fmt(s.rankCount)} 词 · 词表标签 ${_fmt(s.tagCount)} 词 · 翻译 ${_fmt(s.transCount)} 词 · 词形还原 ${_fmt(s.lemmaCount)} 词`
    : `Dictionary ready · frequency ${_fmt(s.rankCount)} · word-list tags ${_fmt(s.tagCount)} · translations ${_fmt(s.transCount)} · lemmas ${_fmt(s.lemmaCount)}`);
  // 分项统计异步取数后刷新就绪文案；统计失败不回退就绪态（数字维持未刷新前的兜底文案）
  // 翻译包后台补装期重取：补装在 projection.js 异步进行（不阻塞词典就绪），首次统计大概率
  //   取到补装前旧计数；transCount<1000 且 lang=en 时 2s 后重取（最多 3 次），小语种无内置包
  //   不空转。其余字段（词频/词表/词形）就绪时已是终值。构建中数字照刷（有啥字段显示啥）——
  //   行尾追加"后台构建中"标记，轮播 span 重挂行尾。
  const applyStats = (retries) => {
    Promise.resolve(getDictFieldStats()).then((s) => {
      const building = !!getDiagState().rebuildPending;
      el.textContent = statusReady(s) + (building ? (zh ? ' · 后台构建中' : ' · building in background') : '');
      if (building) _reattachSpin(el);
      if (s.lang === 'en' && s.transCount < 1000 && retries > 0) {
        setTimeout(() => applyStats(retries - 1), 2000);
      }
    }).catch(() => { /* 计数失败明示：保留已就绪基础文案，不掩饰也不阻断 */ });
  };
  // applyStats 句柄留模块级：词形整表按需下载写入后 SW 广播 LEMMAS_READY（lemmas-engine.js），
  //   init 处 onMessage 监听据此重取分项（消除"下载先于/晚于取数"造成的 lemmas 0 陈旧数字）
  _refreshDictStats = applyStats;
  // 后台重建观察器：rebuildPending 清空（重建结束/失败）即停轮播并重取分项终值；
  //   构建中每 2s tick 顺带 applyStats(0)——字段到账即亮（如翻译先行回填完成后下一次 tick
  //   就显数），不等重建结束一齐出；retries=0 不叠加翻译重试链（tick 本身就在重刷）
  let _rebuildWatchTimer = null;
  const watchRebuild = () => {
    if (_rebuildWatchTimer) return;
    _rebuildWatchTimer = setInterval(() => {
      let d = null;
      try { d = getDiagState(); } catch (_) { d = null; }
      if (!d || !d.rebuildPending) {
        clearInterval(_rebuildWatchTimer);
        _rebuildWatchTimer = null;
        _stopDictSpin();
        applyStats(3);
      } else {
        applyStats(0);
      }
    }, 2000);
  };
  // 就绪渲染按"是否后台构建中"分流：构建中走轮播文案并立即 applyStats(0) 取数（快字段
  //   先行亮出，数字渐进刷新与轮播共存）；未构建直接就绪文案
  const renderReady = () => {
    const d = getDiagState();
    if (d.rebuildPending) {
      _startDictSpin(el, zh ? '词典已就绪 · 后台构建词频/标签中' : 'Dictionary ready · building frequency/tags in background');
      applyStats(0);
      watchRebuild();
    } else {
      _stopDictSpin();
      el.textContent = zh ? '词典已就绪' : 'Dictionary ready';
      el.classList.add('ok');
      applyStats(3);
    }
  };
  const diag = getDiagState();
  if (diag.loadedLang) {
    el.classList.add('ok');
    renderReady();
    return;
  }
  // 装载中 ◑◒◐◓ 轮播（替代静态"装载中…"，一眼可见在动、没死）
  _startDictSpin(el, zh ? '词典装载中' : 'Dictionary loading');
  // 承诺永不悬空（query.js：_loadDict 内部 catch，resolve null/undefined 表示失败）
  Promise.resolve(ensureReady()).then((m) => {
    if (m) {
      el.classList.add('ok');
      el.classList.remove('fail');
      refreshRankMaxPlaceholder();
      renderReady();
    } else {
      _stopDictSpin();
      el.textContent = zh ? '词典装载失败：网页将按无词典降级运行（详见控制台）' : 'Dictionary load failed: pages fall back to no-dictionary mode (see console)';
      el.classList.add('fail');
      el.classList.remove('ok');
    }
  });
}

// 读取 config.json 出厂值（模块级缓存）。对话三项参数（chatWordPrompt/chatSidebarPrompt/
//   chatContextMaxBytes）实际生效以出厂值为第一优先（chat.js openChatPanel/buildFirstPrompt
//   同款三级优先），本页回填后异步覆盖显示，保证引导页"所见 = 实际生效"。
let _factoryCfgPromise = null;
function readFactoryCfg() {
  if (!_factoryCfgPromise) {
    _factoryCfgPromise = fetch(chrome.runtime.getURL('src/data/config.json'))
      .then((r) => r.json())
      .catch(() => ({}));
  }
  return _factoryCfgPromise;
}

// === 事件绑定 ===

// 加载既有设置并回填控件
// 引导页全部默认参数以 src/data/config.json 为唯一来源（键名=storage 键），
//   本文件内联对象仅作 config 缺键时的保底；storage 里用户已设的值恒优先。
let _configDefaults = null;
async function getConfigDefaults() {
  if (_configDefaults) return _configDefaults;
  try {
    const res = await fetch(chrome.runtime.getURL('src/data/config.json'));
    if (res.ok) _configDefaults = await res.json();
  } catch (e) { _configDefaults = null; }
  return _configDefaults || {};
}

async function loadSettings() {
  const cfgDefaults = await getConfigDefaults();
  const defaults = Object.assign({
    uiLanguage: 'zh',
    learnLanguage: 'en',
    meaningLanguage: 'zh',
    rankThreshold: 5000,
    annotateOov: false,
    rankThresholdMax: 0,   // 词频范围上界（0=不限制），出厂未设上界
    annotateRepeat: false,
    hintLaterEnabled: false,   // 与 popup.hintLaterEnabled 同键，默认空即仅首次高亮
    hintSideAnnotation: false,
    textHintEnabled: true,
    // 右键查询/查询栏两键故意不进 defaults——回填时 undefined 即回退旧 queryEnabled，
    //   老用户旧值自动沿用（进了 defaults 会被 get 填 true，旧关值会被掩盖）
    queryEnabled: true,
    // 对话大模型配置（llmBaseUrl/llmModel 留空 = 用所选来源的预置值）
    llmProvider: LLM_DEFAULT_PROVIDER,
    llmBaseUrl: '',
    llmModel: '',
    llmApiKey: '',
    chatWordPrompt: CHAT_WORD_PROMPT,
    chatSidebarPrompt: CHAT_SIDEBAR_PROMPT,
    chatContextMaxBytes: 100000,   // 对话上下文字节上限（与出厂 config.json 同值）
    asrLlmProvider: 'local-backend',   // ASR 转写 API 来源（provider id；本地后端免 Key）
    asrLlmModel: 'whisper-1',   // LLM 转写模型（用户自管，有错就报；本地后端忽略此值）
    asrLlmBaseUrl: '',   // 转写 API 接口地址（后台 resolveLlmEngineCfg('asr') 消费）
    asrLlmApiKey: '',    // 转写 API Key
    ocrLlmProvider: 'openai',   // OCR 视觉识别 API 来源（provider id；本地后端免 Key）
    ocrLlmBaseUrl: '',
    ocrLlmModel: '',
    ocrLlmApiKey: '',
    translationChannels: DEFAULT_TRANS_CH,   // 翻译渠道缺省表（LLM 渠道默认不选，其余全选）
    llmTranslatePrompt: LLM_TRANSLATE_PROMPT,   // LLM 翻译渠道提示词（{text}=原文，{lang}=释义语言）
    // 注释样式出厂默认改引代指常量：绝对值唯一真源在常量（styles.js），版本变化才改常量值
    textStyle: ANN_DEFAULT_STYLE,
    annotationStyle: ANN_DEFAULT_STYLE,
    videoAnnotationStyle: ANN_DEFAULT_STYLE,
    annotationCustom: {   // 注释个性化缺省：生词底色默认透明（无底色）
      wordBg: 'transparent', wordFg: '#004d40', annBg: 'transparent', annFg: '#004d40',
      radius: '4px', bold: true
    },
    annotationSample: 'vocab radar',
    annTemplate: DEFAULT_ANN_TEMPLATE,   // 注释模板；其余三栏各有分键、默认同值
    webAnnTemplate: DEFAULT_ANN_TEMPLATE,
    videoAnnTemplate: DEFAULT_ANN_TEMPLATE,
    videoOverlayAnnTemplate: DEFAULT_ANN_TEMPLATE,
    subtitleStyle: SUB_DEFAULT_STYLE,   // 字幕样式出厂默认改引代指常量
    subtitlePosition: 'b15',   // 贴底 15%
    subtitleCustom: { bg: 'transparent', fg: '#ffffff', fontSizePct: 5, fontFamily: 'sans', fx: 'shadow' },   // subtitleStyle='custom' 时生效；透明底/投影特效，与 overlay 端缺省对齐
    videoOverlayAnnStyle: VANN_DEFAULT_STYLE,   // 视频叠加字幕注释行默认样式（yellow-yellow，与前三栏分道）
    webSidebarEnabled: true,
    sidebarEnabled: true,
    overlayEnabled: false,   // 与 video-sidebar.js 三处 === true 口径一致：未设置视为关
    webSidebarAnnMode: 'side',
    videoSidebarAnnMode: 'side',
    videoOverlayAnnMode: 'side',
    hintFirstBg: 'transparent',   // 默认无底色，透明底绿字
    hintFirstFg: '#2e6b43'
  }, cfgDefaults);
  // 等待 storage 读取完成再返回：init 里 await loadSettings()，保证 _lang 在后续动态行渲染
  //   （deactivate 停用栏 chip 等）前已按界面语言就绪，避免行首渲染竞态到 zh 默认值
  return new Promise((resolve) => {
    chrome.storage.local.get(defaults, (res) => {
      setLangState(res.uiLanguage);
      renderAll(res);
      // 283次：首次使用写回个性化默认——get(defaults) 不落盘，content 端（overlay）只读
      //   storage 拿不到 defaults，不写回则新装用户视频端看不到透明底默认样式
      chrome.storage.local.get(null, (all) => {
        if (!('subtitleCustom' in all)) {
          chrome.storage.local.set({ subtitleCustom: getSubCustom() }, () => log('subtitleCustom 首次写回'));
        }
      });
      resolve(res);
    });
  });
}

// 词频上界占位提示：词典就绪后显示词频表上界实际值，未就绪显示 ∞
function refreshRankMaxPlaceholder() {
  const maxHint = getMaxRank();
  $('rankThresholdMax').placeholder = (maxHint > 0) ? String(maxHint) : '∞';
}

// 上界 spinner 起步值随动下界：min = 下界+步长，空值点 ▲ 直接落在合法值上
function updateRankMaxMin() {
  const low = parseInt($('rankThreshold').value, 10);
  $('rankThresholdMax').min = String((isFinite(low) ? low : 0) + 1000);
}

function renderAll(res) {
  // 语言控件（三组统一：代码 + 自称；释义语言原 LANG_NAMES_EN 英文全称口径 20260930 撤销）
  renderLangSelect($('uiLang'), UI_LANGS, res.uiLanguage);
  renderLangSelect($('learnLanguage'), TRANSLATE_LANGS, res.learnLanguage);
  renderLangSelect($('meaningLanguage'), TRANSLATE_LANGS, res.meaningLanguage);
  $('rankThreshold').value = res.rankThreshold;
  // 词频上界：0/缺省=回退到词典词频表上界；词典未就绪时显示 ∞
  const _effMax = (typeof res.rankThresholdMax === 'number' && isFinite(res.rankThresholdMax) && res.rankThresholdMax > 0)
    ? res.rankThresholdMax : 0;
  $('rankThresholdMax').value = _effMax > 0 ? _effMax : '';
  if (_effMax > 0) $('rankThresholdMax').dataset.prev = String(_effMax); // 非法输入恢复基准
  updateRankMaxMin(); // 上界 spinner 起步值随动下界
  refreshRankMaxPlaceholder();
  $('annotateOov').checked = !!res.annotateOov;
  // ASR/OCR 不启用免费直连组：旧 storage 残留 free 组 id 经组校验显式回退默认并写回
  //   （free 组恢复后 getProvider 不再将其归一化，须自行校验；对话 LLM 无此限制）
  // ASR API 细项回填（模型名保留 whisper-1 兜底）
  const asrAllowed = ['backend', 'openai'];
  const _asrP = getProvider(res.asrLlmProvider);
  const _asrId = asrAllowed.includes(_asrP.group || _asrP.format) ? _asrP.id : 'local-backend';
  renderEngineProviderSelect($('asrLlmProvider'), _asrId, asrAllowed);
  applyEngineProviderHints('asr', $('asrLlmProvider').value, 'whisper-1');
  if (_asrId !== (res.asrLlmProvider || '')) chrome.storage.local.set({ asrLlmProvider: _asrId });
  $('asrLlmBaseUrl').value = res.asrLlmBaseUrl || '';
  $('asrLlmApiKey').value = res.asrLlmApiKey || '';
  $('asrLlmModel').value = res.asrLlmModel || 'whisper-1';
  // OCR API 细项回填（provider id 下拉裁 free 组；地址/模型 placeholder 随来源给预置值）
  const ocrAllowed = ['backend', 'openai', 'anthropic'];
  const _ocrP = getProvider(res.ocrLlmProvider);
  const _ocrId = ocrAllowed.includes(_ocrP.group || _ocrP.format) ? _ocrP.id : 'openai';
  renderEngineProviderSelect($('ocrLlmProvider'), _ocrId, ocrAllowed);
  applyEngineProviderHints('ocr', $('ocrLlmProvider').value);
  if (_ocrId !== (res.ocrLlmProvider || '')) chrome.storage.local.set({ ocrLlmProvider: _ocrId });
  $('ocrLlmBaseUrl').value = res.ocrLlmBaseUrl || '';
  $('ocrLlmModel').value = res.ocrLlmModel || '';
  $('ocrLlmApiKey').value = res.ocrLlmApiKey || '';
  // 翻译渠道回填（缺省表兜底：LLM/Backend/MyMemory 不选、其余全选——跨标签页 get(null) 拿不到默认键时防止全亮）
  // 无内置翻译 API 的浏览器（Firefox）：「浏览器自身」灰显禁用且不勾选
  const tch = Object.assign({}, DEFAULT_TRANS_CH, res.translationChannels || {});
  const builtinUnsupported = (typeof Translator === 'undefined');
  TRANS_CH_IDS.forEach(([id, k]) => {
    const cb = $(id);
    cb.checked = (tch[k] !== false);
    if (k === 'builtin') {
      cb.disabled = builtinUnsupported;
      cb.checked = cb.checked && !builtinUnsupported;
      const lbl = cb.closest('label.chk');
      if (lbl) {
        lbl.classList.toggle('disabled', builtinUnsupported);
        lbl.title = builtinUnsupported ? m('transChBuiltinNoFx') : '';
      }
    }
  });
  $('llmTranslatePrompt').value = res.llmTranslatePrompt || LLM_TRANSLATE_PROMPT;
  // 渠道状态行刷新（CH_HEALTH 登记簿快照，ch-health.js）
  refreshChHealth();
  // 单开关回填：任一重复键为开即勾选（勾选态=允许重复）
  $('hintLaterEnabled').checked = !!(res.hintLaterEnabled || res.annotateRepeat);
  $('hintSideAnnotation').checked = !!res.hintSideAnnotation;
  // word hits 六开关回填（缺省=开；右键查询/查询栏 undefined 时回退旧 queryEnabled）
  const _effQuery = (v) => (typeof v === 'undefined' ? res.queryEnabled : v) !== false;
  $('hitContextLookup').checked = _effQuery(res.contextLookupEnabled);
  $('hitQueryBar').checked = _effQuery(res.queryBarEnabled);
  $('hitTextHint').checked = res.textHintEnabled !== false;
  $('hitTextSidebar').checked = res.webSidebarEnabled !== false;
  $('hitVideoSidebar').checked = res.sidebarEnabled !== false;
  // 视频叠加字幕默认关：未设置视为未勾选（=== true），与 video-sidebar.js / defaults 同口径
  $('hitOverlay').checked = res.overlayEnabled === true;

  // 模型行：来源下拉 + API 配置回填（getProvider 未知 id 回退默认来源并写回）
  const _chatId = getProvider(res.llmProvider).id;
  renderLlmProviderSelect(_chatId || LLM_DEFAULT_PROVIDER);
  if (_chatId !== (res.llmProvider || '')) chrome.storage.local.set({ llmProvider: _chatId || LLM_DEFAULT_PROVIDER });
  $('llmBaseUrl').value = res.llmBaseUrl || '';
  $('llmModel').value = res.llmModel || '';
  $('llmApiKey').value = res.llmApiKey || '';
  $('chatWordPrompt').value = res.chatWordPrompt || CHAT_WORD_PROMPT;
  $('chatSidebarPrompt').value = res.chatSidebarPrompt || CHAT_SIDEBAR_PROMPT;
  // 对话上下文上限回填（空值显示默认 100000，与 loadSettings 默认/出厂 config.json 对齐）；
  //   三项对话参数实际生效以 config.json 出厂值为第一优先，回填后异步用出厂值覆盖显示，
  //   保证"所见 = 实际生效"。
  $('chatContextMaxBytes').value = res.chatContextMaxBytes || 100000;
  readFactoryCfg().then((cfg) => {
    if (!cfg) return;
    const w = cfg.chatWordPrompt;
    if (typeof w === 'string' && w.trim()) $('chatWordPrompt').value = w;
    const s = cfg.chatSidebarPrompt;
    if (typeof s === 'string' && s.trim()) $('chatSidebarPrompt').value = s;
    const n = cfg.chatContextMaxBytes;
    if (typeof n === 'number' && n >= 1000) $('chatContextMaxBytes').value = Math.floor(n);
  });
  applyLlmProviderHints(res.llmProvider);

  syncPoolSettings(res);
  // 候选池（右列网格一次建卡 + 池顶说明随选中栏切换 + 左栏选中态与内联复制卡）；
  //   初始选中栏固定第一项 Web Hints（_poolTarget 默认），补 .selected 高亮。
  renderPoolGrid();
  bindPoolGrid();
  bindPoolLeft();
  document.querySelectorAll('.pool-left .pool-item').forEach((it) => {
    it.classList.toggle('selected', it.dataset.target === getPoolTarget());
  });
  renderPoolNote();
  renderPoolSideDemos();

  syncSubtitleSettings(res);

  // My Words 两栏初始化（幂等；读 storage 回填 + 控件绑定 + chips 渲染）
  initMyWords();

  // 界面文案
  applyTexts();
}

/**
 * 渲染对话模型来源下拉：按 API 格式 <optgroup> 分组（免费直连 / 河狸后端 / OpenAI Chat
 *   Completion 格式 / Anthropic Messages 格式），选项文案跟随界面语言；
 *   未知/残留 id 由 getProvider 回退默认来源。
 * @param {string} id 当前选中的来源 id
 */
// 引擎 LLM 配置的 Provider 选择渲染（通用版，供 ASR/OCR 复用）：
//   过滤支持 group 字段（provider 可归入与 format 不同的显示组，如河狸后端组）；
//   第 3 参 allowedGroups 裁剪显示组（ASR 裁 anthropic、ASR/OCR 都裁 free）
function renderEngineProviderSelect(sel, selected, allowedGroups) {
  if (!sel) return;
  sel.innerHTML = '';
  LLM_FORMAT_GROUPS.forEach((g) => {
    if (allowedGroups && !allowedGroups.includes(g.format)) return;
    const items = LLM_PROVIDERS.filter((p) => (p.group || p.format || 'openai') === g.format);
    if (!items.length) return;
    const og = document.createElement('optgroup');
    og.label = g.label[getLangState()] || g.label.en;
    items.forEach((pr) => {
      const opt = document.createElement('option');
      opt.value = pr.id;
      opt.textContent = pr.label[getLangState()] || pr.label.en;
      og.appendChild(opt);
    });
    sel.appendChild(og);
  });
  sel.value = selected || 'openai';
}

function renderLlmProviderSelect(id) {
  const sel = $('llmProvider');
  if (!sel) return;
  sel.innerHTML = '';
  LLM_FORMAT_GROUPS.forEach((g) => {
    const items = LLM_PROVIDERS.filter((p) => (p.group || p.format || 'openai') === g.format);
    if (!items.length) return;
    const og = document.createElement('optgroup');
    og.label = g.label[getLangState()] || g.label.en;
    items.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label[getLangState()] || p.label.en;
      og.appendChild(opt);
    });
    sel.appendChild(og);
  });
  sel.value = getProvider(id).id;
}

/**
 * 同步来源相关的提示信息：输入框 placeholder 显示该来源的预置地址/模型。
 * 免 Key 来源（free 免费直连 / noKey 本地后端）不隐藏 Key 框（形制统一），
 *   占位符显示 no need 提示无需填写。
 * @param {string} id 来源 id
 */
function applyLlmProviderHints(id) {
  const p = getProvider(id);
  const base = $('llmBaseUrl');
  const model = $('llmModel');
  const key = $('llmApiKey');
  if (base) base.placeholder = p.baseUrl || 'https://your-endpoint/v1';
  if (model) model.placeholder = p.model || 'model-name';
  if (key) key.placeholder = (p.noKey || p.format === 'free') ? 'no need' : 'sk-...';
}

// 服务连通探测：检测单位是服务（当前选中的 provider），不是模型。backend 组探
//   {base}/api/health（baseUrl 去 /v1）；openai 格式探 {base}/models，anthropic 格式探
//   {base}/v1/models（与运行时请求路径同口径）。2xx = √，其余状态码一律 ×；
//   需 Key 的格式无 Key 直接判失败（title 提示 missing-key，不发请求）；有 Key 带鉴权头
//   探测（openai: Authorization Bearer / anthropic: x-api-key + anthropic-version），
//   Key 错误即 401 ×，如实反映。
const SERVICE_DETECT_IDS = {
  llm: { provider: 'llmProvider', base: 'llmBaseUrl', key: 'llmApiKey', btn: 'btnDetectLlm', span: 'spanDetectLlm' },
  asr: { provider: 'asrLlmProvider', base: 'asrLlmBaseUrl', key: 'asrLlmApiKey', btn: 'btnDetectAsr', span: 'spanDetectAsr' },
  ocr: { provider: 'ocrLlmProvider', base: 'ocrLlmBaseUrl', key: 'ocrLlmApiKey', btn: 'btnDetectOcr', span: 'spanDetectOcr' }
};

/** 服务连通探测：5s 超时；2xx = √，其余状态码 = ×。返回 {ok, status?, error?, ms}。 */
async function probeServiceUrl(url, headers) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store', headers: headers || {} });
    return { ok: r.ok, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'AbortError') ? 'timeout' : 'network', ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/** 清空检测结果（切换服务/改地址后旧结果已失效）。 */
function clearServiceResult(kind) {
  const span = $(SERVICE_DETECT_IDS[kind].span);
  if (span) { span.textContent = ''; span.title = ''; }
}

function renderDetectResult(span, res) {
  if (!span) return;
  if (res && res.ok) {
    span.textContent = '√';
    span.style.color = '#1f9d4d';
    span.title = 'HTTP ' + res.status + ' · ' + res.ms + 'ms';
  } else {
    // missing-key 直接中文点破（未发请求），其余原样
    const errText = (res && res.error === 'missing-key')
      ? (getLangState() === 'zh' ? '需先填 API Key' : 'API Key required')
      : ((res && res.error) || 'HTTP ' + (res && res.status));
    span.textContent = '×';
    span.style.color = '#d64541';
    span.title = errText + ' · ' + (res ? res.ms : 0) + 'ms';
  }
}

/** 检测某服务（kind: llm|asr|ocr）当前选中 provider 的连通性：2xx + 鉴权头 + 无 Key 即 ×。 */
async function detectService(kind) {
  const ids = SERVICE_DETECT_IDS[kind];
  const btn = $(ids.btn);
  const span = $(ids.span);
  const p = getProvider($(ids.provider).value);
  if (btn) btn.disabled = true;
  if (span) { span.textContent = '…'; span.style.color = ''; span.title = ''; }
  // 地址：用户手填优先，留空回退来源预置（与 resolveLlmConfig 同口径）
  const rawBase = String($(ids.base).value || '').trim().replace(/\/+$/, '');
  const base = (rawBase || String(p.baseUrl || '').trim().replace(/\/+$/, ''));
  const apiKey = String(($(ids.key) && $(ids.key).value) || '').trim();
  const isAnthropic = (p.format === 'anthropic');
  let res;
  if ((p.group || '') === 'backend' || p.format === 'backend') {
    // backend 组探健康端点（baseUrl 去 /v1）
    res = await probeServiceUrl(base.replace(/\/v1$/i, '') + '/api/health');
  } else if (!p.noKey && p.format !== 'free' && !apiKey) {
    // 需 Key 的格式无 Key：直接 ×，不发请求（free 免费直连 / noKey 本地后端不要求 Key）
    res = { ok: false, error: 'missing-key', ms: 0 };
  } else {
    // 有 Key 带鉴权头探测（探 models 端点）；Key 错误即 401 ×，如实反映；free 不带鉴权头
    const headers = isAnthropic
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : (p.format === 'free' ? {} : { 'Authorization': 'Bearer ' + apiKey });
    res = await probeServiceUrl(base + (isAnthropic ? '/v1/models' : '/models'), headers);
  }
  renderDetectResult(span, res);
  if (btn) btn.disabled = false;
  log('检测服务[' + kind + ']:', p.id, res.ok ? '√ HTTP ' + res.status + ' ' + res.ms + 'ms' : '× ' + ((res && res.error) || ('HTTP ' + res.status)));
}

// ASR/OCR 引擎 API 来源提示通用化（镜像 applyLlmProviderHints 的交互）：
//   placeholder 带来源预置地址/模型；prefix='asr'|'ocr' 拼控件 id；modelPlaceholder 覆写
//   模型提示（来源表预置的是对话模型名，ASR 转写恒提示 whisper-1）。
//   noKey 来源不隐藏 Key 输入，Key 框占位符显示 no need（镜像 chat 行）。
function applyEngineProviderHints(prefix, id, modelPlaceholder) {
  const p = getProvider(id);
  const base = $(prefix + 'LlmBaseUrl');
  const model = $(prefix + 'LlmModel');
  const key = $(prefix + 'LlmApiKey');
  if (base) base.placeholder = p.baseUrl || 'https://your-endpoint/v1';
  if (model) model.placeholder = modelPlaceholder || p.model || 'model-name';
  if (key) key.placeholder = p.noKey ? 'no need' : 'sk-...';
}


// 界面文案填充（data-key 通用 + 动态内容）
function applyTexts() {
  document.title = 'VocabRadar · Guide';
  document.documentElement.lang = getLangState();
  fillByDataKey();
  // fillByDataKey 会把 poolNoteRerender 覆盖回静态兜底文案（段2），须在其后重跑动态拼接
  //   （拼当前栏名）；此时池状态已就绪，幂等无副作用
  renderPoolNote();
  renderHelp();
  // 头部显示构建版本：与视频页 overlay 启动日志的 BUILD_STAMP 对照可判定构建新旧
  const verEl = $('guideVer');
  if (verEl) verEl.textContent = BUILD_STAMP;   // BUILD_STAMP 已含 'v' 前缀（构建注入）
}

// === 初始化 ===

async function init() {
  await initLang().catch(() => {});
  // await：_lang 就绪后 initDeactivate 才渲染动态行（避免语言混杂竞态）
  await loadSettings();
  // 词典状态行（引导页 = 更新/安装后静默初始化的点名入口）
  renderDictStatus();

  // 三子标签切换
  document.querySelectorAll('.guide-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      document.querySelectorAll('.guide-tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.guide-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
      log('切换子标签:', name);
    });
  });

  // 可折叠分组（组头点击折叠/展开，点击开关不触发折叠）
  // 初始把 collapsed 类与箭头同步为内联 display 的实际状态：guide.html 折叠组初始收起
  //   用内联 style="display:none;" 但无 collapsed 类，不同步则第一下点击误判状态。
  document.querySelectorAll('.group[data-collapsible]').forEach((group) => {
    const head = group.querySelector('.group-head');
    const body = group.querySelector('.group-body');
    const toggle = group.querySelector('.group-toggle');
    if (!head || !body) return;
    const setCollapsed = (collapsed) => {
      group.classList.toggle('collapsed', collapsed);
      body.style.display = collapsed ? 'none' : '';
      if (toggle) toggle.textContent = collapsed ? '▸' : '▾';
    };
    // 初始同步：以内联 display 为准（display:none ⇒ 已收起，加 collapsed 类）
    const startsCollapsed = body.style.display === 'none';
    if (startsCollapsed) setCollapsed(true);
    head.addEventListener('click', (e) => {
      if (e.target.closest('label, input, select, a, button')) return;
      setCollapsed(!group.classList.contains('collapsed'));
    });
    if (toggle) {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        setCollapsed(!group.classList.contains('collapsed'));
      });
    }
  });

  // 语言切换：写 storage + 重渲染
  $('uiLang').addEventListener('change', (e) => {
    const lang = e.target.value;
    setLang(lang);
    chrome.storage.local.set({ uiLanguage: lang }, () => {
      setLangState(lang);
      chrome.storage.local.get(null, (res) => renderAll(res));
      log('界面语言已切换为', lang);
    });
  });

  // 源语言/目标语言/阈值/生词开关
  $('learnLanguage').addEventListener('change', (e) => {
    chrome.storage.local.set({ learnLanguage: e.target.value }, () => log('源语言=', e.target.value));
  });
  $('meaningLanguage').addEventListener('change', (e) => {
    chrome.storage.local.set({ meaningLanguage: e.target.value }, () => log('释义语言=', e.target.value));
  });
  $('rankThreshold').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    chrome.storage.local.set({ rankThreshold: isFinite(v) ? v : 5000 }, () => log('词频阈值=', v));
    updateRankMaxMin(); // 下界变了 → 上界 spinner 起步值随动
  });
  // 词频上界（0/空=未设上界=空集，全部词都值得注释；正数上界须大于下界）
  // Chrome 空值点 ▲ 从 min 起步，须区分输入：留空/0=未设上界（空集=∞，annotator.js
  //   setRankMax 对 0/非正数即转 Infinity）；合法值=直接存；非法=恢复上次有效值
  //   （dataset.prev）。spinner min 由 updateRankMaxMin 恒设 下界+1000，起步值本就合法。
  $('rankThresholdMax').addEventListener('change', (e) => {
    const raw = e.target.value;
    const v = parseInt(raw, 10);
    const low = parseInt($('rankThreshold').value, 10);
    if (raw === '' || v === 0) {
      // 留空或 0 = 未设上界（空集=全部词都值得注释）：存 0，输入框保持空显示占位 ∞
      chrome.storage.local.set({ rankThresholdMax: 0 }, () => { refreshRankMaxPlaceholder(); log('词频上界重置为未设（全部词都值得注释）'); });
      return;
    }
    if (isFinite(v) && v > 0 && !(isFinite(low) && v <= low)) {
      $('rankThresholdMax').dataset.prev = String(v);
      chrome.storage.local.set({ rankThresholdMax: v }, () => log('词频上界=', v));
      return;
    }
    // 非法输入：恢复上次有效值；无则回落 未设(∞)
    const prev = parseInt($('rankThresholdMax').dataset.prev || '0', 10);
    const restore = (isFinite(prev) && prev > 0) ? prev : 0;
    $('rankThresholdMax').value = restore > 0 ? String(restore) : '';
    if (restore > 0) $('rankThresholdMax').dataset.prev = String(restore);
    chrome.storage.local.set({ rankThresholdMax: restore }, () => { refreshRankMaxPlaceholder(); log('词频上界非法，已恢复=', restore > 0 ? restore : '未设'); });
  });
  $('annotateOov').addEventListener('change', (e) => {
    chrome.storage.local.set({ annotateOov: e.target.checked }, () => log('注释表外词=', e.target.checked));
  });
  // 旧 annotateRepeat 复选框已删（只留一个开关）；单开关双写——
  //   hintLaterEnabled（后续高亮显隐）+ annotateRepeat（侧邻/侧栏/字幕注释去重）
  //   同值，确保"重复"一个概念两处机制一致；content 侧 onChanged+5s 对账已覆盖两键。
  $('hintLaterEnabled').addEventListener('change', (e) => {
    const v = !!e.target.checked;
    chrome.storage.local.set({ hintLaterEnabled: v, annotateRepeat: v }, () => log('注释重复生词=', v));
  });
  $('hintSideAnnotation').addEventListener('change', (e) => {
    chrome.storage.local.set({ hintSideAnnotation: e.target.checked }, () => log('侧邻提示=', e.target.checked));
  });
  // word hits 六开关保存（旧 queryEnabled 不再写入，只读回退）
  $('hitContextLookup').addEventListener('change', (e) => {
    chrome.storage.local.set({ contextLookupEnabled: e.target.checked }, () => log('右键查询=', e.target.checked));
  });
  $('hitQueryBar').addEventListener('change', (e) => {
    chrome.storage.local.set({ queryBarEnabled: e.target.checked }, () => log('查询栏=', e.target.checked));
  });
  $('hitTextHint').addEventListener('change', (e) => {
    chrome.storage.local.set({ textHintEnabled: e.target.checked }, () => log('网页提示=', e.target.checked));
  });
  $('hitTextSidebar').addEventListener('change', (e) => {
    chrome.storage.local.set({ webSidebarEnabled: e.target.checked }, () => log('文本侧栏=', e.target.checked));
  });
  $('hitVideoSidebar').addEventListener('change', (e) => {
    chrome.storage.local.set({ sidebarEnabled: e.target.checked }, () => log('视频侧栏=', e.target.checked));
  });
  $('hitOverlay').addEventListener('change', (e) => {
    chrome.storage.local.set({ overlayEnabled: e.target.checked }, () => log('视频叠加字幕=', e.target.checked));
  });
  // 注释布局三组 radio 的 storage 键（webSidebarAnnMode/videoSidebarAnnMode/
  //   videoOverlayAnnMode）与 defaults 保留：侧栏/overlay 功能自身 UI 仍消费

  // 模型行：来源切换时清空自定义地址/模型，改用新来源的预置值
  //   （否则切到 Groq 却仍带着 OpenRouter 的模型名，请求必然 404，且用户看不出原因）
  $('llmProvider').addEventListener('change', (e) => {
    const id = e.target.value;
    chrome.storage.local.set({ llmProvider: id, llmBaseUrl: '', llmModel: '' }, () => {
      $('llmBaseUrl').value = '';
      $('llmModel').value = '';
      applyLlmProviderHints(id);
      clearServiceResult('llm');   // 服务已切换，旧检测结果失效
      log('对话模型来源=', id);
    });
  });
  // 每个模型服务一个「检测」按钮，测当前选中服务的连通性
  $('btnDetectLlm').addEventListener('click', () => detectService('llm'));
  $('btnDetectAsr').addEventListener('click', () => detectService('asr'));
  $('btnDetectOcr').addEventListener('click', () => detectService('ocr'));
  // 渠道状态行：周期刷新 SW 翻译登记簿（ch-health.js）
  initChHealth({ log, getLang: getLangState });
  // 词形整表下载完成广播（lemmas-engine.js 写入后发）：就绪行分项重取，
  //   消除"下载先于/晚于取数"造成的 lemmas 0 陈旧数字。不 return true（无需应答）。
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'LEMMAS_READY' && _refreshDictStats) _refreshDictStats(0);
  });
  // 分字段后台合并到账广播（projection.js：FAST 后台 Stage 2 合并/源重建完成时派发
  //   vr-dict-rebuilt）：词表标签等分项异步到账即重取分项数字（2026-10-06 用户裁定
  //   "各个字段独立……等有词表标签再加标签"——就绪行翻牌只等词频级，分项到一门亮
  //   一门）。window 事件（同 context 派发，非 SW 消息，无需应答）。
  window.addEventListener('vr-dict-rebuilt', () => {
    if (_refreshDictStats) _refreshDictStats(0);
  });
  // 地址/模型/Key/提示词：change（失焦或回车）时保存，与本页其他控件一致
  $('llmBaseUrl').addEventListener('change', (e) => {
    chrome.storage.local.set({ llmBaseUrl: e.target.value.trim() }, () => log('接口地址已保存'));
    clearServiceResult('llm');   // 地址已改，旧检测结果失效
  });
  $('llmModel').addEventListener('change', (e) => {
    chrome.storage.local.set({ llmModel: e.target.value.trim() }, () => log('模型名=', e.target.value.trim()));
  });
  $('llmApiKey').addEventListener('change', (e) => {
    chrome.storage.local.set({ llmApiKey: e.target.value.trim() }, () => log('API Key 已保存（长度', e.target.value.trim().length, '）'));
  });
  // 对话提示词拆两套（单词类/侧栏），各自独立保存；清空即回落到各自默认常量
  $('chatWordPrompt').addEventListener('change', (e) => {
    const v = e.target.value.trim() || CHAT_WORD_PROMPT;
    e.target.value = v;
    chrome.storage.local.set({ chatWordPrompt: v }, () => log('单词类查询提示词=', v));
  });
  $('chatSidebarPrompt').addEventListener('change', (e) => {
    const v = e.target.value.trim() || CHAT_SIDEBAR_PROMPT;
    e.target.value = v;
    chrome.storage.local.set({ chatSidebarPrompt: v }, () => log('侧栏提示词=', v));
  });
  // 对话上下文上限（字节，下限 1000；非法输入回落默认 100000）
  $('chatContextMaxBytes').addEventListener('change', (e) => {
    let v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v) || v < 1000) v = 100000;
    e.target.value = v;
    chrome.storage.local.set({ chatContextMaxBytes: v }, () => log('对话上下文上限(字节)=', v));
  });
  // ASR/OCR API 来源下拉：provider id 直存（'openai'/'anthropic' 旧值即 provider id
  //   天然兼容）；change 时同步 placeholder 与 Key 框提示
  $('asrLlmProvider').addEventListener('change', (e) => {
    const v = e.target.value;
    chrome.storage.local.set({ asrLlmProvider: v }, () => log('ASR API 来源=', v));
    applyEngineProviderHints('asr', v, 'whisper-1');
    clearServiceResult('asr');   // 服务已切换，旧检测结果失效
  });
  $('ocrLlmProvider').addEventListener('change', (e) => {
    const v = e.target.value;
    chrome.storage.local.set({ ocrLlmProvider: v }, () => log('OCR API 来源=', v));
    applyEngineProviderHints('ocr', v);
    clearServiceResult('ocr');   // 服务已切换，旧检测结果失效
  });
  // ASR API 细项（OpenAI 兼容转写）：地址/模型/Key 保存
  $('asrLlmBaseUrl').addEventListener('change', (e) => {
    chrome.storage.local.set({ asrLlmBaseUrl: e.target.value.trim() }, () => log('转写接口地址已保存'));
    clearServiceResult('asr');   // 地址已改，旧检测结果失效
  });
  $('asrLlmModel').addEventListener('change', (e) => {
    chrome.storage.local.set({ asrLlmModel: e.target.value.trim() }, () => log('转写模型=', e.target.value.trim()));
  });
  $('asrLlmApiKey').addEventListener('change', (e) => {
    chrome.storage.local.set({ asrLlmApiKey: e.target.value.trim() }, () => log('转写 API Key 已保存（长度', e.target.value.trim().length, '）'));
  });
  // OCR API 细项：地址/模型/Key 保存
  $('ocrLlmBaseUrl').addEventListener('change', (e) => {
    chrome.storage.local.set({ ocrLlmBaseUrl: e.target.value.trim() }, () => log('OCR 接口地址已保存'));
    clearServiceResult('ocr');   // 地址已改，旧检测结果失效
  });
  $('ocrLlmModel').addEventListener('change', (e) => {
    chrome.storage.local.set({ ocrLlmModel: e.target.value.trim() }, () => log('OCR 模型名=', e.target.value.trim()));
  });
  $('ocrLlmApiKey').addEventListener('change', (e) => {
    chrome.storage.local.set({ ocrLlmApiKey: e.target.value.trim() }, () => log('OCR API Key 已保存（长度', e.target.value.trim().length, '）'));
  });
  // 翻译渠道复选保存：按 DOM 现状整表写入；「浏览器自身」在 Firefox 被禁用且未勾，
  //   写回 false 与实际一致。
  TRANS_CH_IDS.forEach(([id]) => {
    $(id).addEventListener('change', () => {
      const obj = {};
      TRANS_CH_IDS.forEach(([id2, k2]) => { obj[k2] = $(id2).checked; });
      chrome.storage.local.set({ translationChannels: obj }, () => log('翻译渠道=', JSON.stringify(obj)));
    });
  });
  // LLM 翻译渠道提示词：清空回落默认模板
  $('llmTranslatePrompt').addEventListener('change', (e) => {
    const v = e.target.value.trim() || LLM_TRANSLATE_PROMPT;
    e.target.value = v;
    chrome.storage.local.set({ llmTranslatePrompt: v }, () => log('LLM 翻译提示词=', v));
  });

  // 功能栏 ASR/OCR/Parser（拆分自 asr-ocr.js：公共初始化 → ASR → OCR + Parser）
  initAsrCommon();
  initAsr();
  initOcr();
  initParser();
  // Deactivate 停用栏（须在折叠组通用绑定与标签切换绑定之后初始化，
  //   深链 ?deactivate= 需复用两者的既有监听）
  initDeactivate({ m, lang: () => getLangState() });
  window.addEventListener('pagehide', () => {
    disposeAsrCommon(); disposeAsr(); disposeOcr(); disposeParser(); disposeDeactivate();
  });

  // 其他标签页改了设置（如字幕样式）→ 本页监听同步
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // 目标语言变化 → My Words 词表 chips 门控重渲染（wordlists 仅英文，
    //   非英语不显示词表标签；本页语言栏自写亦走此回声，renderChips 幂等无害）
    if (changes.learnLanguage) setMyWordsLearnLang(changes.learnLanguage.newValue);
    if (changes.uiLanguage) {
      setLangState(changes.uiLanguage.newValue);
      chrome.storage.local.get(null, (res) => renderAll(res));
    } else if (changes.subtitleStyle || changes.subtitlePosition) {
      // 整栏重渲染（而非仅切 active 类）：其他标签页写入的若为已删样式 id，
      //   旧逻辑无卡可选中；重渲染走 stale-id 清洗回退。位置样式变化同样整栏重渲染。
      chrome.storage.local.get(null, (res) => renderAll(res));
    } else if (changes.textStyle || changes.annotationStyle || changes.videoAnnotationStyle || changes.annTemplate
       || changes.webAnnTemplate || changes.videoAnnTemplate || changes.videoOverlayAnnTemplate
       || changes.videoOverlayAnnStyle || changes.subtitleCustom || changes.subtitleUserStyles
       || changes.subtitleSample || changes.videoOverlayAnnMode
       // 阈值/表外开关影响预览动态注释，布局键跨页同步预览
       || changes.rankThreshold || changes.rankThresholdMax || changes.annotateOov
       // 注释个性化三键（与字幕流同分支，共享回声抑制）
       || changes.annotationCustom || changes.annotationUserStyles || changes.annotationSample) {
      // 回声抑制：本页刚写入（即时渲染已是最终态），1200ms 内回声跳过
      //   全量 renderAll——否则"先经过一个样式再到最终"地闪一次；他页写入正常同步。
      //   池指派写 storage 同样打戳。
      if (Date.now() - ownWriteAt() < 1200) return;
      // 候选池四键跨标签页同步（池三指派键 + 注释模板 + 第四栏注释样式键 +
      //   字幕个性化/用户样式键 + 三栏独立模板键）：缺了会"别的标签页改了样式本页预览不动"。
      chrome.storage.local.get(null, (res) => renderAll(res));
    } else if (changes.myWords || changes.myWordsPresetSel) {
      // My Words 外部变化（查询窗 🏁/✓ 标记按钮、他页编辑）→ 两栏回填。
      //   自写回声由 my-words.js 内部 _lastWriteAt 窗口抑制（防打断输入），不整页 renderAll。
      syncMyWordsFromStorage();
    } else if (changes.llmProvider || changes.llmBaseUrl || changes.llmModel
               || changes.llmApiKey
               || changes.chatWordPrompt || changes.chatSidebarPrompt
               || changes.asrLlmProvider || changes.asrLlmModel || changes.asrLlmBaseUrl
               || changes.asrLlmApiKey || changes.ocrLlmProvider || changes.ocrLlmBaseUrl || changes.ocrLlmModel
                  || changes.ocrLlmApiKey || changes.translationChannels
                || changes.llmTranslatePrompt || changes.learnLanguage || changes.meaningLanguage
                || changes.queryEnabled || changes.contextLookupEnabled || changes.queryBarEnabled
                || changes.textHintEnabled || changes.webSidebarEnabled || changes.sidebarEnabled
                || changes.overlayEnabled) {
      // 「模型」栏等设置键的跨标签页同步：另一标签页改了模型配置，本页输入框
      //   须回填最新值（语言两键变化会联动 OCR 语言候选重渲）。
      chrome.storage.local.get(null, (res) => renderAll(res));
    }
  });
}

init();
