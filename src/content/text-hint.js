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

(async () => {
  console.log(`[VocabRadar][text-hint] content script 已加载 @ ${location.href}`);
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
        const s = await getSettings();
        await startOrReport(s);
      },
      stop: () => { markManual(); if (_impl) _impl.stopHint(); },
      // 侧栏 ✕ 关闭专用：本页会话停用（不写 storage；reconcile 尊重该标记不再自动复活）
      stopForPage: () => { markManual(); _sessionStop = true; if (_impl) _impl.stopHint(); },
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
        chrome.storage.local.set({ textStyle: id || 'none' });
        if (_impl) _impl.applyTextStyleClass(id || 'none');
      }
    };

    // 反思（2026-08-14 第五十六次修正）：storage 监听器原放在 startHint 之后注册，
    //   若 startHint 抛错/挂起，监听器永不注册 → 后续在引导页/弹窗改设置全部失效
    //   （诊断实证：effective.enabled=false 且 setRankThreshold 不生效，但 storage 值已改）。
    //   修正：先注册监听器，再启动；并在窗口挂启动结果供诊断悬浮窗展示。
    chrome.storage.onChanged.addListener((changes) => {
      if (!_impl) return;
      // 主开关
      // 反思（2026-08-15 第五十八次·续）：newValue 为 undefined（键被删除）时不应 stopHint，
      //   统一"仅显式 false 才停用"语义（与 reconcile 一致）。
      if ('textHintEnabled' in changes) {
        if (changes.textHintEnabled.newValue !== false) {
          // 2026-09-08：popup 显式（重）开主开关=用户最新意图，解除本页会话停用
          _sessionStop = false;
          getSettings().then((s) => startOrReport(s));
        } else {
          // 显式停用路径：标记已无意义，一并复位防悬挂
          _sessionStop = false;
          _impl.stopHint();
        }
        return;
      }
      // 文本样式变化 → 只换类名（颜色走 updateColors 的 CSS 变量）
      if ('textStyle' in changes) {
        _impl.applyTextStyleClass(changes.textStyle.newValue);
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
      // 配色字段变化 → 热更新样式（无需重扫）
      const colorKeys = [
        'hintFirstEnabled', 'hintFirstBg', 'hintFirstFg',
        'hintLaterEnabled', 'hintLaterBg', 'hintLaterFg',
        // 侧邻注释（2026-08-05）：注释底色/字色变化热更新；开关变化需重扫
        'hintSideAnnotation', 'hintAnnotationBg', 'hintAnnotationFg'
      ];
      if (colorKeys.some((k) => k in changes)) {
        getSettings().then((s) => _impl.updateColors(s));
      }
    });

    // 启动文本提示（含自愈）：调用 startHint 并在失败时记录诊断信息
    // 反思（2026-08-14 第五十六次）：startHint 内已尽量不抛错，但为万全，
    //   捕获异常并记录到 window.__beaverHintBoot 供诊断窗展示，避免"静默不启动"。
    const startOrReport = async (settings) => {
      try {
        await _impl.startHint(settings);
        window.__beaverHintBoot = { at: Date.now(), textHintEnabled: !!settings.textHintEnabled, ok: true, error: null };
      } catch (e) {
        window.__beaverHintBoot = { at: Date.now(), textHintEnabled: !!settings.textHintEnabled, ok: false, error: String((e && e.message) || e) };
        console.error('[VocabRadar][text-hint] startHint 异常:', e);
      }
    };

    const settings = await getSettings();
    // 启动结果元数据（诊断窗展示"为什么没启动"）
    window.__beaverHintBoot = {
      at: Date.now(),
      textHintEnabled: !!settings.textHintEnabled,
      textStyle: settings.textStyle || 'none',
      ok: null,
      error: null
    };
    if (settings.textHintEnabled) {
      await startOrReport(settings);
    }
    // 文本样式差异化（粗细/斜体/下划线/阴影等）单独应用
    if (settings.textStyle && settings.textStyle !== 'none') {
      _impl.applyTextStyleClass(settings.textStyle);
    }
    // 反思（2026-08-14 第五十六次自愈）：若存储要求启动但模块仍处于未启用态
    //   （首轮 startHint 被并发/页面时序干扰），延迟重试一次，避免"网页无提示"。
    if (settings.textHintEnabled) {
      setTimeout(async () => {
        const st = await _impl.getDiagState().catch(() => null);
        if (st && st.effective && st.effective.enabled === false) {
          console.warn('[VocabRadar][text-hint] 启动后仍处于禁用态，自动重试 startHint');
          getSettings().then((s) => startOrReport(s));
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
      try { s = await getSettings(); } catch (_) { return; }
      // 第一百三十七次：恢复分支防御——旧版把含 textHintEnabled=undefined 的 settings
      //   原样传给 startOrReport，startHint 内 falsy 判定静默中止，5s 对账永远空转
      //   （用户日志实证）。getSettings 已加固，此处再兜底归一化并留痕。
      if (s && s.textHintEnabled === undefined) {
        // 第二百零三次：限频——新装/新浏览器档案从未写入该键时，此 warn 每 5s 必刷，
        //   淹没真日志（用户实测一屏全是它）。60s 至多一条；键真异常时线索仍在。
        const _now = Date.now();
        if (!_lastMissingKeyWarn || _now - _lastMissingKeyWarn > 60000) {
          _lastMissingKeyWarn = _now;
          console.warn('[VocabRadar][text-hint] 对账: settings.textHintEnabled 缺键（读取异常），按启用处理（60s 限频）');
        }
        s.textHintEnabled = true;
      }
      // 反思（2026-08-15 第五十八次·续）：判定语义统一为"仅显式 false 才停用"。
      //   诊断实证 storage.textHintEnabled=undefined（键缺失或异常值），旧判定 `if (s.textHintEnabled)`
      //   把 undefined 判为 falsy → 走停用分支 → stopHint 杀掉正常启动的模块（"高亮闪一下又消失"）。
      //   getSettings 默认 true，undefined 应视为启用（与 guide.js `!== false`、popup 语义一致）。
      const wantEnabled = (s.textHintEnabled !== false);
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
          await startOrReport(s);
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

    // 右键菜单查词消息
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'SHOW_CONTEXT_PANEL' && msg.text) {
        _impl.showContextPanel(msg.text, _lastClickX, _lastClickY);
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
      _impl.showOcrResultPanel(detail.text || '', _lastClickX, _lastClickY, detail.info || '');
    });
  } catch (e) {
    console.error('[VocabRadar][text-hint] 加载失败', e);
  }
})();

/** 读取完整设置（含默认值） */
// 第一百三十七次：曾改用带 DEFAULTS 对象的 get()+重试兜底。
// 第一百三十八次（用户复测日志实证仍出现「缺键」且本轮不可能由上述实现产出）：
//   带默认值对象的 chrome.storage.local.get 存在稳定的缺键异常，重试无效；
//   而裸 get(null)（对账诊断快照）两次均完整返回全部键与正确值。
//   釜底抽薪：改用 get(null) + JS 手工合并默认值——结构上杜绝任何一层
//   （Chrome 默认值合并/序列化）参与，「读到的值要么是存储实值要么是本地默认」，
//   绝不再产出 undefined。绝不把"读失败"当"用户关了"。
function getSettings() {
  const DEFAULTS = {
    textHintEnabled: true,
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
    // 文本样式预设（第五十一次）：'none' 或 TEXT_STYLES 中的 id
    textStyle: 'none'
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
