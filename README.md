# VocabRadar

Discover and learn new words in videos and web pages.

**[English](README.md) | [简体中文](README-zh.md) | [Español](README.es.md) | [العربية](README.ar.md) | [Português (BR)](README.pt-BR.md) | [Bahasa Indonesia](README.id.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Русский](README.ru.md) | [Deutsch](README.de.md)**

Companion site: <https://vocabradar.com>

## What it is

VocabRadar is a browser extension for Chrome / Edge / Firefox. It scans what you
are watching or reading, flags the words you probably don't know — judged by
word frequency — and shows their meanings on the spot. **42 languages**
supported. No sign-up, no account; lookups run locally and your browsing is
never uploaded.

Supported languages (42):

`ar bg bn ca cs da de el en es fa fi fil fr he hi hu id is it ja ko lt lv mk ms nb nl pl pt ro ru sh sk sl sv ta tr uk ur vi zh`

## What it can do

- **Learn words from videos** — on Bilibili / YouTube, a side panel lists the
  subtitles with your new words highlighted, plus a word list for the video.
  Subtitles can also be overlaid on the video with inline translations.
  - Compact or detailed notes; click a subtitle timestamp to jump to that line.
  - One click copies the annotated subtitles into the comment / danmaku box.
- **Learn words from the web** — new words in any page's text are highlighted,
  with hover definitions and right-click lookup; the side panel collects the
  page's new words with their example sentences.
- **Learn without subtitles** — local speech recognition (Whisper) transcribes
  subtitle-less videos, recordings and uploaded audio/video; OCR reads the text
  in the current video frame (burned-in subtitles, slides).
- **AI chat** — a built-in chat panel works with free models, or with your own
  OpenAI / Anthropic-compatible key.
- **Companion practice site** — push your collected pages and scrolls to
  [vocabradar.com](https://vocabradar.com) for review and practice.

## Screenshots

Video side panel (subtitles + word notes) | Web page word hints
:---:|:---:
![Video side panel with subtitle highlights](Screenshot/chosen/video-sidebar.JPG) | ![Web page word hints and side annotations](Screenshot/chosen/web-hints.jpg)

## Install

| Browser | How to install |
|---|---|
| **Firefox** | [addons.mozilla.org — VocabRadar](https://addons.mozilla.org/zh-CN/firefox/addon/vocabradar/) |
| **Edge** | [Microsoft Edge Add-ons — VocabRadar](https://microsoftedge.microsoft.com/addons/detail/hcpmjphbnjhlfahimifbkhfjafkfjbbb) |
| **Chrome** | Not listed in the store yet. Download the latest release zip at `<repo-url>/releases`, unzip it, then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select the folder. See the official guide: [Load an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world?load-unpacked). |

## Data sources

- **Word-frequency data** — from the Hugging Face dataset
  [`vocabradar/wordfreq`](https://huggingface.co/datasets/vocabradar/wordfreq):
  cleaned frequency lists for the 42 languages above, derived from
  [wordfreq](https://github.com/rspeer/wordfreq) 3.0.2 (MIT). The extension
  downloads only the language you need, on demand, and verifies integrity
  (SHA-256) before use.
- **English word lists & translations** — bundled with the extension.
- **Translations** — online channels, Chrome's built-in Translator API, or the
  AI endpoint **you** configure; only the text you explicitly look up is sent.

## Roadmap / TODO

- **Wordbook** — multi-device sync, spaced repetition review, and integration
  with practice exercises on the companion site.
- More video sites beyond Bilibili / YouTube.
- More bundled word lists / translations.

## Privacy

No account, no data collection, no tracking. Everything stays on your device.
See [PRIVACY.md](PRIVACY.md) (English + 中文).

## Repository / License

- Repository: *TBD — placeholder, fill in the public repo URL (its `/releases`
  page will host the Chrome install zips).*
- License: *TBD — placeholder.*
- Build & AMO source-submission notes: [docs/build-readme.md](docs/build-readme.md).