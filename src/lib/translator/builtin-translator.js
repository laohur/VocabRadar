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
    }
  });
}

let _translator = null;       // 单例 Translator 实例
let _initPromise = null;      // 初始化 Promise（避免并发重复初始化）
let _availability = null;     // 缓存可用性检测结果

/**
 * 预加载 Translator 模型
 * content script 启动时调用，后台异步下载，不阻塞页面
 * 独立于任何开关--模型常驻，翻译能力常开
 */
function preloadTranslator() {
  if (_translator || _initPromise) return;
  if (typeof Translator === 'undefined') return;
  // 异步触发 getTranslator，不 await（后台下载）
  getTranslator().catch(() => {});
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
    // 注意（第二百二十五次）：sourceLanguage/targetLanguage 是 Chrome Translator API 的固定参数名，
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
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const avail = await getAvailability();
    if (avail === 'unsupported' || avail === 'unavailable') {
      return null;
    }
    // downloadable 状态直接尝试 create()
    //   - content script 在用户激活上下文（用户已点击页面）中可能成功
    //   - 失败（无用户手势）则回退到在线渠道
    //   downloading 状态等待完成（轮询 availability）
    if (avail === 'downloadable') {
      log(`[VocabRadar][translator][${_ts()}] Translator 模型可下载, 尝试 create()...`);
      try {
        // 反思（2026-08-12）：create 加 15 秒超时（模型下载可能较慢，但不允许永久挂起）
        _translator = await withTimeout(
          Translator.create({
            sourceLanguage: transState.learnLang,
            targetLanguage: transState.meaningLang
          }),
          15000,
          'Translator.create(downloadable)'
        );
        log(`[VocabRadar][translator][${_ts()}] Translator 已就绪 (${transState.learnLang}->${transState.meaningLang})`);
        return _translator;
      } catch (e) {
        console.warn(`[VocabRadar][translator][${_ts()}] Translator.create 失败/超时（可能需用户手势，回退在线渠道）:`, e);
        return null;
      }
    }
    if (avail === 'downloading') {
      log(`[VocabRadar][translator][${_ts()}] Translator 模型下载中, 等待完成...`);
      // 轮询等待下载完成（最多 30 秒）
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const newAvail = await Translator.availability({
          sourceLanguage: transState.learnLang,
          targetLanguage: transState.meaningLang
        });
        if (newAvail === 'available') {
          try {
            // 反思（2026-08-12）：下载后 create 加 15 秒超时
            _translator = await withTimeout(
              Translator.create({
                sourceLanguage: transState.learnLang,
                targetLanguage: transState.meaningLang
              }),
              15000,
              'Translator.create(downloading)'
            );
            log(`[VocabRadar][translator][${_ts()}] Translator 下载完成已就绪 (${transState.learnLang}->${transState.meaningLang})`);
            return _translator;
          } catch (e) {
            console.warn(`[VocabRadar][translator][${_ts()}] 下载后 create 失败/超时:`, e);
            return null;
          }
        }
      }
      console.warn(`[VocabRadar][translator][${_ts()}] Translator 下载超时（30秒）`);
      return null;
    }
    try {
      // 反思（2026-08-12）：available 状态下 create 加 15 秒超时
      _translator = await withTimeout(
        Translator.create({
          sourceLanguage: transState.learnLang,
          targetLanguage: transState.meaningLang
        }),
        15000,
        'Translator.create(available)'
      );
      log(`[VocabRadar][translator][${_ts()}] Translator 已就绪 (${transState.learnLang}->${transState.meaningLang})`);
      return _translator;
    } catch (e) {
      console.warn(`[VocabRadar][translator][${_ts()}] Translator.create 失败/超时:`, e);
      return null;
    }
  })();

  return _initPromise;
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
