<div align="center">
  <img src="./assets/koe-avatar.png" alt="Koe" width="128">
  <h1>Koe</h1>
  <p>Live subtitles and Chinese translation for audio playing in your Chrome tab.</p>
  <p><a href="README_ZH.md">简体中文</a></p>
</div>

Koe（こえ / 声）captures audio from the current Chrome tab, turns it into live subtitles, and optionally translates completed lines into Chinese.

No video downloads, ffmpeg, Node.js, or localhost helper. The extension connects to DashScope directly.

## Features

- **Live subtitles** — captions appear while media is playing.
- **Chinese translation** — final lines are translated without blocking recognition.
- **Automatic recovery** — reconnects after short WebSocket interruptions.
- **Video switching** — keeps working when the source changes inside the same page.
- **Fullscreen overlay** — subtitles stay above the player.
- **Shortcut** — **Alt+K** on Windows/Linux or **Option+K** on macOS.

## Setup

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository.
3. Open Koe, enter your DashScope API Key, and save it.
4. Play a video and select **Start Live Subtitles**.

The API Key is stored in `chrome.storage.local` on your browser profile. Koe uses it only for direct DashScope requests.

## Development

The runtime is plain Manifest V3 JavaScript. Reload the extension from `chrome://extensions` after changing the source.

Main pieces: `background.js` coordinates sessions, `offscreen.js` captures tab audio and talks to DashScope, `content.js` renders subtitles, and `popup.*` manages settings.

[MIT](LICENSE) © 2026 yuxino
