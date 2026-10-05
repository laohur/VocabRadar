// 全站文本提示入口（classic script）
// 用动态 import 加载 ES module（与 bilibili.js 同模式），避免 content_scripts 静态 import 报错
//
// 职责：
//   - 读取设置（textHintEnabled + 配色 6 字段 + rankThreshold）
//   - 监听 storage 变化，启停提示或热更新配色
//   - 接收右键菜单消息，弹出查词面板

// boot 埋点：classic 入口开跑时刻（早于下方 ESM import）。由 th/core.js 装载时回填进
// thTiming.marks['hint:scriptStart']（同一 performance.now() 时间基），诊断窗
// 「网页提示链路耗时」表显示三段：DCL→classic 入口→startHint→首高亮。
try { window.__beaverHintScriptAt = performance.now(); } catch (_) { /* ignore */ }

let _impl = null;

// === 启动链路可观测 + 自恢复 ===
// import() 失败/挂起必须出声（不遮蔽错误）：①boot.state 记 loading/ok/error/hang；
// ②10s/30s 挂起告警；③失败 3s 后重试一次。
let _importSettled = false;
function _bootPatch(patch) {
  try {
    window.__beaverHintBoot = Object.assign({}, window.__beaverHintBoot || {}, patch);
  } catch (_) { /* ignore */ }
}

// 同步 myWords 到网页 localStorage（供 VocabRadar 网站 My Words 页读取）
// 存储键 vocabradar_ext_my_words，格式 {new:[], known:[]}（对齐扩展 storage.myWords）
function _syncMyWordsToWeb(mw) {
  try {
    const data = { new: mw.new || [], known: mw.known || [] };
    localStorage.setItem('vocabradar_ext_my_words', JSON.stringify(data));
  } catch (_) { /* localStorage 写入失败静默忽略 */ }
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

// === 停用规则（Deactivate）gate ===
// 命中「网页提示」停用规则时本页尽量不活动：不加载模块图（无 import）、不挂
// 5s 对账定时器/可见性监听，仅留一个轻量 storage 监听，规则解除后再走完整
// _hintBoot()。匹配/存储逻辑唯一来源 src/lib/deactivate.js（构建时原样进 dist，
// classic 入口可动态 import）。
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
// Query（右键查询+查询栏）可用性：停用规则 query 项 + 全局开关。
// 与网页提示解耦：提示关/停不影响查询，查询关/停不影响提示。
// 右键查询=contextLookupEnabled，查询栏=queryBarEnabled（旧键 queryEnabled 仅作未设置时回退）。
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
    // 整页不加载的判据：「网页提示+搜索栏双停」——提示被停时仍需加载模块图
    // 以服务右键查询/搜索栏（SHOW_CONTEXT_PANEL 监听在本文件）。
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

// === boot：启动主体（幂等；含停用规则实时停用分支）===
async function _hintBoot() {
  if (_booted) return;
  _booted = true;
  try {
    // 挂起看门狗：10s 提醒、30s 定性
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

    // 诊断挂钩：向诊断悬浮窗暴露真实运行实例的状态。
    //   不能由 diagnose.js 二次 import 本模块（会得到独立实例，看不到运行时状态）。
    window.__beaverHintDiag = () => (_impl && typeof _impl.getDiagState === 'function')
      ? _impl.getDiagState()
      : null;

    // 控制挂钩：诊断悬浮窗操作按钮直接调用模块方法。
    //   既写 storage（全链路同步）又直接调 _impl（绕过可能丢失的 onChanged 事件），幂等可重入。
    //   start 先把 textHintEnabled 写 true 再启动，否则 reconcile 会把手动启动停掉。
    //   任意手动操作都刷新 _lastManualAt：reconcile 在最近 8s 内有手动操作时不自动 stopHint。
    let _lastManualAt = 0;
    const markManual = () => { _lastManualAt = Date.now(); };
    // 本页会话停用标记——网页侧栏 ✕ 关闭时连带撤掉页面高亮/注解。不写 storage
    //   （只影响本页，刷新即恢复），但必须拦住 reconcile 的"存储要求启用→自动
    //   startHint"复活路径。清除点：诊断窗 start / popup 显式打开 textHintEnabled（onChanged）。
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
      // 侧栏 ✕ 关闭专用：本页会话停用（不写 storage；reconcile 尊重该标记不再自动复活）。
      //   停用即清防抖签名，此后重新启动不会被 30s 同参防抖误拦（防抖只拦"运行中的重复启动"）。
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
        // 'none' 哨兵非法——空串表示未启用文本样式
        chrome.storage.local.set({ textStyle: id || '' });
        if (_impl) _impl.applyTextStyleClass(id || '');
      }
    };

    // 语言切换重扫防抖定时器（下方 onChanged 的 learnLanguage/meaningLanguage 分支用）
    let _langRescanTimer = null;
    // storage 监听器必须先于 startHint 注册：若启动抛错/挂起，监听器永不注册，
    //   后续在引导页/弹窗改设置全部失效。启动结果写窗口元数据供诊断悬浮窗展示。
    chrome.storage.onChanged.addListener((changes) => {
      if (!_impl) return;
      // 停用规则变化：命中「网页提示」立即停（语义同显式停用，清会话停用标记与
      //   防抖签名）；解除不在此处自动重启，交给 reconcile 在下一周期自然恢复，
      //   避免双启动竞态。
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
      // 主开关：仅显式 false 才停用；newValue 为 undefined（键被删除）不 stopHint
      if ('textHintEnabled' in changes) {
        const _nv = changes.textHintEnabled.newValue;
        const _ov = changes.textHintEnabled.oldValue;
        if (_nv === false) {
          // 显式停用路径：标记已无意义，一并复位防悬挂
          _sessionStop = false;
          _lastStartSig = '';   // 停用即清防抖签名，之后再启用不被 30s 防抖误拦
          _impl.stopHint();
        } else if (_ov === false) {
          // 只有真·关→开切换（oldValue===false，popup/引导页显式重开=用户最新意图）
          //   才解除本页会话停用并重启。对任何非 false 写入都重启的话，同值回声写
          //   （onChanged 对"写到相同值"也触发）会把 ✕ 关侧栏的会话停用撤销并复活提示。
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
      // 个性化/用户条目变化 → 刷新 extra 文本规则并重派颜色变量（无需重扫；类名不变即时生效）
      if ('annotationCustom' in changes || 'annotationUserStyles' in changes) {
        _hintGetSettings().then((s) => {
          _impl.refreshAnnExtraCss(s.annotationCustom, s.annotationUserStyles);
          _impl.updateColors(s);
        });
      }
      // 阈值变化 → 重扫
      if ('rankThreshold' in changes) {
        _impl.setRankThreshold(changes.rankThreshold.newValue);
      }
      // 词频上界变化 → 按新上界重扫（词频范围，key rankThresholdMax）
      if ('rankThresholdMax' in changes) {
        _impl.setRankThresholdMax(changes.rankThresholdMax.newValue);
      }
      // My Words（用户生词/熟词表）变化 → 全量重扫（熟词隐藏/生词显示双向生效）
      if ('myWords' in changes) {
        const _mw = changes.myWords.newValue || {};
        _impl.setMyWordsLists(_mw.new, _mw.known);
        // 同步到网页 localStorage（供 VocabRadar 网站 My Words 页读取）
        _syncMyWordsToWeb(_mw);
      }
      // 注释表外词开关变化 → 重扫
      if ('annotateOov' in changes) {
        _impl.setAnnotateOov(changes.annotateOov.newValue);
      }
      // 注释重复生词开关变化 → 重扫
      if ('annotateRepeat' in changes) {
        _impl.setAnnotateRepeat(changes.annotateRepeat.newValue);
      }
      // 侧邻注释模板变化 → 清缓存重扫
      if ('annTemplate' in changes) {
        _impl.setAnnTemplate(changes.annTemplate.newValue);
      }
      // 学习/释义语言切换 → 词典投影按语言键构建，旧高亮词面/释义全部过期：清缓存
      //   拆旧包裹，等词典按新语言重建就绪后整页重扫（用户："改了语言，还是按照英语扫"）。
      //   防抖 800ms 合并三处 UI（引导页/侧栏/弹窗）可能的连续多键写入，只拆扫一次；
      //   同值回声写（newValue===oldValue）跳过，避免无谓的全页闪烁。
      if ('learnLanguage' in changes || 'meaningLanguage' in changes) {
        const _llEcho = !changes.learnLanguage || changes.learnLanguage.newValue === changes.learnLanguage.oldValue;
        const _mlEcho = !changes.meaningLanguage || changes.meaningLanguage.newValue === changes.meaningLanguage.oldValue;
        if (!_llEcho || !_mlEcho) {
          if (_langRescanTimer) clearTimeout(_langRescanTimer);
          _langRescanTimer = setTimeout(() => {
            _langRescanTimer = null;
            try { _impl.onLangChanged(); } catch (e) { console.warn('[VocabRadar][text-hint] 语言切换重扫失败:', e); }
          }, 800);
        }
      }
      // 配色字段变化 → 热更新样式（无需重扫）
      const colorKeys = [
        'hintFirstEnabled', 'hintFirstBg', 'hintFirstFg',
        'hintLaterEnabled', 'hintLaterBg', 'hintLaterFg',
        // 侧邻注释：注释底色/字色热更新
        // annotationStyle 已移出——pickColors 不读它，web-sidebar.js 独立监听该键
        'hintSideAnnotation', 'hintAnnotationBg', 'hintAnnotationFg',
        // 统一池：textStyle 条目 wordBg/wordFg 参与变量派生，变化也热更
        'textStyle'
      ];
      if (colorKeys.some((k) => k in changes)) {
        _hintGetSettings().then((s) => _impl.updateColors(s));
      }
    });

    // 第518次（用户："改了语言，并不生效，还是按照英语扫"缺口补修）：词典后台重建
    //   完成广播无人接——切到未构建过的新语言时，onLangChanged 的 ensureReady 会随
    //   _loadDict 的"后台首建放行"提前 resolve（空词典），整页重扫 0 命中；等词频
    //   从 HF 拉完写入词典后，页侧再无人重扫，页面高亮一直空白直到手动刷新。
    //   此处监听 projection.js 的 vr-dict-rebuilt 补一轮重扫（rescanNow 自带
    //   thState.enabled 守卫，未启用空转；重复触发幂等无害）。
    window.addEventListener('vr-dict-rebuilt', () => {
      if (!_impl) return;
      try { _impl.rescanNow(); } catch (e) { console.warn('[VocabRadar][text-hint] 词典重建完成重扫失败:', e); }
    });

    // 启动文本提示（含自愈）：startHint 异常捕获并记录到 __beaverHintBoot，避免"静默不启动"。
    // ①caller 标签——startOrReport 每个调用方带名进入，控制台一眼定位驱动方；
    // ②同参防抖——30s 内同参数且上次启动成功时忽略重复启动（startHint 每次都
    //   resetScan+整页重扫，重复调用纯属浪费；参数变化/模块已停/上次失败均放行）。
    //   防抖命中必打 warn（不静默），高频出现即暴露循环调用方。
    let _lastStartSig = '';
    let _lastStartOkAt = 0;
    const _startSig = (s) => [s.rankThreshold, s.rankThresholdMax, s.annotateOov, s.annotateRepeat, s.textStyle,
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
    // 初始同步 myWords 到网页 localStorage（供 VocabRadar 网站 My Words 页读取）
    _syncMyWordsToWeb(settings.myWords || {});
    // 初始启动判据并入停用规则——提示被停则不 startHint（reconcile 的 wantEnabled
    // 亦含规则判定，规则解除后自动恢复）；查询不受影响。
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
    // 文本样式差异化（粗细/斜体/下划线/阴影等）单独应用；空串=未启用
    if (settings.textStyle) {
      _impl.applyTextStyleClass(settings.textStyle);
    }
    // 个性化/用户条目文本规则初始刷新（提示被停用规则拦下时也刷新，查询面板同样式）
    try { _impl.refreshAnnExtraCss(settings.annotationCustom, settings.annotationUserStyles); } catch (_) { /* ignore */ }
    // 自愈：若存储要求启动但模块仍处于未启用态（首轮 startHint 被并发/页面时序干扰），
    //   延迟重试一次，避免"网页无提示"。提示被停用规则命中时同样不自愈（否则对抗规则）。
    if (settings.textHintEnabled && !_bootHintSup) {
      setTimeout(async () => {
        const st = await _impl.getDiagState().catch(() => null);
        if (st && st.effective && st.effective.enabled === false) {
          console.warn('[VocabRadar][text-hint] 启动后仍处于禁用态，自动重试 startHint');
          _hintGetSettings().then((s) => startOrReport(s, 'self-heal-3s'));
        }
      }, 3000);
    }

    // 对账（reconcile）：storage.onChanged 在内容脚本侧偶发丢失，不作为唯一通道——
    //   定时 + 页面重新可见/聚焦时直接比对 storage 与模块运行态：
    //   存储要求启用而模块未启用 → 自动 startHint；参数漂移 → 热同步。
    //   纯自愈机制，不改任何默认值。对账日志走 console.warn，可被诊断悬浮窗捕获。
    let _lastImplNullWarn = 0;    // _impl=null 限频告警时间戳（30s）
    let _lastMissingKeyWarn = 0;  // textHintEnabled 缺键限频告警时间戳（60s）
    let _lastSessionStopWarn = 0; // 会话停用期 reconcile 跳过限频告警时间戳（60s）
    const reconcile = async () => {
      // _impl=null = 模块图未装载（挂起/失败），是"整页无提示"的直接证据，必须出声
      //   （限频防刷屏），并带上 boot.state 供诊断窗/日志取用。
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
      // 兜底归一化：旧版曾把含 textHintEnabled=undefined 的 settings 传给
      //   startOrReport，startHint 内 falsy 判定静默中止，对账永远空转。_hintGetSettings
      //   已保证不产出 undefined，此处再防御一层并留痕。
      if (s && s.textHintEnabled === undefined) {
        // 限频：新装/新浏览器档案从未写入该键时，此 warn 每 5s 必刷，淹没真日志——60s 至多一条
        const _now = Date.now();
        if (!_lastMissingKeyWarn || _now - _lastMissingKeyWarn > 60000) {
          _lastMissingKeyWarn = _now;
          console.warn('[VocabRadar][text-hint] 对账: settings.textHintEnabled 缺键（读取异常），按启用处理（60s 限频）');
        }
        s.textHintEnabled = true;
        // 补救须回写 storage 顶层键（与 startHint 入口同款）：只写内存则缺键状态
        //   永远存在，警告每 60s 反复出现；一次回写后键常驻。回写失败静默（下轮对账再试）。
        try { await chrome.storage.local.set({ textHintEnabled: true }); } catch (_) { /* ignore */ }
      }
      // 判定语义统一为"仅显式 false 才停用"：undefined（缺键/异常值）视为启用，
      //   与 guide.js `!== false`、popup 语义一致。
      // wantEnabled 并入停用规则判定——命中「网页提示」规则时与显式停用同语义
      //   （走下方停用分支 stopHint；解除后本判定放行自动 startHint）。
      const _supHint = await _hintSuppressed();
      if (_supHint && st.effective.enabled) {
        console.warn('[VocabRadar][text-hint] 对账: 停用规则命中（网页提示），保持停止');
      }
      const wantEnabled = (s.textHintEnabled !== false) && !_supHint;
      // 本页会话停用中（侧栏 ✕ 关闭触发）——存储仍要求启用也不自动复活，否则
      //   stopForPage 撤掉的注解 5s 内被对账冲回。限频留痕不静默。
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
          // 日志带启用态全貌（startedEver/lastStartError/contextValid），定位"对账恢复"真实原因
          console.warn('[VocabRadar][text-hint] 对账: 存储要求启用但模块未启用' +
            '（storage 事件可能丢失），自动恢复 startHint' +
            ' | effective.enabled=' + st.effective.enabled +
            ' | startedEver=' + st.effective.startedEver +
            ' | lastStartError=' + (st.effective.lastStartError || '(无)') +
            ' | contextValid=' + st.effective.contextValid +
            ' | storage.textHintEnabled=' + s.textHintEnabled +
            ' | boot=' + JSON.stringify(window.__beaverHintBoot || null));
          // textHintEnabled=undefined 时打 storage 键快照——恢复分支也会出现 undefined，
          //   需定位键是否真存在及其类型
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
        // 配色开关漂移对账——hintLaterEnabled/hintSideAnnotation 走 updateColors 通道，
        //   onChanged 偶发丢失时运行态永久 stale（"弹窗关了、页上还多处亮"）。
        //   updateColors 只写 CSS 变量+类名，无 DOM 结构操作，此处调用即自愈。
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
        // 诊断窗手动操作（启动/重扫/调参等）后 8s 内不对账停用——用户正在调试，
        //   立即停掉会"高亮闪一下又消失"。超过窗口仍不一致才 stopHint。
        if (Date.now() - _lastManualAt < 8000) {
          console.warn('[VocabRadar][text-hint] 对账: 存储要求停用但模块仍启用，' +
            '检测到最近 8s 内手动操作，跳过自动 stopHint（storage.textHintEnabled=' +
            s.textHintEnabled + '）');
          // textHintEnabled=undefined 时打 storage 键快照，定位异常值来源
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
        _lastStartSig = '';   // 停用即清防抖签名，之后再启用不被 30s 防抖误拦
        _impl.stopHint();
      }
    };
    setInterval(reconcile, 5000);
    // 首轮对账提前到 1.5s——若首轮 startHint 因 storage 事件丢失未启动，
    //   不必等首个 5s 周期才恢复；模块正常启用时 reconcile 为空操作。
    setTimeout(reconcile, 1500);
    // 从引导页切回网页标签时立即对账（替代依赖 onChanged 的即时性）
    const reconcileOnVisible = () => { if (document.visibilityState === 'visible') reconcile(); };
    document.addEventListener('visibilitychange', reconcileOnVisible);
    window.addEventListener('focus', reconcileOnVisible);

    // 记录右键点击位置（用于面板定位）。
    // 必须用 capture 阶段：B站/YouTube 播放器常 stopPropagation 阻止冒泡，
    //   冒泡阶段监听拿不到坐标，面板会回退到固定 (16,16) 位置。
    let _lastClickX = null;
    let _lastClickY = null;
    document.addEventListener('contextmenu', (e) => {
      _lastClickX = e.clientX;
      _lastClickY = e.clientY;
    }, true);

    // 选区文本净化：右键菜单 msg.text 来自 SW 的 selectionText，会把已插入页面的
    //   .beaver-page-insert 译文 / .beaver-side-ann 注释文本一并囊括（"先翻译一个词
    //   再选中一段翻译，之前翻译被囊括进来污染"）。从实时选区 cloneContents 复制到
    //   离屏容器，剔除扩展插入节点后取 textContent；选区已丢失或剔除后为空则返回 ''，
    //   由调用方回落 msg.text。
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

    // 右键菜单查词消息。分键门控：有选中文本走右键查询开关（SHOW_CONTEXT_PANEL，
    //   由 Query 可用性门控，不归网页提示管——提示停了查询仍可用）；无选中走
    //   查询栏开关（OPEN_QUERY_BAR，转发 window 事件给文本侧栏 UI）。
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'SHOW_CONTEXT_PANEL' && msg.text) {
        _contextLookupAvailable().then((ok) => {
          if (!ok) {
            console.log('[VocabRadar][text-hint] 右键查询被开关/停用规则关闭，忽略');
            return;
          }
          // 净化后查询：剥离已插入译文/注释避免污染；净化为空（选区已丢/全被剔除）
          //   回落原始 msg.text，保证功能不中断
          const cleanText = _cleanSelectionText() || msg.text;
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

    // 监听 sidebar OCR 结果事件（同页面 content script 通信）：
    //   'beaver-ocr-result' → showOcrResultPanel 显示结果面板（light DOM，
    //   生词受文本提示注释，不自动消失）。
    window.addEventListener('beaver-ocr-result', (e) => {
      if (!_impl) return;
      const detail = e.detail || {};
      _impl.showOcrResultPanel(detail.text || '', _lastClickX, _lastClickY, detail.info || '')
        .catch((e) => console.error('[VocabRadar][text-hint] OCR 结果面板加载失败', e));
    });
  } catch (e) {
    console.error('[VocabRadar][text-hint] 加载失败', e);
  }
}

/** gate 期间的解除观察：规则解除即 boot；boot 幂等（_booted 标记），boot 后本监听
 *  残留无害——运行中的规则启停由 boot 内主监听与 reconcile 接管。
 *  解除判据为「网页提示+搜索栏不全停」：只停其一时仍需加载模块图（查询功能在 gate 下可用）。 */
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

// "Extension context invalidated"＝扩展更新/重载后旧内容脚本的预期态（runtime 已失效，
//   storage 同步抛错）。对账每 5s 重试会反复触发，只留痕一次，后续静默（默认值兜底不变）。
let _ctxInvalidWarned = false;

/** 读取完整设置（含默认值）。
 *  必须用 get(null) + JS 手工合并默认值：带默认值对象的 chrome.storage.local.get
 *  存在稳定的缺键异常（重试无效），而裸 get(null) 完整返回全部键。手工合并在结构上
 *  杜绝 Chrome 默认值合并/序列化参与，保证「读到的值要么是存储实值要么是本地默认」，
 *  绝不产出 undefined；绝不把"读失败"当"用户关了"。 */
function _hintGetSettings() {
  const DEFAULTS = {
    textHintEnabled: true,
    // Query 独立开关：兼容旧键（现细分为右键查询/查询栏两键，见 _storeFlag），仅作回退
    queryEnabled: true,
    // 注释个性化参数＋用户样式（pickColors 经 resolveAnnEntry 解析，直通 settings）
    annotationCustom: null,
    annotationUserStyles: [],
    // 词频下界默认 5000；上界 0 = 不限（Infinity），此键缺失会导致 My Words 过滤失效
    rankThreshold: 5000,
    rankThresholdMax: 0,
    // myWords 缺失 → startHint 传给 scan.js 的 settings 永远没有 myWords →
    //   过滤全失效（刷新/新开页面即失效）。storage.myWords={new:[],known:[]}（小写单词数组）
    myWords: { new: [], known: [] },
    annotateOov: false,  // 注释表外词，默认不选
    annotateRepeat: false,  // 注释重复生词，默认不选
    hintFirstEnabled: true,
    // 生词条目默认透明底＋绿字（用户确认的默认观感；条目显式字段优先于此兜底）
    hintFirstBg: 'transparent',
    hintFirstFg: '#2e6b43',
    // 以下三个复选框均按用户要求默认关闭
    hintLaterEnabled: false,
    hintLaterBg: 'transparent',
    hintLaterFg: '#2e6b43',
    hintSideAnnotation: false,
    hintAnnotationBg: '#ffffff',
    hintAnnotationFg: '#2e6b43',
    // 文本样式预设：TEXT_STYLES 中的 id（'none' 非法，未启用=空串）。
    //   默认 'green-background' 与 guide.js defaults 同步（用户四栏统一裁定）
    textStyle: 'green-background',
    // 注释样式候选池（三处共享），默认与 guide.js 同步
    annotationStyle: 'green-background',
    // 侧邻注释模板（annBrackets 布尔已退役）。classic script 不便 import styles.js，
    //   默认值/迁移字面量须与 lib/styles.js 的 DEFAULT_ANN_TEMPLATE 保持一致
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
          // 旧 annBrackets 布尔一次性迁移：annTemplate 从未设置且旧键存在时，按旧值
          //   派生模板（false=素释义）；不回写 storage，读取时派生即可（引导页保存
          //   annTemplate 后旧键不再参与）。口径与引导页迁移一致。
          if (typeof all.annTemplate === 'undefined' && typeof all.annBrackets !== 'undefined') {
            merged.annTemplate = (all.annBrackets === false) ? '{annotation}' : '{target}{annotation}';
            delete merged.annBrackets;
          }
          resolve(merged);
        });
      } catch (e) {
        const msg = e && (e.message || String(e));
        if (msg && /Extension context invalidated/.test(msg)) {
          if (!_ctxInvalidWarned) {
            _ctxInvalidWarned = true;
            console.warn('[VocabRadar][text-hint] storage.get 失败（扩展已更新/重载，本页内容脚本失效），用默认值兜底。刷新页面后恢复');
          }
        } else {
          console.warn('[VocabRadar][text-hint] storage.get 抛错，用默认值兜底:', e);
        }
        resolve({ ...DEFAULTS });
      }
    };
    attempt(1);
  });
}
