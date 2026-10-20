// =============================================================================
// 卡片 My Words 标记按钮（第561次自 panel.js 拆出，src/content/th/card-mark.js）
// 职责：bindMarkButtons —— 🏁 标生词 / ✓ 标熟词的绑定与 active 态回填。
//   渲染面：右键面板、悬浮提示（buildCardInnerHTML 缺省含按钮）；侧栏内嵌查询卡
//   第561次二轮起不再渲染此二按钮（buildCardInnerHTML({markButtons:false})），
//   本函数对无按钮的 root 自行短路（querySelector 判空返回）。
// =============================================================================

/**
 * 查询卡 🏁/✓ 标记按钮绑定 + active 态回填。
 *
 * 语义：
 *   🏁 = 把这个词记为"生词"（New Words）；✓ = 记为"熟词"（Known Words）。
 *   数据写 chrome.storage.local 的 myWords={new:[],known:[]}（小写单词数组）：
 *     - 再点一次同一个按钮 → 取消标记（从对应表移除）；
 *     - 两表互斥：标生词时自动从熟词表移除，反之亦然（一词不能既生又熟）。
 *   写完后三件事自动发生：
 *     ① 引导页 My Words 两栏经 onChanged 实时回填（my-words.js）；
 *     ② 当前页标注经 text-hint.js onChanged → setMyWordsLists 全量重扫即时生效；
 *     ③ 按钮本地刷新 active 态（浅绿底=已在表中）。
 *
 * 调用方：renderQueryCard（query-card.js，右键面板 + 各侧栏内嵌卡）、
 *         tooltip.js showTooltip（hover 悬浮卡）。每次显示重绑，闭包捕获当次查询词。
 *
 * 直接用 chrome.storage.local 而非 storage 包装：content 侧无统一 storage 门面，
 *   原语即 chrome.storage.local（与 scan.js 同口径）。
 * stopPropagation：与 .speak/.show-page/.chat 同款纪律——shadow 内按钮
 *   放行冒泡本无害，但标记点击语义独立，阻断防宿主页委托误判。
 *
 * @param {Element|ShadowRoot} root 卡片根（内含 .mark-fresh/.mark-known；无按钮则短路）
 * @param {string} word 当次查询词（原文即可，内部统一小写化）
 */
export async function bindMarkButtons(root, word) {
  if (!root || !root.querySelector) return;
  const fresh = root.querySelector('.mark-fresh');
  const known = root.querySelector('.mark-known');
  if (!fresh || !known) return;
  const lower = String(word || '').trim().toLowerCase();
  if (!lower) return;
  const DEF = { myWords: { new: [], known: [] } };
  // active 态回填：该词在 new/known 表中则高亮对应按钮
  const refresh = (mw) => {
    const nw = (mw && Array.isArray(mw.new)) ? mw.new : [];
    const kw = (mw && Array.isArray(mw.known)) ? mw.known : [];
    fresh.classList.toggle('active', nw.indexOf(lower) !== -1);
    known.classList.toggle('active', kw.indexOf(lower) !== -1);
  };
  try {
    const res = await chrome.storage.local.get(DEF);
    refresh(res.myWords);
  } catch (_) { /* 存储不可用时按钮仍可点（写入时会再报） */ }
  // 通用 toggle：写入 myWords（互斥 + 再点取消），返回写入后的最新表
  const toggle = async (list) => {
    const mw = (await chrome.storage.local.get(DEF)).myWords || { new: [], known: [] };
    const nw = Array.isArray(mw.new) ? mw.new.slice() : [];
    const kw = Array.isArray(mw.known) ? mw.known.slice() : [];
    if (list === 'new') {
      const i = nw.indexOf(lower);
      if (i !== -1) nw.splice(i, 1);
      else { nw.push(lower); const k = kw.indexOf(lower); if (k !== -1) kw.splice(k, 1); }
    } else {
      const i = kw.indexOf(lower);
      if (i !== -1) kw.splice(i, 1);
      else { kw.push(lower); const n = nw.indexOf(lower); if (n !== -1) nw.splice(n, 1); }
    }
    const next = { myWords: { new: nw, known: kw } };
    await chrome.storage.local.set(next);
    return next.myWords;
  };
  fresh.onclick = async (e) => {
    e.stopPropagation();
    try {
      const mw = await toggle('new');
      refresh(mw);
      console.log(`[VocabRadar][text-hint] 🏁 生词标记 "${lower}": ${mw.new.indexOf(lower) !== -1 ? '已加入' : '已移出'} My Words（生词 ${mw.new.length}/熟词 ${mw.known.length}）`);
    } catch (err) { console.warn('[VocabRadar][text-hint] 🏁 生词标记写入失败:', err); }
  };
  known.onclick = async (e) => {
    e.stopPropagation();
    try {
      const mw = await toggle('known');
      refresh(mw);
      console.log(`[VocabRadar][text-hint] ✓ 标记熟词 "${lower}": ${mw.known.indexOf(lower) !== -1 ? '已加入' : '已移出'} My Words（生词 ${mw.new.length}/熟词 ${mw.known.length}）`);
    } catch (err) { console.warn('[VocabRadar][text-hint] ✓ 熟词标记写入失败:', err); }
  };
}
