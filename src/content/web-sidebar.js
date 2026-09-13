// 全站网页侧栏入口（classic script）
// 用动态 import 加载 ES module（与 text-hint.js 同模式），避免 content_scripts 静态 import 报错
//
// 职责：
//   - 读取设置（webSidebarEnabled + 配色字段 + rankThreshold + annotateOov）
//   - 监听 storage 变化，启停侧栏或热更新配色/阈值
//   - 始终启动（默认折叠态），用户点击折叠条展开
//   - 视频页面不启动文本侧栏（由 video-controller 启动视频侧栏）
//
// 第二百七十次：停用规则（Deactivate）gate——命中「文本侧栏」停用规则时本页尽量
//   不活动：不加载模块图、不挂 history hook，仅留轻量解除观察监听；规则解除后走
//   完整 _wsBoot()。规则运行中启停由 boot 内主监听的 deactivateRules 分支实时处理。
//   匹配/存储逻辑唯一来源 src/lib/deactivate.js（非打包入口文件，构建时原样进 dist）。

// 反思（2026-08-07）：用户反馈"Identifier '_impl' has already been declared"。
//   根因：text-hint.js 也用 let _impl，classic script 共享全局作用域，变量名冲突。
//   修正：改用 _wsImpl 避免冲突。
let _wsImpl = null;

// 反思（2026-08-12）：用户要求"chrome edge 视频网站没有显示悬浮球"。
//   旧版视频页面不启动文本侧栏（避免与视频侧栏冲突），但用户要求视频网站也要显示悬浮球。
//   修正：视频页面也启动文本侧栏（悬浮球），与视频侧栏共存。
// 第二百二十五次：删除死函数 isVideoPage（定义后零调用；《命名清查》查明旧注释
//   "仍保留供 video-controller.js 使用"不实——video-controller 用自己的 isSupportedPage）。

let _lastUrl = location.href;

// === 第二百七十次：停用规则 gate（与 text-hint.js 同构） ===
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

/** boot：启动主体（第二百七十次自 IIFE 抽出；逻辑原样 + 规则实时启停分支） */
async function _wsBoot() {
  if (_wsBooted) return;
  _wsBooted = true;
  try {
    _wsImpl = await import(chrome.runtime.getURL('src/content/web-sidebar-impl.js'));

    // 诊断挂钩（2026-08-14 第五十四次）：向诊断悬浮窗暴露真实运行实例的状态。
    window.__beaverWebSidebarDiag = () => (_wsImpl && typeof _wsImpl.getDiagState === 'function')
      ? _wsImpl.getDiagState()
      : null;

    const settings = await _wsGetSettings();
    // 反思（2026-08-12）：用户要求"视频网站也要显示悬浮球"。
    //   旧版视频页面不启动文本侧栏，现改为始终启动（与视频侧栏共存）。
    if (settings.webSidebarEnabled) {
      // 反思（2026-08-12 第四十六次）：startWebSidebar 是 async，未 catch 时
      //   Bing 等网站的注入错误会被吞掉，控制台无任何输出，难以诊断。
      //   修正：包装为 Promise 并 catch，打印详细错误信息。
      Promise.resolve(_wsImpl.startWebSidebar(settings)).catch((e) => {
        console.error('[VocabRadar][web-sidebar] startWebSidebar 异常:', e);
      });
    }

    // 设置变化监听
    chrome.storage.onChanged.addListener((changes) => {
      if (!_wsImpl) return;
      // 第二百七十次：停用规则变化——命中「文本侧栏」立即停（同主开关关闭语义）；
      // 解除时按主开关现值恢复（文本侧栏无 reconcile 自愈，启停两向都在此处理）
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
      // 语言变化 → 更新选择器
      if ('learnLanguage' in changes || 'meaningLanguage' in changes) {
        _wsGetSettings().then((s) => _wsImpl.updateLanguages(s));
      }
      // 注释表外词开关变化 → 重扫（2026-08-07）
      if ('annotateOov' in changes) {
        _wsImpl.setAnnotateOov(changes.annotateOov.newValue);
      }
      // 注释重复生词开关变化 → 重扫（2026-08-15 第六十二次）
      if ('annotateRepeat' in changes) {
        _wsImpl.setAnnotateRepeat(changes.annotateRepeat.newValue);
      }
      // 280次：侧邻注释模板变化 → 清缓存重扫（与 annotateRepeat 同构，原 annBrackets）
      // 283次：模板分键——文本侧栏（annotationStyle 栏）只消费 webAnnTemplate
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
      // 301次：个性化/用户条目变化 → 刷新规则表（类名不变即时生效，无需重扫）
      if ('annotationCustom' in changes || 'annotationUserStyles' in changes) {
        _wsGetSettings().then((s) => _wsImpl.refreshAnnPoolCss(s.annotationCustom, s.annotationUserStyles));
      }
    });

    // 反思（2026-08-12）：视频页面也启动文本侧栏，SPA 导航不再停止/启动文本侧栏。
    //   仅在 webSidebarEnabled 开关变化时启停（由 storage.onChanged 监听处理）。
    //   （第二百二十五次：死函数 isVideoPage 已删除，此前的虚假保留注释一并更正。）
    const checkVideoNav = () => {
      const newUrl = location.href;
      if (newUrl === _lastUrl) return;
      _lastUrl = newUrl;
      // 视频页面也启动文本侧栏，无需根据视频页面切换启停
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

/** gate 期间的解除观察（第二百七十次）：规则解除即 boot；boot 幂等（_wsBooted），
 *  boot 后本监听残留无害——运行中的规则启停由 boot 内主监听接管 */
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
      // 反思（2026-08-14 第五十四次修正）：默认词频阈值恢复 5000，撤销第五十二次误改的 0
      rankThreshold: 5000,
      annotateOov: false,
      annotateRepeat: false,
      // 280次：侧邻注释模板默认（annBrackets 布尔退役）
      // 284次：默认组合 {target} {annotation}（与 styles.js 同步）
      annTemplate: '{target} {annotation}',
      // 反思（2026-08-18 第七十三次修正）：默认配色——用户明确"单词绿底白字，注释白底绿字"
      hintFirstBg: '#2e6b43',
      hintFirstFg: '#ffffff',
      hintLaterBg: '#2e6b43',
      hintLaterFg: '#ffffff',
      hintSideAnnotation: false,
      annotationStyle: 'none',
      // 301次：个性化/用户条目缓存（applyAnnStyle 类切换之外，规则表刷新用）
      annotationCustom: null,
      annotationUserStyles: [],
      webSidebarEnabled: true,
      webSidebarAnnMode: 'side'
    }, resolve);
  });
}
