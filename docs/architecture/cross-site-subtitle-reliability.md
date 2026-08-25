# Cross-site subtitle reliability

These are the reusable constraints behind Koe’s YouTube and MissAV fixes. They apply to any site whose player exposes a usable video clock but whose audio, media URL, or DOM structure differs.

## Timing model

- Keep media time and wall time separate. Media time answers whether a cue belongs to the current playback position; wall time answers how long a late finalized cue remains readable.
- Local ASR completion lag is expected. A multi-second PCM window plus Whisper inference must not be treated as a stale network packet.
- Accept lateness only within a bounded wall-time window. Once accepted, give an already-ended cue a stable reading duration instead of deriving a near-zero timeout from its old media end time.
- Playback rate converts between media gaps and wall-time limits. Pause, seek, rate change, source change, and session replacement must fence old work with a new epoch.

## Translation model

- Keep “translation enabled” separate from “this cue needs translation.” A per-cue same-language decision must not silently turn off the user’s master preference.
- Language detection is advisory. Skip only on reliable, sufficiently confident evidence; otherwise continue translating.
- A skipped translation is a passthrough result, not an empty result. Rendering must collapse identical original/translated text and must never hide the only usable line.
- Language preferences belong on every start and reset boundary. Changing them while work is in flight requires a new epoch so old translations cannot leak into the new policy.
- Every consumer, including the side-panel transcript, must gate subtitle messages by both job and epoch. A higher epoch resets sequence high-water marks; a lower epoch is rejected. A translation revision for the same epoch and sequence is an upsert, not a duplicate.

## Reset concurrency

- Any reset path that awaits close, delay, or reconnect work needs an operation token. A superseded reset must finish quietly without creating a socket or publishing a session under the newer state object.
- Queue entries belong to the generation that created them. An old worker may discard its own result after a reset, but it must never clear a shared queue containing newer-generation work; when it exits, it must hand execution to any queued current-generation items.
- Snapshot job, epoch, translation mode, and language policy before the first await. Use those frozen fields for native/offscreen requests and re-check identity before announcing the replacement session.

## Player discovery

- Select the main player by observable playback state and visible area, not by assuming the first `<video>` element is authoritative. Ad, thumbnail, preload, and hidden videos are common.
- Treat a changing signed CDN URL as different from a changing media identity. Only genuine page/video identity changes should reset language detection and recognition state.
- HLS URL discovery and tab-audio fallback are complementary. A site with blob-backed media, such as YouTube, still needs a correctly anchored local-live path; direct HLS sites can prepare cues ahead of playback.

## Release and site acceptance

- Reload the unpacked extension before real-site verification. An already-open browser can retain an old service worker, offscreen document, and content script even when source files changed.
- Rebuild every shipped native payload after protocol or Helper changes, then verify hashes, minimum OS, linked frameworks, and installer behavior.
- Site acceptance should cover YouTube and MissAV independently: identify the actual main player, verify renderer timing and reset behavior, and confirm settings/overlay behavior in the freshly reloaded extension.
- Tab capture requires a trusted browser-invocation lineage. Programmatically opening the action popup and then dispatching a trusted-looking DOM click can still be rejected; acceptance must enter through the real toolbar, registered shortcut, or context menu before clicking the popup control.
- Do not declare a tab-audio site healthy when only authorization succeeds. Verify the selected tab ID, local-live state, at least one persisted transcript row, and a visible in-player overlay. Likewise, a direct-HLS site should produce timed cues and translations from its real media URL, not only a synthetic content-script message.
- Popup focus and the audible media tab may live in different windows. Recommendation and stop routing must bind to the selected media tab and session identity, rather than assuming the popup’s initially active tab remains authoritative.
