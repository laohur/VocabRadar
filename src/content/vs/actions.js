// =============================================================================
// vs/actions.js —— 侧栏交互动作子模块
// -----------------------------------------------------------------------------
// 职责：speakWordVideo()（Web Speech API 朗读单词，随 learnLanguage 设置）、
//       runVideoQuery()（query 标签查询，复用 th/panel 卡片，Shadow DOM 承载）、
//       onLearnClickVs()（learn 按钮：字幕正文+生词组装草稿入缓存并跳转我的卷轴）、
//       autoStartASR()（已废弃的无字幕自动识别入口，保留供未来恢复）。
// 关系：依赖 ./asr-flow.js（toggleASR）、./logger.js、../../lib/i18n.js（t）、
//       ./toast.js、../th/panel.js、../ws/draft-export.js、./subtitle-renderer.js；
//       经受控循环 import 对门面读状态（getVideoLearnLang/isASRActive/getRoot/
//       currentVideoKey）——本模块顶层仅 import 与函数声明，门面绑定调用仅在
//       函数体内发生（运行时门面已初始化完毕，安全）。
//       等价改写：原直读活模块变量 `_root`/`_asrActive`/`_videoLearnLang` 改走
//       门面接驳 getter（同一时点语义等价）。
//       门面经 export 接驳导出 autoStartASR（引用方符号不变）。
// =============================================================================

import { buildPanelCss, buildCardInnerHTML, renderQueryCard, bindLemmaChipClick } from '../th/panel.js';
import { saveDraftToCache, djb2Hash, getSiteUrl } from '../ws/draft-export.js';
import { t } from '../../lib/i18n.js';
import { log } from './logger.js';
import { toast } from './toast.js';
import { toggleASR } from './asr-flow.js';
import { buildSubtitleBody, getAllAnnotations } from './subtitle-renderer.js';
import { getRoot, getVideoLearnLang, isASRActive, currentVideoKey } from '../video-sidebar.js';

/**
 * 视频侧栏朗读单词（Web Speech API），使用 learnLanguage 设置语音。
 * 用户要求"音标前加一个喇叭按钮"。
 * @param {string} word 要朗读的单词
 */
export function speakWordVideo(word) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(word);
    utter.lang = getVideoLearnLang() === 'zh' ? 'zh-CN' : getVideoLearnLang();
    utter.rate = 0.9;
    window.speechSynthesis.speak(utter);
  } catch (_) { /* ignore */ }
}

/**
 * query 标签查询：结果卡复用右键搜索唯一定义（th/panel.js），Shadow DOM 承载
 * 防卡片 CSS 泄漏宿主页；与文本侧栏 runSidebarQuery 同构。
 * @param {string} text 查询文本（空则回空态提示）
 */
export async function runVideoQuery(text) {
  const _root = getRoot();
  const box = _root.querySelector('#beaver-vs-query-result');
  if (!box) return;
  const trimmed = String(text || '').trim();
  const input = _root.querySelector('#beaver-vs-query-input');
  if (input && trimmed) input.value = trimmed;
  if (!trimmed) {
    box.innerHTML = '<div class="beaver-query-tip">' + t('ws.queryTip') + '</div>';
    return;
  }
  box.innerHTML = '';
  const host = document.createElement('div');
  box.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  // 字号基准 14px（用户报"查询窗口只有 https://localhost:3001 字号才会偏大"）：
  //   本内嵌卡与文本侧栏 query 标签同构——嵌套 host 被 `#beaver-sidebar * { font-size: inherit }`
  //   锁死继承侧栏宿主 16px，卡根节点写死 14px 与右键面板/tooltip 同基准（同修详见 ws/ui.js）
  shadow.innerHTML = '<style>' + buildPanelCss() + '</style>'
    + '<div class="beaver-query-card" style="padding:10px 12px;background:#fbfdf9;border-radius:8px;font-size:14px;line-height:1.5;">'
    + buildCardInnerHTML() + '</div>';
  bindLemmaChipClick(shadow);
  try {
    await renderQueryCard(shadow, trimmed);
  } catch (e) {
    console.error('[VocabRadar][video-sidebar] query 标签查询失败:', e);
  }
}

/**
 * learn 按钮（🎯）：视频侧栏草稿导入——字幕正文（buildSubtitleBody）+ 生词
 * （getAllAnnotations，trim+小写去重）组装草稿，id 前缀 ext-v- 与网页草稿区分
 * （同视频换集/换页各自成稿），复用 ws/draft-export 的缓存 upsert（网站按
 * id+version 幂等）；成功后跳转站点「我的卷轴」（getSiteUrl：本地构建跳本地、
 * 商店安装跳线上）。无正文 toast 提示不静默，失败 toast 原因。
 */
export async function onLearnClickVs() {
  try {
    const body = await buildSubtitleBody();
    const text = String(body || '').trim();
    if (!text) { toast(t('learn.noContent')); return; }
    const title = (document.title || '').trim() || location.hostname;
    const words = [];
    const seen = new Set();
    for (const a of getAllAnnotations()) {
      const w = (a && typeof a.word === 'string') ? a.word.trim() : '';
      if (!w) continue;
      const k = w.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      words.push(w);
    }
    const draft = {
      id: 'ext-v-' + djb2Hash(currentVideoKey() + '|' + title),
      title: title,
      lang: getVideoLearnLang() || 'en',
      text: text,
      words: words,
      source: { type: 'extension-video', url: location.href },
      version: 1,
      createdAt: Date.now()
    };
    await saveDraftToCache(draft);
    log('learn 草稿已入缓存 id=' + draft.id + ' words=' + words.length);
    toast(t('learn.importOk'));
    window.open(getSiteUrl() + '/#/my-scrolls', '_blank');
  } catch (e) {
    console.error('[VocabRadar][video-sidebar] learn 草稿导入失败:', e);
    toast(t('learn.importFail'));
  }
}

// === 自动启动 ASR（已废弃，保留函数供未来需要时恢复）===
// 用户反馈"语音识别为啥一直选中，哪怕是刷新网页"：无字幕时自动调用 autoStartASR()
// 会每次刷新都自动启动 ASR，语音识别按钮一直处于选中态。现 video-controller
// 不调用此函数，改为显示"无字幕"提示，用户可手动点击 🎤 按钮或选择 ASR 轨道启动。
// 函数保留不删除，以防未来需要恢复自动启动行为。
export function autoStartASR() {
  const _root = getRoot();
  if (!_root) return;
  if (isASRActive()) return;  // 已在运行则不重复启动
  // sidebar 被隐藏（display:none，关闭按钮/隐藏参数所致）时不自动启动 ASR
  if (_root.style.display === 'none') return;
  log('无常规字幕，自动启动 ASR 作为字幕轨道');
  toggleASR(0, 0);
}
