// VocabRadar 样式预设（统一样式候选池 / 字幕样式 / 位置样式 / 注释模板工具）
//
// 反思（2026-08-16 第七十次）：构建版本戳——引导页头部与 overlay 启动日志都打印本值。
//   用户反馈"edge中你把默认样式改了，撤销，要跟其他浏览器一样"、设定栏"实际有样式但一个都没选"，
//   这些疑似旧构建内容脚本未随扩展重载所致。加本戳后，若 overlay 日志版本 ≠ 引导页头部版本，
//   即可判定为旧构建残留（需重载扩展并刷新视频页），不用再猜。
// 272次（用户裁定"引导页的 vv82 改为 v{修改时间}"）：BUILD_STAMP 改为构建时刻戳——
//   源码里是占位符 __BUILD_STAMP__，scripts/build.mjs 的 stampBuild() 在打包前把它
//   统一替换为 v{yyyyMMdd.HHmm}（本地时间，dist 全部 js 含 chunk 一并替换）；
//   显示处直接用 BUILD_STAMP（guide.js/subtitle-overlay.js 均不再自加 'v' 前缀），
//   直接加载未构建源码时显示占位符即"未注入"信号。
// 279次：ANN_STYLES 重构为三处共享候选池；VANN_STYLES 删除改迁移映射；
//   SUBTITLE_TEXT_STYLES 增补 6 条流行字幕样式。
// 280次（用户裁定"候选池合并，右侧不区分生词和侧邻；两文档样式全录；括号改模板"）：
//   1. TEXT_STYLES(14) 与 ANN_STYLES(17) 合并为单一"统一样式候选池" POOL_STYLES——
//      每条同时含生词区字段（wordBg/wordFg/deco/stroke/emphasis/gradient…）与
//      侧邻注释区字段（annBg/annFg/radius/fontSize），一条样式管两个区域；
//      TEXT_STYLES / ANN_STYLES 保留为同一数组的别名导出，既有 import 不用改；
//   2. 文档《各家阅读提示，生词标注样式.html》13 项（LingQ/Readex/微信读书/Kindle/
//      扇贝/不背单词/Relingo/组合）与《文字标注样式调研.html》21 项（s1~s21）全数录入，
//      视觉重复者去重（s2=马克笔半高、s4=微信波浪线、s12=微读红字、s14=蓝光）；
//   3. 新增字段模型（见 POOL_STYLES 注释）与共享 CSS 生成器 buildAnnPoolCss——
//      两处侧栏的手写 16 条 CSS（sidebar.css / web-sidebar.css）由生成器取代；
//   4. annBrackets 布尔开关退役，改 annTemplate 字符串模板（280次默认 {word}({meaning})；
//      284次默认改为 {target} {annotation}，旧变量名兼容），
//      导出 splitAnnTemplate / renderAnnText / migrateAnnBrackets 工具；
//   5. SUBTITLE_TEXT_STYLES 再增补 4 条调研所得流行字幕样式。
export const BUILD_STAMP = '__BUILD_STAMP__';

// ================================================================
// 统一样式候选池（网页提示 textStyle / 文本侧栏 annotationStyle / 视频侧栏
// videoAnnotationStyle 三键共用同一 id 集；一条样式同时定义生词区与注释区外观）
// ================================================================
// 字段模型（280次定稿）：
//   - id：storage 保存标识（'none'=默认配色，不应用额外样式）
//   - label：中英文短名（引导页卡小字）
//   生词区：
//   - wordBg/wordFg：背景/前景（支持 gradient 字符串，页面经 --beaver-first-bg 变量生效）
//   - radius：圆角（生词区与注释区共用）
//   - bold/italic/underline：旧布尔字段（bold=600）
//   - shadow：text-shadow（生词区）
//   - wordWeight：数字字重（覆盖 bold，如不背单词 800）
//   - wordPadding/wordPaddingBottom：内边距（徽章/kbd/SVG 波浪）
//   - wordBorder/wordBorderBottom/wordBorderLeft：边框（虚线框/左侧竖条/kbd）
//   - deco：{line,color,style,width,offset} 结构化 text-decoration（实线/虚线/波浪/
//     点状/双线/删除线/上划线）
//   - wordStroke：-webkit-text-stroke 简写（描边空心字，配 wordFg:'transparent'）
//   - wordGradient：background-clip:text 渐变字（配 wordFg:'transparent'）
//   - wordBgImage/wordBgSize：背景图（SVG 手绘波浪 dataURI，repeat-x bottom）
//   - wordEmphasis/emphasisPosition：text-emphasis 着重号
//   - wordMono：等宽字体（kbd）
//   - wordFontSize/wordLetterSpacing：字号/字距
//   - wordAnimation：动画名（blink → 生成器注入 @keyframes beaver-ann-blink）
//   注释区：
//   - annBg/annFg：背景/前景；fontSize：字号（仅注释区）
//   - 无显式 annBg/annFg 的条目由消费方派生（th/core.pickColors 前后景互换逻辑）
export const POOL_STYLES = [
  // 'none' = 使用默认配色（生词绿底白字/注释白底绿字），不应用任何额外样式覆盖
  { id: 'none', label: { en: 'Default', zh: '默认配色' } },

  // ---- 原 ANN_STYLES 16 条（279次共享池骨架，参数原样保留） ----
  { id: 'mint', label: { en: 'Mint', zh: '薄荷' }, wordBg: '#a8e6cf', wordFg: '#0d2014', annBg: '#0d2014', annFg: '#ffffff', radius: '999px', bold: true },
  { id: 'gold', label: { en: 'Gold', zh: '鎏金' }, wordBg: '#ffd54f', wordFg: '#332700', annBg: '#fff8e1', annFg: '#8a6d00', radius: '2px', bold: true, fontSize: '15px' },
  { id: 'marker', label: { en: 'Marker', zh: '荧光笔' }, wordBg: 'rgba(255,213,79,.45)', wordFg: '#332700', annBg: 'transparent', annFg: '#b28704', radius: '0', bold: true },
  { id: 'red-underline', label: { en: 'Red Underline', zh: '红下划线' }, wordBg: 'transparent', wordFg: '#d81b60', annBg: 'transparent', annFg: '#d81b60', radius: '0', underline: true },
  { id: 'plain', label: { en: 'Plain', zh: '素字' }, wordBg: 'transparent', wordFg: '#1565c0', annBg: 'transparent', annFg: '#1565c0', radius: '0' },
  { id: 'capsule', label: { en: 'Blue Capsule', zh: '胶囊蓝' }, wordBg: '#64b5f6', wordFg: '#0d1b33', annBg: '#0d1b33', annFg: '#64b5f6', radius: '999px', bold: true },
  { id: 'shadow-pop', label: { en: 'Shadow Pop', zh: '立体' }, wordBg: '#6d4c41', wordFg: '#fff8f0', annBg: '#fff8f0', annFg: '#6d4c41', radius: '3px', bold: true, shadow: '0 2px 3px rgba(0,0,0,.45), 0 5px 8px rgba(0,0,0,.25)' },
  { id: 'ink', label: { en: 'Ink', zh: '墨蓝' }, wordBg: '#263238', wordFg: '#eceff1', annBg: '#eceff1', annFg: '#263238', radius: '2px', bold: true, fontSize: '12px' },
  { id: 'night', label: { en: 'Night', zh: '暗夜' }, wordBg: '#37474f', wordFg: '#ffcc80', annBg: '#ffcc80', annFg: '#37474f', radius: '2px', bold: true },
  { id: 'outline', label: { en: 'Outline', zh: '描边字' }, wordBg: 'transparent', wordFg: '#1a237e', annBg: 'transparent', annFg: '#1a237e', radius: '0', bold: true, shadow: '0 1px 0 #fff, 0 -1px 0 #fff, 1px 0 0 #fff, -1px 0 0 #fff, 0 2px 3px rgba(0,0,0,.5)' },
  { id: 'sunset', label: { en: 'Sunset', zh: '落日橙' }, wordBg: '#ff6d00', wordFg: '#ffffff', annBg: '#ffffff', annFg: '#ff6d00', radius: '4px', bold: true, shadow: '0 1px 2px rgba(255,109,0,.4)' },
  { id: 'snow', label: { en: 'Snow', zh: '雪原' }, wordBg: '#ffffff', wordFg: '#1a1f1a', annBg: '#1a1f1a', annFg: '#ffffff', radius: '2px', bold: true, shadow: '0 1px 2px rgba(0,0,0,.35)', fontSize: '16px' },
  { id: 'glacier', label: { en: 'Glacier', zh: '冰川' }, wordBg: '#4dd0e1', wordFg: '#002f36', annBg: '#002f36', annFg: '#4dd0e1', radius: '2px', fontSize: '18px' },
  { id: 'violet', label: { en: 'Violet', zh: '紫罗兰' }, wordBg: '#b388ff', wordFg: '#12002e', annBg: '#12002e', annFg: '#b388ff', radius: '6px', italic: true },
  { id: 'raspberry', label: { en: 'Raspberry', zh: '覆盆子' }, wordBg: '#f06292', wordFg: '#33000f', annBg: '#33000f', annFg: '#f06292', radius: '4px', italic: true, bold: true },
  { id: 'cyan-glass', label: { en: 'Cyan Glass', zh: '青玻璃' }, wordBg: '#00e5ff', wordFg: '#001318', annBg: 'rgba(0,0,0,.88)', annFg: '#00e5ff', radius: '2px', bold: true, shadow: '0 0 4px rgba(0,229,255,.5)' },

  // ---- 原 TEXT_STYLES 独有 5 条（outline-light 与 outline 近似并入） ----
  { id: 'comic', label: { en: 'Comic', zh: '手写' }, wordBg: '#fff176', wordFg: '#5d4037', annBg: '#5d4037', annFg: '#fff176', radius: '0', italic: true, bold: true, shadow: '0 1px 2px rgba(93,64,55,.4)' },
  { id: 'rose-underline', label: { en: 'Rose Underline', zh: '玫红下划线' }, wordBg: 'transparent', wordFg: '#e91e63', annBg: 'transparent', annFg: '#e91e63', radius: '0', underline: true, shadow: '0 1px 0 #e91e63' },
  { id: 'bold-underline', label: { en: 'Bold Underline', zh: '粗下划线' }, wordBg: 'transparent', wordFg: '#00695c', annBg: 'transparent', annFg: '#00695c', radius: '0', underline: true, bold: true, shadow: '0 1px 0 #00897b' },
  { id: 'glow-blue', label: { en: 'Blue Glow', zh: '蓝光' }, wordBg: 'transparent', wordFg: '#1565c0', annBg: 'transparent', annFg: '#1565c0', radius: '0', shadow: '0 0 4px rgba(21,101,192,.7), 0 0 8px rgba(21,101,192,.4)' },
  { id: 'glow-amber', label: { en: 'Amber Glow', zh: '金光' }, wordBg: 'transparent', wordFg: '#e65100', annBg: 'transparent', annFg: '#e65100', radius: '0', shadow: '0 0 4px rgba(255,160,0,.8), 0 0 10px rgba(255,160,0,.45)' },

  // ---- 文档《各家阅读提示，生词标注样式.html》13 项全录（280次） ----
  // LingQ：颜色管理词汇状态——蓝=系统新词、黄=已收藏
  { id: 'lingq-blue', label: { en: 'LingQ Blue', zh: 'LingQ 蓝' }, wordBg: '#dbeafe', wordFg: '#1e3a8a', annBg: 'transparent', annFg: '#1d4ed8', radius: '2px', wordPadding: '1px 3px' },
  { id: 'lingq-yellow', label: { en: 'LingQ Yellow', zh: 'LingQ 黄' }, wordBg: '#fde68a', wordFg: '#78350f', annBg: 'transparent', annFg: '#b45309', radius: '2px', wordPadding: '1px 3px' },
  // Readex：词库已有词黄色高亮
  { id: 'readex-yellow', label: { en: 'Readex Yellow', zh: 'Readex 黄' }, wordBg: '#fef08a', wordFg: '#713f12', annBg: 'transparent', annFg: '#a16207', radius: '2px', wordPadding: '1px 3px' },
  // 微信读书马克笔（半高）/ 调研 s2：仅绘制渐变不重排
  { id: 'marker-half', label: { en: 'Half Marker', zh: '马克笔半高' }, wordBg: 'linear-gradient(transparent 55%, #ffe066 55%)', wordFg: '#332700', annBg: 'transparent', annFg: '#b28704', radius: '0', bold: true },
  // Kindle：黑色实线下划线（词色保持近黑）
  { id: 'kindle-underline', label: { en: 'Kindle Line', zh: 'Kindle 实线' }, wordBg: 'transparent', wordFg: '#374151', annBg: 'transparent', annFg: '#374151', radius: '0', deco: { line: 'underline', color: '#374151', width: '1.5px', offset: '4px' } },
  // 扇贝阅读：绿色虚线（词色取绿系可读色）
  { id: 'shanbei-dashed', label: { en: 'Shanbei Dashed', zh: '扇贝虚线' }, wordBg: 'transparent', wordFg: '#15803d', annBg: 'transparent', annFg: '#15803d', radius: '0', deco: { line: 'underline', style: 'dashed', color: '#22c55e', width: '1.5px', offset: '5px' } },
  // 微信读书波浪线（三级）/ 调研 s4：红色波浪，正文色不变（此处取近黑保可读）
  { id: 'wx-wavy', label: { en: 'Wavy Line', zh: '微信波浪线' }, wordBg: 'transparent', wordFg: '#1f2937', annBg: 'transparent', annFg: '#ef4444', radius: '0', deco: { line: 'underline', style: 'wavy', color: '#ef4444', width: '1.5px', offset: '5px' } },
  // 不背单词：加粗标记（800 重字重）
  { id: 'bbdc-bold', label: { en: 'Heavy Bold', zh: '不背加粗' }, wordBg: 'transparent', wordFg: '#1a1d26', annBg: 'transparent', annFg: '#1a1d26', radius: '0', wordWeight: 800 },
  // 微信读书彩色批注（红/紫/绿）/ 调研 s12 同族去重
  { id: 'wx-red', label: { en: 'WeRead Red', zh: '微读红字' }, wordBg: 'transparent', wordFg: '#ef4444', annBg: 'transparent', annFg: '#ef4444', radius: '0', wordWeight: 500 },
  { id: 'wx-purple', label: { en: 'WeRead Purple', zh: '微读紫字' }, wordBg: 'transparent', wordFg: '#8b5cf6', annBg: 'transparent', annFg: '#8b5cf6', radius: '0', wordWeight: 500 },
  { id: 'wx-green', label: { en: 'WeRead Green', zh: '微读绿字' }, wordBg: 'transparent', wordFg: '#10b981', annBg: 'transparent', annFg: '#10b981', radius: '0', wordWeight: 500 },
  // Relingo：右侧橙色行内注解小圆角块
  { id: 'relingo', label: { en: 'Relingo Chip', zh: 'Relingo 注解' }, wordBg: 'transparent', wordFg: '#c2410c', annBg: '#fff7ed', annFg: '#f97316', radius: '4px', fontSize: '12px' },
  // 组合：黄色背景 + 红色波浪线
  { id: 'combo', label: { en: 'Highlight + Wavy', zh: '高亮加波浪' }, wordBg: '#fef3c7', wordFg: '#92400e', annBg: 'transparent', annFg: '#ef4444', radius: '2px', wordPadding: '0 2px', deco: { line: 'underline', style: 'wavy', color: '#ef4444', width: '1.5px', offset: '4px' } },

  // ---- 文档《文字标注样式调研.html》21 项全录（280次；s2/s4/s12/s14 与上文重合去重） ----
  // s1 背景色高亮
  { id: 'highlight-yellow', label: { en: 'Yellow Highlight', zh: '黄底高亮' }, wordBg: '#fff3a3', wordFg: '#713f12', annBg: 'transparent', annFg: '#a16207', radius: '3px', wordPadding: '1px 3px' },
  // s3 彩色加粗下划线
  { id: 'thick-underline', label: { en: 'Thick Underline', zh: '加粗下划线' }, wordBg: 'transparent', wordFg: '#9f1239', annBg: 'transparent', annFg: '#ff4d6d', radius: '0', deco: { line: 'underline', color: '#ff4d6d', width: '3px', offset: '4px' } },
  // s5 点状下划线
  { id: 'dotted-underline', label: { en: 'Dotted Underline', zh: '点状下划线' }, wordBg: 'transparent', wordFg: '#4338ca', annBg: 'transparent', annFg: '#6366f1', radius: '0', deco: { line: 'underline', style: 'dotted', color: '#6366f1', width: '2px', offset: '5px' } },
  // s6 双下划线
  { id: 'double-underline', label: { en: 'Double Underline', zh: '双下划线' }, wordBg: 'transparent', wordFg: '#0369a1', annBg: 'transparent', annFg: '#0ea5e9', radius: '0', deco: { line: 'underline', style: 'double', color: '#0ea5e9', offset: '5px' } },
  // s7 删除线
  { id: 'line-through', label: { en: 'Line Through', zh: '删除线' }, wordBg: 'transparent', wordFg: '#7f1d1d', annBg: 'transparent', annFg: '#ef4444', radius: '0', deco: { line: 'line-through', color: '#ef4444', width: '2px' } },
  // s8 上划线
  { id: 'overline', label: { en: 'Overline', zh: '上划线' }, wordBg: 'transparent', wordFg: '#92400e', annBg: 'transparent', annFg: '#f59e0b', radius: '0', deco: { line: 'overline', color: '#f59e0b', width: '2px' } },
  // s9 虚线边框包裹
  { id: 'dashed-box', label: { en: 'Dashed Box', zh: '虚线边框' }, wordBg: '#f5f3ff', wordFg: '#4338ca', annBg: '#4338ca', annFg: '#f5f3ff', radius: '6px', wordPadding: '1px 7px', wordBorder: '1px dashed #6366f1' },
  // s10 左侧竖条（引用块）
  { id: 'left-bar', label: { en: 'Left Bar', zh: '左侧竖条' }, wordBg: '#f0fdf4', wordFg: '#166534', annBg: '#166534', annFg: '#f0fdf4', radius: '0 6px 6px 0', wordPadding: '2px 10px', wordBorderLeft: '3px solid #22c55e' },
  // s11 圆角标签/徽章
  { id: 'badge', label: { en: 'Badge', zh: '圆角徽章' }, wordBg: '#e0e7ff', wordFg: '#4338ca', annBg: '#4338ca', annFg: '#e0e7ff', radius: '999px', wordFontSize: '.82em', wordWeight: 600, wordPadding: '2px 10px', fontSize: '12px' },
  // s13 加粗 + 斜体
  { id: 'bold-italic', label: { en: 'Bold Italic', zh: '粗斜体' }, wordBg: 'transparent', wordFg: '#1f2430', annBg: 'transparent', annFg: '#1f2430', radius: '0', wordWeight: 800, italic: true, wordLetterSpacing: '.02em' },
  // s15 描边空心字（前景透明 + text-stroke）
  { id: 'hollow', label: { en: 'Hollow Stroke', zh: '描边空心' }, wordBg: 'transparent', wordFg: 'transparent', annBg: 'transparent', annFg: '#ef4444', radius: '0', wordStroke: '1px #ef4444', wordWeight: 700 },
  // s16 着重号 text-emphasis（词下方圆点，只绘制不重排）
  { id: 'emphasis-dot', label: { en: 'Emphasis Dot', zh: '着重号' }, wordBg: 'transparent', wordFg: '#1f2430', annBg: 'transparent', annFg: '#ef4444', radius: '0', wordEmphasis: 'filled dot #ef4444', emphasisPosition: 'under right' },
  // s17 键盘按键 kbd 样式
  { id: 'kbd', label: { en: 'Kbd Key', zh: '键盘按键' }, wordBg: '#f9fafb', wordFg: '#374151', annBg: '#374151', annFg: '#f9fafb', radius: '5px', wordMono: true, wordFontSize: '.82em', wordPadding: '2px 7px', wordBorder: '1px solid #d5d9e2', wordBorderBottom: '3px solid #d5d9e2' },
  // s18 反白/遮罩高亮
  { id: 'inverted', label: { en: 'Inverted', zh: '反白' }, wordBg: '#111827', wordFg: '#ffffff', annBg: '#f9fafb', annFg: '#111827', radius: '3px', wordPadding: '1px 6px' },
  // s19 手绘波浪底线（SVG dataURI 平铺）
  { id: 'svg-wavy', label: { en: 'SVG Wavy', zh: '手绘波浪' }, wordBg: 'transparent', wordFg: '#9f1239', annBg: 'transparent', annFg: '#f43f5e', radius: '0', wordBgImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='8' viewBox='0 0 60 8'%3E%3Cpath d='M0 5 Q7.5 1 15 5 T30 5 T45 5 T60 5' fill='none' stroke='%23f43f5e' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E\")", wordBgSize: '60px 8px', wordPaddingBottom: '7px' },
  // s20 渐变文字（background-clip:text）
  { id: 'gradient-text', label: { en: 'Gradient Text', zh: '渐变文字' }, wordBg: 'transparent', wordFg: 'transparent', annBg: 'transparent', annFg: '#ec4899', radius: '0', wordGradient: 'linear-gradient(90deg,#6366f1,#ec4899)', wordWeight: 700 },
  // s21 闪烁高亮（生成器注入 @keyframes beaver-ann-blink）
  { id: 'blink', label: { en: 'Blink', zh: '闪烁高亮' }, wordBg: '#fde68a', wordFg: '#713f12', annBg: 'transparent', annFg: '#b45309', radius: '3px', wordPadding: '1px 3px', wordAnimation: 'beaver-ann-blink' }
];

// 280次：别名导出——既有消费点（th/core.js 生成页面类、pickColors 取注释色、
// guide.js 渲染网格）import 的 TEXT_STYLES / ANN_STYLES 无需改动。
// 两者现在是同一个统一池：网页提示与侧栏可互相选任意条目（多对多）。
export const TEXT_STYLES = POOL_STYLES;
export const ANN_STYLES = POOL_STYLES;

// === 视频侧栏旧样式 → 共享池迁移映射（279次，VANN_STYLES 废弃） ===
// guide.js 启动时若读到旧键 videoAnnotationStyle：映射为池内最近似 id 写入
// annotationStyle（池中无对应/'none' 值 = 阴间样式舍弃，回落默认配色），
// 随后 chrome.storage.local.remove('videoAnnotationStyle') 一次性清理。
// 280次注：videoAnnotationStyle 键复活（三功能独立选样式），本迁移只在
// 引导页对"迁移后从未再设置"的旧值做一次回落式处理，详见 guide.js。
export const VANN_TO_ANN_MIGRATION = {
  'lime-tight': 'none',
  sunset: 'sunset',
  plain: 'plain',
  underline: 'red-underline',
  capsule: 'capsule',
  big: 'none',
  snow: 'snow',
  glacier: 'glacier',
  violet: 'violet',
  ember: 'none',
  mustard: 'none',
  seafoam: 'glacier',
  raspberry: 'raspberry',
  'cyan-glass': 'cyan-glass',
  brick: 'none'
};

// ================================================================
// 注释模板（280次：annBrackets 布尔退役 → annTemplate 字符串模板）
// ================================================================
// 模板变量：{target}=目标文本（旧名 {word}，兼容）、{annotation}=注释（旧名 {meaning}，兼容）。
// 284次（用户裁定）：默认组合改为 {target} {annotation}——目标文本后接空格再接注释
//   （渲染如「apple 苹果」）。旧模板 {word}{meaning} / {word}({meaning}) 仍可解析。
// 侧邻注释渲染时目标 span 已独立存在，{target} token 被丢弃（不重复输出），
// 即渲染结果 = {annotation} 前后的字面量（pre + 注释 + post）。
// 详细模式（注释另起一行）保持"词头+注释"结构，不套模板（维持现状）。
export const DEFAULT_ANN_TEMPLATE = '{target} {annotation}';

/** 拆分模板为 {annotation} 前后字面量；{target} 丢弃（兼容旧 {word}/{meaning}） */
export function splitAnnTemplate(tpl) {
  const t = (typeof tpl === 'string' && tpl.trim()) ? tpl : DEFAULT_ANN_TEMPLATE;
  const marked = t.split('{annotation}').join('\x00').split('{meaning}').join('\x00')
    .split('{target}').join('').split('{word}').join('');
  const i = marked.indexOf('\x00');
  if (i === -1) return { pre: marked, post: '' };
  return { pre: marked.slice(0, i), post: marked.slice(i + 1) };
}

/** 用释义渲染侧邻注释文本：pre + meaning + post */
export function renderAnnText(tpl, meaning) {
  const { pre, post } = splitAnnTemplate(tpl);
  return pre + (meaning || '') + post;
}

/** 旧 annBrackets 布尔 → 模板（true/缺省 = 默认组合，false = 素注释无目标） */
export function migrateAnnBrackets(v) {
  return v === false ? '{annotation}' : DEFAULT_ANN_TEMPLATE;
}

// ================================================================
// 共享 CSS 生成器（280次：取代 sidebar.css / web-sidebar.css 手写 16 条 ×2）
// ================================================================

/** 生词区 CSS 声明数组。opts.important=true 时带 !important（侧栏覆盖用）；
 *  opts.colors=false 时不含 background/color（网页提示用——颜色走 --beaver-first-* 变量，
 *  由 pickColors 显式设置 > 池条目 > 默认的优先级派生，渐变/透明底同样经变量生效） */
export function wordDecl(s, opts = {}) {
  const important = opts.important === true;
  const p = important ? ' !important' : '';
  const d = [];
  if (opts.colors !== false && s.wordBg !== undefined) d.push(`background:${s.wordBg}${p}`);
  if (opts.colors !== false && s.wordFg !== undefined) d.push(`color:${s.wordFg}${p}`);
  // colors=false（网页提示）时 wordGradient 不输出 background——页面背景统一走
  //   --beaver-first-bg 变量（渐变字符串经 FIRST_CLASS 的 background shorthand 生效，
  //   且不会以更高特异性覆盖 .beaver-hide-later 的隐藏规则），只输出 clip 声明。
  if (s.wordGradient) {
    if (opts.colors !== false) d.push(`background:${s.wordGradient}${p}`);
    d.push(`-webkit-background-clip:text${p}`);
    d.push(`background-clip:text${p}`);
    if (s.wordFg === undefined) d.push(`color:transparent${p}`);
  }
  if (s.radius) d.push(`border-radius:${s.radius}${p}`);
  if (s.bold) d.push(`font-weight:600${p}`);
  if (s.wordWeight) d.push(`font-weight:${s.wordWeight}${p}`);
  if (s.italic) d.push(`font-style:italic${p}`);
  if (s.underline) d.push(`text-decoration:underline${p}`);
  if (s.deco) {
    const { line, color, style, width, offset } = s.deco;
    d.push(`text-decoration:${[line, style, color].filter(Boolean).join(' ')}${p}`);
    if (width) d.push(`text-decoration-thickness:${width}${p}`);
    if (offset) d.push(`text-underline-offset:${offset}${p}`);
  }
  if (s.shadow) d.push(`text-shadow:${s.shadow}${p}`);
  if (s.wordStroke) d.push(`-webkit-text-stroke:${s.wordStroke}${p}`);
  if (s.wordBgImage) {
    d.push(`background-image:${s.wordBgImage}${p}`);
    d.push(`background-repeat:repeat-x${p}`);
    d.push(`background-position:left bottom${p}`);
    d.push(`background-size:${s.wordBgSize || '60px 8px'}${p}`);
  }
  if (s.wordPadding) d.push(`padding:${s.wordPadding}${p}`);
  if (s.wordPaddingBottom) d.push(`padding-bottom:${s.wordPaddingBottom}${p}`);
  if (s.wordBorder) d.push(`border:${s.wordBorder}${p}`);
  if (s.wordBorderBottom) d.push(`border-bottom:${s.wordBorderBottom}${p}`);
  if (s.wordBorderLeft) d.push(`border-left:${s.wordBorderLeft}${p}`);
  if (s.wordMono) d.push(`font-family:ui-monospace,Consolas,monospace${p}`);
  if (s.wordFontSize) d.push(`font-size:${s.wordFontSize}${p}`);
  if (s.wordLetterSpacing) d.push(`letter-spacing:${s.wordLetterSpacing}${p}`);
  if (s.wordEmphasis) {
    d.push(`text-emphasis:${s.wordEmphasis}${p}`);
    d.push(`text-emphasis-position:${s.emphasisPosition || 'under right'}${p}`);
  }
  if (s.wordAnimation) d.push(`animation:${s.wordAnimation} 1.4s ease-in-out infinite${p}`);
  return d;
}

/** 注释区 CSS 声明数组（bg/fg/radius/fontSize/italic） */
export function annDecl(s, opts = {}) {
  const p = opts.important === true ? ' !important' : '';
  const d = [];
  if (s.annBg !== undefined) d.push(`background:${s.annBg}${p}`);
  if (s.annFg !== undefined) d.push(`color:${s.annFg}${p}`);
  if (s.radius) d.push(`border-radius:${s.radius}${p}`);
  if (s.fontSize) d.push(`font-size:${s.fontSize}${p}`);
  if (s.italic) d.push(`font-style:italic${p}`);
  return d;
}

/** 生成一个容器的统一池样式表（280次）。
 *  入参为该容器内部既有类名（三类，同 279 次手写 CSS 的选择器）：
 *    root：容器选择器（如 '#beaver-sidebar'），池类 beaver-ann-style-{id} 挂在它上；
 *    word：生词块选择器（含祖先，如 '.beaver-sub-text .beaver-word'）；
 *    annInline：行内注释选择器（如 '.beaver-ann-inline'）；
 *    annWord：详细注释词头选择器（如 '.beaver-ann-line .beaver-ann-word'）。
 *  颜色与字体属性全部 !important（覆盖容器基础配色），与手写版行为一致。 */
export function buildAnnPoolCss({ root, word, annInline, annWord }) {
  const parts = [];
  for (const s of POOL_STYLES) {
    if (s.id === 'none') continue;
    const wd = wordDecl(s, { important: true }).join(';');
    const ad = annDecl(s, { important: true }).join(';');
    parts.push(`${root} ${word}{${wd};}`);
    parts.push(`${root} ${annInline},${root} ${annWord}{${ad};}`);
  }
  // blink 动画 keyframes（s21；动画只改 background-color，覆盖 !important 静态底色）
  parts.push('@keyframes beaver-ann-blink{0%,100%{background-color:#fde68a}50%{background-color:transparent}}');
  return parts.join('\n');
}

// === 字幕文字样式（视频内字幕外观，class style-{id} 定义在 subtitle-overlay.js） ===
// 反思（2026-08-16 第六十九次）：字幕样式 = 文字样式×位置样式 两维独立选择——
//   位置不编码在文字样式里，改由 SUBTITLE_POSITIONS 单独选择（storage.subtitlePosition）。
// 281次：精简内置条目；残留旧 id 由 sanitizeStyleId 回落 'none'（渲染端 findStyle
//   找不到即用首项，不会崩）。字幕正文样式只管字幕正文——注释（释义行）外观改由
//   样式池第四栏 subtitle hints on video（storage.videoOverlayAnnStyle 池条目）单独控制。
// 283次（用户裁定"选最流行的十种字幕样式，按照流行度排列，包括最流行产品的字幕样式，
//   只管字幕正文，不牵扯注释"）：十条重选——YouTube 官方默认、Netflix 官方、
//   TikTok Hormozi 大字（海外最火的字幕流派）、TikTok 卡拉OK黄、TikTok 极简、
//   短视频竖屏大字描边、字幕组黄字黑边、CapCut 优雅斜体、电影衬线描边、立体弹幕。
//   按流行度降序排列；全部 annMode:'side'（正文样式不牵扯注释布局）。
//   字段仍限 bg/fg/sizePct/font/weight/bold/italic/edge/shadow——shadow 支持字符串
//   （第六十四次），pop3d 借此实现硬阴影立体字。
// 293次（用户"字号用百分比"）：size（px）→ 百分比（Netflix 只用百分比、
//   BBC 行高 8%、ASS 相对 PlayResY、YouTube 按默认倍率，见调研）：换算基准
//   SUBTITLE_REF_H=540（px 时代设计短边，16:9 下即高度；22→4、24→4.5、26→5、28→5、
//   30→5.5、32→6，karaoke/fancy/pop3d 较旧值 ±1px，540p 下观感一致）。
// 297次百分比基线（298次：改回统一视频高，短边方案作废）：换算基准
//   SUBTITLE_REF_H=540（px 时代设计高）；缺省默认 5%。旧 size 键不再读取。
export const SUBTITLE_REF_H = 540;
// px（旧）→ 视频高百分比（custom 控件/用户样式 2-12%）
// 297次：缺省默认 5%（298次：基线改回统一视频高）。
export function pxToSizePct(px) {
  const n = Number(px);
  if (!isFinite(n)) return 5;
  return Math.min(12, Math.max(2, Math.round(n / SUBTITLE_REF_H * 100 * 2) / 2));
}
// 视频高百分比 → px（297次：clamp 系失真（用户原话），删除——大小屏纯比例，
//   与 Netflix/BBC 无钳制口径一致；refH 缺省 540 设计高；缺省默认 5%）。
// 298次（用户笔误纠正）：基线改回统一视频高（短边方案作废）。
export function sizePctToPx(pct, refH) {
  const h = (typeof refH === 'number' && refH > 0) ? refH : SUBTITLE_REF_H;
  const p = (typeof pct === 'number' && isFinite(pct)) ? pct : 5;
  return Math.round(p / 100 * h);
}
// 条目字号百分比统一入口（fontSizePct 优先 → 293-294 过渡 sizePct → 旧 fontSize px 换算 → 缺省）
// 295次（用户"那就fontSizePct吧"）：参数名统一为 fontSizePct。
// 297次：缺省默认 5%。
export function subFontSizePct(item) {
  if (item && typeof item.fontSizePct === 'number' && isFinite(item.fontSizePct)) return item.fontSizePct;
  if (item && typeof item.sizePct === 'number' && isFinite(item.sizePct)) return item.sizePct;
  if (item && item.fontSize !== undefined) return pxToSizePct(item.fontSize);
  return 5;
}
export const SUBTITLE_TEXT_STYLES = [
  // 'none' = 默认字幕外观（深色半透明条 + 白字），不应用任何额外样式覆盖
  { id: 'none', label: { en: 'Default', zh: '默认外观' }, font: 'sans', fg: '#ffffff', bg: 'rgba(0,0,0,0.75)', fontSizePct: 5, edge: null, bold: false, italic: false, shadow: false, annMode: 'side', sample: 'He passed the quiz.' },
  // 1. YouTube 官方默认：白字 + 黑半透明底（全球覆盖面最大的字幕样式）
  { id: 'yt-box', label: { en: 'YouTube', zh: 'YouTube 底条' }, font: 'sans', fg: '#ffffff', bg: 'rgba(8,8,8,0.75)', fontSizePct: 4, edge: null, bold: false, italic: false, shadow: false, annMode: 'side', sample: 'He passed the quiz.' },
  // 2. Netflix 官方：白字 + 软阴影（无底条，阴影保证亮暗场景均可读）
  { id: 'netflix', label: { en: 'Netflix', zh: 'Netflix 阴影' }, font: 'sans', fg: '#ffffff', bg: null, fontSizePct: 4.5, edge: null, bold: false, italic: false, shadow: '0 1px 3px rgba(0,0,0,.9),0 0 8px rgba(0,0,0,.7)', annMode: 'side', sample: 'He passed the quiz.' },
  // 3. TikTok Hormozi 大字：特粗 Impact 白字 + 黑底（Alex Hormozi 带火的短视频字幕流派）
  { id: 'hormozi', label: { en: 'Hormozi Big', zh: 'Hormozi 大字' }, font: 'impact', fg: '#ffffff', bg: 'rgba(0,0,0,0.92)', fontSizePct: 6, edge: null, bold: false, italic: false, shadow: false, weight: 800, annMode: 'side', sample: 'He passed the quiz.' },
  // 4. TikTok 卡拉OK：黄字 + 黑底（逐词高亮字幕的经典配色）
  { id: 'karaoke', label: { en: 'Karaoke Yellow', zh: '卡拉OK黄' }, font: 'sans', fg: '#ffe135', bg: 'rgba(0,0,0,0.88)', fontSizePct: 5, edge: null, bold: true, italic: false, shadow: false, annMode: 'side', sample: 'He passed the quiz.' },
  // 5. TikTok 极简：纯白字无装饰（最克制，不遮挡画面）
  { id: 'minimal', label: { en: 'Minimal White', zh: '极简白字' }, font: 'sans', fg: '#ffffff', bg: null, fontSizePct: 4.5, edge: null, bold: false, italic: false, shadow: false, annMode: 'side', sample: 'He passed the quiz.' },
  // 6. 短视频竖屏大字：特粗白字黑描边（无底条）
  { id: 'shorts-big', label: { en: 'Shorts Big', zh: '短视频大字' }, font: 'sans', fg: '#ffffff', bg: null, fontSizePct: 5.5, edge: '#000000', bold: false, italic: false, shadow: false, weight: 800, annMode: 'side', sample: 'He passed the quiz.' },
  // 7. 字幕组经典：黄字黑描边（人人影视/射手年代沿用至今）
  { id: 'edge-yellow', label: { en: 'Fansub Yellow', zh: '字幕组黄边' }, font: 'sans', fg: '#ffd60a', bg: null, fontSizePct: 4.5, edge: '#000000', bold: true, italic: false, shadow: false, annMode: 'side', sample: 'He passed the quiz.' },
  // 8. CapCut 优雅斜体：Arial 斜体白字 + 软阴影（剪映模板主流）
  { id: 'fancy', label: { en: 'CapCut Italic', zh: '优雅斜体' }, font: 'arial', fg: '#ffffff', bg: null, fontSizePct: 5, edge: null, bold: false, italic: true, shadow: '0 2px 6px rgba(0,0,0,.8)', annMode: 'side', sample: 'He passed the quiz.' },
  // 9. 电影衬线：Georgia 白字黑描边（院线字幕质感）
  { id: 'movie', label: { en: 'Cinema Serif', zh: '电影衬线' }, font: 'georgia', fg: '#ffffff', bg: null, fontSizePct: 4.5, edge: '#000000', bold: false, italic: false, shadow: false, annMode: 'side', sample: 'He passed the quiz.' },
  // 10. 立体弹幕：Impact 白字硬阴影（弹幕/游戏区 UP 主常用立体字）
  { id: 'pop3d', label: { en: '3D Pop', zh: '立体弹幕字' }, font: 'impact', fg: '#ffffff', bg: null, fontSizePct: 5, edge: null, bold: false, italic: false, shadow: '2px 2px 0 #000,4px 4px 0 rgba(0,0,0,.8)', weight: 800, annMode: 'side', sample: 'He passed the quiz.' }
];

// === 字幕字体表（282次：从 subtitle-overlay.js 模块常量收敛到共享层并扩列） ===
// 281批仅 sans/serif/mono 三项（用户"字体选项多列几个"）→ 12 项；id 作 storage 值，
// 值为 CSS font-family 栈（Windows 10 环境优先系统字体，逐级回退）。
export const SUB_FONTS = {
  sans: 'system-ui,"Segoe UI","Microsoft YaHei",sans-serif',
  serif: 'Georgia,"Times New Roman",serif',
  mono: 'Consolas,"Courier New",monospace',
  arial: 'Arial,Helvetica,sans-serif',
  verdana: 'Verdana,Geneva,sans-serif',
  tahoma: 'Tahoma,Verdana,sans-serif',
  impact: 'Impact,"Arial Black",sans-serif',
  comic: '"Comic Sans MS","Segoe Print",cursive',
  courier: '"Courier New",Courier,monospace',
  georgia: 'Georgia,serif',
  palatino: '"Palatino Linotype","Book Antiqua",serif',
  trebuchet: '"Trebuchet MS",Tahoma,sans-serif'
};

// 字体下拉选项（id + 双语短名，guide 页 select 用）
export const SUB_FONT_OPTIONS = [
  { id: 'sans', label: { en: 'Sans', zh: '无衬线' } },
  { id: 'serif', label: { en: 'Serif', zh: '衬线' } },
  { id: 'mono', label: { en: 'Mono', zh: '等宽' } },
  { id: 'arial', label: { en: 'Arial', zh: 'Arial' } },
  { id: 'verdana', label: { en: 'Verdana', zh: 'Verdana' } },
  { id: 'tahoma', label: { en: 'Tahoma', zh: 'Tahoma' } },
  { id: 'impact', label: { en: 'Impact', zh: 'Impact' } },
  { id: 'comic', label: { en: 'Comic', zh: '卡通' } },
  { id: 'courier', label: { en: 'Courier', zh: 'Courier' } },
  { id: 'georgia', label: { en: 'Georgia', zh: 'Georgia' } },
  { id: 'palatino', label: { en: 'Palatino', zh: 'Palatino' } },
  { id: 'trebuchet', label: { en: 'Trebuchet', zh: 'Trebuchet' } }
];

// 字体 id → CSS 栈（未知 id 回落 sans——旧 storage 残留/脏值不炸渲染）
export function subFontFamily(id) {
  return SUB_FONTS[id] || SUB_FONTS.sans;
}

// === 字幕特效（282次新增：Custom Style 特效下拉 + 用户样式 fx 字段共用） ===
// 避开 gradient（低对比/性能差）；发光用 currentColor 免传 fg；描边走
// -webkit-text-stroke + paint-order:stroke fill（描边不侵吞字形主干）。
export const SUB_FX_OPTIONS = [
  { id: 'none', label: { en: 'None', zh: '无' } },
  { id: 'shadow', label: { en: 'Shadow', zh: '阴影' } },
  { id: 'glow', label: { en: 'Glow', zh: '发光' } },
  { id: 'stroke', label: { en: 'Outline', zh: '描边' } },
  { id: '3d', label: { en: '3D', zh: '立体' } }
];

// fx id → CSS 声明（单个声明串，无则返回 ''）
export function subFxDecl(fx) {
  switch (fx) {
    case 'shadow':
      return 'text-shadow:2px 2px 4px rgba(0,0,0,0.85)';
    case 'glow':
      return 'text-shadow:0 0 10px currentColor,0 0 20px currentColor';
    case 'stroke':
      return '-webkit-text-stroke:1.5px #000;paint-order:stroke fill';
    case '3d':
      return 'text-shadow:1px 1px 0 rgba(0,0,0,0.9),2px 2px 0 rgba(0,0,0,0.8),3px 3px 0 rgba(0,0,0,0.7),4px 4px 6px rgba(0,0,0,0.5)';
    default:
      return '';
  }
}

// === 用户自定义字幕正文样式（282次新增：Custom Style 大加号 → storage.subtitleUserStyles） ===
// 条目结构：{ id:'user-<timestamp>', label:{en,zh}, bg, fg, sizePct, fontFamily, fx }
// 293次：字号改百分比；refH=换算用视频高（guide 代码框/卡片预览传 540 设计高，
//   overlay 用户规则过滤 font-size 后走 --beaver-sub-fs 实时变量，不用此式）。
// 保存值=大加号按下时的 Custom 四参 + fx；渲染声明与 guide 预览、overlay 真实渲染同源。
export function buildUserStyleDecl(st, refH) {
  const out = [];
  if (st.bg) out.push('background:' + st.bg);
  out.push('color:' + (st.fg || '#ffffff'));
  out.push('font-size:' + sizePctToPx(subFontSizePct(st), refH) + 'px');
  out.push('font-family:' + subFontFamily(st.fontFamily));
  const fx = subFxDecl(st.fx);
  if (fx) out.push(fx);
  return out;
}

// === 字幕位置样式（距视频底部比例，subtitle-overlay 按 ratio 计算 top） ===
// ratio = 字幕框中心线距视频底部的高度占视频高度比例（0.1=贴底 … 0.75=接近顶部）。
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
