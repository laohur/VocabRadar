# Build & Submission Notes — VocabRadar

> 本文件位于公区 `doc/`（2026-09-17 由 `docs/` 迁入）：面向 Mozilla Add-ons (AMO) 的
> 源码提交政策，说明如何从本仓库构建扩展与处理披露。公开项目介绍见根 `README.md`。

# VocabRadar — Source Code & Build Instructions

Firefox / Chrome / Edge browser extension (MV3). This README documents how to
build the extension from this repository, as required by the Mozilla
Add-ons (AMO) source-code submission policy.

## 1. Build environment

| Tool    | Version used for development     | Notes                                          |
|---------|----------------------------------|------------------------------------------------|
| OS      | Windows 10 (build 19045)         | Any OS that can run Node.js will work          |
| Node.js | v24.15.0                         | >= 24 recommended                              |
| npm     | 11.x (bundled with Node 24)      | Used once for `npm install`                    |

## 2. Build steps

Run from the root of this repository:

```text
cd scripts
npm install      # installs esbuild, terser, phonemize, kuroshiro,
                 # kuroshiro-analyzer-kuromoji, pinyin-pro, koroman,
                 # @piper-plus/g2p, path-browserify, adm-zip, jimp,
                 # msgpack-lite (see scripts/package.json)
cd ..
node scripts/build.mjs            # default --mode auto, see the table below
```

With the default `--mode auto` this produces two deliverables at the repo root:

| Output                                        | What it is                                                                 | Where it is submitted            |
|-----------------------------------------------|----------------------------------------------------------------------------|----------------------------------|
| `vocabradar-extension-chrome-upload.zip`      | Chrome/Edge build: comment-stripped (JS/HTML/CSS), terser `compress` with mangling **off**, output re-formatted multi-line (see §3.5) | Chrome Web Store, Edge Add-ons   |
| `vocabradar-extension-firefox-upload.zip`     | Firefox (AMO) build: manifest adapted, then exactly the same processing as the Chrome archive | Firefox Add-ons (AMO)            |

Reproducing the submitted archives: run the same command with the toolchain
versions resolved from `scripts/package.json` (esbuild / terser). The `?v=`
suffix appended to content-script import URLs is an MD5 **content** hash of
the bundled entries (`scripts/build.mjs`), so identical sources produce
identical hashes — there is no timestamp or randomness in the build output.

`scripts/preprocess.mjs` (regenerates the wordfreq frequency tables from a
local corpus) is **not** required to build: the generated data files are
already included under `src/data/wordfreq/` and `src/data/wordlists.json`.
It is shipped only for completeness.

## 3. Processing disclosure (per AMO source-code policy)

`scripts/build.mjs` performs the following steps, in order. Steps 1–4 are
shared by every `--mode`; step 5 is the only mode-dependent difference, and
step 6 packages the result.

1. **Copy** `manifest.json`, `_locales/` and `src/` verbatim into `dist/`.
2. **Comment stripping on first-party JS / HTML / CSS** (`stripComments`,
   `stripHtmlCssComments`):
   every first-party `.js` outside `src/lib/vendor/` and `src/data/` is
   rewritten with the terser JS API —
   `minify(code, { compress: false, mangle: false, format: { comments: false } })`
   (plus `module: true` for ESM files), equivalent to the CLI
   `npx terser <file> --comments false -o <file>`. Compression and mangling
   are **off**: identifiers are **not** renamed, no code is removed, only
   comments are stripped. Per AMO policy comment stripping still counts as
   minification; the submitted archives ship exactly this processed code
   (see step 5). Additionally, `stripHtmlCssComments` (run right before
   zipping, shared by every `--mode`) rewrites every first-party `.html` /
   `.css` outside `src/lib/vendor/` and `src/data/` in place: HTML comments
   and CSS block comments (covering inline `<style>` blocks) are removed,
   trailing whitespace is cleared and runs of 3+ blank lines are collapsed
   to one; whitespace is otherwise untouched, so the output stays multi-line
   and readable.
3. **Content-script bundling** (`bundleContentScripts`): four first-party
   entry files — `src/content/text-hint-impl.js`,
   `src/content/web-sidebar-impl.js`, `src/content/video-controller.js`,
   `src/lib/bilibili-comment.js` — are bundled with **esbuild** into
   single-file outputs of the same names inside `dist/src/`. This is a
   concatenate-several-files-into-one step. esbuild is imported from
   `scripts/node_modules/` (installed by `npm install`).
4. **phonemize pre-build**: `build.mjs` runs `node scripts/build-phonemize.mjs`,
   which uses esbuild to bundle the third-party npm packages `phonemize`,
   `kuroshiro`, `kuroshiro-analyzer-kuromoji`, `kuromoji`, `pinyin-pro`,
   `koroman` and `@piper-plus/g2p` into one prebuilt ESM file per language
   under `src/lib/vendor/phonemize/` (`core.mjs` + `phonemize-*.mjs`).
   These generated files are **included in the submission archives** so the
   extension can be reviewed without running Node at all; the readable esbuild
   inputs live in `scripts/phonemize-src/*.mjs`.
5. **Compression pass** (`--mode obfuscate` and `--mode compress` — the submitted
   `*-upload.zip` archives go through this; the mode name is historical):
   after the esbuild bundling, every first-party `.js` outside
   `src/lib/vendor/` and `src/data/` is rewritten once more with the terser
   JS API. The submitted archives use `compress: true, mangle: false` —
   dead-code elimination / syntax compression, **no identifier renaming** —
   plus `format: { comments: false, beautify: true, indent_level: 2 }`, so
   the output is multi-line, re-formatted and readable. Cross-file
   `import`/`export` binding names, classic-script global names and all
   object-property / `dataset` / storage keys are untouched. Vendor code
   and data files are never rewritten. (`--mode compress` is the same pass
   under a different name; `--mode pure` skips this step entirely, leaving
   the §3.2 comment-stripped output as-is.)
6. **Zip** each `dist` directory into the upload archives (see the §2 table).

## 4. Third-party open-source libraries (included as-is, not our code)

`src/lib/vendor/` contains third-party libraries used at runtime. They are
excluded from comment stripping and are not modified by the build:
msgpack-lite, Readability, defuddle, tesseract.js (+ wasm cores + tessdata),
@huggingface/transformers, youtubei.js bundle, diverse-lemmas, md5, and the
phonemize language packs described in §3.4.

`src/lib/vendor/kuroshiro-dict/*.dat.bin` are kuromoji Japanese dictionary
files. `src/data/wordfreq/*.msgpack.bin` are wordfreq (small) frequency
tables: msgpack-serialised and gzip-compressed by our preprocessing script,
then **renamed `.gz` → `.bin`** solely because the Microsoft Edge Add-ons
store rejects upload archives containing any `.gz` file — the bytes are still
gzip and are decompressed at runtime. `tessdata/*.traineddata` were
decompressed once at packaging time and are loaded with `gzip: false`.

## 5. First-party source files

All first-party code — everything outside `src/lib/vendor/` — is plain
hand-written JavaScript / HTML / CSS. It is not transpiled, not
machine-generated, and (outside the two disclosed steps in §3.2 and §3.3)
not concatenated or minified. `data/` holds the extension manifest, icons
and locales used verbatim at build time. No Web template engine is used.

Note on `\uXXXX` escapes: string literals are emitted as real UTF-8 text
(esbuild runs with `--charset=utf8`). The remaining `\uXXXX` sequences in the
build output occur only inside regular-expression literals
(`\u4e00-\u9fff`, `\u00a0`, `\u3000`, …) — the conventional, human-readable
way to write Unicode ranges and invisible characters — or inside
third-party vendor files as distributed by their upstreams.

---

## 中文对照（简版）

- 构建环境：Windows 10、Node.js v24.15.0、npm 11.x（Node ≥ 24 推荐）。
- 构建步骤：`cd scripts && npm install`，回到根目录 `node scripts/build.mjs`（默认 `--mode auto`），
  产出两个上传包：`vocabradar-extension-chrome-upload.zip`（Chrome 商店/Edge 提交）、
  `vocabradar-extension-firefox-upload.zip`（Firefox / AMO 提交，manifest 已适配）。
- 处理披露：① 注释剥离：JS 过 terser 仅去注释（不改名、不删码，输出按 2 空格缩进重排）；
  HTML/CSS 由 stripHtmlCssComments 原位剥 HTML 注释与 CSS 块注释（含内联 style 块），
  删后清行尾空白并压 3+ 连空行为 1，不另行压缩空白、多行可读；
  ② esbuild 将 4 个
  content script 入口各合并为单文件（拼接）；③ `build-phonemize.mjs` 用 esbuild
  打包第三方注音库为每语言一个预构建文件（产物已随包提供）；
  ④ 提交包（`-upload`）在此之上再过一遍 terser `compress`（mangle 关闭，不混淆）：
  死代码消除+语法压缩，输出仍为多行可读；跨文件 import/export 名、
  classic 全局名、属性名/dataset/存储键全部保留；vendor/data 一律不动；
  内容脚本 import URL 的 `?v=` 为内容 MD5 哈希，同源码复现哈希一致，无时间戳/随机数。
- `*.msgpack.bin` / `*.dat.bin` 内容仍是 gzip，仅因 Edge 商店拒绝 `.gz` 扩展名而改名；
  tessdata 已真解压并以 `gzip:false` 加载。
- `src/lib/vendor/` 为第三方开源库，按原样分发，构建不改动。