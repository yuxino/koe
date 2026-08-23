# Readable Long Subtitles Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Keep Koe's first translated text near-instant while making uninterrupted speech readable, bounded, and visually stable on the video.

**Architecture:** Keep the existing draft translation fast path unchanged. Bound committed ASR units with a language-aware subtitle segmenter, split oversized server finals with the same policy, and make the page overlay a two-line rolling viewport. Add a short display gate only when multiple final units arrive almost simultaneously, so a later unit cannot erase an unread predecessor.

**Tech Stack:** Chrome Manifest V3, vanilla JavaScript, DashScope realtime ASR / Qwen MT, Node `vm` regression tests, ego-lite visual QA.

---

### Task 1: Lock the long-speech behavior with tests

**Files:**
- Create: `test/long-subtitle.test.js`
- Modify: `test/overlay.test.js`

**Step 1: Write the failing ASR segmentation tests**

Cover these behaviors through the existing `offscreen.js` VM harness:

- a punctuation-free Latin draft can commit after the maximum wait once it is readable, without waiting for 120 characters;
- a committed Latin unit never exceeds the overlay's 64-character readable hard cap and prefers a word or pause boundary;
- an oversized server final is split into bounded units;
- short final sentences are packed when possible instead of being emitted as several same-timestamp fragments.

**Step 2: Run the test to verify it fails**

Run: `node test/long-subtitle.test.js`

Expected: FAIL because the current 120/60 thresholds and sentence-only final splitter produce oversized or immediately adjacent units.

**Step 3: Write the failing overlay pacing tests**

Extend `test/overlay.test.js` with controllable timers and assertions that:

- long draft text is reduced to a readable rolling viewport;
- a second final unit received immediately is queued rather than replacing the visible unit;
- its translation attaches to the queued unit and appears when that unit becomes visible;
- a normal later unit is still displayed immediately.

**Step 4: Run the overlay test to verify it fails**

Run: `node test/overlay.test.js`

Expected: FAIL because `content.js` currently writes every unit directly into the same two DOM nodes.

### Task 2: Add one shared subtitle-sized segmentation policy

**Files:**
- Modify: `offscreen.js`
- Test: `test/long-subtitle.test.js`

**Step 1: Replace stale long-tail constants**

Use separate readable minimums and hard maximums. Latin units target natural breaks and remain at or below roughly two compact source lines; CJK units use a smaller character budget. Shorter incomplete text continues waiting, while complete sentences still commit promptly.

**Step 2: Bound complete sentences as well as incomplete tails**

Make the draft committer return the first complete sentence only when it fits. If it is oversized, cut it at sentence punctuation, pause punctuation, or a word boundary in that order.

**Step 3: Segment server finals with the same hard caps**

Replace sentence-only `splitSentences` output with subtitle-sized units. Pack adjacent short sentences up to the cap and never synchronously emit several tiny lines that fit comfortably together.

**Step 4: Run the focused tests**

Run: `node test/long-subtitle.test.js && node test/final-append.test.js && node test/revoke.test.js`

Expected: PASS.

### Task 3: Make the page overlay a stable rolling viewport

**Files:**
- Modify: `content.js`
- Test: `test/overlay.test.js`

**Step 1: Add display-only text fitting**

Fit source and translated text independently, preserving their full values in the recognition/transcript pipeline. Show only the latest readable portion of a growing draft and clamp each visible language to two lines.

**Step 2: Add burst-only unit pacing**

Track the visible committed unit by sequence. When another committed unit arrives before a short minimum reading interval has elapsed, enqueue it; store its translation by sequence; then promote it after the interval. Do not delay normal units that arrive after the interval, and clear the queue on seek, revoke, stop, or session reset.

**Step 3: Run the focused test**

Run: `node test/overlay.test.js`

Expected: PASS.

### Task 4: Full regression and visual QA at 2:50

**Files:**
- Modify if needed: `test/*.test.js`, `content.js`, `offscreen.js`

**Step 1: Run syntax and all regressions**

Run: `node --check offscreen.js && node --check content.js && for test_file in test/*.test.js; do node "$test_file"; done`

Expected: every test passes.

**Step 2: Reload the local extension in ego-lite**

Reuse the existing `koe long subtitle 2m50` task space and the supplied Pornhub URL. Inject the updated content script if a browser-level tab-capture gesture is unavailable.

**Step 3: Verify the video overlay visually**

At 2:50 or later, verify at desktop width that source and Chinese remain within their line budgets, the overlay stays centered over the video, and burst units remain readable instead of replacing one another instantly. Do not include explicit transcript text in QA notes or screenshots shared back to the user.

### Task 5: Release metadata and commit

**Files:**
- Modify: `manifest.json`
- Modify: `README.md`
- Modify: `README_ZH.md`

**Step 1: Bump the patch version and document the behavior**

Describe readable long-speech segmentation, burst pacing, and the unchanged streaming translation fast path.

**Step 2: Re-run the full regression and whitespace checks**

Run: `git diff --check && for test_file in test/*.test.js; do node "$test_file"; done`

Expected: no whitespace errors and every test passes.

**Step 3: Commit on `main`**

Run: `git add ... && git commit -m "v1.7.2: make long subtitles readable"`
