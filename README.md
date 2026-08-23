<div align="center">
  <img src="./assets/koe-avatar.png" alt="Koe" width="128">
  <h1>Koe</h1>
  <p>Live subtitles and Chinese translation for audio playing in your Chrome tab or microphone.</p>
  <p><a href="README_ZH.md">简体中文</a></p>
</div>

Koe（こえ / 声）captures tab audio or the microphone, turns speech into live subtitles, and translates lines into Simplified Chinese. Captions appear directly over the video; the side panel opens only when you want settings or scroll-back history.

No video downloads, ffmpeg, Node.js, or localhost helper.

## Features

- **In-video captions** — captions sit near the bottom of the main player, with distinct original and Chinese lines, three text sizes, and fullscreen support.
- **Media-timeline protection** — seeking, switching videos, or reconnecting recognition cannot replay stale captions or translations over the new scene.
- **Optional subtitle history** — the side panel keeps confirmed lines, the current draft, and scroll-back history; recognition corrections replace only the affected row.
- **Dual-model Chinese translation** — draft lines are translated quickly with `qwen-mt-flash`, authoritative finals with `qwen-mt-plus`. Subtitling style hints and a rolling translation memory keep output natural and terminology consistent.
- **Multiple caption modes** — tab audio or microphone × DashScope / Chrome's built-in recognition (no API key).
- **Recognition-correction handling** — when the server rewrites a line, only the affected row is replaced; duplicates are suppressed at the source.
- **Low-latency audio path** — AudioWorklet capture and bounded weak-network buffering keep the feed current; short WebSocket interruptions reconnect automatically.
- **Shortcut** — **Alt+K** (**Option+K** on macOS) starts captions and follows whichever tab is currently audible, including background playback.
- **Toolbar icon** — opens a minimal controller and starts in-video captions without forcing the side panel open. History and settings remain one explicit click away.
- **Stops for real** — pressing Stop releases the audio stream entirely (no lingering "still listening" state).
- **History survives tab switches** — the subtitle record is persisted in the background, so switching tabs (each tab has its own side-panel instance) restores the session's history.
- **Privacy-friendly diagnostics** — copy or clear logs in one click; logs record timing, lengths, and errors, never subtitle text.

## Setup

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository.
3. Click the Koe toolbar icon; the popup starts in-video captions for the current tab (or follows the audible tab). Open “Caption history & settings” only when you need to change the mode or size, or review history. Microphone + Chrome built-in recognition works with zero configuration.
4. DashScope modes require a saved DashScope API Key.

The API Key is stored in `chrome.storage.local` on your browser profile and is only used for direct DashScope requests.

## Development

The runtime is plain Manifest V3 JavaScript. Reload the extension from `chrome://extensions` after changing the source.

Main pieces: `background.js` coordinates sessions, media timelines, state, and history; `offscreen.js` / `pcm-worklet.js` capture audio and run recognition and translation; `content.js` detects video state and renders in-video captions; `popup.*` is the gesture-based controller; `sidepanel.*` provides settings, diagnostics, and scroll-back history.

© 2026 yuxino
