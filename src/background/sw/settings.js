// =============================================================================
// SW 默认设置与 config.json 易坏参数
// 唯一属主：DEFAULT_SETTINGS 只在本文件定义与改写（applyConfigDefaults 覆盖），
//   lifecycle（onInstalled 写 storage）读取同一份对象，绝不复制第二份。
// 与 popup.js DEFAULTS / CONFIG_KEYS 保持一致（集中管理易坏参数）。
// =============================================================================
import { _ts, log } from './log.js';

export const DEFAULT_SETTINGS = {
  learnLanguage: 'en',
  meaningLanguage: 'zh',
  // 用户裁定"调整词频就能凸显，不应更改默认值"。默认 5000，popup.js DEFAULTS /
  //   config.json 已同步。
  rankThreshold: 5000,
  // 上界补入出厂落盘（用户反馈"Maximum Frequency Rank 要等很久才会赋值"）：storage
  //   缺键时引导页 get(null) 重渲染（subtitleCustom 首写回等触发）会把初渲染值清成
  //   空框，占位符 ∞ 要等词典 ensureReady 完成才变词典实际上界；落盘后不再清空。
  //   0=未设上界（用户裁定"改回原来的5000-∞"）。
  rankThresholdMax: 0,
  // textHintEnabled 默认 true（用户反馈"所有浏览器网页中丢了文本提示"——默认 false 时
  //   onInstalled 写入 storage 后 text-hint.js 读到 false 不启动），与 popup.js /
  //   text-hint.js 默认值一致，开箱即用。
  textHintEnabled: true,
  // 文本提示配色：首次/后续 各自 开关+背景+前景
  // 默认背景色 MD3 primary 马卡龙深绿 #2e6b43，符合"文本提示默认颜色跟侧栏色系一致，
  //   包括背景色"（用户要求）。
  hintFirstEnabled: true,
  // 用户裁定"默认样式改回绿背景"：出厂配色绿底白字；池默认常量 green-wave（本键是
  //   文本提示直配兜底，池指派后 pickColors 压过它，值不随常量动）；存量 storage
  //   有值不受影响（stored 优先）。
  hintFirstBg: '#2e6b43',
  hintFirstFg: '#ffffff',
  // 默认 false，与 popup.js「生词多次出现 复选框 默认空」（用户裁定）及
  //   text-hint.js DEFAULTS 对齐；存量用户 storage 已有值不受影响（stored 优先）。
  hintLaterEnabled: false,
  hintLaterBg: '#2e6b43',
  hintLaterFg: '#ffffff',
  // 键名由 localTranslateEnabled 改为 annotateOov（用户指出原键名"本地翻译开关"与
  //   实际功能——是否注释表外单词，rank=null 兜底翻译——无关）。默认 false。
  annotateOov: false,          // 是否注释表外词（词频词典之外的单词），默认不选
  uiLanguage: 'en',             // 界面语言，默认英文
  // 默认档 large-v3-turbo（与后端 config.asr.whisper_model 默认一致）
  asrModelSize: 'large-v3-turbo'  // ASR 模型大小（从 config.json 读取覆盖）
};

// 易坏参数键名（从 config.json 读取覆盖 DEFAULT_SETTINGS）
// 与 popup.js CONFIG_KEYS 保持一致，集中管理易坏参数
//   （rankThresholdMax 例外：仅引导页/内容端消费，popup 无此控件，不入 popup CONFIG_KEYS）
const CONFIG_KEYS = ['rankThreshold', 'rankThresholdMax', 'rankStep', 'asrModelSize', 'annotateOov'];

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
