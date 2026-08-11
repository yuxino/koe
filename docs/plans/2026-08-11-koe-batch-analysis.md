# Koe Batch Video Analysis Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Koe's real-time audio caption MVP with an offline video-analysis workflow that produces a complete VTT file before captions are shown.

**Architecture:** The extension submits either a directly discoverable media URL, a PornHub/XVideos page URL, or a local video file. The server creates an asynchronous job, downloads or receives the source, uses FFmpeg to extract 16 kHz mono WAV audio, runs Fun-ASR over the complete source in bounded internal segments, merges and post-processes the timestamped transcript, and exposes the finished VTT. The extension waits for job completion, then attaches the VTT to the page video and starts playback from the beginning.

**Tech Stack:** Chrome MV3, vanilla JavaScript, Node.js built-in HTTP, FFmpeg, yt-dlp, Fun-ASR timestamped transcription, Node test runner.

---

### Task 1: Define the batch job contract

**Files:**
- Modify: `src/server/index.js`
- Create: `src/server/jobs.js`
- Test: `test/server.test.js`

**Behavior:** Add `POST /api/jobs` with `{ pageUrl, sourceUrl, filename }`, `GET /api/jobs/:id`, and `GET /api/jobs/:id/vtt`. Jobs expose `queued`, `downloading`, `analyzing`, `ready`, and `error` states. No subtitle lines are returned until the job is ready.

**Verification:** Test mock jobs through the full state contract and verify API-token protection applies to every job endpoint.

### Task 2: Add source acquisition and media normalization

**Files:**
- Create: `src/server/media.js`
- Modify: `src/server/index.js`
- Modify: `package.json`
- Test: `test/media.test.js`

**Behavior:** Accept direct media URLs and allowlisted PornHub/XVideos page URLs. Use `yt-dlp` for page extraction and FFmpeg for media normalization. Reject unsupported schemes, private-network targets, missing binaries, and DRM/login-wall failures with actionable errors. Local file upload uses a bounded request body and the same FFmpeg normalization path.

**Verification:** Unit-test URL validation, host classification, and command construction without invoking external binaries; integration-check `/health` reports required tool availability.

### Task 3: Run complete transcription before publishing subtitles

**Files:**
- Modify: `src/server/asr.js`
- Modify: `src/server/transcript.js`
- Modify: `src/server/jobs.js`
- Test: `test/asr.test.js`
- Test: `test/transcript.test.js`

**Behavior:** Process normalized audio in bounded internal segments, retain absolute offsets, merge all recognized words, then group lines and emit WebVTT. Internal segmentation is an implementation detail; the client receives only the completed transcript.

**Verification:** Test offset merging across segment boundaries, empty audio, provider errors, and VTT formatting.

### Task 4: Replace live capture in the extension

**Files:**
- Modify: `popup.html`
- Modify: `popup.js`
- Modify: `popup.css`
- Modify: `background.js`
- Modify: `content.js`
- Remove from runtime path: `offscreen.js`, `audio-worklet.js`, `offscreen.html`

**Behavior:** Replace Start/Stop captions with Analyze video. Discover the active video source, submit the page/source URL, poll the job, show progress without captions, and load the completed VTT as a native `<track>` or synchronized overlay. Start playback only after the VTT is ready. Support selecting a local file for pages whose media source is unavailable.

**Verification:** Static-check extension scripts, test the job-message state transitions with mocked runtime messages, and manually load the unpacked extension on a supported HTML5 video page.

### Task 5: Update deployment and documentation

**Files:**
- Modify: `README.md`
- Modify: `DEPLOY.md`
- Modify: `manifest.json`

**Behavior:** Document the batch workflow, FFmpeg/yt-dlp prerequisites, supported source classes, explicit DRM/login limitations, and the new API endpoints. Add only the host permissions required for supported source discovery.

**Verification:** Run `npm run check`, exercise `/health`, create a mock job, and verify the deployed service can report dependency status before publishing.

### Task 6: Commit and publish

**Files:**
- All files changed by Tasks 1–5.

**Verification:** Review `git diff`, run the complete test suite, commit with an intentional message, push `main`, then deploy the server and reload the unpacked extension.
