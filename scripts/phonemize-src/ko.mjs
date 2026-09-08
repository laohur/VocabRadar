// 河狸记词 · 韩语注音入口（罗马字，源文件，由 scripts/build-phonemize.mjs 打包）
// 产物：src/lib/vendor/phonemize/phonemize-ko.mjs —— 自包含韩语注音包。
//
// 改道说明（2026-09-04，调研 docs/各语言注音npm包调研.md 第一梯队补齐）：
//   旧版走 phonemize KoreanG2P，输出 IPA（如 annjʌŋhaseyo）；现改 koroman
//   （MIT，国立国语院标准＋连音/鼻音化等发音规则，默认开启）直接输出罗马字
//   （如 annyeonghaseyo），可读性更高。toIPA 方法名保留（接口与
//   phonetics.js 对齐，实际返回罗马字，见 phonetics.js 头注释的输出体系表）。
// 非谚文输入返回空串（learnLanguage=ko 的页面上出现英文词时，不拿原词充数）。
import { romanize } from 'koroman';

const HANGUL_RE = /[\uac00-\ud7af]/;

export default {
  toIPA(text) {
    const s = String(text || '').trim();
    if (!s || !HANGUL_RE.test(s)) return '';
    const out = romanize(s);
    if (typeof out !== 'string') return '';
    const t = out.trim();
    if (!t || t.toLowerCase() === s.toLowerCase()) return '';
    return t;
  },
};
