<div align="center">
  <img src="./assets/koe-avatar.png" alt="Koe" width="128">
  <h1>Koe</h1>
  <p>Live subtitles and translation for audio playing in your Chrome tab.</p>
  <p><a href="README_ZH.md">简体中文</a></p>
</div>

Koe（こえ / 声）captures the audio from the current Chrome tab, turns it into live subtitles, and can translate completed lines into Chinese.

No video download. No ffmpeg. Audio is streamed directly from the tab to Koe's local helper.

## Features

- **Live subtitles** — captions appear while the video is playing.
- **Chinese translation** — completed lines can be translated without blocking recognition.
- **Automatic recovery** — reconnects after short recognition or WebSocket interruptions.
- **Video switching** — keeps working when the source changes inside the same page.
- **In-page overlay** — subtitles stay above the player, including fullscreen mode.
- **Shortcut** — press **Alt+K** on Windows/Linux or **Option+K** on macOS.

## Setup

Koe currently uses a small local helper for realtime recognition and translation. It requires **Node.js 20+** and a DashScope API key.

```bash
./scripts/install-local-helper.sh
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this repository.

The installer stores your DashScope API key in macOS Keychain and runs the helper at `127.0.0.1:8787` with LaunchAgent.

## Usage

1. Play a video in Chrome.
2. Open Koe and select **Start Live Subtitles**, or press **Option+K** on macOS.
3. Toggle Chinese translation from the popup when needed.

Koe captures tab audio only. It does not download the video or process media files.

## Development

```bash
npm install
npm run check
```

Main pieces: `background.js` for session coordination, `offscreen.js` for tab audio capture, `content.js` for subtitle UI, and `src/server/` for the local helper.

[MIT](LICENSE) © 2026 yuxino
