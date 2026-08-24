# Visible Media Status and Tab Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

> **Product update:** This plan was revised after review to remove the in-video media-status notice. Media issues remain visible in the popup and side panel; the page overlay now contains subtitles only.

**Goal:** Keep local subtitles alive across tab/service-worker transitions and make recoverable or unsupported media states immediately visible without disrupting the video.

**Architecture:** Preserve and resume the active local session from `chrome.storage.session`, make offscreen capture starts identity-aware, and carry a stable `issueCode` plus user-facing detail from the Helper through the background state. Render that shared state as explicit status text in the popup and side panel; keep the page overlay subtitle-only and clear issue state as soon as the session recovers or the media changes.

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

Also assert that `GET_STATE` keeps returning the issue after a terminal failure releases `captureTabId`, while the page receives only a legacy `clear` message and never an actionable/error card.

**Step 2: Run tests and verify failure**

Run: `node test/offline-media.test.js && node test/action-indicator.test.js`

Expected: current state has only `stageDetail`, terminal errors disappear from controller queries after capture ends, and actionable/error status still reaches the page.

**Step 3: Implement status helpers**

Create a small background helper that updates `status`, `stageDetail`, `issueCode`, and `issueKind`, persists the state, and sends only a legacy `KOE_MEDIA_STATUS` clear to the correct content frame. Use it for waiting-for-tab-audio, native errors, helper disconnects, and capture failures. Clear issue fields on new session, retry, `live`, or successful cues, and expose the most recent terminal issue to controller queries after capture ends.

**Step 4: Run tests and verify pass**

Run: `node test/offline-media.test.js && node test/action-indicator.test.js`

Expected: status propagation and badge semantics pass without relying on localized string parsing.

### Task 4: Render controller status visibly and consistently

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

Assert that recoverable and terminal statuses do not mount an in-video notice, while popup and side panel render `starting`, `captureNeedsGesture`, and `error` details instead of generic copy. Keep successful subtitle rendering covered independently.

**Step 2: Run the UI tests and verify failure**

Run: `node test/overlay.test.js && node test/panel-open.test.js && node test/sidepanel-draft.test.js`

Expected: current page handling still mounts a status notice and the extension surfaces render only generic text.

**Step 3: Keep the video overlay subtitle-only**

Remove the `.notice` markup, styling, state, and message handling from the content script. Keep issue classification in background state for controller surfaces, and send only a legacy `clear` page message so an already-open page from an older build can dismiss an existing notice.

**Step 4: Implement popup and side-panel states**

Make popup `render()` always set status copy for idle, starting, needs-action, live, other-tab, and error states; use “重新尝试” for terminal errors. Add a compact status strip below the side-panel start button, promote specific error/action text there, and mirror it into the empty transcript placeholder. Preserve keyboard focus, readable contrast, and `aria-live` announcements.

**Step 5: Run UI tests and verify pass**

Run: `node test/overlay.test.js && node test/panel-open.test.js && node test/sidepanel-draft.test.js`

Expected: all UI state regressions pass, and only actual subtitles can mount over the video.

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

Load the unpacked extension, verify a supported HLS video, a non-HLS page requiring tab-audio permission, and a forced terminal error. Confirm the video shows subtitles only at normal and fullscreen sizes, while action/error detail remains available in the popup and side panel and clears immediately when retry succeeds or media changes.

**Step 4: Review the final diff**

Run: `git status --short && git diff --stat && git diff`

Expected: only scoped implementation, tests, and this plan are changed.
