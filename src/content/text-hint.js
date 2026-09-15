// 全站文本提示入口（classic script）
// 用动态 import 加载 ES module（与 bilibili.js 同模式），避免 content_scripts 静态 import 报错
//
// 职责：
//   - 读取设置（textHintEnabled + 配色 6 字段 + rankThreshold）
//   - 监听 storage 变化，启停提示或热更新配色
//   - 接收右键菜单消息，弹出查词面板

// 第一百九十六次：boot 埋点——classic 入口开跑时刻（早于下方 ESM import）。
//   用户实测「DCL→startHint」间隔 1685ms 占首提延迟的大头，但 th 埋点从 startHint 才开始，
//   无法区分「浏览器注入等待」与「ESM 模块图装载」各占多少。本值由 th/core.js 装载时
//   回填进 thTiming.marks['hint:scriptStart']（同一 performance.now() 时间基），诊断窗
//   「网页提示链路耗时」表即显示三段：DCL→classic 入口→startHint→首高亮。
try { window.__beaverHintScriptAt = performance.now(); } catch (_) { /* ignore */ }

let _impl = null;

// === 第二百次：启动链路可观测 + 自恢复（用户：火狐多页扫描慢、commandcode.ai 上
//     startHint 永未发生且零痕迹）===
// 旧问题：import() 失败被外层 try/catch 静默吞进 __beaverHintBoot（不打日志）；
//   import() 挂起更是无任何记录；_impl=null 时 5s 对账也静默 return。
//   违反"不遮蔽错误"——bundle 化后模块图装载链路一旦断（如某 chunk 被拦/加载失败），
//   网页提示全灭且诊断表只剩一排"未发生"。现补三道观测 + 一次自恢复：
//   ①boot.state 记 loading/ok/error/hang；②10s/30s 挂起告警；③失败 3s 后重试一次。
let _importSettled = false;
function _bootPatch(patch) {
  try {
    window.__beaverHintBoot = Object.assign({}, window.__beaverHintBoot || {}, patch);
  } catch (_) { /* ignore */ }
}

async function _loadImpl() {
  _bootPatch({ state: 'loading', at: Date.now() });
  try {
    _impl = await import(chrome.runtime.getURL('src/content/text-hint-impl.js'));
    _importSettled = true;
    _bootPatch({ state: 'ok', ok: true, error: null, at: Date.now() });
    return true;
  } catch (e) {
    _importSettled = true;
    const msg = String((e && e.message) || e);
    // 不遮蔽：装载失败必须出声（此前静默吞进 boot 元数据）
    console.error('[VocabRadar][text-hint] text-hint-impl.js 动态 import 失败:', msg, e);
    _bootPatch({ state: 'error', ok: false, error: msg, at: Date.now() });
    return false;
  }
}

// === 第二百七十次：停用规则（Deactivate）gate ===
// 命中「网页提示」停用规则时本页尽量不活动：不加载模块图（无 import）、不挂
// 5s 对账定时器/可见性监听，仅留一个轻量 storage 监听，规则解除后再走完整
// _hintBoot()。匹配/存储逻辑唯一来源 src/lib/deactivate.js（非打包入口文件，
// 构建时原样进 dist，classic 入口可动态 import）。
let _hintDeactLib = null;
function _hintLoadDeactLib() {
  return import(chrome.runtime.getURL('src/lib/deactivate.js'))
    .then((m) => { _hintDeactLib = m; return true; })
    .catch((e) => {
      // 不遮蔽：规则库加载失败按"未停用"处理并出声（不拖垮提示主功能）
      console.warn('[VocabRadar][text-hint] 停用规则库加载失败，按未停用处理:', e);
      return false;
    });
}
/** 当前页是否命中「网页提示」停用规则（规则库缺失时恒 false） */
function _hintSuppressed() {
  if (!_hintDeactLib) return Promise.resolve(false);
  return _hintDeactLib.suppressionFor(location)
    .then((s) => s.hint === true)
    .catch(() => false);
}
// 272次：Query（右键查询+查询栏）可用性——停用规则 query 项 + 全局开关。
// 与网页提示解耦：提示关/停不影响查询，查询关/停不影响提示。
// 286次：Query 拆分为右键查询（contextLookupEnabled）与查询栏（queryBarEnabled）；
//   停用规则 query 项仍同时门控两者（规则语义不变）；旧 queryEnabled 仅作新键未设置时的回退。
function _querySuppressed() {
  if (!_hintDeactLib) return Promise.resolve(false);
  return _hintDeactLib.suppressionFor(location)
    .then((s) => s.query === true)
    .catch(() => false);
}
function _storeFlag(key) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ [key]: undefined, queryEnabled: true }, (r) =>
        resolve((typeof r[key] === 'undefined' ? r.queryEnabled : r[key]) !== false));
    } catch (_) { resolve(true); }
  });
}
async function _contextLookupAvailable() {
  if (await _querySuppressed()) return false;
  return _storeFlag('contextLookupEnabled');
}
async function _queryBarAvailable() {
  if (await _querySuppressed()) return false;
  return _storeFlag('queryBarEnabled');
}
let _booted = false;

(async () => {
  console.log(`[VocabRadar][text-hint] content script 已加载 @ ${location.href}`);
  try {
    await _hintLoadDeactLib();
    // 272次：整页不加载的判据由「网页提示停」改为「网页提示+搜索栏双停」——
    // 提示被停时仍需加载模块图以服务右键查询/搜索栏（SHOW_CONTEXT_PANEL 监听在本文件）。
    const _sup0 = _hintDeactLib ? await _hintDeactLib.suppressionFor(location) : { hint: false, query: false };
    if (_sup0.hint && _sup0.query) {
      console.log('[VocabRadar][text-hint] 命中停用规则（网页提示+搜索栏全停），本页不加载提示模块（规则解除后自动恢复）');
      _hintInstallUnsuppressWatch();
      return;
    }
    if (_sup0.hint) console.log('[VocabRadar][text-hint] 停用规则命中（网页提示），本页不启动提示（右键查询/搜索栏仍可用）');
    await _hintBoot();
  } catch (e) {
    console.error('[VocabRadar][text-hint] 加载失败', e);
  }
})();

// === boot：启动主体（第二百七十次自 IIFE 抽出；逻辑原样 + 规则实时停用分支）===
async function _hintBoot() {
  if (_booted) return;
  _booted = true;
  try {
    // 挂起看门狗：10s 提醒、30s 定性（import 悬而不决时此前零痕迹）
    const t0 = Date.now();
    const hangTimer = setInterval(() => {
      if (_importSettled) { clearInterval(hangTimer); return; }
      const sec = Math.round((Date.now() - t0) / 1000);
      if (sec >= 30) {
        clearInterval(hangTimer);
        console.error('[VocabRadar][text-hint] text-hint-impl.js 动态 import 30s 未完成——模块图挂起'
          + '（排查：chunk 加载是否被拦/WAR 是否缺失/网络栈是否卡死），boot.state=hang');
        _bootPatch({ state: 'hang', ok: false, error: 'import 30s 未完成（挂起）' });
      } else if (sec >= 10) {
        console.warn('[VocabRadar][text-hint] text-hint-impl.js 动态 import 已 ' + sec + 's 未完成（继续等待）');
      }
    }, 1000);
    let ok = await _loadImpl();
    if (!ok) {
      // 失败自恢复：3s 后重试一次（瞬时失败如 SW 竞态/首次 chunk 加载抖动）
      await new Promise((r) => setTimeout(r, 3000));
      console.warn('[VocabRadar][text-hint] import 首次失败，3s 后重试一次');
      ok = await _loadImpl();
    }
    if (!ok) {
      console.error('[VocabRadar][text-hint] 重试仍失败，网页提示不可用（侧栏将走独立兜底扫描）。'
        + '请把本页控制台 [VocabRadar][text-hint] 全部日志发我。');
    }
    clearInterval(hangTimer);

    // 诊断挂钩（2026-08-14 第五十四次）：向诊断悬浮窗暴露真实运行实例的状态。
    //   不能由 diagnose.js 二次 import 本模块（会得到独立实例，看不到运行时状态）。
    window.__beaverHintDiag = () => (_impl && typeof _impl.getDiagState === 'function')
      ? _impl.getDiagState()
      : null;

    // 控制挂钩（2026-08-14 第五十六次）：诊断悬浮窗操作按钮直接调用模块方法。
    //   关键：既写 storage（全链路同步）又直接调用 _impl（绕过可能丢失的 onChanged 事件），
    //   幂等可重入。diagnose.js 的按钮就靠它"看网页是否变化"。
    // 反思（2026-08-14 第五十八次）：start 原只调 startOrReport 不写 storage。
    //   若 storage.textHintEnabled 仍为 false，5s 对账(reconcile)会 stopHint 杀掉手动启动
    //   →"网页高亮闪一下又消失"。修正：start 先把 textHintEnabled 写 true 再启动。
    // 反思（2026-08-15 第五十八次·续）：诊断窗任意手动操作（启动/重扫/删高亮/调参）都刷新
    //   _lastManualAt，reconcile 在最近 8s 内有手动操作时不自动 stopHint（见 reconcile）。
    //   避免"点完启动/重扫 5s 后被对账误杀"。
    let _lastManualAt = 0;
    const markManual = () => { _lastManualAt = Date.now(); };
    // 2026-09-08：本页会话停用标记——网页侧栏 ✕ 关闭时连带撤掉页面高亮/注解
    //   （用户："扩展侧栏中关闭后，影响并未消失"）。不写 storage（只影响本页，
    //   刷新即恢复），但必须拦住 reconcile 的"存储要求启用→自动 startHint"复活路径，
    //   否则 5s 对账会把手动 stopHint 无限复活。清除点：诊断窗 start / popup 显式
    //   打开 textHintEnabled（onChanged）。
    let _sessionStop = false;
    window.__beaverHintCtl = {
      start: async () => {
        markManual();
        _sessionStop = false;
        try { await chrome.storage.local.set({ textHintEnabled: true }); } catch (_) { /* ignore */ }
        const s = await _hintGetSettings();
        await startOrReport(s, 'ctl.start');
      },
      stop: () => { markManual(); _lastStartSig = ''; if (_impl) _impl.stopHint(); },
      // 侧栏 ✕ 关闭专用：本页会话停用（不写 storage；reconcile 尊重该标记不再自动复活）
      // 第二百六十九次：停用即清防抖签名——此后用户重新展开侧栏/点注释开（ctl.start）
      //   不会被 #267 的 30s 同参防抖误拦（防抖只拦"运行中的重复启动"，不拦"停后再启"）。
      stopForPage: () => { markManual(); _sessionStop = true; _lastStartSig = ''; if (_impl) _impl.stopHint(); },
      rescan: () => { markManual(); if (_impl) _impl.rescanNow(); },
      clear: () => { markManual(); if (_impl) _impl.clearHighlights(); },
      setRank: (v) => {
        markManual();
        const n = (typeof v === 'number' && isFinite(v)) ? v : 5000;
        chrome.storage.local.set({ rankThreshold: n });
        if (_impl) _impl.setRankThreshold(n);
      },
      setAnnotateOov: (v) => {
        markManual();
        chrome.storage.local.set({ annotateOov: !!v });
        if (_impl) _impl.setAnnotateOov(!!v);
      },
      applyStyle: (id) => {
        markManual();
        // 318次：'none' 哨兵非法——空串表示未启用文本样式。
        chrome.storage.local.set({ textStyle: id || '' });
        if (_impl) _impl.applyTextStyleClass(id || '');
      }
    };

    // 反思（2026-08-14 第五十六次修正）：storage 监听器原放在 startHint 之后注册，
    //   若 startHint 抛错/挂起，监听器永不注册 → 后续在引导页/弹窗改设置全部失效
    //   （诊断实证：effective.enabled=false 且 setRankThreshold 不生效，但 storage 值已改）。
    //   修正：先注册监听器，再启动；并在窗口挂启动结果供诊断悬浮窗展示。
    chrome.storage.onChanged.addListener((changes) => {
      if (!_impl) return;
      // 第二百七十次：停用规则变化——命中「网页提示」立即停（语义同显式停用，
      //   清会话停用标记与防抖签名）；解除不在此处自动重启，交给 reconcile
      //   （wantEnabled 已并入规则判定）在下一周期自然恢复，避免双启动竞态。
      if ('deactivateRules' in changes) {
        _hintSuppressed().then((sup) => {
          if (sup) {
            _sessionStop = false;
            _lastStartSig = '';
            _impl.stopHint();
            console.log('[VocabRadar][text-hint] 停用规则命中（网页提示），已停止');
          }
        });
        return;
      }
      // 主开关
      // 反思（2026-08-15 第五十八次·续）：newValue 为 undefined（键被删除）时不应 stopHint，
      //   统一"仅显式 false 才停用"语义（与 reconcile 一致）。
      if ('textHintEnabled' in changes) {
        const _nv = changes.textHintEnabled.newValue;
        const _ov = changes.textHintEnabled.oldValue;
        if (_nv === false) {
          // 显式停用路径：标记已无意义，一并复位防悬挂
          _sessionStop = false;
          _lastStartSig = '';   // 第二百六十九次：停用即清防抖签名，之后再启用不被 30s 防抖误拦
          _impl.stopHint();
        } else if (_ov === false) {
          // 第二百六十九次（用户报"扩展关闭侧栏后，网页依旧提示"）：只有真·关→开
          //   切换（oldValue===false，popup/引导页显式重开=用户最新意图）才解除本页
          //   会话停用并重启。旧版对任何非 false 写入都清 _sessionStop 并 startHint
          //   ——storage 同值回声写（onChanged 对"写到相同值"也触发）会把 ✕ 关侧栏的
          //   会话停用撤销并复活提示，日志实证 caller=onChanged 高频防抖命中即此因。
          _sessionStop = false;
          _hintGetSettings().then((s) => startOrReport(s, 'onChanged:textHintEnabled'));
        } else {
          // 同值回声写（oldValue===newValue 或首次建键 oldValue===undefined）：
          //   会话停用标记不动、不重启，留痕便于对账（模块运行态本就不需要变）。
          console.log('[VocabRadar][text-hint] onChanged: textHintEnabled 同值写（'
            + String(_ov) + '→' + String(_nv) + '），忽略不改运行态');
        }
        return;
      }
      // 文本样式变化 → 只换类名（颜色走 updateColors 的 CSS 变量）
      if ('textStyle' in changes) {
        _impl.applyTextStyleClass(changes.textStyle.newValue);
      }
      // 301次：个性化/用户条目变化 → 刷新 extra 文本规则（无需重扫；类名不变即时生效）
      if ('annotationCustom' in changes || 'annotationUserStyles' in changes) {
        _hintGetSettings().then((s) => _impl.refreshAnnExtraCss(s.annotationCustom, s.annotationUserStyles));
      }
      // 阈值变化 → 重扫
      if ('rankThreshold' in changes) {
        _impl.setRankThreshold(changes.rankThreshold.newValue);
      }
      // 注释表外词开关变化 → 重扫（2026-08-07；2026-08-14 键名改 annotateOov）
      if ('annotateOov' in changes) {
        _impl.setAnnotateOov(changes.annotateOov.newValue);
      }
      // 注释重复生词开关变化 → 重扫（2026-08-15 第六十二次）
      if ('annotateRepeat' in changes) {
        _impl.setAnnotateRepeat(changes.annotateRepeat.newValue);
      }
      // 280次：侧邻注释模板变化 → 清缓存重扫（与 annotateRepeat 同构，原 annBrackets）
      if ('annTemplate' in changes) {
        _impl.setAnnTemplate(changes.annTemplate.newValue);
      }
      // 配色字段变化 → 热更新样式（无需重扫）
      const colorKeys = [
        'hintFirstEnabled', 'hintFirstBg', 'hintFirstFg',
        'hintLaterEnabled', 'hintLaterBg', 'hintLaterFg',
        // 侧邻注释（2026-08-05）：注释底色/字色变化热更新；开关变化需重扫
        'hintSideAnnotation', 'hintAnnotationBg', 'hintAnnotationFg',
        // 279次：注释样式候选池——池 id 变化热更新 pickColors（无需重扫）
        'annotationStyle',
        // 280次：统一池——textStyle 条目 wordBg/wordFg 参与变量派生，变化也热更
        'textStyle'
      ];
      if (colorKeys.some((k) => k in changes)) {
        _hintGetSettings().then((s) => _impl.updateColors(s));
      }
    });

    // 启动文本提示（含自愈）：调用 startHint 并在失败时记录诊断信息
    // 反思（2026-08-14 第五十六次）：startHint 内已尽量不抛错，但为万全，
    //   捕获异常并记录到 window.__beaverHintBoot 供诊断窗展示，避免"静默不启动"。
    // 第二百六十七次（用户报障"后台一直在不停地扫"，日志实证 [reset][已启动][分屏扫描]
    //   [配色] 四条日志成环——即 startHint 被链式反复调用）：
    //   ①caller 标签——startOrReport 每个调用方带名进入，控制台一眼定位驱动方；
    //   ②同参防抖——30s 内同参数且上次启动成功时忽略重复启动。startHint 每次都
    //   resetScan（侧栏清空）+ 整页重扫，重复调用纯属浪费；设置真变化（签名不同）、
    //   模块已停（enabled=false 路径随每次启动翻新时间戳自然放行）、上次失败均放行。
    //   防抖命中必打 warn（不静默），高频出现即暴露循环调用方。
    let _lastStartSig = '';
    let _lastStartOkAt = 0;
    const _startSig = (s) => [s.rankThreshold, s.annotateOov, s.annotateRepeat, s.textStyle,
      s.hintFirstEnabled, s.hintFirstBg, s.hintFirstFg,
      s.hintLaterEnabled, s.hintLaterBg, s.hintLaterFg,
      s.hintSideAnnotation, s.hintAnnotationBg, s.hintAnnotationFg].join('|');
    const startOrReport = async (settings, caller) => {
      const sig = _startSig(settings);
      if (_impl && sig === _lastStartSig && (Date.now() - _lastStartOkAt) < 30000) {
        console.warn('[VocabRadar][text-hint] startHint 防抖命中（30s 内同参数已启动，'
          + Math.round((Date.now() - _lastStartOkAt) / 1000) + 's 前），忽略本次（caller=' + caller
          + '）。此日志高频出现=有调用方在循环重启');
        return;
      }
      console.log('[VocabRadar][text-hint] startHint 调用 (caller=' + caller + ')');
      try {
        await _impl.startHint(settings);
        _lastStartSig = sig;
        _lastStartOkAt = Date.now();
        window.__beaverHintBoot = { at: Date.now(), textHintEnabled: !!settings.textHintEnabled, ok: true, error: null };
      } catch (e) {
        _lastStartSig = ''; // 失败允许重试
        window.__beaverHintBoot = { at: Date.now(), textHintEnabled: !!settings.textHintEnabled, ok: false, error: String((e && e.message) || e) };
        console.error('[VocabRadar][text-hint] startHint 异常:', e);
      }
    };

    const settings = await _hintGetSettings();
    // 272次：初始启动判据并入停用规则——提示被停则不 startHint（reconcile 的
    // wantEnabled 亦含规则判定，规则解除后自动恢复）；查询不受影响。
    const _bootHintSup = await _hintSuppressed();
    // 启动结果元数据（诊断窗展示"为什么没启动"）
    window.__beaverHintBoot = {
      at: Date.now(),
      textHintEnabled: !!settings.textHintEnabled,
      textStyle: settings.textStyle || '',
      ok: null,
      error: null
    };
    if (settings.textHintEnabled && !_bootHintSup) {
      await startOrReport(settings, 'init');
    } else if (_bootHintSup) {
      console.log('[VocabRadar][text-hint] init: 停用规则命中（网页提示），不启动提示');
    }
    // 文本样式差异化（粗细/斜体/下划线/阴影等）单独应用
    // 318次：哨兵 'none' 改 truthy 判定（空串=未启用）。
    if (settings.textStyle) {
      _impl.applyTextStyleClass(settings.textStyle);
    }
    // 301次：个性化/用户条目文本规则初始刷新（提示被停用规则拦下时也刷新，查询面板同样式）
    try { _impl.refreshAnnExtraCss(settings.annotationCustom, settings.annotationUserStyles); } catch (_) { /* ignore */ }
    // 反思（2026-08-14 第五十六次自愈）：若存储要求启动但模块仍处于未启用态
    //   （首轮 startHint 被并发/页面时序干扰），延迟重试一次，避免"网页无提示"。
    //   272次：提示被停用规则命中时同样不自愈（否则对抗规则）。
    if (settings.textHintEnabled && !_bootHintSup) {
      setTimeout(async () => {
        const st = await _impl.getDiagState().catch(() => null);
        if (st && st.effective && st.effective.enabled === false) {
          console.warn('[VocabRadar][text-hint] 启动后仍处于禁用态，自动重试 startHint');
          _hintGetSettings().then((s) => startOrReport(s, 'self-heal-3s'));
        }
      }, 3000);
    }

    // 反思（2026-08-14 第五十六次根因修正）：诊断实证 storage.textHintEnabled 由 false
    //   变为 true 后，本 content script 的 storage.onChanged 并未触发（startedEver=false），
    //   导致"网页无提示"。onChanged 事件在内容脚本侧偶发丢失（跨上下文消息不可靠）。
    //   修正：不再依赖事件唯一通道，新增对账(reconcile)机制——定时 + 页面重新可见/聚焦时
    //   直接读取 storage 与模块运行态比对：存储要求启用而模块未启用 → 自动 startHint；
    //   参数漂移（rankThreshold/annotateOov）→ 热同步。此机制不改任何默认值，纯自愈。
    //   对账日志走 console.warn，可被诊断悬浮窗"运行日志"捕获，便于确认恢复路径。
    let _lastImplNullWarn = 0;   // 第二百次：_impl=null 的限频告警时间戳
    let _lastMissingKeyWarn = 0; // 第二百零三次：textHintEnabled 缺键的限频告警时间戳
    let _lastSessionStopWarn = 0; // 2026-09-08：会话停用期 reconcile 跳过的限频告警时间戳
    const reconcile = async () => {
      // 第二百次：_impl=null 不再静默——模块图未装载（挂起/失败）是"整页无提示"的直接
      //   证据，对账周期必须出声（30s 限频防刷屏），并带上 boot.state 供诊断窗/日志取用。
      if (!_impl) {
        const now = Date.now();
        if (!_lastImplNullWarn || now - _lastImplNullWarn > 30000) {
          _lastImplNullWarn = now;
          console.warn('[VocabRadar][text-hint] 对账: 模块图尚未装载（_impl=null），'
            + 'boot=' + JSON.stringify(window.__beaverHintBoot || null));
        }
        return;
      }
      let st = null;
      try { st = await _impl.getDiagState(); } catch (_) { /* 模块尚未就绪 */ }
      if (!st || !st.effective) return;
      let s = null;
      try { s = await _hintGetSettings(); } catch (_) { return; }
      // 第一百三十七次：恢复分支防御——旧版把含 textHintEnabled=undefined 的 settings
      //   原样传给 startOrReport，startHint 内 falsy 判定静默中止，5s 对账永远空转
      //   （用户日志实证）。_hintGetSettings 已加固，此处再兜底归一化并留痕。
      if (s && s.textHintEnabled === undefined) {
        // 第二百零三次：限频——新装/新浏览器档案从未写入该键时，此 warn 每 5s 必刷，
        //   淹没真日志（用户实测一屏全是它）。60s 至多一条；键真异常时线索仍在。
        const _now = Date.now();
        if (!_lastMissingKeyWarn || _now - _lastMissingKeyWarn > 60000) {
          _lastMissingKeyWarn = _now;
          console.warn('[VocabRadar][text-hint] 对账: settings.textHintEnabled 缺键（读取异常），按启用处理（60s 限频）');
        }
        s.textHintEnabled = true;
        // 第二百四十五次（用户拍板"修"）：补救只写内存不回写 storage，缺键状态永远存在，
        //   警告每 60s 反复出现（用户日志实证）。与 startHint 入口写法（L106）同款回写
        //   顶层键，一次回写后键常驻，警告此后不再出现。回写失败静默（下轮对账再试）。
        try { await chrome.storage.local.set({ textHintEnabled: true }); } catch (_) { /* ignore */ }
      }
      // 反思（2026-08-15 第五十八次·续）：判定语义统一为"仅显式 false 才停用"。
      //   诊断实证 storage.textHintEnabled=undefined（键缺失或异常值），旧判定 `if (s.textHintEnabled)`
      //   把 undefined 判为 falsy → 走停用分支 → stopHint 杀掉正常启动的模块（"高亮闪一下又消失"）。
      //   _hintGetSettings 默认 true，undefined 应视为启用（与 guide.js `!== false`、popup 语义一致）。
      // 第二百七十次：wantEnabled 并入停用规则判定——命中「网页提示」规则时
      //   与显式停用同语义（走下方停用分支 stopHint；解除后本判定放行自动 startHint）
      const _supHint = await _hintSuppressed();
      if (_supHint && st.effective.enabled) {
        console.warn('[VocabRadar][text-hint] 对账: 停用规则命中（网页提示），保持停止');
      }
      const wantEnabled = (s.textHintEnabled !== false) && !_supHint;
      // 2026-09-08：本页会话停用中（侧栏 ✕ 关闭触发）——存储仍要求启用也不自动复活，
      //   否则 stopForPage 撤掉的注解 5s 内被对账冲回（用户："影响并未消失"）。
      //   限频留痕不静默。
      if (wantEnabled && _sessionStop) {
        const _nowSS = Date.now();
        if (!_lastSessionStopWarn || _nowSS - _lastSessionStopWarn > 60000) {
          _lastSessionStopWarn = _nowSS;
          console.warn('[VocabRadar][text-hint] 对账: 本页会话停用中（侧栏✕关闭），跳过自动 startHint（60s 限频）');
        }
        return;
      }
      if (wantEnabled) {
        if (!st.effective.enabled || st.effective.startedEver === false) {
          // 诊断（2026-08-20 第八十六次补充③）：打印启用态全貌，定位"对账恢复"真实原因
          //   ——startedEver=false 说明首轮 startHint 未被调用（storage 当时为 false）；
          //   lastStartError 非空说明 startHint 抛错；contextValid=false 说明扩展上下文已失效。
          console.warn('[VocabRadar][text-hint] 对账: 存储要求启用但模块未启用' +
            '（storage 事件可能丢失），自动恢复 startHint' +
            ' | effective.enabled=' + st.effective.enabled +
            ' | startedEver=' + st.effective.startedEver +
            ' | lastStartError=' + (st.effective.lastStartError || '(无)') +
            ' | contextValid=' + st.effective.contextValid +
            ' | storage.textHintEnabled=' + s.textHintEnabled +
            ' | boot=' + JSON.stringify(window.__beaverHintBoot || null));
          // 第一百三十六次：textHintEnabled=undefined（键缺失/异常值）时同样打 storage 键
          //   快照——旧版只在"停用分支"打印，用户日志实证恢复分支也会出现 undefined，
          //   需定位键是否真存在及其类型（boot 显示 false、对账时 undefined 的矛盾来源）。
          if (s.textHintEnabled === undefined) {
            try {
              chrome.storage.local.get(null, (all) => {
                console.warn('[VocabRadar][text-hint] 对账诊断 storage 键(恢复分支):', Object.keys(all || {}).join(', '),
                  '| textHintEnabled 类型=', all && all.textHintEnabled !== undefined
                    ? (typeof all.textHintEnabled) + '=' + JSON.stringify(all.textHintEnabled) : '(键缺失)');
              });
            } catch (_) { /* ignore */ }
          }
          window.__beaverHintBoot = {
            at: Date.now(), textHintEnabled: true, ok: true, error: null, recovered: true
          };
          await startOrReport(s, 'reconcile');
          return;
        }
        // 参数漂移对账（事件丢失时热同步，不等下一次 onChanged）
        if (st.effective.rankThreshold !== s.rankThreshold) {
          console.warn('[VocabRadar][text-hint] 对账: rankThreshold ' +
            st.effective.rankThreshold + ' → ' + s.rankThreshold);
          _impl.setRankThreshold(s.rankThreshold);
        }
        if (st.effective.annotateOov !== s.annotateOov) {
          console.warn('[VocabRadar][text-hint] 对账: annotateOov ' +
            st.effective.annotateOov + ' → ' + s.annotateOov);
          _impl.setAnnotateOov(s.annotateOov);
        }
        if (st.effective.annotateRepeat !== s.annotateRepeat) {
          console.warn('[VocabRadar][text-hint] 对账: annotateRepeat ' +
            st.effective.annotateRepeat + ' → ' + s.annotateRepeat);
          _impl.setAnnotateRepeat(s.annotateRepeat);
        }
        // 326次：配色开关漂移对账——hintLaterEnabled/hintSideAnnotation 走 updateColors
        //   通道，onChanged 偶发丢失（v56 已实证 storage 事件丢失）时运行态永久 stale，
        //   即"弹窗关了、页上还多处亮"。updateColors 已重算 colors（325次），此处调即自愈
        //   （只写 CSS 变量+类名，无 DOM 结构操作，不触发 08-06"点几次消失"）。
        if (typeof st.effective.laterEnabled === 'boolean' || typeof st.effective.sideAnnotation === 'boolean') {
          const wantLater = (s.hintLaterEnabled === true);
          const wantSide = (s.hintSideAnnotation === true);
          if ((st.effective.laterEnabled === true) !== wantLater
            || (st.effective.sideAnnotation === true) !== wantSide) {
            console.warn('[VocabRadar][text-hint] 对账: 配色开关漂移（later '
              + st.effective.laterEnabled + ' → ' + wantLater + '，side '
              + st.effective.sideAnnotation + ' → ' + wantSide + '），热同步 updateColors');
            _impl.updateColors(s);
          }
        }
      } else if (st.effective.enabled) {
        // 反思（2026-08-15 第五十八次·续）：诊断窗手动操作（启动/重扫/调参等）后 8s 内
        //   不对账停用——用户正在调试，立即停掉会"高亮闪一下又消失"。
        //   超过窗口仍不一致（storage 明确停用而模块启用）才 stopHint。
        if (Date.now() - _lastManualAt < 8000) {
          console.warn('[VocabRadar][text-hint] 对账: 存储要求停用但模块仍启用，' +
            '检测到最近 8s 内手动操作，跳过自动 stopHint（storage.textHintEnabled=' +
            s.textHintEnabled + '）');
          // 反思（2026-08-15 第五十八次·续）：storage.textHintEnabled 异常时打 storage 键快照，
          //   定位"启动时 true、对账时 undefined"的来源（键是否真存在、值类型）。
          if (s.textHintEnabled === undefined) {
            try {
              chrome.storage.local.get(null, (all) => {
                console.warn('[VocabRadar][text-hint] 对账诊断 storage 键:', Object.keys(all || {}).join(', '),
                  '| textHintEnabled 类型=', all && all.textHintEnabled !== undefined
                    ? (typeof all.textHintEnabled) + '=' + JSON.stringify(all.textHintEnabled) : '(键缺失)');
              });
            } catch (_) { /* ignore */ }
          }
          return;
        }
        // 反思（2026-08-15 第五十八次·续）：storage.textHintEnabled=undefined 时打印
        //   storage 键快照，定位异常值来源（诊断实证：启动时 true、5s 后 undefined）。
        if (s.textHintEnabled === undefined) {
          try {
            chrome.storage.local.get(null, (all) => {
              console.warn('[VocabRadar][text-hint] 对账诊断 storage 键:', Object.keys(all || {}).join(', '),
                '| textHintEnabled 类型=', typeof all && all.textHintEnabled !== undefined
                  ? (typeof all.textHintEnabled) + '=' + JSON.stringify(all.textHintEnabled) : '(键缺失)');
            });
          } catch (_) { /* ignore */ }
        }
        console.warn('[VocabRadar][text-hint] 对账: 存储要求停用但模块仍启用，自动 stopHint' +
          '（storage.textHintEnabled=' + s.textHintEnabled + '）');
        _lastStartSig = '';   // 第二百六十九次：停用即清防抖签名，之后再启用不被 30s 防抖误拦
        _impl.stopHint();
      }
    };
    setInterval(reconcile, 5000);
    // 反思（2026-08-20 第八十六次补充③）：首轮对账提前到 1.5s——若首轮 startHint 未启动
    //   （storage 变更事件丢失，v56 已实证），旧版要等首个 5s 周期才恢复，用户感知"网页提示
    //   出现很慢"。提前一档把恢复延迟从 ~5s 降到 ~1.5s；模块正常启用时 reconcile 为空操作。
    setTimeout(reconcile, 1500);
    // 从引导页切回网页标签时立即对账（替代依赖 onChanged 的即时性）
    const reconcileOnVisible = () => { if (document.visibilityState === 'visible') reconcile(); };
    document.addEventListener('visibilitychange', reconcileOnVisible);
    window.addEventListener('focus', reconcileOnVisible);

    // 记录右键点击位置（用于面板定位）
    // 反思（2026-07-08）：用户反馈"右键查询的飘窗固定不动"。
    //   根因：contextmenu 监听在冒泡阶段，B站/YouTube 播放器常 stopPropagation 阻止冒泡，
    //   导致 _lastClickX/Y 为 null，positionPanel 回退到 (16,16) 固定位置。
    //   修正：改用 capture 阶段（第三参数 true），在冒泡被拦截前捕获坐标。
    let _lastClickX = null;
    let _lastClickY = null;
    document.addEventListener('contextmenu', (e) => {
      _lastClickX = e.clientX;
      _lastClickY = e.clientY;
    }, true);

    // 320次：选区文本净化——右键菜单 msg.text 来自 SW 的 selectionText，会把已插入
    //   页面的 .beaver-page-insert 译文 / .beaver-side-ann 注释文本一并囊括（用户反馈
    //   "先翻译一个词再选中一段翻译会让之前翻译囊括进来污染"）。从实时选区
    //   cloneContents 复制到离屏容器，剔除扩展插入节点后取 textContent；选区已丢失
    //   或剔除后为空则返回 ''，由调用方回落 msg.text。
    function _cleanSelectionText() {
      try {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return '';
        const range = sel.getRangeAt(0);
        if (!range.startContainer || !range.startContainer.isConnected) return '';
        const holder = document.createElement('div');
        holder.appendChild(range.cloneContents());
        holder.querySelectorAll('.beaver-page-insert, .beaver-side-ann').forEach((n) => n.remove());
        return String(holder.textContent || '').replace(/\s+/g, ' ').trim();
      } catch (_) { return ''; }
    }

    // 右键菜单查词消息
    // 272次：SHOW_CONTEXT_PANEL 由 Query 可用性门控，不再由网页提示负责——提示停了查询仍可用；
    //   OPEN_QUERY_BAR——右键菜单无选中文本时弹查询栏输入（转发 window 事件给文本侧栏 UI）。
    // 286次：两者分键门控——有选中文本走右键查询开关，无选中走查询栏开关。
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'SHOW_CONTEXT_PANEL' && msg.text) {
        _contextLookupAvailable().then((ok) => {
          if (!ok) {
            console.log('[VocabRadar][text-hint] 右键查询被开关/停用规则关闭，忽略');
            return;
          }
          // 320次：净化后查询——剥离已插入译文/注释，避免污染查询文本；净化为空
          //   （选区已丢/全被剔除）回落原始 msg.text，保证功能不中断
          const cleanText = _cleanSelectionText() || msg.text;
          // w4：panel.js 已改动态转发，catch 打日志防加载失败被静默吞掉
          _impl.showContextPanel(cleanText, _lastClickX, _lastClickY)
            .catch((e) => console.error('[VocabRadar][text-hint] 查词面板加载失败', e));
        });
      }
      if (msg.type === 'OPEN_QUERY_BAR') {
        _queryBarAvailable().then((ok) => {
          if (!ok) return;
          try { window.dispatchEvent(new CustomEvent('beaver-open-query-bar')); } catch (_) { /* ignore */ }
        });
      }
      sendResponse({ ok: true });
      return true;
    });

    // 监听 sidebar OCR 结果事件（同页面 content script 通信）
    // 反思（2026-08-05 修正）：OCR 回归侧栏按钮点击截帧方式，结果通过自定义事件发送。
    //   text-hint.js 监听 'beaver-ocr-result' 事件，调用 showOcrResultPanel 显示结果。
    //   结果面板为 light DOM，生词受文本提示注释（高亮+侧邻注释），不自动消失。
    window.addEventListener('beaver-ocr-result', (e) => {
      if (!_impl) return;
      const detail = e.detail || {};
      // w4：panel.js 已改动态转发，catch 打日志防加载失败被静默吞掉
      _impl.showOcrResultPanel(detail.text || '', _lastClickX, _lastClickY, detail.info || '')
        .catch((e) => console.error('[VocabRadar][text-hint] OCR 结果面板加载失败', e));
    });
  } catch (e) {
    console.error('[VocabRadar][text-hint] 加载失败', e);
  }
}

/** gate 期间的解除观察（第二百七十次）：规则解除即 boot；boot 幂等（_booted 标记），
 *  272次：解除判据同步改为「网页提示+搜索栏不全停」（只停其一时仍需加载模块图），
 *  boot 后本监听残留无害——运行中的规则启停由 boot 内主监听与 reconcile 接管 */
function _hintInstallUnsuppressWatch() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !('deactivateRules' in changes)) return;
      if (!_hintDeactLib) return;
      _hintDeactLib.suppressionFor(location).then((sup) => {
        if (!(sup.hint && sup.query) && !_booted) {
          console.log('[VocabRadar][text-hint] 停用规则解除，启动网页提示');
          _hintBoot();
        }
      });
    });
  } catch (e) {
    console.warn('[VocabRadar][text-hint] 停用规则解除监听注册失败:', e);
  }
}

/** 读取完整设置（含默认值） */
// 第一百三十七次：曾改用带 DEFAULTS 对象的 get()+重试兜底。
// 第一百三十八次（用户复测日志实证仍出现「缺键」且本轮不可能由上述实现产出）：
//   带默认值对象的 chrome.storage.local.get 存在稳定的缺键异常，重试无效；
//   而裸 get(null)（对账诊断快照）两次均完整返回全部键与正确值。
//   釜底抽薪：改用 get(null) + JS 手工合并默认值——结构上杜绝任何一层
//   （Chrome 默认值合并/序列化）参与，「读到的值要么是存储实值要么是本地默认」，
//   绝不再产出 undefined。绝不把"读失败"当"用户关了"。
function _hintGetSettings() {
  const DEFAULTS = {
    textHintEnabled: true,
    // 272次：Query 独立开关（旧键，286次拆分为右键查询/查询栏后仅作回退，见 _storeFlag）
    queryEnabled: true,
    // 301次：注释个性化参数＋用户样式（pickColors 经 resolveAnnEntry 解析，直通 settings）
    annotationCustom: null,
    annotationUserStyles: [],
    // 反思（2026-08-14 第五十四次修正）：恢复默认 5000，撤销第五十二次误改的 0
    rankThreshold: 5000,
    annotateOov: false,  // 注释表外词（2026-08-14 第五十四次：键名改名 + 默认不选）
    annotateRepeat: false,  // 注释重复生词（2026-08-15 第六十二次：默认不选）
    hintFirstEnabled: true,
    // 反思（2026-08-18 第七十三次修正）：用户明确"网页提示默认配色是单词绿底白字，
    //   注释是白底绿字"。旧版 #0d2014 墨绿近黑被用户视为黑色。
    hintFirstBg: '#2e6b43',
    hintFirstFg: '#ffffff',
    // 反思（2026-08-05 修正）：用户要求"生词多次出现 复选框 默认空"
    hintLaterEnabled: false,
    hintLaterBg: '#2e6b43',
    hintLaterFg: '#ffffff',
    // 侧邻注释（2026-08-05）：用户要求"侧邻提示 复选框 默认空"
    //   注释=白底绿字（用户明确）
    hintSideAnnotation: false,
    hintAnnotationBg: '#ffffff',
    hintAnnotationFg: '#2e6b43',
    // 文本样式预设（第五十一次）：TEXT_STYLES 中的 id（318次：'none' 非法，未启用=空串）
    // 308次：默认改绿色下划线样式（与 guide.js defaults 同步，网页提示端兜底须一致）
    // 309次第二轮：名字定稿 'green-underline'（Green Underline，用户裁定），颜色主题化不变
    // 309次第五轮（用户四栏统一裁定）：默认改 'green-background'（生词绿底白字），与 guide.js 一致
    // 318次：默认语义=代指常量 ANN_DEFAULT_STYLE 的锚定（styles.js 唯一真源，版本变化才改
    //   常量值，无 storage 指针键）；本文件 classic script 不便 import styles.js，此字面量
    //   是常量的镜像兜底（仅 storage 全空时生效），真值锚点见 lib/styles.js
    textStyle: 'green-background',
    // 279次：注释样式候选池（三处共享）
    // 309次第五轮（用户四栏统一裁定）：默认 'green-background'，与 guide.js defaults 同步
    // 318次：同上——'green-background' 是 ANN_DEFAULT_STYLE 常量的镜像兜底，非写死绝对回落
    annotationStyle: 'green-background',
    // 280次：侧邻注释模板（annBrackets 布尔退役；
    //   classic script 不便 import styles.js，默认值/迁移字面量与 lib/styles.js 保持一致）
    // 284次：默认组合 {target} {annotation}（空格分隔，与 styles.js DEFAULT_ANN_TEMPLATE 同步）
    // 306次：默认去空格 '{target}{annotation}'
    annTemplate: '{target}{annotation}'
  };
  return new Promise((resolve) => {
    const attempt = (retriesLeft) => {
      try {
        chrome.storage.local.get(null, (all) => {
          const err = chrome.runtime.lastError;
          if (err || !all || typeof all !== 'object') {
            console.warn('[VocabRadar][text-hint] storage.get(null) 异常:',
              err ? err.message : '返回非对象',
              retriesLeft > 0 ? '→ 重试一次' : '→ 用默认值兜底');
            if (retriesLeft > 0) { setTimeout(() => attempt(retriesLeft - 1), 300); return; }
            resolve({ ...DEFAULTS });
            return;
          }
          // 手工合并：键存在即用实值；不存在用本地默认——永不产出 undefined
          const merged = { ...DEFAULTS };
          for (const k of Object.keys(DEFAULTS)) {
            if (typeof all[k] !== 'undefined') merged[k] = all[k];
          }
          // 280次：旧 annBrackets 布尔一次性迁移——annTemplate 从未设置且旧键存在时，
          //   按旧值派生模板（true/缺省=默认模板，false=素释义）；不回写 storage，
          //   读取时派生即可（引导页保存 annTemplate 后旧键不再参与）。
          // 284次：默认模板随 DEFAULT_ANN_TEMPLATE 同步为 {target} {annotation}。
          // 306次：去空格 '{target}{annotation}'（与引导页迁移同口径）。
          if (typeof all.annTemplate === 'undefined' && typeof all.annBrackets !== 'undefined') {
            merged.annTemplate = (all.annBrackets === false) ? '{annotation}' : '{target}{annotation}';
            delete merged.annBrackets;
          }
          resolve(merged);
        });
      } catch (e) {
        console.warn('[VocabRadar][text-hint] storage.get 抛错，用默认值兜底:', e);
        resolve({ ...DEFAULTS });
      }
    };
    attempt(1);
  });
}
