// ============================================================
// 文件职责：词典投影预取入口（classic script，document_start）
// 第一百九十一次（用户两问：「IndexedDB 必须每个网页打开一个吗？能一打开网页就读取
// 而不是等到网页加载完？」）：
//   现状：主脚本（text-hint/web-sidebar）均为 document_idle，词典投影请求在页面
//   加载完成后才发出；SW 闲置 ~30s 休眠即清空 _projCache，每页首个请求要付
//   「SW 冷启动 + IDB 全表扫描 + 大消息传输」全价（实测 4448ms）。
//   本脚本在网页打开瞬间（document_start）发一条消息唤醒 SW，SW 顶层预热
//   （service-worker.js 顶层 warmupDictProjection）立即开始扫库——与页面加载
//   并行，主脚本 idle 后请求投影时缓存已热。fire-and-forget：失败不影响任何功能。
// 注意：内容脚本环境 chrome.runtime 恒可用；回调仅清 lastError 防 unchecked 警告。
// ============================================================
try {
  chrome.runtime.sendMessage({ type: 'WORD_DB_PROJ_PREFETCH' }, () => { void chrome.runtime.lastError; });
} catch (e) { /* SW 不可达时静默（如扩展重载瞬间），按需读取路径兜底 */ }
