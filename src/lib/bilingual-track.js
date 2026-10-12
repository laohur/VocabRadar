// ============================================================
// 双语字幕第二轨编排（src/lib/bilingual-track.js，D1+D2 落地）
// ------------------------------------------------------------
// 职责：双语副行取数的**唯一入口** fetchBilingualLine(cue, mainCues)。
//   数据源优先级（用户批复"都做"，依据 video/docs/专题调研-双语字幕对齐.md §四）：
//     ① 站上现成第二语言字幕文件——YouTube 原生轨/tlang 翻译轨、B站 subtitle 列表；
//     ② 两份文件时间轴偏差经 bilingual-align 全局偏移 + 时间重叠配对修齐（D2）；
//     ③ 站上无第二语言文件 / 逐行配不上 / prime 失败 → fetchBilingualTrans
//        实时翻译兜底（既有渠道表 + 熔断，行为与旧版完全一致）。
// 生命周期：按 `平台|视频标识(去 t/si)|learn|meaning` 缓存状态机——
//   每视频+语言对至多一次第二轨发现与下载；换集/换语言对自动重新 prime；
//   失败负缓存（failed 不逐行重试发现）；双语开关关闭时零成本（无人调用）。
// 等待策略：发现链总闸 PRIME_TIMEOUT_MS（超时判 failed）；单行等待
//   PRIME_WAIT_MS——取数链慢时该行先出实时译文，prime 继续跑，后续行改用
//   站上文件（宁可短暂混源，不让译文行长期缺席）。
// 关系：依赖 ./bilingual-trans.js（兜底）、./subtitle/bilingual-align.js（对齐纯函数）、
//   ./subtitle/index.js（两平台第二轨取数）。消费方：vs/subtitle-renderer.js、
//   subtitle-overlay.js（双语渲染分支）。
// ============================================================
import { fetchBilingualTrans } from './bilingual-trans.js';
import { estimateOffset, prepareSecondary, pairSecondaryText } from './subtitle/bilingual-align.js';
import { fetchYouTubeSecondarySubtitles, fetchBilibiliSecondarySubtitles } from './subtitle/index.js';

const PRIME_WAIT_MS = 5000;      // 单行等待第二轨就绪上限：超时该行先走实时翻译
const PRIME_TIMEOUT_MS = 20000;  // 第二轨发现+下载总闸：超时判 failed（负缓存）
const COVERAGE_SAMPLE = 300;     // 就绪自检抽样上限（覆盖率日志用，防长视频全量扫）

// === 语言对（与 lib/bilingual-trans.js 同款监听口径） ===
let _learn = 'en';               // 学习语言（第二轨选轨参照 + 同文判定）
let _meaning = 'zh';             // 释义语言（第二轨目标语言）
const _langReady = new Promise((resolve) => {
  try {
    chrome.storage.local.get({ learnLanguage: 'en', meaningLanguage: 'zh' }, (r) => {
      _learn = r.learnLanguage || 'en';
      _meaning = r.meaningLanguage || 'zh';
      resolve();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.learnLanguage) _learn = ch.learnLanguage.newValue || 'en';
      if (ch.meaningLanguage) _meaning = ch.meaningLanguage.newValue || 'zh';
      // 语言对编入 prime key：变化后下一次取行自动按新语言对重新 prime，
      //   无需在此显式清状态（旧 key 状态自然被替换丢弃）。
    });
  } catch (e) {
    resolve();   // 非扩展上下文容错（模块被复用时）——退化为纯实时翻译
  }
});

// === 当前视频的第二轨状态机（单槽：key 不同即整体替换） ===
// {key, status: 'idle'|'loading'|'ready'|'failed', prepared, promise, wait}
let _state = null;

/** 平台标记：yt=YouTube / bili=B站 / gen=通用站（无站上字幕 API，直接实时翻译） */
function platformTag() {
  try {
    const h = location.hostname || '';
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(h)) return 'yt';
    if (/(^|\.)bilibili\.com$/.test(h)) return 'bili';
    return 'gen';
  } catch (e) {
    return 'gen';
  }
}

/** 视频稳定标识：path+query（去掉 t 时间戳与 si 分享参数——同视频不同链接不换 key） */
function videoKey() {
  try {
    const u = new URL(location.href);
    u.searchParams.delete('t');
    u.searchParams.delete('si');
    u.hash = '';
    return u.pathname + u.search;
  } catch (e) {
    return String(location.pathname || '') + String(location.search || '');
  }
}

function buildKey() {
  return platformTag() + '|' + videoKey() + '|' + _learn + '|' + _meaning;
}

/** 平台分发取第二轨（站上现成文件）；generic 无站上字幕 API → null */
async function fetchSecondaryCues() {
  const tag = platformTag();
  if (tag === 'yt') return await fetchYouTubeSecondarySubtitles({ learn: _learn, meaning: _meaning });
  if (tag === 'bili') return await fetchBilibiliSecondarySubtitles({ learn: _learn, meaning: _meaning });
  return null;
}

/** 带总闸的超时包装（底层请求超时后仍可能继续跑，其结果自然丢弃） */
function withTimeout(p, ms, what) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' 超时 ' + ms + 'ms')), ms))
  ]);
}

/**
 * prime：下载第二轨 → 估全局偏移 → 建配对索引。结果写入 st（ready/failed）。
 * @param {{status:string, prepared:object|null}} st 状态槽
 * @param {Array<{start,end,text}>} mainCues 当前主字幕列表（估偏移用）
 */
async function prime(st, mainCues) {
  st.status = 'loading';
  try {
    const cues = await withTimeout(fetchSecondaryCues(), PRIME_TIMEOUT_MS, '第二轨取数');
    const list = Array.isArray(cues) ? cues : [];
    if (list.length === 0) {
      st.status = 'failed';
      return;
    }
    const offset = estimateOffset(mainCues, list);          // D2 ①：全局偏移预校
    const prepared = prepareSecondary(list, offset);          // D2 ②：配对索引
    if (!prepared) {
      st.status = 'failed';
      return;
    }
    st.prepared = prepared;
    st.status = 'ready';
    // 就绪自检日志：抽样算覆盖率，便于贴日志判断第二轨是否配得上主显轨
    try {
      const main = Array.isArray(mainCues) ? mainCues : [];
      const n = Math.min(main.length, COVERAGE_SAMPLE);
      let hit = 0;
      for (let i = 0; i < n; i++) if (pairSecondaryText(main[i], prepared)) hit++;
      console.log('[VocabRadar][bilingual-track] 第二轨就绪: ' + list.length
        + ' 条, 偏移 ' + (Math.round(offset * 100) / 100) + 's, 抽样配对 ' + hit + '/' + n);
    } catch (e) { /* 自检日志失败不影响功能 */ }
  } catch (e) {
    st.status = 'failed';
    console.warn('[VocabRadar][bilingual-track] 第二轨 prime 失败，本视频全程实时翻译兜底:', e && e.message);
  }
}

/**
 * 双语副行取数统一入口（D1：站上第二语言字幕优先，实时翻译兜底）。
 * @param {{start:number,end:number,text:string}} cue 当前主字幕条目
 * @param {Array<{start,end,text}>} [mainCues] 当前完整主字幕列表（估全局偏移用；
 *   首个触发 prime 的调用方传入，后续调用方传参不参与已就绪状态）
 * @returns {Promise<string|null>} 副行文本；null=无（调用方不渲染译文行）
 */
export async function fetchBilingualLine(cue, mainCues) {
  const text = String((cue && cue.text) || '');
  if (!text.trim()) return null;
  try {
    await _langReady;
    const key = buildKey();
    let st = _state;
    if (!st || st.key !== key) {
      st = _state = { key, status: 'idle', prepared: null, promise: null, wait: null };
    }
    if (st.status === 'idle') {
      st.promise = prime(st, Array.isArray(mainCues) ? mainCues : []);
      // 单行等待闸（每 prime 只建一次）：PRIME_WAIT_MS 内等就绪，超时放行去实时翻译
      st.wait = new Promise((resolve) => {
        const t = setTimeout(() => resolve('timeout'), PRIME_WAIT_MS);
        const done = () => { clearTimeout(t); resolve('ready'); };
        st.promise.then(done, done);
      });
    }
    if (st.status === 'loading') await st.wait;

    if (st.status === 'ready' && st.prepared) {
      const hit = pairSecondaryText(cue, st.prepared);
      // 同文视为未命中（退化场景：站上第二轨恰=当前主显轨，如 B站仅中文轨时）——
      //   不重复显示原文，交给兜底口径处理（兜底同文时其内部判 null 不出行）。
      if (hit && hit.toLowerCase() !== text.trim().toLowerCase()) return hit;
    }
  } catch (e) {
    console.warn('[VocabRadar][bilingual-track] 第二行取数异常，转实时翻译:', e && e.message);
  }
  return fetchBilingualTrans(text);
}
