// B站弹幕助手（填入输入框，不自动发送）
//
// 设计变更（2026-06-30）：
//   原实现通过 dm/web/so API 直接发送弹幕，绕过用户确认，存在误发风险。
//   现改为"填入输入框 + 手动发送"模式：
//   1. 获取字幕，提取目标词（词典命中且 rank>阈值），记录首次出现秒数。
//   2. 监听 video.timeupdate，在目标词时间前 3 秒，把弹幕文本填入 B站弹幕输入框。
//   3. 用户检查后手动点发送（弹幕时间戳由 B站按发送时刻绑定）。
//   提前 3 秒是为了给用户反应时间，且时间戳仍接近目标词出现时刻。
//
// 取消自动发送后不再需要 csrf token 与 API 调用，仅做 DOM 填充。

import { lookup } from './dictionary.js';
import { extract_english_words } from './tokenizer.js';
import { getBilibiliSubtitles } from './subtitle/index.js';

// 已注册的 timeupdate 监听器引用，便于重复触发时先移除旧监听
let _danmakuListener = null;
// 已填入输入框的目标词（按 word 标记，避免同词多次出现重复填入）
let _filledWords = new Set();

/**
 * 把文本填入 B站弹幕输入框
 *
 * B站新版播放器弹幕输入框选择器（多选尝试）：
 *   .bpx-player-dm-input input  —— 新版
 *   .b-danmaku-input input      —— 旧版
 *   input.b-danmaku-input       —— 备选
 *
 * 直接设 value 不会触发 React/Vue 的 onChange，需用原生 setter + dispatchEvent。
 * @param {string} text
 * @returns {boolean} 是否填入成功
 */
function fillDanmakuInput(text) {
  const selectors = [
    '.bpx-player-dm-input input',
    '.b-danmaku-input input',
    'input.b-danmaku-input'
  ];
  for (const sel of selectors) {
    const input = document.querySelector(sel);
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      console.log(`[VocabRadar][danmaku] 填入输入框(${sel}): ${text}`);
      return true;
    }
  }
  console.warn('[VocabRadar][danmaku] 未找到弹幕输入框，请确认播放器已加载且弹幕框可见');
  return false;
}

/**
 * 启动弹幕助手
 *
 * 流程：
 *   1. 获取字幕、提取目标词、记录每个词首次出现秒数
 *   2. 找到 video 元素，注册 timeupdate 监听
 *   3. 播放进度到达 目标词时间-3s 时，把弹幕文本填入输入框（每个词仅填一次）
 *   4. 用户手动点发送
 *
 * 重复点击会重置监听与已填入标记，便于换视频或重新运行。
 * @returns {Promise<void>}
 */
export async function sendDanmaku() {
  const subtitles = await getBilibiliSubtitles();
  if (!subtitles || subtitles.length === 0) {
    alert('该视频无字幕，无法提取单词');
    return;
  }

  const settings = await new Promise((resolve) => {
    chrome.storage.local.get({ rankThreshold: 0 }, resolve);
  });

  // 收集每个单词首次出现的秒数
  const wordFirstTime = new Map();
  const seen = new Set();
  for (const sub of subtitles) {
    const words = extract_english_words(sub.text.toLowerCase());
    for (const w of words) {
      if (seen.has(w)) continue;
      seen.add(w);
      wordFirstTime.set(w, Math.floor(sub.start));
    }
  }

  // 过滤：词典命中且 rank>阈值
  const targets = [];
  for (const [word, playtime] of wordFirstTime) {
    const entry = lookup(word);
    if (entry && entry.rank > settings.rankThreshold) {
      targets.push({ word, playtime, translations: entry.translations });
    }
  }

  if (targets.length === 0) {
    alert('没有符合阈值的单词');
    return;
  }

  // 按 playtime 排序，便于监听时按时间推进
  targets.sort((a, b) => a.playtime - b.playtime);
  console.log(`[VocabRadar][danmaku] 目标词 ${targets.length} 个:`, targets.map((t) => `${t.word}@${t.playtime}s`).join(', '));

  // 找 video 元素
  const video = document.querySelector('video');
  if (!video) {
    alert('未找到视频元素');
    return;
  }

  // 移除旧监听
  if (_danmakuListener) {
    video.removeEventListener('timeupdate', _danmakuListener);
  }
  _filledWords.clear();

  // 注册新监听
  _danmakuListener = () => {
    const t = video.currentTime;
    for (const target of targets) {
      // 在 目标时间-3s 到 目标时间 之间填入（提前3秒，给用户反应时间）
      if (t >= target.playtime - 3 && t <= target.playtime + 1 && !_filledWords.has(target.word)) {
        // 第一百七十七次：去掉 🦫（Win10 无字形，显示为豆腐块）
        const text = `${target.word} ${target.translations.join('; ')}`;
        if (fillDanmakuInput(text)) {
          _filledWords.add(target.word);
        }
        break; // 一次 timeupdate 只填一条
      }
    }
  };
  video.addEventListener('timeupdate', _danmakuListener);

  alert(`弹幕助手已启动，${targets.length} 个目标词。\n视频播放到对应时间前 3 秒将自动填入弹幕输入框，请手动点发送。`);
}
