# Local Media Relay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Process the current page's video on the user's Mac, send only extracted audio to the existing Koe API for complete ASR, and keep yt-dlp as a local fallback.

**Architecture:** The extension talks only to a loopback Koe helper. The helper first gives the browser-discovered MP4/HLS URL directly to ffmpeg; if that fails or the page exposes only a blob URL, it falls back to local yt-dlp. It uploads the resulting mono compressed audio to the existing authenticated Koe API, mirrors remote progress, and returns the completed VTT through the existing job interface.

**Tech Stack:** Chrome Manifest V3, Node.js HTTP server, ffmpeg, yt-dlp fallback, macOS LaunchAgent, Node test runner.

---

### Task 1: Generic local media extraction

**Files:**
- Modify: `src/server/media.js`
- Test: `test/media.test.js`

1. Add failing tests proving direct MP4/HLS URLs are passed to ffmpeg with Referer and that a direct-input failure falls back to page extraction.
2. Run `node --test test/media.test.js`; expect the new tests to fail because `extractAudioLocally` does not exist.
3. Add `extractAudioLocally({ pageUrl, sourceUrl, outputDir, ffmpegBin, ytdlpBin, run })`. Write 16 kHz mono AAC to `audio.m4a`; use the browser URL first and call `acquireSource` only as fallback.
4. Run `node --test test/media.test.js`; expect all media tests to pass.

### Task 2: Audio-only relay to the production API

**Files:**
- Create: `src/server/relay.js`
- Create: `test/relay.test.js`

1. Add a failing integration test with a mock remote Koe server: create upload job, stream a local audio file, poll until ready, and download VTT.
2. Run `node --test test/relay.test.js`; expect module-not-found failure.
3. Implement `relayAudioToKoe` with Bearer auth, streamed upload, bounded polling, progress forwarding, and explicit 401/error messages.
4. Run `node --test test/relay.test.js`; expect pass.

### Task 3: Local relay job mode

**Files:**
- Modify: `src/server/jobs.js`
- Modify: `src/server/index.js`
- Modify: `src/server/media.js`
- Modify: `test/server.test.js`

1. Add a failing server test that starts Koe with `remoteUrl` and `remoteToken`, accepts an arbitrary public page URL, and reports `mode: local-relay`.
2. Run `node --test test/server.test.js`; expect failure.
3. Add a local-relay processor that extracts audio locally, relays it remotely, and returns VTT. Permit arbitrary public page URLs only in local-relay mode; preserve the production server's restricted fallback hosts.
4. Expose `localProcessing: true` from `/health` and keep the server bound to `127.0.0.1`.
5. Run `node --test test/server.test.js`; expect pass.

### Task 4: Make the extension local-first

**Files:**
- Modify: `manifest.json`
- Modify: `popup.html`
- Modify: `popup.js`
- Modify: `background.js`

1. Set the fixed API URL to `http://127.0.0.1:8787` and stop sending a browser-stored server Token.
2. Remove service URL and Token inputs from the popup. Show whether the local helper is connected and whether processing is local.
3. Keep current-tab video discovery and completed-VTT loading unchanged.
4. Run `node --check popup.js && node --check background.js`; expect pass.

### Task 5: Local installation and documentation

**Files:**
- Create: `scripts/install-local-helper.sh`
- Modify: `README.md`

1. Add an idempotent installer that checks Node, ffmpeg, and yt-dlp; writes a user LaunchAgent; stores the remote Koe Token in macOS Keychain; and starts the loopback helper.
2. Document that full video stays local, only extracted audio reaches the Koe API, and yt-dlp is fallback-only.
3. Run the installer against the current checkout, verify `curl http://127.0.0.1:8787/health`, and reload the unpacked extension in ego-lite.

### Task 6: Verification and publication

**Files:**
- Verify all changed files.

1. Run `npm run check`; expect all tests and syntax checks to pass.
2. Verify a browser-discovered direct media URL reaches local ffmpeg without invoking yt-dlp using test instrumentation.
3. Verify an audio upload reaches the production API with authenticated job creation and no full-video upload.
4. Commit the feature, merge to `main`, push `yuxino/koe`, and confirm GitHub Actions succeeds.
