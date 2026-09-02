// ============================================================
// 文件职责：SW 在线翻译渠道消息通道（src/lib/translator/online-channels.js）
// 来源：拆分自 src/lib/translator.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// 在线渠道（MyMemory -> Google -> Youdao -> Baidu -> Bing -> Lingva）的实际
//   请求与各渠道响应解析在 src/background/service-worker.js 的 handleTranslateText；
//   本模块是 content 侧通道：sendMessage 发 TRANSLATE_TEXT 给 SW 并带超时
//   （TRANSLATE_TEXT 55 秒 / 其他消息 15 秒），超时或异常 resolve(null)，
//   不让队列阻塞（与原单文件行为一致）。_ts 时间戳来自 shared.js。
// ============================================================
import { _ts } from './shared.js';

// === 工具：发消息到 service worker ===
// 反思（2026-08-12）：用户反馈"翻译一直 Translating..."。
//   根因：chrome.runtime.sendMessage 回调在 SW 休眠/唤醒失败时不触发，
//   导致 sendMessage 永久挂起，翻译队列阻塞，后续所有词都卡住。
//   修正：添加超时，超时后 resolve(null)，让翻译流程继续走下一个渠道或返回 null。
// 反思（2026-08-12 第四十一次）：火狐翻译结果少。
//   根因：TRANSLATE_TEXT 走 SW 6 个串行在线渠道（每个 8 秒超时），总计可达 48 秒。
//   Firefox 无 Translator API，所有翻译都走在线渠道。15 秒超时在第二个渠道完成前就触发，
//   导致 MyMemory 失败后后续渠道来不及尝试。修正：TRANSLATE_TEXT 用 55 秒超时，其他消息用 15 秒。
export function sendMessage(msg, timeout = 15000) {
  // TRANSLATE_TEXT 需要更长超时（6 渠道 × 8 秒 = 48 秒 + SW 唤醒缓冲）
  if (msg.type === 'TRANSLATE_TEXT') timeout = 55000;
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      console.warn(`[VocabRadar][translator][${_ts()}] 消息超时(${timeout/1000}s):`, msg.type);
      resolve(null);
    }, timeout);
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          console.warn(`[VocabRadar][translator][${_ts()}] 消息失败:`, chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(resp);
      });
    } catch (e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      console.warn(`[VocabRadar][translator][${_ts()}] sendMessage 异常:`, e);
      resolve(null);
    }
  });
}
