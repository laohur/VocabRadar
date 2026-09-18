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
import { getLangProjection, getRanksProjection, bulkWriteDictionary, bulkWriteTranslations, clearByLang, countTranslationEntries } from '../word-db.js';
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
        // 第三百四十六次（用户裁定方案 A"有啥就出啥" + ◑◒◐◓ 轮播）：不再 await 重建
        //   阻塞就绪（用户实测干等数分钟）——先建 rank-only 部分 Map 放行（ranks Promise
        //   即刻 settle，扫描侧先亮已有词），增量补齐后台跑；完成后页侧轮询
        //   rebuildPending 自动刷新就绪行分项数字，高亮全量需重扫。
        console.warn(`[VocabRadar][dictionary][${_ts()}] 投影不完整: 库内 ${cntFast} / 基准 ${expectedFast} -> 后台增量补齐（346 渐进就绪：先放行 ${cntFast} 词，完成后自动刷新）`);
        dictState.dictMap = new Map();
        dictState.maxRank = 0;
        const _pr = ranksProj.ranks || {};
        for (const word in _pr) {
          const _r = _pr[word];
          if (typeof _r === 'number' && _r > dictState.maxRank) dictState.maxRank = _r;
          dictState.dictMap.set(word, { rank: _r, tags: [], lemma: null, translation: undefined, translationLang: undefined, phonetic: undefined });
        }
        dictState.ranksReadyLang = meaningLang;
        try { if (dictState._settleRanks) dictState._settleRanks(dictState.dictMap); } catch (_) {}
        _kickRebuildBackground(meaningLang, `FAST 路投影不完整（库内 ${cntFast}/${expectedFast}）`);
        dictState.loadedLang = meaningLang;
        return dictState.dictMap;
      }
      // ranks 命中且完整：建 rank-only Map，resolve ranks，先出高亮
      _t0 = performance.now();
      dictState.dictMap = new Map();
      dictState.maxRank = 0;
      const _pr = ranksProj.ranks || {};
      for (const word in _pr) {
        const _r = _pr[word];
        if (typeof _r === 'number' && _r > dictState.maxRank) dictState.maxRank = _r;
        dictState.dictMap.set(word, { rank: _r, tags: [], lemma: null, translation: undefined, translationLang: undefined, phonetic: undefined });
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
        // 第三百四十一次：合并值数组校验——`|| []` 只防 null/undefined，防不了非数组
        //   垃圾值（tags 字段系统契约恒为数组，统计侧 getDictFieldStats 即按 Array.isArray 计）。
        for (const word in _pt) {
          const _tv = Array.isArray(_pt[word]) && _pt[word].length > 0 ? _pt[word] : [];
          const e = dictState.dictMap.get(word);
          if (e) e.tags = _tv;
          else dictState.dictMap.set(word, { rank: null, tags: _tv, lemma: _pl[word] || null, translation: undefined, translationLang: undefined, phonetic: undefined });
        }
        for (const word in _pl) {
          const e = dictState.dictMap.get(word);
          if (e) { if (typeof e.lemma !== 'string') e.lemma = _pl[word]; }
          else dictState.dictMap.set(word, { rank: null, tags: [], lemma: _pl[word], translation: undefined, translationLang: undefined, phonetic: undefined });
        }
        console.log(`[VocabRadar][dictionary][${_ts()}] 整投影合并完成(Stage 2): tags/lemma 就位，共 ${dictState.dictMap.size} 词`);
      } else if (_full === null) {
        // 第三百四十三次：else 原先混打两种形态，掩盖真相——
        //   null = 读取失败（消息通道/扫库异常/ok:false，异常详情已在 word-db 层四条
        //   失败路径 + db-ops 分表 error 显性打出，此处只提示形态不遮蔽）；
        //   built=false = 读到了投影但 meta 缺 built 标记（另一类问题，需重建）。
        console.warn(`[VocabRadar][dictionary][${_ts()}] 整投影读取失败(null)，仅 ranks 可用（异常详情见上方 word-db error 日志；tags/lemma 为空，高亮不受影响）`);
      } else {
        // 第三百四十六次（用户裁定方案 A）：built=false 不再 await 阻塞——Stage 1 的
        //   rank-only Map 已建/settle，即刻放行（词频部分数据先亮），源重建后台跑
        //   （upsert 不清库 + 末块同事务打 __built__），完成后页侧轮询 rebuildPending
        //   自动刷新就绪行；tags/lemma 高亮全量需重扫。
        console.warn(`[VocabRadar][dictionary][${_ts()}] 整投影 built=false（库无构建标记/数据残缺）→ 后台源重建补全（346 渐进就绪：先放行词频 ${dictState.dictMap.size} 词，完成后自动刷新）`);
        _kickRebuildBackground(meaningLang, 'Stage2 整投影 built=false（库残缺）');
        dictState.loadedLang = meaningLang;
        return dictState.dictMap;
      }
      // 第三百四十次（用户实测就绪行 "tags 0 · translations 687"）：快道坏库自愈——缺就补。
      //   坏库成因：329-336 次期间构建——wordfreq 拉取成功打上 __built__（d_rank 完好），
      //   但当时 loadWordlists/loadBuiltinEnZh 读 .json 解析失败（337 次已修读点）→
      //   d_trans 无内置翻译包；此后 built+ranks 完整恒走快道永不重建，且
      //   2026-09-08 起 dataVersion 固定写 0、版本比对自动跳过——坏状态固化。
      //   第三百四十一次（用户实测 "tags 0" 在 340 次修复后依旧）：修正 340 次的错误
      //   诊断——d_tags 并非"空"而是"全是空数组条目"：_rebuildFromSources 构建词条
      //   tags 恒为 []（本文件 L360），bulkWriteDictionary 写库只查 !== undefined 即写，
      //   故 loadWordlists 失败的重建仍把 28,813 个词频词的空 tags 写满 d_tags；投影
      //   读出 Object.keys>0，340 次的 `keys===0` 判据恒假、自愈从未触发（translations
      //   走数量阈值不受影响故补装成功——用户实测 40,366 即证）。判据改为扫描：无任何
      //   非空数组条目即视为缺数据，空段/全空数组两种坏形态全覆盖。
      //   修法：Stage 2 检出无有效标签 → loadWordlists 重装 → 原位并入 dictMap →
      //   仅 tags 的精简 Map 送 bulkWriteDictionary 持久化（rank=undefined 跳过 rank 写、
      //   expected/dataVersion 传整投影原值防 meta 整条替换抹字段——末块 __built__ 重打
      //   不可避免，upsert 幂等，词表词覆盖旧空条目、词频独有词本就应空标签）。
      //   en 限定：词表源是英文考试词表专属（word-loader.js 读
      //   src/data/en/），小语种 tags 本就空，不得误补英文词表。
      let _validTags = false;
      const _ptScan = (_full && _full.tags) || {};
      for (const _w in _ptScan) {
        const _v = _ptScan[_w];
        if (Array.isArray(_v) && _v.length > 0) { _validTags = true; break; }
      }
      if (meaningLang === 'en' && !_validTags) {
        console.warn(`[VocabRadar][dictionary][${_ts()}] tags 投影无有效标签（历史坏库：全空数组条目或空段），词表缺就补装`);
        try {
          const wl = await loadWordlists();
          if (wl.size > 0) {
            const tagsOnly = new Map();
            for (const [word, tags] of wl) {
              const e = dictState.dictMap.get(word);
              if (e) e.tags = tags;
              else dictState.dictMap.set(word, { rank: null, tags, lemma: null, translation: undefined, translationLang: undefined, phonetic: undefined });
              tagsOnly.set(word, { tags });
            }
            try {
              await bulkWriteDictionary(meaningLang, tagsOnly, _full && _full.expected, _full && _full.dataVersion);
              console.log(`[VocabRadar][dictionary][${_ts()}] 词表补装完成并持久化: ${tagsOnly.size} 词`);
            } catch (e) {
              console.warn(`[VocabRadar][dictionary][${_ts()}] 词表补装持久化失败（本页内存可用，下次装载再补）:`, e && e.message);
            }
          } else {
            console.warn(`[VocabRadar][dictionary][${_ts()}] 词表补装失败：源装载为空（见上方 wordlists 告警），标签暂不可用`);
          }
        } catch (e) {
          console.warn(`[VocabRadar][dictionary][${_ts()}] 词表补装异常（高亮不受影响）:`, e && e.message);
        }
      }
      // 第三百四十次：内置英中翻译包补装（en 限定，不阻塞就绪——d_trans 是懒读字段）。
      //   同上坏库：内置翻译包从未写入 d_trans（用户实测 687 条全是运行时在线缓存）。
      //   补装条件 d_trans 计数 < 1000：内置包 4 万级、在线缓存一般数百；无法区分缓存与
      //   内置包来源，阈值 + 会话节流双保险。节流 _transBackfilled 挂 dictState（SW 冷
      //   启动重置，每会话最多补一次；重复补装幂等 upsert 无害）。完成后新查询自然命中，
      //   本就绪行统计若晚于补装则直接显示真实词数。
      if (meaningLang === 'en' && !dictState._transBackfilled) {
        dictState._transBackfilled = true;
        Promise.resolve().then(async () => {
          try {
            const cnt = await countTranslationEntries(meaningLang);
            if (cnt >= 1000) {
              console.log(`[VocabRadar][dictionary][${_ts()}] d_trans 已有 ${cnt} 条，跳过内置翻译包补装`);
              return;
            }
            const zhMap = await loadBuiltinEnZh();
            if (zhMap.size > 0) {
              const ok = await bulkWriteTranslations(meaningLang, zhMap, 'zh');
              console.log(`[VocabRadar][dictionary][${_ts()}] 内置英中翻译包补装${ok ? '完成' : '部分失败'}: ${zhMap.size} 词（补前 d_trans ${cnt} 条）`);
            } else {
              console.warn(`[VocabRadar][dictionary][${_ts()}] 内置翻译包补装失败：源装载为空（见上方告警），释义暂走在线`);
            }
          } catch (e) {
            console.warn(`[VocabRadar][dictionary][${_ts()}] 内置翻译包补装异常（释义走在线）:`, e && e.message);
          }
        });
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
      dictState.maxRank = 0;
      for (const word in projRanks) {
        const _r = projRanks[word];
        if (typeof _r === 'number' && _r > dictState.maxRank) dictState.maxRank = _r;
        dictState.dictMap.set(word, { rank: _r, tags: projTags[word] || [], lemma: projLemmas[word] || null, translation: undefined, translationLang: undefined, phonetic: undefined });
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
      // 第三百四十六次（用户裁定方案 A）：不完整/空投影不再 await——SLOW PATH 无 ranks
      //   快道，但手头 proj（built=true 而 cnt<expected）上方三轮合并已建好部分 dictMap，
      //   直接放行，增量补齐后台跑；真 0 词库保险丝改在放行时置位（语义保持：空 Map
      //   放行即视为"本会话重建过仍空"，重建完成后下次装载走正常完整性判据）。
      console.warn(`[VocabRadar][dictionary][${_ts()}] 投影不完整/空投影: 库内 ${cnt} / 基准 ${expected} -> 后台增量补齐（346 渐进就绪：先放行 ${dictState.dictMap.size} 词，完成后自动刷新）`);
      if (!dictState.dictMap || dictState.dictMap.size === 0) {
        dictState._emptyProjRebuilt = true;
      }
      _kickRebuildBackground(meaningLang, `SLOW 路投影不完整（库内 ${cnt}/${expected}）`);
      return dictState.dictMap;
    }

    // 词典缺 __built__ 标记 -> 首次构建
    // 第三百四十六次（用户裁定方案 A）：首建不再 await 阻塞就绪（用户实测干等数分钟，
    //   内置翻译 d_trans 本就独立懒读不该陪绑）——放行空 Map（页侧就绪行翻转 + ◑◒◐◓
    //   轮播提示"后台构建中"，翻译/已入库字段照常可用），源构建后台跑，完成后页侧
    //   轮询 rebuildPending 自动刷新分项数字。反思：构建期间网页高亮 0 命中属临时态
    //   （轮播明示构建中，不是假就绪、不遮蔽）。
    console.warn(`[VocabRadar][dictionary][${_ts()}] 词典缺 __built__ 标记 -> 后台首次构建（346 渐进就绪：先放行，完成后自动刷新；构建期间高亮 0 命中属预期）`);
    _kickRebuildBackground(meaningLang, '首建（无构建标记）');
    return dictState.dictMap || new Map();
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
  // 第三百四十七次（用户："好像还是一齐最后显示，而不是有啥字段显示啥"+"内置的翻译按道理
  //   应该非常快"）：内置英中翻译包回填并行先行——原位置在 bulkWriteDictionary 成功之后，
  //   被词频远程拉取（分钟级）+ 全量写库串行绑死；翻译源是包内本地 jsonl（秒级），提前
  //   fire-and-forget 并行跑，d_trans 秒级满仓（页侧 347 渐进渲染下一次 tick 即亮翻译数）。
  //   失败仅 warn 不影响重建主链（与原位置同语义）；upsert 幂等，与 340 自愈 b 补装并发
  //   双写无害。
  if (lang === 'en') {
    Promise.resolve().then(async () => {
      try {
        const zhMap = await loadBuiltinEnZh();
        if (zhMap.size > 0) {
          const zhOk = await bulkWriteTranslations(lang, zhMap, 'zh');
          console.log(`[VocabRadar][dictionary][${_ts()}] 内置英中翻译包先行回填${zhOk ? '完成' : '部分失败'}: ${zhMap.size} 词（347 与词频拉取并行，不等重建）`);
        }
      } catch (e) {
        console.warn(`[VocabRadar][dictionary][${_ts()}] 内置英中翻译包先行回填异常（释义走在线）:`, e && e.message);
      }
    });
  }
  const [wf, wl] = await Promise.all([
    loadWordfreq(lang),
    loadWordlists()
  ]);
  // 2026-09-08：与 preprocess manifest 的词数对账随包内 meta.json 退役——
  //   wf.size 就是远程数据解码后的动态实际词数，直接作为 expected 基准写库。
  // 两个源文件是同一词典的字段：wordfreq 给 rank、wordlists 给 tags，合为一张全属性词条表
  dictState.dictMap = new Map();
  dictState.maxRank = 0;
  for (const [word, rank] of wf) {
    if (typeof rank === 'number' && rank > dictState.maxRank) dictState.maxRank = rank;
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
        //   第三百四十七次：此块整体上移到函数开头 fire-and-forget 并行先行（原被词频
        //   远程拉取+全量写库串行绑死，全新库下翻译数字陪绑到最后才出，违背"有啥字段
        //   显示啥"）；失败语义不变（仅 warn，translator 未命中走在线兜底）。
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

/**
 * 第三百四十六次（用户裁定方案 A"有啥就出啥"+◑◒◐◓ 轮播）：后台重建调度器。
 * 装载路径检出库残缺/无构建标记时不再 await _rebuildFromSources 阻塞就绪（用户实测
 * 干等数分钟，内置翻译等独立字段陪绑），改为：
 *   1) 同步置 dictState.rebuildPending = lang（页侧 getDiagState 轮询依据）；
 *   2) _rebuildFromSources 后台执行（其内部自会重建 dictMap/设 loadedLang/写库打标）；
 *   3) 完成/失败 finally 清 rebuildPending——引导页轮询到清空即停轮播并重取分项数字。
 * 防重入：_rebuildRunning 同页互斥；跨页各自 context 各跑各的（与原 await 版一致，
 * upsert 幂等无害）。失败不遮蔽：console.warn + 分项数字如实显示当前值，下次装载再试。
 * @param {string} lang
 * @param {string} reason 触发原因（日志用）
 */
function _kickRebuildBackground(lang, reason) {
  if (dictState._rebuildRunning) {
    console.log(`[VocabRadar][dictionary][${_ts()}] 后台重建已在进行（跳过重复触发: ${reason}）`);
    return;
  }
  dictState._rebuildRunning = true;
  dictState.rebuildPending = lang;
  console.log(`[VocabRadar][dictionary][${_ts()}] 后台重建启动: ${reason}（就绪不阻塞，完成后自动刷新就绪行）`);
  Promise.resolve()
    .then(() => _rebuildFromSources(lang))
    .catch((e) => {
      console.warn(`[VocabRadar][dictionary][${_ts()}] 后台重建失败（本页手头数据仍可用，下次装载再试）:`, e && e.message);
    })
    .finally(() => {
      dictState._rebuildRunning = false;
      dictState.rebuildPending = null;
      console.log(`[VocabRadar][dictionary][${_ts()}] 后台重建结束，rebuildPending 已清空（页侧轮询将刷新就绪行）`);
    });
}
