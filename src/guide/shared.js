// VocabRadar 引导页 共享基础设施
// 职责：引导页三栏（设定栏 thinner：本页编排 guide.js / 注释池 ann-pool.js / 字幕 sub-style.js）
//   共用的无环依赖底座——$ 取元、界面语言态、MSG 文案与 m()、日志门面、storage 回声戳、
//   样式 id 清洗。依赖方向：shared ← ann-pool / shared ← sub-style / {shared,ann-pool,sub-style} ← guide.js，
//   禁止反向 import（无环 DAG，见 AGENTS.md；guide-common ← asr/ocr/parser 同例）。
//   跨模块共享状态（界面语言）归属本文件唯一一份，其他模块经 get/set 接缝访问，绝不另存副本。

import { t } from '../lib/i18n.js';
// sanitizeStyleId 缺省兜底引字幕默认代指常量（styles.js 唯一写死处）
import { SUBTITLE_TEXT_STYLES, subPosRatio, SUB_DEFAULT_STYLE } from '../lib/styles.js';

export const $ = (id) => document.getElementById(id);

// === 界面语言态（唯一属主；读写经接缝） ===
let _langState = 'zh';
export function getLangState() { return _langState; }
export function setLangState(v) { _langState = (v === 'zh') ? 'zh' : 'en'; }

// 引导页自身文案（中英双语，跟随界面语言；data-key 与 HTML 属性对应）
const MSG = {
  tabSettings: { en: 'Settings', zh: '设定栏' },
  // My Words 独立子标签（tab 顺序=设定栏之后、ASR 之前）
  tabMyWords: { en: 'My Words', zh: 'My Words' },
  tabAsr: { en: 'ASR', zh: 'ASR' },
  tabOcr: { en: 'OCR', zh: 'OCR' },
  tabParser: { en: 'Parser', zh: 'Parser' },
  parserTitle: { en: 'Document Parser', zh: '文档解析（Parser）' },
  parserDesc: {
    en: 'Parse links / web pages / files (text, audio/video, images, PDF, DOCX and other common types) into plain text for word annotation and learning.',
    zh: '把链接/网页/文件（文本、音视频、图片、PDF、DOCX 等常见类型）解析为纯文本，供生词标注与学习。'
  },
  parserInputPh: {
    en: 'Paste text or a link here, or drop / paste a file (web page, audio/video, image, PDF, DOCX, TXT…)',
    zh: '在此粘贴文本或链接，或拖入/粘贴文件（文本网页、音视频、图片、PDF、DOCX 等）'
  },
  parserRun: { en: 'Parse', zh: '解析' },
  // 结果操作与输入清空按钮（parser 面板 data-key）
  parserCopy: { en: 'Copy', zh: '复制' },
  parserExport: { en: 'Export', zh: '导出' },
  parserClear: { en: 'Clear', zh: '清空' },
  parserOutputTitle: { en: 'Parse Result', zh: '解析结果' },
  // 空态提示由 parser.js resetOutput 统一绘制：parserOutputTip 移至 i18n（parser.outputTip），
  //   静态 HTML/MSG 双源会导致语言混杂
  tabHelp: { en: 'Help', zh: '说明栏' },
  groupGlobal: { en: 'Global Parameters', zh: '全局参数' },
  // My Words 分组（设定栏 group-global 后）——生词/熟词两栏词表
  groupMyWords: { en: 'My Words', zh: 'My Words（我的词表）' },
  mwNewWords: { en: 'New Words', zh: '生词' },
  mwKnownWords: { en: 'Known Words', zh: '熟词' },
  mwCountUnit: { en: 'words', zh: '个词' },
  mwCopy: { en: 'Copy list', zh: '复制词表' },
  mwExport: { en: 'Export as .txt', zh: '导出为 .txt' },
  mwNewPh: { en: 'One word per line — annotated regardless of frequency range', zh: '一行一个单词——无论词频范围如何都会标注' },
  mwKnownPh: { en: 'One word per line — never annotated', zh: '一行一个单词——一律不再标注' },
  groupModel: { en: 'Models', zh: '模型' },
  // 「模型」分组内分成小标题（对话大模型 / 翻译 / 语音识别模型 / OCR）
  subHeadChat: { en: 'Chat LLM', zh: '对话大模型' },
  subHeadAsr: { en: 'Speech Recognition Model', zh: '语音识别模型' },
  subHeadOcr: { en: 'OCR', zh: 'OCR' },
  subHeadTrans: { en: 'Translation', zh: '翻译' },
  asrModelDesc: {
    en: 'Speech recognition: OpenAI-compatible transcription (endpoint/model name/key; source: VocabRadar backend (local/official) or your own API). Unrelated to the chat LLM above.',
    zh: '语音识别：OpenAI 兼容转写（接口地址/模型名/Key；来源可选河狸后端本地/官方，或自备 API）。与上面的对话模型互不相关。'
  },
  ocrEngineDesc: {
    en: 'Text recognition for screenshots/video frames: vision LLM (source: VocabRadar backend (local/official) or your own API; needs image input support).',
    zh: '截图/视频帧的文字识别：大模型视觉识别（来源可选河狸后端本地/官方，或自备 API，需模型支持图片输入）。'
  },
  modelDesc: {
    en: 'LLM endpoint used by the chat (💬) feature. Provider groups: Free, VocabRadar backend, OpenAI Chat Completion Style, Anthropic Messages Style — the latter two need your own API key.',
    zh: '对话（💬）功能所用的大模型接口。来源分四组：免费直连、河狸后端、OpenAI Chat Completion 格式、Anthropic Messages 格式；后两类需自行申请 Key。'
  },
  fieldLlmProvider: { en: 'Provider', zh: 'Provider' },
  fieldLlmModel: { en: 'Model', zh: '模型名' },
  fieldLlmBaseUrl: { en: 'Endpoint', zh: '接口地址' },
  fieldLlmApiKey: { en: 'API Key', zh: 'API Key' },
  // 各模型服务「检测」按钮文案（单位是服务；backend 组连通性亦由此覆盖）
  btnDetectService: { en: 'Test', zh: '检测' },
  // backend 组形制与其他 LLM API 一致（预置 baseUrl 即默认地址，Endpoint 填空可改）
  fieldChatWordPrompt: {
    en: 'Chat prompt for words ({text} = selected text, {lang} = definition language)',
    zh: '单词类查询提示词（{text} = 选中文本，{lang} = 释义语言）'
  },
  fieldChatSidebarPrompt: {
    en: 'Chat prompt for sidebars ({lang} = definition language; body text is sent as context)',
    zh: '侧栏提示词（{lang} = 释义语言；正文作为上下文另行发送）'
  },
  groupOverlay: { en: 'Video Overlay Subtitles', zh: '视频叠加字幕' },
  // Deactivate 停用栏（组头/说明/行内 chip/添加与删除）
  groupDeactivate: { en: 'Deactivate (per-site)', zh: 'Deactivate（停用）' },
  deactivateDesc: {
    en: 'Deactivate features per site: left = address (wildcard * allowed, e.g. example.com, *.example.com:8080, example.com/videos/*), right = click the features to deactivate there. With "All" checked the extension stays as inactive as possible on that site.',
    zh: '按站点停用扩展功能：左侧填地址（可用 * 通配，如 example.com、*.example.com:8080、example.com/videos/*），右侧点选在该站停用的功能；勾「所有」时扩展在该站尽量不活动。'
  },
  deactivatePatPh: {
    en: 'example.com | *.example.com:8080 | example.com/videos/*',
    zh: 'example.com 或 *.example.com:8080 或 example.com/videos/*'
  },
  deactivatePatTitle: {
    en: 'Address pattern: host[:port][/path], * = any characters; without * the host also matches its subdomains; path matches by prefix segments',
    zh: '地址规则：域名[:端口][/路径前缀]，* 匹配任意字符；不带 * 时同时命中该域名及其子域；路径按段前缀匹配'
  },
  deactivateAdd: { en: '＋ Add rule', zh: '＋ 添加规则' },
  // query bar 选项——排在「所有」之后，管右键查询与 query bar；
  //   query bar = 图标边框 + 输入框（无悬浮球）
  deactivateQuery: { en: 'query bar', zh: 'query bar' },
  deactivateAll: { en: 'All', zh: '所有' },
  deactivateHint: { en: 'Web hints', zh: '网页提示' },
  deactivateTextSidebar: { en: 'Text sidebar', zh: '文本侧栏' },
  deactivateVideoSidebar: { en: 'Video sidebar', zh: '视频侧栏' },
  deactivateOverlay: { en: 'Overlay subtitles', zh: '视频叠加字幕' },
  deactivateDel: { en: 'Remove this rule', zh: '删除此条' },
  fieldUiLang: { en: 'Interface Language', zh: '界面语言' },
  fieldSource: { en: 'Target language (to learn)', zh: '目标语言' },   // 此键=要学习的目标语言
  fieldTarget: { en: 'Definition language', zh: '释义语言' },
  fieldThreshold: { en: 'Minimum Frequency Rank', zh: '词频下界' },
  fieldThresholdMax: { en: 'Maximum Frequency Rank', zh: '词频上界' },
  // Whisper 模型行为单选行标签（选项为 whisper-tiny 等具体模型名，语言中立不走 i18n）
  fieldAsrModel: { en: 'Whisper model', zh: 'Whisper 模型' },
  // 对话上下文字段随界面语言
  fieldChatContextMax: { en: 'Background (web/subtitle text) sent to the chat: at most', zh: '送入对话的作为背景的网页/字幕正文至多' },
  guideContextBytesSuffix: { en: 'bytes.', zh: '字节。' },
  // 翻译小节标题与说明（subHeadTrans/transDesc）；渠道回显原文需另一渠道印证的规则写进 transDesc
  transDesc: {
    en: 'Online channels for word meanings (checked = enabled, tried in order). Groups by closeness: no-config (Backend / browser built-in / BaiduSug / YoudaoDict) → free online (Reverso / Bing / Google / Youdao / Baidu / MyMemory). LLM, Backend and MyMemory are unchecked by default; the other free channels are on. The LLM channel uses the chat LLM above; Backend uses the backend translate API from the chat row. When a channel echoes the original text, another channel must confirm it before it is accepted.',
    zh: '生词释义的在线翻译渠道（勾选启用，按序回退），按亲疏分组：免配置（后端/浏览器自身/百度联想/有道词典）→ 免费在线（Reverso/Bing/Google/有道翻译/百度翻译/MyMemory）。LLM、Backend、MyMemory 默认不选（MyMemory 质量差且每天限 5000 字符，仅作末位兜底），其余免费渠道默认选中；LLM 渠道走上方对话大模型；Backend 走对话行所选后端组的翻译接口。渠道回显原文时，需另一渠道给出相同译文才采纳。'
  },
  transChLlm: { en: 'LLM', zh: 'LLM' },
  // 后端翻译渠道：走 backend POST /api/translate（翻译路由，非 /v1/chat/completions 大模型路由）
  transChBackend: { en: 'Backend', zh: '后端' },
  transChBuiltin: { en: 'Browser built-in', zh: '浏览器自身' },
  // 无内置翻译 API 的浏览器（Firefox，typeof Translator === 'undefined'）灰显提示
  transChBuiltinNoFx: { en: 'This browser has no built-in translation (e.g. Firefox)', zh: '此浏览器无内置翻译（如 Firefox）' },
  transChBaidusug: { en: 'BaiduSug', zh: '百度联想' },
  transChYoudaodict: { en: 'YoudaoDict', zh: '有道词典' },
  // Reverso 免 key 端点（见 sw/translate-channels.js reversoTranslate）
  transChReverso: { en: 'Reverso', zh: 'Reverso' },
  transChMymemory: { en: 'MyMemory', zh: 'MyMemory' },
  transChGoogle: { en: 'Google', zh: 'Google' },
  transChYoudao: { en: 'Youdao', zh: '有道翻译' },
  transChBaidu: { en: 'Baidu', zh: '百度翻译' },
  transChBing: { en: 'Bing', zh: 'Bing' },
  // 渠道状态行（详情由 ch-health.js 取 SW 登记簿渲染进 #transChHealthDetail）
  transChHealth: { en: 'Channel status', zh: '渠道状态' },
  asrEngineLocal: { en: 'Local', zh: '本地' },
  asrEngineApi: { en: 'API', zh: 'API' },
  fieldAsrLlmModel: { en: 'Transcription model', zh: '转写模型' },
  // ASR/OCR 来源下拉共用标签（选项文案由 LLM_PROVIDERS 表按界面语言动态生成）
  engineApiFmt: { en: 'Provider', zh: 'Provider' },
  chkRareWords: { en: 'Annotate out-of-vocabulary words', zh: '注释表外词' },
  chkAnnotateRepeat: { en: 'Annotate repeated words', zh: '注释重复生词' },
  poolItemQuery: { en: 'Query', zh: '查询' },
  hitContextLookup: { en: 'Right-click lookup', zh: '右键查询' },
  hitQueryBar: { en: 'Query bar', zh: '查询栏' },
  hitTextHint: { en: 'Web hints', zh: '网页提示' },
  hitTextSidebar: { en: 'Text sidebar', zh: '文本侧栏' },
  hitVideoSidebar: { en: 'Video sidebar', zh: '视频侧栏' },
  hitOverlay: { en: 'Overlay subtitles', zh: '视频叠加字幕' },
  chkSideAnnotation: { en: 'Side hint', zh: '生词旁侧邻提示' },
  switchOn: { en: 'On', zh: '开启' },
  groupWordAnnotation: { en: 'Word Annotation', zh: '生词标注' },
  wordAnnDesc: {
    en: 'Click a feature on the left to select it, then click a style card on the right — the card is assigned to that feature and copied into it. Subtitle hints on video controls the annotation line of overlay subtitles.',
    zh: '点击左栏功能选中它，再点击右侧样式卡——该样式即指派给选中功能并复制显示在左栏内。「视频中字幕的注释」控制叠加字幕注释行的外观。'
  },
  fieldAnnTemplate: { en: 'Annotation template', zh: '注释模板' },
  // {target} 是生词（new word），{annotation} 是释义（meaning）
  annTemplateHint: { en: '{target}{annotation}: {target} is new word, {annotation} is meaning', zh: '{target}{annotation}：{target}是生词，{annotation}是释义' },
  // 池绘制三组组名＋空组占位（分组见 styles.poolPaint；composite 暂无成员则显示占位行）
  poolPaintComposite: { en: 'Composite', zh: '合成' },
  poolPaintRepaint: { en: 'Repaint', zh: '重绘' },
  poolPaintReflow: { en: 'Reflow', zh: '重排' },
  poolPaintEmpty: { en: 'No composite-only styles yet', zh: '暂无纯合成样式' },
  // 池右列两段说明：段1=样式卡指派即时生效不重渲染；段2=模板行触发重渲染——
  //   模板分键后只作用于当前选中栏（annTplScopePrefix/annTplScopeSuffix 由 renderPoolNote
  //   动态写入 poolNoteRerender），静态键保留作 fillByDataKey 兜底（JS 未跑完前的占位文案）
  poolNoteNoRerenderSuffix: { en: 'Assigning a card takes effect instantly — no re-render.', zh: '样式卡指派即时生效，不重渲染。' },
  poolNoteRerender: { en: 'Annotation template — changing it re-renders the samples.', zh: '注释模板——修改它会触发重渲染候选样例。' },
  // 段2动态拼接件（中文无空格直连）
  annTplScopePrefix: { en: 'Annotation template for', zh: '注释模板（' },
  annTplScopeSuffix: { en: '— changing it re-renders this row’s samples.', zh: '）——修改会触发重渲染该栏候选样例。' },
  poolItemWebHint: { en: 'Web Hints', zh: '网页提示' },
  poolItemWebSidebar: { en: 'Text Sidebar', zh: '文本侧栏' },
  poolItemSidebar: { en: 'Video Sidebar', zh: '视频侧栏' },
  // 注释样例行＋个性化行文案（仿字幕 Custom Style 结构）
  annSampleText: { en: 'Sample text', zh: '样例文字' },
  annSamplePh: { en: 'Sample sentence for style cards', zh: '样式卡展示用的样例句子' },
  annCustomStyle: { en: 'Custom Style', zh: '个性化样式' },
  // 单 CSS 框拆双框（target/annotation 各一段），placeholder 各配一键；
  //   双 CSS 框名称行比 placeholder 常驻可辨
  annCssTargetName: { en: 'Target word CSS', zh: '生词 CSS（target）' },
  annCssAnnName: { en: 'Annotation CSS', zh: '注释 CSS（annotation）' },
  annCustomCssTargetPh: { en: 'CSS for the target word, e.g. background:#004d40;color:#fff', zh: '生词（target）的 CSS，如 background:#004d40;color:#fff' },
  annCustomCssAnnPh: { en: 'CSS for the annotation, e.g. background:rgba(0,0,0,.55);color:#fff', zh: '注释（annotation）的 CSS，如 background:rgba(0,0,0,.55);color:#fff' },
  annAddStyle: { en: 'Save current custom settings as a new annotation style', zh: '把当前个性化参数保存为新注释样式' },
  annCustomWordBg: { en: 'Word BG', zh: '生词底色' },
  annCustomWordFg: { en: 'Word', zh: '生词字色' },
  annCustomAnnBg: { en: 'Ann BG', zh: '注释底色' },
  annCustomAnnFg: { en: 'Ann', zh: '注释字色' },
  annCustomRadius: { en: 'Radius', zh: '圆角' },
  annCustomDeco: { en: 'Line', zh: '装饰线' },
  annCustomBold: { en: 'Bold', zh: '加粗' },
  // 左列第四栏——视频叠加字幕的注释行样式（正文样式在下方视频叠加字幕组内选）
  poolItemSubAnn: { en: 'Subtitle Hints on Video', zh: '视频中字幕的注释' },
  // 池顶文本说明（随左栏选中项切换）
  poolNoteTextStyle: { en: 'Style for words highlighted in web pages (Web Hints).', zh: '网页提示里正文生词的高亮样式。' },
  poolNoteAnnotationStyle: { en: 'Style for annotations in the text sidebar.', zh: '文本侧栏中的注释样式。' },
  poolNoteVideoAnnotationStyle: { en: 'Style for annotations in the video sidebar.', zh: '视频侧栏中的注释样式。' },
  poolNoteVideoOverlayAnnStyle: { en: 'Style for the annotation line on overlay subtitles (subtitle text style is picked below in Video Overlay Subtitles).', zh: '视频叠加字幕中注释行的样式（字幕正文样式在下方「视频叠加字幕」组内选择）。' },
  // 字幕组：正文样式只管正文，注释由第四栏控制；位置单选；个性化四控件
  subStyleDesc: { en: 'Text styles apply to subtitle text only; the annotation line follows “Subtitle hints on video” in Word Annotation. Any change (style / custom / position) updates the preview immediately.', zh: '正文样式只管字幕正文；注释行外观由「生词标注 → 视频中字幕的注释」控制。样式/个性化/位置任一变化都会立即刷新预览。' },
  subPreview: { en: 'Preview', zh: '效果预览' },
  subTextStyle: { en: 'Subtitle Text Style', zh: '字幕正文样式' },
  // 滑轨下方显示该标签
  subPosition: { en: 'Subtitle position', zh: '字幕位置' },
  subCustomStyle: { en: 'Custom Style', zh: '个性化样式' },
  subCustomBg: { en: 'Background', zh: '底色' },
  // 底色透明勾选（勾选后取色器禁用、写入 'transparent'）；用户卡名称可编辑提示
  subCustomTransparent: { en: 'Transparent', zh: '透明' },
  subRenameStyle: { en: 'Click to rename', zh: '点击可重命名' },
  subCustomFg: { en: 'Text color', zh: '字色' },
  subCustomSize: { en: 'Font size (%)', zh: '字号（%）' },
  subCustomFont: { en: 'Font', zh: '字体' },
  // 特效下拉 / 加号保存 / 用户卡删除钮
  subCustomFx: { en: 'Effect', zh: '特效' },
  subAddStyle: { en: 'Save current custom settings as a new text style', zh: '把当前个性化参数保存为新正文样式' },
  // CSS 代码框占位提示（查看/编辑当前个性化样式代码，作用于预览）
  subCustomCssPh: { en: 'CSS code of the custom style — view and edit, applies to the preview', zh: '个性化样式的 CSS 代码——可查看编辑，作用于预览' },
  // 样例文字输入框文案
  subSampleText: { en: 'Sample text', zh: '样例文字' },
  subSamplePh: { en: 'Text shown on style cards and in the preview', zh: '显示在样式卡与预览中的样例文字' },
  subDelStyle: { en: 'Delete this style', zh: '删除该样式' },
  // 字幕注释方式单选（与视频侧栏 Detail 按钮写同一键）；subAnnModeHint 为组前说明
  subAnnModeHint: { en: 'Annotation style', zh: '注释样式' },
  subAnnSide: { en: 'Side', zh: '侧邻' },
  subAnnDetail: { en: 'Detail', zh: '详细' },
  annResultsTitle: { en: 'Annotated Words', zh: '展示注释结果' },
  asrTitle: { en: 'Speech Recognition (ASR)', zh: '语音识别（ASR）' },
  asrDesc: { en: 'Recognize speech in videos/recordings without subtitles; output sentences with word meanings.', zh: '识别无字幕视频/录音的语音，实时输出句子并标注生词释义。' },
  ocrTitle: { en: 'Text Recognition (OCR)', zh: '文字识别（OCR）' },
  ocrDesc: { en: 'Recognize text in images / camera frames, output line by line with word meanings.', zh: '识别图片/摄像头画面中的文字，按行输出并标注生词释义。' },
  sourceOr: { en: 'or', zh: '或' },
  recordChoose: { en: 'Record from:', zh: '录制来源：' },
  uploadAv: { en: 'Upload', zh: '上传文件' },
  record: { en: 'Record', zh: '录制' },
  recordAudio: { en: 'Record Audio', zh: '录音' },
  recordVideo: { en: 'Record Video', zh: '录像' },
  recordScreen: { en: 'Record Screen', zh: '录屏' },
  recognize: { en: 'Recognize', zh: '开始识别' },
  uploadImg: { en: 'Upload', zh: '上传图片' },
  capturePhoto: { en: 'Capture', zh: '拍照' },
  // 录制来源措辞与 recording 行同步（microphone/camera/screen）
  asrHint: { en: 'Upload a file, or click Record after choosing a source (microphone/camera/screen) above, then click Recognize to start.', zh: '上传文件、或选择来源（麦克风/摄像头/屏幕）后点击「录制」，再点击「开始识别」即可。' },
  ocrHint: { en: 'Upload an image or capture a photo, then click Recognize to start.', zh: '上传图片或拍照后，点击「开始识别」即可识别。' },
  asrResultTip: { en: 'Recognized sentences will appear here.', zh: '识别出的句子将显示在这里。' },
  // OCR 右侧面板只是纯文本结果列表；提取生词是文本侧栏（悬浮球）的活
  ocrResultsTitle: { en: 'Recognition Results', zh: '识别结果' },
  ocrResultTip: { en: 'Recognized text will appear here.', zh: '识别出的文字将显示在这里。' },
  helpTitle: { en: 'User Guide', zh: '使用说明' },
  subWord: { en: 'word', zh: '单词' },
  subTrans: { en: 'meaning', zh: '释义' }
};

export function m(key) {
  const entry = MSG[key];
  if (entry) return entry[_langState] || entry.en;
  // data-key 含 ws. 前缀时回退到 i18n t()：弹窗/radio 等 ws. 键未在 MSG 注册
  if (typeof t === 'function' && key.startsWith('ws.')) return t(key) || '';
  return '';
}

export function log(...args) {
  console.log('[VocabRadar][guide]', ...args);
}

// === storage 回声戳（多栏写入共用，分支守卫共用） ===
let _ownWriteAt = 0;
export function markOwnWrite() { _ownWriteAt = Date.now(); }
export function ownWriteAt() { return _ownWriteAt; }

// 样式 id 清洗：不在对应样式列表内的（旧版已删除/写坏）回退 fallback，保证网格恒有选中卡
// （storage 残留已删样式 id 时 renderStyleGrid 无匹配卡）；textStyle 的特殊 'custom'
// 分支（用户在弹窗改过配色）不在本清洗范围（仍是有效显示态）。
// fallback 口径：调用方传默认代指常量（ANN_DEFAULT_STYLE/SUB_DEFAULT_STYLE，
//   styles.js 唯一允许缺省字面量处，版本变化才改常量值）；存量不在池内的 id
//   自动回落默认卡并写盘，迁移就地完成。本函数不出现其他绝对样式字面量。
export function sanitizeStyleId(items, id, fallback) {
  if (id && Array.isArray(items) && items.some((it) => it.id === id)) return id;
  return fallback || SUB_DEFAULT_STYLE;
}

// 位置 id 清洗：合法 = 档表命中 或 滑轨自定义 'bNN'（0-100 整数）；否则回退出厂默认
//   （与 storage/overlay 一致；'b10' 档仍存在可选）；'t10' 存量一次性迁移为 'b90'。
export function sanitizePositionId(id) {
  if (id === 't10') return 'b90';
  if (id && subPosRatio(id) !== null) return id;
  return 'b15';   // 出厂默认 White Glow pos=b15
}
