// =============================================================================
// SW 网站素材解析编排（2026-09-27 拆分自 service-worker.js）
// 职责：PARSE_MATERIAL（vocabradar-bridge 转发）按 kind 分流：
//   link → 抓 HTML + offscreen 提正文；image → OCR 链路；asr → 在线转写；
//   document → offscreen parse-doc；llm → 对话；translation → 桥接翻译快路径。
// 分工契约见 docs/桥接网站.md §4.2（网站阶段二 §5，各处理方不混用）。
// =============================================================================
import { b64ToUint8, pcmF32ToWavBlob } from './util.js';
import { ensureOffscreenHost } from './offscreen.js';
import { handleOcrRecognize } from './ocr.js';
import { llmTranscribeBlob } from './asr.js';
import { resolveLlmEngineCfg, handleLlmChat } from './llm.js';
import { handleBridgeTranslation } from './translate.js';

// === G4（2026-09-08）：网站素材解析（vocabradar-bridge 转发的 PARSE_MATERIAL） ===
// 分工契约（网站阶段二 §5，各处理方不混用）：链接→SW 抓 HTML + offscreen Defuddle 提正文；
//   图片→复用 OCR 链路；视频站（YouTube/B站）→ 字幕/转写有专门链路（FETCH_SUBTITLE/ASR），
//   抓 HTML 提不出正文，明示引导走扩展页面工作流（code:'video-link'，网站侧有对应文案）；
//   文档→offscreen parse-doc 解析（B2，2026-09-10：pdf/docx/epub，文件字节 b64 透传）。
// Firefox：无 chrome.offscreen（F1，2026-09-10 起）→ 经 ensureOffscreenHost 走后台页内
//   回退 iframe（同宿主同协议），图片 OCR/链接/文档解析全部可用，不再是报错边界。
export async function handleParseMaterial(kind, payload) {
  if (kind === 'link') {
    const url = String((payload && payload.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url: ' + url };
    if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be|bilibili\.com)\//i.test(url)) {
      return { ok: false, code: 'video-link', error: 'video site link — use the extension player workflow' };
    }
    const res = await fetch(url, { redirect: 'follow', credentials: 'omit' });
    if (!res.ok) throw new Error('fetch ' + res.status + ' ' + url);
    const html = await res.text();
    const host = await ensureOffscreenHost();   // F1：Firefox 走后台页内回退 iframe，链接解析不再报错
    if (!host.ok) throw new Error('offscreen 宿主不可用：' + (host.error || 'unknown'));
    const resp = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_EXTRACT_TEXT',
      html: html,
      baseUrl: url
    }).catch((e) => ({ ok: false, error: String(e.message || e) }));
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'offscreen no response');
    return { ok: true, text: resp.text, title: resp.title };
  }
  if (kind === 'image') {
    const r = await handleOcrRecognize((payload && payload.imageDataUrl) || '', (payload && payload.lang) || 'eng');
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'ocr failed' };
    return { ok: true, text: r.text };
  }
  if (kind === 'asr') {
    // P 批（2026-09-11）：网站卷轴听说回退——浏览器 Web Speech 不可用时，网页把
    // 跟读录音（audio/webm dataURL）发来走扩展转写。
    // 第三百九十四次（plan 阶段二③，用户裁定「扩展不再保留这两个模型」）：whisper
    //   本地推理移除后此处只剩在线 LLM 转写单一路径（resolveLlmEngineCfg('asr') +
    //   llmTranscribeBlob）。协议见桥接扩展.md §2.2。
    // 第三百九十四次：312 批的「在线失败降级本地 whisper」随模型移除一并删除，
    //   失败如实报错不遮蔽；mime 修复（310 批声称但未落盘）保留：从 dataURL 头解析
    //   真实 mime，extMap 反查扩展名。
    const audioDataUrl = String((payload && payload.audioDataUrl) || '');
    // W批（2026-09-20）：lang 兜底改读扩展 learnLanguage——旧兜底硬编码 'en'，网页音视频
    //   路径不传 lang（undefined）时中文音频被强制英文转写 → whisper 返回空（本次
    //   《世界赠与我的》报障链路一环）。learnLanguage 是 ASR 语言真源（L895 在线路径
    //   本就以它兜底），仍缺省才落 'en'。话筒路径显式传 BCP-47 不受影响。
    let lang = String((payload && payload.lang) || '');
    if (!lang) {
      try {
        lang = String((await new Promise((r) => chrome.storage.local.get({ learnLanguage: 'en' }, r))).learnLanguage || 'en');
      } catch (_) { lang = 'en'; }
    }
    if (!audioDataUrl) return { ok: false, error: 'asr payload missing audioDataUrl' };
    const b64Part = audioDataUrl.replace(/^data:[^;]+;base64,/, '');
    // 312 批补做 310 丢失修复：dataURL 头解析 mime → 扩展名映射
    const mimeMatch = audioDataUrl.match(/^data:([^;,]+)/i);
    const mime = (mimeMatch && mimeMatch[1]) || 'audio/webm';
    const EXT_BY_MIME = {
      'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
      'audio/mp3': 'mp3', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a',
      'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/aac': 'aac',
    };
    const ext = EXT_BY_MIME[mime] || 'bin';
    let learn = lang;
    try { learn = (await new Promise((r) => chrome.storage.local.get({ learnLanguage: lang }, r))).learnLanguage || lang; } catch (_) { }
    try {
      const cfg = await resolveLlmEngineCfg('asr');
      // 316次（用户"送入模型之前应当转换，包括网页送入"）：网页送入的录音在送在线
      //   LLM 转写引擎前先客户端转换——原始 webm/opus 裸送既有模型端兼容性风险又
      //   浪费带宽；先经 offscreen 解码+重采样 16k 单声道（与分片路径 handleSegmentByLlm
      //   的 pcmF32ToWavBlob(pcm,16000) 同款），再编码 WAV 送转写。转换失败 console.warn
      //   后回退原始 blob 直送（保底不阻断，错误如实透出不遮蔽）。
      // 317次（用户"只压缩，不扩增"）：转换不得让体积变大——16k 16bit WAV 恒定
      //   256kbps，原始低码率 webm/opus 常见约 32kbps，长录音转完反而扩增约 8 倍。
      //   编码前先估算（44 头 + pcm×2 字节，16bit；与 pcmF32ToWavBlob 产物严格一致）
      //   ≥ 原始字节数（base64 还原近似）则返回 null 省掉编码 CPU，外层回退原始
      //   直送；只有真变小时才送 WAV。
      async function toWavBlob() {
        const host = await ensureOffscreenHost();
        if (!host.ok) throw new Error('offscreen 宿主不可用：' + (host.error || 'unknown'));
        const resp = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_AUDIO_DECODE',
          webmB64: b64Part
        }).catch((e) => ({ ok: false, error: String(e.message || e) }));
        if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'offscreen decode no response');
        const pcm = new Float32Array(b64ToUint8(resp.pcmB64).buffer);
        const wavEst = 44 + pcm.length * 2;                  // 16bit 单声道 WAV 总字节
        const rawLen = Math.floor(b64Part.length * 3 / 4);   // base64 还原原始字节近似
        if (wavEst >= rawLen) return null;                   // 317次：转了更大 → 不转
        return pcmF32ToWavBlob(pcm, resp.sampleRate || 16000);
      }
      // 318次（用户"asr送入模型之前，先判定后转而不是反过来"）：mime 先判定是否值得
      //   转，判定不过就不解码——16k 16bit WAV 恒定 256kbps，有损格式（webm/opus/
      //   mp3/m4a/aac/ogg）码率远低于此，转完几乎必扩增，317 次的 wavEst≥rawLen
      //   校验却要解码完才能算（顺序反了）。故仅无损大格式（wav/flac，源码率恒高，
      //   降 16k 单声道几乎必变小）走解码+转换；有损一律原始直送。wavEst 校验保留
      //   在 toWavBlob 内作二次防线（防"高码率有损"等边缘）。
      const LOSSLESS_MIMES = new Set(['audio/wav', 'audio/x-wav', 'audio/flac', 'audio/x-flac']);
      const worthConverting = LOSSLESS_MIMES.has(mime);
      let blob;
      let fileName = 'audio.' + ext;
      try {
        blob = worthConverting ? await toWavBlob() : null;
        if (blob) {
          fileName = 'segment.wav';
        } else {
          // 317次：只压缩不扩增——转换产物不小于原始字节（或 mime 判定不值得转），回退原始直送
          console.info(`[VocabRadar][sw] mime=${mime} 不转 16k WAV（${worthConverting ? '预估不小于原始' : '有损格式不解码'}），原始直送`);
          blob = new Blob([b64ToUint8(b64Part)], { type: mime });
        }
      } catch (eConv) {
        console.warn('[VocabRadar][sw] 音频预转换（解码+16k WAV）失败，回退原始直送:', eConv);
        blob = new Blob([b64ToUint8(b64Part)], { type: mime });
      }
      // 313 批（2026-09-14 用户报「Network is slow — 持续了很久，不报错也不转入本地
      // 推理」）：在线转写加 90s 超时——此前 fetch 无 signal，网络慢时无限挂起永不进
      // catch。AbortController 中断后 AbortError 转可读文案，与其它失败同样进外层
      // catch 如实报错（第三百九十四次：降级本地推理已随 whisper 移除）。
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90000);
      let text;
      try {
        text = await llmTranscribeBlob(blob, cfg, learn, fileName, ctrl.signal);
      } catch (err) {
        if (err && err.name === 'AbortError') throw new Error('在线转写超时（90 秒）：网络过慢或端点无响应，请稍后重试或检查后端地址');
        throw err;
      } finally {
        clearTimeout(timer);
      }
      // W批（2026-09-20）：在线转写只能产出纯文本（无时间戳），segments 置 null（协议
      // 允许缺省）；空结果 warn 留痕不静默（本地路径同口径）
      const onlineText = String(text || '').trim();
      if (!onlineText) {
        console.warn('[VocabRadar][sw] 在线转写空结果: engine=' + (cfg && cfg.engine || '?') + ' lang=' + learn + '（无时间戳可带，segments=null）');
      }
      return { ok: true, text: onlineText, segments: null };
    } catch (e) {
      // 第三百九十四次：whisper 移除后无本地降级，失败如实透出（不遮蔽）
      return { ok: false, error: '在线转写失败：' + String((e && e.message) || e) };
    }
  }
  if (kind === 'document') {
    // B2（2026-09-10）：文档解析——offscreen 侧 parse-doc.js（与 guide/parser.js 同源，
    // 复用包内 unpdf/mammoth + parser-epub，零新增 vendor）。文件字节 b64 透传
    // （runtime message JSON 序列化约束），offscreen 侧 atob 还原后按 docKind 分流。
    const docKind = String((payload && payload.docKind) || '');
    const b64 = String((payload && payload.b64) || '');
    const name = String((payload && payload.name) || '');
    if (!b64) return { ok: false, error: 'document payload missing b64' };
    const host = await ensureOffscreenHost();   // F1：Firefox 走后台页内回退 iframe，文档解析不再报错
    if (!host.ok) throw new Error('offscreen 宿主不可用：' + (host.error || 'unknown'));
    const resp = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_PARSE_DOC',
      docKind: docKind,
      b64: b64,
      name: name
    }).catch((e) => ({ ok: false, error: String(e.message || e) }));
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'offscreen no response');
    return { ok: true, text: resp.text };
  }
  if (kind === 'llm') {
    // W1（2026-09-11）：网站卷轴 AI 通道（桥接扩展.md §4.2 kind:'llm'）——阅读理解
    //   AI 生成、AI 润色共用。复用扩展聊天 handleLlmChat（llm* 配置 + 免费源轮替），
    //   prompt 单串直传；超 12000 字符明示拒绝（网站侧 extParseChannel 先拦，双保险）。
    const prompt = String((payload && payload.prompt) || '');
    if (!prompt) return { ok: false, error: 'llm payload missing prompt' };
    if (prompt.length > 12000) return { ok: false, error: 'prompt too long (max 12000 chars)' };
    const out = await handleLlmChat([{ role: 'user', content: prompt }]);
    if (!out.ok) return { ok: false, error: out.error };
    return { ok: true, text: String(out.content || '').trim() };
  }
  if (kind === 'translation') {
    // 343 次（2026-09-19）：网站侧单词翻译通道（桥接网站.md §4.2 kind:'translation'，
    //   消费方网站 translateService 第③级「扩展桥」）。网站侧超时仅 3s 且任何一次
    //   失败（含超时）置 _extCapability=false 本会话熔断不再试探——故本分支只走
    //   「有界快路径」：词典缓存直读（SW 属主 IDB，毫秒级，含原形回退）→ 词典直查
    //   快渠道并行（BaiduSug + YoudaoDict，单词场景最快、国内免签名）；慢渠道
    //   （MyMemory/Google/Bing 等）与 LLM 一概不碰（最坏 55s 必超时毒化能力记忆）。
    //   总预算 2.2s（Promise.race 兜底，给桥转发+回传留 ~0.8s 余量）。
    // 343 次·裁定（用户「空文本降级」）：快路径失败（快渠道全挂/超预算）返回
    //   { ok: true, text: '', error: 原因 } 而非 ok:false——网站侧对 ok:false 一律
    //   reject→熔断 _extCapability 本会话不再试探，而 ok:true+空 text 走其既有
    //   空分支（translateService L115）=null 降级第④级 Worker API 且不熔断。
    //   错误不遮蔽：error 字段照带 + SW 控制台 warn 照打；仅 payload 缺 word
    //   （调用方 bug）仍 ok:false。
    const r = await Promise.race([
      handleBridgeTranslation(payload),
      new Promise((res) => setTimeout(() => res({ ok: true, text: '', error: 'bridge translation budget (2.2s) exceeded' }), 2200))
    ]);
    return r;
  }
  // 312 批注：音频走上方 kind === 'asr' 分支（本地推理 / 在线失败自动降级本地）；
  // 此处兜底=其余未支持类型明示报错（不静默成功）
  return { ok: false, error: 'kind not supported: ' + kind };
}
