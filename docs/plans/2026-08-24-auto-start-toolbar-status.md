# Koe Auto-start and Toolbar Status Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Start local subtitles when the page's main video begins playing and expose the global Koe session state on the browser toolbar.

**Architecture:** Keep the existing content-script activity signals and central `ensureLiveCaptions` scheduler. Allow a new local session only for an actually playing video, preserve `userStopped` as the restart guard, and derive a global action badge/title from persisted session state.

**Tech Stack:** Manifest V3 JavaScript, Chrome action API, Node.js `vm` regression tests, ego-lite.

---

### Task 1: Lock the behavior with regression tests

**Files:**
- Modify: `test/offline-media.test.js`
- Create: `test/action-indicator.test.js`

**Step 1: Write the failing auto-start tests**

Add cases proving that a playing local video creates a session without `forceReset`, a paused video does not, and a `userStopped` session never restarts from page activity.

**Step 2: Run the focused test and verify it fails**

Run: `node test/offline-media.test.js`

Expected: FAIL because the existing local-mode guard rejects every new background start.

**Step 3: Write the failing action-indicator test**

Exercise the background state projection for these exact outputs: starting → `··`, live → `ON`, error → `!`, idle → empty text. Also assert the matching Chinese action title.

**Step 4: Run the focused test and verify it fails**

Run: `node test/action-indicator.test.js`

Expected: FAIL because the background does not yet synchronize an action badge or title.

### Task 2: Implement safe local auto-start

**Files:**
- Modify: `background.js:318-500`
- Test: `test/offline-media.test.js`

**Step 1: Replace the blanket local-session guard**

For a new, non-forced local session, require `source.hasVideo`, `source.playing`, and a non-ad source. Do not weaken the existing `userStopped` checks for an existing state.

**Step 2: Keep explicit starts more permissive**

Continue allowing the popup and side panel to start local preparation while the selected video is paused.

**Step 3: Run the focused regression**

Run: `node test/offline-media.test.js`

Expected: PASS, including the stop and handoff invariants.

### Task 3: Synchronize the global toolbar indicator

**Files:**
- Modify: `background.js:1645-1719`
- Test: `test/action-indicator.test.js`

**Step 1: Add a pure state-to-indicator projection**

Map active session state to badge text, neutral/status background color, and a concise Chinese title. Prefer the active capture, then the most recent unresolved error; do not display stopped idle sessions.

**Step 2: Synchronize through the state persistence path**

Update the action badge and title whenever `persistStates()` runs, and once after boot restoration. Use global action calls without `tabId` so the state remains visible after changing tabs.

**Step 3: Make unsupported action methods non-fatal**

Guard optional Chrome action APIs and settle failures so status decoration can never interrupt subtitle processing.

**Step 4: Run focused tests**

Run: `node test/action-indicator.test.js && node test/offline-media.test.js && node test/stop-always.test.js`

Expected: PASS.

### Task 4: Release and verify

**Files:**
- Modify: `manifest.json`
- Modify: `README_ZH.md`
- Modify: `README.md`

**Step 1: Bump the patch version**

Change the extension version from `1.8.1` to `1.8.2`.

**Step 2: Document the behavior**

Mention play-triggered local auto-start, the stop safeguard, and the toolbar badge states.

**Step 3: Run the full regression suite**

Run every `test/*.test.js`, then run the Swift helper core checks and release build using the repository's existing commands.

Expected: all tests and builds pass.

**Step 4: Install and visually verify in ego-lite**

Reload the extension, play a supported HLS video, verify `··` appears during preparation, `ON` appears when cues are ready, and stopping clears the badge without automatic restart.

**Step 5: Commit the implementation**

Commit the tested implementation on `main` with a concise feature message. Do not push unless requested.
