"""翻译引擎：config <translate>.model 选模型（值 = translate_llm.cards 卡片名）。

- 全部走翻译专用 llama-server 实例（app 装配的 translate_llm 引擎，内部端口
  7789，与对话 LLM 的 7788 分开启停、分开选卡）：默认卡 tencent/Hy-MT2-1.8B
  （2026-10-V1 基准主选），备选 mradermacher/LMT-60-1.7B 与 LMT-60-0.6B
  （NiuTrans 官方权重社区量化，NLLB 平替；官方英文三行式模板全系共用，
  同一 60 语清单）。OpenAI /v1/chat/completions；贪心解码 +
  enable_thinking=False，<think> 块兜底剥离。
- 提示词按当前生效卡分发：卡带 translate_prompt 模板则用之，无模板回落
  通用中文指令模板。占位符：{dst}=目标语言中文名、{src_en}/{dst_en}=源/目标
  语言英文名、{text}=原文。翻译特化模型各有官方模板措辞，混用会假崩坏
  （LMT-60 被套中文指令曾致 zh2en 输出中文，lab 翻译调研 §5 事故）：
  Hy-MT2 用腾讯官方中文指令；LMT-60 必须用官方英文三行式 + 英语言名
  （src=auto 经 Unicode 脚本探测补齐，探测覆盖见 _SCRIPT_RANGES，缺省英语）。
- 历史注记：进程内 NLLB-200-600M CT2 快路径已移除（CC-BY-NC 商用风险 +
  2026-10 基准专名漏译/长文乱码，被 LMT-60-0.6B 全面替代），ctranslate2/
  sentencepiece 依赖退场（faster-whisper 仍传递依赖 ctranslate2）；"nllb"
  旧值经 config._migrate_translate 归一到 LMT-60 卡名。
- 首请求可能触发 llama-server 冷启动（含模型下载，分钟级）；生命周期
  （启停/空闲卸载/手动停机）归 translate_llm 实例，总览页「翻译 LLM」行。
- 缓存不做：翻译输入千变万化命中率低。
"""

import requests

# 2 字语言码 → 英文名（translate_prompt 的 {src_en}/{dst_en} 用；LMT-60 官方
# 三行式模板必须英语言名）。覆盖与 _LANG_NAMES_ZH 同一 42 语清单；LMT-60 不
# 收录的语种（fil/sh/ca/lt/sl/mk/lv）模型侧自担，扩展端走渠道降级。
_LANG_NAMES_EN = {
    "en": "English", "zh": "Chinese", "hi": "Hindi", "es": "Spanish",
    "fr": "French", "ar": "Arabic", "bn": "Bengali", "pt": "Portuguese",
    "ru": "Russian", "ur": "Urdu", "id": "Indonesian", "de": "German",
    "ja": "Japanese", "tr": "Turkish", "fil": "Filipino", "vi": "Vietnamese",
    "ta": "Tamil", "ko": "Korean", "fa": "Persian", "it": "Italian",
    "ms": "Malay", "pl": "Polish", "uk": "Ukrainian", "nl": "Dutch",
    "ro": "Romanian", "sh": "Croatian", "el": "Greek", "hu": "Hungarian",
    "cs": "Czech", "sv": "Swedish", "he": "Hebrew", "bg": "Bulgarian",
    "da": "Danish", "fi": "Finnish", "nb": "Norwegian Bokmål",
    "sk": "Slovak", "ca": "Catalan", "lt": "Lithuanian", "sl": "Slovenian",
    "mk": "Macedonian", "lv": "Latvian", "is": "Icelandic",
}

# 2 字语言码 → 中文名（通用中文指令模板用；与官方 translate.py LANG_NAMES
# 对齐，缺的语种按通行中文名补齐；未知码回落原码）
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
    (0x3040, 0x30FF, "jpn"),        # 平假名 + 片假名
    (0xAC00, 0xD7AF, "ko"),         # 谚文
    (0x4E00, 0x9FFF, "zh"),         # CJK 统一汉字
    (0x0900, 0x097F, "hi"),         # 天城文
    (0x0980, 0x09FF, "bn"),         # 孟加拉文
    (0x0B80, 0x0BFF, "ta"),         # 泰米尔文
    (0x0590, 0x05FF, "he"),         # 希伯来
    (0x0600, 0x06FF, "ar"),         # 阿拉伯字母（fa/ur 共享，归阿拉伯语）
    (0x0370, 0x03FF, "el"),         # 希腊
)
_UKRAINIAN_LETTERS = (0x0456, 0x0457, 0x0454, 0x0491)  # і ї є ґ


def detect_src(text):
    """auto 源语言探测：逐字符查脚本区间，命中即返回 2 字码；乌克兰语特征
    字母（і ї є ґ）优先于泛西里尔；拉丁文及未识别脚本默认英语。
    （原 NLLB 版返回 FLORES 码，现仅服务 LMT 英语言名补齐，直出 2 字码。）"""
    has_cyrillic = False
    for ch in text:
        cp = ord(ch)
        if cp in _UKRAINIAN_LETTERS:
            return "uk"
        for lo, hi, lang in _SCRIPT_RANGES:
            if lo <= cp <= hi:
                return lang
        if 0x0400 <= cp <= 0x04FF:
            has_cyrillic = True
    return "ru" if has_cyrillic else "en"


def _strip_think(text):
    """<think> 块兜底剥离（对齐官方 translate.py strip_think）：Qwen 系模板
    在 chat_template_kwargs 未生效等边缘下可能漏思考块。"""
    if "</think>" in text:
        text = text.split("</think>", 1)[1]
    return text.strip().removeprefix("<think>").strip()


def _lang_two(code):
    """语言码归一为 2 字码（{_LANG_NAMES_*} 的键域）；未知码原样返回。"""
    return (code or "").strip().lower() or None


class TranslateEngine:
    """翻译路由属主（挂 app.extensions["engines"]["translate"]）。

    模型全部由 translate_llm 实例承载（7789 llama-server），本引擎只做
    模型名路由与提示词组装；生命周期（启停/空闲卸载/手动停机）归该实例
    （总览页「翻译 LLM」行），本引擎无进程内模型、无独立启停。
    """

    def __init__(self, cfg, llm=None):
        self.cfg = cfg or {}
        self._llm = llm  # LlmEngine 引用（翻译专用实例）

    def status(self):
        """/api/translate/status 与 /api/status 用。model=当前模型选择（卡片
        名）；运行态看总览页「翻译 LLM」实例（translate_llm.status()）。"""
        return {"model": self.cfg.get("model"),
                "mode": self.cfg.get("mode", "on-demand")}

    # ---- 推理 ----

    def translate(self, text, src="auto", dst="zh"):
        """翻译 → {text, model}。src/dst 为 2 字语言码，src 支持 "auto"。

        RuntimeError：引擎不可用 → api 层映射 503；
        ValueError：参数不支持 → 400。
        """
        model = (self.cfg.get("model") or "").strip()
        if not model:
            raise RuntimeError("翻译模型未选择，请到管理页翻译段选卡")
        return self._translate_llm(text, src, dst, model)

    def _translate_llm(self, text, src, dst, model_name):
        """翻译专用 llama-server 实例（translate_llm）：按当前生效卡分发官方
        纯翻译提示词模板（卡带 translate_prompt 则用之）+ 贪心解码。

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
        dst = _lang_two(dst)
        src = _lang_two(src)
        body_text = text.strip()
        # 语言名两套：中文名给通用中文指令模板，英文名给 LMT 官方三行式。
        # src=auto 时脚本探测补齐（detect_src 兜底英语）。
        dst_en = _LANG_NAMES_EN.get(dst, dst)
        src_en = _LANG_NAMES_EN.get(src) or _LANG_NAMES_EN.get(detect_src(text), "English")
        dst_zh = _LANG_NAMES_ZH.get(dst, dst)
        src_zh = _LANG_NAMES_ZH.get(src)
        # 卡片自带翻译提示词模板（translate_prompt）优先：翻译特化模型各有
        # 官方模板措辞（Hy-MT2 腾讯中文指令 / LMT-60 官方英文三行式，bench
        # 即按卡分发实测）。占位符逐一 replace 不走 str.format——文本含
        # 花括号也不炸；dst/src 先替换、text 最后替换，避免正文字面量被
        # 二次扫描。
        tpl = str((llm.current_card() or {}).get("translate_prompt") or "")
        if tpl:
            prompt = (tpl.replace("{src_en}", src_en).replace("{dst_en}", dst_en)
                         .replace("{dst}", dst_zh).replace("{text}", body_text))
        elif src_zh:
            prompt = (f"请将以下{src_zh}文本翻译为{dst_zh}，直接输出翻译结果，"
                      f"不要进行任何解释。\n\n{body_text}")
        else:
            prompt = (f"请将以下文本翻译为{dst_zh}，直接输出翻译结果，"
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
