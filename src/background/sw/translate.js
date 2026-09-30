// =============================================================================
// SW 翻译编排
// 职责：译文分类判定（classifyTranslation/isUntranslated/targetScriptOk）、
//   9 渠道表驱动串行编排 + 同形词跨渠道共识 + 渠道状态登记/熔断冷却（handleTranslateText，
//   供页面 TRANSLATE_TEXT）、网站桥接快路径（handleBridgeTranslation，供 PARSE_MATERIAL
//   kind:'translation'，2.2s 预算）。渠道实现见 translate-channels.js。
// =============================================================================
import { cleanDictEntry } from '../../lib/dict-clean.js';
import { getWord, updateFields } from '../../lib/word-db.js';
import { isRunawayText } from '../../lib/runaway.js';
import { _ts, log } from './log.js';
import {
  backendTranslateOnce, baiduSugTranslate, youdaoDictTranslate, mymemoryTranslate,
  reversoTranslate, googleTranslate, youdaoTranslate, baiduTranslate, bingTranslate
} from './translate-channels.js';

// === 在线翻译（Translator API 不可用时的兜底渠道） ===
// 注意渠道健壮性：一种不行就换一种

// 用户反馈"有些释义结果不正常，还是原来语言"：各渠道只校验"返回非空"不够——
//   某些渠道（百度语言码不匹配、MyMemory 限流）会返回原文未翻译，被当成功接受并缓存。
//   isUntranslated 校验译文与原文完全相同（trim+lowercase）且 src!==tgt → 未翻译，
//   继续下一渠道；少数外来语（tofu/dimension）译文与原文相同会被误判，属罕见取舍。
//   targetScriptOk 文字系统校验兜"同语言不同词"（en→zh 时 running→run 仍是英文）：
//   译文须含目标语言代表性字符（zh 汉字/ja 假名汉字/ko 谚文/ru 西里尔等），不含 →
//   未翻译换下一渠道；源/目标同文字系统（如 en→es 均拉丁字母）回退精确匹配校验。
/**
 * 译文分类器（同形词共识改制）。
 * 说人话：把「译文可用性」细分成三档，供表驱动编排层按档处置——
 *   'ok'       正常译文 → 立即采纳；
 *   'same-form 译文与原文完全相同但文字系统合格（如 pt→pt 的 americanos 原样回显、
 *              或 es→pt 外来语同形）→ 不立即采纳，记入跨渠道共识票，≥2 个独立
 *              渠道投出同一文本才采纳（单渠道同形大概率是端点偷懒回显，不可信）；
 *   'bad'      空结果/文字系统不符（如 en→zh 返回英文、渠道中文泄漏）/输出失控
 *              （退化重复，isRunawayText 判定）→ 丢弃换渠道。
 * 分类规则：src===tgt 一律 ok（同语言不校验）；先比 trim+lowercase 精确相等，
 *   再过输出失控检测（LLM 免费渠道偶发单字符无限复读，如 "ooo呜呜呜呜呜…"，
 *   非空且文字系统合格，旧三道闸拦不住），最后跑 targetScriptOk 文字系统校验
 *   （不等但文字系统不符也是 bad——同语言不同词）。
 * @param {string} text 译文（可为 null/空）
 * @param {string} word 原文
 * @param {string} src 源语言码
 * @param {string} tgt 目标语言码
 * @returns {'ok'|'same-form'|'bad'}
 */
export function classifyTranslation(text, word, src, tgt) {
  if (!text) return 'bad';
  if (src === tgt) return 'ok';
  const trimmed = String(text).trim();
  const same = trimmed.toLowerCase() === String(word || '').trim().toLowerCase();
  if (same) return targetScriptOk(trimmed, tgt) ? 'same-form' : 'bad';
  if (isRunawayText(trimmed, word)) {
    console.warn(`[VocabRadar][sw][${_ts()}] 校验失败: 译文"${trimmed.slice(0, 60)}" 输出失控（退化重复），视为无效`);
    return 'bad';
  }
  if (!targetScriptOk(trimmed, tgt)) {
    console.warn(`[VocabRadar][sw][${_ts()}] 校验失败: 译文"${trimmed}" 不含目标语言(${tgt})文字系统，视为未翻译`);
    return 'bad';
  }
  return 'ok';
}

/**
 * 译文是否视为未翻译（导出供桥接快路径 _bridgeTryChannel 沿用）。
 * 实现为 classifyTranslation 的薄包装：same-form/bad 均算未翻译——共识采纳与否
 *   由编排层 handleTranslateText 单独裁决。
 * @returns {boolean} true=未翻译（空/原文回显/文字系统不符）
 */
export function isUntranslated(text, word, src, tgt) {
  return classifyTranslation(text, word, src, tgt) !== 'ok';
}

/**
 * 校验译文是否含目标语言的代表性字符（文字系统）。
 * 源语言与目标语言同文字系统时（如 en→es）返回 true（无法区分，回退精确匹配）。
 * CJK 反向规则（用户反馈"释义语言并没有跟随设定"）：拉丁目标语言（en/es/fr 等，
 *   SCRIPT_MAP 无条目）若恒放行，baidusug/youdaodict 恒返回的中文释义会被当作
 *   任意目标语言的译文采纳并写脏缓存——目标语言非 CJK 而译文含 CJK 字符
 *   （假名/注音/汉字/兼容汉字/谚文）→ 判未翻译。
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
  // CJK 字符（假名/注音符号/汉字扩展/兼容汉字/谚文）：渠道中文释义泄漏的指纹
  const CJK_RE = /[\u3040-\u30ff\u3100-\u312f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
  const range = SCRIPT_MAP[tgt];
  // 拉丁字母语言（en/es/fr/de 等）：反向规则——译文含 CJK 即中文泄漏（如 baidusug/youdaodict 恒返回中文），判未翻译
  if (!range) return !CJK_RE.test(text);
  const re = new RegExp('[' + range + ']');
  return re.test(text);
}

// 渠道表（表驱动改制，消除 11 份重复 try/catch；需 Key 渠道 deepl/mstrans 撤销 →
//   9 渠道，串行保持）：
//   顺序 = 用户裁定回退序：勾选的 Backend/词典快渠道 → Reverso/Bing →
//   国内兜底（Google gtx 可能被墙，仍有有道/百度兜底）→ MyMemory 默认不选、末位手工兜底。
//   lingva 公共实例不稳定，已摘除。zhOnly=端点恒返回中文释义，仅 zh 目标参与。
//   每渠道单次 8 秒超时（translate-channels.js fetchWithTimeout），最坏 9×8=72s。
const CHANNEL_TABLE = [
  { id: 'backend', name: 'Backend', run: backendTranslateOnce },
  { id: 'baidusug', name: 'BaiduSug', run: baiduSugTranslate, zhOnly: true },
  { id: 'youdaodict', name: 'YoudaoDict', run: youdaoDictTranslate, zhOnly: true },
  { id: 'reverso', name: 'Reverso', run: reversoTranslate },
  { id: 'bing', name: 'Bing', run: bingTranslate },
  { id: 'google', name: 'Google', run: googleTranslate },
  { id: 'youdao', name: 'Youdao', run: youdaoTranslate },
  { id: 'baidu', name: 'Baidu', run: baiduTranslate },
  { id: 'mymemory', name: 'MyMemory', run: mymemoryTranslate }
];

// === 渠道状态登记 + 连败熔断（用户裁定「记录各个渠道状态」） ===
// 说人话：每次渠道尝试都记一笔账（成功/失败/连败数/最近错误/最近耗时/冷却截止），
//   连败 ≥3 次进入 60 秒冷却——冷却期内直接跳过该渠道（省掉白烧的 8s 超时），
//   冷却到期自动解除、连败清零重试。状态经 router.js 'CHANNEL_STATUS' 消息
//   供引导页「翻译」分组状态行读取（guide/ch-health.js）。
const CH_COOLDOWN_MS = 60 * 1000;
const CH_FAIL_LIMIT = 3;
const _chStatus = new Map(); // id → {name, ok, fail, consec, lastErr, lastMs, coolUntil, lastOk}

/** 取渠道状态快照（数组序 = 渠道表序，供 CHANNEL_STATUS 消息返回） */
export function getChannelStatus() {
  const now = Date.now();
  return CHANNEL_TABLE.map((c) => {
    const s = _chStatus.get(c.id);
    return {
      id: c.id, name: c.name,
      ok: s ? s.ok : 0, fail: s ? s.fail : 0,
      consec: s && s.coolUntil <= now ? s.consec : (s ? s.consec : 0),
      coolingMs: s && s.coolUntil > now ? s.coolUntil - now : 0,
      lastErr: s ? s.lastErr : '', lastMs: s ? s.lastMs : 0, lastOk: s ? s.lastOk : 0
    };
  });
}

/** 记一次渠道成功（清连败与冷却） */
function _chOk(id, name, ms) {
  const s = _chStatus.get(id) || { name, ok: 0, fail: 0, consec: 0, lastErr: '', lastMs: 0, coolUntil: 0, lastOk: 0 };
  s.ok++; s.consec = 0; s.coolUntil = 0; s.lastMs = ms; s.lastOk = Date.now(); s.lastErr = '';
  _chStatus.set(id, s);
}

/** 记一次渠道失败（连败 ≥CH_FAIL_LIMIT 进入冷却） */
function _chFail(id, name, err, ms) {
  const s = _chStatus.get(id) || { name, ok: 0, fail: 0, consec: 0, lastErr: '', lastMs: 0, coolUntil: 0, lastOk: 0 };
  s.fail++; s.consec++; s.lastErr = String(err || '').slice(0, 80); s.lastMs = ms;
  if (s.consec >= CH_FAIL_LIMIT) s.coolUntil = Date.now() + CH_COOLDOWN_MS;
  _chStatus.set(id, s);
}

/**
 * 全渠道翻译编排（页面 TRANSLATE_TEXT 的执行体）。
 * 同形词跨渠道共识（用户裁定）：同形结果（译文=原文，classifyTranslation='same-form'）
 *   不单渠道立即采纳也不直接丢弃——记入共识票（Map<规范化译文, Set<渠道名>>），
 *   **≥2 个独立渠道投出同一文本才采纳**（channel 标注 "A+B(同形词印证)"）；单渠道
 *   同形大概率是端点偷懒回显原文，不可信。正常译文（'ok'）立即采纳；'bad' 丢弃换
 *   下一渠道。内容侧浏览器内置（builtin Translator）判定的同形结果经 prior 形参
 *   下传先计 1 票——builtin 与任一在线渠道同形即凑满 2 票采纳（内置优先的延伸）。
 * 渠道状态（用户裁定「记录各个渠道状态」）：每次尝试写入 _chStatus 登记簿，
 *   连败 ≥3 冷却 60s 跳过（见渠道表下方 _chOk/_chFail）；快照经 'CHANNEL_STATUS'
 *   消息供引导页状态行（ch-health.js）读取。
 * 每个渠道可勾选启停（缺省全启），未勾选报"渠道未启用"；渠道 fetch 一律 8 秒超时
 *   （channels 内 fetchWithTimeout），防服务器不响应永久挂起阻塞翻译队列。
 *   baidusug/youdaodict 为免签名国内快渠道（恒中文释义，zhOnly 门控，见 CHANNEL_TABLE）。
 * @param {string} word 待译文本
 * @param {string} [source] 源语言码（缺省 en）
 * @param {string} [target] 目标语言码（缺省 zh）
 * @param {Object} [channels] 渠道勾选表（transCh*；缺省全启）
 * @param {Object} [prior] builtin 先验同形票 { text, channel }（见 index.js 下传）
 * @returns {Promise<{ok:true,text,channel}|{ok:false,error}>}
 */
export async function handleTranslateText(word, source, target, channels, prior) {
  if (!word) return { ok: false, error: 'empty word' };
  const chGate = (id) => (!channels || channels[id] !== false);
  const src = source || 'en';
  const tgt = target || 'zh';
  const errs = [];
  const votes = new Map(); // 同形词共识票：规范化译文(小写) → { text, chans:Set<渠道名> }

  // builtin 先验票：内容侧浏览器内置给出的同形结果（随 TRANSLATE_TEXT 下传）。
  //   与在线渠道同口径过 classifyTranslation——文字系统不合格的（bad）不计票。
  if (prior && prior.text && classifyTranslation(prior.text, word, src, tgt) === 'same-form') {
    const k = String(prior.text).trim().toLowerCase();
    votes.set(k, { text: String(prior.text).trim(), chans: new Set([prior.channel || '浏览器内置']) });
    errs.push((prior.channel || '浏览器内置') + ': 同形词待印证(1/2)');
  }

  for (const c of CHANNEL_TABLE) {
    if (!chGate(c.id)) { errs.push(c.name + ': 渠道未启用'); continue; }
    if (c.zhOnly && tgt !== 'zh') {
      errs.push(c.name + ': 不支持目标语言(' + tgt + ')（端点恒返回中文释义）');
      continue;
    }
    // 熔断：连败 ≥3 次的渠道冷却 60s，期内跳过（省掉白烧的 8s 超时）；
    //   冷却到期自动解除并在首次重试前清零连败（_chOk/_chFail 维护）。
    const preSt = _chStatus.get(c.id);
    if (preSt && preSt.coolUntil > Date.now()) {
      errs.push(c.name + ': 冷却中(' + Math.ceil((preSt.coolUntil - Date.now()) / 1000) + 's，连败' + preSt.consec + ')');
      continue;
    }
    if (preSt && preSt.coolUntil && preSt.coolUntil <= Date.now()) { preSt.consec = 0; preSt.coolUntil = 0; } // 冷却到期重置
    const t0 = Date.now();
    try {
      const t = await c.run(word, src, tgt);
      const cls = classifyTranslation(t, word, src, tgt);
      if (cls === 'ok') { _chOk(c.id, c.name, Date.now() - t0); return { ok: true, text: String(t).trim(), channel: c.name }; }
      if (cls === 'same-form') {
        const k = String(t).trim().toLowerCase();
        const ent = votes.get(k) || { text: String(t).trim(), chans: new Set() };
        ent.chans.add(c.name);
        if (ent.chans.size >= 2) {
          _chOk(c.id, c.name, Date.now() - t0);
          return { ok: true, text: ent.text, channel: Array.from(ent.chans).join('+') + '(同形词印证)' };
        }
        _chOk(c.id, c.name, Date.now() - t0); // 同形待印证属"响应正常"，计成功不计失败
        errs.push(c.name + ': 同形词待印证(1/2)');
        continue;
      }
      _chFail(c.id, c.name, t ? '未通过文字系统校验' : '返回空结果', Date.now() - t0);
      errs.push(c.name + ': ' + (t ? '未通过文字系统校验' : '返回空结果'));
    } catch (e) {
      const m = String(e.message || e);
      _chFail(c.id, c.name, m, Date.now() - t0);
      errs.push(c.name + ': ' + m);
      console.warn('[VocabRadar][sw][' + _ts() + '] 渠道[' + c.name + '] 失败:', m);
    }
  }
  return { ok: false, error: errs.join('; ') };
}

// === 网站桥接翻译快路径（kind:'translation' 实现） ===
// 网站页面遇到生词，先问扩展「你有这个词的中文释义吗」——本函数就是扩展的应答器。
//   三步：①查本地词典缓存（含原形，如 running→run 的缓存）；②缓存没有就并行问快渠道
//   （百度联想 sug + 有道词典 jsonapi + Reverso；勾选了 Backend 则把后端翻译路由
//   /api/translate 一并列入并行，列首位）；③拿到有效译文回写缓存（下次秒回）。
//   全程尊重扩展设置里的渠道勾选（translationChannels，用户关掉的渠道不问）。
// 为什么不用 handleTranslateText 全渠道：它串行跑 9 渠道最坏 72s，网站侧 3s 就
//   超时并熔断扩展通道，违背供给初衷。
export async function handleBridgeTranslation(payload) {
  const word = String((payload && payload.word) || '').trim();
  // 网站侧传 BCP-47（可能 zh-CN/en-US），渠道函数只认基码——截基段
  const src = (String((payload && payload.source) || 'en').split('-')[0] || 'en').toLowerCase();
  const tgt = (String((payload && payload.target) || 'zh').split('-')[0] || 'zh').toLowerCase();
  if (!word) return { ok: false, error: 'translation payload missing word' };

  // ① 词典缓存直读（translationLang 校验语言对 + targetScriptOk 校验文字系统，
  //   存量脏缓存（中文释义写成任意 translationLang）在此自动失效走在线重翻；
  //   原形回退：屈折词借原形缓存）
  try {
    const rec = await getWord(src, word);
    if (rec && rec.translation && rec.translationLang === tgt && targetScriptOk(rec.translation, tgt)) {
      return { ok: true, text: cleanDictEntry(rec.translation), channel: '缓存' };
    }
    if (rec && rec.lemma && rec.lemma !== word.toLowerCase()) {
      const lem = await getWord(src, rec.lemma);
      if (lem && lem.translation && lem.translationLang === tgt && targetScriptOk(lem.translation, tgt)) {
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
  // 后端翻译路由并行候选列首位（用户裁定「网站桥接也接上」「勾了就排最前」）：
  //   Promise.all 等齐后按数组序取第一个有效结果，故列首即"优先用后端"。门控用
  //   `=== true`（backend 缺省不选）。单独 1.2s 上限：本路径有 2.2s 总预算，
  //   Promise.all 会等齐全部候选，后端推理慢则整包超时连百度联想也陪葬——后端
  //   超时即判失败让位（用户已认此取舍）。
  if (ch.backend === true) tasks.push(_bridgeTryChannel('Backend',
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('backend translate budget (1.2s) exceeded')), 1200);
      backendTranslateOnce(word, src, tgt).then((t) => { clearTimeout(timer); resolve(t); },
        (e) => { clearTimeout(timer); reject(e); });
    }), word, src, tgt));
  // baidusug/youdaodict 恒返回中文释义，非 zh 目标不参与并行（与 handleTranslateText
  //   渠道门控同口径），否则中文释义会被写脏缓存。
  if (ch.baidusug !== false && tgt === 'zh') tasks.push(_bridgeTryChannel('BaiduSug', baiduSugTranslate(word, src, tgt), word, src, tgt));
  if (ch.youdaodict !== false && tgt === 'zh') tasks.push(_bridgeTryChannel('YoudaoDict', youdaoDictTranslate(word, src, tgt), word, src, tgt));
  // Reverso（免 key 翻译端点，响应快约 300ms）并入桥接并行组，兜住 baidusug/
  //   youdaodict 只服务 zh 目标的缺口；不支持的语言对由渠道抛错、_bridgeTryChannel
  //   捕获记日志，不影响其他并行候选。
  if (ch.reverso !== false) tasks.push(_bridgeTryChannel('Reverso', reversoTranslate(word, src, tgt), word, src, tgt));
  // 用户裁定：失败返回 ok:true+空 text（空文本降级，见上方分支注释），error 照带不遮蔽
  if (!tasks.length) return { ok: true, text: '', error: '快渠道均不可用（backend 未勾选或超预算；baidusug/youdaodict 需勾选启用且目标语言为中文；reverso 被取消勾选）' };
  const results = await Promise.all(tasks);
  const hit = results.find(Boolean);
  if (!hit) return { ok: true, text: '', error: '快渠道（' + (ch.backend === true ? 'Backend/' : '') + 'BaiduSug/YoudaoDict/Reverso）均失败——网站侧降级其自身 API' };

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
