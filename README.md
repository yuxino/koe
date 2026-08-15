<div align="center">
  <img src="./assets/koe-avatar.png" alt="Koe" width="128">
  <h1>Koe</h1>
  <p>Live subtitles and Chinese translation for audio playing in your Chrome tab or microphone.</p>
  <p><a href="README_ZH.md">简体中文</a></p>
</div>

Koe（こえ / 声）captures tab audio or the microphone, turns speech into live subtitles, and translates lines into Simplified Chinese. Subtitles scroll continuously in the Chrome side panel with scroll-back history.

No video downloads, ffmpeg, Node.js, or localhost helper.

## Features

- **Side-panel subtitle feed** — confirmed sentences accumulate one per row; the live draft previews the current line; server finals are committed sentence by sentence, so subtitles grow only and never flash-reset.
- **Dual-model Chinese translation** — draft lines are translated quickly with `qwen-mt-flash`, authoritative finals with `qwen-mt-plus`. Subtitling style hints and a rolling translation memory keep output natural and terminology consistent.
- **Multiple caption modes** — tab audio or microphone × DashScope / Chrome's built-in recognition (no API key).
- **Recognition-correction handling** — when the server rewrites a line, only the affected row is replaced; duplicates are suppressed at the source.
- **Automatic recovery** — reconnects after short WebSocket interruptions.
- **Shortcut** — **Alt+K** (**Option+K** on macOS) starts captions and follows whichever tab is currently audible, including background playback.
- **Toolbar icon** — opens a minimal popup; its click is the browser-recognized gesture that starts captions, opens the side panel, then closes itself. While captions are running, clicking the icon just reopens the side panel.
- **Stops for real** — pressing Stop releases the audio stream entirely (no lingering "still listening" state).
- **History survives tab switches** — the subtitle record is persisted in the background, so switching tabs (each tab has its own side-panel instance) restores the session's history.
- **Diagnostic logs** — copy or clear in-panel logs with one click for bug reports.

## Setup

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository.
3. Click the Koe toolbar icon; the popup starts captions for the current tab (or follows the audible tab) and opens the side panel. Pick a caption mode under Settings; microphone + Chrome built-in recognition works with zero configuration.
4. DashScope modes require a saved DashScope API Key.

The API Key is stored in `chrome.storage.local` on your browser profile and is only used for direct DashScope requests.

## Development

The runtime is plain Manifest V3 JavaScript. Reload the extension from `chrome://extensions` after changing the source.

Main pieces: `background.js` coordinates sessions, state, and the subtitle record; `offscreen.js` captures audio and runs recognition (DashScope / Chrome built-in); `content.js` detects videos and shows status toasts; `popup.*` is the gesture-based start surface; `sidepanel.*` renders the side panel and scrolling subtitle feed.

[MIT](LICENSE) © 2026 yuxino
