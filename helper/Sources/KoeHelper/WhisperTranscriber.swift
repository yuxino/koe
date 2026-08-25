import Foundation
import KoeHelperCore
// WhisperKit 0.9.x predates Swift 6 Sendable annotations. Access remains
// serialized by this actor and the explicit busy gate below.
@preconcurrency import WhisperKit

actor WhisperTranscriber {
    private let modelName: String
    private var whisperKit: WhisperKit?
    private var languageHintState = MediaLanguageHintState()
    private var busy = false

    init(modelName: String = "large-v3-v20240930_626MB") {
        self.modelName = modelName
    }

    func prepare() async throws {
        if whisperKit != nil { return }
        try await acquire()
        defer { busy = false }
        if whisperKit != nil { return }
        _ = try await model()
    }

    /// The Whisper-detected language for the current media item, once known.
    /// Used as the translation source hint so the translator never guesses.
    func currentLanguage() -> String? {
        languageHintState.languageHint
    }

    func transcribe(
        audioURL: URL,
        mediaKey: String,
        profile: TranscriptionProfile = .accurate
    ) async throws -> [RawCue] {
        try await acquire()
        defer { busy = false }
        try Task.checkCancellation()
        let kit = try await model()
        let languageHint = languageHintState.begin(
            mediaKey: mediaKey,
            persistHint: profile.persistsLanguageHint
        )
        let options = DecodingOptions(
            verbose: false,
            task: .transcribe,
            language: languageHint,
            temperature: 0,
            temperatureFallbackCount: profile.temperatureFallbackCount,
            usePrefillPrompt: languageHint != nil,
            detectLanguage: languageHint == nil,
            withoutTimestamps: false,
            wordTimestamps: true,
            concurrentWorkerCount: 1,
            chunkingStrategy: nil
        )
        let results = try await kit.transcribe(audioPath: audioURL.path, decodeOptions: options)
        try Task.checkCancellation()
        if languageHint == nil {
            languageHintState.remember(
                results.lazy.map(\.language).first { !$0.isEmpty },
                for: mediaKey,
                persistHint: profile.persistsLanguageHint
            )
        }
        return results.flatMap { result in
            result.segments.compactMap { segment in
                let text = Self.cleanSegmentText(segment.text)
                let timedWords = (segment.words ?? []).compactMap { word -> RawWordTiming? in
                    let wordText = word.word
                    let start = Double(word.start)
                    let end = Double(word.end)
                    guard !wordText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                          start.isFinite,
                          end.isFinite,
                          end > start else { return nil }
                    return RawWordTiming(
                        text: wordText,
                        startSeconds: start,
                        endSeconds: end
                    )
                }
                let start = timedWords.first?.startSeconds ?? Double(segment.start)
                let end = timedWords.last?.endSeconds ?? Double(segment.end)
                guard !text.isEmpty, end > start else { return nil }
                return RawCue(
                    startSeconds: start,
                    endSeconds: end,
                    text: text,
                    timedWords: timedWords
                )
            }
        }
    }

    /// Strip Whisper token artifacts (e.g. `<|endoftext|>`, `<|8.32|>`) that leak
    /// into segment text, so they never become subtitle content or translation
    /// input.
    static func cleanSegmentText(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: #"<\|[^|]*\|>"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Core ML inference may finish its current call even after cancellation.
    /// New seeks wait only for that one call, while canceled intermediate seeks
    /// leave the queue without becoming user-visible "busy" failures.
    private func acquire() async throws {
        while busy {
            try Task.checkCancellation()
            try await Task.sleep(for: .milliseconds(25))
        }
        try Task.checkCancellation()
        busy = true
    }

    private func model() async throws -> WhisperKit {
        if let whisperKit { return whisperKit }
        let config = WhisperKitConfig(
            model: modelName,
            verbose: false,
            prewarm: false,
            load: true,
            download: true
        )
        let loaded = try await WhisperKit(config)
        whisperKit = loaded
        return loaded
    }
}
