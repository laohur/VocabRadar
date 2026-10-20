// =============================================================================
// 卡片相关词汇行（第561次，src/content/th/card-related.js）
// 用户裁定："单词条目增加相关词汇……展开选出十个向量最近的五个词汇。这两个都需要
//   查询或者计算，可以异步出。"——本模块把相关词汇（WordEmbedding 向量近邻，SW 端
//   word-db/embeddings-engine.js 计算、d_rel 行缓存）异步渲染进查询卡/悬浮卡。
// 单词门控在此兜底（多词/整段查询不查相关词汇）；结果为空或查询失败整行隐藏，
//   不留空行不报错弹窗（与 trans-row 失败留空同口径）。
// 自包含模块：仅依赖 word-db 门面 + i18n，语言态自读 storage（th 模块各自读 storage
//   惯例，panel.js 同款，不跨模块搬状态）。
// =============================================================================
import { relatedWords } from '../../lib/word-db.js';

// 学习语言（相关词汇按 learnLang 语料的向量包计算），storage 初始读取 + onChanged 跟随
let _learnLang = 'en';
try {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({ learnLanguage: 'en' }, (res) => {
      if (res && typeof res.learnLanguage === 'string' && res.learnLanguage) _learnLang = res.learnLanguage;
    });
    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.learnLanguage && typeof changes.learnLanguage.newValue === 'string' && changes.learnLanguage.newValue) {
          _learnLang = changes.learnLanguage.newValue;
        }
      });
    }
  }
} catch (_) { /* 非扩展上下文默认 en */ }

/**
 * 异步填充卡片相关词汇行（悬浮提示与右键面板/内嵌卡共用——root 内含 buildCardInnerHTML 结构）
 * 第561次三轮（用户裁定"相关词汇等候太长，不要浮动省略号特效"）：结果到达前整行
 *   不显示（无占位动画），到词即原位出现；空结果/失败整行隐藏，与 trans-row 失败
 *   留空同口径。字段名在 buildCardInnerHTML 的 .kv-label 静态列，本函数只写 .kv-value。
 * @param {Element|ShadowRoot} root 卡片根
 * @param {string} word 查询词（原文即可，内部小写化）
 * @param {{alive?: () => boolean, refresh?: () => void}} [opts] alive=写入守卫
 *   （过期异步不覆盖新查询）；refresh=内容到达后的位置/尺寸刷新回调（浮动面板用）
 */
export function fillRelated(root, word, opts) {
  if (!root || !root.querySelector) return;
  const lower = String(word || '').trim().toLowerCase();
  // 单词门控（与 isMultiWordText 同口径兜底）：多词/整段无单词条目，不查相关词汇
  if (!lower || /\s/.test(lower)) return;
  const row = root.querySelector('.related-row');
  if (!row) return;
  const value = row.querySelector('.kv-value');
  if (!value) return;
  const alive = (opts && typeof opts.alive === 'function') ? opts.alive : () => true;
  const refresh = (opts && typeof opts.refresh === 'function') ? opts.refresh : null;
  // 等待期整行隐藏（无占位特效；首次查询可能含向量包下载，卡片不阻塞交互）
  row.style.display = 'none';
  value.textContent = '';
  relatedWords(_learnLang, lower).then((r) => {
    if (!alive()) return;
    const words = (r && r.ok && Array.isArray(r.words)) ? r.words : [];
    if (!words.length) {
      // 空=词表外/全零向量/近邻全为同族——如实隐藏整行，不显示歧义文案
      row.style.display = 'none';
      value.textContent = '';
      if (refresh) refresh();
      return;
    }
    value.textContent = words.join(', ');
    row.style.display = '';
    if (refresh) refresh();
  }).catch(() => {
    if (!alive()) return;
    row.style.display = 'none';
    value.textContent = '';
  });
}
