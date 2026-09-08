// ============================================================
// 文件职责：词频/词表源文件装载函数（src/lib/dictionary/word-loader.js）
// 来源：拆分自 src/lib/dictionary.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// 装载函数（loadWordfreq/loadWordlists）与词典无关--仅在初始化或词典数据
//   缺失/不全时启用（由 projection.js 的 _rebuildFromSources 调用），装载完成
//   经 bulkWriteDictionary 送入词典（word-db.js）后不再读取（readme 权威设计）。
// 含：fetchWfViaBackground（2026-09-08 HF dataset 中转，SW 直传 ArrayBuffer）、
//   loadWordfreq（HF CDN 拉取 + DecompressionStream 解压 + msgpack/cBpack 解码 ->
//   Map<word, rank>）、loadWordlists（JSON -> Map<word, tags>）、
//   loadBuiltinEnZh（内置英中翻译包 JSON -> Map<word, translation定稿字符串>）。
// 仅使用 state.js 的 _ts() 时间戳辅助，无共享状态写入（产物 Map 由调用方消费）。
// ============================================================

import { _ts } from './state.js';
import { decode as msgpackDecode } from '../vendor/msgpack-lite.js';

/**
 * 通过 background Service Worker 拉 wordfreq 数据文件（2026-09-08 HF dataset CDN 化）
 * 背景：42 语 small_*.msgpack.gz 不随包，改由 HF dataset vocabradar/wordfreq 拉取。
 *   content script 受宿主页面 CSP connect-src 约束（B站/YouTube 等不放行
 *   huggingface.co），须由 SW 代理 fetch（含 files.json SHA-256 校验，见
 *   service-worker.js handleWfFetch；SW 恒为 secure context，crypto.subtle 可用）。
 * @param {string} file 相对路径（data/small_xx.msgpack.gz，SW 端正则白名单，防借道 SSRF）
 * @returns {Promise<{ok:true,data:ArrayBuffer}|null>} 成功返回 {ok,data}（SW 直传，
 *   结构化克隆支持 ArrayBuffer），失败返回 null
 */
function fetchWfViaBackground(file) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'WF_FETCH', file }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[VocabRadar][dictionary] wordfreq 后台拉取消息错误:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        if (response && response.ok && response.data) {
          resolve(response);
        } else {
          console.warn('[VocabRadar][dictionary] wordfreq 后台拉取失败:', response && response.error);
          resolve(null);
        }
      });
    } catch (e) {
      console.warn('[VocabRadar][dictionary] wordfreq 后台拉取消息发送失败:', e);
      resolve(null);
    }
  });
}

/**
 * 加载 wordfreq 数据文件（装载函数，与词典无关--仅初始化或词典数据缺失/不全时启用）
 * 流程：SW 经 HF dataset 拉 .gz（SHA-256 已校验）-> DecompressionStream 解压（或 SW 回退）-> msgpack 解码 -> 构建 Map<word, rank>
 * 反思（2026-08-20 第八十五次）：词频不是独立缓存，而是词典字段（words store 记录 rank 字段）。
 *   装载完成由 _loadDict 送入词典（bulkWriteDictionary），此后页面加载只从词典投影读，
 *   本函数仅在词典缺少该语言数据时执行（用户："词频、词形等都是扩展刚安装初始化一次性读取，
 *   读完之后存入词典，之后不再读取"）。不再读写 dictCache。
 * @param {string} lang 语言代码（如 en, zh, ja）
 * @returns {Promise<Map<string, number>>} Map<word_lower, rank>
 */
export async function loadWordfreq(lang) {
  // 2026-09-08（用户批复"删包内 42 语 .bin"+ HF dataset）：词频包不再随扩展分发，
  //   改经 SW 从 HF dataset vocabradar/wordfreq 拉取（files.json SHA-256 校验在 SW 端）。
  const file = `data/small_${lang}.msgpack.gz`;
  console.log(`[VocabRadar][dictionary][${_ts()}] 词典缺少 ${lang} 数据，经后台拉取词频源文件: ${file}`);
  // 反思（2026-08-05 修正）：拉取可能抛异常（扩展更新后页面未刷新、网络失败等），
  //   未包 try/catch 会导致 loadDictionary reject -> text-hint startHint 中断 -> 文本提示不出现。
  //   修正：失败返回空 Map（所有词按表外处理，不阻塞功能）——fetchWfViaBackground
  //   内部已兜底为 resolve(null)，永不 reject。
  const r = await fetchWfViaBackground(file);
  if (!r) {
    console.warn(`[VocabRadar][dictionary][${_ts()}] wordfreq 拉取失败（${file}），返回空 Map`);
    return new Map();
  }

  // 1. gzip 解压（DecompressionStream 单路径：Chrome 80+, Firefox 113+）。
  // 2026-09-08（用户批复）：删旧"回退 SW 代解压"分支——直传改造后该分支已无触发
  //   条件（SW 从未实现 DECOMPRESS_GZIP handler，sendMessage 恒得 lastError，纯死路）。
  //   解压失败即返回空 Map（所有词按表外处理），不阻塞功能。
  const compressed = r.data;
  console.log(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] 压缩大小: ${(compressed.byteLength / 1024).toFixed(1)} KB`);
  let decompressedBuf;
  try {
    const decompressedStream = new Response(compressed).body
      .pipeThrough(new DecompressionStream('gzip'));
    decompressedBuf = await new Response(decompressedStream).arrayBuffer();
    console.log(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] DecompressionStream 解压成功: ${(decompressedBuf.byteLength / 1024).toFixed(1)} KB`);
  } catch (e) {
    console.error(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] gzip 解压失败:`, e);
    return new Map();
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
  // 2026-09-08（用户批复"HF 数据更新自动重建"）：成功拉取并解码后，把 SW 校验过的
  //   sha256/bytes 写入 storage.wfInstalled[lang]（SW checkWfUpdates 每 24h 轮询比对的
  //   基线），并清除 wfUpdates[lang] 待处理标记。失败路径（返回空 Map）不写——保持
  //   旧基线，等下次更新检测或重装触发重拉。
  try {
    if (r && r.sha256) {
      const { wfInstalled = {}, wfUpdates = {} } = await chrome.storage.local.get(['wfInstalled', 'wfUpdates']);
      wfInstalled[lang] = { sha256: r.sha256, bytes: r.bytes || 0, ts: Date.now() };
      delete wfUpdates[lang];
      await chrome.storage.local.set({ wfInstalled, wfUpdates });
      console.log(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] 已记录源版本 sha256=${String(r.sha256).slice(0, 8)}…（更新轮询基线）`);
    }
  } catch (e) {
    console.warn(`[VocabRadar][dictionary][${_ts()}] wordfreq[${lang}] 记录源版本失败（不影响装载）:`, e);
  }
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

/**
 * 加载内置英中翻译包（装载函数，与词典无关--仅初始化或词典数据缺失/不全时启用）
 * 反思（2026-09-04）：小程序内置英中翻译包（VocabRadar/preprocess/build_translation_zh.py
 *   产出，ECDICT+LLM，见 src/data/translations/ATTRIBUTION.md）接入扩展——不走内存直查
 *   （违反"业务只从词典读"），而在此装载为 Map<word, translation定稿字符串>，
 *   由 projection._rebuildFromSources 经 bulkWriteTranslations 一次性写入词典 d_trans
 *   分表（translationLang='zh'），之后 translator 首层词典缓存即命中，在线只补真正缺词。
 *   仅 learnLanguage=en 时调用；其它语言对不受影响（translationLang 校验天然隔离）。
 *   释义定稿：数组 join(' | ')，与详细模式 translations.join(' | ') 全列口径一致。
 * @returns {Promise<Map<string, string>>} Map<word_lower, translation>
 */
export async function loadBuiltinEnZh() {
  const url = chrome.runtime.getURL('src/data/translations/en_zh.json');
  console.log(`[VocabRadar][dictionary][${_ts()}] 装载内置英中翻译包: ${url}`);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.warn(`[VocabRadar][dictionary][${_ts()}] 内置翻译包 fetch 异常: ${e && e.message}, 返回空 Map（释义走在线）`);
    return new Map();
  }
  if (!res.ok) {
    console.warn(`[VocabRadar][dictionary][${_ts()}] 内置翻译包加载失败: HTTP ${res.status}, 返回空 Map（释义走在线）`);
    return new Map();
  }
  let obj;
  try {
    obj = await res.json();
  } catch (e) {
    console.warn(`[VocabRadar][dictionary][${_ts()}] 内置翻译包 JSON 解析失败，返回空 Map（释义走在线）`);
    return new Map();
  }
  const map = new Map();
  if (obj && typeof obj === 'object') {
    for (const word in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, word)) continue;
      const v = obj[word];
      const arr = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : null);
      if (!arr) continue;
      const items = [];
      for (const t of arr) {
        if (typeof t !== 'string') continue;
        const s = t.trim();
        if (s && items.indexOf(s) === -1) items.push(s);
        if (items.length >= 5) break;
      }
      if (items.length > 0) map.set(String(word).toLowerCase(), items.join(' | '));
    }
  }
  console.log(`[VocabRadar][dictionary][${_ts()}] 内置英中翻译包装载完成: ${map.size} 词`);
  return map;
}
