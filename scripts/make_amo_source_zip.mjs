#!/usr/bin/env node
/**
 * AMO 源码包打包脚本（Node ESM，2026-09-05 自 make_amo_source_zip.py 迁移）
 *
 * 背景：Firefox (AMO) 提交时，因构建管线使用了 terser（去注释）与 esbuild
 * （content script 拼接 / phonemize 第三方库预构建），按 AMO 政策须同时提交
 * 可让审核者复现构建的完整源代码包。本脚本把该源码包打成 zip。
 *
 * 包含（白名单，宁窄勿宽）：
 *   README.md                        构建步骤与环境/管线披露（AMO 要求）
 *   src/                             全部第一方源码 + 第三方 vendor 库
 *                                    （含 phonemize 预构建产物，审核者不跑
 *                                    Node 也能直接读扩展代码）
 *   data/                            manifest.json、_locales、图标等构建输入
 *   scripts/                         构建脚本（build.mjs / preprocess.mjs /
 *                                    build-phonemize.mjs / phonemize-src/）
 *                                    ——node_modules 排除，审核者 npm install 还原
 *
 * 排除（一律不打进源码包）：
 *   dist/、dist-firefox/、根目录 *.zip（构建产物）
 *   scripts/node_modules（npm install 可还原）
 *   data/hf-upload（HF 数据集上传包，2026-09-07 起移入 data/，须排除）
 *   logs/、docs/（内部开发日志与文档，与审核无关）
 *
 * 自检（不讳疾忌医，缺一即失败退出）：
 *   1. zip 内不得出现 node_modules 路径；
 *   2. zip 内不得出现 .gz 文件（Edge/AMO 上传均拒 .gz 扩展名）；
 *   3. 关键文件必须存在（构建脚本链 + manifest + phonemize 产物 + 词频数据）。
 *   （迁移改进：Python 版自检失败时 zip 文件已部分写出、留残缺文件；JS 版改为
 *    全部条目收集+自检通过后再一次性落盘，失败不留残缺 zip。）
 *
 * 用法：
 *   node scripts/make_amo_source_zip.mjs
 * 输出：
 *   vocabradar-extension-source.zip（仓库根目录）
 */

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_ZIP = path.join(ROOT, 'vocabradar-extension-source.zip');

// 白名单顶层条目
const INCLUDE_ITEMS = ['README.md', 'src', 'data', 'scripts'];

// scripts/ 下排除的目录名（node_modules 必排）
const SCRIPTS_EXCLUDE_DIRS = new Set(['node_modules']);

// data/ 下排除的子目录（2026-09-07：data/hf-upload 为 Hugging Face 数据集上传包，
// 非扩展源码；且其中 .msgpack.gz 会触发 .gz 自检，必须在收集阶段跳过）
const DATA_EXCLUDE_DIRS = new Set(['hf-upload']);

// 通用垃圾文件
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db']);

// 自检关键文件（zip 内相对路径；2026-09-05 py→js 迁移后 build/preprocess 为 .mjs）
const REQUIRED_FILES = [
  'README.md',
  'data/manifest.json',
  'scripts/build.mjs',
  'scripts/preprocess.mjs',
  'scripts/build-phonemize.mjs',
  'scripts/package.json',
  'scripts/package-lock.json',
  'scripts/phonemize-src/ja.mjs',
  'src/lib/vendor/phonemize/core.mjs',
  'src/lib/vendor/phonemize/phonemize-ja.mjs',
  'src/lib/vendor/kuroshiro-dict/base.dat.bin',
];

function main() {
  if (fs.existsSync(OUT_ZIP)) fs.rmSync(OUT_ZIP);

  const zip = new AdmZip();
  const names = [];

  for (const item of INCLUDE_ITEMS) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) {
      throw new Error(`白名单条目缺失: ${src}`);
    }
    if (fs.statSync(src).isFile()) {
      zip.addFile(item, fs.readFileSync(src));
      names.push(item);
      console.log(`[打包] ${item}`);
      continue;
    }
    // 目录：递归收集（等价 Python sorted(rglob("*"))：先列全再按路径排序）
    const files = fs
      .readdirSync(src, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => path.join(d.parentPath, d.name))
      .sort();
    for (const full of files) {
      const rel = path.relative(ROOT, full);
      const parts = rel.split(path.sep);
      // scripts/ 下排除 node_modules（其余顶层目录全收）
      if (parts[0] === 'scripts' && parts.some((p) => SCRIPTS_EXCLUDE_DIRS.has(p))) {
        continue;
      }
      // data/ 下排除 hf-upload（HF 数据集上传包，非扩展源码）
      if (parts[0] === 'data' && DATA_EXCLUDE_DIRS.has(parts[1])) continue;
      if (JUNK_FILES.has(path.basename(full))) continue;
      const arcname = parts.join('/');
      zip.addFile(arcname, fs.readFileSync(full));
      names.push(arcname);
    }
  }

  // ---- 自检（不遮蔽任何问题，缺一即失败；通过后才写盘，不留残缺 zip） ----
  const nameSet = new Set(names);
  const nodeModules = names.filter((n) => n.includes('node_modules'));
  const gzFiles = names.filter((n) => n.endsWith('.gz'));
  const missing = REQUIRED_FILES.filter((r) => !nameSet.has(r));
  if (nodeModules.length) {
    throw new Error(`源码包混入 node_modules ${nodeModules.length} 个文件，中止`);
  }
  if (gzFiles.length) {
    throw new Error(`源码包混入 .gz 文件 ${gzFiles.length} 个，中止`);
  }
  if (missing.length) {
    throw new Error(`源码包缺关键文件: ${missing.join(', ')}`);
  }

  zip.writeZip(OUT_ZIP);
  console.log(
    `[完成] ${path.basename(OUT_ZIP)}: ${names.length} 个文件，${(fs.statSync(OUT_ZIP).size / 1024).toFixed(0)}KB`
  );
  console.log('自检通过：无 node_modules、无 .gz、关键文件齐全');
}

try {
  main();
} catch (e) {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
