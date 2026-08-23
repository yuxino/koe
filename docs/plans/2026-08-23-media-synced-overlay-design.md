# Media-Synced Page Subtitles Design

## Product decision

Koe returns page subtitles to the primary viewing surface. The side panel remains available for history, settings, copying, and diagnostics, but it is no longer the only place where captions appear. The page treatment is intentionally quiet: centered above the player controls, at most two lines, original speech in the smaller line and Chinese translation in the primary line. It must remain readable on bright and dark video without looking like a floating application panel.

Real-time ASR cannot make finalized text appear before the model recognizes it. Koe therefore optimizes for low and stable perceived latency: intermediate recognition appears immediately, final text replaces it without jumping, and translation fills in as soon as it is ready. Exact ASR timestamps are used to reject stale results and preserve order, not to pretend that a late final can be shown in the past.

## Timing model

DashScope returns `sentence.begin_time`, `sentence.end_time`, `sentence_id`, and word timestamps relative to the current ASR task. The offscreen document converts these to a monotonically increasing session audio clock and attaches them to every partial, final, translation, and revoke event.

The selected video frame owns a media epoch. A new epoch begins on seek, source replacement, or capture-session replacement. Content messages include the epoch; the background and overlay reject messages from previous epochs. On seek, the overlay clears immediately and the ASR socket is reset so delayed text from the old playback position cannot reappear.

The overlay maintains an anchor between the latest audio position and `video.currentTime`. Partial text is shown immediately. A result that is unexpectedly ahead of the media clock may be scheduled briefly; a result that is too old is discarded. Pause keeps the current final visible briefly, while seek clears it. Playback-rate changes refresh the anchor without destroying the session.

## Session ownership

Every capture has one durable descriptor: `jobId`, `tabId`, `frameId`, `source`, `engine`, `mediaEpoch`, and active status. The descriptor is stored in `chrome.storage.session` and is also included in messages emitted by the offscreen document. This lets a restarted Manifest V3 service worker route the first resumed caption event without relying on lost global variables.

Only one capture may be active. Starting another target stops and releases the previous target first. A tab stream is reused only when its stream identity matches; the generic value `source="tab"` is not sufficient. Changing capture mode targets the active capture session, not whichever tab happens to be focused, and source changes perform a full stream transition.

Transcript storage is keyed by sequence number. Original and translated text merge into the same record, and revoke removes the same range from persistent history. Restoring the side panel therefore produces the same rows that were visible before switching tabs.

## Audio path

Chrome uses `AudioWorkletNode` for PCM extraction. The worklet batches 16 kHz mono samples before posting them to the offscreen page, keeping audio processing off the main thread and avoiding the deprecated `ScriptProcessorNode` path in supported Chrome versions. A bounded queue and WebSocket `bufferedAmount` limit prefer dropping old audio over accumulating seconds of subtitle lag on a weak connection.

The existing direct DashScope WebSocket remains. Its Authorization header rule is scoped to the Koe extension initiator. Diagnostic events remain available, but raw recognized and translated text is not persisted in logs by default.

## Quality behavior

Duplicate suppression uses the server sentence identity, so repeated dialogue such as “Yeah. Yeah.” remains intact when it belongs to different sentences. Japanese kana prevents the translation shortcut from treating Japanese text containing kanji as already-Chinese. Translation failures keep the original stable line visible instead of silently dropping speech.

## Verification

Automated regressions cover service-worker restoration, switching between two tab streams, running-mode changes, transcript merge/revoke, media epochs, timestamp propagation, repeated sentences, Japanese detection, and page-overlay behavior. Existing tests remain green.

Visual QA uses a local fixture with a video element to verify two-line layout, long English and CJK wrapping, pause, seek, rate changes, fullscreen, narrow players, and reduced-motion behavior.
