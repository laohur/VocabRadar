"""backend 配置与路径：内置默认值 + backend/config.json 用户层覆盖（deep merge）。

config.json 不存在或损坏时回落默认值；写入用原子替换（tmp + os.replace）。
"""

import copy
import json
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
UI_DIR = os.path.join(BASE_DIR, "ui")
MEDIA_DIR = os.path.join(BASE_DIR, "media")
CACHE_DIR = os.path.join(BASE_DIR, "cache")
BIN_DIR = os.path.join(BASE_DIR, "bin")

DEFAULTS = {
    "port": 7777,            # 对外端口（扩展与管理界面固定指向）
    "host": "127.0.0.1",     # 只绑回环，不暴露局域网
    "llm": {
        "engine": "llamacpp",   # 固定项（§3.2），无其他引擎选项
        "port": 7788,           # llama-server 内部端口，backend 反代 /v1/*
        "ctx": 16384,           # 第418次：默认 16k（原 65536 吃显存，Vulkan 小卡易 OOM）
        "mode": "resident",     # resident | on-demand
        "idle_timeout": 600,    # on-demand 空闲退出秒数
        # 主模型 GGUF 文件名（第408次：多模型可选切换，如 MiniCPM5-1B-Q4_K_M.gguf）；
        # 空 = 自动取 models/ 下首个主 GGUF（mmproj 除外，旧行为）。
        # 注意 MiniCPM 系纯文本无 mmproj，选它则 LLM 视觉 OCR 失效，视觉需切回 Qwen 系。
        "model": "",
    },
    "asr": {
        "engine": "faster-whisper",  # 唯一引擎（第404次：qwen3-asr 备选整体移除——第三百九十六次裁定其不作默认，本批裁定彻底删除）
        "mode": "resident",
        "cache": True,
        "whisper_model": "large-v3-turbo",  # faster-whisper 档位全名：large-v3-turbo/tiny/base/small/medium/large-v3（旧值 turbo 自动归一）
    },
    "ocr": {"engine": "rapidocr", "mode": "resident"},  # engine: llm | rapidocr；mode 仅 rapidocr 生效（llm 归 llm 段管）
    "translate": {"engine": "llm"},  # 翻译只走 llm（第三百九十五次：argos 移除）
    # cookiefile：Netscape 格式 cookie.txt 路径——仅登录墙内容需要（YouTube 年龄
    # 限制/机器人墙、B 站大会员清晰度等）；务必小号导出（主号自动化下载有风控
    # 封号风险），相对路径基于 backend/ 目录，路径不存在会报错；空 = 不携带
    # cookies_from_browser：自动取已登录浏览器的 cookie（yt-dlp 原生
    # --cookies-from-browser），空 = 关闭；与 cookiefile 二选一，cookiefile 优先。
    # Windows 上 Chrome 127+ 因 App-Bound Encryption 解密会失败，Firefox 最稳，
    # Edge/Brave 视版本而定；成功与否取决于浏览器已登录目标站点
    "ytdl": {"format": "m4a", "cookiefile": "", "cookies_from_browser": ""},
    "binaries": {"gpu": "auto"},                   # auto | vulkan | cuda | cpu
}


def deep_merge(base, override):
    """递归合并：override 覆盖 base，返回新 dict，不改动入参。"""
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def load():
    """读配置：默认值 + config.json 覆盖。"""
    cfg = copy.deepcopy(DEFAULTS)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            disk = json.load(f)
    except (OSError, ValueError):
        disk = {}
    cfg = deep_merge(cfg, disk)
    return cfg


def save(cfg):
    """完整写盘（调用方负责先 deep_merge），原子替换。"""
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)


def needs_setup():
    """第431次：模型全走 llama-server -hf 自动下载（HF hub 缓存），models/
    本地目录撤销，「未安装」概念消失；只剩「未配置」——无任何模型卡片即
    视为未完成首次设置（扩展端据此提示去管理界面选卡）。"""
    return not (load().get("llm") or {}).get("cards")


def set_engine_stopped(section, stopped):
    """第410次：持久化引擎手动停机标志（config.json <section>.stopped）。

    _manual_stop 是内存态，后端进程重启即丢——用户主动关停的服务下次启动
    又被无条件自动拉起。此助手按 _persist_port 同款「读盘→改单键→save」
    模式增量更新，不固化完整配置；stopped=False 移除该键保持 config.json 干净。
    """
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            disk = json.load(f)
    except (OSError, ValueError):
        disk = {}
    if not isinstance(disk, dict):
        disk = {}
    sec = disk.setdefault(section, {})
    if not isinstance(sec, dict):
        sec = disk[section] = {}
    if stopped:
        sec["stopped"] = True
    else:
        sec.pop("stopped", None)
    save(disk)
