# Koe Local-First Workspace Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Koe remember ordinary settings across extension reinstalls, default to translation, support non-HLS sites through a private local-live Whisper fallback, and replace the debug-like side panel with a polished subtitle workspace.

**Architecture:** Browser storage remains authoritative and retains the API Key; Helper mirrors only an allow-listed non-secret preference document. Local mode becomes a router: HLS keeps the existing ahead-of-playback pipeline, while missing HLS switches to tab-audio PCM streamed through Native Messaging to short overlapping Whisper windows. The side panel and popup consume the same session state but present a neutral, reading-first interface.

**Tech Stack:** Manifest V3 JavaScript, Chrome storage/tabCapture/offscreen/nativeMessaging APIs, vanilla HTML/CSS, Swift 6, WhisperKit, Apple Translation, Node-based regression tests, ego-lite visual and real-site QA.

---

### Task 1: Preference defaults and native mirror

**Files:**
- Create: `preferences.js`
- Modify: `background.js`
- Modify: `sidepanel.js`
- Modify: `helper/Sources/KoeHelperCore/Protocol.swift`
- Create: `helper/Sources/KoeHelper/PreferenceStore.swift`
- Modify: `helper/Sources/KoeHelper/SessionCoordinator.swift`
- Test: `test/preferences.test.js`
- Test: `helper/Sources/KoeHelperCoreChecks/main.swift`

**Steps:**
1. Add failing tests for first-install defaults, browser-over-native precedence, native restore with API Key excluded, and `unknown` translation capability preserving `koeTranslate=true`.
2. Run `node test/preferences.test.js` and confirm the new assertions fail.
3. Add an allow-listed preference schema and normalization in JS and Swift.
4. Add Helper `preferencesGet` / `preferencesSet` requests and an atomic Application Support store.
5. Initialize preferences during background boot, mirror storage changes, and make native translation capability tri-state.
6. Run the preference test and Helper core checks; expect all cases to pass.

### Task 2: Local-live PCM protocol and Whisper windows

**Files:**
- Create: `helper/Sources/KoeHelperCore/PCMStreamBuffer.swift`
- Modify: `helper/Sources/KoeHelperCore/Protocol.swift`
- Modify: `helper/Sources/KoeHelper/SessionCoordinator.swift`
- Modify: `helper/Sources/KoeHelper/WhisperTranscriber.swift`
- Modify: `helper/Sources/KoeHelperCoreChecks/main.swift`

**Steps:**
1. Add failing core checks for PCM validation, first-window latency, bounded buffering, overlap offsets, WAV headers, and reset behavior.
2. Run `swift run --package-path helper koe-helper-core-checks`; confirm the new checks fail to compile or fail assertions.
3. Implement a bounded 16 kHz mono PCM buffer that emits a short bootstrap window and overlapping steady windows.
4. Implement WAV framing and native `streamStart`, `streamAudio`, `streamStop` request validation.
5. Extend `SessionCoordinator` to transcribe one stream window at a time, merge overlap, and emit original cues followed by local translations.
6. Run Helper core checks and a release build; expect checks to pass and record any local toolchain-only build blocker separately.

### Task 3: Browser local-live routing

**Files:**
- Modify: `offscreen.js`
- Modify: `background.js`
- Modify: `popup.js`
- Modify: `content.js`
- Test: `test/local-live.test.js`
- Test: `test/offline-media.test.js`
- Test: `test/stop-always.test.js`

**Steps:**
1. Add failing tests for non-HLS fallback, gesture-required state, neutral toolbar indication, API-key-free local PCM capture, native PCM forwarding, cue delivery, and complete stop cleanup.
2. Run the focused tests and confirm failures.
3. Add a local engine branch to offscreen PCM capture; batch frames and send them to the background without opening DashScope.
4. Change local media discovery to select HLS when present and enter local-live after the discovery deadline when absent.
5. Use an explicit toolbar/shortcut stream ID to start local-live, keep HLS automatic, and forward native live cues through the existing live subtitle messages.
6. Harden stop, seek, handoff, translation toggle, and stale epoch handling.
7. Run focused and existing offline/session tests; expect all to pass.

### Task 4: Side-panel and popup redesign

**Files:**
- Modify: `sidepanel.html`
- Modify: `sidepanel.css`
- Modify: `sidepanel.js`
- Modify: `popup.html`
- Modify: `popup.css`
- Modify: `popup.js`
- Test: `test/sidepanel-layout.test.js`
- Test: `test/sidepanel-draft.test.js`
- Test: `test/panel-open.test.js`

**Steps:**
1. Add a failing static layout test asserting semantic controls, a dedicated empty state, responsive settings sheet, and no visible log-copy/log-clear controls.
2. Replace the current stacked controls and bordered feed with the approved editorial workspace structure while retaining stable functional IDs where useful.
3. Implement neutral design tokens, responsive typography, transcript separators, accessible focus states, reduced-motion behavior, and concise status language.
4. Update state rendering for HLS preparing, local-live gesture, local-live running, cloud running, and genuine error states.
5. Restyle the popup to match and make explicit local starts obtain a tab stream ID for fallback.
6. Run layout, draft, and panel-open tests; expect all to pass.
7. Inspect screenshots at 320×720, 380×820, and 480×900; fix every visible overflow, hierarchy, focus, and empty-state issue before continuing.

### Task 5: Full regression, real-site QA, documentation, and release

**Files:**
- Modify: `manifest.json`
- Modify: `README.md`
- Modify: `README_ZH.md`
- Modify: `helper/README.md`

**Steps:**
1. Run every `test/*.test.js`; expect zero failures.
2. Run Helper core checks and release packaging where the local SDK permits.
3. Reload Koe in ego-lite and verify idle, settings, gesture-required, live transcript, and error UI states visually.
4. Test the supplied YouTube video: it must enter local-live or request one click, never show the old HLS/DASH technical error, and must not call DashScope in local mode.
5. Recheck an HLS video to ensure automatic ahead-of-playback captions remain intact.
6. Update privacy/support documentation and bump the extension minor version.
7. Run `git diff --check`, review the complete diff, commit scoped changes, and push `main`.
