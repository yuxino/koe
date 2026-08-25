# Same-language translation policy

## Problem

Koe previously treated “show Chinese translation” as both a user preference and a command to translate every recognized cue. That wastes time for captions already written in the user’s language and can produce two identical overlay lines. When “hide original” is enabled, an empty or passthrough translation can also leave the overlay blank.

## Design

Add a default-on preference, `koeSkipSameLanguage`, without changing the master translation toggle. The browser UI language from `chrome.i18n.getUILanguage()` is carried as bounded `preferredLanguage` metadata on every cloud, offline, and local-live start/reset request.

Cloud translation uses `chrome.i18n.detectLanguage`. It skips the network request only when Chrome marks the result reliable, the first candidate is at least 70%, and its base BCP-47 language matches the preferred language. Detection failure, uncertainty, or timeout continues through the normal translation path. The existing kana-aware Chinese check remains the stricter fast path for Chinese captions.

The native Helper validates and normalizes the language tag at the protocol boundary. Whisper’s detected source language is compared with the preferred base language before an Apple Translation session is created. Both paths return the original text as a stable passthrough value. The overlay collapses normalized original/translation pairs to one original line. “Hide original” activates only after a distinct, non-empty translation exists.

Changing the policy updates storage and restarts an active translation timeline with a new media epoch, so requests created under the previous policy cannot overwrite current subtitles.

## Verification

Regression coverage includes preference defaults and UI synchronization, reliable same-language zero-request behavior, uncertain/low-confidence/timeout fail-open behavior, language-tag normalization, local offline/live protocol propagation, session restart fencing, duplicate-line collapse, and hide-original fallback. Both packaged Helper variants are rebuilt after the Swift protocol changes.
