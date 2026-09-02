// =============================================================================
// vs/sidebar-layout.js -- 视频侧栏布局子模块（注入/高度同步/折叠/拖拽/重注入）
// -----------------------------------------------------------------------------
// 职责：侧栏骨架注入页面（B站右列/YouTube #secondary/Shorts 浮动/generic 浮动，
//       含防消失重注入守卫与可见性看门狗）、高度同步体系（measureSyncHeight/
//       startSyncHeight，0/500/1500/3000ms 延迟锁高）、折叠/展开（尺寸快照还原）、
//       首批内容自动展开配额（armAutoExpand/autoExpandOnce）、浮动形态拖动与
//       右下角调整大小（位置/尺寸持久化与恢复、视口钳制）、重置布局、统一侧栏
//       路由事件（beaver-unified-open）与窗口 resize 视口守卫。
// 来源：拆分自 src/content/video-sidebar.js（2026-08-28 拆分第三刀，纯机械搬移：
//       折叠组+高度同步组+拖拽组；门面根节点引用经 getRoot() 等价接驳，
//       getHiddenByUserSetting() 经 getHiddenByUserSetting() 读取）。
// 关系：依赖 ./logger.js（log）、./yt-reorder.js（startYTReorderGuard）、门面
//       video-sidebar.js（getRoot/getHiddenByUserSetting，受控循环 import）；
//       布局状态全部内聚本模块，门面经文件尾接驳导出读写。
// =============================================================================

import { log } from './logger.js';
import { startYTReorderGuard } from './yt-reorder.js';
import { getRoot, getHiddenByUserSetting } from '../video-sidebar.js';


// === 折叠/展开视频侧栏（状态持久化）===
// 反思（2026-08-12 第四十六次）：用户要求"视频侧栏顶行有折叠按钮，切换折叠展开，应当能记住"。
//   折叠时仅显示标题行（隐藏 tabs/toolbar/panel/footer），展开时恢复完整侧栏。
//   折叠状态保存到 chrome.storage.local，刷新页面后恢复。
// === 第一百二十二次（用户裁定"折叠前后的尺寸应当不变"）===
//   修复过程自纠：本文件第380-391行存在上次会话遗留的孤立 `}` 残尾（ESM 解析失败、
//   视频侧栏整体无法加载），本次随重写一并清除。
//   折叠前把 width/height/maxHeight **三项原样快照**；展开时逐项原样写回（不再走
//   >100 启发分支与 90% 视口钳制——钳制本身就是尺寸变化源）。仅当还原值超出当前
//   视口时安全钳制并打 [VocabRadar][video-sidebar][时间戳] [size] 日志说明原因。
//   Shorts 等浮动对位函数（placeShortsOutside）在折叠期间不得改高度（见该处守卫）；
//   展开后若用户未手动拖动/调尺寸则重新对位一次——视频矩形未变时高度与折叠前一致。
let _preCollapseSize = null; // {width, height, maxHeight, left?, top?}

/**
 * 折叠/展开切换。
 * @param {boolean} [byUser=true] 用户手势调用=true；autoExpandOnce 内部=false
 *   （不清除自动展开配额——配额在 autoExpandOnce 入口已消费，语义分离防误伤）。
 * 第一百三十四次（用户裁定"就地展开折叠…位置乱窜"）：
 *   ① 删除第一百二十三次"重测取大者"分支——那是折叠前后尺寸漂移的直接来源
 *     （重测落在布局中间态即写入错误值）。现在快照什么就还原什么，一个像素不动；
 *     仅当还原值超出当前视口（折叠期间窗口变小）才安全钳制。
 *   ② 浮动形态快照补 left/top：折叠期间对位/同步全部停写，展开原样搬回，
 *     实现"就地"。内嵌形态位置由列布局决定，无需快照定位。
 */
export function toggleSidebarCollapse(byUser = true) {
  if (!getRoot()) return;
  // 第一百三十三次：用户手动折叠/展开 → 自动展开配额作废（此后不再干预）
  if (byUser) _autoExpandPending = false;
  const btn = getRoot().querySelector('#beaver-sidebar-collapse');
  const isCollapsed = getRoot().classList.toggle('beaver-collapsed');
  if (btn) btn.textContent = isCollapsed ? '▶' : '◀';
  if (isCollapsed) {
    // 快照：内联值优先；height 缺失时用实测盒高兑底（maxHeight 同步补齐，
    // 保证展开还原后约束关系与折叠前一致）
    _preCollapseSize = {
      width: getRoot().style.width || '',
      height: getRoot().style.height || '',
      maxHeight: getRoot().style.maxHeight || ''
    };
    if (!isFinite(parseInt(_preCollapseSize.height, 10))) {
      const r = getRoot().getBoundingClientRect();
      _preCollapseSize.height = Math.round(r.height) + 'px';
      if (!isFinite(parseInt(_preCollapseSize.maxHeight, 10))) {
        _preCollapseSize.maxHeight = _preCollapseSize.height;
      }
      if (!_preCollapseSize.width) _preCollapseSize.width = Math.round(r.width) + 'px';
    }
    // 第一百三十四次：浮动形态连位置一起快照（就地展开折叠）
    if (getRoot().dataset.mode === 'float' && getRoot().classList.contains('beaver-sidebar-dragged')) {
      const r = getRoot().getBoundingClientRect();
      _preCollapseSize.left = Math.round(r.left);
      _preCollapseSize.top = Math.round(r.top);
    }
    log('[size] collapse 快照', JSON.stringify(_preCollapseSize));
    _sidebarCollapsed = true;
    _heightSyncPaused = true;
    getRoot().style.height = 'auto';
    getRoot().style.maxHeight = 'none';
  } else {
    _sidebarCollapsed = false;
    if (_preCollapseSize && isFinite(parseInt(_preCollapseSize.height, 10))) {
      let h = parseInt(_preCollapseSize.height, 10);
      // 第一百五十次（用户裁定"都有明确规则…你不知道视频大小吗"）：内嵌形态展开
      // 高度**每次按规则实测**（横屏=视频顶→点赞底；竖屏 float 走对位不受此管）。
      // 不再盲信折叠前快照——早期写入的小值会被原样放大成"展开很矮"。
      if (getRoot().dataset.mode !== 'float' && !_userPlaced) {
        const fresh = measureTargetHeight();
        if (fresh > 100) h = Math.min(fresh, Math.round(window.innerHeight * 0.9));
      }
      // 唯一例外：还原值超出视口（折叠期间窗口变小）才钳制
      const vh = Math.round(window.innerHeight * 0.98);
      if (h > vh) {
        log('[size] 展开还原钳制: ' + h + '→' + vh + '（超出视口，折叠期间窗口变化）');
        h = vh;
      }
      getRoot().style.height = h + 'px';
      getRoot().style.maxHeight = h + 'px';
      if (_preCollapseSize.width) getRoot().style.width = _preCollapseSize.width;
      // 第一百三十四次：浮动形态位置原样还原（就地）
      if (_preCollapseSize.left != null && _preCollapseSize.top != null) {
        getRoot().classList.add('beaver-sidebar-dragged');
        getRoot().style.left = _preCollapseSize.left + 'px';
        getRoot().style.top = _preCollapseSize.top + 'px';
        getRoot().style.right = 'auto';
        getRoot().style.bottom = 'auto';
      }
      // 第一百七十四次：改为**无条件同步**为实际落盘值。原 `if (_heightSyncMaxH < h)`
      //   只增不减，展开时按规则实测已回缩了内联高度，_heightSyncMaxH 却仍留着旧大值，
      //   两者不一致会让 apply() 的判断依据失真（"过高"问题的次生来源）。
      _heightSyncMaxH = h;
      log('[size] expand height=' + h + 'px（内嵌=规则实测 / float=快照）');
    } else if (_heightSyncMaxH > 100) {
      // 无快照（如刷新后从 storage 恢复的首次展开）：退回同步高度
      getRoot().style.height = _heightSyncMaxH + 'px';
      getRoot().style.maxHeight = _heightSyncMaxH + 'px';
      log('[size] expand 无快照, 用同步高 ' + _heightSyncMaxH + 'px');
    } else {
      getRoot().style.height = '';
      getRoot().style.maxHeight = '';
    }
    _heightSyncPaused = false;
    _preCollapseSize = null;
    // 浮动对位形态（Shorts）：视频可能已滚动换位——仅当用户未接管（_userPlaced=false）
    //   时重新对位。第一百二十八次：单次对位在视频矩形刚变（滚动/折叠期间布局变化）时
    //   可能落在中间态 → 展开"尺寸过矮"甚至字幕区被吞；改为短重试循环（400ms×10）至成功。
    if (!_userPlaced && typeof _shortsRealign === 'function') {
      let __rn = 0;
      const __rtick = () => {
        let ok = false;
        try { ok = _shortsRealign(); } catch (e) { /* ignore */ }
        if (!ok && __rn++ < 10 && getRoot() && document.body.contains(getRoot())) setTimeout(__rtick, 400);
      };
      __rtick();
    }
  }
  try { chrome.storage.local.set({ sidebarCollapsed: isCollapsed }); } catch (_) { /* ignore */ }
  log('视频侧栏折叠状态:', isCollapsed ? '折叠' : '展开');
}

// === 注入到 B站右侧：作者(up-panel-container)之后、弹幕列表(danmaku-box)之前 ===
// 参考 VideoSeek：视频提示挤进 .right-container-inner，把原弹幕列表挤下去。
// 实测 B站子元素：up-panel-container | danmaku-box | (空) | slide-ad-exp | video-card-ad-small | rcmd-tab
// 目标位置：up-panel-container 之后 / danmaku-box 之前。
// YouTube 侧：注入 #secondary（视频页右侧相关栏）顶部。
// 反思（2026-07-09 #75）：用户要求「高度固定，一屏之内」。
//   旧版 startSyncHeight 用 MutationObserver 持续监听 body 30 秒，每次 DOM 变化都重算
//   高度 → 页面动态加载（评论/推荐/折叠展开）时视频提示高度反复跳动，"一团糟"。
//   修正：去掉 MutationObserver，改为多次延迟计算（0/500/1500/3000ms）等布局稳定后固定。
//   _heightSyncStarted 防重复启动；_heightSyncTimers 管理延迟任务；_heightSyncResizeHandler
//   保存 resize 监听器引用以便 destroySidebar 清理（旧版未移除 resize 监听器=内存泄漏）。
let _heightSyncObs = null;            // 保留（destroySidebar 等处引用），不再真正使用
let _heightSyncStarted = false;
let _heightSyncTimers = [];
let _heightSyncResizeHandler = null;
// 反思（2026-07-10 #84）：用户再次反馈「视频提示窗口高度还是一团糟，高度并不固定」。
//   根因：apply() 在 0/500/1500/3000ms 多次延迟计算时，每次 h 不同都写入 style.height，
//   导致高度反复跳动；且换集分支只清除 height/maxHeight 却未重置 _heightSyncStarted、
//   未重调 startSyncHeight()，换集后高度彻底失去约束（用户反馈"高度缩小"）。
//   修正：引入 _heightSyncMaxH 记录已落盘的最大高度，apply() 只增不减（取最大值），
//   避免延迟计算期间跳动；h<=100 时不清除已有高度，避免视频未就绪时塌陷。
//   换集时重置 _heightSyncMaxH=0 + _heightSyncStarted=false 并重调 startSyncHeight()。
let _heightSyncMaxH = 0;
// 第一百三十八次：本集高度锁——首次同步写入后置 true，apply 后续调用直接短路；
// 三处 _heightSyncMaxH=0（换集/重置布局）处同步解锁。配合 _sizeFrozen 实现
// "除非用户手动调整，否则不因任何活动重塑窗口"。
let _heightLocked = false;
// 反思（2026-08-13 第五十二次）：折叠状态标志。
//   用户反馈"视频侧栏折叠态还是顶行+大段空白"。
//   根因：startSyncHeight 的延迟计算（500/1500/3000ms）与 resize 回调在折叠后仍运行，
//   把固定高度重新写回 → 折叠态残留空白。
//   修正：折叠时置 _sidebarCollapsed=true，apply() 检测到折叠直接跳过；
//   展开时置 false 并恢复 _heightSyncMaxH 高度。
let _sidebarCollapsed = false;
// 第一百三十三次（用户裁定"先折叠，有内容了再展开，而不是先展开空着"）：
// 启动一律折叠（不再恢复 storage.sidebarCollapsed）；_autoExpandPending=true 时，
// 首批真实内容（原生字幕/ASR 结果）到达自动展开一次；用户手动折叠/展开即清除标记。
let _autoExpandPending = false;
export function armAutoExpand() { _autoExpandPending = true; }
// （2026-08-28 拆分第三刀：vs/subtitle-renderer 调用，加 export 接驳）
export async function autoExpandOnce() {
  if (!_autoExpandPending || !getRoot() || !document.contains(getRoot())) return;
  _autoExpandPending = false;
  try {
    if (_sidebarCollapsed && !getRoot().classList.contains('beaver-collapsed')) {
      // 状态不同步（罕见）：仅对齐标志
      _sidebarCollapsed = false;
      return;
    }
    if (_sidebarCollapsed) {
      log('首批内容到达，自动展开侧栏');
      toggleSidebarCollapse(false);
      // 第一百三十九次（用户反馈"有些字幕先全部展开，一会后缩小"）：早于高度同步
      // 就展开时，height:auto 会让面板被内容撑到极高（全部字幕铺开），随后同步
      // 写入钳制值又骤缩。展开瞬间若无同步高，先按测量值预置并锁定（与 apply 同式），
      // 视觉上一次到位。
      try {
        if (!_heightSyncMaxH && getRoot().dataset.mode !== 'float' && !_userPlaced) {
          // 第一百四十九次：展开前预测量重试（≤6×250ms）——布局早期锚点未就绪时
          // 测量值偏小会造成"先矮后高"两段式跳变；等到位再展开，视觉一次到位。
          // 第一百五十五次：重试门槛提到 视口40%（横屏播放器正常占比），
          // 重试耗尽仍小则以 62% 视口兜底——宁可偏高也绝不出现"初始很矮"。
          // 第一百五十六次：重试耐心 6→16 次（≤4s）——用户实测"第一次半高第二次全高"
          // 说明冷布局就绪普遍 >1.5s；宁可晚 ~2s 展开，也要一次到位。
          // 第一百七十三次（用户裁定"横屏初始展开半高"是缺陷，应当全高）：
          //   旧门槛 `h >= max(320, 视口40%)` 是**错的判据**——横屏播放器本身就占
          //   视口 50%~60%，第 0 次测量（点赞行尚未渲染，measureSyncHeight 走
          //   "回退纯播放器高"分支）即已满足，循环立刻 break，把"只有播放器高"的
          //   半高值当成规则高度写死；随后 _heightSyncMaxH 非零又让本函数与
          //   apply() 都不再重算 → 永久半高。
          //   改为以**规则锚点是否就绪**为判据（B站点赞工具条 / YouTube #actions
          //   已渲染且位于播放器下方），锚点没到就继续等，等到的才是"视频顶→点赞底"。
          let h = 0;
          let ready = false;
          for (let i = 0; i < 16; i++) {
            ready = isSpanAnchorReady();
            h = measureTargetHeight();
            if (ready && h > 100) break;
            await new Promise((r) => setTimeout(r, 250));
          }
          const vhCap = Math.round(window.innerHeight * 0.9);
          // 第一百七十四次（用户反馈"bilibili 视频侧栏过高，应当与视频齐顶、点赞按钮同底"）：
          //   撤销上一次引入的 `floorFallback = 62% 视口` 兜底。该兜底本意是防"初始半高"，
          //   但它可能 **大于** 规则高度（视频顶→点赞底），配合 apply() 的"只增不减"就成了
          //   永久性偏高——正是本轮"过高"的直接来源。
          //   改为：只写测量值（measureTargetHeight 已自带"不低于播放器高"的地板，
          //   天然 ≤ 规则高度，绝不会偏高）；测不出就干脆不写，交给后续补测一次到位。
          const capped = (h > 100) ? Math.min(h, vhCap) : 0;
          if (capped > 100) {
            getRoot().style.height = capped + 'px';
            getRoot().style.maxHeight = capped + 'px';
            _heightSyncMaxH = capped;
            log('[size] autoExpand 预置 height=' + capped + 'px（锚点'
              + (ready ? '已就绪，规则高度' : '未就绪，过渡值待补测') + '）');
          }
          // 第一百七十三次：兜底路径留后手——startSyncHeight 的延迟批次最晚 3000ms，
          //   本循环最多耗 4s 已错过，若不补测则兜底值会成为最终值。此处安排两次
          //   延迟补测，锚点一到就让 apply()（只增不减）把高度补到规则值。
          if (!ready) {
            [1500, 4000].forEach((d) => setTimeout(() => {
              try { if (isSpanAnchorReady()) requestSyncHeightOnce(); } catch (e) { /* ignore */ }
            }, d));
          }
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}
let _heightSyncPaused = false; // 第一百一十九次：折叠期间暂停 startSyncHeight 写入
// 第一百二十二次：用户接管标记——拖动/调整大小后为 true，startSyncHeight 与
// Shorts 对位不再改写尺寸（"此形态之外，侧栏应当可以移动和调整大小"，接管后位置尺寸归用户）
let _userPlaced = false;
// 第一百三十四次（用户裁定"除非用户手动调整大小切换形态，否则不因asr等活动重塑窗口"）：
// ASR 启动成功即置 true——startSyncHeight/placeShortsOutside/单次补测全部停写外框。
// 与 _userPlaced（用户手动接管，永久）区分：本标记只锁"活动引发的自动重塑"。
let _sizeFrozen = false;
// 第一百二十二次：无字幕自动折叠已执行标记——setTracks 重试(2.5s/4.5s/8s)会多次触发
// showNoSubtitle，旧版每次都把用户手动展开的侧栏再折叠回去（"折叠展开前后高度变化"的
// 主要来源之一）。改为每次换集/新字幕到达前最多自动折叠一次。
let _noSubAutoCollapseDone = false;
// 第一百二十二次：Shorts 对位函数引用，展开折叠时重新对位一次（视频未滚动则尺寸与折叠前一致）
let _shortsRealign = null;
// 第一百三十二次（用户裁定"视频侧栏很矮…16:9竖侧栏"）：浮动形态默认身形统一为
// **竖版 16:9**（宽:高=9:16 的竖立卡片）——旧默认 420×236 是横版扁盒，即"很矮"主源。
// 宽以视口钳制，高按 16:9 竖放并夹进视口；generic 注入/Shorts 初始占位/重置布局共用。
function defaultFloatSize() {
  const w = Math.min(320, Math.max(240, window.innerWidth - 16));
  let h = Math.round(w * 16 / 9);
  h = Math.max(240, Math.min(h, window.innerHeight - 40));
  return { width: w, height: h };
}
// 第一百三十三次：Shorts 页 DOM 里同时存在多条 short 的 <video>（上下滑动栈），
// querySelector('video') 常抓到非当前条 → 对位矩形比可见视频更高更宽。
// 第一百三十八次（用户反馈"竖屏宽度不足、位置比视频还高"）：滚动过渡期相邻两条
// 与视口相交面积接近，最大面积法会抓到邻条（其 rect 偏上=侧栏比视频高；窄条=宽度不足）。
// 改为：优先取**包含视口中心点**的 video（即当前正在观看的这条），无命中再退回最大相交。
function pickVisibleVideo() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const cx = vw / 2, cy = vh / 2;
  let best = null, bestArea = 0;
  let centerHit = null;
  // 第一百三十九次：优先信任 YouTube 自身的活跃标记（ytd-reel-video-renderer[is-active]），
  // 这是官方"当前条"信号，比几何推断更可靠；无标记再走中心点/最大相交几何回退。
  try {
    const activeEl = document.querySelector('ytd-reel-video-renderer[is-active] video')
      || document.querySelector('[is-active] video');
    if (activeEl && activeEl.videoHeight > 0) return activeEl;
  } catch (e) { /* ignore */ }
  document.querySelectorAll('video').forEach((v) => {
    let r;
    try { r = v.getBoundingClientRect(); } catch (e) { return; }
    if (!r || (v.videoHeight <= 0 && r.height <= 0)) return;
    if (centerHit === null && r.left <= cx && r.right >= cx && r.top <= cy && r.bottom >= cy) {
      centerHit = v; // 含视口中心＝当前条（可能多条时取最后一个，DOM 顺序即栈序）
    }
    const ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (ix * iy > bestArea) { bestArea = ix * iy; best = v; }
  });
  return centerHit || best;
}
// 第一百四十七次（用户裁定"位置固定下来，不再更改大小"）：Shorts 首次对位写入
// 宽高后置 true——此后滚动跟随只更新 left/top，尺寸会话内不再变。
let _shortsSizeLocked = false;
// 第一百二十五次：startSyncHeight 内部 apply 的单次重测句柄（null=同步未启动）
let _applyNow = null;
/** 字幕到达/面板变化后补测一次高度（仅内嵌形态；折叠/接管态由 apply 自行短路）
 *  第一百三十四次：活动冻结（ASR 运行）期间不补测--业务活动不得重塑外框 */
// （2026-08-28 拆分第三刀：vs/subtitle-renderer 调用，加 export 接驳）
export function requestSyncHeightOnce() {
  if (!_applyNow) return;
  if (_sizeFrozen) return;
  try { _applyNow(); } catch (e) { /* ignore */ }
}
// === 第一百七十五次：B 站右列参照元素识别器（重建） ===
// 用户裁定侧栏目标位置："视频之右，作者之下，弹幕列表之上"。
// 实测 B站右列子元素顺序：
//   up-panel-container | danmaku-box | (空) | slide-ad-exp | video-card-ad-small | rcmd-tab
// 故插入点 = 弹幕列表(danmaku-box)之前；弹幕列表缺失时回退到作者块之后；
// 二者皆无才回退容器末尾（绝不插首位——首位会盖住作者块）。

/** 是否为弹幕列表/评论区（主锚点之一：侧栏应排在它之前）
 *  第一百七十六次：移出 rcmd-tab|recommend-list——推荐区在右列**末位**，
 *  混进本识别器会让"弹幕未渲染时"退化成"插推荐之前"（即广告之下），
 *  正是用户三次反馈的"落到弹幕列表和广告之下"。推荐区另立 isRecommendSection。 */
function isDanmakuSection(el) {
  const cls = String((el && el.className) || '');
  const id = String((el && el.id) || '');
  const tag = String((el && el.tagName) || '').toLowerCase();
  return /danmaku-box|danmaku-wrap|danmaku-list|bili-comments|comment-section|comment-wrap/i
    .test(cls + ' ' + id + ' ' + tag);
}

/** 是否为作者信息块（次锚点：侧栏应排在它之后） */
function isUpinfo(el) {
  const cls = String((el && el.className) || '');
  const id = String((el && el.id) || '');
  return /up-panel-container|up-info|upinfo|up-card|staff-container/i.test(cls + ' ' + id);
}

/** 是否为其他列表区（弹幕缺位时的替补锚点：剧集列表/播放列表等） */
function isOtherListSection(el) {
  const cls = String((el && el.className) || '');
  const id = String((el && el.id) || '');
  const tag = String((el && el.tagName) || '').toLowerCase();
  return /ep-list|episode-list|multi-page|video-pod|section-list|right-container-hint/i
    .test(cls + ' ' + id + ' ' + tag);
}

/** 是否为广告位（右列中部：slide-ad-exp / video-card-ad-small 等） */
function isAdSection(el) {
  const cls = String((el && el.className) || '');
  const id = String((el && el.id) || '');
  return /slide-ad|video-card-ad|ad-report|bili-ad|activity-m-v1/i.test(cls + ' ' + id);
}

/** 是否为推荐列表区（右列末位：rcmd-tab / recommend-list-v1 / 播放列表页 recommend-list-container） */
function isRecommendSection(el) {
  const cls = String((el && el.className) || '');
  const id = String((el && el.id) || '');
  return /rcmd-tab|recommend-list/i.test(cls + ' ' + id);
}

/**
 * 第一百七十六次（用户第三次反馈"目前放在弹幕列表和广告之下了"）：
 * 计算侧栏在 B 站右列中的落位点。返回 { ref, why }：
 *   ref 非空 → 应 insertBefore(root, ref)；ref 为 null → 无可用参照。
 *
 * 优先级重排的理由（本次修正的根因）：
 *   旧 isDanmakuSection 的正则把 rcmd-tab|recommend-list 也算作"弹幕列表"，
 *   于是当 danmaku-box 尚未渲染而 rcmd-tab 已渲染时，锚点退化为"推荐列表之前"
 *   ——而推荐列表在右列**末位**、广告之后，落位就正好是用户看到的
 *   "弹幕列表和广告之下"。故本次把推荐区拆成独立的最低优先级识别器，
 *   并把"作者块之后"提到第一优先级：用户已明确右列顺序是
 *   作者块(up-panel-container, 首位) → 弹幕列表 → 广告 → 推荐，
 *   "作者块的下一个兄弟之前"就是目标位置的直接表达，且不依赖弹幕是否已渲染。
 *
 * @param {HTMLElement} holder 右列容器（或侧栏当前父节点）
 * @param {HTMLElement} [root] 侧栏自身（需从候选中排除）
 * @returns {{ref: HTMLElement|null, why: string}}
 */
function biliPlacement(holder, root) {
  if (!holder) return { ref: null, why: '容器为空' };
  const kids = Array.from(holder.children)
    .filter((c) => c && c.tagName !== 'STYLE' && c !== root);
  // 1) 作者块之后（最可靠：作者块是右列首位，与"作者之下"一一对应）
  const up = kids.find((c) => isUpinfo(c));
  if (up) {
    // 取作者块之后的第一个非侧栏/非 STYLE 元素作为插入前参照
    let ref = up.nextElementSibling;
    while (ref && (ref === root || ref.tagName === 'STYLE')) ref = ref.nextElementSibling;
    if (ref) return { ref, why: '作者块之后（' + briefOf(ref) + ' 之前）' };
    return { ref: null, why: '作者块是最后一个元素 → 追加末尾即作者之下' };
  }
  // 2) 弹幕列表/评论区之前
  const dm = kids.find((c) => isDanmakuSection(c));
  if (dm) return { ref: dm, why: '弹幕列表之前（' + briefOf(dm) + '）' };
  // 3) 其他列表区（番剧剧集/合集列表）之前
  const other = kids.find((c) => isOtherListSection(c));
  if (other) return { ref: other, why: '剧集/合集列表之前（' + briefOf(other) + '）' };
  // 4) 广告位之前
  const ad = kids.find((c) => isAdSection(c));
  if (ad) return { ref: ad, why: '广告位之前（' + briefOf(ad) + '）' };
  // 5) 推荐列表之前（最低优先级——它在右列末位，只比"末尾"好一点）
  const rc = kids.find((c) => isRecommendSection(c));
  if (rc) return { ref: rc, why: '推荐列表之前（' + briefOf(rc) + '）' };
  return { ref: null, why: '未识别到任何参照元素' };
}

/** 节点简述（诊断/日志用）：<tag>#id.class1.class2 */
function briefOf(n) {
  if (!n) return '(null)';
  if (n.nodeType === Node.COMMENT_NODE) return '<!--' + String(n.nodeValue || '').trim().slice(0, 24) + '-->';
  if (n.nodeType === Node.TEXT_NODE) return 'text:"' + String(n.nodeValue || '').trim().slice(0, 24) + '"';
  const tag = String(n.tagName || '?').toLowerCase();
  const id = n.id ? '#' + n.id : '';
  const cls = n.className ? '.' + String(n.className).trim().replace(/\s+/g, '.') : '';
  return '<' + tag + '>' + id + cls;
}

/**
 * 第一百七十六次（用户裁定"先加诊断再定方案"）：打印 B 站右列**完整**子节点清单。
 * 输出内容：序号 + 节点简述（含 id/全部 class）+ 注释/文本占位节点 + 每节点
 * getBoundingClientRect 的 top/height + 侧栏所在序号 + 播放器/工具条基准线，
 * 不截断、不省略。注入时与顺序守卫每次动作时都打，用于据实定位而非猜测。
 * @param {HTMLElement} holder 右列容器
 * @param {string} tag 场景标签（如"注入前"/"守卫移位后"）
 * @param {HTMLElement} [root] 侧栏根节点
 */
function dumpBiliColumn(holder, tag, root) {
  try {
    if (!holder) { log('[bili-col] ' + tag + ': 容器为空'); return; }
    const lines = [];
    let idx = -1;
    let rootIdx = -1;
    Array.from(holder.childNodes).forEach((n) => {
      if (n.nodeType === Node.ELEMENT_NODE) {
        idx++;
        const r = n.getBoundingClientRect();
        if (n === root) rootIdx = idx;
        lines.push('  [' + idx + '] ' + briefOf(n)
          + ' top=' + Math.round(r.top) + ' h=' + Math.round(r.height)
          + (n === root ? '   <== 我方侧栏' : ''));
      } else if (n.nodeType === Node.COMMENT_NODE || (n.nodeType === Node.TEXT_NODE && String(n.nodeValue || '').trim())) {
        lines.push('  [-] ' + briefOf(n) + ' (占位节点，不计入元素序号)');
      }
    });
    // 高度基准线（同时服务"齐顶/点赞同底"的高度诉求诊断）
    const player = document.querySelector('.bpx-player-container')
      || document.querySelector('.bpx-player-video-wrap');
    const toolbar = document.querySelector('#arc_toolbar_report')
      || document.querySelector('#playlistToolbar')
      || document.querySelector('.video-toolbar-container');
    const pr = player ? player.getBoundingClientRect() : null;
    const tr = toolbar ? toolbar.getBoundingClientRect() : null;
    const rr = root && root.isConnected ? root.getBoundingClientRect() : null;
    const plan = biliPlacement(holder, root);
    log('[bili-col] ' + tag
      + '\n 容器: ' + briefOf(holder) + '  元素子节点数=' + (idx + 1)
      + '  侧栏序号=' + (rootIdx < 0 ? '不在此容器内' : rootIdx)
      + '\n' + lines.join('\n')
      + '\n 落位计划: ' + plan.why + ' → ref=' + briefOf(plan.ref)
      + '\n 播放器: ' + (pr ? 'top=' + Math.round(pr.top) + ' h=' + Math.round(pr.height) + ' bottom=' + Math.round(pr.bottom) : '未找到')
      + '\n 工具条(点赞行): ' + (tr ? 'top=' + Math.round(tr.top) + ' bottom=' + Math.round(tr.bottom) : '未找到')
      + '\n 侧栏: ' + (rr ? 'top=' + Math.round(rr.top) + ' h=' + Math.round(rr.height) + ' bottom=' + Math.round(rr.bottom) : '未挂载')
      + '\n 目标高度(工具条bottom - 播放器top) = ' + (pr && tr ? Math.round(tr.bottom - pr.top) : 'N/A'));
  } catch (e) {
    log('[bili-col] ' + tag + ' 失败: ' + e.message);
  }
}

export function injectIntoPage(root) {
  // 第一百五十一次：幂等守卫——已在目标容器则直接跳过。日志实证 YouTube 初始化期
  // 会短暂移除再重建子树，reinject 守卫与 MutationObserver 竞态造成"检测到被移除×8
  // / 已注入×4"风暴（侧栏闪烁、观察器堆积）。幂等后单实例稳定。
  // 第一百七十二次（用户反馈"哔哩哔哩中都挪到弹幕列表和广告之下了"）：
  //   旧幂等守卫只判"在不在右列内"，一旦初次插错位置（或被 B 站脚本挪下去）
  //   便永久不纠正——这是"落到弹幕/广告之下"的直接放行口。改为**位置守卫**：
  //   已在右列但不是首个子元素时，就地移回首位（顶部对齐视频顶部），再返回。
  // 第一百七十五次（用户裁定"不可兜底首位。右列首位你是妄想。几天之前一直稳定正常。"
  //   "具体为视频之右，作者之下，弹幕列表之上"）：恢复参照元素锚点定位。
  //   第一百七十二次曾把这三个识别器随四级回退一并删除、改为无条件插右列首位，
  //   被用户否决——首位会盖在作者块(up-panel-container)之上，非目标位置。
  //   现按 change.log 第 84/86 条与本文件顶部注释重建三识别器。
  try {
    if (root.isConnected) {
      const sec = document.querySelector('#secondary');
      if (sec && sec.contains(root)) { log('幂等: 已在 #secondary，跳过注入'); return; }
      const rc = document.querySelector('.right-container-inner, .right-container, .playlist-container--right');
      if (rc && rc.contains(root)) {
        // 位置守卫（落位版）：只在"排到了参照元素之后"时移回参照之前；
        // 第一百七十六次：参照元素缺位时不再静默放行——改为按"作者块之后"补正，
        //   若连作者块都没有才真的不动（不擅自挪位置，更不抬到首位）。
        const holder = root.parentElement;
        const plan = holder ? biliPlacement(holder, root) : { ref: null, why: '无父节点' };
        dumpBiliColumn(holder, '幂等/位置守卫入口', root);
        if (plan.ref && !(root.compareDocumentPosition(plan.ref) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          holder.insertBefore(root, plan.ref);
          log('位置守卫: B站右列内落位错误 → 移回 ' + plan.why);
          startSyncHeight();
        } else {
          log('幂等: 已在 B站右列目标位置，跳过注入（' + plan.why + '）');
        }
        return;
      }
    }
  } catch (e) { /* ignore */ }

  const tryInject = () => {
    // YouTube：注入 #secondary 顶部（完全复刻 videoseek 的选择器与位置）
    // videoseek 用 #secondary.ytd-watch-flexy，把 shadowHost 插到 firstChild 之前
    // 反思（2026-07-28）：用户反馈"YouTube Shorts 缺失显示，装载极慢"。
    //   根因：Shorts 页面 DOM 是 ytd-shorts，没有 #secondary 元素，
    //   tryInject 永远找不到 #secondary，MutationObserver 持续等待 30 秒才超时。
    //   修正：Shorts 页面使用浮动注入（position:fixed），与 generic 平台一致。
    const isShorts = /\/shorts\//i.test(location.pathname);
    if (isShorts) {
      // 反思（2026-07-29 三次修复）：用户反馈"视频提示不能附着视频而是独自悬浮，高度变来变去，
      //   初始临时高度可以依据视频上半部分再调"。
      //   根因1：position:fixed 独自悬浮，与视频无关联。修正：基于视频位置计算 top/right。
      //   根因2：startSyncHeight 覆盖高度导致变来变去。修正：不调用，高度固定为视频上半部分。
      //   根因3：初始高度需依据视频上半部分。修正：先用 50vh 兜底，视频就绪后调整为视频高度一半。
      if (root.parentNode === document.body && root.style.position === 'fixed') {
        return true;
      }
      document.body.appendChild(root);
      root.style.position = 'fixed';
      // 第一百一十八次（用户裁定）：竖屏 Shorts——与视频同高、位于视频之外，
      // 不遮挡播放器右侧点赞/评论按钮列（该列在视频矩形内部右缘）。
      root.dataset.mode = 'float'; // 第一百二十二次：浮动形态标记（可拖动/可调大小）
      // 第一百二十六次（用户反馈"竖屏里侧栏变成顶栏横跨整个页面"）：根因=默认宽度
      // 随 placeShortsOutside 移入后，视频未就绪期间无任何宽高 → 基础 CSS width:100%
      // + fixed top:0 = 整页宽的"顶栏"。恢复**同步默认尺寸**。
      // 第一百四十三次（用户裁定）：竖屏身形 **1:2**（高=视口可用高的~2/3，宽=高一半），
      // 对位成功后被活跃视频矩形精确覆盖。
      {
        const h = Math.min(Math.round(window.innerHeight * 0.7), window.innerHeight - 40);
        const w = Math.max(220, Math.min(Math.round(h * 0.5), window.innerWidth - 16));
        root.style.width = w + 'px';
        root.style.maxWidth = w + 'px';
        root.style.height = h + 'px';
        root.style.maxHeight = h + 'px';
        // 第一百四十六次：占位期默认右上角（此前无坐标→fixed 静态位=左上角）
        root.style.top = '20px';
        root.style.right = '16px';
      }
      root.style.zIndex = '2147483000';
      root.style.boxShadow = '-2px 0 8px rgba(0,0,0,0.15)';
      // 第一百二十四次（用户反馈"youtube竖屏侧栏依旧很宽很矮"）：根因=0/500/1500/3000ms
      // 四次对位可能全部落在视频元数据就绪之前（videoHeight=0 直接 return），
      // 高度从未写入 → 只剩 CSS min-height:200px，360×200 即"宽而矮"。
      // 修正：①宽度自适应视口；②每 400ms 持续重试至成功（上限 30 次）；
      // ③挂 video loadedmetadata 立即对位兜底。
        // 第一百四十六次·关键修复：启动即强制折叠（133）后本守卫"折叠→视为已就位"
        // 导致**对位从未执行**——侧栏停留在注入占位态（无坐标=fixed 静态位=左上角、
        // 临时高=比视频高）。改为：折叠只影响内容显隐，**位置照常对位**；
        // 折叠期间仅写 left/top（不写宽高，防顶条被撑成空白高块）。
        const placeShortsOutside = () => {
          if (_userPlaced || root.classList.contains('beaver-sidebar-dragged')) return true;
          if (_sizeFrozen) return true;
          // 第一百三十三次/一百三十九次：优先官方 is-active，其次视口中心，再次最大相交
          const v = pickVisibleVideo();
          if (!v || v.videoHeight <= 0) return false;
          const rect = v.getBoundingClientRect();
          if (!(rect.height > 50) || !(rect.width > 50)) return false;
          const collapsedNow = _sidebarCollapsed || _heightSyncPaused;
          // 1:2 竖条：高随视频，宽=高一半（钳视口）
          const H = Math.round(rect.height);
          const W = Math.round(Math.max(220, Math.min(H * 0.5, window.innerWidth - 16)));
          // 第一百四十七次（用户裁定"位置固定下来，不再更改大小"）：宽高只在首次
          // 对位写入一次并永久锁定；此后滚动/换条仅跟随 left/top。
          if (!collapsedNow && !_shortsSizeLocked) {
            root.style.width = W + 'px';
            root.style.maxWidth = W + 'px';
          }
          const GAP = 120;
          let left = rect.right + GAP;
          if (left + W > window.innerWidth - 8) left = rect.left - W - GAP;
          if (left < 8) left = Math.max(8, window.innerWidth - W - GAP);
          root.style.left = Math.round(left) + 'px';
          root.style.right = 'auto';
          root.style.top = Math.max(0, Math.round(rect.top)) + 'px';   // 同视频顶
          if (!collapsedNow && !_shortsSizeLocked) {
            root.style.height = H + 'px';                                // 同视频底
            root.style.maxHeight = H + 'px';
            _shortsSizeLocked = true;
          }
          return true;
        };
      _shortsRealign = placeShortsOutside; // 第一百二十二次：供折叠展开后对位
      wireMoveResize(root);
      // 持续对位：成功即停；loadedmetadata 再对一次防元数据晚到
      let __shortsTries = 0;
      const __shortsTick = () => {
        __shortsTries++;
        let ok = false;
        try { ok = placeShortsOutside(); } catch (e) { /* ignore */ }
        if (!ok && __shortsTries < 30 && document.body.contains(root)) {
          setTimeout(__shortsTick, 400);
        }
      };
      __shortsTick();
      const __v = document.querySelector('video');
      if (__v) {
        try { __v.addEventListener('loadedmetadata', () => { try { placeShortsOutside(); } catch (e) { /* ignore */ } }, { once: true }); } catch (e) { /* ignore */ }
      }
      // 第一百一十三次引入的 ASR 后高度缩小问题：录制/识别期间不再有任何代码改高度
      // （此处显式固定为视频同高）；窗口尺寸变化时重新对位
      if (!root.__beaverShortsResize) {
        root.__beaverShortsResize = true;
        window.addEventListener('resize', () => {
          if (document.body.contains(root)) placeShortsOutside();
        }, { passive: true });
        // 第一百四十三次（用户反馈"不可上下移动/位置比视频高"）：Shorts 滚动期间
        // 节流跟随（500ms）——视频矩形整体位移时侧栏实时追贴，而非只在滚动停止后补一次。
        let __scrollLast = 0;
        window.addEventListener('scroll', () => {
          const now = Date.now();
          if (now - __scrollLast < 500) return;
          __scrollLast = now;
          try { if (document.body.contains(root)) placeShortsOutside(); } catch (e) { /* ignore */ }
        }, { passive: true, capture: true });
      }
      log('YouTube Shorts: 视频同高、视频之外的浮动注入（持续对位版）');
      return true;
    }
    const isYT = !!document.querySelector('#secondary') || /youtube\.com/i.test(location.hostname);
    if (isYT) {
      // 用 videoseek 完全相同的选择器（带 ytd-watch-flexy tag），保证容器一致
      const sec = document.querySelector('#secondary.ytd-watch-flexy')
        || document.querySelector('#secondary-inner')
        || document.querySelector('#secondary');
      if (sec) {
        // 插到 firstChild 之前 = 最顶部（与 videoseek 同位置）
        // 第一百二十二次：横屏内嵌形态——位置由布局管理（不可拖动/调尺寸）
        root.dataset.mode = 'inline';
        sec.insertBefore(root, sec.firstChild);
        log('已注入 YouTube #secondary 顶部（复刻 videoseek）');
        startSyncHeight();
        startYTReorderGuard(root, sec);
        return true;
      }
      // #secondary 尚未渲染，返回 false 让 MutationObserver 继续等
      return false;
    }

    // 反思（2026-07-06 二次修复）：用户反馈"有些视频位置错误，无论啥视频都应在播放窗口右侧"。
    // 上一版新增 .plp-r 等选择器，但番剧页实际 DOM 可能与预期不同，仍有漂浮。
    // 本次策略：1) 扩展已知选择器；2) 新增"通过 #playerWrap 兄弟节点定位"回退方案。
    // 番剧页布局：左列(含 #playerWrap) + 右列(弹幕/剧集/作者)，
    // 从 #playerWrap 向上找第一个有 DIV/SECTION 兄弟的祖先，该兄弟即右侧容器。
    // 第一百七十二次（顺手修既存缺陷）：本变量在下方 "#playerWrap 兄弟节点回退"
    //   分支里被重新赋值（inner = sibling），声明为 const 时该分支必抛
    //   TypeError: Assignment to constant variable，被外层 try-catch 吞掉，
    //   等于回退方案从未生效。改为 let。
    let inner = document.querySelector('.right-container-inner')
      || document.querySelector('.right-container')
      || document.querySelector('.playlist-container--right')  // 第一百七十六次：播放列表页右列（无 inner 层）
      || document.querySelector('.plp-r')           // 番剧播放页右侧
      || document.querySelector('#bangumi_detail .plp-r')
      || document.querySelector('.main-container .plp-r')  // 番剧页主容器内右侧
      || document.querySelector('.video-container-v1 .right-container-inner')  // videoseek CSS 同款选择器
      || document.querySelector('.video-container-v1 .right-container')
      || document.querySelector('.video-info-container')?.parentElement  // 番剧页视频信息区父容器
      || document.querySelector('.bangumi-right')          // 番剧专用右侧容器
      || document.querySelector('.ep-info-right')          // 剧集信息右侧
      || document.querySelector('.player-side-right')      // 播放器视频提示右侧
      || document.querySelector('.video-detail-right')     // 视频详情右侧
      || document.querySelector('#playerWrap + div')       // playerWrap 紧邻兄弟
      || document.querySelector('.bpx-player-container + div');  // 播放器容器紧邻兄弟

    // 回退：通过 #playerWrap 兄弟节点定位右侧容器（不依赖具体类名）
    // 从 #playerWrap 向上最多遍历 5 层，找到第一个有 DIV/SECTION 兄弟的祖先
    if (!inner) {
      const playerWrap = document.querySelector('#playerWrap');
      if (playerWrap) {
        let el = playerWrap;
        for (let depth = 0; depth < 5 && el; depth++) {
          const sibling = el.nextElementSibling;
          if (sibling && (sibling.tagName === 'DIV' || sibling.tagName === 'SECTION')
              && sibling.children.length > 0 && !sibling.querySelector('video')) {
            // 找到右侧容器（排除含 video 的兄弟，那可能是播放器的一部分）
            log('通过 #playerWrap 兄弟节点定位右侧容器 (depth=' + depth + '):', String(sibling.className).slice(0, 60));
            inner = sibling;
            break;
          }
          el = el.parentElement;
        }
      }
    }
    // 反思（2026-07-08 #44）：generic 平台（TikTok/抖音/小红书/X/FB/IG/流媒体）
    //   无专用右侧容器，参照 Language Reactor / Trancy 浮动注入视口右侧。
    //   仅当页面有 video 元素才注入（避免非视频页注入）。
    // 反思（2026-07-28）：用户反馈"抖音上视频提示遮盖了整页"。
    //   根因：JS 未显式设置 width，抖音页面 CSS 可能覆盖视频提示宽度导致 100%。
    //   修正：显式设置 width/maxWidth/height/maxHeight，防止页面 CSS 覆盖。
    if (!inner) {
      const genericVideo = document.querySelector('video');
      if (genericVideo) {
        document.body.appendChild(root);
        root.dataset.mode = 'float'; // 第一百二十二次：浮动形态（可拖动/可调大小）
        root.style.position = 'fixed';
        // 第一百二十三次（用户裁定）：没有固定位置时默认右上角——与悬浮球/文本侧栏
        // 同一默认锚点（right:16px top:20px），不再通栏 100vh 遮盖页面右侧。
        root.style.right = '16px';
        root.style.top = '20px';
        // 第一百二十五次（用户裁定）：浮动默认比例 16:9——宽 420 → 高 236；
        // 右下角手柄可调大小；竖屏视频场景由 Shorts 对位改同视频高
        // 第一百三十二次（用户反馈"视频侧栏很矮…16:9竖侧栏"）：420×236 是横版扁盒，
        // 即"很矮"主源。改竖版 16:9（defaultFloatSize，320×569 视口钳制）。
        {
          const ds = defaultFloatSize();
          root.style.width = ds.width + 'px';
          root.style.maxWidth = ds.width + 'px';
          root.style.height = ds.height + 'px';
          root.style.maxHeight = ds.height + 'px';
        }
        root.style.zIndex = '2147483000';
        root.style.boxShadow = '-2px 0 8px rgba(0,0,0,0.15)';
        log('generic 平台: 浮动注入右上角 (hostname=', location.hostname, ', 380×75vh)');
        wireMoveResize(root);
        startSyncHeight();
        return true;
      }
      return false;
    }
    // 第一百二十二次：B站横屏内嵌形态——位置由布局管理（不可拖动/调尺寸）
    root.dataset.mode = 'inline';
    // 第一百七十六次（用户裁定"先加诊断再定方案"）：注入前打印右列完整子节点清单。
    //   旧诊断只在 !root.parentNode 时打、只输出 tagName.className、还截断到 8 个，
    //   信息量不足以定位"为什么落到广告之下"，故换成 dumpBiliColumn 全量输出。
    dumpBiliColumn(inner, '注入前', root);
    // 第一百七十五次（用户裁定"具体为视频之右，作者之下，弹幕列表之上"，
    //   且"不可兜底首位。右列首位你是妄想。几天之前一直稳定正常。"）：
    //   恢复锚点定位。
    // 第一百七十六次：改用 biliPlacement——"作者块之后"升为第一优先级，
    //   推荐列表降为最低优先级（见 biliPlacement 注释中的根因说明）。
    const plan = biliPlacement(inner, root);
    if (plan.ref) {
      inner.insertBefore(root, plan.ref);
      log('已插入 B站右列: ' + plan.why);
    } else {
      inner.appendChild(root);
      log('B站右列无可用参照，插入容器末尾（不占首位）: ' + plan.why);
    }
    dumpBiliColumn(inner, '注入后', root);
    startSyncHeight();
    // 第一百七十二次：B 站也挂顺序守卫——B 站 Vue 会在右列动态插入广告卡/弹幕区，
    //   这类插入不会移除侧栏（reinject 守卫不触发），只会把侧栏顺序压下去。
    // 第一百七十五次：守卫改为**锚点模式**（只保证在参照之前，不抬首位）。
    // 第一百七十六次：容器重解析补 .playlist-container--right；锚点解析改 biliPlacement；
    //   并传入诊断回调，守卫每次移位都打完整清单。
    startYTReorderGuard(root, inner, () => document.querySelector('.right-container-inner')
      || document.querySelector('.right-container')
      || document.querySelector('.playlist-container--right'),
      () => biliPlacement(root.parentElement, root).ref,
      (tag) => dumpBiliColumn(root.parentElement, tag, root));
    return true;
  };
  // 反思（2026-07-06）：try-catch 保护，防止异常页面 DOM 结构导致"未知错误"
  try {
    if (tryInject()) return;
  } catch (e) {
    console.warn('[VocabRadar][video-sidebar] tryInject 异常:', e.message);
  }
  log('等待右侧容器出现...');
  const obs = new MutationObserver(() => {
    try {
      if (tryInject()) obs.disconnect();
    } catch (e) { /* 忽略，等下次 mutation 重试 */ }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  // 反思（2026-07-06 五次修复）：用户明确"窗口错就错吧，只要得有啊"。
  // 旧版超时后 root.remove() + getRoot()=null 永久杀死视频提示，导致字幕窗口彻底消失。
  // 修正：超时后找不到容器时回退为浮动面板（.beaver-floating），附加到 body，
  // 确保视频提示始终可见——即便位置不理想，也比消失好。
  setTimeout(() => {
    if (root.parentNode) return;
    obs.disconnect();
    tryInject();
    if (!root.parentNode) {
      log('未找到合适容器，回退浮动面板');
      root.classList.add('beaver-floating');
      root.dataset.mode = 'float'; // 第一百二十二次：浮动形态（可拖动/可调大小）
      document.body.appendChild(root);
      wireMoveResize(root);
      startSyncHeight();
    }
  }, 10000);
}

// === 第一百二十五次：浮动形态接线（拖动 + 右下角调整大小 + 位置/尺寸持久化）===
// 用户裁定："只有在 youtube bilibili 横屏中侧栏位置正常。此形态之外，侧栏应当可以移动和调整大小。"
// 第一百二十七次：调高手柄开放到内嵌形态（仅调高，不脱离文档流）——横屏基线=纯播放器高，
// 用户要"顶到点赞底"可自行拉高；拖动仍限浮动形态。
function wireMoveResize(root) {
  if (!root || root.__beaverMovable) return;
  root.__beaverMovable = true;
  if (root.dataset.mode === 'float') {
    makeSidebarDraggable();
    // 第一百三十三次（用户裁定"竖屏同顶同底同宽，目前比视频高/宽"）：Shorts 页面
    // **忽略持久化位置/尺寸**——历史拖动残留会置 _userPlaced=true 并永久停写对位，
    // 侧栏从此停在旧尺寸上（比视频高/宽的直接来源）。竖屏身形由视频矩形唯一权威；
    // 用户仍可在当前会话拖动/调大小（接管当页生效，不跨页复活）。
    if (!/\/shorts\//i.test(location.pathname)) {
      restoreSidebarDraggedPosition();
      restoreSidebarSize();
    }
  }
  makeSidebarResizable();
}

// === 防消失：B站 Vue 重新渲染右侧容器时会移除 sidebar ===
// 监听 getRoot() 被移出 DOM，重新注入到右侧容器。
// 参考 videoseek 等扩展的持久化策略：sidebar 一旦启动就应在视频页全程可见。
let _reinjectObs = null;
// 第一百五十一次：风暴抑制——YouTube 初始化期连续拔插（日志实证 1s 内 8 次移除+4 次重复注入），
// 800ms 内只处理一次移除事件，配合 injectIntoPage 幂等守卫消抖。
let _lastReinjectAt = 0;
export function startReinjectGuard() {
  if (_reinjectObs) return;
  _reinjectObs = new MutationObserver(() => {
    if (getRoot() && !document.contains(getRoot())) {
      const __now = Date.now();
      if (__now - _lastReinjectAt < 800) { /* 风暴抑制：稍后 observer 再触发 */ }
      else {
        _lastReinjectAt = __now;
        console.warn('[VocabRadar][video-sidebar][' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0') + '] 检测到被移除, 重新注入');
        // 容器可能也在重建，延迟重试
        setTimeout(() => {
          if (getRoot() && !document.contains(getRoot())) {
            injectIntoPage(getRoot());
          }
        }, 350);
      }
    }
    // 第一百三十六次：可见性看门狗——"视频网站中视频侧栏直接消失，啥都没有"根因修复。
    // 反思：旧守卫只管 getRoot() 在不在 DOM（重插），不管重插回来的节点是否仍带
    //   display:none（形态切换/✕关闭/看门狗自身上一轮隐藏的残留内联样式）。
    //   重插后节点在 DOM 但不可见 = getVideoSidebarPresence 判 formSwitched/absent，
    //   悬浮球也被互斥逻辑压住 → 整页"啥都没有"。此处按状态机权威语义恢复：
    //   - userClosed='1'：用户显式 ✕ 关闭，唯一合法的隐藏态，不干预；
    //   - 其余 display:none 且无 _hiddenByFormSwitch 标记：异常残留，清内联恢复显示。
    //   popup sidebarEnabled=false 经 hideSidebar() 隐藏时带 _hiddenByFormSwitch 标记，
    //   不误伤（该开关由 storage.onChanged 路径自行管理显隐）。
    if (getRoot() && document.contains(getRoot()) && getRoot().style.display === 'none'
        && !(getRoot().dataset && getRoot().dataset.userClosed === '1')
        && !_hiddenByFormSwitch && !getHiddenByUserSetting()) {
      console.warn('[VocabRadar][video-sidebar] 看门狗: 侧栏在 DOM 但 display:none 且无 userClosed/formSwitch 标记，恢复显示');
      getRoot().style.display = '';
    }
  });
  _reinjectObs.observe(document.body, { childList: true, subtree: true });
}

// === 同步视频提示高度 = 视频高度（同顶同底） ===
// 反思（2026-07-03）：用户指"youtube, 窗口高度错误"。
//   旧版只查 B站选择器 #playerWrap/.bpx-player-container，YouTube 无这些元素，
//   player 为 null，高度不设置 → 视频提示高度异常（撑满或塌陷）。
//   修正：增加 YouTube 选择器 #movie_player / #player-container-inner / #primary。
//   YouTube 视频提示注入 #secondary，高度应匹配 #primary 内视频播放器高度。
// === 第一百二十三次：测量抽为独立函数（startSyncHeight 与折叠展开共用）===
// 用户反馈"视频侧栏早展开高度低，过一会儿展开正常"——根因：无字幕自动折叠发生在
// 加载早期（播放器尚未撑开），快照的是当时的小高度；布局稳定后展开若只认快照则永远偏矮。
// 展开时对内嵌形态重测一次、与快照取大者：布局未变时两值相等（仍满足"尺寸不变"），
// 早于布局稳定时自动纠正为真实目标高。
// === 第一百二十五次：高度测量重写（用户裁定默认尺寸体系）===
//   竖屏（Shorts 等）：同视频高 —— placeShortsOutside 自管，不经本函数；
//   横屏内嵌（YT/B站桌面）：**视频顶 → 点赞区底**；
//   无锚点可测：返回 0（不写高度）。
// 反思（"极长，延伸到底部全部展示完字幕才停下"）：旧版在播放器未就绪时回退
//   #primary（含评论区，数千 px），0ms 首测即写入近整屏高，且"只增不减"规则
//   将其永久锁死——侧栏比视频高出一大截、字幕全铺开。本次废除该兜底：
//   测不准就不写，等真实锚点出现再写一次到位。
/**
 * 第一百七十六次（用户当面指正"你看错了。视频顶，弹幕列表顶，作者（包括图标关注
 *   按钮一整块）底都在同一水平线。"）：**回撤**第一百七十五次引入的 biliSpanTop /
 *   isBiliInlineBelowPlayerTop / isSpanStartReady 三件套。
 *   第一百七十五次的前提是"作者块占掉了播放器顶那一段、侧栏顶边必然低于视频顶"，
 *   与实际布局相反 —— 作者块整体位于播放器顶**之上**，侧栏落位正确时其顶边本就
 *   与播放器顶边齐平。而"取侧栏自身顶边为跨度起点"在侧栏落位错误（被挤到广告
 *   之下）时会读到远低于播放器顶的值，算出的高度随之失真，把位置缺陷放大成高度
 *   缺陷。故跨度恒为"播放器顶 → 点赞行底"，与用户诉求"与视频齐顶、点赞按钮同底"
 *   一一对应，无需任何 B 站特例。
 */
function measureSyncHeight() {
  // B站横屏：播放器顶 → 点赞投币收藏工具条底
  const bpxPlayer = document.querySelector('.bpx-player-container')
    || document.querySelector('.bpx-player-video-wrap')?.parentElement;
  if (bpxPlayer) {
    const pRect = bpxPlayer.getBoundingClientRect();
    const tb = document.querySelector('#arc_toolbar_report')
      || document.querySelector('.video-toolbar-container-main')
      || document.querySelector('.video-toolbar-left');
    if (tb && tb.getBoundingClientRect().height > 0) {
      // 第一百七十四/一百七十五次曾试图把跨度起点改为侧栏自身顶边，
      //   第一百七十六次已按用户指正回撤（见本函数上方注释）：起点恒为播放器顶边。
      return tb.getBoundingClientRect().bottom - pRect.top;
    }
    return pRect.height;
  }
    // YouTube 横屏：纯播放器画面高度（字幕区底部对齐视频底部）
    // 第一百二十七次反思：上一版按用户字面"视频顶到点赞底"取 actions.bottom-player.top，
    // 实测该跨度含标题/作者区 ≈ 播放器高+250px，在 900px 视口里接近满屏——即本轮反馈的
    // "极长"。回归长期验证过的基线（2026-07-22 裁定），同时开放内嵌态右下角手柄调高，
    // 用户要更长的可自行拉到点赞底。
    const ytPlayer = document.querySelector('#movie_player')
      || document.querySelector('#player-container-inner');
    if (ytPlayer) {
      // 第一百二十八次（用户重申裁定）：横屏默认 = **视频顶 → 点赞区底**。
      //   （撤销第一百二十七次的回归基线——用户本轮明确再次要求该跨度。）
      //   取 ytd-watch-metadata 内 #actions（点赞/分享按钮行）底部；
      //   锥点缺失或异常时回退纯播放器高。视口钳制仍由 apply() 统一承担。
      const pRect = ytPlayer.getBoundingClientRect();
      const actions = document.querySelector('ytd-watch-metadata #actions')
        || document.querySelector('#actions ytd-menu-renderer');
      if (actions) {
        const aRect = actions.getBoundingClientRect();
        if (aRect.height > 0 && aRect.bottom > pRect.bottom) {
          return aRect.bottom - pRect.top;
        }
      }
      return pRect.height;
    }
  // 无可靠锚点：不写高度（等待下次触发）
  return 0;
}

// 第一百七十三次（用户裁定"横屏初始展开半高"是缺陷，应当全高）：
//   规则锚点就绪判据。measureSyncHeight() 在"点赞行尚未渲染"时会静默回退到
//   纯播放器高（只有半高），调用方无从分辨这是规则高度还是残缺读数——这正是
//   "初始半高并被永久锁死"的根因。本函数把该区分显式化：
//     B站   —— #arc_toolbar_report / .video-toolbar-* 已渲染（height>0）；
//     YouTube —— ytd-watch-metadata #actions 已渲染且底边低于播放器底边；
//     其它平台/无播放器 —— 视为"无锚点可等"，返回 true（不阻塞展开与锁定）。
//   两处使用：autoExpandOnce 预置循环的 break 判据 / apply() 是否落本集锁。
function isSpanAnchorReady() {
  try {
    const bpxPlayer = document.querySelector('.bpx-player-container')
      || document.querySelector('.bpx-player-video-wrap')?.parentElement;
    if (bpxPlayer) {
      const tb = document.querySelector('#arc_toolbar_report')
        || document.querySelector('.video-toolbar-container-main')
        || document.querySelector('.video-toolbar-left');
      return !!(tb && tb.getBoundingClientRect().height > 0);
    }
    const ytPlayer = document.querySelector('#movie_player')
      || document.querySelector('#player-container-inner');
    if (ytPlayer) {
      const actions = document.querySelector('ytd-watch-metadata #actions')
        || document.querySelector('#actions ytd-menu-renderer');
      if (!actions) return false;
      const aRect = actions.getBoundingClientRect();
      const pRect = ytPlayer.getBoundingClientRect();
      return (aRect.height > 0 && aRect.bottom > pRect.bottom);
    }
    return true;   // 非双平台：无锚点体系，不阻塞
  } catch (e) { return true; }
}

// 第一百五十四次：播放器高度地板——"你不知道视频大小吗？"视频尺寸是已知量：
// 任何测量跨度若低于播放器实际高度即为无效读数（布局未就绪的部分渲染），
// 以播放器高度兜底。三处使用：autoExpandOnce 预置 / toggleSidebarCollapse 展开 /
// startSyncHeight.apply 写入前。
function getPlayerHeightFloor() {
  try {
    const el = document.querySelector('#movie_player')
      || document.querySelector('.bpx-player-container')
      || document.querySelector('video');
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return (r.height > 60) ? Math.round(r.height) : 0;
  } catch (e) { return 0; }
}
/** 实测跨度＋播放器地板合成最终目标高（≤0 表示暂不可测） */
function measureTargetHeight() {
  const floor = getPlayerHeightFloor();
  let h = measureSyncHeight();
  // 第一百七十五次曾以"B 站侧栏顶边在作者块之下"为由停用播放器地板；
  //   第一百七十六次按用户指正回撤 —— 跨度起点恒为播放器顶边，跨度必 ≥ 播放器高，
  //   地板恒为有效的无效读数过滤器（低于播放器高即布局未就绪的部分渲染）。
  if (floor > 50 && h < floor) h = floor;
  return (h > 100) ? h : 0;
}

// 第一百七十六次：删除第一百七十五次新增的 isSpanStartReady() 与
//   isBiliInlineBelowPlayerTop()。二者都只服务于"B 站跨度起点是侧栏自身顶边"
//   这个已被用户指正为错误的前提（视频顶=弹幕列表顶=作者块底 同一水平线），
//   前提回撤后它们既无调用方也无意义，按"不留兼容性残留"一并清除。

export function startSyncHeight() {
  if (_heightSyncStarted) return;
  _heightSyncStarted = true;
  // 反思（2026-07-06）：旧版 MutationObserver 监听 body 全部 style/class 变化（subtree:true），
  // 反思（2026-07-06）：旧版 MutationObserver 监听 body 全部 style/class 变化（subtree:true），
  // apply() 修改 getRoot().style.height 又触发 observer → 反馈循环导致高频回调。
  // 修正：1) 记录上次高度，仅在高度真正变化时才写入 style（避免不必要 mutation）；
  //       2) 防抖：requestAnimationFrame 合并同一帧内多次触发。
  // 反思（2026-07-06 四次修复）：用户反馈"字幕窗口不见了，即便是普通视频中"。
  // 根因：startSidebar 在视频元素出现后立即调用（早于 waitForVideoReady），
  // 此时 player 容器可能高度极小（如 50px），startSyncHeight 将 height/maxHeight
  // 都设为该极小值 → 视频提示被压到不可见。5 秒超时又太短，视频还没加载完就停止同步。
  // 修正：1) 高度阈值从 h>0 改为 h>100，仅当 player 高度合理时才同步；
  //      2) 观察器超时从 5 秒延长到 30 秒，给视频加载更多时间；
  //      3) sidebar.css 添加 min-height:200px 兜底，确保视频提示最小可见高度。
  // 反思（2026-07-06 五次修复）：用户反馈"字幕窗口消失，窗口错就错吧，只要得有啊"。
  // 根因：maxHeight 内联样式约束内容区域，即使 CSS min-height 生效，flex 子元素仍可能
  // 因 maxHeight 被压缩。修正：不再设置 maxHeight，仅设 height 作为建议高度，
  // 配合 CSS min-height 确保 sidebar 始终可见。
  // 反思（2026-07-10 #84）：_lastHeight 为闭包局部变量，换集重调 startSyncHeight 时被重置为 0，
  // 但旧的高度已写入 style，新计算的 h 若小于旧值会反向缩小高度 → 跳动。
  // 改用模块级 _heightSyncMaxH（换集时显式重置），apply() 只增不减，保证高度稳定。
  let _rafPending = false;
  const apply = () => {
    if (!getRoot()) return;
    // 折叠态不写高度（2026-08-13 第五十二次）：否则固定高度回写 → 折叠态残留空白
    if (_sidebarCollapsed) return;
    // 第一百三十四次：活动冻结（ASR 运行中）——业务活动不得重塑外框
    if (_sizeFrozen) return;
    // 第一百二十三次：浮动形态尺寸自管（Shorts 对位/generic 默认右上角/兜底 CSS），
    // 高度同步仅服务内嵌（inline）形态——避免 100vh 覆盖用户/默认的浮动尺寸
    if (getRoot().dataset.mode === 'float') return;
    // 反思（2026-07-07）：用户反馈"viceoseek一直延伸到评论区了。视频提示底部到视频下方标签下方的分割线"。
    //   根因：旧版用 #playerWrap 高度，B站 #playerWrap（.left-container）包含播放器+标签区+评论区+推荐，
    //   高度过大导致视频提示延伸到评论区。
    //   修正：B站用 .bpx-player-container（纯播放器）+ #viewbox_report（标题/标签区）高度，
    //   即从播放器顶部到标签区下方分割线的高度。YouTube 用 #movie_player 或 #primary 高度。
    // 反思（2026-07-08 #42）：用户要求「bilibili视频提示底线在视频下方点赞下的分割线，确保视频提示一屏幕能显示完。
    //   youyube中则延申到作者栏底」。
    //   B站：保持 .bpx-player-container + #viewbox_report + #arc_toolbar_report（播放器+标题标签+点赞投币收藏），
    //     新增 Math.min(h, window.innerHeight) 限制不超过一屏。
    //   YouTube：改为 #movie_player 顶部到 ytd-video-owner-renderer（作者栏）底部的距离，
    //     不再用 #primary（含评论区导致过高），同样限制不超过一屏。
    // 反思（2026-07-22）：用户要求「视频提示的字幕区底部对齐视频底部」。
    //   旧版累加 viewbox/toolbar（B站）或作者栏（YouTube），导致视频提示延伸到视频下方标签/作者区。
    //   修正：只用视频画面本身高度——B站取 .bpx-player-container 纯播放器高度；
    //   YouTube 取 #movie_player 播放器高度。其他平台保持原逻辑。
    // 第一百二十三次：测量抽为 measureSyncHeight()（折叠展开展开时复用）
    let h = measureTargetHeight();
    // 确保视频提示一屏幕能显示完：高度不超过视口可见区域。
    // 反思（2026-07-09 #46）：旧版 Math.min(h, window.innerHeight) 未扣除视频提示顶部偏移，
    //   视频提示 top=100px 时 h=window.innerHeight(900px) → 底部延伸到 1000px，超出视口。
    //   修正：maxH = window.innerHeight - max(0, sidebarTop)，扣除顶部偏移。
    //   sidebarTop 为负（滚动后视频提示顶部在视口上方）时按 0 处理，可见高度=视口高度。
    // 反思（2026-07-10 #83）：用户再次反馈「视频提示窗口高度还是一团糟，要求高度固定，一屏之内，至少视频高度」。
    //   根因有三：
    //   A) CSS .beaver-panel min-height:80px 阻止 flex 收缩 → 内容多时容器被撑高（已修 CSS）；
    //   B) JS 只设 height 未设 max-height → overflow:visible 时内容溢出视觉上撑高；
    //   C) 未保证「至少视频高度」→ 计算结果可能小于播放器高度。
    //   修正：1) 同时设 height + maxHeight，双重约束容器不超过计算高度；
    //        2) B站计算中确保 h >= bpxPlayer.height（至少视频高度）；
    //        3) 仅当高度合理（>100px）时才写入，避免未就绪时压扁。
    if (h > 100) {
      const sidebarTop = Math.max(0, getRoot().getBoundingClientRect().top);
      const maxH = window.innerHeight - sidebarTop;
      h = Math.min(h, Math.max(maxH, 100));
    }
    // 反思（2026-07-10 #84）：用户要求「高度固定」。
    //   旧版每次 h 变化都写入 style.height，0/500/1500/3000ms 多次计算期间高度反复跳动；
    //   且 h<=100 时清除高度导致视频未就绪时塌陷。
    //   修正：取 _heightSyncMaxH = Math.max(_heightSyncMaxH, h)，只增不减，
    //   仅当最大值增大时才写入 style；h<=100 时保持已有高度不清除，避免塌陷。
    //   换集时由 startSidebar 显式重置 _heightSyncMaxH=0 后重调本函数。
    // 第一百七十四次（用户反馈"bilibili 视频侧栏过高，应当与视频齐顶、点赞按钮同底"）：
    //   旧写入门槛是纯粹的"只增不减"（h > _heightSyncMaxH）。它能防延迟批次期间跳动，
    //   但一旦早期写入过大值（历史的 62% 视口兜底，或播放器全屏/宽屏瞬间的读数），
    //   就永远无法回缩 → 表现为"过高，超出点赞行"。
    //   修正：以**规则锚点是否就绪**分流——
    //     锚点已就绪：measureSyncHeight 给出的"视频顶→点赞底"就是权威值，允许上调也允许
    //       回缩（h !== _heightSyncMaxH 即写），写完立刻落本集锁，本集内不再变动；
    //     锚点未就绪：读数只是过渡值，沿用"只增不减"避免跳动，且不落锁待补高。
    // 第一百七十六次：去掉 isSpanStartReady() 这一附加条件（该函数已随错误前提删除）。
    const _anchorReady = isSpanAnchorReady();
    if (h > 100 && (_anchorReady ? (h !== _heightSyncMaxH) : (h > _heightSyncMaxH))) {
      // 第一百一十九次：折叠期间不写高度（展开时按折叠前精确值还原）
      // 第一百二十二次：用户拖动/调尺寸接管后不再写（尺寸归用户）
      if (_heightSyncPaused || _sidebarCollapsed || _userPlaced
          || (getRoot().classList && getRoot().classList.contains('beaver-sidebar-dragged'))) return;
      // 第一百三十八次（用户裁定"折叠切换/后续活动不得改尺寸；框极长"）：本集高度
      // 一经写入即锁定——字幕渲染、面板增行等一切后续变化不再改写外框，内容区
      // 自行滚动。锁定随换集/重置解锁（_heightSyncMaxH=0 处同步清锁）。
      // 第一百三十八次：本集高度锁——首次同步写入即锁（内容区自行滚动）……
      // 第一百四十七次：微型锁自愈——历史会话可能在布局早期把 <260px 的小值锁死
      // （"横屏展开很矮"根因），此处检测到即解锁允许重写正确值。
      const _curH = parseInt(getRoot().style.height, 10) || 0;
      if (_heightLocked && _curH > 0 && _curH < 260) {
        _heightLocked = false;
        log('[size] 检测到微型锁定(' + _curH + 'px) → 解锁重写');
      }
      if (_heightLocked) return;
      // 第一百一十八次：同步高度钳制视口 90%（防反馈循环导致极长）
      _heightSyncMaxH = Math.min(h, Math.round(window.innerHeight * 0.9));
      getRoot().style.height = _heightSyncMaxH + 'px';
      getRoot().style.maxHeight = _heightSyncMaxH + 'px';  // #83: maxHeight 封顶，防止 overflow:visible 时内容撑高容器
      // 第一百七十三次（"横屏初始展开半高"缺陷）：本集锁只在**规则锚点就绪**后才落。
      //   锚点未就绪时 measureSyncHeight 只能给出纯播放器高（半高），旧代码把它
      //   直接锁死 → 点赞行随后渲染出来也无法再补高。改为：先写这个过渡值让侧栏
      //   可见，但不上锁，留给后续延迟批次/resize 用"只增不减"规则补到规则高度。
      if (_anchorReady) _heightLocked = true;
      log('[size] startSyncHeight 写入 height=' + _heightSyncMaxH + 'px（'
        + (_anchorReady ? '锚点就绪，本集锁定' : '锚点未就绪，暂不锁定待补高') + '）');
    }
    // h<=100 时不清除已有高度（保持 _heightSyncMaxH），避免视频未就绪时塌陷。
    // 仅当从未计算出有效高度（_heightSyncMaxH 仍为 0）时才清空内联样式，让 CSS min-height 兜底。
    if (h <= 100 && _heightSyncMaxH === 0) {
      getRoot().style.height = '';
      getRoot().style.maxHeight = '';
    }
  };
  const debouncedApply = () => {
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => {
      _rafPending = false;
      apply();
    });
  };
  // 第一百二十五次：暴露单次重测入口——字幕到达/面板变化时调用（requestSyncHeightOnce），
  // 兜住"测量锚点晚于首次渲染"的时序空洞（测不准不写的副作用兜底）
  _applyNow = apply;
  // 反思（2026-07-09 #75）：用户要求「高度固定，一屏之内」。
  //   旧版用 MutationObserver 持续监听 body 30 秒，每次 DOM 变化都重算高度，
  //   导致页面动态加载内容（评论/推荐/折叠展开）时视频提示高度反复跳动，"一团糟"。
  //   修正：去掉 MutationObserver，改为多次延迟计算（立即 + 500ms + 1500ms + 3000ms），
  //   等视频和页面布局稳定后固定高度，不再随 DOM 变化跳动。
  //   延迟点 rationale：
  //     - 立即：首屏骨架尽快有高度
  //     - 500ms：B站/YouTube 播放器通常已就位
  //     - 1500ms：标题/标签/点赞区渲染完成
  //     - 3000ms：兜底，慢速网络下布局稳定
  //   resize 监听保留（窗口尺寸变化时需重算），保存引用以便 destroySidebar 清理。
  debouncedApply();
  [500, 1500, 3000].forEach((delay) => {
    const t = setTimeout(debouncedApply, delay);
    _heightSyncTimers.push(t);
  });
  _heightSyncResizeHandler = debouncedApply;
  window.addEventListener('resize', _heightSyncResizeHandler);
}

/**
 * 反思（2026-08-08）：用户要求"悬浮球、侧栏都应当可拖动"。
 * 拖动视频侧栏标题栏时，切换为自由定位模式。
 * 拖动位置保存到 chrome.storage.local，下次加载时恢复。
 *
 * === 第一百二十二次重写 ===
 * 修复过程自纠：旧版 onMove 引用未声明的 _heightSyncTimer（ESM 严格模式抛
 * ReferenceError），且 makeSidebarDraggable 从未被调用——拖动功能整体失效。
 * 重写要点：
 *   - 仅浮动形态（data-mode="float"）由 wireMoveResize 绑定；inline 横屏形态位置
 *     由布局管理，不绑拖动（用户裁定"此形态之外才可移动"）。
 *   - Pointer Events 一套覆盖鼠标/触摸/笔 + setPointerCapture 防指针逃逸
 *     （与 web-sidebar-impl 同方案，其 FF/Edge 兼容性已实证）。
 *   - 拖动置 _userPlaced=true：startSyncHeight / placeShortsOutside 永久停写。
 */
let _sidebarDragging = false;
let _sidebarDragMoved = false;
let _sidebarDragOffsetX = 0;
let _sidebarDragOffsetY = 0;
let _sidebarDragPointerId = null;

function makeSidebarDraggable() {
  if (!getRoot()) return;

  const header = getRoot().querySelector('.beaver-header');
  if (!header) return;

  const startDrag = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // 鼠标仅左键
    // 排除标题栏内的按钮点击（🌐/⋯/◀/📄）
    if (e.target.closest('button')) return;
    _sidebarDragging = true;
    _sidebarDragMoved = false;
    _sidebarDragPointerId = e.pointerId;
    const rect = getRoot().getBoundingClientRect();
    _sidebarDragOffsetX = e.clientX - rect.left;
    _sidebarDragOffsetY = e.clientY - rect.top;
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
  };

  const onMove = (e) => {
    if (!_sidebarDragging || e.pointerId !== _sidebarDragPointerId) return;
    _sidebarDragMoved = true;
    let x = e.clientX - _sidebarDragOffsetX;
    let y = e.clientY - _sidebarDragOffsetY;
    // 边界约束：保持在视口内
    const w = getRoot().offsetWidth;
    const h = getRoot().offsetHeight;
    x = Math.max(0, Math.min(x, window.innerWidth - w));
    y = Math.max(0, Math.min(y, window.innerHeight - h));
    getRoot().classList.add('beaver-sidebar-dragged');
    _userPlaced = true; // 第一百二十二次：接管——高度同步/对位永久停写
    _shortsRealign = null; // 对位已无意义（用户自由定位）
    getRoot().style.left = x + 'px';
    getRoot().style.top = y + 'px';
    getRoot().style.right = 'auto';
    getRoot().style.bottom = 'auto';
    e.preventDefault();
  };

  const endDrag = () => {
    if (!_sidebarDragging) return;
    _sidebarDragging = false;
    _sidebarDragPointerId = null;
    if (_sidebarDragMoved) {
      // 保存拖动位置
      try {
        const rect = getRoot().getBoundingClientRect();
        // 第一百三十四次（用户裁定"位置为页面的相对坐标"）：同时存视口坐标与
        // 文档坐标（doc=视口+滚动）。恢复端优先 doc 坐标——刷新后无论滚到哪，
        // 都回到页面内容的同一相对位置；旧 {left,top} 形状保留兼容读取。
        chrome.storage.local.set({
          videoSidebarPos: {
            left: rect.left, top: rect.top,
            docX: Math.round(rect.left + window.scrollX),
            docY: Math.round(rect.top + window.scrollY)
          }
        });
      } catch (e) { /* ignore */ }
    }
  };

  header.addEventListener('pointerdown', startDrag);
  header.addEventListener('dragstart', (e) => { e.preventDefault(); });
  // window 层 capture 兜底，拖出边界仍能跟踪（同 web-sidebar 实证方案）
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', endDrag, true);
  window.addEventListener('pointercancel', endDrag, true);
}

/**
 * 第一百二十二次新增：右下角手柄调整大小（仅浮动形态）。
 * 对标文本侧栏 makeResizable 的 Win 窗口行为：向右拖增宽、向下拖增高；
 * 约束 280×200 ~ 视口-8；尺寸持久化到 storage.videoSidebarSize。
 * 调整后置 _userPlaced=true 停止一切自动尺寸写入。
 */
let _sidebarResizing = false;
function makeSidebarResizable() {
  if (!getRoot()) return;
  const handle = getRoot().querySelector('#beaver-resize-handle');
  if (!handle) return;

  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    _sidebarResizing = true;
    _userPlaced = true; // 接管
    _shortsRealign = null;
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = getRoot().getBoundingClientRect();
    const startW = rect.width;
    const startH = rect.height;
    // 第一百二十七次：内嵌形态仅调高——宽度由所在列布局驱动，且不得脱离文档流
    const inlineMode = getRoot().dataset.mode === 'inline';
    const maxW = inlineMode ? startW : (window.innerWidth - 8);
    const maxH = window.innerHeight - 8;

    const onMove = (ev) => {
      if (!_sidebarResizing) return;
      if (!inlineMode) {
        const w = Math.max(280, Math.min(startW + (ev.clientX - startX), maxW));
        getRoot().classList.add('beaver-sidebar-dragged');
        getRoot().style.width = w + 'px';
        getRoot().style.maxWidth = w + 'px';
      }
      const h = Math.max(200, Math.min(startH + (ev.clientY - startY), maxH));
      getRoot().style.height = h + 'px';
      getRoot().style.maxHeight = h + 'px';
      ev.preventDefault();
    };
    const endResize = () => {
      if (!_sidebarResizing) return;
      _sidebarResizing = false;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', endResize, true);
      window.removeEventListener('pointercancel', endResize, true);
      try {
        const r = getRoot().getBoundingClientRect();
        chrome.storage.local.set({ videoSidebarSize: { width: Math.round(r.width), height: Math.round(r.height) } });
        log('[size] 用户调整尺寸:', Math.round(r.width) + 'x' + Math.round(r.height) + (inlineMode ? '（内嵌·仅高）' : ''));
      } catch (e) { /* ignore */ }
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', endResize, true);
    window.addEventListener('pointercancel', endResize, true);
  });
}

/** 第一百二十二次新增：恢复持久化的自定义尺寸（仅浮动形态应用） */
function restoreSidebarSize() {
  if (!getRoot() || getRoot().dataset.mode !== 'float') return;
  try {
    chrome.storage.local.get('videoSidebarSize', (res) => {
      const sz = res && res.videoSidebarSize;
      if (!sz || !sz.width || !sz.height) return;
      // 第一百三十二次：恢复前钳制到合理区间——历史会话可能存过很小的值，
      // 原样恢复即"视频侧栏很矮"且每页复现；下限对齐手柄约束（280×240）。
      const w = Math.max(280, Math.min(sz.width, window.innerWidth - 8));
      const h = Math.max(240, Math.min(sz.height, window.innerHeight - 8));
      getRoot().style.width = w + 'px';
      getRoot().style.maxWidth = w + 'px';
      getRoot().style.height = h + 'px';
      getRoot().style.maxHeight = h + 'px';
      log('[size] 恢复自定义尺寸', sz.width + 'x' + sz.height, '→ 钳制后', w + 'x' + h);
    });
  } catch (e) { /* ignore */ }
}

/** 恢复拖动保存的位置 */
// 反思（2026-08-19 第七十九次）：devtools 右侧停靠时视口变窄，保存的左/上像素可能
//   落在新视口外 → 视频侧栏被吃掉。修正：恢复时钳制回当前视口内（同 web-sidebar）。
function restoreSidebarDraggedPosition() {
  if (!getRoot()) return;
  try {
    chrome.storage.local.get('videoSidebarPos', (res) => {
      if (res.videoSidebarPos) {
        const pos = res.videoSidebarPos;
        // 第一百三十四次：优先文档坐标（页面相对）——doc−当前滚动=视口位置，
        // 刷新后随内容归位；旧 {left,top} 视口坐标原样兼容。
        let left = pos.left, top = pos.top;
        if (Number.isFinite(pos.docX) && Number.isFinite(pos.docY)) {
          left = pos.docX - window.scrollX;
          top = pos.docY - window.scrollY;
        }
        getRoot().classList.add('beaver-sidebar-dragged');
        // 第一百三十二次：恢复历史拖动位置=用户接管，自动高度/对位停写
        _userPlaced = true;
        _shortsRealign = null;
        getRoot().style.left = left + 'px';
        getRoot().style.top = top + 'px';
        getRoot().style.right = 'auto';
        getRoot().style.bottom = 'auto';
        // 视口钳制：保存位置超出当前视口（devtools 停靠/窗口缩小/滚动差异）时钳回可见范围；
        //   完全在视口外则回退默认位置。
        const rect = getRoot().getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w = rect.width || 0;
        const h = rect.height || 0;
        if (rect.left >= vw || rect.top >= vh || rect.right <= 0 || rect.bottom <= 0) {
          getRoot().classList.remove('beaver-sidebar-dragged');
          getRoot().style.left = '';
          getRoot().style.top = '';
          getRoot().style.right = '';
          getRoot().style.bottom = '';
          return;
        }
        let x = rect.left;
        let y = rect.top;
        if (w < vw) x = Math.max(0, Math.min(x, vw - w));
        if (h < vh) y = Math.max(0, Math.min(y, vh - h));
        if (x !== rect.left || y !== rect.top) {
          getRoot().style.left = x + 'px';
          getRoot().style.top = y + 'px';
        }
      }
    });
  } catch (e) { /* ignore */ }
}

/**
 * 第一百三十二次新增：↺ 重置位置与尺寸（⋯ 设定菜单项，id=beaver-reset-layout）。
 * 背景：拖动/调尺寸会置 _userPlaced=true 永久停写自动对位与高度同步（122 设计），
 * 历史小尺寸还会经 restoreSidebarSize 每页复活——用户需要一个自愈出口。
 * 行为：清持久化 → 解除接管 → 清定位/尺寸内联样式 → 按形态回落默认：
 *   float+Shorts：触发 resize 让 placeShortsOutside 重对位（同视频矩形）；
 *   float+其他：defaultFloatSize() 竖版 16:9 + 右上角；
 *   inline：清高度后 requestSyncHeightOnce() 重测（视频顶→点赞底体系）。
 */
export function resetSidebarLayout() {
  if (!getRoot()) return;
  try { chrome.storage.local.remove(['videoSidebarPos', 'videoSidebarSize']); } catch (e) { /* ignore */ }
  _userPlaced = false;          // 解除接管：自动对位/同步恢复写入资格
  _heightSyncMaxH = 0;          // 只增不减锁存清零：允许高度回落到真实测量值
  _heightLocked = false;        // 第一百三十八次：重置同步解锁
  _heightSyncPaused = false;
  getRoot().classList.remove('beaver-sidebar-dragged');
  ['left', 'top', 'right', 'bottom', 'transform'].forEach((k) => getRoot().style.removeProperty(k));
  const mode = getRoot().dataset.mode;
  const isShorts = /\/shorts\//i.test(location.pathname);
  if (mode === 'float' && isShorts) {
    // Shorts：清尺寸后由 injectIntoPage 注册的 resize 监听器重新按视频矩形对位
    ['width', 'maxWidth', 'height', 'maxHeight'].forEach((k) => getRoot().style.removeProperty(k));
    try { window.dispatchEvent(new Event('resize')); } catch (e) { /* ignore */ }
    log('[size] 已重置位置与尺寸（Shorts 待重对位）');
  } else if (mode === 'float') {
    // generic 浮动：竖版 16:9 默认身形 + 右上角锚点
    const ds = defaultFloatSize();
    getRoot().style.width = ds.width + 'px';
    getRoot().style.maxWidth = ds.width + 'px';
    getRoot().style.height = ds.height + 'px';
    getRoot().style.maxHeight = ds.height + 'px';
    log('[size] 已重置位置与尺寸（float 竖版 ', ds.width + 'x' + ds.height + '）');
  } else {
    // 内嵌（YouTube #secondary / B站右列）：宽度仍由列布局驱动，清高后立即重测
    ['width', 'maxWidth', 'height', 'maxHeight'].forEach((k) => getRoot().style.removeProperty(k));
    requestSyncHeightOnce();
    log('[size] 已重置位置与尺寸（inline 待重测高度）');
  }
}

// === 第一百二十二次：统一侧栏路由——接收文本侧栏的"展开视频形态"请求 ===
// 文本侧栏悬浮球/🎬 按钮在页面已有视频侧栏时派发 beaver-unified-open
// （派发端 web-sidebar-impl.js expand() 已实现），此处负责展开视频形态。
let _unifiedEventsWired = false;
// 第一百二十四次："选其一"——切到文本形态时被整体隐藏的标记（回程恢复用）
let _hiddenByFormSwitch = false;
export function wireUnifiedFormEvents() {
  if (_unifiedEventsWired) return;
  _unifiedEventsWired = true;
  window.addEventListener('beaver-unified-open', () => {
    if (!getRoot() || !document.contains(getRoot())) return;
    // 第一百三十二次：复活路径统一清 userClosed 标记（✕ 关闭后球点击/🎬 召唤回来）
    if (getRoot().dataset && getRoot().dataset.userClosed) { try { delete getRoot().dataset.userClosed; } catch (e) { /* ignore */ } }
    // 第一百二十四次：若此前因切到文本形态被整体隐藏，先恢复显示
    // 第一百三十二次：✕ 关闭（display:none + userClosed）同样经此恢复
    if (_hiddenByFormSwitch || getRoot().style.display === 'none') {
      getRoot().style.display = '';
      _hiddenByFormSwitch = false;
      log('统一侧栏路由: 恢复视频形态显示');
    }
    if (getRoot().classList.contains('beaver-collapsed')) toggleSidebarCollapse();
    // 内嵌形态可能在视口外（页面已滚动），滚动到可见；浮动形态原地即可
    if (getRoot().dataset.mode !== 'float') {
      try { getRoot().scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* ignore */ }
    }
  });
}

// 窗口 resize 时处理拖动侧栏位置（调试窗口被挤掉问题）
// 第一百二十二次：补挂接（旧版从未被调用=死代码）+ 模块级防重复注册
let _dragResizeWired = false;
export function handleDragResize() {
  if (_dragResizeWired) return;
  _dragResizeWired = true;
  window.addEventListener('resize', () => {
    if (!getRoot() || !getRoot().classList.contains('beaver-sidebar-dragged')) return;
    const rect = getRoot().getBoundingClientRect();
    // 如果侧栏完全在视口外，重置到默认位置
    if (rect.left >= window.innerWidth || rect.top >= window.innerHeight ||
        rect.right <= 0 || rect.bottom <= 0) {
      getRoot().classList.remove('beaver-sidebar-dragged');
      getRoot().style.left = '';
      getRoot().style.top = '';
      getRoot().style.right = '';
      getRoot().style.bottom = '';
    } else {
      // 仅约束位置，不改变尺寸
      let x = rect.left;
      let y = rect.top;
      const w = getRoot().offsetWidth;
      const h = getRoot().offsetHeight;
      x = Math.max(0, Math.min(x, window.innerWidth - w));
      y = Math.max(0, Math.min(y, window.innerHeight - h));
      getRoot().style.left = x + 'px';
      getRoot().style.top = y + 'px';
    }
  });
}

// =============================================================================
// 2026-08-28 拆分第三刀：门面接驳导出。
// 门面（video-sidebar.js）原直接读写的布局状态，拆分后经下列导出访问；
// 语义与原模块级读写完全等价（状态唯一归属本模块，绝无复制）。
// =============================================================================

// 折叠标志：bindEvents 启动强制折叠置 true；诊断探针/时序防御读回
export function setSidebarCollapsedFlag(v) { _sidebarCollapsed = v; }
export function getSidebarCollapsedFlag() { return _sidebarCollapsed; }

// 活动冻结：toggleASR 启动成功置 true（业务活动不得重塑外框，不随停止解冻）
export function setSizeFrozen(v) { _sizeFrozen = v; }

// 换集重置自动折叠配额（setTracks 重试期间最多自动折叠一次）
export function setNoSubAutoCollapseDone(v) { _noSubAutoCollapseDone = v; }

// 切到文本形态时整体隐藏标记（bindEvents 派发 beaver-toggle-form 后置 true）
export function setHiddenByFormSwitch(v) { _hiddenByFormSwitch = v; }

// 停止高度同步：清 timers + 移除 resize 监听器 + 重置 started/maxH/locked
// （原换集分支与 destroySidebar 内联清理序列的等价提取，供两处共用）
export function stopHeightSync() {
  _heightSyncTimers.forEach((t) => clearTimeout(t));
  _heightSyncTimers = [];
  if (_heightSyncResizeHandler) {
    window.removeEventListener('resize', _heightSyncResizeHandler);
    _heightSyncResizeHandler = null;
  }
  _heightSyncStarted = false;
  _heightSyncMaxH = 0;
  _heightLocked = false;
}

// 销毁清理：断开 reinject/heightSync 观察器 + stopHeightSync()
// （原 destroySidebar 内联清理序列的等价提取）
export function teardownLayout() {
  if (_reinjectObs) { _reinjectObs.disconnect(); _reinjectObs = null; }
  if (_heightSyncObs) { _heightSyncObs.disconnect(); _heightSyncObs = null; }
  stopHeightSync();
}
