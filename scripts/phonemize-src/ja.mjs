// 河狸记词 · 日语注音入口（片假名，源文件，由 scripts/build-phonemize.mjs 打包）
// 产物：src/lib/vendor/phonemize/phonemize-ja.mjs —— 自包含日语注音包
//   （kuroshiro＋kuromoji 形态分析器打进包；词典 12 个 .dat.gz 不随包，运行时经
//   background SW 中转从 CDN 加载——BrowserDictionaryLoader 的 loadArrayBuffer 被
//   构建脚本 patch 为 chrome.runtime.sendMessage，CDN 回退链见 service-worker.js
//   的 KURO_FETCH）。
//
// 改道说明（2026-09-04，调研 docs/各语言注音npm包调研.md 第一梯队补齐）：
//   旧版走 phonemize JapaneseG2P，输出 IPA；用户原要求"日文用片假名"。
//   现改 kuroshiro（MIT）＋kuroshiro-analyzer-kuromoji（MIT，内含 kuromoji
//   Apache-2.0），convert(text,{to:'katakana'}) 直接输出片假名读法
//   （如 日本語→ニホンゴ）。toIPA 方法名保留（接口与 phonetics.js 对齐，
//   实际返回片假名，见 phonetics.js 头注释的输出体系表）。
// 上下文感知（2026-09-04，用户："查日文单词连带上下文一起查注音"）：
//   日文汉字读音依赖上下文（送假名/活用/连浊/量词），孤立查词先天吃亏。
//   toIPA(text, {context})：context 为所在整句时，先 parse 整句（句级缓存，
//   同句多词复用一次分析），取 surface_form 与词面相同的首个 token 的 reading
//   （已是片假名）；无 context、句中找不到该词、parse 失败时回退单查 convert。
//   局限：同句同面多读音（如 橋/箸同形）只取首个命中，属近似，注释说明。
// 初始化在模块顶层 await 完成（dynamic import 等到就绪才 resolve，
// Chrome 89+/Firefox 89+ 支持模块顶层 await）；dicPath 指向 CDN 主源目录
// （文件名拼接与实际 fetch 见 DictionaryLoader/BrowserDictionaryLoader 的 patch）。
// 非日文输入（无假名/汉字）返回空串——"语言之外不管"，不拿原词充数。
// 片假名原词（如 レミリア）转换结果与原词相同属正常，直接返回（不判空）。
import Kuroshiro from 'kuroshiro';
import Analyzer from 'kuroshiro-analyzer-kuromoji';

const JA_RE = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/;
const KuroshiroCls = Kuroshiro.default || Kuroshiro;
const AnalyzerCls = Analyzer.default || Analyzer;

const _kuroshiro = new KuroshiroCls();
const _analyzer = new AnalyzerCls({
  // 词典 CDN 主源（12 个 .dat.gz；回退链 cdn→fastly→gcore jsdelivr→unpkg 在 SW 的
  // KURO_FETCH 内做——此处给主源完整 URL，SW 端按路径白名单换源重试）
  dictPath: 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/',
});
await _kuroshiro.init(_analyzer);

// 句级分析缓存：sentence -> tokens[]（同句多词复用一次 parse；FIFO 上限，防长视频堆积）
const _sentCache = new Map();
const SENT_CACHE_LIMIT = 30;
function _parseCached(sentence) {
  const hit = _sentCache.get(sentence);
  if (hit) return hit;
  const p = _analyzer.parse(sentence).catch(() => null);
  if (_sentCache.size >= SENT_CACHE_LIMIT) {
    const oldest = _sentCache.keys().next();
    if (!oldest.done) _sentCache.delete(oldest.value);
  }
  _sentCache.set(sentence, p);
  return p;
}

export default {
  async toIPA(text, opts) {
    const s = String(text || '').trim();
    if (!s || !JA_RE.test(s)) return '';
    const ctx = opts && typeof opts.context === 'string' ? opts.context.trim() : '';
    // 上下文感知：整句含该词且非整句直查时，走句 parse 取 token 读法
    if (ctx && ctx !== s && ctx.includes(s)) {
      try {
        const tokens = await _parseCached(ctx);
        if (Array.isArray(tokens)) {
          for (const tk of tokens) {
            if (tk && tk.surface_form === s && typeof tk.reading === 'string' && tk.reading) {
              return tk.reading.trim();
            }
          }
        }
      } catch (_) { /* 回退单查 */ }
    }
    const out = await _kuroshiro.convert(s, { to: 'katakana' });
    return typeof out === 'string' ? out.trim() : '';
  },
};
