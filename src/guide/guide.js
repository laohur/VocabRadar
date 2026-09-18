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
// 第三百零二次（门面模式拆分）：本文件保留编排（renderAll/init/loadSettings/模型栏），
//   共享底座 → shared.js，注释池 → ann-pool.js，字幕 → sub-style.js（依赖无环，见各文件头）。

import {
  initLang, setLang,
  LANG_NAMES, LANG_NAMES_EN, UI_LANGS, TRANSLATE_LANGS
} from '../lib/i18n.js';
import { DEFAULT_ANN_TEMPLATE, BUILD_STAMP, ANN_DEFAULT_STYLE, SUB_DEFAULT_STYLE } from '../lib/styles.js';
// 302次：拆分模块（编排仅调它们的导出； direct lib 引用随代码搬迁，见各模块头）。
import { $, m, log, getLangState, setLangState, ownWriteAt } from './shared.js';
import {
  syncPoolSettings, getPoolTarget, renderPoolGrid, bindPoolGrid, bindPoolLeft,
  renderPoolNote, renderPoolSideDemos
} from './ann-pool.js';
import { syncSubtitleSettings, getSubCustom } from './sub-style.js';
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
// 第二百四十八次：词典装载状态行——ensureReady 幂等（IDB 已构建走投影快通道秒回，
//   缺数据才就地从源装载 = 更新/安装后引导页静默初始化的点名入口），getDiagState 读装载态。
import { ensureReady, getDiagState, getMaxRank, getDictFieldStats } from '../lib/dictionary.js';

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



// 说明栏内容
function renderHelp() {
  const box = $('helpBody');
  if (!box) return;
  box.innerHTML = '';
  for (const sec of HELP) {
    const title = document.createElement('h3');
    title.className = 'help-title';
    title.textContent = sec.title[getLangState()] || sec.title.en;
    box.appendChild(title);
    const ul = document.createElement('ul');
    ul.className = 'help-list';
    for (const item of sec.items) {
      const li = document.createElement('li');
      li.textContent = item[getLangState()] || item.en;
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

// 第二百四十八次：词典初始化状态行（设定栏顶部 #gDictStatus）——用户："更新安装后，自动
//   打开引导页就静默初始化么"。引导页打开即触发 ensureReady：IDB 已构建（__built__ 标记，
//   如 SW onInstalled 已建）则走投影快通道秒回；IDB 缺数据才就地从源装载（词频网络拉取只在
//   缺数据时发生），完成翻转「已就绪」。失败示红（网页按无词典降级，不掩饰错误——AGENTS.md）。
//   文案按界面语言取，与 renderHelp 一样用 getLangState()（不走 data-key/i18n 字典）。
// 第三百三十八次（用户："有错为啥不改"）：ready 文案 "built-in meanings · N words" 名不
//   副实——N=dictMap.size=词频∪词表并集（rank+tags 两字段覆盖的词条数），并非释义数；
//   内置翻译包 40261 词在 d_trans 分表懒读、不进内存投影（projection.js 321-324 行设计
//   如此），页侧无现成计数。文案改为如实标注数字口径，不再声称 "built-in meanings"。
// 第三百三十九次（用户："各个字段分别统计"）：338 次仍只显示一个并集数，仍不符要求。
//   就绪行改为四字段各显各的规模：词频 / 词表标签 / 翻译 / 词形还原，计数经
//   getDictFieldStats()（query.js 339 次）分项取得——词频/词表遍历内存 dictMap，
//   翻译查 d_trans 分表 IDB 计数（含运行时在线翻译缓存），词形查扩展数据域缓存
//   （仅读不下载）。就绪先翻转（不阻塞），分项数字异步到账后刷新文案。
const _fmt = (n) => Number(n || 0).toLocaleString('en-US');
// 第三百四十六次（用户裁定方案 A + "◑◒◐◓轮播"）：渐进式就绪视觉——
//   ◑◒◐◓ 四帧 120ms 字符轮播用于两处：装载中（ensureReady 未落定）、后台构建中
//   （projection.js 346 起库残缺不再 await 重建，放行就绪后源构建后台跑）。
//   句柄模块级持有：renderDictStatus 重入（语言切换）先停旧轮播防 interval 泄漏。
//   rebuildPending 观察器 2s 轮询 getDiagState，清空（重建结束/失败）即停轮播并
//   applyStats(3) 重取分项终值；重建失败时 rebuildPending 同样清空，分项数字如实
//   显示当前残值（控制台有 projection.js 的 warn 详情），不遮蔽错误。
const _SPIN_FRAMES = ['◑', '◒', '◐', '◓'];
let _spinEl = null;
let _spinTimer = null;
function _stopDictSpin() {
  if (_spinTimer) { try { clearInterval(_spinTimer); } catch (_) { /* ignore */ } _spinTimer = null; }
  if (_spinEl) { try { _spinEl.remove(); } catch (_) { /* ignore */ } _spinEl = null; }
}
function _startDictSpin(el, baseText) {
  _stopDictSpin();
  el.textContent = baseText + ' ';
  const span = document.createElement('span');
  span.className = 'g-dict-spin';
  span.textContent = _SPIN_FRAMES[0];
  el.appendChild(span);
  _spinEl = span;
  let _i = 0;
  _spinTimer = setInterval(() => { span.textContent = _SPIN_FRAMES[(++_i) % _SPIN_FRAMES.length]; }, 120);
}
// 第三百四十七次（用户："好像还是一齐最后显示，而不是有啥字段显示啥"）：textContent 赋值
//   会整体替换子节点（轮播 span 被摘下、interval 仍在往脱管节点写字符）——346 版 applyStats
//   因此被延后到重建结束，快字段全被绑死一齐出。改为：span 句柄模块级持有，数字刷新后
//   轮播仍活跃即把 span 重新挂回行尾（appendChild 自动从脱管状态移回），构建中的渐进
//   数字刷新与轮播可共存。
function _reattachSpin(el) {
  if (_spinEl && _spinTimer) el.appendChild(_spinEl);
}
function renderDictStatus() {
  const el = $('gDictStatus');
  if (!el) return;
  const zh = getLangState() === 'zh';
  const statusReady = (s) => (zh
    ? `词典已就绪 · 词频 ${_fmt(s.rankCount)} 词 · 词表标签 ${_fmt(s.tagCount)} 词 · 翻译 ${_fmt(s.transCount)} 词 · 词形还原 ${_fmt(s.lemmaCount)} 词`
    : `Dictionary ready · frequency ${_fmt(s.rankCount)} · word-list tags ${_fmt(s.tagCount)} · translations ${_fmt(s.transCount)} · lemmas ${_fmt(s.lemmaCount)}`);
  // 分项统计异步取数后刷新就绪文案；统计失败不回退就绪态（数字维持未刷新前的兜底文案）
  // 第三百四十次：翻译包后台补装期重取——补装在 projection.js 异步进行（不阻塞词典就绪），
  //   首次统计大概率取到补装前旧计数（如 687）；transCount<1000 且 lang=en 时 2s 后重取
  //   （最多 3 次），小语种无内置包不空转。其余字段（词频/词表/词形）就绪时已是终值。
  // 第三百四十七次：构建中数字照刷（有啥字段显示啥）——行尾追加"后台构建中"标记，轮播
  //   span 重挂行尾；346 版把 applyStats 延后到重建结束，快字段（翻译/词形）被绑死一齐出。
  const applyStats = (retries) => {
    Promise.resolve(getDictFieldStats()).then((s) => {
      const building = !!getDiagState().rebuildPending;
      el.textContent = statusReady(s) + (building ? (zh ? ' · 后台构建中' : ' · building in background') : '');
      if (building) _reattachSpin(el);
      if (s.lang === 'en' && s.transCount < 1000 && retries > 0) {
        setTimeout(() => applyStats(retries - 1), 2000);
      }
    }).catch(() => { /* 计数失败明示：保留已就绪基础文案，不掩饰也不阻断 */ });
  };
  // 346：后台重建观察器——rebuildPending 清空（重建结束/失败）即停轮播并重取分项终值
  // 347：构建中每 2s tick 顺带 applyStats(0)——字段到账即亮（如翻译先行回填完成后下一次
  //   tick 就显数），不再等重建结束一齐出；retries=0 不叠加翻译重试链（tick 本身就在重刷）
  let _rebuildWatchTimer = null;
  const watchRebuild = () => {
    if (_rebuildWatchTimer) return;
    _rebuildWatchTimer = setInterval(() => {
      let d = null;
      try { d = getDiagState(); } catch (_) { d = null; }
      if (!d || !d.rebuildPending) {
        clearInterval(_rebuildWatchTimer);
        _rebuildWatchTimer = null;
        _stopDictSpin();
        applyStats(3);
      } else {
        applyStats(0);
      }
    }, 2000);
  };
  // 346：就绪渲染按"是否后台构建中"分流——构建中走轮播文案（applyStats 延后到
  //   重建结束，防其 textContent 刷新清掉轮播 span；当前数字如实不撒谎）
  // 347：构建中立即 applyStats(0) 取数——快字段先行亮出，数字渐进刷新与轮播共存
  const renderReady = () => {
    const d = getDiagState();
    if (d.rebuildPending) {
      _startDictSpin(el, zh ? '词典已就绪 · 后台构建词频/标签中' : 'Dictionary ready · building frequency/tags in background');
      applyStats(0);
      watchRebuild();
    } else {
      _stopDictSpin();
      el.textContent = zh ? '词典已就绪' : 'Dictionary ready';
      el.classList.add('ok');
      applyStats(3);
    }
  };
  const diag = getDiagState();
  if (diag.loadedLang) {
    el.classList.add('ok');
    renderReady();
    return;
  }
  // 346：装载中 ◑◒◐◓ 轮播（替代静态"装载中…"，一眼可见在动、没死）
  _startDictSpin(el, zh ? '词典装载中' : 'Dictionary loading');
  // 承诺永不悬空（query.js：_loadDict 内部 catch，resolve null/undefined 表示失败）
  Promise.resolve(ensureReady()).then((m) => {
    if (m) {
      el.classList.add('ok');
      el.classList.remove('fail');
      refreshRankMaxPlaceholder();
      renderReady();
    } else {
      _stopDictSpin();
      el.textContent = zh ? '词典装载失败：网页将按无词典降级运行（详见控制台）' : 'Dictionary load failed: pages fall back to no-dictionary mode (see console)';
      el.classList.add('fail');
      el.classList.remove('ok');
    }
  });
}

// === 事件绑定 ===

// 样式网格点击：写 storage + 切 active + 预览（每个网格只绑一次）
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
    rankThresholdMax: 0,   // 词频范围上界（0=不限制）
    annotateRepeat: false,
    // 327次：引导页新增复选框回填默认（与 popup.hintLaterEnabled 同键，默认空即仅首次高亮）
    hintLaterEnabled: false,
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
    // 308次（用户"新增默认样式"）：网页提示默认样式改绿色下划线，annotationStyle 等注释栏默认不动。
    // 309次第二轮：名字定稿 'green-underline'。
    // 309次第五轮（用户"单词注释的网页提示、文本侧栏、视频侧栏、视频叠加字幕默认样式
    //   应当是Green Background"）：四注释类指派出厂默认统一改 'green-background'
    //   （生词绿底#2e6b43白字+注释同主题绿字）——旧默认下引导页四栏指派 none/兜底色
    //   （hintFirstBg transparent+hintFirstFg #2e6b43 绿字）与池指派脱节，用户看不出"是啥样式"；
    //   池指派后 pickColors 压过兜底，四端观感与引导页样式卡一致。none 仍是合法选项可手选。
    // 317次（用户"default 不是绝对而是代指"）：出厂默认改引代指常量。
    // 318次：default=代指定稿——绝对值唯一真源在常量，版本变化才改常量值；
    //   317 次新增的指针键出厂值（annDefaultStyle/subDefaultStyle）撤销。
    textStyle: ANN_DEFAULT_STYLE,
    annotationStyle: ANN_DEFAULT_STYLE,
    // 280 次：videoAnnotationStyle 复活（池内三指派之一）；annBrackets 布尔退役 → annTemplate 模板
    videoAnnotationStyle: ANN_DEFAULT_STYLE,
    // 301次：注释个性化参数＋样例句缺省（用户样式列表不进 defaults，读 res || []）
    // 304次：生词底色默认透明（用户"默认无底色"）。
    annotationCustom: {
      wordBg: 'transparent', wordFg: '#004d40', annBg: 'transparent', annFg: '#004d40',
      radius: '4px', bold: true
    },
    annotationSample: 'vocab radar',
    annTemplate: DEFAULT_ANN_TEMPLATE,
    // 283次：注释模板分键——其余三栏各自的模板缺省（与 annTemplate 同默认值）
    webAnnTemplate: DEFAULT_ANN_TEMPLATE,
    videoAnnTemplate: DEFAULT_ANN_TEMPLATE,
    videoOverlayAnnTemplate: DEFAULT_ANN_TEMPLATE,
    // 318次：字幕样式出厂默认改引代指常量 SUB_DEFAULT_STYLE（default=代指，版本变化才改常量值）
    subtitleStyle: SUB_DEFAULT_STYLE,
    subtitlePosition: 'b20',   // 314次：默认位置改贴底 1/10（用户裁定"default位置应当是底部10%"）；329次：用户裁定改回下 1/5（b20）
    // 281次：个性化字幕四参默认（subtitleStyle='custom' 时生效）+ 第四栏注释行样式键
    // 283次：默认改"能直接用"——透明底/不小字号/投影特效（用户裁定），与 overlay 端缺省对齐
    // 293次：字号改百分比；294次：默认 7%（用户裁定）
    subtitleCustom: { bg: 'transparent', fg: '#ffffff', fontSizePct: 5, fontFamily: 'sans', fx: 'shadow' },
    // 309次第五轮：视频叠加字幕注释行默认同改 'green-background'（用户四栏统一裁定）
    // 317次：改引默认代指常量（回落不写死绝对 id）
    videoOverlayAnnStyle: ANN_DEFAULT_STYLE,
    webSidebarEnabled: true,
    sidebarEnabled: true,
    // 反思（2026-08-21 第九十次）：用户曾要求"视频叠加字幕应当默认不选"——
    // 277次（用户"引导页 视频叠加字幕默认选中"）改默认开（storage 未设置即勾选）
    // 308次（用户"视频叠加字幕默认关"）改回默认关：与 video-sidebar.js 三处 === true
    //   口径一致——未设置视为关，全链路统一
    overlayEnabled: false,
    webSidebarAnnMode: 'side',
    videoSidebarAnnMode: 'side',
    videoOverlayAnnMode: 'side',
    // 304次（用户"默认无底色"）：透明底绿字。
    hintFirstBg: 'transparent',
    hintFirstFg: '#2e6b43'
  }, cfgDefaults);
  // 272 次：等待 storage 读取完成再返回——init 里改 await loadSettings()，
  //   保证 _lang 在后续动态行渲染（deactivate 停用栏 chip 等）前已按界面语言就绪
  //   （旧版不等待，deactivate 行首渲染竞态到 zh 默认值 = 英文界面下闪中文混杂）。
  return new Promise((resolve) => {
    chrome.storage.local.get(defaults, (res) => {
      setLangState(res.uiLanguage);
      renderAll(res);
      // 283次：首次使用写回个性化默认——get(defaults) 不落盘，content 端（overlay）只读
      //   storage 拿不到 defaults，不写回则新装用户视频端看不到透明底默认样式
      chrome.storage.local.get(null, (all) => {
        if (!('subtitleCustom' in all)) {
          chrome.storage.local.set({ subtitleCustom: getSubCustom() }, () => log('subtitleCustom 首次写回'));
        }
      });
      resolve(res);
    });
  });
}

// 词频上界占位提示：词典就绪后显示词频表上界实际值（用户「是几就是几」），未就绪显示 ∞
function refreshRankMaxPlaceholder() {
  const maxHint = getMaxRank();
  $('rankThresholdMax').placeholder = (maxHint > 0) ? String(maxHint) : '∞';
}

function renderAll(res) {
  // 语言控件（2026-09-02 释义语言统一英文名称：meaningLanguage 固定用 LANG_NAMES_EN）
  renderLangSelect($('uiLang'), UI_LANGS, res.uiLanguage);
  renderLangSelect($('learnLanguage'), TRANSLATE_LANGS, res.learnLanguage);
  renderLangSelect($('meaningLanguage'), TRANSLATE_LANGS, res.meaningLanguage, LANG_NAMES_EN);
  $('rankThreshold').value = res.rankThreshold;
  // 词频上界：0/缺省=回退到词典词频表上界（用户「是几就是几」；词典未就绪时显示 ∞）
  $('rankThresholdMax').value = (typeof res.rankThresholdMax === 'number' && isFinite(res.rankThresholdMax) && res.rankThresholdMax > 0)
    ? res.rankThresholdMax : '';
  refreshRankMaxPlaceholder();
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
  // 328次：单开关回填——任一重复键为开即勾选（收敛历史分歧值；勾选态=允许重复）
  $('hintLaterEnabled').checked = !!(res.hintLaterEnabled || res.annotateRepeat);
  $('hintSideAnnotation').checked = !!res.hintSideAnnotation;
  // 286次：word hits 六开关回填（缺省=开；右键查询/查询栏 undefined 时回退旧 queryEnabled）
  const _effQuery = (v) => (typeof v === 'undefined' ? res.queryEnabled : v) !== false;
  $('hitContextLookup').checked = _effQuery(res.contextLookupEnabled);
  $('hitQueryBar').checked = _effQuery(res.queryBarEnabled);
  $('hitTextHint').checked = res.textHintEnabled !== false;
  $('hitTextSidebar').checked = res.webSidebarEnabled !== false;
  $('hitVideoSidebar').checked = res.sidebarEnabled !== false;
  // 277次（用户"引导页 视频叠加字幕默认选中"）：默认开——未设置视为勾选（!== false）
  // 308次：改回默认关——未设置视为未勾选（=== true），与 video-sidebar.js / defaults 同口径
  $('hitOverlay').checked = res.overlayEnabled === true;
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

  syncPoolSettings(res);
  // 281次：候选池（右列网格一次建卡 + 池顶说明随选中栏切换 + 左栏选中态与内联复制卡）。
  //   初始选中栏固定第一项 Web Hints（_poolTarget 默认），补 .selected 高亮。
  renderPoolGrid();
  bindPoolGrid();
  bindPoolLeft();
  document.querySelectorAll('.pool-left .pool-item').forEach((it) => {
    it.classList.toggle('selected', it.dataset.target === getPoolTarget());
  });
  renderPoolNote();
  renderPoolSideDemos();

  syncSubtitleSettings(res);

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
    og.label = g.label[getLangState()] || g.label.en;
    items.forEach((pr) => {
      const opt = document.createElement('option');
      opt.value = pr.id;
      opt.textContent = pr.label[getLangState()] || pr.label.en;
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
    og.label = g.label[getLangState()] || g.label.en;
    items.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label[getLangState()] || p.label.en;
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


// 界面文案填充（data-key 通用 + 动态内容）
function applyTexts() {
  document.title = 'VocabRadar · Guide';
  document.documentElement.lang = getLangState();
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
  // 第二百四十八次：词典状态行（引导页 = 更新/安装后静默初始化的点名入口）
  renderDictStatus();

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
      setLangState(lang);
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
  // 词频上界（0/空=回退到词典词频表上界；下界必须小于上界，冲突时清空回退表上界）
  $('rankThresholdMax').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    const low = parseInt($('rankThreshold').value, 10);
    if (!isFinite(v) || v <= 0 || (isFinite(low) && v <= low)) {
      $('rankThresholdMax').value = '';
      chrome.storage.local.set({ rankThresholdMax: 0 }, () => { refreshRankMaxPlaceholder(); log('词频上界重置为词频表上界'); });
      return;
    }
    chrome.storage.local.set({ rankThresholdMax: v }, () => log('词频上界=', v));
  });
  $('annotateOov').addEventListener('change', (e) => {
    chrome.storage.local.set({ annotateOov: e.target.checked }, () => log('注释表外词=', e.target.checked));
  });
  // 328次：旧 annotateRepeat 复选框已删（只留一个开关）；单开关双写——
  //   hintLaterEnabled（后续高亮显隐）+ annotateRepeat（侧邻/侧栏/字幕注释去重）
  //   同值，确保"重复"一个概念两处机制一致；content 侧 onChanged+5s 对账已覆盖两键。
  $('hintLaterEnabled').addEventListener('change', (e) => {
    const v = !!e.target.checked;
    chrome.storage.local.set({ hintLaterEnabled: v, annotateRepeat: v }, () => log('注释重复生词=', v));
  });
  $('hintSideAnnotation').addEventListener('change', (e) => {
    chrome.storage.local.set({ hintSideAnnotation: e.target.checked }, () => log('侧邻提示=', e.target.checked));
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
  initDeactivate({ m, lang: () => getLangState() });
  window.addEventListener('pagehide', () => {
    disposeAsrCommon(); disposeAsr(); disposeOcr(); disposeParser(); disposeDeactivate();
  });

  // 其他标签页改了设置（如字幕样式）→ 本页监听同步
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.uiLanguage) {
      setLangState(changes.uiLanguage.newValue);
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
       || changes.rankThreshold || changes.rankThresholdMax || changes.annotateOov
       // 301次：注释个性化三键（与字幕流同分支，共享回声抑制）
       || changes.annotationCustom || changes.annotationUserStyles || changes.annotationSample) {
      // 292次回声抑制：本页刚写入（即时渲染已是最终态），1200ms 内回声跳过
      //   全量 renderAll——否则"先经过一个样式再到最终"地闪一次；他页写入正常同步。
      // 301次：池指派写 storage 同样打戳，281"不重渲染"至此才真正落地（此前回声必全量重建）。
      if (Date.now() - ownWriteAt() < 1200) return;
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
