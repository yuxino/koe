import Foundation
import KoeHelperCore

private var failures = 0

@MainActor
private func check(_ condition: @autoclosure () -> Bool, _ label: String) {
    if !condition() {
        FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
        failures += 1
    }
}

let preferenceDefaults = KoePreferences.normalized(KoePreferences())
check(preferenceDefaults.koeTranslate == true,
      "native preference defaults enable translation")
check(preferenceDefaults.koeAsrEngine == "local"
        && preferenceDefaults.koeCaptureSource == "tab",
      "native preference defaults select local-first tab capture")
check(preferenceDefaults.koeOverlayEnabled == true
        && preferenceDefaults.koeOverlaySize == "medium",
      "native preference defaults keep the standard overlay visible")

let sanitizedPreferences = KoePreferences.normalized(KoePreferences(
    koePreferencesVersion: 99,
    koeTranslate: false,
    koeHideOriginal: true,
    koeCaptureSource: "mic",
    koeAsrEngine: "webspeech",
    koeOverlayEnabled: false,
    koeOverlaySize: "huge"
))
check(sanitizedPreferences.koePreferencesVersion == 1,
      "native preferences clamp their schema version")
check(sanitizedPreferences.koeTranslate == false
        && sanitizedPreferences.koeHideOriginal == true,
      "valid native boolean preferences survive normalization")
check(sanitizedPreferences.koeCaptureSource == "tab"
        && sanitizedPreferences.koeAsrEngine == "local"
        && sanitizedPreferences.koeOverlaySize == "medium",
      "retired or invalid native preference values fall back safely")

do {
    var stream = try PCMStreamBuffer(
        sampleRate: 16_000,
        channels: 1,
        bootstrapDurationMs: 4_000,
        overlapMs: 1_500,
        maximumBufferedDurationMs: 20_000
    )
    try stream.append(Data(repeating: 0, count: 16_000 * 2 * 3))
    check(stream.takeWindow() == nil,
          "local live waits for the four-second bootstrap window")
    try stream.append(Data(repeating: 1, count: 16_000 * 2))
    let bootstrap = stream.takeWindow()
    check(bootstrap?.pcm.count == 16_000 * 2 * 4
            && bootstrap?.startMs == 0
            && bootstrap?.endMs == 4_000
            && bootstrap?.emitAfterMs == 0,
          "local live emits an exact short bootstrap window")

    try stream.append(Data(repeating: 2, count: 16_000 * 2 * 2 + 16_000))
    let steady = stream.takeWindow()
    check(steady?.startMs == 2_500
            && steady?.endMs == 6_500
            && steady?.emitAfterMs == 3_250,
          "steady local-live windows stay short while suppressing the old prefix")
    check(stream.bufferedDurationMs <= 20_000,
          "local-live PCM buffering stays bounded")

    do {
        try stream.append(Data([0]))
        check(false, "odd PCM byte counts are rejected")
    } catch PCMStreamError.invalidChunk {
        check(true, "odd PCM byte counts are rejected")
    } catch {
        check(false, "odd PCM byte counts return the expected error")
    }

    if let bootstrap {
        let wav = try PCM16WAV.encode(pcm: bootstrap.pcm, sampleRate: 16_000, channels: 1)
        check(String(data: wav.prefix(4), encoding: .ascii) == "RIFF"
                && String(data: wav[8..<12], encoding: .ascii) == "WAVE",
              "local-live PCM is wrapped in a valid WAV container")
        check(wav.count == bootstrap.pcm.count + 44,
              "WAV framing adds only the canonical 44-byte header")
    }
} catch {
    check(false, "local-live PCM windows initialize: \(error)")
}

do {
    let pcm = Data(repeating: 7, count: 3_200)
    let request = HostRequest(
        type: "streamAudio",
        protocolVersion: koeNativeProtocolVersion,
        jobId: "local-live-1",
        mediaEpoch: 3,
        sampleRate: 16_000,
        channels: 1,
        pcmBase64: pcm.base64EncodedString()
    )
    let audio = try request.validatedStreamAudio()
    check(audio.pcm == pcm && audio.jobId == "local-live-1" && audio.mediaEpoch == 3,
          "native stream audio validates and decodes bounded base64 PCM")
} catch {
    check(false, "valid native stream audio request: \(error)")
}
do {
    let request = HostRequest(
        type: "start",
        protocolVersion: koeNativeProtocolVersion,
        jobId: "offline-1",
        mediaEpoch: 2,
        mediaKey: "media",
        source: MediaSource(
            url: "https://cdn.example.com/video.m3u8?token=secret",
            headers: [
                "referer": "https://example.com/watch",
                "origin": "https://example.com",
                "Cookie": "session=secret",
                "Authorization": "Bearer secret"
            ]
        ),
        currentTimeMs: 170_000,
        durationMs: 900_000,
        playbackRate: 1
    )
    let start = try request.validatedStart()
    check(start.headers == [
        "Referer": "https://example.com/watch",
        "Origin": "https://example.com"
    ], "only Referer and Origin cross the native boundary")
    check(start.sourceURL.absoluteString.contains("token=secret"), "signed URL remains usable in memory")
} catch {
    check(false, "valid start request: \(error)")
}

do {
    let encoded = try JSONEncoder().encode(HostResponse.status(
        jobId: "offline-1",
        mediaEpoch: 2,
        stage: "ready",
        detail: "ready",
        preparedUntilMs: 36_000,
        mediaComplete: true
    ))
    let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
    check(object?["mediaComplete"] as? Bool == true,
          "ready status explicitly reports that the media end is prepared")
} catch {
    check(false, "media-complete status encoding: \(error)")
}

private enum CoreCheckFailure: Error {
    case generic
}

@MainActor
private func checkIssueCode(
    _ error: Error,
    equals expected: String,
    _ label: String
) {
    do {
        let response = HostResponse.failure(
            jobId: "offline-issue",
            mediaEpoch: 4,
            issueCode: NativeIssueCode.classify(error).rawValue,
            message: "保留给用户看的中文错误"
        )
        let encoded = try JSONEncoder().encode(response)
        let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        check(object?["issueCode"] as? String == expected, label)
        check(object?["error"] as? String == "保留给用户看的中文错误",
              "stable issue codes preserve the localized error detail")
    } catch {
        check(false, "\(label): \(error)")
    }
}

checkIssueCode(
    HLSResolverError.unsupportedEncryption,
    equals: "protected_media",
    "protected HLS has a stable native issue code"
)
checkIssueCode(
    HLSResolverError.unsupportedAudio,
    equals: "unsupported_audio",
    "unsupported HLS audio has a stable native issue code"
)
checkIssueCode(
    HLSResolverError.unsupportedByteRange,
    equals: "unsupported_media",
    "unsupported HLS structure has a stable native issue code"
)
checkIssueCode(
    HLSResolverError.invalidResponse,
    equals: "media_unreadable",
    "unreadable HLS has a stable native issue code"
)
checkIssueCode(
    RequestValidationError.unsupportedProtocol,
    equals: "helper_incompatible",
    "protocol mismatch has a stable native issue code"
)
checkIssueCode(
    RequestValidationError.invalidURL,
    equals: "media_unreadable",
    "invalid source URL has a stable native issue code"
)
checkIssueCode(
    PCMStreamError.invalidFormat,
    equals: "unsupported_audio",
    "unsupported PCM format has a stable native issue code"
)
checkIssueCode(
    PCMStreamError.invalidChunk,
    equals: "capture_failed",
    "invalid PCM capture has a stable native issue code"
)
checkIssueCode(
    URLError(.timedOut),
    equals: "media_unreadable",
    "URL failures have a stable native issue code"
)
checkIssueCode(
    CoreCheckFailure.generic,
    equals: "capture_failed",
    "generic local processing failures have a stable native issue code"
)

var languageState = MediaLanguageHintState()
check(languageState.begin(mediaKey: "media-a") == nil,
      "the first window of a media item detects its language")
languageState.remember("en", for: "media-a")
check(languageState.begin(mediaKey: "media-a") == "en",
      "a seek with the same media key reuses the detected language")
check(languageState.begin(mediaKey: "media-b") == nil,
      "switching to a different media key clears the previous language")
languageState.remember("ja", for: "media-a")
check(languageState.begin(mediaKey: "media-b") == nil,
      "a stale media result cannot pollute the active media language")
languageState.remember("ja", for: "media-b")
check(languageState.begin(mediaKey: "media-b") == "ja",
      "the new media caches its own detected language")

do {
    let request = HostRequest(
        type: "start",
        protocolVersion: koeNativeProtocolVersion,
        jobId: "offline-1",
        mediaEpoch: 0,
        source: MediaSource(url: "http://127.0.0.1/private.mp4")
    )
    _ = try request.validatedStart()
    check(false, "private network source is rejected")
} catch RequestValidationError.unsafeURL {
    check(true, "private network source is rejected")
} catch {
    check(false, "private network source returns the expected error")
}

let windows = WindowScheduler().windows(currentTimeMs: 170_000, durationMs: 260_000)
check(windows.first == MediaWindow(startMs: 166_000, endMs: 186_000, emitAfterMs: 166_000),
      "bootstrap surrounds the current playback position")
check(windows.dropFirst().first == MediaWindow(startMs: 182_000, endMs: 212_000, emitAfterMs: 184_000),
      "forward windows overlap without re-emitting their complete prefix")
check(windows.last?.endMs == 260_000, "forward scheduling reaches the media end")
check(WindowScheduler().windows(currentTimeMs: 1_000, durationMs: 10_000)
    == [MediaWindow(startMs: 0, endMs: 10_000, emitAfterMs: 0)], "bootstrap clamps at media edges")

if let base = URL(string: "https://cdn.example.com/master.m3u8?token=secret") {
    let playlist = """
    #EXTM3U
    #EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1920x1080
    high/index.m3u8
    #EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=420000,BANDWIDTH=600000,RESOLUTION=640x360
    low/index.m3u8
    """
    let variants = HLSResolver.variants(in: playlist, baseURL: base)
    let selected = variants.min { $0.bandwidth < $1.bandwidth }
    check(selected?.bandwidth == 420_000, "lowest HLS bandwidth is selected for fast audio extraction")
    check(selected?.url.absoluteString == "https://cdn.example.com/low/index.m3u8?token=secret",
          "relative HLS variants preserve the signed query")

    let crossOriginPlaylist = """
    #EXTM3U
    #EXT-X-STREAM-INF:BANDWIDTH=200000
    https://other.example.net/low/index.m3u8
    """
    let crossOriginVariant = HLSResolver.variants(in: crossOriginPlaylist, baseURL: base).first
    check(crossOriginVariant?.url.query == nil,
          "signed master query is never copied to a cross-origin HLS URL")

    let missingBandwidth = """
    #EXTM3U
    #EXT-X-STREAM-INF:CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720,NAME="720"
    720/index.m3u8
    #EXT-X-STREAM-INF:CODECS="avc1.4d401e,mp4a.40.2",RESOLUTION=512x288,NAME="288"
    288/index.m3u8
    #EXT-X-STREAM-INF:CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,NAME="1080"
    1080/index.m3u8
    """
    let resolutionVariants = HLSResolver.variants(in: missingBandwidth, baseURL: base)
    let resolutionSelected = resolutionVariants.min { $0.bandwidth < $1.bandwidth }
    check(resolutionSelected?.bandwidth == 512 * 288,
          "resolution is the fallback selection weight when HLS bandwidth is omitted")
    check(resolutionSelected?.url.absoluteString == "https://cdn.example.com/288/index.m3u8?token=secret",
          "bandwidth-less HLS selects the lowest-resolution variant")

    let media = """
    #EXTM3U
    #EXT-X-TARGETDURATION:5
    #EXTINF:4.004,
    segment-1.ts
    #EXTINF:3.996,
    segment-2.ts
    #EXT-X-ENDLIST
    """
    do {
        let parsed = try HLSResolver.mediaPlaylist(in: media, baseURL: base)
        check(parsed.segments.count == 2 && parsed.durationMs == 8_000,
              "target-style MPEG-TS HLS timing is parsed exactly")
        check(abs(parsed.segments[1].startMs - 4_004) < 0.01,
              "HLS segment start time is cumulative absolute media time")
        check(parsed.segments[0].url.absoluteString.contains("token=secret"),
              "signed query is inherited by relative HLS segments")
    } catch {
        check(false, "target-style HLS playlist parses: \(error)")
    }

    let fragmentedMP4 = """
    #EXTM3U
    #EXT-X-VERSION:7
    #EXT-X-MAP:URI="init.mp4"
    #EXTINF:4.000,
    segment-1.m4s
    #EXTINF:4.000,
    segment-2.m4s
    #EXT-X-ENDLIST
    """
    do {
        let parsed = try HLSResolver.mediaPlaylist(in: fragmentedMP4, baseURL: base)
        check(parsed.initializationSegmentURL?.absoluteString
            == "https://cdn.example.com/init.mp4?token=secret",
              "CMAF initialization segment preserves the signed query")
        check(parsed.segments.count == 2 && parsed.durationMs == 8_000,
              "CMAF media fragments use the same absolute HLS timing")
    } catch {
        check(false, "CMAF HLS playlist parses: \(error)")
    }

    let byteRangeMap = """
    #EXTM3U
    #EXT-X-MAP:URI="media.mp4",BYTERANGE="720@0"
    #EXTINF:4,
    segment.m4s
    """
    do {
        _ = try HLSResolver.mediaPlaylist(in: byteRangeMap, baseURL: base)
        check(false, "byte-range CMAF initialization segments are rejected")
    } catch HLSResolverError.unsupportedByteRange {
        check(true, "byte-range CMAF initialization segments are rejected")
    } catch {
        check(false, "byte-range CMAF initialization returns the expected error")
    }

    let changingInitialization = """
    #EXTM3U
    #EXT-X-MAP:URI="init-a.mp4"
    #EXTINF:4,
    segment-a.m4s
    #EXT-X-DISCONTINUITY
    #EXT-X-MAP:URI="init-b.mp4"
    #EXTINF:4,
    segment-b.m4s
    """
    do {
        _ = try HLSResolver.mediaPlaylist(in: changingInitialization, baseURL: base)
        check(false, "CMAF playlists that change initialization midstream are rejected")
    } catch HLSResolverError.unsupportedMediaChange {
        check(true, "CMAF playlists that change initialization midstream are rejected")
    } catch {
        check(false, "changing CMAF initialization returns the expected error")
    }

    let encrypted = """
    #EXTM3U
    #EXT-X-KEY:METHOD=AES-128,URI="key.bin"
    #EXTINF:4,
    segment.ts
    """
    do {
        _ = try HLSResolver.mediaPlaylist(in: encrypted, baseURL: base)
        check(false, "encrypted HLS is rejected instead of mis-decoded")
    } catch HLSResolverError.unsupportedEncryption {
        check(true, "encrypted HLS is rejected instead of mis-decoded")
    } catch {
        check(false, "encrypted HLS returns the expected error")
    }
} else {
    check(false, "HLS test URL")
}

func mp4Box(_ type: String, payload: [UInt8]) -> Data {
    let size = UInt32(8 + payload.count)
    var bytes: [UInt8] = [
        UInt8((size >> 24) & 0xff),
        UInt8((size >> 16) & 0xff),
        UInt8((size >> 8) & 0xff),
        UInt8(size & 0xff)
    ]
    bytes.append(contentsOf: type.utf8)
    bytes.append(contentsOf: payload)
    return Data(bytes)
}

let syntheticInitialization = mp4Box("ftyp", payload: [0, 0, 0, 0])
    + mp4Box("moov", payload: [1, 2, 3, 4])
let syntheticFragment = mp4Box("styp", payload: [0, 0, 0, 0])
    + mp4Box("moof", payload: [5, 6, 7, 8])
    + mp4Box("mdat", payload: [9, 10, 11, 12])
do {
    let assembled = try HLSResolver.assembleFragmentedMP4(
        initialization: syntheticInitialization,
        fragments: [syntheticFragment]
    )
    check(assembled == syntheticInitialization + syntheticFragment,
          "CMAF initialization and selected fragments are assembled losslessly")
} catch {
    check(false, "CMAF fragments assemble: \(error)")
}

let metadataPrefixedFragment = mp4Box("free", payload: [])
    + mp4Box("emsg", payload: [0, 0, 0, 0])
    + mp4Box("moof", payload: [1, 2, 3, 4])
    + mp4Box("mdat", payload: [5, 6, 7, 8])
do {
    _ = try HLSResolver.assembleFragmentedMP4(
        initialization: syntheticInitialization,
        fragments: [metadataPrefixedFragment]
    )
    check(true, "valid CMAF metadata boxes may precede moof")
} catch {
    check(false, "valid CMAF metadata boxes may precede moof: \(error)")
}

for (invalidFragment, label) in [
    (mp4Box("moof", payload: [1, 2, 3, 4]), "CMAF fragment without mdat is rejected"),
    (Data([0, 0, 0, 32, 0x6d, 0x6f, 0x6f, 0x66]), "truncated CMAF top-level box is rejected")
] {
    do {
        _ = try HLSResolver.assembleFragmentedMP4(
            initialization: syntheticInitialization,
            fragments: [invalidFragment]
        )
        check(false, label)
    } catch HLSResolverError.invalidResponse {
        check(true, label)
    } catch {
        check(false, "\(label) with the expected error")
    }
}

do {
    _ = try HLSResolver.assembleFragmentedMP4(
        initialization: mp4Box("ftyp", payload: [0, 0, 0, 0]),
        fragments: [syntheticFragment]
    )
    check(false, "CMAF initialization without moov is rejected")
} catch HLSResolverError.invalidResponse {
    check(true, "CMAF initialization without moov is rejected")
} catch {
    check(false, "CMAF initialization without moov returns the expected error")
}

func transportPacket(pid: Int, payloadStart: Bool, payload: [UInt8]) -> Data {
    precondition(payload.count <= 183)
    var bytes: [UInt8] = [
        0x47,
        UInt8((payloadStart ? 0x40 : 0) | ((pid >> 8) & 0x1f)),
        UInt8(pid & 0xff),
        0x30
    ]
    let adaptationLength = 183 - payload.count
    bytes.append(UInt8(adaptationLength))
    if adaptationLength > 0 {
        bytes.append(0)
        if adaptationLength > 1 {
            bytes.append(contentsOf: repeatElement(0xff, count: adaptationLength - 1))
        }
    }
    bytes.append(contentsOf: payload)
    precondition(bytes.count == 188)
    return Data(bytes)
}

func transportPackets(pid: Int, payload: [UInt8]) -> Data {
    var result = Data()
    var cursor = 0
    while cursor < payload.count {
        let end = min(cursor + 183, payload.count)
        result.append(transportPacket(
            pid: pid,
            payloadStart: cursor == 0,
            payload: Array(payload[cursor..<end])
        ))
        cursor = end
    }
    return result
}

func adtsFrame(payloadCount: Int) -> [UInt8] {
    let frameLength = 7 + payloadCount
    precondition(frameLength < 8_192)
    let header: [UInt8] = [
        0xff,
        0xf1,
        0x50,
        0x80 | UInt8((frameLength >> 11) & 0x03),
        UInt8((frameLength >> 3) & 0xff),
        UInt8((frameLength & 0x07) << 5) | 0x1f,
        0xfc
    ]
    return header + (0..<payloadCount).map { UInt8($0 % 0xef) }
}

let pat: [UInt8] = [
    0x00,
    0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00,
    0x00, 0x01, 0xef, 0xff,
    0x00, 0x00, 0x00, 0x00
]
let pmt: [UInt8] = [
    0x00,
    0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00,
    0xe1, 0x00, 0xf0, 0x00,
    0x0f, 0xe1, 0x01, 0xf0, 0x00,
    0x00, 0x00, 0x00, 0x00
]
let adtsFrame: [UInt8] = [0xff, 0xf1, 0x50, 0x80, 0x01, 0x3f, 0xfc, 0x00, 0x00]
let pes: [UInt8] = [
    0x00, 0x00, 0x01, 0xc0, 0x00, 0x11, 0x80, 0x80, 0x05,
    0x00, 0x00, 0x00, 0x00, 0x00
] + adtsFrame
let syntheticTransport = transportPacket(pid: 0, payloadStart: true, payload: pat)
    + transportPacket(pid: 0x0fff, payloadStart: true, payload: pmt)
    + transportPacket(pid: 0x0101, payloadStart: true, payload: pes)
do {
    let demuxed = try HLSResolver.demuxADTS(from: [syntheticTransport])
    check(demuxed == Data(adtsFrame), "MPEG-TS AAC is demuxed without ffmpeg or video bytes")
} catch {
    check(false, "MPEG-TS AAC demux: \(error)")
}

let programInfoLength = 180
let pmtSectionLength = 18 + programInfoLength
let splitPMT: [UInt8] = [
    0x00,
    0x02, 0xb0 | UInt8((pmtSectionLength >> 8) & 0x0f), UInt8(pmtSectionLength & 0xff),
    0x00, 0x01, 0xc1, 0x00, 0x00,
    0xe1, 0x00,
    0xf0 | UInt8((programInfoLength >> 8) & 0x0f), UInt8(programInfoLength & 0xff)
] + Array(repeating: 0, count: programInfoLength) + [
    0x0f, 0xe1, 0x01, 0xf0, 0x00,
    0x00, 0x00, 0x00, 0x00
]
let longFrame = adtsFrame(payloadCount: 420)
let longPESLength = 8 + longFrame.count
let longPES: [UInt8] = [
    0x00, 0x00, 0x01, 0xc0,
    UInt8((longPESLength >> 8) & 0xff), UInt8(longPESLength & 0xff),
    0x80, 0x80, 0x05,
    0x00, 0x00, 0x00, 0x00, 0x00
] + longFrame
let splitAudioPackets = transportPackets(pid: 0x0101, payload: longPES)
let firstSplitSegment = transportPacket(pid: 0, payloadStart: true, payload: pat)
    + transportPackets(pid: 0x0fff, payload: splitPMT)
    + Data(splitAudioPackets.prefix(188))
let secondSplitSegment = Data(splitAudioPackets.dropFirst(188))
do {
    let demuxed = try HLSResolver.demuxADTS(from: [firstSplitSegment, secondSplitSegment])
    check(demuxed == Data(longFrame),
          "split PMT, PES, ADTS frame, and HLS segment boundaries remain lossless")
} catch {
    check(false, "split MPEG-TS structures demux: \(error)")
}

do {
    _ = try HLSResolver.demuxADTS(from: [Data(syntheticTransport.dropLast())])
    check(false, "truncated transport streams are rejected instead of producing partial subtitles")
} catch HLSResolverError.invalidResponse {
    check(true, "truncated transport streams are rejected instead of producing partial subtitles")
} catch {
    check(false, "truncated transport stream returns the expected error")
}

func withoutWhitespace(_ text: String) -> String {
    text.unicodeScalars
        .filter { !CharacterSet.whitespacesAndNewlines.contains($0) }
        .map(String.init)
        .joined()
}

let readableWindow = MediaWindow(startMs: 100_000, endMs: 130_000, emitAfterMs: 100_000)
let longEnglish = """
The local subtitle should move with the picture, preserve every word, and never hide the ending. \
Natural punctuation gives each thought a clean stopping point while the timing continues forward. \
Finally, proportional durations keep a short phrase readable without making a long phrase disappear too soon.
"""
var readableAccumulator = CueAccumulator()
let readableEnglish = readableAccumulator.merge(
    rawCues: [RawCue(startSeconds: 2, endSeconds: 14, text: longEnglish)],
    window: readableWindow,
    durationMs: 130_000
)
check(readableEnglish.count >= 3, "long English Whisper cues are split into readable subtitles")
check(readableEnglish.allSatisfy { $0.text.count <= 90 },
      "English subtitle chunks stay near the 70-90 character readability target")
check(withoutWhitespace(readableEnglish.map(\.text).joined()) == withoutWhitespace(longEnglish),
      "long cue splitting preserves the complete transcript including its tail")
check(readableEnglish.first?.startMs == 102_000 && readableEnglish.last?.endMs == 114_000,
      "split cues retain the raw cue absolute time range")
check(zip(readableEnglish, readableEnglish.dropFirst()).allSatisfy {
    abs($0.endMs - $1.startMs) < 0.001
}, "split cue timestamps advance continuously without gaps or overlap")
check(readableEnglish.allSatisfy { $0.endMs - $0.startMs >= 899.9 },
      "readable chunks never flash for less than the minimum duration")
let englishCharacterTotal = readableEnglish.reduce(0.0) { $0 + Double($1.text.count) }
check(readableEnglish.allSatisfy {
    let expected = 12_000 * Double($0.text.count) / englishCharacterTotal
    return abs(($0.endMs - $0.startMs) - expected) < 0.01
}, "raw cue time is distributed in proportion to chunk character counts")

let rapidSentence = "These opening words arrive in a quick burst before a noticeably long pause."
let slowSentence = "These later words continue slowly so their subtitle timing follows the voice."
let unevenText = "\(rapidSentence) \(slowSentence)"
func timedSentence(
    _ sentence: String,
    startSeconds: Double,
    endSeconds: Double,
    leadingSpace: Bool
) -> [RawWordTiming] {
    let words = sentence.split(separator: " ").map(String.init)
    let wordDuration = (endSeconds - startSeconds) / Double(words.count)
    return words.enumerated().map { index, word in
        RawWordTiming(
            text: (leadingSpace || index > 0 ? " " : "") + word,
            startSeconds: startSeconds + Double(index) * wordDuration,
            endSeconds: startSeconds + Double(index + 1) * wordDuration
        )
    }
}
let unevenWords = timedSentence(
    rapidSentence,
    startSeconds: 1,
    endSeconds: 2,
    leadingSpace: false
) + timedSentence(
    slowSentence,
    startSeconds: 5,
    endSeconds: 9,
    leadingSpace: true
)
var timedAccumulator = CueAccumulator()
let timedEnglish = timedAccumulator.merge(
    rawCues: [RawCue(
        startSeconds: 1,
        endSeconds: 9,
        text: unevenText,
        timedWords: unevenWords
    )],
    window: readableWindow,
    durationMs: 130_000
)
check(timedEnglish.map(\.text) == [rapidSentence, slowSentence],
      "word-timed long cues still split at a natural sentence boundary")
check(timedEnglish.count == 2
        && abs(timedEnglish[0].startMs - 101_000) < 0.01
        && abs(timedEnglish[0].endMs - 102_000) < 0.01
        && abs(timedEnglish[1].startMs - 105_000) < 0.01
        && abs(timedEnglish[1].endMs - 109_000) < 0.01,
      "uneven speech uses real first/last word timestamps instead of character proportions")

let longCJK = """
本地字幕应该跟着画面稳定推进，不能因为一次识别出现太多文字就把后半句藏起来。遇到自然标点时优先停顿，同时让每个子句的时间紧密相连。即使一句话特别长，最后的内容也必须完整显示。
"""
var cjkAccumulator = CueAccumulator()
let readableCJK = cjkAccumulator.merge(
    rawCues: [RawCue(startSeconds: 0, endSeconds: 15, text: longCJK)],
    window: MediaWindow(startMs: 0, endMs: 15_000, emitAfterMs: 0),
    durationMs: 15_000
)
check(readableCJK.count >= 3, "long CJK Whisper cues are split into multiple subtitles")
check(readableCJK.allSatisfy { $0.text.count <= 42 },
      "CJK chunks stay near the 30-40 character readability target")
check(readableCJK.map(\.text).joined() == longCJK,
      "CJK splitting preserves every character")

let rushedText = String(repeating: "very long subtitle words ", count: 8)
var rushedAccumulator = CueAccumulator()
let rushed = rushedAccumulator.merge(
    rawCues: [RawCue(startSeconds: 0, endSeconds: 1.5, text: rushedText)],
    window: MediaWindow(startMs: 0, endMs: 1_500, emitAfterMs: 0),
    durationMs: 1_500
)
check(rushed.count == 1 && rushed.first?.text == rushedText.trimmingCharacters(in: .whitespaces),
      "a short raw time range is not split into unreadable flashes")

var shortAccumulator = CueAccumulator()
let shortCue = shortAccumulator.merge(
    rawCues: [RawCue(startSeconds: 1, endSeconds: 3, text: "Short cue.")],
    window: MediaWindow(startMs: 10_000, endMs: 20_000, emitAfterMs: 10_000),
    durationMs: 20_000
)
check(shortCue.count == 1
        && shortCue.first?.text == "Short cue."
        && shortCue.first?.startMs == 11_000
        && shortCue.first?.endMs == 13_000,
      "short cue text and timing remain unchanged")

var accumulator = CueAccumulator()
let firstWindow = MediaWindow(startMs: 166_000, endMs: 186_000, emitAfterMs: 166_000)
let first = accumulator.merge(
    rawCues: [RawCue(startSeconds: 18, endSeconds: 20, text: "Hello there.")],
    window: firstWindow,
    durationMs: 260_000
)
let overlapWindow = MediaWindow(startMs: 182_000, endMs: 212_000, emitAfterMs: 184_000)
let second = accumulator.merge(
    rawCues: [
        RawCue(startSeconds: 2.1, endSeconds: 3.8, text: "Hello there."),
        RawCue(startSeconds: 4, endSeconds: 6, text: "A new line.")
    ],
    window: overlapWindow,
    durationMs: 260_000
)
check(first.first?.startMs == 184_000, "cue timestamps become absolute media time")
check(second.map(\.text) == ["A new line."], "overlap duplicate is removed")
check(accumulator.cues.count == 2 && accumulator.revision == 2, "cue revision advances only with additions")

var boundaryAccumulator = CueAccumulator()
let discarded = boundaryAccumulator.merge(
    rawCues: [RawCue(startSeconds: 0, endSeconds: 1, text: "Old overlap")],
    window: overlapWindow,
    durationMs: 260_000
)
check(discarded.isEmpty, "forward overlap prefix is not emitted twice")

print(failures == 0 ? "Koe Helper core checks PASS" : "\(failures) failures")
exit(failures == 0 ? 0 : 1)
