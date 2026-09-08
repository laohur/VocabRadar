// 河狸记词 · phonemize 英语入口（源文件，由 scripts/build-phonemize.mjs 打包）
// 产物：src/lib/vendor/phonemize/phonemize-en.mjs —— 自包含英语注音包。
// 英语 G2P（named+default 双导出），词典 exceptions/homographs/compound-parts 由 esbuild 内联。
// core 引擎走相对路径 ./core.mjs（构建时 external，见 build-phonemize.mjs——多语言共享
// 文件统一为 core.mjs，不再由 splitting 自动抽 chunk-*）。
import { createPhonemizer } from './core.mjs';
import { EnglishG2P } from 'phonemize/en-g2p';

export default createPhonemizer({ processors: [new EnglishG2P()] });
