"""翻译引擎：NLLB-200-distilled-600M（CTranslate2 int8 CPU，唯一引擎，纯本地免 Key）。

设计：
- 模型：JustFrederik/nllb-200-distilled-600M-ct2-int8（预转换 CT2 int8 仓库，
  免 torch/transformers 转换依赖）。模型文件交 huggingface_hub 自动维护：
  先 hub 本地缓存直取（local_files_only，就绪绝不联网），无缓存才联网
  snapshot_download（断点续传，尊重 HF_ENDPOINT 镜像）。
- 推理：ctranslate2.Translator（CPU int8）+ sentencepiece 分词。源序列 =
  [源语言码] + sp 编码 + </s>，target_prefix=[目标语言码]，译文 = sp.decode
  （去掉输出首部的目标语言 token）。
- 语言码：调用方传 2 字码（zh/en/…，全集见 ui/pages.js LANGS），内部映射
  FLORES-200；src="auto" 按 Unicode 脚本区间探测（NLLB 无自动识别）。
- 生命周期同 ASR（进程内模型）：resident 随启动预加载 / on-demand 首请求
  加载 + 空闲卸载 + _starting 互斥；手动停机持久化 config.json
  <translate>.stopped，管理页可启停。
- 缓存不做：翻译输入千变万化命中率低。
"""

import gc
import os
import threading
import time

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


class TranslateEngine:
    """进程内翻译引擎属主（挂 app.extensions["engines"]["translate"]）。

    唯一引擎 NLLB-200-distilled-600M（CT2 int8 CPU）；模型加载互斥，
    on-demand 模式空闲超时自动卸载，手动停机持久化 config.json。
    """

    def __init__(self, cfg):
        self.cfg = cfg or {}
        self.mode = self.cfg.get("mode", "resident")
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
        """确保模型就绪（懒加载），返回 (translator, sp)。线程安全。

        force=True（管理页启动按钮）解除手动停机；普通调用在手动停机期间
        拒绝加载（停了就是停了，不被业务请求悄悄拉回）。
        """
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
        """手动卸载模型（管理界面关停按钮）。线程安全；置位手动停机并持久化，
        业务请求不再自动重新加载。"""
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
        """/api/translate/status 与 /api/status 用。"""
        return {
            "engine": "nllb",
            "mode": self.mode,
            "loaded": self._model is not None,
            "loading": self._starting,
            "manual_stop": self._manual_stop,
            "model": _MODEL_REPO,
        }

    # ---- 推理 ----

    def translate(self, text, src="auto", dst="zh"):
        """翻译 → {text, engine}。src/dst 为 2 字语言码，src 支持 "auto"。

        RuntimeError：引擎不可用 → api 层映射 503；
        ValueError：参数不支持 → 400。
        """
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
        return {"text": sp.decode(out[1:]).strip(), "engine": "nllb"}
