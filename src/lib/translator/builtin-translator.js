// ============================================================
// 文件职责：浏览器内置 Translator API 调用（src/lib/translator/builtin-translator.js）
// 来源：拆分自 src/lib/translator.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// 内容：Translator 单例状态（_translator/_initPromise/_availability，与使用者同模块）、
//   chrome.storage 语言对初始读取与 onChanged 监听（变化时重置单例，原单文件同一段）、
//   preloadTranslator 模型预热、getAvailability 可用性检测（原导出）、
//   getTranslator 单例获取（downloadable/downloading/available 三态 create，均带超时）、
//   targetScriptOk 译文文字系统校验（供 index.js 渠道串联复用）。
// 语言对读写经 shared.js 的 transState（唯一实例）；_debug/log/_ts/withTimeout 亦来自 shared.js。
// ============================================================
import { withTimeout, log, _ts, transState } from './shared.js';

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get({ learnLanguage: 'en', meaningLanguage: 'zh' }, (res) => {
    transState.learnLang = res.learnLanguage || 'en';
    transState.meaningLang = res.meaningLanguage || 'zh';
    // 预加载 Translator 模型（独立于任何开关，启动时自动下载）
    preloadTranslator();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let langChanged = false;
    if (changes.learnLanguage && changes.learnLanguage.newValue !== transState.learnLang) {
      transState.learnLang = changes.learnLanguage.newValue || 'en';
      langChanged = true;
    }
    if (changes.meaningLanguage && changes.meaningLanguage.newValue !== transState.meaningLang) {
      transState.meaningLang = changes.meaningLanguage.newValue || 'zh';
      langChanged = true;
    }
    // 语言对变化：重置 Translator 单例（新语言对需重新 create）
    if (langChanged) {
      log(`[VocabRadar][translator][${_ts()}] 语言对变更: ${transState.learnLang} -> ${transState.meaningLang}, 重置 Translator 单例`);
      _translator = null;
      _initPromise = null;
      _availability = null;
      _lastFailTs = 0; // 第二百四十二次：新语言对清失败冷却（旧语言对的失败与它无关）
    }
  });
}

let _translator = null;       // 单例 Translator 实例
let _initPromise = null;      // 初始化 Promise（避免并发重复初始化）
let _availability = null;     // 缓存可用性检测结果
// 2026-09-09 第二百四十二次（用户："浏览器翻译需要手势，右键查询等地方加手势再用"）：
//   失败冷却——create 失败（多为无手势 NotAllowedError）后 60s 内 getTranslator 直接
//   返回 null，防止自动注释逐词高频调用反复发起 create；手势入口 primeTranslator()
//   可清冷却强制重试。
let _lastFailTs = 0;          // 上次 create 失败时刻（ms 时间戳，0=无失败记录）
const FAIL_COOLDOWN_MS = 60000;

/**
 * 预热：探测内置翻译模型状态（不创建实例）
 * 2026-09-09 第二百四十二次改语义（原"预加载模型"）：
 *   Chrome 138+ Translator.create() 需要 user activation（官方文档明确要求），content
 *   script 启动时无手势必 NotAllowedError——旧版此处启动即 create 从未成功过，且因
 *   getTranslator 的 _initPromise 失败锁死把之后有手势的重试也堵死。改为仅探测
 *   availability 打日志；实例创建延迟到有手势的入口（th/panel.js 查词/OCR 面板）prime。
 */
function preloadTranslator() {
  if (typeof Translator === 'undefined') return;
  getAvailability().then((avail) => {
    log(`[VocabRadar][translator][${_ts()}] 内置翻译模型状态: ${avail}（实例将在查词等手势入口创建）`);
  }).catch(() => {});
}

/**
 * 检测 Translator API 可用性（基于当前语言对）
 */
export async function getAvailability() {
  if (_availability) return _availability;
  if (typeof Translator === 'undefined') {
    _availability = 'unsupported';
    return _availability;
  }
  try {
    // 反思（2026-08-12）：availability 加 5 秒超时，防止永久挂起
    // 注意（第二百二十五次）：下方对象字面量的两个属性名是 Chrome Translator API 的固定参数名，
    //   不可随本项目改名；其值取 transState 的 learnLang（学习语言）/meaningLang（释义语言）。
    _availability = await withTimeout(
      Translator.availability({
        sourceLanguage: transState.learnLang,
        targetLanguage: transState.meaningLang
      }),
      5000,
      'Translator.availability'
    );
  } catch (e) {
    console.warn(`[VocabRadar][translator][${_ts()}] Translator.availability 失败/超时:`, e);
    _availability = 'unavailable';
  }
  return _availability;
}

export async function getTranslator() {
  if (_translator) return _translator;
  if (typeof Translator === 'undefined') return null;
  // 2026-09-09 第二百四十二次：失败锁死修复——旧版 _initPromise 失败（resolve null）后
  //   从不清空（仅语言对变更时重置），后续所有调用（含有手势的 prime）永远拿到已定格
  //   的 null，渠道终身报废（这就是"浏览器内置翻译从未成功过"的第二根因，第一根因是
  //   启动 preload 无手势 create 必败）。改为：promise 收尾即复位；失败记 _lastFailTs
  //   进 60s 冷却，冷却期内快速 return null（自动注释逐词高频调用不再反复 create）。
  if (!_initPromise && Date.now() - _lastFailTs < FAIL_COOLDOWN_MS) return null;
  if (!_initPromise) {
    _initPromise = _createTranslatorOnce();
  }
  try {
    const translator = await _initPromise;
    if (!translator) _lastFailTs = Date.now();
    return translator;
  } finally {
    _initPromise = null;
  }
}

/**
 * 单次创建 Translator 实例（内部）
 * 2026-09-09 第二百四十二次：合并旧版 downloadable/downloading/available 三态分支。
 *   旧版 downloading 态先轮询 availability 变 available 再 create——多余：W3C 解释稿
 *   与 Chrome 文档均明确 create() 在 downloadable 态触发下载、downloading 态等待进行中
 *   的下载，完成后才 resolve，一处 await 即覆盖三态。超时分级：available（模型已就绪，
 *   本地初始化）15s 足够；downloadable/downloading（要下载 1-2GB 模型）放宽到 300s——
 *   旧版统一 15s 必超时，下载被 race 掉后下次重试继续，模型永远下不完。
 */
async function _createTranslatorOnce() {
  const avail = await getAvailability();
  if (avail === 'unsupported' || avail === 'unavailable') {
    return null;
  }
  const CREATE_TIMEOUT_MS = avail === 'available' ? 15000 : 300000;
  try {
    // 注意（第二百二十五次）：下方对象字面量的两个属性名是 Chrome Translator API 的
    //   固定参数名，不可随本项目改名；其值取 transState 的 learnLang/meaningLang。
    const translator = await withTimeout(
      Translator.create({
        sourceLanguage: transState.learnLang,
        targetLanguage: transState.meaningLang
      }),
      CREATE_TIMEOUT_MS,
      'Translator.create'
    );
    // 第二百四十七次（用户 13:33 github.com 日志：2 秒内 ~100 条"Translator 已就绪"）：
    //   旧版创建成功后从不回写 _translator 单例——getTranslator 每次只读 _translator（恒 null）
    //   就重建新实例，自动注释逐词 translate 高频触发 → 每次 create 成功都打"已就绪"刷屏。
    //   修法：在此唯一创建点回写单例，此后 getTranslator/primeTranslator 直接复用。
    _translator = translator;
    log(`[VocabRadar][translator][${_ts()}] Translator 已就绪 (${transState.learnLang}->${transState.meaningLang}, 模型态:${avail})`);
    return translator;
  } catch (e) {
    console.warn(`[VocabRadar][translator][${_ts()}] Translator.create(${avail}) 失败/超时（无手势场景属预期，查词手势入口会重试）:`, e);
    return null;
  }
}

/**
 * 手势入口 prime：在用户手势上下文中创建 Translator 实例并缓存
 * 2026-09-09 第二百四十二次（用户："浏览器翻译需要手势，右键查询等地方加手势再用"）：
 *   调用时机=th/panel.js 的 showContextPanel（右键菜单查词）与 showOcrResultPanel
 *   （OCR 查词）——两者均由页面内交互触发（右键/按钮点击），距手势 1-3s，transient
 *   activation（约 5s 窗口）仍有效，此处 create 可成功。创建后 translate() 无需手势，
 *   自动注释场景直接复用单例。清冷却强制重试：即使启动探测/上次 create 失败也重试。
 * @returns {Promise<Object|null>} Translator 实例（失败 null，调用方无需 await）
 */
export function primeTranslator(opts = {}) {
  if (typeof Translator === 'undefined') return Promise.resolve(null);
  if (_translator) return Promise.resolve(_translator);
  // 第二百四十三次：force 仅限明确手势入口（右键/OCR 查词面板）——清冷却强制重试。
  //   高频入口（hover 悬浮卡、侧栏展开）须用默认温和模式：自带 60s 冷却防反复空试，
  //   冷却外 create 仍会发起（此时 activation 有效即成功），失败自动续冷却。
  if (opts.force) _lastFailTs = 0;
  return getTranslator().catch(() => null);
}

/**
 * 校验译文是否含目标语言的代表性字符（文字系统）
 * 反思（2026-08-06）：与 service-worker.js targetScriptOk 同逻辑。
 *   精确匹配漏掉"同语言不同词"（en->zh running->run），需文字系统校验。
 *   源/目标同文字系统时（en->es）返回 true（无法区分，回退精确匹配）。
 */
export function targetScriptOk(text, tgt) {
  if (!text) return false;
  const SCRIPT_MAP = {
    zh: '\\u4e00-\\u9fff',
    ja: '\\u3040-\\u309f\\u30a0-\\u30ff\\u4e00-\\u9fff',
    ko: '\\uac00-\\ud7af',
    ru: '\\u0400-\\u04ff', uk: '\\u0400-\\u04ff',
    ar: '\\u0600-\\u06ff', he: '\\u0590-\\u05ff',
    th: '\\u0e00-\\u0e7f',
    el: '\\u0370-\\u03ff',
    hi: '\\u0900-\\u097f', bn: '\\u0980-\\u09ff',
    ta: '\\u0b80-\\u0bff', te: '\\u0c00-\\u0c7f', ml: '\\u0d00-\\u0d7f',
  };
  const range = SCRIPT_MAP[tgt];
  if (!range) return true;
  return new RegExp('[' + range + ']').test(text);
}
