// =============================================================================
// SW 默认设置与 config.json 易坏参数（2026-09-27 拆分自 service-worker.js）
// 唯一属主：DEFAULT_SETTINGS 只在本文件定义与改写（applyConfigDefaults 覆盖），
//   lifecycle（onInstalled 写 storage）读取同一份对象，绝不复制第二份。
// 与 popup.js DEFAULTS / CONFIG_KEYS 保持一致（集中管理易坏参数）。
// =============================================================================
import { _ts, log } from './log.js';

export const DEFAULT_SETTINGS = {
  learnLanguage: 'en',
  meaningLanguage: 'zh',
  // 反思（2026-08-14 第五十四次修正）：用户裁定"调整词频就能凸显，不应更改默认值"。
  //   2026-09-29（用户："默认提示4000-5000词频"）：默认改 4000，配 config.json
  //   rankThresholdMax=5000（上界出厂值），popup.js DEFAULTS 已同批同步。
  rankThreshold: 4000,
  // 第二百二十五次：删除死键 subtitleOverlay（SW install 写入、全库零读取，《命名清查》裁定）。
  // 反思（2026-08-12）：用户反馈"所有浏览器网页中丢了文本提示"。
  //   旧版 textHintEnabled: false，onInstalled 写入 storage 后 text-hint.js 读取到 false 不启动。
  //   修正：改为 true，与 popup.js / text-hint.js 默认值一致，开箱即用。
  textHintEnabled: true,
  // 文本提示配色：首次/后续 各自 开关+背景+前景
  // 反思（2026-07-08 MD3 重构）：默认背景色改为 MD3 primary 马卡龙深绿 #2e6b43
  //   （原 #5a8a6a 河狸棕绿），符合"文本提示默认颜色跟侧栏色系一致，包括背景色"。
  hintFirstEnabled: true,
  // 第502次（用户"默认样式改回绿背景"）：回退第501次误改的透明底/'inherit'——
  //   出厂配色回绿底白字；第503次：池默认常量终裁 green-wave（本键是文本提示直配
  //   兜底，池指派后 pickColors 压过它，故值不随常量动，仅注释更正锚点描述）；
  //   存量 storage 有值不受影响（stored 优先）。
  hintFirstBg: '#2e6b43',
  hintFirstFg: '#ffffff',
  // 326次：默认改 false——与 popup.js:110「生词多次出现 复选框 默认空」（08-05 用户裁定）
  //   及 text-hint.js DEFAULTS 对齐；旧版 true 致新装用户开箱即多处高亮。
  //   存量用户 storage 已有值不受影响（onInstalled 合并 stored 优先）。
  hintLaterEnabled: false,
  hintLaterBg: '#2e6b43',
  hintLaterFg: '#ffffff',
  // 反思（2026-08-14 第五十四次修正）：设置键改名 localTranslateEnabled → annotateOov。
  //   原键名"本地翻译开关"与实际功能（是否注释表外单词，rank=null 兜底翻译）无关，
  //   用户指出命名错误。默认 false（注释表外词默认不选）。
  annotateOov: false,          // 是否注释表外词（词频词典之外的单词），默认不选
  uiLanguage: 'en',             // 界面语言，默认英文
  // 第419次：默认档 tiny → large-v3-turbo（与后端 config.asr.whisper_model 默认一致）
  asrModelSize: 'large-v3-turbo'  // ASR 模型大小（从 config.json 读取覆盖）
};

// 易坏参数键名（从 config.json 读取覆盖 DEFAULT_SETTINGS）
// 反思（2026-08-03）：与 popup.js CONFIG_KEYS 保持一致，集中管理易坏参数
const CONFIG_KEYS = ['rankThreshold', 'rankStep', 'asrModelSize', 'annotateOov'];

/**
 * 从 config.json 读取易坏参数，覆盖 DEFAULT_SETTINGS
 * 失败时用 DEFAULT_SETTINGS 兜底，不影响功能
 */
export async function applyConfigDefaults() {
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
