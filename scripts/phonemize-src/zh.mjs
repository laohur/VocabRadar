// 河狸记词 · 中文注音入口（拼音，源文件，由 scripts/build-phonemize.mjs 打包）
// 产物：src/lib/vendor/phonemize/phonemize-zh.mjs —— 自包含中文注音包。
//
// 改道说明（2026-09-04，调研 docs/各语言注音npm包调研.md 第一梯队补齐）：
//   旧版走 phonemize ChineseG2P，输出 IPA 声调曲线（如 ni˧˩˧），用户看不懂
//   （声调字母 ˧˨˩ 非常用字体缺字形，且与"汉语用拼音"的要求不符）。
//   现改 pinyin-pro（MIT，phonemize 的底层依赖，无新增依赖）直接输出拼音
//   （tone symbol，如 nǐ hǎo），toIPA 方法名保留（接口与 phonetics.js 对齐，
//   实际返回拼音，见 phonetics.js 头注释的输出体系表）。
// 非汉字输入返回空串（learnLanguage=zh 的页面上出现英文词时，不拿原词充数）。
import { pinyin } from 'pinyin-pro';

const HAN_RE = /[\u4e00-\u9fff]/;

export default {
  toIPA(text) {
    const s = String(text || '').trim();
    if (!s || !HAN_RE.test(s)) return '';
    const out = pinyin(s, { toneType: 'symbol' });
    if (typeof out !== 'string') return '';
    const t = out.trim();
    if (!t || t.toLowerCase() === s.toLowerCase()) return '';
    return t;
  },
};
