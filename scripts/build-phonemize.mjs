// 河狸记词 · phonemize 按语言拆包构建脚本
//
// 功能（2026-09-04 改造"chunk 零碎统一为 core"，docs/多语言注音方案调研.md 方案 B）：
//   把 npm phonemize@2.0.0 打成"一种语言一个 ESM 文件"，输出到
//   src/lib/vendor/phonemize/，替换旧的整包 phonemize-bundle.mjs（5.39MB，
//   超 Firefox addons-linter 单 JS 文件 5MB 解析上限，且词典重复内嵌、无生成
//   脚本不可复现——见调研文档"本地取证"一节）。
//
// 产物结构（手工 core + external；不再用 splitting 自动抽 chunk）：
//   core.mjs                       共享核心引擎（phonemize/core + anyascii 音译表），
//                                  无 hash 定名；仅 en/ru 走规则式 G2P 引用它。
//   phonemize-{en,zh,ja,ko,ru,es,fr,pt,sv}.mjs   每语言入口（default 导出
//     { toIPA } 注音实例：en/ru import './core.mjs'；zh 走 pinyin-pro 直接
//     输出拼音；ja 走 kuroshiro+kuromoji；ko 走 koroman 输出罗马字；
//     es/fr/pt/sv 走 @piper-plus/g2p 规则式 G2P（tokens 经 pua-map
//     unmapToken 解回标准 IPA）；法语鼻化元音 PUA（E056-E058）与内部标签
//     y_vowel 在 fr 入口内兜底）。
//   全部普通 ESM 文件：内容脚本 import(chrome.runtime.getURL(...)) 加载，
//   不走 blob/解压，宿主页 CSP 无涉；单文件均远低于 5MB 解析上限。
//
// 为何弃用 splitting（2026-09-04）：esbuild splitting 自动抽 chunk 的数量与
// 归组不可控，曾产出 4 个 chunk-*（两个 1.7KB 零碎 + 0.8KB CJS 垫片）。
// 改为 core 单独构建 + 语言包 external:['./core.mjs']，恰好一个共享文件，
// 懒加载语义零变化（zh/ja/ko/es/fr/pt/sv 完全自包含，不被 core 牵连）。
// charset:'utf8'：esbuild 默认 ascii 会把非 ASCII 转成 \uXXXX（如 IPA 字符
// ɑ → 6 字节、å → 4 字节），utf8 原生输出更小（实测全包 -180KB）；ESM 规范
// 强制按 UTF-8 解码，扩展资源本地加载，无编码事故风险。
//
// 用法：node scripts/build-phonemize.mjs（build.mjs 构建时自动调用；
//       esbuild 缺失时本脚本报错退出——按"不遮蔽错误"原则不静默回退）。

import * as esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const srcDir = path.join(scriptDir, 'phonemize-src');
const outDir = path.join(repoRoot, 'src', 'lib', 'vendor', 'phonemize');
const languages = ['en', 'zh', 'ja', 'ko', 'ru', 'es', 'fr', 'pt', 'sv'];
const CORE_FILE = 'core.mjs';

// 自清扫（2026-09-04）：构建前删光 outDir 内旧 .mjs（路径含 vendor/phonemize
// 才敢删，防误删）。旧 splitting 版 chunk-*.mjs、旧 hash 产物一并清掉。
if (!outDir.includes(path.join('vendor', 'phonemize'))) {
  console.error('[build-phonemize] outDir 异常，拒绝清扫：' + outDir);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) {
  if (f.endsWith('.mjs')) fs.unlinkSync(path.join(outDir, f));
}

// kuromoji 词典 CDN 化 patch（2026-09-08，词典不随包、扩展包省约 17MB）：node_modules
// 不进 git，重装依赖后改动会回来，故两处 patch 均幂等（重复构建零变化）。必须在首个
// esbuild.build 之前执行——esbuild 打包 ja 入口时读的就是这份源码（时序教训见旧版
// .dat.bin patch 注释，2026-09-04）。
//   patch A（DictionaryLoader.js）：
//     A1 文件名恢复 .dat.gz——CDN 是原生 gzip 命名；旧版 Edge 适配曾改 .dat.bin，
//        Edge 问题随词典下架一并消失，重装 node_modules 后天然是 .dat.gz，此处幂等反向。
//     A2 4 处 path.join(dic_path, ...) 换成字符串拼接 dic_path + ...：path-browserify
//        的 join/normalize 会把 URL 里 '://' 折叠成 ':/'（实测实锤），产出畸形 URL
//        （chrome-extension:/…、https:/…）导致 XHR 404——旧本地词典形态即踩此坑，
//        ja 注音一旦失败在 phonetics.js 只静默回空串，极难察觉。CDN URL 更经不起折叠。
//   patch B（BrowserDictionaryLoader.js）：loadArrayBuffer（基类只 throw，本类覆写为
//     XHR）改为经 background SW 中转 fetch：content script 的 XHR 受宿主页面 CSP
//     connect-src 约束（B站/YouTube 等不放行 CDN 域），SW 的 fetch 不受限。
//     __KURO_SW_RELAY__ 标记保证幂等。
const dictLoaderPath = path.join(repoRoot, 'scripts', 'node_modules', 'kuromoji', 'src', 'loader', 'DictionaryLoader.js');
if (!fs.existsSync(dictLoaderPath)) {
  console.error('[build-phonemize] 未找到 kuromoji DictionaryLoader.js（依赖缺失？）：' + dictLoaderPath);
  process.exit(1);
}
{
  const before = fs.readFileSync(dictLoaderPath, 'utf8');
  let after = before.replace(/\.dat\.bin/g, '.dat.gz');
  after = after.replace(/path\.join\(dic_path,\s*("[^"]+")\)/g, 'dic_path + $1');
  if (after !== before) {
    fs.writeFileSync(dictLoaderPath, after);
    console.log('[build-phonemize] 已 patch DictionaryLoader.js：文件名恢复 .dat.gz + path.join 改字符串拼接');
  }
}
const browserLoaderPath = path.join(repoRoot, 'scripts', 'node_modules', 'kuromoji', 'src', 'loader', 'BrowserDictionaryLoader.js');
const KURO_MARK = '__KURO_SW_RELAY__';
const KURO_LOADER_BODY = `BrowserDictionaryLoader.prototype.loadArrayBuffer = function (url, callback) {
    /* ${KURO_MARK}：VocabRadar 构建时注入（scripts/build-phonemize.mjs），勿手改。
       词典 12 个 .dat.gz 改从 CDN 加载并经 background SW 中转：content script 的 XHR
       受宿主页面 CSP connect-src 约束（B站/YouTube 等不放行 CDN 域），SW 的 fetch
       不受限。SW 直传 ArrayBuffer（结构化克隆，Chrome 102+；2026-09-08 去 base64
       转换），内容仍是 gzip 原始字节，gunzip 由 kuromoji 自己做。 */
    chrome.runtime.sendMessage({ type: "KURO_FETCH", url: url }, function (resp) {
        if (!resp || !resp.ok) {
            callback(new Error((resp && resp.error) || "KURO_FETCH: no response"), null);
            return;
        }
        var gz = new zlib.Zlib.Gunzip(new Uint8Array(resp.data));
        callback(null, gz.decompress().buffer);
    });
};`;
{
  const before = fs.readFileSync(browserLoaderPath, 'utf8');
  const re = /BrowserDictionaryLoader\.prototype\.loadArrayBuffer = function \(url, callback\) \{[\s\S]*?\n\};/;
  if (!re.test(before)) {
    console.error('[build-phonemize] BrowserDictionaryLoader.js loadArrayBuffer 形态不识别（上游升级？），拒绝盲改');
    process.exit(1);
  }
  // 2026-09-08：改为“总是按正则替换函数体”。旧逻辑 KURO_MARK 存在即跳过，
  //   导致修改 KURO_LOADER_BODY 后重建不生效；替换结果与现文件相同时零写盘，幂等。
  const replaced = before.replace(re, () => KURO_LOADER_BODY);
  if (replaced !== before) {
    fs.writeFileSync(browserLoaderPath, replaced);
    console.log('[build-phonemize] 已 patch BrowserDictionaryLoader.js：loadArrayBuffer → SW 中转（直传 ArrayBuffer）');
  }
}

// 反思（2026-09-04）：kuromoji（ja 片假名链路）DictionaryLoader.js 顶部仍
// require("path")（拼词典路径用的模块，2026-09-08 起调用点虽已 patch 成字符串拼接，
// require 语句还在），browser 平台下 esbuild 无法解析 node 内建模块。
// 用 path-browserify 别名顶上（纯字符串拼接，无 node API，浏览器可用）。
// 注：alias 按 CWD 解析，而构建在仓库根执行，故此处用绝对路径（裸包名够不着
// scripts/node_modules，实测报错 "couldn't be resolved"）。
const alias = { path: path.join(scriptDir, 'node_modules', 'path-browserify') };

// 第一步：单独构建 core.mjs（无 hash 定名，语言包按固定文件名引用）。
// 内容 = phonemize/core 引擎 + anyascii 音译表（en/ru 的公共依赖）。
const coreResult = await esbuild.build({
  entryPoints: [path.join(srcDir, 'core.mjs')],
  outdir: outDir,
  entryNames: 'core', // outExtension 已换成 .mjs → 产物即 core.mjs
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  alias,
  minify: true,
  charset: 'utf8',
  sourcemap: false,
  metafile: true,
  logLevel: 'info',
});

// 第二步：构建 9 个语言包。splitting:false → 每语言完全内联自身依赖，不再产生
// chunk；en/ru 的 './core.mjs' 标记 external 保持相对引用（按源码书写路径匹配，
// 不内联，否则 core 引擎会在两个语言包里各重复一份 ~862KB）。
const langResult = await esbuild.build({
  entryPoints: languages.map((l) => path.join(srcDir, `${l}.mjs`)),
  outdir: outDir,
  entryNames: 'phonemize-[name]',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  splitting: false,
  format: 'esm',
  platform: 'browser',
  alias,
  external: ['./core.mjs'],
  minify: true,
  charset: 'utf8',
  sourcemap: false,
  metafile: true,
  logLevel: 'info',
});

for (const [name, r] of [['core', coreResult], ['语言包', langResult]]) {
  if (r.warnings && r.warnings.length > 0) {
    console.warn(`[build-phonemize] esbuild ${name} 构建产生 ${r.warnings.length} 条警告（如上）`);
  }
}

// ---------------------------------------------------------------------------
// 产物一致性校验（2026-09-04 新增，永久生效）：防止再次出现"产物 import 指向
// 不存在的文件"类事故（此前 src/ 曾残留 phonemize-en.mjs 引用已被清扫的
// core-A4EHYXOS.mjs，英语注音运行时 404）。三条校验：
//   1) outDir 文件清单 = core.mjs + 9 个 phonemize-*.mjs，出现任何其他 .mjs
//      （含 chunk-*）即失败——"chunk 零碎统一为 core"的硬性保证；
//   2) 每个产物内的相对 import（'./x.mjs'）必须解析到 outDir 内真实存在的文件
//      （用 esbuild metafile 的结构化 imports，非正则扫内容，不误报）；
//   3) 语言包从 core.mjs 引用的导出名，必须都在 core.mjs 实际导出集合内
//      （minify 不改 ESM 导出名；此校验防未来 core 重构改名造成静默断链）。
// ---------------------------------------------------------------------------

// 校验 1：文件清单
const expected = new Set([CORE_FILE, ...languages.map((l) => `phonemize-${l}.mjs`)]);
const actual = new Set(fs.readdirSync(outDir).filter((f) => f.endsWith('.mjs')));
for (const f of actual) {
  if (!expected.has(f)) {
    console.error(`[build-phonemize] 意外产物：${f}（应只有 core.mjs + 9 语言包，不允许 chunk-*）`);
    process.exit(1);
  }
}
for (const f of expected) {
  if (!actual.has(f)) {
    console.error(`[build-phonemize] 缺失产物：${f}`);
    process.exit(1);
  }
}

// 校验 2：相对 import 均可解析到 outDir 内真实文件
for (const [key, out] of Object.entries(langResult.metafile.outputs)) {
  for (const imp of out.imports || []) {
    if (!imp.path.startsWith('.')) continue; // 裸包名/绝对路径均已内联，与产物无关
    const target = path.resolve(outDir, imp.path);
    if (!target.startsWith(outDir + path.sep)) {
      console.error(`[build-phonemize] 产物 ${path.basename(key)} 相对 import 越界：${imp.path}`);
      process.exit(1);
    }
    if (!fs.existsSync(target)) {
      console.error(`[build-phonemize] 产物 ${path.basename(key)} 相对 import 悬空：${imp.path}（应为 产物一致性事故）`);
      process.exit(1);
    }
  }
}

// 校验 3：core.mjs 导出名覆盖语言包所引名字
//   core 实际导出集合来自 metafile 的 exports 字段（ESM 输出才有）。
const [, coreOut] = Object.entries(coreResult.metafile.outputs)
  .find(([k]) => path.basename(k) === CORE_FILE);
const coreExports = new Set(coreOut?.exports || []);
if (!coreExports.has('createPhonemizer')) {
  console.error(`[build-phonemize] core.mjs 未导出 createPhonemizer（实际：${[...coreExports].join(', ') || '无'}）`);
  process.exit(1);
}
// 语言包对 core 的具名导入：minify 后形如 import{createPhonemizer as c}from"./core.mjs"，
// 源侧名字（as 前）不会变，用 metafile 确认谁引了 core，再用正则从产物抠名字。
for (const [key, out] of Object.entries(langResult.metafile.outputs)) {
  const importsCore = (out.imports || []).some((imp) => imp.external && path.basename(imp.path) === 'core.mjs');
  if (!importsCore) continue;
  const file = path.join(outDir, path.basename(key));
  const content = fs.readFileSync(file, 'utf8');
  const stmtRe = /import\s*\{([^}]*)\}\s*from\s*["'](\.\/core\.mjs)["']/g;
  const matches = [...content.matchAll(stmtRe)];
  if (matches.length === 0) {
    console.error(`[build-phonemize] 产物 ${path.basename(key)} 声明引用 core.mjs 但正则抠不出具名导入（压缩格式变化？）——中止，请人工核查`);
    process.exit(1);
  }
  for (const m of matches) {
    for (const spec of m[1].split(',')) {
      const nm = spec.trim().match(/^(?:([\w$]+)\s+as\s+)?([\w$]+)$/);
      const importedName = nm ? (nm[1] || nm[2]) : spec.trim();
      if (importedName && !coreExports.has(importedName)) {
        console.error(`[build-phonemize] 断链：${path.basename(key)} 引用 core.mjs 的 "${importedName}"，但 core 未导出该名字`);
        process.exit(1);
      }
    }
  }
}
console.log('[build-phonemize] 产物一致性校验通过（清单 / 相对 import / core 导出名）');

// 产物清单 + 体积汇报（超 5MB 直接失败，与 addons-linter 上限对齐；含 core.mjs）
const LIMIT = 5 * 1024 * 1024;
let oversized = false;
for (const f of [...actual].sort()) {
  const size = fs.statSync(path.join(outDir, f)).size;
  if (size > LIMIT) {
    console.error(`[build-phonemize] 超限：${f} = ${size} 字节 > 5MB`);
    oversized = true;
  }
}
if (oversized) process.exit(1);

// kuromoji 词典不再随包（2026-09-08 CDN 化）：旧版把 scripts/node_modules/kuromoji/dict
// 的 12 个 .dat.gz 复制进 src/lib/vendor/kuroshiro-dict/（约 17MB，是扩展包体膨胀
// 主因之一）。现词典直接从 CDN 加载（SW 中转，回退链见 service-worker.js 的
// KURO_FETCH；patch 见本文件头部），kuroshiro-dict/ 目录已删除。此处留注释说明
// 产物结构变化，防后来者找不到"词典复制逻辑"而误判缺失。

let total = 0;
for (const f of [...actual].sort()) {
  const size = fs.statSync(path.join(outDir, f)).size;
  total += size;
  console.log(`[build-phonemize] ${f}  ${(size / 1024).toFixed(1)}KB`);
}
console.log(`[build-phonemize] 共 ${actual.size} 个文件，合计 ${(total / 1024).toFixed(1)}KB`);
