// ============================================================
// 文件职责：YouTube 字幕获取（门面，仅 re-export；实现已拆至 yt/ 子模块）
// 来源：拆分自 src/lib/subtitle-fetcher.js（ES Modules 模块化拆分），2026-08-27
// 拆分第三刀：2026-09-27 本文件 1754 行 → 门面 + src/lib/subtitle/yt/ 七模块
//   yt-utils.js          ensureXmlFormat / extractYtcfg / extractVarFromScripts / extractBalancedJson
//   page-context.js      页面主世界注入 + timedtext 缓存 + fetchViaPageContext（模块状态唯一属主）
//   player-intercept.js  sleep / 广告判据 / 播放器探测 / checkPageCache / triggerAndInterceptSubtitle
//   backend.js           fetchSubsViaBackend / backendSubtitlesFallback / fetchSubtitleViaServiceWorker
//   innertube.js         熔断器 + youtubei 单例 + warm + 路径A/B + 轨道补拉 + fresh baseUrl + URL 构造
//   caption-tracks.js    四路轨道发现 + getYouTubeSubtitles
//   track-download.js    fetchYouTubeTrack（七路下载）
// 符号：getYouTubeSubtitles / warmYouTubeCaptionInnertube / fetchYouTubeTrack（由 index.js 统一 re-export）
// 内部工具：ensureXmlFormat / extractVarFromScripts / extractBalancedJson / fetchTrackListViaInnertube 等
//   仅被本门面的子模块使用，故落在 yt/ 而不放入 subtitle-parser.js（拆分计划规则）
// 注：原文件头注释（修复历史）见下；其中 B 站相关修复历史现位于 bilibili-fetcher.js。

// ⚠ 语法修复说明（2026-08-27，唯一一处偏离“逐字节搬移”的必要修复）：
//   原文件 fetchTrackViaGetTranscript 的 catch 块存在真实语法错误：
//   第一份残缺 catch 体（原 L1270-1279）以 “} catch (e) {”（原 L1280）非法衔接，
//   V8 解析直接报 SyntaxError: Unexpected token 'catch'（原文件在浏览器中同样无法加载）。
//   修复：删除第一份残缺 catch 体与非法的 “} catch (e) {” 行（原 L1270-1280，共11行），
//   保留紧随其后语义完整的第二份 catch 体（原 L1281-1294，重试/熔断逻辑完整）。
//   其余所有代码均逐字节原样搬移，原有注释全部保留。
// ============================================================
// 字幕获取：B站 + YouTube
// 返回统一格式 [{start, end, text}]
//
// 修复历史：
//   2026-06-25：B站 AI 字幕 lan 为 ai-en/ai-zh，原匹配 startsWith('en') 漏检 ai-en；
//               新增 wbi 签名（player wbi/v2 调用前对参数签名）；增加详细日志。
//   2026-06-30：修复字幕下载 CORS 失败——AI 字幕域名 aisubtitle.hdslb.com 响应头为
//               Access-Control-Allow-Origin:*，带 credentials:'include' 会被浏览器拒绝；
//               字幕 URL 已带 auth_key 鉴权，无需 cookie，改为 credentials:'omit'。
//               修复 getPageVar inline script 被 B站 CSP 拒绝——改读 <script> 标签
//               textContent 提取页面变量（仅读取不执行，不违反 CSP）；B站 aid/cid
//               统一走 view API（已验证可用）。
//   2026-07-03：YouTube 字幕下载根因修复。历次误判回顾：
//               v1 fmt=xml→空, v2 fmt=srv→空, v3 fmt=json3→空, v4 不改fmt→仍空。
//               误判结论"修改fmt会使签名失效"是错误的！真正根因：getPlayerResponse()
//               返回的 baseUrl 签名绑定了播放器会话上下文，content script 直接 fetch
//               该 URL 时 YouTube 返回 0 字节。正确方案：用 innertube API 的
//               WEB_EMBEDDED_PLAYER 客户端获取全新的 baseUrl（签名不绑定会话），
//               再加 fmt=json3 参数（fmt 不在 sparams 签名列表中，安全），
//               用普通 fetch 下载即可成功。

// ⚠ 第一百七十三次（用户反馈"youtube字幕依旧抓不到"）——真实根因修复：
//   2026-08-27 那次拆分把 parseSubtitleContent 留在 subtitle-parser.js 并加了 export，
//   却**漏写本文件的 import**。本文件 9 处调用它（路径 0/1/2/3/4/4b/A/5 的最后一步
//   全部依赖），运行时一律抛 ReferenceError: parseSubtitleContent is not defined，
//   且被各路径的 catch 吞成"路径N 异常"，观感与网络失败/PoToken 问题完全一致。
//   逃逸原因：未声明标识符是**运行时**错误而非语法错误，`node --check` 查不出来
//   （拆分自述的验证手段恰是 node --check，故当时全 PASS）。
//   教训：拆分后必须做"自由标识符对账"，不能只跑语法校验。

// === 门面 re-export（2026-09-27 拆分第三刀；导出符号零差异，引用方零改动）===
// 本轮同样跑过自由标识符对账（node --check 之外的孤儿引用/死导入检查）。

export { getYouTubeSubtitles } from './yt/caption-tracks.js';
export { warmYouTubeCaptionInnertube } from './yt/innertube.js';
export { fetchYouTubeTrack } from './yt/track-download.js';
