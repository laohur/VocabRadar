// 河狸记词 · phonemize 俄语入口（源文件，由 scripts/build-phonemize.mjs 打包）
// 产物：src/lib/vendor/phonemize/phonemize-ru.mjs —— 自包含俄语注音包。
// 俄语 G2P（default 导出），音译 + 启发式重音与元音弱化，官方标注 Approximate（近似）。
// core 引擎走相对路径 ./core.mjs（构建时 external，见 build-phonemize.mjs）。
import { createPhonemizer } from './core.mjs';
import RussianG2P from 'phonemize/ru-g2p';

export default createPhonemizer({ processors: [new RussianG2P()] });
