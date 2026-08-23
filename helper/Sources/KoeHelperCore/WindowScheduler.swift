import Foundation

public struct MediaWindow: Equatable, Sendable {
    public let startMs: Double
    public let endMs: Double
    public let emitAfterMs: Double

    public init(startMs: Double, endMs: Double, emitAfterMs: Double) {
        self.startMs = startMs
        self.endMs = endMs
        self.emitAfterMs = emitAfterMs
    }
}

public struct WindowScheduler: Sendable {
    public let bootstrapLookBehindMs: Double
    public let bootstrapLookAheadMs: Double
    public let forwardWindowMs: Double
    public let overlapMs: Double
    public let maximumLookAheadMs: Double

    public init(
        bootstrapLookBehindMs: Double = 4_000,
        bootstrapLookAheadMs: Double = 16_000,
        forwardWindowMs: Double = 30_000,
        overlapMs: Double = 4_000,
        maximumLookAheadMs: Double = 120_000
    ) {
        self.bootstrapLookBehindMs = bootstrapLookBehindMs
        self.bootstrapLookAheadMs = bootstrapLookAheadMs
        self.forwardWindowMs = forwardWindowMs
        self.overlapMs = overlapMs
        self.maximumLookAheadMs = maximumLookAheadMs
    }

    public func windows(currentTimeMs: Double, durationMs: Double) -> [MediaWindow] {
        guard durationMs > 0 else { return [] }
        let current = min(durationMs, max(0, currentTimeMs))
        let batchEnd = min(durationMs, max(current + 250, current + maximumLookAheadMs))
        let firstStart = max(0, current - bootstrapLookBehindMs)
        let firstEnd = min(batchEnd, max(firstStart + 250, current + bootstrapLookAheadMs))
        var result = [MediaWindow(startMs: firstStart, endMs: firstEnd, emitAfterMs: firstStart)]
        var previousEnd = firstEnd
        while previousEnd < batchEnd {
            let start = max(firstStart, previousEnd - overlapMs)
            let end = min(batchEnd, start + forwardWindowMs)
            guard end > start + 100 else { break }
            result.append(MediaWindow(
                startMs: start,
                endMs: end,
                emitAfterMs: max(start, previousEnd - overlapMs / 2)
            ))
            if end <= previousEnd { break }
            previousEnd = end
        }
        return result
    }
}
