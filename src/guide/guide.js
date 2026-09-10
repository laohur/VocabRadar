// VocabRadar 引导页逻辑（第五十四次大改：四子标签 设定栏/ASR/OCR/说明栏，默认设定栏）
// 第二百五十三次（用户："引导页 asr ocr 之后增加 parser … 先实现界面"）：五子标签
//   设定栏/ASR/OCR/Parser/说明栏，新增 Parser 文档解析界面（parser.js，解析逻辑待接线）。
// 反思（2026-08-14 第五十四次修正）：用户要求 asr 跟 ocr 跟 设定栏、说明栏并列，
//   即四子标签：设定栏=按功能分组的参数与样式
//   （全局参数组 + 网页生词提示/文本侧栏/视频侧栏/视频叠加字幕四个可折叠组，组头带启用开关），
//   ASR/OCR=从文本侧栏迁移来的语音/文字识别完整功能（本文件仅负责入口与标签切换，识别逻辑见
//   asr.js/ocr.js，公共基础设施见 asr-common.js——2026-08-20 第八十六次按用户要求拆分），
//   说明栏=使用说明；默认落在设定栏。样例文字为有意义的 "He passed the quiz(测验)."。
//   本页统一承载设置：
//     - 文本样式 → 写 storage.textStyle + hintFirstBg/hintFirstFg（生词配色，注释自动派生）
//     - 文本侧栏注释样式 → 写 storage.annotationStyle
//     - 视频侧栏注释样式 → 写 storage.videoAnnotationStyle
//     - 字幕样式 → 写 storage.subtitleStyle（文字外观）+ subtitlePosition（距底部位置，overlay 实时应用）
//       + 横屏 16:9 / 竖屏 9:16 双预览（第六十九次重构：样式=文字样式×位置样式 两维）
//     - 各功能开关 / 源/目标语言 / 词频阈值 / 注释表外词开关 / ASR 模型 → 写 storage 对应键
//   文案全部经 data-key 属性由本地化字典填充，跟随界面语言。
// 第二百二十三次（用户："本次只改引导页界面"）：模型分组重排——新增「翻译」小节（从全局参数
//   挪入；行1=LLM 渠道（默认不选）+提示词，行2=其余渠道默认全选；保存监听补齐；Firefox 无内置
//   翻译灰显）；ASR/OCR 引擎改下拉两行式（本地/API 默认本地，细项随选中切换；旧存 'api' 归一化
//   为消费端认的 'llm'）；OCR 本地语言复选改动态渲染（界面/目标/释义三语言，不写死，无语言包禁用）；
//   字幕文字样式网格 3→4 列压缩留白；位置默认统一 b20（下 1/5）。
// 第二百二十四次（用户反馈修正）：①ASR/OCR 引擎由下拉改回单选（radio）两行式，细项各自铺开——
//   本地 Whisper 为 whisper-tiny 等具体模型名单选（value 仍存 tiny/base/…）；②OCR 语言复选标签
//   改回角色名 界面/目标/释义（223 次误用语言名 English/中文 当标签，用户纠正"不要特指"），
//   值仍动态映射 tess 代码、默认全选；③翻译行提示词与 LLM 复选框确认同行（收窄防换行）。
// 第二百二十五次（命名清查执行）：①存储语言键按本义改名（学习语言/释义语言两键，全库统一）；
//   ②引擎值 'llm' 定名 'api'（读侧兼容旧残留）；③死键/死代码清理（subtitleOverlay、
//   sidebarCollapsed、_asrFallbackMode、SEND_* 等）。
// 第二百二十六次（用户反馈）：①旧键迁移块删除（升级用户语言回落默认，需重选一次）；
//   ②字幕文字样式卡底框改统一窄高尺寸；③字段行水平对齐（.chk 去底部内边距）；
//   ④两个提示词与背景正文上限合并为一行；⑤ASR/OCR 改为"每行=引擎单选+细项"两行式
//   （行1 本地+Whisper 下拉，行2 API+地址/模型/Key；行1 细项=语言复选，行2 细项=格式+地址/模型/Key）。

import {
  initLang, setLang, t,
  LANG_NAMES, LANG_NAMES_EN, UI_LANGS, TRANSLATE_LANGS
} from '../lib/i18n.js';
import {
  TEXT_STYLES, ANN_STYLES, VANN_STYLES,
  SUBTITLE_TEXT_STYLES, SUBTITLE_POSITIONS, findStyle, styleLabel, BUILD_STAMP
} from '../lib/styles.js';
// 第二百五十三次：asr-common.js 名实不符改名 guide-common.js（import 同步）
import { initAsrCommon, disposeAsrCommon } from './guide-common.js';
import { initAsr, disposeAsr } from './asr.js';
import { initOcr, disposeOcr } from './ocr.js';
// 第二百五十三次：Parser 文档解析界面（本阶段界面，解析逻辑待接线）
import { initParser, disposeParser } from './parser.js';
// 第一百七十次：对话大模型来源预置表（与后台共用同一份，避免地址/模型名两处不一致）
// 第一百七十四次：新增 LLM_FORMAT_GROUPS —— 下拉按「免费直连 / OpenAI 格式 / Anthropic 格式」三类分组
import {
  LLM_PROVIDERS, LLM_FORMAT_GROUPS, LLM_DEFAULT_PROVIDER, CHAT_WORD_PROMPT, CHAT_SIDEBAR_PROMPT, getProvider
} from '../lib/llm.js';

const $ = (id) => document.getElementById(id);

// 第二百二十三次：LLM 翻译渠道提示词默认模板（{text}=原文，{lang}=释义语言）。
// 2026-09-02 修正占位为 {text}（用户裁定：Please translate "{text}" in {lang}.）
// 注意：后台 handleLlmTranslate 目前用硬编码英文提示词、不消费此键——接线属后台改造（本次仅保存）。
const LLM_TRANSLATE_PROMPT = 'Please translate "{text}" in {lang}.';

// 翻译渠道缺省表（与 lib/translator/index.js 的 DEFAULT_TRANS_CHANNELS 一致：LLM 默认不选）。
// renderAll 回填与 loadSettings 默认共用；跨标签页 get(null) 拿不到默认键时也以它兜底。
const DEFAULT_TRANS_CH = { llm: false, builtin: true, baidusug: true, youdaodict: true, mymemory: true, google: true, youdao: true, baidu: true, bing: true, lingva: true };

// 翻译渠道复选框清单（元素 id ↔ translationChannels 键），回填与保存监听共用一份
const TRANS_CH_IDS = [['transChLlm', 'llm'], ['transChBuiltin', 'builtin'], ['transChBaidusug', 'baidusug'],
  ['transChYoudaodict', 'youdaodict'], ['transChMymemory', 'mymemory'], ['transChGoogle', 'google'],
  ['transChYoudao', 'youdao'], ['transChBaidu', 'baidu'], ['transChBing', 'bing'], ['transChLingva', 'lingva']];

// 目标/释义/界面语言 → Tesseract 语言代码映射（覆盖 TRANSLATE_LANGS 全 42 种），
// OCR 本地复选框（renderOcrLangRow）动态渲染用，不写死三种语言。
// 反思（2026-09-07）：tessdata 已改 CDN 回退链加载（见 offscreen.js TESSDATA_SOURCES，
//   本地 vendor/tessdata 已删）。但 offscreen.resolveTessLang 仍只映射 zh→chi_sim、
//   其余→eng 两档，未映射语言的复选框仍须禁用，否则勾了也只会用 eng 识别（如实呈现）。
const TESS_LANG_CODES = {
  ar: 'ara', bg: 'bul', bn: 'ben', ca: 'cat', cs: 'ces', da: 'dan', de: 'deu', el: 'ell',
  en: 'eng', es: 'spa', fa: 'fas', fi: 'fin', fil: 'fil', fr: 'fra', he: 'heb', hi: 'hin',
  hu: 'hun', id: 'ind', is: 'isl', it: 'ita', ja: 'jpn', ko: 'kor', lt: 'lit', lv: 'lav',
  mk: 'mkd', ms: 'msa', nb: 'nor', nl: 'nld', pl: 'pol', pt: 'por', ro: 'ron', ru: 'rus',
  sh: 'hrv', sk: 'slk', sl: 'slv', sv: 'swe', ta: 'tam', tr: 'tur', uk: 'ukr', ur: 'urd',
  vi: 'vie', zh: 'chi_sim'
};
// resolveTessLang 已映射的 tess 代码（eng/chi_sim 走 CDN 回退链拉取，见 offscreen.js；
// 新增映射须同步 offscreen.resolveTessLang）
const BUNDLED_TESS_PACKS = new Set(['eng', 'chi_sim']);

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
  parserOutputTitle: { en: 'Parse Result', zh: '解析结果' },
  parserOutputTip: { en: 'Parsed plain text will appear here.', zh: '解析出的纯文本将显示在这里。' },
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
  groupTextHint: { en: 'Word Hints on Pages', zh: '网页生词提示' },
  groupWebSidebar: { en: 'Text Sidebar', zh: '文本侧栏' },
  groupSidebar: { en: 'Video Sidebar', zh: '视频侧栏' },
  groupOverlay: { en: 'Video Overlay Subtitles', zh: '视频叠加字幕' },
  fieldUiLang: { en: 'Interface Language', zh: '界面语言' },
  fieldSource: { en: 'Target language (to learn)', zh: '目标语言' },   // 第二百二十二次：名实相符（此键=要学习的目标语言）
  fieldTarget: { en: 'Definition language', zh: '释义语言' },   // 第二百二十二次：名实相符
  fieldThreshold: { en: 'Frequency Threshold', zh: '词频阈值' },
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
  chkSideAnnotation: { en: 'Side hint', zh: '生词旁侧邻提示' },   // 第二百一十九次：用户裁定缩短
  annLayout: { en: 'Annotation Layout', zh: '注释布局' },
  annModeSide: { en: 'Side', zh: '侧邻' },
  annModeDetail: { en: 'Detail', zh: '详细' },
  switchOn: { en: 'On', zh: '开启' },
  textStyleDesc: { en: 'New-word highlight colors across pages; annotation color is auto-inverted. Click a card to apply.', zh: '全站生词高亮配色（注释色自动为前后景互换）。点击样例卡即生效。' },
  annStyleDesc: { en: 'Style of word(meaning) annotations in the text sidebar.', zh: '文本侧栏句子中 生词(释义) 注释样式。' },
  vannStyleDesc: { en: 'Style of word(meaning) annotations in the video sidebar.', zh: '视频侧栏句子中 生词(释义) 注释样式。' },
  subStyleDesc: { en: 'Subtitle appearance and position are two separate choices. Pick a text style (color / font / size / edge / annotation layout), then pick a position from the video bottom; the two panels show horizontal & vertical previews, and the chosen style applies to on-video subtitles in real time.', zh: '字幕的外观与位置是两维独立选择。先选文字样式（颜色/字体/字号/边缘/注释布局），再选距视频底部的位置；下方横屏/竖屏双预览实时展示，选中后立即应用到视频字幕。' },
  subPreview: { en: 'Preview', zh: '效果预览' },
  subTextStyle: { en: 'Text Style', zh: '文字样式' },
  subPosition: { en: 'Position (from video bottom)', zh: '位置样式（距底部）' },
  subLandPreview: { en: 'Landscape', zh: '横屏' },
  subPortPreview: { en: 'Portrait', zh: '竖屏' },
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
  wordDemo: { en: 'word', zh: '单词' },
  transDemo: { en: '(meaning)', zh: '（释义）' },
  subWord: { en: 'word', zh: '单词' },
  subTrans: { en: 'meaning', zh: '释义' }
};

// 使用说明（说明栏），分节渲染
const HELP = [
  {
    title: { en: 'Word hints on pages', zh: '网页生词提示' },
    items: [
      { en: 'After enabling, hover over a word to see its meaning, and click to hear pronunciation.', zh: '开启后，网页上悬停生词即可查看释义，点击可发音。' },
      { en: 'Highlight style is set in Settings → Word Hints on Pages.', zh: '高亮样式在「设定栏 → 网页生词提示」中设置。' },
      { en: 'Frequency threshold filters how rare a word must be to get a meaning.', zh: '词频阈值用于过滤：只有足够生僻的词才会被标注。' }
    ]
  },
  {
    title: { en: 'Text sidebar', zh: '文本侧栏' },
    items: [
      { en: 'Collects sentences of the current page; click any word in a sentence to look it up.', zh: '汇总当前页面的句子，点击句子中的任意生词可查词。' },
      { en: 'Sentence / Word tabs switch between two views.', zh: '句 / 词 两个标签切换视图。' },
      { en: 'New-word (meaning) annotation style is set in Settings → Text Sidebar.', zh: '生词(释义) 注释样式在「设定栏 → 文本侧栏」中设置。' }
    ]
  },
  {
    title: { en: 'Video sidebar', zh: '视频侧栏' },
    items: [
      { en: 'On video pages, shows subtitle sentences of the current video with word meanings.', zh: '在视频页面显示当前视频的逐句字幕并标注生词释义。' },
      { en: 'Sentence / Word tabs switch between views; click a sentence to jump the video.', zh: '句 / 词 两个标签切换视图，点击句子可跳转视频。' },
      { en: 'Annotation style is set in Settings → Video Sidebar.', zh: '注释样式在「设定栏 → 视频侧栏」中设置。' }
    ]
  },
  {
    title: { en: 'Video overlay subtitles', zh: '视频叠加字幕' },
    items: [
      { en: 'Renders the current subtitle onto the video; position / color / font / size / edge are fully configurable.', zh: '将当前字幕叠加到视频画面上，位置/颜色/字体/字号/边缘均可配置。' },
      { en: 'Preview and apply styles in Settings → Video Overlay Subtitles.', zh: '在「设定栏 → 视频叠加字幕」中预览并应用样式。' }
    ]
  },
  {
    title: { en: 'Speech recognition (ASR)', zh: '语音识别（ASR）' },
    items: [
      { en: 'In the ASR tab, upload audio/video, or record audio / video / screen; sentences are recognized and annotated with word meanings.', zh: '在「ASR 栏」上传音视频或录音/录像/录屏，实时识别句子并标注生词释义。' },
      { en: 'Recognition runs locally (Whisper) or via an OpenAI-compatible transcription API, chosen in Settings → Models. Progress and results are shown in the ASR tab.', zh: '识别在本地（Whisper）或 OpenAI 兼容转写 API 运行，于「设定栏 → 模型」选择；进度与结果在「ASR 栏」查看。' }
    ]
  },
  {
    title: { en: 'Text recognition (OCR)', zh: '文字识别（OCR）' },
    items: [
      { en: 'In the OCR tab, upload an image or capture from camera to recognize text in it.', zh: '在「OCR 栏」上传图片或拍照，识别画面中的文字。' },
      { en: 'Recognized lines are annotated with word meanings for your vocabulary.', zh: '识别出的每行文字会标注生词释义。' }
    ]
  },
  {
    title: { en: 'Document parser', zh: '文档解析（Parser）' },
    items: [
      { en: 'In the Parser tab, paste text or a link, or upload / drop / paste a file (web page HTML, PDF, DOCX, txt/md/srt…, image, audio/video); the parsed plain text shows on the right.', zh: '在「Parser 栏」粘贴文本或链接，或上传/拖入/粘贴文件（网页 HTML、PDF、DOCX、txt/md/srt 等文本类、图片、音视频），解析出的纯文本显示在右栏。' },
      { en: 'Images are recognized by OCR and audio/video by speech recognition (engine chosen in Settings → Models); Capture uses the camera, Record uses microphone/camera/screen.', zh: '图片走 OCR 识别、音视频走语音识别（引擎在「设定栏 → 模型」选择）；「拍照」用摄像头，「录制」来源为麦克风/摄像头/屏幕。' }
    ]
  },
  {
    title: { en: 'Dictionary & translation', zh: '词典与翻译' },
    items: [
      { en: 'Meanings come from the built-in dictionary; rare words are auto-inverted via the annotation color.', zh: '释义来自内置词典，生词注释色自动与高亮前后景互换。' },
      { en: 'Offscreen translation is used when the local dictionary has no entry.', zh: '本地词典缺词时，后台使用离线翻译补充。' }
    ]
  }
];

let _lang = 'zh';

// 当前选中的字幕文字/位置样式 id（渲染样卡与双预览共用，切换时同步刷新）
let _subStyleId = 'none';
let _subPosId = 'b20';   // 第二百二十三次：默认位置统一下 1/5（原 'b10' 与 storage 默认 b20 不一致）

function m(key) {
  const entry = MSG[key];
  if (entry) return entry[_lang] || entry.en;
  // 反思（2026-08-16 第七十二次）：data-key 含 ws. 前缀时回退到 i18n t()，
  //   避免弹窗/radio 等 ws. 键未在 MSG 注册导致文案为空（语言混杂）。
  if (typeof t === 'function' && key.startsWith('ws.')) return t(key) || '';
  return '';
}

function log(...args) {
  console.log('[VocabRadar][guide]', ...args);
}

// === 渲染函数 ===

function _setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}

function renderLangSelect(selectEl, langs, selected, names) {
  // 第二百二十八次：names 可选——释义语言下拉传 LANG_NAMES_EN 统一英文名（用户裁定），
  // 其余下拉缺省用本地化名 LANG_NAMES。
  const nameOf = names || LANG_NAMES;
  selectEl.innerHTML = '';
  for (const code of langs) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = nameOf[code] || code;
    opt.selected = (code === selected);
    selectEl.appendChild(opt);
  }
}

// 样例网格（三列四行）
function renderStyleGrid(container, items, activeId, renderCard) {
  container.innerHTML = '';
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'style-card' + (item.id === activeId ? ' active' : '');
    card.dataset.id = item.id;
    card.dataset.style = item.id;
    card.appendChild(renderCard(item));
    const label = document.createElement('div');
    label.className = 'card-label';
    label.textContent = styleLabel(item, _lang);
    card.appendChild(label);
    container.appendChild(card);
  }
}

// 文本样式卡：生词高亮 + (释义) 侧邻注释
function textCard(item) {
  const demo = document.createElement('div');
  demo.className = 'demo';
  const w = document.createElement('span');
  w.className = 'word-demo';
  w.textContent = m('wordDemo');
  const a = document.createElement('span');
  a.className = 'ann-demo';
  a.textContent = m('transDemo');
  // none 卡显示默认配色（绿底白字 #2e6b43/#ffffff），与页面实际渲染一致
  const wordBg = item.wordBg || '#2e6b43';
  const wordFg = item.wordFg || '#ffffff';
  w.style.background = wordBg;
  w.style.color = wordFg;
  w.style.borderRadius = item.radius || '3px';
  if (item.bold) w.style.fontWeight = '600';
  if (item.italic) w.style.fontStyle = 'italic';
  if (item.underline) w.style.textDecoration = 'underline';
  if (item.shadow) w.style.boxShadow = item.shadow;
  if (item.fontSize) w.style.fontSize = item.fontSize;
  const opaqueBg = wordBg && !/^rgba\(/.test(wordBg) && !/^transparent$/i.test(wordBg);
  a.style.background = opaqueBg ? wordFg : 'transparent';
  a.style.color = opaqueBg ? wordBg : wordFg;
  a.style.borderRadius = item.radius || '3px';
  demo.appendChild(w);
  demo.appendChild(a);
  return demo;
}

// 侧栏注释样式卡：生词(释义) 样例（文本/视频侧栏共用渲染）
function annCard(item) {
  const demo = document.createElement('div');
  demo.className = 'demo';
  const w = document.createElement('span');
  w.className = 'word-demo';
  w.textContent = m('wordDemo');
  const a = document.createElement('span');
  a.className = 'ann-demo';
  a.textContent = m('transDemo');
  // 反思（2026-08-20 第八十三次）：none 卡（无 wordBg/annBg 字段）之前完全不套配色→空白卡，
  //   与实际渲染（默认单词绿底白字 + 注释白底绿字 #2e6b43/#ffffff ↔ #ffffff/#2e6b43）不符。
  //   镜像 textCard 的默认处理：wordBg/wordFg 缺失取默认，注释块按前后景互换派生。
  const wordBg = item.wordBg || '#2e6b43';
  const wordFg = item.wordFg || '#ffffff';
  w.style.background = wordBg;
  w.style.color = wordFg;
  w.style.borderRadius = item.radius || '3px';
  if (item.bold) w.style.fontWeight = '600';
  if (item.italic) w.style.fontStyle = 'italic';
  if (item.underline) w.style.textDecoration = 'underline';
  if (item.shadow) w.style.boxShadow = item.shadow;
  // 反思（2026-08-15 第六十三次）：大字样式（wordFontSize/fontSize）在样卡中同样生效
  if (item.wordFontSize) w.style.fontSize = item.wordFontSize;
  const opaqueBg = wordBg && !/^rgba\(/.test(wordBg) && !/^transparent$/i.test(wordBg);
  a.style.background = item.annBg || (opaqueBg ? wordFg : 'transparent');
  a.style.color = item.annFg || (opaqueBg ? wordBg : wordFg);
  a.style.borderRadius = item.radius || '3px';
  if (item.fontSize) a.style.fontSize = item.fontSize;
  demo.appendChild(w);
  demo.appendChild(a);
  return demo;
}

// 字幕样式卡：迷你 16:9 视频区 + 按文字样式（在当前位置 ratio 上）渲染的 word(释义) 字幕
const GUIDE_FONTS = {
  sans: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  serif: '"Georgia", "Times New Roman", "SimSun", serif',
  mono: '"Consolas", "Courier New", monospace'
};

// 字幕盒样式（文字样式卡/预览共用）：文字属性 + 背景 + 内边距，不含定位与换行
// 反思（2026-08-19 第八十次）：拆出独立函数——详细模式预览的注释块需与字幕行盒分离
//   （注释独立块不带盒背景，见 subSampleHtml），盒样式与 buildSubMiniCss 保持一致。
function buildSubBoxCss(item, s) {
  const parts = [];
  parts.push('color:' + (item.fg || '#ffffff'));
  // 第一百二十七次：默认外观（size=null）预览字号与真实 overlay 基线一致（24px，
  // 真实端随视频高度 4.5% 自适应；引导页小窗按 s 缩放）
  parts.push('font-size:' + Math.round((item.size || (item.id === 'none' ? 24 : 16)) * s) + 'px');
  parts.push('font-family:' + (GUIDE_FONTS[item.font] || GUIDE_FONTS.sans));
  if (item.id === 'none') {
    parts.push('background:rgba(0,0,0,0.75)');
  } else if (item.bg) {
    parts.push('background:' + item.bg);
  }
  if (item.bold) parts.push('font-weight:600');
  if (item.italic) parts.push('font-style:italic');
  if (item.shadow) parts.push('text-shadow:' + (typeof item.shadow === 'string' ? item.shadow : '0 0 4px rgba(0,0,0,.9)'));
  if (item.edge) parts.push('-webkit-text-stroke:1px ' + item.edge);
  parts.push('padding:2px 6px;border-radius:3px');
  return parts.join(';');
}

// 按字幕文字样式元数据 + 位置 ratio 生成迷你字幕元素 cssText（样卡/双预览共用）
// 反思（2026-08-16 第六十九次）：位置与文字样式解耦——bottom = ratio×100%（距视频底部比例），
//   'none'（默认）= 深色半透明条 + 无文本投影（第六十七次起，与 overlay 基础样式一致）。
// 反思（2026-08-19 第七十九次）：新增 flow 模式——文字样式卡（.sub-stage）不再用
//   绝对定位迷你视频区（与前三个栏目尺寸一致，见 subCard），flow=true 时省略
//   position/left/bottom/transform，按普通流渲染水平文本样例。
// 反思（2026-08-19 第八十次）：位置预览按"中心水平线"对齐——ratio 是字幕框中心线距
//   底部比例（与真实 overlay 一致），transform 加 translateY(50%)：bottom 置于 ratio 线后
//   下移半高，使盒子中心正好落在中心线上（用户："预览窗口的字幕位置并不准，没按中心水平线"）。
function buildSubMiniCss(item, ratio, scale, wrap, flow) {
  const s = (typeof scale === 'number' && scale > 0) ? scale : 1;
  const parts = [];
  if (flow) {
    parts.push('white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis');
  } else {
    parts.push('position:absolute;left:50%;bottom:' + (ratio * 100) + '%;transform:translate(-50%, 50%)');
    parts.push(wrap
      ? 'white-space:normal;max-width:100%;word-break:break-word;line-height:1.35'
      : 'white-space:nowrap;max-width:94%;overflow:hidden;text-overflow:ellipsis');
  }
  parts.push(buildSubBoxCss(item, s));
  return parts.join(';');
}

// 有意义的样字（2026-08-16 第七十次）：不再用"单词释义"占位符，改用与真实字幕一致的
// 句子样例（styles.js 各字幕样式自带 sample，如 "He passed the quiz(测验)."）——
// 生词 quiz 绿色高亮 + (测验) 释义，detail 模式释义换行为 "quiz 测验" 新行，
// 模拟 subtitle-overlay 的真实渲染（生词绿块 + 释义，所见即所得）。
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function subSampleHtml(item, ratio, annMode, scale, wrap, flow, plain) {
  const sample = item.sample || 'He passed the quiz(测验).';
  // 反思（2026-08-19 第八十一次）：样例解析修正——旧正则以 `(?:\(...\))?` 将括号组设为可选，
  //   且 `(.*?)` 惰性匹配到第一个单词即停：样例 "He passed the quiz(测验)." 解析出的生词是
  //   "He"（高亮错词、释义为空，用户反馈"生词标错/详细模式释义没放正确"）。
  //   修正：括号组必选，先匹配"单词紧邻 (释义)"结构；无括号的旧样例按句中 quiz 兜底高亮；
  //   仍无生词的样例整句原样输出（不虚构高亮与释义）。
  const m = sample.match(/^(.*?)([A-Za-z]+)\(([^)]*)\)(.*)$/);
  let before = m ? m[1] : '';
  let word = m ? m[2] : '';
  let trans = m ? (m[3] || '') : '';
  let after = m ? m[4] : '';
  if (!m) {
    const q = sample.match(/^(.*?)(quiz\b)([^]*)$/i);
    if (q) {
      before = q[1];
      word = q[2];
      trans = '测验';
      after = q[3];
    } else {
      before = '';
      word = '';
      trans = '';
      after = sample;
    }
  }
  const s = (typeof scale === 'number' && scale > 0) ? scale : 1;
  // 释义字色：有底色样式（含默认深条）用白字；透明底样式直显样式前景色
  const annFg = item.bg ? '#ffffff' : (item.fg || '#ffffff');
  const wordCss = 'background:#2e6b43;color:#ffffff;border-radius:2px;padding:0 3px;font-weight:600';
  // 注释模式：预览优先用 radio 选中的模式（用户要求"侧邻注释跟详细注释预览中有变化"），
  //   无覆盖时用样式自带默认（annMode 字段）；plain（样式卡）恒为纯文字展示（单行、无注释块）
  const mode = (annMode !== undefined && annMode !== null) ? annMode : item.annMode;
  if (!word) {
    return '<span style="' + buildSubMiniCss(item, ratio, scale, wrap, flow) + '">' + escapeHtml(after) + '</span>';
  }
  const beforeHtml = escapeHtml(before);
  const wordHtml = '<span style="' + wordCss + '">' + escapeHtml(word) + '</span>';
  const afterHtml = escapeHtml(after);
  if (!plain && mode === 'detail') {
    // 反思（2026-08-19 第八十次）：详细模式注释独立成块——与真实 overlay 一致
    //   （subtitle-overlay.js buildDetailAnnotationHtml 的 .beaver-overlay-ann-line 独立元素）。
    //   字幕行盒（盒样式 buildSubBoxCss）与注释块分离为兄弟元素：注释不带盒背景、
    //   位于盒下方独立一行（用户：'详细模式时候，预览窗口的单词注释并没有独立出来'）。
    //   旧版注释嵌在字幕行盒内（受 overflow:hidden 裁剪），故未"独立出来"。
    // 反思（2026-08-19 第八十一次）：注释块补显式 font-size（0.9×字幕字号，与真实 overlay
    //   .beaver-overlay-annotations 的 0.9em 一致）——旧版继承容器字号（约13px），大字号样式
    //   下注释比字幕小、小字号样式下注释比字幕大（用户反馈"文字样式大小不一"）。
    const subCss = (wrap
      ? 'white-space:normal;max-width:100%;word-break:break-word;line-height:1.35'
      : 'white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis') + ';' + buildSubBoxCss(item, s);
    const subBox = '<span style="' + subCss + '">' + beforeHtml + wordHtml + afterHtml + '</span>';
    const annBlock = '<div style="margin-top:4px;line-height:1.3;text-align:left;white-space:' + (wrap ? 'normal' : 'nowrap') + ';font-size:' + Math.round((item.size || 16) * s * 0.9) + 'px">'
      + '<span style="color:' + annFg + ';font-weight:600">' + escapeHtml(word) + '</span> '
      + '<span style="color:' + annFg + '">' + escapeHtml(trans) + '</span></div>';
    if (flow) return subBox + annBlock;
    // 预览：外容器绝对定位居中（盒子中心落在 ratio 中心线），字幕行盒 + 注释块竖排
    return '<span style="position:absolute;left:50%;bottom:' + (ratio * 100) + '%;transform:translate(-50%, 50%);display:flex;flex-direction:column;align-items:center;max-width:94%">'
      + subBox + annBlock + '</span>';
  }
  // 侧邻注释模式（或样式卡 plain）：字幕行内生词高亮 + (释义) 行内。
  //   plain 卡不显示行内释义——样式卡只展示文字样式，注释布局由下方双预览（radio 驱动）负责。
  const inner = beforeHtml + wordHtml
    + (!plain && trans ? '<span style="color:' + annFg + '">(' + escapeHtml(trans) + ')</span>' : '')
    + afterHtml;
  return '<span style="' + buildSubMiniCss(item, ratio, scale, wrap, flow) + '">' + inner + '</span>';
}

function subCard(item) {
  const demo = document.createElement('div');
  demo.className = 'demo sub-stage';
  // 反思（2026-08-19 第七十九次）：文字样式卡尺寸与前三个栏目一致——
  //   不再用 92×52 迷你视频区 + 绝对定位，改用 flow 模式水平文本样例（同 .demo 卡片）。
  //   位置不再在样卡上体现（有独立位置卡 + 双预览）。
  // 反思（2026-08-19 第八十一次）：plain 纯文字展示——所有样卡统一单行（无注释块），
  //   避免 detail 样式卡出现"字幕+注释"两行（用户反馈"有的出现了两行"）；
  //   注释布局（侧邻/详细）由下方双预览（radio 驱动）展示。
  const mini = document.createElement('div');
  mini.className = 'sub-demo';
  // 反思（2026-08-20 第八十五次）：样卡字号过小——旧 scale=0.45 是第七十九次之前
  //   92×52 迷你视频区时代的残留，16px 默认字号被缩到约 7px，远小于前三个栏目的
  //   13px 基准（用户反馈"文字样式的字尤其小"）。改用 0.8：16×0.8≈13px，与其他栏目一致。
  mini.innerHTML = subSampleHtml(item, 0, undefined, 0.8, false, true, true);
  demo.appendChild(mini);
  return demo;
}

// 位置样式卡：迷你 16:9 视频区 + 一条位于 ratio 处的白线
function posCard(item) {
  const demo = document.createElement('div');
  demo.className = 'demo sub-pos-stage';
  const line = document.createElement('div');
  line.className = 'sub-pos-line';
  line.style.bottom = (item.ratio * 100) + '%';
  demo.appendChild(line);
  return demo;
}

// 重新渲染文字样式网格（位置切换后样卡的位置线需跟随刷新；容器监听已委托，无需重绑）
function renderSubTextGrid() {
  renderStyleGrid($('subtitleStyleGrid'), SUBTITLE_TEXT_STYLES, _subStyleId, subCard);
}

// 横屏(16:9) + 竖屏(9:16) 双预览：以当前文字样式 + 位置 ratio 各渲染一遍
// 反思（2026-08-16 第六十九次）：竖屏适配不再靠样式 orient 字段，双预览同时展示，
//   所见即所得（字幕横排、位置按视频矩形比例）。
// 反思（2026-08-18 第七十三次修正）：预览跟随 videoOverlayAnnMode radio——侧邻/详细
//   切换时预览同步变化（用户要求"侧邻注释跟详细注释预览中有变化才是"）。
function renderSubPreview() {
  const row = $('subPreviewRow');
  if (!row) return;
  const style = findStyle(SUBTITLE_TEXT_STYLES, _subStyleId) || SUBTITLE_TEXT_STYLES[0];
  const pos = findStyle(SUBTITLE_POSITIONS, _subPosId) || SUBTITLE_POSITIONS[0];
  // 读取当前选中的注释模式 radio（侧邻 side / 详细 detail）
  const checked = document.querySelector('input[name="videoOverlayAnnMode"]:checked');
  const annMode = checked ? checked.value : 'side';
  row.innerHTML = '';
  for (const orient of ['land', 'port']) {
    const stage = document.createElement('div');
    stage.className = 'sub-preview-stage ' + orient;
    const mini = document.createElement('div');
    mini.className = 'sub-preview-mini';
    // 反思（2026-08-20 第八十六次）：横屏/竖屏窗口大小一致（同面积、长宽互换，
    //   横屏 480×270 / 竖屏 270×480），字幕字号统一 0.8 缩放、视觉一致。
    //   （旧版竖屏 152×270 面积远小于横屏，用户要求"二者大小一致，只是长宽互换"。）
    mini.innerHTML = subSampleHtml(style, pos.ratio, annMode, 0.8, orient === 'port', false);
    stage.appendChild(mini);
    const cap = document.createElement('div');
    cap.className = 'sub-preview-caption';
    cap.textContent = m(orient === 'land' ? 'subLandPreview' : 'subPortPreview');
    const wrap = document.createElement('div');
    wrap.className = 'sub-preview-col';
    wrap.appendChild(stage);
    wrap.appendChild(cap);
    row.appendChild(wrap);
  }
}

// 位置样式 id 清洗：不在 SUBTITLE_POSITIONS 内的回退默认 'b20'（下 1/5，与 storage/overlay 默认一致；
// 第二百二十三次：原回退 'b10' 与默认值链不一致，残留非法值时会显示成下 1/10）
function sanitizePositionId(id) {
  return (id && SUBTITLE_POSITIONS.some((p) => p.id === id)) ? id : 'b20';
}

// 说明栏内容
function renderHelp() {
  const box = $('helpBody');
  if (!box) return;
  box.innerHTML = '';
  for (const sec of HELP) {
    const title = document.createElement('h3');
    title.className = 'help-title';
    title.textContent = sec.title[_lang] || sec.title.en;
    box.appendChild(title);
    const ul = document.createElement('ul');
    ul.className = 'help-list';
    for (const item of sec.items) {
      const li = document.createElement('li');
      li.textContent = item[_lang] || item.en;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
}

// 通用 data-key 文案填充
// 反思（2026-08-16 第七十一次）：⑥ 两处增强——
//   1) 保留前导图标（📁/🎙 等 emoji）：旧版 textContent 直接覆盖会把按钮 emoji 吞掉，
//      现在仅当元素文本以 emoji 开头时保留"emoji + 空格 + i18n 文案"；
//   2) 支持 data-title-key：悬浮提示（如 ASR 来源 radio 的 *_Title 键）也走 i18n，
//      不再硬编码英文 title。
function fillByDataKey() {
  document.querySelectorAll('[data-key]').forEach((el) => {
    const key = el.dataset.key;
    const txt = m(key);
    if (txt !== '') {
      const icon = (el.textContent || '').match(/^\s*\p{So}/u);
      el.textContent = icon ? icon[0] + ' ' + txt : txt;
    }
  });
  document.querySelectorAll('[data-title-key]').forEach((el) => {
    const key = el.dataset.titleKey;
    const txt = m(key);
    if (txt !== '') el.title = txt;
  });
  // 第二百五十三次：data-ph-key——textarea/input 占位符本地化（Parser 输入框用；
  //   placeholder 是属性而非文本内容，data-key 的 textContent 路径不适用）
  document.querySelectorAll('[data-ph-key]').forEach((el) => {
    const key = el.dataset.phKey;
    const txt = m(key);
    if (txt !== '') el.placeholder = txt;
  });
}

// === 事件绑定 ===

// 样式网格点击：写 storage + 切 active + 预览（每个网格只绑一次）
function bindStyleGrid(container, storageKey, applyPreview) {
  if (container.dataset.bound) return;
  container.dataset.bound = '1';
  container.addEventListener('click', (e) => {
    const card = e.target.closest('.style-card');
    if (!card) return;
    const id = card.dataset.id;
    container.querySelectorAll('.style-card').forEach((c) => c.classList.remove('active'));
    card.classList.add('active');
    const patch = {};
    patch[storageKey] = id;
    // 文本样式需联动生词配色（none → 恢复默认绿底白字 #2e6b43/#ffffff）
    if (storageKey === 'textStyle') {
      const st = TEXT_STYLES.find((t) => t.id === id);
      if (st && st.wordBg) {
        patch.hintFirstBg = st.wordBg;
        patch.hintFirstFg = st.wordFg;
      } else {
        patch.hintFirstBg = '#2e6b43';
        patch.hintFirstFg = '#ffffff';
      }
    }
    chrome.storage.local.set(patch, () => {
      if (applyPreview) applyPreview(id);
      log('已选择 ' + storageKey + ' =', id);
    });
  });
}

// 加载既有设置并回填控件
// 第二百一十三次（用户："更新 config.json…引导页的所有参数都在此"）：
//   引导页全部默认参数以 src/data/config.json 为唯一来源（键名=storage 键），
//   本文件内联对象仅作 config 缺键时的保底；storage 里用户已设的值恒优先。
let _configDefaults = null;
async function getConfigDefaults() {
  if (_configDefaults) return _configDefaults;
  try {
    const res = await fetch(chrome.runtime.getURL('src/data/config.json'));
    if (res.ok) _configDefaults = await res.json();
  } catch (e) { _configDefaults = null; }
  return _configDefaults || {};
}

async function loadSettings() {
  const cfgDefaults = await getConfigDefaults();
  const defaults = Object.assign({
    uiLanguage: 'zh',
    learnLanguage: 'en',
    meaningLanguage: 'zh',
    rankThreshold: 5000,
    annotateOov: false,
    uiLanguage: 'zh',
    learnLanguage: 'en',
    meaningLanguage: 'zh',
    rankThreshold: 5000,
    annotateOov: false,
    annotateRepeat: false,
    hintSideAnnotation: false,
    textHintEnabled: true,
    // 第一百七十次：与唯一来源 src/data/config.json 的 asrModelSize 保持一致（原写 base.en，
    //   与 config.json 的 base 不符，未设置过的用户会看到与实际生效值不同的选项）
    asrModelSize: 'base',
    // 第一百七十次：对话大模型配置（llmBaseUrl/llmModel 留空 = 用所选来源的预置值）
    llmProvider: LLM_DEFAULT_PROVIDER,
    llmBaseUrl: '',
    llmModel: '',
    llmApiKey: '',
    chatWordPrompt: CHAT_WORD_PROMPT,
    chatSidebarPrompt: CHAT_SIDEBAR_PROMPT,
    chatContextMaxBytes: 10000,   // 第二百一十二次：对话上下文字节上限（默认 1 万字节，用户三度确认 [10 000]）
    // 第二百二十三次：引擎改下拉两行式；补齐 asrLlm*/ocrLlm* 六键与 translationChannels/llmTranslatePrompt 默认
    ocrEngine: 'tesseract',   // OCR 引擎（tesseract | api；第二百二十五次：值 'llm' 改名 'api'）
    asrEngine: 'local',   // ASR 引擎（local whisper | api 转写；同上改名）
    asrLlmModel: 'whisper-1',   // LLM 转写模型（用户自管，有错就报）
    asrLlmBaseUrl: '',   // 转写 API 接口地址（后台 resolveLlmEngineCfg('asr') 消费，此前无 UI）
    asrLlmApiKey: '',    // 转写 API Key（此前无 UI）
    ocrLlmProvider: 'openai',   // OCR 视觉识别 API 格式（openai | anthropic）
    ocrLlmBaseUrl: '',
    ocrLlmModel: '',
    ocrLlmApiKey: '',
    translationChannels: DEFAULT_TRANS_CH,   // 第二百二十三次：改引常量（LLM 渠道默认不选，其余全选）
    llmTranslatePrompt: LLM_TRANSLATE_PROMPT,   // LLM 翻译渠道提示词（{text}=原文，{lang}=释义语言）
    // 第一百零二次：asrFirstChunkSec 默认值条目移除（唯一来源 src/data/config.json）
    textStyle: 'none',
    annotationStyle: 'none',
    videoAnnotationStyle: 'none',
    subtitleStyle: 'none',
    subtitlePosition: 'b20',   // 第二百一十九次：默认位置改为下 1/5（用户裁定）
    webSidebarEnabled: true,
    sidebarEnabled: true,
    // 反思（2026-08-21 第九十次）：用户要求"视频叠加字幕应当默认不选"——默认 false
    overlayEnabled: false,
    webSidebarAnnMode: 'side',
    videoSidebarAnnMode: 'side',
    videoOverlayAnnMode: 'side',
    hintFirstBg: '#2e6b43',
    hintFirstFg: '#ffffff'
  }, cfgDefaults);
  chrome.storage.local.get(defaults, (res) => {
    _lang = (res.uiLanguage === 'zh') ? 'zh' : 'en';
    renderAll(res);
  });
}

function renderAll(res) {
  // 语言控件（2026-09-02 释义语言统一英文名称：meaningLanguage 固定用 LANG_NAMES_EN）
  renderLangSelect($('uiLang'), UI_LANGS, res.uiLanguage);
  renderLangSelect($('learnLanguage'), TRANSLATE_LANGS, res.learnLanguage);
  renderLangSelect($('meaningLanguage'), TRANSLATE_LANGS, res.meaningLanguage, LANG_NAMES_EN);
  $('rankThreshold').value = res.rankThreshold;
  $('annotateOov').checked = !!res.annotateOov;
  // 第二百二十五次：引擎存储值定名 'api'（与 UI 词、语义一致，《命名清查》裁定）。
  // 兼容读旧残留：223~224 次存过 'llm'，读侧归一化为 'api' 并回写一次（同样式 id 清洗模式）。
  // 第二百二十六次：每行=引擎单选+该引擎细项（两行常驻），不再做细项行显隐切换。
  const asrEng = (res.asrEngine === 'llm' || res.asrEngine === 'api') ? 'api' : 'local';
  if (res.asrEngine === 'llm') chrome.storage.local.set({ asrEngine: 'api' });
  document.querySelectorAll('input[name="asrEngine"]').forEach((r) => { r.checked = (r.value === asrEng); });
  const ocrEng = (res.ocrEngine === 'llm' || res.ocrEngine === 'api') ? 'api' : 'tesseract';
  if (res.ocrEngine === 'llm') chrome.storage.local.set({ ocrEngine: 'api' });
  document.querySelectorAll('input[name="ocrEngine"]').forEach((r) => { r.checked = (r.value === ocrEng); });
  // OCR 本地语言复选（界面/目标/释义三角色，值动态映射 tess 代码，默认全选——见 renderOcrLangRow）
  renderOcrLangRow(res);
  // ASR API 细项回填（地址/Key 此前无 UI；模型名保留 whisper-1 兜底）
  $('asrLlmBaseUrl').value = res.asrLlmBaseUrl || '';
  $('asrLlmApiKey').value = res.asrLlmApiKey || '';
  $('asrLlmModel').value = res.asrLlmModel || 'whisper-1';
  // OCR API 细项回填（格式下拉 openai/anthropic，缺省 openai；地址/模型 placeholder 随格式给预置值）
  $('ocrLlmProvider').value = (res.ocrLlmProvider === 'anthropic') ? 'anthropic' : 'openai';
  applyOcrProviderHints($('ocrLlmProvider').value);
  $('ocrLlmBaseUrl').value = res.ocrLlmBaseUrl || '';
  $('ocrLlmModel').value = res.ocrLlmModel || '';
  $('ocrLlmApiKey').value = res.ocrLlmApiKey || '';
  // 翻译渠道回填（缺省表兜底：LLM 不选、其余全选——跨标签页 get(null) 拿不到默认键时防止全亮）
  // 无内置翻译 API 的浏览器（Firefox）：「浏览器自身」灰显禁用且不勾选
  const tch = Object.assign({}, DEFAULT_TRANS_CH, res.translationChannels || {});
  const builtinUnsupported = (typeof Translator === 'undefined');
  TRANS_CH_IDS.forEach(([id, k]) => {
    const cb = $(id);
    cb.checked = (tch[k] !== false);
    if (k === 'builtin') {
      cb.disabled = builtinUnsupported;
      cb.checked = cb.checked && !builtinUnsupported;
      const lbl = cb.closest('label.chk');
      if (lbl) {
        lbl.classList.toggle('disabled', builtinUnsupported);
        lbl.title = builtinUnsupported ? m('transChBuiltinNoFx') : '';
      }
    }
  });
  $('llmTranslatePrompt').value = res.llmTranslatePrompt || LLM_TRANSLATE_PROMPT;
  $('annotateRepeat').checked = !!res.annotateRepeat;
  $('hintSideAnnotation').checked = !!res.hintSideAnnotation;
  $('textHintEnabled').checked = res.textHintEnabled !== false;
  $('webSidebarEnabled').checked = res.webSidebarEnabled !== false;
  $('sidebarEnabled').checked = res.sidebarEnabled !== false;
  // 反思（2026-08-21 第九十次）：视频叠加字幕默认不选——严格 === true（未设置=不选）
  $('overlayEnabled').checked = res.overlayEnabled === true;
  // 注释模式单选初始化
  _setRadio('webSidebarAnnMode', res.webSidebarAnnMode || 'side');
  _setRadio('videoSidebarAnnMode', res.videoSidebarAnnMode || 'side');
  _setRadio('videoOverlayAnnMode', res.videoOverlayAnnMode || 'side');
  // Whisper 模型下拉回填（第二百二十六次：由单选铺开改回下拉；storage 残留 offscreen 不支持的值时回落 base）
  $('asrModelSize').value = res.asrModelSize || 'base';
  if (!$('asrModelSize').value) {
    // 第二百二十九次：非法残留值（如下拉里见到页面 URL 之类的串）回落 base 并回写，
    //   防止每次进入引导页都回落显示、storage 却永远是脏值。
    $('asrModelSize').value = 'base';
    chrome.storage.local.set({ asrModelSize: 'base' });
  }
  // 第一百零二次：asrFirstChunkSec 引导页控件已移除（唯一来源 src/data/config.json）

  // 模型行（第一百七十次）：来源下拉 + API 配置回填
  renderLlmProviderSelect(res.llmProvider);
  $('llmBaseUrl').value = res.llmBaseUrl || '';
  $('llmModel').value = res.llmModel || '';
  $('llmApiKey').value = res.llmApiKey || '';
  $('chatWordPrompt').value = res.chatWordPrompt || CHAT_WORD_PROMPT;
  $('chatSidebarPrompt').value = res.chatSidebarPrompt || CHAT_SIDEBAR_PROMPT;
  // 第二百零七次：对话上下文上限回填（空值显示默认 100000）
  $('chatContextMaxBytes').value = res.chatContextMaxBytes || 10000;
  applyLlmProviderHints(res.llmProvider);

  // 文本样式网格：若当前生词配色与选中样式不符（用户曾在弹窗手改），不标 active
  let textActive = res.textStyle || 'none';
  // 反思（2026-08-16 第六十八次）：stale-id 清洗——storage 里可能是旧版已删除的样式 id
  //   （如字幕样式 right-vertical/center-vertical），renderStyleGrid 找不到匹配卡 → "一个都没选中"。
  //   统一：四个样式网格的 id 若不在对应列表，回退 'none' 并回写 storage（下轮渲染恒有选中卡）。
  if (!TEXT_STYLES.some((t) => t.id === textActive)) {
    textActive = 'none';
    chrome.storage.local.set({ textStyle: 'none' });
  } else {
    const st = TEXT_STYLES.find((t) => t.id === textActive);
    if (st && st.wordBg && (st.wordBg !== res.hintFirstBg || st.wordFg !== res.hintFirstFg)) {
      textActive = 'custom';
    }
  }
  renderStyleGrid($('textStyleGrid'), TEXT_STYLES, textActive, textCard);
  bindStyleGrid($('textStyleGrid'), 'textStyle', null);

  const annActive = sanitizeStyleId(ANN_STYLES, res.annotationStyle);
  if (annActive !== (res.annotationStyle || 'none')) chrome.storage.local.set({ annotationStyle: annActive });
  renderStyleGrid($('annStyleGrid'), ANN_STYLES, annActive, annCard);
  bindStyleGrid($('annStyleGrid'), 'annotationStyle', null);

  const vannActive = sanitizeStyleId(VANN_STYLES, res.videoAnnotationStyle);
  if (vannActive !== (res.videoAnnotationStyle || 'none')) chrome.storage.local.set({ videoAnnotationStyle: vannActive });
  renderStyleGrid($('vannStyleGrid'), VANN_STYLES, vannActive, annCard);
  bindStyleGrid($('vannStyleGrid'), 'videoAnnotationStyle', null);

  // 字幕：文字样式 + 位置样式 两维独立选择（第六十九次重构）
  const subActive = sanitizeStyleId(SUBTITLE_TEXT_STYLES, res.subtitleStyle);
  if (subActive !== (res.subtitleStyle || 'none')) chrome.storage.local.set({ subtitleStyle: subActive });
  const posActive = sanitizePositionId(res.subtitlePosition);
  if (posActive !== (res.subtitlePosition || 'b20')) chrome.storage.local.set({ subtitlePosition: posActive });
  _subStyleId = subActive;
  _subPosId = posActive;
  renderStyleGrid($('subtitleStyleGrid'), SUBTITLE_TEXT_STYLES, subActive, subCard);
  bindStyleGrid($('subtitleStyleGrid'), 'subtitleStyle', (id) => {
    _subStyleId = id;
    renderSubPreview();
  });
  renderStyleGrid($('subPositionGrid'), SUBTITLE_POSITIONS, posActive, posCard);
  bindStyleGrid($('subPositionGrid'), 'subtitlePosition', (id) => {
    _subPosId = id;
    renderSubPreview();
    renderSubTextGrid();
  });
  renderSubPreview();

  // 界面文案
  applyTexts();
}

/**
 * 渲染对话模型来源下拉（第一百七十次）
 * 第一百七十四次：按 API 格式分三类，用 <optgroup> 分组（免费直连 / OpenAI / Anthropic），
 *   让"要不要账号"一眼可辨。选项文案跟随界面语言；未知/残留 id 由 getProvider 回退默认来源。
 * @param {string} id 当前选中的来源 id
 */
// 第二百一十六次：引擎 LLM 配置的 Provider 选择渲染（通用版，供 ASR/OCR 复用）
function renderEngineProviderSelect(sel, selected) {
  if (!sel) return;
  sel.innerHTML = '';
  LLM_FORMAT_GROUPS.forEach((g) => {
    const items = LLM_PROVIDERS.filter((p) => (p.format || 'openai') === g.format);
    if (!items.length) return;
    const og = document.createElement('optgroup');
    og.label = g.label[_lang] || g.label.en;
    items.forEach((pr) => {
      const opt = document.createElement('option');
      opt.value = pr.id;
      opt.textContent = pr.label[_lang] || pr.label.en;
      og.appendChild(opt);
    });
    sel.appendChild(og);
  });
  sel.value = selected || 'openai';
}

function renderLlmProviderSelect(id) {
  const sel = $('llmProvider');
  if (!sel) return;
  sel.innerHTML = '';
  LLM_FORMAT_GROUPS.forEach((g) => {
    const items = LLM_PROVIDERS.filter((p) => (p.format || 'openai') === g.format);
    if (!items.length) return;
    const og = document.createElement('optgroup');
    og.label = g.label[_lang] || g.label.en;
    items.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label[_lang] || p.label.en;
      og.appendChild(opt);
    });
    sel.appendChild(og);
  });
  sel.value = getProvider(id).id;
}

/**
 * 同步来源相关的提示信息：输入框 placeholder 显示该来源的预置地址/模型。
 * 第一百七十四次：'free' 类来源无需账号无需 Key，故整列隐藏 API Key 输入，
 *   避免用户以为还得先注册。
 * 第一百七十五次（用户："移除 Get a key 按钮"）：删去申请链接一列，不再从来源表读 keyUrl。
 * @param {string} id 来源 id
 */
function applyLlmProviderHints(id) {
  const p = getProvider(id);
  const base = $('llmBaseUrl');
  const model = $('llmModel');
  const isFree = (p.format || 'openai') === 'free';
  if (base) base.placeholder = p.baseUrl || 'https://your-endpoint/v1';
  if (model) model.placeholder = p.model || 'model-name';
  const keyField = $('llmApiKeyField');
  if (keyField) keyField.style.display = isFree ? 'none' : '';
}

// 第二百二十四次（用户："三种语言界面 目标 释义，不要写死、不要特指，默认全选"；并纠正 223 次
// 误把语言名 English/中文 当复选框标签）：复选框标签固定为角色名（界面/目标/释义，静态 HTML），
// 各自的勾选"值"由本函数按当前设定动态映射——界面语言/目标语言/释义语言 → Tesseract 语言代码
// （TESS_LANG_CODES），写入 checkbox.dataset.tess；storage 仍按代码存 ocrLanguages（后台直读同形）。
// 默认全选：storage 无 ocrLanguages 时三个角色全部勾上（无语言包的角色除外——勾了必失败，
// offscreen 的 langPath 仅指向本地 vendor，如实禁用并提示）。同一语言代码出现在多个角色时
// 天然联动（如界面=释义=中文：勾/去勾任一，两处同态）。
// 触发时机：renderAll、本页切换 目标/释义语言、跨标签页 storage 变化（onChanged → renderAll）。
function renderOcrLangRow(res) {
  const roles = [
    ['ocrLangUi', res.uiLanguage || 'zh'],
    ['ocrLangTarget', res.learnLanguage || 'en'],
    ['ocrLangMeaning', res.meaningLanguage || 'zh']
  ];
  const stored = res.ocrLanguages;   // undefined=新用户（默认全选）；有值则按已存代码尊重
  roles.forEach(([id, langCode]) => {
    const cb = $(id);
    if (!cb) return;
    const tess = TESS_LANG_CODES[langCode];
    cb.dataset.tess = tess || '';
    const hasPack = !!tess;   // 42 语全映射，仅表外语言兜底禁用
    cb.disabled = !hasPack;
    const lbl = cb.closest('label.chk');
    if (lbl) {
      lbl.classList.toggle('disabled', !hasPack);
      lbl.title = '';   // 42 语全放开后无"无包"场景（ocrLangNoPack 文案已删）
    }
    cb.checked = stored ? (!!tess && stored[tess] === true) : hasPack;
  });
}

// 第二百二十四次：从三个角色复选框收集勾选并集（按 tess 代码），供 change 监听写 ocrLanguages
function collectOcrLangs() {
  const obj = {};
  ['ocrLangUi', 'ocrLangTarget', 'ocrLangMeaning'].forEach((id) => {
    const cb = $(id);
    if (cb && cb.checked && cb.dataset.tess) obj[cb.dataset.tess] = true;
  });
  return obj;
}

// 第二百二十三次：OCR API 格式切换时更新地址/模型名 placeholder（镜像 applyLlmProviderHints 的交互；
// 预置值来自 llm.js 同一张 LLM_PROVIDERS 表：openai → api.openai.com/v1 + gpt-4o-mini，
// anthropic → api.anthropic.com + claude-3-5-haiku。用户手填值恒优先，留空回落预置）。
function applyOcrProviderHints(id) {
  const p = getProvider(id === 'anthropic' ? 'anthropic' : 'openai');
  const base = $('ocrLlmBaseUrl');
  const model = $('ocrLlmModel');
  if (base) base.placeholder = p.baseUrl || 'https://your-endpoint/v1';
  if (model) model.placeholder = p.model || 'model-name';
}

// 样式 id 清洗：不在对应样式列表内的（旧版已删除/写坏）回退 'none'，保证网格恒有选中卡
// 反思（2026-08-16 第六十八次）：解决"实际有样式，但设定栏一个都没选"——
//   storage 残留已删样式 id 时 renderStyleGrid 无匹配卡。textStyle 的特殊 'custom'
//   分支（用户在弹窗改过配色）不在本清洗范围（仍是有效显示态）。
function sanitizeStyleId(items, id) {
  if (id && Array.isArray(items) && items.some((it) => it.id === id)) return id;
  return 'none';
}

// 界面文案填充（data-key 通用 + 动态内容）
function applyTexts() {
  document.title = 'VocabRadar · Guide';
  document.documentElement.lang = _lang;
  fillByDataKey();
  renderHelp();
  // 反思（2026-08-16 第七十次）：头部显示构建版本——与视频页 overlay 启动日志的
  //   BUILD_STAMP 对照，可判定"改了默认样式/没选中"是不是旧构建残留。
  const verEl = $('guideVer');
  if (verEl) verEl.textContent = 'v' + BUILD_STAMP;
}

// === 初始化 ===

async function init() {
  await initLang().catch(() => {});
  loadSettings();

  // 三子标签切换
  document.querySelectorAll('.guide-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      document.querySelectorAll('.guide-tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.guide-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
      log('切换子标签:', name);
    });
  });

  // 可折叠分组（组头点击折叠/展开，点击开关不触发折叠）
  // 反思（2026-08-16 第六十六次）：样式栏"第一下点不开"的根因——
  //   guide.html 折叠组 .group-body 用内联 style="display:none;" 初始收起，
  //   但 group 上没有 'collapsed' 类，点击头时 setCollapsed(!classList.contains('collapsed'))
  //   认为初始未收起 → 第一下反而设为收起（视觉无变化），第二下才展开。
  //   修正：初始化时把 collapsed 类与箭头同步为内联 display 的实际状态。
  document.querySelectorAll('.group[data-collapsible]').forEach((group) => {
    const head = group.querySelector('.group-head');
    const body = group.querySelector('.group-body');
    const toggle = group.querySelector('.group-toggle');
    if (!head || !body) return;
    const setCollapsed = (collapsed) => {
      group.classList.toggle('collapsed', collapsed);
      body.style.display = collapsed ? 'none' : '';
      if (toggle) toggle.textContent = collapsed ? '▸' : '▾';
    };
    // 初始同步：以内联 display 为准（display:none ⇒ 已收起，加 collapsed 类）
    const startsCollapsed = body.style.display === 'none';
    if (startsCollapsed) setCollapsed(true);
    head.addEventListener('click', (e) => {
      if (e.target.closest('label, input, select, a, button')) return;
      setCollapsed(!group.classList.contains('collapsed'));
    });
    if (toggle) {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        setCollapsed(!group.classList.contains('collapsed'));
      });
    }
  });

  // 语言切换：写 storage + 重渲染
  $('uiLang').addEventListener('change', (e) => {
    const lang = e.target.value;
    setLang(lang);
    chrome.storage.local.set({ uiLanguage: lang }, () => {
      _lang = (lang === 'zh') ? 'zh' : 'en';
      chrome.storage.local.get(null, (res) => renderAll(res));
      log('界面语言已切换为', lang);
    });
  });

  // 源语言/目标语言/阈值/生词开关/ASR 模型
  $('learnLanguage').addEventListener('change', (e) => {
    chrome.storage.local.set({ learnLanguage: e.target.value }, () => {
      log('源语言=', e.target.value);
      // 第二百二十三次：OCR 本地语言候选随目标语言变 → 重渲该行（勾选态按已存 ocrLanguages）
      chrome.storage.local.get(null, (res) => renderOcrLangRow(res));
    });
  });
  $('meaningLanguage').addEventListener('change', (e) => {
    chrome.storage.local.set({ meaningLanguage: e.target.value }, () => {
      log('释义语言=', e.target.value);
      chrome.storage.local.get(null, (res) => renderOcrLangRow(res));
    });
  });
  $('rankThreshold').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    chrome.storage.local.set({ rankThreshold: isFinite(v) ? v : 5000 }, () => log('词频阈值=', v));
  });
  $('annotateOov').addEventListener('change', (e) => {
    chrome.storage.local.set({ annotateOov: e.target.checked }, () => log('注释表外词=', e.target.checked));
  });
  $('annotateRepeat').addEventListener('change', (e) => {
    chrome.storage.local.set({ annotateRepeat: e.target.checked }, () => log('注释重复生词=', e.target.checked));
  });
  $('hintSideAnnotation').addEventListener('change', (e) => {
    chrome.storage.local.set({ hintSideAnnotation: e.target.checked }, () => log('侧邻提示=', e.target.checked));
  });
  $('textHintEnabled').addEventListener('change', (e) => {
    chrome.storage.local.set({ textHintEnabled: e.target.checked }, () => log('网页生词提示=', e.target.checked));
  });
  $('webSidebarEnabled').addEventListener('change', (e) => {
    chrome.storage.local.set({ webSidebarEnabled: e.target.checked }, () => log('文本侧栏=', e.target.checked));
  });
  $('sidebarEnabled').addEventListener('change', (e) => {
    chrome.storage.local.set({ sidebarEnabled: e.target.checked }, () => log('视频侧栏=', e.target.checked));
  });
  $('overlayEnabled').addEventListener('change', (e) => {
    chrome.storage.local.set({ overlayEnabled: e.target.checked }, () => log('视频叠加字幕=', e.target.checked));
  });
  // 注释模式单选
  ['webSidebarAnnMode', 'videoSidebarAnnMode', 'videoOverlayAnnMode'].forEach((name) => {
    document.querySelectorAll(`input[name="${name}"]`).forEach((radio) => {
      radio.addEventListener('change', () => {
        if (radio.checked) {
          chrome.storage.local.set({ [name]: radio.value }, () => log(`${name}=`, radio.value));
          // 视频叠加字幕注释模式变化 → 双预览同步重渲染（侧邻/详细差异可见）
          if (name === 'videoOverlayAnnMode') renderSubPreview();
        }
      });
    });
  });
  // （第二百二十四次：Whisper 模型由下拉改单选，监听移至下方「引擎单选」区块统一处理）

  // 模型行（第一百七十次）：来源切换时清空自定义地址/模型，改用新来源的预置值
  //   （否则切到 Groq 却仍带着 OpenRouter 的模型名，请求必然 404，且用户看不出原因）
  $('llmProvider').addEventListener('change', (e) => {
    const id = e.target.value;
    chrome.storage.local.set({ llmProvider: id, llmBaseUrl: '', llmModel: '' }, () => {
      $('llmBaseUrl').value = '';
      $('llmModel').value = '';
      applyLlmProviderHints(id);
      log('对话模型来源=', id);
    });
  });
  // 地址/模型/Key/提示词：change（失焦或回车）时保存，与本页其他控件一致
  $('llmBaseUrl').addEventListener('change', (e) => {
    chrome.storage.local.set({ llmBaseUrl: e.target.value.trim() }, () => log('接口地址已保存'));
  });
  $('llmModel').addEventListener('change', (e) => {
    chrome.storage.local.set({ llmModel: e.target.value.trim() }, () => log('模型名=', e.target.value.trim()));
  });
  $('llmApiKey').addEventListener('change', (e) => {
    chrome.storage.local.set({ llmApiKey: e.target.value.trim() }, () => log('API Key 已保存（长度', e.target.value.trim().length, '）'));
  });
  // 第一百八十四次：默认提示词拆两套，各自独立保存；清空即回落到各自默认常量
  $('chatWordPrompt').addEventListener('change', (e) => {
    const v = e.target.value.trim() || CHAT_WORD_PROMPT;
    e.target.value = v;
    chrome.storage.local.set({ chatWordPrompt: v }, () => log('单词类查询提示词=', v));
  });
  $('chatSidebarPrompt').addEventListener('change', (e) => {
    const v = e.target.value.trim() || CHAT_SIDEBAR_PROMPT;
    e.target.value = v;
    chrome.storage.local.set({ chatSidebarPrompt: v }, () => log('侧栏提示词=', v));
  });
  // 第二百零七次：对话上下文上限（字节，下限 1000；非法输入回落默认 100000）
  $('chatContextMaxBytes').addEventListener('change', (e) => {
    let v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v) || v < 1000) v = 10000;
    e.target.value = v;
    chrome.storage.local.set({ chatContextMaxBytes: v }, () => log('对话上下文上限(字节)=', v));
  });
  // 第二百二十六次：引擎单选（每行=引擎+该引擎细项，两行常驻，无显隐联动）——变更只保存。
  // 第二百二十五次：radio value 定名 local/api（原 'llm'）。
  document.querySelectorAll('input[name="asrEngine"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      chrome.storage.local.set({ asrEngine: r.value }, () => log('ASR 引擎=', r.value));
    });
  });
  document.querySelectorAll('input[name="ocrEngine"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      chrome.storage.local.set({ ocrEngine: r.value }, () => log('OCR 引擎=', r.value));
    });
  });
  // Whisper 模型下拉（value 保持 tiny/base/…，与 offscreen SUPPORTED_MODELS 一致）
  $('asrModelSize').addEventListener('change', (e) => {
    chrome.storage.local.set({ asrModelSize: e.target.value }, () => log('ASR 模型=', e.target.value));
  });
  // OCR API 格式下拉（openai/anthropic，视觉识别两种后台均已实现）
  $('ocrLlmProvider').addEventListener('change', (e) => {
    const v = (e.target.value === 'anthropic') ? 'anthropic' : 'openai';
    chrome.storage.local.set({ ocrLlmProvider: v }, () => log('OCR API 格式=', v));
    applyOcrProviderHints(v);
  });
  // ASR API 细项（OpenAI 兼容转写）：地址/模型/Key 保存（此前 asrLlmModel 无保存监听——缺口补齐）
  $('asrLlmBaseUrl').addEventListener('change', (e) => {
    chrome.storage.local.set({ asrLlmBaseUrl: e.target.value.trim() }, () => log('转写接口地址已保存'));
  });
  $('asrLlmModel').addEventListener('change', (e) => {
    chrome.storage.local.set({ asrLlmModel: e.target.value.trim() }, () => log('转写模型=', e.target.value.trim()));
  });
  $('asrLlmApiKey').addEventListener('change', (e) => {
    chrome.storage.local.set({ asrLlmApiKey: e.target.value.trim() }, () => log('转写 API Key 已保存（长度', e.target.value.trim().length, '）'));
  });
  // OCR API 细项：地址/模型/Key 保存（格式单选监听在上方「引擎单选」区块）
  $('ocrLlmBaseUrl').addEventListener('change', (e) => {
    chrome.storage.local.set({ ocrLlmBaseUrl: e.target.value.trim() }, () => log('OCR 接口地址已保存'));
  });
  $('ocrLlmModel').addEventListener('change', (e) => {
    chrome.storage.local.set({ ocrLlmModel: e.target.value.trim() }, () => log('OCR 模型名=', e.target.value.trim()));
  });
  $('ocrLlmApiKey').addEventListener('change', (e) => {
    chrome.storage.local.set({ ocrLlmApiKey: e.target.value.trim() }, () => log('OCR API Key 已保存（长度', e.target.value.trim().length, '）'));
  });
  // OCR 本地语言复选（界面/目标/释义三角色，值=各自语言映射的 tess 代码，renderOcrLangRow 动态赋值）：
  // 任一变化即收集三框勾选并集，写 ocrLanguages（对象 by tess 代码，后台 handleOcrRecognize 直读）
  ['ocrLangUi', 'ocrLangTarget', 'ocrLangMeaning'].forEach((id) => {
    $(id).addEventListener('change', () => {
      const obj = collectOcrLangs();
      chrome.storage.local.set({ ocrLanguages: obj }, () => log('OCR 语言=', Object.keys(obj).join('+') || '(无)'));
    });
  });
  // 翻译渠道复选：补保存监听（第二百二十三次——此前勾选从不写 storage，设置形同虚设）。
  // 保存按 DOM 现状整表写入；「浏览器自身」在 Firefox 被禁用且未勾，写回 false 与实际一致。
  TRANS_CH_IDS.forEach(([id]) => {
    $(id).addEventListener('change', () => {
      const obj = {};
      TRANS_CH_IDS.forEach(([id2, k2]) => { obj[k2] = $(id2).checked; });
      chrome.storage.local.set({ translationChannels: obj }, () => log('翻译渠道=', JSON.stringify(obj)));
    });
  });
  // LLM 翻译渠道提示词：清空回落默认模板（仅保存；后台 handleLlmTranslate 消费接线属后续改造）
  $('llmTranslatePrompt').addEventListener('change', (e) => {
    const v = e.target.value.trim() || LLM_TRANSLATE_PROMPT;
    e.target.value = v;
    chrome.storage.local.set({ llmTranslatePrompt: v }, () => log('LLM 翻译提示词=', v));
  });
  // 第一百零二次：asrFirstChunkSec 监听器已随引导页控件移除（唯一来源 config.json）

  // 反思（2026-08-14 第五十六次修正）：底部按钮栏已整栏删除（用户要求"这一栏全删掉"）。
  // 反思（2026-08-21 第八十八次）：diagnose.js 已彻底删除（用户要求），诊断问题已解决。

  // 功能栏 ASR/OCR/Parser（拆分自 asr-ocr.js：公共初始化 → ASR → OCR；253 次 + Parser）
  initAsrCommon();
  initAsr();
  initOcr();
  initParser();
  window.addEventListener('pagehide', () => {
    disposeAsrCommon(); disposeAsr(); disposeOcr(); disposeParser();
  });

  // 其他标签页改了设置（如字幕样式）→ 本页监听同步
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.uiLanguage) {
      _lang = (changes.uiLanguage.newValue === 'zh') ? 'zh' : 'en';
      chrome.storage.local.get(null, (res) => renderAll(res));
    } else if (changes.subtitleStyle || changes.subtitlePosition) {
      // 反思（2026-08-16 第六十八次）：整栏重渲染（而非仅切 active 类）——
      //   其他标签页写入的若为已删样式 id，旧逻辑无卡可选中；重渲染走 stale-id 清洗回退。
      // 反思（2026-08-16 第六十九次）：位置样式（subtitlePosition）变化同样整栏重渲染。
      chrome.storage.local.get(null, (res) => renderAll(res));
    } else if (changes.textStyle || changes.annotationStyle || changes.videoAnnotationStyle) {
      chrome.storage.local.get(null, (res) => renderAll(res));
    } else if (changes.llmProvider || changes.llmBaseUrl || changes.llmModel
               || changes.llmApiKey || changes.chatWordPrompt || changes.chatSidebarPrompt || changes.asrModelSize
               || changes.asrEngine || changes.ocrEngine || changes.asrLlmModel || changes.asrLlmBaseUrl
               || changes.asrLlmApiKey || changes.ocrLlmProvider || changes.ocrLlmBaseUrl || changes.ocrLlmModel
               || changes.ocrLlmApiKey || changes.ocrLanguages || changes.translationChannels
               || changes.llmTranslatePrompt || changes.learnLanguage || changes.meaningLanguage) {
      // 第一百七十三次：补齐「模型」栏的跨标签页同步。第一百七十次新增 llm*/chatPrompt/
      //   asrModelSize 六个键时漏了本监听器 —— 在另一标签页改了模型配置，本页输入框
      //   仍显示旧值，用户以为没保存又改一遍，两页互相覆盖。
      // 第二百二十三次：引擎/翻译渠道/LLM 翻译提示词/ASR·OCR API 细项/OCR 语言/目标·释义语言
      //   新键并入（语言两键变化会联动 OCR 语言候选重渲）。
      chrome.storage.local.get(null, (res) => renderAll(res));
    }
  });
}

init();
