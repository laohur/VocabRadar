// =============================================================================
// SW 翻译编排（2026-09-27 拆分自 service-worker.js）
// 职责：译文有效性判定（isUntranslated/targetScriptOk）、9 渠道串行编排
//   （handleTranslateText，供页面 TRANSLATE_TEXT）、网站桥接快路径
//   （handleBridgeTranslation，供 PARSE_MATERIAL kind:'translation'，2.2s 预算）。
// 渠道实现见 translate-channels.js（本文件不含任何请求细节）。
// =============================================================================
import { cleanDictEntry } from '../../lib/dict-clean.js';
import { getWord, updateFields } from '../../lib/word-db.js';
import { _ts, log } from './log.js';
import {
  backendTranslateOnce, baiduSugTranslate, youdaoDictTranslate, mymemoryTranslate,
  googleTranslate, youdaoTranslate, baiduTranslate, bingTranslate, lingvaTranslate
} from './translate-channels.js';

// === 在线翻译（Translator API 不可用时的兜底渠道） ===
// 注意渠道健壮性：一种不行就换一种

// 反思（2026-08-05 修正）：用户反馈"有些释义结果不正常，还是原来语言，要检查，换翻译渠道"。
//   根因：各渠道只校验"返回非空"，未校验"译文是否与原文相同（未翻译）"。
//   某些渠道（如百度语言码不匹配、MyMemory 限流返回原文）会返回原文未翻译，
//   被当作成功结果接受并缓存。
//   修正：新增 isUntranslated 校验函数，每个渠道返回后校验，
//   译文与原文完全相同（trim+lowercase）且 src!==tgt 时视为未翻译，继续下一渠道。
//   注意：少数外来语（如 tofu/dimension）译文可能确实与原文相同，会被误判，
//   但属罕见情况，且用户明确反馈"还是原来语言"，优先解决未翻译问题。
// 反思（2026-08-06 修正）：用户再次反馈"还是原来语言"。
//   根因：旧版 isUntranslated 只校验"译文=原文完全相同"，漏掉"同语言不同词"
//   （如 en→zh 时 running→run 仍是英文，不是中文）。
//   修正：新增 targetScriptOk 文字系统校验——译文须含目标语言的代表性字符。
//   tgt=zh 须含汉字，tgt=ja 须含假名/汉字，tgt=ko 须含谚文，tgt=ru 须含西里尔等。
//   不含目标文字系统 → 视为未翻译，换下一渠道。
//   源语言与目标语言同文字系统时（如 en→es 均拉丁字母）回退到精确匹配校验。
export function isUntranslated(text, word, src, tgt) {
  if (!text) return true;
  if (src === tgt) return false; // 同语言不校验
  const trimmed = text.trim();
  // 1. 精确匹配校验：译文=原文（trim+lowercase）→ 未翻译
  if (trimmed.toLowerCase() === word.trim().toLowerCase()) return true;
  // 2. 文字系统校验：译文须含目标语言代表性字符
  if (!targetScriptOk(trimmed, tgt)) {
    console.warn(`[VocabRadar][sw][${_ts()}] 校验失败: 译文"${trimmed}" 不含目标语言(${tgt})文字系统，视为未翻译`);
    return true;
  }
  return false;
}

/**
 * 校验译文是否含目标语言的代表性字符（文字系统）
 * 反思（2026-08-06）：精确匹配漏掉"同语言不同词"，需文字系统校验兜底。
 *   源语言与目标语言同文字系统时（如 en→es），返回 true（无法区分，回退精确匹配）。
 * @param {string} text 译文
 * @param {string} tgt 目标语言码
 * @returns {boolean} true=含目标文字系统（或无法判断），false=不含（未翻译）
 */
export function targetScriptOk(text, tgt) {
  if (!text) return false;
  // 目标语言 → 代表性 Unicode 范围
  const SCRIPT_MAP = {
    zh: '\\u4e00-\\u9fff',                              // CJK 汉字
    ja: '\\u3040-\\u309f\\u30a0-\\u30ff\\u4e00-\\u9fff', // 平假名/片假名/汉字
    ko: '\\uac00-\\ud7af',                              // 谚文
    ru: '\\u0400-\\u04ff', uk: '\\u0400-\\u04ff',       // 西里尔
    ar: '\\u0600-\\u06ff', he: '\\u0590-\\u05ff',       // 阿拉伯/希伯来
    th: '\\u0e00-\\u0e7f',                              // 泰文
    el: '\\u0370-\\u03ff',                              // 希腊文
    hi: '\\u0900-\\u097f', bn: '\\u0980-\\u09ff',       // 天城文/孟加拉文
    ta: '\\u0b80-\\u0bff', te: '\\u0c00-\\u0c7f', ml: '\\u0d00-\\u0d7f', // 泰米尔/泰卢固/马拉雅拉姆
  };
  const range = SCRIPT_MAP[tgt];
  if (!range) return true; // 拉丁字母语言（en/es/fr/de 等）无法区分，回退精确匹配
  const re = new RegExp('[' + range + ']');
  return re.test(text);
}

export async function handleTranslateText(word, source, target, channels) {
  if (!word) return { ok: false, error: 'empty word' };
  // 第二百一十六次（用户："引导页增加翻译一行，后跟LLM、几个api、浏览器自身复选框"）：
  //   每个渠道可勾选启停（缺省全启）；未勾选的渠道直接跳过（报"渠道未启用"）。
  const chGate = (id) => (!channels || channels[id] !== false);
  const src = source || 'en';
  const tgt = target || 'zh';
  // 反思（2026-08-12）：用户反馈"翻译一直 Translating..."。
  //   根因：在线翻译 fetch 无超时，服务器不响应时永久挂起，阻塞翻译队列。
  //   修正：所有翻译渠道用 fetchWithTimeout（8秒超时），超时返回 null 继续下一个渠道。
  // 反思（2026-08-13 第五十一次）：用户反馈"翻译 quizzes 失败，请增加直接用的翻译渠道"。
  //   旧渠道（MyMemory/Google/有道 translate_o/百度 transapi/Bing/Lingva）实测全失败：
  //     - Google gtx 国内被墙（aborted）
  //     - MyMemory 免费限流返回空
  //     - 有道 translate_o 签名失效 NetworkError
  //     - 百度 transapi 无签名端点在浏览器环境被反爬拒
  //     - Bing 需 IG token 获取常失败、Lingva 公共实例不稳定
  //   修正：新增两个免签名、国内直接可用的词典端点，放到最前（单词场景命中率最高）：
  //     渠道 1：百度联想 sug（fanyi.baidu.com/sug，POST kw，返回中文释义）
  //     渠道 2：有道词典 jsonapi（dict.youdao.com/jsonapi，返回中文释义）
  //   原 6 渠道保留为短语/句子兜底。

  // 渠道 0（第447次，用户裁定「勾了就排最前」）：后端翻译路由 POST /api/translate
  let beErr = null;
  try {
    if (!chGate('backend')) throw new Error('渠道未启用');
    const be = await backendTranslateOnce(word, src, tgt);
    if (be && !isUntranslated(be, word, src, tgt)) return { ok: true, text: be, channel: 'Backend' };
    beErr = be ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    beErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[Backend] 失败:', beErr);
  }

  // 渠道 1：百度联想 sug（单词中文释义，国内快、无需 key/签名）
  let bdsErr = null;
  try {
    if (!chGate('baidusug')) throw new Error('渠道未启用');
    const bds = await baiduSugTranslate(word, src, tgt);
    if (bds && !isUntranslated(bds, word, src, tgt)) return { ok: true, text: bds, channel: 'BaiduSug' };
    bdsErr = bds ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    bdsErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[BaiduSug] 失败:', bdsErr);
  }

  // 渠道 2：有道词典 jsonapi（单词中文释义，国内快、无需 key/签名）
  let yddErr = null;
  try {
    if (!chGate('youdaodict')) throw new Error('渠道未启用');
    const ydd = await youdaoDictTranslate(word, src, tgt);
    if (ydd && !isUntranslated(ydd, word, src, tgt)) return { ok: true, text: ydd, channel: 'YoudaoDict' };
    yddErr = ydd ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    yddErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[YoudaoDict] 失败:', yddErr);
  }

  // 渠道 3：MyMemory（免费，无需 key，CORS 友好）
  let mmErr = null;
  try {
    if (!chGate('mymemory')) throw new Error('渠道未启用');
    const mm = await mymemoryTranslate(word, src, tgt);
    if (mm && !isUntranslated(mm, word, src, tgt)) return { ok: true, text: mm, channel: 'MyMemory' };
    mmErr = mm ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    mmErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[MyMemory] 失败:', mmErr);
  }

  // 渠道 4：Google translate 公共端点（可能被限流，作为兜底）
  let ggErr = null;
  try {
    if (!chGate('google')) throw new Error('渠道未启用');
    const g = await googleTranslate(word, src, tgt);
    if (g && !isUntranslated(g, word, src, tgt)) return { ok: true, text: g, channel: 'Google' };
    ggErr = g ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    ggErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[Google] 失败:', ggErr);
  }

  // 渠道 5：有道翻译（国内可用，作为最终兜底）
  let ydErr = null;
  try {
    if (!chGate('youdao')) throw new Error('渠道未启用');
    const yd = await youdaoTranslate(word, src, tgt);
    if (yd && !isUntranslated(yd, word, src, tgt)) return { ok: true, text: yd, channel: 'Youdao' };
    ydErr = yd ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    ydErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[Youdao] 失败:', ydErr);
  }

  // 渠道 6：百度翻译（国内可用，最终兜底）
  let bdErr = null;
  try {
    if (!chGate('baidu')) throw new Error('渠道未启用');
    const bd = await baiduTranslate(word, src, tgt);
    if (bd && !isUntranslated(bd, word, src, tgt)) return { ok: true, text: bd, channel: 'Baidu' };
    bdErr = bd ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    bdErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[Baidu] 失败:', bdErr);
  }

  // 渠道 7：Bing 翻译（Edge 浏览器用户优先可用）
  let bingErr = null;
  try {
    if (!chGate('bing')) throw new Error('渠道未启用');
    const bing = await bingTranslate(word, src, tgt);
    if (bing && !isUntranslated(bing, word, src, tgt)) return { ok: true, text: bing, channel: 'Bing' };
    bingErr = bing ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    bingErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[Bing] 失败:', bingErr);
  }

  // 渠道 8：Lingva 翻译（Google 翻译代理，避免 Google 直接被墙）
  let lvErr = null;
  try {
    if (!chGate('lingva')) throw new Error('渠道未启用');
    const lv = await lingvaTranslate(word, src, tgt);
    if (lv && !isUntranslated(lv, word, src, tgt)) return { ok: true, text: lv, channel: 'Lingva' };
    lvErr = lv ? '返回原文未翻译' : '返回空结果';
  } catch (e) {
    lvErr = String(e.message || e);
    console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[Lingva] 失败:', lvErr);
  }

  return { ok: false, error: 'Backend: ' + beErr + '; BaiduSug: ' + bdsErr + '; YoudaoDict: ' + yddErr + '; MyMemory: ' + mmErr + '; Google: ' + ggErr + '; Youdao: ' + ydErr + '; Baidu: ' + bdErr + '; Bing: ' + bingErr + '; Lingva: ' + lvErr };
}

// === 343 次（2026-09-19）：网站桥接翻译快路径（kind:'translation' 实现） ===
// 说人话：网站页面遇到生词，先问扩展「你有这个词的中文释义吗」——本函数就是
//   扩展的应答器。三步：①查本地词典缓存（含原形，如 running→run 的缓存）；
//   ②缓存没有就并行问快渠道（百度联想 sug + 有道词典 jsonapi；第447次起，
//     勾选了 Backend 渠道则把后端翻译路由 /api/translate 一并列入并行，列首位）；
//   ③拿到有效译文回写缓存（下次秒回）。全程尊重扩展设置里的渠道勾选
//   （translationChannels，用户关掉的渠道不问）。
// 为什么不用 handleTranslateText 全渠道：它串行跑 8 渠道最坏 55s，网站侧 3s 就
//   超时并熔断扩展通道（本会话不再用扩展翻译），违背本次供给初衷。
export async function handleBridgeTranslation(payload) {
  const word = String((payload && payload.word) || '').trim();
  // 网站侧传 BCP-47（可能 zh-CN/en-US），渠道函数只认基码——截基段
  const src = (String((payload && payload.source) || 'en').split('-')[0] || 'en').toLowerCase();
  const tgt = (String((payload && payload.target) || 'zh').split('-')[0] || 'zh').toLowerCase();
  if (!word) return { ok: false, error: 'translation payload missing word' };

  // ① 词典缓存直读（translationLang 校验语言对；原形回退：屈折词借原形缓存）
  try {
    const rec = await getWord(src, word);
    if (rec && rec.translation && rec.translationLang === tgt) {
      return { ok: true, text: cleanDictEntry(rec.translation), channel: '缓存' };
    }
    if (rec && rec.lemma && rec.lemma !== word.toLowerCase()) {
      const lem = await getWord(src, rec.lemma);
      if (lem && lem.translation && lem.translationLang === tgt) {
        const t = cleanDictEntry(lem.translation);
        await updateFields(src, word, { translation: t, translationLang: tgt }); // 回写原词，下次直接命中
        return { ok: true, text: t, channel: '缓存(原形:' + rec.lemma + ')' };
      }
    }
  } catch (_) { /* 缓存读失败不阻断，走在线快渠道 */ }

  // ② 快渠道并行（各渠道勾选门控对齐 handleTranslateText 的 chGate 语义：缺省启用）
  let ch = {};
  try { ch = (await new Promise((r) => chrome.storage.local.get({ translationChannels: {} }, r))).translationChannels || {}; } catch (_) { }
  const tasks = [];
  // 第447次（用户裁定「网站桥接也接上」「勾了就排最前」）：后端翻译路由并行候选，列首位
  //   ——Promise.all 等齐后按数组序取第一个有效结果，故列首即"优先用后端"。门控用
  //   `=== true`（backend 缺省不选，旧表无此键，沿用 `!== false` 会让未升级用户默认全开）。
  //   单独 1.2s 上限：本路径有 2.2s 总预算，Promise.all 会等齐全部候选，后端在推理时
  //   慢则整包超时，连本来能赢的百度联想也陪葬——故后端超时即判失败让位（用户已认此取舍）。
  if (ch.backend === true) tasks.push(_bridgeTryChannel('Backend',
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('backend translate budget (1.2s) exceeded')), 1200);
      backendTranslateOnce(word, src, tgt).then((t) => { clearTimeout(timer); resolve(t); },
        (e) => { clearTimeout(timer); reject(e); });
    }), word, src, tgt));
  if (ch.baidusug !== false) tasks.push(_bridgeTryChannel('BaiduSug', baiduSugTranslate(word, src, tgt), word, src, tgt));
  if (ch.youdaodict !== false) tasks.push(_bridgeTryChannel('YoudaoDict', youdaoDictTranslate(word, src, tgt), word, src, tgt));
  // 343 次·裁定：失败返回 ok:true+空 text（空文本降级，见上方分支注释），error 照带不遮蔽
  if (!tasks.length) return { ok: true, text: '', error: '快渠道均未启用（backend/baidusug/youdaodict 已在扩展设置勾选关闭）' };
  const results = await Promise.all(tasks);
  const hit = results.find(Boolean);
  if (!hit) return { ok: true, text: '', error: '快渠道（' + (ch.backend === true ? 'Backend/' : '') + 'BaiduSug/YoudaoDict）均失败——网站侧降级其自身 API' };

  // ③ 回写缓存（小写主键与 makeKey 口径一致），下次网站请求毫秒级命中
  try { await updateFields(src, word, { translation: hit.text, translationLang: tgt }); } catch (_) { /* ignore */ }
  return { ok: true, text: hit.text, channel: hit.channel };
}

// 单渠道尝试包装：译文须过 isUntranslated 校验（同 handleTranslateText 口径），
//   失败/原文回显一律 null（不抛，由上层汇总），防单渠道异常拖垮并行结构
async function _bridgeTryChannel(channel, p, word, src, tgt) {
  try {
    const t = await p;
    if (t && !isUntranslated(t, word, src, tgt)) return { text: t, channel };
    console.warn('[VocabRadar][sw][' + _ts() + '] 桥接渠道[' + channel + '] 无效结果:', t || '(空)');
  } catch (e) {
    console.warn('[VocabRadar][sw][' + _ts() + '] 桥接渠道[' + channel + '] 失败:', String(e.message || e));
  }
  return null;
}
