#!/usr/bin/env node
/**
 * VocabRadar 浏览器扩展 预处理脚本（Node ESM，2026-09-05 自 preprocess.py 迁移）
 *
 * 输入（发布代码不含本地绝对路径：外部源路径一律经命令行参数提供，默认值见配置段）:
 *   - 10个英文词表文件 (--wordlist-dir，默认 ../BeaverWord/preprocess/word_list/*.txt)
 *     每行一个英文单词，对应 CET4/CET6/TEM4/TEM8/GRADUATE/IELTS/TOEFL/GRE/GMAT/SAT
 *   - 图标源图 (--logo，默认 ../文档/logo.png)
 *
 * 输出:
 *   - src/data/wordlists.json ({word_lower: [list_ids]}，仅英文词表)
 *   - src/data/icons/icon{16,32,48,128,144}.png（--icons 子任务，由 --logo 源图缩放生成）
 *
 * 词频（wordfreq）不再由本脚本处理（2026-09-08 用户裁定"preprocess.mjs 不再处理
 * wordfreq，有 clean.js 文件处理"）：词频 .gz 与词数元数据均由公开仓库
 * data/hf-upload/wordfreq/clean.js 产出（small_<lang>.msgpack.gz + meta.json，供
 * hf-upload）；运行时 word-loader.js 经 SW WF_FETCH 从 HF/镜像 CDN 拉取，词数校验
 * 动态取下载文件解码后的实际 Map.size，不再依赖包内写死的 meta.json（已删除）。
 *
 * 设计：
 *   - 词频 rank 由前端运行时按 frequency 降序排序后构建 Map<word, rank>
 *     （数据构建在公开仓库 clean.js，本脚本不参与）
 *   - 词表标签仅针对英文（CET4等），其他语言的词频文件不含词表
 *   - 释义不再打包，改由前端在线查询后 fnv1aHash 100分桶缓存本地
 *   - wordbank.json 弃用，不再生成
 *
 * 反思（2026-08-02 修正）：
 *   - 初版仅复制前10大语言的 wordfreq 文件，用户反馈"目标和释义语言有几十种"
 *   - 改为动态扫描源目录的所有 small_*.msgpack.gz（共42种语言）
 *   - 动态扫描的好处：wordfreq 升级新增语言时无需改 preprocess
 *
 * 反思（第一百七十五次，用户质问"图标你咋处理的，preprocess 中没见着"）：
 *   - 图标此前是一次性手工生成后直接落盘 src/data/icons/，脚本里确实无迹可循，
 *     源图一变就无从复现。本次固化为 --icons 子任务（缩放），并补命令行参数。
 *
 * 反思（2026-09-03 源头过滤，用户裁定"明显不是本语言的词源头过滤掉，重建 wordfreq"；
 *   实现已随本批 --wordfreq 子任务迁往公开仓库 clean.js，此处留历史记录）：
 *   - 诊断实测（42 语言全量扫描）wordfreq 上游数据混有四类脏词：纯数字/纯符号/emoji、
 *     非拉丁语言里成规模纯拉丁垃圾词（'the'/'http' 类）、其他文字整词混入、
 *     同形字污染（内嵌拉丁字母冒充本族字母）。
 *   - 过滤规则（用户裁定）：每语言设期望文字（Unicode script）白名单；词中所有字母
 *     必须全部属于白名单；无字母词剔除；词内数字/组合符/标点（'90s'、"don't"）允许。
 *   - 白名单依据上游 wordfreq/language_info.py 每语言 'script' 字段 + 诊断实测归组；
 *     未列出的语言默认拉丁文字。
 *
 * 反思（2026-09-08 两步收口）：
 *   - 第一步停写 .bin（用户裁定"preprocess.mjs 停写 .bin，wordfreq 就跟其他远程数据
 *     是文件一样，用 hf/镜像当作 cdn 加载"）：42 语 .bin 从扩展包删除
 *     （16757KB→8852KB），运行时 word-loader.js 经 SW WF_FETCH 从 HF dataset 双源
 *     （huggingface.co→hf-mirror.com）拉取并 SHA-256 校验。
 *   - 第二步彻底迁出（用户裁定"preprocess.mjs 不再处理 wordfreq，有 clean.js 文件
 *     处理"）：删除本脚本全部词频代码（含 Unicode script 过滤、统计、meta.json 产出），
 *     包内 meta.json 一并删除——词数校验动态化（下载文件解码后的实际 Map.size 即
 *     实际值基准），projection.js 的 manifest 版本比对机制同步退役。
 *
 * 迁移说明（preprocess.py → preprocess.mjs 的等价与差异，2026-09-05；词频相关条目
 *   ——unicodedata 正则等价、msgpack-lite、zlib、filter_wordfreq_files 缺陷修正——
 *   已随 --wordfreq 子任务整体删除，实现详见公开仓库 clean.js）：
 *   - Pillow → jimp（中心裁切 + BICUBIC 重采样，替代 LANCZOS；RGBA 透明通道天然保留）；
 *   - loguru → console（带 [HH:MM:SS] 前缀近似）。
 *
 * 用法:
 *   node preprocess.mjs                        # 全部子任务
 *   node preprocess.mjs --icons                # 仅重新生成图标
 *   node preprocess.mjs --wordlists            # 仅词表标签
 *   node preprocess.mjs --wordlist-dir <目录>   # 指定词表目录（默认 ../BeaverWord/preprocess/word_list）
 *   node preprocess.mjs --logo <文件>          # 指定图标源图（默认 ../文档/logo.png）
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

// === 配置 ===

// 输出目录（scripts/ 的上一级即扩展项目根）
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'src', 'data');
const WORDLISTS_OUTPUT_PATH = path.join(OUTPUT_DIR, 'wordlists.json');
const ICONS_OUTPUT_DIR = path.join(OUTPUT_DIR, 'icons');
const ICON_SIZES = [16, 32, 48, 128, 144]; // 128 商店图标；144 备用（部分平台高分屏）

// 发布代码不含本地绝对路径（2026-09-08 用户裁定"src dst 都不能有"）：外部源路径
// 一律经命令行参数提供（--wordlist-dir / --logo），此处仅定义相对 PROJECT_ROOT 的默认值。
// 词表目录（来自 BeaverWord/preprocess/word_list/，仅英文）
const DEFAULT_WORDLIST_DIR = path.join(PROJECT_ROOT, '..', 'BeaverWord', 'preprocess', 'word_list');
// 图标源图（第一百七十五次）
const DEFAULT_LOGO = path.join(PROJECT_ROOT, '..', '文档', 'logo.png');

// 词表配置（与前端 lemmatizer.js 词表标签匹配一致）
// id -> 文件名
const WORD_LISTS = {
  CET4: 'CET4.txt',
  CET6: 'CET6.txt',
  TEM4: 'Level4.txt',   // Level4.txt 对应 TEM4
  TEM8: 'Level8.txt',   // Level8.txt 对应 TEM8
  GRADUATE: '考研.txt',
  IELTS: 'IELTS.txt',
  TOEFL: 'TOEFL.txt',
  GRE: 'GRE.txt',
  GMAT: 'GMAT.txt',
  SAT: 'SAT.txt',
};

// === 日志（loguru → console 近似，[HH:MM:SS] 前缀） ===
function nowStamp() {
  return new Date().toTimeString().slice(0, 8);
}
function log(msg) { console.log(`[${nowStamp()}] ${msg}`); }
function warn(msg) { console.warn(`[${nowStamp()}] [警告] ${msg}`); }
function error(msg) { console.error(`[${nowStamp()}] [错误] ${msg}`); }

function loadWordlists(wordlistDir) {
  // 加载10个英文词表，返回 {id: Set(words)}
  const wordlists = {};
  for (const [listId, filename] of Object.entries(WORD_LISTS)) {
    const p = path.join(wordlistDir, filename);
    if (!fs.existsSync(p)) {
      warn(`词表不存在: ${p}`);
      wordlists[listId] = new Set();
      continue;
    }
    const words = new Set();
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const w = line.trim().toLowerCase();
      if (w) words.add(w);
    }
    wordlists[listId] = words;
    log(`加载词表 ${listId}: ${words.size} 词 (${filename})`);
  }
  return wordlists;
}

function buildWordlistsJson(wordlists) {
  // 构建 {word_lower: [list_ids]} 字典
  // 仅包含至少属于一个词表的单词（避免大文件）
  const wordToTags = {};
  for (const [listId, words] of Object.entries(wordlists)) {
    for (const w of words) {
      if (!wordToTags[w]) wordToTags[w] = [];
      wordToTags[w].push(listId);
    }
  }
  log(`wordlists.json: ${Object.keys(wordToTags).length} 个词含标签`);
  return wordToTags;
}

async function genIcons(logoSrc) {
  // 由 --logo 源图生成扩展各尺寸图标 → src/data/icons/icon{size}.png
  //
  // 第一百七十五次固化：
  //   - 统一取正方形中心裁切后缩放（源图非正方时避免拉伸变形）；
  //   - RGBA 保留透明通道（Chrome 工具栏图标需透明背景；jimp 位图恒为 RGBA）；
  //   - BICUBIC 重采样（jimp 无 LANCZOS，BICUBIC 为其最高质量近似），
  //     小尺寸（16/32）细节保留较好；
  //   - jimp 为 npm 依赖，缺失时明确报错而不静默跳过（不遮蔽错误）。
  let Jimp;
  try {
    ({ Jimp } = await import('jimp'));
  } catch {
    error('生成图标需要 jimp：cd scripts && npm install');
    return false;
  }
  if (!fs.existsSync(logoSrc)) {
    error(`图标源图不存在: ${logoSrc}`);
    return false;
  }

  fs.mkdirSync(ICONS_OUTPUT_DIR, { recursive: true });
  const src = await Jimp.read(logoSrc);
  const { width: w, height: h } = src.bitmap;
  // 中心正方裁切（源图 w!=h 时）
  let img = src;
  if (w !== h) {
    const side = Math.min(w, h);
    const left = Math.floor((w - side) / 2);
    const top = Math.floor((h - side) / 2);
    img = src.clone().crop({ x: left, y: top, w: side, h: side });
    log(`源图 ${w}x${h} → 中心裁切为 ${side}x${side}`);
  }

  for (const size of ICON_SIZES) {
    const out = path.join(ICONS_OUTPUT_DIR, `icon${size}.png`);
    await img.clone().resize({ w: size, h: size, mode: Jimp.RESIZE_BICUBIC }).write(out);
    log(`输出图标: icon${size}.png (${size}x${size}, ${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
  }
  log(`图标输出目录: ${ICONS_OUTPUT_DIR}`);
  return true;
}

async function main() {
  const { values } = parseArgs({
    options: {
      wordlists: { type: 'boolean' },
      icons: { type: 'boolean' },
      'wordlist-dir': { type: 'string' },
      logo: { type: 'string' },
    },
  });
  // 未指定任何子任务 = 全做
  const runAll = !values.wordlists && !values.icons;
  // 发布代码不含本地绝对路径（2026-09-08 用户裁定）：外部源路径一律经命令行参数
  // 提供，默认值相对 PROJECT_ROOT（见配置段 DEFAULT_WORDLIST_DIR / DEFAULT_LOGO）。
  const wordlistDir = values['wordlist-dir'] || DEFAULT_WORDLIST_DIR;
  const logoSrc = values.logo || DEFAULT_LOGO;

  log('=== VocabRadar 浏览器扩展 预处理 ===');

  // 1. 构建英文词表标签 JSON
  if (runAll || values.wordlists) {
    if (!fs.existsSync(wordlistDir)) {
      warn(`词表目录不存在: ${wordlistDir}，跳过 wordlists.json 生成`);
    } else {
      const wordlists = loadWordlists(wordlistDir);
      const wordToTags = buildWordlistsJson(wordlists);

      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      fs.writeFileSync(WORDLISTS_OUTPUT_PATH, JSON.stringify(wordToTags), 'utf8');

      const sizeKb = fs.statSync(WORDLISTS_OUTPUT_PATH).size / 1024;
      log(`输出: ${WORDLISTS_OUTPUT_PATH} (${Object.keys(wordToTags).length} 词, ${sizeKb.toFixed(1)} KB)`);
    }
  }

  // 2. 第一百七十五次：扩展图标
  if (runAll || values.icons) {
    await genIcons(logoSrc);
  }

  log('=== 预处理完成 ===');
  log(`输出目录: ${OUTPUT_DIR}`);
  log('提示：wordbank.json 已弃用，可手动删除');
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
