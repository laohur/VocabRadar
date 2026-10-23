/**
 * video-meta.js —— 视频元数据抓取（聊天说话人混淆方案 D 之 A 部分）
 *
 * 背景（docs/聊天说话人混淆调研.md）：聊天引用字幕作上下文时，LLM 会把多人
 *   对话误判为一人。元数据（标题/博主名/简介）不能直接解决轮次归属（那是
 *   diarization 的事），但能：①锚定话题压住主题幻觉；②提供身份锚点
 *   （arXiv 2406.06608 实证：提示带人名提升准确性）；③简介常列嘉宾名单，
 *   配合 Speaker N 标签可做真名映射。
 *
 * 实现口径：
 *   1. 全部走 DOM/<meta>（内容脚本隔离环境即可读）——不走 ytInitialPlayerResponse/
 *      __INITIAL_STATE__ 主世界注入（page-fetch 注入基建太重，元数据不值得）；
 *   2. B站/YouTube 各配专属选择器，generic 入口 og 标签 + document.title 兜底；
 *   3. 失败如实降级：抓不到的字段不进结果，全部抓不到返回 null（不编造）；
 *   4. 简介节选限长（META_DESC_CAP）：简介常含推广噪音（求三连/链接堆），只当线索。
 */

// 简介节选上限（字符）：足够列嘉宾名单/主题句，不把推广噪音整段塞进上下文
const META_DESC_CAP = 600;

/**
 * 清理文本：折叠空白、去首尾。空/极短返回 null
 * @param {string} s
 * @returns {string|null}
 */
function cleanText(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t : null;
}

/**
 * 读 <meta> content（name 或 property 两种写法都查）
 * @param {string} key
 * @returns {string|null}
 */
function metaContent(key) {
  try {
    const el = document.querySelector(`meta[name="${key}"],meta[property="${key}"]`);
    return cleanText(el && el.getAttribute('content'));
  } catch (e) { return null; }
}

/**
 * 依次尝试多个选择器取文本（B站/YouTube 改版频繁，多兜底口径）
 * @param {string[]} selectors
 * @returns {string|null}
 */
function firstText(selectors) {
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (!el) continue;
      // title 属性优先（B站 h1.video-title 长标题被截断时完整文本在 title 里）
      const t = cleanText(el.getAttribute && el.getAttribute('title')) || cleanText(el.textContent);
      if (t) return t;
    } catch (e) { /* 选择器异常换下一个 */ }
  }
  return null;
}

/**
 * document.title 去站点后缀（兜底口径）：B站"标题_哔哩哔哩_bilibili"、
 * YouTube"标题 - YouTube"等
 * @returns {string|null}
 */
function cleanDocTitle() {
  const raw = cleanText(document.title);
  if (!raw) return null;
  return cleanText(
    raw.replace(/_哔哩哔哩(_bilibili)?$/i, '')
       .replace(/\s*-\s*YouTube\s*$/i, '')
       .replace(/\s*-\s*B站\s*$/i, ''));
}

/**
 * 抓取当前视频页元数据
 * @returns {{title: string, author: string, desc: string, source: string}|null}
 *   字段皆可选（抓不到不占位）；整体抓不到返回 null
 */
export function getVideoMeta() {
  const host = location.hostname || '';
  let title = null;
  let author = null;
  let desc = null;
  let source = 'generic';

  // 视频页守卫：URL 形态 + <video> 在场双条件。文本侧栏（ws）在 B站首页/
  // YouTube 首页等非视频页也会以 kind='sidebar' 开聊天，没有此守卫会把
  // "video subtitles may contain multiple speakers" 错误套给网页正文上下文
  const url = location.pathname || '';
  const videoUrl = (/bilibili\.com$/i.test(host) && /\/video\//.test(url))
    || (/youtube\.com$/i.test(host) && (/\/watch/.test(url) || /\/shorts\//.test(url) || /\/embed\//.test(url)))
    || (host === 'youtu.be' && url.length > 1);
  let hasVideoEl = false;
  try { hasVideoEl = !!document.querySelector('video'); } catch (e) { /* 查不到按无 */ }
  if (!videoUrl || !hasVideoEl) return null;

  if (/bilibili\.com$/i.test(host)) {
    source = 'bilibili';
    title = firstText(['h1.video-title', '.video-title', 'h1[data-title]']);
    author = firstText(['.up-name', 'a.up-name', '.up-detail-top a']);
    desc = metaContent('description');
    if (!title) title = cleanDocTitle();
  } else if (/youtube\.com$/i.test(host) || host === 'youtu.be' || /\.youtube\.com$/i.test(host)) {
    source = 'youtube';
    title = firstText(['h1.ytd-watch-metadata', 'ytd-watch-metadata h1', '#title h1']);
    author = firstText(['ytd-channel-name#channel-name a', 'ytd-channel-name a', '#owner #channel-title']);
    desc = metaContent('description');
    if (!title) title = cleanDocTitle();
  } else {
    title = firstText(['meta[property="og:title"]']) ? metaContent('og:title') : cleanDocTitle();
    author = metaContent('og:site_name') || metaContent('author');
    desc = metaContent('description') || metaContent('og:description');
  }

  // 简介节选：限长防推广噪音（截断处不硬切词——按空格回退，越界丢失可接受）
  if (desc && desc.length > META_DESC_CAP) {
    desc = desc.slice(0, META_DESC_CAP).replace(/\s+\S*$/, '') + '…';
  }

  const meta = {};
  if (title) meta.title = title;
  if (author) meta.author = author;
  if (desc) meta.desc = desc;
  if (!meta.title && !meta.author && !meta.desc) return null;
  meta.source = source;
  return meta;
}

/**
 * 非视频页元数据抓取（文本侧栏聊天轻量版，2026-10-23 裁定）：
 * 网页正文自带语义、无说话人问题，故只做主题锚定（标题/站点/简介节选），
 * 不放说话人约束文案。失败如实降级：抓不到返回 null。
 * @returns {{title: string, site: string, desc: string}|null}
 */
export function getPageMeta() {
  const title = metaContent('og:title') || cleanDocTitle();
  const site = metaContent('og:site_name') || metaContent('author');
  let desc = metaContent('description') || metaContent('og:description');
  if (desc && desc.length > META_DESC_CAP) {
    desc = desc.slice(0, META_DESC_CAP).replace(/\s+\S*$/, '') + '…';
  }
  const meta = {};
  if (title) meta.title = title;
  if (site) meta.site = site;
  if (desc) meta.desc = desc;
  return (meta.title || meta.site || meta.desc) ? meta : null;
}

/**
 * 组装文本侧栏上下文头部的页面元数据块（轻量版：无说话人约束）
 * @param {{title,site,desc}} meta getPageMeta() 结果
 * @returns {string} 多行块（以 \n\n 结尾，供直接拼接在正文前）
 */
export function formatPageMetaBlock(meta) {
  if (!meta) return '';
  const lines = ['[Page info]'];
  if (meta.title) lines.push('Title: ' + meta.title);
  if (meta.site) lines.push('Site: ' + meta.site);
  if (meta.desc) lines.push('Description (excerpt): ' + meta.desc);
  return lines.join('\n') + '\n\n';
}

/**
 * 组装上下文头部的元数据块（英文，与 chat 默认提示词同语种）
 * 含说话人不确定约束——这是治"多人误判一人"的提示词侧加固：
 *   · 字幕可能来自多位说话人，无 "Speaker N:" 前缀时不得断言单人；
 *   · 博主名只是可能的主讲人/主持人之一，不得把全部发言归给博主；
 *   · 有 "Speaker N:" 前缀（moss diarization）时按标签区分，可结合简介
 *     里的嘉宾名单尝试映射真名，映射不了就保留 N。
 * @param {{title,author,desc,source}} meta getVideoMeta() 结果
 * @returns {string} 多行块（以 \n 结尾，供直接拼接在字幕正文前）
 */
export function formatVideoMetaBlock(meta) {
  if (!meta) return '';
  const lines = ['[Video info]'];
  if (meta.title) lines.push('Title: ' + meta.title);
  if (meta.author) lines.push('Uploader/Channel: ' + meta.author);
  if (meta.desc) lines.push('Description (excerpt): ' + meta.desc);
  lines.push(
    'Note: The transcript below is video subtitles and may contain MULTIPLE speakers. ' +
    'Unless segments carry explicit "Speaker N:" prefixes, do not attribute the content ' +
    'to a single speaker; use timestamps, vocatives and Q/A cues to infer turns cautiously, ' +
    'and say so when unsure. The uploader/channel above is not necessarily the only speaker. ' +
    'If "Speaker N:" prefixes are present, treat them as distinct people; you may map them ' +
    'to real names using the description (e.g. guest lists), otherwise keep "Speaker N". ' +
    'Sources are mixed: when only some segments carry "Speaker N:" prefixes, the unlabeled ' +
    'ones (or "Speaker ?") are of UNKNOWN speaker — treat them as potentially distinct ' +
    'people and never merge them into any labeled speaker.');
  return lines.join('\n') + '\n\n';
}
