# Visible Media Status and Tab Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep local subtitles alive across tab/service-worker transitions and make recoverable or unsupported media states immediately visible without disrupting the video.

**Architecture:** Preserve and resume the active local session from `chrome.storage.session`, make offscreen capture starts identity-aware, and carry a stable `issueCode` plus user-facing detail from the Helper through the background state. Render that shared state as a compact persistent notice over the video and as explicit status text in the popup and side panel; clear it as soon as the session recovers or the media changes.

**Tech Stack:** Chrome Manifest V3 service worker/content scripts/offscreen document, vanilla HTML/CSS/JavaScript, Swift Native Messaging Helper, Node VM regression tests, Swift Package checks.

---

### Task 1: Add stable native issue codes

**Files:**
- Modify: `helper/Sources/KoeHelperCore/Protocol.swift`
- Modify: `helper/Sources/KoeHelper/SessionCoordinator.swift`
- Test: `helper/Sources/KoeHelperCoreChecks/main.swift`

**Step 1: Write the failing checks**

Encode a failed `HostResponse` and assert that it includes a stable `issueCode`. Cover at least protected HLS, unsupported audio, unreadable media, helper/protocol mismatch, and generic local processing failure.

**Step 2: Run the checks and verify failure**

Run: `swift run KoeHelperCoreChecks`

Expected: the new `issueCode` assertions fail because `HostResponse` only carries a localized error string.

**Step 3: Implement minimal classification**

Add optional `issueCode` to `HostResponse` and to `HostResponse.failure`. In `SessionCoordinator`, map typed errors to these stable values:

- `protected_media`
- `unsupported_audio`
- `unsupported_media`
- `media_unreadable`
- `helper_incompatible`
- `capture_failed`

Keep the existing Chinese `message` as the display detail; do not classify errors in JavaScript by matching localized strings.

**Step 4: Run the checks and verify pass**

Run: `swift run KoeHelperCoreChecks`

Expected: all Helper core checks pass.

### Task 2: Recover local sessions and serialize capture handoffs

**Files:**
- Modify: `background.js`
- Modify: `offscreen.js`
- Test: `test/session-routing.test.js`
- Test: `test/stream-reuse.test.js`

**Step 1: Write failing regressions**

Add one test that hydrates an active `offline-*` session after an MV3 worker restart and verifies it is eligible for automatic resume without a browser gesture. Add another test that starts tab A and tab B before A finishes and verifies B becomes the final `captureTabId/jobId/mediaEpoch` rather than inheriting A's result.

**Step 2: Run the focused tests and verify failure**

Run: `node test/session-routing.test.js && node test/stream-reuse.test.js`

Expected: local state is skipped by `restoreStates`, and concurrent starts collapse onto the first promise.

**Step 3: Implement local recovery**

Persist `captureNeedsGesture`, `localFallbackActive`, `mediaIdentity`, and the current stage fields needed for display. Restore local sessions as resumable state, reconnect the active previously-running local session when its video is still playing, and add a tab-activation nudge that calls the same idempotent discovery path. Never hand off an active session merely because another tab becomes active.

**Step 4: Implement identity-aware start serialization**

Replace the single anonymous `startCapturePromise` reuse with serialized latest-request processing. Identical `{tabId, jobId, mediaEpoch, streamId}` starts may share work; a different identity must run after/cancel the prior operation and its caller must receive the result for its own request.

**Step 5: Run focused tests and verify pass**

Run: `node test/session-routing.test.js && node test/stream-reuse.test.js`

Expected: both suites pass, including the new cross-tab race cases.

### Task 3: Propagate one explicit media-status contract

**Files:**
- Modify: `background.js`
- Test: `test/offline-media.test.js`
- Test: `test/action-indicator.test.js`

**Step 1: Write failing status tests**

Verify these states:

- no direct HLS plus no stream grant → `needs_tab_audio`, recoverable, toolbar `··`
- native protected/unsupported/unreadable response → matching terminal issue, toolbar `!`
- helper disconnect → `helper_unavailable`, toolbar `!`
- successful cues/status → issue fields cleared

Also assert that the background sends a page status message containing `kind`, `issueCode`, `title`, and `detail`.

**Step 2: Run tests and verify failure**

Run: `node test/offline-media.test.js && node test/action-indicator.test.js`

Expected: current state has only `stageDetail`, and recoverable status never reaches the page.

**Step 3: Implement status helpers**

Create a small background helper that updates `status`, `stageDetail`, `issueCode`, and `issueKind`, persists the state, and sends `KOE_MEDIA_STATUS` to the correct content frame. Use it for waiting-for-tab-audio, native errors, helper disconnects, and capture failures. Clear issue fields on new session, retry, `live`, or successful cues.

**Step 4: Run tests and verify pass**

Run: `node test/offline-media.test.js && node test/action-indicator.test.js`

Expected: status propagation and badge semantics pass without relying on localized string parsing.

### Task 4: Render the status visibly and consistently

**Files:**
- Modify: `content.js`
- Modify: `popup.js`
- Modify: `popup.css`
- Modify: `sidepanel.html`
- Modify: `sidepanel.js`
- Modify: `sidepanel.css`
- Test: `test/overlay.test.js`
- Test: `test/panel-open.test.js`
- Test: `test/sidepanel-draft.test.js`

**Step 1: Write failing UI regressions**

Assert that a recoverable status produces a persistent in-video notice with the exact action, a terminal issue produces a clear unsupported/failure notice, and `OFFLINE_SESSION`, successful cues, retry, source change, or stop clears it. Assert popup and side panel render `starting`, `captureNeedsGesture`, and `error` details instead of generic copy.

**Step 2: Run the UI tests and verify failure**

Run: `node test/overlay.test.js && node test/panel-open.test.js && node test/sidepanel-draft.test.js`

Expected: current page handling discards errors and the extension surfaces render only generic text.

**Step 3: Implement the in-video notice**

Add a separate `.notice` inside the existing Shadow DOM. Position it at the video's upper-right, use a near-black background, white primary text, muted secondary text, a 1px neutral border, no gradient, and no pointer interception. Keep it visible until state changes; do not reuse the subtitle lines or their bottom placement.

**Step 4: Implement popup and side-panel states**

Make popup `render()` always set status copy for idle, starting, needs-action, live, other-tab, and error states; use “重新尝试” for terminal errors. Add a compact status strip below the side-panel start button, promote specific error/action text there, and mirror it into the empty transcript placeholder. Preserve keyboard focus, readable contrast, and `aria-live` announcements.

**Step 5: Run UI tests and verify pass**

Run: `node test/overlay.test.js && node test/panel-open.test.js && node test/sidepanel-draft.test.js`

Expected: all UI state regressions pass.

### Task 5: Full verification and visual QA

**Files:**
- Modify only if verification finds a defect.

**Step 1: Run all JavaScript regressions**

Run: `for test_file in test/*.test.js; do node "$test_file" || exit 1; done`

Expected: every test exits successfully.

**Step 2: Run Helper checks and formatting checks**

Run: `swift run --package-path helper KoeHelperCoreChecks`

Run: `git diff --check`

Expected: Helper checks pass and the diff has no whitespace errors.

**Step 3: Visual QA in ego-lite**

Load the unpacked extension, verify a supported HLS video, a non-HLS page requiring tab-audio permission, and a forced terminal error. Confirm the notice stays within the video at normal and fullscreen sizes, does not cover subtitles, and clears immediately when retry succeeds or media changes.

**Step 4: Review the final diff**

Run: `git status --short && git diff --stat && git diff`

Expected: only scoped implementation, tests, and this plan are changed.
