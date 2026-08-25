# Late local caption recovery

## Problem

Local tab-audio transcription is necessarily delivered after the matching audio. The current media-timed renderer rejects a finalized cue once the player is more than 2.5 seconds beyond the cue end. A four-second PCM window plus Whisper inference commonly exceeds that threshold, so valid YouTube captions are discarded before they can render. Accepted cues can also disappear after only 900 ms because their media end time is already behind the player.

## Design

Keep media timing for the cases where it is authoritative: do not show a cue before the player reaches it, clear the overlay on pause, and reset recognition after seeks or playback-rate changes. Treat ordinary lateness differently because it is an expected property of local recognition rather than proof that a cue is stale. A finalized cue up to 12 wall-clock seconds behind the player renders immediately instead of being rejected. When its media end time has already passed, give it a fixed 3.2-second reading window; cues that arrive on time continue to derive their display duration from the player time and playback rate. Multiply the maximum media-time gap by playback rate so the limit remains 12 seconds of real reading delay at every speed. Cues beyond that bound are discarded, and late translations still cannot resurrect an expired cue.

## Verification

The overlay regression test models a cue that arrives more than 2.5 seconds behind the player, requires it to render, and verifies that it expires after the bounded reading window. It also rejects a cue more than a minute behind the player. Existing tests continue to cover early-cue rejection, pause/seek/rate resets, epoch isolation, and late-translation suppression.
