// 河狸记词 · 法语注音入口（源文件，由 scripts/build-phonemize.mjs 打包）
// 产物：src/lib/vendor/phonemize/phonemize-fr.mjs —— 自包含法语注音包。
// @piper-plus/g2p FrenchG2P（MIT，纯规则零依赖）：phonemize(text) 返回
// {tokens}（单字符 IPA 数组，鼻化元音走 PUA：E056=ɛ̃、E057=ɑ̃、E058=ɔ̃、
// E063=œ̃；E01E 是内部标签 y_vowel，非 IPA，手动兜成 y）。
// PUA 经同包 pua-map.js 的 unmapToken 解回标准 IPA（相对路径直引，
// 不走包 exports——exports 未暴露 ./pua-map 子路径，走 index 会连带打入日语 WASM）。
// default 导出 { toIPA }，与 phonetics.js ensureBundle 的接口约定一致。
import { FrenchG2P } from '@piper-plus/g2p/fr';
import { unmapToken } from '../node_modules/@piper-plus/g2p/src/pua-map.js';

const _inst = new FrenchG2P();

export default {
  toIPA(text) {
    const r = _inst.phonemize(String(text || ''));
    const toks = (r && r.tokens) || [];
    // 反思（2026-09-04）：实测 bonjour → b+E058+ʒuʁ，unmapToken 解 E058→ɔ̃；
    // E01E 解出的是内部标签 'y_vowel'（7 个字母，非 IPA），此处手动兜成 y。
    return toks.map((tk) => (tk === 'y_vowel' ? 'y' : unmapToken(tk))).join('');
  },
};
