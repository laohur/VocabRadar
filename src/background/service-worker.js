// VocabRadar 后台 Service Worker（ES module 入口）
// 职责（2026-09-27 起为"装配入口"）：按序引入 sw/ 子模块（子模块在自身顶层注册
//   监听/执行幂等副作用），并做唤醒即预热。各子模块职责见其文件头注释：
//   sw/log.js            日志门面（_ts/log + config.json debug 开关）
//   sw/util.js           工具（超时 fetch / base64 / WAV / md5）
//   sw/settings.js       DEFAULT_SETTINGS 唯一属主 + config.json 易坏参数覆盖
//   sw/translate.js      翻译编排（9 渠道串行 + 网站桥接快路径）；渠道实现在 translate-channels.js
//   sw/offscreen.js      offscreen / Firefox 回退 iframe 宿主生命周期 + PING 探针
//   sw/llm.js            LLM 对话（非流式/流式）+ ASR/OCR 引擎配置 + Port 通道注册
//   sw/ocr.js            图片入口缩放 + LLM 视觉识别
//   sw/asr.js            分片/整段在线转写
//   sw/parse-material.js PARSE_MATERIAL 分流（link/image/asr/document/llm/translation）
//   sw/backend.js        网络代理（字幕 / ASR 任务 / 词典 / 正文 / kuromoji）
//   sw/wf.js             wordfreq 拉取与校验 + 7天更新轮询（alarm 监听）
//   sw/menu.js           右键菜单重建与点击分发（顶层幂等注册）
//   sw/router.js         onMessage 消息路由（唯一分发点）
//   sw/lifecycle.js      onInstalled/onStartup/action 点击 + 存量规则迁移
// 第三百九十四次（plan 阶段二③，用户裁定"扩展不再保留这两个模型"）：
//   offscreen Whisper/Tesseract 本地推理整链移除——START_ASR/STOP_ASR 会话状态机
//   （_asrActive/_asrTabId/persistAsrState/restoreAsrState）、ASR_STATUS/ASR_SEGMENT/
//   ASR_ERROR 转发区（生产者已无）、ASR_AUDIO_SEGMENT 的 local 分支（OFFSCREEN_ASR_RECOGNIZE）、
//   OCR 的 tesseract 分支（OFFSCREEN_OCR）、整段转写的本地降级（OFFSCREEN_ASR_WEBM）全删。
//   ASR/OCR 一律走在线引擎：分片 ASR_AUDIO_SEGMENT → handleSegmentByLlm，整段 ASR_LLM_FILE，
//   OCR → handleOcrByLlm（引擎 provider 默认 local-backend）。offscreen document 仍保留
//   （AUDIO_DECODE/EXTRACT_TEXT/PARSE_DOC 三类非模型能力 + PING 探针）。
// 第398次（plan 阶段三2，用户裁定"扩展内音频下载管线全退役，backend 端到端任务式转写"）：
//   FETCH_AUDIO/FETCH_AUDIO_META/FETCH_AUDIO_RANGE 代理通道删除（发送方 asr-client/
//   record-workflow 的 B站/YouTube 音频管线同批退役）；新增 ASR_JOB_SUBMIT/ASR_JOB_POLL
//   代理——content script 受页面 CSP 不能直连 backend，经 SW 调 POST /api/asr/jobs
//   （提交 URL）与 GET /api/asr/jobs/<id>?after=N（增量轮询：下载/转写进度 + 新增转写段）。

// 反思（2026-08-02）：import md5.js 作为副作用脚本，挂到 self.md5
//   供有道翻译 sign 计算使用（sw/util.js 内的 md5Hex 消费；模块缓存保证只执行一次）
import '../lib/vendor/md5.js';
// 第一百九十一次：warmupDictProjection 供 SW 唤醒即预热词典投影
// 拆分后 word-db 消息分发 / 词典初始化 / 释义清洗等由 sw/router.js 与 sw/lifecycle.js
//   各自按需 import（同一模块缓存，只初始化一次）。
import { warmupDictProjection } from '../lib/word-db.js';
// 以下子模块带顶层副作用（监听注册 / 幂等迁移 / 菜单重建），必须被入口静态引入。
// 顺序即模块求值顺序：先日志与工具，再注册监听的 router/menu/llm/wf，最后 lifecycle
//  （其内部保持"词典 init → 规则迁移 → 设置写入"的原相对次序）。
import './sw/log.js';
import './sw/util.js';
import './sw/settings.js';
import './sw/translate-channels.js';
import './sw/translate.js';
import './sw/offscreen.js';
import './sw/ocr.js';
import './sw/asr.js';
import './sw/llm.js';
import './sw/parse-material.js';
import './sw/backend.js';
import './sw/wf.js';
import './sw/menu.js';
import './sw/router.js';
import './sw/lifecycle.js';

// 第一百九十一次：SW 每次被唤醒立即后台预热词典投影。
// MV3 SW 闲置 ~30s 休眠即清空 _projCache（SW 内存态），下一页首请求要付
// 「冷启动 + 全表扫描 + 大消息传输」全价（实测 4448ms）。唤醒即预热让扫库与
// 页面加载并行（调研 Dark Reader 等 MV3 开源实践：唤醒即重建内存态）；
// document_start 预取脚本（dict-prefetch.js）把唤醒时刻提前到网页打开瞬间。
// fire-and-forget：失败静默，不影响按需读取路径。
warmupDictProjection();
