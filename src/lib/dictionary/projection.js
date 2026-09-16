// ============================================================
// 文件职责：词典内存投影构建与源重建（src/lib/dictionary/projection.js）
// 来源：拆分自 src/lib/dictionary.js（ES Modules 模块化拆分）
// 拆分日期：2026-08-28
// _loadDict（懒加载主流程：getLangProjection 读词典投影 -> 已构建则合并为内存
//   统一词条表 dictState.dictMap；缺 __built__ 标记或投影不完整则 _rebuildFromSources）
// 与 _rebuildFromSources（装载函数唯一入口：
//   loadWordfreq/loadWordlists 源装载 -> 内存合并 -> bulkWriteDictionary 分块 upsert
//   送入词典 + __built__/expected/dataVersion 原子标记 + 写后校验）。
// 2026-09-08（用户裁定"远程下载动态获取数字"）：包内 wordfreq/meta.json 退役，
//   getManifest 及 manifest.version 版本比对机制一并删除——词数基准用 meta.expected
//   （上次构建同事务写入的实际值），远程拉取的词数以解码后 Map.size 为准（动态实际值）。
// 共享状态经 state.js 的 dictState 可变对象读写。
// ============================================================

import { dictState, DEFAULT_SOURCE_LANG, _ts } from './state.js';
import { getLangProjection, getRanksProjection, bulkWriteDictionary, bulkWriteTranslations, clearByLang } from '../word-db.js';
import { loadWordfreq, loadWordlists, loadBuiltinEnZh } from './word-loader.js';

/**
 * 加载词典（懒加载，按 learnLanguage 选择 wordfreq 文件）
 * 反思（2026-08-20 第八十五次）：词频/词表不是独立缓存，而是词典字段。
 *   页面每次加载优先从词典（words store）投影构建 Map（getLangProjection）；
 *   仅当词典缺失/不全（built=false，如首次安装或切换语言后该语言词典尚未构建）时，
 *   才启用装载函数（loadWordfreq/loadWordlists）读取源文件并送入词典。
 * 反思（2026-08-21 第八十八次）：词典只有一个--rank/tags 合入同一 Map<word, {rank,tags}>，
 *   不再有 wordfreq/wordlists 两张表；装载函数也只是把同一词典的字段合起来。
 * @param {string} [lang] 强制指定语言（默认读 storage.currentLearnLang）
 * @returns {Promise<Map<string,{rank:number|null,tags:string[]}>>} 统一词典
 */
export async function _loadDict(lang) {
  const meaningLang = lang || dictState.currentLearnLang || DEFAULT_SOURCE_LANG;

  // ---- 同步段守卫与注册（第二百四十五次，用户拍板"实施修复"）----
  //   旧结构把"已加载返回/在途复用/ranksPromise 注册"全放在首个 await（L42 wfUpdates
  //   检查）之后：首个调用者 ensureRanksReady（query.js L87 兜底）同步启动 _loadDict 后
  //   即让出，等 wfUpdates 检查回来才走到装载体内部 L83 建 ranksPromise——首调者永远
  //   只能拿到整装载 Promise（244 兜底），"词频先行（Stage 1）"分阶段收益整个丢失
  //   （实测时序表：词频先行就绪与词典就绪仅差 0.9ms，Stage 2 整投影 116ms 被吞进等待）。
  //   修法：把三步全部提到同步段（async 函数体首个 await 之前同步执行）——
  //   ① 已加载快速返回；② 在途复用；③ 先注册 Stage 1 ranksPromise（_lang 立即标记），
  //   首调者即刻持有分阶段承诺，Stage 1 建完 rank-only Map 即 settle 重扫出高亮，
  //   tags/lemma 由 Stage 2 原位合并随后补齐（2026-09-04 设计意图恢复）。
  // 已加载相同语言：直接返回（不打日志--用户反馈"每次都要加载 wordfreq/wordlists"，
  //   实际是单例缓存命中，只是多处调用触发了日志）。
  if (dictState.loadedLang === meaningLang && dictState.dictMap) {
    return dictState.dictMap;
  }
  // 已有加载中 Promise：复用
  if (dictState.loadPromise && dictState.loadPromise._lang === meaningLang) {
    return dictState.loadPromise;
  }
  // Stage 1 ranksPromise 同步注册（一次性 settler：resolve 即自毁，防旧轮误碰新轮）
  if (!dictState.ranksPromise || dictState.ranksPromise._lang !== meaningLang) {
    let _resolveRanksEarly = null;
    dictState.ranksPromise = new Promise((r) => { _resolveRanksEarly = r; });
    dictState.ranksPromise._lang = meaningLang;
    dictState._settleRanks = (v) => {
      try { if (_resolveRanksEarly) _resolveRanksEarly(v); } catch (_) {}
      _resolveRanksEarly = null;
      dictState._settleRanks = null;
    };
  }

  // 第二百四十六次：每轮装载重置"空投影已重建过"标记（SLOW PATH 自愈守卫用），
  //   防语言切换后旧语言的标记误放行新语言的空投影（真 0 词库时逐页死循环的保险丝）。
  dictState._emptyProjRebuilt = false;

  // 第二百四十七次（用户 13:33 github.com 日志：一次装载却两次拉取词频文件）：
  //   旧版把 loadPromise 的创建放在 wfUpdates 检查（首个 await）之后——两个同步调用方
  //   （ensureRanksReady + ensureReady，文本提示/侧栏各自触发）都能在 loadPromise 尚未
  //   赋值时穿过上方在途复用守卫，各自新建一个 IIFE 并发装载 → _rebuildFromSources
  //   跑两遍 → 两次 WF_FETCH 网络拉取（判据：同上下文两次"词典缺少 en 数据"）。
  //   修法：装载 Promise 在同步段（首个 await 之前）即赋值，之后所有调用方一律命中
  //   上方在途复用；wfUpdates 检查下移进 IIFE 内部，行为语义不变。
  dictState.loadPromise = (async () => {
    const startTime = Date.now();

    // 2026-09-08（用户批复"主动轮询 files.json 检测更新并自动重建"）：SW 每 24h 比对
    //   storage.wfInstalled[lang].sha256 与 HF files.json（checkWfUpdates），差异写
    //   storage.wfUpdates[lang]。此处入口检查（60s 内存节流）：有更新 → clearByLang
    //   清该语言词典数据 + 失效单例 → 走下方正常重建路径自然重拉。
    try {
      const now = Date.now();
      if (!dictState._wfUpdateCheckedAt || now - dictState._wfUpdateCheckedAt > 60000) {
        dictState._wfUpdateCheckedAt = now;
        const { wfUpdates } = await chrome.storage.local.get('wfUpdates');
        if (wfUpdates && wfUpdates[meaningLang]) {
          console.log(`[VocabRadar][dictionary][${_ts()}] 检测到 ${meaningLang} 词频源更新（HF files.json sha256 变化），清库重建`);
          const removed = await clearByLang(meaningLang);
          console.log(`[VocabRadar][dictionary][${_ts()}] 词典 ${meaningLang} 已清除 ${removed} 条，开始重建`);
          dictState.loadedLang = null;
          dictState.dictMap = null;
          // 第二百四十七次：不置 loadPromise=null——本 IIFE 即在途装载，保持上方在途复用
          //   （其他调用方复用本 Promise，不再开新并发装载；重拉由本 IIFE 正常重建完成）。
        }
      }
    } catch (e) {
      console.warn(`[VocabRadar][dictionary][${_ts()}] wfUpdates 检查失败（不影响正常加载）:`, e);
    }

    console.log(`[VocabRadar][dictionary][${_ts()}] 开始加载词典, lang=${meaningLang}`);

    // 反思（2026-08-20 第八十五次）：从词典读词频/词表（rank/tags 字段）--
    //   只有词典会缓存，词频等不是独立缓存；词典已构建（__built__ 标记）即直接读词典。
    let proj = null;
    // 第一百八十八次：分段计时 —— 上轮实测词典就绪仍剩 5.5s（DCL 后），
    //   需定位耗时落在：投影读取(IDB) / Map 构建 / manifest 对账 / 源重建哪一段。
    //   查看：控制台 window.__beaverDictTiming（实时引用）。
    const _seg = { proj: 0, ranks: 0, map: 0, manifest: 0, rebuild: 0, total: 0 };
    if (typeof window !== 'undefined') window.__beaverDictTiming = _seg;
    // 分阶段投影 ranks 承诺管线（2026-09-04）：_settleRanks 暂存 resolve，Stage 1 建完
    //   rank-only Map 即 resolve（扫描侧先重扫出高亮）；loadPromise 异常时兜底 resolve null
    //   （承诺永不悬空）。resolve 一次即自毁，后续重复调用无操作。
    //   （第二百四十五次）ranksPromise 的创建与 settler 定义已上移至 _loadDict 同步段
    //   （函数开头）——此处不再重复创建，直接沿用同步段注册的本轮 Stage 1 承诺。
    let _t0 = performance.now();
    // 分阶段 Stage 1（2026-09-04）：ranks 投影快通道。2026-09-08：manifest 退役，
    //   并行管线只剩 ranks 一路。_seg.proj 此后记录整投影耗时（Stage 2），ranks 耗时记 _seg.ranks。
    let ranksProj = null;
    ranksProj = await getRanksProjection(meaningLang).catch(() => null);
    _seg.ranks = Math.round(performance.now() - _t0);
    // ---- FAST PATH：ranks 先行（分阶段 Stage 1，2026-09-04）----
    // 判据与慢路径同源（built/version/expected），只是数据源换成 ranksProj 的 meta。
    // 命中即建 rank-only dictMap 并 resolve ranksPromise——扫描侧先重扫，高亮只认 rank；
    // 随后 Stage 2 取整投影原位合并 tags/lemma（Map 引用稳定），再 resolve 完整 loadPromise。
    // 第二百四十六次修复（用户实测"非常慢+0命中+词表0"）：ranksCount=0 的 built=true 坏投影
    //   （240 修复前 NaN 时期写入：expected=NaN→0、ranks 表空）不得走快道——旧版会建
    //   空 rank-only Map 并 settle（词频先行假就绪）→ lookup(the)=null → 0 命中死锁。
    //   ranksCount>0 才快道；空投影落 SLOW PATH，由收紧后的判据强制重建自愈。
    if (ranksProj && ranksProj.built && (Number(ranksProj.ranksCount) || 0) > 0) {
      // 2026-09-08：词数基准仅 meta.expected（上次构建同事务写入的实际值）；
      //   manifest.wordCounts 兜底与 manifest.version 版本比对（清库重建）随包内
      //   meta.json 一并退役——远程数据以解码后 Map.size 动态对账（_rebuildFromSources）。
      const expectedFast = Number(ranksProj.expected) || 0;
      const cntFast = Number(ranksProj.ranksCount) || 0;
      if (expectedFast && cntFast < expectedFast) {
        console.warn(`[VocabRadar][dictionary][${_ts()}] 投影不完整: 库内 ${cntFast} / 基准 ${expectedFast} -> 增量补齐(upsert，不清库)`);
        _t0 = performance.now();
        await _rebuildFromSources(meaningLang);
        _seg.rebuild = Math.round(performance.now() - _t0);
        return dictState.dictMap;
      }
      // ranks 命中且完整：建 rank-only Map，resolve ranks，先出高亮
      _t0 = performance.now();
      dictState.dictMap = new Map();
      const _pr = ranksProj.ranks || {};
      for (const word in _pr) {
        dictState.dictMap.set(word, { rank: _pr[word], tags: [], lemma: null, translation: undefined, translationLang: undefined, phonetic: undefined });
      }
      dictState.ranksReadyLang = meaningLang;
      _seg.map = Math.round(performance.now() - _t0);
      console.log(`[VocabRadar][dictionary][${_ts()}] 词频先行就绪(Ranks Stage 1): ${dictState.dictMap.size} 词 (${((Date.now() - startTime) / 1000).toFixed(2)}s)，tags/lemma 随后合并`);
      try { if (dictState._settleRanks) dictState._settleRanks(dictState.dictMap); } catch (_) {}
      // ---- Stage 2：整投影合并 tags/lemma（原位合并，Map 引用稳定）----
      _t0 = performance.now();
      let _full = null;
      try { _full = await getLangProjection(meaningLang); } catch (e) { _full = null; }
      _seg.proj = Math.round(performance.now() - _t0);
      if (_full && _full.built) {
        const _pt = _full.tags || {};
        const _pl = _full.lemmas || {};
        for (const word in _pt) {
          const e = dictState.dictMap.get(word);
          if (e) e.tags = _pt[word] || [];
          else dictState.dictMap.set(word, { rank: null, tags: _pt[word] || [], lemma: _pl[word] || null, translation: undefined, translationLang: undefined, phonetic: undefined });
        }
        for (const word in _pl) {
          const e = dictState.dictMap.get(word);
          if (e) { if (typeof e.lemma !== 'string') e.lemma = _pl[word]; }
          else dictState.dictMap.set(word, { rank: null, tags: [], lemma: _pl[word], translation: undefined, translationLang: undefined, phonetic: undefined });
        }
        console.log(`[VocabRadar][dictionary][${_ts()}] 整投影合并完成(Stage 2): tags/lemma 就位，共 ${dictState.dictMap.size} 词`);
      } else {
        console.warn(`[VocabRadar][dictionary][${_ts()}] 整投影缺失，仅 ranks 可用（tags/lemma 为空，高亮不受影响）`);
      }
      dictState.loadedLang = meaningLang;
      _seg.total = Math.round(Date.now() - startTime);
      console.log(`[VocabRadar][dictionary][${_ts()}] 词典完全就绪: ${dictState.dictMap.size} 词 (ranks ${_seg.ranks}ms / 整投影 ${_seg.proj}ms / 合计 ${_seg.total}ms)`);
      return dictState.dictMap;
    }
    // ---- SLOW PATH：ranks 缺失/未 built——沿用旧整投影路径（首屏等多一轮，无分阶段收益）----
    _t0 = performance.now();
    try {
      proj = await getLangProjection(meaningLang);
    } catch (e) {
      proj = null;
    }
    _seg.proj = Math.round(performance.now() - _t0);
    if (proj && proj.built) {
      // 投影对象是同一词典的字段（rank/tags/lemma），合并为一张全属性词条表。
      // 第一百八十七次·性能修复（用户实测：词典就绪 17093ms＝DCL 后 14.9s）：
      //   旧实现三轮 Object.keys(...) 各分配一个约 5 万元素的字符串数组，且第二、三轮
      //   还要各做一次 Map.get + 可能的对象改写。改为 for...in 直接枚举（无中间数组），
      //   并在第一轮就把 tags/lemma 一并填入（tags/lemmas 基本是 ranks 的子集），
      //   后两轮只补 ranks 里没有的孤词。合并结果与语义完全不变。
      const projRanks = proj.ranks || {};
      const projTags = proj.tags || {};
      const projLemmas = proj.lemmas || {};
      _t0 = performance.now();   // 第一百八十八次：Map 构建段计时
      dictState.dictMap = new Map();
      for (const word in projRanks) {
        dictState.dictMap.set(word, { rank: projRanks[word], tags: projTags[word] || [], lemma: projLemmas[word] || null, translation: undefined, translationLang: undefined, phonetic: undefined });
      }
      for (const word in projTags) {
        if (dictState.dictMap.has(word)) continue;
        dictState.dictMap.set(word, { rank: null, tags: projTags[word] || [], lemma: projLemmas[word] || null, translation: undefined, translationLang: undefined, phonetic: undefined });
      }
      for (const word in projLemmas) {
        if (dictState.dictMap.has(word)) continue;
        dictState.dictMap.set(word, { rank: null, tags: [], lemma: projLemmas[word], translation: undefined, translationLang: undefined, phonetic: undefined });
      }
      dictState.loadedLang = meaningLang;
      _seg.map = Math.round(performance.now() - _t0);   // 第一百八十八次
      const cost = ((Date.now() - startTime) / 1000).toFixed(2);
      // 第一百四十一次（用户裁定）：完整性用**实际值**校验，基准 = meta.expected
      //   （上次成功构建同事务写入的真实数）。库内实数 ranksCount 比对：
      //   不足 ⇒ 增量补齐（upsert 不清库）；足够 ⇒ 直接用。读操作全程不受影响。
      // 2026-09-08：manifest 对账（wordCounts 兜底 + version 版本比对清库重建）随包内
      //   meta.json 退役——远程数据的词数以解码后 Map.size 动态对账（_rebuildFromSources）。
      const expected = proj.expected || 0;
      // 第一百九十次修复：total 原用 performance.now() 减 Date.now() 的 startTime（epoch 值），
      //   得出 -1.78e12 的负数（用户实测"合计 -1788164723852ms"）。统一用 Date.now 口径。
      _seg.total = Math.round(Date.now() - startTime);   // 第一百八十八次：总耗时
      console.log(`[VocabRadar][dictionary][${_ts()}] 词典装载分段耗时: 投影读取 ${_seg.proj}ms / Map构建 ${_seg.map}ms / 合计 ${_seg.total}ms`);
      const cnt = proj.ranksCount || 0;
      // 第二百四十六次修复：旧判据 `!expected || cnt >= expected` 中 `!expected` 把
      //   built=true 但 expected=0 的老格式坏投影当"完整"放行 → 空 Map 返回 →
      //   lookup(the)=null → 0 命中，且永不触发自愈重建（空词典死锁）。
      //   收紧：expected>0 且 cnt>=expected 才放行；expected=0 或残缺一律增量补齐
      //   （_rebuildFromSources 末块同事务重写 __built__+expected 实际值，下次装载即正常）。
      if (expected > 0 && cnt >= expected) {
        if (Number(cost) >= 0.25) {
          console.log(`[VocabRadar][dictionary][${_ts()}] 词典已就绪(投影): ${dictState.dictMap.size} 词 (${cost}s)`);
        }
        return dictState.dictMap;
      }
      // 空 Map 且本会话已重建过仍空（真 0 词库/坏源）：放行防逐页死循环（标记见下方补齐后）。
      if (cnt === 0 && dictState._emptyProjRebuilt) {
        return dictState.dictMap;
      }
      console.warn(`[VocabRadar][dictionary][${_ts()}] 投影不完整/空投影: 库内 ${cnt} / 基准 ${expected} -> 增量补齐(upsert，不清库)`);
      _t0 = performance.now();   // 第一百八十八次：增量补齐段计时
      await _rebuildFromSources(meaningLang);
      _seg.rebuild = Math.round(performance.now() - _t0);
      // 第二百四十六次：补齐后 Map 仍空 → 置标记，本会话后续装载放行（真 0 词库保险丝）。
      if (!dictState.dictMap || dictState.dictMap.size === 0) {
        dictState._emptyProjRebuilt = true;
      }
      return dictState.dictMap;
    }

    // 词典缺 __built__ 标记 -> 首次构建
    _t0 = performance.now();   // 第一百八十八次：首次构建段计时
    await _rebuildFromSources(meaningLang);
    _seg.rebuild = Math.round(performance.now() - _t0);
    return dictState.dictMap;
  })();
  dictState.loadPromise._lang = meaningLang;
  // 分阶段兜底（2026-09-04）：loadPromise 落定（成功/异常）时，若本轮 ranks 承诺还没人
  //   resolve，就地补一次（成功带完整 Map，异常带 null，扫描侧按无词典继续）。
  //   闭包捕获本轮 settler——语言切换开新一轮 _loadDict 时，旧轮的落定不得碰新轮的承诺。
  const _settleMine = dictState._settleRanks;
  dictState.loadPromise.then(
    (m) => { try { if (_settleMine) _settleMine(m); } catch (_) {} },
    () => { try { if (_settleMine) _settleMine(null); } catch (_) {} }
  );

  return dictState.loadPromise;
}

/**
 * 第一百四十次：从源文件重建/增量补齐词典（装载函数唯一入口）。
 * 流程：解压解码源文件 -> 内存合并为统一词条表（供本页同步查询）-> 分块 upsert 送入
 * 词典库（**不清库**：已有 translation/phonetic/lemma 字段保留，缺失条目被补上）->
 * 末块同事务写入 __built__ + expected 实际值。
 * @param {string} lang
 */
async function _rebuildFromSources(lang) {
  const startTime = Date.now();
  const [wf, wl] = await Promise.all([
    loadWordfreq(lang),
    loadWordlists()
  ]);
  // 2026-09-08：与 preprocess manifest 的词数对账随包内 meta.json 退役——
  //   wf.size 就是远程数据解码后的动态实际词数，直接作为 expected 基准写库。
  // 两个源文件是同一词典的字段：wordfreq 给 rank、wordlists 给 tags，合为一张全属性词条表
  dictState.dictMap = new Map();
  for (const [word, rank] of wf) {
    dictState.dictMap.set(word, { rank, tags: [], lemma: null, translation: undefined, translationLang: undefined, phonetic: undefined });
  }
  for (const [word, tags] of wl) {
    const e = dictState.dictMap.get(word);
    if (e) e.tags = tags;
    else dictState.dictMap.set(word, { rank: null, tags, lemma: null, translation: undefined, translationLang: undefined, phonetic: undefined });
  }

  dictState.loadedLang = lang;
  const cost = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`[VocabRadar][dictionary][${_ts()}] 源装载完成并送入词典: lang=${lang} ${dictState.dictMap.size} 词 (rank 基准 ${wf.size}) (${cost}s)`);

  // 装载完成送入词典--分块 upsert + 末块原子标记（含 expected 实际值 + dataVersion 数据版本）。
    try {
      // 2026-09-08：包内 meta.json 退役后无远程版本号可比对，dataVersion 固定 0
      //   （= 未记录预处理版本，加载侧版本比对自动跳过）；数据完整性由 expected
      //   实际值（wf.size 动态词数）对账兜底。
      const dataVersion = 0;
      const ok = await bulkWriteDictionary(lang, dictState.dictMap, wf.size, dataVersion);
      if (ok === false) {
        console.warn(`[VocabRadar][dictionary][${_ts()}] 送入词典部分失败（未打构建标记，下次加载将重装）`);
      } else {
        console.log(`[VocabRadar][dictionary][${_ts()}] 词典已存入词典库（upsert 不清库 + __built__/expected=${wf.size}/dataVersion=v${dataVersion} 同事务原子）`);
        // 反思（2026-09-04）：内置英中翻译包回填——仅 learnLanguage=en。
        //   不进内存 dictMap（40k 条释义常驻内存浪费，translation 本就设计为懒读字段），
        //   直接 bulkWriteTranslations 写 d_trans 分表。失败只告警（不阻塞构建，下次
        //   版本重建覆盖；translator 首层未命中则照常走在线）。
        if (lang === 'en') {
          try {
            const zhMap = await loadBuiltinEnZh();
            if (zhMap.size > 0) {
              const zhOk = await bulkWriteTranslations(lang, zhMap, 'zh');
              console.log(`[VocabRadar][dictionary][${_ts()}] 内置英中翻译包回填${zhOk ? '完成' : '部分失败'}: ${zhMap.size} 词`);
            }
          } catch (e) {
            console.warn(`[VocabRadar][dictionary][${_ts()}] 内置英中翻译包回填异常（释义走在线）:`, e && e.message);
          }
        }
        // 第一百五十三次：写后校验--直读投影确认持久化真实生效（cnt 应≈wf.size）
        try {
          const proj2 = await getLangProjection(lang);
          const cnt2 = proj2 ? (proj2.ranksCount || 0) : -1;
          console.log(`[VocabRadar][dictionary][${_ts()}] 写后校验: 库内 ${cnt2} / 期望 ${wf.size}${cnt2 >= wf.size ? ' ✅' : ' ❌ 未持久化!'}`);
        } catch (e) { /* ignore */ }
      }
  } catch (e) {
    console.warn(`[VocabRadar][dictionary][${_ts()}] 送入词典失败（忽略，本次内存词典仍可用）:`, e && e.message);
  }
  return dictState.dictMap;
}
