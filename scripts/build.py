#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VocabRadar 浏览器扩展 打包脚本

功能：
  1. 创建 dist/ 目录，仅含扩展运行所需文件（manifest.json + src/）
  2. 排除开发文件（preprocess.py/plan.md/readme.txt/浏览器扩展.txt/change.log/build.py）
  3. 用 terser 压缩混淆 JS 文件（排除 vendor 第三方库 + data 数据目录，--minify 可选，默认不压缩）
  4. 将 dist/ 打包成 zip 文件

数据目录结构（src/data/，由 preprocess.py 生成，打包时不压缩）：
  - config.json          配置文件（panelHideDelay 等）
  - wordfreq/            wordfreq 词频数据（42种语言，small_*.msgpack.gz）
    - small_en.msgpack.gz
    - small_zh.msgpack.gz
    - small_ja.msgpack.gz
    - ... 共 42 个文件（preprocess.py 动态扫描源目录全部 small_*.msgpack.gz）
  - wordlists.json       英文词表标签 { word: [list_ids] }
  - mp-qr.jpg            微信小程序码（build.py 从根目录复制）
  注：wordfreq/ 和 wordlists.json 必须先执行 `python preprocess.py` 生成，
      否则扩展运行时词典加载失败（dictionary.js fetch 返回 404）。

反思（2026-08-02）：
  - 旧版打包 wordbank.json (6.8MB，含静态 translations)
  - 新版移除 wordbank.json，改打包 wordfreq/ (42个 msgpack.gz) + wordlists.json (~200KB)
  - 释义不再打包，运行时由 translator.js 在线查询后 fnv1aHash 100分桶缓存本地

反思（2026-08-02 修正）：
  - 初版 preprocess.py 仅复制前10大语言的 wordfreq 文件
  - 用户反馈"界面十大预言，目标和释义语言有几十种"
  - 改为动态扫描源目录全部 small_*.msgpack.gz（共42种语言）：
    ar/bg/bn/ca/cs/da/de/el/en/es/fa/fi/fil/fr/he/hi/hu/id/is/it/
    ja/ko/lt/lv/mk/ms/nb/nl/pl/pt/ro/ru/sh/sk/sl/sv/ta/tr/uk/ur/vi/zh
  - UI语言仍为前10种（i18n.js UI_LANGS），目标/释义语言扩展到42种（TRANSLATE_LANGS）

用法：
  python build.py                      # 默认同时构建 Chrome/Edge 与 Firefox（--browser all）
  python build.py --browser chrome     # 仅构建 Chrome/Edge（dist/）
  python build.py --browser firefox    # 仅构建 Firefox（dist-firefox/）
  python build.py --browser all        # 同时构建两者（默认）
  python build.py --minify             # 启用 terser 压缩混淆（可选，默认不压缩）
  python scripts/build.py --browser all --minify             # 启用 terser 压缩混淆（可选，默认不压缩）
"""

import argparse
import json
import re
import shutil
import subprocess
import zipfile
from pathlib import Path

# === 配置 ===

# 反思（2026-08-28）：build.py 被移入 scripts/ 子目录后 ROOT 未同步调整，
#   仍取 Path(__file__).parent（= scripts/），导致找不到 manifest.json 与 src/，
#   打出 0 KB 空包且 Firefox 分支因缺 manifest.json 抛 FileNotFoundError。
#   修正为 .parent.parent（扩展项目根 BrowserExtention/）。
ROOT = Path(__file__).parent.parent

# 需打包的运行时文件/目录
# 反思（2026-08-09）：图标已移至 src/data/icons/，不再需要单独打包根目录图标文件
# 第一百七十五次（用户要求"扩展说明多语言按需加载"）：新增 _locales —— manifest 的
#   name/description 改用 __MSG_extName__/__MSG_extDesc__，浏览器只加载与界面语言
#   匹配的那一份 messages.json（按需加载由浏览器原生完成，无需我方代码）。
#   缺此目录会导致扩展因找不到消息而无法加载，故必须随包。
RUNTIME_ITEMS = ["manifest.json", "_locales", "src"]

# 第一百九十八次：esbuild 预打包的入口清单（详见 bundle_content_scripts 注释）
BUNDLE_ENTRIES = [
    "src/content/text-hint-impl.js",
    "src/content/web-sidebar-impl.js",
    "src/content/video-controller.js",
    "src/lib/bilibili-danmaku.js",
    "src/lib/bilibili-comment.js",
]

# 需排除的文件名（即使出现在 src/ 下也排除，如 .DS_Store 等）
# 反思（2026-08-02）：加入 wordbank.json 防止旧版静态词典文件被误打包
#   新版已弃用 wordbank.json（释义改由 translator.js 在线查询后缓存本地），
#   若开发者本地仍保留旧文件，打包时自动跳过
EXCLUDE_NAMES = {".DS_Store", "Thumbs.db", "wordbank.json"}

# terser 压缩排除目录
# - vendor：第三方库（msgpack-lite/transformers/tesseract 等），含 WASM/特殊语法，压缩会破坏
# - data：数据目录（wordfreq/*.msgpack.gz 是二进制 gzip，wordlists.json 是 JSON，非 JS 不应压缩）
# 反思（2026-08-02）：data 目录新增 wordfreq/ 子目录存放 small_*.msgpack.gz，
#   原本只含 config.json/mp-qr.jpg，现仍保持整个 data/ 不压缩（数据文件本就不是 JS）
TERSER_EXCLUDE_DIRS = {"vendor", "data"}


def clean_dist(dist_dir):
    """清理旧的 dist 目录"""
    if dist_dir.exists():
        shutil.rmtree(dist_dir)
    dist_dir.mkdir(parents=True)


def copy_runtime(dist_dir):
    """复制运行时文件到 dist_dir/"""
    for item in RUNTIME_ITEMS:
        # 反思（2026-08-28）：manifest.json 已移入 data/ 子目录（与 icon*.png、
        #   qrcode-unlimit.png 同处），但其内部路径（icons/content_scripts/
        #   web_accessible_resources）全部以扩展根为基准，故仍须落到 dist 根。
        src = ROOT / item
        if not src.exists():
            src = ROOT / "data" / item
        if not src.exists():
            print(f"[警告] 缺失: {item}")
            continue
        dst = dist_dir / item
        if src.is_dir():
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns(*EXCLUDE_NAMES))
        else:
            shutil.copy2(src, dst)
        print(f"[复制] {item}")

    # 额外资源：微信小程序码图片源在 data/（qrcode-unlimit.png），
    # 不放入 src/ 源码目录；打包时复制到 dist/src/data/mp-qr.jpg，
    # 与 sidebar.js 的 chrome.runtime.getURL('src/data/mp-qr.jpg') 对应。
    mp_src = ROOT / "data" / "qrcode-unlimit.png"
    mp_dst = dist_dir / "src" / "data" / "mp-qr.jpg"
    if mp_src.exists():
        mp_dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(mp_src, mp_dst)
        print(f"[复制] {mp_src} -> {mp_dst}")
    else:
        print(f"[警告] 缺失: {mp_src}")


def patch_manifest_for_firefox(dist_dir):
    """修改 manifest.json 适配 Firefox MV3
    Firefox MV3 差异：
    1. background.service_worker → background.scripts（Firefox 109+）
    2. 添加 browser_specific_settings.gecko.id（Firefox 必需）
    3. 移除 offscreen permission（Firefox 不支持 offscreen API）
    4. 移除 content_scripts 里 world:"MAIN" 的条目（Firefox MV3 不支持该字段）
    """
    manifest_path = dist_dir / "manifest.json"
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    # 1. background: service_worker → scripts
    if "background" in manifest:
        bg = manifest["background"]
        if "service_worker" in bg:
            sw_path = bg.pop("service_worker")
            bg["scripts"] = [sw_path]
            # type: module 保留（Firefox 支持 ESM background script）

    # 2. 添加 browser_specific_settings.gecko.id
    #    第一百七十六次（用户："manifest 两处改名残留…不用考虑兼容性"）：id 由旧名
    #    beaver-word@heli-jici.cn 改为 vocabradar@vocabradar.app，须与 data/manifest.json 一致。
    manifest["browser_specific_settings"] = {
        "gecko": {
            "id": "vocabradar@vocabradar.app",
            "strict_min_version": "115.0"
        }
    }

    # 3. 移除 offscreen permission（Firefox 不支持）
    # 4. 录音/录像/录屏媒体权限：Chrome 用 audioCapture/videoCapture；Firefox 用 media
    if "permissions" in manifest:
        manifest["permissions"] = [p for p in manifest["permissions"] if p != "offscreen"]
        manifest["permissions"] = [p for p in manifest["permissions"] if p != "audioCapture" and p != "videoCapture"]
        if "media" not in manifest["permissions"]:
            manifest["permissions"].append("media")

    # 5. 第一百七十八次（借鉴 VideoSeek 修 YouTube CC 字幕）：Chrome 侧新增了
    #    world:"MAIN" + document_start 的 page-fetch.js 常驻注入条目，用于在播放器
    #    自身请求 /api/timedtext 之前装好 XHR/fetch 拦截。Firefox MV3 至今不支持
    #    content_scripts[].world="MAIN"（会整条报错拒绝加载），故此处整条剥离；
    #    Firefox 仍走 youtube-fetcher.js 内 injectPageScript() 的 <script src> 懒注入
    #    路径（能力弱一些：装补丁时机晚，只能靠模拟切轨触发，但不报错、不阻断）。
    if "content_scripts" in manifest:
        before = len(manifest["content_scripts"])
        manifest["content_scripts"] = [
            cs for cs in manifest["content_scripts"] if cs.get("world") != "MAIN"
        ]
        removed = before - len(manifest["content_scripts"])
        if removed:
            print(f"[Firefox] 已剥离 {removed} 条 world:MAIN content_script（Firefox 不支持）")

    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"[Firefox] manifest.json 已适配: background.scripts + gecko.id + 移除 offscreen/audioCapture/videoCapture + 添加 media + 剥离 world:MAIN")


def minify_js(dist_dir):
    """用 terser 压缩混淆 dist_dir/src/ 下的 JS 文件（排除 vendor/data 目录）"""
    print(f"[压缩] 开始 terser 压缩混淆...")
    js_files = []
    for js in (dist_dir / "src").rglob("*.js"):
        # 排除 vendor（第三方库）和 data（数据文件）目录
        parts = js.relative_to(dist_dir / "src").parts
        if any(part in TERSER_EXCLUDE_DIRS for part in parts):
            continue
        js_files.append(js)

    if not js_files:
        print("[压缩] 无需压缩的 JS 文件")
        return

    total_before = 0
    total_after = 0
    for js in js_files:
        before = js.stat().st_size
        total_before += before
        # 反思（2026-08-11 第三十七次）：terser --module 会 mangle 顶层变量为短名（如 t），
        #   classic script（无 export/import）共享全局作用域，多文件 t 冲突 → SyntaxError。
        #   修正：有 export/import 的 ES module 用 --module，classic script 不用 --module。
        content = js.read_text(encoding="utf-8")
        is_module = bool(re.search(r'^\s*(export|import)\s', content, re.MULTILINE))
        terser_args = ["npx", "terser", str(js), "-c", "-m"]
        if is_module:
            # ES module: --module 允许 mangle 顶层变量（模块作用域隔离，不污染全局）
            terser_args.append("--module")
        # classic script: 不传 --module，不传 --toplevel
        #   默认不 mangle 顶层变量，避免多 classic script 共享全局作用域时变量名冲突
        terser_args.extend(["-o", str(js)])
        result = subprocess.run(
            terser_args,
            capture_output=True, text=True, shell=True
        )
        if result.returncode != 0:
            print(f"[压缩] 失败: {js.relative_to(dist_dir)} - {result.stderr.strip()}")
            continue
        after = js.stat().st_size
        total_after += after
        ratio = (1 - after / before) * 100 if before > 0 else 0
        print(f"[压缩] {js.relative_to(dist_dir)} {before//1024}KB -> {after//1024}KB ({ratio:.0f}%)")

    ratio = (1 - total_after / total_before) * 100 if total_before > 0 else 0
    print(f"[压缩] 总计 {total_before//1024}KB -> {total_after//1024}KB (节省 {ratio:.0f}%)")


def make_zip(dist_dir, zip_path):
    """将 dist_dir/ 打包成 zip"""
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in dist_dir.rglob("*"):
            if path.is_file():
                arcname = path.relative_to(dist_dir)
                zf.write(path, arcname)
    size_kb = zip_path.stat().st_size / 1024
    print(f"[打包] {zip_path.name} ({size_kb:.0f} KB)")


def bundle_content_scripts(dist_dir):
    """esbuild 预打包 content script 的 ESM 模块图（第一百九十八次）

    用户实测：classic 入口注入仅 DCL+3.7ms，而 ESM 模块图装载 2119ms（37 文件约 514KB，
    逐文件请求延迟型）＝首提亮瓶颈。此处把多个入口的模块图预打包成「单文件 + 共享 chunk」，
    1 次请求替代几十次。

    关键约束（必须用 --splitting 多入口，绝不允许各入口独立 --bundle）：
      page-scan-bus 等跨侧栏共享模块靠"同 URL import 得到同一实例"互通；独立打包会把
      它复制成多份，text-hint 与 web-sidebar 的总线即断。splitting 让共享模块进同一
      chunk，所有入口引用之，单例不破。

    入口 = 各 classic 入口动态 import 的模块。输出路径与源文件一致（覆盖 dist 里的散文件
    副本），classic 入口代码零改动、manifest 路径零改动。
    运行时动态 import 的 youtube-audio/asr 链不入图：无状态共享，保持懒加载原样。
    """
    esbuild = _find_esbuild()
    if not esbuild:
        print("[警告] 未找到 esbuild（scripts/node_modules/.bin 或 PATH）——本次构建未预打包，"
              "首提亮将维持 ESM 逐文件装载的 ~2.1s。安装：npm install --prefix scripts esbuild")
        return
    cmd = [
        esbuild,
        *[str(ROOT / e) for e in BUNDLE_ENTRIES],
        "--bundle", "--splitting", "--format=esm", "--platform=browser",
        "--outdir=" + str(dist_dir / "src"),
        "--outbase=" + str(ROOT / "src"),
        "--chunk-names=content/chunks/[name]-[hash]",
        "--target=es2022",
        "--log-level=warning",
    ]
    print(f"[预打包] esbuild 合并 content script 模块图（{len(BUNDLE_ENTRIES)} 个入口）...")
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(ROOT))
    if r.returncode != 0:
        # 不遮蔽：失败必须出声。esbuild 可能已覆盖部分入口文件，恢复原散文件保证功能不变。
        print("[错误] esbuild 预打包失败（本次 dist 回退为未打包散文件，功能不变，优化未生效）：")
        if r.stdout.strip():
            print(r.stdout.strip()[-1500:])
        if r.stderr.strip():
            print(r.stderr.strip()[-1500:])
        for e in BUNDLE_ENTRIES:
            shutil.copy2(ROOT / e, dist_dir / e)
        return
    if r.stderr.strip():
        print(r.stderr.strip()[:1200])
    # 第二百零二次：入口 import URL 追加内容哈希（?v=<hash>）。
    #   Firefox 对扩展模块的缓存可能在扩展重载后残留旧模块——旧 bundle 引用已被本次
    #   构建删除的旧 chunk → import 失败 → text-hint/web-sidebar 双双失效，表现为
    #   "扩展消失且无日志"。查询串改变模块身份，强制按本次构建取用，跨构建不串。
    import hashlib
    h = hashlib.md5()
    for e in BUNDLE_ENTRIES:
        p = dist_dir / e
        if p.exists():
            h.update(p.read_bytes())
    ver = h.hexdigest()[:8]
    patched_cnt = 0
    for entry in ("src/content/text-hint.js", "src/content/web-sidebar.js",
                  "src/content/generic.js", "src/content/bilibili.js", "src/content/youtube.js"):
        p = dist_dir / entry
        if not p.exists():
            continue
        s = p.read_text(encoding="utf-8")
        patched = s
        for tgt in BUNDLE_ENTRIES:
            patched = patched.replace(
                "chrome.runtime.getURL('" + tgt + "')",
                "chrome.runtime.getURL('" + tgt + "?v=" + ver + "')",
            )
        if patched != s:
            p.write_text(patched, encoding="utf-8", newline="\n")
            patched_cnt += 1
    print(f"[预打包] 入口 import URL 已加 ?v={ver}（{patched_cnt} 个入口，防 Firefox 旧模块缓存）")


def _find_esbuild():
    """定位 esbuild 可执行文件：scripts/node_modules/.bin（npm 本地安装）优先，其次 PATH"""
    bin_dir = ROOT / "scripts" / "node_modules" / ".bin"
    for name in ("esbuild.cmd", "esbuild", "esbuild.exe"):
        p = bin_dir / name
        if p.exists():
            return str(p)
    return shutil.which("esbuild") or shutil.which("esbuild.cmd")


def build_chrome(minify=False):
    """构建 Chrome/Edge 版本"""
    dist_dir = ROOT / "dist"
    zip_path = ROOT / "vocabradar-extension-chrome.zip"
    print("=== 构建 Chrome/Edge ===")
    clean_dist(dist_dir)
    copy_runtime(dist_dir)
    bundle_content_scripts(dist_dir)
    if minify:
        minify_js(dist_dir)
    else:
        print("[压缩] 跳过（未指定 --minify）")
    make_zip(dist_dir, zip_path)
    print(f"dist 目录: {dist_dir}")
    print(f"zip 文件: {zip_path}")


def build_firefox(minify=False):
    """构建 Firefox 版本"""
    dist_dir = ROOT / "dist-firefox"
    zip_path = ROOT / "vocabradar-extension-firefox.zip"
    print("=== 构建 Firefox ===")
    clean_dist(dist_dir)
    copy_runtime(dist_dir)
    patch_manifest_for_firefox(dist_dir)
    bundle_content_scripts(dist_dir)
    if minify:
        minify_js(dist_dir)
    else:
        print("[压缩] 跳过（未指定 --minify）")
    make_zip(dist_dir, zip_path)
    print(f"dist 目录: {dist_dir}")
    print(f"zip 文件: {zip_path}")


def main():
    parser = argparse.ArgumentParser(description="VocabRadar 浏览器扩展打包")
    parser.add_argument("--browser", choices=["chrome", "firefox", "all"], default="all",
                        help="目标浏览器：chrome / firefox / all（默认 all，同时构建两者）")
    parser.add_argument("--minify", action="store_true",
                        help="启用 terser 压缩混淆（可选，默认不压缩，便于调试/检查）")
    args = parser.parse_args()

    if args.browser == "chrome":
        build_chrome(args.minify)
    elif args.browser == "firefox":
        build_firefox(args.minify)
    elif args.browser == "all":
        build_chrome(args.minify)
        print()
        build_firefox(args.minify)

    print("=== 打包完成 ===")


if __name__ == "__main__":
    main()
