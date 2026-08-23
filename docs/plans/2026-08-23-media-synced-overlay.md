# Media-Synced Page Subtitles Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make page subtitles Koe's low-latency primary experience while keeping side-panel history consistent and capture sessions resilient.

**Architecture:** DashScope timestamps become a session audio clock carried through offscreen, background, and content messages. A media epoch invalidates delayed work after seek/source changes, while a shadow-DOM overlay renders immediate drafts and stable bilingual finals. Session ownership and transcript rows are persisted by identity rather than inferred from service-worker globals.

**Tech Stack:** Chrome Manifest V3, plain JavaScript, Web Audio AudioWorklet, DashScope WebSocket, Shadow DOM, Node VM regression tests.

---

### Task 1: Lock session and history invariants with failing tests

**Files:**
- Create: `test/session-routing.test.js`
- Create: `test/transcript-consistency.test.js`
- Modify: `test/stream-reuse.test.js`

**Steps:**
1. Add a service-worker restart case where an offscreen message containing `jobId` and `tabId` restores the active route.
2. Add a different-stream-ID case and assert that the old tab stream is released.
3. Add same-seq original/translation merge and revoke persistence cases.
4. Run the three tests and confirm they fail against v1.6.37.

### Task 2: Make the capture session durable and singular

**Files:**
- Modify: `background.js`
- Modify: `offscreen.js`
- Test: `test/session-routing.test.js`
- Test: `test/stream-reuse.test.js`

**Steps:**
1. Pass `jobId`, `tabId`, and `mediaEpoch` in `CAPTURE_START` and every offscreen event.
2. Persist active status, source, engine, and epoch; hydrate state and transcript at service-worker module startup.
3. Route offscreen events from their descriptor when globals are empty.
4. Stop the previous active target before another target starts.
5. Track the tab stream ID and reuse only an identical stream.
6. Run the targeted tests until green.

### Task 3: Make settings and transcript history truthful

**Files:**
- Modify: `background.js`
- Modify: `sidepanel.js`
- Test: `test/transcript-consistency.test.js`
- Test: `test/sidepanel-draft.test.js`

**Steps:**
1. Send capture-mode changes to `currentState.tabId`.
2. Perform a full restart for source/engine changes and return a gesture-required state when switching to tab audio without a valid stream ID.
3. Store one transcript row per seq and merge `text`, `translated`, timing, and epoch.
4. Remove revoked seq ranges from memory and session storage.
5. Fall back to original text when a final translation is empty.
6. Run transcript and side-panel regressions.

### Task 4: Carry ASR timing and media epochs end to end

**Files:**
- Modify: `offscreen.js`
- Modify: `background.js`
- Modify: `content.js`
- Create: `test/timeline.test.js`

**Steps:**
1. Convert server sentence times to the session audio clock and attach `beginTimeMs`, `endTimeMs`, `audioPositionMs`, `sentenceId`, and `mediaEpoch` to output messages.
2. Add `MEDIA_DISCONTINUITY` handling for seek/source changes and reset in-flight recognition/translation work.
3. Reject stale-epoch output in the background and content script.
4. Add tests for timestamp propagation and late results after seek.

### Task 5: Build the page subtitle overlay

**Files:**
- Modify: `content.js`
- Modify: `sidepanel.html`
- Modify: `sidepanel.js`
- Modify: `sidepanel.css`
- Create: `test/overlay.test.js`

**Steps:**
1. Create one guarded shadow-DOM overlay in the selected video frame.
2. Render immediate original drafts, stable original finals, and translated primary text without layout jumps.
3. Anchor above player controls, cap width and line count, support fullscreen and narrow video, and respect reduced motion.
4. Add persisted overlay visibility and size controls to side-panel settings.
5. Test session adoption, seq ordering, epoch reset, stale-result discard, and cleanup.

### Task 6: Replace deprecated audio processing and bound latency

**Files:**
- Create: `pcm-worklet.js`
- Modify: `offscreen.js`
- Modify: `test/stream-reuse.test.js`

**Steps:**
1. Add a 16 kHz mono AudioWorklet processor that posts 2048-sample batches.
2. Use `AudioWorkletNode` in Chrome and retain a narrow fallback only for unsupported test/legacy environments.
3. Bound queued PCM and respect WebSocket `bufferedAmount`, dropping oldest frames instead of accumulating delay.
4. Verify start, stop, restart, source switching, and teardown.

### Task 7: Fix subtitle-quality edge cases and perform final QA

**Files:**
- Modify: `offscreen.js`
- Modify: `background.js`
- Modify: `README.md`
- Modify: `README_ZH.md`
- Modify: relevant tests

**Steps:**
1. Scope duplicate suppression to server sentence identity so repeated real speech is preserved.
2. Detect Japanese kana before applying the already-Chinese shortcut.
3. Restrict the DashScope WebSocket header rule to the extension initiator and redact transcript text from persistent logs.
4. Run every `test/*.test.js`, syntax checks, manifest parsing, and `git diff --check`.
5. Load the unpacked extension in Chrome and visually verify normal, long-line, fullscreen, pause, seek, and rate-change states.
6. Update the README to describe page subtitles, synchronization behavior, and side-panel history.
