// VocabRadar 样式预设（文本样式 / 文本侧栏注释样式 / 视频侧栏注释样式 / 字幕样式）
//
// 反思（2026-08-16 第七十次）：构建版本戳——引导页头部与 overlay 启动日志都打印本值。
//   用户反馈"edge中你把默认样式改了，撤销，要跟其他浏览器一样"、设定栏"实际有样式但一个都没选"，
//   这些疑似旧构建内容脚本未随扩展重载所致。加本戳后，若 overlay 日志版本 ≠ 引导页头部版本，
//   即可判定为旧构建残留（需重载扩展并刷新视频页），不用再猜。
export const BUILD_STAMP = 'v82';
//
// 反思（2026-08-13 第五十一次）：用户反馈"样式同质化（都是颜色互换），样例要 word(释义)，
//   字幕样式要含位置/侧邻注释/新行注释/字号/颜色/边缘，缺少视频侧栏样式"。
//   本模块重新设计四套样式，属性差异化（字号/粗细/阴影/底色/描边/圆角/斜体/下划线），
//   引导页渲染真实样例（word(释义) 形式、视频 16:9 预览），内容脚本通过 storage 应用。
//
// 数据格式：
//   - id：storage 中保存的标识（'none'=默认配色，不应用额外样式覆盖）
//   - label：中英文短名（引导页样例卡小字显示）
//   - wordBg/wordFg：生词块背景/前景色
//   - annBg/annFg：释义块背景/前景色（文本/侧栏注释样式）
//   - radius：圆角
//   - bold/italic/underline：字体属性开关
//   - shadow：文本阴影（CSS text-shadow 值，false=无）
//   - fontSize：字号（仅侧栏注释样式用，px）
//   - 字幕样式：pos 位置 / font 字体 / fg 前景 / bg 背景 / size 字号 / edge 描边 / annMode 注释模式

// === 文本样式（生词高亮，class beaver-text-style-{id} 挂在 <html>） ===
// 样例：页面句子中的生词高亮 + (释义) 侧邻注释
// 反思（2026-08-15 第六十三次）：去同质化重构——
//   1. 数量精简到 16（无+15），保留流行大众样式并放前（高亮/下划线/发光/胶囊/立体）。
//   2. 结构差异明显：透明底（无背景色）vs 实底、下划线式、外发光、描边字、胶囊、立体、
//      大字（fontSize）、手写斜体等，不再全是"字色+背景色互换"。
//   3. 字段：wordBg/wordFg/radius/bold/italic/underline/shadow/fontSize（第六十三次起支持大字）。
export const TEXT_STYLES = [
  // 'none' = 使用默认配色（绿底白字），不应用任何额外样式覆盖
  { id: 'none', label: { en: 'Default', zh: '默认配色' } },
  { id: 'mint', label: { en: 'Mint', zh: '薄荷' }, wordBg: '#a8e6cf', wordFg: '#0d2014', radius: '2px' },
  { id: 'gold', label: { en: 'Gold', zh: '鎏金' }, wordBg: '#ffd54f', wordFg: '#332700', radius: '3px', bold: true, shadow: '0 1px 2px rgba(51,39,0,.35)' },
  { id: 'marker', label: { en: 'Marker', zh: '荧光笔' }, wordBg: 'rgba(255,213,79,.45)', wordFg: '#332700', radius: '0', bold: true },
  { id: 'rose-underline', label: { en: 'Rose Underline', zh: '玫红下划线' }, wordBg: 'transparent', wordFg: '#e91e63', radius: '0', underline: true, shadow: '0 1px 0 #e91e63' },
  { id: 'double-underline', label: { en: 'Double Underline', zh: '双下划线' }, wordBg: 'transparent', wordFg: '#c2185b', radius: '0', underline: true, shadow: '0 1px 0 rgba(194,24,91,.55), 0 2.5px 0 rgba(194,24,91,.35)' },
  { id: 'bold-underline', label: { en: 'Bold Underline', zh: '粗下划线' }, wordBg: 'transparent', wordFg: '#00695c', radius: '0', underline: true, bold: true, shadow: '0 1px 0 #00897b' },
  { id: 'glow-blue', label: { en: 'Blue Glow', zh: '蓝光' }, wordBg: 'transparent', wordFg: '#1565c0', radius: '0', shadow: '0 0 4px rgba(21,101,192,.7), 0 0 8px rgba(21,101,192,.4)' },
  { id: 'glow-amber', label: { en: 'Amber Glow', zh: '金光' }, wordBg: 'transparent', wordFg: '#e65100', radius: '0', shadow: '0 0 4px rgba(255,160,0,.8), 0 0 10px rgba(255,160,0,.45)' },
  { id: 'outline-light', label: { en: 'Outline', zh: '描边字' }, wordBg: 'transparent', wordFg: '#1a237e', radius: '0', bold: true, shadow: '0 1px 0 #fff, 0 -1px 0 #fff, 1px 0 0 #fff, -1px 0 0 #fff, 1px 1px 0 #fff, -1px 1px 0 #fff, 1px -1px 0 #fff, -1px -1px 0 #fff, 0 2px 3px rgba(0,0,0,.5)' },
  { id: 'capsule-blue', label: { en: 'Blue Capsule', zh: '胶囊蓝' }, wordBg: '#64b5f6', wordFg: '#0d1b33', radius: '999px', bold: true },
  { id: 'capsule-rose', label: { en: 'Rose Capsule', zh: '胶囊玫' }, wordBg: '#f48fb1', wordFg: '#33000f', radius: '999px', italic: true },
  { id: 'shadow-pop', label: { en: 'Shadow Pop', zh: '立体' }, wordBg: '#6d4c41', wordFg: '#fff8f0', radius: '3px', bold: true, shadow: '0 2px 3px rgba(0,0,0,.45), 0 5px 8px rgba(0,0,0,.25)' },
  { id: 'ink', label: { en: 'Ink', zh: '墨蓝' }, wordBg: '#263238', wordFg: '#eceff1', radius: '2px', bold: true },
  { id: 'night', label: { en: 'Night', zh: '暗夜' }, wordBg: '#37474f', wordFg: '#ffcc80', radius: '2px', bold: true, shadow: '0 1px 2px rgba(0,0,0,.4)' },
  { id: 'comic', label: { en: 'Comic', zh: '手写' }, wordBg: '#fff176', wordFg: '#5d4037', radius: '0', italic: true, bold: true, shadow: '0 1px 2px rgba(93,64,55,.4)' },
  { id: 'big-serif', label: { en: 'Big Serif', zh: '大字' }, wordBg: 'transparent', wordFg: '#0d47a1', radius: '0', italic: true, fontSize: '20px' }
];

// === 文本侧栏注释样式（class beaver-ann-style-{id} 挂在 #beaver-web-sidebar） ===
// 反思（2026-08-15 第六十三次）：去同质化重构——数量精简到 16（无+15），流行在前。
//   结构与文本样式呼应但独立：既有实底胶囊/立体，也有"无背景色"（素字/下划线/描边）、
//   大字（wordFontSize/fontSize）。web-sidebar.css 中 beaver-ann-style-{id} 规则与此一一对应。
export const ANN_STYLES = [
  // 'none' = 使用默认配色（绿底白字/白底绿字），不应用任何额外样式覆盖
  { id: 'none', label: { en: 'Default', zh: '默认配色' } },
  { id: 'mint', label: { en: 'Mint', zh: '薄荷' }, wordBg: '#a8e6cf', wordFg: '#0d2014', annBg: '#0d2014', annFg: '#ffffff', radius: '999px', bold: true },
  { id: 'gold', label: { en: 'Gold', zh: '鎏金' }, wordBg: '#ffd54f', wordFg: '#332700', annBg: '#fff8e1', annFg: '#8a6d00', radius: '2px', bold: true, fontSize: '15px' },
  { id: 'marker', label: { en: 'Marker', zh: '荧光笔' }, wordBg: 'rgba(255,213,79,.45)', wordFg: '#332700', annBg: 'transparent', annFg: '#b28704', radius: '0', bold: true },
  { id: 'red-underline', label: { en: 'Red Underline', zh: '红下划线' }, wordBg: 'transparent', wordFg: '#d81b60', annBg: 'transparent', annFg: '#d81b60', radius: '0', underline: true },
  { id: 'plain', label: { en: 'Plain', zh: '素字' }, wordBg: 'transparent', wordFg: '#1565c0', annBg: 'transparent', annFg: '#1565c0', radius: '0' },
  { id: 'capsule', label: { en: 'Blue Capsule', zh: '胶囊蓝' }, wordBg: '#64b5f6', wordFg: '#0d1b33', annBg: '#0d1b33', annFg: '#64b5f6', radius: '999px', bold: true },
  { id: 'shadow-pop', label: { en: 'Shadow Pop', zh: '立体' }, wordBg: '#6d4c41', wordFg: '#fff8f0', annBg: '#fff8f0', annFg: '#6d4c41', radius: '3px', bold: true, shadow: '0 2px 3px rgba(0,0,0,.45), 0 5px 8px rgba(0,0,0,.25)' },
  { id: 'ink', label: { en: 'Ink', zh: '墨蓝' }, wordBg: '#263238', wordFg: '#eceff1', annBg: '#eceff1', annFg: '#263238', radius: '2px', bold: true, fontSize: '12px' },
  { id: 'big', label: { en: 'Big', zh: '大字' }, wordBg: 'transparent', wordFg: '#00695c', wordFontSize: '19px', annBg: 'transparent', annFg: '#00695c', radius: '0', bold: true, fontSize: '17px' },
  { id: 'night', label: { en: 'Night', zh: '暗夜' }, wordBg: '#37474f', wordFg: '#ffcc80', annBg: '#ffcc80', annFg: '#37474f', radius: '2px', bold: true },
  { id: 'serif-italic', label: { en: 'Serif Italic', zh: '衬线斜体' }, wordBg: 'transparent', wordFg: '#4a148c', annBg: 'transparent', annFg: '#6a1b9a', radius: '0', italic: true },
  { id: 'outline', label: { en: 'Outline', zh: '描边字' }, wordBg: 'transparent', wordFg: '#1a237e', annBg: 'transparent', annFg: '#1a237e', radius: '0', bold: true, shadow: '0 1px 0 #fff, 0 -1px 0 #fff, 1px 0 0 #fff, -1px 0 0 #fff, 0 2px 3px rgba(0,0,0,.5)' },
  { id: 'rose', label: { en: 'Rose', zh: '玫瑰' }, wordBg: '#f48fb1', wordFg: '#3d0019', annBg: 'transparent', annFg: '#c2185b', radius: '999px', italic: true, bold: true },
  { id: 'sky', label: { en: 'Sky', zh: '天青' }, wordBg: '#80deea', wordFg: '#003038', annBg: '#003038', annFg: '#80deea', radius: '999px', italic: true },
  { id: 'lime', label: { en: 'Lime', zh: '青柠' }, wordBg: '#d4e157', wordFg: '#222b00', annBg: '#222b00', annFg: '#d4e157', radius: '0', bold: true, underline: true, fontSize: '15px' }
];

// === 视频侧栏注释样式（class beaver-vann-style-{id} 挂在 #beaver-sidebar） ===
// 反思（2026-08-15 第六十三次）：去同质化重构——数量精简到 16（无+15），流行在前。
//   视频场景字更大更醒目：新增"无背景色"（素字/下划线）与"大字"（wordFontSize/fontSize）。
//   sidebar.css 中 beaver-vann-style-{id} 规则与此一一对应。
export const VANN_STYLES = [
  // 'none' = 使用默认配色（绿底白字/白底绿字），不应用任何额外样式覆盖
  { id: 'none', label: { en: 'Default', zh: '默认配色' } },
  { id: 'lime-tight', label: { en: 'Lime', zh: '荧光绿' }, wordBg: '#d4e157', wordFg: '#1a1a00', annBg: '#1a1a00', annFg: '#d4e157', radius: '2px', bold: true, fontSize: '17px' },
  { id: 'sunset', label: { en: 'Sunset', zh: '落日橙' }, wordBg: '#ff6d00', wordFg: '#ffffff', annBg: '#ffffff', annFg: '#ff6d00', radius: '4px', bold: true, shadow: '0 1px 2px rgba(255,109,0,.4)' },
  { id: 'plain', label: { en: 'Plain', zh: '素字' }, wordBg: 'transparent', wordFg: '#e53935', annBg: 'transparent', annFg: '#e53935', radius: '0', bold: true },
  { id: 'underline', label: { en: 'Red Underline', zh: '红下划线' }, wordBg: 'transparent', wordFg: '#d81b60', annBg: 'transparent', annFg: '#d81b60', radius: '0', underline: true },
  { id: 'capsule', label: { en: 'Blue Capsule', zh: '胶囊蓝' }, wordBg: '#64b5f6', wordFg: '#0d1b33', annBg: '#0d1b33', annFg: '#64b5f6', radius: '999px', bold: true },
  { id: 'big', label: { en: 'Big', zh: '大字' }, wordBg: 'transparent', wordFg: '#00b8d4', wordFontSize: '22px', annBg: 'transparent', annFg: '#00b8d4', radius: '0', bold: true, fontSize: '18px' },
  { id: 'snow', label: { en: 'Snow', zh: '雪原' }, wordBg: '#ffffff', wordFg: '#1a1f1a', annBg: '#1a1f1a', annFg: '#ffffff', radius: '2px', bold: true, shadow: '0 1px 2px rgba(0,0,0,.35)', fontSize: '16px' },
  { id: 'glacier', label: { en: 'Glacier', zh: '冰川' }, wordBg: '#4dd0e1', wordFg: '#002f36', annBg: '#002f36', annFg: '#4dd0e1', radius: '2px', fontSize: '18px' },
  { id: 'violet', label: { en: 'Violet', zh: '紫罗兰' }, wordBg: '#b388ff', wordFg: '#12002e', annBg: '#12002e', annFg: '#b388ff', radius: '6px', italic: true },
  { id: 'ember', label: { en: 'Ember', zh: '余烬' }, wordBg: '#ffab40', wordFg: '#331400', annBg: '#331400', annFg: '#ffab40', radius: '3px', bold: true, underline: true },
  { id: 'mustard', label: { en: 'Mustard', zh: '芥末黄' }, wordBg: '#ffee58', wordFg: '#332b00', annBg: '#332b00', annFg: '#ffee58', radius: '2px', bold: true, underline: true, fontSize: '18px' },
  { id: 'seafoam', label: { en: 'Seafoam', zh: '海沫' }, wordBg: '#80cbc4', wordFg: '#002e29', annBg: '#002e29', annFg: '#80cbc4', radius: '3px', fontSize: '17px' },
  { id: 'raspberry', label: { en: 'Raspberry', zh: '覆盆子' }, wordBg: '#f06292', wordFg: '#33000f', annBg: '#33000f', annFg: '#f06292', radius: '4px', italic: true, bold: true },
  { id: 'cyan-glass', label: { en: 'Cyan Glass', zh: '青玻璃' }, wordBg: '#00e5ff', wordFg: '#001318', annBg: 'rgba(0,0,0,.88)', annFg: '#00e5ff', radius: '2px', bold: true, shadow: '0 0 4px rgba(0,229,255,.5)' },
  { id: 'brick', label: { en: 'Brick', zh: '砖红' }, wordBg: '#ff8a65', wordFg: '#2d0a00', annBg: '#2d0a00', annFg: '#ff8a65', radius: '4px', bold: true, fontSize: '17px' }
];

// === 字幕文字样式（视频内字幕外观，class style-{id} 定义在 subtitle-overlay.js） ===
// 反思（2026-08-13 第五十一次）：去同质化重构——数量精简到 16（无+15），流行在前。
// 反思（2026-08-15 第六十五次）：参考同类项目补充差异化样式——
//   netflix-style（流媒体式白字黑边无底）/ app-dark-bar（看视频学英语类 App 深色字幕条）。
// 反思（2026-08-16 第六十六次）：删除竖排（right-vertical/center-vertical）与竖排渲染逻辑
//   （用户明确："是视频竖着，不是字幕竖着"，字幕一律横排、跟随视频矩形）。
// 反思（2026-08-16 第六十七次）：撤销第六十六次对默认样式（'none'）的改动（用户：
//   "edge中你把默认样式改了，撤销"）——'none' 恢复深色半透明条 rgba(0,0,0,0.75)、
//   shadow 改 false（第六十六次新增的文本投影移除），与 subtitle-overlay.js 基础样式一致。
//   "不要把透明当作黑色"适用于 bg=null 的本应透明样式，与默认深条不冲突。
// 反思（2026-08-16 第六十九次）：字幕样式 = 文字样式 × 位置样式 两维独立选择——
//   - 位置不再编码在文字样式里（删 pos 字段），改由 SUBTITLE_POSITIONS 单独选择
//     （storage.subtitlePosition，距视频底部比例 1/10~3/4）；
//   - 竖屏预览不再靠 orient 字段（改由引导页双预览：横屏 16:9 + 竖屏 9:16 各渲一遍）；
//   - 文字样式 id 保留旧值（既有用户已选的文字外观不丢，位置回落到默认 b10）。
//   annMode：side 释义行内（侧邻注释）/ detail 释义换行（新行注释）
export const SUBTITLE_TEXT_STYLES = [
  // 'none' = 默认字幕外观（深色半透明条 + 白字），不应用任何额外样式覆盖
  // 第一百二十七次：size 置 null——字号随视频高度自适应（4.5%，clamp 18-40px，
  // 由 subtitle-overlay 注入 --beaver-sub-fs）。依据调研：YouTube 默认 ≈24-28px、
  // Netflix 28-32px@1080p、Captionator polyfill 默认 4.5% 视频高；原 16px 远低于
  // 广播"帧高 1/20~1/10"下限（用户反馈"默认字号太小"）。
  { id: 'none', label: { en: 'Default', zh: '默认外观' }, font: 'sans', fg: '#ffffff', bg: 'rgba(0,0,0,0.75)', size: null, edge: null, bold: false, italic: false, shadow: false, annMode: 'side', sample: 'He passed the quiz(测验).' },
  { id: 'bottom-white-sans', label: { en: 'White / Sans', zh: '白字无衬线' }, font: 'sans', fg: '#ffffff', bg: 'rgba(0,0,0,0.6)', size: 20, edge: null, bold: false, italic: false, shadow: false, annMode: 'side', sample: 'He passed the quiz(测验).' },
  { id: 'bottom-yellow-serif', label: { en: 'Yellow / Serif', zh: '黄字衬线' }, font: 'serif', fg: '#ffeb3b', bg: 'rgba(20,10,0,0.6)', size: 26, edge: null, bold: true, italic: false, shadow: false, annMode: 'detail', sample: 'He passed the quiz.' },
  { id: 'bottom-cyan-mono', label: { en: 'Cyan / Mono', zh: '青字等宽' }, font: 'mono', fg: '#00e5ff', bg: null, size: 17, edge: '#000000', bold: false, italic: false, shadow: false, annMode: 'side', sample: 'He passed the quiz(测验).' },
  { id: 'big-bottom', label: { en: 'Huge', zh: '底部大字' }, font: 'sans', fg: '#ffffff', bg: 'rgba(0,0,0,0.75)', size: 30, edge: null, bold: true, italic: false, shadow: true, annMode: 'side', sample: 'He passed the quiz(测验).' },
  { id: 'netflix-style', label: { en: 'Streaming / White + Black Edge', zh: '流媒体式白字黑边' }, font: 'sans', fg: '#ffffff', bg: null, size: 27, edge: '#000000', bold: false, italic: false, shadow: true, annMode: 'side', sample: 'He passed the quiz(测验).' },
  { id: 'bottom-up-white', label: { en: 'White / Sans (High)', zh: '白字无衬线（偏高）' }, font: 'sans', fg: '#ffffff', bg: 'rgba(0,0,0,0.6)', size: 20, edge: null, bold: false, italic: false, shadow: true, annMode: 'side', sample: 'He passed the quiz(测验).' },
  { id: 'bottom-white-serif', label: { en: 'White / Serif (High)', zh: '白字衬线（偏高）' }, font: 'serif', fg: '#ffffff', bg: 'rgba(0,0,0,0.55)', size: 24, edge: '#000000', bold: false, italic: false, shadow: false, annMode: 'detail', sample: 'He passed the quiz.' },
  { id: 'bottom-yellow-mono', label: { en: 'Yellow / Mono (High)', zh: '黄字等宽（偏高）' }, font: 'mono', fg: '#ffeb3b', bg: 'rgba(0,0,0,0.5)', size: 20, edge: '#ff1744', bold: true, italic: false, shadow: false, annMode: 'side', sample: 'He passed the quiz(测验).' },
  { id: 'bottom-amber-glow', label: { en: 'Amber Glow', zh: '琥珀光' }, font: 'sans', fg: '#ffc107', bg: null, size: 26, edge: null, bold: true, italic: false, shadow: '0 0 6px rgba(255,193,7,.85), 0 0 14px rgba(255,193,7,.45)', annMode: 'side', sample: 'He passed the quiz(测验).' },
  { id: 'app-dark-bar', label: { en: 'App Dark Bar', zh: '深色字幕条' }, font: 'sans', fg: '#ffffff', bg: 'rgba(0,0,0,0.72)', size: 24, edge: null, bold: true, italic: false, shadow: false, annMode: 'side', sample: 'He passed the quiz(测验).' },
  { id: 'top-white-serif', label: { en: 'White / Serif', zh: '白字衬线' }, font: 'serif', fg: '#ffffff', bg: '#000000', size: 21, edge: null, bold: false, italic: false, shadow: false, annMode: 'detail', sample: 'He passed the quiz.' },
  { id: 'top-yellow-mono', label: { en: 'Yellow / Mono', zh: '黄字等宽' }, font: 'mono', fg: '#ffeb3b', bg: 'rgba(0,0,0,0.55)', size: 18, edge: null, bold: false, italic: true, shadow: false, annMode: 'side', sample: 'He passed the quiz(测验).' },
  { id: 'top-cyan-sans', label: { en: 'Cyan / Sans', zh: '青字无衬线' }, font: 'sans', fg: '#00e5ff', bg: 'rgba(0,0,0,0.5)', size: 23, edge: '#00e5ff', bold: true, italic: false, shadow: false, annMode: 'detail', sample: 'He passed the quiz.' },
  { id: 'center-white-mono', label: { en: 'White / Mono', zh: '白字等宽' }, font: 'mono', fg: '#ffffff', bg: 'rgba(0,0,0,0.55)', size: 19, edge: null, bold: false, italic: false, shadow: true, annMode: 'side', sample: 'He passed the quiz(测验).' },
  { id: 'center-yellow-sans', label: { en: 'Yellow / Sans', zh: '黄字无衬线' }, font: 'sans', fg: '#ffeb3b', bg: 'rgba(0,0,0,0.55)', size: 22, edge: '#ffffff', bold: true, italic: false, shadow: false, annMode: 'detail', sample: 'He passed the quiz.' },
  // === 竖屏/短视频场景文字样式（2026-08-16 第六十八次起，第六十九次去掉 orient 字段） ===
  // 第六十九次起：竖屏适配不靠样式字段，改由引导页"横屏+竖屏 双预览"统一展示；
  //   这 4 项仅保留外观差异，位置由 SUBTITLE_POSITIONS 独立控制。
  { id: 'portrait-bottom-white', label: { en: 'Portrait / White', zh: '竖屏·白字' }, font: 'sans', fg: '#ffffff', bg: 'rgba(0,0,0,0.65)', size: 22, edge: null, bold: false, italic: false, shadow: false, annMode: 'side', sample: 'He passed the quiz(测验).' },
  { id: 'portrait-bottom-bar', label: { en: 'Portrait / Dark Bar', zh: '竖屏·深色字幕条' }, font: 'sans', fg: '#ffffff', bg: 'rgba(0,0,0,0.8)', size: 24, edge: null, bold: true, italic: false, shadow: false, annMode: 'side', sample: 'He passed the quiz(测验).' },
  { id: 'portrait-up-cyan', label: { en: 'Portrait / Cyan', zh: '竖屏·青字' }, font: 'sans', fg: '#00e5ff', bg: 'rgba(0,0,0,0.5)', size: 21, edge: '#00e5ff', bold: true, italic: false, shadow: false, annMode: 'side', sample: 'He passed the quiz(测验).' },
  { id: 'portrait-top-serif', label: { en: 'Portrait / Serif', zh: '竖屏·衬线' }, font: 'serif', fg: '#fff8e1', bg: 'rgba(0,0,0,0.55)', size: 20, edge: null, bold: false, italic: true, shadow: false, annMode: 'detail', sample: 'He passed the quiz.' }
];

// === 字幕位置样式（距视频底部比例，subtitle-overlay 按 ratio 计算 top） ===
// 反思（2026-08-16 第六十九次）：位置与文字样式解耦——用户选文字样式 + 选位置，
//   引导页双预览（横屏 16:9 / 竖屏 9:16）与 overlay 都以同一 ratio 渲染，所见即所得。
//   ratio = 字幕框中心线距视频底部的高度占视频高度比例（0.1=贴底 … 0.75=接近顶部）。
export const SUBTITLE_POSITIONS = [
  { id: 'b10', label: { en: 'Bottom 1/10', zh: '下1/10' }, ratio: 0.1 },
  { id: 'b20', label: { en: 'Bottom 1/5', zh: '下1/5' }, ratio: 0.2 },
  { id: 'b25', label: { en: 'Bottom 1/4', zh: '下1/4' }, ratio: 0.25 },
  { id: 'b33', label: { en: 'Bottom 1/3', zh: '下1/3' }, ratio: 1 / 3 },
  { id: 'b50', label: { en: 'Center', zh: '正中' }, ratio: 0.5 },
  { id: 'b75', label: { en: 'Top 1/4', zh: '上1/4' }, ratio: 0.75 }
];

// 取当前界面语言下的样式短名
export function styleLabel(st, lang) {
  if (!st || !st.label) return '';
  return (lang === 'zh') ? st.label.zh : st.label.en;
}

// 查找样式项（按 id，找不到返回 null）
export function findStyle(list, id) {
  if (!Array.isArray(list) || !id) return null;
  return list.find((s) => s.id === id) || null;
}
