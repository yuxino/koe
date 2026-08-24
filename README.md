<div align="center">
  <img src="./assets/koe-avatar.png" alt="Koe" width="128">
  <h1>Koe</h1>
  <p>Live subtitles and Chinese translation for audio playing in your Chrome tab or microphone.</p>
  <p><a href="README_ZH.md">简体中文</a></p>
</div>

Koe（こえ / 声）turns speech from a browser tab or microphone into media-synced subtitles and optional Simplified Chinese translation. Only captions appear over the video; controls, prompts, and errors stay in the popup or side panel.

The regular live modes remain a pure Manifest V3 extension: they require no video download, ffmpeg, Node.js, or localhost service. On ego-lite for macOS, you can optionally install Koe Helper for more accurate, progressive local subtitles.

## Features

- **In-video captions** — captions sit near the bottom of the main player, with distinct original and Chinese lines, three text sizes, and fullscreen support.
- **Media-timeline protection** — seeking, switching videos, or reconnecting recognition cannot replay stale captions or translations over the new scene.
- **Optional progressive local subtitles** — on ego-lite for macOS, the Native Helper runs Whisper `large-v3` on short windows around the playhead, continues preparing the next window, and returns absolute media timestamps. Seeking cancels obsolete work instead of letting old subtitles catch up with the new scene.
- **Manual by default** — playback, video changes, opening the popup, and saving settings never start processing on their own; Koe only runs after an explicit Start action.
- **Visible toolbar status** — `··`, `ON`, and `!` on the Koe icon show preparation, running, and attention-required states globally, even after switching tabs.
- **Optional subtitle history** — the side panel keeps confirmed lines, the current draft, and scroll-back history; recognition corrections replace only the affected row.
- **Immediate streaming Chinese in live mode** — DashScope drafts and confirmed lines both use incremental `qwen-mt-flash`; the first Chinese chunk appears without a fixed wait, confirmed lines preempt stale drafts, and rolling translation memory improves the first visible result instead of correcting it after the scene has passed.
- **Readable continuous speech** — long monologues split at natural pauses with hard two-line limits; burst results keep source and translation paired and give each confirmed line time to be read instead of flashing over one another.
- **Multiple caption modes** — tab audio or microphone × DashScope / Chrome's built-in recognition (no API key).
- **Recognition-correction handling** — when the server rewrites a line, only the affected row is replaced; duplicates are suppressed at the source.
- **Low-latency audio path** — AudioWorklet capture and bounded weak-network buffering keep the feed current; short WebSocket interruptions reconnect automatically.
- **Shortcut** — **Alt+K** (**Option+K** on macOS) opens the Koe controller without changing the caption switch.
- **Toolbar icon** — opens a minimal controller whose primary button explicitly starts or stops captions. History and settings remain one click away.
- **Stops for real** — pressing Stop releases the audio stream entirely (no lingering "still listening" state).
- **History survives tab switches** — the subtitle record is persisted in the background, so switching tabs (each tab has its own side-panel instance) restores the session's history.
- **Privacy-friendly diagnostics** — copy or clear logs in one click; logs record timing, lengths, and errors, never subtitle text.

## Setup

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository.
3. Koe is off by default. Click the toolbar icon, then press the popup's primary button to start in-video captions for the current tab (or the audible tab). Open “Caption history & settings” only when you need to change the mode or size, or review history.
4. DashScope modes require a saved DashScope API Key.

### Optional local subtitles for ego-lite

Koe Helper currently requires **macOS 15 or later**, **ego-lite**, and an installed Swift 6 toolchain (Xcode Command Line Tools is sufficient). It is not a localhost server.

1. Find Koe's extension ID on `chrome://extensions` in ego-lite.
2. From the repository root, run `helper/scripts/install-ego-lite.sh <extension ID>`.
3. Reload Koe, open “Caption history & settings”, and choose “Tab video · Local accurate”.

The installer builds a user-scoped Native Messaging helper and registers it only for the supplied Koe extension ID in ego-lite. On first use, WhisperKit downloads the approximately 626 MB `large-v3` model; later sessions reuse the local cache. The helper supports unencrypted, non-byte-range MPEG-TS and CMAF/fMP4 HLS VOD (`.m3u8`). Plain MP4, DASH-only, and DRM media are currently unsupported, and the helper does not read browser cookies or authorization headers.

### Privacy

In local mode, media preparation, audio extraction, and speech recognition happen on your Mac. The helper temporarily fetches only the media data needed for the current subtitle windows; audio and video are not uploaded to Koe, DashScope, or object storage. Recognized original-language subtitle text also stays local by default.

On macOS 26+, local accurate mode can enable Simplified Chinese translation, also computed on-device by Apple's Translation framework, keeping the whole media/recognition/translation/display path on your Mac. For first use, open **System Settings → General → Language & Region → Translation Languages**, enable **On-Device**, and download the language pack; it gracefully falls back to original-only when the pack is missing or the Mac is on macOS 15–25.

The DashScope API Key is stored in `chrome.storage.local` in your browser profile and is used only for direct DashScope requests.

## Development

The extension runtime is plain Manifest V3 JavaScript. Reload it from `chrome://extensions` after changing the source. The optional local helper is a Swift package under `helper/`; see `helper/README.md` for its protocol, support boundaries, and development checks.

Main pieces: `background.js` coordinates sessions, media timelines, state, and history; `offscreen.js` / `pcm-worklet.js` capture audio and run live recognition and translation; `content.js` detects video state and renders in-video captions; `popup.*` is the gesture-based controller; `sidepanel.*` provides settings, diagnostics, and scroll-back history; `helper/` provides the optional Native Messaging local pipeline.

© 2026 yuxino
