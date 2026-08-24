import CryptoKit
import Foundation

public struct RawWordTiming: Equatable, Sendable {
    public let text: String
    public let startSeconds: Double
    public let endSeconds: Double

    public init(text: String, startSeconds: Double, endSeconds: Double) {
        self.text = text
        self.startSeconds = startSeconds
        self.endSeconds = endSeconds
    }
}

public struct RawCue: Equatable, Sendable {
    public let startSeconds: Double
    public let endSeconds: Double
    public let text: String
    public let timedWords: [RawWordTiming]

    public init(
        startSeconds: Double,
        endSeconds: Double,
        text: String,
        timedWords: [RawWordTiming] = []
    ) {
        self.startSeconds = startSeconds
        self.endSeconds = endSeconds
        self.text = text
        self.timedWords = timedWords
    }
}

public struct CueAccumulator: Sendable {
    private struct ReadableChunk {
        let text: String
        let characterWeight: Double
    }

    private static let maximumDisplayUnits = 88.0
    private static let minimumChunkDurationMs = 900.0

    public private(set) var cues: [SubtitleCue] = []
    public private(set) var revision = 0

    public init() {}

    public mutating func merge(
        rawCues: [RawCue],
        window: MediaWindow,
        durationMs: Double
    ) -> [SubtitleCue] {
        var additions: [SubtitleCue] = []
        for raw in rawCues {
            let text = raw.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let start = max(window.startMs, window.startMs + raw.startSeconds * 1_000)
            let end = min(durationMs, window.startMs + raw.endSeconds * 1_000)
            guard !text.isEmpty,
                  start.isFinite,
                  end.isFinite,
                  end > start else { continue }

            let chunks = Self.readableChunks(text, durationMs: end - start)
            let durations = Self.chunkDurations(chunks, totalDurationMs: end - start)
            let wordTimings = Self.wordTimedRanges(raw: raw, chunks: chunks)
            var proportionalStart = start
            for index in chunks.indices {
                let chunk = chunks[index]
                let chunkStart: Double
                let chunkEnd: Double
                if let timing = wordTimings?[index] {
                    chunkStart = max(window.startMs, window.startMs + timing.startSeconds * 1_000)
                    chunkEnd = min(durationMs, window.startMs + timing.endSeconds * 1_000)
                } else {
                    chunkStart = proportionalStart
                    chunkEnd = index == chunks.index(before: chunks.endIndex)
                        ? end
                        : min(end, chunkStart + durations[index])
                    proportionalStart = chunkEnd
                }
                let midpoint = (chunkStart + chunkEnd) / 2
                guard chunkEnd > chunkStart, midpoint >= window.emitAfterMs else { continue }
                let candidate = SubtitleCue(
                    cueId: Self.cueID(startMs: chunkStart, endMs: chunkEnd, text: chunk.text),
                    startMs: chunkStart,
                    endMs: chunkEnd,
                    text: chunk.text
                )
                if isDuplicate(candidate) { continue }
                cues.append(candidate)
                additions.append(candidate)
            }
        }
        cues.sort { left, right in
            left.startMs == right.startMs ? left.endMs < right.endMs : left.startMs < right.startMs
        }
        if !additions.isEmpty { revision += 1 }
        return additions
    }

    private static func readableChunks(_ text: String, durationMs: Double) -> [ReadableChunk] {
        let characters = Array(text)
        let complete = ReadableChunk(text: text, characterWeight: characterWeight(text))
        let totalWidth = characters.reduce(0.0) { $0 + displayUnits($1) }
        let neededParts = max(1, Int(ceil(totalWidth / maximumDisplayUnits)))
        let durationLimitedParts = max(1, Int(floor(durationMs / minimumChunkDurationMs)))
        let partCount = min(neededParts, durationLimitedParts)
        guard partCount > 1 else { return [complete] }

        var chunks: [ReadableChunk] = []
        var startIndex = 0
        var remainingWidth = totalWidth
        for part in 0..<(partCount - 1) {
            let remainingParts = partCount - part
            let idealWidth = remainingWidth / Double(remainingParts)
            let breakIndex = bestBreakIndex(
                in: characters,
                from: startIndex,
                remainingWidth: remainingWidth,
                remainingParts: remainingParts,
                idealWidth: idealWidth,
                enforceMaximum: partCount == neededParts
            )
            let chunkText = String(characters[startIndex..<breakIndex])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !chunkText.isEmpty {
                chunks.append(ReadableChunk(
                    text: chunkText,
                    characterWeight: characterWeight(chunkText)
                ))
            }
            let consumedWidth = characters[startIndex..<breakIndex]
                .reduce(0.0) { $0 + displayUnits($1) }
            remainingWidth -= consumedWidth
            startIndex = breakIndex
        }

        let finalText = String(characters[startIndex...])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !finalText.isEmpty {
            chunks.append(ReadableChunk(
                text: finalText,
                characterWeight: characterWeight(finalText)
            ))
        }
        return chunks.count > 1 ? chunks : [complete]
    }

    /// Map readable chunks back to complete Whisper words so every split uses
    /// the real spoken boundary. If token text or timing is ambiguous, the
    /// caller falls back to the conservative proportional timeline.
    private static func wordTimedRanges(
        raw: RawCue,
        chunks: [ReadableChunk]
    ) -> [(startSeconds: Double, endSeconds: Double)]? {
        guard chunks.count > 1,
              !containsCJK(raw.text),
              !raw.timedWords.isEmpty else { return nil }

        let compactRaw = compactCharacters(raw.text)
        let compactWords = raw.timedWords.map { compactCharacters($0.text) }
        guard !compactRaw.isEmpty,
              compactWords.allSatisfy({ !$0.isEmpty }),
              compactWords.flatMap({ $0 }) == compactRaw else { return nil }

        let compactChunks = chunks.map { compactCharacters($0.text) }
        guard compactChunks.allSatisfy({ !$0.isEmpty }),
              compactChunks.flatMap({ $0 }) == compactRaw else { return nil }

        var ranges: [(startSeconds: Double, endSeconds: Double)] = []
        var wordIndex = 0
        var previousEnd = -Double.infinity
        for chunk in compactChunks {
            let firstWord = wordIndex
            var consumedCharacters = 0
            while wordIndex < compactWords.count,
                  consumedCharacters < chunk.count {
                consumedCharacters += compactWords[wordIndex].count
                wordIndex += 1
            }
            guard consumedCharacters == chunk.count, wordIndex > firstWord else { return nil }

            let startSeconds = raw.timedWords[firstWord].startSeconds
            let endSeconds = raw.timedWords[wordIndex - 1].endSeconds
            guard startSeconds.isFinite,
                  endSeconds.isFinite,
                  startSeconds >= raw.startSeconds,
                  endSeconds <= raw.endSeconds,
                  startSeconds >= previousEnd,
                  endSeconds > startSeconds else { return nil }
            ranges.append((startSeconds, endSeconds))
            previousEnd = endSeconds
        }
        guard wordIndex == raw.timedWords.count else { return nil }
        return ranges
    }

    private static func compactCharacters(_ text: String) -> [Character] {
        text.filter { !isWhitespace($0) }
    }

    private static func containsCJK(_ text: String) -> Bool {
        text.unicodeScalars.contains { scalar in
            switch scalar.value {
            case 0x1100...0x11ff,
                 0x2e80...0x9fff,
                 0xac00...0xd7af,
                 0xf900...0xfaff,
                 0x20000...0x2fa1f:
                return true
            default:
                return false
            }
        }
    }

    private static func bestBreakIndex(
        in characters: [Character],
        from startIndex: Int,
        remainingWidth: Double,
        remainingParts: Int,
        idealWidth: Double,
        enforceMaximum: Bool
    ) -> Int {
        let futureParts = remainingParts - 1
        let lastPossibleIndex = characters.count - futureParts
        let minimumWidth = idealWidth * 0.62
        let maximumWidth = enforceMaximum
            ? min(maximumDisplayUnits, idealWidth * 1.38)
            : idealWidth * 1.38
        let minimumFutureWidth = idealWidth * 0.62 * Double(futureParts)

        var width = 0.0
        var hardBreak = startIndex + 1
        var hardDistance = Double.greatestFiniteMagnitude
        var naturalBreak: Int?
        var naturalPriority = 0
        var naturalDistance = Double.greatestFiniteMagnitude

        for index in startIndex..<lastPossibleIndex {
            width += displayUnits(characters[index])
            let boundary = index + 1
            let futureWidth = remainingWidth - width
            guard futureWidth >= minimumFutureWidth else { break }
            if enforceMaximum, futureWidth > maximumDisplayUnits * Double(futureParts) {
                continue
            }

            let distance = abs(width - idealWidth)
            if distance < hardDistance {
                hardBreak = boundary
                hardDistance = distance
            }
            guard width >= minimumWidth, width <= maximumWidth else { continue }
            let priority = breakPriority(after: boundary, in: characters)
            guard priority > 0 else { continue }
            if priority > naturalPriority || (priority == naturalPriority && distance < naturalDistance) {
                naturalBreak = boundary
                naturalPriority = priority
                naturalDistance = distance
            }
        }
        return naturalBreak ?? hardBreak
    }

    private static func chunkDurations(
        _ chunks: [ReadableChunk],
        totalDurationMs: Double
    ) -> [Double] {
        guard chunks.count > 1 else { return [totalDurationMs] }
        var durations = Array(repeating: 0.0, count: chunks.count)
        var pending = Array(chunks.indices)
        var remainingDuration = totalDurationMs

        while !pending.isEmpty {
            let totalWeight = pending.reduce(0.0) { $0 + chunks[$1].characterWeight }
            let tooShort = pending.filter {
                remainingDuration * chunks[$0].characterWeight / totalWeight < minimumChunkDurationMs
            }
            if tooShort.isEmpty {
                for index in pending {
                    durations[index] = remainingDuration * chunks[index].characterWeight / totalWeight
                }
                break
            }
            for index in tooShort {
                durations[index] = minimumChunkDurationMs
                remainingDuration -= minimumChunkDurationMs
            }
            let clamped = Set(tooShort)
            pending.removeAll { clamped.contains($0) }
        }

        if let last = durations.indices.last {
            durations[last] += totalDurationMs - durations.reduce(0, +)
        }
        return durations
    }

    private static func characterWeight(_ text: String) -> Double {
        max(1, Double(text.count))
    }

    private static func displayUnits(_ character: Character) -> Double {
        character.unicodeScalars.contains(where: isWideScalar) ? 2.2 : 1
    }

    private static func isWideScalar(_ scalar: UnicodeScalar) -> Bool {
        switch scalar.value {
        case 0x1100...0x11ff,
             0x2e80...0x9fff,
             0xac00...0xd7af,
             0xf900...0xfaff,
             0xff00...0xffef,
             0x1f300...0x1faff,
             0x20000...0x2fa1f:
            return true
        default:
            return false
        }
    }

    private static func breakPriority(after boundary: Int, in characters: [Character]) -> Int {
        var index = boundary - 1
        let endsInWhitespace = isWhitespace(characters[index])
        while index >= 0,
              isWhitespace(characters[index]) || isClosingPunctuation(characters[index]) {
            index -= 1
        }
        guard index >= 0 else { return endsInWhitespace ? 1 : 0 }
        if isSentencePunctuation(characters[index]) { return 3 }
        if isClausePunctuation(characters[index]) { return 2 }
        return endsInWhitespace ? 1 : 0
    }

    private static func isWhitespace(_ character: Character) -> Bool {
        character.unicodeScalars.allSatisfy(CharacterSet.whitespacesAndNewlines.contains)
    }

    private static func isSentencePunctuation(_ character: Character) -> Bool {
        ".!?。！？…".contains(character)
    }

    private static func isClausePunctuation(_ character: Character) -> Bool {
        ",;:，；：、—–".contains(character)
    }

    private static func isClosingPunctuation(_ character: Character) -> Bool {
        "\"'”’」』）)]】》〉".contains(character)
    }

    private func isDuplicate(_ candidate: SubtitleCue) -> Bool {
        let normalized = Self.normalized(candidate.text)
        guard !normalized.isEmpty else { return true }
        return cues.suffix(12).contains { existing in
            guard Self.normalized(existing.text) == normalized else { return false }
            let overlap = max(0, min(existing.endMs, candidate.endMs) - max(existing.startMs, candidate.startMs))
            let shortest = min(existing.endMs - existing.startMs, candidate.endMs - candidate.startMs)
            return abs(existing.startMs - candidate.startMs) <= 1_500
                || (shortest > 0 && overlap / shortest >= 0.5)
        }
    }

    private static func normalized(_ text: String) -> String {
        text.lowercased().unicodeScalars
            .filter { CharacterSet.alphanumerics.contains($0) }
            .map(String.init)
            .joined()
    }

    private static func cueID(startMs: Double, endMs: Double, text: String) -> String {
        let payload = "\(Int(startMs.rounded()))|\(Int(endMs.rounded()))|\(normalized(text))"
        let digest = SHA256.hash(data: Data(payload.utf8))
        return digest.prefix(10).map { String(format: "%02x", $0) }.joined()
    }
}
