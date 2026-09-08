#!/usr/bin/env node
/**
 * scripts/check-cdn.mjs —— 候选 CDN 可达性诊断脚本（按需数据拉取选型预研，2026-09-07）
 *
 * 目的：从当前网络环境实测候选 CDN 的连通性/耗时/CORS，为「OCR 语言包、日文注音词典等
 *       大数据文件按需从 CDN 拉取」（后续上传 HuggingFace 仓库）的选型提供依据。
 * 用法：node scripts/check-cdn.mjs
 *       —— 单次运行自动退出；每个请求 8s 超时；无第三方依赖（Node >= 18 内置 fetch）。
 * 说明：真实大文件用 Range: bytes=0-1023 探测（206 表示支持 Range 断点）；
 *       若服务端忽略 Range 会返回 200，此时立即 cancel 响应体，避免整包下载。
 *       诊断结果仅作选型参考，非运行时依据；网络环境变化后可重跑。
 */

const TIMEOUT_MS = 8000;

// range: true —— 真实大文件，走 Range 探测；其余小文件直接整取
const TARGETS = [
  { label: 'HF镜像-API',       url: 'https://hf-mirror.com/api/models?limit=1' },
  { label: 'HF镜像-文件resolve', url: 'https://hf-mirror.com/Xenova/whisper-tiny/resolve/main/config.json' },
  { label: 'HF官方-API',       url: 'https://huggingface.co/api/models?limit=1' },
  { label: 'jsdelivr-npm',     url: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/package.json' },
  { label: 'jsdelivr-gh-OCR包', url: 'https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main/eng.traineddata', range: true },
  { label: 'jsdelivr-fastly',  url: 'https://fastly.jsdelivr.net/npm/tesseract.js@5/package.json' },
  { label: 'jsdelivr-gcore',   url: 'https://gcore.jsdelivr.net/npm/tesseract.js@5/package.json' },
  { label: 'unpkg',            url: 'https://unpkg.com/tesseract.js@5/package.json' },
  { label: 'tessdata官方CDN',   url: 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz', range: true },
  { label: 'GitHub-raw',       url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata', range: true },
  { label: 'npmmirror-registry', url: 'https://registry.npmmirror.com/tesseract.js/latest' },
  { label: 'npmmirror-文件服务', url: 'https://registry.npmmirror.com/tesseract.js/5.1.1/files/package.json' },
];

/** 探测单个目标：返回 {ok,status,ms,acao,lenInfo,note}，任何网络层错误都透出 err.cause（不掩蔽） */
async function probe(t) {
  const started = Date.now();
  try {
    const res = await fetch(t.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: t.range ? { Range: 'bytes=0-1023' } : {},
    });
    const ms = Date.now() - started;
    const acao = res.headers.get('access-control-allow-origin');
    const cr = res.headers.get('content-range');
    const cl = res.headers.get('content-length');
    const lenInfo = cr ? `range=${cr}` : cl != null ? `len=${cl}` : 'len=?';
    try { await res.body?.cancel(); } catch { /* 无 body 或已结束 */ }
    const note = res.url && res.url !== t.url ? `redirect→${res.url.slice(0, 60)}` : '';
    return { ok: res.ok, status: res.status, ms, acao: acao || '-', lenInfo, note };
  } catch (err) {
    const ms = Date.now() - started;
    const code = err?.cause?.code || err?.name || 'ERR';
    return { ok: false, status: '-', ms, acao: '-', lenInfo: '', note: `error=${code} ${String(err?.message || err).slice(0, 70)}` };
  }
}

console.log(`网络诊断开始：共 ${TARGETS.length} 项，逐项串行探测（每项 ${TIMEOUT_MS / 1000}s 超时）…\n`);
let pass = 0;
for (const t of TARGETS) {
  const r = await probe(t);
  if (r.ok) pass++;
  console.log(
    `[${r.ok ? '通' : '断'}] ${t.label.padEnd(12)} status=${String(r.status).padEnd(4)}` +
    `${String(r.ms).padStart(5)}ms  ACAO=${String(r.acao).slice(0, 28).padEnd(28)} ${r.lenInfo} ${r.note}`
  );
}
console.log(`\n汇总：${pass}/${TARGETS.length} 项可达（Pass=HTTP 2xx/206）。`);
console.log('选型提示：扩展页 fetch 已配置 host_permissions=<all_urls>，CORS 头（ACAO）非硬性要求，但有更稳；');
console.log('          内容脚本上下文不可直连任何 CDN，一律走 SW 代理（FETCH_URL），故上表 CORS 仅供参考。');
