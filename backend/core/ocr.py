"""OCR 引擎：LLM 多模态（默认，复用 llama-server 视觉能力）/ RapidOCR（可选）分发。

设计：
- llm 引擎：复用 LlmEngine 拉起的 llama-server（models/ 已带 mmproj，启动即多模态），
  内部 POST /v1/chat/completions 发 OpenAI 兼容 image_url（dataURL）消息。
  生命周期归 LlmEngine：resident 预拉 / on-demand 首请求 + inflight 防空闲误杀。
- rapidocr 引擎：进程内模型（PP-OCR 系随 pip 包分发，纯 CPU，无需下载），
  生命周期同 ASR：resident 预加载 / on-demand 空闲卸载，_starting 防重入。
- 结果缓存：不做（LLM/OCR/翻译输入千变万化，命中率低）。
"""

import base64
import gc
import threading
import time

import requests

import config

_OCR_PROMPT = (
    "提取图片中的全部文字。按阅读顺序逐行输出原文，"
    "不要翻译、不要解释、不要添加任何多余内容。若图中没有文字，输出空字符串。"
)


class OcrEngine:
    """OCR 引擎属主（挂 app.extensions["engines"]["ocr"]）。

    llm 引擎把推理与生命周期委托给 LlmEngine 实例；rapidocr 引擎为进程内
    模型，自管加载互斥与空闲卸载（同 AsrEngine 模式）。
    """

    def __init__(self, cfg, llm):
        self.cfg = cfg or {}
        self.llm = llm  # LlmEngine 实例：llm 引擎路径的进程/端口属主
        self.mode = self.cfg.get("mode", "resident")  # 仅 rapidocr 引擎生效
        self._engine = None            # RapidOCR 实例
        self._engine_loaded = None     # 已加载的进程内引擎名（llm 不落在此）
        self._lock = threading.Lock()
        self._starting = False         # 加载互斥标志（同 llm_engine/asr）
        # 手动停机标志（仅 rapidocr 生效）；从 config <ocr>.stopped 恢复：
        # 默认 True（默认全关），重启后仍尊重用户设定
        self._manual_stop = bool(self.cfg.get("stopped"))
        self._last_used = 0.0
        if self.mode == "on-demand":
            threading.Thread(target=self._idle_watch, daemon=True).start()

    # ---- 状态 ----

    def status(self):
        """/api/ocr/status 与 /api/status 用。llm 路径状态透传 LlmEngine。"""
        return {
            "engine": self.cfg.get("engine", "llm"),
            "mode": self.mode,
            "loaded": self._engine is not None,     # rapidocr 进程内模型
            "loading": self._starting,
            "loaded_engine": self._engine_loaded,
            "manual_stop": self._manual_stop,  # 手动停机中（懒加载被抑制）
            "llm": self.llm.status(),
        }

    # ---- 推理 ----

    def recognize(self, image_bytes, mime="image/png", engine=None):
        """识别 → {text}。image_bytes 为原始图片字节（png/jpeg/webp 等）。

        RuntimeError：引擎不可用（llama-server 拉起失败/依赖未装/服务不可达）
        → api 层映射 503；ValueError：图片解码失败 → 400。
        """
        engine = engine or self.cfg.get("engine", "llm")
        if engine == "llm":
            return self._recognize_llm(image_bytes, mime)
        if engine == "rapidocr":
            model, _ = self.ensure_loaded(engine)
            return {"text": self._run_rapidocr(model, image_bytes)}
        raise ValueError(f"未知 OCR 引擎：{engine}")

    def _recognize_llm(self, image_bytes, mime):
        if not self.llm.status()["running"]:
            if not self.llm.auto_start_allowed():  # LLM 手动停机期间不自动拉起
                raise RuntimeError("LLM 引擎已手动停机，请到管理页重新启动后再用 LLM OCR")
            self.llm.start()  # RuntimeError（未安装/超时）上抛，api 映射 503
        data_url = f"data:{mime};base64," + base64.b64encode(image_bytes).decode("ascii")
        payload = {
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": _OCR_PROMPT},
                {"type": "image_url", "image_url": {"url": data_url}},
            ]}],
            "temperature": 0,      # 文字提取要确定性输出
            "max_tokens": 2048,
            "stream": False,
            # Qwen3.5 为思考模型：不关思考会先输出 reasoning（占 max_tokens）
            "chat_template_kwargs": {"enable_thinking": False},
        }
        self.llm.begin_request()  # on-demand 下推理期间不被空闲误杀
        try:
            r = requests.post(f"{self.llm.base_url()}/v1/chat/completions",
                              json=payload, timeout=(10, 600))
            r.raise_for_status()
            text = r.json()["choices"][0]["message"]["content"]
            return {"text": (text or "").strip()}
        except requests.RequestException as e:
            raise RuntimeError(f"LLM 服务不可达：{e}") from e
        except (KeyError, IndexError, ValueError) as e:
            raise RuntimeError(f"LLM 返回格式异常：{e}") from e
        finally:
            self.llm.end_request()

    def _run_rapidocr(self, engine, image_bytes):
        import cv2
        import numpy as np
        img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("图片解码失败（支持 png/jpeg/webp/bmp 等常见格式）")
        self._last_used = time.time()
        result = engine(img)
        txts = getattr(result, "txts", None) or ()  # 无文字时 txts 为 None
        return "\n".join(txts)

    # ---- 生命周期（仅 rapidocr 引擎；llm 引擎归 LlmEngine） ----

    def ensure_loaded(self, engine=None, force=False):
        """确保进程内引擎就绪（懒加载），返回 (model, engine_name)。线程安全。

        force=True（管理页启动按钮）解除手动停机；普通调用在手动停机
        期间拒绝加载（同 ASR）。"""
        engine = engine or self.cfg.get("engine", "llm")
        if engine == "llm":
            raise ValueError("llm 引擎无进程内模型（生命周期归 LlmEngine）")
        if engine != "rapidocr":
            raise ValueError(f"未知 OCR 引擎：{engine}")
        with self._lock:
            if force:
                self._manual_stop = False
                config.set_engine_stopped("ocr", False)  # 持久化用户启动设定（stopped:false）
            elif self._manual_stop:
                raise RuntimeError("OCR 引擎已手动停机，请到管理页重新启动")
            if self._engine is not None and self._engine_loaded == engine:
                self._last_used = time.time()
                return self._engine, engine
            if self._starting:
                raise RuntimeError("OCR 引擎正在加载中，请稍候重试")
            self._starting = True
            try:
                self._engine = self._load_rapidocr()
                self._engine_loaded = engine
                self._last_used = time.time()
                return self._engine, engine
            finally:
                self._starting = False

    def _load_rapidocr(self):
        try:
            from rapidocr import RapidOCR
        except ImportError as e:
            raise RuntimeError(
                "未安装 rapidocr。请运行：pip install rapidocr onnxruntime") from e
        return RapidOCR()

    def _idle_watch(self):
        """on-demand 空闲卸载线程（daemon）。"""
        timeout = self.cfg.get("idle_timeout", 600)
        while True:
            time.sleep(30)
            with self._lock:
                if (self._engine is not None and not self._starting
                        and time.time() - self._last_used > timeout):
                    self._release()

    def _release(self):
        self._engine = None
        self._engine_loaded = None
        gc.collect()

    def stop(self):
        """手动卸载进程内模型（管理界面关停按钮；仅 rapidocr 引擎，llm 归 LlmEngine）。

        RuntimeError：加载中无法关停；ValueError：llm 引擎无进程内模型。"""
        engine = self.cfg.get("engine", "llm")
        if engine != "rapidocr":
            raise ValueError(f"OCR 当前由 {engine} 引擎承载，无独立进程内模型"
                             f"（llm 引擎的生命周期归 LLM 行管理）")
        with self._lock:
            if self._starting:
                raise RuntimeError("OCR 引擎正在加载中，请稍候再关停")
            self._manual_stop = True  # 业务请求不再自动重新加载
            self._release()
        config.set_engine_stopped("ocr", True)  # 持久化主动关停（移除键回落默认停机）
