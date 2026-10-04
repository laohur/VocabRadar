/* 管理界面双语：
   key = 英文原文（en 直接回落显示 key，零维护成本），中文查 ZH 表；
   t(key, params) 做 {x} 占位替换；语言存 localStorage('admin_lang')，
   切换入口为右上角地球图标，点击后整页 reload
   生效（页面均为函数式重渲染，无常驻状态，reload 即全量翻译）。 */
'use strict';

const ZH = {
  // ---- 侧栏 / 路由 ----
  'Overview / Status': '总览 / 状态',
  'Translate': '翻译',
  'ASR': '语音识别',
  'OCR': '文字识别',
  'Downloader': '下载器',
  'Not implemented.': '未实现。',

  // ---- 通用 ----
  'Running': '运行中',
  'Stopped': '已停止',
  'Loading…': '加载中…',
  'loading…': '加载中…',
  'Failed: {msg}': '失败：{msg}',
  'Saved.': '已保存。',
  'Saved. Port/host changes require a backend restart to take effect.': '已保存。端口/主机变更需重启后端生效。',
  'Save failed: {msg}': '保存失败：{msg}',
  'Settings': '设定',
  'Switch language': '切换语言',
  'Backend Logs': '后端日志',
  'Refresh': '刷新',
  '(log is empty)': '（日志为空）',

  // ---- 总览表 ----
  'Feature': '功能',
  'Engine': '引擎',
  'Status': '状态',
  'Details': '详情',
  'Action': '操作',
  'Start': '启动',
  'Stop': '关停',
  'Failed to load status: {msg}': '状态加载失败：{msg}',
  'No default model selected. Open the LLM page and pick a model — it auto-downloads on first use.':
    '尚未选择默认模型。请打开 LLM 页选择模型——首次使用时自动下载。',
  'mode={m} · internal port {p}': 'mode={m} · 内部端口 {p}',
  'Model / Engine': '模型 / 引擎',
  '· loaded {e}': '· 已加载 {e}',
  'llama-server running': 'llama-server 运行中',
  'llama-server starting': 'llama-server 启动中',
  'Translate LLM': '翻译 LLM',
  'serves the llama.cpp translation model selected on the Translate page': '承载翻译页所选的 llama.cpp 翻译模型（与对话 LLM 分开启停）',
  'not running': '未运行',
  'default format {f}': '默认格式 {f}',
  '· cookie configured': '· 已配 cookie',

  // ---- 基础设定 ----
  'Basic Settings': '基础设定',
  'Port': '端口',
  'After changing the port and restarting, the extension auto-scans 7777–7827 to find the new address':
    '改端口并重启后，扩展会自动扫描 7777–7827 找到新地址',
  'Listen Address': '监听地址',
  'Keep 127.0.0.1 (do not expose to the LAN)': '保持 127.0.0.1（勿暴露到局域网）',
  'GPU Backend': 'GPU 后端',
  'llama.cpp asset selection; takes effect after restart': 'llama.cpp 资产选择；重启后生效',
  'Save Basic Settings': '保存基础设定',

  // ---- LLM 页 ----
  'LLM (llama.cpp)': 'LLM（llama.cpp）',
  'Model': '模型',
  'Context length (ctx)': '上下文长度 (ctx)',
  'Run mode': '运行模式',
  'resident (always on)': 'resident（常驻）',
  'on-demand': 'on-demand（按需）',
  'Idle exit (seconds, on-demand only)': '空闲退出（秒，仅 on-demand）',
  'General Settings': '通用设定',
  'Default model': '默认模型',
  'Internal port': '内部端口',
  'Model Cards': '模型卡片',
  'Cards are read-only. Models auto-download at llama-server startup (order: HF → hf-mirror → fallback URL) into the HF hub cache.':
    '卡片只读。模型在 llama-server 启动时自动下载（顺序：HF → hf-mirror → 直链兜底），存入 HF hub 缓存。',
  'Default': '默认',
  'Downloaded': '已下载',
  'Not downloaded': '未下载',
  'Status: {s} · internal port {p} · saving General Settings auto-reloads llama-server · MiniCPM is text-only (no vision OCR; use Qwen for vision)':
    '状态：{s} · 内部端口 {p} · 保存通用设定会重载 llama-server · MiniCPM 为纯文本模型（无视觉 OCR；视觉用途请用 Qwen 系）',
  'Saved. Reloading llama-server with the new model…': '已保存，正在用新模型重载 llama-server…',
  'Think': '思考',
  'Thought process': '思考过程',
  'Playground · Chat': '试用 · 对话',
  'Type a message (optionally attach an image)…': '输入消息（可附图片）…',
  'Send': '发送',
  'Generating…': '生成中…',
  'Attach image (multimodal image_url)': '附加图片（多模态 image_url）',
  'Remove image': '移除图片',
  'Clear chat': '清空对话',
  ' [image]': ' [图片]',

  // ---- 翻译页 ----
  'Playground': '试用',
  // ---- 翻译页模型选择 ----
  'Translation model': '翻译模型',
  'nllb = built-in NLLB-200-distilled-600M (in-process CT2, fast). Any other entry is a llama.cpp card served by the dedicated Translate LLM engine (independent start/stop on the Overview page; first request may cold-start it).':
    'nllb = 内置 NLLB-200-distilled-600M（进程内 CT2，快）。其余条目为 llama.cpp 模型卡，由翻译专用的「翻译 LLM」引擎承载（与对话 LLM 分开、在总览页独立启停；首次请求可能触发冷启动下载/加载）。',
  'Model follows the Settings card; start/stop the serving engine on the Overview page.':
    '模型跟随上方设定卡；承载引擎的启停在总览页。',
  'Source language': '源语言',
  'Target language': '目标语言',
  'Auto detect': '自动检测',
  'Enter text to translate…': '输入要翻译的文本…',
  'Translating…': '翻译中…',

  // ---- ASR 页 ----
  'ASR (Speech-to-Text)': '语音识别 (ASR)',
  'Result cache': '结果缓存',
  'Deduplicate by video_id or audio content hash': '按 video_id 或音频内容哈希去重',
  'whisper tier (faster-whisper only)': 'whisper 档位（仅 faster-whisper）',
  'Result Cache': '结果缓存',
  '{n} entries': '{n} 条',
  'video {id}': '视频 {id}',
  'Clear cache': '清空缓存',
  'Playground · Upload Audio to Transcribe': '试用 · 上传音频转写',
  'Audio file (mp3/m4a/wav/webm…)': '音频文件 (mp3/m4a/wav/webm…)',
  'Language hint': '语言提示',
  'Leave empty for auto-detect': '留空自动检测',
  'Optional, e.g. en / ja / zh': '可选，如 en / ja / zh',
  'Select a file first.': '请先选择文件。',
  'Uploading…': '上传中…',
  'Queued…': '排队中…',
  'Transcribing… {p}%': '转写中… {p}%',
  'Done. {n} segments': '完成，共 {n} 段',
  '[cache hit] ': '[缓存命中] ',
  'Transcribe': '开始转写',

  // ---- OCR 页 ----
  'OCR (Image Text Recognition)': '文字识别 (OCR)',
  'llm (vision model)': 'llm（视觉模型）',
  'rapidocr (local lightweight)': 'rapidocr（本地轻量）',
  'Run mode (rapidocr only; llm is managed on the LLM page)': '运行模式（仅 rapidocr；llm 归 LLM 页管理）',
  'Playground · Image Recognition': '试用 · 图片识别',
  'Image file': '图片文件',
  'Select an image first.': '请先选择图片。',
  'Recognizing…': '识别中…',
  '(no text recognized)': '（未识别到文本）',
  'Recognize': '开始识别',

  // ---- 下载器页 ----
  'Downloader (yt-dlp)': '下载器 (yt-dlp)',
  'Default format': '默认格式',
  'Only for callers that do not pass an explicit format (e.g. the extension). The buttons below always send their own format':
    '仅对未显式传格式的调用方生效（如扩展）；下方按钮始终发送各自的格式',
  'm4a (native audio stream)': 'm4a（原生音频流）',
  'bestaudio (best audio)': 'bestaudio（最佳音频）',
  'Cookie file path': 'Cookie 文件路径',
  'Netscape format; relative paths resolve against backend/. Only needed for login-walled content; export from a throwaway account. Takes priority over browser cookies':
    'Netscape 格式；相对路径以 backend/ 为基准。仅登录墙内容需要；建议小号导出。优先于浏览器 cookie',
  'Cookies from browser': '从浏览器取 Cookie',
  'Auto-pick cookies from a logged-in browser (yt-dlp --cookies-from-browser). Chrome 127+ on Windows fails due to App-Bound Encryption — Firefox is the most reliable; requires the target site to be logged in':
    '自动从已登录浏览器取 cookie（yt-dlp --cookies-from-browser）。Windows 上 Chrome 127+ 因 App-Bound Encryption 会失败——Firefox 最稳；需目标站点处于登录态',
  'off': '关',
  'Playground · Resolve → Download': '试用 · 解析 → 下载',
  'Video URL': '视频 URL',
  'Video page URL (Bilibili/YouTube etc.)': '视频页面链接（B站/YouTube 等）',
  'Resolution (video only)': '分辨率（仅视频）',
  'Best (no limit)': '最高（不限）',
  'Audio quality (abr cap)': '音质（abr 上限）',
  'Subtitle language': '字幕语言',
  'Default (original language)': '默认（原始语言）',
  'manual': '手动',
  'auto (machine)': '自动（机器生成）',
  'No subtitles': '无字幕轨道',
  'Enter a URL first.': '请先输入链接。',
  'Resolving…': '解析中…',
  'Title': '标题',
  'Uploader': '上传者',
  'Duration': '时长',
  'Container': '容器',
  'Approx. size': '大小（约）',
  'Subtitle tracks': '字幕轨道',
  'Resolutions': '可选分辨率',
  'Audio qualities': '可选音质',
  'none': '无',
  'Duration {d}s': '时长 {d} 秒',
  'Resolve failed: {msg}': '解析失败：{msg}',
  'Resolve': '解析',
  'Submitting download…': '提交下载…',
  'Task {id} · queued': '任务 {id} · 排队中',
  'Audio (m4a)': '音频 (m4a)',
  'Video (mp4)': '视频 (mp4)',
  'Subtitles': '字幕',
  'Fetching subtitles…': '获取字幕…',
  'Save subtitles.srt ({lang}, {kind}, {n} cues)': '保存 subtitles.srt（{lang}，{kind}，{n} 条）',
  'Subtitles ready: {lang} ({kind}), {n} cues.': '字幕就绪：{lang}（{kind}），{n} 条。',
  'Downloading {p}%': '下载中 {p}%',
  'Done: {name}': '完成：{name}',
  'Save file': '保存文件',
  'unknown error': '未知错误',
};

function currentLang() {
  return localStorage.getItem('admin_lang') || 'en';
}

function t(key, params) {
  let s = currentLang() === 'zh' ? (ZH[key] ?? key) : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split('{' + k + '}').join(String(v));
    }
  }
  return s;
}

// 侧栏静态文案（index.html 内 hardcode）按 data-page 翻译 + 右上角注入
// 地球图标语言切换按钮（fixed 定位样式见 admin.css）。
// 页面内容（main 内）由各页函数渲染时经 t() 输出，无需此处处理。
function initI18n() {
  const labels = {
    overview: 'Overview / Status', llm: 'LLM', translate: 'Translate',
    asr: 'ASR', ocr: 'OCR', ytdl: 'Downloader',
  };
  document.querySelectorAll('.sidebar button[data-page]').forEach((b) => {
    const key = labels[b.dataset.page];
    if (key) b.textContent = t(key);
  });
  const btn = document.createElement('button');
  btn.className = 'lang-globe';
  btn.title = t('Switch language');
  btn.textContent = '🌐';
  btn.style.fontSize = '17px';
  btn.addEventListener('click', () => {
    localStorage.setItem('admin_lang', currentLang() === 'en' ? 'zh' : 'en');
    location.reload();
  });
  document.body.append(btn);
}

initI18n();
