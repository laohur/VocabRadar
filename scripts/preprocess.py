#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
VocabRadar 浏览器扩展 预处理脚本

输入:
  - wordfreq 数据文件 (C:/data/corpus/wordfreq-3.0.2/wordfreq/data/small_*.msgpack.gz)
    每文件为 {word: frequency} 的 msgpack 字典，gzip 压缩
    frequency 是每百万词出现次数（float）
  - 10个英文词表文件 (C:/code/河狸记词/BeaverWord/preprocess/word_list/*.txt)
    每行一个英文单词，对应 CET4/CET6/TEM4/TEM8/GRADUATE/IELTS/TOEFL/GRE/GMAT/SAT

输出:
  - src/data/wordfreq/small_{lang}.msgpack.gz (动态扫描源目录所有 small_*.msgpack.gz 复制)
  - src/data/wordlists.json ({word_lower: [list_ids]}，仅英文词表)
  - src/data/icons/icon{16,32,48,128,144}.png（--icons 子任务，由 文档/logo.png 缩放生成）

设计：
  - 词频 rank 由前端运行时按 frequency 降序排序后构建 Map<word, rank>
    （避免 preprocess 重复排序输出大文件）
  - 词表标签仅针对英文（CET4等），其他语言的 wordfreq 文件不含词表
  - 释义不再打包，改由前端在线查询后 fnv1aHash 100分桶缓存本地
  - wordbank.json 弃用，不再生成

反思（2026-08-02 修正）：
  - 初版仅复制前10大语言的 wordfreq 文件，用户反馈"目标和释义语言有几十种"
  - 改为动态扫描源目录的所有 small_*.msgpack.gz（共42种语言）
  - UI语言仍为前10种（i18n.js SUPPORTED_LANGS），但目标/释义语言扩展到42种
  - 动态扫描的好处：wordfreq 升级新增语言时无需改 preprocess.py

用法:
  C:\\ProgramData\\miniconda3\\python.exe preprocess.py            # 全部子任务
  C:\\ProgramData\\miniconda3\\python.exe preprocess.py --icons     # 仅重新生成图标
  C:\\ProgramData\\miniconda3\\python.exe preprocess.py --wordfreq  # 仅词频
  C:\\ProgramData\\miniconda3\\python.exe preprocess.py --wordlists # 仅词表标签

反思（第一百七十五次，用户质问"图标你咋处理的，preprocess.py 中没见着"）：
  - 图标此前是一次性手工生成后直接落盘 src/data/icons/，脚本里确实无迹可循，
    源图一变就无从复现。本次固化为 --icons 子任务（Pillow 缩放），并补 argparse。
  - 同时修正既存路径缺陷：OUTPUT_DIR 原为 Path(__file__).parent/"src"/"data"，
    脚本移入 scripts/ 后实际指向 scripts/src/data（写错地方）。改为 .parent.parent。
"""

import argparse
import gzip
import json
import shutil
from datetime import datetime
from pathlib import Path

from loguru import logger

# === 配置 ===

# wordfreq 数据目录（small_*.msgpack.gz 所在）
WORDFREQ_DIR = Path(r"C:/data/corpus/wordfreq-3.0.2/wordfreq/data")

# 词表目录（来自 BeaverWord/preprocess/word_list/，仅英文）
WORDLIST_DIR = Path(r"C:/code/河狸记词/BeaverWord/preprocess/word_list")

# 输出目录（scripts/ 的上一级即扩展项目根）
PROJECT_ROOT = Path(__file__).parent.parent
OUTPUT_DIR = PROJECT_ROOT / "src" / "data"
WORDFREQ_OUTPUT_DIR = OUTPUT_DIR / "wordfreq"
WORDLISTS_OUTPUT_PATH = OUTPUT_DIR / "wordlists.json"

# 图标源图与输出（第一百七十五次）
LOGO_SRC = Path(r"C:/code/河狸记词/文档/logo.png")
ICONS_OUTPUT_DIR = OUTPUT_DIR / "icons"
ICON_SIZES = [16, 32, 48, 128, 144]   # 128 商店图标；144 备用（部分平台高分屏）

# 界面前十大语言（仅用于 UI 语言下拉菜单，与 i18n.js SUPPORTED_LANGS 一致）
# 注：目标/释义语言支持 wordfreq 全部语言（动态扫描），不限于这10种
UI_LANGS = ["en", "zh", "hi", "es", "ar", "fr", "bn", "pt", "ru", "ja"]

# 词表配置（与前端 lemmatizer.js 词表标签匹配一致）
# id -> 文件名
WORD_LISTS = {
    "CET4":     "CET4.txt",
    "CET6":     "CET6.txt",
    "TEM4":     "Level4.txt",   # Level4.txt 对应 TEM4
    "TEM8":     "Level8.txt",   # Level8.txt 对应 TEM8
    "GRADUATE": "考研.txt",
    "IELTS":    "IELTS.txt",
    "TOEFL":    "TOEFL.txt",
    "GRE":      "GRE.txt",
    "GMAT":     "GMAT.txt",
    "SAT":      "SAT.txt",
}


def copy_wordfreq_files():
    """
    动态扫描源目录所有 small_*.msgpack.gz 并复制到 src/data/wordfreq/
    反思（2026-08-02 修正）：初版仅复制 UI_LANGS 内10种，用户要求目标/释义语言支持几十种，
      改为动态扫描源目录所有 small_*.msgpack.gz 文件（42种语言）。
    """
    WORDFREQ_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 动态扫描源目录
    src_files = sorted(WORDFREQ_DIR.glob("small_*.msgpack.gz"))
    if not src_files:
        logger.error(f"未找到 small_*.msgpack.gz 文件: {WORDFREQ_DIR}")
        return

    total_size = 0
    copied_count = 0
    for src in src_files:
        # 从文件名提取 lang（如 small_en.msgpack.gz → en）
        lang = src.stem.replace("small_", "").replace(".msgpack", "")
        dst = WORDFREQ_OUTPUT_DIR / src.name
        shutil.copy2(src, dst)
        size_kb = dst.stat().st_size / 1024
        total_size += size_kb
        copied_count += 1
    logger.info(f"wordfreq 共 {copied_count} 个文件, 总 {total_size:.0f} KB")


def gen_wordfreq_manifest():
    """
    第一百四十一次（用户裁定"判断并不是你假定的一个值，有实际值，预处理记住"）：
    逐语言解码 small_{lang}.msgpack.gz 统计真实词条数，输出 manifest.json：
      { "version":1, "generatedAt": ISO, "wordCounts": {lang: count}, "sourceDir": ... }
    运行时（dictionary.js）用它作为该语言词典完整性的**实际值基准**：
      库内实数 < manifest 数 ⇒ 增量补齐（upsert 不清库），而非丢弃重来。
    msgpack 为可选依赖：缺失时跳过统计并告警（运行时退回 meta.expected 实际值）。
    """
    try:
        import msgpack
    except ImportError:
        logger.warning("未安装 msgpack（pip install msgpack）——跳过 manifest 生成，"
                       "运行时将以首次成功构建写入的 meta.expected 为完整性基准")
        return

    counts = {}
    for src in sorted(WORDFREQ_OUTPUT_DIR.glob("small_*.msgpack.gz")):
        lang = src.stem.replace("small_", "").replace(".msgpack", "")
        try:
            with gzip.open(src, "rb") as f:
                data = f.read()
            obj = msgpack.unpackb(data, raw=False)
            # wordfreq small 真实结构：[header, 频段0, 频段1, …, 频段599]
            # 每频段是该频率档的词表；总词条数 = 各频段长度之和（en=28917 实测）。
            # 顶层 len=601 是"1 header + 600 频段"，绝不能直接 len(obj)。
            n = 0
            if isinstance(obj, list):
                for band in obj[1:]:
                    if isinstance(band, list):
                        n += len(band)
            elif isinstance(obj, dict):
                n = len(obj)
            counts[lang] = n
            logger.info(f"manifest: {lang} = {n} 词")
        except Exception as e:
            logger.error(f"解码失败 {src.name}: {e}")

    if not counts:
        logger.warning("manifest 无任何语言计数，未生成")
        return

    manifest = {
        "version": 1,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "sourceDir": str(WORDFREQ_DIR),
        "wordCounts": counts,
    }
    out = WORDFREQ_OUTPUT_DIR / "manifest.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))
    logger.info(f"输出: {out} ({len(counts)} 语言)")


def load_wordlists():
    """加载10个英文词表，返回 {id: set(words)}"""
    wordlists = {}
    for list_id, filename in WORD_LISTS.items():
        path = WORDLIST_DIR / filename
        if not path.exists():
            logger.warning(f"词表不存在: {path}")
            wordlists[list_id] = set()
            continue
        words = set()
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                w = line.strip().lower()
                if w:
                    words.add(w)
        wordlists[list_id] = words
        logger.info(f"加载词表 {list_id}: {len(words)} 词 ({filename})")
    return wordlists


def build_wordlists_json(wordlists):
    """
    构建 {word_lower: [list_ids]} 字典
    仅包含至少属于一个词表的单词（避免大文件）
    """
    word_to_tags = {}
    for list_id, words in wordlists.items():
        for w in words:
            if w not in word_to_tags:
                word_to_tags[w] = []
            word_to_tags[w].append(list_id)
    logger.info(f"wordlists.json: {len(word_to_tags)} 个词含标签")
    return word_to_tags


def gen_icons():
    """由 文档/logo.png 生成扩展各尺寸图标 → src/data/icons/icon{size}.png

    第一百七十五次固化（用户质问"图标你咋处理的"）：
      - 统一取正方形中心裁切后缩放（源图非正方时避免拉伸变形）；
      - 一律转 RGBA 保留透明通道（Chrome 工具栏图标需透明背景）；
      - LANCZOS 重采样，小尺寸（16/32）细节保留较好；
      - Pillow 为可选依赖，缺失时明确报错而不静默跳过（不遮蔽错误）。
    """
    try:
        from PIL import Image
    except ImportError:
        logger.error("生成图标需要 Pillow：C:/ProgramData/miniconda3/python.exe -m pip install pillow")
        return False
    if not LOGO_SRC.exists():
        logger.error(f"图标源图不存在: {LOGO_SRC}")
        return False

    ICONS_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    src = Image.open(LOGO_SRC).convert("RGBA")
    w, h = src.size
    # 中心正方裁切（源图 w!=h 时）
    if w != h:
        side = min(w, h)
        left = (w - side) // 2
        top = (h - side) // 2
        src = src.crop((left, top, left + side, top + side))
        logger.info(f"源图 {w}x{h} → 中心裁切为 {side}x{side}")

    for size in ICON_SIZES:
        out = ICONS_OUTPUT_DIR / f"icon{size}.png"
        src.resize((size, size), Image.LANCZOS).save(out, format="PNG", optimize=True)
        logger.info(f"输出图标: {out.name} ({size}x{size}, {out.stat().st_size / 1024:.1f} KB)")
    logger.info(f"图标输出目录: {ICONS_OUTPUT_DIR}")
    return True


def main():
    parser = argparse.ArgumentParser(description="VocabRadar 浏览器扩展 预处理")
    parser.add_argument("--wordfreq", action="store_true", help="仅复制词频数据并生成 manifest")
    parser.add_argument("--wordlists", action="store_true", help="仅生成英文词表标签 JSON")
    parser.add_argument("--icons", action="store_true", help="仅由 文档/logo.png 生成扩展图标")
    args = parser.parse_args()
    # 未指定任何子任务 = 全做
    run_all = not (args.wordfreq or args.wordlists or args.icons)

    logger.info("=== VocabRadar 浏览器扩展 预处理 ===")

    # 1. 复制 wordfreq 数据文件
    if run_all or args.wordfreq:
        if not WORDFREQ_DIR.exists():
            logger.error(f"wordfreq 数据目录不存在: {WORDFREQ_DIR}")
        else:
            copy_wordfreq_files()
            # 1.5 第一百四十一次：逐语言解码统计真实词条数 → manifest.json（实际值基准）
            gen_wordfreq_manifest()

    # 2. 构建英文词表标签 JSON
    if run_all or args.wordlists:
        if not WORDLIST_DIR.exists():
            logger.warning(f"词表目录不存在: {WORDLIST_DIR}，跳过 wordlists.json 生成")
        else:
            wordlists = load_wordlists()
            word_to_tags = build_wordlists_json(wordlists)

            OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
            with open(WORDLISTS_OUTPUT_PATH, "w", encoding="utf-8") as f:
                json.dump(word_to_tags, f, ensure_ascii=False, separators=(",", ":"))

            size_kb = WORDLISTS_OUTPUT_PATH.stat().st_size / 1024
            logger.info(f"输出: {WORDLISTS_OUTPUT_PATH} ({len(word_to_tags)} 词, {size_kb:.1f} KB)")

    # 3. 第一百七十五次：扩展图标
    if run_all or args.icons:
        gen_icons()

    logger.info("=== 预处理完成 ===")
    logger.info(f"输出目录: {OUTPUT_DIR}")
    logger.info("提示：wordbank.json 已弃用，可手动删除")


if __name__ == "__main__":
    main()

