"""翻译引擎：LLM（复用 llama-server 提示词路径，单一路径）。

设计（plan-backend §2.6/§3.3）：
- llm 引擎：复用 LlmEngine 端点，提示词模板做翻译（只输出译文）；
  src 支持 "auto"（LLM 自动识别源语言）。生命周期归 LlmEngine。
- 结果缓存：不做（plan §2.11：翻译输入千变万化，命中率低）。
第三百九十五次：Argos Translate 备选档整体移除（qwen3.5-0.8b 常驻后
LLM 翻译全面占优，离线档无保留价值，用户裁定），不保留代码。
"""

import requests

_TRANSLATE_PROMPT = (
    "你是翻译引擎。将用户文本{src_desc}翻译成{dst}。"
    "只输出译文本身：不要解释、不要加引号、不要重复原文、不要输出任何多余内容。"
    "若文本为空或无法翻译，输出空字符串。"
)

_LANG_NAMES = {
    "zh": "中文", "en": "英语", "ja": "日语", "ko": "韩语", "de": "德语",
    "fr": "法语", "es": "西班牙语", "pt": "葡萄牙语", "ru": "俄语",
    "it": "意大利语", "ar": "阿拉伯语", "th": "泰语", "vi": "越南语",
    "id": "印尼语", "hi": "印地语", "nl": "荷兰语", "tr": "土耳其语",
}


def _lang_desc(code):
    """提示词里的语言描述：已知代码用中文名，否则原样透传。"""
    if not code or code == "auto":
        return "（自动识别源语言）"
    return f"从{_LANG_NAMES.get(code, code)}"


class TranslateEngine:
    """翻译引擎属主（挂 app.extensions["engines"]["translate"]）。

    推理与生命周期委托给 LlmEngine 实例（llama-server 进程/端口属主）。
    """

    def __init__(self, cfg, llm):
        self.cfg = cfg or {}
        self.llm = llm  # LlmEngine 实例：进程/端口属主

    # ---- 状态 ----

    def status(self):
        """/api/translate/status 与 /api/status 用。状态透传 LlmEngine。"""
        return {
            "engine": self.cfg.get("engine", "llm"),
            "llm": self.llm.status(),
        }

    # ---- 推理 ----

    def translate(self, text, src="auto", dst="zh"):
        """翻译 → {text}。src/dst 为语言代码，src 支持 "auto"。

        RuntimeError：引擎不可用（llama-server 拉起失败/服务不可达）
        → api 层映射 503；ValueError：参数不支持 → 400。
        """
        return {"text": self._translate_llm(text, src, dst)}

    def _translate_llm(self, text, src, dst):
        if not dst or dst == "auto":
            raise ValueError("目标语言不能为空或 auto")
        payload = {
            "messages": [
                {"role": "system", "content": _TRANSLATE_PROMPT.format(
                    src_desc=_lang_desc(src), dst=_LANG_NAMES.get(dst, dst))},
                {"role": "user", "content": text},
            ],
            "temperature": 0,      # 翻译要确定性输出
            "max_tokens": 4096,
            "stream": False,
            # Qwen3.5 为思考模型：不关思考会先输出 reasoning（耗 token 且
            # max_tokens 耗尽在思考阶段时 content 为空）
            "chat_template_kwargs": {"enable_thinking": False},
        }
        return self._chat_once(payload)

    def _chat_once(self, payload):
        """发一次 chat/completions 并取回纯文本（与 ocr 同款错误包装）。"""
        if not self.llm.status()["running"]:
            if not self.llm.auto_start_allowed():  # 第409次：LLM 手动停机期间不自动拉起
                raise RuntimeError("LLM 引擎已手动停机，请到管理页重新启动后再翻译")
            self.llm.start()  # RuntimeError（未安装/超时）上抛，api 映射 503
        self.llm.begin_request()  # on-demand 下推理期间不被空闲误杀
        try:
            r = requests.post(f"{self.llm.base_url()}/v1/chat/completions",
                              json=payload, timeout=(10, 600))
            r.raise_for_status()
            text = r.json()["choices"][0]["message"]["content"]
            return (text or "").strip()
        except requests.RequestException as e:
            raise RuntimeError(f"LLM 服务不可达：{e}") from e
        except (KeyError, IndexError, ValueError) as e:
            raise RuntimeError(f"LLM 返回格式异常：{e}") from e
        finally:
            self.llm.end_request()
