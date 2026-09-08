#!/usr/bin/env node
/**
 * VocabRadar 浏览器扩展 打包脚本（Node ESM，2026-09-05 自 build.py 迁移）
 *
 * 功能：
 *   1. 创建 dist/ 目录，仅含扩展运行所需文件（manifest.json + src/）
 *   2. 排除开发文件（preprocess.mjs/plan.md/readme.txt/浏览器扩展.txt/change.log/build.mjs）
 *   3. 用 terser 剥离自研 JS 注释（排除 vendor 第三方库 + data 数据目录；
 *      2026-09-04 用户指令"移除压缩混淆。打包的时候移除注释"——不再 compress/mangle，
 *      不改任何标识符名、不删代码，仅去注释/压缩空白；AMO 口径下仍属
 *      minification，须在源码包 README 中如实披露）
 *   4. 将 dist/ 打包成 zip 文件
 *   5. --mode 打包形态（2026-09-07，与 --browser 正交，纯净为基础）：
 *      - pure（纯净）：terser 仅去注释/压缩空白，不改名不删码；
 *      - compress（压缩）：纯净基础上 terser compress（死代码消除/语法压缩），不改名；
 *      - obfuscate（压缩上传）：纯净基础上 terser compress（压缩深度同 compress），
 *        2026-09-08 用户裁定"都压缩，但不单行，不混淆，能直接上传"——mangle 关闭
 *        （对齐 AMO 政策：混淆代码被明令禁止、minification 允许；主流项目
 *        Firefox 包普遍不混淆）；mode 名保留 CLI 兼容，label 改"压缩"；
 *      - auto（自动，默认）：一次产出两个上传包（2026-09-08 用户裁定"auto 最终
 *        生成两个文件，无需审核版"——dist-firefox-review 审核文件夹与自足脚本
 *        make-upload.mjs 整体取消；包内代码剥注释/压缩/多行可读，审核员直接
 *        审包）：
 *        a) vocabradar-extension-chrome-upload.zip —— Chrome 商店/Edge 提交包；
 *        b) vocabradar-extension-firefox-upload.zip —— Firefox (AMO) 提交包。
 *        上传后缀统一 -upload（2026-09-08 裁定：文件名不透出 obf 字样，改名
 *        在本 build 内部改）。
 *        原 make_amo_source_zip.mjs 及其产出的 vocabradar-extension-source.zip
 *        已删除（2026-09-08）。
 *      - 2026-09-08 全模式 terser 输出加 format beautify（indent_level 2）：
 *        用户裁定产物"不单行"——多行缩进可读，顶层语句仍顶格，行首
 *        export/import 判定语义不变；vendor/data 仍排除。
 *      - 2026-09-08 第二百三十七次：HTML/CSS 剥注释补齐（用户反馈"html 并没有
 *        清除注释"）——stripHtmlCssComments 对 dist 内 .html/.css 原位剥 HTML
 *        注释与 CSS 块注释（含内联 style 块），三模式统一、排除 vendor/data，
 *        删后清行尾空白并压 3+ 连空行为 1；仅剥注释不压缩空白，产物多行可读。
 *      压缩/混淆的 terser 统一处理跑在 esbuild 预打包之后（散文件 + chunk 一次
 *      覆盖）。产物命名：纯净包名不变；压缩 *-min.zip / dist-min*；上传
 *      *-upload.zip / dist-upload*（2026-09-08 前为 *-obf）。
 *
 * 数据目录结构（src/data/，由 preprocess.mjs 生成，打包时不处理）：
 *   - config.json          配置文件（panelHideDelay 等）
 *   - wordlists.json       英文词表标签 { word: [list_ids] }
 *   - mp-qr.jpg            微信小程序码（本脚本从 data/ 复制）
 *   注：wordlists.json 必须先执行 `node preprocess.mjs` 生成。
 *   注（2026-09-08）：wordfreq 词频数据不再内置包内（src/data/wordfreq/ 已移除），
 *       运行时经 HF/镜像 CDN 拉取，词数动态取自下载文件解码后的实际 Map.size
 *       （见 src/lib/vendor/dictionary/projection.js；tessdata/kuromoji 字典亦同为 CDN）。
 *   注（2026-09-04 Edge 适配，历史）：Edge 上传校验拒绝包内任何 .gz 扩展名文件——
 *       当时将 wordfreq/kuroshiro-dict 改名 .bin、tessdata 真解压；2026-09-07/08 起
 *       大体积数据均已 CDN 化，包内已无此类文件，该约束仍适用于未来新增数据。
 *
 * 迁移说明（build.py → build.mjs 的等价与差异，2026-09-05）：
 *   - terser：CLI spawn（npx terser <file> --comments false [--module] -o <file>）
 *     改为进程内 API minify(code, { compress:false, mangle:false,
 *     format:{comments:false}, module })，逐段等价；
 *   - esbuild：CLI spawn 改为进程内 API build({...})，参数一一对应；
 *     原版"找不到 esbuild 仅警告并回退散文件继续"改为 import 失败即报错终止——
 *     esbuild/terser 均为 package.json 硬依赖（npm install 即有），缺失说明环境
 *     未就绪，按"不遮蔽错误"原则不再静默降级（esbuild 预打包运行期失败仍
 *     保留原回退散文件语义）；
 *   - zipfile → adm-zip（deflate 压缩）；
 *   - 其余逻辑（复制、Firefox manifest 适配、?v= 哈希补丁、失败统一 raise）
 *     逐段等价；strip_comments/make_zip 需递归列目录，fs.readdirSync recursive。
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { build as esbuildBuild } from 'esbuild';
import { minify } from 'terser';
import AdmZip from 'adm-zip';

// === 配置 ===

// 反思（2026-08-28）：脚本被移入 scripts/ 子目录后 ROOT 未同步调整，导致打出
//   0 KB 空包——修正为 scripts/ 的上一级（扩展项目根 BrowserExtention/）。
const ROOT = path.resolve(import.meta.dirname, '..');

// 需打包的运行时文件/目录
// 反思（2026-08-09）：图标已移至 src/data/icons/，不再需要单独打包根目录图标文件
// 第一百七十五次（用户要求"扩展说明多语言按需加载"）：新增 _locales —— manifest 的
//   name/description 改用 __MSG_extName__/__MSG_extDesc__，浏览器只加载与界面语言
//   匹配的那一份 messages.json（按需加载由浏览器原生完成，无需我方代码）。
//   缺此目录会导致扩展因找不到消息而无法加载，故必须随包。
const RUNTIME_ITEMS = ['manifest.json', '_locales', 'src'];

// 第一百九十八次：esbuild 预打包的入口清单（详见 bundleContentScripts 注释）
const BUNDLE_ENTRIES = [
  'src/content/text-hint-impl.js',
  'src/content/web-sidebar-impl.js',
  'src/content/video-controller.js',
  'src/lib/bilibili-comment.js',
];

// 需排除的文件名（即使出现在 src/ 下也排除，如 .DS_Store 等）
// 反思（2026-08-02）：加入 wordbank.json 防止旧版静态词典文件被误打包
//   新版已弃用 wordbank.json（释义改由 translator.js 在线查询后缓存本地），
//   若开发者本地仍保留旧文件，打包时自动跳过
const EXCLUDE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'wordbank.json']);

// 注释剥离排除目录（2026-09-04 由 TERSER_EXCLUDE_DIRS 更名，语义不变）
// - vendor：第三方库（msgpack-lite/transformers/tesseract 等）保持原样不剥离
//   （AMO 政策对第三方开源库豁免，且部分为压缩单行文件，重写有风险）
// - data：数据目录（wordlists.json 是 JSON、icons/ 是 PNG，均非 JS）
const STRIP_EXCLUDE_DIRS = new Set(['vendor', 'data']);

// 打包形态配置（2026-09-07 --mode，纯净为基础；2026-09-08 用户裁定全不混淆）
// terser 为 null = 纯净路径：esbuild 预打包之前仅去注释（现行为不变）；
// 非 null = esbuild 预打包之后对 dist 全部自研 JS（散文件 + chunk，排除 vendor/data）
// 统一过一遍 terser：compress=死代码消除/语法压缩；mangle=标识符改名（混淆）。
// 2026-09-08 起所有模式 mangle:false——AMO 政策明令禁止混淆代码、允许 minification；
// mangle 若未来重开，也不得开 toplevel/properties（跨文件 import/export 名、
// classic 全局名、属性名/dataset/存储键一律不动，保证语义与跨文件契约零风险）。
const BUILD_MODES = {
  pure: { label: '纯净', suffix: '', terser: null },
  compress: { label: '压缩', suffix: '-min', terser: { compress: true, mangle: false } },
  // 上传产物后缀 -upload（2026-09-08 用户裁定）：提交商店的文件名不透出 obf 字样
  // （"obf 后缀容易引发疑虑"）；2026-09-08 起 mangle 关闭，压缩深度同 compress
  // （mode 名 obfuscate 保留 CLI 兼容，label 改"压缩"）。
  obfuscate: { label: '压缩', suffix: '-upload', terser: { compress: true, mangle: false } },
};

function cleanDist(distDir) {
  // 清理旧的 dist 目录
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
}

function copyRuntime(distDir) {
  // 复制运行时文件到 distDir/
  for (const item of RUNTIME_ITEMS) {
    // 反思（2026-08-28）：manifest.json 已移入 data/ 子目录（与 icon*.png、
    //   qrcode-unlimit.png 同处），但其内部路径（icons/content_scripts/
    //   web_accessible_resources）全部以扩展根为基准，故仍须落到 dist 根。
    let src = path.join(ROOT, item);
    if (!fs.existsSync(src)) src = path.join(ROOT, 'data', item);
    if (!fs.existsSync(src)) {
      console.log(`[警告] 缺失: ${item}`);
      continue;
    }
    const dst = path.join(distDir, item);
    if (fs.statSync(src).isDirectory()) {
      // filter 按条目名排除（等价 shutil.ignore_patterns(*EXCLUDE_NAMES)）
      fs.cpSync(src, dst, {
        recursive: true,
        filter: (s) => !EXCLUDE_NAMES.has(path.basename(s)),
      });
    } else {
      fs.copyFileSync(src, dst);
    }
    console.log(`[复制] ${item}`);
  }

  // 额外资源：微信小程序码图片源在 data/（qrcode-unlimit.png），
  // 不放入 src/ 源码目录；打包时复制到 dist/src/data/mp-qr.jpg，
  // 与 sidebar.js 的 chrome.runtime.getURL('src/data/mp-qr.jpg') 对应。
  const mpSrc = path.join(ROOT, 'data', 'qrcode-unlimit.png');
  const mpDst = path.join(distDir, 'src', 'data', 'mp-qr.jpg');
  if (fs.existsSync(mpSrc)) {
    fs.mkdirSync(path.dirname(mpDst), { recursive: true });
    fs.copyFileSync(mpSrc, mpDst);
    console.log(`[复制] ${mpSrc} -> ${mpDst}`);
  } else {
    console.log(`[警告] 缺失: ${mpSrc}`);
  }
}

function buildPhonemizeLangpacks() {
  // 第二百三十二次：多语言注音按语言拆包构建（方案 B，替代 gzip 单包方案）
  //
  // 背景：单文件 phonemize-bundle.mjs 实测 5,390,748 字节，超 Firefox AMO
  // addons-linter 对 JS 文件 5MB 的解析上限（Error 级阻断 AMO 上传/签名）。
  // gzip 方案（第二百零四次）被用户否定，定案按语言拆包。
  //
  // 方案：调用 node scripts/build-phonemize.mjs（esbuild 多入口），把 npm
  // phonemize@2.0.0 打成 9 个语言包 + 共享核心 core.mjs，全部 <5MB 合规；
  // 运行时 phonetics.js 按语言懒加载对应包。产物落 src/lib/vendor/phonemize/，
  // 随后由 copyRuntime 随 "src" 一并复制进 dist；manifest 的
  // web_accessible_resources 已有 "src/lib/vendor/*" 通配，无需增补。
  //
  // 失败策略：esbuild 缺失（scripts/node_modules 未 npm install）或构建超限
  // 直接 throw 终止打包——不静默回退，否则旧 bundle/缺失语言包进 dist 问题
  // 更隐蔽（不讳疾忌医）。
  const script = path.join(ROOT, 'scripts', 'build-phonemize.mjs');
  if (!fs.existsSync(script)) {
    throw new Error(`缺少语言包构建脚本: ${script}`);
  }
  console.log('[phonemize] 构建多语言注音语言包（node scripts/build-phonemize.mjs）...');
  const result = spawnSync(process.execPath, [script], { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `语言包构建失败（exit ${result.status}）。常见原因：scripts/node_modules ` +
      `未安装（npm install --prefix scripts）或产物超 5MB。不打静默回退包。`
    );
  }
}

function patchManifestForFirefox(distDir) {
  // 修改 manifest.json 适配 Firefox MV3
  // Firefox MV3 差异：
  // 1. background.service_worker → background.scripts（Firefox 109+）
  // 2. 添加 browser_specific_settings.gecko.id（Firefox 必需）
  // 3. 移除 offscreen permission（Firefox 不支持 offscreen API）
  // 4. 移除 content_scripts 里 world:"MAIN" 的条目（Firefox MV3 不支持该字段）
  const manifestPath = path.join(distDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // 1. background: service_worker → scripts
  if (manifest.background) {
    const bg = manifest.background;
    if (bg.service_worker) {
      const swPath = bg.service_worker;
      delete bg.service_worker;
      bg.scripts = [swPath];
      // type: module 保留（Firefox 支持 ESM background script）
    }
  }

  // 2. 添加 browser_specific_settings.gecko
  //    第一百七十六次：id 由旧名 beaver-word@heli-jici.cn 改为 vocabradar@vocabradar.app，
  //    须与 data/manifest.json 一致。第二百零四次：新增 data_collection_permissions
  //    （本扩展不收集任何数据）。Firefox 140 起 AMO 新提交必填；Firefox 115~139
  //    对该未知键仅控制台警告并忽略，不影响加载。故放 Firefox 适配层而非
  //    data/manifest.json，Chrome 构建不受影响。
  manifest.browser_specific_settings = {
    gecko: {
      id: 'vocabradar@vocabradar.app',
      strict_min_version: '115.0',
      data_collection_permissions: { required: ['none'] },
    },
  };

  // 3. 移除 offscreen permission（Firefox 不支持）
  // 4. 移除 audioCapture/videoCapture（Chrome 专用）；第二百零四次：不再添加 "media"
  //    —— 旧版误以为 Firefox 需要 media 权限，实际 Firefox 无此权限，且 getUserMedia
  //    录音不需要任何清单权限（由浏览器运行时授权弹窗管理）。
  if (manifest.permissions) {
    manifest.permissions = manifest.permissions.filter(
      (p) => p !== 'offscreen' && p !== 'audioCapture' && p !== 'videoCapture'
    );
  }

  // 5. 第一百七十八次（借鉴 VideoSeek 修 YouTube CC 字幕）：Chrome 侧新增了
  //    world:"MAIN" + document_start 的 page-fetch.js 常驻注入条目。Firefox MV3
  //    至今不支持 content_scripts[].world="MAIN"（会整条报错拒绝加载），故此处
  //    整条剥离；Firefox 仍走 youtube-fetcher.js 内 injectPageScript() 的
  //    <script src> 懒注入路径（能力弱一些，但不报错、不阻断）。
  if (manifest.content_scripts) {
    const before = manifest.content_scripts.length;
    manifest.content_scripts = manifest.content_scripts.filter(
      (cs) => cs.world !== 'MAIN'
    );
    const removed = before - manifest.content_scripts.length;
    if (removed) {
      console.log(`[Firefox] 已剥离 ${removed} 条 world:MAIN content_script（Firefox 不支持）`);
    }
  }

  // ensure_ascii=False indent=2 的等价写出（末尾补换行，与 Python 一致）
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(
    '[Firefox] manifest.json 已适配: background.scripts + gecko.id/data_collection_permissions + 移除 offscreen/audioCapture/videoCapture + 剥离 world:MAIN'
  );
}

async function terserProcess(distDir, { compress = false, mangle = false, label = '注释剥离' }) {
  // terser 统一处理 distDir/src/ 下自研 JS（排除 vendor/data 目录），失败统一 raise
  //
  // 两种口径（2026-09-08 用户裁定"都压缩，但不单行，不混淆"后 obfuscate 并入
  // compress 口径，仅 label/后缀不同）：
  //   - 注释剥离（pure）：compress=false mangle=false——2026-09-04 用户指令
  //     "移除压缩混淆。打包的时候移除注释"：不改任何标识符名、不做死代码删除，
  //     仅去注释，format.comments=false 连 /*! @license 类默认保留注释一并移除
  //     （自研代码无需保留版权头）；
  //   - 压缩（compress/obfuscate）：compress=true mangle=false——死代码消除/
  //     语法压缩，不改名（混淆 2026-09-08 取消，理由见 BUILD_MODES 注释）。
  //   - 输出统一 beautify（indent_level 2）：用户裁定产物"不单行"——多行缩进
  //     可读；terser beautify 顶层语句顶格，行首 export/import 判定语义不变。
  // 调用时机：pure 在 esbuild 预打包之前（现行为不变）；compress/obfuscate 在
  // 预打包之后——散文件与 chunk 一次覆盖，?v= 补丁先落，terser 不动 getURL 字符串。
  console.log(`[${label}] terser 处理（compress=${compress} mangle=${mangle}，排除 vendor/data）...`);
  const distSrc = path.join(distDir, 'src');
  const jsFiles = [];
  for (const dirent of fs.readdirSync(distSrc, { recursive: true, withFileTypes: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith('.js')) continue;
    const full = path.join(dirent.parentPath, dirent.name);
    const rel = path.relative(distSrc, full);
    // 排除 vendor（第三方库）和 data（数据文件）目录
    if (rel.split(path.sep).some((part) => STRIP_EXCLUDE_DIRS.has(part))) continue;
    jsFiles.push({ full, rel: rel.split(path.sep).join('/') });
  }

  if (!jsFiles.length) {
    console.log(`[${label}] 无可处理 JS 文件`);
    return;
  }

  let totalBefore = 0;
  let totalAfter = 0;
  const failed = [];
  for (const { full, rel } of jsFiles) {
    const before = fs.statSync(full).size;
    totalBefore += before;
    // 沿用旧 minify_js 的 module/classic 区分（2026-08-11 第三十七次）：
    // 有 export/import 的 ES module 按 ESM 解析；classic script 不传。
    // module:true 隐含 toplevel 语义：ESM 顶层未引用绑定会被 compress 删除
    // （模块私有可安全优化）；classic 顶层名即全局名，terser 不动。
    // mangle:false 下两种模式都不改名，差异仅死代码删除深度。
    const content = fs.readFileSync(full, 'utf8');
    const isModule = /^\s*(export|import)\s/m.test(content);
    try {
      // pure 等价 CLI：terser <file> --comments false --beautify [--module] -o <file>
      const result = await minify(content, {
        compress,
        mangle,
        format: { comments: false, beautify: true, indent_level: 2 },
        module: isModule,
      });
      fs.writeFileSync(full, result.code, 'utf8');
    } catch (e) {
      // 不遮蔽错误：失败仅记录，最后统一 raise——不打静默包
      failed.push([rel, String(e.message || e).slice(0, 300)]);
      continue;
    }
    const after = fs.statSync(full).size;
    totalAfter += after;
    const ratio = before > 0 ? (1 - after / before) * 100 : 0;
    console.log(`[${label}] ${rel} ${Math.floor(before / 1024)}KB -> ${Math.floor(after / 1024)}KB (${ratio.toFixed(0)}%)`);
  }
  if (failed.length) {
    for (const [rel, err] of failed) {
      console.log(`[${label}] 失败: ${rel} - ${err}`);
    }
    throw new Error(`${label}失败 ${failed.length} 个文件——不打静默包（不讳疾忌医）`);
  }
  const ratio = totalBefore > 0 ? (1 - totalAfter / totalBefore) * 100 : 0;
  console.log(`[${label}] 总计 ${Math.floor(totalBefore / 1024)}KB -> ${Math.floor(totalAfter / 1024)}KB (节省 ${ratio.toFixed(0)}%)`);
}

function stripHtmlCssComments(distDir) {
  // 第二百三十七次（2026-09-08 用户反馈"html并没有清除注释"）：HTML/CSS 剥注释补齐
  //
  // 根因：剥离链此前只覆盖 JS（esbuild 预打包 + terser），HTML/CSS 走 copyRuntime
  // 原样复制，产物注释全保留（实证 popup.html 20 处 / guide.html 44 处 + 3 处内联
  // style / sidebar.css 133 处 / web-sidebar.css 85 / guide.css 68 / popup.css 15）。
  //
  // 口径（2026-09-08 用户 AskUserQuestion 裁定）：
  //   - 三模式统一执行（与 JS "pure 也剥注释"一致），排除 vendor/data 目录；
  //   - 仅剥注释，不压缩空白——产物保持多行可读；删注释后清行尾空白，
  //     3+ 连续空行压成 1（大块注释删除后不留空行沟）；
  //   - HTML 对全文件跑 CSS 注释正则的依据：grep 实证 .html 中 /* 仅出现在
  //     内联 <style> 块内、无内联 <script> 代码、CSS content 字符串内无 /*。
  // 边界：若日后 HTML 出现内联 <script> 且字符串含 "<!--" 或 "/*"，本正则
  // 会误伤——届时须换真解析器（如 postcss），勿静默扩大正则适用面。
  const targets = [];
  for (const dirent of fs.readdirSync(distDir, { recursive: true, withFileTypes: true })) {
    if (!dirent.isFile()) continue;
    if (!dirent.name.endsWith('.html') && !dirent.name.endsWith('.css')) continue;
    const full = path.join(dirent.parentPath, dirent.name);
    const rel = path.relative(distDir, full);
    // 与 terserProcess 同口径：排除 vendor（第三方库）与 data（数据）目录
    if (rel.split(path.sep).some((part) => STRIP_EXCLUDE_DIRS.has(part))) continue;
    targets.push({ full, rel: rel.split(path.sep).join('/') });
  }
  let changed = 0;
  for (const { full, rel } of targets) {
    const before = fs.readFileSync(full, 'utf8');
    const after = before
      .replace(/<!--[\s\S]*?-->/g, '') // HTML 注释（含跨行；未闭合注释不匹配不破坏）
      .replace(/\/\*[\s\S]*?\*\//g, '') // CSS 注释（含 <style> 内联块）
      .replace(/[ \t]+$/gm, '') // 行尾空白
      .replace(/\n{3,}/g, '\n\n'); // 空行沟压缩（用户裁定）
    if (after !== before) {
      fs.writeFileSync(full, after, 'utf8');
      changed++;
      console.log(`[HTML/CSS 注释剥离] ${rel} ${Math.floor(before.length / 1024)}KB -> ${Math.floor(after.length / 1024)}KB`);
    }
  }
  console.log(`[HTML/CSS 注释剥离] 完成：${changed}/${targets.length} 个文件有变更`);
}

function makeZip(distDir, zipPath) {
  // 将 distDir/ 打包成 zip（deflate，等价 zipfile.ZIP_DEFLATED）
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  const zip = new AdmZip();
  for (const dirent of fs.readdirSync(distDir, { recursive: true, withFileTypes: true })) {
    if (!dirent.isFile()) continue;
    const full = path.join(dirent.parentPath, dirent.name);
    // zip 条目名统一 / 分隔（Windows 下 path.relative 产生 \）
    const arcname = path.relative(distDir, full).split(path.sep).join('/');
    zip.addFile(arcname, fs.readFileSync(full));
  }
  zip.writeZip(zipPath);
  console.log(`[打包] ${path.basename(zipPath)} (${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB)`);
}

async function bundleContentScripts(distDir) {
  // esbuild 预打包 content script 的 ESM 模块图（第一百九十八次）
  //
  // 用户实测：classic 入口注入仅 DCL+3.7ms，而 ESM 模块图装载 2119ms（37 文件约
  // 514KB，逐文件请求延迟型）＝首提亮瓶颈。此处把多个入口的模块图预打包成
  // 「单文件 + 共享 chunk」，1 次请求替代几十次。
  //
  // 关键约束（必须用 splitting 多入口，绝不允许各入口独立 bundle）：
  //   page-scan-bus 等跨侧栏共享模块靠"同 URL import 得到同一实例"互通；独立
  //   打包会把它复制成多份，text-hint 与 web-sidebar 的总线即断。splitting 让
  //   共享模块进同一 chunk，所有入口引用之，单例不破。
  //
  // 入口 = 各 classic 入口动态 import 的模块。输出路径与源文件一致（覆盖 dist
  // 里的散文件副本），classic 入口代码零改动、manifest 路径零改动。
  // 运行时动态 import 的 youtube-audio/asr 链不入图：无状态共享，保持懒加载原样。
  try {
    await esbuildBuild({
      entryPoints: BUNDLE_ENTRIES.map((e) => path.join(ROOT, e)),
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'browser',
      outdir: path.join(distDir, 'src'),
      outbase: path.join(ROOT, 'src'),
      chunkNames: 'content/chunks/[name]-[hash]',
      target: 'es2022',
      // 2026-09-04：默认 charset=ascii 会把字符串里的中文/Unicode 全转成 \uXXXX
      //（如 \u7684），产物满屏转义形似混淆、AMO 审核可读性差。utf8 让字符串
      // 字面量输出原文；正则字面量里的 \uXXXX 范围惯用写法不受影响（esbuild
      // 原样保留正则 body，本就是保留项）。
      charset: 'utf8',
      logLevel: 'warning',
    });
  } catch (e) {
    // 不遮蔽：失败必须出声。esbuild 可能已覆盖部分入口文件，恢复原散文件保证功能不变。
    console.log('[错误] esbuild 预打包失败（本次 dist 回退为未打包散文件，功能不变，优化未生效）：');
    console.log(String(e.message || e).slice(-1500));
    for (const entry of BUNDLE_ENTRIES) {
      fs.copyFileSync(path.join(ROOT, entry), path.join(distDir, entry));
    }
    return;
  }
  // 第二百零二次：入口 import URL 追加内容哈希（?v=<hash>）。
  //   Firefox 对扩展模块的缓存可能在扩展重载后残留旧模块——旧 bundle 引用已被本次
  //   构建删除的旧 chunk → import 失败 → text-hint/web-sidebar 双双失效，表现为
  //   "扩展消失且无日志"。查询串改变模块身份，强制按本次构建取用，跨构建不串。
  const h = createHash('md5');
  for (const entry of BUNDLE_ENTRIES) {
    const p = path.join(distDir, entry);
    if (fs.existsSync(p)) h.update(fs.readFileSync(p));
  }
  const ver = h.digest('hex').slice(0, 8);
  let patchedCnt = 0;
  let hitCnt = 0;
  const entryScripts = [
    'src/content/text-hint.js',
    'src/content/web-sidebar.js',
    'src/content/generic.js',
    'src/content/bilibili.js',
    'src/content/youtube.js',
  ];
  for (const entry of entryScripts) {
    const p = path.join(distDir, entry);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, 'utf8');
    let patched = s;
    for (const tgt of BUNDLE_ENTRIES) {
      // 引号用捕获组+反向引用：terser 会把源码单引号规范化为双引号，产物实为
      // 双引号——只匹配单引号会导致补丁 0 命中（2026-09-05 修复，此前从未生效）。
      const tgtEsc = tgt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      patched = patched.replace(
        new RegExp(`chrome\\.runtime\\.getURL\\((['"])(${tgtEsc})\\1\\)`, 'g'),
        (_m, q, t) => {
          hitCnt++;
          return `chrome.runtime.getURL(${q}${t}?v=${ver}${q})`;
        }
      );
    }
    if (patched !== s) {
      fs.writeFileSync(p, patched, 'utf8');
      patchedCnt++;
    }
  }
  console.log(`[预打包] 入口 import URL 已加 ?v=${ver}（${patchedCnt} 个入口命中 ${hitCnt} 处，防 Firefox 旧模块缓存）`);
  if (hitCnt === 0) {
    console.log('[警告] ?v= 补丁 0 命中：产物里未找到 chrome.runtime.getURL(...) 调用，防缓存未生效，请检查！');
  }
}

async function buildBrowser(browser, mode) {
  // 按 浏览器 × 打包形态 构建（2026-09-07 自 buildChrome/buildFirefox 合并）
  // browser: 'chrome' | 'firefox'；mode: pure | compress | obfuscate
  // 2026-09-08 用户最终裁定：审核文件夹体系（review 参数 / dist-firefox-review /
  // FIREFOX_REVIEW_README / make-upload.mjs）整体取消，auto 直出两个上传 zip。
  const cfg = BUILD_MODES[mode];
  // 纯净沿用原目录/包名（dist、dist-firefox，zip 无后缀，Edge 上传等既有流程不受影响）；
  // 压缩/上传按后缀另开目录与包名，与纯净产物互不覆盖。
  const distDir = path.join(ROOT, `${browser === 'chrome' ? 'dist' : 'dist-firefox'}${cfg.suffix}`);
  const zipPath = path.join(ROOT, `vocabradar-extension-${browser}${cfg.suffix}.zip`);
  console.log(`=== 构建 ${browser === 'chrome' ? 'Chrome/Edge' : 'Firefox'}（${cfg.label}）===`);
  cleanDist(distDir);
  copyRuntime(distDir);
  if (browser === 'firefox') patchManifestForFirefox(distDir);
  if (mode === 'pure') {
    // 纯净（现行为不变）：先剥离注释再 esbuild 预打包——esbuild 从 ROOT 源码读入、
    // 输出本就无注释，覆盖 dist 内 impl 副本；散文件注释剥离只对最终留在 dist 的文件生效。
    await terserProcess(distDir, { compress: false, mangle: false, label: '注释剥离' });
  }
  await bundleContentScripts(distDir);
  if (mode !== 'pure') {
    // 压缩/上传：esbuild 预打包之后统一过一遍 terser——散文件与 chunk 一次覆盖；
    // ?v= 补丁已在 bundleContentScripts 内先落，terser 保留 chrome.runtime.getURL
    // 调用与字符串字面量，防缓存补丁不受影响。
    await terserProcess(distDir, { ...cfg.terser, label: cfg.label });
  }
  // 第二百三十七次：HTML/CSS 剥注释，三模式统一（2026-09-08 用户裁定），在
  // zip 前最后执行——所有内容步骤（复制/适配/bundle/terser）完成后一次覆盖。
  stripHtmlCssComments(distDir);
  makeZip(distDir, zipPath);
  console.log(`dist 目录: ${distDir}`);
  console.log(`zip 文件: ${zipPath}`);
}

async function buildAuto() {
  // 自动模式（2026-09-08 用户最终裁定）：一次产出两个上传包，直接提交商店。
  // 统一口径 = 剥离注释 + compress + 多行 beautify（indent_level 2，不单行），
  // mangle:false 不混淆——AMO 政策明令禁止混淆代码、允许 minification。
  // 产出：
  //   1. vocabradar-extension-chrome-upload.zip —— Chrome 商店 / Edge 提交包；
  //   2. vocabradar-extension-firefox-upload.zip —— Firefox (AMO) 提交包。
  // dist-firefox-review/ 审核文件夹体系（专用 README + make-upload.mjs）整体取消。
  console.log('=== 自动模式：Chrome + Firefox 上传包 ===');
  await buildBrowser('chrome', 'obfuscate');
  await buildBrowser('firefox', 'obfuscate');
}

async function main() {
  const { values } = parseArgs({
    options: {
      // 等价旧 argparse --browser choices=[chrome,firefox,all] default=all
      browser: { type: 'string', default: 'all' },
      // 2026-09-07：打包形态（纯净/压缩/上传/自动），纯净为基础
      mode: { type: 'string', default: 'auto' },
    },
  });
  const browser = values.browser;
  const mode = values.mode;
  if (!['chrome', 'firefox', 'all'].includes(browser)) {
    throw new Error(`--browser 取值须为 chrome/firefox/all，收到: ${browser}`);
  }
  if (mode !== 'auto' && !(mode in BUILD_MODES)) {
    throw new Error(
      `--mode 取值须为 pure/compress/obfuscate/auto（纯净/压缩/上传/自动），收到: ${mode}`
    );
  }

  // 第二百三十二次：语言包构建放 main 统一执行（各构建共用一次产物，不重复跑 esbuild）
  buildPhonemizeLangpacks();

  if (mode === 'auto') {
    // 自动：固定产出 Chrome + Firefox 两个上传包，--browser 不参与
    if (browser !== 'all') {
      console.log(`[提示] auto 模式忽略 --browser=${browser}，固定产出 Chrome + Firefox 两个上传包`);
    }
    await buildAuto();
  } else if (browser === 'chrome') {
    await buildBrowser('chrome', mode);
  } else if (browser === 'firefox') {
    await buildBrowser('firefox', mode);
  } else {
    await buildBrowser('chrome', mode);
    console.log();
    await buildBrowser('firefox', mode);
  }

  console.log('=== 打包完成 ===');
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
