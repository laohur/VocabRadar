// 河狸记词 · 葡语注音入口（源文件，由 scripts/build-phonemize.mjs 打包）
// 产物：src/lib/vendor/phonemize/phonemize-pt.mjs —— 自包含葡语注音包。
// @piper-plus/g2p PortugueseG2P（MIT，纯规则零依赖，巴西葡语口音；
// TRANSLATE_LANGS 的 pt 取巴西口音，与 ipa-dict pt_BR 对齐）。
// phonemize(text) 返回 {tokens}（t/d 腭化走 PUA：E054=tʃ、E055=dʒ，
// 鼻化 E064=ɐ̃），经 pua-map.js unmapToken 解回标准 IPA（相对路径直引，
// 不走包 exports——exports 未暴露 ./pua-map 子路径，走 index 会连带打入日语 WASM）。
// default 导出 { toIPA }，与 phonetics.js ensureBundle 的接口约定一致。
import { PortugueseG2P } from '@piper-plus/g2p/pt';
import { unmapToken } from '../node_modules/@piper-plus/g2p/src/pua-map.js';

const _inst = new PortugueseG2P();

export default {
  toIPA(text) {
    const r = _inst.phonemize(String(text || ''));
    const toks = (r && r.tokens) || [];
    return toks.map((tk) => unmapToken(tk)).join('');
  },
};
