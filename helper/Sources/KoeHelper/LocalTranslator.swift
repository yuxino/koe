import Foundation
import KoeHelperCore

#if canImport(Translation) && !KOE_DISABLE_NATIVE_TRANSLATION
@preconcurrency import Translation
import NaturalLanguage
#endif

/// Whether Apple's on-device Translation framework is usable for subtitle
/// translation on this host. This only checks the OS / hardware / framework and
/// that Simplified Chinese is a supported *target* — it does not guarantee the
/// language pack is installed (that is the OS's business; we guide the user to
/// System Settings and degrade to original-only otherwise).
enum NativeTranslationCapability {
    static func available() async -> Bool {
        #if canImport(Translation) && arch(arm64) && !KOE_DISABLE_NATIVE_TRANSLATION
        guard #available(macOS 26.0, *) else { return false }
        // The framework is present on this host. Whether a *specific* source→zh-Hans
        // pair is installed is decided per translation (degrading to original-only),
        // so we do not gate the toggle on a language list here.
        return true
        #else
        return false
        #endif
    }
}

/// On-device translator for finalized subtitle lines, backed by Apple's
/// `Translation` framework. Only usable on macOS 26+; callers must gate access
/// with `#available(macOS 26.0, *)`. Keeps a session per source language so a
/// long media item does not re-prepare the pair for every window.
#if canImport(Translation) && !KOE_DISABLE_NATIVE_TRANSLATION
@available(macOS 26.0, *)
actor LocalTranslator {
    static let shared = LocalTranslator()

    private let targetLanguage = Locale.Language(identifier: "zh-Hans")
    private var sessions: [String: TranslationSession] = [:]

    /// Translate one finalized subtitle line to Simplified Chinese. Returns nil
    /// (caller keeps the original) when the source language is unknown, the
    /// source is already Chinese, the source matches the user's preferred
    /// language and that policy is enabled, the pair is unsupported, or the
    /// model is not installed / translation failed.
    func translate(
        _ text: String,
        sourceLanguageHint: String?,
        skipSameLanguage: Bool = true,
        preferredLanguage: String? = nil
    ) async -> String? {
        let cleaned = text
            .replacingOccurrences(of: #"<\|[^|]*\|>"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        let source: Locale.Language
        if let hint = sourceLanguageHint,
           let resolved = Locale.Language(identifier: hint) as Locale.Language?,
           !resolved.minimalIdentifier.isEmpty {
            source = resolved
        } else if let detected = Self.detectLanguage(in: cleaned) {
            source = detected
        } else {
            return nil
        }
        // Passthrough keeps the existing subtitle delivery contract: callers
        // still receive a stable value while no Translation session is created.
        if skipSameLanguage,
           LanguageIdentity.sameLanguage(source.minimalIdentifier, preferredLanguage) {
            return cleaned
        }
        // Already Chinese: show the original as-is rather than re-translating.
        if source.minimalIdentifier.hasPrefix("zh") { return cleaned }
        do {
            let availability = LanguageAvailability()
            let status = await availability.status(from: source, to: targetLanguage)
            guard status != .unsupported else { return nil }
            let session = try session(for: source)
            let response = try await session.translate(cleaned)
            let translated = response.targetText
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return translated.isEmpty ? nil : translated
        } catch {
            return nil
        }
    }

    private func session(for source: Locale.Language) throws -> TranslationSession {
        let key = source.minimalIdentifier
        if let existing = sessions[key] { return existing }
        let session = TranslationSession(installedSource: source, target: targetLanguage)
        sessions[key] = session
        return session
    }

    private static func detectLanguage(in text: String) -> Locale.Language? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(trimmed)
        guard let best = recognizer.dominantLanguage?.rawValue else { return nil }
        return Locale.Language(identifier: best)
    }
}
#else
actor LocalTranslator {
    static let shared = LocalTranslator()

    func translate(
        _ text: String,
        sourceLanguageHint: String?,
        skipSameLanguage: Bool = true,
        preferredLanguage: String? = nil
    ) async -> String? {
        nil
    }
}
#endif
