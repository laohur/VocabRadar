// =============================================================================
// SW 生命周期（2026-09-27 拆分自 service-worker.js）
// 职责：onInstalled（词典初始化 + 默认设置写入 + 存量规则迁移 + 版本清 IDB +
//   打开引导页）、onStartup、工具栏图标点击、Deactivate 存量规则 V1/V2 迁移。
// 顶层副作用：两个迁移 IIFE（标记防重入，SW 每次唤醒先查标记早退，幂等近零开销）。
// =============================================================================
import { clearAll as clearIdbAll } from '../../lib/word-db.js';
import { ensureReady } from '../../lib/dictionary.js';
import { _ts, log } from './log.js';
import { DEFAULT_SETTINGS, applyConfigDefaults } from './settings.js';
import { createContextMenus } from './menu.js';
import { WF_UPDATE_ALARM, checkWfUpdates } from './wf.js';

// 第一百四十次（用户裁定"扩展安装更新的时候应该初始化词典"）：
// onInstalled（install/update）时在后台一次性完成词典构建——页面从此只读 IDB，
// 不再承担首次冷构建。失败静默降级：首页异步装载路径仍会构建（分块原子+expected
// 校验保证最终一致）。
// 第二百四十六次补充（用户反馈 SW 日志报 import() 被禁）：改用顶部静态 import 的
//   ensureReady 直接调用（本机 Chrome 实测动态 import 被 ServiceWorkerGlobalScope
//   禁止，原动态 import 路径从未成功过）。
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install' && details.reason !== 'update') return;
  console.log(`[VocabRadar][sw][${_ts()}] [init] 扩展${details.reason === 'install' ? '安装' : '更新'} → 后台初始化词典…`);
  (async () => {
    try {
      const m = await ensureReady();
      console.log(`[VocabRadar][sw][${_ts()}] [init] 词典初始化完成: ${m ? m.size : 0} 词`);
    } catch (e) {
      console.warn(`[VocabRadar][sw][${_ts()}] [init] 词典初始化失败（将由页面路径重建）:`, e && e.message);
    }
  })();
});

// 275次：Deactivate 存量规则一次性迁移——「停用本站」菜单在 272 次之前默认写
// 四项全停（hint/textSidebar/videoSidebar/overlay 全 true），用户已裁定默认应为
// 仅提示停用；存量全停规则会让对应站点视频侧栏不可见（controller 走 overlay-only
// 或全停分支）。此处把"四项全 true"的存量规则改写为仅 hint（其余字段含 query 原样
// 保留），storage 标记防重入。只迁移菜单旧默认产物——迁移之后用户在引导页手动
// 改出的规则按原样尊重。SW 顶层每次唤醒执行：先查标记早退，幂等且近乎零开销。
(async () => {
  try {
    const done = await new Promise((resolve) => {
      try { chrome.storage.local.get('deactivateRulesMigratedV1', (res) => resolve(res && res.deactivateRulesMigratedV1 === true)); } catch (_) { resolve(true); }
    });
    if (done) return;
    const rules = await new Promise((resolve) => {
      try { chrome.storage.local.get('deactivateRules', (res) => resolve(res && Array.isArray(res.deactivateRules) ? res.deactivateRules : [])); } catch (_) { resolve([]); }
    });
    let changed = 0;
    const migrated = rules.map((raw) => {
      const r = (raw && typeof raw === 'object') ? raw : {};
      if (r.hint === true && r.textSidebar === true && r.videoSidebar === true && r.overlay === true) {
        changed++;
        return Object.assign({}, r, { textSidebar: false, videoSidebar: false, overlay: false });
      }
      return r;
    });
    if (changed > 0) {
      await new Promise((resolve, reject) => {
        try { chrome.storage.local.set({ deactivateRules: migrated }, () => { const e = chrome.runtime.lastError; e ? reject(e) : resolve(); }); } catch (e) { reject(e); }
      });
      console.log(`[VocabRadar][sw][${_ts()}] [init] Deactivate 旧全停规则迁移 ${changed} 条 → 仅提示停用（272 次默认变更追溯）`);
    }
    chrome.storage.local.set({ deactivateRulesMigratedV1: true });
  } catch (e) {
    console.warn('[VocabRadar][sw] Deactivate 规则迁移失败（不置位，下次唤醒重试）:', e);
  }
})();

// 276次：Deactivate 存量规则 V2 迁移——V1 只覆盖"四项全 true"，但用户实测视频侧栏
// 仍不可见（日志实证 controller 走 overlay-only=videoSidebar 仍被压）：规则是 272 次
// 前旧菜单默认（四项全停）写入、后又经引导页点选残留的组合，漏过 V1 的精确匹配。
// 规则唯一来源是旧菜单默认，故 V2 全量撤销其对视频侧栏的压制：所有规则
// videoSidebar→false（其余字段含 query/hint 原样保留）；用户此后想停某站视频侧栏
// 在引导页 Deactivate 栏重新勾选即可。幂等+标记防重入。
(async () => {
  try {
    const done = await new Promise((resolve) => {
      try { chrome.storage.local.get('deactivateRulesMigratedV2', (res) => resolve(res && res.deactivateRulesMigratedV2 === true)); } catch (_) { resolve(true); }
    });
    if (done) return;
    const rules = await new Promise((resolve) => {
      try { chrome.storage.local.get('deactivateRules', (res) => resolve(res && Array.isArray(res.deactivateRules) ? res.deactivateRules : [])); } catch (_) { resolve([]); }
    });
    let changed = 0;
    const migrated = rules.map((raw) => {
      const r = (raw && typeof raw === 'object') ? raw : {};
      if (r.videoSidebar === true) {
        changed++;
        return Object.assign({}, r, { videoSidebar: false });
      }
      return r;
    });
    if (changed > 0) {
      await new Promise((resolve, reject) => {
        try { chrome.storage.local.set({ deactivateRules: migrated }, () => { const e = chrome.runtime.lastError; e ? reject(e) : resolve(); }); } catch (e) { reject(e); }
      });
      console.log(`[VocabRadar][sw][${_ts()}] [init] Deactivate 规则 V2 迁移 ${changed} 条 → 撤销对视频侧栏的压制（用户裁定恢复默认可见）`);
    }
    chrome.storage.local.set({ deactivateRulesMigratedV2: true });
  } catch (e) {
    console.warn('[VocabRadar][sw] Deactivate 规则 V2 迁移失败（不置位，下次唤醒重试）:', e);
  }
})();

// 旧默认首次背景色（灰蓝/河狸棕绿），onInstalled 时迁移为新 MD3 马卡龙深绿
const LEGACY_DEFAULT_FIRST_BGS = ['#5a7a99', '#5a8a6a'];

// 安装时写入默认设置 + 创建右键菜单
// 反思（2026-08-03）：改为 async，先读取 config.json 覆盖易坏参数
chrome.runtime.onInstalled.addListener(async (details) => {
  await applyConfigDefaults();
  // 2026-09-08：wordfreq 源更新轮询周期 alarm（安装/更新时创建；onStartup 亦建，
  //   双保险覆盖"安装后浏览器长期不重启"场景）。
  // 2026-09-08 第二次：周期 24h→7天（用户裁定：万一有错能补救——轮询只读 files.json
  //   不拉词典本体，周期放长仅延迟更新感知，无正确性风险）。
  chrome.alarms.create(WF_UPDATE_ALARM, { periodInMinutes: 10080 });
  chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    // 迁移：已保存的首次背景色若为旧默认（灰蓝/河狸棕绿），自动改为新 MD3 马卡龙深绿。
    // 不覆盖用户自定义的其他颜色（如手动改的红/黄），只迁移旧默认值。
    if (merged.hintFirstBg && LEGACY_DEFAULT_FIRST_BGS.includes(merged.hintFirstBg.toLowerCase())) {
      merged.hintFirstBg = '#2e6b43';
    }
    if (merged.hintLaterBg && LEGACY_DEFAULT_FIRST_BGS.includes(merged.hintLaterBg.toLowerCase())) {
      merged.hintLaterBg = '#2e6b43';
    }
    // 反思（2026-08-18 第七十三次修正）：注释配色旧默认值迁移——用户明确默认
    //   "注释是白底绿字"（#ffffff/#2e6b43）。旧默认（墨绿近黑 #0d2014 底/青 #a8e6cf 字）
    //   被用户视为黑色。旧值若仍存于 storage 会覆盖新默认，需迁移。
    const LEGACY_ANN_BGS = ['#e0e0e0', '#fff3b0', '#2e6b43', '#0d2014'];
    const LEGACY_ANN_FGS = ['#616161', '#5d4037', '#ffffff', '#a8e6cf'];
    if (merged.hintAnnotationBg && LEGACY_ANN_BGS.includes(merged.hintAnnotationBg.toLowerCase())) {
      merged.hintAnnotationBg = '#ffffff';
    }
    if (merged.hintAnnotationFg && LEGACY_ANN_FGS.includes(merged.hintAnnotationFg.toLowerCase())) {
      merged.hintAnnotationFg = '#2e6b43';
    }
    // 反思（2026-08-18 第七十三次修正）：生词默认配色迁移——用户明确"单词绿底白字"。
    //   旧默认 #0d2014/#a8e6cf（近黑/青）也需迁移为 #2e6b43/#ffffff。
    const LEGACY_FIRST_BGS = ['#0d2014', '#5a8a6a', '#3f51b5', '#1b2838'];
    const LEGACY_FIRST_FGS = ['#a8e6cf', '#ffffff'];
    if (merged.hintFirstBg && LEGACY_FIRST_BGS.includes(merged.hintFirstBg.toLowerCase())) {
      merged.hintFirstBg = '#2e6b43';
    }
    if (merged.hintFirstFg && LEGACY_FIRST_FGS.includes(merged.hintFirstFg.toLowerCase())) {
      merged.hintFirstFg = '#ffffff';
    }
    chrome.storage.local.set(merged);
    // 反思（2026-08-14 第五十四次）：删除改名前的旧键 localTranslateEnabled，
    //   避免陈旧值残留在 storage 中造成混淆。
    chrome.storage.local.remove(['localTranslateEnabled']);
  });
  // 默认停用规则注入——config.json 定义 vocabradar.com/localhost/127.0.0.1/*.*.*.*
  //   四条默认规则（抑制网页提示），storage 无 deactivateRules 或为空时写入。
  //   用户已有规则不覆盖；迁移标记防重入。
  (async () => {
    try {
      const done = await new Promise((resolve) => {
        try { chrome.storage.local.get('deactivateRulesDefaultsInjected', (res) => resolve(res && res.deactivateRulesDefaultsInjected === true)); } catch (_) { resolve(true); }
      });
      if (done) return;
      const existing = await new Promise((resolve) => {
        try { chrome.storage.local.get('deactivateRules', (res) => resolve(res && Array.isArray(res.deactivateRules) ? res.deactivateRules : [])); } catch (_) { resolve([]); }
      });
      if (existing.length > 0) {
        chrome.storage.local.set({ deactivateRulesDefaultsInjected: true });
        log('[VocabRadar][sw][' + _ts() + '] deactivateRules 已有规则(' + existing.length + '条)，跳过默认注入');
        return;
      }
      let defaults = [];
      try {
        const url = chrome.runtime.getURL('src/data/config.json');
        const res = await fetch(url);
        const cfg = await res.json();
        defaults = Array.isArray(cfg.deactivateRules) ? cfg.deactivateRules : [];
      } catch (e) {
        console.warn('[VocabRadar][sw][' + _ts() + '] 读取 config.json 默认停用规则失败:', e);
      }
      if (defaults.length === 0) {
        chrome.storage.local.set({ deactivateRulesDefaultsInjected: true });
        return;
      }
      await new Promise((resolve, reject) => {
        try {
          chrome.storage.local.set({ deactivateRules: defaults }, () => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message)); else resolve();
          });
        } catch (e) { reject(e); }
      });
      chrome.storage.local.set({ deactivateRulesDefaultsInjected: true });
      log('[VocabRadar][sw][' + _ts() + '] 默认停用规则已注入', defaults.length, '条');
    } catch (e) {
      console.warn('[VocabRadar][sw] 默认停用规则注入失败（不置位，下次唤醒重试）:', e);
    }
  })();
  // 反思（2026-08-14 第五十五次修正）：删除 word-cache.js（fnv1aHash 100 分桶旧缓存）。
  //   第五十二次已迁移统一词典（word-db.js IDB 单库），translator.js 不再读写 wc_* 桶，
  //   旧版版本变更清空 wc_* 桶的逻辑与文件一同删除；翻译缓存改由 onInstalled 清 IDB。
  const curVersion = chrome.runtime.getManifest().version;
  chrome.storage.local.get(['_lastDictClearVersion'], (res) => {
    if (res._lastDictClearVersion !== curVersion) {
      // 第367次：idbClearAll 清理范围已补全（分表+meta+dictCache+旧words）。
      //   反思：diverse-lemmas 词形还原数据第五十三次起并入 dictCache store，
      //   vendor storage.js 的独立 'diverse-lemmas' 库在扩展中从未打开（无 import），
      //   故无需 deleteDatabase——清 dictCache 即为"可复取缓存彻底清"。
      //   用户数据（My Words/设定，storage.local）不动；代价：更新后首次冷装载慢一轮（重拉重建）。
      clearIdbAll().catch(() => {});
      chrome.storage.local.set({ _lastDictClearVersion: curVersion });
      log('[VocabRadar][sw][' + _ts() + '] 版本变更(' + curVersion + ')，清空 IDB 词典缓存（分表+meta+dictCache+旧words，用户数据保留）');
    } else {
      log('[VocabRadar][sw][' + _ts() + '] 版本未变更(' + curVersion + ')，保留词典缓存');
      // 2026-09-09（用户批复"扩展更新安装，不应该就拉取吗"→ 拍板"补 onInstalled 对账"）：
      //   版本未变更（本地重载同版本等）也跑一次 wfInstalled 基线 vs 远程 files.json 对账，
      //   覆盖"浏览器长期不重启、onStartup 兜底未跑"的窗口。节流 1h（storage._lastWfAudit）：
      //   开发期反复 load unpacked 同版本时避免每次 onInstalled 都拉 files.json。
      chrome.storage.local.get('_lastWfAudit', (a) => {
        if (Date.now() - (a._lastWfAudit || 0) < 3600000) return; // 1h 内已对账
        chrome.storage.local.set({ _lastWfAudit: Date.now() });
        checkWfUpdates();
      });
    }
  });
  createContextMenus();
  // 反思（2026-08-13 第五十次）：新安装时自动打开引导页（(16) 新装弹引导页）。
  //   2026-09-09 第二百五十次（用户指令"安装更新应当跳转到引导页，初始化"）：update
  //   也跳转——版本变更清 IDB 后词频需重新拉取，引导页走初始化链路（原设计"更新
  //   不打扰"废止：更新后词典空窗期用户无从得知，引导页明示初始化进度更稳）。
  if (details && (details.reason === 'install' || details.reason === 'update')) {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/guide/guide.html') }).catch(() => {});
  }
  log('[VocabRadar][sw][' + _ts() + '] onInstalled');
});

// 工具栏图标点击 → 打开引导页（不是弹窗）
// 反思（2026-08-13 第五十一次）：用户要求"工具栏图标点击不是弹窗而是跳到引导页"。
//   manifest action 已移除 default_popup；此处监听 onClicked 打开引导页。
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/guide/guide.html') }).catch(() => {});
  log('[VocabRadar][sw][' + _ts() + '] 点击工具栏图标，打开引导页');
});

// 重新启动时也确保菜单存在（service worker 唤醒后菜单可能丢失）
chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
  log('[VocabRadar][sw][' + _ts() + '] onStartup');
  // 2026-09-08：wordfreq 源更新轮询——浏览器启动即重建 7天 周期 alarm（同名覆盖
  //   重置计时无妨，本就按浏览器会话边界重建；2026-09-08 第二次 24h→7天）并立即
  //   跑一次比对（兜底浏览器长开场景）。
  chrome.alarms.create(WF_UPDATE_ALARM, { periodInMinutes: 10080 });
  checkWfUpdates();
});
