import Foundation

/// Keeps Whisper's detected language scoped to one logical media item.
///
/// A seek starts a new transcription session but keeps the same `mediaKey`, so
/// it can reuse the detected language. Switching media changes the key and
/// clears the hint before the next decode.
public struct MediaLanguageHintState: Sendable {
    private var mediaKey: String?
    public private(set) var languageHint: String?

    public init() {}

    public mutating func begin(mediaKey: String, persistHint: Bool = true) -> String? {
        guard self.mediaKey == mediaKey else {
            self.mediaKey = mediaKey
            languageHint = nil
            return nil
        }
        return persistHint ? languageHint : nil
    }

    public mutating func remember(
        _ language: String?,
        for mediaKey: String,
        persistHint: Bool = true
    ) {
        guard persistHint else { return }
        guard self.mediaKey == mediaKey, languageHint == nil else { return }
        let normalized = String(language ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return }
        languageHint = normalized
    }
}
