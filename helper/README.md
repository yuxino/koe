# Koe Helper

[简体中文](README_ZH.md) · [Koe](../README.md)

Koe Helper is the macOS Native Messaging host for Local accurate mode. It transcribes locally with WhisperKit, without a localhost service or calls to DashScope.

It has two processing paths: compatible HLS sources provide media segments near the current playback position directly; when no usable direct source is available, the extension can capture tab audio and send PCM through Native Messaging for local live transcription.

## Requirements

- Lightweight installer: an Apple silicon Mac running macOS 15 or later. Intel Macs are not supported yet.
- Source builds: Swift 6, plus the macOS 15.4 and macOS 26 SDKs.
- ego-lite is the currently guided and tested browser path. The installer also writes a compatibility registration for Chrome and limits Native Messaging origins to the fixed extension ID from the manifest.

## Install

1. Download and fully extract `Koe-*-macOS-arm64.zip` from the [latest Koe release](https://github.com/yuxino/koe/releases/latest).
2. Double-click `Install Koe.command` in the extracted folder, or run it from that folder in Terminal:

   ```sh
   ./Install\ Koe.command
   ```

3. The installer copies the extension to a stable directory and opens ego-lite, where Koe appears automatically. Google Chrome still requires a manual load from `~/Library/Application Support/Koe/Extension` on `chrome://extensions`.

No manual extension ID or Swift/Xcode installation is required. The first transcription session downloads and caches the `large-v3-v20240930_626MB` model.

The download contains two Helpers of approximately 1.7 MB each; the installer selects one for the system. macOS 15–25 uses the compatibility build without Translation.framework, while macOS 26+ uses the build with local translation. After changing Swift source, developers can run `scripts/update-helper-payload.sh all` to stage builds before updating both payloads and their SHA-256 files. Pass `baseline` or `macos26` to update only one payload. Build caches are excluded from user downloads.

The current Helper is an ad-hoc signed Git preview, without Developer ID signing or Apple notarization. The installer checks the fixed extension ID, SHA-256, Mach-O architecture, minimum system version, dependencies, and code-signature structure. It removes quarantine only from a copied Helper that passes those checks. The SHA files travel with the binaries and detect corruption; they do not establish publisher identity. Formal public distribution still requires signing and notarizing the entire release container.

## Local translation

Apple silicon Macs running macOS 26 or later can use Apple Translation for local Simplified Chinese translation. Enable **On-Device** and download the required language packs in **System Settings → General → Language & Region → Translation Languages** first. The macOS 15–25 compatibility build still provides local Whisper transcription, but Local accurate mode displays only the original language; switch to DashScope if Chinese translation is needed.

Koe retains the original captions when local translation is unavailable because of an older system, an Intel Mac, missing language packs, an unsupported language pair, or a translation failure.

## Supported media and limits

- Direct HLS reading supports only public HTTP/HTTPS `.m3u8` VOD: unencrypted, without byte ranges, and with MPEG-TS AAC/ADTS or complete CMAF/fMP4 audio segments.
- Ordinary MP4, DASH, and other media do not use the direct parser. Local live fallback is available when the browser can capture tab audio.
- Koe does not bypass DRM. Encrypted HLS cannot be read directly; the browser and player determine whether tab capture is allowed on other protected pages.
- The direct path does not read Cookie or Authorization headers. It forwards only the necessary Origin/Referer headers and rejects localhost, private, loopback, link-local, and unsafe redirect targets.

Local processing may still connect to the network to download the Whisper model and fetch segments for the current caption window from the original media server or CDN. Apple language packs must be installed separately in System Settings. Audio and recognized text are not sent to DashScope.
