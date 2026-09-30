// ============================================================
// 文件职责：SW 在线翻译渠道消息通道（src/lib/translator/online-channels.js）
// 在线渠道（Backend -> 词典快渠道 -> Reverso -> Bing -> Google -> Youdao -> Baidu
//   -> MyMemory）的实际请求与各渠道响应解析在 SW 的 handleTranslateText
//   （src/background/sw/translate.js）；
// 本模块是 content 侧通道：sendMessage 发 TRANSLATE_TEXT 给 SW 并带超时
//   （TRANSLATE_TEXT 80 秒 / 其他消息 15 秒），超时或异常 resolve(null)，
//   不让队列阻塞（与原单文件行为一致）。_ts 时间戳来自 shared.js。
// ============================================================
import { _ts } from './shared.js';

// === 工具：发消息到 service worker ===
// 超时兜底：chrome.runtime.sendMessage 回调在 SW 休眠/唤醒失败时不触发，sendMessage
//   会永久挂起、翻译队列阻塞（用户反馈"翻译一直 Translating..."），故超时后
//   resolve(null) 让流程继续走下一个渠道或返回 null。
// TRANSLATE_TEXT 用 80s 长超时：Firefox 无 Translator API，所有翻译都走在线渠道
//   （SW 串行 9 渠道 × 8s ≈ 72s），15s 超时会掐断后续渠道（用户反馈"火狐翻译结果
//   少"）；80s = 72s + SW 唤醒缓冲。实际词级预算另受队列 45s 单任务上限约束
//   （index.js _processQueue withTimeout），本超时只兜消息挂起。
export function sendMessage(msg, timeout = 15000) {
  // TRANSLATE_TEXT 需要更长超时（9 渠道 × 8 秒 = 72 秒 + SW 唤醒缓冲）
  if (msg.type === 'TRANSLATE_TEXT') timeout = 80000;
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
