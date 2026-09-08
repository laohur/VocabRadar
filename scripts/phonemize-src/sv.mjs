// 河狸记词 · 瑞典语注音入口（源文件，由 scripts/build-phonemize.mjs 打包）
// 产物：src/lib/vendor/phonemize/phonemize-sv.mjs —— 自包含瑞典语注音包。
// @piper-plus/g2p SwedishG2P（MIT，纯规则零依赖）：phonemize(text) 返回
// {tokens}（长元音走 PUA：E059=iː … E061=ʉː），经 pua-map.js unmapToken
// 解回标准 IPA（相对路径直引，不走包 exports——exports 未暴露 ./pua-map
// 子路径，走 index 会连带打入日语 WASM）。
// default 导出 { toIPA }，与 phonetics.js ensureBundle 的接口约定一致。
import { SwedishG2P } from '@piper-plus/g2p/sv';
import { unmapToken } from '../node_modules/@piper-plus/g2p/src/pua-map.js';

const _inst = new SwedishG2P();

export default {
  toIPA(text) {
    const r = _inst.phonemize(String(text || ''));
    const toks = (r && r.tokens) || [];
    return toks.map((tk) => unmapToken(tk)).join('');
  },
};
