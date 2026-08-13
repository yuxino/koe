<div align="center">
  <img src="./assets/koe-avatar.png" alt="Koe" width="128">
  <h1>Koe</h1>
  <p>Live subtitles and Chinese translation for audio playing in your Chrome tab or microphone.</p>
  <p><a href="README_ZH.md">简体中文</a></p>
</div>

Koe（こえ / 声）captures tab audio or the microphone, turns speech into live subtitles, and optionally translates lines into Simplified Chinese. Subtitles scroll continuously in the Chrome side panel, with history you can scroll back through.

No video downloads, ffmpeg, Node.js, or localhost helper.

## Features

- **Side-panel scrolling subtitle feed** — confirmed lines accumulate, the live draft updates in place, and long captions are split into short display segments.
- **Chinese translation** — per-line translation via DashScope qwen-mt with an explicit Simplified Chinese target.
- **Multiple caption modes** — tab audio or microphone × DashScope / fully-offline Vosk models (Chinese & English) / Chrome's built-in recognition (no API key).
- **Offline recognition** — bundled Vosk models in `models/`; once loaded, subtitles keep working without any network, and the microphone mode needs no gesture and no key.
- **Automatic recovery** — reconnects after short WebSocket interruptions.
- **Shortcut** — **Alt+K** (**Option+K** on macOS) starts captions and follows whichever tab is currently audible, including background playback.
- **Toolbar icon** — one click starts captions for the current tab and opens the side panel.

## Setup

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository (it bundles ~95MB of offline models, so loading takes a few seconds).
3. Click the Koe toolbar icon to open the side panel; pick a caption mode under Settings (microphone + offline model works with zero configuration).
4. DashScope modes require a saved DashScope API Key.

The API Key is stored in `chrome.storage.local` on your browser profile and is only used for direct DashScope requests.

## Development

The runtime is plain Manifest V3 JavaScript. Reload the extension from `chrome://extensions` after changing the source.

Main pieces: `background.js` coordinates sessions, `offscreen.js` captures audio and runs recognition (DashScope / Chrome built-in / bundled Vosk models), `content.js` detects videos and shows status toasts, `sidepanel.*` renders the side panel and the scrolling subtitle feed, and `vosk.js` / `vosk-worker.js` / `models/` power offline recognition.

[MIT](LICENSE) © 2026 yuxino
