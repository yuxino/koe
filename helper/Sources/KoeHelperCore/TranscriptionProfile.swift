public enum TranscriptionProfile: Sendable {
    case accurate
    case live

    public var temperatureFallbackCount: Int {
        switch self {
        case .accurate: 5
        case .live: 1
        }
    }

    public var persistsLanguageHint: Bool {
        switch self {
        case .accurate: true
        case .live: false
        }
    }
}
