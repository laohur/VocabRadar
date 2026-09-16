// VocabRadar 引导页 共享基础设施（302次拆分：门面模式）
// 职责：引导页三栏（设定栏 thinner：本页编排 guide.js / 注释池 ann-pool.js / 字幕 sub-style.js）
//   共用的无环依赖底座——$ 取元、界面语言态、MSG 文案与 m()、日志门面、storage 回声戳、
//   样式 id 清洗。依赖方向：shared ← ann-pool / shared ← sub-style / {shared,ann-pool,sub-style} ← guide.js，
//   禁止反向 import（无环 DAG，见 AGENTS.md；guide-common ← asr/ocr/parser 同例）。
// 说明：由 guide.js 机械拆分而来，代码逐字保留，未改动任何逻辑。
//   MSG 整块由 guide.js 原样搬迁（字节一致，diff 可验）；跨模块共享状态
//   （界面语言）归属本文件唯一一份，其他模块经 get/set 接缝访问，绝不另存副本。

import { t } from '../lib/i18n.js';
// 317次：sanitizeStyleId 缺省兜底改引字幕默认代指常量（styles.js 唯一写死处）
import { SUBTITLE_TEXT_STYLES, SUBTITLE_POSITIONS, SUB_DEFAULT_STYLE } from '../lib/styles.js';

export const $ = (id) => document.getElementById(id);

// === 界面语言态（唯一属主；读写经接缝） ===
let _langState = 'zh';
export function getLangState() { return _langState; }
export function setLangState(v) { _langState = (v === 'zh') ? 'zh' : 'en'; }

// 引导页自身文案（中英双语，跟随界面语言；data-key 与 HTML 属性对应）
const MSG = {
  tabSettings: { en: 'Settings', zh: '设定栏' },
  tabAsr: { en: 'ASR', zh: 'ASR' },
  tabOcr: { en: 'OCR', zh: 'OCR' },
  // 第二百五十三次：Parser 标签与面板文案；第二百五十四次：desc 补链接、删 browse/sidebar 键
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
  // 第二百五十六次：结果操作与输入清空按钮（parser 面板 data-key）
  parserCopy: { en: 'Copy', zh: '复制' },
  parserExport: { en: 'Export', zh: '导出' },
  parserClear: { en: 'Clear', zh: '清空' },
  parserOutputTitle: { en: 'Parse Result', zh: '解析结果' },
  // 257 次：parserOutputTip 移至 i18n（parser.outputTip）——空态提示由 parser.js resetOutput
  //   统一绘制，修复"解析出的纯文本将显示在这里"语言混杂（静态 HTML/MSG 双源导致）
  tabHelp: { en: 'Help', zh: '说明栏' },
  groupGlobal: { en: 'Global Parameters', zh: '全局参数' },
  groupModel: { en: 'Models', zh: '模型' },
  // 第一百七十四次：「模型」分组内分成小标题（对话大模型 / 翻译 / 语音识别模型 / OCR）
  subHeadChat: { en: 'Chat LLM', zh: '对话大模型' },
  subHeadAsr: { en: 'Speech Recognition Model', zh: '语音识别模型' },
  subHeadOcr: { en: 'OCR', zh: 'OCR' },
  subHeadTrans: { en: 'Translation', zh: '翻译' },
  asrModelDesc: {
    en: 'Speech recognition engine: local Whisper (larger = more accurate but slower, downloaded on first use) or an OpenAI-compatible transcription API (endpoint / model / key). Unrelated to the chat LLM above.',
    zh: '语音识别引擎：本地 Whisper（模型越大越准也越慢，首次使用需下载），或 OpenAI 兼容转写 API（填接口地址/模型名/Key）。与上面的对话模型互不相关。'
  },
  ocrEngineDesc: {
    en: 'OCR engine for screenshots/video frames: local Tesseract (pick languages among the interface / target / definition languages), or a vision LLM API (needs image input support).',
    zh: '截图/视频帧的文字识别引擎：本地 Tesseract（在界面/目标/释义三种语言中勾选要识别的语言），或大模型视觉识别 API（需模型支持图片输入）。'
  },
  modelDesc: {
    en: 'LLM endpoint used by the chat (💬) feature. Three API formats: free direct (no account), OpenAI-compatible, and Anthropic — the latter two need your own API key.',
    zh: '对话（💬）功能所用的大模型接口。按 API 格式分三类：免费直连（无需账号）、OpenAI 格式、Anthropic 格式；后两类需自行申请 Key。'
  },
  fieldLlmProvider: { en: 'Chat Provider', zh: '对话模型来源' },
  fieldLlmModel: { en: 'Model', zh: '模型名' },
  fieldLlmBaseUrl: { en: 'Endpoint', zh: '接口地址' },
  fieldLlmApiKey: { en: 'API Key', zh: 'API Key' },
  // 第二百二十七次（用户："两种提示词，背景最大长度，都应当各自一行"）：改回各自一行，
  //   恢复完整标签（226 次的悬浮提示键 tipChat* 随之删除）；"Anthropic 兼容"表述对齐
  //   "OpenAI 兼容"（自定义网关同样可用，并非只有官方端点）。
  fieldChatWordPrompt: {
    en: 'Chat prompt for words ({text} = selected text, {lang} = definition language)',
    zh: '单词类查询提示词（{text} = 选中文本，{lang} = 释义语言）'
  },
  fieldChatSidebarPrompt: {
    en: 'Chat prompt for sidebars ({lang} = definition language; body text is sent as context)',
    zh: '侧栏提示词（{lang} = 释义语言；正文作为上下文另行发送）'
  },
  // 第二百七十一次：栏目名统一——用户裁定 "Word Hints on Pages" 一律改叫 "Web Hints"（zh 网页提示），
  //   与停用栏 deactivateHint 文案（en 'Web hints'/zh '网页提示'）对齐，同一功能一个名字
  // 280 次：groupTextHint/groupWebSidebar/groupSidebar 三键随旧组头删除（左列功能卡用 poolItem* 键）
  groupOverlay: { en: 'Video Overlay Subtitles', zh: '视频叠加字幕' },
  // 第二百七十次：Deactivate 停用栏（组头/说明/行内 chip/添加与删除）
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
  // 272 次：query bar（query）选项——排在「所有」之后，管右键查询与 query bar
  // 284次名实相符：query bar = 图标边框 + 输入框（无悬浮球，不再叫搜索栏）
  deactivateQuery: { en: 'query bar', zh: 'query bar' },
  deactivateAll: { en: 'All', zh: '所有' },
  deactivateHint: { en: 'Web hints', zh: '网页提示' },
  deactivateTextSidebar: { en: 'Text sidebar', zh: '文本侧栏' },
  deactivateVideoSidebar: { en: 'Video sidebar', zh: '视频侧栏' },
  deactivateOverlay: { en: 'Overlay subtitles', zh: '视频叠加字幕' },
  deactivateDel: { en: 'Remove this rule', zh: '删除此条' },
  fieldUiLang: { en: 'Interface Language', zh: '界面语言' },
  fieldSource: { en: 'Target language (to learn)', zh: '目标语言' },   // 第二百二十二次：名实相符（此键=要学习的目标语言）
  fieldTarget: { en: 'Definition language', zh: '释义语言' },   // 第二百二十二次：名实相符
  fieldThreshold: { en: 'Minimum Frequency Rank', zh: '词频下界' },
  fieldThresholdMax: { en: 'Maximum Frequency Rank', zh: '词频上界' },
  // 第二百二十四次：Whisper 模型行为单选行标签（选项为 whisper-tiny 等具体模型名，语言中立不走 i18n）
  fieldAsrModel: { en: 'Whisper model', zh: 'Whisper 模型' },
  // 第二百一十二次：对话上下文字段随界面语言（用户："界面语言是啥就用啥语言"）
  fieldChatContextMax: { en: 'Background (web/subtitle text) sent to the chat: at most', zh: '送入对话的作为背景的网页/字幕正文至多' },
  guideContextBytesSuffix: { en: 'bytes.', zh: '字节。' },
  // 第二百二十三次（用户："翻译行挪入模型分组；OCR 引擎改下拉两行式"）：
  //   subHeadTrans/transDesc 为翻译小节标题与说明；OCR 引擎下拉选项 ocrEngineLocal/ocrEngineApi；
  //   原 fieldTransChannels 行标签文案并入 transDesc（键删除）；ocrLanguages 复选动态渲染（不写死）。
  // 第二百二十六次：引擎单选文字精简为 本地/API；fieldOcrEngine 行标签键随行结构删除。
  ocrEngineLocal: { en: 'Local', zh: '本地' },
  ocrEngineApi: { en: 'API', zh: 'API' },
  // 第二百二十八次（用户裁定文案）：OCR 行读作"Tesseract 支持 界面/目标/释义 语言"
  fieldOcrLangs: { en: 'Tesseract supporting', zh: 'Tesseract 支持' },
  ocrLangsSuffix: { en: 'language', zh: '语言' },
  // 第二百二十四次（用户："界面 目标 释义，不要写死、不要特指，默认全选"）：OCR 语言复选的角色名标签
  //   ——标签恒为角色名，勾选"值"由 JS 按当前 界面/目标/释义 语言动态映射 tess 代码
  ocrRoleUi: { en: 'Interface', zh: '界面' },
  ocrRoleTarget: { en: 'Target', zh: '目标' },
  ocrRoleMeaning: { en: 'Meaning', zh: '释义' },
  ocrLangNoPack: { en: 'No local language pack', zh: '本地未内置该语言包' },
  transDesc: {
    en: 'Online channels for word meanings (checked = enabled, tried in order). The LLM channel uses the chat LLM above and is off by default; the others are on by default.',
    zh: '生词释义的在线翻译渠道（勾选启用，按序回退）：LLM 渠道走上方对话大模型，默认不选；其余渠道默认全启用。'
  },
  transChLlm: { en: 'LLM', zh: 'LLM' },
  transChBuiltin: { en: 'Browser built-in', zh: '浏览器自身' },
  // 第二百二十三次：无内置翻译 API 的浏览器（Firefox，typeof Translator === 'undefined'）灰显提示
  transChBuiltinNoFx: { en: 'This browser has no built-in translation (e.g. Firefox)', zh: '此浏览器无内置翻译（如 Firefox）' },
  transChBaidusug: { en: 'BaiduSug', zh: '百度联想' },
  transChYoudaodict: { en: 'YoudaoDict', zh: '有道词典' },
  transChMymemory: { en: 'MyMemory', zh: 'MyMemory' },
  transChGoogle: { en: 'Google', zh: 'Google' },
  transChYoudao: { en: 'Youdao', zh: '有道翻译' },
  transChBaidu: { en: 'Baidu', zh: '百度翻译' },
  transChBing: { en: 'Bing', zh: 'Bing' },
  transChLingva: { en: 'Lingva', zh: 'Lingva' },
  // 第二百二十六次（用户："asr 两行单选，第一行是本地，whisper模型是下拉，第二行是api。ocr同理"）：
  //   引擎单选文字精简为 本地/API（细项标签与说明承载 Whisper/Tesseract 语境）；
  //   fieldAsrEngine/fieldOcrEngine/asrApiFmt 三个行标签键随行结构删除。
  asrEngineLocal: { en: 'Local', zh: '本地' },
  asrEngineApi: { en: 'API', zh: 'API' },
  fieldAsrLlmModel: { en: 'Transcription model', zh: '转写模型' },
  ocrApiFmt: { en: 'API format', zh: 'API 格式' },
  fmtOpenai: { en: 'OpenAI-compatible', zh: 'OpenAI 兼容' },
  fmtAnthropic: { en: 'Anthropic-compatible', zh: 'Anthropic 兼容' },   // 第二百二十七次：对齐"OpenAI 兼容"表述（自定义网关可用，非仅官方端点）
  // 第一百零二次：asrFirstChunkSec 引导页输入已按用户裁定移除（唯一来源 config.json），
  // MSG 词条 fieldAsrFirstChunk/asrFirstChunkDesc 一并删除
  chkRareWords: { en: 'Annotate out-of-vocabulary words', zh: '注释表外词' },
  chkAnnotateRepeat: { en: 'Annotate repeated words', zh: '注释重复生词' },
  // 286次：六开关文案（Query 拆分为右键查询+查询栏）
  // 299次：word hits 栏目撤销（开关并回左卡片，新增 Query 卡；groupWordHits 键删除）
  poolItemQuery: { en: 'Query', zh: '查询' },
  hitContextLookup: { en: 'Right-click lookup', zh: '右键查询' },
  hitQueryBar: { en: 'Query bar', zh: '查询栏' },
  hitTextHint: { en: 'Web hints', zh: '网页提示' },
  hitTextSidebar: { en: 'Text sidebar', zh: '文本侧栏' },
  hitVideoSidebar: { en: 'Video sidebar', zh: '视频侧栏' },
  hitOverlay: { en: 'Overlay subtitles', zh: '视频叠加字幕' },
  chkSideAnnotation: { en: 'Side hint', zh: '生词旁侧邻提示' },   // 第二百一十九次：用户裁定缩短
  // 280 次：annLayout/annModeSide/annModeDetail 三键随引导页 radio 删除（布局控制在各自侧栏与叠加字幕内）
  switchOn: { en: 'On', zh: '开启' },
  // 280 次：textStyleDesc/annStyleDesc/vannStyleDesc/groupStylePool/stylePoolDesc/poolWordStyles/
  //   poolAnnStyles/chkAnnBrackets 随旧布局退役；新增 Word Annotation 组文案
  groupWordAnnotation: { en: 'Word Annotation', zh: '生词标注' },
  // 281次：wordAnnDesc 随池重做改写（选中左栏→点池卡指派并复制显示）；chipWeb/chipText/
  //   chipVideo/poolAssignTitle 四键随三指派钮删除；新增第四栏名与四条池顶说明
  wordAnnDesc: {
    en: 'Click a feature on the left to select it, then click a style card on the right — the card is assigned to that feature and copied into it. Subtitle hints on video controls the annotation line of overlay subtitles.',
    zh: '点击左栏功能选中它，再点击右侧样式卡——该样式即指派给选中功能并复制显示在左栏内。「视频中字幕的注释」控制叠加字幕注释行的外观。'
  },
  fieldAnnTemplate: { en: 'Annotation template', zh: '注释模板' },
  // 303次（用户口径）：{target} 是生词（new word），{annotation} 是释义（meaning）
  annTemplateHint: { en: '{target}{annotation}: {target} is new word, {annotation} is meaning', zh: '{target}{annotation}：{target}是生词，{annotation}是释义' },
  // 303次：池绘制三组组名＋空组占位（分组见 styles.poolPaint；composite 暂无成员则显示占位行）
  poolPaintComposite: { en: 'Composite', zh: '合成' },
  poolPaintRepaint: { en: 'Repaint', zh: '重绘' },
  poolPaintReflow: { en: 'Reflow', zh: '重排' },
  poolPaintEmpty: { en: 'No composite-only styles yet', zh: '暂无纯合成样式' },
  // 282次：池右列两段说明——段1=样式卡指派即时生效不重渲染（拼在 poolNoteXxx 之后）；
  //   段2=模板行是唯一触发渲染者（poolNoteRerender，静态 data-key 填充）
  // 283次：段2改动态——模板分键后只作用于当前选中栏，说明随左栏选中项拼接栏名
  //   （annTplScopePrefix/annTplScopeSuffix 由 renderPoolNote 动态写入 poolNoteRerender），
  //   静态键 poolNoteRerender 保留作 fillByDataKey 兜底（JS 未跑完前的占位文案）。
  poolNoteNoRerenderSuffix: { en: 'Assigning a card takes effect instantly — no re-render.', zh: '样式卡指派即时生效，不重渲染。' },
  poolNoteRerender: { en: 'Annotation template — changing it re-renders the samples.', zh: '注释模板——修改它会触发重渲染候选样例。' },
  // 283次：段2动态拼接件——en: 'Annotation template for Web Hints — changing it …'；
  //   zh: '注释模板（网页提示）——修改会触发重渲染该栏候选样例。'（中文无空格直连）
  annTplScopePrefix: { en: 'Annotation template for', zh: '注释模板（' },
  annTplScopeSuffix: { en: '— changing it re-renders this row’s samples.', zh: '）——修改会触发重渲染该栏候选样例。' },
  poolItemWebHint: { en: 'Web Hints', zh: '网页提示' },
  poolItemWebSidebar: { en: 'Text Sidebar', zh: '文本侧栏' },
  poolItemSidebar: { en: 'Video Sidebar', zh: '视频侧栏' },
  // 301次：注释样例行＋个性化行文案（仿字幕 Custom Style 结构）
  annSampleText: { en: 'Sample text', zh: '样例文字' },
  annSamplePh: { en: 'Sample sentence for style cards', zh: '样式卡展示用的样例句子' },
  annCustomStyle: { en: 'Custom Style', zh: '个性化样式' },
  // 306次：单 CSS 框拆双框（target/annotation 各一段），placeholder 各配一键（原 annCustomCssPh 停用删除）
  // 307次：双 CSS 框名称行（用户"两种css 输入框加名字"）——比 placeholder 常驻可辨
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
  // 281次：左列第四栏——视频叠加字幕的注释行样式（正文样式在下方视频叠加字幕组内选）
  poolItemSubAnn: { en: 'Subtitle Hints on Video', zh: '视频中字幕的注释' },
  // 281次：池顶文本说明（随左栏选中项切换；"最上是文本说明"）
  poolNoteTextStyle: { en: 'Style for words highlighted in web pages (Web Hints).', zh: '网页提示里正文生词的高亮样式。' },
  poolNoteAnnotationStyle: { en: 'Style for annotations in the text sidebar.', zh: '文本侧栏中的注释样式。' },
  poolNoteVideoAnnotationStyle: { en: 'Style for annotations in the video sidebar.', zh: '视频侧栏中的注释样式。' },
  poolNoteVideoOverlayAnnStyle: { en: 'Style for the annotation line on overlay subtitles (subtitle text style is picked below in Video Overlay Subtitles).', zh: '视频叠加字幕中注释行的样式（字幕正文样式在下方「视频叠加字幕」组内选择）。' },
  // 281次：字幕组重做——正文样式只管正文，注释由第四栏控制；位置改单选；新增个性化四控件
  subStyleDesc: { en: 'Text styles apply to subtitle text only; the annotation line follows “Subtitle hints on video” in Word Annotation. Any change (style / custom / position) updates the preview immediately.', zh: '正文样式只管字幕正文；注释行外观由「生词标注 → 视频中字幕的注释」控制。样式/个性化/位置任一变化都会立即刷新预览。' },
  subPreview: { en: 'Preview', zh: '效果预览' },
  subTextStyle: { en: 'Subtitle Text Style', zh: '字幕正文样式' },
  subPosition: { en: 'Position', zh: '位置' },
  subCustomStyle: { en: 'Custom Style', zh: '个性化样式' },
  subCustomBg: { en: 'Background', zh: '底色' },
  // 283次：底色透明勾选（勾选后取色器禁用、写入 'transparent'）；用户卡名称可编辑提示
  subCustomTransparent: { en: 'Transparent', zh: '透明' },
  subRenameStyle: { en: 'Click to rename', zh: '点击可重命名' },
  subCustomFg: { en: 'Text color', zh: '字色' },
  subCustomSize: { en: 'Font size (%)', zh: '字号（%）' },
  subCustomFont: { en: 'Font', zh: '字体' },
  // 282次：特效下拉 / 大加号 / 用户卡删除钮 / 预览横竖切换
  subCustomFx: { en: 'Effect', zh: '特效' },
  subAddStyle: { en: 'Save current custom settings as a new text style', zh: '把当前个性化参数保存为新正文样式' },
  // 289次：CSS 代码框占位提示（查看/编辑当前个性化样式代码，作用于预览）
  subCustomCssPh: { en: 'CSS code of the custom style — view and edit, applies to the preview', zh: '个性化样式的 CSS 代码——可查看编辑，作用于预览' },
  // 290次：样例文字输入框文案
  subSampleText: { en: 'Sample text', zh: '样例文字' },
  subSamplePh: { en: 'Text shown on style cards and in the preview', zh: '显示在样式卡与预览中的样例文字' },
  subDelStyle: { en: 'Delete this style', zh: '删除该样式' },
  subOrientLandscape: { en: 'Landscape 16:9', zh: '横屏 16:9' },
  subOrientPortrait: { en: 'Portrait 9:16', zh: '竖屏 9:16' },
  // 291次：字幕注释方式单选（与视频侧栏 Detail 按钮写同一键）
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
  // 第一百七十八次：来源措辞与录制行同步（microphone/camera/screen，不再用 audio/video/screen）
  asrHint: { en: 'Upload a file, or click Record after choosing a source (microphone/camera/screen) above, then click Recognize to start.', zh: '上传文件、或选择来源（麦克风/摄像头/屏幕）后点击「录制」，再点击「开始识别」即可。' },
  ocrHint: { en: 'Upload an image or capture a photo, then click Recognize to start.', zh: '上传图片或拍照后，点击「开始识别」即可识别。' },
  asrResultTip: { en: 'Recognized sentences will appear here.', zh: '识别出的句子将显示在这里。' },
  // 反思（2026-08-21 第九十二次）：OCR 右侧面板标题改回"识别结果"——它只是纯文本结果列表，
  //   提取生词是文本侧栏（悬浮球）的活，不该叫 Text Sidebar（用户质疑命名）。
  ocrResultsTitle: { en: 'Recognition Results', zh: '识别结果' },
  ocrResultTip: { en: 'Recognized text will appear here.', zh: '识别出的文字将显示在这里。' },
  helpTitle: { en: 'User Guide', zh: '使用说明' },
  // 301次：wordDemo/transDemo 退役（池卡样例改用户输入句，不再用固定词/释义键）
  subWord: { en: 'word', zh: '单词' },
  subTrans: { en: 'meaning', zh: '释义' }
};

export function m(key) {
  const entry = MSG[key];
  if (entry) return entry[_langState] || entry.en;
  // 反思（2026-08-16 第七十二次）：data-key 含 ws. 前缀时回退到 i18n t()，
  //   避免弹窗/radio 等 ws. 键未在 MSG 注册导致文案为空（语言混杂）。
  if (typeof t === 'function' && key.startsWith('ws.')) return t(key) || '';
  return '';
}

export function log(...args) {
  console.log('[VocabRadar][guide]', ...args);
}

// === storage 回声戳（292次；多栏写入共用，分支守卫共用） ===
let _ownWriteAt = 0;
export function markOwnWrite() { _ownWriteAt = Date.now(); }
export function ownWriteAt() { return _ownWriteAt; }

// 样式 id 清洗：不在对应样式列表内的（旧版已删除/写坏）回退 fallback，保证网格恒有选中卡
// 反思（2026-08-16 第六十八次）：解决"实际有样式，但设定栏一个都没选"——
//   storage 残留已删样式 id 时 renderStyleGrid 无匹配卡。textStyle 的特殊 'custom'
//   分支（用户在弹窗改过配色）不在本清洗范围（仍是有效显示态）。
// 316次：加第三参 fallback——生词池（POOL_STYLES）删 none 卡后调用方传默认回落；
//   字幕池（SUBTITLE_TEXT_STYLES）不传仍落默认卡。
// 318次：fallback 口径定稿——调用方传默认代指常量（ANN_DEFAULT_STYLE/SUB_DEFAULT_STYLE，
//   styles.js 唯一允许缺省字面量处，版本变化才改常量值）；317 次的"指针现值"口径撤销。
//   subtitleStyle 存量 'none' 不在池内 → 自动回落 SUB_DEFAULT_STYLE（'white-bottom'）并写盘，
//   存量迁移就地完成。本函数不出现其他绝对样式字面量。
export function sanitizeStyleId(items, id, fallback) {
  if (id && Array.isArray(items) && items.some((it) => it.id === id)) return id;
  return fallback || SUB_DEFAULT_STYLE;
}

// 位置样式 id 清洗：不在 SUBTITLE_POSITIONS 内的回退默认 'b10'（贴底 1/10，与 storage/overlay
// 出厂默认一致；314次：用户裁定默认位置改贴底 10%，推翻 223 次的 'b20'——
// 'b10' 档一直存在，无显示兼容问题）
// 316次：'t10'（原顶部 1/10，316 次改名 b90 延续 b 系列命名）存量一次性迁移。
export function sanitizePositionId(id) {
  if (id === 't10') return 'b90';
  return (id && SUBTITLE_POSITIONS.some((p) => p.id === id)) ? id : 'b10';
}
