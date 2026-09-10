// 界面语言 i18n 模块
// 支持前十大语言（按总使用人数）：en/zh/hi/es/ar/fr/bn/pt/ru/ja
// 完整翻译：en/zh；其他8种语言回退到 en（界面文案翻译待补充，语言名称已本地化）
// 存储 key: uiLanguage，默认 'en'。
//
// 反思（2026-08-02）：
//   - 旧版仅支持 en/zh 切换（toggleLang 二选一），用户要求改为下拉菜单支持前十大语言
//   - 界面文案本地化工作量较大（每语言约80条 key），先实现结构支持
//     + en/zh 完整翻译 + 其他8种语言的语言名称本地化
//   - 切换到未完整翻译的语言时，未命中 key 回退到 en，保证界面可用
//
// 反思（2026-08-02 修正）：
//   - 初版把 UI_LANGS 同时用于 UI语言+目标语言+释义语言（均仅10种）
//   - 用户反馈"界面十大预言，目标和释义语言有几十种"
//   - 拆分为两个常量：
//     (a) UI_LANGS：前10种语言，仅用于 #uiLangSelect 界面语言下拉菜单
//     (b) TRANSLATE_LANGS：42种语言（wordfreq small_*.msgpack.gz 全部），
//         用于 #learnLanguage（目标语言）和 #meaningLanguage（释义语言）下拉菜单
//   - LANG_NAMES 扩展到全部42种语言，便于下拉菜单显示本地化名称
//   - （第二百二十五次：旧别名 SUPPORTED_LANGS 已随命名清查删除，全库统一只用 UI_LANGS）

// === UI 语言列表：前十大语言（按总使用人数从大到小排，第二百二十八次调整 fr/ar 顺序） ===
// 仅用于 #uiLangSelect 界面语言下拉菜单
// 与 preprocess.mjs UI_LANGS 一致
export const UI_LANGS = ['en', 'zh', 'hi', 'es', 'fr', 'ar', 'bn', 'pt', 'ru', 'ja'];

// （第二百二十五次：旧别名 SUPPORTED_LANGS 已删除——全库引用已统一为 UI_LANGS）

// === 目标/释义语言列表：wordfreq 全部支持的语言（42种） ===
// 用于 #learnLanguage 和 #meaningLanguage 下拉菜单
// 与 preprocess.mjs 动态扫描的 small_*.msgpack.bin 文件列表一致（集合一致，顺序仅供展示）
// 注：UI语言仅10种，但目标/释义语言扩展到42种（用户要求"几十种"）
// 第二百二十八次（用户："三种语言列表都从规模往下排"）：按语言使用规模（总使用人数）
//   从大到小排序，替代原字母序；仅影响下拉展示顺序，词典/词频按语言代码取用不受影响。
export const TRANSLATE_LANGS = [
  'en', 'zh', 'hi', 'es', 'fr', 'ar', 'bn', 'pt', 'ru', 'ur',
  'id', 'de', 'ja', 'tr', 'fil', 'vi', 'ta', 'ko', 'fa', 'it',
  'ms', 'pl', 'uk', 'nl', 'ro', 'sh', 'el', 'hu', 'cs', 'sv',
  'he', 'bg', 'da', 'fi', 'nb', 'sk', 'ca', 'lt', 'sl', 'mk',
  'lv', 'is'
];

// === 各语言英文名称（第二百二十八次，用户："释义语言统一英文名称"） ===
// 释义语言下拉用英文名统一呈现（学习语言/界面语言下拉仍用本地化名 LANG_NAMES）。
// 覆盖 TRANSLATE_LANGS 全部 42 种，键集合与之一致。
export const LANG_NAMES_EN = {
  en: 'English', zh: 'Chinese', hi: 'Hindi', es: 'Spanish', fr: 'French',
  ar: 'Arabic', bn: 'Bengali', pt: 'Portuguese', ru: 'Russian', ur: 'Urdu',
  id: 'Indonesian', de: 'German', ja: 'Japanese', tr: 'Turkish', fil: 'Filipino',
  vi: 'Vietnamese', ta: 'Tamil', ko: 'Korean', fa: 'Persian', it: 'Italian',
  ms: 'Malay', pl: 'Polish', uk: 'Ukrainian', nl: 'Dutch', ro: 'Romanian',
  sh: 'Serbo-Croatian', el: 'Greek', hu: 'Hungarian', cs: 'Czech', sv: 'Swedish',
  he: 'Hebrew', bg: 'Bulgarian', da: 'Danish', fi: 'Finnish', nb: 'Norwegian Bokmål',
  sk: 'Slovak', ca: 'Catalan', lt: 'Lithuanian', sl: 'Slovenian', mk: 'Macedonian',
  lv: 'Latvian', is: 'Icelandic'
};

// === 各语言的本地化名称（用于下拉菜单显示） ===
// 反思（2026-08-02）：用户在自己母语中看到的语言名称，便于识别
// LANG_NAMES 覆盖全部42种语言（含UI_LANGS 的10种 + 额外32种）
export const LANG_NAMES = {
  // === UI 前10种语言 ===
  en: 'English',
  zh: '中文',
  hi: 'हिन्दी',
  es: 'Español',
  ar: 'العربية',
  fr: 'Français',
  bn: 'বাংলা',
  pt: 'Português',
  ru: 'Русский',
  ja: '日本語',
  // === 额外32种语言（wordfreq 支持，UI 不显示但目标/释义语言可选） ===
  bg: 'Български',
  ca: 'Català',
  cs: 'Čeština',
  da: 'Dansk',
  de: 'Deutsch',
  el: 'Ελληνικά',
  fa: 'فارسی',
  fi: 'Suomi',
  fil: 'Filipino',
  he: 'עברית',
  hu: 'Magyar',
  id: 'Bahasa Indonesia',
  is: 'Íslenska',
  it: 'Italiano',
  ko: '한국어',
  lt: 'Lietuvių',
  lv: 'Latviešu',
  mk: 'Македонски',
  ms: 'Bahasa Melayu',
  nb: 'Norsk Bokmål',
  nl: 'Nederlands',
  pl: 'Polski',
  ro: 'Română',
  sh: 'Српскохрватски',
  sk: 'Slovenčina',
  sl: 'Slovenščina',
  sv: 'Svenska',
  ta: 'தமிழ்',
  tr: 'Türkçe',
  uk: 'Українська',
  ur: 'اردو',
  vi: 'Tiếng Việt'
};

const DICT = {
  en: {
    // 侧边栏
    // 第一百七十六次：去掉 🦫（Win10 无字形），小图标改由 brandIconSVG() 内联
    'tab.subtitle': '🎬 Subtitles',
    'tab.words': '📖 Vocabulary',
    'tab.learn': '📱 Learn',
    'tool.rank': 'Rank',
    'tool.annotation': 'Annotation',
    'tool.detail': 'Detail',
    'tool.export': 'Word List',
    'btn.copy': '📋 Copy',
    'btn.danmaku': '🎯 Danmaku',
    'btn.downloadAudio': '⬇️ Audio',
    // 第一百七十一次：💬 让位给 Chat 按钮，评论按钮改用 📝
    'btn.comment': '📝 Comment',
    'btn.chat': '💬 Chat',
    // 第一百七十一次：视频侧栏 copy 右侧的导出按钮（按本文件惯例 emoji 写在词条值里）
    'btn.export': '💾 Export',
    'btn.ocr': '📷 OCR Frame',
    // 第二百三十九次：OCR 链路用户可见提示（vs/ocr.js）——原中文硬编码改 i18n（用户："英文哪来的中文提示？"）；
    //   offscreen 技术性错误消息固定英文，不进本表
    'ocr.failPrefix': 'OCR failed: ',
    'ocr.extUpdated': 'Extension updated. Refresh the page (F5) before using OCR.',
    'ocr.noVideo': 'No video found for OCR',
    'ocr.unknownErr': 'Unknown error',
    'ocr.noText': 'No text recognized',
    // 第二百五十三次：Parser 栏功能提示；第二百五十五次接线——todo* 占位键退役，换解析过程键
    'parser.parsing': 'Parsing…',
    'parser.fetching': 'Fetching page…',
    'parser.bytes': 'bytes',
    'parser.empty': 'No text extracted.',
    'parser.fail': 'Parse failed: ',
    'parser.unsupported': 'Unsupported type: {what}',
    // 256 次：多链接/多文件/复制导出
    'parser.linksCount': '{n} link(s)',
    'parser.multiFiles': '{n} file(s)',
    'parser.copied': 'Copied to clipboard.',
    'parser.copyFail': 'Copy failed: ',
    // 257/260 次：空态提示 i18n 化、结果框元信息行（字符+字节，替代完成 toast）
    'parser.outputTip': 'Parsed plain text will appear here.',
    'parser.needDocx': 'Legacy .doc is not supported — please save it as .docx first.',
    'parser.fileSave': 'Save file',
    'parser.fileDelete': 'Remove from batch',
    'parser.noInput': 'Enter text or a link, or drop/paste a file first',
    'parser.fileAttached': 'File',
    'parser.linkDetected': 'Link detected',
    'parser.chars': 'characters',
    // 第一百七十一次：Chat 对话面板（src/lib/chat.js）
    'chat.title': '💬 VocabRadar Chat',
    'chat.placeholder': 'Ask a follow-up (Enter to send, Shift+Enter for a new line)',
    'chat.send': 'Send',
    'chat.thinking': 'Thinking...',
    'chat.failed': 'Request failed',
    'chat.openGuide': 'Open settings to configure the model',
    'chat.noText': 'No text to discuss',
    // 第九十六次：下载音频按钮 toast（弹幕按钮已移除、弹幕模块已删除）
    'toast.dlAudioBusy': 'Download already in progress...',
    'toast.dlAudioOk': 'Audio saved',
    'toast.dlAudioFail': 'Audio download failed: ',
    // 第一百一十次：ASR 进度提示（en 完整；其余语言回退 en）
    'asr.preparing': 'Preparing...',
    'asr.modelDownloading': 'Downloading model',
    'asr.modelReady': 'Model ready',
    'asr.fetchAudio': 'Fetching audio',
    'asr.probeMeta': 'Probing audio',
    'asr.metaFail': 'Meta probe failed',
    'asr.parseHead': 'Parsing audio header',
    'asr.firstReady': 'First chunk ready',
    'asr.dlAudioFile': 'Downloading audio',
    'asr.dlAudioDone': 'Audio downloaded',
    'asr.dlAudioFail': 'Audio download failed',
    'asr.decoding': 'Decoding audio',
    'asr.decodeDone': 'Audio decoded',
    'asr.decodeFail': 'Decode failed',
    'asr.pcmReady': 'PCM ready',
    'asr.streamFallback': 'Stream fallback',
    'asr.directFail': 'Direct download unavailable',
    'asr.ytAudio': 'YouTube audio',
    'asr.prepRecog': 'Preparing recognition',
    'asr.fallbackMode': 'Fallback mode',
    'asr.bgDownload': 'Background download',
    'asr.bgInterrupted': 'Background download interrupted',
    'asr.dlRetry': 'Download retrying',
    'asr.backfillAudio': 'Backfilling start audio',
    'asr.backfillRecog': 'Recognizing start (backfill)',
    'asr.segRetry': 'Segment retrying',
    'asr.gating': 'Syncing subtitles',
    'asr.frontier': 'Frontier',
    'asr.buffer': 'Buffer',
    'asr.allDone': 'Recognition complete',
    'asr.inSync': 'Subtitles fully synced with playback',
    'asr.recognizing': 'Recognizing {i}/{n}',
    'asr.segDone': 'Segment {i}/{n} done',
    'asr.total': 'total',
    'asr.videoEnded': 'Video ended',
    'asr.stopCapture': 'capture stopped',
    'asr.capturing': 'Capturing {i}/{n}',
    'asr.noAudioSeg': 'No audio {i}/{n}',
    'asr.silentSkip': 'Silent skip {i}/{n}',
    'asr.errorLabel': 'Error',
    'asr.rtPaused': 'Realtime fallback: recognition follows playback (direct download unavailable), pauses with video',
    'asr.rtResumed': 'Playback resumed, recognizing',
    'asr.dlGetInfo': 'Fetching audio track...',
    'asr.sameOrigin': 'same-origin channel',
    'asr.audioSaved': 'Audio saved',
    'asr.ctxInvalidated': 'Extension updated — reload this page (F5), then retry ASR',
    'dl.noTrack': 'No audio track in __playinfo__',
    'dl.ytFail': 'YouTube audio fetch failed',
    'dl.unsupportedSite': 'Audio download not supported on this site',
    'dl.metaProbeFail': 'Failed to probe audio size',
    'dl.chunkFail': 'Chunk download failed @ {pos}',
    // 第一百一十三次：录制工作流与回退提示
    'asr.rtSlowTip': 'Realtime recognition lags playback by tens of seconds — prefer download-first recognition, then play in sync.',
    'asr.recordOffer': 'Download unavailable. Record: play through once, audio kept for ASR.',
    'asr.recordBtn': 'Record',
    'asr.backBtn': 'Back',
    'asr.recording': 'Recording',
    'asr.recordingUntilEnd': 'Recording... an audio file will be generated when playback ends',
    'asr.recSavedForAsr': 'Audio saved and kept for next ASR run',
    'asr.recStop': 'Stop & download',
'asr.longWarn': 'Long video: recording plus recognition takes roughly as long as the video itself — prefer direct download, or split the task',
    'btn.settings': 'Settings',
    'btn.close': 'Close (refresh to restore)',
    'btn.sync': 'Sync display',
    'lang.toggleTo': '中文',
    'loading': 'Loading subtitles...',
    'noSubtitle': 'No subtitle data',
    'noSubtitleTip': 'No subtitles, click 🎤 to start ASR',
    'subtitleTimeoutTip': 'Subtitle load timeout, click 🎤 to start ASR',
    'asr.track': 'ASR Track',
    'tool.track': 'Track',
    'tool.none': 'None',
    'asr.start': 'Click to start recognition',
    'asr.stop': 'Stop recognition',
    'asr.listening': 'Listening...',
    'asr.modelLoading': 'Loading ASR model...',
    'learn.tip': 'Scan with WeChat to use the VocabRadar mini-program<br>Learn vocabulary anytime',
  // G3（2026-09-08）：learn 面板按钮行（§6.2）——导入当前侧栏内容为草稿卷轴
  'learn.importDraft': '📚 Import to My Scrolls',
  'learn.importAndOpen': '↗ Import and Open',
  'learn.importOk': 'Draft imported — view it in My Scrolls on the VocabRadar site',
  'learn.importFail': 'Import failed — see console for details',
  'learn.noContent': 'No page text yet — browse and scan a page first',
    // toast
    'toast.copied': 'Copied to clipboard',
    'toast.copyFail': 'Copy failed, please select text manually',
    'toast.noContent': 'Nothing to fill (subtitles not loaded or word list empty)',
    'toast.noTrans': 'No word translations available (translations pending)',
    'toast.danmakuFilled': 'Filled into danmaku box',
    'toast.danmakuFail': 'Danmaku input not found (hover the video to show it)',
    'toast.commentFilled': 'Filled into comment box',
    'toast.commentFail': 'Main comment box not found (scroll to comments and retry)',
    'toast.commentTrimmed': 'Comment too long, randomly picked {picked}/{total} words',
    'toast.learnNoCopy': 'Learn panel has nothing to copy',
    'toast.noVideo': 'Video element not found, cannot jump',
    'toast.asrUnavail': 'Real-time ASR unavailable',
    'toast.asrStarted': 'Real-time ASR started (loading model…)',
    'toast.asrStopped': 'Real-time ASR stopped',
    'toast.asrLoading': 'Downloading ASR model {pct}%',
    'toast.asrReady': 'ASR model ready',
    'toast.asrNeedActiveTab': 'Authorization needed: click the VocabRadar icon on the toolbar once (grants tab access), then click ASR again.',
    // popup
    'popup.learnLang': 'Target Language',
    'popup.meaningLang': 'Definition language',
    'popup.minRank': 'Min Rank',
    'popup.sidebar': 'Video Hint',
    'popup.webSidebar': 'Web Hint',
    // web sidebar
    // 第一百七十六次（用户："侧栏顶行左端的图示字符显示不出来，换成小图标"）：
    //   去掉 🦫（Windows 10 旧版 Segoe UI Emoji 无此字形，渲染成豆腐块）；
    //   左端小图标改由 sidebar-topbar.js 的 brandIconSVG() 统一内联，标题只留纯文字。
    'ws.expand': 'Expand VocabRadar',
    // 召唤视频侧栏（2026-08-20 第八十六次补充③）：悬浮球右键 / 顶行按钮手动启动视频侧栏
    'ws.videoSidebar': 'Video Sidebar',
    // 引导页 OCR 侧栏（2026-08-20 第八十七次补充①）：文本侧栏面板标题
    'ws.textSidebar': 'Text Sidebar',
    'ws.noVideoOnPage': 'No video element on this page',
    'ws.collapse': 'Collapse',
    'ws.settings': 'Settings',
    'ws.openGuide': 'Open guide page',
    'ws.mainTextDiag': 'Main-text extraction diag',
    'ws.resetLayout': 'Reset position & size',
    'ws.close': 'Close (refresh to restore)',
    'ws.langSettings': 'Language Settings',
    'ws.learnLang': 'Target Language',
    'ws.meaningLang': 'Definition language',
    'ws.tabSentences': 'Sentences',
    'ws.tabWords': 'Vocabulary',
    'ws.annotation': 'Annotate',
    'ws.rank': 'Rank',
    'ws.subtitleStyle': 'Sub Style',
    'ws.detail': 'Detail',
    'ws.wordList': 'Word List',
    'ws.scanning': 'Scanning page...',
    'ws.noWords': 'No words yet',
    'ws.avRecognition': 'Audio/Video Recognition',
    'ws.uploadAv': 'Upload',
    'ws.record': 'Record',
    // 第二百五十三次（修复第一百七十八次遗留）：录制来源 radio 改设备名（Microphone/Camera/Screen）——
    //   178 次只改了 guide.html 引用，本表从未补键：ws.recordFrom/recordFromEnd 缺失（EN 硬编码
    //   "from (" 兜底、zh 也显示英文括号），recordAudio/Video/Screen 旧值 Record/Video/Screen
    //   与意图不符。三键全库仅 guide.html 消费（grep 实证），改值无连带。
    'ws.recordFrom': 'from (',
    'ws.recordFromEnd': ')',
    'ws.recordAudio': 'Microphone',
    'ws.recordScreen': 'Screen',
    'ws.recordVideo': 'Camera',
    'ws.recordAudioTitle': 'Record microphone audio (browser ASR)',
    'ws.recordVideoTitle': 'Record camera video with audio (browser ASR)',
    'ws.recordScreenTitle': 'Record screen (with audio, Whisper model)',
    'ws.avStartTip': 'Upload a file, or pick a source (audio/video/screen) and click Record',
    // 反思（2026-08-20 第八十七次修正）：旧指引的 cameraAndMic 设置页通常不列扩展源（用户实测"不存在"）。
//   正确路径：本扩展页地址栏左侧站点信息图标 → 此网站的权限 → 麦克风（扩展源与普通网站同入口）；
//   兜底：edge://extensions → 本扩展详情 → 重置权限；换目录重载换 ID 可 100% 重置。
'ws.micDenied': 'Microphone access denied (extension page). To reset:\n1. On this page click the icon left of the address bar → "Permissions for this site" → Microphone → Ask (or Reset permissions) → reload\n2. Or: edge://extensions → this extension → Details → "Reset permissions"\n3. Or: Windows Settings → Privacy → Microphone → allow apps.\nNote: reloading/reinstalling from the SAME folder keeps the permission; reloading from a DIFFERENT folder (new extension ID) resets it',
    'ws.micDeniedTitle': 'Microphone access denied',
    'ws.micRetry': 'Retry',
    'ws.asrEmptyDone': 'Recognition done: no speech detected',
    'ws.asrResultTip': 'Recognized sentences will appear here.',
    'ws.ocrResultTip': 'Recognized text will appear here.',
    'ws.browserAsrNotSupported': 'Browser speech recognition not supported, falling back to Whisper model',
    'ws.browserAsrListening': 'Browser ASR listening...',
    'ws.browserAsrError': 'Browser ASR error:',
    'ws.browserAsrNoSpeech': 'No speech detected',
    'ws.asrBtnTitle': 'Please upload a video or audio file first',
    'ws.recognize': 'Recognize',
    'ws.stop': 'Stop',
    'ws.ocrRecognition': 'Image Recognition',
    'ws.uploadImg': 'Upload',
    'ws.capturePhoto': 'Camera',
    'ws.uploadImgTitle': 'Upload image file',
    'ws.capturePhotoTitle': 'Take photo from camera',
    'ws.ocrStartTip': 'Click Upload / Camera to start',
    'ws.ocrBtnTitle': 'Please upload an image first',
    'ws.preparing': 'Preparing...',
    'ws.recognizing': 'Recognizing',
    'ws.recognizeDone': 'Done',
    'ws.error': 'Error',
    // 反思（2026-08-14 第五十八次）：noDef 原为空串，导致侧栏句子/词汇面板翻译失败时
    //   注释位置空白，用户反馈"侧栏句子无注释"。改为非空占位。
    // 第一百八十五次：用户裁定"不允许释义说 No definition yet，不可用文字混淆释义"
    //   → 占位改为纯符号破折号，既不空白（保留占位可见性）又不冒充释义文字。
    'ws.decoding': 'Decoding file...',
    'ws.copy': 'Copy',
    'ws.copied': 'Copied',
    'ws.noContent': 'No content to copy',
    'ws.copyFail': 'Copy failed',
    // 第一百七十一次：导出为文件（copy 右侧）
    'ws.exportFile': 'Export',
    'ws.exported': 'Exported',
    'ws.exportFail': 'Export failed: ',
    'ws.translating': 'Translating...',
    // 反思（2026-08-12）：用户反馈"词汇中没有释义"。
    //   翻译失败时词汇面板为空，无任何提示。新增"暂无释义"占位文案。
    // 反思（2026-08-14 第五十八次）：noDef 原为空串，导致侧栏句子/词汇面板翻译失败时
    //   注释位置空白，用户反馈"侧栏句子无注释"。改为非空占位。
    // 第一百八十五次：同上——重复键的后者才生效，两处都须改为纯符号。
    'ws.unsupportedFileType': 'Unsupported file type (please upload video/audio/image)',
    'ws.recognizeAvTitle': 'Recognize uploaded audio/video',
    'ws.recognizeImgTitle': 'Recognize uploaded image',
    'ws.asrOnlyAv': 'ASR only supports video/audio files',
    'ws.ocrOnlyImage': 'OCR only supports image files',
    'ws.extUpdated': 'Extension updated, please refresh the page',
    'ws.asrModelFail': 'ASR model load failed, please check network and retry',
    'ws.asrStartFail': 'ASR start failed: ',
    'ws.noResponse': 'no response',
    'ws.asrFail': 'ASR failed: ',
    // ASR 状态阶段名（翻译 offscreen pushStatus 发送的中文阶段名）
    // 反思（2026-08-08）：用户反馈「菜单依旧中英文夹杂」。
    //   offscreen 的 pushStatus 发送中文阶段名（如 'model加载'），
    //   界面语言为英文时直接显示中文，造成中英文夹杂。
    //   修正：web-sidebar 收到 ASR_STATUS 后翻译阶段名。
    'ws.stageModelLoading': 'Loading ASR model...',
    'ws.stageRecognizingSeg': 'Recognizing segment...',
    'ws.stageWhisperNotReady': 'ASR model not ready, skipping',
    'ws.stageRecognizeResult': 'Recognition result',
    'ws.stageCorrectedEmpty': 'No valid text after correction',
    'ws.stageWhisperFail': 'ASR failed',
    'ws.stageStart': 'ASR starting',
    'ws.stageModelRetry': 'Model retrying...',
    'ws.modelDownloading': 'Downloading model {pct}%',
    'ws.modelReady': 'ASR model ready',
    'ws.recordingInProgress': 'Recording in progress, please stop first',
    'ws.asrInProgress': 'ASR in progress, please stop first',
    'ws.noGetUserMedia': 'getUserMedia not available (possibly HTTP page)',
    'ws.recordStartFail': 'Recording start failed: ',
    'ws.noGetDisplayMedia': 'getDisplayMedia not supported by this browser',
    'ws.noAudioTrack': 'No audio track, please enable "Share audio"',
    'ws.screenStartFail': 'Screen recording start failed: ',
    'ws.screenRecording': 'Screen recording...',
    'ws.audioRecording': '🎙 Recording audio...',
    'ws.videoRecording': '📹 Recording video...',
    'ws.recordingInProgressShort': 'Recording in progress',
    'ws.recording': 'Recording',
    'ws.realtimeRecognition': 'Real-time recognition',
    'ws.recordingStopped': 'Recording stopped',
    'ws.total': 'total',
    'ws.cameraDenied': 'Camera not authorized',
    'ws.cameraNotFound': 'No camera found. Please connect a camera device.',
    // 反思（2026-08-20 第八十五次）：录音失败精确分类——无设备(NotFound) / 占用或系统隐私关闭(NotReadable)
    'ws.micNotFound': 'No microphone found. Please connect a microphone device.',
    'ws.micInUse': 'Microphone is in use or blocked by system privacy settings. Please check Windows Settings → Privacy → Microphone.',
    'ws.micPermissionPrompt': 'Clicking Record requests microphone access; please allow it in the browser prompt.',
    // 反思（2026-08-12 第四十一次）：右键查询面板/悬浮提示界面文本 i18n
    // 第一百八十五次：不可用文字混淆释义 → 空释义用纯符号占位
    // 字幕样式预设名称（3属性×3值=9种 + 无）
    'ws.cameraInUse': 'Camera is in use by another application. Please close it and retry.',
    'ws.cameraStartFail': 'Camera start failed: ',
    'ws.captureRecognize': 'Capture & Recognize',
    'ws.cameraNotReady': 'Camera not ready',
    'ws.photo': 'Photo',
    'ws.cancel': 'Cancel',
    'ws.ocrRunning': 'OCR is running',
    'ws.imgNotLoaded': 'Image not loaded yet',
    'ws.ocrFail': 'OCR failed: ',
    'ws.ocrNoText': 'No text recognized',
    'ws.ocrDone': 'Recognized: ',
    'ws.ocrLines': 'lines',
    // 反思（2026-08-12 第四十一次）：右键查询面板/悬浮提示界面文本 i18n
    'th.definition': 'Definition',
    'th.tags': 'Tags',
    'th.lemma': 'Lemma',
    // 2026-09-04（用户："词形还原即便原形也要说，右加折叠符号"）：词表原形折叠按钮 title
    'th.lemmaExpand': 'Show same-lemma words',
    'th.lemmaCollapse': 'Collapse',
    'th.querying': 'Querying...',
    // 第一百八十五次：重复键后者生效，同步改为纯符号
    'th.notWord': 'Common word',
    'th.outside': 'Outside',
    'th.stage': 'Level {n}',
    'th.brand': 'VocabRadar',
    // 字幕样式预设名称（3属性×3值=9种 + 无）
    'ws.subNone': 'None',
    'ws.subBottomWhiteSans': 'Bottom / White / Sans',
    'ws.subBottomYellowSerif': 'Bottom / Yellow / Serif',
    'ws.subBottomCyanMono': 'Bottom / Cyan / Mono',
    'ws.subBottomWhiteSerif': 'Bottom / White / Serif',
    'ws.subBottomYellowMono': 'Bottom / Yellow / Mono',
    'ws.subTopWhiteSerif': 'Top / White / Serif',
    'ws.subTopYellowMono': 'Top / Yellow / Mono',
    'ws.subTopCyanSans': 'Top / Cyan / Sans',
    'ws.subCenterWhiteMono': 'Center / White / Mono',
    'ws.subCenterYellowSans': 'Center / Yellow / Sans',
    'ws.subCenterCyanSerif': 'Center / Cyan / Serif',
    // （第二百二十五次：死词条 popup.subtitleOverlay 已删——键与控件均已移除）
    'popup.textHint': 'Text Hints (site-wide word highlight + hover definition + right-click translate)',
    'tool.subtitleStyle': 'Sub Style',
    'tool.overlayToggle': 'Overlay Subs',
    'popup.hintFirst': 'Word',
    'popup.hintLater': 'Repeated words',
    'popup.hintSideAnnotation': 'Side hint',
    'popup.hintAnnotation': 'Annotation',
    'popup.hintSample': 'Sample',
    'popup.bgColor': 'Background',
    'popup.fgColor': 'Text',
    'popup.annotate': 'Annotate Out-of-Vocabulary Words',
    'popup.annotateStatus.off': 'Off',
    'popup.annotateStatus.unsupported': 'Unsupported (Chrome 138+ required)',
    'popup.annotateStatus.detectFail': 'Detection failed',
    'popup.annotateStatus.ready': 'Model ready',
    'popup.annotateStatus.downloadable': 'Model ready to download',
    'popup.annotateStatus.downloading': 'Downloading model…',
    'popup.annotateStatus.unavailable': 'Unavailable',
    'popup.annotateStatus.loading': 'Loading model…',
    'popup.annotateStatus.loaded': 'Ready',
    'popup.annotateStatus.loadFail': 'Load failed',
    'popup.asrMirror': 'ASR Model Mirror (optional)',
    'popup.asrMirrorHint': 'Leave empty for default (huggingface.co). Use https://hf-mirror.com in China.',
    'popup.asrModelSize': 'ASR Model Size',
    'popup.asrModelSizeHint': 'Larger models are more accurate but slower to download and run. Change requires restarting ASR.',
    'popup.asrSegmentSec': 'ASR Segment Length (seconds)',
    'popup.asrSegmentSecHint': 'Length of each audio segment sent to Whisper. Smaller = lower latency but choppier; larger = more context but slower. 1-30s.',
    'lang.ui': 'UI Language',
    'title': 'VocabRadar',
    'lang.en-zh': 'English → 中文',
    'asr.realtime': '🎤',
    'asr.realtimeTitle': 'ASR (Live)',
    'ws.title': 'VocabRadar',
    'ws.uploadAvTitle': '上传视频/音频文件',
    'ws.modelError': '模型错误',
    'ws.segments': '段',
    'ws.noDef': '—',
    'th.noDef': '—',
  },
  zh: {
    // 第一百七十六次：同上，去掉 🦫
    'title': 'VocabRadar',
    'tab.subtitle': '🎬字幕',
    'tab.words': '📖词汇',
    'tab.learn': '📱学习',
    'tool.rank': '词频',
    'tool.annotation': '注释',
    'tool.detail': '详略',
    'tool.export': '词单',
    'tool.subtitleStyle': '字幕样式',
    'tool.overlayToggle': '视频叠加字幕',
    'btn.copy': '📋 复制',
    'btn.danmaku': '🎯 弹幕',
    'btn.downloadAudio': '⬇️ 音频',
    'btn.comment': '📝 评论',
    'btn.chat': '💬 对话',
    // 第一百七十一次：视频侧栏 copy 右侧的导出按钮
    'btn.export': '💾 导出',
    'btn.ocr': '📷 识别当前帧',
    // 第二百三十九次：OCR 链路用户可见提示（vs/ocr.js），与 en 段同键
    'ocr.failPrefix': 'OCR 失败: ',
    'ocr.extUpdated': '扩展已更新，请刷新页面（F5）后再使用 OCR',
    'ocr.noVideo': '未找到视频，无法 OCR',
    'ocr.unknownErr': '未知错误',
    'ocr.noText': '未识别到文字',
    // 第二百五十三次：Parser 栏功能提示；第二百五十五次接线——todo* 占位键退役，换解析过程键
    'parser.parsing': '解析中…',
    'parser.fetching': '抓取网页…',
    'parser.bytes': '字节',
    'parser.empty': '未解析出文本。',
    'parser.fail': '解析失败：',
    'parser.unsupported': '暂不支持的类型：{what}',
    // 256 次：多链接/多文件/复制导出
    'parser.linksCount': '{n} 条链接',
    'parser.multiFiles': '{n} 个文件',
    'parser.copied': '已复制到剪贴板。',
    'parser.copyFail': '复制失败：',
    // 257/260 次：空态提示 i18n 化、结果框元信息行（字符+字节，替代完成 toast）
    'parser.outputTip': '解析出的纯文本将显示在这里。',
    'parser.needDocx': '旧版 .doc 暂不支持——请先另存为 .docx。',
    'parser.fileSave': '保存文件',
    'parser.fileDelete': '移出本批',
    'parser.noInput': '请先输入文本/链接，或拖入/粘贴文件',
    'parser.fileAttached': '文件',
    'parser.linkDetected': '识别为链接',
    'parser.chars': '字符',
    // 第一百七十一次：Chat 对话面板（src/lib/chat.js）
    'chat.title': '💬 VocabRadar 对话',
    'chat.placeholder': '继续追问（回车发送，Shift+回车换行）',
    'chat.send': '发送',
    'chat.thinking': '思考中...',
    'chat.failed': '请求失败',
    'chat.openGuide': '打开设置配置模型',
    'chat.noText': '没有可讨论的文本',
    // 第九十六次：下载音频按钮 toast（弹幕按钮已移除、弹幕模块已删除）
    'toast.dlAudioBusy': '已有下载任务进行中...',
    'toast.dlAudioOk': '音频已保存',
    'toast.dlAudioFail': '音频下载失败：',
    // 第一百一十次：ASR 进度提示（与 en 键一一对应）
    'asr.preparing': '准备中...',
    'asr.modelDownloading': '模型下载',
    'asr.modelReady': '模型就绪',
    'asr.fetchAudio': '获取音频',
    'asr.probeMeta': '探测音频',
    'asr.metaFail': '元数据失败',
    'asr.parseHead': '解析音频头',
    'asr.firstReady': '首段就绪',
    'asr.dlAudioFile': '下载音频',
    'asr.dlAudioDone': '音频下载完成',
    'asr.dlAudioFail': '音频下载失败',
    'asr.decoding': '解码音频',
    'asr.decodeDone': '音频解码完成',
    'asr.decodeFail': '音频解码失败',
    'asr.pcmReady': 'PCM 就绪',
    'asr.streamFallback': '流式回退',
    'asr.directFail': '直连不可用',
    'asr.ytAudio': 'YouTube 音频',
    'asr.prepRecog': '准备识别',
    'asr.fallbackMode': '回退模式',
    'asr.bgDownload': '后台下载',
    'asr.bgInterrupted': '后台下载中断',
    'asr.dlRetry': '下载重试',
    'asr.backfillAudio': '回填开头音频',
    'asr.backfillRecog': '回填识别开头',
    'asr.segRetry': '段重试',
    'asr.gating': '字幕同步中',
    'asr.frontier': '前沿',
    'asr.buffer': '缓冲',
    'asr.allDone': '识别完成',
    'asr.inSync': '字幕与播放完全同步',
    'asr.recognizing': '识别中 {i}/{n}',
    'asr.segDone': '段 {i}/{n} 完成',
    'asr.total': '总长',
    'asr.videoEnded': '视频已结束',
    'asr.stopCapture': '停止采集',
    'asr.capturing': '采集 {i}/{n}',
    'asr.noAudioSeg': '无音频 {i}/{n}',
    'asr.silentSkip': '静音跳过 {i}/{n}',
    'asr.errorLabel': '错误',
    'asr.rtPaused': '回退实时模式：识别跟随播放（直连下载不可用），视频暂停即暂停',
'asr.longWarn': '视频较长：录制加识别大约要花与视频相当的时间——建议优先直连下载，或分段处理',
    'asr.rtResumed': '视频恢复，继续识别',
    'asr.dlGetInfo': '获取音轨信息...',
    'asr.sameOrigin': '同源通道',
    'asr.audioSaved': '音频已保存',
    'asr.ctxInvalidated': '扩展已更新，请刷新页面（F5）后再使用 ASR',
    'dl.noTrack': '__playinfo__ 无音轨',
    'dl.ytFail': 'YouTube 音频获取失败',
    'dl.unsupportedSite': '该站点暂不支持下载音频',
    'dl.metaProbeFail': '探测音频大小失败',
    'dl.chunkFail': '区间下载失败 @ {pos}',
    // 第一百一十三次：录制工作流与回退提示
    'asr.rtSlowTip': '即时识别很落后播放几十秒：可以先下载识别、再同步播放。',
    'asr.recordOffer': '直连下载不可用，可点「录制」：原速播完自动存音频供识别。',
    'asr.recordBtn': '录制',
    'asr.backBtn': '返回',
    'asr.recording': '录制中',
    'asr.recordingUntilEnd': '录制中…播放结束时自动生成音频文件',
    'asr.recSavedForAsr': '音频已生成并留存，下次点 🎤 将直接识别该录音',
    'asr.recStop': '停止并下载',
    'btn.settings': '设定',
    'btn.close': '关闭（刷新恢复）',
    'btn.sync': '同步显示',
    'lang.en-zh': 'English → 中文',
    'lang.toggleTo': 'EN',
    'loading': '字幕加载中...',
    'noSubtitle': '无字幕数据',
    'noSubtitleTip': '无字幕，可点击 🎤 按钮启动语音识别',
    'subtitleTimeoutTip': '字幕加载超时，可点击 🎤 按钮启动语音识别',
    'asr.track': 'ASR 字幕',
    'asr.realtime': '🎤',
    'asr.realtimeTitle': '实时语音识别',
    'tool.track': '轨道',
    'tool.none': '空',
    'asr.start': '点击开始识别',
    'asr.stop': '停止识别',
    'asr.listening': '识别中...',
    'asr.modelLoading': '加载 ASR 模型中...',
    'learn.tip': '微信扫码使用「VocabRadar」小程序<br>随时随地背单词',
  // G3（2026-09-08）：learn 面板按钮行（§6.2）——导入当前侧栏内容为草稿卷轴
  'learn.importDraft': '📚 导入到我的卷轴学习',
  'learn.importAndOpen': '↗ 并且打开',
  'learn.importOk': '已存为草稿卷轴，可在网站「我的卷轴」查看',
  'learn.importFail': '导入失败，详见控制台',
  'learn.noContent': '暂无正文，请先浏览网页完成扫描',
    'toast.copied': '已复制到剪切板',
    'toast.copyFail': '复制失败，请手动选择文本',
    'toast.noContent': '无内容可填入（字幕未加载或生词表为空）',
    'toast.noTrans': '无生词译文可填入（译文未就绪）',
    'toast.danmakuFilled': '已填入弹幕框',
    'toast.danmakuFail': '未找到弹幕输入框（请悬停视频显示弹幕框）',
    'toast.commentFilled': '已填入评论框',
    'toast.commentFail': '未找到主评论框（请滚动到评论区顶部后重试）',
    'toast.commentTrimmed': '评论超长，已随机选取 {picked}/{total} 词',
    'toast.learnNoCopy': '学习面板无需复制',
    'toast.asrUnavail': '实时识别不可用',
    'toast.asrStarted': '实时识别已开始（正在加载模型…）',
    'toast.asrStopped': '实时识别已停止',
    'toast.asrLoading': '下载识别模型 {pct}%',
    'toast.asrReady': '识别模型已就绪',
    'toast.asrNeedActiveTab': '需要授权：请先点击工具栏的 VocabRadar 图标一次（授予当前标签页权限），然后重新点 ASR。',
    'popup.learnLang': '目标语言',
    'popup.meaningLang': '注释语言',
    'popup.minRank': '最低词频',
    'popup.sidebar': '视频提示',
    'popup.webSidebar': '网页悬浮',
    // web sidebar
    // 第一百七十六次：同上，去掉 🦫，小图标由 brandIconSVG() 内联
    'ws.title': 'VocabRadar',
    'ws.expand': '展开VocabRadar',
    // 召唤视频侧栏（2026-08-20 第八十六次补充③）：悬浮球右键 / 顶行按钮手动启动视频侧栏
    'ws.videoSidebar': '视频侧栏',
    // 引导页 OCR 侧栏（2026-08-20 第八十七次补充①）：文本侧栏面板标题
    'ws.textSidebar': '文本侧栏',
    'ws.noVideoOnPage': '当前页面没有视频元素',
    'ws.collapse': '收起',
    'ws.settings': '设定',
    'ws.openGuide': '打开引导页',
    'ws.mainTextDiag': '正文提取诊断',
    'ws.resetLayout': '重置位置与尺寸',
    'ws.close': '关闭（刷新恢复）',
    'ws.langSettings': '语言设置',
    'ws.learnLang': '目标语言',
    'ws.meaningLang': '释义语言',
    'ws.tabSentences': '句',
    'ws.tabWords': '词汇',
    'ws.annotation': '注释',
    'ws.rank': '阶',
    'ws.detail': '详细',
    'ws.wordList': '词单',
    'ws.subtitleStyle': '字幕样式',
    'ws.scanning': '扫描页面中...',
    'ws.noWords': '暂无生词',
    // 反思（2026-08-14 第五十八次）：noDef 原为空串，导致侧栏句子/词汇面板翻译失败时
    //   注释位置空白，用户反馈"侧栏句子无注释"。改为非空占位。
    'ws.avRecognition': '音视频识别',
    'ws.uploadAv': '上传',
    'ws.record': '录制',
    // 第二百五十三次：同 EN 段——录制来源改设备名 + 补 recordFrom/recordFromEnd（zh 用全角括号）
    'ws.recordFrom': '来源（',
    'ws.recordFromEnd': '）',
    'ws.recordAudio': '麦克风',
    'ws.recordScreen': '屏幕',
    'ws.recordVideo': '摄像头',
    'ws.uploadAvTitle': '上传视频/音频文件',
    'ws.recordAudioTitle': '录制麦克风音频（浏览器ASR实时识别）',
    'ws.recordVideoTitle': '录制摄像头视频（含音频，浏览器ASR实时识别）',
    'ws.recordScreenTitle': '录制屏幕（含音频，Whisper模型识别）',
    'ws.avStartTip': '上传文件，或选择录制来源（audio/video/screen）后点「录制」',
    // 反思（2026-08-20 第八十七次修正）：旧指引的 cameraAndMic 设置页通常不列扩展源（用户实测"不存在"）。
//   正确路径：本扩展页地址栏左侧站点信息图标 → 此网站的权限 → 麦克风（扩展源与普通网站同入口）；
//   兜底：edge://extensions → 本扩展详情 → 重置权限；换目录重载换 ID 可 100% 重置。
'ws.micDenied': '麦克风权限被拒绝（扩展页）。重置方法：\n1. 在本页地址栏左侧点击图标（锁/站点信息）→ "此网站的权限" → 麦克风 → 询问（或重置权限）→ 刷新\n2. 或：edge://extensions → 本扩展 → 详情 → 「重置权限」\n3. 或：Windows 设置 → 隐私 → 麦克风 → 允许应用访问\n注意：同目录重载/重装不重置；换目录重载（新扩展 ID）会重置并重新弹框',
    'ws.micDeniedTitle': '麦克风权限被拒绝',
    'ws.micRetry': '重试',
    'ws.asrEmptyDone': '识别完成：未识别到语音',
    'ws.asrResultTip': '识别出的句子将显示在这里。',
    'ws.ocrResultTip': '识别出的文字将显示在这里。',
    'ws.browserAsrNotSupported': '浏览器不支持语音识别，回退到 Whisper 模型',
    'ws.browserAsrListening': '浏览器语音识别中...',
    'ws.browserAsrError': '浏览器语音识别错误：',
    'ws.browserAsrNoSpeech': '未检测到语音',
    'ws.asrBtnTitle': '请先上传视频或音频文件',
    'ws.recognize': '开始识别',
    'ws.stop': '停止',
    'ws.ocrRecognition': '图像识别',
    'ws.uploadImg': '上传',
    'ws.capturePhoto': '拍照',
    'ws.uploadImgTitle': '上传图片文件',
    'ws.capturePhotoTitle': '从摄像头拍照',
    'ws.ocrStartTip': '点击「上传」「拍照」开始',
    'ws.ocrBtnTitle': '请先上传图片',
    'ws.preparing': '准备中...',
    'ws.recognizing': '识别中',
    'ws.recognizeDone': '识别完成',
    'ws.error': '错误',
    'ws.modelError': '模型错误',
    'ws.decoding': '解码文件...',
    'ws.segments': '段',
    'ws.copy': '复制',
    'ws.copied': '已复制',
    'ws.noContent': '没有可复制的内容',
    'ws.copyFail': '复制失败',
    // 第一百七十一次：导出为文件（copy 右侧）
    'ws.exportFile': '导出',
    'ws.exported': '已导出',
    'ws.exportFail': '导出失败：',
    'ws.translating': '翻译中...',
    // 反思（2026-08-12）：用户反馈"词汇中没有释义"。
    //   翻译失败时词汇面板为空，无任何提示。新增"暂无释义"占位文案。
    // 反思（2026-08-14 第五十八次）：noDef 原为空串，导致侧栏句子/词汇面板翻译失败时
    //   注释位置空白，用户反馈"侧栏句子无注释"。改为非空占位。
    // 第一百八十五次：中文侧同理，"暂无释义" 也是文字混淆 → 纯符号占位
    'ws.noDef': '—',
    'ws.unsupportedFileType': '不支持的文件类型（请上传视频/音频/图片）',
    'ws.recognizeAvTitle': '识别上传的音视频',
    'ws.recognizeImgTitle': '识别上传的图片',
    // 反思（2026-08-12 第四十一次）：右键查询面板/悬浮提示界面文本 i18n
    // 字幕样式预设名称（3属性×3值=9种 + 无）
    'ws.asrOnlyAv': 'ASR 仅支持视频/音频文件',
    'ws.ocrOnlyImage': 'OCR 仅支持图片文件',
    'ws.extUpdated': '扩展已更新，请刷新页面后再使用',
    'ws.asrModelFail': 'ASR 模型加载失败，请检查网络后重试',
    'ws.asrStartFail': 'ASR 启动失败：',
    'ws.noResponse': '无响应',
    'ws.asrFail': 'ASR 失败：',
    // ASR 状态阶段名（翻译 offscreen pushStatus 发送的中文阶段名）
    'ws.stageModelLoading': '加载识别模型...',
    'ws.stageRecognizingSeg': '识别段...',
    'ws.stageWhisperNotReady': '识别模型未就绪，跳过',
    'ws.stageRecognizeResult': '识别结果',
    'ws.stageCorrectedEmpty': '修正后无有效文本',
    'ws.stageWhisperFail': '识别失败',
    'ws.stageStart': 'ASR 启动中',
    'ws.stageModelRetry': '模型重试中...',
    'ws.modelDownloading': '下载模型 {pct}%',
    'ws.modelReady': '识别模型已就绪',
    'ws.recordingInProgress': '正在录音/录屏，请先停止',
    'ws.asrInProgress': '正在识别上传文件，请先停止',
    'ws.noGetUserMedia': '当前页面不支持 getUserMedia（可能是 http 站点）',
    'ws.recordStartFail': '录音启动失败：',
    'ws.noGetDisplayMedia': '当前浏览器不支持 getDisplayMedia',
    'ws.noAudioTrack': '未获取到音频轨，请勾选"分享音频"',
    'ws.screenStartFail': '录屏启动失败：',
    'ws.screenRecording': '录屏中...',
    'ws.audioRecording': '🎙 录音中...',
    'ws.videoRecording': '📹 录像中...',
    'ws.recordingInProgressShort': '正在录音/录屏',
    'ws.recording': '录音中',
    'ws.realtimeRecognition': '实时识别',
    'ws.recordingStopped': '录音已停止',
    'ws.total': '共',
    'ws.cameraDenied': '摄像头未授权',
    'ws.cameraNotFound': '未找到摄像头，请确认已连接摄像头设备。',
    'ws.cameraInUse': '摄像头被其他程序占用，请关闭后重试。',
    'ws.cameraStartFail': '摄像头启动失败：',
    // 反思（2026-08-20 第八十五次）：录音失败精确分类——无设备(NotFound) / 占用或系统隐私关闭(NotReadable)
    'ws.micNotFound': '未找到麦克风，请确认已连接麦克风设备。',
    'ws.micInUse': '麦克风被占用或系统隐私设置已关闭，请检查 Windows 设置 → 隐私 → 麦克风。',
    'ws.micPermissionPrompt': '点击「录制」将请求麦克风权限，请在浏览器弹窗中点击「允许」。',
    'ws.captureRecognize': '拍照识别',
    'ws.cameraNotReady': '摄像头尚未就绪',
    'ws.photo': '拍照',
    'ws.cancel': '取消',
    'ws.ocrRunning': 'OCR 正在运行中',
    'ws.imgNotLoaded': '图片未加载完成',
    'ws.ocrFail': 'OCR 失败：',
    'ws.ocrNoText': '未识别到文字',
    'ws.ocrDone': '识别完成：',
    'ws.ocrLines': '行',
    // 反思（2026-08-12 第四十一次）：右键查询面板/悬浮提示界面文本 i18n
    'th.definition': '释义',
    'th.tags': '标签',
    'th.lemma': '原形',
    // 2026-09-04（用户："词形还原即便原形也要说，右加折叠符号"）：词表原形折叠按钮 title
    'th.lemmaExpand': '展开同原形词',
    'th.lemmaCollapse': '收起',
    'th.querying': '查询中…',
    'th.noDef': '—',
    'th.notWord': '非生词',
    'th.outside': '表外',
    'th.stage': '{n}阶',
    // 字幕样式预设名称（3属性×3值=9种 + 无）
    'ws.subNone': '无',
    'ws.subBottomWhiteSans': '底部 / 白色 / 无衬线',
    'ws.subBottomYellowSerif': '底部 / 黄色 / 衬线',
    'ws.subBottomCyanMono': '底部 / 青色 / 等宽',
    'ws.subBottomWhiteSerif': '底部 / 白色 / 衬线',
    'ws.subBottomYellowMono': '底部 / 黄色 / 等宽',
    'ws.subTopWhiteSerif': '顶部 / 白色 / 衬线',
    'ws.subTopYellowMono': '顶部 / 黄色 / 等宽',
    'ws.subTopCyanSans': '顶部 / 青色 / 无衬线',
    'ws.subCenterWhiteMono': '居中 / 白色 / 等宽',
    'ws.subCenterYellowSans': '居中 / 黄色 / 无衬线',
    'ws.subCenterCyanSerif': '居中 / 青色 / 衬线',
    'popup.textHint': '文本提示（全站生词高亮 + 悬浮释义 + 右键翻译）',
    'popup.hintFirst': '生词',
    'popup.hintLater': '生词多次出现',
    'popup.hintSideAnnotation': '侧邻提示',
    'popup.hintAnnotation': '注释',
    'popup.hintSample': '样例',
    'popup.bgColor': '底色',
    'popup.fgColor': '字色',
    'popup.annotate': '注释表外词',
    'popup.annotateStatus.off': '未开启',
    'popup.annotateStatus.unsupported': '不支持（需 Chrome 138+）',
    'popup.annotateStatus.detectFail': '检测失败',
    'popup.annotateStatus.ready': '模型已就绪',
    'popup.annotateStatus.downloadable': '模型待下载',
    'popup.annotateStatus.downloading': '模型下载中…',
    'popup.annotateStatus.unavailable': '不可用',
    'popup.annotateStatus.loading': '正在加载模型…',
    'popup.annotateStatus.loaded': '已就绪',
    'popup.annotateStatus.loadFail': '加载失败',
    'popup.asrMirror': 'ASR 模型镜像（可选）',
    'popup.asrMirrorHint': '留空用默认 huggingface.co；国内建议填 https://hf-mirror.com',
    'popup.asrModelSize': 'ASR 模型大小',
    'popup.asrModelSizeHint': '更大的模型更准确但下载和运行更慢。切换后需重启 ASR 生效。',
    'popup.asrSegmentSec': 'ASR 单段时长（秒）',
    'popup.asrSegmentSecHint': '每次送 Whisper 识别的音频段长。越小延迟越低但更碎；越大上下文越多但更慢。范围 1-30 秒。',
    'lang.ui': '界面语言'
  }
  // 反思（2026-08-02）：其他8种语言（hi/es/ar/fr/bn/pt/ru/ja）界面文案翻译待补充。
  //   切换到这些语言时，t() 会回退到 en，保证界面可用（仅"语言名称"在下拉菜单本地化）。
  //   后续补充：在 DICT 中添加对应语言对象即可，无需改动其他代码。
};

let _lang = 'en';
let _initialized = false;
const _listeners = new Set();

function readStored() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      resolve('en');
      return;
    }
    chrome.storage.local.get({ uiLanguage: 'en' }, (res) => resolve(res.uiLanguage || 'en'));
  });
}

export async function initLang() {
  if (_initialized) return _lang;
  _lang = await readStored();
  // 反思（2026-08-02）：旧版仅允许 en/zh，新版允许 UI_LANGS 内任意值
  //   非法值（如旧版残留或外部修改）回退到 en
  if (!UI_LANGS.includes(_lang)) _lang = 'en';
  _initialized = true;
  // 监听其他上下文的切换
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.uiLanguage && changes.uiLanguage.newValue !== _lang) {
        const newLang = changes.uiLanguage.newValue || 'en';
        _lang = UI_LANGS.includes(newLang) ? newLang : 'en';
        _listeners.forEach((fn) => { try { fn(_lang); } catch (e) { /* ignore */ } });
      }
    });
  }
  return _lang;
}

export function getLang() {
  return _lang;
}

/**
 * 设置界面语言
 * @param {string} lang 语言代码（必须在 UI_LANGS 内）
 * 反思（2026-08-02）：旧版 setLang 仅允许 en/zh，新版接受任意 UI_LANGS 内的值
 */
export function setLang(lang) {
  _lang = UI_LANGS.includes(lang) ? lang : 'en';
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ uiLanguage: _lang });
  }
  _listeners.forEach((fn) => { try { fn(_lang); } catch (e) { /* ignore */ } });
}

/**
 * 切换语言（旧版二选一，保留兼容）
 * 反思（2026-08-02）：toggleLang 已不适用于10种语言切换，
 *   popup/sidebar 改为下拉菜单直接调 setLang。保留此函数仅向后兼容。
 */
export function toggleLang() {
  setLang(_lang === 'en' ? 'zh' : 'en');
}

/** 翻译 key，支持插值 {var} */
export function t(key, vars) {
  // 反思（2026-08-02）：回退链 当前语言 → en → 返回 key 本身
  //   其他8种语言未在 DICT 中定义时，自动回退 en
  let s = (DICT[_lang] && DICT[_lang][key]) || DICT.en[key];
  if (s === undefined) return key;
  if (vars) {
    for (const k in vars) {
      s = s.split(`{${k}}`).join(vars[k]);
    }
  }
  return s;
}

/** 注册语言变更回调，返回取消订阅函数 */
export function onLangChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
