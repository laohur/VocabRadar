"""翻译引擎：多模型并存，config <translate>.model 选模型（值 = 模型名）。

- "nllb"（默认）：NLLB-200-distilled-600M（CTranslate2 int8 CPU），快，字幕/
  高频场景；模型文件交 huggingface_hub 自动维护：先 hub 本地缓存直取
  （local_files_only，就绪绝不联网），无缓存才联网 snapshot_download
  （断点续传，尊重 HF_ENDPOINT 镜像）。推理 ctranslate2.Translator（CPU
  int8）+ sentencepiece 分词；语言码 2 字 → FLORES-200，src="auto" 按
  Unicode 脚本区间探测。
- 其他值 = translate_llm.cards 的卡片名（如 IndexTeam/Index-Translate-2B-
  GGUF:Q4_K_M）：走翻译专用 llama-server 实例（app 装配的 translate_llm
  引擎，内部端口 7789，与对话 LLM 的 7788 实例分开启停、分开选卡），
  OpenAI /v1/chat/completions；提示词对齐 IndexTeam 官方 translate.py
  客户端（instTrans 规范的纯翻译形态），贪心解码 + enable_thinking=False，
  <think> 块兜底剥离。质量高，速度慢于 NLLB 一个量级，且首请求可能触发
  llama-server 冷启动。
- 生命周期同 ASR（进程内 NLLB 模型）：resident 随启动预加载（model≠nllb
  时不预加载，NLLB 挂着无用）/ on-demand 首请求加载 + 空闲卸载 +
  _starting 互斥；手动停机持久化 config.json <translate>.stopped，管理页
  可启停。translate_llm 实例的生命周期归该实例（总览页「翻译 LLM」行）。
- 缓存不做：翻译输入千变万化命中率低。
"""

import gc
import os
import threading
import time

import requests

import config

# 预转换 CT2 int8 模型仓库（含 model.bin / sentencepiece.bpe.model /
# shared_vocabulary.txt；许可证 cc-by-nc-4.0，本地自用）
_MODEL_REPO = "JustFrederik/nllb-200-distilled-600M-ct2-int8"

# 2 字语言码 → FLORES-200（覆盖 ui/pages.js LANGS / 扩展端 i18n TRANSLATE_LANGS 42 语）
_FLORES = {
    "en": "eng_Latn", "zh": "zho_Hans", "hi": "hin_Deva", "es": "spa_Latn",
    "fr": "fra_Latn", "ar": "arb_Arab", "bn": "ben_Beng", "pt": "por_Latn",
    "ru": "rus_Cyrl", "ur": "urd_Arab", "id": "ind_Latn", "de": "deu_Latn",
    "ja": "jpn_Jpan", "tr": "tur_Latn", "fil": "fil_Latn", "vi": "vie_Latn",
    "ta": "tam_Taml", "ko": "kor_Hang", "fa": "pes_Arab", "it": "ita_Latn",
    "ms": "zsm_Latn", "pl": "pol_Latn", "uk": "ukr_Cyrl", "nl": "nld_Latn",
    "ro": "ron_Latn", "sh": "hrv_Latn", "el": "ell_Grek", "hu": "hun_Latn",
    "cs": "ces_Latn", "sv": "swe_Latn", "he": "heb_Hebr", "bg": "bul_Cyrl",
    "da": "dan_Latn", "fi": "fin_Latn", "nb": "nob_Latn", "sk": "slk_Latn",
    "ca": "cat_Latn", "lt": "lit_Latn", "sl": "slv_Latn", "mk": "mkd_Cyrl",
    "lv": "lvs_Latn", "is": "isl_Latn",
}

# 2 字语言码 → 中文名（LLM 提示词用；与官方 translate.py LANG_NAMES 对齐，
# 缺的语种按通行中文名补齐；未知码回落原码——模型侧 150 语自识）
_LANG_NAMES_ZH = {
    "en": "英语", "zh": "中文", "hi": "印地语", "es": "西班牙语", "fr": "法语",
    "ar": "阿拉伯语", "bn": "孟加拉语", "pt": "葡萄牙语", "ru": "俄语",
    "ur": "乌尔都语", "id": "印尼语", "de": "德语", "ja": "日语",
    "tr": "土耳其语", "fil": "菲律宾语", "vi": "越南语", "ta": "泰米尔语",
    "ko": "韩语", "fa": "波斯语", "it": "意大利语", "ms": "马来语",
    "pl": "波兰语", "uk": "乌克兰语", "nl": "荷兰语", "ro": "罗马尼亚语",
    "sh": "塞尔维亚-克罗地亚语", "el": "希腊语", "hu": "匈牙利语",
    "cs": "捷克语", "sv": "瑞典语", "he": "希伯来语", "bg": "保加利亚语",
    "da": "丹麦语", "fi": "芬兰语", "nb": "书面挪威语", "sk": "斯洛伐克语",
    "ca": "加泰罗尼亚语", "lt": "立陶宛语", "sl": "斯洛文尼亚语",
    "mk": "马其顿语", "lv": "拉脱维亚语", "is": "冰岛语",
}

# Unicode 脚本区间 → 源语言（auto 探测用；假名/谚文先于汉字判定——日文
# 混用汉字，谚文独立成段）。共享文字（fa/ur 用阿拉伯字母）归默认语言。
_SCRIPT_RANGES = (
    (0x3040, 0x30FF, "jpn_Jpan"),   # 平假名 + 片假名
    (0xAC00, 0xD7AF, "kor_Hang"),   # 谚文音节
    (0x4E00, 0x9FFF, "zho_Hans"),   # CJK 统一汉字
    (0x0900, 0x097F, "hin_Deva"),   # 天城文
    (0x0980, 0x09FF, "ben_Beng"),   # 孟加拉文
    (0x0B80, 0x0BFF, "tam_Taml"),   # 泰米尔文
    (0x0590, 0x05FF, "heb_Hebr"),   # 希伯来
    (0x0600, 0x06FF, "arb_Arab"),   # 阿拉伯字母（fa/ur 共享，归 MSA）
    (0x0370, 0x03FF, "ell_Grek"),   # 希腊
)
_UKRAINIAN_LETTERS = (0x0456, 0x0457, 0x0454, 0x0491)  # і ї є ґ


def _flores(code):
    """2 字码 → FLORES-200；调用方直接给 FLORES 码则原样放行；未知返回 None。"""
    code = (code or "").strip()
    if not code or code == "auto":
        return None
    if "_" in code:
        return code
    return _FLORES.get(code.lower())


def detect_src(text):
    """auto 源语言探测：逐字符查脚本区间，命中即返回；乌克兰语特征字母
    （і ї є ґ）优先于泛西里尔；拉丁文及未识别脚本默认英语。"""
    has_cyrillic = False
    for ch in text:
        cp = ord(ch)
        if cp in _UKRAINIAN_LETTERS:
            return "ukr_Cyrl"
        for lo, hi, lang in _SCRIPT_RANGES:
            if lo <= cp <= hi:
                return lang
        if 0x0400 <= cp <= 0x04FF:
            has_cyrillic = True
    return "rus_Cyrl" if has_cyrillic else "eng_Latn"


def ensure_local_model():
    """确保模型就绪，返回模型目录（huggingface_hub 自动维护：hub 默认缓存，
    断点续传/并发锁/完整性自管）。先本地缓存直取——就绪绝不联网；无缓存
    才联网下载（尊重 HF_ENDPOINT 镜像环境变量）。"""
    from huggingface_hub import snapshot_download
    try:
        return snapshot_download(repo_id=_MODEL_REPO, local_files_only=True)
    except Exception:
        return snapshot_download(repo_id=_MODEL_REPO)


def _strip_think(text):
    """<think> 块兜底剥离（对齐官方 translate.py strip_think）：Qwen 系模板
    在 chat_template_kwargs 未生效等边缘下可能漏思考块。"""
    if "</think>" in text:
        text = text.split("</think>", 1)[1]
    return text.strip().removeprefix("<think>").strip()


class TranslateEngine:
    """翻译引擎属主（挂 app.extensions["engines"]["translate"]）。

    按模型名路由（config <translate>.model）："nllb"=进程内 CT2 模型（加载
    互斥、on-demand 空闲卸载、手动停机持久化）；卡片名=转发翻译专用
    llama-server 实例（translate_llm 引擎引用经 app 装配注入，与对话 LLM
    的启停互不相干；生命周期归该实例，总览页「翻译 LLM」行启停）。
    """

    def __init__(self, cfg, llm=None):
        self.cfg = cfg or {}
        self.mode = self.cfg.get("mode", "resident")
        self._llm = llm  # LlmEngine 引用（engine=llm 路径用）
        self._model = None  # (Translator, SentencePieceProcessor)
        self._lock = threading.Lock()
        self._starting = False          # 加载互斥标志（同 llm_engine/asr）
        self._manual_stop = bool(self.cfg.get("stopped"))
        self._last_used = 0.0
        if self.mode == "on-demand":
            t = threading.Thread(target=self._idle_watch, daemon=True)
            t.start()

    # ---- 生命周期 ----

    def ensure_loaded(self, force=False):
        """确保 NLLB 模型就绪（懒加载），返回 (translator, sp)。线程安全。

        force=True（管理页启动按钮）解除手动停机；普通调用在手动停机期间
        拒绝加载（停了就是停了，不被业务请求悄悄拉回）。engine=llm 路径
        不经此处（NLLB 不加载）。"""
        with self._lock:
            if force:
                self._manual_stop = False
                config.set_engine_stopped("translate", False)
            elif self._manual_stop:
                raise RuntimeError("翻译引擎已手动停机，请到管理页重新启动")
            if self._model is not None:
                self._last_used = time.time()
                return self._model
            if self._starting:
                raise RuntimeError("翻译引擎正在加载中，请稍候重试")
            self._starting = True
            try:
                self._model = self._load_nllb()
                self._last_used = time.time()
                return self._model
            finally:
                self._starting = False

    def _load_nllb(self):
        import ctranslate2
        import sentencepiece as spm
        model_dir = ensure_local_model()
        translator = ctranslate2.Translator(model_dir, device="cpu",
                                            compute_type="int8")
        sp = spm.SentencePieceProcessor()
        sp.load(os.path.join(model_dir, "sentencepiece.bpe.model"))
        return translator, sp

    def _release(self):
        self._model = None
        gc.collect()

    def stop(self):
        """手动卸载 NLLB 模型（管理界面关停按钮）。线程安全；置位手动停机并
        持久化，业务请求不再自动重新加载。engine=llm 时翻译不依赖 NLLB，
        关停仅影响 nllb 路径（llm 生命周期在总览页「翻译 LLM」行）。"""
        with self._lock:
            if self._starting:
                raise RuntimeError("翻译引擎正在加载中，请稍候再关停")
            self._manual_stop = True
            self._release()
        config.set_engine_stopped("translate", True)

    def _idle_watch(self):
        timeout = self.cfg.get("idle_timeout", 600)
        while True:
            time.sleep(30)
            with self._lock:
                if (self._model is not None and not self._starting
                        and time.time() - self._last_used > timeout):
                    self._release()

    def status(self):
        """/api/translate/status 与 /api/status 用。model=当前模型选择
        （"nllb" 或 translate_llm 卡片名）；loaded/loading/manual_stop 均 NLLB
        侧状态；卡片模型路径的运行态看总览页「翻译 LLM」实例。"""
        return {
            "model": self.cfg.get("model", "nllb"),
            "nllb_model": _MODEL_REPO,
            "mode": self.mode,
            "loaded": self._model is not None,
            "loading": self._starting,
            "manual_stop": self._manual_stop,
        }

    # ---- 推理 ----

    def translate(self, text, src="auto", dst="zh"):
        """翻译 → {text, model}。src/dst 为 2 字语言码，src 支持 "auto"。

        模型路由取 config <translate>.model："nllb" → NLLB 快路径；卡片名 →
        translate_llm 实例（该实例的选卡由 config <translate_llm>.model 决定，
        管理页与翻译段下拉联动写入）。
        RuntimeError：引擎不可用 → api 层映射 503；
        ValueError：参数不支持 → 400。
        """
        model = (self.cfg.get("model") or "nllb").strip()
        if model != "nllb":
            return self._translate_llm(text, src, dst, model)
        dst_flores = _flores(dst)
        if not dst_flores:
            raise ValueError(f"不支持的目标语言：{dst}")
        src_flores = _flores(src) or detect_src(text)
        translator, sp = self.ensure_loaded()
        tokens = [src_flores] + sp.encode(text, out_type=str) + ["</s>"]
        results = translator.translate_batch(
            [tokens], target_prefix=[[dst_flores]], beam_size=4)
        out = results[0].hypotheses[0]
        # 首个 token 为目标语言码，decode 前去掉
        return {"text": sp.decode(out[1:]).strip(), "model": "nllb"}

    def _translate_llm(self, text, src, dst, model_name):
        """翻译专用 llama-server 实例（translate_llm）：官方 translate.py 纯翻译
        提示词 + 贪心解码。

        惰性拉起语义对齐 api/llm.py 反代：手动停机不自动拉起（503 如实报），
        未运行则 start() 等就绪。begin/end_request 包裹防推理中被空闲误杀。"""
        if self._llm is None:
            raise RuntimeError("翻译 LLM 引擎未装配，无法使用 llama.cpp 翻译模型")
        llm = self._llm
        if not llm.status()["running"]:
            if not llm.auto_start_allowed():
                raise RuntimeError(
                    f"翻译模型 {model_name} 所在的 llama-server 已手动停机，"
                    "请到管理页总览启动「翻译 LLM」")
            llm.start()  # 冷启动（首次含模型下载）可达分钟级，调用方超时自行权衡
        dst_name = _LANG_NAMES_ZH.get((dst or "").strip().lower(), dst)
        src_name = _LANG_NAMES_ZH.get((src or "").strip().lower())
        body_text = text.strip()
        if src_name:
            prompt = (f"请将以下{src_name}文本翻译为{dst_name}，直接输出翻译结果，"
                      f"不要进行任何解释。\n\n{body_text}")
        else:
            prompt = (f"请将以下文本翻译为{dst_name}，直接输出翻译结果，"
                      f"不要进行任何解释。\n\n{body_text}")
        payload = {
            # model 字段 llama-server 不校验，取当前卡片名便于日志对账
            "model": llm.cfg.get("model") or "default",
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,          # 官方默认贪心（translate.py temperature=0）
            "max_tokens": 1024,        # 同官方默认；字幕/段落足够
            "chat_template_kwargs": {"enable_thinking": False},
        }
        llm.begin_request()
        try:
            r = requests.post(llm.base_url() + "/v1/chat/completions",
                              json=payload, timeout=(10, 120))
        except requests.RequestException as e:
            raise RuntimeError(f"llama-server 请求失败：{e}")
        finally:
            llm.end_request()
        if r.status_code != 200:
            raise RuntimeError(f"llama-server 返回 HTTP {r.status_code}：{r.text[:200]}")
        try:
            data = r.json()
            content = data["choices"][0]["message"]["content"] or ""
        except (ValueError, KeyError, IndexError) as e:
            raise RuntimeError(f"llama-server 响应格式异常：{e}")
        return {"text": _strip_think(content), "model": model_name}
