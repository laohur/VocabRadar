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
//     - 272次：Word Annotation 单组（280 次重排）——左列三功能卡（网页提示/文本侧栏/视频侧栏开关），
//       右列共享样式候选池 POOL_STYLES；每张池卡带 Web/Text/Video 三个指派钮（多对多）：
//       Web → 写 storage.textStyle + hintFirstBg/hintFirstFg（注释色自动派生），
//       Text → storage.annotationStyle，Video → storage.videoAnnotationStyle（280 次复活）
//     - annTemplate 注释模板（280 次：annBrackets 退役；284次默认 {target} {annotation}，旧 {word}/{meaning} 兼容）
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
// 第二百八十一次（用户反馈）：①共享池交互重做——左列四栏上下平铺可点选（Web Hints/文本侧栏/
//   视频侧栏/新增第四栏 Subtitle hints on video），点栏选中（.selected 高亮+池顶说明切换），
//   点池卡=指派给选中栏并把卡样例 cloneNode 复制进栏内（用户："选中之后，直接把卡片复制过去"）；
//   池卡三指派钮（Web/Text/Video chip）删除；网格一次建卡不重建，指派/切栏只改类名。
//   ②字幕组重做——正文样式网格改 none+10 内置+个性化卡共 12 卡 5 列；个性化=底色/字色/字号/
//   字体四控件（storage.subtitleCustom，改任一切 'custom'）；位置改单选行（radio）；
//   预览改单窗 16:9（容器水平居中，字幕按位置 ratio 渲染）；注释行样式由第四栏
//   storage.videoOverlayAnnStyle 控制；正文/位置/注释任一变化立即刷新预览。
// 第二百八十二次（用户反馈）：①字幕正文样式组增强——Custom 增加特效下拉（无/阴影/
//   发光/描边/立体，共享层 SUB_FX_OPTIONS）、字体下拉扩到 12 项（SUB_FONT_OPTIONS），
//   行尾大加号把当前参数存为新正文样式（storage.subtitleUserStyles，样卡右上角可删除，
//   overlay 端动态生成 style-user-* 规则）；样式卡样例一律只渲染正文。
//   ②预览重做——横屏 16:9 / 竖屏 9:16 切换（本地态不写 storage）；视频按 1080p 真实
//   像素虚拟舞台渲染再整体 scale(0.25)（横 480×270 / 竖 270×480），字体显示比例与
//   真实 1080p 视频一致；正文/位置/注释样式任一变化都触发立即预览。
// 第二百八十八次（Video Overlay Subtitles 改造执行）：①点击样例卡回填个性化行
//   （backfillSubCustomFrom，选中态不变；custom 卡跳过）；②预览改首尾两词注释
//   （subPreviewHtml：He/他 + quiz/测验，side 行内/detail 独立两行）；内置 10 按流行度
//   保持 283 排序不动（B站≈yt-box/Default）；位置单选与横竖屏预览保持；存储键零新增。
// 第二百八十九次（CSS 代码行）：个性化行下加左代码框 + 右大加号（加号由原行搬入，
//   同 id 绑定不变）；代码框与五控件双向同步（subCustomCssText 生成/parseSubCustomCssText
//   解析/applySubCustomControls 统一应用），同源渲染，作用于预览；改名/删除/点击复制既有。
// 第二百九十次（样例文字 + 右侧卡去闪 + 卡片保真）：Subtitle Text Style 网格后加样例
//   输入框（storage.subtitleSample，默认 VocabRadar is short for vocabulary 词汇
//   radar(雷达).），驱动样式卡与预览；预览注释改通用解析（parseSamplePairs：括号式 +
//   空格式，side 行内/detail 独立多行）；个性化卡搬出网格至代码右侧独立卡，原地刷新，
//   控件/CSS 改动不再全网格重建（去闪），点击选中 custom；样例卡真实尺寸 scale=1.0。
// 第二百九十一次（六项反馈）：①卡片越界修复（flow 分支改块级 + flex 子项 min-width:0）；
//   ②代码框 rows 4→6/min-height 120px/字号 13px；③样例改 input 事件实时重绘（持久化防抖）；
//   ④默认样例改纯英文句，注释走动态链路（getAnnotations：释义语言/词频阈值实时）；
//   ⑤Position 后加 side/detail 单选（videoOverlayAnnMode，与视频侧栏同键）；
//   ⑥右侧卡改常驻单 span 原地改样式（demo 不重建，彻底去闪）。
// 第二百九十二次（三项反馈）：①卡片换行全显（wrap=true 块级，height:auto，无溢出无省略号）；
//   ②注释截短（pickCleanShortTrans＋24 字 cap，side 行内 0.85em，detail 独立行同口径）；
//   ③storage 回声抑制（markOwnWrite＋分支 1200ms 跳过，去"中间态"闪）。
// 第二百九十三次（字号百分比，297-298次修订为视频高基线＋默认 5%＋无 clamp）：
//   overlay 全样式走 --beaver-sub-fs 实时变量；guide 卡片 540/预览 1080 同口径换算；
//   旧值三处一次性迁移（custom/用户条目/config）；短释义分隔符拓宽（radar 例）。
// 第二百九十四次：网格改 2 列（卡片换行全显不变，窄屏 1 列）；custom 默认改 7%。
// 第二百九十五次：①一排横向滚动卡片（296次作废回滚）；②custom 默认 7%→6%（296次改回 7%）；
//   ③参数名统一 fontSizePct（三级回退收过渡值）。
// 第二百九十六次：①网格回 2 列换行全显（一排方案作废）；②缺省一直默认 7%
//   （none 同改 7%，之前 6% 是误改，即改回；认错）。
// 第二百九十七次：基线改视频短边＋默认 5%＋删 clamp（失真）。
// 第二百九十八次（用户笔误纠正）：基线改回统一视频高（短边方案作废）；底色问题见汇报（代码未动）。
// 第三百零一次（注释 Sample＋Custom，仿字幕结构；其他不动）：样例行（annotationSample，
//   默认 vocab radar，只注释末词，动态链路同字幕）＋个性化行（七控件＋双区段 CSS 代码＋
//   右侧卡＋大＋号，用户卡改名/删除/点击回填）＋统一解析器与四消费点接线；另修潜伏 bug：
//   buildAnnPoolCss 52 条同选择器致末条通吃，补 beaver-ann-style-{id} 限定（只会让选择生效）。
// 第二百九十三次（字号百分比，297-298次修订为视频高基线＋默认 5%＋无 clamp）：
//   overlay 全样式走 --beaver-sub-fs 实时变量；guide 卡片 540/预览 1080 同口径换算；
//   旧值三处一次性迁移（custom/用户条目）；短释义分隔符拓宽（radar 例）。

import {
  initLang, setLang, t,
  LANG_NAMES, LANG_NAMES_EN, UI_LANGS, TRANSLATE_LANGS
} from '../lib/i18n.js';
import {
  POOL_STYLES, VANN_TO_ANN_MIGRATION, wordDecl, annDecl,
  DEFAULT_ANN_TEMPLATE, splitAnnTemplate,
  SUBTITLE_TEXT_STYLES, SUBTITLE_POSITIONS, findStyle, styleLabel, BUILD_STAMP,
  SUB_FONT_OPTIONS, SUB_FX_OPTIONS, subFontFamily, subFxDecl, buildUserStyleDecl,
  SUBTITLE_REF_H, pxToSizePct, sizePctToPx, subFontSizePct,
  resolveAnnEntry, annCustomCssText
} from '../lib/styles.js';
// 291次：预览动态注释（释义语言/词频跟随真实注解链路；guide-common 亦引此二模块，无新增依赖边）
import { getAnnotations } from '../lib/annotator.js';
import { ensureReady } from '../lib/dictionary.js';
// 注：pickCleanShortTrans 已于 291 次引入（预览动态注释），301 次池样例复用，不重复引。
// 292次：侧邻注释截短（与 guide-common 同源的短释义选取）
import { pickCleanShortTrans } from '../lib/dict-clean.js';
// 第二百五十三次：asr-common.js 名实不符改名 guide-common.js（import 同步）
import { initAsrCommon, disposeAsrCommon } from './guide-common.js';
import { initAsr, disposeAsr } from './asr.js';
import { initOcr, disposeOcr } from './ocr.js';
// 第二百五十三次：Parser 文档解析界面（本阶段界面，解析逻辑待接线）
import { initParser, disposeParser } from './parser.js';
// 第二百七十次：Deactivate 停用栏（逐条规则行渲染/编辑/深链，见该文件头注释）
import { initDeactivate, disposeDeactivate } from './deactivate.js';
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
  annTemplateHint: { en: '{target} {annotation} are variables', zh: '{target} {annotation} 为变量' },
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
  annCustomCssPh: { en: 'CSS code of the custom annotation style — view and edit', zh: '个性化注释样式的 CSS 代码——可查看编辑' },
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

// 使用说明（说明栏），分节渲染
const HELP = [
  {
    title: { en: 'Web Hints', zh: '网页提示' },
    items: [
      { en: 'After enabling, hover over a word to see its meaning, and click to hear pronunciation.', zh: '开启后，网页上悬停生词即可查看释义，点击可发音。' },
      { en: 'Highlight style is set in Settings → Web Hints.', zh: '高亮样式在「设定栏 → 网页提示」中设置。' },
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
// 290次：样例句子（样式卡与预览共用；持久化 storage.subtitleSample）
// 291次：默认改纯英文句（注释不再硬编码，动态按释义语言/词频注释）；290版旧默认做一次性迁移
const DEFAULT_SUB_SAMPLE = 'VocabRadar is short for vocabulary radar.';
const LEGACY_SUB_SAMPLE_290 = 'VocabRadar is short for vocabulary 词汇 radar(雷达).';
let _subSample = DEFAULT_SUB_SAMPLE;
// 291次：预览动态注释缓存（word_lower → 释义；随样例/阈值/语言变化刷新）
//   预览同步读缓存即时渲染，fetch 回来后再刷一次（数据到达，非交互闪烁）。
let _previewAnns = new Map();
let _previewAnnsTimer = 0;
let _previewAnnsBusy = false;
function schedulePreviewAnns() {
  if (_previewAnnsTimer) clearTimeout(_previewAnnsTimer);
  _previewAnnsTimer = setTimeout(refreshPreviewAnns, 600);
}
async function refreshPreviewAnns() {
  _previewAnnsTimer = 0;
  if (_previewAnnsBusy) { schedulePreviewAnns(); return; }
  _previewAnnsBusy = true;
  const snap = _subSample;
  try {
    // 词频门控要有 rank 必须等词典就绪（否则全词走在线翻译，浪费且慢）
    try { await ensureReady(); } catch (_) { /* 降级：用缓存/空注释 */ }
    if (snap !== _subSample) return;
    const th = await new Promise((resolve) => {
      try { chrome.storage.local.get({ rankThreshold: 5000 }, (r) => resolve(r.rankThreshold)); }
      catch (_) { resolve(5000); }
    });
    const anns = await getAnnotations(snap, th, new Set(), null, false);
    if (snap !== _subSample) return;
    const map = new Map();
    for (const a of anns) {
      // 292次：取短释义（在线长译文进预览会撑破布局；空短串按无注释跳过）
      const t = pickCleanShortTrans(a.translations || []);
      if (t) map.set(String(a.word).toLowerCase(), t);
    }
    _previewAnns = map;
    renderSubPreview();
  } catch (e) {
    console.warn('[VocabRadar][guide] 预览注释获取失败，沿用旧缓存:', e && e.message);
  } finally {
    _previewAnnsBusy = false;
  }
}

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

// 280 次：_setRadio 辅助函数删除——注释布局 radio 全部移出引导页，页面已无任何 radio 组需回填

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

// 280 次：候选池当前选择缓存（四键指派状态 + 注释模板；renderAll 回填）。
//   281次：新增第四键 videoOverlayAnnStyle（视频中字幕的注释行样式）。
//   textStyle/annotationStyle/videoAnnotationStyle/videoOverlayAnnStyle 均指向 POOL_STYLES 的样式 id（'none'=默认配色）。
// 283次：注释模板分键——annTemplate 只归 textStyle 栏（text-hint.js 消费），其余三栏各用
//   独立键（webAnnTemplate=文本侧栏、videoAnnTemplate=视频侧栏、videoOverlayAnnTemplate=
//   叠加字幕注释行），"Annotation template 只会影响当前选中的注释栏目"。
const ANN_TPL_KEYS = {
  textStyle: 'annTemplate',
  annotationStyle: 'webAnnTemplate',
  videoAnnotationStyle: 'videoAnnTemplate',
  videoOverlayAnnStyle: 'videoOverlayAnnTemplate'
};
const _poolSel = {
  textStyle: 'none', annotationStyle: 'none', videoAnnotationStyle: 'none', videoOverlayAnnStyle: 'none',
  annTemplate: DEFAULT_ANN_TEMPLATE,
  webAnnTemplate: DEFAULT_ANN_TEMPLATE, videoAnnTemplate: DEFAULT_ANN_TEMPLATE, videoOverlayAnnTemplate: DEFAULT_ANN_TEMPLATE
};
// 281次：左列当前选中栏（点击 .pool-item 切换；池卡点击指派给该栏）
let _poolTarget = 'textStyle';
// 301次：注释个性化参数（Custom 行七控件）＋用户自建缓存
// 302次（用户"注释也应当没有背景色"）：预设改透明底绿字（青瓷深底作废；生词底色待用户定值，暂留）。
let _annCustom = { wordBg: '#e0f2f1', wordFg: '#004d40', annBg: 'transparent', annFg: '#004d40', radius: '4px', bold: true };
let _annUserStyles = [];
// 301次：装饰线形选项（none/underline/wavy/dashed/dotted；颜色取注释字色，见 buildAnnCustomObj）
const ANN_DECO_OPTIONS = [
  { id: 'none', en: 'None', zh: '无' },
  { id: 'underline', en: 'Underline', zh: '下划线' },
  { id: 'wavy', en: 'Wavy', zh: '波浪线' },
  { id: 'dashed', en: 'Dashed', zh: '虚线' },
  { id: 'dotted', en: 'Dotted', zh: '点线' }
];
// 301次：注释样例（池卡共用；默认 vocab radar，只注释末词 radar，注释走动态链路）
const DEFAULT_ANN_SAMPLE = 'vocab radar';
let _annSample = DEFAULT_ANN_SAMPLE;
let _annSampleTrans = new Map();
let _annSampleTimer = 0;
let _annSampleBusy = false;
// 281次：个性化字幕样式缓存（storage.subtitleCustom，renderAll 回填）。
//   282次：加 fx 特效字段（与 Custom 特效下拉/大加号保存的用户样式共用参数集）
// 283次：默认改为"能直接用"的样式（用户裁定：底色透明、字号不小、投影特效）——
//   透明底白字 + 阴影在任意视频上可读，不再默认黑条压画面。
let _subCustom = { bg: 'transparent', fg: '#ffffff', fontSizePct: 5, fontFamily: 'sans', fx: 'shadow' };
// 282次：用户自建正文样式缓存（storage.subtitleUserStyles，条目 {id,label,bg,fg,fontSizePct,fontFamily,fx}）
// 295次：custom 默认 7%→6%（用户"默认7%高"）；参数名统一 fontSizePct。
// 293次：字号改视频高百分比（旧 fontSize px 按 540 设计高换算，见 pxToSizePct）
let _userStyles = [];
// 282次：预览方向（'landscape'/'portrait'）——本地态不写 storage，仅影响预览窗形状
let _subPreviewOrient = 'landscape';
// 283次：预览 1080p 舞台缩放监听（ResizeObserver）——stage 宽随正文页宽变化时
//   重算 scale（模块级持有，renderSubPreview 重建 stage 后重挂；disconnect 防泄漏）
let _subPreviewRO = null;
// 280 次：视频叠加字幕注释布局缓存（radio 从引导页删除后，renderSubPreview 改读此缓存；
//   renderAll 时从 storage 赋值，非 'detail' 一律按 'side' 渲染预览）
let _overlayAnnMode = 'side';

// 281次：共享样式候选池网格（去 280 次的三指派钮）——每张池卡 = 样例（wordDecl/annDecl
//   生成器输出，与真实渲染同源）+ 名称；active 高亮按左列选中栏的当前指派（_poolSel[_poolTarget]）。
//   网格一次建卡不重建（用户要求"不重渲染"），指派/切栏只更新 active 类。
function renderPoolGrid() {
  const grid = $('poolStyleGrid');
  grid.innerHTML = '';
  const buildCard = (item) => {
    const card = document.createElement('div');
    card.className = 'style-card' + (_poolSel[_poolTarget] === item.id ? ' active' : '');
    card.dataset.style = item.id;
    card.appendChild(poolCardDemo(item));
    return card;
  };
  const buildLabel = (item, editable) => {
    if (!editable) {
      const label = document.createElement('div');
      label.className = 'card-label';
      label.textContent = styleLabel(item, _lang);
      return label;
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'card-label-input';
    input.value = styleLabel(item, _lang);
    input.title = m('subRenameStyle');
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (!v) { input.value = styleLabel(item, _lang); return; }
      const st = _annUserStyles.find((s) => s && s.id === item.id);
      if (!st) return;
      st.label = { en: v, zh: v };
      markOwnWrite();
      chrome.storage.local.set({ annotationUserStyles: _annUserStyles }, () => log('annUserStyle rename=', item.id));
    });
    return input;
  };
  for (const item of POOL_STYLES) {
    if (item.id === 'none') continue;
    const card = buildCard(item);
    card.appendChild(buildLabel(item, false));
    grid.appendChild(card);
  }
  // 301次：个性化卡（Custom 行参数的实时样例；点击选中 custom，与内置卡同逻辑）
  const customObj = buildAnnCustomObj();
  const ccard = buildCard(customObj);
  ccard.appendChild(buildLabel(customObj, false));
  grid.appendChild(ccard);
  // 301次：用户自建卡（改名 input＋删除钮；点击选中/回填走通用逻辑）
  for (const st of _annUserStyles) {
    const ucard = buildCard(st);
    const del = document.createElement('button');
    del.className = 'sub-card-del';
    del.type = 'button';
    del.textContent = '×';
    del.title = m('subDelStyle');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteAnnUserStyle(st.id);
    });
    ucard.appendChild(del);
    ucard.appendChild(buildLabel(st, true));
    grid.appendChild(ucard);
  }
}

// 281次：池顶文本说明（"最上是文本说明"）——随左栏选中项切换，说明该栏样式的用途。
//   282次：按用户"最上是文本说明 不重渲染"重排——本说明=用途+「指派即时生效不重渲染」
//   后缀，位于池卡网格上方（段1）；模板行上方另有一段「触发渲染」说明（段2，静态键）。
//   说明行不重建 DOM，只换文字。
// 283次：段2（poolNoteRerender）改动态——模板已分键只作用于当前选中栏，说明拼当前栏名
//   （"注释模板（网页提示）——修改会触发重渲染该栏候选样例。"）。调用时机：
//   ①renderAll 池段（候选列建卡完成后）②applyTexts 的 fillByDataKey 之后
//   （语言切换会用 data-key 静态文案覆盖此行，必须重跑动态拼接还原栏名）。
function renderPoolNote() {
  const note = $('poolNoteNoRerender');
  if (!note) return;
  const KEY = {
    textStyle: 'poolNoteTextStyle',
    annotationStyle: 'poolNoteAnnotationStyle',
    videoAnnotationStyle: 'poolNoteVideoAnnotationStyle',
    videoOverlayAnnStyle: 'poolNoteVideoOverlayAnnStyle'
  };
  note.textContent = m(KEY[_poolTarget] || KEY.textStyle) + ' ' + m('poolNoteNoRerenderSuffix');
  const rerender = $('poolNoteRerender');
  if (rerender) {
    const ITEM = {
      textStyle: 'poolItemWebHint',
      annotationStyle: 'poolItemWebSidebar',
      videoAnnotationStyle: 'poolItemSidebar',
      videoOverlayAnnStyle: 'poolItemSubAnn'
    };
    // 中文直连括号内栏名（无空格），英文以空格分词
    const sep = (_lang === 'zh') ? '' : ' ';
    rerender.textContent = m('annTplScopePrefix') + sep + m(ITEM[_poolTarget] || ITEM.textStyle) + sep + m('annTplScopeSuffix');
  }
}

// 281次：左栏内联复制卡（用户裁定"选中之后，直接把卡片复制过去"）——把池卡（样例+名称）
//   原样复制进左栏选中项的 .pool-item-demo（未指派/回落 none 时清空显示占位）。
//   复制实现：从池网格中找同 id 卡，cloneNode 其 demo 与 label（"直接把卡片复制过去"）。
function renderPoolSideDemos() {
  const grid = $('poolStyleGrid');
  document.querySelectorAll('.pool-left .pool-item').forEach((item) => {
    const box = item.querySelector('.pool-item-demo');
    if (!box) return;
    box.innerHTML = '';
    const id = _poolSel[item.dataset.target];
    if (!id || id === 'none') return;
    const src = grid ? grid.querySelector('.style-card[data-style="' + id + '"]') : null;
    if (!src) return;
    box.appendChild(src.querySelector('.demo').cloneNode(true));
    const lab = document.createElement('div');
    lab.className = 'pool-inline-label';
    lab.textContent = src.querySelector('.card-label').textContent;
    box.appendChild(lab);
  });
}

// 281次：左栏选中态——点击 .pool-item 切换 _poolTarget（高亮 + 池说明 + 池卡 active 跟随）。
//   项内开关/复选的点击同时会选中该栏（操作哪个栏哪个栏高亮，符合直觉且无副作用）。
function bindPoolLeft() {
  const left = document.querySelector('.pool-left');
  if (!left || left.dataset.bound) return;
  left.dataset.bound = '1';
  left.addEventListener('click', (e) => {
    const item = e.target.closest('.pool-item');
    if (!item || !item.dataset.target) return;
    // 299次：Query 卡无样式指派，不参与选中（豁免；开关照常用）
    if (item.dataset.target === 'query') return;
    if (_poolTarget === item.dataset.target) return;
    _poolTarget = item.dataset.target;
    document.querySelectorAll('.pool-left .pool-item').forEach((it) => {
      it.classList.toggle('selected', it.dataset.target === _poolTarget);
    });
    renderPoolNote();
    // 283次：切栏回填模板输入框——模板分键后每栏独立，输入框始终显示当前选中栏的模板
    const tplInput = $('annTemplate');
    if (tplInput) tplInput.value = _poolSel[ANN_TPL_KEYS[_poolTarget]] || DEFAULT_ANN_TEMPLATE;
    // 池卡 active 跟随新选中栏的当前指派（不重建网格）
    const grid = $('poolStyleGrid');
    grid.querySelectorAll('.style-card').forEach((c) => {
      c.classList.toggle('active', c.dataset.style === _poolSel[_poolTarget]);
    });
  });
}

// 281次：池卡样例——wordDecl/annDecl 生成器输出作 cssText（与真实渲染同源，覆盖渐变/描边/
//   空心/着重号/SVG 波浪等全部新字段）；注释文本按 annTemplate 拆出 {meaning} 前后字面量。
// 301次：样例改用户输入句（_annSample，默认 vocab radar）——前文原样，末拉丁词为注释词，
//   释义取动态缓存（字幕同款链路），无缓存暂不渲染注释行（fetch 回来重绘补上）。
function annSampleModel() {
  const text = _annSample || DEFAULT_ANN_SAMPLE;
  const words = [];
  const re = /[A-Za-z]+/g;
  let m;
  while ((m = re.exec(text))) words.push({ word: m[0], index: m.index, end: m.index + m[0].length });
  const last = words.length ? words[words.length - 1] : null;
  const { pre, post } = splitAnnTemplate(_poolSel[ANN_TPL_KEYS[_poolTarget]] || DEFAULT_ANN_TEMPLATE);
  const trans = (last && _annSampleTrans.get(last.word.toLowerCase())) || '';
  return { text, last, pre, post, trans };
}
function poolCardDemo(item) {
  const demo = document.createElement('div');
  demo.className = 'demo';
  const model = annSampleModel();
  const lead = model.last ? model.text.slice(0, model.last.index) : model.text;
  if (lead) {
    const l = document.createElement('span');
    l.textContent = lead;
    demo.appendChild(l);
  }
  if (model.last) {
    const w = document.createElement('span');
    w.className = 'word-demo';
    w.textContent = model.last.word;
    w.style.cssText = wordDecl(item).join(';');
    demo.appendChild(w);
    if (model.trans) {
      const a = document.createElement('span');
      a.className = 'ann-demo';
      a.textContent = model.pre + model.trans + model.post;
      a.style.cssText = annDecl(item).join(';');
      demo.appendChild(a);
    }
    const tail = model.text.slice(model.last.end);
    if (tail) {
      const t = document.createElement('span');
      t.textContent = tail;
      demo.appendChild(t);
    }
  }
  return demo;
}

// 301次：样例末词动态注释（字幕 schedulePreviewAnns 同款：防抖＋忙互斥＋过期丢弃＋失败沿用缓存）。
//   阈值传 0（展示位恒注释，不做词频过滤；释义语言走 translator 当前目标语言）。
function scheduleAnnSample() {
  if (_annSampleTimer) clearTimeout(_annSampleTimer);
  _annSampleTimer = setTimeout(refreshAnnSample, 600);
}
async function refreshAnnSample() {
  _annSampleTimer = 0;
  if (_annSampleBusy) { scheduleAnnSample(); return; }
  _annSampleBusy = true;
  const text = _annSample || DEFAULT_ANN_SAMPLE;
  const words = [];
  const re = /[A-Za-z]+/g;
  let m;
  while ((m = re.exec(text))) words.push(m[0]);
  const last = words.length ? words[words.length - 1] : '';
  try {
    try { await ensureReady(); } catch (_) { /* 降级：用缓存/空注释 */ }
    if (text !== (_annSample || DEFAULT_ANN_SAMPLE)) return;
    const anns = await getAnnotations(last, 0, new Set(), null, false);
    if (text !== (_annSample || DEFAULT_ANN_SAMPLE)) return;
    const hit = (anns || []).find((a) => a && String(a.word).toLowerCase() === last.toLowerCase());
    const t = hit ? pickCleanShortTrans(hit.translations || []) : '';
    const map = new Map(_annSampleTrans);
    if (t) map.set(last.toLowerCase(), t);
    else map.delete(last.toLowerCase());
    _annSampleTrans = map;
    renderPoolGrid();
    renderPoolSideDemos();
    updateAnnCustomSideCard();
  } catch (e) {
    console.warn('[VocabRadar][guide] 池样例注释获取失败，沿用旧缓存:', e && e.message);
  } finally {
    _annSampleBusy = false;
  }
}

// 281次：池卡点击指派——点池卡=指派给左栏选中栏（再点同卡取消，回落 'none'）。
//   Web（textStyle）联动写 hintFirstBg/hintFirstFg（池条目 wordBg/wordFg 或默认绿白配色）。
//   更新策略（用户要求"不重渲染"）：只切该卡 active 类 + 刷新左栏复制卡，不重建网格。
function bindPoolGrid() {
  const grid = $('poolStyleGrid');
  if (grid.dataset.bound) return;   // renderAll 可多次触发，防重复绑定（同 bindStyleGrid 口径）
  grid.dataset.bound = '1';
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.style-card');
    if (!card) return;
    const feat = _poolTarget;
    const next = (_poolSel[feat] === card.dataset.style) ? 'none' : card.dataset.style;
    _poolSel[feat] = next;
    // 301次：指派写 storage 即打回声戳——本页已即时切类，跳过回声全量重建（281"不重渲染"本意）。
    markOwnWrite();
    if (feat === 'textStyle') {
      // 301次：联动解析改统一入口（custom/用户条目亦可派生前后景）
      const st = next === 'none' ? null : resolveAnnEntry(next, buildAnnCustomObj(), _annUserStyles);
      chrome.storage.local.set({
        textStyle: next,
        hintFirstBg: (st && st.wordBg) || '#2e6b43',
        hintFirstFg: (st && st.wordFg) || '#ffffff'
      }, () => log('textStyle=', next));
    } else {
      chrome.storage.local.set({ [feat]: next }, () => log(feat + '=', next));
    }
    // 301次：点用户卡回填个性化行（仿字幕；custom 卡即当前控件参数，无需回填）
    if (next !== 'none' && next !== 'ann-custom') {
      const us = _annUserStyles.find((s) => s && s.id === next);
      if (us) backfillAnnCustomFrom(us);
    }
    grid.querySelectorAll('.style-card').forEach((c) => {
      c.classList.toggle('active', c.dataset.style === _poolSel[feat]);
    });
    renderPoolSideDemos();
  });
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

// 280 次：textCard/annCard 两卡渲染器随旧双网格退役——池卡统一由 poolCardDemo（wordDecl/annDecl
//   生成器输出）渲染，三种指派关系共用同一张样例卡。

// 字幕样式卡：迷你 16:9 视频区 + 按文字样式（在当前位置 ratio 上）渲染的 word(释义) 字幕
const GUIDE_FONTS = {
  sans: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  serif: '"Georgia", "Times New Roman", "SimSun", serif',
  mono: '"Consolas", "Courier New", monospace'
};

// 字幕盒样式（文字样式卡/预览共用）：文字属性 + 背景 + 内边距，不含定位与换行
// 反思（2026-08-19 第八十次）：拆出独立函数——详细模式预览的注释块需与字幕行盒分离
//   （注释独立块不带盒背景，见 subSampleHtml），盒样式与 buildSubMiniCss 保持一致。
// 293次：字号改百分比（refH=换算用视频高：卡片 540 设计高/预览 1080 真实像素），
//   与 overlay 真实渲染同口径（297次：无 clamp，纯比例；298次短边作废改回视频高）。
function buildSubBoxCss(item, s, refH) {
  const parts = [];
  parts.push('color:' + (item.fg || '#ffffff'));
  parts.push('font-size:' + sizePctToPx(subFontSizePct(item), refH) + 'px');
  // 282次：用户样式字体 id（arial/impact 等）不在 GUIDE_FONTS 时回落共享层 SUB_FONTS
  parts.push('font-family:' + (GUIDE_FONTS[item.font] || subFontFamily(item.font)));
  if (item.id === 'none') {
    parts.push('background:rgba(0,0,0,0.75)');
  } else if (item.bg) {
    parts.push('background:' + item.bg);
  }
  // 281次：weight 字段优先（特粗 800，如 edge-white-bold），否则 bold→600（与 overlay 渲染一致）
  if (item.weight) parts.push('font-weight:' + item.weight);
  else if (item.bold) parts.push('font-weight:600');
  if (item.italic) parts.push('font-style:italic');
  if (item.shadow) parts.push('text-shadow:' + (typeof item.shadow === 'string' ? item.shadow : '0 0 4px rgba(0,0,0,.9)'));
  if (item.edge) parts.push('-webkit-text-stroke:1px ' + item.edge);
  // 282次：fx 特效（custom/用户样式卡）——组合样式在预览与样卡中一并体现
  const fxd = subFxDecl(item.fx);
  if (fxd) parts.push(fxd);
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
function buildSubMiniCss(item, ratio, scale, wrap, flow, refH) {
  const s = (typeof scale === 'number' && scale > 0) ? scale : 1;
  const parts = [];
  if (flow) {
    // 旧省略号分支（292次退役）：行内 span 吃不下 max-width，长样例溢出；292改换行后
    //   样例卡不再走 flow（wrap=true），本分支保留防外部调用回归。
    parts.push('display:block;width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis');
  } else if (wrap) {
    // 292次：卡片换行全显——块级 + 自动换行不断溢出；高度由调用方 height:auto 承接。
    parts.push('display:block;width:100%;white-space:normal;word-break:break-word;line-height:1.35');
  } else {
    // 292次：预览绝对定位单行（wrap 的换行分支已上移，此处 wrap 恒 false，死三元清理）
    parts.push('position:absolute;left:50%;bottom:' + (ratio * 100) + '%;transform:translate(-50%, 50%)');
    parts.push('white-space:nowrap;max-width:94%;overflow:hidden;text-overflow:ellipsis');
  }
  parts.push(buildSubBoxCss(item, s, refH));
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

// 281次：新增 annStyle 参数——字幕注释行样式改由第四栏池条目（Subtitle hints on video）
//   控制（annDecl 输出与真实 overlay 渲染同源）；缺省/'none' 时沿用旧配色逻辑。
function subSampleHtml(item, ratio, annMode, scale, wrap, flow, plain, annStyle) {
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
  // 281次：注释样式由第四栏池条目控制（annDecl 生成器输出 cssText）；未指派（缺省/'none'）
  //   时沿用旧逻辑：有底色样式（含默认深条）注释用白字，透明底直显样式前景色。
  const annCss = (annStyle && annStyle.id !== 'none') ? annDecl(annStyle).join(';') : '';
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
    // 281次：注释行样式由第四栏池条目控制（annCss=annDecl 输出）；annDecl 不含字体/字重，
    //   字体在块级给 sans 基准、词头保持 font-weight:600（与真实 overlay 注释行一致）。
    const annWordCss = annCss || ('color:' + annFg + ';font-weight:600');
    const annTransCss = annCss || ('color:' + annFg);
    // 293次：注释块字号改百分比口径（旧 item.size px 已退役；本分支现仅样例卡 plain 路径外休眠）
    const annBlock = '<div style="margin-top:4px;line-height:1.3;text-align:left;white-space:' + (wrap ? 'normal' : 'nowrap') + ';font-size:' + Math.round(sizePctToPx(subFontSizePct(item), SUBTITLE_REF_H) * s * 0.9) + 'px;font-family:' + GUIDE_FONTS.sans + '">'
      + '<span style="' + annWordCss + '">' + escapeHtml(word) + '</span> '
      + '<span style="' + annTransCss + '">' + escapeHtml(trans) + '</span></div>';
    if (flow) return subBox + annBlock;
    // 预览：外容器绝对定位居中（盒子中心落在 ratio 中心线），字幕行盒 + 注释块竖排
    return '<span style="position:absolute;left:50%;bottom:' + (ratio * 100) + '%;transform:translate(-50%, 50%);display:flex;flex-direction:column;align-items:center;max-width:94%">'
      + subBox + annBlock + '</span>';
  }
  // 侧邻注释模式（或样式卡 plain）：字幕行内生词高亮 + 注释行内。
  //   281次：注释文本按 annTemplate 模板拆出 {meaning} 前后字面量（不再硬编码圆括号），
  //   样式同样由第四栏池条目（annCss）控制。
  //   plain 卡不显示行内释义——样式卡只展示文字样式，注释布局由下方预览负责。
  //   283次：模板分键——字幕注释行读 videoOverlayAnnTemplate（本函数非 plain 调用
  //   只来自 renderSubPreview；plain 样卡不走此分支）。
  const tplParts = splitAnnTemplate(_poolSel.videoOverlayAnnTemplate || DEFAULT_ANN_TEMPLATE);
  const annSpanCss = annCss || ('color:' + annFg);
  const inner = beforeHtml + wordHtml
    + (!plain && trans ? '<span style="' + annSpanCss + '">' + tplParts.pre + escapeHtml(trans) + tplParts.post + '</span>' : '')
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
  // 反思（2026-08-20 第八十五次）：样卡字号过小——旧 scale=0.45 是残留。
  // 290次（用户"样例字号小，定义要准确"）：改真实尺寸 scale=1.0——卡片即定义本身，
  //   样例句子取用户输入（_subSample），卡片恒纯文字无注释。
  // 292次换行全显（wrap=true 块级，height:auto 承接）→294次 2 列确认→296次一排方案作废回滚至此。
  const it = Object.assign({}, item, { sample: _subSample });
  mini.innerHTML = subSampleHtml(it, 0, undefined, 1, true, false, true);
  demo.appendChild(mini);
  return demo;
}

// 281次：位置样式卡随独立位置网格一并删除（位置改单选行，预览窗内直接体现位置）。

// 281次：个性化样式合成对象——subtitleCustom 参数 → 字幕样式结构（id 'custom'），
//   供样式卡与预览渲染共用（与内置条目同构：font/fg/bg/size 均来自 storage.subtitleCustom）。
//   282次：加 fx 特效字段；样例去 '(测验)' 注释（正文样式卡只渲染正文）。
function buildCustomStyleObj() {
  return {
    id: 'custom',
    label: { en: 'Custom', zh: '个性化' },
    font: _subCustom.fontFamily,
    fg: _subCustom.fg,
    bg: _subCustom.bg,
    fontSizePct: _subCustom.fontSizePct,
    fx: _subCustom.fx,
    edge: null, bold: false, italic: false, shadow: false, annMode: 'side',
    sample: 'He passed the quiz.'
  };
}

// 282次：用户样式条目 → 渲染对象（与内置条目同构，样式卡/预览共用）。
// 293次：字号改百分比（旧 fontSize px 经 pxToSizePct 换算；缺省 5 即 custom 默认）。
function userStyleObj(st) {
  return {
    id: st.id,
    label: st.label || { en: 'User style', zh: '自建样式' },
    font: st.fontFamily || 'sans',
    fg: st.fg || '#ffffff',
    bg: st.bg || null,
    // 295次三级回退：fontSizePct → 过渡 sizePct → 旧 fontSize px 换算
    fontSizePct: (typeof st.fontSizePct === 'number' && isFinite(st.fontSizePct))
      ? Math.min(12, Math.max(2, st.fontSizePct))
      : ((typeof st.sizePct === 'number' && isFinite(st.sizePct))
        ? Math.min(12, Math.max(2, st.sizePct)) : pxToSizePct(st.fontSize)),
    fx: st.fx || 'none',
    edge: null, bold: false, italic: false, shadow: false, annMode: 'side',
    sample: 'He passed the quiz.'
  };
}

// 文字样式网格重渲染：none + 10 内置（renderStyleGrid）+ 用户自建样式卡
//   （282次，右上角删除钮）。active 高亮按 _subStyleId。
//   290次：个性化卡搬出网格（代码右侧独立卡 #subCustomSideCard，原地刷新不闪）。
function renderSubTextGrid() {
  const grid = $('subtitleStyleGrid');
  renderStyleGrid(grid, SUBTITLE_TEXT_STYLES, _subStyleId, subCard);
  // 282次：用户自建正文样式卡（storage.subtitleUserStyles；点击选中=bindStyleGrid 通用逻辑，
  //   删除钮 stopPropagation 不触发选中）
  for (const st of _userStyles) {
    const obj = userStyleObj(st);
    const ucard = document.createElement('div');
    ucard.className = 'style-card' + (_subStyleId === st.id ? ' active' : '');
    ucard.dataset.id = st.id;
    ucard.dataset.style = st.id;
    ucard.appendChild(subCard(obj));
    const del = document.createElement('button');
    del.className = 'sub-card-del';
    del.type = 'button';
    del.textContent = '×';
    del.title = m('subDelStyle');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteUserStyle(st.id);
    });
    ucard.appendChild(del);
    // 283次：名称可编辑——label div 改 input（点击/键盘 stopPropagation 防 bindStyleGrid
    //   容器委托把输入动作当选卡）；change 写回 st.label（en/zh 同值）并 storage 持久化，
    //   不重渲染网格（保输入焦点；预览与左栏不显示用户卡名称）
    const ulabel = document.createElement('input');
    ulabel.type = 'text';
    ulabel.className = 'card-label-input';
    ulabel.value = styleLabel(obj, _lang);
    ulabel.title = m('subRenameStyle');
    ulabel.addEventListener('click', (e) => e.stopPropagation());
    ulabel.addEventListener('keydown', (e) => e.stopPropagation());
    ulabel.addEventListener('change', () => {
      const v = ulabel.value.trim();
      if (!v) { ulabel.value = styleLabel(obj, _lang); return; }
      st.label = { en: v, zh: v };
      markOwnWrite();
      chrome.storage.local.set({ subtitleUserStyles: _userStyles }, () => log('userStyle rename=', st.id));
    });
    ucard.appendChild(ulabel);
    grid.appendChild(ucard);
  }
}

// 290次：样例句注释对解析——括号式 word(trans) 全局提取；掩盖括号段后，空格式
//   word + CJK 注释（如 vocabulary 词汇）按前词归属提取；按出现顺序排序。
//   无注释对时返回空数组（调用方原样输出整句，不虚构注释，与 subSampleHtml 同纪律）。
function parseSamplePairs(text) {
  const pairs = [];
  const src = String(text || '');
  const masked = src.replace(/([A-Za-z]+)\(([^)]*)\)/g, (m0, w, t, off) => {
    pairs.push({ word: w, trans: t, index: off, end: off + m0.length });
    return ' '.repeat(m0.length);
  });
  const re2 = /([A-Za-z]+) ([\u3400-\u4DBF\u4E00-\u9FFF]+)/g;
  let m2;
  while ((m2 = re2.exec(masked))) {
    const raw = src.substr(m2.index, m2[0].length);
    const sp = raw.indexOf(' ');
    pairs.push({ word: raw.slice(0, sp), trans: raw.slice(sp + 1), index: m2.index, end: m2.index + m2[0].length });
  }
  pairs.sort((a, b) => a.index - b.index);
  return pairs;
}

// 288次：预览专用（注释落样例句中各注释词）；290次改通用解析——默认样例
//   'VocabRadar is short for vocabulary 词汇 radar(雷达).' 注释 vocabulary/词汇 与
//   radar/雷达；side 行内、detail 独立多行。样例卡（subCard/plain）仍纯文字无注释。
function subPreviewHtml(style, ratio, annMode, annStyle) {
  const tplParts = splitAnnTemplate(_poolSel.videoOverlayAnnTemplate || DEFAULT_ANN_TEMPLATE);
  const annCss = (annStyle && annStyle.id !== 'none') ? annDecl(annStyle).join(';') : '';
  const annFg = style.bg ? '#ffffff' : (style.fg || '#ffffff');
  const wordCss = 'background:#2e6b43;color:#ffffff;border-radius:2px;padding:0 3px;font-weight:600';
  // 292次（用户"侧邻模式没有截短释义"）：注释文本截短（超 24 字切…，detail 独立行同口径）；
  //   side 行内注释字号取 0.85em（32px 级字幕下全尺寸注释过大，overlay 注释行基准 0.9em 同理）。
  const shortTrans = (t) => {
    const s = String(t || '');
    return s.length > 24 ? s.slice(0, 24) + '…' : s;
  };
  const annSpan = (t) => '<span style="' + (annCss || ('color:' + annFg)) + ';font-size:0.85em">'
    + tplParts.pre + escapeHtml(shortTrans(t)) + tplParts.post + '</span>';
  const wordHtml = (w) => '<span style="' + wordCss + '">' + escapeHtml(w) + '</span>';
  // 291次：显式注释对（样例内手写）优先；其余拉丁词按动态缓存补注释（释义语言/词频实时链路），
  //   无缓存（首刷/获取中）暂原样，fetch 回来重渲染补上；句内去重（首个为准）。
  const pairs = parseSamplePairs(_subSample);
  const used = {};
  for (const p of pairs) used[String(p.word).toLowerCase()] = true;
  const dynRe = /[A-Za-z]+/g;
  let dm;
  while ((dm = dynRe.exec(_subSample))) {
    const wl = dm[0].toLowerCase();
    if (used[wl]) continue;
    used[wl] = true;
    const t = _previewAnns.get(wl);
    if (t) pairs.push({ word: dm[0], trans: t, index: dm.index, end: dm.index + dm[0].length });
  }
  pairs.sort((a, b) => a.index - b.index);
  if (!pairs.length) {
    return '<span style="' + buildSubMiniCss(style, ratio, 1, false, false, 1080) + '">'
      + escapeHtml(_subSample) + '</span>';
  }
  const mode = (annMode !== undefined && annMode !== null) ? annMode : style.annMode;
  if (mode === 'detail') {
    let boxInner = '';
    let cursor = 0;
    for (const p of pairs) {
      boxInner += escapeHtml(_subSample.slice(cursor, p.index)) + wordHtml(p.word);
      cursor = p.end;
    }
    boxInner += escapeHtml(_subSample.slice(cursor));
    const subBox = '<span style="white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;'
      + buildSubBoxCss(style, 1, 1080) + '">' + boxInner + '</span>';
    const annWordCss = annCss || ('color:' + annFg + ';font-weight:600');
    const annTransCss = annCss || ('color:' + annFg);
    let lines = '';
    for (const p of pairs) {
      lines += '<div><span style="' + annWordCss + '">' + escapeHtml(p.word) + '</span> '
        + '<span style="' + annTransCss + '">' + escapeHtml(shortTrans(p.trans)) + '</span></div>';
    }
    const annBlock = '<div style="margin-top:4px;line-height:1.3;text-align:left;white-space:nowrap;font-size:'
      + Math.round(sizePctToPx(subFontSizePct(style), 1080) * 0.9) + 'px;font-family:' + GUIDE_FONTS.sans + '">'
      + lines + '</div>';
    return '<span style="position:absolute;left:50%;bottom:' + (ratio * 100) + '%;transform:translate(-50%, 50%);display:flex;flex-direction:column;align-items:center;max-width:94%">'
      + subBox + annBlock + '</span>';
  }
  let inner = '';
  let cursor = 0;
  for (const p of pairs) {
    inner += escapeHtml(_subSample.slice(cursor, p.index)) + wordHtml(p.word) + annSpan(p.trans);
    cursor = p.end;
  }
  inner += escapeHtml(_subSample.slice(cursor));
  return '<span style="' + buildSubMiniCss(style, ratio, 1, false, false, 1080) + '">' + inner + '</span>';
}

// 282次：预览重做（用户"少了竖屏""预览的视频大小按照1080p缩放的，注意字体显示比例"）——
//   ①横屏 16:9 / 竖屏 9:16 切换按钮（_subPreviewOrient 本地态，不写 storage）。
//   ②1080p 虚拟舞台：内层按真实 1080p 像素（1920×1080 / 1080×1920）渲染字幕——
//   字号用样式 size 的真实 px（'none' 时真实 overlay 为 clamp(18, 高×4.5%, 40)，
//   1080p 恰取上限 40px），外层横 480×270 / 竖 270×480 整体 transform:scale(0.25)——
//   字体显示比例与真实 1080p 视频完全一致（旧版 scale=0.8 是 480px 小窗比例，失真）。
//   ③正文样式按 _subStyleId（custom/用户样式→合成对象）；注释行按第四栏池条目
//   （_poolSel.videoOverlayAnnStyle）——正文/位置/注释任一变化调用本函数立即刷新。
function renderSubPreview() {
  const row = $('subPreviewRow');
  if (!row) return;
  let style = (_subStyleId === 'custom') ? buildCustomStyleObj()
    : findStyle(SUBTITLE_TEXT_STYLES, _subStyleId);
  if (!style) {
    const us = _userStyles.find((s) => s.id === _subStyleId);
    style = us ? userStyleObj(us) : SUBTITLE_TEXT_STYLES[0];
  }
  const pos = findStyle(SUBTITLE_POSITIONS, _subPosId) || SUBTITLE_POSITIONS[0];
  const annStyle = findStyle(POOL_STYLES, _poolSel.videoOverlayAnnStyle);
  // 注释布局缓存（侧邻 side / 详细 detail，renderAll 从 storage.videoOverlayAnnMode 回填）
  const annMode = _overlayAnnMode;
  row.innerHTML = '';
  // 横竖切换按钮行
  const orient = document.createElement('div');
  orient.className = 'sub-orient-btns';
  for (const o of [
    { id: 'landscape', key: 'subOrientLandscape' },
    { id: 'portrait', key: 'subOrientPortrait' }
  ]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sub-orient-btn' + (_subPreviewOrient === o.id ? ' active' : '');
    b.textContent = m(o.key);
    b.addEventListener('click', () => {
      if (_subPreviewOrient === o.id) return;
      _subPreviewOrient = o.id;
      renderSubPreview();
    });
    orient.appendChild(b);
  }
  row.appendChild(orient);
  const portrait = (_subPreviewOrient === 'portrait');
  const stage = document.createElement('div');
  stage.className = 'sub-preview-stage' + (portrait ? ' portrait' : '');
  // 内层 1080p 舞台（真实像素）+ scale(0.25) 缩放（CSS 见 guide.css）
  const stage1080 = document.createElement('div');
  stage1080.className = 'sub-preview-1080' + (portrait ? ' portrait' : '');
  const mini = document.createElement('div');
  mini.className = 'sub-preview-mini';
  // 293次 size:40 特例删除；297次：预览短边恒 1080（横 1920×1080/竖 1080×1920 短边皆 1080），
  //   无 clamp，与真实 overlay 同口径，不再硬编码
  mini.innerHTML = subPreviewHtml(style, pos.ratio, annMode, annStyle);
  stage1080.appendChild(mini);
  stage.appendChild(stage1080);
  row.appendChild(stage);
  // 283次：缩放动态化——stage 宽按正文页宽百分比（横 50%/竖 28.125%，r10 CSS），窗口
  //   宽度变化后固定 scale(0.25) 失真（"预览的横屏半宽，竖屏半高，按照正文页面的宽度算"），
  //   实测 stage.clientWidth/1920 重算（竖屏分母 1080）；guard w>0 防 display:none 时测 0。
  //   ResizeObserver 模块级持有，stage 每次重建后重挂（先 disconnect 防泄漏）。
  const den = portrait ? 1080 : 1920;
  const fit = () => {
    const w = stage.clientWidth;
    if (w > 0) stage1080.style.transform = 'scale(' + (w / den) + ')';
  };
  fit();
  if (typeof ResizeObserver !== 'undefined') {
    if (_subPreviewRO) _subPreviewRO.disconnect();
    _subPreviewRO = new ResizeObserver(fit);
    _subPreviewRO.observe(stage);
  }
}

// 291次：注释方式单选行（side 侧邻/detail 详细；写 storage.videoOverlayAnnMode，
//   与视频侧栏 Detail 按钮同一键，控制字幕注释布局；change 即刷预览）
function renderSubAnnModeRadios() {
  const box = $('subAnnModeRadios');
  if (!box) return;
  box.innerHTML = '';
  for (const o of [
    { id: 'side', key: 'subAnnSide' },
    { id: 'detail', key: 'subAnnDetail' }
  ]) {
    const lab = document.createElement('label');
    lab.className = 'sub-pos-radio';
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = 'subAnnMode';
    r.value = o.id;
    r.checked = (o.id === _overlayAnnMode);
    r.addEventListener('change', () => {
      if (!r.checked) return;
      _overlayAnnMode = o.id;
      markOwnWrite();
      chrome.storage.local.set({ videoOverlayAnnMode: o.id }, () => log('videoOverlayAnnMode=', o.id));
      renderSubPreview();
    });
    const txt = document.createElement('span');
    txt.textContent = m(o.key);
    lab.appendChild(r);
    lab.appendChild(txt);
    box.appendChild(lab);
  }
}

// 281次：位置单选行（radio 组替代旧位置网格；change 即写 storage.subtitlePosition + 刷预览）
function renderSubPosRadios() {
  const box = $('subPosRadios');
  if (!box) return;
  box.innerHTML = '';
  for (const p of SUBTITLE_POSITIONS) {
    const lab = document.createElement('label');
    lab.className = 'sub-pos-radio';
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = 'subPos';
    r.value = p.id;
    r.checked = (p.id === _subPosId);
    r.addEventListener('change', () => {
      if (!r.checked) return;
      _subPosId = p.id;
      markOwnWrite();
      chrome.storage.local.set({ subtitlePosition: p.id }, () => log('subtitlePosition=', p.id));
      renderSubPreview();
    });
    const txt = document.createElement('span');
    txt.textContent = styleLabel(p, _lang);
    lab.appendChild(r);
    lab.appendChild(txt);
    box.appendChild(lab);
  }
}

// 282次：字体/特效下拉动态填充——选项来自共享层 SUB_FONT_OPTIONS（12 项）/
//   SUB_FX_OPTIONS（5 项），与 overlay 渲染同源；填充后按当前参数回填选中值。
//   renderAll 每轮调用（幂等重建，语言切换时选项文案随之更新）。
function fillSubCustomSelects() {
  const font = $('subCustomFont'), fx = $('subCustomFx');
  if (!font || !fx) return;
  font.innerHTML = '';
  for (const o of SUB_FONT_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = styleLabel(o, _lang);
    font.appendChild(opt);
  }
  fx.innerHTML = '';
  for (const o of SUB_FX_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = styleLabel(o, _lang);
    fx.appendChild(opt);
  }
  font.value = _subCustom.fontFamily;
  fx.value = _subCustom.fx;
}

// 282次：大加号——把当前 Custom 参数（底色/字色/字号/字体/特效）保存为新正文样式
//   （storage.subtitleUserStyles 追加一条，id='user-<时间戳>'），保存后自动选中新样式；
//   可连续点击保存多套（用户"最右侧来个大加号，可以新增字幕正文样式"）。
function bindSubCustomAdd() {
  const btn = $('subCustomAdd');
  if (!btn) return;
  btn.title = m('subAddStyle');
  if (btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    const entry = {
      id: 'user-' + Date.now(),
      label: { en: 'Style ' + (_userStyles.length + 1), zh: '样式 ' + (_userStyles.length + 1) },
      bg: _subCustom.bg,
      fg: _subCustom.fg,
      fontSizePct: _subCustom.fontSizePct,
      fontFamily: _subCustom.fontFamily,
      fx: _subCustom.fx
    };
    _userStyles = _userStyles.concat([entry]);
    _subStyleId = entry.id;
    markOwnWrite();
    chrome.storage.local.set({ subtitleUserStyles: _userStyles, subtitleStyle: entry.id },
      () => log('subtitleUserStyles+', entry.id));
    renderSubTextGrid();
    renderSubPreview();
  });
}

// 288次：点击样例卡回填个性化行——把选中卡参数复制进 Custom 五控件（用户"点击后样式
//   代码复制到个性化输入框，再加号会新增"），选中态不变；custom 卡回填即空操作。
//   映射：font/fg/size 直拷；bg 仅 #rrggbb 进取色器，其余（rgba/transparent/null）走透明勾选
//   （color input 不接受 alpha，属实注明）；fx 内置无字段，按 edge→描边、shadow→阴影近似
//   （pop3d 硬阴影→立体），回填后可再手调。写 storage.subtitleCustom（overlay 仅 style='custom'
//   时消费，不影响当前选中渲染）；随后重绘网格刷新 custom 卡样例（选中态按 _subStyleId 保留）。
function backfillSubCustomFrom(obj) {
  if (!obj || obj.id === 'custom') return;
  const fontOk = SUB_FONT_OPTIONS.some((o) => o.id === obj.font);
  _subCustom = {
    bg: (typeof obj.bg === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj.bg)) ? obj.bg : 'transparent',
    fg: (typeof obj.fg === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj.fg)) ? obj.fg : '#ffffff',
    // 293次：回填百分比；295次三级回退（fontSizePct → 过渡 sizePct → fontSize 换算）
    fontSizePct: (typeof obj.fontSizePct === 'number' && isFinite(obj.fontSizePct))
      ? Math.min(12, Math.max(2, obj.fontSizePct))
      : ((typeof obj.sizePct === 'number' && isFinite(obj.sizePct))
        ? Math.min(12, Math.max(2, obj.sizePct)) : pxToSizePct(obj.fontSize)),
    fontFamily: fontOk ? obj.font : 'sans',
    fx: obj.fx || (obj.edge ? 'stroke' : (obj.shadow ? (/4px 4px/.test(obj.shadow) ? '3d' : 'shadow') : 'none'))
  };
  if (!SUB_FX_OPTIONS.some((o) => o.id === _subCustom.fx)) _subCustom.fx = 'none';
  const tr = $('subCustomBgTransparent');
  if (tr) tr.checked = (_subCustom.bg === 'transparent');
  $('subCustomBg').value = (_subCustom.bg === 'transparent') ? '#000000' : _subCustom.bg;
  $('subCustomBg').disabled = (_subCustom.bg === 'transparent');
  $('subCustomFg').value = _subCustom.fg;
  $('subCustomSize').value = _subCustom.fontSizePct;
  fillSubCustomSelects();
  chrome.storage.local.set({ subtitleCustom: _subCustom }, () => log('subtitleCustom 回填<=', obj.id));
  refreshSubCustomCssText();
  updateCustomSideCard();
}

// 301次：注释个性化对象合成（_annCustom → 池条目结构，id 'ann-custom'）。
//   deco 存 _annCustom 内（select 只是它的编辑器），重载不丢。
function buildAnnCustomObj() {
  return Object.assign(
    { id: 'ann-custom', label: { en: 'Custom', zh: '个性化' } },
    _annCustom
  );
}

// 301次：装饰线 select 值 → deco 对象（颜色取注释字色；none 即无装饰字段）。
function decoFromSelect() {
  const sel = $('annCustomDeco');
  const id = sel ? sel.value : 'none';
  if (!id || id === 'none') return undefined;
  return { line: 'underline', style: id, color: _annCustom.annFg };
}
let _annSampleSaveTimer = 0;

// 301次：装饰线下拉填充（选项双语随界面语言；renderAll 每轮调用，幂等重建）。
function fillAnnCustomDeco() {
  const sel = $('annCustomDeco');
  if (!sel) return;
  sel.innerHTML = '';
  for (const o of ANN_DECO_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = (_lang === 'zh') ? o.zh : o.en;
    sel.appendChild(opt);
  }
  sel.value = (_annCustom.deco && _annCustom.deco.style) || $('annCustomDeco').dataset.want || 'none';
}

// 301次：个性化 CSS 代码文本（与 wordDecl/annDecl 同源，见 styles.annCustomCssText）。
function refreshAnnCustomCssText() {
  const ta = $('annCustomCss');
  if (!ta) return;
  if (document.activeElement === ta) return;
  ta.value = annCustomCssText(buildAnnCustomObj());
}

// 301次：注释 CSS 解析回填七控件——仅识别生成子集（background/color/border-radius/
//   font-weight/font-style/text-decoration），未知忽略；全无可识别沿用旧参数并照实打日志。
//   双区段按 /* annotation */ 标记切分（无标记视为全 Target 区）。
function parseAnnCustomCssText(text) {
  const out = {};
  const src = String(text || '');
  const ai = src.indexOf('/* annotation */');
  const wText = ai === -1 ? src : src.slice(0, ai);
  const aText = ai === -1 ? '' : src.slice(ai);
  const scan = (part, zone) => {
    for (const seg of part.split(';')) {
      const i = seg.indexOf(':');
      if (i === -1) continue;
      const prop = seg.slice(0, i).trim().toLowerCase();
      const val = seg.slice(i + 1).trim();
      if (!val || /\/\*/.test(prop)) continue;
      if (prop === 'background' || prop === 'background-color') {
        if (/^#[0-9a-fA-F]{6}$/.test(val) || /^transparent$/i.test(val) || /^rgba?\(/i.test(val)) {
          out[zone === 'w' ? 'wordBg' : 'annBg'] = val;
        }
      } else if (prop === 'color') {
        if (/^#[0-9a-fA-F]{6}$/.test(val)) out[zone === 'w' ? 'wordFg' : 'annFg'] = val;
      } else if (prop === 'border-radius' && zone === 'w' && !out.radius) {
        out.radius = val;
      } else if (prop === 'font-weight' && zone === 'w' && !out.boldSet) {
        out.boldSet = true;
        out.bold = /^(600|700|800|bold)$/i.test(val);
      } else if (prop === 'text-decoration' && zone === 'w' && !out.decoSet) {
        out.decoSet = true;
        const m = val.match(/underline/i);
        if (m) {
          const st = /wavy/i.test(val) ? 'wavy' : (/dashed/i.test(val) ? 'dashed'
            : (/dotted/i.test(val) ? 'dotted' : 'underline'));
          out.deco = st;
        } else {
          out.deco = 'none';
        }
      }
    }
  };
  scan(wText, 'w');
  scan(aText, 'a');
  delete out.boldSet;
  delete out.decoSet;
  return out;
}

// 301次：七控件统一应用（Custom 行改动与代码框改动共用）——设参数＋当前栏指派 custom＋
///  持久化（annotationCustom＋目标键，textStyle 联动 hintFirstBg/Fg）＋原地刷新。
function applyAnnCustomControls() {
  const wb = $('annCustomWordBg'), wf = $('annCustomWordFg'),
    ab = $('annCustomAnnBg'), af = $('annCustomAnnFg'),
    ra = $('annCustomRadius'), dc = $('annCustomDeco'), bo = $('annCustomBold'),
    tr = $('annCustomAnnBgTransparent');
  if (!wb || !wf || !ab || !af || !ra || !dc || !bo) return;
  _annCustom = {
    wordBg: wb.value || 'transparent',
    wordFg: wf.value || '#004d40',
    // 302次：注释底色透明勾选（默认勾选即 transparent）
    annBg: (tr && tr.checked) ? 'transparent' : (ab.value || '#004d40'),
    annFg: af.value || '#004d40',
    radius: (ra.value || '').trim() || '4px',
    bold: !!bo.checked,
    deco: (!dc.value || dc.value === 'none')
      ? undefined : { line: 'underline', style: dc.value, color: (af.value || '#004d40') }
  };
  dc.dataset.want = dc.value;
  assignAnnCustomToTarget();
  markOwnWrite();
  chrome.storage.local.set({ annotationCustom: _annCustom },
    () => log('annotationCustom=', JSON.stringify(_annCustom)));
  updateAnnCustomSideCard();
  refreshAnnCustomCssText();
}

// 301次：当前栏指派 custom（控件改动/代码改动/右侧卡点击共用）——写目标键＋textStyle 联动。
function assignAnnCustomToTarget() {
  const feat = _poolTarget;
  _poolSel[feat] = 'ann-custom';
  const obj = buildAnnCustomObj();
  const patch = {};
  patch[feat] = 'ann-custom';
  if (feat === 'textStyle') {
    patch.hintFirstBg = obj.wordBg || '#2e6b43';
    patch.hintFirstFg = obj.wordFg || '#ffffff';
  }
  markOwnWrite();
  chrome.storage.local.set(patch, () => log(feat + '= ann-custom'));
  const grid = $('poolStyleGrid');
  if (grid) grid.querySelectorAll('.style-card').forEach((c) => {
    c.classList.toggle('active', c.dataset.style === 'ann-custom');
  });
  renderPoolSideDemos();
}

// 301次：代码框改动应用——解析→写回七控件→走统一应用路径；成功后重生成规范文本；
//   全无可识别回滚旧代码并照实打日志。
function applyAnnCustomCssText() {
  const ta = $('annCustomCss');
  if (!ta) return;
  const parsed = parseAnnCustomCssText(ta.value);
  const keys = Object.keys(parsed);
  if (!keys.length) {
    console.warn('[VocabRadar][guide] 注释 CSS 无可识别声明，沿用旧参数');
    ta.value = annCustomCssText(buildAnnCustomObj());
    return;
  }
  if (parsed.wordBg) $('annCustomWordBg').value = /^#[0-9a-fA-F]{6}$/.test(parsed.wordBg) ? parsed.wordBg : '#000000';
  if (parsed.wordFg) $('annCustomWordFg').value = parsed.wordFg;
  // 302次：注释底色透明同步勾选态
  if (parsed.annBg) {
    const t = !/^#[0-9a-fA-F]{6}$/.test(parsed.annBg);
    $('annCustomAnnBgTransparent').checked = t;
    $('annCustomAnnBg').value = t ? '#000000' : parsed.annBg;
    $('annCustomAnnBg').disabled = t;
  }
  if (parsed.annFg) $('annCustomAnnFg').value = parsed.annFg;
  if (parsed.radius) $('annCustomRadius').value = parsed.radius;
  if (parsed.deco) {
    fillAnnCustomDeco();
    $('annCustomDeco').dataset.want = parsed.deco;
    $('annCustomDeco').value = parsed.deco;
  }
  if (typeof parsed.bold === 'boolean') $('annCustomBold').checked = parsed.bold;
  // rgba/transparent 底色取色器放不下：沿用旧色值（上两行已按 #rrggbb 设），如实注明
  applyAnnCustomControls();
  ta.value = annCustomCssText(buildAnnCustomObj());
  try { ta.focus(); } catch (_) { /* ignore */ }
}

// 301次：右侧样例卡原地刷新（常驻 word＋ann 双 span，只改样式与文本，不替换节点去闪）。
function updateAnnCustomSideCard() {
  const card = $('annCustomSideCard');
  if (!card) return;
  card.classList.toggle('active', _poolSel[_poolTarget] === 'ann-custom');
  const demo = $('annCustomSideDemo');
  const model = annSampleModel();
  const obj = buildAnnCustomObj();
  if (demo) {
    let w = demo.querySelector('.word-demo');
    let a = demo.querySelector('.ann-demo');
    if (!w) {
      demo.innerHTML = '';
      w = document.createElement('span');
      w.className = 'word-demo';
      demo.appendChild(w);
      a = document.createElement('span');
      a.className = 'ann-demo';
      demo.appendChild(a);
    }
    w.style.cssText = wordDecl(obj).join(';');
    const word = model.last ? model.last.word : model.text;
    if (w.textContent !== word) w.textContent = word;
    a.style.cssText = annDecl(obj).join(';');
    const annText = model.last && model.trans ? (model.pre + model.trans + model.post) : '';
    if (a.textContent !== annText) a.textContent = annText;
    a.style.display = annText ? '' : 'none';
  }
  const lab = $('annCustomSideLabel');
  if (lab) {
    const t = styleLabel(obj, _lang);
    if (lab.textContent !== t) lab.textContent = t;
  }
}

// 301次：七控件＋代码框＋右侧卡＋样例行绑定（各只绑一次）。
function bindAnnCustom() {
  const wb = $('annCustomWordBg');
  if (!wb || wb.dataset.bound) return;
  wb.dataset.bound = '1';
  const apply = () => applyAnnCustomControls();
  for (const id of ['annCustomWordBg', 'annCustomWordFg', 'annCustomAnnBg', 'annCustomAnnFg',
    'annCustomRadius', 'annCustomDeco', 'annCustomBold', 'annCustomAnnBgTransparent']) {
    const el = $(id);
    if (el) el.addEventListener('change', apply);
  }
  // 302次：透明勾选切换取色器禁用态（仿字幕行）
  const tr0 = $('annCustomAnnBgTransparent'), ab0 = $('annCustomAnnBg');
  if (tr0 && ab0 && !tr0.dataset.bound) {
    tr0.dataset.bound = '1';
    tr0.addEventListener('change', () => { ab0.disabled = tr0.checked; });
  }
  if (ab0 && tr0) ab0.disabled = tr0.checked;
  const ta = $('annCustomCss');
  if (ta && !ta.dataset.bound) {
    ta.dataset.bound = '1';
    ta.addEventListener('change', applyAnnCustomCssText);
  }
  const card = $('annCustomSideCard');
  if (card && !card.dataset.bound) {
    card.dataset.bound = '1';
    card.addEventListener('click', () => {
      assignAnnCustomToTarget();
      updateAnnCustomSideCard();
    });
  }
  const sample = $('annSampleText');
  if (sample && !sample.dataset.bound) {
    sample.dataset.bound = '1';
    sample.addEventListener('input', () => {
      const v = sample.value.trim();
      _annSample = v || DEFAULT_ANN_SAMPLE;
      if (_annSampleSaveTimer) clearTimeout(_annSampleSaveTimer);
      _annSampleSaveTimer = setTimeout(() => {
        _annSampleSaveTimer = 0;
        markOwnWrite();
        chrome.storage.local.set({ annotationSample: _annSample }, () => log('annotationSample=', _annSample));
      }, 500);
      renderPoolGrid();
      renderPoolSideDemos();
      updateAnnCustomSideCard();
      scheduleAnnSample();
    });
    sample.addEventListener('change', () => {
      if (_annSampleSaveTimer) { clearTimeout(_annSampleSaveTimer); _annSampleSaveTimer = 0; }
      const v = sample.value.trim();
      _annSample = v || DEFAULT_ANN_SAMPLE;
      if (!v) sample.value = _annSample;
      markOwnWrite();
      chrome.storage.local.set({ annotationSample: _annSample }, () => log('annotationSample=', _annSample));
      renderPoolGrid();
      renderPoolSideDemos();
      updateAnnCustomSideCard();
      scheduleAnnSample();
    });
  }
  const btn = $('annCustomAdd');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.title = m('annAddStyle');
    btn.addEventListener('click', () => {
      const entry = Object.assign(
        { id: 'ann-user-' + Date.now(), label: { en: 'Style ' + (_annUserStyles.length + 1), zh: '样式 ' + (_annUserStyles.length + 1) } },
        _annCustom,
        { deco: buildAnnCustomObj().deco }
      );
      _annUserStyles = _annUserStyles.concat([entry]);
      const feat = _poolTarget;
      _poolSel[feat] = entry.id;
      const patch = { annotationUserStyles: _annUserStyles };
      patch[feat] = entry.id;
      if (feat === 'textStyle') {
        patch.hintFirstBg = entry.wordBg || '#2e6b43';
        patch.hintFirstFg = entry.wordFg || '#ffffff';
      }
      markOwnWrite();
      chrome.storage.local.set(patch, () => log('annotationUserStyles+', entry.id));
      renderPoolGrid();
      renderPoolSideDemos();
    });
  }
}

// 301次：点击用户卡回填个性化行（仿字幕 backfillSubCustomFrom；选中态不变）。
function backfillAnnCustomFrom(st) {
  if (!st || st.id === 'ann-custom') return;
  const hex = (v, fb) => (/^#[0-9a-fA-F]{6}$/.test(v || '') ? v : fb);
  const decoId = (st.deco && st.deco.style) || 'none';
  _annCustom = {
    wordBg: st.wordBg || 'transparent',
    wordFg: hex(st.wordFg, '#004d40'),
    annBg: st.annBg || 'transparent',
    annFg: hex(st.annFg, '#e0f2f1'),
    radius: st.radius || '4px',
    bold: !!st.bold,
    deco: (decoId === 'none') ? undefined : { line: 'underline', style: decoId, color: hex(st.annFg, '#e0f2f1') }
  };
  $('annCustomWordBg').value = hex(st.wordBg, '#e0f2f1');
  $('annCustomWordFg').value = _annCustom.wordFg;
  const backTransparent = (_annCustom.annBg === 'transparent');
  $('annCustomAnnBgTransparent').checked = backTransparent;
  $('annCustomAnnBg').value = backTransparent ? '#000000' : hex(st.annBg, '#004d40');
  $('annCustomAnnBg').disabled = backTransparent;
  $('annCustomAnnFg').value = _annCustom.annFg;
  $('annCustomRadius').value = _annCustom.radius;
  fillAnnCustomDeco();
  $('annCustomDeco').dataset.want = ANN_DECO_OPTIONS.some((o) => o.id === decoId) ? decoId : 'none';
  $('annCustomDeco').value = $('annCustomDeco').dataset.want;
  $('annCustomBold').checked = _annCustom.bold;
  markOwnWrite();
  chrome.storage.local.set({ annotationCustom: _annCustom }, () => log('annotationCustom 回填<=', st.id));
  refreshAnnCustomCssText();
  updateAnnCustomSideCard();
}

// 301次：个性化参数回填（renderAll；storage.annotationCustom，缺省好看预设）。
function doAnnCustomBackfill(res) {
  const sc = (res && res.annotationCustom) || {};
  const hex = (v, fb) => (/^#[0-9a-fA-F]{6}$/.test(v || '') ? v : fb);
  _annCustom = {
    wordBg: sc.wordBg || '#e0f2f1',
    wordFg: hex(sc.wordFg, '#004d40'),
    annBg: sc.annBg || 'transparent',
    annFg: hex(sc.annFg, '#004d40'),
    radius: sc.radius || '4px',
    bold: sc.bold !== false,
    // 301次：deco 透传（select 编辑器，见 fillAnnCustomDeco；无即 undefined，生成器跳过）
    deco: (sc.deco && sc.deco.style && sc.deco.style !== 'none') ? sc.deco : undefined
  };
  $('annCustomWordBg').value = hex(sc.wordBg, '#e0f2f1');
  $('annCustomWordFg').value = _annCustom.wordFg;
  // 302次：透明底回填勾选态（取色器放不下 transparent，给占位黑并禁用）
  const annTransparent = (_annCustom.annBg === 'transparent');
  $('annCustomAnnBgTransparent').checked = annTransparent;
  $('annCustomAnnBg').value = annTransparent ? '#000000' : hex(sc.annBg, '#004d40');
  $('annCustomAnnBg').disabled = annTransparent;
  $('annCustomAnnFg').value = _annCustom.annFg;
  $('annCustomRadius').value = _annCustom.radius;
  $('annCustomBold').checked = _annCustom.bold;
  fillAnnCustomDeco();
  refreshAnnCustomCssText();
  updateAnnCustomSideCard();
}

// 301次：删除用户自建注释样式（选中它时回落 'none'）。
function deleteAnnUserStyle(id) {
  _annUserStyles = _annUserStyles.filter((s) => s && s.id !== id);
  const patch = { annotationUserStyles: _annUserStyles };
  for (const k of ['textStyle', 'annotationStyle', 'videoAnnotationStyle', 'videoOverlayAnnStyle']) {
    if (_poolSel[k] === id) {
      _poolSel[k] = 'none';
      patch[k] = 'none';
    }
  }
  markOwnWrite();
  chrome.storage.local.set(patch, () => log('annotationUserStyles-', id));
  renderPoolGrid();
  renderPoolSideDemos();
}

// 282次：删除用户自建样式——从 subtitleUserStyles 移除；若正选中该样式则回落 'none'。
function deleteUserStyle(id) {
  _userStyles = _userStyles.filter((s) => s.id !== id);
  const patch = { subtitleUserStyles: _userStyles };
  if (_subStyleId === id) {
    _subStyleId = 'none';
    patch.subtitleStyle = 'none';
  }
  markOwnWrite();
  chrome.storage.local.set(patch, () => log('subtitleUserStyles-', id));
  renderSubTextGrid();
  renderSubPreview();
}

// 290次：代码右侧个性化样例卡原地刷新（只碰本卡，不重建网格——
//   控件/CSS 改动走全网格重建会"闪一下才到最终态"；选中态按 _subStyleId 同步）。
// 291次（用户"还是会闪"）：demo 重建（innerHTML 替换）本身即一次闪烁——改常驻单 span，
//   只改 style/textContent，不替换节点；卡片恒纯文字无注释（与网格卡同口径）。
function updateCustomSideCard() {
  const card = $('subCustomSideCard');
  if (!card) return;
  card.classList.toggle('active', _subStyleId === 'custom');
  const demo = $('subCustomSideDemo');
  if (demo) {
    const obj = Object.assign(buildCustomStyleObj(), { sample: _subSample });
    const css = buildSubBoxCss(obj, 1)
      + ';display:block;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    let span = demo.firstElementChild;
    if (!span) {
      span = document.createElement('span');
      demo.appendChild(span);
    }
    span.style.cssText = css;
    if (span.textContent !== _subSample) span.textContent = _subSample;
  }
  const lab = $('subCustomSideLabel');
  if (lab) {
    const t = styleLabel(buildCustomStyleObj(), _lang);
    if (lab.textContent !== t) lab.textContent = t;
  }
}

// 290次：右侧卡点击=选中 custom（网格内无 custom 卡后的唯一入口；不回填，控件即 custom 本身）
function bindCustomSideCard() {
  const card = $('subCustomSideCard');
  if (!card || card.dataset.bound) return;
  card.dataset.bound = '1';
  card.addEventListener('click', () => {
    _subStyleId = 'custom';
    chrome.storage.local.set({ subtitleStyle: 'custom' }, () => log('subtitleStyle= custom（右侧卡）'));
    const grid = $('subtitleStyleGrid');
    if (grid) grid.querySelectorAll('.style-card').forEach((c) => c.classList.remove('active'));
    updateCustomSideCard();
    renderSubPreview();
  });
}

// 290次：样例文字输入框绑定（持久化 storage.subtitleSample + 重绘卡片与预览；
//   空值回落默认并写回，避免空样例卡全空）。
// 291次（用户"更改似乎不生效"）：change 只在失焦/回车触发，键入时 cards/预览纹丝不动
//   观感即"不生效"——改 input 事件实时重绘（卡片+预览同步，动态注释防抖跟进），
//   持久化防抖 500ms（逐键写 storage 会刷 onChanged 风暴），change 时立即落盘。
let _subSampleSaveTimer = 0;
function bindSubSampleText() {
  const input = $('subSampleText');
  if (!input || input.dataset.bound) return;
  input.dataset.bound = '1';
  const repaint = () => {
    renderSubTextGrid();
    updateCustomSideCard();
    renderSubPreview();
    schedulePreviewAnns();
  };
  input.addEventListener('input', () => {
    const v = input.value.trim();
    _subSample = v || DEFAULT_SUB_SAMPLE;
    if (_subSampleSaveTimer) clearTimeout(_subSampleSaveTimer);
    _subSampleSaveTimer = setTimeout(() => {
      _subSampleSaveTimer = 0;
      markOwnWrite();
      chrome.storage.local.set({ subtitleSample: _subSample }, () => log('subtitleSample=', _subSample));
    }, 500);
    repaint();
  });
  input.addEventListener('change', () => {
    if (_subSampleSaveTimer) { clearTimeout(_subSampleSaveTimer); _subSampleSaveTimer = 0; }
    const v = input.value.trim();
    _subSample = v || DEFAULT_SUB_SAMPLE;
    if (!v) input.value = _subSample;
    markOwnWrite();
    chrome.storage.local.set({ subtitleSample: _subSample }, () => log('subtitleSample=', _subSample));
    repaint();
  });
}

// 281次：个性化控件（底色/字色/字号/字体 + 282次特效）——改任一即切 'custom' 卡并写
//   storage.subtitleCustom + subtitleStyle='custom'，随后刷新右侧卡与预览（290次：
//   不再全网格重建，原地刷新去闪；同时清网格 active，选中态唯一）。
//   283次：底色透明勾选（subCustomBgTransparent）——勾选时 bg 写 'transparent' 并禁用
//   取色器（视觉明确），取消恢复取色值；字号缺省对齐新默认 28。
// 292次 storage 回声抑制：本页字幕流写入后即时渲染已是最终态，onChanged 回声再全量
//   renderAll 会"先经过一个样式再到最终"地闪一次；写前打时间戳，回声分支 1200ms 内跳过。
//   他页写入时间戳久远，正常同步。只覆盖字幕流，池分支行为不变。
let _ownWriteAt = 0;
function markOwnWrite() { _ownWriteAt = Date.now(); }

// 289次：五控件应用抽出（控件改动与 CSS 代码改动共用同一应用路径）
function applySubCustomControls() {
  const bg = $('subCustomBg'), fg = $('subCustomFg'), size = $('subCustomSize'),
    font = $('subCustomFont'), fx = $('subCustomFx'), tr = $('subCustomBgTransparent');
  if (!bg || !fg || !size || !font || !fx) return;
  _subCustom = {
    bg: (tr && tr.checked) ? 'transparent' : (bg.value || '#000000'),
    fg: fg.value || '#ffffff',
    // 293次：字号控件改百分比（2-12%，步进 0.5）；296次缺省一直默认 7%
    fontSizePct: Math.min(12, Math.max(2, parseFloat(size.value) || 7)),
    fontFamily: font.value || 'sans',
    fx: fx.value || 'none'
  };
  _subStyleId = 'custom';
  markOwnWrite();
  chrome.storage.local.set({ subtitleStyle: 'custom', subtitleCustom: _subCustom },
    () => log('subtitleCustom=', JSON.stringify(_subCustom)));
  // 290次：原地刷新（右侧卡 + 预览），不清焦点不闪网格；网格旧 active 清掉保持选中唯一
  const grid = $('subtitleStyleGrid');
  if (grid) grid.querySelectorAll('.style-card').forEach((c) => c.classList.remove('active'));
  updateCustomSideCard();
  renderSubPreview();
  refreshSubCustomCssText();
}

// 289次：当前个性化参数的 CSS 代码文本（与预览/overlay 同源：buildUserStyleDecl）
// 293次：字号行改百分比形式（font-size:5% ≈27px@540p；解析器认 %，px 按 540 换算；
//   注释内无冒号，解析切分安全）
function subCustomCssText() {
  const px = sizePctToPx(_subCustom.fontSizePct, SUBTITLE_REF_H);
  return buildUserStyleDecl({
    bg: _subCustom.bg,
    fg: _subCustom.fg,
    fontSizePct: _subCustom.fontSizePct,
    fontFamily: _subCustom.fontFamily,
    fx: _subCustom.fx
  }).map((d) => (d.indexOf('font-size') === 0
    ? 'font-size:' + _subCustom.fontSizePct + '% (~' + px + 'px @540p)' : d)).join(';\n') + ';';
}

// 289次：代码框刷新（编辑聚焦时不覆盖，避免打断输入）
function refreshSubCustomCssText() {
  const ta = $('subCustomCss');
  if (!ta) return;
  if (document.activeElement === ta) return;
  ta.value = subCustomCssText();
}

// 289次：CSS 代码解析回填五控件——仅识别本框生成的属性子集（background/color/
//   font-size/font-family/text-shadow/-webkit-text-stroke），未知属性忽略；
//   全无可识别时沿用旧参数（不拿"解析失败"当用户意图，照实打日志）。
//   字体按生成串精确回查选项，找不到按首 token 前缀匹配；阴影按 currentColor→发光、
//   4px 硬偏移→立体、其余→阴影启发；描边→描边。
function parseSubCustomCssText(text) {
  const out = {};
  const seen = { bg: false, fg: false, size: false, font: false, fx: false };
  const normFamily = (v) => String(v).replace(/["']/g, '').replace(/\s+/g, '').toLowerCase();
  for (const part of String(text || '').split(';')) {
    const i = part.indexOf(':');
    if (i === -1) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim();
    if (!val) continue;
    if ((prop === 'background' || prop === 'background-color') && !seen.bg) {
      seen.bg = true;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) out.bg = { transparent: false, color: val };
      else out.bg = { transparent: true };
    } else if (prop === 'color' && !seen.fg) {
      seen.fg = true;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) out.fg = val;
    } else if (prop === 'font-size' && !seen.size) {
      seen.size = true;
      // 293次：认百分比（5% 或生成串 5% (~27px @540p) 取前导数），px 按 540 换算
      const pm = val.match(/^([\d.]+)\s*%/);
      if (pm && isFinite(parseFloat(pm[1]))) {
        out.fontSizePct = Math.min(12, Math.max(2, parseFloat(pm[1])));
      } else {
        const n = parseInt(val, 10);
        if (isFinite(n)) out.fontSizePct = pxToSizePct(n);
      }
    } else if (prop === 'font-family' && !seen.font) {
      seen.font = true;
      const nv = normFamily(val);
      let hit = SUB_FONT_OPTIONS.find((o) => normFamily(subFontFamily(o.id)) === nv);
      if (!hit) {
        const first = nv.split(',')[0];
        hit = SUB_FONT_OPTIONS.find((o) => o.id === first || normFamily(subFontFamily(o.id)).indexOf(first + ',') === 0);
      }
      if (hit) out.fontFamily = hit.id;
    } else if (prop === 'text-shadow' && !seen.fx) {
      seen.fx = true;
      // 注：rgba() 内逗号不能用于计数，硬阴影按 4px 偏移特征识别（与回填同口径）
      out.fx = /currentcolor/i.test(val) ? 'glow' : (/4px 4px/.test(val) ? '3d' : 'shadow');
    } else if (prop === '-webkit-text-stroke' && !seen.fx) {
      seen.fx = true;
      out.fx = 'stroke';
    }
  }
  return out;
}

// 289次：代码框改动应用——解析→写回五控件→走统一应用路径（含预览）；
//   成功后代码框重生成规范文本（往返归一）；全无可识别则回滚显示旧代码并照实打日志。
function applySubCustomCssText() {
  const ta = $('subCustomCss');
  if (!ta) return;
  const parsed = parseSubCustomCssText(ta.value);
  const keys = Object.keys(parsed);
  if (!keys.length) {
    console.warn('[VocabRadar][guide] CSS 代码无可识别声明，沿用旧参数');
    ta.value = subCustomCssText();
    return;
  }
  if (parsed.bg) {
    $('subCustomBgTransparent').checked = parsed.bg.transparent;
    $('subCustomBg').value = parsed.bg.transparent ? '#000000' : parsed.bg.color;
    $('subCustomBg').disabled = parsed.bg.transparent;
  }
  if (parsed.fg) $('subCustomFg').value = parsed.fg;
  if (parsed.fontSizePct) $('subCustomSize').value = parsed.fontSizePct;
  if (parsed.fontFamily) {
    fillSubCustomSelects();
    $('subCustomFont').value = parsed.fontFamily;
  }
  if (parsed.fx) {
    fillSubCustomSelects();
    $('subCustomFx').value = parsed.fx;
  }
  applySubCustomControls();
  ta.value = subCustomCssText();
  try { ta.focus(); } catch (_) { /* ignore */ }
}

// 289次：代码框绑定（只绑一次；change 时应用）
function bindSubCustomCss() {
  const ta = $('subCustomCss');
  if (!ta || ta.dataset.bound) return;
  ta.dataset.bound = '1';
  ta.addEventListener('change', applySubCustomCssText);
}

function bindSubCustom() {
  const bg = $('subCustomBg'), fg = $('subCustomFg'), size = $('subCustomSize'),
    font = $('subCustomFont'), fx = $('subCustomFx'), tr = $('subCustomBgTransparent');
  if (!bg || !fg || !size || !font || !fx || bg.dataset.bound) return;
  bg.dataset.bound = '1';
  const apply = () => applySubCustomControls();
  bg.addEventListener('change', apply);
  fg.addEventListener('change', apply);
  size.addEventListener('change', apply);
  font.addEventListener('change', apply);
  fx.addEventListener('change', apply);
  if (tr) {
    // 283次：勾选切换——透明时取色器置灰（disabled），apply 统一写 storage
    tr.addEventListener('change', () => {
      bg.disabled = tr.checked;
      apply();
    });
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
    // 280 次：textStyle 联动分支删除——网格现仅用于字幕样式/位置（textStyle 指派走池卡 chip），
    //   且 TEXT_STYLES 常量已并入共享池，此分支引用失效。
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
  const defaults = Object.assign({    uiLanguage: 'zh',
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
    // 272 次：Query 独立开关（右键查询+查询栏），默认开；不再由网页提示负责
    // 286次：拆分为右键查询（contextLookupEnabled）/查询栏（queryBarEnabled）两键，默认开；
    //   两键故意不进 defaults——回填时 undefined 即回退旧 queryEnabled，老用户旧值自动沿用
    //   （进了 defaults 会被 get 填 true，旧关值会被掩盖）；旧 queryEnabled 保留只读作回退
    queryEnabled: true,
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
    // 280 次：videoAnnotationStyle 复活（池内三指派之一）；annBrackets 布尔退役 → annTemplate 模板
    videoAnnotationStyle: 'none',
    // 301次：注释个性化参数＋样例句缺省（用户样式列表不进 defaults，读 res || []）
    annotationCustom: {
      wordBg: '#e0f2f1', wordFg: '#004d40', annBg: 'transparent', annFg: '#004d40',
      radius: '4px', bold: true
    },
    annotationSample: 'vocab radar',
    annTemplate: DEFAULT_ANN_TEMPLATE,
    // 283次：注释模板分键——其余三栏各自的模板缺省（与 annTemplate 同默认值）
    webAnnTemplate: DEFAULT_ANN_TEMPLATE,
    videoAnnTemplate: DEFAULT_ANN_TEMPLATE,
    videoOverlayAnnTemplate: DEFAULT_ANN_TEMPLATE,
    subtitleStyle: 'none',
    subtitlePosition: 'b20',   // 第二百一十九次：默认位置改为下 1/5（用户裁定）
    // 281次：个性化字幕四参默认（subtitleStyle='custom' 时生效）+ 第四栏注释行样式键
    //   283次：默认改"能直接用"——透明底/不小字号/投影特效（用户裁定），与 overlay 端缺省对齐
    // 293次：字号改百分比；294次：默认 7%（用户裁定）
    subtitleCustom: { bg: 'transparent', fg: '#ffffff', fontSizePct: 5, fontFamily: 'sans', fx: 'shadow' },
    videoOverlayAnnStyle: 'none',
    webSidebarEnabled: true,
    sidebarEnabled: true,
    // 反思（2026-08-21 第九十次）：用户曾要求"视频叠加字幕应当默认不选"——
    // 277次（用户"引导页 视频叠加字幕默认选中"）改默认开（storage 未设置即勾选）
    overlayEnabled: true,
    webSidebarAnnMode: 'side',
    videoSidebarAnnMode: 'side',
    videoOverlayAnnMode: 'side',
    hintFirstBg: '#2e6b43',
    hintFirstFg: '#ffffff'
  }, cfgDefaults);
  // 272 次：等待 storage 读取完成再返回——init 里改 await loadSettings()，
  //   保证 _lang 在后续动态行渲染（deactivate 停用栏 chip 等）前已按界面语言就绪
  //   （旧版不等待，deactivate 行首渲染竞态到 zh 默认值 = 英文界面下闪中文混杂）。
  return new Promise((resolve) => {
    chrome.storage.local.get(defaults, (res) => {
      _lang = (res.uiLanguage === 'zh') ? 'zh' : 'en';
      renderAll(res);
      // 283次：首次使用写回个性化默认——get(defaults) 不落盘，content 端（overlay）只读
      //   storage 拿不到 defaults，不写回则新装用户视频端看不到透明底默认样式
      chrome.storage.local.get(null, (all) => {
        if (!('subtitleCustom' in all)) {
          chrome.storage.local.set({ subtitleCustom: _subCustom }, () => log('subtitleCustom 首次写回'));
        }
      });
      resolve(res);
    });
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
  // 286次：word hits 六开关回填（缺省=开；右键查询/查询栏 undefined 时回退旧 queryEnabled）
  const _effQuery = (v) => (typeof v === 'undefined' ? res.queryEnabled : v) !== false;
  $('hitContextLookup').checked = _effQuery(res.contextLookupEnabled);
  $('hitQueryBar').checked = _effQuery(res.queryBarEnabled);
  $('hitTextHint').checked = res.textHintEnabled !== false;
  $('hitTextSidebar').checked = res.webSidebarEnabled !== false;
  $('hitVideoSidebar').checked = res.sidebarEnabled !== false;
  // 277次（用户"引导页 视频叠加字幕默认选中"）：默认开——未设置视为勾选（!== false）
  $('hitOverlay').checked = res.overlayEnabled !== false;
  // 280 次：注释布局 radio 移出引导页（控制在各自侧栏与叠加字幕内）——overlay 布局值入
  //   _overlayAnnMode 缓存供 renderSubPreview 用；侧栏两键仍由各自功能页消费，不再回填
  _overlayAnnMode = res.videoOverlayAnnMode === 'detail' ? 'detail' : 'side';
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

  // 281次：共享池四键回填（textStyle/annotationStyle/videoAnnotationStyle/videoOverlayAnnStyle）——
  //   sanitizeStyleId 洗脏值（池外 id 回落 'none' 并回写）；videoAnnotationStyle 特殊：
  //   旧残留若不在池内，经 VANN_TO_ANN_MIGRATION 映射后写回自身（280 次复活语义：
  //   池内同名保留，池外经映射表回落，不再并入 annotationStyle、不再 remove 键）。
  //   第四键 videoOverlayAnnStyle：视频中字幕的注释行样式（无迁移，残留即回落）。
  // 301次：用户自建注释样式载入（非法条目过滤；残留 custom/用户 id 放行，见下）
  _annUserStyles = Array.isArray(res.annotationUserStyles)
    ? res.annotationUserStyles.filter((s) => s && typeof s.id === 'string' && s.id.indexOf('ann-user-') === 0)
    : [];
  const annStyleOk = (id) => id === 'ann-custom' || _annUserStyles.some((s) => s.id === id);
  for (const key of ['textStyle', 'annotationStyle', 'videoAnnotationStyle', 'videoOverlayAnnStyle']) {
    let val = (res[key] && annStyleOk(res[key])) ? res[key] : sanitizeStyleId(POOL_STYLES, res[key] || 'none');
    if (key === 'videoAnnotationStyle' && res[key] && !POOL_STYLES.some((s) => s.id === res[key]) && !annStyleOk(res[key])) {
      val = VANN_TO_ANN_MIGRATION[res[key]] || 'none';
      chrome.storage.local.set({ videoAnnotationStyle: val });
    } else if (val !== (res[key] || 'none')) {
      chrome.storage.local.set({ [key]: val });
    }
    _poolSel[key] = val;
  }
  // 301次：个性化参数回填（缺省好看预设；deco 下拉按 _annCustom.deco 回填）
  // 301次：样例行回填（空回落默认）＋绑定＋动态注释跟进
  doAnnCustomBackfill(res);
  _annSample = (typeof res.annotationSample === 'string' && res.annotationSample.trim())
    ? res.annotationSample : DEFAULT_ANN_SAMPLE;
  if (_annSample !== res.annotationSample) { markOwnWrite(); chrome.storage.local.set({ annotationSample: _annSample }); }
  $('annSampleText').value = _annSample;
  bindAnnCustom();
  scheduleAnnSample();
  // 280 次：注释模板回填（空/非字符串回落默认并回写）
  _poolSel.annTemplate = (typeof res.annTemplate === 'string' && res.annTemplate.trim())
    ? res.annTemplate : DEFAULT_ANN_TEMPLATE;
  // 282次：280 批旧默认残留迁移——'{word}({meaning})' 会让候选样例与真实注释多出一层
  //   括号（用户"候选项的释义不要加()"），统一迁到新默认（下分支回写）。
  // 284次：旧默认 '{word}({meaning})' 与 '{word}{meaning}' 统一迁到 '{target} {annotation}'。
  if (_poolSel.annTemplate === '{word}({meaning})' || _poolSel.annTemplate === '{word}{meaning}') {
    _poolSel.annTemplate = DEFAULT_ANN_TEMPLATE;
  }
  if (_poolSel.annTemplate !== res.annTemplate) chrome.storage.local.set({ annTemplate: _poolSel.annTemplate });
  // 283次：模板分键——其余三栏各自的注释模板（独立 storage 键；空/非字符串回落默认）。
  //   输入框始终显示当前选中栏的模板（跨标签页 renderAll 与切栏 bindPoolLeft 同口径）。
  for (const k of ['webAnnTemplate', 'videoAnnTemplate', 'videoOverlayAnnTemplate']) {
    _poolSel[k] = (typeof res[k] === 'string' && res[k].trim()) ? res[k] : DEFAULT_ANN_TEMPLATE;
  }
  $('annTemplate').value = _poolSel[ANN_TPL_KEYS[_poolTarget]] || DEFAULT_ANN_TEMPLATE;
  // 281次：候选池（右列网格一次建卡 + 池顶说明随选中栏切换 + 左栏选中态与内联复制卡）。
  //   初始选中栏固定第一项 Web Hints（_poolTarget 默认），补 .selected 高亮。
  renderPoolGrid();
  bindPoolGrid();
  bindPoolLeft();
  document.querySelectorAll('.pool-left .pool-item').forEach((it) => {
    it.classList.toggle('selected', it.dataset.target === _poolTarget);
  });
  renderPoolNote();
  renderPoolSideDemos();

  // 281次：字幕段回填——正文样式允许 'custom'（个性化）；282次：用户自建样式
  //   （user-* 前缀且存在于 subtitleUserStyles）同样放行，残留已删 id 回落清洗链。
  //   位置改单选行（renderSubPosRadios）；个性化五控件回填并绑定（bindSubCustom）；
  //   预览立即渲染。旧位置网格/位置卡已删。
  // 293次：用户样式字号改百分比——旧条目一次性迁新键并写回
  // 295次：三级回退（fontSizePct → 过渡 sizePct → fontSize px），旧键清扫
  _userStyles = Array.isArray(res.subtitleUserStyles)
    ? res.subtitleUserStyles.filter((s) => s && typeof s.id === 'string' && s.id.indexOf('user-') === 0)
    : [];
  let _userMigrated = false;
  for (const s of _userStyles) {
    if (typeof s.fontSizePct !== 'number' || !isFinite(s.fontSizePct)) {
      s.fontSizePct = (typeof s.sizePct === 'number' && isFinite(s.sizePct))
        ? Math.min(12, Math.max(2, s.sizePct)) : pxToSizePct(s.fontSize);
      delete s.fontSize;
      delete s.sizePct;
      _userMigrated = true;
    } else if ('sizePct' in s || 'fontSize' in s) {
      delete s.fontSize;
      delete s.sizePct;
      _userMigrated = true;
    }
  }
  if (_userMigrated) { markOwnWrite(); chrome.storage.local.set({ subtitleUserStyles: _userStyles }); }
  const subActive = (res.subtitleStyle === 'custom') ? 'custom'
    : (_userStyles.some((s) => s.id === res.subtitleStyle) ? res.subtitleStyle
      : sanitizeStyleId(SUBTITLE_TEXT_STYLES, res.subtitleStyle));
  if (subActive !== (res.subtitleStyle || 'none')) { markOwnWrite(); chrome.storage.local.set({ subtitleStyle: subActive }); }
  const posActive = sanitizePositionId(res.subtitlePosition);
  if (posActive !== (res.subtitlePosition || 'b20')) { markOwnWrite(); chrome.storage.local.set({ subtitlePosition: posActive }); }
  _subStyleId = subActive;
  _subPosId = posActive;
  // 281次：个性化参数回填（storage.subtitleCustom；缺省/非法值回落默认对象）。
  //   282次：加 fx；fontFamily 白名单放宽为 SUB_FONT_OPTIONS 全部 12 项（旧版仅三项）。
  //   283次：bg 'transparent'（透明勾选态）原样保留；勾选态回填 checkbox 并禁用取色器
  //   （color input 不接受非 #rrggbb 值，透明时给占位黑色）。
  // 293次：字号改百分比；295次三级回退（fontSizePct → 过渡 sizePct → fontSize 换算）。
  const sc = res.subtitleCustom || {};
  _subCustom = {
    bg: sc.bg || 'transparent',
    fg: sc.fg || '#ffffff',
    fontSizePct: (typeof sc.fontSizePct === 'number' && isFinite(sc.fontSizePct))
      ? Math.min(12, Math.max(2, sc.fontSizePct))
      : ((typeof sc.sizePct === 'number' && isFinite(sc.sizePct))
        ? Math.min(12, Math.max(2, sc.sizePct)) : pxToSizePct(sc.fontSize)),
    fontFamily: SUB_FONT_OPTIONS.some((o) => o.id === sc.fontFamily) ? sc.fontFamily : 'sans',
    fx: SUB_FX_OPTIONS.some((o) => o.id === sc.fx) ? sc.fx : 'none'
  };
  const bgTransparent = (_subCustom.bg === 'transparent');
  const trCb = $('subCustomBgTransparent');
  if (trCb) trCb.checked = bgTransparent;
  $('subCustomBg').value = bgTransparent ? '#000000' : _subCustom.bg;
  $('subCustomBg').disabled = bgTransparent;
  $('subCustomFg').value = _subCustom.fg;
  $('subCustomSize').value = _subCustom.fontSizePct;
  fillSubCustomSelects();
  // 289次：代码框初始刷新 + 绑定（回填/跨页同步后代码与控件一致）
  bindSubCustomCss();
  refreshSubCustomCssText();
  // 290次：样例文字回填（空/非字符串回落默认；输入框绑定；右侧卡初始刷新走 update）
  // 291次：290版硬编码注释旧默认（LEGACY）一并迁新默认（注释改动态链路）
  _subSample = (typeof res.subtitleSample === 'string' && res.subtitleSample.trim())
    ? res.subtitleSample : DEFAULT_SUB_SAMPLE;
  if (_subSample === LEGACY_SUB_SAMPLE_290) _subSample = DEFAULT_SUB_SAMPLE;
  if (_subSample !== res.subtitleSample) { markOwnWrite(); chrome.storage.local.set({ subtitleSample: _subSample }); }
  $('subSampleText').value = _subSample;
  bindSubSampleText();
  bindCustomSideCard();
  updateCustomSideCard();
  renderSubTextGrid();
  bindStyleGrid($('subtitleStyleGrid'), 'subtitleStyle', (id) => {
    _subStyleId = id;
    // 288次：选中即回填个性化行（内置/自建卡参数→Custom 五控件；custom 卡跳过）
    if (id !== 'custom') {
      let sel = findStyle(SUBTITLE_TEXT_STYLES, id);
      if (!sel) {
        const us = _userStyles.find((s) => s.id === id);
        if (us) sel = userStyleObj(us);
      }
      if (sel) backfillSubCustomFrom(sel);
    }
    renderSubPreview();
  });
  renderSubPosRadios();
  renderSubAnnModeRadios();
  bindSubCustom();
  bindSubCustomAdd();
  renderSubPreview();
  // 291次：动态注释跟进（样例/阈值/语言变化后刷新缓存；防抖+忙互斥在函数内）
  schedulePreviewAnns();

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
  // 283次：fillByDataKey 会把 poolNoteRerender 覆盖回静态兜底文案（段2），须在其后
  //   重跑动态拼接（拼当前栏名）；此时池状态已就绪，幂等无副作用
  renderPoolNote();
  renderHelp();
  // 反思（2026-08-16 第七十次）：头部显示构建版本——与视频页 overlay 启动日志的
  //   BUILD_STAMP 对照，可判定"改了默认样式/没选中"是不是旧构建残留。
  const verEl = $('guideVer');
  // 272次：BUILD_STAMP 已含 'v' 前缀（构建注入 v{yyyyMMdd.HHmm}），不再外加 'v'
  if (verEl) verEl.textContent = BUILD_STAMP;
}

// === 初始化 ===

async function init() {
  await initLang().catch(() => {});
  // 272 次：改 await——_lang 就绪后 initDeactivate 才渲染动态行（修语言混杂竞态）
  await loadSettings();

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
  // 280 次：候选池——注释模板输入（{word}/{meaning} 变量；空值回落默认 {word}({meaning})），
  //   更新 _poolSel 后刷新池卡样例（poolCardDemo 按 pre+释义+post 拆分渲染）
  // 283次：模板分键——写入当前选中栏对应的 storage 键（ANN_TPL_KEYS 映射），
  //   只影响该栏候选样例与真实渲染（"Annotation template 只会影响当前选中的注释栏目"）
  $('annTemplate').addEventListener('change', (e) => {
    let tpl = e.target.value;
    if (!tpl || !tpl.trim()) {
      tpl = DEFAULT_ANN_TEMPLATE;
      e.target.value = tpl;
    }
    const key = ANN_TPL_KEYS[_poolTarget] || 'annTemplate';
    _poolSel[key] = tpl;
    chrome.storage.local.set({ [key]: tpl }, () => log('注释模板[' + key + ']=', tpl));
    renderPoolGrid();
  });
  // 286次：word hits 六开关保存（原五处开关抽取至此；旧 queryEnabled 不再写入，只读回退）
  $('hitContextLookup').addEventListener('change', (e) => {
    chrome.storage.local.set({ contextLookupEnabled: e.target.checked }, () => log('右键查询=', e.target.checked));
  });
  $('hitQueryBar').addEventListener('change', (e) => {
    chrome.storage.local.set({ queryBarEnabled: e.target.checked }, () => log('查询栏=', e.target.checked));
  });
  $('hitTextHint').addEventListener('change', (e) => {
    chrome.storage.local.set({ textHintEnabled: e.target.checked }, () => log('网页提示=', e.target.checked));
  });
  $('hitTextSidebar').addEventListener('change', (e) => {
    chrome.storage.local.set({ webSidebarEnabled: e.target.checked }, () => log('文本侧栏=', e.target.checked));
  });
  $('hitVideoSidebar').addEventListener('change', (e) => {
    chrome.storage.local.set({ sidebarEnabled: e.target.checked }, () => log('视频侧栏=', e.target.checked));
  });
  $('hitOverlay').addEventListener('change', (e) => {
    chrome.storage.local.set({ overlayEnabled: e.target.checked }, () => log('视频叠加字幕=', e.target.checked));
  });
  // 280 次：注释布局三组 radio 监听删除——radio 移出引导页，布局控制在各自侧栏与叠加字幕内；
  //   storage 键（webSidebarAnnMode/videoSidebarAnnMode/videoOverlayAnnMode）与 defaults 保留
  //   （侧栏/overlay 功能自身 UI 仍消费）。
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
  // 第二百七十次：Deactivate 停用栏（须在折叠组通用绑定与标签切换绑定之后初始化，
  //   深链 ?deactivate= 需复用两者的既有监听）
  initDeactivate({ m, lang: () => _lang });
  window.addEventListener('pagehide', () => {
    disposeAsrCommon(); disposeAsr(); disposeOcr(); disposeParser(); disposeDeactivate();
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
    } else if (changes.textStyle || changes.annotationStyle || changes.videoAnnotationStyle || changes.annTemplate
       || changes.webAnnTemplate || changes.videoAnnTemplate || changes.videoOverlayAnnTemplate
       || changes.videoOverlayAnnStyle || changes.subtitleCustom || changes.subtitleUserStyles
       || changes.subtitleSample || changes.videoOverlayAnnMode
       // 291次：阈值/表外开关影响预览动态注释，布局键跨页同步预览
       || changes.rankThreshold || changes.annotateOov
       // 301次：注释个性化三键（与字幕流同分支，共享回声抑制）
       || changes.annotationCustom || changes.annotationUserStyles || changes.annotationSample) {
      // 292次回声抑制：本页刚写入（即时渲染已是最终态），1200ms 内回声跳过
      //   全量 renderAll——否则"先经过一个样式再到最终"地闪一次；他页写入正常同步。
      // 301次：池指派写 storage 同样打戳，281"不重渲染"至此才真正落地（此前回声必全量重建）。
      if (Date.now() - _ownWriteAt < 1200) return;
      // 280 次：候选池四键跨标签页同步（池三指派键 + 注释模板；annBrackets 退役）。
      //   282次：补第四栏注释样式键与字幕个性化/用户样式键——缺了会"别的标签页改了
      //   样式本页预览不动"（用户"都会触发立即预览，现在没动"的根因之一）。
      //   283次：补三栏独立模板键（分键后每个键变化都需重渲染池卡样例与输入框回填）。
      chrome.storage.local.get(null, (res) => renderAll(res));
    } else if (changes.llmProvider || changes.llmBaseUrl || changes.llmModel
               || changes.llmApiKey || changes.chatWordPrompt || changes.chatSidebarPrompt || changes.asrModelSize
               || changes.asrEngine || changes.ocrEngine || changes.asrLlmModel || changes.asrLlmBaseUrl
               || changes.asrLlmApiKey || changes.ocrLlmProvider || changes.ocrLlmBaseUrl || changes.ocrLlmModel
               || changes.ocrLlmApiKey || changes.ocrLanguages || changes.translationChannels
                || changes.llmTranslatePrompt || changes.learnLanguage || changes.meaningLanguage
                || changes.queryEnabled || changes.contextLookupEnabled || changes.queryBarEnabled
                || changes.textHintEnabled || changes.webSidebarEnabled || changes.sidebarEnabled
                || changes.overlayEnabled) {
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
