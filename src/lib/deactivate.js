// ============================================================
// 文件职责：站点停用规则（Deactivate）唯一实现（第二百七十次新建）
// 来源：用户需求——①引导页增 deactivate 栏（默认折叠，逐条记录：左地址输入、
//   右功能点选 所有/网页提示/文本侧栏/视频侧栏/视频叠加字幕）；②两侧栏 ⋯ 菜单
//   增「停用本站」项（写当前域规则→立即抑制→跳引导页停用栏微调）；③规则范围
//   支持通配（地址/端口/路径前缀）；④勾「所有」时扩展在该站尽量不活动。
// 唯一定义约定：匹配/规范化/抑制判定逻辑只许本文件一份，classic 入口
//   （text-hint.js / web-sidebar.js / bilibili.js / youtube.js / generic.js）
//   经 import(chrome.runtime.getURL('src/lib/deactivate.js')) 动态加载
//   （非 BUNDLE_ENTRIES 文件构建时原样复制进 dist，动态 import 可达）；
//   ESM 侧（vc/controller.js、video-sidebar.js、ws/ui.js、引导页）静态 import。
//
// 存储键：chrome.storage.local 'deactivateRules'
//   值 = [{ pat:'example.com', query:true, hint:true, textSidebar:true, videoSidebar:true, overlay:true }, …]
//   布尔字段 true = 在命中页面上"停用"该功能；五项全 true 即用户口中的「所有」。
// 五大功能键：query=搜索栏/右键查询(272次新增) / hint=网页提示(text-hint) /
//   textSidebar=文本侧栏(web-sidebar) / videoSidebar=视频侧栏(video-sidebar) /
//   overlay=视频叠加字幕(subtitle-overlay)。
//
// 匹配语义（matchPattern，规则 pat 不区分大小写；路径段区分）：
//   1) 规范化：trim → 小写 → 去 http(s):// 前缀 → 去末尾 '/'（空 pat 恒不命中）；
//   2) host[:port] 段：'*' 通配任意字符；无 '*' 时按"后缀域"匹配（example.com
//      同时命中 example.com 与其任意子域——用户"停用当前域名"的自然预期）；
//      pat 带端口则端口必须一致（URL 缺省端口按 https:443 / http:80 归一），
//      不带端口则任意端口（含缺省）；
//   3) /path 段：缺省=任意路径；有则前缀匹配且"段对齐"（/videos 命中 /videos 与
//      /videos/x，不命中 /videosxx）；含 '*' 时按正则前缀（* → .*）。
// ============================================================

/** storage 键（deactivateRules 规则数组） */
export const DEACTIVATE_KEY = 'deactivateRules';

/** 五大功能键（规则对象字段与抑制表字段同名；query=搜索栏/右键查询，272 次新增） */
export const DEACTIVATE_FEATURES = ['query', 'hint', 'textSidebar', 'videoSidebar', 'overlay'];

/** 规范化 pattern：trim/小写/去协议前缀/去末尾斜杠；空串=无效规则（恒不命中） */
export function normalizePattern(pat) {
  let p = String(pat == null ? '' : pat).trim().toLowerCase();
  p = p.replace(/^https?:\/\//, '');
  p = p.replace(/\/+$/, '');
  return p;
}

/** 规则对象规范化（保证六字段齐全、布尔归一；写入与判定两侧共用；旧规则缺 query=false） */
export function normalizeRule(raw) {
  return {
    pat: normalizePattern(raw && raw.pat),
    query: !!(raw && raw.query),
    hint: !!(raw && raw.hint),
    textSidebar: !!(raw && raw.textSidebar),
    videoSidebar: !!(raw && raw.videoSidebar),
    overlay: !!(raw && raw.overlay)
  };
}

/**
 * 判定一条 pattern 是否命中 location（用 hostname/port/pathname/protocol 四字段，
 * location 对象或其形似对象均可）。语义见文件头"匹配语义"。
 * @param {string} pat 规则地址（未规范化也可，内部先 normalize）
 * @param {{hostname?:string, port?:string, pathname?:string, protocol?:string}} loc
 * @returns {boolean}
 */
export function matchPattern(pat, loc) {
  const p = normalizePattern(pat);
  if (!p || !loc) return false;
  const slash = p.indexOf('/');
  const hostPat = slash === -1 ? p : p.slice(0, slash);
  const pathPat = slash === -1 ? '' : p.slice(slash);   // 保留前导 '/'
  // host 段拆出可选端口（不处理 IPv6 字面量含冒号的写法——浏览器站点场景极少，如需可后续加 [] 识别）
  let hBody = hostPat;
  let portPat = '';
  const colon = hostPat.lastIndexOf(':');
  if (colon !== -1 && /^\d+$/.test(hostPat.slice(colon + 1))) {
    hBody = hostPat.slice(0, colon);
    portPat = hostPat.slice(colon + 1);
  }
  const hostname = String(loc.hostname || '').toLowerCase();
  if (!hostname || !hBody) return false;
  // 先转义正则特殊字符（* 不在表中），再把 * 展开为 .*
  const esc = hBody.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = hBody.includes('*')
    ? new RegExp('^' + esc + '$')                       // 显式通配：整段精确匹配
    : new RegExp('^(.+\\.)?' + esc + '$');              // 无通配：后缀域匹配（本域+子域）
  if (!re.test(hostname)) return false;
  if (portPat) {
    const urlPort = String(loc.port || '') || (loc.protocol === 'https:' ? '443' : '80');
    if (urlPort !== portPat) return false;
  }
  if (pathPat && pathPat !== '/') {
    const pathname = String(loc.pathname || '/');
    if (pathPat.includes('*')) {
      const pEsc = pathPat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      if (!new RegExp('^' + pEsc).test(pathname)) return false;
    } else if (pathPat.endsWith('/')) {
      if (!pathname.startsWith(pathPat)) return false;
    } else if (pathname !== pathPat && !pathname.startsWith(pathPat + '/')) {
      return false;
    }
  }
  return true;
}

/** 读规则数组（storage 缺键/异常一律回退空数组，绝不抛错打断启动链路） */
export function getDeactivateRules() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(DEACTIVATE_KEY, (res) => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.warn('[VocabRadar][deactivate] 读取规则失败:', err.message);
          resolve([]);
          return;
        }
        const v = res && res[DEACTIVATE_KEY];
        resolve(Array.isArray(v) ? v : []);
      });
    } catch (e) {
      console.warn('[VocabRadar][deactivate] storage 不可用，按无规则处理:', e);
      resolve([]);
    }
  });
}

/**
 * 由规则数组计算 location 的抑制表（同步、纯函数；规则全部不命中即全 false）。
 * all = 五项全 true（用户口中的「所有」）；matchedPats = 命中的规则地址（诊断日志用）。
 * @param {Array} rules
 * @param {Location} loc
 */
export function getSuppression(rules, loc) {
  const out = { query: false, hint: false, textSidebar: false, videoSidebar: false, overlay: false, all: false, matchedPats: [] };
  if (!Array.isArray(rules) || !rules.length || !loc) return out;
  for (const raw of rules) {
    const r = normalizeRule(raw);
    if (!r.pat || !matchPattern(r.pat, loc)) continue;
    out.matchedPats.push(r.pat);
    if (r.query) out.query = true;
    if (r.hint) out.hint = true;
    if (r.textSidebar) out.textSidebar = true;
    if (r.videoSidebar) out.videoSidebar = true;
    if (r.overlay) out.overlay = true;
  }
  out.all = out.query && out.hint && out.textSidebar && out.videoSidebar && out.overlay;
  return out;
}

/** 便捷组合：读规则 + 算抑制（消费方绝大多数只要这一个） */
export async function suppressionFor(loc) {
  const rules = await getDeactivateRules();
  const where = loc || (typeof location !== 'undefined' ? location : null);
  return getSuppression(rules, where);
}

/**
 * 按 pat（规范化后精确对位）追加或合并一条规则，写回 storage。
 * 两侧栏 ⋯「停用本站」与引导页深链共用；返回最新规则数组（失败抛错由调用方汇报）。
 * @param {string} pat
 * @param {{hint?:boolean, textSidebar?:boolean, videoSidebar?:boolean, overlay?:boolean}} patch
 */
export async function upsertDeactivateRule(pat, patch) {
  const key = normalizePattern(pat);
  if (!key) throw new Error('空地址规则');
  const rules = await getDeactivateRules();
  const found = rules.find((r) => normalizePattern(r && r.pat) === key);
  if (found) {
    Object.assign(found, patch || {});
  } else {
    rules.push(normalizeRule(Object.assign({ pat: key }, patch || {})));
  }
  await new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set({ [DEACTIVATE_KEY]: rules }, () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message)); else resolve();
      });
    } catch (e) { reject(e); }
  });
  return rules;
}
