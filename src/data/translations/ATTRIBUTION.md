# 内置英中翻译包 · 数据来源声明

- 文件：`en_zh.json`（`{小写英文词: [中文释义...(≤5条)]}`，40261 条，裸 JSON 约 2.5MB）
  + `meta.json`（规模清单，含 generatedAt；2026-09-05 由 manifest.json 改名——Edge 商店
  校验要求扩展包内仅根目录一个 manifest.json，数据目录元数据统一叫 meta.json，
  外部管线重跑落盘时勿再生成 manifest.json）。
- 产出：VocabRadar 仓 `preprocess/build_translation_zh.py`
  （输入 ECDICT + LLM 直译缺口，清洗规则对齐旧仓
  `BeaverWord/preprocess/load_dictionary.py`：切行/strip/过滤空与长度≤1/取前 5 条）。
- 上游词典：ECDICT（https://github.com/skywind3000/ECDICT，MIT License，
  作者已在 issue #43 亲口确认可商用；复制/分发须保留本版权声明）。
  - Copyright (c) skywind3000 / ECDICT contributors, MIT License.
  - 本包仅含经上述脚本清洗后的释义子集（40261 条），原始 ECDICT 另有数十万条。
- 小程序侧调用：`VocabRadar/miniprogram/src/utils/builtinZhDict.js`
  （层次 offlineDict → builtin → 在线；仅 en→zh 命中）。
- 扩展侧接入：装载进统一词典 IDB `translation` 字段（`translationLang='zh'`），
  由 `src/lib/dictionary/` 装载函数一次性写入，之后查询只走词典
  （translator 首层缓存即命中，在线渠道只补真正缺词）；其它语言对不受影响。
- 更新规则：上游 `data/translations/en_zh.json.br` 更新后，重跑解码落盘到此目录。
  2026-09-08：原"包内 wordfreq/meta.json version +1 触发清库重建"机制随 meta.json
  退役——词典重建以构建时写入的 expected 实际值为基准；数据更新后重建词典的方式
  待定（是否为远程数据加主动版本检测，待请示）。
