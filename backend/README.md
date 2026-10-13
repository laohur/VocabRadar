# VocabRadar Backend

本地后端：LLM（llama.cpp）/ 翻译 / ASR / OCR / 媒体下载，监听 `127.0.0.1:7777`。
**本服务为可选增强**：浏览器扩展没有它也完整可用（LLM 默认免费直连轮替）；
安装后扩展可切换到本地推理/离线 ASR 等增强能力。规划详见 `docs/plan-backend.md`。

## 启动

```bash
# 1. 首次安装（幂等，可重复跑）：装依赖、下 llama.cpp（模型由 llama-server 首次选卡时自动下载）；
#    检测到 NVIDIA GPU 时会询问是否安装 whisper GPU 支持（y/N，回车默认不装）
python backend/scripts/install.py

# 1b.（可选）whisper GPU 加速（NVIDIA 显卡）：装后管理界面 ASR 页出现「GPU」
#     设定卡，转写约快 5 倍；不装无此卡，whisper 走 CPU，行为与从前一致。
#     详见下方「whisper GPU 加速」；--whisper-gpu no 可明确跳过
python backend/scripts/install.py --whisper-gpu yes

# 2. 升级（llama.cpp / yt-dlp；详见下方「升级」章节）
python backend/scripts/install.py --check
python backend/scripts/install.py --upgrade

# 3. 日常启动（自动打开 http://127.0.0.1:7777 管理界面）
python backend/app.py

# 也可运行级指定端口（仅本次生效，不写回 config.json）
python backend/app.py --port 8888
```

- 要求系统 Python ≥ 3.10（安装器不内置 Python）。
- 运行日志：stderr 同步输出 + `backend/logs/backend.log`（UTF-8，2MB×5 轮转；
  llama-server 子进程输出一并采集），排障先看这里。
- 下载代理自适应：HuggingFace / GitHub 直连不通时自动切换镜像（hf-mirror.com、
  ghfast.top 等），无需手动设置；也可设 `HF_ENDPOINT` / `GH_PROXY` 强制指定。
- 模型也可手动放置：GGUF 与 mmproj 放 `backend/models/` 即可（跳过下载）。

## 配置

`backend/config.json`（改端口等；完整默认值见 `backend/config.py`）。
端口被占用时启动自动向后递延（7777 被占 → 试 7778..7827）并写回；
`--port` 指定时不写回。扩展侧未手动填写「本地后端地址」时会自动扫描
7777–7827 发现新端口（探测 `/api/health`，命中缓存 60 秒），无需同步修改；
已手动填写地址的才需要在 扩展设置-本地后端地址 同步修改。

## 推理方式与设备

全部本地推理，分两类载体：llama-server 子进程（llama.cpp）与进程内引擎。

### llama-server（LLM 对话 / 视觉 OCR / 翻译）

- 载体：llama-server 子进程（llama.cpp，GGUF），两个独立实例分开启停、分开选卡——
  对话 LLM 内部端口 7788、翻译 LLM 内部端口 7789。
- 设备：**二进制级、全局一次选定**。安装时 `config.binaries.gpu`
  （auto | vulkan | cuda | cpu）决定下载哪一份 llama-server
  （`scripts/install.py`：auto→vulkan，NVIDIA/AMD/Intel 通吃、免 CUDA 版本匹配）。
  卡片 `command` 只有 `-ngl 99`（全层 GPU 卸载）等运行参数，**不含设备选择**——
  因此不存在「每张卡各选设备」；切换设备需改 `binaries.gpu` 重装并重启。
- 兼容：CUDA 版仅 NVIDIA；非 NVIDIA 卡请用默认 Vulkan。

### ASR（三引擎，`asr.engine` 选一）

| 引擎 | 推理载体 | 设备 |
|---|---|---|
| faster-whisper（默认） | CTranslate2（进程内） | **可选**（`asr.whisper_device` auto/cpu/cuda）：未装 GPU 支持时 CPU int8；装了 cuBLAS 后 auto=检测到即用 GPU，失败回落 CPU |
| qwen3-asr | DML 编码 + llama.cpp Vulkan 解码（独立 python 子进程） | GPU 专用（Windows + DirectML），纯 CPU 不可用，自动回落 faster-whisper |
| MOSS | transcribe.cpp（ggml 系，进程内） | Vulkan / CUDA 后端包自动探测；CPU 不可用级，无 GPU 时报错回落 faster-whisper |

### OCR（`ocr.engine` 选一）

- llm（默认）：复用对话 LLM 的 llama-server 多模态视觉（mmproj）。
- rapidocr：进程内 PP-OCR，纯 CPU（ONNX），随 pip 分发无需下载。

### whisper GPU 加速（可选，NVIDIA 显卡）

faster-whisper 的 GPU 推理只支持 CUDA（其引擎 CTranslate2 没有 Vulkan/DML
后端），因此做成可选安装：默认不装，安装时检测到 NVIDIA 显卡才会询问。

```bash
python backend/scripts/install.py                    # 检测到 NVIDIA 显卡时询问 y/N（回车=不装）
python backend/scripts/install.py --whisper-gpu yes  # 跳过询问直接安装
python backend/scripts/install.py --whisper-gpu no   # 明确跳过
```

- 装的内容：`nvidia-cublas-cu12`（下载约 553MB；cuDNN 9 已随 ctranslate2 的
  Windows 包自带，无需另装。Linux 会另装 cudnn 包）。
- 装了之后：管理界面 ASR 页出现「GPU」设定卡，设备默认 auto——检测到 CUDA
  即用 GPU，失败自动回落 CPU 并在状态行显示原因；设备/计算精度改动下次引擎
  启动生效。同档转写约快 5 倍（见下表）。
- 不装：无此卡，whisper 一律 CPU，与从前行为一致。已装后重跑安装器自动跳过。

性能对照（本项目 2026-10 基准：同机同素材，RTX 5060 Laptop 8GB，
large-v3-turbo 档，RTFx = 音频秒 ÷ 处理秒，数值越大越快）：

| 设备 | RTFx |
|---|---|
| GPU（CUDA float16） | 11–14x |
| CPU（int8） | 2.2–2.7x |

### 为什么只有 whisper 需要装 CUDA？

其他模型不是不用 GPU，而是用了**免安装**的 GPU 路径——运行库随显卡驱动或
Windows 系统自带，用户无需下载任何东西：

| 功能 | GPU 后端 | 免装的原因 |
|---|---|---|
| 对话 / 翻译 / 视觉 OCR（llama.cpp） | Vulkan | 一份二进制通吃 NVIDIA/AMD/Intel，运行库随显卡驱动自带 |
| MOSS（ggml 系） | Vulkan | 同上 |
| Qwen3-ASR | DirectML | Windows 系统自带运行时 |
| faster-whisper（CTranslate2） | 仅 CUDA | 该引擎的 GPU 后端只有 CUDA，没有 Vulkan/DML |

Vulkan 的取舍：NVIDIA 显卡上比 CUDA 慢约 15%（社区同卡对照通常在
10–30% 区间），换来 AMD/Intel 显卡开箱即用、免掉数百 MB 运行库下载与
CUDA 版本匹配——所以本后端的 llama.cpp/MOSS 统一用 Vulkan 构建。
出处：

- llama.cpp 官方 llama-bench 排行榜（CUDA 居首、Vulkan 以覆盖面见长）：
  [CUDA 榜](https://github.com/ggml-org/llama.cpp/discussions/15013) ·
  [Vulkan 榜](https://github.com/ggml-org/llama.cpp/discussions/10879)
- Vulkan 后端介绍（NVIDIA 卡约慢 15%）：
  [llama.cpp gets Vulkan backend](https://lllm.dev/news/llamacpp-vulkan)
- CTranslate2 GPU 后端仅 CUDA：
  [CTranslate2 安装文档](https://opennmt.net/CTranslate2/installation.html) ·
  [faster-whisper README（cuBLAS for CUDA 12 + cuDNN 9）](https://github.com/SYSTRAN/faster-whisper#gpu)

## API

安全边界：Host 头白名单（仅 `127.0.0.1`/`localhost`），防 DNS rebinding；
CORS 只放行浏览器扩展 origin；管理界面见 `GET /`（`backend/ui/`）。

### 响应形状

- `/api/*`：统一 `{ok: true, ...}` 成功；失败 `{ok: false, error: "<错误码>",
  message?: "..."}` 配语义化状态码（400 参数缺失/非法、404 not_found、
  409 冲突、501 not_implemented、502/503 引擎不可用）。
- `/v1/*`：OpenAI 兼容端点，成功响应为 OpenAI 形状；backend 自身错误
  （引擎启动失败/上游不可达）仍是 backend 形状。

### OpenAI 兼容端点（/v1/*）

任何 OpenAI 格式客户端可直连。扩展 local-backend provider 即按此消费：
`baseUrl = http://127.0.0.1:7777/v1`。

- **POST /v1/chat/completions** — llama-server 纯反代：请求 body 原样透传
  （messages/model/stream/temperature 等，支持范围以 llama-server 为准），
  SSE 流式原样转发。首个请求惰性拉起 llama-server；启动失败 `503
  llm_start_failed`、上游不可达 `502 llm_unreachable`。
- **POST /v1/audio/transcriptions** — OpenAI 转写薄壳（与
  `/api/asr/transcribe` 共用实现）：multipart `file` 必带，`language` 可带
  （透传），`model` 忽略（引擎固定 faster-whisper，由后端配置决定），
  `response_format` 恒 json。成功 `{"text": "..."}`；失败为 backend 形状
  （400 missing_file/bad_audio、503 asr_engine_failed）。

### 功能 API（/api/*）

ASR（faster-whisper）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/asr/transcribe | multipart `file` 必带，`engine`/`language`/`video_id` 可选 → `{ok, cached, text, language, segments?}`；结果缓存（key=video_id 或音频 SHA-256 前 16 位，命中需引擎/语言一致） |
| POST | /api/asr/jobs | `{url, language?}` 提交视频 URL → `{ok, id, status, cached}`；边下边转，缓存命中直接 completed |
| GET | /api/asr/jobs/<id>?after=N | 增量轮询：任务快照 + 第 N 段后新增 `segments` + `segments_total` + `progress{download, transcribe}`；status ∈ queued/downloading/transcribing/completed/failed，failed 带 error |
| GET | /api/asr/status | 引擎状态 |
| GET / DELETE | /api/asr/cache | 缓存列表 / 清空 |
| GET | /api/asr/downloads | 各档位预下载状态（cached=资产齐备；state/progress=手动预下载态；管理页模型卡「下载」按钮数据源） |
| POST | /api/asr/download | `{engine, tier}` 手动预下载（faster-whisper=hub 双源 snapshot；qwen3-asr=GitHub Releases 自取；moss=hf 双源单文件补拉落 backend/models/），后台线程执行幂等 |

OCR：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/ocr | 双入参：multipart `file` 或 JSON `{image: "data:image/...;base64,..."}`；`engine` 可选（llm / rapidocr）→ `{ok, ...识别结果}` |
| GET | /api/ocr/status | 引擎状态 |

翻译（多模型并存，按模型名选择，管理页翻译段下拉）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/translate | `{text, from?, to}` → `{ok, text, model}`；路由取配置 `translate.model`（= translate_llm.cards 卡片名，翻译专用 llama-server 实例，总览页「翻译 LLM」，端口 7789，与对话 LLM 分开启停；进程内 NLLB 快路径已移除） |
| GET | /api/translate/status | 状态（model=当前模型选择；mode=运行模式，生命周期归「翻译 LLM」实例） |
| GET | /api/translate/models | 翻译模型清单（translate_llm 卡片，name/desc/desc_en/installed/is_default；管理页下拉与「模型卡片」区数据源） |
| POST | /api/{llm,translate}/models/download/\<name\> | 手动预下载卡片模型进 HF hub 缓存（hf → hf-mirror 双源，与启动下载同库；管理页卡片「下载」按钮，进行中重复触发幂等；fallback_url 直链兜底仅 llama-server 启动链支持） |

媒体下载（yt-dlp）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/ytdl/resolve?url=&format= | 解析视频信息（format 缺省取配置） |
| POST | /api/ytdl/download | `{url, format?}` → `{ok, id}`（后台任务） |
| GET | /api/ytdl/status[?id=] | 单任务或全部任务快照 |
| GET | /api/ytdl/subtitles?url=&lang= | 扩展五路字幕全失败后的兜底；两轨全空 404 no_subtitles |
| GET | /media/<file_id> | 音视频文件，`conditional=True` 自带 Range（拖动/断点） |

管理 / 升级：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | `{ok, version, needs_setup}`（扩展健康检查） |
| GET / PUT | /api/config | 读 / 深合并写配置；port 或 host 变更返回 `restart_required: true` |
| GET | /api/status | 版本 + needs_setup + models 摘要 + 五引擎总览 |

## 升级

**升级唯一入口是安装脚本**（管理界面不设升级中心，网页不做升级入口）：

```bash
python backend/scripts/install.py --check             # 只查 llama.cpp / yt-dlp 新版本
python backend/scripts/install.py --upgrade           # 升级全部（llama.cpp + yt-dlp）
python backend/scripts/install.py --upgrade llamacpp  # 只升级 llama.cpp
python backend/scripts/install.py --upgrade ytdlp     # 只升级 yt-dlp
```

| 资产 | 检查方式 | 升级动作 |
|---|---|---|
| llama.cpp | `bin/llamacpp/.tag` vs GitHub latest release | 下载到 `_unpack` 验证 → 终止本机 llama-server（Windows 文件锁）→ 原子换名 `bin/llamacpp` → 写 `.tag`；backend 下次请求自动用新版，无需重启 |
| yt-dlp | venv 已装版本 vs PyPI latest | `pip install -U yt-dlp`；backend 重启后生效（`core/ytdl` 进程内已 import） |
| backend 自身 | 无对外发布仓库 | 仅提示：重新下载 zip 覆盖（`config.json` / `models/` / `media/` / `bin/` 保留在外置目录，不受影响） |

- 启动静默检查：`python backend/app.py` 启动时查一次，有新版本仅在日志里
  打印升级命令，不打扰、不改动任何东西。
- 模型无升级体系：llama-server `-hf` 每次启动按仓库解析，自动跟进上游新版本
  （进 HF hub 缓存）。

## 目录约定

`models/ media/ cache/ bin/` 均为运行时产物（gitignore，不随源码分发）；
升级/覆盖安装不影响这些目录。
