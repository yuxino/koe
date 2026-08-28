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

1. From [Koe Releases](https://github.com/yuxino/koe/releases), download and fully extract the `Koe-*-macOS-arm64.zip` asset from **v1.9.5 or later**. v1.9.4 and earlier do not include automatic restore.
2. Double-click `Install Koe.command` in the extracted folder. If macOS blocks it, Control-click the file, choose **Open**, and confirm once.
3. The installer copies the extension to a stable application-support directory and opens ego-lite. Koe appears automatically; there is no extension-page step and no repeated import after reopening the browser.

You can move or delete the extracted folder afterward. The installer registers a small per-user startup item that runs only while a genuine ego-lite local socket exists. It verifies the browser publisher plus Koe's fixed ID, version, managed path, and file hashes before restoring the extension; it does not read page content, browsing history, cookies, or Koe settings. Restoration uses an isolated empty task with no user pages and closes it immediately after verification. Run `~/Library/Application Support/Koe/Disable Koe Auto-Load.command` to disable restore. Koe remains in the current browser process until you quit, but the next launch will not restore it. Rerun the installer to enable restore again.

Open a video, choose Koe, then click the button labelled **开启本地精准字幕**. No Xcode, Swift toolchain, administrator access, or extension ID is required. The download is about 1.5–2 MB and expands to about 4 MB; the current version installs about 3 MB, while an older Helper may remain for diagnostics. The Git download contains neither the development build cache nor the Whisper model.

The first local-caption session downloads the approximately 626 MB Whisper model and reuses the local cache afterward. Alternatively, switch to **DashScope** in the side panel and save your own API Key.

> Upgrading from development version 1.8.3 or earlier: version 1.9.0's fixed extension ID makes this a one-time new extension install. Remove the old Koe entry, then run the installer; a DashScope API Key stored by the old extension must be entered again. If 1.9.0–1.9.4 was loaded manually, run the new installer and quit/reopen ego-lite once so it switches to the managed path. If the extensions page still shows the old folder, remove that old Koe entry and rerun the installer. Later upgrades only require rerunning the installer.

## Koe Helper

Koe Helper is required only for Local accurate mode. The download contains two precompiled Apple silicon Helpers. macOS 15–25 automatically uses the compatibility Helper for local transcription in the original language; use DashScope for Chinese translation. macOS 26+ automatically uses the Translation-enabled Helper and can translate locally when the required Apple language pack is installed. `Install Koe.command` selects, verifies, installs, and registers the right one.

The current Git download is a developer preview. The Helper is not yet Developer ID signed or Apple notarized. Only after its SHA-256 and code-signature structure pass validation does the installer remove quarantine from the copied Helper; if macOS blocks the installer itself, Control-click it and choose **Open**. Truly frictionless public distribution still requires a signed and notarized PKG or DMG.

The installer also writes a compatibility registration for Google Chrome, but automatic restore is limited to ego-lite. Chrome still needs a manual `chrome://extensions` load from `~/Library/Application Support/Koe/Extension`.

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
