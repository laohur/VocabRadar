// VocabRadar 后台 Service Worker（ES module）
// 职责：
//   1. 安装时初始化默认设置
//   2. 注册右键菜单 🦫VocabRadar（i18n，随界面语言动态切换）
//   3. 接收右键点击，把选中文本转发到当前 tab 的 text-hint content script
//   4. 消息路由
//   5. ASR 状态持久化（chrome.storage.session），防止 SW 重启后丢失 _asrActive
//      反思（2026-08-08）：用户反馈「依旧asr经常停止」。根因：MV3 SW 会被 Chrome
//      随时终止重启，内存中的 _asrActive=false 导致后续 ASR_AUDIO_SEGMENT 被静默丢弃。
//      修正：_asrActive/_asrTabId 持久化到 session storage，SW 启动时恢复。

// 反思（2026-08-02）：import md5.js 作为副作用脚本，挂到 self.md5
//   供 youdaoTranslate 的 sign 计算使用
import '../lib/vendor/md5.js';
// 反思（2026-08-12）：导入 word-db.js 消息处理器，注册 WORD_DB_* 消息分发
// 第一百九十一次：warmupDictProjection 供 SW 唤醒即预热词典投影
import { handleWordDbMessage, clearAll as clearIdbAll, warmupDictProjection } from '../lib/word-db.js';
// 反思（2026-08-16 第六十六次）：词典渠道返回的释义清洗（去除"原形(释义)的屈折说明"夹杂）
import { cleanDictEntry } from '../lib/dict-clean.js';
// 第一百七十一次：LLM 对话（Chat）配置解析——引导页「模型」行写入 storage，此处解析成请求参数
// 第一百七十五次：getFreeProviders 提供免费直连轮替清单，供 402/429 自动回退
import { resolveLlmConfig, getFreeProviders } from '../lib/llm.js';

// 第一百九十一次：SW 每次被唤醒立即后台预热词典投影。
// MV3 SW 闲置 ~30s 休眠即清空 _projCache（SW 内存态），下一页首请求要付
// 「冷启动 + 全表扫描 + 大消息传输」全价（实测 4448ms）。唤醒即预热让扫库与
// 页面加载并行（调研 Dark Reader 等 MV3 开源实践：唤醒即重建内存态）；
// document_start 预取脚本（dict-prefetch.js）把唤醒时刻提前到网页打开瞬间。
// fire-and-forget：失败静默，不影响按需读取路径。
warmupDictProjection();

// 第一百四十次（用户裁定"扩展安装更新的时候应该初始化词典"）：
// onInstalled（install/update）时在后台一次性完成词典构建——页面从此只读 IDB，
// 不再承担首次冷构建。动态 import dictionary.js（避免拉入重依赖拖慢 SW 常驻启动）；
// 失败静默降级：首页异步装载路径仍会构建（分块原子+expected 校验保证最终一致）。
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install' && details.reason !== 'update') return;
  console.log(`[VocabRadar][sw][${_ts()}] [init] 扩展${details.reason === 'install' ? '安装' : '更新'} → 后台初始化词典…`);
  import('../lib/dictionary.js').then(async ({ ensureReady }) => {
    try {
      const m = await ensureReady();
      console.log(`[VocabRadar][sw][${_ts()}] [init] 词典初始化完成: ${m ? m.size : 0} 词`);
    } catch (e) {
      console.warn(`[VocabRadar][sw][${_ts()}] [init] 词典初始化失败（将由页面路径重建）:`, e && e.message);
    }
  }).catch((e) => {
    console.warn(`[VocabRadar][sw][${_ts()}] [init] dictionary 模块加载失败（将由页面路径重建）:`, e && e.message);
  });
});

// 默认设置（与 popup.js DEFAULTS 保持一致）

// 时间戳辅助：所有日志带 HH:MM:SS.mmm 便于诊断时序问题
function _ts() {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// 反思（2026-08-03）：用户要求"网络请求等打印日志遵循调试开关"。
//   _debug 从 config.json 读取，false 时只输出 console.warn（错误），
//   true 时输出 console.log（调试信息：网络请求、渠道、转发日志等）
let _debug = false;
// 调试日志：仅在 _debug=true 时输出
function log(...args) {
  if (_debug) console.log(...args);
}
// 异步读取 config.json 的 debug 字段
(async () => {
  try {
    const url = chrome.runtime.getURL('src/data/config.json');
    const res = await fetch(url);
    const cfg = await res.json();
    _debug = !!cfg.debug;
  } catch (_) { /* ignore */ }
})();
const DEFAULT_SETTINGS = {
  sourceLanguage: 'en',
  targetLanguage: 'zh',
  // 反思（2026-08-14 第五十四次修正）：用户裁定"调整词频就能凸显，不应更改默认值"。
  //   恢复默认 5000（原 5000），此前第五十二次误改为 0 属于错误默认，回滚。
  rankThreshold: 5000,
  subtitleOverlay: true,
  // 反思（2026-08-12）：用户反馈"所有浏览器网页中丢了文本提示"。
  //   旧版 textHintEnabled: false，onInstalled 写入 storage 后 text-hint.js 读取到 false 不启动。
  //   修正：改为 true，与 popup.js / text-hint.js 默认值一致，开箱即用。
  textHintEnabled: true,
  // 文本提示配色：首次/后续 各自 开关+背景+前景
  // 反思（2026-07-08 MD3 重构）：默认背景色改为 MD3 primary 马卡龙深绿 #2e6b43
  //   （原 #5a8a6a 河狸棕绿），符合"文本提示默认颜色跟侧栏色系一致，包括背景色"。
  hintFirstEnabled: true,
  hintFirstBg: '#2e6b43',
  hintFirstFg: '#ffffff',
  hintLaterEnabled: true,
  hintLaterBg: '#2e6b43',
  hintLaterFg: '#ffffff',
  // 反思（2026-08-14 第五十四次修正）：设置键改名 localTranslateEnabled → annotateOov。
  //   原键名"本地翻译开关"与实际功能（是否注释表外单词，rank=null 兜底翻译）无关，
  //   用户指出命名错误。默认 false（注释表外词默认不选）。
  annotateOov: false,          // 是否注释表外词（词频词典之外的单词），默认不选
  uiLanguage: 'en',             // 界面语言，默认英文
  asrModelSize: 'tiny'          // ASR 模型大小（从 config.json 读取覆盖）
};

// 易坏参数键名（从 config.json 读取覆盖 DEFAULT_SETTINGS）
// 反思（2026-08-03）：与 popup.js CONFIG_KEYS 保持一致，集中管理易坏参数
const CONFIG_KEYS = ['rankThreshold', 'rankStep', 'asrModelSize', 'annotateOov'];

// 旧默认首次背景色（灰蓝/河狸棕绿），onInstalled 时迁移为新 MD3 马卡龙深绿
const LEGACY_DEFAULT_FIRST_BGS = ['#5a7a99', '#5a8a6a'];

/**
 * 从 config.json 读取易坏参数，覆盖 DEFAULT_SETTINGS
 * 失败时用 DEFAULT_SETTINGS 兜底，不影响功能
 */
async function applyConfigDefaults() {
  try {
    const url = chrome.runtime.getURL('src/data/config.json');
    const res = await fetch(url);
    const cfg = await res.json();
    for (const k of CONFIG_KEYS) {
      if (cfg[k] !== undefined) {
        DEFAULT_SETTINGS[k] = cfg[k];
      }
    }
    log('[VocabRadar][sw][' + _ts() + '] config.json 易坏参数已应用:', CONFIG_KEYS.reduce((o, k) => (o[k] = DEFAULT_SETTINGS[k], o), {}));
  } catch (e) {
    console.warn('[VocabRadar][sw][' + _ts() + '] 读取 config.json 失败，用 DEFAULT_SETTINGS 兜底:', e);
  }
}

// 安装时写入默认设置 + 创建右键菜单
// 反思（2026-08-03）：改为 async，先读取 config.json 覆盖易坏参数
chrome.runtime.onInstalled.addListener(async (details) => {
  await applyConfigDefaults();
  chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    // 迁移：已保存的首次背景色若为旧默认（灰蓝/河狸棕绿），自动改为新 MD3 马卡龙深绿。
    // 不覆盖用户自定义的其他颜色（如手动改的红/黄），只迁移旧默认值。
    if (merged.hintFirstBg && LEGACY_DEFAULT_FIRST_BGS.includes(merged.hintFirstBg.toLowerCase())) {
      merged.hintFirstBg = '#2e6b43';
    }
    if (merged.hintLaterBg && LEGACY_DEFAULT_FIRST_BGS.includes(merged.hintLaterBg.toLowerCase())) {
      merged.hintLaterBg = '#2e6b43';
    }
    // 反思（2026-08-18 第七十三次修正）：注释配色旧默认值迁移——用户明确默认
    //   "注释是白底绿字"（#ffffff/#2e6b43）。旧默认（墨绿近黑 #0d2014 底/青 #a8e6cf 字）
    //   被用户视为黑色。旧值若仍存于 storage 会覆盖新默认，需迁移。
    const LEGACY_ANN_BGS = ['#e0e0e0', '#fff3b0', '#2e6b43', '#0d2014'];
    const LEGACY_ANN_FGS = ['#616161', '#5d4037', '#ffffff', '#a8e6cf'];
    if (merged.hintAnnotationBg && LEGACY_ANN_BGS.includes(merged.hintAnnotationBg.toLowerCase())) {
      merged.hintAnnotationBg = '#ffffff';
    }
    if (merged.hintAnnotationFg && LEGACY_ANN_FGS.includes(merged.hintAnnotationFg.toLowerCase())) {
      merged.hintAnnotationFg = '#2e6b43';
    }
    // 反思（2026-08-18 第七十三次修正）：生词默认配色迁移——用户明确"单词绿底白字"。
    //   旧默认 #0d2014/#a8e6cf（近黑/青）也需迁移为 #2e6b43/#ffffff。
    const LEGACY_FIRST_BGS = ['#0d2014', '#5a8a6a', '#3f51b5', '#1b2838'];
    const LEGACY_FIRST_FGS = ['#a8e6cf', '#ffffff'];
    if (merged.hintFirstBg && LEGACY_FIRST_BGS.includes(merged.hintFirstBg.toLowerCase())) {
      merged.hintFirstBg = '#2e6b43';
    }
    if (merged.hintFirstFg && LEGACY_FIRST_FGS.includes(merged.hintFirstFg.toLowerCase())) {
      merged.hintFirstFg = '#ffffff';
    }
    chrome.storage.local.set(merged);
    // 反思（2026-08-14 第五十四次）：删除改名前的旧键 localTranslateEnabled，
    //   避免陈旧值残留在 storage 中造成混淆。
    chrome.storage.local.remove(['localTranslateEnabled']);
  });
  // 反思（2026-08-14 第五十五次修正）：删除 word-cache.js（fnv1aHash 100 分桶旧缓存）。
  //   第五十二次已迁移统一词典（word-db.js IDB 单库），translator.js 不再读写 wc_* 桶，
  //   旧版版本变更清空 wc_* 桶的逻辑与文件一同删除；翻译缓存改由 onInstalled 清 IDB。
  const curVersion = chrome.runtime.getManifest().version;
  chrome.storage.local.get(['_lastDictClearVersion'], (res) => {
    if (res._lastDictClearVersion !== curVersion) {
      clearIdbAll().catch(() => {});
      chrome.storage.local.set({ _lastDictClearVersion: curVersion });
      log('[VocabRadar][sw][' + _ts() + '] 版本变更(' + curVersion + ')，清空 IDB 词典缓存');
    } else {
      log('[VocabRadar][sw][' + _ts() + '] 版本未变更(' + curVersion + ')，保留词典缓存');
    }
  });
  createContextMenus();
  // 反思（2026-08-13 第五十次）：新安装时自动打开引导页（(16) 新装弹引导页）。
  //   仅 reason==='install' 触发，扩展更新(reason='update')不打扰用户。
  if (details && details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/guide/guide.html') }).catch(() => {});
  }
  log('[VocabRadar][sw][' + _ts() + '] onInstalled');
});

// 工具栏图标点击 → 打开引导页（不是弹窗）
// 反思（2026-08-13 第五十一次）：用户要求"工具栏图标点击不是弹窗而是跳到引导页"。
//   manifest action 已移除 default_popup；此处监听 onClicked 打开引导页。
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/guide/guide.html') }).catch(() => {});
  log('[VocabRadar][sw][' + _ts() + '] 点击工具栏图标，打开引导页');
});

// 重新启动时也确保菜单存在（service worker 唤醒后菜单可能丢失）
chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
  log('[VocabRadar][sw][' + _ts() + '] onStartup');
});

// 反思（2026-07-06）：用户反馈"右键菜单消失了"。
// MV3 SW 会被 Chrome 随时终止，唤醒时机不限于 onInstalled/onStartup。
// 虽然右键菜单由浏览器持久化，但扩展更新时 onInstalled 中 removeAll 的回调
// 可能因 SW 被终止而未执行 create，导致菜单被删未建。
// 修正：模块顶层调用 createContextMenus()，每次 SW 唤醒（无论由何种事件触发）
// 都确保菜单存在。removeAll+create 是幂等操作，反复调用安全。
createContextMenus();

// 反思（2026-08-08）：用户反馈「菜单依旧中英文夹杂」。
//   界面语言切换时重建右键菜单，使标题语言同步更新。
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.uiLanguage) {
      createContextMenus();
    }
  });
}

// 反思（2026-07-06）：用户反馈"为啥每次开启 ASR 都要下载模型？"。
// 根因：offscreen document 仅在 START_ASR 时创建，SW 被回收后 offscreen 也可能被回收，
// 导致模型实例丢失。修正：扩展启动时预创建 offscreen document，整个会话期间复用，
// 模型只需加载一次。ensureOffscreen 是幂等操作，反复调用安全。
ensureOffscreen().catch(() => { /* 首次创建可能失败，不影响主流程 */ });

/**
 * 创建右键菜单（i18n，随界面语言动态切换）
 * 反思（2026-08-05 修正）：用户要求"ocr改为之前，点击识别当前帧"。
 *   移除 image/video 上下文 OCR 菜单项（很多视频无法右键识别），
 *   OCR 回归侧栏按钮点击截帧方式。保留 selection 上下文的查词菜单。
 * 反思（2026-08-08）：用户反馈「菜单依旧中英文夹杂」。
 *   根因：右键菜单标题硬编码中文 '🦫VocabRadar：查 "%s"'，
 *   界面语言为英文时仍是中文，造成中英文夹杂。
 *   修正：从 chrome.storage.local 读取 uiLanguage，动态选择标题语言。
 *   同时监听 storage 变化，语言切换时重建菜单。
 */
function createContextMenus() {
  // 先尝试从 storage 读取界面语言，异步创建菜单
  // 第一百零九次（用户裁定）：菜单语义从"查词/Look up"改为"翻译/Translate"——
  // 选中文本面板支持整句翻译，不只是单词查询。
  chrome.storage.local.get({ uiLanguage: 'en' }, (res) => {
    const lang = res.uiLanguage || 'en';
    // 第一百七十七次：去掉 🦫（Win10 旧版 Segoe UI Emoji 无字形，菜单里显示为豆腐块）
    const title = (lang === 'zh')
      ? 'VocabRadar：翻译 "%s"'
      : 'VocabRadar: Translate "%s"';
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'beaver-lookup',
        title: title,
        contexts: ['selection']
      });
      log('[VocabRadar][sw][' + _ts() + '] 右键菜单已注册（翻译, lang=' + lang + '）');
    });
  });
}

// === 第一百零九次 P3：MAIN world 函数注册表 ===
// 这些函数会被序列化后在页面主世界执行（world:'MAIN'），只能访问页面 window/document。
// 注意：不得引用 SW 作用域内的任何变量/导入。
function mwReadPlayinfo() {
  try {
    var p = window.__playinfo__;
    return p ? JSON.parse(JSON.stringify(p)) : null;
  } catch (e) { return null; }
}

function mwReadBiliTitle() {
  try {
    var st = window.__INITIAL_STATE__;
    var t = st ? ((st.videoData && st.videoData.title) ||
      (st.epInfo && (st.epInfo.showTitle || st.epInfo.long_title || st.epInfo.title)) ||
      (st.h1Title && st.h1Title.title) || '') : '';
    return String(t || '');
  } catch (e) { return ''; }
}

const MAIN_WORLD_FUNCS = { readPlayinfo: mwReadPlayinfo, readBiliTitle: mwReadBiliTitle };

/**
 * 右键菜单点击分发
 * - beaver-lookup：选中文本转发到 text-hint 显示查词面板
 *
 * 反思（2026-08-05 修正）：移除图片/视频 OCR 右键菜单项，
 *   OCR 回归侧栏按钮点击截帧方式（很多视频无法右键识别）。
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'beaver-lookup') {
    const text = info.selectionText || '';
    if (!text.trim()) return;
    log('[VocabRadar][sw][' + _ts() + '] 右键翻译: "' + text.slice(0, 30) + '" tab=' + tab.id);
    chrome.tabs.sendMessage(tab.id, { type: 'SHOW_CONTEXT_PANEL', text }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn('[VocabRadar][sw][' + _ts() + '] 转发失败:', chrome.runtime.lastError.message);
      }
    });
  }
});

// 消息路由（保留扩展点）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') {
    sendResponse({ ok: false, error: 'invalid msg' });
    return true;
  }
  // 第一百八十次：删除 ASR_FALLBACK_IFRAME 分支——该广播原用于请求页面/引导页创建
  //   Firefox 回退 iframe，现宿主已改建在后台页自身 document 内（ensureFallbackIframe），
  //   不再有此消息类型。
  // ASR_STATUS / ASR_SEGMENT / ASR_ERROR 是 offscreen 发给 SW 的，
  // SW 中转给 content script（offscreen 的 runtime.sendMessage 广播 content script 收不到，
  // 必须由 SW 用 chrome.tabs.sendMessage 精准转发）
  if (msg.type === 'ASR_STATUS' || msg.type === 'ASR_SEGMENT' || msg.type === 'ASR_ERROR') {
    if (msg.type === 'ASR_STATUS') {
      log('[VocabRadar][sw][' + _ts() + '] 转发 ASR_STATUS:', msg.stage, msg.info || msg.status || '');
    } else if (msg.type === 'ASR_SEGMENT') {
      // 反思（2026-07-09 #77）：用户反馈「字幕你全打印了，毫无意义」。
      //   旧版 console.log('转发 ASR_SEGMENT:', msg.text) 全量打印每段识别文本，
      //   ASR 持续识别时 service worker 控制台被字幕全文刷屏。
      //   修正：只打印前 40 字符 + 总长度，足以确认识别在运转又不污染控制台。
      log('[VocabRadar][sw][' + _ts() + '] 转发 ASR_SEGMENT:', (msg.text || '').slice(0, 40), 'len=', (msg.text || '').length);
    } else {
      log('[VocabRadar][sw][' + _ts() + '] 转发 ASR_ERROR:', msg.error);
    }
    // 转发给发起 ASR 的 tab
    if (_asrTabId) {
      chrome.tabs.sendMessage(_asrTabId, msg).catch(() => { /* tab 可能已关闭 */ });
    }
    return false;
  }
  switch (msg.type) {
    case 'START_ASR':
      handleStartASR(sender.tab?.id, msg.videoKey)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'ASR_AUDIO_SEGMENT':
      // content script 采集的音频段，转发给 offscreen 做 whisper 识别
      // 不等待结果（offscreen 识别完成后会主动发 ASR_SEGMENT 回来）
      // 反思（2026-07-04 重构）：新增 returnTimestamps 字段转发，
      // B站预识别路径请求 chunk 级时间戳用于精确字幕定位。
      // 反思（2026-08-08）：SW 重启后 _asrActive 可能未及时恢复（session.get 是异步的）。
      //   若 _asrActive 为 false 但 offscreen 存在，仍尝试转发，避免丢段。
      // 反思（2026-08-08 第二次）：用户持续反馈"asr经常停止"。
      //   根因：SW 重启后 offscreen document 可能也被 Chrome 回收，
      //   chrome.runtime.sendMessage({ type: 'OFFSCREEN_RECOGNIZE' }) 失败被 .catch 吞掉，
      //   段被静默丢弃，content script 的 sendSegmentAndWait 超时后跳过当前段。
      //   修正：转发前先 ensureOffscreen()，确保 offscreen 存在。
      //   ensureOffscreen 内部先 hasDocument 检查（快），不存在才 createDocument。
      (async () => {
        // 第二百一十五次（用户："asr模型可选本地whisper，也能选llm"；"离线整段，在线分片"）：
        //   ASR 引擎可选——'llm' 走 LLM 音频转写（在线分片：每段 Float32 PCM(16kHz)
        //   现转 WAV 一次请求）；'local'（默认）走既有 offscreen whisper。
        //   模型名用户自管（asrLlmModel，默认 whisper-1），有错就报（回包带 error 字段）。
        let asrEngineSel = 'local';
        let asrLlmModel = 'whisper-1';
        try {
          const er = await new Promise((r) => chrome.storage.local.get({ asrEngine: 'local', asrLlmModel: 'whisper-1' }, r));
          asrEngineSel = er.asrEngine || 'local';
          asrLlmModel = er.asrLlmModel || 'whisper-1';
        } catch (_) { /* 默认本地 */ }
        if (asrEngineSel === 'llm') {
          handleSegmentByLlm(msg, sender).catch((e) => {
            console.warn('[VocabRadar][sw][' + _ts() + '] ASR(LLM) 段失败:', e);
          });
          sendResponse({ ok: true });
          return;
        }
        if (_asrActive || _asrTabId) {
          await ensureOffscreen().catch(() => { /* ignore */ });
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_RECOGNIZE',
            videoKey: msg.videoKey,
            start: msg.start,
            end: msg.end,
            audio: msg.audio,
            // 第一百零四次（关键修复）：必须转发 audioB64——本中继是显式字段白名单，
            // 第九十八次双通道修复只改了发送端与接收端，遗漏中间人，导致
            // ArrayBuffer 在部分环境序列化丢失后 base64 兜底也被丢弃（ch=none samples=0）。
            audioB64: msg.audioB64,
            returnTimestamps: msg.returnTimestamps || false
          }).catch(() => { /* offscreen 可能已关闭 */ });
        } else {
          // 兜底：尝试从 session 恢复状态后再转发
          const res = await new Promise((r) => chrome.storage.session.get(['_asrActive', '_asrTabId'], r));
          if (res && res._asrActive) {
            _asrActive = true;
            _asrTabId = res._asrTabId || null;
            await ensureOffscreen().catch(() => { /* ignore */ });
            chrome.runtime.sendMessage({
              type: 'OFFSCREEN_RECOGNIZE',
              videoKey: msg.videoKey,
              start: msg.start,
              end: msg.end,
              audio: msg.audio,
              audioB64: msg.audioB64, // 第一百零四次：同上，兜底路径同样转发
              returnTimestamps: msg.returnTimestamps || false
            }).catch(() => { /* offscreen 可能已关闭 */ });
          }
        }
      })();
      sendResponse({ ok: true });
      return true;
    case 'STOP_ASR':
      handleStopASR()
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'ASR_CHECK':
      sendResponse({ ok: true, supported: true });
      return true;
    case 'TRANSLATE_WORD':
      handleTranslateWord(msg.word, msg.source, msg.target, msg.channels)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'FETCH_SUBTITLE':
      handleFetchSubtitle(msg.url)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'FETCH_AUDIO':
      // B站预识别路径：代理下载音频文件（SW 不受 CORS 限制）；第九十六次支持 urls[] 多候选回退
      handleFetchAudio(msg.url, msg.urls)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'FETCH_AUDIO_META':
      // 第九十五次（流式 ASR）：探测音频文件总字节数（HEAD，缺失时 Range bytes=0-0 读 content-range）
      handleFetchAudioMeta(msg.url, msg.urls)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'FETCH_AUDIO_RANGE':
      // 第九十五次（流式 ASR）：按字节区间下载（借鉴 videoseek ChunkedDownloader 的分块 Range 方式）
      handleFetchAudioRange(msg.url, msg.start, msg.end, msg.urls)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    // === 第一百零九次 P3：chrome.scripting MAIN world 执行/注入 ===
    // 背景：内联 <script> 注入受页面 CSP 限制（B站若下发严格 CSP 则主世界读取静默失败，
    // 即调研文档 H1）。chrome.scripting 的 world:'MAIN' 不受页面 CSP 管，且能直接拿返回值。
    // 内容脚本经消息调用；Firefox 旧版无 world 选项时由调用方 catch 后走旧注入路径兜底。
    case 'MAIN_WORLD_EXEC': {
      const tabId = sender.tab?.id;
      const fn = MAIN_WORLD_FUNCS[msg.name];
      if (!tabId || !fn) {
        sendResponse({ ok: false, error: 'bad args' });
        return true;
      }
      chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: fn, args: msg.args || [] })
        .then((results) => sendResponse({ ok: true, result: results && results[0] ? results[0].result : null }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }
    case 'MAIN_WORLD_INJECT_FILE': {
      const tabId2 = sender.tab?.id;
      if (!tabId2 || !msg.file || !/^src\/lib\//.test(msg.file)) {
        sendResponse({ ok: false, error: 'bad args' });
        return true;
      }
      chrome.scripting.executeScript({ target: { tabId: tabId2 }, world: 'MAIN', files: [msg.file] })
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }
    case 'OCR_RECOGNIZE':
      // content script 发来的 OCR 请求，转发给 offscreen 运行 Tesseract.js
      // 反思（2026-07-28）：content script 受页面 CSP 限制无法加载 CDN 脚本，
      //   OCR 需在 offscreen document 运行（扩展自身 CSP 已配置 cdn.jsdelivr.net）。
      // 反思（2026-08-16 第六十六次）：透传 lang（OCR 语言随 sourceLanguage）。
      handleOcrRecognize(msg.imageDataUrl, msg.lang)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'ASR_LLM_FILE':
      // 第二百一十五次：离线整段 LLM 转写（引导页上传原始文件一次请求，不本地解码分片）
      handleAsrLlmFile(msg, sender)
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    case 'FETCH_URL':
      // 反思（2026-08-09）：content script 受页面 CSP 限制无法 fetch CDN，
      //   diverse-lemmas 词典数据下载需经 SW 代理（SW 有 host_permissions <all_urls>）。
      handleFetchUrl(msg.url)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    // 第一百七十一次：Chat 面板的模型请求。content script 受宿主页面 CSP 限制无法直接
    //   fetch 第三方 API（与 FETCH_URL / OCR_RECOGNIZE 同因），统一由 SW 代理。
    case 'LLM_CHAT':
      handleLlmChat(msg.messages)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    // 第二百一十六次：翻译渠道的 LLM 文本翻译——**直接用聊天的 LLM 配置**（文本形态）
    case 'LLM_TRANSLATE':
      handleLlmTranslate(msg.text, msg.target)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    // 第一百七十一次：Chat 面板"打开设置配置模型"按钮 —— content script 无法开扩展页
    case 'OPEN_GUIDE':
      chrome.tabs.create({ url: chrome.runtime.getURL('src/guide/guide.html') }).catch(() => {});
      sendResponse({ ok: true });
      return true;
    // 反思（2026-08-12）：统一词典 WORD_DB_* 消息分发
    //   content script 通过 sendMessage 请求 SW 操作 IndexedDB（CS 的 IDB 按站点隔离）
    // 反思（2026-08-13 第五十二次）：词典缓存 DICT_CACHE_GET/SET 也走本分发，
    //   旧版只匹配 WORD_DB_ 前缀，DICT_CACHE_* 落入 sendResponse({ok:true})（无 cache 字段），
    //   导致每次刷新都"无词典缓存, 首次构建并写入缓存"。补上 DICT_CACHE_ 前缀。
    default:
      // 先尝试 WORD_DB_* / DICT_CACHE_* / LEMMAS_* / LEMMATIZE_* 消息
      // 反思（2026-08-16 第六十七次）：补上 LEMMATIZE_ 前缀——逐词词形还原消息，
      //   旧版只匹配前三个前缀，LEMMATIZE_WORD 会落入 sendResponse({ok:true})（无 lemma 字段）
      //   → 页面逐词词形还原永远返回原词。必须转发给 handleWordDbMessage。
      if (msg.type && (msg.type.startsWith('WORD_DB_') || msg.type.startsWith('DICT_CACHE_') || msg.type.startsWith('LEMMAS_') || msg.type.startsWith('LEMMATIZE_'))) {
        // 反思（2026-08-13 第四十七次）：handleWordDbMessage 是 async 函数，返回 Promise（truthy），
        //   旧版 `if (handled) return true` 恒成立，fallback sendResponse 永不执行。
        //   当 isSW=false 时 handleWordDbMessage 返回 false 且不调 sendResponse → 通道挂起。
        //   修正：直接调用并 return true 保持通道开放，.then 中检查 handled，
        //   false 时补发 sendResponse 错误响应。
        handleWordDbMessage(msg, sender, sendResponse).then((handled) => {
          if (!handled) {
            sendResponse({ ok: false, error: 'WORD_DB handler not available (not in background context)' });
          }
        });
        return true;
      }
      sendResponse({ ok: true });
      return true;
  }
});

// === OCR：转发到 offscreen 运行 Tesseract.js ===
// 反思（2026-07-28）：content script 受页面 CSP 限制无法直接加载 Tesseract.js，
//   需通过 offscreen document 运行。SW 负责确保 offscreen 存在并转发消息。
// 反思（2026-08-16 第六十六次）：OCR 语言随 sourceLanguage——透传 lang 给 offscreen。
async function handleOcrRecognize(imageDataUrl, lang) {
  // 第二百一十四次（用户："OCR可选 Tesseract LLM"）：引擎由 storage.ocrEngine 选择——
  //   'tesseract'（默认，offscreen 本地识别）| 'llm'（当前对话大模型的视觉识别）。
  let engine = 'tesseract';
  let tessLangs = 'eng';
  try {
    const er = await new Promise((resolve) => {
      try { chrome.storage.local.get({ ocrEngine: 'tesseract', ocrLanguages: { eng: true } }, resolve); } catch (_) { resolve({}); }
    });
    engine = er.ocrEngine || 'tesseract';
    const ol = er.ocrLanguages || {};
    const ls = Object.keys(ol).filter((k) => ol[k] === true);
    if (ls.length > 0) tessLangs = ls.join('+');
  } catch (_) { /* 默认 Tesseract + eng */ }
  if (engine === 'llm') {
    return handleOcrByLlm(imageDataUrl, lang);
  }
  lang = tessLangs;   // 第二百一十九次：Tesseract 语言=引导页复选（eng/chi_sim/jpn 的并集）
  if (typeof chrome.offscreen === 'undefined') {
    return { ok: false, error: 'offscreen API 不可用' };
  }
  const ready = await ensureOffscreen();
  if (!ready) return { ok: false, error: 'offscreen 创建失败' };
  const resp = await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_OCR',
    imageDataUrl: imageDataUrl,
    lang: lang
  }).catch((e) => ({ ok: false, error: String(e.message || e) }));
  return resp;
}

// === 第二百一十四次：OCR 的 LLM 引擎（视觉识别）===
// 与 handleLlmChat 同一套 llm* 配置与三类格式分流；图片走 dataURL，
//   openai/free 形态用 image_url，anthropic 形态用 base64 source 块。
// 提示词要求逐字提取可见文本（保持原语言与换行），与 Tesseract 的产出同构，
//   供侧栏注释/生词流程直接消费。
const OCR_LLM_PROMPT = 'Extract ALL visible text from this image verbatim. '
  + 'Keep the original language, line breaks and reading order. '
  + 'Output ONLY the extracted text, with no commentary.';

// === 第二百一十五次：ASR 的 LLM 引擎（音频转写）===
// 端点形态（用户裁定采用主流候选）：OpenAI 兼容 multipart POST {baseUrl}/audio/transcriptions，
//   字段 file/model/language/response_format=json → { text }。
// 音频形态：在线分片＝每段 Float32 PCM(16kHz) 现转 WAV 一次请求；离线整段＝原始上传文件
//   一次请求（ASR_LLM_FILE）。模型名用户自管（asrLlmModel，默认 whisper-1），有错就报。
function b64ToUint8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function pcmF32ToWavBlob(f32, sampleRate) {
  const n = f32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const wstr = (off, str) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
  wstr(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); wstr(8, 'WAVE'); wstr(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); wstr(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 2) {
    const sv = Math.max(-1, Math.min(1, f32[i]));
    v.setInt16(o, sv < 0 ? sv * 0x8000 : sv * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function llmTranscribeBlob(blob, cfg, lang, fileName) {
  // 第二百一十六次：cfg 由调用方传入（ASR-LLM 独立配置 resolveEngineCfg('asr') 产物）
  if (cfg.format === 'anthropic') throw new Error('Anthropic 无音频转写端点，请改用 OpenAI 兼容来源');
  if (!cfg.baseUrl) throw new Error('Base URL 未配置');
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
  const fd = new FormData();
  fd.append('file', blob, fileName || 'segment.wav');
  fd.append('model', cfg.model);
  if (lang) fd.append('language', String(lang).split('-')[0]);
  fd.append('response_format', 'json');
  const headers = {};
  if (cfg.format !== 'free' && cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
  const resp = await fetch(url, { method: 'POST', headers, credentials: 'omit', cache: 'no-store', body: fd });
  const raw = await resp.text();
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + raw.slice(0, 300));
  try {
    const j = JSON.parse(raw);
    return String((j && j.text) || '');
  } catch (e) {
    throw new Error('响应不是 JSON：' + raw.slice(0, 200));
  }
}

async function handleSegmentByLlm(msg, sender) {
  let f32 = msg.audio;
  if (!(f32 instanceof ArrayBuffer) && msg.audioB64) f32 = b64ToUint8(msg.audioB64).buffer;
  if (!f32) throw new Error('段音频缺失');
  const pcm = new Float32Array(f32);
  const wav = pcmF32ToWavBlob(pcm, 16000);
  let lang = null;
  try { lang = (await new Promise((r) => chrome.storage.local.get({ sourceLanguage: 'en' }, r))).sourceLanguage; } catch (_) { }
  const cfg = await resolveEngineCfg('asr');   // 恢复 216 形态：ASR-LLM 独立配置
  const text = await llmTranscribeBlob(wav, cfg, lang, 'segment.wav');
  // 回包与 offscreen 的 ASR_SEGMENT 同形（无 chunks——接收端按整段文本处理，已兼容）
  if (sender && sender.tab && sender.tab.id) {
    chrome.tabs.sendMessage(sender.tab.id, {
      type: 'ASR_SEGMENT', videoKey: msg.videoKey, start: msg.start, end: msg.end,
      text: text, samples: pcm.length, engine: 'llm'
    }).catch(() => { /* 接收页可能已关闭 */ });
  }
}

// 第二百一十六次（用户："可以下拉，可以单独配置，跟聊天的LLM不同"）：
//   ASR-LLM 与 OCR-LLM 各自独立的 LLM 配置（asrLlm* / ocrLlm* 键），
//   provider 缺省 openai（转写/视觉的主流候选），与聊天 llm* 配置互不影响。
async function resolveEngineCfg(engine) {
  const keys = (engine === 'asr')
    ? { p: 'asrLlmProvider', b: 'asrLlmBaseUrl', m: 'asrLlmModel', k: 'asrLlmApiKey' }
    : { p: 'ocrLlmProvider', b: 'ocrLlmBaseUrl', m: 'ocrLlmModel', k: 'ocrLlmApiKey' };
  const res = await new Promise((resolve) => {
    chrome.storage.local.get(
      { [keys.p]: 'openai', [keys.b]: '', [keys.m]: '', [keys.k]: '' },
      (r) => resolve(r || {})
    );
  });
  return resolveLlmConfig({
    llmProvider: res[keys.p], llmBaseUrl: res[keys.b],
    llmModel: res[keys.m], llmApiKey: res[keys.k]
  });
}

async function handleAsrLlmFile(msg, sender) {
  try {
    const u8 = b64ToUint8(msg.audioB64 || '');
    const ext = (String(msg.fileName || '').split('.').pop() || 'wav').toLowerCase();
    const mimeMap = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg', flac: 'audio/flac' };
    const blob = new Blob([u8], { type: mimeMap[ext] || 'audio/wav' });
    let lang = null;
    try { lang = (await new Promise((r) => chrome.storage.local.get({ sourceLanguage: 'en' }, r))).sourceLanguage; } catch (_) { }
    const cfg = await resolveEngineCfg('asr');   // 第二百二十次：LLM 只此聊天一处设定
    const text = await llmTranscribeBlob(blob, cfg, lang, String(msg.fileName || 'audio.wav'));
    sendResponse({ ok: true, text: text });
  } catch (e) {
    // 有错就报（不遮蔽）：调用方 toast 展示原文
    sendResponse({ ok: false, error: String(e.message || e) });
  }
}

async function handleOcrByLlm(imageDataUrl, lang) {
  const cfg = await resolveEngineCfg('ocr');   // 恢复 216 形态：OCR-LLM 独立配置
  const out = await llmVisionOnce(cfg, OCR_LLM_PROMPT, imageDataUrl);
  if (!out.ok) {
    log('[VocabRadar][sw][' + _ts() + '] OCR(LLM) 失败: ' + out.error);
    return { ok: false, error: 'OCR(LLM): ' + out.error };
  }
  return { ok: true, text: out.content };
}

/**
 * 单来源 LLM 视觉识别（镜像 llmChatOnce 的 URL/头/解析，消息体为多模态 content 数组）
 * @returns {Promise<{ok:boolean, content?:string, error?:string}>}
 */
async function llmVisionOnce(cfg, prompt, imageDataUrl) {
  const isFree = cfg.format === 'free';
  const isAnthropic = cfg.format === 'anthropic';
  if (!isFree && !cfg.apiKey) return { ok: false, error: 'API Key 未配置' };
  if (!cfg.baseUrl) return { ok: false, error: 'Base URL 未配置' };
  if (!cfg.model) return { ok: false, error: '模型名未配置' };

  // 解析 dataURL：data:image/png;base64,xxxx
  const m = /^data:([^;]+);base64,(.*)$/s.exec(imageDataUrl || '');
  if (!m) return { ok: false, error: 'imageDataUrl 不是 base64 dataURL' };
  const mime = m[1];
  const b64 = m[2];

  const url = cfg.baseUrl + (isAnthropic ? '/v1/messages' : '/chat/completions');
  const headers = { 'Content-Type': 'application/json' };
  if (isAnthropic) {
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (!isFree) {
    headers['Authorization'] = 'Bearer ' + cfg.apiKey;
  }
  let body;
  if (isAnthropic) {
    body = JSON.stringify({
      model: cfg.model,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } }
        ]
      }],
      stream: false
    });
  } else {
    body = JSON.stringify({
      model: cfg.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      }],
      stream: false
    });
  }
  log('[VocabRadar][sw][' + _ts() + '] ocrLLM provider=' + cfg.provider + ' format=' + cfg.format + ' model=' + cfg.model);
  try {
    const resp = await fetch(url, { method: 'POST', headers, credentials: 'omit', cache: 'no-store', body });
    const raw = await resp.text();
    if (!resp.ok) {
      console.warn('[VocabRadar][sw][' + _ts() + '] ocrLLM HTTP ' + resp.status + ': ' + raw.slice(0, 300));
      return { ok: false, error: 'HTTP ' + resp.status + ' ' + raw.slice(0, 300) };
    }
    let data = null;
    try { data = JSON.parse(raw); } catch (e) {
      return { ok: false, error: '响应不是 JSON：' + raw.slice(0, 200) };
    }
    let content = '';
    if (isAnthropic) {
      content = Array.isArray(data && data.content)
        ? data.content.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('')
        : '';
    } else {
      content = data && data.choices && data.choices[0] && data.choices[0].message
        ? String(data.choices[0].message.content || '')
        : '';
    }
    if (!content) return { ok: false, error: '响应中无内容：' + raw.slice(0, 200) };
    return { ok: true, content };
  } catch (e) {
    console.error('[VocabRadar][sw][' + _ts() + '] ocrLLM 异常:', e);
    return { ok: false, error: String(e.message || e) };
  }
}

// === ASR：offscreen 协调（音频捕获重构 2026-07-04）===
// 旧方案：SW 调 tabCapture.getMediaStreamId → offscreen getUserMedia 采集
// 新方案：content script 用 AudioContext + MediaElementAudioSourceNode 采集
//   → 发 ASR_AUDIO_SEGMENT 到 SW → SW 转发 OFFSCREEN_RECOGNIZE 到 offscreen
//   → offscreen 用 whisper 识别 → 回传 ASR_SEGMENT → SW 中转给 content script
// SW 不再需要 tabCapture，只需创建 offscreen 供 whisper 运行
let _asrActive = false;
let _asrTabId = null;
// Firefox 回退（2026-08-15 第六十四次；2026-08-30 第一百八十次改宿主位置）：
//   Firefox 无 chrome.offscreen，whisper 运行于**后台 event page 自身 document** 内的
//   隐藏 iframe（旧版建在网页 DOM 里，被网页 CSP 拦，详见 ensureFallbackIframe）。
let _asrFallbackMode = false;
// 后台页内的 ASR 宿主 iframe 引用（仅 Firefox；Chromium 后台为 SW 无 DOM，恒为 null）
let _asrFallbackFrame = null;

/**
 * 持久化 ASR 状态到 chrome.storage.session
 * 反思（2026-08-08）：MV3 SW 被终止重启后 _asrActive 丢失，
 *   导致 ASR_AUDIO_SEGMENT 消息被 if(_asrActive) 拦截丢弃，表现为「ASR 经常停止」。
 *   session storage 在 SW 生命周期内持久，重启后可恢复。
 * @param {boolean} active
 * @param {number|null} tabId
 */
function persistAsrState(active, tabId) {
  try {
    chrome.storage.session.set({ _asrActive: active, _asrTabId: tabId || null });
  } catch (e) { /* ignore */ }
}

/**
 * 从 chrome.storage.session 恢复 ASR 状态
 * SW 重启时调用，恢复 _asrActive 和 _asrTabId
 */
function restoreAsrState() {
  try {
    chrome.storage.session.get(['_asrActive', '_asrTabId'], (res) => {
      if (res && res._asrActive) {
        _asrActive = true;
        _asrTabId = res._asrTabId || null;
        log('[VocabRadar][sw][' + _ts() + '] ASR 状态已恢复: asrActive=true tabId=', _asrTabId);
      }
    });
  } catch (e) { /* ignore */ }
}
// SW 启动时恢复 ASR 状态
restoreAsrState();

async function handleStartASR(tabId, videoKey) {
  log('[VocabRadar][sw][' + _ts() + '] handleStartASR tabId=', tabId, 'videoKey=', videoKey, 'asrActive=', _asrActive);
  // 反思（2026-08-15 第六十四次）：Firefox 回退——Firefox 不支持 chrome.offscreen API，
  //   改由页面内隐藏 iframe（扩展页 src/offscreen/offscreen.html）承载 whisper：
  //   - 扩展页拥有完整 chrome.runtime 消息能力，SW 的 OFFSCREEN_* 广播与 ASR_* 回传
  //     转发链路（content script 收不到 offscreen 广播，需 SW 中转）与 offscreen 文档完全一致，
  //     消息协议零改动。
  //   - 扩展 CSP 已含 wasm-unsafe-eval，引导页 asr.js 已证明 Firefox 扩展页可运行 whisper。
  const useFallback = typeof chrome.offscreen === 'undefined';
  if (useFallback) {
    _asrFallbackMode = true;
    const created = await ensureFallbackIframe();
    if (!created.ok) {
      _asrFallbackMode = false;
      const msg = 'Firefox 回退宿主创建失败（' + (created.error || '未知原因') + '）。请打开扩展引导页，在「ASR」栏上传音视频或录音识别。';
      console.warn('[VocabRadar][sw][' + _ts() + '] ' + msg);
      return { ok: false, error: msg };
    }
    log('[VocabRadar][sw][' + _ts() + '] Firefox 回退已启用（whisper 运行于后台页内隐藏 iframe）');
  } else {
    _asrFallbackMode = false;
  }
  if (_asrActive) {
    // 已在运行：先停
    await handleStopASR();
  }
  _asrTabId = tabId || null;
  persistAsrState(true, _asrTabId);

  if (!useFallback) {
    // 1. 确保已有 offscreen document（供 whisper 识别）
    const offscreenReady = await ensureOffscreen();
    log('[VocabRadar][sw][' + _ts() + '] ensureOffscreen =>', offscreenReady);
    if (!offscreenReady) return { ok: false, error: 'offscreen create failed' };
  }

  // 2. 通知 offscreen/回退 iframe 初始化（预加载 whisper，不再有 streamId）
  // 第一百七十九次（用户报障：火狐 "ASR start failed in service worker: no response"）：
  //   回退模式下先等 whisper 宿主（后台页内隐藏 iframe 里的 offscreen.js）真正注册好
  //   runtime.onMessage 监听器，再发 START。第一百八十次纠正：旧注释把失败归因于
  //   "offscreen.js 是 ES module，监听器注册晚于 load"，但实测其顶层无 import、
  //   无 top-level await，onMessage 注册很早；真因是页面内 iframe 被**网页 CSP** 拦
  //   （详见 ensureFallbackIframe 注释），宿主根本没跑起来。PING 握手仍保留，
  //   作为"宿主确已就绪"的唯一判据。
  if (useFallback) {
    const ready = await waitOffscreenReady(8000);
    if (!ready) {
      _asrFallbackMode = false;
      persistAsrState(false, null);
      const msg = 'Firefox 回退宿主未就绪（8 秒内无 PING 应答；诊断：' + describeFallbackFrame()
        + '）。请重试，或打开扩展引导页在「ASR」栏识别。';
      console.warn('[VocabRadar][sw][' + _ts() + '] ' + msg);
      return { ok: false, error: msg };
    }
  }
  const resp = await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_ASR_START',
    videoKey: videoKey || ''
  }).catch((e) => {
    console.warn('[VocabRadar][sw][' + _ts() + '] 通知 offscreen 失败:', e);
    return { ok: false, error: 'OFFSCREEN_ASR_START 无接收方：' + String((e && e.message) || e) };
  });
  log('[VocabRadar][sw][' + _ts() + '] offscreen 响应:', resp);
  _asrActive = !!(resp && resp.ok);
  if (!_asrActive) { persistAsrState(false, null); }
  // 第一百七十九次：resp 为 null/无 error 字段时也给出具体错因，不再把 null 抛给客户端
  //   （客户端旧版据此拼出无信息量的 "no response"）。
  return { ok: _asrActive, error: _asrActive ? undefined : ((resp && resp.error) || 'ASR 宿主未响应 OFFSCREEN_ASR_START（offscreen/回退 iframe 可能已被回收）') };
}

/**
 * 第一百七十九次：轮询 OFFSCREEN_PING，等待 whisper 宿主注册好消息监听器
 * @param {number} timeoutMs 总超时（毫秒）
 * @returns {Promise<boolean>} 就绪返回 true
 */
async function waitOffscreenReady(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  let tries = 0;
  while (Date.now() < deadline) {
    tries++;
    const r = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' }).catch(() => null);
    // 只认 offscreen.js 的应答签名（ready:true），避免其他扩展页监听器误认为就绪
    if (r && r.ok && r.ready === true) {
      log('[VocabRadar][sw][' + _ts() + '] ASR 宿主已就绪（PING 第 ' + tries + ' 次应答）');
      return true;
    }
    await new Promise((rs) => setTimeout(rs, 200));
  }
  console.warn('[VocabRadar][sw][' + _ts() + '] ASR 宿主 PING 超时，共尝试 ' + tries + ' 次');
  return false;
}

async function handleStopASR() {
  if (_asrActive) {
    try {
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_ASR_STOP' });
    } catch (e) { /* ignore */ }
  }
  _asrActive = false;
  _asrTabId = null;
  _asrFallbackMode = false;
  persistAsrState(false, null);
  return { ok: true };
}

/**
 * Firefox 回退：在**后台页自身 document** 内创建隐藏 iframe（offscreen.html）承载 whisper
 *
 * 反思（2026-08-30 第一百八十次，用户报障"asr 重装后依旧：Firefox 回退 iframe 内的
 *   ASR 宿主未就绪（8 秒内无 PING 应答）"）：
 *   - 旧实现把隐藏 iframe 建在**网页 DOM**里（由 content script / 引导页创建）。
 *     Firefox 自 76 起对内容脚本发起的 DOM 加载施加**网页** CSP。实测报障页
 *     learn.microsoft.com 的响应头 CSP 为 `default-src *`（且无 frame-src），
 *     而 CSP 的 `*` 只匹配网络 scheme、**不匹配 moz-extension:** →
 *     `<iframe src="moz-extension://…/offscreen.html">` 直接被拦，offscreen.js
 *     从未运行，OFFSCREEN_PING 永无应答。web_accessible_resources 已含
 *     src/offscreen/*，故不是权限问题；offscreen.js 顶层无 import/无 top-level await、
 *     onMessage 注册很早，故也不是"监听器注册晚于 load"（第 179 次的判断有误，此处纠正）。
 *   - 且旧的页面侧创建函数无论 load 还是 4 秒超时都 resolve({ok:true})，
 *     把失败遮蔽成成功，SW 侧只能等到 PING 超时才报错，掩盖了真实错因。
 *   修正：Firefox MV3 的后台**不是** Service Worker，而是带 DOM 的 event page
 *   （scripts/build.py#patch_manifest_for_firefox 把 background.service_worker
 *   改写为 background.scripts），后台页自身适用**扩展** CSP（含 wasm-unsafe-eval），
 *   因此把隐藏 iframe 建在后台页自己的 document 内即可完全绕开网页 CSP，
 *   与 Chromium 的 offscreen document 等价，OFFSCREEN 与 ASR 两族消息协议零改动。
 * @returns {Promise<{ok:boolean, error?:string}>} 真实结果，失败即报错，不做假成功
 */
async function ensureFallbackIframe() {
  // Chromium 的后台是无 DOM 的 Service Worker；本函数仅在 chrome.offscreen 缺失
  // （即 Firefox event page）时调用，此处仅作真实诊断，不静默成功。
  if (typeof document === 'undefined' || !document.documentElement) {
    return { ok: false, error: '后台环境无 DOM（Service Worker），无法承载 ASR 回退 iframe' };
  }
  // 幂等：已存在且文档仍在则复用（event page 未被回收时模型缓存可复用）
  if (_asrFallbackFrame && _asrFallbackFrame.isConnected && _asrFallbackFrame.contentWindow) {
    log('[VocabRadar][sw][' + _ts() + '] Firefox 回退 iframe 复用（后台页内已存在）');
    return { ok: true };
  }
  try {
    const frame = document.createElement('iframe');
    frame.id = 'beaver-asr-host';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'display:none;width:0;height:0;border:0;';
    const loaded = new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      frame.addEventListener('load', () => done({ ok: true }), { once: true });
      frame.addEventListener('error', () => done({ ok: false, error: 'iframe load 事件报错' }), { once: true });
      // 超时不再假装成功：真实回报"未触发 load"
      setTimeout(() => done({ ok: false, error: '后台页内 iframe 10 秒内未触发 load' }), 10000);
    });
    frame.src = chrome.runtime.getURL('src/offscreen/offscreen.html');
    document.documentElement.appendChild(frame);
    _asrFallbackFrame = frame;
    const r = await loaded;
    if (!r.ok) {
      // 失败即拆除，避免残留的坏 iframe 被下次幂等分支复用（否则用户永远重试不好）
      try { frame.remove(); } catch (e2) { /* ignore */ }
      _asrFallbackFrame = null;
      console.warn('[VocabRadar][sw][' + _ts() + '] Firefox 回退 iframe 加载失败: ' + r.error);
      return r;
    }
    log('[VocabRadar][sw][' + _ts() + '] Firefox 回退 iframe 已在后台页内加载完成（whisper 宿主）');
    return { ok: true };
  } catch (e) {
    const error = String((e && e.message) || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] Firefox 回退 iframe 创建异常: ' + error);
    return { ok: false, error };
  }
}

/**
 * 第一百八十次：回退 iframe 的运行时诊断快照（PING 超时时并入错误文案，
 * 便于区分"iframe 未加载"与"加载了但消息不通"两类失败，不再只给一句笼统超时）
 * @returns {string}
 */
function describeFallbackFrame() {
  if (typeof document === 'undefined') return '后台无 DOM';
  const f = _asrFallbackFrame;
  if (!f) return 'iframe 未创建';
  if (!f.isConnected) return 'iframe 已脱离后台页';
  let state = '未知';
  let href = '未知';
  try { state = (f.contentDocument && f.contentDocument.readyState) || '无 contentDocument'; } catch (e) { state = '跨源不可读'; }
  try { href = (f.contentWindow && f.contentWindow.location && f.contentWindow.location.href) || '无'; } catch (e) { href = '跨源不可读'; }
  return 'readyState=' + state + ' url=' + href;
}

async function ensureOffscreen() {
  // 反思（2026-08-15 第六十四次）：Firefox 无 chrome.offscreen，直接返回 false
  //   （旧版访问 chrome.offscreen.hasDocument 抛 TypeError，被调用方 .catch 吞掉）。
  if (typeof chrome.offscreen === 'undefined') return false;
  // 检查是否已有 offscreen document（hasDocument 在 Chrome 116+/Edge 116+ 可用）
  if (typeof chrome.offscreen.hasDocument === 'function') {
    try {
      const existing = await chrome.offscreen.hasDocument();
      if (existing) {
        log('[VocabRadar][sw][' + _ts() + '] offscreen 已存在（复用，模型应已缓存）');
        return true;
      }
    } catch (e) { /* 忽略，尝试创建 */ }
  }
  log('[VocabRadar][sw][' + _ts() + '] offscreen 不存在，创建新 document（模型需重新加载）');
  try {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['BLOBS', 'WORKERS'],
      justification: 'Real-time ASR: receive audio ArrayBuffer from content script + whisper pipeline (WASM/Workers)',
    });
    return true;
  } catch (e) {
    console.warn('[VocabRadar][sw][' + _ts() + '] createDocument 失败:', e);
    // 可能已被其他调用创建，再次检查
    if (typeof chrome.offscreen.hasDocument === 'function') {
      try { return !!(await chrome.offscreen.hasDocument()); } catch (e2) { /* ignore */ }
    }
    // 没有 hasDocument API 时，若 createDocument 报 "already exists" 视为成功
    if (String(e.message || e).includes('already exist') || String(e.message || e).includes('Only a single')) {
      return true;
    }
    return false;
  }
}

// === 在线翻译（Translator API 不可用时的兜底渠道） ===
// 注意渠道健壮性：一种不行就换一种

// 反思（2026-08-05 修正）：用户反馈"有些释义结果不正常，还是原来语言，要检查，换翻译渠道"。
//   根因：各渠道只校验"返回非空"，未校验"译文是否与原文相同（未翻译）"。
//   某些渠道（如百度语言码不匹配、MyMemory 限流返回原文）会返回原文未翻译，
//   被当作成功结果接受并缓存。
//   修正：新增 isUntranslated 校验函数，每个渠道返回后校验，
//   译文与原文完全相同（trim+lowercase）且 src!==tgt 时视为未翻译，继续下一渠道。
//   注意：少数外来语（如 tofu/dimension）译文可能确实与原文相同，会被误判，
//   但属罕见情况，且用户明确反馈"还是原来语言"，优先解决未翻译问题。
// 反思（2026-08-06 修正）：用户再次反馈"还是原来语言"。
//   根因：旧版 isUntranslated 只校验"译文=原文完全相同"，漏掉"同语言不同词"
//   （如 en→zh 时 running→run 仍是英文，不是中文）。
//   修正：新增 targetScriptOk 文字系统校验——译文须含目标语言的代表性字符。
//   tgt=zh 须含汉字，tgt=ja 须含假名/汉字，tgt=ko 须含谚文，tgt=ru 须含西里尔等。
//   不含目标文字系统 → 视为未翻译，换下一渠道。
//   源语言与目标语言同文字系统时（如 en→es 均拉丁字母）回退到精确匹配校验。
function isUntranslated(text, word, src, tgt) {
  if (!text) return true;
  if (src === tgt) return false; // 同语言不校验
  const trimmed = text.trim();
  // 1. 精确匹配校验：译文=原文（trim+lowercase）→ 未翻译
  if (trimmed.toLowerCase() === word.trim().toLowerCase()) return true;
  // 2. 文字系统校验：译文须含目标语言代表性字符
  if (!targetScriptOk(trimmed, tgt)) {
    console.warn(`[VocabRadar][sw][${_ts()}] 校验失败: 译文"${trimmed}" 不含目标语言(${tgt})文字系统，视为未翻译`);
    return true;
  }
  return false;
}

/**
 * 校验译文是否含目标语言的代表性字符（文字系统）
 * 反思（2026-08-06）：精确匹配漏掉"同语言不同词"，需文字系统校验兜底。
 *   源语言与目标语言同文字系统时（如 en→es），返回 true（无法区分，回退精确匹配）。
 * @param {string} text 译文
 * @param {string} tgt 目标语言码
 * @returns {boolean} true=含目标文字系统（或无法判断），false=不含（未翻译）
 */
function targetScriptOk(text, tgt) {
  if (!text) return false;
  // 目标语言 → 代表性 Unicode 范围
  const SCRIPT_MAP = {
    zh: '\\u4e00-\\u9fff',                              // CJK 汉字
    ja: '\\u3040-\\u309f\\u30a0-\\u30ff\\u4e00-\\u9fff', // 平假名/片假名/汉字
    ko: '\\uac00-\\ud7af',                              // 谚文
    ru: '\\u0400-\\u04ff', uk: '\\u0400-\\u04ff',       // 西里尔
    ar: '\\u0600-\\u06ff', he: '\\u0590-\\u05ff',       // 阿拉伯/希伯来
    th: '\\u0e00-\\u0e7f',                              // 泰文
    el: '\\u0370-\\u03ff',                              // 希腊文
    hi: '\\u0900-\\u097f', bn: '\\u0980-\\u09ff',       // 天城文/孟加拉文
    ta: '\\u0b80-\\u0bff', te: '\\u0c00-\\u0c7f', ml: '\\u0d00-\\u0d7f', // 泰米尔/泰卢固/马拉雅拉姆
  };
  const range = SCRIPT_MAP[tgt];
  if (!range) return true; // 拉丁字母语言（en/es/fr/de 等）无法区分，回退精确匹配
  const re = new RegExp('[' + range + ']');
  return re.test(text);
}

// 反思（2026-08-12）：带超时的 fetch，避免翻译服务器不响应时永久挂起
async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function handleTranslateWord(word, source, target, channels) {
  if (!word) return { ok: false, error: 'empty word' };
  // 第二百一十六次（用户："引导页增加翻译一行，后跟LLM、几个api、浏览器自身复选框"）：
  //   每个渠道可勾选启停（缺省全启）；未勾选的渠道直接跳过（报"渠道未启用"）。
  const chGate = (id) => (!channels || channels[id] !== false);
  const src = source || 'en';
  const tgt = target || 'zh';
  // 反思（2026-08-12）：用户反馈"翻译一直 Translating..."。
  //   根因：在线翻译 fetch 无超时，服务器不响应时永久挂起，阻塞翻译队列。
  //   修正：所有翻译渠道用 fetchWithTimeout（8秒超时），超时返回 null 继续下一个渠道。
  // 反思（2026-08-13 第五十一次）：用户反馈"翻译 quizzes 失败，请增加直接用的翻译渠道"。
  //   旧渠道（MyMemory/Google/有道 translate_o/百度 transapi/Bing/Lingva）实测全失败：
  //     - Google gtx 国内被墙（aborted）
  //     - MyMemory 免费限流返回空
  //     - 有道 translate_o 签名失效 NetworkError
  //     - 百度 transapi 无签名端点在浏览器环境被反爬拒
  //     - Bing 需 IG token 获取常失败、Lingva 公共实例不稳定
  //   修正：新增两个免签名、国内直接可用的词典端点，放到最前（单词场景命中率最高）：
  //     渠道 1：百度联想 sug（fanyi.baidu.com/sug，POST kw，返回中文释义）
  //     渠道 2：有道词典 jsonapi（dict.youdao.com/jsonapi，返回中文释义）
  //   原 6 渠道保留为短语/句子兜底。

  // 渠道 1：百度联想 sug（单词中文释义，国内快、无需 key/签名）
  let bdsErr = null;
  try {
    if (!chGate('baidusug')) throw new Error('渠道未启用');
    const bds = await baiduSugTranslate(word, src, tgt);
    if (bds && !isUntranslated(bds, word, src, tgt)) return { ok: true, text: bds, channel: 'BaiduSug' };
    bdsErr = bds ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    bdsErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[BaiduSug] 失败:', bdsErr);
  }

  // 渠道 2：有道词典 jsonapi（单词中文释义，国内快、无需 key/签名）
  let yddErr = null;
  try {
    if (!chGate('youdaodict')) throw new Error('渠道未启用');
    const ydd = await youdaoDictTranslate(word, src, tgt);
    if (ydd && !isUntranslated(ydd, word, src, tgt)) return { ok: true, text: ydd, channel: 'YoudaoDict' };
    yddErr = ydd ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    yddErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[YoudaoDict] 失败:', yddErr);
  }

  // 渠道 3：MyMemory（免费，无需 key，CORS 友好）
  let mmErr = null;
  try {
    if (!chGate('mymemory')) throw new Error('渠道未启用');
    const mm = await mymemoryTranslate(word, src, tgt);
    if (mm && !isUntranslated(mm, word, src, tgt)) return { ok: true, text: mm, channel: 'MyMemory' };
    mmErr = mm ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    mmErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[MyMemory] 失败:', mmErr);
  }

  // 渠道 4：Google translate 公共端点（可能被限流，作为兜底）
  let ggErr = null;
  try {
    if (!chGate('google')) throw new Error('渠道未启用');
    const g = await googleTranslate(word, src, tgt);
    if (g && !isUntranslated(g, word, src, tgt)) return { ok: true, text: g, channel: 'Google' };
    ggErr = g ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    ggErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[Google] 失败:', ggErr);
  }

  // 渠道 5：有道翻译（国内可用，作为最终兜底）
  let ydErr = null;
  try {
    if (!chGate('youdao')) throw new Error('渠道未启用');
    const yd = await youdaoTranslate(word, src, tgt);
    if (yd && !isUntranslated(yd, word, src, tgt)) return { ok: true, text: yd, channel: 'Youdao' };
    ydErr = yd ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    ydErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[Youdao] 失败:', ydErr);
  }

  // 渠道 6：百度翻译（国内可用，最终兜底）
  let bdErr = null;
  try {
    if (!chGate('baidu')) throw new Error('渠道未启用');
    const bd = await baiduTranslate(word, src, tgt);
    if (bd && !isUntranslated(bd, word, src, tgt)) return { ok: true, text: bd, channel: 'Baidu' };
    bdErr = bd ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    bdErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[Baidu] 失败:', bdErr);
  }

  // 渠道 7：Bing 翻译（Edge 浏览器用户优先可用）
  let bingErr = null;
  try {
    if (!chGate('bing')) throw new Error('渠道未启用');
    const bing = await bingTranslate(word, src, tgt);
    if (bing && !isUntranslated(bing, word, src, tgt)) return { ok: true, text: bing, channel: 'Bing' };
    bingErr = bing ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    bingErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[Bing] 失败:', bingErr);
  }

  // 渠道 8：Lingva 翻译（Google 翻译代理，避免 Google 直接被墙）
  let lvErr = null;
  try {
    if (!chGate('lingva')) throw new Error('渠道未启用');
    const lv = await lingvaTranslate(word, src, tgt);
    if (lv && !isUntranslated(lv, word, src, tgt)) return { ok: true, text: lv, channel: 'Lingva' };
    lvErr = lv ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    lvErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[Lingva] 失败:', lvErr);
  }

  return { ok: false, error: 'BaiduSug: ' + bdsErr + '; YoudaoDict: ' + yddErr + '; MyMemory: ' + mmErr + '; Google: ' + ggErr + '; Youdao: ' + ydErr + '; Baidu: ' + bdErr + '; Bing: ' + bingErr + '; Lingva: ' + lvErr };
}

/**
 * 百度联想 sug（单词中文释义）
 * 反思（2026-08-13 第五十一次）：fanyi.baidu.com/sug 免签名、免 key、国内快。
 *   POST 表单 kw=<word>，返回 {errno:0, data:[{k,v}]}，v 含中文释义。
 *   仅适合单词/短词（本扩展翻译对象即单词），长文本走渠道 3-8 的完整翻译 API。
 * @param {string} text
 * @param {string} src
 * @param {string} tgt
 * @returns {Promise<string|null>}
 */
async function baiduSugTranslate(text, src, tgt) {
  if (!text || !/^[\w .'-]+$/.test(text) || text.length > 60) return null;
  const url = 'https://fanyi.baidu.com/sug';
  const params = new URLSearchParams({ kw: text });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://fanyi.baidu.com/'
    },
    body: params.toString()
  }, 8000);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || data.errno !== 0 || !Array.isArray(data.data)) return null;
  // 优先精确命中原文（大小写不敏感），否则取第一条联想
  const lower = text.toLowerCase();
  const hit = data.data.find((d) => d && d.k && d.k.toLowerCase() === lower);
  const item = hit || data.data[0];
  if (!item || !item.v) return null;
  const first = String(item.v).split('\n')[0].trim();
  // 反思（2026-08-16 第六十六次）：百度 sug 对屈折形式返回夹杂"原形(释义)的屈折说明"，
  //   如 "v. 促进( facilitate的第三人称单数 ); 使便利; ..."，清洗后再返回。
  return cleanDictEntry(first) || null;
}

/**
 * 有道词典 jsonapi（单词中文释义）
 * 反思（2026-08-13 第五十一次）：dict.youdao.com/jsonapi 免签名、免 key、国内快。
 *   POST q=<word>，返回 ec.word[].trs[] 英文释义（含中文，格式如 "n. 测验"）。
 *   仅适合单词，长文本走渠道 3-8。
 * @param {string} text
 * @param {string} src
 * @param {string} tgt
 * @returns {Promise<string|null>}
 */
async function youdaoDictTranslate(text, src, tgt) {
  if (!text || !/^[\w .'-]+$/.test(text) || text.length > 60) return null;
  const url = 'https://dict.youdao.com/jsonapi?q=' + encodeURIComponent(text) + '&doctype=json&keyfrom=fanyi.web&xmlVersion=norm';
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://dict.youdao.com/'
    }
  }, 8000);
  if (!res.ok) return null;
  const data = await res.json();
  const trs = data?.ec?.word?.[0]?.trs;
  if (!Array.isArray(trs) || trs.length === 0) return null;
  // 第一百二十三次（用户反馈"释义缺右括号：短裤( shor"）：l.i 是**分段数组**——
  // 长释义被有道切进多个元素（余段在 i[1..]，如 "ts）"），旧版只取 i[0] 必然截断。
  // 修正：拼接全部字符串段（跳过 '#' 开头的元数据标签）后再清洗。
  const parts = trs
    .map((tr) => {
      const segs = tr?.tr?.[0]?.l?.i;
      if (!Array.isArray(segs)) return '';
      const txt = segs
        .filter((seg) => typeof seg === 'string' && !seg.startsWith('#'))
        .join('');
      return txt ? txt.trim() : '';
    })
    .filter(Boolean);
  if (parts.length === 0) return null;
  // 反思（2026-08-16 第六十六次）：有道 jsonapi 对屈折形式返回夹杂"原形(释义)的屈折说明"，
  //   如 "v. 使更容易，使便利；促进，推动（facilitate 的第三人称单数）"，清洗后再返回。
  // 取前 3 条释义，用分号连接，避免过长
  return cleanDictEntry(parts.slice(0, 3).join('；')) || null;
}

async function mymemoryTranslate(text, src, tgt) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${src}|${tgt}`;
  // 反思（2026-08-02）：增加 User-Agent header，部分 API 要求
  // 反思（2026-08-12）：用 fetchWithTimeout 替代裸 fetch，8 秒超时防止永久挂起
  const res = await fetchWithTimeout(url, {
    credentials: 'omit',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  }, 8000);
  if (!res.ok) return null;
  const data = await res.json();
  const t = data?.responseData?.translatedText;
  if (!t || /MYMEMORY WARNING|INVALID/i.test(t)) return null;
  return t;
}

async function googleTranslate(text, src, tgt) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${src}&tl=${tgt}&dt=t&q=${encodeURIComponent(text)}`;
  // 反思（2026-08-12）：用 fetchWithTimeout，8 秒超时
  const res = await fetchWithTimeout(url, {
    credentials: 'omit',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  }, 8000);
  if (!res.ok) return null;
  const data = await res.json();
  // data[0] 是段次数组，每段 [原文, 译文, ...]
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  const out = data[0].map((seg) => (seg && seg[0]) ? seg[0] : '').join('');
  return out || null;
}

/**
 * 有道翻译（国内可用，作为最终兜底渠道）
 *
 * 反思（2026-08-02 修正）：
 *   Python 测试发现 fanyi.youdao.com/translate?doctype=json 返回 HTML 而非 JSON，
 *   该端点已失效。改用 fanyi.youdao.com/translate_o 接口（POST + form 数据）。
 *   但 translate_o 需要 sign 计算（涉及 JS 加密），较复杂。
 *   替代方案：使用有道智云 API 的公共端点，或改用其他渠道。
 *   最终方案：改用 translate.googleapis.com 的备选端点 + 增加 User-Agent。
 *   有道作为最后兜底，用 dict.youdao.com/leopard/t/translate 端点。
 *
 * 实际：保留 youdaoTranslate 函数，但改用正确的 API 端点。
 *   https://fanyi.youdao.com/translate_o 端点需要 POST + form 数据：
 *   i=text, from=src, to=tgt, smartresult=dict, client=fanyideskweb
 *   但需要 sign 计算（salt + md5），暂时跳过，回退到其他渠道。
 */
async function youdaoTranslate(text, src, tgt) {
  // 有道翻译 API：POST https://fanyi.youdao.com/translate_o
  // 反思（2026-08-02 修正）：fanyi.youdao.com/translate?doctype=json 端点已失效（返回 HTML）。
  //   改用 translate_o 端点，需要 form 数据 + salt + sign（md5）。
  //   sign 计算参考有道网页版：md5(client + text + salt + key)
  //   client=fanyideskweb, salt=时间戳, key=固定值
  //   但 key 会变化，且签名算法可能更新，此处仅作尝试。
  //   若 sign 错误会返回 {"errorCode": 50} 或空结果，返回 null 让调用方继续。
  const salt = Date.now().toString();
  const client = 'fanyideskweb';
  // 有道网页版 key（可能失效，仅作兜底尝试）
  const sign = md5Hex(client + text + salt + 'Ygy_4c=r#e#4EX^NUGUc5');
  const url = 'https://fanyi.youdao.com/translate_o';
  const params = new URLSearchParams({
    i: text,
    from: src,
    to: tgt,
    smartresult: 'dict',
    client: client,
    salt: salt,
    sign: sign,
    lts: salt,
    bv: md5Hex(navigator.userAgent),
    doctype: 'json',
    version: '2.1',
    keyfrom: 'fanyi.web',
    action: 'FY_BY_DEFAULT'
  });
  // 反思（2026-08-12）：用 fetchWithTimeout，8 秒超时
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://fanyi.youdao.com/',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: params.toString()
  }, 8000);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.errorCode !== 0) return null;
  if (!Array.isArray(data.translateResult) || !data.translateResult[0]) return null;
  const seg = data.translateResult[0][0];
  if (!seg || !seg.tgt) return null;
  return seg.tgt.trim() || null;
}

/**
 * 计算 md5 哈希（使用 js-md5 库，已挂到 self.md5）
 */
function md5Hex(str) {
  if (typeof self !== 'undefined' && self.md5) {
    return self.md5(str);
  }
  return '';
}

/**
 * 百度翻译（国内可用，fanyi.baidu.com transapi 公共端点）
 *
 * 反思（2026-08-02）：用户反馈所有在线渠道都 Failed to fetch。
 *   Python 测试 MyMemory/Google 可达，但浏览器扩展 fetch 失败。
 *   根因：manifest CSP connect-src 没有包含翻译 API 域名，已修复。
 *   增加百度翻译作为另一个国内可用渠道。
 *   baidu transapi 公共端点：https://fanyi.baidu.com/transapi
 *   POST: query=text, from=src, to=tgt
 *   返回: { "data": [{"dst":"译文","src":"原文"}], "from":"en", "to":"zh" }
 */
async function baiduTranslate(text, src, tgt) {
  // 反思（2026-08-05 修正）：百度 transapi 语言码与 ISO 639-1 不完全一致，
  //   未映射时百度可能不识别（如 ja/ko），返回原文未翻译。
  //   映射表参考百度翻译网页版实际请求：ja→jp, ko→kor, fr→fra, es→spa, de→de, ru→ru。
  //   zh/en 保持 2 字母。未列出的语言原样传递（百度可能识别或不识别）。
  const BAIDU_LANG_MAP = {
    ja: 'jp', ko: 'kor', fr: 'fra', es: 'spa', ar: 'ara', th: 'th',
    vi: 'vie', id: 'ind', ms: 'may', tl: 'fil', hi: 'hi', bn: 'ben',
    ta: 'tam', te: 'tel', ml: 'mal', tr: 'tr', nl: 'nl', el: 'el',
    sv: 'swe', no: 'nor', da: 'dan', fi: 'fin', pl: 'pl', cs: 'cs',
    hu: 'hu', ro: 'rom', uk: 'uk', he: 'heb', fa: 'per'
  };
  const from = BAIDU_LANG_MAP[src] || src;
  const to = BAIDU_LANG_MAP[tgt] || tgt;
  const url = 'https://fanyi.baidu.com/transapi';
  const params = new URLSearchParams({
    query: text,
    from: from,
    to: to
  });
  // 反思（2026-08-12）：用 fetchWithTimeout，8 秒超时
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://fanyi.baidu.com/'
    },
    body: params.toString()
  }, 8000);
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data.data) || data.data.length === 0) return null;
  return data.data.map((seg) => seg.dst || '').join('') || null;
}

/**
 * Bing 翻译（Edge 浏览器用户优先可用）
 *
 * 反思（2026-08-02）：用户在 Edge 浏览器，Bing 翻译可能更容易访问。
 *   Bing translator API 需要 IG token（从 bing.com/translator 页面获取）。
 *   ttranslatev3 端点：POST https://www.bing.com/ttranslatev3?isVertical=1&IG=xxx
 *   返回: [{ "translations": [{ "text": "译文", "to": "zh" }] }]
 *   若 token 获取失败或翻译失败，返回 null 让调用方继续其他渠道。
 */
let _bingIG = null;
let _bingIGTime = 0;
async function bingTranslate(text, src, tgt) {
  // IG token 有效期约 5 分钟，过期重新获取
  if (!_bingIG || Date.now() - _bingIGTime > 4 * 60 * 1000) {
    try {
      // 反思（2026-08-12）：用 fetchWithTimeout，8 秒超时
      const pageRes = await fetchWithTimeout('https://www.bing.com/translator', {
        credentials: 'omit',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      }, 8000);
      if (!pageRes.ok) return null;
      const pageText = await pageRes.text();
      const igMatch = pageText.match(/IG:"([^"]+)"/);
      if (igMatch) {
        _bingIG = igMatch[1];
        _bingIGTime = Date.now();
      } else {
        return null;
      }
    } catch (e) {
      return null;
    }
  }

  const url = `https://www.bing.com/ttranslatev3?isVertical=1&IG=${_bingIG}&IID=translator.5010`;
  const params = new URLSearchParams({
    fromLang: 'auto-detect',
    text: text,
    to: tgt
  });
  // 反思（2026-08-12）：用 fetchWithTimeout，8 秒超时
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.bing.com/translator'
    },
    body: params.toString()
  }, 8000);
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const translations = data[0]?.translations;
  if (!Array.isArray(translations) || translations.length === 0) return null;
  return translations[0]?.text?.trim() || null;
}

/**
 * Lingva 翻译（Google 翻译的代理，避免 Google 直接被墙）
 *
 * 反思（2026-08-02）：Lingva 是 Google 翻译的开源代理，
 *   公共实例可能不稳定，但作为额外渠道尝试。
 *   API: https://lingva.ml/api/v1/{src}/{tgt}/{text}
 *   返回: { "translation": "译文" }
 */
async function lingvaTranslate(text, src, tgt) {
  // 尝试多个 Lingva 实例
  const instances = [
    'https://lingva.ml',
    'https://translate.plausibility.cloud',
    'https://lingva.lunar.icu'
  ];
  for (const base of instances) {
    try {
      const url = `${base}/api/v1/${src}/${tgt}/${encodeURIComponent(text)}`;
      // 反思（2026-08-12）：用 fetchWithTimeout，8 秒超时
      const res = await fetchWithTimeout(url, {
        credentials: 'omit',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      }, 8000);
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.translation) return data.translation.trim();
    } catch (e) {
      // 继续尝试下一个实例
    }
  }
  return null;
}

/**
 * 代理下载字幕（绕过 content script 的 CORS 限制）
 * service worker 环境不受 CORS 限制，可以直接 fetch YouTube/B站 字幕 URL
 * @param {string} url 字幕 URL
 * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
 */
async function handleFetchSubtitle(url) {
  if (!url) {
    console.warn('[VocabRadar][sw][' + _ts() + '] fetchSubtitle: empty url');
    return { ok: false, error: 'empty url' };
  }
  log('[VocabRadar][sw][' + _ts() + '] fetchSubtitle:', url.slice(0, 100) + '...');
  try {
    const res = await fetch(url, { credentials: 'omit' });
    log('[VocabRadar][sw][' + _ts() + '] fetchSubtitle 响应:', res.status, res.statusText);
    if (!res.ok) {
      return { ok: false, error: 'HTTP ' + res.status };
    }
    const text = await res.text();
    log('[VocabRadar][sw][' + _ts() + '] fetchSubtitle 成功, 内容长度:', text.length);
    return { ok: true, text };
  } catch (e) {
    console.error('[VocabRadar][sw][' + _ts() + '] fetchSubtitle 异常:', e);
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 候选 URL 列表（第九十六次）：主 URL + backupUrls 去重（借鉴 videoseek/bilibili-evolved 多源回退）
 * @param {string} url 主 URL
 * @param {string[]} [urls] 完整候选列表（含主 URL）
 * @returns {string[]}
 */
function candidateUrls(url, urls) {
  const list = Array.isArray(urls) && urls.length > 0 ? urls : [url];
  const seen = new Set();
  const out = [];
  for (const u of list) {
    if (typeof u === 'string' && u && !seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out.length > 0 ? out : (url ? [url] : []);
}

/**
 * 代理下载 B站音频文件（绕过 content script 的 CORS 限制）
 * B站预识别路径：content script 从 __playinfo__ 提取音频 URL，
 * 通过 SW 代理下载（SW 不受 CORS 限制，host_permissions 含 <all_urls>）。
 * 音频 URL 自带 auth_key 鉴权参数，无需额外 cookie。
 * 第九十六次：支持 urls[] 多候选依序尝试（主 URL 失败换 backupUrl）。
 * @param {string} url 音频流 URL（.m4s 格式）
 * @param {string[]} [urls] 候选 URL 列表
 * @returns {Promise<{ok: boolean, arrayBuffer?: ArrayBuffer, error?: string}>}
 */
async function handleFetchAudio(url, urls) {
  const candidates = candidateUrls(url, urls);
  if (candidates.length === 0) {
    console.warn('[VocabRadar][sw][' + _ts() + '] fetchAudio: empty url');
    return { ok: false, error: 'empty url' };
  }
  log('[VocabRadar][sw][' + _ts() + '] fetchAudio:', candidates[0].slice(0, 120) + '...', '候选=' + candidates.length);
  // 反思（2026-08-14 第五十四次修正）：Firefox 上偶发 "NetworkError when attempting
  //   to fetch resource." 根因未定（疑 B站 CDN 对 SW 请求的 CORS/cookie 策略差异）。
  //   修正：最多重试 2 次，第二次改用 credentials:'include' 携带站点 cookie
  //   （auth_key 已内联鉴权，但部分 CDN 仍需 referer/cookie），并输出 host 便于诊断。
  const attempts = [
    { credentials: 'omit' },
    { credentials: 'include' }
  ];
  let lastError = 'unreachable';
  for (const cu of candidates) {
    for (let i = 0; i < attempts.length; i++) {
      const opts = { credentials: attempts[i].credentials };
      try {
        const res = await fetch(cu, opts);
        log('[VocabRadar][sw][' + _ts() + '] fetchAudio 响应(第' + (i + 1) + '次):', res.status, res.statusText, 'size=' + res.headers.get('content-length'));
        if (!res.ok) {
          // 服务器返回 4xx/5xx：换凭据重试意义不大，直接失败
          lastError = 'HTTP ' + res.status;
          break;
        }
        const arrayBuffer = await res.arrayBuffer();
        log('[VocabRadar][sw][' + _ts() + '] fetchAudio 成功(第' + (i + 1) + '次), 大小:', Math.round(arrayBuffer.byteLength / 1024) + 'KB');
        return { ok: true, arrayBuffer };
      } catch (e) {
        const host = safeHostOf(cu);
        console.error('[VocabRadar][sw][' + _ts() + '] fetchAudio 异常(第' + (i + 1) + '次, host=' + host + ', credentials=' + attempts[i].credentials + '):', e);
        lastError = String(e.message || e) + ' (host=' + host + ')';
      }
    }
    if (cu !== candidates[candidates.length - 1]) log('[VocabRadar][sw][' + _ts() + '] fetchAudio 换备用 URL 重试');
  }
  return { ok: false, error: lastError };
}

// 提取 URL host，便于异常诊断；失败返回 'unknown'
function safeHostOf(url) {
  try { return new URL(url).host; } catch (e) { return 'unknown'; }
}

/**
 * 探测音频文件总字节数（第九十五次·流式 ASR；第九十六次支持多候选 URL）
 * 借鉴 videoseek ChunkedDownloader 的第一步：先拿 content-length 才能切 Range 区间表。
 * 优先 HEAD；部分 CDN 对 HEAD 不回 content-length，改发 Range bytes=0-0 从
 * Content-Range: bytes 0-0/TOTAL 解析总长（响应体 2 字节，读后即弃）。
 * 凭据策略与 handleFetchAudio 一致（omit 失败换 include 重试）；候选 URL 依序尝试。
 * @param {string} url 音频流 URL
 * @param {string[]} [urls] 候选 URL 列表
 * @returns {Promise<{ok: boolean, size?: number, error?: string}>}
 */
async function handleFetchAudioMeta(url, urls) {
  const candidates = candidateUrls(url, urls);
  if (candidates.length === 0) return { ok: false, error: 'empty url' };
  const attempts = [
    { credentials: 'omit' },
    { credentials: 'include' }
  ];
  let lastError = '无法确定文件大小';
  for (const cu of candidates) {
    for (let i = 0; i < attempts.length; i++) {
      const opts = { credentials: attempts[i].credentials };
      try {
        // 第一步：HEAD 拿 content-length
        const head = await fetch(cu, { ...opts, method: 'HEAD' });
        const len = parseInt(head.headers.get('content-length') || '0', 10);
        if (head.ok && len > 0) {
          log('[VocabRadar][sw][' + _ts() + '] fetchAudioMeta(HEAD) 成功 size=' + len);
          return { ok: true, size: len };
        }
        // 第二步：Range bytes=0-0 探测，Content-Range 携带总大小
        const probe = await fetch(cu, { ...opts, headers: { Range: 'bytes=0-0' } });
        let cr = '';
        if (probe.status === 206) {
          cr = probe.headers.get('content-range') || '';
          const m = cr.match(/\/(\d+)\s*$/);
          if (m) {
            const total = parseInt(m[1], 10);
            log('[VocabRadar][sw][' + _ts() + '] fetchAudioMeta(Range) 成功 size=' + total);
            try { await probe.body?.cancel(); } catch (e) { /* ignore */ }
            return { ok: true, size: total };
          }
        }
        lastError = '未获得大小 status=' + probe.status + ' content-range=' + cr;
        console.warn('[VocabRadar][sw][' + _ts() + '] fetchAudioMeta(第' + (i + 1) + '次) ' + lastError);
      } catch (e) {
        console.error('[VocabRadar][sw][' + _ts() + '] fetchAudioMeta 异常(第' + (i + 1) + '次, host=' + safeHostOf(cu) + '):', e);
        lastError = String(e.message || e);
      }
    }
  }
  return { ok: false, error: lastError + ' (host=' + safeHostOf(candidates[0]) + ')' };
}

/**
 * 按字节区间下载音频（第九十五次·流式 ASR，借鉴 videoseek 分块 Range 下载；
 * 第九十六次支持多候选 URL 依序尝试）
 * 仅接受 206 Partial Content——若 CDN 忽略 Range 返回 200 全量，字节对齐假设被破坏，
 * 明确报 range-unsupported 让上层走整文件回退，绝不把全量响应当区间数据用。
 * @param {string} url 音频流 URL
 * @param {number} start 起始字节（含）
 * @param {number} end 结束字节（含）
 * @param {string[]} [urls] 候选 URL 列表
 * @returns {Promise<{ok: boolean, arrayBuffer?: ArrayBuffer, error?: string}>}
 */
async function handleFetchAudioRange(url, start, end, urls) {
  const candidates = candidateUrls(url, urls);
  if (candidates.length === 0 || !(start >= 0) || !(end >= start)) {
    return { ok: false, error: 'bad args' };
  }
  const range = 'bytes=' + start + '-' + end;
  const attempts = [
    { credentials: 'omit' },
    { credentials: 'include' }
  ];
  // 第一百零七次（P0）：记录最后一次 HTTP 状态码——403=防盗链/referer、416=区间越界等，
  // 归因 H2/H4 全靠它（此前最终错误只有笼统的 range fetch failed）
  let lastStatus = 0;
  for (const cu of candidates) {
    for (let i = 0; i < attempts.length; i++) {
      const opts = { credentials: attempts[i].credentials, headers: { Range: range } };
      try {
        const res = await fetch(cu, opts);
        if (res.status === 206) {
          const ab = await res.arrayBuffer();
          log('[VocabRadar][sw][' + _ts() + '] fetchAudioRange[' + range + '] ' + Math.round(ab.byteLength / 1024) + 'KB');
          return { ok: true, arrayBuffer: ab };
        }
        if (res.status === 200) {
          // CDN 不支持 Range：中止并放弃全量响应体
          try { await res.body?.cancel(); } catch (e) { /* ignore */ }
          console.warn('[VocabRadar][sw][' + _ts() + '] fetchAudioRange 返回200全量（不支持Range）');
          return { ok: false, error: 'range-unsupported' };
        }
        lastStatus = res.status;
        console.warn('[VocabRadar][sw][' + _ts() + '] fetchAudioRange HTTP ' + res.status + ' [' + range + '] host=' + safeHostOf(cu));
      } catch (e) {
        console.error('[VocabRadar][sw][' + _ts() + '] fetchAudioRange 异常(第' + (i + 1) + '次, host=' + safeHostOf(cu) + ', ' + range + '):', e);
        lastStatus = -1;
      }
    }
  }
  return { ok: false, error: 'range fetch failed [' + range + ']' + (lastStatus ? (' HTTP' + lastStatus) : '') + (lastStatus === -1 ? '(网络异常)' : '') };
}

/**
 * 代理 fetch JSON 请求（绕过 content script 的 CSP/CORS 限制）
 * 反思（2026-08-09）：diverse-lemmas 词典数据需从 CDN 下载，
 *   content script 受页面 CSP 限制可能失败，SW 有 host_permissions 可直接 fetch。
 * @param {string} url JSON 数据 URL
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 */
async function handleFetchUrl(url) {
  if (!url) return { ok: false, error: 'empty url' };
  log('[VocabRadar][sw][' + _ts() + '] fetchUrl:', url.slice(0, 120));
  try {
    // 反思（2026-08-10）：加 cache:'no-store' 避免浏览器 HTTP 缓存返回旧响应
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) {
      console.warn('[VocabRadar][sw][' + _ts() + '] fetchUrl HTTP ' + res.status + ':', url.slice(0, 80));
      return { ok: false, error: 'HTTP ' + res.status };
    }
    const data = await res.json();
    // 反思（2026-08-10）：诊断日志——记录返回数据的 key 数量，便于排查词典加载异常
    const dataKeys = (data && typeof data === 'object') ? Object.keys(data).length : -1;
    const wdKeys = (data && data.word_dict && typeof data.word_dict === 'object') ? Object.keys(data.word_dict).length : -1;
    log('[VocabRadar][sw][' + _ts() + '] fetchUrl 成功, topKeys=' + dataKeys + ' wordDictKeys=' + wdKeys);
    return { ok: true, data };
  } catch (e) {
    console.error('[VocabRadar][sw][' + _ts() + '] fetchUrl 异常:', e);
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 代理 LLM 对话请求
 * 第一百七十一次：content script 受宿主页面 CSP 限制无法 fetch 第三方 API，
 *   统一由 SW 代理（扩展 CSP 的 connect-src 已加入各来源域名）。
 * 第一百七十四次：来源按 format 分三类（见 lib/llm.js），请求差异集中在本函数：
 *   - 'openai' / 'free'：POST {baseUrl}/chat/completions，取 choices[0].message.content；
 *                        'free' 不带任何鉴权头、也不要求 Key。
 *   - 'anthropic'      ：POST {baseUrl}/v1/messages，x-api-key + anthropic-version 头，
 *                        system 消息须单列、max_tokens 必填，取 content[0].text。
 * @param {Array<{role: string, content: string}>} messages 对话上下文
 * @returns {Promise<{ok: boolean, content?: string, error?: string, needConfig?: boolean}>}
 *   needConfig=true 表示尚未配置，前端应显示"打开设置"按钮而非只报错
 */
// 第二百一十六次：LLM 文本翻译（翻译渠道候选之一）——直接复用聊天的 LLM 配置与轮替；
//   提示词只要求输出译文本身，词条级短文本，max_tokens 默认 1024 足够。
async function handleLlmTranslate(text, target) {
  if (!text) return { ok: false, error: 'empty text' };
  const tgt = String(target || 'zh');
  const NL = String.fromCharCode(10);
  const prompt = 'Translate the following text into ' + tgt
    + '. Output ONLY the translation, with no commentary, no quotes.'
    + NL + NL + String(text);
  const out = await handleLlmChat([{ role: 'user', content: prompt }]);
  if (!out.ok) return { ok: false, error: out.error };
  return { ok: true, text: String(out.content || '').trim() };
}

async function handleLlmChat(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: 'empty messages' };
  }
  // 读配置：引导页「模型」行写入的 llm* 键；缺省由 resolveLlmConfig 用来源预设补齐
  const res = await new Promise((resolve) => {
    chrome.storage.local.get(
      { llmProvider: '', llmBaseUrl: '', llmModel: '', llmApiKey: '' },
      (r) => resolve(r || {})
    );
  });
  const cfg = resolveLlmConfig(res);

  // 第一百七十五次（用户裁定"默认轮替免费直连，除非用户配置 key"；实测 Pollinations 返回
  //   402 Payment Required 属匿名配额限流）：
  //   免费来源且用户未手填地址/模型时，构造"轮替尝试清单"——从上次用过的下一家开始，
  //   遇 402/429/网络错就换下一家；用户手填了地址或模型、或选了需 Key 的来源，则只试其本身
  //   （不擅自改用户配置，也不遮蔽其错误）。
  let attempts = [cfg];
  if (cfg.format === 'free' && !cfg.userBaseUrl && !cfg.userModel) {
    const frees = getFreeProviders();
    if (frees.length > 1) {
      const start = _llmFreeCursor % frees.length;
      _llmFreeCursor = (_llmFreeCursor + 1) % frees.length;
      attempts = [];
      for (let i = 0; i < frees.length; i++) {
        const p = frees[(start + i) % frees.length];
        attempts.push(Object.assign({}, cfg, { provider: p.id, baseUrl: p.baseUrl, model: p.model }));
      }
    }
  }

  let last = { ok: false, error: 'no attempt' };
  for (let i = 0; i < attempts.length; i++) {
    last = await llmChatOnce(attempts[i], messages);
    if (last.ok || !last.retryable) return last;
    log('[VocabRadar][sw][' + _ts() + '] llmChat 来源 ' + attempts[i].provider + ' 失败(' + last.error
      + ')，自动改试下一家免费直连');
  }
  // 全部失败：把最后一次的原始错误如实返回（不遮蔽），并去掉内部标记字段
  return { ok: false, error: last.error, needConfig: !!last.needConfig };
}

// 免费直连轮替游标：模块级，SW 存活期间逐次前移，实现"默认轮替"而非总打头一家
let _llmFreeCursor = 0;

/**
 * 发起一次 LLM 请求（单来源，不含轮替）
 * @param {object} cfg resolveLlmConfig 的结果（或轮替时替换过 provider/baseUrl/model 的副本）
 * @param {Array<{role: string, content: string}>} messages 对话上下文
 * @returns {Promise<{ok: boolean, content?: string, error?: string, needConfig?: boolean, retryable?: boolean}>}
 *   retryable=true 表示"本家限流/不通，换一家可能成"（402/429/5xx/网络错），交由上层轮替
 */
async function llmChatOnce(cfg, messages) {
  const isFree = cfg.format === 'free';
  const isAnthropic = cfg.format === 'anthropic';
  // 不遮蔽错误：缺 baseUrl / 缺 model 都明确告知；Key 只对需账号的两类强制要求
  if (!isFree && !cfg.apiKey) return { ok: false, error: 'API Key 未配置', needConfig: true };
  if (!cfg.baseUrl) return { ok: false, error: 'Base URL 未配置', needConfig: true };
  if (!cfg.model) return { ok: false, error: '模型名未配置', needConfig: true };

  // 三类格式的 URL / 头 / 请求体差异
  const url = cfg.baseUrl + (isAnthropic ? '/v1/messages' : '/chat/completions');
  const headers = { 'Content-Type': 'application/json' };
  if (isAnthropic) {
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    // 浏览器环境直连 Anthropic 需显式声明，否则被其 CORS 策略拒绝
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (!isFree) {
    headers['Authorization'] = 'Bearer ' + cfg.apiKey;
  }
  let body;
  if (isAnthropic) {
    // Anthropic 的 system 不能混在 messages 里，须提到顶层字段
    const sys = messages.filter((m) => m && m.role === 'system').map((m) => String(m.content || '')).join('\n');
    const turns = messages.filter((m) => m && m.role !== 'system');
    const payload = { model: cfg.model, max_tokens: 1024, messages: turns, stream: false };
    if (sys) payload.system = sys;
    body = JSON.stringify(payload);
  } else {
    body = JSON.stringify({ model: cfg.model, messages, stream: false });
  }

  log('[VocabRadar][sw][' + _ts() + '] llmChat provider=' + cfg.provider + ' format=' + cfg.format
    + ' model=' + cfg.model + ' turns=' + messages.length);
  try {
    const resp = await fetch(url, { method: 'POST', headers, credentials: 'omit', cache: 'no-store', body });
    // 失败时把响应体前 300 字一并带回：各家错误信息（额度耗尽/模型名错/Key 无效）都在这里
    const raw = await resp.text();
    if (!resp.ok) {
      console.warn('[VocabRadar][sw][' + _ts() + '] llmChat HTTP ' + resp.status + ': ' + raw.slice(0, 300));
      // 402=匿名配额耗尽、429=限流、5xx=服务端故障 → 标记可重试，上层换下一家免费直连
      const retryable = resp.status === 402 || resp.status === 429 || resp.status >= 500;
      return { ok: false, error: 'HTTP ' + resp.status + ' ' + raw.slice(0, 300), retryable };
    }
    let data = null;
    try { data = JSON.parse(raw); } catch (e) {
      // 返回体不是 JSON（常见于网关错误页/限流页）→ 也算本家不通，可换下一家
      return { ok: false, error: '响应不是 JSON：' + raw.slice(0, 200), retryable: true };
    }
    // 响应解析：Anthropic 是 content[] 数组（取所有 text 块拼接），OpenAI 形状是 choices[0].message.content
    let content = '';
    if (isAnthropic) {
      content = Array.isArray(data && data.content)
        ? data.content.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('')
        : '';
    } else {
      content = data && data.choices && data.choices[0] && data.choices[0].message
        ? String(data.choices[0].message.content || '')
        : '';
    }
    if (!content) return { ok: false, error: '响应中无内容：' + raw.slice(0, 200), retryable: true };
    return { ok: true, content };
  } catch (e) {
    console.error('[VocabRadar][sw][' + _ts() + '] llmChat 异常:', e);
    // 网络层异常（DNS/TLS/超时）→ 换一家可能成
    return { ok: false, error: String(e.message || e), retryable: true };
  }
}
