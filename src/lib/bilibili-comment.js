// B站评论助手（填入评论框，不自动发送）
//
// 设计变更（2026-06-30）：
//   原实现通过 reply/add API 直接发送评论，绕过用户确认，存在误发风险。
//   现改为"填入评论框 + 手动发送"模式：
//   1. 获取字幕，提取目标词（词典命中且 rank>阈值）。
//   2. 组装表格文本（word | 释义 | 阶）。
//   3. 填入 B站主评论框（优先富文本 ql-editor，回退 textarea）。
//   4. 用户检查后手动点发送。
//
// 取消自动发送后不再需要 csrf token 与 API 调用，仅做 DOM 填充。

import { lookup } from './dictionary.js';
import { extract_english_words } from './tokenizer.js';
import { getBilibiliSubtitles } from './subtitle/index.js';

/** 阶显示：rank 每 1000 为一阶，表外词单独标识 */
function rankToStage(rank) {
  if (rank === null || rank === undefined) return '表外';
  return `${Math.floor(rank / 1000)}阶`;
}

/**
 * 组装评论文本（表格，每词一行）
 * @param {Array<{word, translations, rank}>} annotations
 * @returns {string}
 */
function buildCommentText(annotations) {
  // 第一百七十七次：前缀去掉 🦫（Win10 旧版 Segoe UI Emoji 无字形，显示为豆腐块）与"提示"二字
  const lines = ['VocabRadar：'];
  for (const a of annotations) {
    const trans = a.translations.join('；');
    lines.push(`${a.word} | ${trans} | ${rankToStage(a.rank)}`);
  }
  return lines.join('\n');
}

/**
 * 把文本填入 B站主评论框
 *
 * B站评论区输入框选择器（多选尝试）：
 *   .reply-box .ql-editor[contenteditable=true]  —— 新版富文本
 *   .reply-box textarea.reply-textarea            —— 旧版
 *   .comment-box .ql-editor                       —— 备选
 *   .comment-box textarea                         —— 备选
 *
 * 富文本 ql-editor 用 innerText + input 事件触发 Vue 更新；
 * textarea 用原生 value setter + input 事件。
 * @param {string} text
 * @returns {boolean} 是否填入成功
 */
function fillCommentInput(text) {
  // 优先富文本编辑器
  const editor = document.querySelector(
    '.reply-box .ql-editor[contenteditable=true], .comment-box .ql-editor[contenteditable=true]'
  );
  if (editor) {
    editor.innerText = text;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    console.log('[VocabRadar][comment] 填入富文本评论框');
    return true;
  }
  // 回退 textarea
  const ta = document.querySelector(
    '.reply-box textarea, .comment-box textarea'
  );
  if (ta) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    console.log('[VocabRadar][comment] 填入 textarea 评论框');
    return true;
  }
  console.warn('[VocabRadar][comment] 未找到评论框，请先点击评论区"写评论"展开输入框后重试');
  return false;
}

/**
 * 填入评论框
 *
 * 流程：
 *   1. 获取字幕、提取目标词（词典命中且 rank>阈值）
 *   2. 组装表格文本
 *   3. 填入主评论框，用户手动发送
 * @returns {Promise<void>}
 */
export async function sendComment() {
  const subtitles = await getBilibiliSubtitles();
  if (!subtitles || subtitles.length === 0) {
    alert('该视频无字幕，无法提取单词');
    return;
  }

  const settings = await new Promise((resolve) => {
    chrome.storage.local.get({ rankThreshold: 0 }, resolve);
  });

  // 收集所有字幕中的英文单词，去重
  const seen = new Set();
  const annotations = [];
  for (const sub of subtitles) {
    const words = extract_english_words(sub.text.toLowerCase());
    for (const w of words) {
      if (seen.has(w)) continue;
      seen.add(w);
      const entry = lookup(w);
      if (entry && entry.rank > settings.rankThreshold) {
        annotations.push({
          word: w,
          translations: entry.translations,
          rank: entry.rank
        });
      }
    }
  }

  if (annotations.length === 0) {
    alert('没有符合阈值的单词');
    return;
  }

  const text = buildCommentText(annotations);
  console.log(`[VocabRadar][comment] 评论文本 ${annotations.length} 词，预览:\n${text.slice(0, 200)}`);

  if (!fillCommentInput(text)) {
    alert('未找到评论输入框，请先点击评论区"写评论"展开输入框后重试');
    return;
  }

  alert(`已填入评论框（${annotations.length} 词），请检查后手动点发送`);
}
