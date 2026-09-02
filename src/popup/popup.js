// popup 逻辑：界面语言切换、选项联动、登录态检测、Translator API 状态、按钮触发
//
// 反思（2026-07-03）：用户反馈"点击工具栏图标无设定菜单弹出"。
// 排查：manifest.json action.default_popup 配置正常，最可能原因是 init() 抛异常
// 导致 popup 白屏，被误判为"没弹"。加固：init 包 try/catch，异常 + 全局未捕获错误
// 一律显示在 #popupError 红色横幅，便于用户截图反馈根因。
//
// 反思（2026-07-08）：用户再次反馈"工具栏点击图标不能弹出菜单"。
// 加固升级：1) init 各阶段独立 try/catch，单点失败不阻塞整体 UI；
//   2) 各阶段加 console.log 便于 popup 右键"检查"时诊断；
//   3) loadSettings/detectTranslator/checkBilibiliLogin 失败时降级显示，不抛错；
//   4) init 完成后显式移除 #popupLoading 提示，避免误判"没弹"。

import { initLang, getLang, setLang, onLangChange, t, UI_LANGS, TRANSLATE_LANGS, LANG_NAMES } from '../lib/i18n.js';

// 在 popup 顶部显示错误横幅（避免白屏无法诊断）
function showPopupError(err) {
  const el = document.getElementById('popupError');
  if (!el) return;
  const msg = String(err && err.message ? err.message : err);
  el.style.display = 'block';
  el.textContent = '⚠ ' + msg;
  console.error('[VocabRadar][popup]', err);
}

// 隐藏"加载中"提示（init 完成或失败后都调用）
function hideLoading() {
  const el = document.getElementById('popupLoading');
  if (el) el.style.display = 'none';
}

// 反思（2026-08-06）：侧邻提示开关变化时提示用户刷新页面后生效
//   旧版开关变化时直接操作 DOM 导致"文本提示消失"，改为提示刷新
function showReloadHint() {
  let el = document.getElementById('beaverReloadHint');
  if (!el) {
    el = document.createElement('div');
    el.id = 'beaverReloadHint';
    el.style.cssText = 'position:fixed;bottom:8px;left:50%;transform:translateX(-50%);background:#2e6b43;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,.2);';
    document.body.appendChild(el);
  }
  el.textContent = '💡 刷新页面后生效';
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// 反思（2026-07-10 #91）：用户反馈「浏览器工具栏点开不显示VocabRadar，有时候能弹出来有时候不能」。
//   根因：init() 各阶段 await 无超时，特别是 checkBilibiliLogin 的 chrome.cookies.get
//   可能因浏览器内部状态卡住，导致 init 永不完成，hideLoading 不被调用，popup 卡在"加载中"白屏。
//   修正：新增 withTimeout 辅助函数，各阶段加超时保护，超时后降级继续（各阶段已有 try/catch）。
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' 超时(' + ms + 'ms)')), ms))
  ]);
}

// 全局未捕获错误兜底（async 内 throw、Promise reject 等）
window.addEventListener('error', (e) => showPopupError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showPopupError(e.reason));

/**
 * 填充目标语言/释义语言下拉菜单选项
 * 反思（2026-08-02 修正）：初版硬编码10种语言，用户要求"目标和释义语言有几十种"。
 *   改为从 i18n.js TRANSLATE_LANGS + LANG_NAMES 动态生成，避免硬编码与 i18n.js 不同步。
 *   数据源（42种）与 preprocess.py 动态扫描的 small_*.msgpack.gz 文件列表一致。
 */
function populateTranslateLangOptions() {
  const selects = ['learnLanguage', 'meaningLanguage'];
  for (const id of selects) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    // 已填充则跳过（防止重复填充）
    if (sel.options.length > 0) continue;
    for (const lang of TRANSLATE_LANGS) {
      const opt = document.createElement('option');
      opt.value = lang;
      opt.textContent = LANG_NAMES[lang] || lang;
      sel.appendChild(opt);
    }
  }
  console.log(`[VocabRadar][popup] 填充 ${TRANSLATE_LANGS.length} 种目标/释义语言选项`);
}

const DEFAULTS = {
  learnLanguage: 'en',
  meaningLanguage: 'zh',
  // 反思（2026-08-14 第五十四次修正）：用户裁定"调整词频就能凸显，不应更改默认值"。
  //   恢复默认 5000，撤销第五十二次误改的 0。
  rankThreshold: 5000,
  // 反思（2026-07-10 #88）：用户反馈「字幕提示可选的按钮丢了」，指整个侧栏的开关。
  //   加回 sidebarEnabled 控制侧栏显隐，默认 true（侧栏默认显示）。
  sidebarEnabled: true,
  webSidebarEnabled: true,  // 网页悬浮球（2026-08-07）：全站网页侧栏开关
  textHintEnabled: true,
  // 文本提示配色：首次/后续 各自 开关+背景+前景
  // 反思（2026-07-08 MD3 重构）：默认背景色改为 MD3 primary 马卡龙深绿 #2e6b43
  //   （原 #5a8a6a 河狸棕绿），与 sidebar.css --beaver-primary 一致。
  hintFirstEnabled: true,
  // 反思（2026-08-18 第七十三次修正）：用户明确"网页提示默认配色是单词绿底白字，
  //   注释是白底绿字"。旧版 #0d2014 墨绿近黑被用户视为黑色（"你老毛病就是把黑色
  //   当作无色"）。修正：单词=绿底白字（#2e6b43/#ffffff），注释=白底绿字
  //   （#ffffff/#2e6b43），与 MD3 primary #2e6b43 一致。
  hintFirstBg: '#2e6b43',   // 绿底（强，吸睛高亮）
  hintFirstFg: '#ffffff',   // 白字（绿底配白字）
  // 反思（2026-08-05 修正）：用户要求"生词多次出现 复选框 默认空"。
  hintLaterEnabled: false,
  hintLaterBg: '#2e6b43',   // 后续出现复用生词配色
  hintLaterFg: '#ffffff',   // 后续出现复用生词配色
  // 侧邻注释（2026-08-05 修正）：用户要求"侧邻提示 复选框 默认空"。
  //   反思（2026-08-18 第七十三次修正）：注释=白底绿字（用户明确）
  hintSideAnnotation: false,       // 侧邻注释开关，默认空
  hintAnnotationBg: '#ffffff',     // 注释底色（白底）
  hintAnnotationFg: '#2e6b43',     // 注释字色（绿字）
  // 反思（2026-08-14 第五十四次修正）：设置键改名 localTranslateEnabled → annotateOov。
  //   原键名"本地翻译"与实际功能（是否注释表外单词，rank=null 兜底翻译）无关。
  //   默认 false（注释表外词默认不选）。
  annotateOov: false,           // 是否注释表外词（词频词典之外的单词），默认不选
  uiLanguage: 'en'              // 界面语言，默认英文
  // 第一百七十次：asrModelSize 已迁至引导页「模型」分组，popup 不再读写该键
};

// 易坏参数键名（从 config.json 读取覆盖 DEFAULTS）
// 反思（2026-08-03）：用户要求"易坏的参数放到配置文件中"。
//   这些参数容易在代码改动中被误改（如步长被改回500、模型默认值被改），
//   集中到 config.json 统一管理，DEFAULTS 仅作兜底。
const CONFIG_KEYS = ['rankThreshold', 'rankStep', 'annotateOov'];

/**
 * 从 config.json 读取易坏参数，覆盖 DEFAULTS
 * 失败时用 DEFAULTS 兜底，不影响功能
 */
async function applyConfigDefaults() {
  try {
    const url = chrome.runtime.getURL('src/data/config.json');
    const res = await fetch(url);
    const cfg = await res.json();
    for (const k of CONFIG_KEYS) {
      if (cfg[k] !== undefined) {
        DEFAULTS[k] = cfg[k];
      }
    }
    console.log('[VocabRadar][popup] config.json 易坏参数已应用:', CONFIG_KEYS.reduce((o, k) => (o[k] = DEFAULTS[k], o), {}));
  } catch (e) {
    console.warn('[VocabRadar][popup] 读取 config.json 失败，用 DEFAULTS 兜底:', e);
  }
}

// === 设置读写 ===
function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (stored) => {
      resolve({ ...DEFAULTS, ...stored });
    });
  });
}

function saveSetting(key, value) {
  chrome.storage.local.set({ [key]: value });
}

// === 应用 i18n 到 popup ===
// 反思（2026-08-02）：旧版 applyPopupI18n 设置 uiLangBtn 文字（"🌐 中文"/"🌐 EN"），
//   新版改为下拉菜单 uiLangSelect，需要同步当前选中项
function applyPopupI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.innerHTML = t(el.getAttribute('data-i18n'));
  });
  document.documentElement.lang = getLang();
  // 同步界面语言下拉菜单选中项
  const sel = document.getElementById('uiLangSelect');
  if (sel) sel.value = getLang();
}

// === 注释生僻词 ===
// 反思（2026-07-09）：用户反馈「也没有Model ready，现在都用translate.js翻译了」。
//   旧版 popup 有 detectTranslator/tryDownloadModel 在 popup 中检测 Translator API
//   可用性并下载模型，显示"Model ready"状态。现在翻译由 translator.js 多渠道处理
//   （Translator API + 在线渠道），popup 只需保存开关，无需检测/下载模型。
//   已移除 detectTranslator/tryDownloadModel/translatorStatus 元素。

// === B站登录态检测 ===
function checkBilibiliLogin() {
  return new Promise((resolve) => {
    chrome.cookies.get(
      { url: 'https://www.bilibili.com', name: 'bili_jct' },
      (cookie) => resolve(!!cookie)
    );
  });
}

// === 初始化 ===
// 反思（2026-07-08）：各阶段独立 try/catch，单点失败不阻塞整体 UI。
//   某阶段失败时在控制台 warn 并继续，确保 popup 至少能显示设置项。
async function init() {
  console.log('[VocabRadar][popup] init 开始');

  // 阶段0：从 config.json 读取易坏参数，覆盖 DEFAULTS
  // 反思（2026-08-03）：必须在 loadSettings 之前执行，否则 storage 为空时用旧 DEFAULTS
  await applyConfigDefaults();
  // 同步 rankThreshold input 的 step（从 config.json 的 rankStep 读取）
  const rankInput = document.getElementById('rankThreshold');
  if (rankInput && DEFAULTS.rankStep) {
    rankInput.step = String(DEFAULTS.rankStep);
  }

  // 阶段1：界面语言
  try {
    await withTimeout(initLang(), 3000, 'initLang');
    applyPopupI18n();
    onLangChange(() => applyPopupI18n());
    // 反思（2026-08-02）：旧版 uiLangBtn 点击切换 en/zh，新版 uiLangSelect 下拉菜单
    //   change 事件直接 setLang(value)，支持10种语言
    const uiLangSelect = document.getElementById('uiLangSelect');
    if (uiLangSelect) {
      uiLangSelect.value = getLang();
      uiLangSelect.addEventListener('change', (e) => {
        const lang = e.target.value;
        if (UI_LANGS.includes(lang)) {
          setLang(lang);
        }
      });
    }
    // 反思（2026-08-13 第五十次）：引导页入口按钮（(16) 打开引导页）
    const openGuideBtn = document.getElementById('openGuideBtn');
    if (openGuideBtn) {
      openGuideBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('src/guide/guide.html') }).catch(() => {});
        window.close();
      });
    }
    console.log('[VocabRadar][popup] 阶段1 i18n 完成');
  } catch (e) {
    console.warn('[VocabRadar][popup] 阶段1 i18n 失败:', e);
  }

  // 阶段2：加载设置并填充表单
  let settings = {};
  try {
    settings = await withTimeout(loadSettings(), 3000, 'loadSettings');
    // 反思（2026-08-02 修正）：先填充目标/释义语言下拉菜单选项（42种），
    //   再 setVal，否则 select 为空 setVal 不生效
    populateTranslateLangOptions();
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
    setVal('learnLanguage', settings.learnLanguage);
    setVal('meaningLanguage', settings.meaningLanguage);
    setVal('rankThreshold', settings.rankThreshold);
    setChk('textHintEnabled', settings.textHintEnabled);
    setChk('sidebarEnabled', settings.sidebarEnabled);
    setChk('webSidebarEnabled', settings.webSidebarEnabled);
    // 样式设定菜单（2026-08-05 重构）：移除 hintFirstEnabled/hintLaterBg/hintLaterFg 的 UI
    //   生词配色统一用 hintFirstBg/Fg；后续出现复用相同配色（不再独立配置）
    setVal('hintFirstBg', settings.hintFirstBg);
    setVal('hintFirstFg', settings.hintFirstFg);
    setChk('hintLaterEnabled', settings.hintLaterEnabled);
    // 侧邻提示 + 注释配色
    setChk('hintSideAnnotation', settings.hintSideAnnotation);
    setVal('hintAnnotationBg', settings.hintAnnotationBg);
    setVal('hintAnnotationFg', settings.hintAnnotationFg);
    setChk('annotateOov', settings.annotateOov);
    console.log('[VocabRadar][popup] 阶段2 设置加载完成', settings);
  } catch (e) {
    console.warn('[VocabRadar][popup] 阶段2 设置加载失败:', e);
  }

  // 阶段3：选项联动绑定
  try {
    bindOptionChanges();
    console.log('[VocabRadar][popup] 阶段3 选项绑定完成');
  } catch (e) {
    console.warn('[VocabRadar][popup] 阶段3 选项绑定失败:', e);
  }

  // 阶段4：B站登录态检测（失败不影响 UI）
  try {
    await withTimeout(checkBilibiliLogin(), 3000, 'checkBilibiliLogin');
    console.log('[VocabRadar][popup] 阶段4 登录态检测完成');
  } catch (e) {
    console.warn('[VocabRadar][popup] 阶段4 登录态检测失败:', e);
  }

  // 阶段5：自动检测并下载 Translator 模型
  // 反思（2026-08-02）：用户要求"尽量自动下载"。
  //   Translator API 模型下载需要用户手势（浏览器安全限制），
  //   popup 打开本身就是用户交互上下文，可在此自动触发下载。
  //   旧版已移除 detectTranslator/tryDownloadModel，现恢复自动下载逻辑。
  //   非阻塞：下载在后台进行，不影响 popup 交互。
  try {
    autoDownloadTranslator(settings);
    console.log('[VocabRadar][popup] 阶段5 Translator 自动下载检测完成');
  } catch (e) {
    console.warn('[VocabRadar][popup] 阶段5 Translator 自动下载失败:', e);
  }

  hideLoading();
  console.log('[VocabRadar][popup] init 完成');
}

/**
 * 自动检测并下载 Translator 模型
 * popup 打开是用户手势上下文，可触发 Translator.create() 自动下载模型。
 * 下载在后台异步进行，不阻塞 popup。
 */
async function autoDownloadTranslator(settings) {
  const src = settings.learnLanguage || 'en';
  const tgt = settings.meaningLanguage || 'zh';
  if (src === tgt) return;  // 同语言无需翻译

  if (typeof Translator === 'undefined') {
    console.log('[VocabRadar][popup] Translator API 不支持（需 Chrome 138+）');
    return;
  }

  try {
    const avail = await Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
    console.log(`[VocabRadar][popup] Translator 可用性: ${avail} (${src}→${tgt})`);

    if (avail === 'downloadable') {
      // 用户手势上下文，触发下载（不 await，后台进行）
      console.log('[VocabRadar][popup] 开始下载 Translator 模型...');
      const t = await Translator.create({ sourceLanguage: src, targetLanguage: tgt });
      console.log('[VocabRadar][popup] Translator 模型下载完成，已就绪');
      // 销毁实例（content script 会自行 create），仅触发下载
      if (t && typeof t.destroy === 'function') t.destroy();
    } else if (avail === 'downloading') {
      console.log('[VocabRadar][popup] Translator 模型下载中...');
    } else if (avail === 'available') {
      console.log('[VocabRadar][popup] Translator 模型已就绪');
    }
  } catch (e) {
    console.warn('[VocabRadar][popup] Translator 检测/下载失败:', e);
  }
}

// 选项联动绑定（从 init 抽出，便于独立 try/catch）
function bindOptionChanges() {
  document.getElementById('learnLanguage').addEventListener('change', (e) => saveSetting('learnLanguage', e.target.value));
  document.getElementById('meaningLanguage').addEventListener('change', (e) => saveSetting('meaningLanguage', e.target.value));
  document.getElementById('rankThreshold').addEventListener('change', (e) => saveSetting('rankThreshold', Number(e.target.value)));
  document.getElementById('textHintEnabled').addEventListener('change', (e) => saveSetting('textHintEnabled', e.target.checked));
  document.getElementById('sidebarEnabled').addEventListener('change', (e) => saveSetting('sidebarEnabled', e.target.checked));
  document.getElementById('webSidebarEnabled').addEventListener('change', (e) => saveSetting('webSidebarEnabled', e.target.checked));
  // 配色：change 事件保存 + 更新样例区
  // 样式设定菜单（2026-08-05 重构）：移除 hintFirstEnabled/hintLaterBg/hintLaterFg 绑定
  //   生词配色统一用 hintFirstBg/Fg；样例区实时预览
  const updateSample = () => {
    const wordEl = document.getElementById('hintSampleWord');
    const annEl = document.getElementById('hintSampleAnn');
    if (!wordEl || !annEl) return;
    const wordBg = document.getElementById('hintFirstBg').value;
    const wordFg = document.getElementById('hintFirstFg').value;
    const sideAnn = document.getElementById('hintSideAnnotation').checked;
    wordEl.style.background = wordBg;
    wordEl.style.color = wordFg;
    wordEl.style.padding = '0 2px';
    wordEl.style.borderRadius = '3px';
    if (sideAnn) {
      annEl.style.display = '';
      // 反思（2026-08-06）：注释配色自动派生自单词配色（前后景互换）
      // 反思（2026-08-06 修正）：用户反馈"设定栏的值是错的，实际值并没有跟随设定参数"。
      //   根因：updateSample 用互换色渲染样例，但 hintAnnotationBg/Fg input 值未同步更新，
      //   导致 input 显示旧值而样例显示正确互换色。
      //   修正：同步 input 值到互换色，并保存到 storage。
      const annBg = wordFg;  // 注释底色 = 单词字色
      const annFg = wordBg;  // 注释字色 = 单词底色
      const annBgInput = document.getElementById('hintAnnotationBg');
      const annFgInput = document.getElementById('hintAnnotationFg');
      if (annBgInput) { annBgInput.value = annBg; saveSetting('hintAnnotationBg', annBg); }
      if (annFgInput) { annFgInput.value = annFg; saveSetting('hintAnnotationFg', annFg); }
      annEl.style.background = annBg;
      annEl.style.color = annFg;
      annEl.style.padding = '0 2px';
      annEl.style.borderRadius = '3px';
      annEl.style.marginLeft = '1px';
    } else {
      annEl.style.display = 'none';
    }
  };
  document.getElementById('hintFirstBg').addEventListener('change', (e) => { saveSetting('hintFirstBg', e.target.value); updateSample(); });
  document.getElementById('hintFirstFg').addEventListener('change', (e) => { saveSetting('hintFirstFg', e.target.value); updateSample(); });
  document.getElementById('hintLaterEnabled').addEventListener('change', (e) => saveSetting('hintLaterEnabled', e.target.checked));
  // 反思（2026-08-06）：侧邻提示开关变化时提示用户刷新后生效
  //   旧版开关变化时直接操作 DOM（追加/移除 .beaver-side-ann），反复切换导致"文本提示消失"。
  //   修正：开关变化只写入 storage，不操作已有 DOM。新扫描的词才追加注释，需刷新生效。
  document.getElementById('hintSideAnnotation').addEventListener('change', (e) => {
    saveSetting('hintSideAnnotation', e.target.checked);
    updateSample();
    showReloadHint();
  });
  document.getElementById('hintAnnotationBg').addEventListener('change', (e) => { saveSetting('hintAnnotationBg', e.target.value); updateSample(); });
  document.getElementById('hintAnnotationFg').addEventListener('change', (e) => { saveSetting('hintAnnotationFg', e.target.value); updateSample(); });
  // 初始化样例区
  updateSample();
  // 注释表外词：仅保存开关，翻译由 translator.js 多渠道处理
  document.getElementById('annotateOov').addEventListener('change', (e) => {
    saveSetting('annotateOov', e.target.checked);
  });
  // 第一百七十次：ASR 模型大小的绑定已随控件迁至引导页 guide.js
}

// 启动：try/catch 包裹，异常显示在 popup 顶部横幅，避免白屏被误判为"没弹"
// 反思（2026-07-08）：finally 中确保 hideLoading，即使 init 抛错也移除加载提示
// 反思（2026-07-10 #91）：init 整体加 10 秒超时保护，防止各阶段 withTimeout 之外的
//   异常导致 init 永久卡住、hideLoading 不被调用、popup 白屏。
withTimeout(init(), 10000, 'init').catch((e) => showPopupError(e)).finally(() => hideLoading());
