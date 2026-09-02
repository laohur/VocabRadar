// 全站网页侧栏入口（classic script）
// 用动态 import 加载 ES module（与 text-hint.js 同模式），避免 content_scripts 静态 import 报错
//
// 职责：
//   - 读取设置（webSidebarEnabled + 配色字段 + rankThreshold + annotateOov）
//   - 监听 storage 变化，启停侧栏或热更新配色/阈值
//   - 始终启动（默认折叠态），用户点击折叠条展开
//   - 视频页面不启动文本侧栏（由 video-controller 启动视频侧栏）

// 反思（2026-08-07）：用户反馈"Identifier '_impl' has already been declared"。
//   根因：text-hint.js 也用 let _impl，classic script 共享全局作用域，变量名冲突。
//   修正：改用 _wsImpl 避免冲突。
let _wsImpl = null;

/**
 * 检测当前页面是否为视频页面（B站/YouTube 正片页）
 * 反思（2026-08-12）：用户要求"chrome edge 视频网站没有显示悬浮球"。
 *   旧版视频页面不启动文本侧栏（避免与视频侧栏冲突），但用户要求视频网站也要显示悬浮球。
 *   修正：视频页面也启动文本侧栏（悬浮球），与视频侧栏共存。
 *   isVideoPage 仍保留用于 SPA 导航检测（视频侧栏由 video-controller 启动）。
 */
function isVideoPage() {
  const path = location.pathname;
  const host = location.hostname;
  // B站正片页（排除番剧/直播/首页/空间）
  if (host.includes('bilibili.com')) {
    return /\/video\/(BV[\w]+|av\d+)/i.test(path);
  }
  // YouTube 正片页
  if (host.includes('youtube.com')) {
    return /\/(watch|shorts)($|\?|\/)/i.test(path);
  }
  return false;
}

let _lastUrl = location.href;

(async () => {
  console.log(`[VocabRadar][web-sidebar] content script 已加载 @ ${location.href}`);
  try {
    _wsImpl = await import(chrome.runtime.getURL('src/content/web-sidebar-impl.js'));

    // 诊断挂钩（2026-08-14 第五十四次）：向诊断悬浮窗暴露真实运行实例的状态。
    window.__beaverWebSidebarDiag = () => (_wsImpl && typeof _wsImpl.getDiagState === 'function')
      ? _wsImpl.getDiagState()
      : null;

    const settings = await getSettings();
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
      // 主开关
      if ('webSidebarEnabled' in changes) {
        if (changes.webSidebarEnabled.newValue) {
          getSettings().then((s) => _wsImpl.startWebSidebar(s));
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
      if ('sourceLanguage' in changes || 'targetLanguage' in changes) {
        getSettings().then((s) => _wsImpl.updateLanguages(s));
      }
      // 注释表外词开关变化 → 重扫（2026-08-07）
      if ('annotateOov' in changes) {
        _wsImpl.setAnnotateOov(changes.annotateOov.newValue);
      }
      // 注释重复生词开关变化 → 重扫（2026-08-15 第六十二次）
      if ('annotateRepeat' in changes) {
        _wsImpl.setAnnotateRepeat(changes.annotateRepeat.newValue);
      }
      // 配色字段变化 → 热更新样式（无需重扫）
      const colorKeys = [
        'hintFirstBg', 'hintFirstFg',
        'hintLaterBg', 'hintLaterFg'
      ];
      if (colorKeys.some((k) => k in changes)) {
        getSettings().then((s) => _wsImpl.updateColors(s));
      }
      // 侧栏注释样式变化（引导页选择）→ 热更新 root class
      if ('annotationStyle' in changes) {
        _wsImpl.updateAnnStyle(changes.annotationStyle.newValue);
      }
    });

    // 反思（2026-08-12）：视频页面也启动文本侧栏，SPA 导航不再停止/启动文本侧栏。
    //   仅在 webSidebarEnabled 开关变化时启停（由 storage.onChanged 监听处理）。
    //   isVideoPage 仍保留供 video-controller.js 使用。
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
})();

/** 读取完整设置（含默认值） */
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({
      sourceLanguage: 'en',
      targetLanguage: 'zh',
      // 反思（2026-08-14 第五十四次修正）：默认词频阈值恢复 5000，撤销第五十二次误改的 0
      rankThreshold: 5000,
      annotateOov: false,
      annotateRepeat: false,
      // 反思（2026-08-18 第七十三次修正）：默认配色——用户明确"单词绿底白字，注释白底绿字"
      hintFirstBg: '#2e6b43',
      hintFirstFg: '#ffffff',
      hintLaterBg: '#2e6b43',
      hintLaterFg: '#ffffff',
      hintSideAnnotation: false,
      annotationStyle: 'none',
      webSidebarEnabled: true,
      webSidebarAnnMode: 'side'
    }, resolve);
  });
}