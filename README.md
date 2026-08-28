# Koe

Koe is a local-first subtitle extension for video playing in a Chromium tab.

[简体中文](README_ZH.md)

Koe recognizes speech, keeps captions aligned with the player, and can optionally translate them into Simplified Chinese. It is off by default and starts only when you click Koe's start button.

## What Koe does

- Runs Whisper `large-v3` locally on Apple silicon, using the media timeline for compatible public HLS and local tab audio as a fallback on other pages.
- Keeps captions aligned through seeking, video changes, and fullscreen, with an optional in-video overlay.
- Offers on-device Chinese translation on macOS 26+ with the required Apple language packs, or optional DashScope recognition and translation with your own API Key.
- Keeps one active session at a time; the side panel provides recent confirmed captions, display settings, and diagnostic logs.

## Get started

Koe requires an **Apple silicon Mac running macOS 15 or later**. [ego-lite](https://www.egolite.ai/download) is the guided and tested browser path; Intel Macs are not supported.

1. Download and fully extract the `Koe-*-macOS-arm64.zip` asset from the [latest Koe release](https://github.com/yuxino/koe/releases/latest).
2. Double-click `Install Koe.command`. If macOS blocks it, Control-click the file, choose **Open**, and confirm once.
3. Open a video, click Koe, then click the start button.

No Xcode, Swift toolchain, administrator access, or extension ID is required. The first local-caption session downloads the approximately 626 MB Whisper model and reuses the cache afterward.

The installer also enables per-user automatic restore for ego-lite. Run `~/Library/Application Support/Koe/Disable Koe Auto-Load.command` to disable it; rerun the installer to enable it again or update Koe.

## Permissions, privacy, and limits

- **Permissions:** Koe requests all-site access, page scripting, tab-audio capture, local storage, Native Messaging, side-panel, and network-rule permissions to find media, place captions, save settings, connect Koe Helper, and authenticate DashScope. Audio recognition starts only after an explicit Start action.
- **Local mode:** speech recognition stays on the Mac. Koe may download the Whisper model and fetch required public media segments from their original server or CDN. On macOS 15–25, local mode displays the original language only; macOS 26+ local translation requires the relevant Apple language pack.
- **DashScope and storage:** in DashScope mode, captured tab audio is sent directly to DashScope; translation also sends recognized text and up to five recent source/translation pairs for context. The video file is not uploaded. The API Key is stored in the browser profile and sent only to DashScope to authorize requests, not to Koe Helper. Recent captions stay in browser session storage, and diagnostic logs exclude caption text.
- **Media support:** direct media reading is limited to public, unencrypted HLS VOD. Other ordinary web pages may use the tab-audio fallback; browser-internal pages are unavailable. Koe does not bypass DRM or read cookies and Authorization headers. See the [technical Koe Helper boundaries (Chinese)](helper/README.md) for details.
- **Distribution:** the current download is a developer preview for Apple silicon. Koe Helper is not Developer ID signed or Apple notarized, and the extension interface is currently Simplified Chinese. Automatic installation and restore are limited to ego-lite; Google Chrome must load `~/Library/Application Support/Koe/Extension` manually from `chrome://extensions`.

© 2026 yuxino
