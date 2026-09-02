// VocabRadar 视频侧栏 · ASR 进度条 DOM 子模块（第一百三十八次拆分第一刀）
//
// 用户裁定："有的文件太大拆分"——video-sidebar.js（~4900 行）按功能切块，
// 本模块为第一刀：进度条的纯 DOM 三函数（显示/隐藏/百分比填充）。
// 只依赖根元素获取器，零业务逻辑、零反向依赖——video-sidebar.js 经 init 注入
// getRoot，避免循环 import；后续刀口（录制工作流/footer 动作）照此模式推进。
// updateASRProgressFromStage 因耦合闸门评估/诊断日志，暂留主文件，待 deps
// 注入方案覆盖 evaluateGate/pushDiagLine 后再切。

/** 根元素获取器（由 video-sidebar.js init 注入：() => _root） */
let _getRoot = () => null;

/**
 * 注入依赖（幂等，重复调用以最后一次为准）。
 * @param {{getRoot: () => HTMLElement|null}} deps
 */
export function initAsrProgress({ getRoot } = {}) {
  if (typeof getRoot === 'function') _getRoot = getRoot;
}

/** 显示进度条并设置阶段文本和详情 */
export function showASRProgress(stage, detail) {
  const root = _getRoot();
  if (!root) return;
  const bar = root.querySelector('#beaver-asr-progress');
  const stageEl = root.querySelector('#beaver-asr-progress-stage');
  const detailEl = root.querySelector('#beaver-asr-progress-detail');
  if (bar) bar.style.display = '';
  if (stageEl) stageEl.textContent = stage || '';
  if (detailEl) detailEl.textContent = detail || '';
  // 第一百三十九次（用户反馈"切换 ASR 后字幕区压缩为无"）：进度行出现会挤占
  // 固定外框内的面板空间（面板地板 120px）。若当前外框高度不足以容纳
  // 「其他固定行 + 面板地板」，一次性补偿差额到外框——属可用性让步，
  // 与"ASR 不重塑窗口"冲突处已折中：只在将压穿地板时发生，且写日志留痕。
  try {
    const PANEL_FLOOR = 120;
    const deficit = PANEL_FLOOR - (root.clientHeight - _fixedRowsHeight(root));
    if (deficit > 0 && root.dataset.mode !== 'float') {
      const cur = parseInt(root.style.height, 10) || root.getBoundingClientRect().height;
      const grown = Math.min(Math.round(cur + deficit), Math.round(window.innerHeight * 0.96));
      if (grown > cur) {
        root.style.height = grown + 'px';
        root.style.maxHeight = grown + 'px';
        console.log('[VocabRadar][video-sidebar][size] ASR 进度出现 → 外框亏损补偿 +' + (grown - cur) + 'px（防字幕区压穿）');
      }
    }
  } catch (e) { /* ignore */ }
}

/** 外框内除主面板外的固定行总高（header/tabs/toolbar/asr-progress/footer） */
function _fixedRowsHeight(root) {
  let h = 0;
  for (const sel of ['.beaver-header', '.beaver-tabs', '.beaver-toolbar', '.beaver-asr-progress', '.beaver-footer']) {
    const el = root.querySelector(sel);
    if (el && el.style.display !== 'none') h += el.getBoundingClientRect().height;
  }
  return h;
}

/** 隐藏进度条 */
export function hideASRProgress() {
  const root = _getRoot();
  if (!root) return;
  const bar = root.querySelector('#beaver-asr-progress');
  if (bar) bar.style.display = 'none';
}

/** 设置进度条填充百分比 (0-100)；NaN/越界防御后写入 */
export function updateASRProgressFill(pct) {
  const root = _getRoot();
  if (!root) return;
  // NaN 防御：pct 非有限数字时设为 0，避免 'NaN%' 显示
  const safePct = (typeof pct === 'number' && isFinite(pct)) ? pct : 0;
  const fill = root.querySelector('#beaver-asr-progress-fill');
  if (fill) fill.style.width = Math.max(0, Math.min(100, safePct)) + '%';
}
