// edge_upload.mjs —— 通过 Edge Add-ons v1.1 REST API 上传扩展包并（可选）提交审核。
// 依赖：Node ≥ 18（使用内置 fetch 与 node:fs），无第三方依赖。
// 用法：
//   node scripts/edge_upload.mjs --product-id <GUID> --zip <路径> [--publish] [--notes "..."]
//   可选参数：--client-id <ID> --api-key <KEY> --interval <秒> --upload-wait <秒> --publish-wait <秒>
//   --check <operationId>：只查询某次包处理 operation 的完整结果（用于查看 Failed 的具体校验错误）。
//   --product-id 与 --zip 必传，取值优先级：命令行 > local.json 的 productId/zip > 环境变量 EDGE_PRODUCT_ID / EDGE_ZIP。
//   凭据优先级：命令行参数 > scripts/edge_upload.local.json（不入库，可存 clientId/apiKey/productId/zip）> 环境变量 EDGE_CLIENT_ID / EDGE_API_KEY。
//   productId 获取：Partner Center > Microsoft Edge > Overview > 扩展页 Extension identity（128 位 GUID）。
// 官方文档：https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/using-addons-api
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://api.addons.microsoftedge.microsoft.com";

/** 带秒级时间戳（本地时区）的进度输出。toISOString 是 UTC，会与本地时间差 8 小时，故手动格式化。 */
function log(msg) {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  console.log(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`, msg);
}

/** 极简命令行参数解析：--key value / --key=value / 布尔开关 --key。 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    let [k, v] = a.slice(2).split("=");
    if (v === undefined) {
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith("--")) { v = nxt; i++; }
      else v = true; // 布尔开关，如 --publish
    }
    args[k] = v;
  }
  return args;
}

/** 发送一次 API 请求，返回 {status, headers, text}；HTTP 错误码不抛出，交由调用方判断。 */
async function apiRequest(method, url, headers, body) {
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

/** 从 Location 头（.../operations/{id}）提取 operationId。 */
function opIdFromLocation(location) {
  if (!location) return null;
  const tail = location.split("?")[0].replace(/\/+$/, "");
  return tail.split("/").pop() || null;
}

/** 步骤 1：上传 zip 到草稿提交（POST /v1/products/{pid}/submissions/draft/package），返回 operationId。 */
async function uploadPackage(pid, clientId, apiKey, zipPath) {
  const payload = fs.readFileSync(zipPath);
  log(`上传包 ${zipPath}（${(payload.length / 1048576).toFixed(1)} MB）...`);
  const { status, headers, text } = await apiRequest(
    "POST",
    `${BASE}/v1/products/${pid}/submissions/draft/package`,
    {
      "Authorization": `ApiKey ${apiKey}`,
      "X-ClientID": clientId,
      "Content-Type": "application/zip",
    },
    payload,
  );
  log(`上传响应 HTTP ${status}，body: ${(text || "(空)").slice(0, 500)}`);
  if (status === 401) throw new Error("401 鉴权失败：检查 API Key / Client ID 是否正确、未过期。");
  if (status === 404) throw new Error("404 未找到：检查 productId 是否正确（Partner Center 扩展页 GUID）。");
  if (status !== 202) throw new Error(`上传失败，HTTP ${status}，body: ${text || "(空)"}`);
  const op = opIdFromLocation(headers.get("location"));
  if (!op) throw new Error(`未从 Location 头解析出 operationId：${headers.get("location")}`);
  log(`上传已受理，operationId = ${op}`);
  return op;
}

/** 步骤 2：轮询包处理状态；Success 返回 true，Failed 抛错（附完整响应体），超时返回 false。 */
async function pollUpload(pid, clientId, apiKey, op, interval, maxWait) {
  const deadline = Date.now() + maxWait * 1000;
  const url = `${BASE}/v1/products/${pid}/submissions/draft/package/operations/${op}`;
  while (Date.now() < deadline) {
    const { status, text } = await apiRequest("GET", url, {
      "Authorization": `ApiKey ${apiKey}`, "X-ClientID": clientId,
    });
    log(`包处理状态 HTTP ${status}: ${text || "(空)"}`);
    if (status === 200 && text.includes('"Failed"')) {
      // 输出完整响应体，PackageValidationError 的 errors 数组可能很长，不能截断。
      throw new Error(`包处理失败（Failed），完整响应：${text}`);
    }
    // API 成功状态串是 "Succeeded"（非 "Success"），用 '"Succ' 前缀两者通吃。
    if (status === 200 && text.includes('"Succ')) {
      log("包处理成功（Succeeded）。");
      return true;
    }
    await new Promise(r => setTimeout(r, interval * 1000));
  }
  log("轮询超时：上传可能仍在后台处理，稍后可在 Partner Center 查看。");
  return false;
}

/** 步骤 3：提交草稿进入审核（POST /v1/products/{pid}/submissions），返回发布 operationId。 */
async function publish(pid, clientId, apiKey, notes) {
  const { status, headers, text } = await apiRequest(
    "POST",
    `${BASE}/v1/products/${pid}/submissions`,
    {
      "Authorization": `ApiKey ${apiKey}`,
      "X-ClientID": clientId,
      "Content-Type": "application/json",
    },
    JSON.stringify({ notes: notes || "" }),
  );
  log(`发布响应 HTTP ${status}，body: ${(text || "(空)").slice(0, 500)}`);
  if (status === 409) throw new Error("409：已有进行中的提交（可能有审核中版本），请稍后再试。");
  if (status !== 202) throw new Error(`发布请求失败，HTTP ${status}，body: ${text || "(空)"}`);
  const op = opIdFromLocation(headers.get("location"));
  log(`发布已受理，operationId = ${op}`);
  return op;
}

/** 步骤 4：轮询发布状态；完成返回 true，超时返回 false（审核耗时可能较长）。 */
async function pollPublish(pid, clientId, apiKey, op, interval, maxWait) {
  const deadline = Date.now() + maxWait * 1000;
  const url = `${BASE}/v1/products/${pid}/submissions/operations/${op}`;
  while (Date.now() < deadline) {
    const { status, text } = await apiRequest("GET", url, {
      "Authorization": `ApiKey ${apiKey}`, "X-ClientID": clientId,
    });
    log(`发布状态 HTTP ${status}: ${text || "(空)"}`);
    // 同上：'"Succ' 兼容 "Succeeded"/"Success" 两种成功状态串。
    if (status === 200 && (text.includes('"Succ') || text.includes('"Failed"'))) return true;
    await new Promise(r => setTimeout(r, interval * 1000));
  }
  return false;
}

/**
 * 读取与脚本同目录的 edge_upload.local.json（可固化 clientId/apiKey/productId/zip，已加入 .gitignore 不入库）。
 * 文件不存在或 JSON 非法时返回空对象（允许无该文件运行，此时走环境变量/命令行）。
 */
function loadLocalConf() {
  const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "edge_upload.local.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

/** 入口：解析参数，按 上传→轮询→(可选)发布→轮询 执行并逐条汇报。 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  // 本地配置（scripts/edge_upload.local.json，不入库）：可固化 clientId/apiKey/productId/zip 四项，
  // 优先级 命令行 > 本地配置 > 环境变量；文件不存在则视为空配置。
  const local = loadLocalConf();
  // zip 与 productId 的取值优先级：命令行 > local.json（productId/zip） > 环境变量
  // （EDGE_PRODUCT_ID / EDGE_ZIP）；三者皆无才报错。
  const zip = args.zip || local.zip || process.env.EDGE_ZIP;
  const pid = args["product-id"] || local.productId || process.env.EDGE_PRODUCT_ID;
  const clientId = args["client-id"] || local.clientId || process.env.EDGE_CLIENT_ID;
  const apiKey = args["api-key"] || local.apiKey || process.env.EDGE_API_KEY;
  const interval = parseInt(args.interval || "10", 10);
  if (!pid) { console.error("缺少 productId：请传 --product-id <GUID>、在 scripts/edge_upload.local.json 写 productId，或设环境变量 EDGE_PRODUCT_ID"); process.exit(1); }
  if (!zip) { console.error("缺少上传包：请传 --zip <路径>、在 scripts/edge_upload.local.json 写 zip，或设环境变量 EDGE_ZIP"); process.exit(1); }
  if (!clientId || !apiKey) {
    console.error("缺少凭据：请传 --client-id/--api-key、创建 scripts/edge_upload.local.json 或设置环境变量 EDGE_CLIENT_ID/EDGE_API_KEY");
    process.exit(1);
  }

  // --check <operationId>：只查询包处理 operation 的完整结果（用于查看 Failed 的具体校验错误）。
  if (args["check"]) {
    const url = `${BASE}/v1/products/${pid}/submissions/draft/package/operations/${args["check"]}`;
    const { status, text } = await apiRequest("GET", url, {
      "Authorization": `ApiKey ${apiKey}`, "X-ClientID": clientId,
    });
    console.log(`HTTP ${status}\n${text}`);
    return;
  }

  if (!fs.existsSync(zip)) { console.error(`zip 不存在：${zip}`); process.exit(1); }

  // 步骤 1-2：上传并等待包处理结果
  const op = await uploadPackage(pid, clientId, apiKey, zip);
  const ok = await pollUpload(pid, clientId, apiKey, op, interval, parseInt(args["upload-wait"] || "1200", 10));
  if (!ok) { console.error("包处理未在时限内完成，未执行发布。"); process.exit(2); }

  // 步骤 3-4：仅当显式 --publish 时提交审核
  if (args.publish) {
    const pubOp = await publish(pid, clientId, apiKey, args.notes || "");
    const done = await pollPublish(pid, clientId, apiKey, pubOp, interval, parseInt(args["publish-wait"] || "1800", 10));
    if (!done) { console.error("发布仍在进行（审核耗时较长），可稍后在 Partner Center 查看结果。"); process.exit(2); }
  } else {
    log("未指定 --publish：包已入草稿，请在 Partner Center 检查后再手动提交。");
  }
  log("全部完成。");
}

main().catch(err => {
  console.error("[错误]", err.message);
  // Node fetch 的网络层失败（DNS/连接重置/代理中断等）细节藏在 err.cause，必须透出，不掩蔽错误。
  if (err.cause) console.error("[原因]", err.cause.code || err.cause.message || err.cause);
  console.error("[提示] 若为 fetch failed：多为网络/代理问题（Node fetch 不走系统代理），可稍后重试或换网络后重试。");
  process.exit(1);
});
