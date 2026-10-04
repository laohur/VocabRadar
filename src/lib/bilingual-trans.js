// ============================================================
// 双语字幕整句译文（src/lib/bilingual-trans.js，第514次）
// ------------------------------------------------------------
// 职责：视频叠加字幕（subtitle-overlay.js）与视频侧栏字幕面板
//   （vs/subtitle-renderer.js）共用的整句译文获取与会话缓存。
//   用户裁定："视频叠加字幕的按钮后面增加双语标签按钮，目标语言在上，
//   释义语言在下""应当影响视频侧栏的字幕、视频叠加字幕、取消侧栏字幕注释"。
// 链路：直发 SW TRANSLATE_TEXT（Backend/Reverso/Bing/Google/... 同一渠道表
//   与熔断；渠道勾选经 getTransChannels 同口径传入），不走单词口径
//   translate()（小写化+词典缓存按 word|lang 主键，整句必污染缓存）。
// 并发闸：懒注释布防一次 fire 近百行（NEAR 60 + HEAD 40），直发渠道无队列
//   会瞬间并发打满外部端点（429/封禁风险）——3 路并发 + FIFO 队列串出。
// 缓存：Map<原文, 译文|null>（null=失败/超时/同文回显——本会话同句不重试）；
//   语言对（learnLanguage→meaningLanguage）变化整表作废（storage 监听本模块
//   自持，调用方只管各自的重渲染）。
// ============================================================
import { sendMessage } from './translator/online-channels.js';
import { getTransChannels } from './translator.js';

const TRANS_CACHE_MAX = 500;      // 缓存上限（超出整表清空——字幕语料单集远小于此）
const MAX_CONCURRENT = 3;         // 并发闸：在途整句翻译上限
const _cache = new Map();
let _learn = 'en';                // 译文源语言 = 目标语言（storage.learnLanguage）
let _meaning = 'zh';              // 译文目标语言 = 释义语言（storage.meaningLanguage）
let _active = 0;
const _queue = [];                // FIFO：[{text, resolve}]（当前行先 fire 先出队）

// 语言对初始化 + 热更新（模块级一次注册；变化即清缓存）
try {
  chrome.storage.local.get({ learnLanguage: 'en', meaningLanguage: 'zh' }, (r) => {
    _learn = r.learnLanguage || 'en';
    _meaning = r.meaningLanguage || 'zh';
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.learnLanguage) _learn = ch.learnLanguage.newValue || 'en';
    if (ch.meaningLanguage) _meaning = ch.meaningLanguage.newValue || 'zh';
    if (ch.learnLanguage || ch.meaningLanguage) _cache.clear();
  });
} catch (e) { /* 非扩展上下文容错（模块被复用时） */ }

/** 缓存命中直返；未命中入队等并发闸放行 */
export function fetchBilingualTrans(text) {
  const key = String(text || '');
  if (!key.trim()) return Promise.resolve(null);
  if (_cache.has(key)) return Promise.resolve(_cache.get(key));
  return new Promise((resolve) => {
    _queue.push({ text: key, resolve });
    _pump();
  });
}

async function _doFetch(key) {
  let out = null;
  try {
    const resp = await sendMessage({
      type: 'TRANSLATE_TEXT',
      word: key,
      source: _learn || 'en',
      target: _meaning || 'zh',
      channels: getTransChannels()
    });
    const t = (resp && resp.ok) ? String(resp.text || '').trim() : '';
    // 同文回显（渠道偷懒/目标语言=释义语言）不算译文
    out = (t && t.toLowerCase() !== key.trim().toLowerCase()) ? t : null;
  } catch (e) {
    console.warn('[VocabRadar][bilingual-trans] 译文获取失败:', e);
  }
  if (_cache.size >= TRANS_CACHE_MAX) _cache.clear();
  _cache.set(key, out);
  return out;
}

function _pump() {
  while (_active < MAX_CONCURRENT && _queue.length) {
    const { text, resolve } = _queue.shift();
    _active++;
    _doFetch(text)
      .then(resolve, () => resolve(null))
      .finally(() => { _active--; _pump(); });
  }
}
