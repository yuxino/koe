# Ultra-Low-Latency Subtitles Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Minimize both audio-to-original and original-to-Chinese delay without adding a lower-quality translation path.

**Architecture:** Keep streaming ASR drafts as the immediate original source. Replace the throttled dual-model translation queue with a latest-first, abortable `qwen-mt-flash` incremental stream in which durable units preempt drafts and accuracy context is included in the first request.

**Tech Stack:** Chrome Manifest V3, plain JavaScript, DashScope WebSocket ASR, DashScope SSE translation, Node VM regression tests.

---

### Task 1: Lock the latency contract with failing tests

**Files:**
- Create: `test/translation-latency.test.js`
- Modify: `test/revoke.test.js`

**Steps:**
1. Assert an ASR draft emits `CAPTURE_PARTIAL` synchronously rather than waiting for the stability timer.
2. Simulate incremental DashScope SSE chunks and assert the first accumulated Chinese text is emitted before stream completion.
3. Assert draft and durable requests both use `qwen-mt-flash`, `incremental_output`, and SSE.
4. Hold a draft request open, enqueue a durable unit, and assert the draft is aborted and the unit starts next without a fixed throttle delay.
5. Run the targeted tests and confirm the new translation cases fail on the current implementation.

### Task 2: Implement incremental translation transport

**Files:**
- Modify: `offscreen.js`
- Test: `test/translation-latency.test.js`

**Steps:**
1. Add an SSE reader that handles split frames, `[DONE]`, DashScope errors, and JSON fallback responses.
2. Enable `X-DashScope-SSE` and `incremental_output` for `qwen-mt-flash`.
3. Accumulate chunks and expose the current translation through a callback.
4. Add request-to-first-output and request-to-completion diagnostic events.
5. Run the SSE transport tests until green.

### Task 3: Replace the throttled queue with priority scheduling

**Files:**
- Modify: `offscreen.js`
- Test: `test/translation-latency.test.js`
- Test: `test/revoke.test.js`

**Steps:**
1. Remove live `qwen-mt-plus`, the 700 ms normal-path wait, and two-unit batching.
2. Coalesce queued drafts to the latest text and reuse recent translation memory for the first-pass flash request.
3. Put durable units before drafts and abort any in-flight draft.
4. Emit incremental updates only while the request generation and item identity remain current; emit one final accumulated value at completion.
5. Keep rate-limit cooldown and model fallback behavior for failures.
6. Run the targeted translation and recognition regressions until green.

### Task 4: Verify the complete extension

**Files:**
- Modify: `manifest.json`
- Modify: `README.md`
- Modify: `README_ZH.md`

**Steps:**
1. Bump the patch version and document flash streaming/live-path behavior.
2. Run every `test/*.test.js` test.
3. Run JavaScript syntax checks, manifest parsing, and `git diff --check`.
4. Load the unpacked extension with ego-lite, start translated captions, and verify the extension error page is empty.
5. Inspect privacy-safe latency logs for ASR draft emission, translation first output, and translation completion.
