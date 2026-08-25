import Foundation

/// Small, deterministic BCP-47 identity helpers shared by native request
/// validation and translation policy. Translation only needs the base spoken
/// language, so script and region subtags intentionally do not distinguish
/// `zh-Hans` from `zh-Hant`.
public enum LanguageIdentity {
    public static let maximumIdentifierUTF8Length = 128

    private static let legacyBaseAliases = [
        "iw": "he",
        "in": "id",
        "ji": "yi"
    ]

    /// Returns a bounded, lowercase BCP-47-like identifier using `-` separators.
    /// Invalid or empty metadata is discarded instead of reaching framework APIs.
    public static func normalizedIdentifier(_ value: String?) -> String? {
        let trimmed = String(value ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              trimmed.utf8.count <= maximumIdentifierUTF8Length else { return nil }

        let rawSubtags = trimmed
            .replacingOccurrences(of: "_", with: "-")
            .lowercased()
            .split(separator: "-", omittingEmptySubsequences: false)
            .map(String.init)
        guard let rawBase = rawSubtags.first,
              (2...8).contains(rawBase.utf8.count),
              isASCIIAlpha(rawBase),
              rawSubtags.dropFirst().allSatisfy({ subtag in
                  (1...8).contains(subtag.utf8.count) && isASCIIAlphanumeric(subtag)
              }) else { return nil }

        var subtags = rawSubtags
        subtags[0] = legacyBaseAliases[rawBase] ?? rawBase
        return subtags.joined(separator: "-")
    }

    public static func baseLanguage(_ value: String?) -> String? {
        normalizedIdentifier(value)?.split(separator: "-").first.map(String.init)
    }

    public static func sameLanguage(_ left: String?, _ right: String?) -> Bool {
        guard let leftBase = baseLanguage(left),
              let rightBase = baseLanguage(right) else { return false }
        return leftBase == rightBase
    }

    private static func isASCIIAlpha(_ value: String) -> Bool {
        !value.isEmpty && value.unicodeScalars.allSatisfy { scalar in
            (65...90).contains(scalar.value) || (97...122).contains(scalar.value)
        }
    }

    private static func isASCIIAlphanumeric(_ value: String) -> Bool {
        !value.isEmpty && value.unicodeScalars.allSatisfy { scalar in
            (48...57).contains(scalar.value)
                || (65...90).contains(scalar.value)
                || (97...122).contains(scalar.value)
        }
    }
}
