// =============================================================================
// SW 右键菜单（2026-09-27 拆分自 service-worker.js）
// 职责：菜单的幂等重建（removeAll+create）与点击分发。
// 顶层副作用：SW 每次唤醒即重建菜单（MV3 SW 随时被终止，唤醒时机不限于
//   onInstalled/onStartup——反思 2026-07-06"右键菜单消失了"）。
// =============================================================================
import { _ts, log } from './log.js';

/**
 * 创建右键菜单
 * 反思（2026-08-05 修正）：用户要求"ocr改为之前，点击识别当前帧"。
 *   移除 image/video 上下文 OCR 菜单项（很多视频无法右键识别），
 *   OCR 回归侧栏按钮点击截帧方式。保留 selection 上下文的查词菜单。
 * 第二百四十四次（用户裁定）：标题统一 "VocabRadar: query %s"（%s=选中文本），
 *   不再按 uiLanguage 分叉。历史沿革：第一百零九次"查词/Look up"→"翻译/Translate"，
 *   2026-08-08 为"中英文夹杂"引入按界面语言动态选标题（含 onChanged 重建监听）；
 *   现用户直接定死单一格式，storage 读取（每次菜单重建一次 IO）一并退役。
 *   removeAll+create 幂等。
 * 第二百四十五次（用户裁定）：标题改版 "VocabRadar: 🔍 %s"。🔍 为 Unicode 6.0（2010）
 *   老字符，Win10 系统字形普遍覆盖，与 177 次退役的 🦫（Emoji 13 新字符致豆腐块）不同源。
 */
export function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'beaver-lookup',
      title: 'VocabRadar: 🔍 %s',
      // 272次：contexts 由 ['selection'] 扩为 ['all']——没选中也能搜索：
      // 有选中文本=查选区（原行为）；无选中=弹搜索栏输入（OPEN_QUERY_BAR，
      // 见 onClicked 分发）。%s 在无选中时由浏览器渲染为空。
      contexts: ['all']
    });
    log('[VocabRadar][sw][' + _ts() + '] 右键菜单已注册（🔍 查词/搜索）');
  });
}

/**
 * 右键菜单点击分发
 * - beaver-lookup：选中文本转发到 text-hint 显示查词面板
 *
 * 反思（2026-08-05 修正）：移除图片/视频 OCR 右键菜单项，
 *   OCR 回归侧栏按钮点击截帧方式（很多视频无法右键识别）。
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'beaver-lookup') {
    const text = (info.selectionText || '').trim();
    if (text) {
      log('[VocabRadar][sw][' + _ts() + '] 右键翻译: "' + text.slice(0, 30) + '" tab=' + tab.id);
      chrome.tabs.sendMessage(tab.id, { type: 'SHOW_CONTEXT_PANEL', text }, (resp) => {
        if (chrome.runtime.lastError) {
          console.warn('[VocabRadar][sw][' + _ts() + '] 转发失败:', chrome.runtime.lastError.message);
        }
      });
    } else {
      // 272次：没选中也能搜索——跳到页面搜索栏输入（文本侧栏搜索栏聚焦/query 标签）
      log('[VocabRadar][sw][' + _ts() + '] 右键无选中 → 弹搜索栏 tab=' + tab.id);
      chrome.tabs.sendMessage(tab.id, { type: 'OPEN_QUERY_BAR' }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[VocabRadar][sw][' + _ts() + '] OPEN_QUERY_BAR 转发失败:', chrome.runtime.lastError.message);
        }
      });
    }
  }
});

// 反思（2026-07-06）：用户反馈"右键菜单消失了"。
// MV3 SW 会被 Chrome 随时终止，唤醒时机不限于 onInstalled/onStartup。
// 虽然右键菜单由浏览器持久化，但扩展更新时 onInstalled 中 removeAll 的回调
// 可能因 SW 被终止而未执行 create，导致菜单被删未建。
// 修正：模块顶层调用 createContextMenus()，每次 SW 唤醒（无论由何种事件触发）
// 都确保菜单存在。removeAll+create 是幂等操作，反复调用安全。
createContextMenus();

// 第二百四十四次（用户裁定）：原此处有 storage.onChanged 监听 uiLanguage 变化重建菜单
//   （2026-08-08"中英文夹杂"修法）。标题已统一为固定格式 "VocabRadar: query {word}"，
//   不再随界面语言分叉，监听失去存在意义，随菜单实现一并退役。
