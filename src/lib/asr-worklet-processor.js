/* VocabRadar ASR AudioWorklet 处理器
 *
 * 作用：在 AudioWorklet 线程中持续采集 video.captureStream() 的音频 PCM，
 *   累积到 ASR_PCM_CHUNK 帧后通过 port.postMessage 传输到主线程（asr-client.js）。
 *
 * 反思（2026-07-09）：用户反馈「依旧过一会全是静音」。根因：旧版 ScriptProcessorNode
 *   是已废弃 API，onaudioprocess 回调在主线程执行，标签页后台/主线程繁忙时回调被挂起，
 *   _fallbackPcmBuffer 恒空 → 每段都走 fallback-silent 全静音分支。AudioWorklet 在独立的
 *   音频线程运行，不受主线程阻塞影响，是现代替代方案。
 *
 * 文件加载：通过 chrome.runtime.getURL('src/lib/asr-worklet-processor.js') 由
 *   audioCtx.audioWorklet.addModule() 加载，需在 manifest web_accessible_resources 中声明。
 *
 * AudioWorkletGlobalScope 全局变量：registerProcessor / sampleRate / currentTime。
 *   不能用 ES module 的 import/export，但本文件本身就是 module（addModule 加载）。
 *
 * PCM 传输：process() 每次 128 帧（render quantum），累积到 ASR_PCM_CHUNK(4096) 帧
 *   再 postMessage 一次，减少消息频率。用 Transferable 传输 ArrayBuffer 避免拷贝。
 */

const ASR_PCM_CHUNK = 4096;

class AsrProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._length = 0;
  }

  /**
   * 处理音频块（每 128 帧调用一次，在音频线程）
   * @param {Float32Array[][]} inputs - 输入音频（inputs[0][0] = 第1输入第1声道）
   * @returns {boolean} true 保持节点存活，false 停止
   */
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      const chunk = new Float32Array(input[0]);
      this._chunks.push(chunk);
      this._length += chunk.length;
      if (this._length >= ASR_PCM_CHUNK) {
        const merged = new Float32Array(this._length);
        let offset = 0;
        for (const c of this._chunks) {
          merged.set(c, offset);
          offset += c.length;
        }
        this.port.postMessage(merged, [merged.buffer]);
        this._chunks = [];
        this._length = 0;
      }
    }
    return true;
  }
}

registerProcessor('asr-processor', AsrProcessor);
