// ============================================================
// 文件职责：词频/词表源文件装载函数（src/lib/dictionary/word-loader.js）
// 来源：拆分自 src/lib/dictionary.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// 装载函数（loadWordfreq/loadWordlists）与词典无关--仅在初始化或词典数据
//   缺失/不全时启用（由 projection.js 的 _rebuildFromSources 调用），装载完成
//   经 bulkWriteDictionary 送入词典（word-db.js）后不再读取（readme 权威设计）。
// 含：decompressViaBackground（后台 SW 代解压回退）、loadWordfreq（gzip 解压 +
//   msgpack/cBpack 解码 -> Map<word, rank>）、loadWordlists（JSON -> Map<word, tags>）。
// 仅使用 state.js 的 _ts() 时间戳辅助，无共享状态写入（产物 Map 由调用方消费）。
// ============================================================

import { _ts } from './state.js';
import { decode as msgpackDecode } from '../vendor/msgpack-lite.js';

/**
 * 通过 background Service Worker 解压 gzip 数据
 * 反思（2026-08-11 第二十三次）：Firefox content script 中 DecompressionStream
 *   可能不可用或返回 Xray 包装的 ArrayBuffer。SW 有完整 Web API 访问权限，
 *   且不受 Xray 限制，可作为回退方案。
 *   数据通过 chrome.runtime.sendMessage 传输（structured clone 支持 ArrayBuffer）。
 * @param {ArrayBuffer} compressed 压缩数据
 * @returns {Promise<ArrayBuffer|null>} 解压后的 ArrayBuffer，失败返回 null
 */
function decompressViaBackground(compressed) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: 'DECOMPRESS_GZIP', data: compressed },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[VocabRadar][dictionary] 后台解压消息错误:', chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          if (response && response.ok && response.data) {
            resolve(response.data);
          } else {
            console.warn('[VocabRadar][dictionary] 后台解压返回失败:', response && response.error);
            resolve(null);
          }
        }
      );
    } catch (e) {
      console.warn('[VocabRadar][dictionary] 后台解压消息发送失败:', e);
      resolve(null);
    }
  });
}

/**
 * 加载 wordfreq 数据文件（装载函数，与词典无关--仅初始化或词典数据缺失/不全时启用）
 * 流程：fetch .gz -> DecompressionStream 解压（或 SW 回退）-> msgpack 解码 -> 按 frequency 降序排序 -> 构建 Map<word, rank>
 * 反思（2026-08-20 第八十五次）：词频不是独立缓存，而是词典字段（words store 记录 rank 字段）。
 *   装载完成由 _loadDict 送入词典（bulkWriteDictionary），此后页面加载只从词典投影读，
 *   本函数仅在词典缺少该语言数据时执行（用户："词频、词形等都是扩展刚安装初始化一次性读取，
 *   读完之后存入词典，之后不再读取"）。不再读写 dictCache。
 * @param {string} lang 语言代码（如 en, zh, ja）
 * @returns {Promise<Map<string, number>>} Map<word_lower, rank>
 */
export async function loadWordfreq(lang) {
  const url = chrome.runtime.getURL(`src/data/wordfreq/small_${lang}.msgpack.gz`);
  console.log(`[VocabRadar][dictionary][${_ts()}] 词典缺少 ${lang} 数据，装载词频源文件: ${url}`);
  // 反思（2026-08-05 修正）：fetch 可能抛异常（扩展更新后页面未刷新、URL 失效、CSP 等），
  //   未包 try/catch 会导致 loadDictionary reject -> text-hint startHint 中断 -> 文本提示不出现。
  //   修正：fetch 包 try/catch，失败返回空 Map（所有词按表外处理，不阻塞功能）。
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.warn(`[VocabRadar][dictionary][${_ts()}] wordfreq fetch 异常: ${e && e.message}, 返回空 Map`);
    return new Map();
  }
  if (!res.ok) {
    console.warn(`[VocabRadar][dictionary][${_ts()}] wordfreq 加载失败: HTTP ${res.status}, 返回空 Map`);
    return new Map();
  }

  // 1. gzip 解压
  // 反思（2026-08-11 第二十三次）：Firefox content script 可能无 DecompressionStream
  //   或 DecompressionStream 返回的 ArrayBuffer 被 Xray 包装导致后续操作失败。
  //   修正：优先用 DecompressionStream，失败时回退到后台引擎解压
  //   （SW 有完整 Web API 访问权限，且不受 Xray 限制）。
  //   最后一道防线：用 fetch + Content-Encoding trick（Firefox 特有行为）。
  const compressed = await res.arrayBuffer();
  console.log(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] 压缩大小: ${(compressed.byteLength / 1024).toFixed(1)} KB`);
  let decompressedBuf;
  try {
    if (typeof DecompressionStream !== 'undefined') {
      // 方案 A：原生 DecompressionStream（Chrome 80+, Firefox 113+）
      const decompressedStream = new Response(compressed).body
        .pipeThrough(new DecompressionStream('gzip'));
      decompressedBuf = await new Response(decompressedStream).arrayBuffer();
      console.log(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] DecompressionStream 解压成功: ${(decompressedBuf.byteLength / 1024).toFixed(1)} KB`);
    } else {
      // 方案 B：Firefox 无 DecompressionStream -> 通过 background SW 解压
      console.warn(`[VocabRadar][dictionary][${_ts()}] DecompressionStream 不可用，回退到后台引擎解压`);
      decompressedBuf = await decompressViaBackground(compressed);
      if (!decompressedBuf) throw new Error('后台引擎解压返回空');
      console.log(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] 后台解压成功: ${(decompressedBuf.byteLength / 1024).toFixed(1)} KB`);
    }
  } catch (e) {
    console.error(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] gzip 解压失败:`, e);
    // 最后尝试方案 B（如果方案 A 失败）
    try {
      decompressedBuf = await decompressViaBackground(compressed);
      if (!decompressedBuf) throw new Error('后台解压也返回空');
      console.log(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] 后台回退解压成功: ${(decompressedBuf.byteLength / 1024).toFixed(1)} KB`);
    } catch (e2) {
      console.error(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] 所有解压方案均失败:`, e2);
      return new Map();
    }
  }

  // 2. msgpack 解码：得到数组或对象
  // 反思（2026-08-11 第二十三次）：msgpack-lite.js 已重写，用逐字节复制防御 Firefox Xray
  // 反思（2026-08-02 修正）：
  //   旧版假设数据恒为 {word: freq} 对象，但实际 wordfreq-3.0.2 的 small_*.msgpack.gz
  //   是**数组格式** [word1, word2, ...]（按频率降序排列，rank=index+1）。
  //   旧版用 Object.entries(array) 把数组索引当 key ->
  //   map.set("0", 1) / map.set("1", 2) ... 而 lookup("the")=undefined ->
  //   所有真实单词判为表外词，rank=null 无词阶，词形还原后查 wordfreq 仍失败。
  //   日志特征：前3个示例为 ["0","1","2"]（数组索引）而非真实单词。
  //   修正：检测 Array.isArray 分支处理，数组元素即单词字符串；
  //         对象格式（large_*.msgpack.gz 可能为 {word:freq}）仍走排序分支。
  let freqObj;
  try {
    freqObj = msgpackDecode(decompressedBuf);
  } catch (e) {
    console.error(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] msgpack 解码失败:`, e);
    return new Map();
  }
  if (!freqObj || typeof freqObj !== 'object') {
    console.warn(`[VocabRadar][dictionary][${_ts()}] wordfreq 解码失败: 数据非对象, type=${typeof freqObj}`);
    return new Map();
  }

  const map = new Map();

  // === cBpack 格式检测 ===
  // 反思（2026-08-02 修正）：wordfreq 3.0.2 的 small_*.msgpack.gz 使用 cBpack 格式，
  //   不是简单的 {word:freq} 字典或 [word1,word2,...] 数组。
  //   cBpack 结构：
  //     [header, bucket1, bucket2, ..., bucket600]
  //   - header = {format:'cB', version:1}
  //   - bucket[index] = 该频率等级的单词列表（按字母序）
  //   - index 对应 -cB（centibels），freq = 10^(-index/100)
  //   - index=1 -> cB=-1 -> freq≈0.977（近100%，基本为空）
  //   - index=110 -> cB=-110 -> freq≈10^(-1.1)≈0.079（"the"约7-8%）
  //   - index=600 -> cB=-600 -> freq=10^(-6)（百万分之一）
  //   - 601 是 bucket 数（1 header + 600 buckets），不是词数！
  //   - 总词数 = 所有 bucket 内单词数之和（英文约 50000+）
  //   旧版假设是 {word:freq} 对象，用 Object.keys 把数组索引当 key ->
  //   map.set("0",1)... 而 lookup("the")=undefined -> 所有词判为表外。
  if (Array.isArray(freqObj) && freqObj.length > 0 &&
      freqObj[0] && typeof freqObj[0] === 'object' &&
      String(freqObj[0].format) === 'cB') {
    // cBpack 格式：跳过 header，按 index 升序遍历 bucket 赋 rank
    // index 小 = 频率高 = rank 小（1=最高频）
    // 反思（2026-08-03 修正）：原条件 freqObj[0].format === 'cB' && version === 1
    //   version 用 === 严格比较，msgpack-lite 可能解码为 string "1" 导致不命中。
    //   改为 String() 宽松比较 format，version 不作为检测条件（格式名已足够）。
    console.log(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] cBpack 格式: ${freqObj.length - 1} buckets, header:`, freqObj[0]);
    let rank = 1;
    const sampleWords = [];
    for (let i = 1; i < freqObj.length; i++) {
      const bucket = freqObj[i];
      if (Array.isArray(bucket)) {
        for (const word of bucket) {
          const w = String(word).toLowerCase();
          if (w) {
            map.set(w, rank++);
            if (sampleWords.length < 5) sampleWords.push(w);
          }
        }
      }
    }
    console.log(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] cBpack 构建完成: ${map.size} 词, 前5:`, sampleWords);
  } else if (Array.isArray(freqObj)) {
    // 普通数组格式：[word1, word2, ...] 按频率降序，rank = index + 1
    console.log(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] 数组格式: ${freqObj.length} 词, 前3:`, freqObj.slice(0, 3));
    for (let i = 0; i < freqObj.length; i++) {
      const word = String(freqObj[i]).toLowerCase();
      if (word) map.set(word, i + 1);
    }
  } else {
    // 对象格式：{word: freq}（large_*.msgpack.gz 等）
    const objKeys = Object.keys(freqObj);
    console.log(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] 对象格式: ${objKeys.length} 条, 前3:`, objKeys.slice(0, 3));
    const entries = Object.entries(freqObj);
    entries.sort((a, b) => (b[1] || 0) - (a[1] || 0));
    for (let i = 0; i < entries.length; i++) {
      map.set(entries[i][0].toLowerCase(), i + 1);
    }
  }
  console.log(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] 构建完成: ${map.size} 词`);
  // 反思（2026-08-20 第八十五次）：词频是词典字段，不再写 dictCache。
  //   送入词典（rank 字段 + __built__ 标记）由 _loadDict 的 bulkWriteDictionary 统一完成。
  return map;
}

/**
 * 加载 wordlists.json 词表标签（装载函数，与词典无关--仅初始化或词典数据缺失/不全时启用）
 * 反思（2026-08-20 第八十五次）：词表标签不是独立缓存，而是词典字段（words store 记录 tags 字段）。
 *   装载完成由 _loadDict 送入词典，此后页面加载只从词典投影读，本函数仅词典缺数据时执行。
 * @returns {Promise<Map<string, string[]>>} Map<word_lower, [list_ids]>
 */
export async function loadWordlists() {
  const url = chrome.runtime.getURL('src/data/wordlists.json');
  console.log(`[VocabRadar][dictionary][${_ts()}] 词典缺少词表数据，装载词表源文件: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[VocabRadar][dictionary][${_ts()}] wordlists 加载失败: HTTP ${res.status}, 返回空 Map`);
    return new Map();
  }
  const obj = await res.json();
  const map = new Map();
  for (const word in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, word)) {
      const lower = word.toLowerCase();
      const lists = obj[word] || [];
      map.set(lower, lists);
    }
  }
  console.log(`[VocabRadar][dictionary][${_ts()}] wordlists 装载完成: ${map.size} 词`);
  return map;
}
