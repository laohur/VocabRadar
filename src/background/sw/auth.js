// =============================================================================
// SW 账号模块（2026-10-08 P1c：网站账号连接与自动登录，方案 docs/云端数据与积分制方案.md §2）
// 职责：
//   - onMessageExternal 唯一监听：只接受网站（externally_connectable 白名单 origin）
//     的账号交接/查询/断开三种消息；token 只经 chrome 消息通道一次性交予，
//     不走 postMessage 桥（方案风险表「扩展 token 经页面暴露」裁定：页面不触达扩展存储）
//   - 登录态存 chrome.storage.local（CLOUD_AUTH_KEY），guide 账号栏直接读显
//   - getValidAccessToken()：P3/P4 云端请求统一入口——临期自动用 refresh_token
//     直连 GoTrue 续签（扩展有 <all_urls> host 权限）；**不调 /api/points/daily-login**
//     （§3.3：扩展自动登录不计登录奖，防静默刷分）
// 协议镜像：web/docs/桥接扩展.md §7 通道 C（改动必须两文档+两实现同步）
// =============================================================================

// Supabase 公开值（与 web/src/lib/supabase.js 同源：publishable key 本就是公开凭据，
// 改动时两端同步；用途仅限 GoTrue token 端点）
const SUPABASE_URL = 'https://wlvrinvlbufdsinaimoy.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_VkfhEGuyBIbVlXnr0kuf5Q_kMH_B-1Y';

// token 对存储 key（camelCase 与扩展惯例一致；网站侧键均 vocabradar_ 前缀蛇形，
// 本键由 SW 与 guide 共读，取扩展风格）
export const CLOUD_AUTH_KEY = 'vocabradarCloudAuth';

// 交接来源白名单（与 manifest.json externally_connectable.matches 保持一致；
// onMessageExternal 无 manifest 层 origin 过滤，必须逐条校验 sender）
const ALLOWED_ORIGINS = [
  'https://vocabradar.com',
  'https://localhost:3001',
  'http://localhost:3001',
];

const REFRESH_AHEAD_MS = 30 * 1000; // 临期提前量：剩余 <30s 即先续签

function senderAllowed(sender) {
  const origin = sender && (sender.origin || (sender.url || '').replace(/^(https?:\/\/[^/]+).*$/, '$1'));
  return !!origin && ALLOWED_ORIGINS.indexOf(origin) !== -1;
}

function readAuth() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(CLOUD_AUTH_KEY, (items) => {
        resolve(items && items[CLOUD_AUTH_KEY] ? items[CLOUD_AUTH_KEY] : null);
      });
    } catch (e) { resolve(null); }
  });
}

function writeAuth(auth) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [CLOUD_AUTH_KEY]: auth }, () => resolve(true));
    } catch (e) { resolve(false); }
  });
}

function clearAuth() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.remove(CLOUD_AUTH_KEY, () => resolve(true));
    } catch (e) { resolve(false); }
  });
}

// refresh_token → 新 token 对（GoTrue 标准 grant）；失败返回 null（不遮蔽，由调用方处置）
async function refreshByGoTrue(refreshToken) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || !data.access_token || !data.refresh_token) return null;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAtMs: data.expires_at ? data.expires_at * 1000 : Date.now() + 3600 * 1000,
    };
  } catch (e) {
    return null;
  }
}

// 云端请求取 token 的统一入口（P3/P4 消费）：临期先续签并落盘，失败回旧值由
// 请求方按 401 自行降级。扩展自动登录不触发任何奖励端点。
export async function getValidAccessToken() {
  const cur = await readAuth();
  if (!cur || !cur.accessToken) return null;
  if (cur.expiresAtMs && cur.expiresAtMs - REFRESH_AHEAD_MS > Date.now()) {
    return cur.accessToken;
  }
  const fresh = cur.refreshToken ? await refreshByGoTrue(cur.refreshToken) : null;
  if (!fresh) return cur.accessToken;
  const next = { ...cur, ...fresh };
  await writeAuth(next);
  return next.accessToken;
}

// 顶层副作用：注册 onMessageExternal（入口 service-worker.js import 触发）。
// 三种消息一应答；未知 type 如实回错（与解析桥「不静默丢弃」同纪律）。
// **双通道**：
//   - Chrome/Edge：网页经 chrome.runtime.sendMessage 直达 onMessageExternal；
//   - Firefox：不支持 externally_connectable（MDN：Firefox 未实现），网页消息由
//     content script vocabradar-bridge.js 经内部 chrome.runtime.sendMessage 中继
//     （同 type），由下方 onMessage 内部监听承接（sender.id 必为本扩展）。
async function handleAuthMessage(msg) {
  const type = msg && msg.type;

  if (type === 'vocabradar:auth-handoff') {
    const { accessToken, refreshToken, expiresAt, user } = msg;
    if (typeof accessToken !== 'string' || !accessToken ||
        typeof refreshToken !== 'string' || !refreshToken) {
      return { ok: false, error: 'invalid payload' };
    }
    const auth = {
      accessToken,
      refreshToken,
      expiresAtMs: typeof expiresAt === 'number' ? expiresAt * 1000 : Date.now() + 3600 * 1000,
      email: (user && user.email) || '',
      userId: (user && user.id) || '',
      savedAt: Date.now(),
    };
    await writeAuth(auth);
    return { ok: true, email: auth.email };
  }

  if (type === 'vocabradar:auth-ping') {
    const cur = await readAuth();
    return { ok: true, connected: !!(cur && cur.accessToken), email: (cur && cur.email) || '' };
  }

  if (type === 'vocabradar:auth-disconnect') {
    await clearAuth();
    return { ok: true };
  }

  // P3：扩展页面（guide 字幕库）取有效 token 上传分享——续签逻辑保持 SW 单一属主
  if (type === 'vocabradar:auth-get-token') {
    const accessToken = await getValidAccessToken();
    return accessToken
      ? { ok: true, accessToken }
      : { ok: false, error: 'not-connected' };
  }

  return { ok: false, error: 'unknown type' };
}

// **Firefox 守卫（20261008 真机根因）**：Firefox 不支持 onMessageExternal
// （MDN 未实现，API 为 undefined）——顶层直接 .addListener 抛 TypeError，
// 整个 SW 装配链炸掉（火狐工具栏图标无反应、新装不开引导页）。存在才注册；
// Firefox 网页侧走中继（vocabradar-bridge → 内部 onMessage），不依赖本监听。
if (chrome.runtime.onMessageExternal && chrome.runtime.onMessageExternal.addListener) {
  chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    if (!senderAllowed(sender)) {
      sendResponse({ ok: false, error: 'origin not allowed' });
      return false;
    }
    handleAuthMessage(msg).then(sendResponse);
    return true; // 异步 sendResponse
  });
}

// 内部通道：仅本扩展的 content script 中继可达（Firefox 网页无法直发，
// 见上）；不校验 sender.origin——消息源自扩展自身上下文
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('vocabradar:auth-')) {
    return false; // 非 auth 消息放行给其他监听者（router.js 等）
  }
  handleAuthMessage(msg).then(sendResponse);
  return true;
});
