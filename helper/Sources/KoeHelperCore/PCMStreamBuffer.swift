import Foundation

public enum PCMStreamError: LocalizedError, Equatable {
    case invalidFormat
    case invalidChunk
    case chunkTooLarge

    public var errorDescription: String? {
        switch self {
        case .invalidFormat:
            return "本地实时字幕收到的音频格式不受支持。"
        case .invalidChunk:
            return "本地实时字幕收到的音频片段不完整。"
        case .chunkTooLarge:
            return "本地实时字幕收到的音频片段过大。"
        }
    }
}

public struct PCMStreamWindow: Equatable, Sendable {
    public let pcm: Data
    public let startMs: Double
    public let endMs: Double
    public let emitAfterMs: Double

    public init(pcm: Data, startMs: Double, endMs: Double, emitAfterMs: Double) {
        self.pcm = pcm
        self.startMs = startMs
        self.endMs = endMs
        self.emitAfterMs = emitAfterMs
    }
}

public struct PCMStreamBuffer: Sendable {
    public let sampleRate: Int
    public let channels: Int

    private let bytesPerSample: Int
    private let bootstrapSamples: Int64
    private let windowSamples: Int64
    private let overlapSamples: Int64
    private let maximumBufferedSamples: Int64
    private var storage = Data()
    private var storageStartSample: Int64 = 0
    private var totalSamplesReceived: Int64 = 0
    private var nextWindowStartSample: Int64 = 0
    private var previousWindowEndSample: Int64 = 0
    private var emittedWindow = false

    public init(
        sampleRate: Int = 16_000,
        channels: Int = 1,
        bootstrapDurationMs: Int = 4_000,
        windowDurationMs: Int = 8_000,
        overlapMs: Int = 1_500,
        maximumBufferedDurationMs: Int = 30_000
    ) throws {
        guard sampleRate == 16_000,
              channels == 1,
              bootstrapDurationMs >= 1_000,
              windowDurationMs >= bootstrapDurationMs,
              overlapMs >= 0,
              overlapMs < bootstrapDurationMs,
              overlapMs < windowDurationMs,
              maximumBufferedDurationMs >= windowDurationMs else {
            throw PCMStreamError.invalidFormat
        }
        self.sampleRate = sampleRate
        self.channels = channels
        self.bytesPerSample = MemoryLayout<Int16>.size * channels
        self.bootstrapSamples = Int64(sampleRate * bootstrapDurationMs / 1_000)
        self.windowSamples = Int64(sampleRate * windowDurationMs / 1_000)
        self.overlapSamples = Int64(sampleRate * overlapMs / 1_000)
        self.maximumBufferedSamples = Int64(sampleRate * maximumBufferedDurationMs / 1_000)
    }

    public var bufferedDurationMs: Double {
        Double(storage.count / bytesPerSample) * 1_000 / Double(sampleRate)
    }

    public mutating func append(_ pcm: Data) throws {
        guard pcm.count.isMultiple(of: bytesPerSample) else { throw PCMStreamError.invalidChunk }
        guard pcm.count <= 512 * 1_024 else { throw PCMStreamError.chunkTooLarge }
        guard !pcm.isEmpty else { return }
        storage.append(pcm)
        totalSamplesReceived += Int64(pcm.count / bytesPerSample)
        trimToMaximum()
    }

    public mutating func takeWindow() -> PCMStreamWindow? {
        let requiredSamples = emittedWindow ? windowSamples : bootstrapSamples
        guard totalSamplesReceived - nextWindowStartSample >= requiredSamples else { return nil }
        let offsetSamples = nextWindowStartSample - storageStartSample
        guard offsetSamples >= 0 else { return nil }
        let lower = Int(offsetSamples) * bytesPerSample
        let byteCount = Int(requiredSamples) * bytesPerSample
        guard lower >= 0, lower + byteCount <= storage.count else { return nil }
        let lowerIndex = storage.index(storage.startIndex, offsetBy: lower)
        let upperIndex = storage.index(lowerIndex, offsetBy: byteCount)

        let startSample = nextWindowStartSample
        let endSample = startSample + requiredSamples
        let emitAfterSample = emittedWindow
            ? max(startSample, previousWindowEndSample - overlapSamples / 2)
            : startSample
        let result = PCMStreamWindow(
            pcm: storage.subdata(in: lowerIndex..<upperIndex),
            startMs: milliseconds(startSample),
            endMs: milliseconds(endSample),
            emitAfterMs: milliseconds(emitAfterSample)
        )

        emittedWindow = true
        previousWindowEndSample = endSample
        nextWindowStartSample = endSample - overlapSamples
        discard(before: nextWindowStartSample)
        return result
    }

    private func milliseconds(_ samples: Int64) -> Double {
        Double(samples) * 1_000 / Double(sampleRate)
    }

    private mutating func trimToMaximum() {
        let bufferedSamples = Int64(storage.count / bytesPerSample)
        guard bufferedSamples > maximumBufferedSamples else { return }
        let desiredStart = totalSamplesReceived - maximumBufferedSamples
        if desiredStart > nextWindowStartSample {
            nextWindowStartSample = desiredStart
            previousWindowEndSample = max(previousWindowEndSample, desiredStart)
            emittedWindow = true
        }
        discard(before: desiredStart)
    }

    private mutating func discard(before absoluteSample: Int64) {
        let target = min(totalSamplesReceived, max(storageStartSample, absoluteSample))
        let samples = target - storageStartSample
        guard samples > 0 else { return }
        let bytes = min(storage.count, Int(samples) * bytesPerSample)
        storage.removeFirst(bytes)
        storageStartSample += Int64(bytes / bytesPerSample)
    }
}

public enum PCM16WAV {
    public static func encode(pcm: Data, sampleRate: Int, channels: Int) throws -> Data {
        guard sampleRate > 0,
              (1...2).contains(channels),
              pcm.count.isMultiple(of: MemoryLayout<Int16>.size * channels),
              pcm.count <= Int(UInt32.max) - 44 else {
            throw PCMStreamError.invalidFormat
        }
        let bitsPerSample: UInt16 = 16
        let channelCount = UInt16(channels)
        let rate = UInt32(sampleRate)
        let blockAlign = channelCount * bitsPerSample / 8
        let byteRate = rate * UInt32(blockAlign)
        let dataSize = UInt32(pcm.count)

        var output = Data()
        output.append(contentsOf: "RIFF".utf8)
        append(UInt32(36) + dataSize, to: &output)
        output.append(contentsOf: "WAVEfmt ".utf8)
        append(UInt32(16), to: &output)
        append(UInt16(1), to: &output)
        append(channelCount, to: &output)
        append(rate, to: &output)
        append(byteRate, to: &output)
        append(blockAlign, to: &output)
        append(bitsPerSample, to: &output)
        output.append(contentsOf: "data".utf8)
        append(dataSize, to: &output)
        output.append(pcm)
        return output
    }

    private static func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { bytes in
            data.append(contentsOf: bytes)
        }
    }
}
