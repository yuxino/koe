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
- **Language-aware translation** — by default, captions that reliably match your browser language stay as one original line instead of being translated again. The side-panel setting can disable this behavior; uncertain language detection continues through the normal translation path.
- **Video-safe UI** — captions follow seeking, video changes, and fullscreen. Status and errors never cover the video.
- **One active session** — the toolbar shows global status, the side panel keeps recent confirmed lines from the current session plus diagnostics, and Stop releases tab capture.

## Install

The lightweight installer supports an **Apple silicon Mac running macOS 15 or later**. The guided and tested browser path is [ego-lite](https://www.egolite.ai/download). Intel Macs are not supported yet.

1. [Download the Koe ZIP](https://github.com/yuxino/koe/archive/refs/heads/main.zip) and fully extract it.
2. Double-click `Install Koe.command` in the extracted folder. If macOS blocks it, Control-click the file, choose **Open**, and confirm once.
3. The installer opens `chrome://extensions` in ego-lite. Enable **Developer mode**, choose **Load unpacked**, and select the extracted repository root (the folder that directly contains `manifest.json`). For a dedicated release ZIP, select its `Koe Extension` folder instead.

Keep the selected folder in a permanent location. Koe runs directly from that unpacked folder, so moving or deleting it after loading will make the extension unavailable.

Open a video, choose Koe, then click the button labelled **开启本地精准字幕**. No Xcode, Swift toolchain, administrator access, or extension ID is required. The download is about 2–3 MB and expands to about 6–7 MB; the installer selects one of two precompiled Helpers and writes about 3 MB. The Git download contains neither the 1.7 GB development build cache nor the Whisper model.

The first local-caption session downloads the approximately 626 MB Whisper model and reuses the local cache afterward. Alternatively, switch to **DashScope** in the side panel and save your own API Key.

> Upgrading from development version 1.8.3 or earlier: version 1.9.0's fixed extension ID makes this a one-time new extension install. Remove the old Koe entry, then load the new folder; a DashScope API Key stored by the old extension must be entered again. For upgrades after 1.9.0, first replace the files in the same folder currently loaded by the browser, then rerun the installer and click Reload. Extracting a new ZIP elsewhere and reloading the old entry does not update its code.

## Koe Helper

Koe Helper is required only for Local accurate mode. The download contains two precompiled Apple silicon Helpers. macOS 15–25 automatically uses the compatibility Helper for local transcription in the original language; use DashScope for Chinese translation. macOS 26+ automatically uses the Translation-enabled Helper and can translate locally when the required Apple language pack is installed. `Install Koe.command` selects, verifies, installs, and registers the right one.

The current Git download is a developer preview. The Helper is not yet Developer ID signed or Apple notarized. Only after its SHA-256 and code-signature structure pass validation does the installer remove quarantine from the copied Helper; if macOS blocks the installer itself, Control-click it and choose **Open**. Truly frictionless public distribution still requires a signed and notarized PKG or DMG.

The installer also writes a compatibility registration for Google Chrome, but currently opens and tests only ego-lite. Chrome must be opened at `chrome://extensions` and loaded manually.

Only developers rebuilding the Helper need Swift 6 plus the macOS 15.4 and macOS 26 SDKs. Refresh both lightweight payloads with:

```sh
scripts/update-helper-payload.sh all
./Install\ Koe.command
```

Pass `baseline` or `macos26` to update only one payload. The first source build downloads Swift dependencies.

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
scripts/package-release.sh
```

The release script assembles a ZIP from an explicit runtime allow-list in a clean directory. It excludes `.git`, `helper/.build`, tests, documentation, Swift Helper source, and models. Preview output is written to `dist/`; public distribution still requires Developer ID signing and Apple notarization.

© 2026 yuxino
