<div align="center">
  <img src="./assets/koe-avatar.png" alt="Koe" width="128">
  <h1>Koe</h1>
  <p>Local-first subtitles for video playing in a Chromium tab.</p>
  <p><a href="README_ZH.md">简体中文</a></p>
</div>

Koe generates manually controlled, media-synced subtitles with optional Simplified Chinese translation. Only captions appear over the video; controls, prompts, and errors stay in the popup or side panel.

## How it works

- **Off by default** — playback, page changes, settings, and opening Koe do not start subtitles. Only an explicit Start action from Koe's controls or context menu begins a session; once started, it follows media changes until you stop it. **Alt+K** only opens the controller.
- **Local accurate (default)** — Koe Helper runs Whisper `large-v3` on the Mac. Compatible public HLS uses the media timeline directly; when no usable HLS source is available, Koe can fall back to local tab-audio recognition.
- **DashScope** — captures tab audio for cloud recognition and optional Chinese translation. This mode requires your own DashScope API Key.
- **Language-aware translation** — captions that reliably match your browser language stay as one original line by default. You can disable this behavior in the side panel; uncertain language detection continues through the normal translation path.
- **Video-safe UI** — captions follow seeking, video changes, and fullscreen. Status and errors never cover the video.
- **One active session** — the toolbar shows global status, the side panel keeps recent confirmed lines and diagnostics, and Stop releases tab capture.

## Install

The lightweight installer supports an **Apple silicon Mac running macOS 15 or later**. The guided and tested browser path is [ego-lite](https://www.egolite.ai/download). Intel Macs are not supported yet.

1. From the [latest Koe release](https://github.com/yuxino/koe/releases/latest), download and fully extract `Koe-*-macOS-arm64.zip`.
2. Double-click `Install Koe.command` in the extracted folder. If macOS blocks it, Control-click the file, choose **Open**, and confirm once.
3. The installer copies the extension to a stable application-support directory and opens ego-lite. Koe appears automatically, with no extension-page step or repeated import after reopening the browser.

You can move or delete the extracted folder afterward. The installer registers a per-user auto-restore item for ego-lite and verifies the browser publisher, Koe's fixed identity, managed path, version, and file hashes in an isolated empty task. Run `~/Library/Application Support/Koe/Disable Koe Auto-Load.command` to disable it; rerun the installer to enable it again.

Open a video, click Koe, then click the start button. No Xcode, Swift toolchain, administrator access, or extension ID is required. The Git download contains neither the development build cache nor the Whisper model.

The first local-caption session downloads the approximately 626 MB Whisper model and reuses the local cache afterward. Alternatively, switch to **DashScope** in the side panel and save your own API Key.

> Upgrading from 1.8.3 or earlier: remove the old Koe entry, run the installer, and re-enter any DashScope API Key stored by the old extension. If 1.9.0–1.9.4 was loaded manually, rerun the installer and restart ego-lite once; remove the old manually loaded entry if it remains. Later updates only require rerunning the installer.

## Koe Helper

Koe Helper is required only for Local accurate mode. The download contains two precompiled Apple silicon Helpers. macOS 15–25 uses the compatibility Helper for local transcription in the original language; use DashScope for Chinese translation. macOS 26+ uses the Translation-enabled Helper and can translate locally when the required Apple language pack is installed. `Install Koe.command` selects, verifies, installs, and registers the right one.

The current Git download is a developer preview. Koe Helper is not Developer ID signed or Apple notarized, and the extension interface is currently Simplified Chinese. The installer removes quarantine only from a copied Helper that passes its integrity and code-signature-structure checks.

The installer also writes a compatibility registration for Google Chrome, but automatic restore is limited to ego-lite. Chrome still needs a manual `chrome://extensions` load from `~/Library/Application Support/Koe/Extension`.

Only developers rebuilding the Helper need Swift 6 plus the macOS 15.4 and macOS 26 SDKs. Refresh both lightweight payloads with:

```sh
scripts/update-helper-payload.sh all
./Install\ Koe.command
```

Pass `baseline` or `macos26` to update only one payload. The first source build downloads Swift dependencies.

The direct media path supports public, unencrypted, non-byte-range HLS VOD with MPEG-TS AAC or CMAF/fMP4 segments. Koe does not bypass DRM or read browser cookies and authorization headers; browser-internal pages cannot be captured. Pages without a usable direct HLS source may use the local tab-audio fallback instead. See [Koe Helper documentation](helper/README.md) for exact boundaries.

## Privacy

- **Permissions:** Koe uses browser permissions including all-site access, page scripting, tab-audio capture, local storage, Native Messaging, side-panel, and network rules to find media, place captions, save settings, connect Koe Helper, and authenticate DashScope. Audio recognition starts only after an explicit Start action.
- **Local accurate:** recognition stays on the Mac and is never sent to DashScope. Koe may download the Whisper model and read needed media segments from the original server; Apple language packs must be installed separately in System Settings.
- **DashScope:** captured tab audio is sent directly to DashScope for recognition. Translation also sends recognized text and up to five recent source/translation pairs for context; the video file itself is not uploaded.
- The API Key is stored in the browser profile and sent only to DashScope to authorize requests, not to Koe Helper. Recent captions stay in browser session storage, and diagnostic logs contain timing and errors rather than caption text.

## Development

The extension is plain Manifest V3 JavaScript with no build step. Reload it from `chrome://extensions` after changes. The optional Helper is a Swift package under `helper/`.

```sh
for test_file in test/*.test.js; do node "$test_file" || exit 1; done
swift run --package-path helper koe-helper-core-checks
scripts/package-release.sh
```

The release script assembles a ZIP from an explicit runtime allow-list in a clean directory. It excludes `.git`, `helper/.build`, tests, documentation, Swift Helper source, and models. Preview output is written to `dist/`; public distribution still requires Developer ID signing and Apple notarization.

© 2026 yuxino
