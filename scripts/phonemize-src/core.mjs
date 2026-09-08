// 河狸记词 · phonemize 共享核心 stub（源文件，由 scripts/build-phonemize.mjs 打包）
// 产物：src/lib/vendor/phonemize/core.mjs —— 无 hash 定名，供语言包以相对路径
// `./core.mjs` 引用（构建时 external，不内联进语言包）。
//
// 现状（2026-09-04）：仅 en/ru 走 phonemize 规则式 G2P 需要此引擎；
// zh/ja/ko（pinyin-pro/kuroshiro/koroman）与 es/fr/pt/sv（@piper-plus/g2p）
// 均不依赖 phonemize/core，不 import 本文件。
export { createPhonemizer } from 'phonemize/core';
