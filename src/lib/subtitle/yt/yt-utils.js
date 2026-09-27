// =============================================================================
// yt/yt-utils.js —— YouTube 页面通用工具（叶子模块，无内部依赖）
// -----------------------------------------------------------------------------
// 职责：ensureXmlFormat()（字幕 baseUrl 补 v 参数）、extractYtcfg()（页面 <script>
//       提取 INNERTUBE_API_KEY/clientVersion）、extractVarFromScripts()/
//       extractBalancedJson()（花括号配对提取页面 JSON 变量）。
// 来源：拆分自 src/lib/subtitle/youtube-fetcher.js（2026-09-27 拆分第三刀，
//       纯机械搬移；随迁注释原样保留）。
// 消费方：./caption-tracks.js（路径0-3）、./innertube.js（列表补拉/WEB_EMBEDDED_PLAYER）。
// =============================================================================

/**
 * 补全 YouTube 字幕 URL 的 v 参数（不修改 fmt）。
 *
 * 反思（2026-07-03 第五次修正）：
 *   之前结论"修改fmt会使签名失效"是错误的。fmt 不在 sparams 签名参数列表中，
 *   添加/修改 fmt 不会破坏签名。但 getPlayerResponse() 返回的 baseUrl 签名
 *   绑定了播放器会话，直接 fetch 无论 fmt 取何值都返回 0 字节。
 *   此函数仅补充 v 参数，fmt 由 fetchYouTubeTrack 中的 innertube 路径处理。
 *
 * @param {string} url 原始 baseUrl
 * @param {string} videoId 当前视频 ID
 * @returns {string} 校验后的 URL
 */
export function ensureXmlFormat(url, videoId) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (videoId && !u.searchParams.has('v')) {
      u.searchParams.set('v', videoId);
    }
    return u.toString();
  } catch (e) {
    console.warn('[VocabRadar][youtube] ensureXmlFormat 解析 URL 失败:', e.message, '保留原 URL');
    return url;
  }
}

/**
 * 从页面 <script> 标签文本提取 ytcfg 中的 INNERTUBE_API_KEY 与 clientVersion。
 *
 * ytcfg.set({INNERTUBE_API_KEY: "AIza...", INNERTUBE_CONTEXT: {client: {clientVersion: "..."}}})
 * 仅读取脚本文本不执行，不违反 CSP。提取不到返回空串（调用方回退默认值）。
 * @returns {{apiKey:string, clientVersion:string}}
 */
export function extractYtcfg() {
  let apiKey = '';
  let clientVersion = '';
  try {
    const scripts = document.getElementsByTagName('script');
    for (const s of scripts) {
      const text = s.textContent || '';
      if (!text.includes('INNERTUBE_API_KEY') && !text.includes('clientVersion')) continue;
      if (!apiKey) {
        const m = text.match(/INNERTUBE_API_KEY:\s*"([A-Za-z0-9_-]+)"/);
        if (m) apiKey = m[1];
      }
      if (!clientVersion) {
        const m = text.match(/"clientVersion":\s*"([0-9.]+)"/);
        if (m) clientVersion = m[1];
      }
      if (apiKey && clientVersion) break;
    }
  } catch (e) {
    console.warn('[VocabRadar][youtube] extractYtcfg 异常:', e);
  }
  console.log('[VocabRadar][youtube] ytcfg 提取: apiKey=' + (apiKey ? '(有)' : '(空)')
    + ' clientVersion=' + (clientVersion || '(空)'));
  return { apiKey, clientVersion };
}

// === 工具：从页面 <script> 标签文本提取变量 ===

/**
 * 从 text 中下标 start 处（应为 '{'）开始，按花括号配对提取一个完整的 JSON 对象字符串。
 * 正确处理字符串字面量内的花括号与反斜杠转义，避免在 JSON 字符串里误判层级。
 * @param {string} text
 * @param {number} start '{' 的下标
 * @returns {string|null} 完整的 {...} 字符串，失败返回 null
 */
function extractBalancedJson(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 遍历页面所有 <script> 标签的 textContent，正则定位 varName 赋值语句，
 * 用花括号配对提取并 JSON.parse 出对应对象。
 *
 * 仅读取脚本文本、不执行任何脚本，不违反页面 CSP（与原 getPageVar 注入 inline
 * script 的方式相比，避免了被 script-src 拒绝的问题）。
 *
 * 适用前提：目标变量在页面 HTML 中以对象字面量形式赋值，且为合法 JSON
 * （YouTube 的 ytInitialPlayerResponse 满足；B站 __INITIAL_STATE__ 含 undefined
 * 等非合法 JSON，不适用，B站改走 view API）。
 * @param {string} varName
 * @returns {any|null}
 */
export function extractVarFromScripts(varName) {
  const scripts = document.getElementsByTagName('script');
  // 匹配 varName = / var varName = / window.varName = / window["varName"] = 形式
  const re = new RegExp(
    `(?:var\\s+|window\\["${varName}"\\]\\s*=\\s*|window\\.${varName}\\s*=\\s*|)${varName}\\s*=\\s*`
  );
  for (const s of scripts) {
    const text = s.textContent || '';
    if (!text.includes(varName)) continue;
    const m = text.match(re);
    if (!m) continue;
    const braceStart = text.indexOf('{', m.index + m[0].length);
    if (braceStart === -1) continue;
    const jsonStr = extractBalancedJson(text, braceStart);
    if (!jsonStr) continue;
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      // 当前 script 不匹配，继续尝试下一个（可能有多个同名片段）
    }
  }
  return null;
}
