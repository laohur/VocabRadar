// 文本总结模块
// 优先使用浏览器内置 Summarizer API（Chrome 138+），不可用时回退 transformers.js。
// 符合"web-ai-toolkit"思路：内置 AI API 优先，本地模型兜底。

let _summarizer = null;
let _initPromise = null;
let _availability = null;

/**
 * 检测 Summarizer API 可用性
 */
export async function getAvailability() {
  if (_availability) return _availability;
  if (typeof Summarizer === 'undefined') {
    _availability = 'unsupported';
    return _availability;
  }
  try {
    _availability = await Summarizer.availability();
  } catch (e) {
    console.warn('[VocabRadar][summarizer] Summarizer.availability 失败:', e);
    _availability = 'unavailable';
  }
  return _availability;
}

async function getSummarizer(opts) {
  if (_summarizer) return _summarizer;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const avail = await getAvailability();
    if (avail === 'unsupported' || avail === 'unavailable') return null;
    try {
      _summarizer = await Summarizer.create({
        type: opts.type || 'keypoints',
        format: opts.format || 'markdown',
        length: opts.length || 'medium',
        monitor(m) {
          m.addEventListener('downloadprogress', () => { /* 静默 */ });
        }
      });
      return _summarizer;
    } catch (e) {
      console.warn('[VocabRadar][summarizer] Summarizer.create 失败:', e);
      return null;
    }
  })();
  return _initPromise;
}

// === transformers.js 兜底 ===
let _transformersPipeline = null;
async function getTransformersFallback() {
  if (_transformersPipeline) return _transformersPipeline;
  try {
    const url = chrome.runtime.getURL('src/lib/vendor/transformers.mjs');
    const mod = await import(url);
    const pipeline = mod.pipeline || mod.default?.pipeline;
    if (!pipeline) return null;
    // 总结任务用 text2text-generation（如 BART/T5）
    _transformersPipeline = await pipeline('summarization', 'Xenova/distilbart-cnn-6-6', { quantized: true });
    return _transformersPipeline;
  } catch (e) {
    console.warn('[VocabRadar][summarizer] transformers.js 总结模型加载失败:', e);
    return null;
  }
}

// 简易抽取式兜底：取前 N 句 + 关键词高亮，避免模型不可用时完全无结果
function extractiveFallback(text, maxSentences = 5) {
  const sentences = text.split(/(?<=[.!?。！？])\s+/).filter((s) => s.trim().length > 0);
  if (sentences.length <= maxSentences) return text.trim();
  // 简单按出现顺序取前 N 句
  return sentences.slice(0, maxSentences).join(' ');
}

/**
 * 总结文本
 * @param {string} text 输入文本
 * @param {{type?:string, format?:string, length?:string}} opts
 * @returns {Promise<string|null>}
 */
export async function summarize(text, opts = {}) {
  if (!text || !text.trim()) return null;
  // 截断超长文本（Summarizer API 有限制）
  const input = text.slice(0, 8000);

  // 1. 内置 Summarizer API
  try {
    const summarizer = await getSummarizer(opts);
    if (summarizer) {
      const result = await summarizer.summarize(input);
      if (result && result.trim()) return result.trim();
    }
  } catch (e) {
    console.warn('[VocabRadar][summarizer] Summarizer.summarize 失败, 尝试兜底:', e);
  }

  // 2. transformers.js 兜底
  try {
    const pipeline = await getTransformersFallback();
    if (pipeline) {
      const output = await pipeline(input, { max_length: 120, min_length: 30 });
      const txt = Array.isArray(output) ? output[0]?.summary_text : output?.summary_text;
      if (txt && txt.trim()) return txt.trim();
    }
  } catch (e) {
    console.warn('[VocabRadar][summarizer] transformers.js 总结失败:', e);
  }

  // 3. 抽取式兜底
  const fb = extractiveFallback(input);
  return fb || null;
}
