"""backend 配置与路径：代码内置默认值（DEFAULTS）+ backend/config.json 用户层覆盖。

出厂不带 config.json：用户首次在管理界面设定时才生成；用户设定优于默认，
没有用户配置（或文件损坏）时回落 DEFAULTS。写入用原子替换（tmp + os.replace）；
config.json 只存用户设定（最小持久化），不固化默认值。
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

# 出厂内置的 LLM 模型卡片（llama-server -hf 自动下载，HF hub 缓存；fallback_url
# 走 ModelScope 镜像）。默认不选卡（llm.model 为空），管理页选卡后才落 config.json。
_BUILTIN_CARDS = [
    {
        "name": "unsloth/Qwen3-0.6B-GGUF:Q4_K_M",
        "desc": "最小最快的对话/翻译模型（纯文本，无视觉 OCR；Q4_K_M 量化更省盘）",
        "desc_en": "smallest & fastest chat/translate model (text-only, no vision OCR; Q4_K_M, smaller)",
        "hf_repo": "unsloth/Qwen3-0.6B-GGUF",
        "fallback_url": "https://modelscope.cn/models/unsloth/Qwen3-0.6B-GGUF/resolve/master/Qwen3-0.6B-Q4_K_M.gguf",
        "command": "llama-server -hf unsloth/Qwen3-0.6B-GGUF:Q4_K_M --jinja --host 127.0.0.1 --port 7788 -c 16384",
        "sampling": {
            "temperature": 0.7,
            "top_p": 0.8,
            "top_k": 20,
            "min_p": 0,
            "repeat_penalty": 1.1
        }
    },
    {
        "name": "unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M",
        "desc": "对话/翻译/视觉 OCR 模型（多模态；Q4_K_M 量化更省盘）",
        "desc_en": "chat/translate/vision OCR model (multimodal; Q4_K_M, smaller)",
        "hf_repo": "unsloth/Qwen3.5-0.8B-GGUF",
        "fallback_url": "https://modelscope.cn/models/unsloth/Qwen3.5-0.8B-GGUF/resolve/master/Qwen3.5-0.8B-Q4_K_M.gguf",
        "fallback_mmproj_url": "https://modelscope.cn/models/unsloth/Qwen3.5-0.8B-GGUF/resolve/master/mmproj-F16.gguf",
        "command": "llama-server -hf unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M --image-min-tokens 1024 --jinja --host 127.0.0.1 --port 7788 -c 16384",
        "sampling": {
            "temperature": 0.7,
            "top_p": 0.8,
            "top_k": 20,
            "min_p": 0,
            "repeat_penalty": 1.1
        }
    },
    {
        "name": "unsloth/Qwen3.5-2B-GGUF:Q4_K_M",
        "desc": "对话/翻译/视觉 OCR 模型（多模态；比 0.8b 更强）",
        "desc_en": "chat/translate/vision OCR model (multimodal; stronger than 0.8b)",
        "hf_repo": "unsloth/Qwen3.5-2B-GGUF",
        "fallback_url": "https://modelscope.cn/models/unsloth/Qwen3.5-2B-GGUF/resolve/master/Qwen3.5-2B-Q4_K_M.gguf",
        "fallback_mmproj_url": "https://modelscope.cn/models/unsloth/Qwen3.5-2B-GGUF/resolve/master/mmproj-F16.gguf",
        "command": "llama-server -hf unsloth/Qwen3.5-2B-GGUF:Q4_K_M --image-min-tokens 1024 --jinja --host 127.0.0.1 --port 7788 -c 16384",
        "sampling": {
            "temperature": 0.7,
            "top_p": 0.8,
            "top_k": 20,
            "min_p": 0,
            "repeat_penalty": 1.1
        }
    },
    {
        "name": "openbmb/MiniCPM5-1B-GGUF:Q4_K_M",
        "desc": "轻量纯文本备选模型（无视觉 OCR；Q4_K_M 量化更省盘）",
        "desc_en": "lightweight text-only fallback (no vision OCR; Q4_K_M, smaller)",
        "hf_repo": "openbmb/MiniCPM5-1B-GGUF",
        "fallback_url": "https://modelscope.cn/models/OpenBMB/MiniCPM5-1B-GGUF/resolve/master/MiniCPM5-1B-Q4_K_M.gguf",
        "command": "llama-server -hf openbmb/MiniCPM5-1B-GGUF:Q4_K_M --jinja --host 127.0.0.1 --port 7788 -c 16384",
        "sampling": {
            "temperature": 0.7,
            "top_p": 0.95,
            "min_p": 0,
            "repeat_penalty": 1.1
        }
    },
    {
        "name": "openbmb/MiniCPM5-2B-GGUF:Q4_K_M",
        "desc": "纯文本备选模型（无视觉 OCR；比 1b 更强）",
        "desc_en": "text-only fallback (no vision OCR; stronger than 1b)",
        "hf_repo": "openbmb/MiniCPM5-2B-GGUF",
        "fallback_url": "https://modelscope.cn/models/OpenBMB/MiniCPM5-2B-GGUF/resolve/master/MiniCPM5-2B-Q4_K_M.gguf",
        "command": "llama-server -hf openbmb/MiniCPM5-2B-GGUF:Q4_K_M --jinja --host 127.0.0.1 --port 7788 -c 16384",
        "sampling": {
            "temperature": 0.7,
            "top_p": 0.95,
            "min_p": 0,
            "repeat_penalty": 1.1
        }
    }
]

DEFAULTS = {
    "port": 7777,            # 对外端口（扩展与管理界面固定指向）
    "host": "127.0.0.1",     # 只绑回环，不暴露局域网
    "llm": {
        "engine": "llamacpp",   # 固定项，无其他引擎选项
        "port": 7788,           # llama-server 内部端口，backend 反代 /v1/*
        "ctx": 16384,           # 默认 16k（大值吃显存，Vulkan 小卡易 OOM）
        "mode": "on-demand",    # resident | on-demand
        "idle_timeout": 600,    # on-demand 空闲退出秒数
        # 主模型名（= 所选卡片 name，如 unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M）；
        # 空 = 未选卡（needs_setup 据此判定首次设置未完成）。
        # 注意 MiniCPM 系纯文本无 mmproj，选它则 LLM 视觉 OCR 失效，视觉需切回 Qwen 系。
        "model": "",
        # 默认全关：不预载、业务请求不自动拉起；管理页点启动 = 写 stopped:false
        # （用户设定持久化），点关停 = 移除该键回落默认停机。
        "stopped": True,
        "cards": _BUILTIN_CARDS,
    },
    "asr": {
        "engine": "faster-whisper",  # 唯一引擎
        "mode": "on-demand",
        "stopped": True,
        "cache": True,
        "whisper_model": "large-v3-turbo",  # faster-whisper 档位全名：large-v3-turbo/tiny/base/small/medium/large-v3
    },
    "ocr": {"engine": "rapidocr", "mode": "on-demand", "stopped": True},  # engine: llm | rapidocr；mode 仅 rapidocr 生效（llm 归 llm 段管）
    "translate": {"mode": "on-demand", "stopped": True, "idle_timeout": 600},  # NLLB 引擎生命周期（core 层定引擎）
    # cookiefile：Netscape 格式 cookie.txt 路径——仅登录墙内容需要（YouTube 年龄
    # 限制/机器人墙、B 站大会员清晰度等）；务必小号导出（主号自动化下载有风控
    # 封号风险），相对路径基于 backend/ 目录，路径不存在会报错；空 = 不携带
    # cookies_from_browser：自动取已登录浏览器的 cookie（yt-dlp 原生
    # --cookies-from-browser，每次运行直读浏览器 cookie 库＝现用现取，
    # 无静态文件过期问题）；值可为浏览器名（firefox/chrome/edge/brave/
    # vivaldi/chromium…yt-dlp 支持名单）或 auto＝自动探测本机
    # 已装浏览器（Firefox 无加密最稳故最优先），空 = 关闭；与 cookiefile
    # 二选一，cookiefile 优先。Windows 上 Chrome 127+ 因 App-Bound
    # Encryption 解密会失败，Edge/Brave 视版本而定；成功与否取决于
    # 浏览器已登录目标站点
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


def _read_disk():
    """读磁盘 config.json；不存在/损坏/非 dict 时返回空 dict（回落默认）。"""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            disk = json.load(f)
    except (OSError, ValueError):
        return {}
    return disk if isinstance(disk, dict) else {}


def load():
    """读配置：默认值 + config.json 用户覆盖。"""
    return deep_merge(copy.deepcopy(DEFAULTS), _read_disk())


def save(cfg):
    """完整写盘（调用方负责先 deep_merge），原子替换。"""
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)


def update_user(body):
    """最小持久化用户设定：body deep merge 进磁盘 config.json 并落盘。

    只写用户层，不把 DEFAULTS 固化进文件（出厂默认永远跟随代码）。
    body 为管理界面提交的部分配置 dict，新值覆盖旧值。返回合并后的磁盘内容。
    """
    disk = deep_merge(_read_disk(), body)
    save(disk)
    return disk


def needs_setup():
    """未选主模型（llm.model 为空）即视为未完成首次设置
    （扩展端据此提示去管理界面选卡）。"""
    return not (load().get("llm") or {}).get("model")


def set_engine_stopped(section, stopped):
    """持久化引擎手动启停标志（config.json <section>.stopped）。

    默认值 stopped=true（默认全关，不自动拉起）。增量更新（读盘→改单键→save），
    不固化完整配置：
    - stopped=True：移除该键 → 回落默认（停机）；
    - stopped=False：写入 false → 用户设定持久化（业务请求可按需拉起）。
    """
    disk = _read_disk()
    sec = disk.setdefault(section, {})
    if not isinstance(sec, dict):
        sec = disk[section] = {}
    if stopped:
        sec.pop("stopped", None)
    else:
        sec["stopped"] = False
    save(disk)
