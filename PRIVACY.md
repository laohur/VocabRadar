# Privacy Policy — VocabRadar

> 语言：English / 中文（见下方中文版）
> Last updated: 2026-09-05

VocabRadar is a browser extension that helps you discover and learn new words while watching videos or reading web pages.

**We do not collect, transmit, sell, or share any personal data.** The developer runs no servers and receives nothing from your use of this extension. There is no account, no sign-up, no analytics, no advertising, and no tracking of any kind.

## Data stored on your device (never uploaded by us)
- **Word book, lookup history, statistics**: stored locally in the extension's own storage (IndexedDB / `chrome.storage.local`) inside your browser profile. Uninstalling the extension or clearing its data removes everything permanently.
- **Settings**: annotation thresholds, display language, and any translation/AI endpoints you configure yourself.

## Network requests the extension may make
- **Dictionary & translation lookups**: when you look up a word or chat with the AI helper, the extension sends only the text you explicitly selected to the translation/AI endpoint in use (a public dictionary service, or the endpoint **you** configured in settings).
- **Video subtitles**: on video sites (Bilibili, YouTube), the extension requests publicly available subtitle data from those sites' public web APIs so it can annotate words.
- **Speech recognition & OCR**: microphone recordings and camera captures are used **only after you click the record/capture button**, and are processed **locally** by bundled Whisper / Tesseract models. Audio and images are never uploaded, stored, or kept after processing.

## Permissions
Each permission is used only for the purpose stated in the store listing (see the "Privacy" tab of the store page):
- `storage` — local word book and settings.
- `activeTab` / `scripting` — annotate the page you are viewing; read player/subtitle info on Bilibili/YouTube tabs in response to your actions.
- `cookies` — a one-time boolean check for a Bilibili login cookie (so your own subtitle list can be fetched); the value is never read, stored, or transmitted.
- `contextMenus` — right-click "look up selection".
- `offscreen` + `audioCapture` / `videoCapture` — run local speech recognition and OCR in an offscreen page, on your click only.
- Host permissions — needed to annotate pages and fetch subtitles across sites.

## Contact
If you have questions about this policy, open an issue at the project's repository or contact the developer via the store listing.

---

# 隐私政策 — VocabRadar（中文版）

VocabRadar 是一款帮助你在看视频、读网页时发现并学习生词的浏览器扩展。

**我们不收集、不传输、不出售、不共享任何个人数据。** 开发者没有任何服务器，无法也不会获取你的任何信息。无账号、无注册、无统计埋点、无广告、无任何追踪。

## 保存在你设备本地的数据（我们不上传）
- **生词本、查词历史、统计**：保存在浏览器配置文件中的扩展自有存储（IndexedDB / `chrome.storage.local`）。卸载扩展或清除其数据即彻底删除。
- **设置**：标注阈值、界面语言，以及你自行填写的翻译/AI 接口地址。

## 扩展可能发起的网络请求
- **词典与翻译查询**：仅当你主动查词或使用 AI 对话时，把你选中的文本发送给当前使用的翻译/AI 服务（公共词典服务，或你在设置里自己配置的接口）。
- **视频字幕**：在视频网站（B站、YouTube）上，通过其公开 Web API 获取公开字幕数据，用于生词标注。
- **语音识别与 OCR**：仅在你点击录音/拍摄按钮后使用麦克风/摄像头，由**本地内置**的 Whisper / Tesseract 模型处理；音频与图像不上传、不存储、处理完即弃。

## 权限用途
每项权限仅用于商店页面"Privacy"页签所述用途：本地存储、当前页标注与视频站播放器信息读取、B站登录态布尔判断（不读取 cookie 值）、右键查词、本地语音识别与 OCR、跨站标注与字幕获取所需的主机权限。

## 联系方式
如对本政策有疑问，请通过项目仓库提交 Issue，或通过商店页面联系开发者。
