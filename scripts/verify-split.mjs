// 拆分验收脚本（源自 docs/拆分计划.md 第四节，可复现）
// 三项检查：
//   1. ESM 语法：复制为 UTF-8 无 BOM 的临时 .mjs 再 node --check
//      （直接 node --check 有"首错短路退出 0"的假通过；--input-type=module 不被允许）
//   2. import/export 逐符号对账：解析每个静态 import 的具名符号，与目标文件实际
//      导出集合比对；注释剥离走单遍词法扫描（同时处理行/块注释与三种字符串），
//      绝不"先块后行"（行注释里的 `vs/*` 会被误当块注释起点）。
//   3. 行数：>1000 行的自研文件报出（AGENTS.md"代码文件不要超过 1000 行"）。
//
// 用法：node scripts/verify-split.mjs [--root src] [--dist dist] [--dist dist-firefox]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE_DIRS = new Set(['vendor', 'data', 'node_modules', 'chunks']);
const LINE_LIMIT = 1000;

// ---------------------------------------------------------------------------
// 单遍词法扫描剥注释：返回去掉 // 与 /* */ 注释后的代码（字符串/模板串内容保留）
// ---------------------------------------------------------------------------
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (src[i] === quote) { out += quote; i++; break; }
        // 模板串内 ${ } 中的注释按代码处理（罕见，保守跳过）
        out += src[i];
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 收集待检文件
// ---------------------------------------------------------------------------
function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const dirent of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!dirent.isFile()) continue;
    if (!/\.(js|mjs)$/.test(dirent.name)) continue;
    const full = path.join(dirent.parentPath ?? dirent.path, dirent.name);
    const rel = path.relative(ROOT, full).split(path.sep);
    if (rel.some((p) => EXCLUDE_DIRS.has(p))) continue;
    acc.push(full);
  }
  return acc;
}

function relPosix(full) {
  return path.relative(ROOT, full).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// 1. 语法校验
// ---------------------------------------------------------------------------
function checkSyntax(files) {
  const bad = [];
  const tmp = path.join(ROOT, 'scripts', '.verify-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const full of files) {
    const code = fs.readFileSync(full, 'utf8').replace(/^﻿/, '');
    const tmpFile = path.join(tmp, relPosix(full).replace(/[\\/]/g, '__') + '.mjs');
    fs.writeFileSync(tmpFile, code, 'utf8');
    const r = spawnSync(process.execPath, ['--check', tmpFile], { encoding: 'utf8' });
    if (r.status !== 0) {
      bad.push({ file: relPosix(full), error: String(r.stderr || r.stdout || '').trim().split('\n').slice(0, 6).join('\n') });
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return bad;
}

// ---------------------------------------------------------------------------
// 2. import/export 对账
// ---------------------------------------------------------------------------
function exportedNames(full) {
  const src = stripComments(fs.readFileSync(full, 'utf8'));
  const names = new Set();
  const reExports = [];      // export * from './x.js' 需要递归
  let m;
  const fnDecl = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = fnDecl.exec(src))) names.add(m[1]);
  const listExport = /export\s*\{([^}]*)\}/g;
  while ((m = listExport.exec(src))) {
    for (const part of m[1].split(',')) {
      const s = part.trim();
      if (!s) continue;
      const as = s.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  if (/export\s+default\b/.test(src)) names.add('default');
  const star = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = star.exec(src))) reExports.push(m[1]);
  for (const spec of reExports) {
    const target = resolveSpec(full, spec);
    if (target && fs.existsSync(target)) for (const n of exportedNames(target)) names.add(n);
  }
  return names;
}

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  if (fs.existsSync(base + '.js')) return base + '.js';
  if (fs.existsSync(base + '.mjs')) return base + '.mjs';
  if (fs.existsSync(path.join(base, 'index.js'))) return path.join(base, 'index.js');
  return null;
}

function checkSymbols(files) {
  const problems = [];
  const cache = new Map();
  const namesOf = (f) => {
    if (!cache.has(f)) cache.set(f, exportedNames(f));
    return cache.get(f);
  };
  for (const full of files) {
    const src = stripComments(fs.readFileSync(full, 'utf8'));
    const re = /import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*|\*\s*as\s+[A-Za-z_$][\w$]*)\s*,\s*)?(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))?\s*from\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const braceList = m[2];
      const spec = m[4];
      if (!braceList) continue;
      const target = resolveSpec(full, spec);
      if (!target) { problems.push(`${relPosix(full)}: 无法解析 import 源 '${spec}'`); continue; }
      if (!fs.existsSync(target)) { problems.push(`${relPosix(full)}: import 源不存在 '${spec}'`); continue; }
      const exp = namesOf(target);
      for (const part of braceList.split(',')) {
        const s = part.trim();
        if (!s) continue;
        const local = (s.split(/\s+as\s+/)[0]).trim();
        if (!local) continue;
        if (!exp.has(local)) problems.push(`${relPosix(full)}: 从 '${spec}' 导入的 '${local}' 未在 ${relPosix(target)} 导出`);
      }
    }
    // 副作用导入 / 纯默认导入的源存在性
    const re2 = /import\s*(?:[A-Za-z_$][\w$]*|\*\s*as\s+[A-Za-z_$][\w$]*)?\s*(?:,\s*(?:\{[^}]*\}))?\s*from\s*['"]([^'"]+)['"]/g;
    while ((m = re2.exec(src))) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      if (!resolveSpec(full, spec)) problems.push(`${relPosix(full)}: import 源不存在 '${spec}'`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const roots = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') roots.push(path.resolve(ROOT, args[++i]));
}
if (!roots.length) roots.push(path.join(ROOT, 'src'));

const files = roots.flatMap((r) => walk(r)).sort();
console.log(`[verify] 待检文件 ${files.length} 个`);

const syntaxBad = checkSyntax(files);
console.log(`[verify] SYNTAX_BAD=${syntaxBad.length}`);
for (const b of syntaxBad) console.log(`  ✗ ${b.file}\n${b.error.replace(/^/gm, '      ')}`);

const symbolProblems = checkSymbols(files);
console.log(`[verify] SYMBOL_PROBLEMS=${symbolProblems.length}`);
for (const p of symbolProblems) console.log('  ✗ ' + p);

const over = files
  .map((f) => ({ f, n: fs.readFileSync(f, 'utf8').split('\n').length }))
  .filter((x) => x.n > LINE_LIMIT)
  .sort((a, b) => b.n - a.n);
console.log(`[verify] LINES_OVER_${LINE_LIMIT}=${over.length}`);
for (const x of over) console.log(`  ! ${x.n} 行  ${relPosix(x.f)}`);

const failed = syntaxBad.length > 0 || symbolProblems.length > 0;
console.log(failed ? '[verify] 结果: FAIL' : '[verify] 结果: PASS');
process.exit(failed ? 1 : 0);
