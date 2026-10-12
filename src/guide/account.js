// VocabRadar 引导页 账号 模块（2026-10-08 P1c：guide.js 已超行限，独立成文件，仿 my-words.js；
// 同日用户裁定：账号是独立标签页 panel-account（帮助之前），不进设定栏）
// 职责（docs/云端数据与积分制方案.md §2「扩展账号连接」）：
//   - 状态行：读 chrome.storage.local.vocabradarCloudAuth（SW sw/auth.js 维护），
//     显示 未连接 / 已连接 <email>；storage 变化即时跟随（网页重复交接、他处断开均同步）
//   - 连接账号：chrome.tabs.create 打开网站登录页深链 /user?extconnect=<扩展ID>；
//     站点按 draft-export.js 同款规则判定（manifest 带 update_url=商店安装 →
//     vocabradar.com，本地开发 → https://localhost:3001）
//   - 断开：chrome.runtime.sendMessage(SW 'vocabradar:auth-disconnect')（SW 清存储，
//     本模块不直写，保持 SW 是登录态唯一属主）；断开只清扩展本地 token 对，
//     不影响网站自身登录态
// 文案：静态 data-key 由 shared.js MSG 填充；状态行动态串用 m() 取键
import { $, m, log } from './shared.js';

let _inited = false;

function siteUrl() {
  try {
    const mf = chrome.runtime.getManifest();
    return mf && mf.update_url ? 'https://vocabradar.com' : 'https://localhost:3001';
  } catch (e) {
    return 'https://localhost:3001';
  }
}

function renderStatus(auth) {
  const el = $('spanAccountStatus');
  if (!el) return;
  el.textContent = (auth && auth.accessToken && auth.email)
    ? m('accountConnected').replace('{email}', auth.email)
    : m('accountNotConnected');
}

function refreshFromStorage() {
  try {
    chrome.storage.local.get('vocabradarCloudAuth', (items) => {
      renderStatus(items && items.vocabradarCloudAuth);
    });
  } catch (e) {
    log('[VocabRadar][account] 读登录态失败:', e);
  }
}

function onConnect() {
  const extId = chrome.runtime.id;
  const url = `${siteUrl()}/user?extconnect=${encodeURIComponent(extId)}`;
  try {
    chrome.tabs.create({ url });
  } catch (e) {
    window.open(url, '_blank');
  }
}

function onDisconnect() {
  try {
    chrome.runtime.sendMessage({ type: 'vocabradar:auth-disconnect' }, (res) => {
      const err = chrome.runtime.lastError; // 必须读，否则控制台报未处理 lastError
      if (err || !res || !res.ok) {
        log('[VocabRadar][account] 断开失败:', (err && err.message) || (res && res.error));
        return;
      }
      renderStatus(null);
    });
  } catch (e) {
    log('[VocabRadar][account] 断开异常:', e);
  }
}

export function initAccount() {
  if (_inited) return;
  _inited = true;
  const btnConnect = $('btnAccountConnect');
  const btnDisconnect = $('btnAccountDisconnect');
  if (btnConnect) btnConnect.addEventListener('click', onConnect);
  if (btnDisconnect) btnDisconnect.addEventListener('click', onDisconnect);
  // 网站重复交接 / 他处断开 → 状态行跟随
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.vocabradarCloudAuth) {
        renderStatus(changes.vocabradarCloudAuth.newValue || null);
      }
    });
  } catch (e) {}
  refreshFromStorage();
}

export function disposeAccount() {
  if (!_inited) return;
  _inited = false;
  const btnConnect = $('btnAccountConnect');
  const btnDisconnect = $('btnAccountDisconnect');
  if (btnConnect) btnConnect.removeEventListener('click', onConnect);
  if (btnDisconnect) btnDisconnect.removeEventListener('click', onDisconnect);
}
