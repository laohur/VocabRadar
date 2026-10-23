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

# 模型卡片推理方式说明（追加到各卡 desc/desc_en 末尾，避免逐卡重复）：
# 所有卡片均由 llama-server（llama.cpp）子进程承载，设备在安装时由
# binaries.gpu 一次性选定（auto→vulkan，NVIDIA/AMD/Intel 通吃；见 backend/README.md
# 「推理方式与设备」）。卡片 command 无设备概念，故不在卡片级再选设备。
_INFER_SUFFIX = "。推理方式：llama-server（llama.cpp）子进程，GPU 后端随安装 binaries.gpu（auto→Vulkan）"
_INFER_SUFFIX_EN = ". Inference: llama-server (llama.cpp) subprocess; GPU backend fixed at install via binaries.gpu (auto→Vulkan)"

# 翻译特化卡片（腾讯混元 Hy-MT2-1.8B）：翻译 LLM（translate_llm.cards）默认卡。
# 2026-10-V1 基准实测（同机同 backend 自装 Vulkan llama-server）：13 句 3.0s 快于
# Index-Translate-2B 的 3.6s，术语/专名全对且 Q4=Q8 无量化损失。纯文本
# （--no-mmproj）：翻译用不到投影，省内存。translate_prompt=翻译提示词模板
# （占位符 {dst}/{text}）：bench 口径对齐腾讯官方 translate.py 模板措辞，与
# 其他家模板不同，core/translate.py 按当前生效卡选用，无模板回落通用模板。
# ModelScope 仓库页未暴露该文件（resolve 404），第三级直链兜底改走 hf-mirror
# （已验证 200；第二级 MODEL_ENDPOINT 镜像重定向本就覆盖 hf-mirror，此处仅
# 直链双保险）。
# -ngl 99（2026-10-10 翻译速度评测，通用技术）：显式全层 GPU 卸载——不写则依赖
# 构建默认，老版 llama-server 默认 ngl=0 会静默全 CPU（Hy-MT2 CPU 仅 23 源词/s
# vs GPU 105）；无 GPU 机器仅告警回落 CPU，安全。同评测：无 GPU 用户机建议切
# LMT 卡（CPU 快 2.3x）；逐行请求即最优，勿做多行合并（LMT 完整性崩）。
_HY_MT2_CARD = {
    "name": "tencent/Hy-MT2-1.8B-GGUF:Q4_K_M",
    "desc": "翻译特化模型（腾讯混元 Hy-MT2-1.8B；基准实测最优，术语/专名更稳；官方支持 33 语互译（含中英日韩等），纯文本，禁用视觉）原始卡：https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF" + _INFER_SUFFIX,
    "desc_en": "translation-specialized (tencent Hy-MT2-1.8B; best in benchmarks with steadier terminology; official 33-language coverage incl. zh/en/ja/ko; text-only, vision disabled) original card: https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF" + _INFER_SUFFIX_EN,
    "hf_repo": "tencent/Hy-MT2-1.8B-GGUF",
    "fallback_url": "https://hf-mirror.com/tencent/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B-Q4_K_M.gguf",
    "command": "llama-server -hf tencent/Hy-MT2-1.8B-GGUF:Q4_K_M --no-mmproj --jinja --host 127.0.0.1 --port 7789 -c 16384 -ngl 99",
    "translate_prompt": "将以下文本翻译为 `{dst}`，注意只需要输出翻译后的结果，不要额外解释：\n\n{text}",
    "sampling": {
        "temperature": 0,
        "top_p": 1.0,
        "min_p": 0
    }
}

# 翻译特化卡片（NiuTrans LMT-60-0.6B，mradermacher 社区 Q4_K_M 量化，484MB）：
# 翻译 LLM 备选轻量卡。NiuTrans 官方权重 Apache-2.0，60 语 234 方向中英枢纽；
# 2026-10-V1 基准 §5.2b：作为进程内 NLLB-600M 的平替是全面升级（Apache vs
# CC-BY-NC、同 CPU 路径快一倍、不漏译不乱码），但术语句中英混杂，质量档请选
# Hy-MT2。translate_prompt=NiuTrans 官方英文三行式提示词（README Quickstart），
# 必须配英语言名占位符 {src_en}/{dst_en}——官方模板被换成中文指令会假崩坏
# （zh2en 输出中文，lab 翻译调研 §5 事故）。.ModelScope 无此仓库，直链兜底走
# hf-mirror（已验证 200，484,220,000 字节与本地 bench 文件一致）。
_LMT60_CARD = {
    "name": "mradermacher/LMT-60-0.6B-GGUF:Q4_K_M",
    "desc": "轻量翻译模型（NiuTrans LMT-60-0.6B 社区量化，60 语中英枢纽；质量弱于 Hy-MT2，术语句中英混杂，胜在小快省）原始卡：https://huggingface.co/NiuTrans/LMT-60-0.6B" + _INFER_SUFFIX,
    "desc_en": "lightweight translation model (NiuTrans LMT-60-0.6B community quant, 60 languages zh-en hub; weaker than Hy-MT2 on terminology, but small & fast) original card: https://huggingface.co/NiuTrans/LMT-60-0.6B" + _INFER_SUFFIX_EN,
    "hf_repo": "mradermacher/LMT-60-0.6B-GGUF",
    "fallback_url": "https://hf-mirror.com/mradermacher/LMT-60-0.6B-GGUF/resolve/main/LMT-60-0.6B.Q4_K_M.gguf",
    "command": "llama-server -hf mradermacher/LMT-60-0.6B-GGUF:Q4_K_M --no-mmproj --jinja --host 127.0.0.1 --port 7789 -c 8192 -ngl 99",
    "translate_prompt": "Translate the following text from {src_en} into {dst_en}:\n{src_en}: {text}\n{dst_en}:",
    "sampling": {
        "temperature": 0,
        "top_p": 1.0,
        "min_p": 0
    }
}

# 翻译特化卡片（NiuTrans LMT-60-1.7B，mradermacher 社区 Q4_K_M 量化，约 1.4GB）：
# 与 0.6B 同套同语清单（60 语 234 方向中英枢纽——高资源 13 语 ar/en/es/de/fr/it/
# ja/nl/pl/pt/ru/tr/zh，中资源 18 语含韩/越/泰/印，低资源 29 语含粤/藏/蒙），
# Qwen3-1.7B 底座，Apache-2.0；体积/速度/质量介于 Hy-MT2-1.8B 与 LMT-60-0.6B
# 之间（同套逐级放大，未单独跑基准）。translate_prompt 与 0.6B 完全一致
# （NiuTrans 官方英文三行式为 LMT-60 全系共用模板，README Quickstart），必须
# 配英语言名占位符 {src_en}/{dst_en}（原因见上方 0.6B 卡注记）。.ModelScope
# 无此仓库，直链兜底走 hf-mirror（已验证 200，重定向 xethub CDN，文件
# LMT-60-1.7B.Q4_K_M.gguf）。
_LMT60_17B_CARD = {
    "name": "mradermacher/LMT-60-1.7B-GGUF:Q4_K_M",
    "desc": "中量翻译模型（NiuTrans LMT-60-1.7B 社区量化，60 语 234 方向中英枢纽；体积/速度/质量介于 Hy-MT2 与 LMT-60-0.6B 之间）原始卡：https://huggingface.co/NiuTrans/LMT-60-1.7B" + _INFER_SUFFIX,
    "desc_en": "mid-size translation model (NiuTrans LMT-60-1.7B community quant, 60 languages / 234 directions, zh-en hub; sits between Hy-MT2 and LMT-60-0.6B in size/speed) original card: https://huggingface.co/NiuTrans/LMT-60-1.7B" + _INFER_SUFFIX_EN,
    "hf_repo": "mradermacher/LMT-60-1.7B-GGUF",
    "fallback_url": "https://hf-mirror.com/mradermacher/LMT-60-1.7B-GGUF/resolve/main/LMT-60-1.7B.Q4_K_M.gguf",
    "command": "llama-server -hf mradermacher/LMT-60-1.7B-GGUF:Q4_K_M --no-mmproj --jinja --host 127.0.0.1 --port 7789 -c 8192 -ngl 99",
    "translate_prompt": "Translate the following text from {src_en} into {dst_en}:\n{src_en}: {text}\n{dst_en}:",
    "sampling": {
        "temperature": 0,
        "top_p": 1.0,
        "min_p": 0
    }
}

# 出厂内置的 LLM 模型卡片（llama-server -hf 自动下载，HF hub 缓存；fallback_url
# 走 ModelScope 镜像）。默认不选卡（llm.model 为空），管理页选卡后才落 config.json。
# Qwen3/Qwen3.5 系模板默认开思考（--jinja 下思考走 delta.reasoning_content）：思考
# 吃满 max_tokens 会正文为空、扩展侧报 "SSE returned no content"（20261023 实测），
# 故卡级统一 --reasoning off 默认关思考（与 MiniCPM-V 4.7 卡同款）；管理页测试窗的
# 请求级 chat_template_kwargs 仍可勾选开启。
_BUILTIN_CARDS = [
    {
        "name": "unsloth/Qwen3-0.6B-GGUF:Q4_K_M",
        "desc": "最小最快的对话/翻译模型（纯文本，无视觉 OCR；Q4_K_M 量化更省盘）" + _INFER_SUFFIX,
        "desc_en": "smallest & fastest chat/translate model (text-only, no vision OCR; Q4_K_M, smaller)" + _INFER_SUFFIX_EN,
        "hf_repo": "unsloth/Qwen3-0.6B-GGUF",
        "fallback_url": "https://modelscope.cn/models/unsloth/Qwen3-0.6B-GGUF/resolve/master/Qwen3-0.6B-Q4_K_M.gguf",
        "command": "llama-server -hf unsloth/Qwen3-0.6B-GGUF:Q4_K_M --reasoning off --jinja --host 127.0.0.1 --port 7788 -c 16384",
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
        "desc": "对话/翻译/视觉 OCR 模型（多模态；Q4_K_M 量化更省盘）" + _INFER_SUFFIX,
        "desc_en": "chat/translate/vision OCR model (multimodal; Q4_K_M, smaller)" + _INFER_SUFFIX_EN,
        "hf_repo": "unsloth/Qwen3.5-0.8B-GGUF",
        "fallback_url": "https://modelscope.cn/models/unsloth/Qwen3.5-0.8B-GGUF/resolve/master/Qwen3.5-0.8B-Q4_K_M.gguf",
        "fallback_mmproj_url": "https://modelscope.cn/models/unsloth/Qwen3.5-0.8B-GGUF/resolve/master/mmproj-F16.gguf",
        "command": "llama-server -hf unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M --image-min-tokens 1024 --reasoning off --jinja --host 127.0.0.1 --port 7788 -c 16384",
        "sampling": {
            "temperature": 0.7,
            "top_p": 0.8,
            "top_k": 20,
            "min_p": 0,
            "repeat_penalty": 1.1
        }
    },
    # MiniCPM-V 4.7 1B（官方 GGUF，2026-10 发布）：Qwen3.5 底座 + SigLIP2 视觉塔，
    # 官方评测整体与效率双超 Qwen3.5-0.8B。llama.cpp 支持随 PR #29416 合入（安装器
    # 取 latest nightly，≥ b11574 满足）。视觉投影必须 -mmu 钉官方推荐的
    # mmproj-model-f16.gguf——-hf 的自动挑选按「量化位数贴近模型」启发式
    # （download.cpp find_best_sibling），Q4 模型会误选 mmproj-model-f16-4x.gguf
    # （4x 细粒度变体，视觉 token ×4）；arg.cpp 中 mmproj.url 非空即跳过仓库自动
    # 挑选，-hf 三源链不受影响。-mmu 用 ModelScope 直链：hf 官方与仅 hf-mirror
    # 两种可达场景都可用（MODEL_ENDPOINT 只重定向 -hf 的仓库解析，不覆盖绝对
    # URL）。--reasoning off：官方注明 v4.7 模板默认开思考，普通回复须显式关
    # （请求级 chat_template_kwargs 仍可按需覆盖，管理页思考开关不受影响）。
    {
        "name": "openbmb/MiniCPM-V-4.7-1B-gguf:Q4_K_M",
        "desc": "对话/翻译/视觉 OCR 模型（多模态，MiniCPM-V 4.7 官方 GGUF；Q4_K_M+视觉投影约 1.8GB 盘；官方评测整体与效率双超 Qwen3.5-0.8B；需 PR #29416 后的 llama.cpp）原始卡：https://huggingface.co/openbmb/MiniCPM-V-4.7-1B-gguf" + _INFER_SUFFIX,
        "desc_en": "chat/translate/vision OCR model (multimodal, official MiniCPM-V 4.7 GGUF; ~1.8GB disk incl. vision projector; beats Qwen3.5-0.8B on official evals; needs llama.cpp with MiniCPM-V 4.7 support, PR #29416) original card: https://huggingface.co/openbmb/MiniCPM-V-4.7-1B-gguf" + _INFER_SUFFIX_EN,
        "hf_repo": "openbmb/MiniCPM-V-4.7-1B-gguf",
        "fallback_url": "https://modelscope.cn/models/OpenBMB/MiniCPM-V-4.7-1B-gguf/resolve/master/MiniCPM-V-4_7-1B-Q4_K_M.gguf",
        "fallback_mmproj_url": "https://modelscope.cn/models/OpenBMB/MiniCPM-V-4.7-1B-gguf/resolve/master/mmproj-model-f16.gguf",
        "command": "llama-server -hf openbmb/MiniCPM-V-4.7-1B-gguf:Q4_K_M -mmu https://modelscope.cn/models/OpenBMB/MiniCPM-V-4.7-1B-gguf/resolve/master/mmproj-model-f16.gguf --reasoning off --jinja --host 127.0.0.1 --port 7788 -c 16384",
        "sampling": {
            "temperature": 0.7,
            "top_p": 0.8,
            "top_k": 100,
            "min_p": 0,
            "repeat_penalty": 1.05
        }
    },
    {
        "name": "unsloth/Qwen3.5-2B-GGUF:Q4_K_M",
        "desc": "对话/翻译/视觉 OCR 模型（多模态；比 0.8b 更强）" + _INFER_SUFFIX,
        "desc_en": "chat/translate/vision OCR model (multimodal; stronger than 0.8b)" + _INFER_SUFFIX_EN,
        "hf_repo": "unsloth/Qwen3.5-2B-GGUF",
        "fallback_url": "https://modelscope.cn/models/unsloth/Qwen3.5-2B-GGUF/resolve/master/Qwen3.5-2B-Q4_K_M.gguf",
        "fallback_mmproj_url": "https://modelscope.cn/models/unsloth/Qwen3.5-2B-GGUF/resolve/master/mmproj-F16.gguf",
        "command": "llama-server -hf unsloth/Qwen3.5-2B-GGUF:Q4_K_M --image-min-tokens 1024 --reasoning off --jinja --host 127.0.0.1 --port 7788 -c 16384",
        "sampling": {
            "temperature": 0.7,
            "top_p": 0.8,
            "top_k": 20,
            "min_p": 0,
            "repeat_penalty": 1.1
        }
    },
    {
        "name": "unsloth/Qwen3.5-4B-GGUF:Q4_K_M",
        "desc": "对话/翻译/视觉 OCR 模型（多模态；约 3.4GB 盘，显存占用明显高于 2B，小显存卡慎与 ASR/翻译并发）" + _INFER_SUFFIX,
        "desc_en": "chat/translate/vision OCR model (multimodal; ~3.4GB disk, noticeably more VRAM than 2b, mind concurrency on small-VRAM GPUs)" + _INFER_SUFFIX_EN,
        "hf_repo": "unsloth/Qwen3.5-4B-GGUF",
        "fallback_url": "https://modelscope.cn/models/unsloth/Qwen3.5-4B-GGUF/resolve/master/Qwen3.5-4B-Q4_K_M.gguf",
        "fallback_mmproj_url": "https://modelscope.cn/models/unsloth/Qwen3.5-4B-GGUF/resolve/master/mmproj-F16.gguf",
        "command": "llama-server -hf unsloth/Qwen3.5-4B-GGUF:Q4_K_M --image-min-tokens 1024 --reasoning off --jinja --host 127.0.0.1 --port 7788 -c 16384",
        "sampling": {
            "temperature": 0.7,
            "top_p": 0.8,
            "top_k": 20,
            "min_p": 0,
            "repeat_penalty": 1.1
        }
    },
    {
        "name": "unsloth/Qwen3.5-9B-GGUF:Q4_K_M",
        "desc": "对话/翻译/视觉 OCR 最强档（多模态；约 6.6GB 盘；Q4 权重+投影已近 8GB 显存上限，仅限独占运行，并发/长上下文易 OOM 自担）" + _INFER_SUFFIX,
        "desc_en": "chat/translate/vision OCR model, strongest tier (multimodal; ~6.6GB disk; Q4 weights+mmproj near the 8GB VRAM ceiling — dedicated use only, OOM at your own risk)" + _INFER_SUFFIX_EN,
        "hf_repo": "unsloth/Qwen3.5-9B-GGUF",
        "fallback_url": "https://modelscope.cn/models/unsloth/Qwen3.5-9B-GGUF/resolve/master/Qwen3.5-9B-Q4_K_M.gguf",
        "fallback_mmproj_url": "https://modelscope.cn/models/unsloth/Qwen3.5-9B-GGUF/resolve/master/mmproj-F16.gguf",
        "command": "llama-server -hf unsloth/Qwen3.5-9B-GGUF:Q4_K_M --image-min-tokens 1024 --reasoning off --jinja --host 127.0.0.1 --port 7788 -c 16384",
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
        "desc": "轻量纯文本备选模型（无视觉 OCR；Q4_K_M 量化更省盘）" + _INFER_SUFFIX,
        "desc_en": "lightweight text-only fallback (no vision OCR; Q4_K_M, smaller)" + _INFER_SUFFIX_EN,
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
        "desc": "纯文本备选模型（无视觉 OCR；比 1b 更强）" + _INFER_SUFFIX,
        "desc_en": "text-only fallback (no vision OCR; stronger than 1b)" + _INFER_SUFFIX_EN,
        "hf_repo": "openbmb/MiniCPM5-2B-GGUF",
        "fallback_url": "https://modelscope.cn/models/OpenBMB/MiniCPM5-2B-GGUF/resolve/master/MiniCPM5-2B-Q4_K_M.gguf",
        "command": "llama-server -hf openbmb/MiniCPM5-2B-GGUF:Q4_K_M --jinja --host 127.0.0.1 --port 7788 -c 16384",
        "sampling": {
            "temperature": 0.7,
            "top_p": 0.95,
            "min_p": 0,
            "repeat_penalty": 1.1
        }
    },
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
        # llama-server 并行槽位（-np，默认 4）：多请求同刻推理的并发上限，
        # 服务端队列外的第一道闸。启动时 -c 按 ctx×parallel 放大注入（每槽
        # 上下文=ctx；llama-server 把总 ctx 均分给各槽），显存随总 ctx 增长。
        "parallel": 4,
        # 主模型名（= 所选卡片 name，如 unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M）；
        # 空 = 未选卡（needs_setup 据此判定首次设置未完成）。
        # 注意 MiniCPM5 系纯文本无 mmproj，选它则 LLM 视觉 OCR 失效，视觉需切回
        # Qwen 系或 MiniCPM-V-4.7（后者为多模态）。
        "model": "",
        # 默认全关：不预载、业务请求不自动拉起；管理页点启动 = 写 stopped:false
        # （用户设定持久化），点关停 = 移除该键回落默认停机。
        "stopped": True,
        "cards": _BUILTIN_CARDS,
    },
    "asr": {
        "engine": "faster-whisper",  # faster-whisper | qwen3-asr | moss | whisper-cpp（多引擎，评审 2026-10）
        "mode": "on-demand",
        "stopped": True,
        "cache": True,
        # 转写并发槽位（默认 4，取代第398次起的全局单路）：URL job 与同步
        # multipart 转写共用同一槽位池，超出者排队。CPU 单路已近饱和，调高
        # 收益有限；GPU（cuda）多路才有明显提速。
        "job_slots": 4,
        "whisper_model": "large-v3-turbo",  # faster-whisper 档位全名：large-v3-turbo/tiny/base/small/medium/large-v3
        # 第558次：whisper 设备（auto|cpu|cuda）。auto=检测到 CUDA 设备且 cuBLAS
        # 可载即用 GPU，失败回落 CPU；未装 GPU 支持（nvidia-cublas-cu12）时
        # auto/cpu 行为与历史 CPU int8 完全一致（零回归）。不热切：改动下次
        # 引擎启动/卸载后生效（第517次口径）。
        "whisper_device": "auto",
        # 计算精度：空=自动（cpu→int8 / cuda→float16）；cuda 可选
        # int8/int8_float16/float16/bfloat16，cpu 可选 int8/int8_float32/float32，
        # 越界值加载时告警并归 int8。
        "whisper_compute_type": "",
        "qwen3_size": "0.6b",       # qwen3-asr 档位：0.6b（默认档，1.35GB/zh 最准）| 1.7b（质量档）
        "moss_quant": "q4_K_M",     # moss 量化：q4_K_M（默认，最快档）| q8_0
        "moss_model_path": "",      # moss 模型 gguf 路径覆盖；空 = backend/models/ 下默认名（缺失时自动补拉，hf → hf-mirror）
        # whisper.cpp 量化（评审 §1.3b 第 4 适配器候选，仅 GPU）：q5_0 唯一档
        # （官方 ggml 574MB + CUDA 二进制 685MB，DLL 随包自带）；q4_0 有损
        # （fr 30.5/hi 44.7）、q8_0 未本地基准，均不接入。无 CUDA 设备如实
        # 拒绝加载，指回落 faster-whisper。
        "wcpp_quant": "q5_0",
    },
    "ocr": {"engine": "rapidocr", "mode": "on-demand", "stopped": True},  # engine: llm | rapidocr；mode 仅 rapidocr 生效（llm 归 llm 段管）
    # 翻译模型选择（值 = translate_llm.cards 卡片名，全部走翻译专用 llama-server
    # 实例）：默认 = Hy-MT2-1.8B 卡（2026-10-V1 基准决策④）；备选 LMT-60-1.7B
    # （中量档）与 LMT-60-0.6B（NLLB 平替轻量卡）。进程内 NLLB 快路径与
    # Index-Translate-2B 卡已移除
    # （基准实测 NLLB 专名漏译/乱码 + CC-BY-NC 商用风险；Index 术语译坏）——
    # 旧值经 _migrate_translate 内存归一，不悬空。首请求可能触发 llama-server
    # 冷启动/下载。管理页翻译段下拉按模型名展示。
    "translate": {"model": _HY_MT2_CARD["name"], "mode": "on-demand", "stopped": True, "idle_timeout": 600},
    # 翻译 LLM 引擎（llama-server 实例）：与对话 LLM（llm 段，7788）分开启停、
    # 分开选卡，默认卡（首卡）= Hy-MT2-1.8B，备选 = LMT-60-1.7B（中量档）、
    # LMT-60-0.6B（轻量档）。对话/OCR 归 llm 段管，翻译 llm 归本段管，互不牵连。
    # 默认全关同 llm 段口径。
    "translate_llm": {
        "engine": "llamacpp",
        "port": 7789,            # 独立内部端口（llm 段 7788）
        "ctx": 16384,
        "parallel": 4,           # llama-server 并行槽位（-np），同 llm 段
        "mode": "on-demand",
        "idle_timeout": 600,
        "model": "",             # 空 = 用首卡（内置 Hy-MT2-1.8B，LMT-60 两档备选）
        "stopped": True,
        "cards": [_HY_MT2_CARD, _LMT60_17B_CARD, _LMT60_CARD],
    },
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
    merged = deep_merge(copy.deepcopy(DEFAULTS), _read_disk())
    _migrate_translate(merged)
    return merged


def _migrate_translate(cfg):
    """translate 旧值归一（内存视图，不回写磁盘——用户下次保存自然落新键）。

    两类历史残留：
    - engine（已废止的引擎抽象键）→ model（模型名）：曾用 engine: "nllb"|"llm"
      表达引擎路由，用户裁定列表元素应为模型名。只看用户层原始磁盘配置
      （合并视图已被 DEFAULTS 填满，无法区分"用户已设新键"），旧键存在且
      用户层未设新键才迁移。
    - model 指向已移除的模型（进程内 NLLB 快路径废除、Index-Translate-2B 卡
      随 Hy-MT2 上位而删除）→ 映射到现役等价卡，防下拉/路由悬空：
      "nllb"→LMT-60-0.6B（基准 §5.2b 实测平替）、Index 卡名→Hy-MT2（主选）。"""
    disk = _read_disk().get("translate")
    if not isinstance(disk, dict):
        return
    legacy = disk.get("engine")
    if legacy is not None and not disk.get("model"):
        if legacy == "llm":
            cards = [c for c in (cfg.get("translate_llm", {}).get("cards") or [])
                     if isinstance(c, dict) and c.get("name")]
            cfg["translate"]["model"] = cards[0]["name"] if cards else _HY_MT2_CARD["name"]
        else:
            cfg["translate"]["model"] = _LMT60_CARD["name"]
    remap = {
        "nllb": _LMT60_CARD["name"],
        "indexteam/index-translate-2b-gguf:q4_k_m": _HY_MT2_CARD["name"],
    }
    val = (cfg.get("translate", {}).get("model") or "").strip().lower()
    if val in remap:
        cfg["translate"]["model"] = remap[val]


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
