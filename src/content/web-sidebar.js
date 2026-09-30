// 全站网页侧栏入口（classic script）
// 用动态 import 加载 ES module（与 text-hint.js 同模式），避免 content_scripts 静态 import 报错
//
// 职责：
//   - 读取设置（webSidebarEnabled + 配色字段 + 阈值 + 注释开关）
//   - 监听 storage 变化，启停侧栏或热更新配色/阈值
//   - 始终启动（默认折叠态），视频页面也启动（与视频侧栏共存）
//   - 停用规则 gate：命中「文本侧栏」规则时本页尽量不活动——不加载模块图、
//     不挂 history hook，仅留轻量解除观察监听；规则解除后走完整 _wsBoot()，
//     规则运行中启停由 boot 内主监听的 deactivateRules 分支实时处理。
//     匹配/存储逻辑唯一来源 src/lib/deactivate.js（构建时原样进 dist）

// classic script 与 text-hint.js 共享页面全局作用域，变量名须带 _ws 前缀避免冲突
let _wsImpl = null;

let _lastUrl = location.href;

// === 停用规则 gate（与 text-hint.js 同构） ===
let _wsDeactLib = null;
function _wsLoadDeactLib() {
  return import(chrome.runtime.getURL('src/lib/deactivate.js'))
    .then((m) => { _wsDeactLib = m; return true; })
    .catch((e) => {
      // 不遮蔽：规则库加载失败按"未停用"处理并出声
      console.warn('[VocabRadar][web-sidebar] 停用规则库加载失败，按未停用处理:', e);
      return false;
    });
}
/** 当前页是否命中「文本侧栏」停用规则（规则库缺失时恒 false） */
function _sidebarSuppressed() {
  if (!_wsDeactLib) return Promise.resolve(false);
  return _wsDeactLib.suppressionFor(location)
    .then((s) => s.textSidebar === true)
    .catch(() => false);
}
let _wsBooted = false;

/** boot：启动主体（幂等；含停用规则实时启停分支） */
async function _wsBoot() {
  if (_wsBooted) return;
  _wsBooted = true;
  try {
    _wsImpl = await import(chrome.runtime.getURL('src/content/web-sidebar-impl.js'));

    // 诊断挂钩：向诊断悬浮窗暴露真实运行实例的状态
    window.__beaverWebSidebarDiag = () => (_wsImpl && typeof _wsImpl.getDiagState === 'function')
      ? _wsImpl.getDiagState()
      : null;

    const settings = await _wsGetSettings();
    if (settings.webSidebarEnabled) {
      // startWebSidebar 是 async，必须 catch，否则注入错误被吞、控制台无输出
      Promise.resolve(_wsImpl.startWebSidebar(settings)).catch((e) => {
        console.error('[VocabRadar][web-sidebar] startWebSidebar 异常:', e);
      });
    }

    // 设置变化监听
    chrome.storage.onChanged.addListener((changes) => {
      if (!_wsImpl) return;
      // 停用规则变化：命中立即停（同主开关关闭语义）；解除时按主开关现值恢复
      if ('deactivateRules' in changes) {
        _sidebarSuppressed().then((sup) => {
          if (sup) {
            try { _wsImpl.stopWebSidebar(); } catch (e) { console.warn('[VocabRadar][web-sidebar] 规则停用失败:', e); }
            console.log('[VocabRadar][web-sidebar] 停用规则命中（文本侧栏），侧栏已停止');
          } else {
            _wsGetSettings().then((s) => {
              if (s.webSidebarEnabled) {
                Promise.resolve(_wsImpl.startWebSidebar(s)).catch((e) => {
                  console.error('[VocabRadar][web-sidebar] 规则解除后重启异常:', e);
                });
              }
            });
          }
        });
        return;
      }
      // 主开关
      if ('webSidebarEnabled' in changes) {
        if (changes.webSidebarEnabled.newValue) {
          _wsGetSettings().then((s) => _wsImpl.startWebSidebar(s));
        } else {
          _wsImpl.stopWebSidebar();
        }
        return;
      }
      // 阈值变化 → 重扫
      if ('rankThreshold' in changes) {
        _wsImpl.setRankThreshold(changes.rankThreshold.newValue);
      }
      // 词频上界变化 → 重扫（词频范围，key rankThresholdMax）
      if ('rankThresholdMax' in changes) {
        _wsImpl.setRankThresholdMax(changes.rankThresholdMax.newValue);
      }
      // My Words（用户生词/熟词表）变化 → 全量重扫
      if ('myWords' in changes) {
        const _mw = changes.myWords.newValue || {};
        _wsImpl.setMyWordsLists(_mw.new, _mw.known);
      }
      // 语言变化 → 更新选择器
      if ('learnLanguage' in changes || 'meaningLanguage' in changes) {
        _wsGetSettings().then((s) => _wsImpl.updateLanguages(s));
      }
      // 注释表外词开关变化 → 重扫
      if ('annotateOov' in changes) {
        _wsImpl.setAnnotateOov(changes.annotateOov.newValue);
      }
      // 注释重复生词开关变化 → 重扫
      if ('annotateRepeat' in changes) {
        _wsImpl.setAnnotateRepeat(changes.annotateRepeat.newValue);
      }
      // 注释模板变化 → 清缓存重扫；文本侧栏只消费 webAnnTemplate（与字幕侧 annTemplate 分键）
      if ('webAnnTemplate' in changes) {
        _wsImpl.setAnnTemplate(changes.webAnnTemplate.newValue);
      }
      // 配色字段变化 → 热更新样式（无需重扫）
      const colorKeys = [
        'hintFirstBg', 'hintFirstFg',
        'hintLaterBg', 'hintLaterFg'
      ];
      if (colorKeys.some((k) => k in changes)) {
        _wsGetSettings().then((s) => _wsImpl.updateColors(s));
      }
      // 侧栏注释样式变化（引导页选择）→ 热更新 root class
      if ('annotationStyle' in changes) {
        _wsImpl.updateAnnStyle(changes.annotationStyle.newValue);
      }
      // 个性化/用户条目变化 → 刷新规则表（类名不变即时生效，无需重扫）
      if ('annotationCustom' in changes || 'annotationUserStyles' in changes) {
        _wsGetSettings().then((s) => _wsImpl.refreshAnnPoolCss(s.annotationCustom, s.annotationUserStyles));
      }
    });

    // SPA 导航不启停侧栏；启停仅由 storage.onChanged 的 webSidebarEnabled 分支处理
    const checkVideoNav = () => {
      const newUrl = location.href;
      if (newUrl === _lastUrl) return;
      _lastUrl = newUrl;
    };
    // hook pushState/replaceState（幂等）
    if (!window.__beaverWebSidebarUrlHooked) {
      window.__beaverWebSidebarUrlHooked = true;
      const origPush = history.pushState;
      const origReplace = history.replaceState;
      history.pushState = function (...args) {
        const r = origPush.apply(this, args);
        setTimeout(checkVideoNav, 100);
        return r;
      };
      history.replaceState = function (...args) {
        const r = origReplace.apply(this, args);
        setTimeout(checkVideoNav, 100);
        return r;
      };
      window.addEventListener('popstate', () => setTimeout(checkVideoNav, 100));
    }
  } catch (e) {
    console.error('[VocabRadar][web-sidebar] 加载失败', e);
  }
}

(async () => {
  console.log(`[VocabRadar][web-sidebar] content script 已加载 @ ${location.href}`);
  try {
    await _wsLoadDeactLib();
    if (await _sidebarSuppressed()) {
      console.log('[VocabRadar][web-sidebar] 命中停用规则（文本侧栏），本页不加载侧栏模块（规则解除后自动恢复）');
      _wsInstallUnsuppressWatch();
      return;
    }
    await _wsBoot();
  } catch (e) {
    console.error('[VocabRadar][web-sidebar] 加载失败', e);
  }
})();

/** gate 期间的解除观察：规则解除即 boot（boot 幂等；boot 后残留监听无害） */
function _wsInstallUnsuppressWatch() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !('deactivateRules' in changes)) return;
      _sidebarSuppressed().then((sup) => {
        if (!sup && !_wsBooted) {
          console.log('[VocabRadar][web-sidebar] 停用规则解除，启动文本侧栏');
          _wsBoot();
        }
      });
    });
  } catch (e) {
    console.warn('[VocabRadar][web-sidebar] 停用规则解除监听注册失败:', e);
  }
}

/** 读取完整设置（含默认值） */
function _wsGetSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({
      learnLanguage: 'en',
      meaningLanguage: 'zh',
      // 词频下界默认 5000
      rankThreshold: 5000,
      // 上界 0 = 不限（Infinity）；此键缺失会导致 My Words 过滤失效
      rankThresholdMax: 0,
      myWords: { new: [], known: [] },
      annotateOov: false,
      annotateRepeat: false,
      // 注释模板默认，与 lib/styles.js 默认同步
      annTemplate: '{target}{annotation}',
      // 默认透明底绿字；条目显式字段仍优先于默认值
      hintFirstBg: 'transparent',
      hintFirstFg: '#2e6b43',
      hintLaterBg: 'transparent',
      hintLaterFg: '#2e6b43',
      hintSideAnnotation: false,
      // 'green-background' 镜像 lib/styles.js 的 ANN_DEFAULT_STYLE（classic script
      //   不便 import styles.js；styles.js 常量变化时须同步此兜底）
      annotationStyle: 'green-background',
      // 个性化/用户条目缓存（applyAnnStyle 类切换之外，规则表刷新用）
      annotationCustom: null,
      annotationUserStyles: [],
      webSidebarEnabled: true,
      webSidebarAnnMode: 'side'
    }, resolve);
  });
}
