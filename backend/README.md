# VocabRadar Backend

本地后端：LLM（llama.cpp）/ 翻译 / ASR / OCR / 媒体下载，监听 `127.0.0.1:7777`。
**本服务为可选增强**：浏览器扩展没有它也完整可用（LLM 默认免费直连轮替）；
安装后扩展可切换到本地推理/离线 ASR 等增强能力。规划详见 `docs/plan-backend.md`。

## 启动

```bash
# 1. 首次安装（幂等，可重复跑）：建 venv、装依赖、下 llama.cpp 与模型
python backend/scripts/install.py

# 2. 日常启动（自动打开 http://127.0.0.1:7777 管理界面）
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

OCR：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/ocr | 双入参：multipart `file` 或 JSON `{image: "data:image/...;base64,..."}`；`engine` 可选（llm / rapidocr）→ `{ok, ...识别结果}` |
| GET | /api/ocr/status | 引擎状态 |

翻译（多模型并存，按模型名选择，管理页翻译段下拉）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/translate | `{text, from?, to}` → `{ok, text, model}`；路由取配置 `translate.model`（"nllb"=内置 NLLB-600M 快路径；卡片名=翻译专用 llama-server 实例，总览页「翻译 LLM」，端口 7789，与对话 LLM 分开启停） |
| GET | /api/translate/status | 状态（model=当前模型选择；loaded/loading/manual_stop 均指 NLLB 侧） |
| GET | /api/translate/models | 翻译模型清单（nllb + translate_llm 卡片，含 installed/is_default，管理页下拉数据源） |

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
| GET | /api/upgrade/check | 四资产检查（llamacpp / ytdlp / models / backend，同步网络请求） |
| POST | /api/upgrade/<action> | action ∈ llamacpp/ytdlp/models，后台线程执行；进行中 409 upgrade_running；llamacpp 动作先自动停 llama-server（Windows 文件锁） |
| GET | /api/upgrade/status | 升级动作进度（stage/log/error），前端轮询 |

## 目录约定

`models/ media/ cache/ bin/` 均为运行时产物（gitignore，不随源码分发）；
升级/覆盖安装不影响这些目录。
