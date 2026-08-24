<div align="center">
  <img src="./assets/koe-avatar.png" alt="Koe" width="128">
  <h1>Koe</h1>
  <p>Local-first subtitles for video playing in a Chromium tab.</p>
  <p><a href="README_ZH.md">简体中文</a></p>
</div>

Koe generates manually controlled, media-synced subtitles with optional Simplified Chinese translation. Only captions appear over the video; controls, prompts, and errors stay in the popup or side panel.

## How it works

- **Off by default** — while Koe is off, playback, page changes, settings, and opening Koe do not turn it on. Only an explicit Start action from Koe's controls or context menu starts a session; once started, it follows media changes until you stop it. **Alt+K** only opens the controller.
- **Local accurate (default)** — Koe Helper runs Whisper `large-v3` on the Mac. Compatible public HLS uses the media timeline directly; when no usable HLS source is available, Koe can fall back to local tab-audio recognition.
- **DashScope** — captures tab audio for cloud recognition and optional Chinese translation. This mode requires your own DashScope API Key.
- **Video-safe UI** — captions follow seeking, video changes, and fullscreen. Status and errors never cover the video.
- **One active session** — the toolbar shows global status, the side panel keeps recent confirmed lines from the current session plus diagnostics, and Stop releases tab capture.

## Install

1. Open `chrome://extensions`, enable **Developer mode**, and load this repository with **Load unpacked**.
2. Use the default **Local accurate** mode after installing Koe Helper, or switch to **DashScope** and save an API Key in the side panel.
3. Start from Koe's controls or context menu. Koe remains off until an explicit Start action.

## Koe Helper

Koe Helper is required only for Local accurate mode. The included installer targets ego-lite on macOS and requires macOS 15+, Swift 6, and a toolchain containing the macOS 26 SDK.

```sh
helper/scripts/install-ego-lite.sh <extension ID>
```

The first build downloads Swift dependencies; the first transcription downloads and caches the approximately 626 MB Whisper model. On Apple Silicon with macOS 26+, Chinese translation can also run through Apple's on-device Translation framework when the required language pack is installed. Other supported Macs show original-language subtitles only.

The direct media path supports public, unencrypted, non-byte-range HLS VOD with MPEG-TS AAC or CMAF/fMP4 segments. Koe does not bypass DRM or read browser cookies and authorization headers. Pages without a usable direct HLS source may use the local tab-audio fallback instead. See [Koe Helper documentation](helper/README.md) for exact boundaries.

## Privacy

- **Local accurate:** recognition stays on the Mac and is never sent to DashScope. Koe may download the Whisper model and read needed media segments from the original server; Apple language packs must be installed separately in System Settings.
- **DashScope:** captured tab audio is sent directly to DashScope for recognition; when translation is enabled, recognized text is also sent for translation. The video file itself is not uploaded.
- The API Key stays in the browser profile's `chrome.storage.local` and is not sent to Koe Helper. Diagnostic logs contain timing and errors, not caption text.

## Development

The extension is plain Manifest V3 JavaScript with no build step. Reload it from `chrome://extensions` after changes. The optional Helper is a Swift package under `helper/`.

```sh
for test_file in test/*.test.js; do node "$test_file" || exit 1; done
swift run --package-path helper koe-helper-core-checks
```

© 2026 yuxino
