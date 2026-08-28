import Foundation

public enum HLSResolverError: LocalizedError {
    case invalidResponse
    case http(Int)
    case manifestTooLarge
    case emptyPlaylist
    case unsupportedEncryption
    case unsupportedByteRange
    case unsupportedMediaChange
    case unsupportedAudio
    case unsafeRedirect

    public var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "视频服务器返回了无法读取的响应。"
        case let .http(status):
            return "视频服务器拒绝读取（HTTP \(status)）。"
        case .manifestTooLarge:
            return "视频播放列表异常大，已停止读取。"
        case .emptyPlaylist:
            return "视频播放列表中没有可用媒体。"
        case .unsupportedEncryption:
            return "这个 HLS 视频使用了暂不支持的分片加密。"
        case .unsupportedByteRange:
            return "这个 HLS 视频使用了暂不支持的字节范围分片。"
        case .unsupportedMediaChange:
            return "这个 HLS 视频中途更换了媒体格式，暂不支持离线字幕。"
        case .unsupportedAudio:
            return "这个 HLS 视频的音轨不是可直接读取的 AAC。"
        case .unsafeRedirect:
            return "视频地址重定向到了本机或内网，已阻止读取。"
        }
    }
}

public struct HLSVariant: Equatable, Sendable {
    public let url: URL
    public let bandwidth: Int

    public init(url: URL, bandwidth: Int) {
        self.url = url
        self.bandwidth = bandwidth
    }
}

public struct HLSSegment: Equatable, Sendable {
    public let url: URL
    public let startMs: Double
    public let endMs: Double

    public init(url: URL, startMs: Double, endMs: Double) {
        self.url = url
        self.startMs = startMs
        self.endMs = endMs
    }
}

public struct HLSMediaPlaylist: Equatable, Sendable {
    public let url: URL
    public let segments: [HLSSegment]
    public let durationMs: Double
    public let initializationSegmentURL: URL?

    public init(
        url: URL,
        segments: [HLSSegment],
        durationMs: Double,
        initializationSegmentURL: URL? = nil
    ) {
        self.url = url
        self.segments = segments
        self.durationMs = durationMs
        self.initializationSegmentURL = initializationSegmentURL
    }
}

public struct AssembledMedia: Sendable {
    public let fileURL: URL
    public let mediaStartMs: Double
    public let mediaEndMs: Double

    public init(fileURL: URL, mediaStartMs: Double, mediaEndMs: Double) {
        self.fileURL = fileURL
        self.mediaStartMs = mediaStartMs
        self.mediaEndMs = mediaEndMs
    }
}

private enum BoundedDownloadError: Error {
    case tooLarge
}

package final class HLSDownloadBudget: @unchecked Sendable {
    private let lock = NSLock()
    private let maximumBytes: Int
    private var consumed = 0

    package init(maximumBytes: Int) {
        self.maximumBytes = max(0, maximumBytes)
    }

    package func canFit(_ count: Int) -> Bool {
        guard count >= 0 else { return false }
        lock.lock()
        defer { lock.unlock() }
        return count <= maximumBytes - consumed
    }

    package func consume(_ count: Int) -> Bool {
        guard count >= 0 else { return false }
        lock.lock()
        defer { lock.unlock() }
        guard count <= maximumBytes - consumed else { return false }
        consumed += count
        return true
    }

    package var consumedBytes: Int {
        lock.lock()
        defer { lock.unlock() }
        return consumed
    }
}

private final class BoundedDataLoader: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    private let maximumBytes: Int
    private let budget: HLSDownloadBudget?
    private let stateLock = NSLock()
    private var continuation: CheckedContinuation<Data, Error>?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var payload = Data()
    private var acceptedResponse = false
    private var cancellationRequested = false
    private var finished = false

    init(maximumBytes: Int, budget: HLSDownloadBudget?) {
        self.maximumBytes = max(0, maximumBytes)
        self.budget = budget
    }

    func load(_ request: URLRequest, configuration: URLSessionConfiguration) async throws -> Data {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let queue = OperationQueue()
                queue.maxConcurrentOperationCount = 1
                let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
                let task = session.dataTask(with: request)

                stateLock.lock()
                self.continuation = continuation
                self.session = session
                self.task = task
                let shouldCancel = cancellationRequested
                stateLock.unlock()

                task.resume()
                if shouldCancel { task.cancel() }
            }
        } onCancel: {
            self.requestCancellation()
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(request.url.map(MediaURLSafety.isResolvedPublic) == true ? request : nil)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        let result: Result<Void, Error>
        if let http = response as? HTTPURLResponse {
            if http.url.map(MediaURLSafety.isResolvedPublic) != true {
                result = .failure(HLSResolverError.unsafeRedirect)
            } else if !(200..<300).contains(http.statusCode) {
                result = .failure(HLSResolverError.http(http.statusCode))
            } else if response.expectedContentLength >= 0,
                      response.expectedContentLength > Int64(maximumBytes) {
                result = .failure(BoundedDownloadError.tooLarge)
            } else if response.expectedContentLength >= 0,
                      budget?.canFit(Int(response.expectedContentLength)) == false {
                result = .failure(BoundedDownloadError.tooLarge)
            } else {
                result = .success(())
            }
        } else {
            result = .failure(HLSResolverError.invalidResponse)
        }

        switch result {
        case .success:
            stateLock.lock()
            acceptedResponse = true
            stateLock.unlock()
            completionHandler(.allow)
        case let .failure(error):
            completionHandler(.cancel)
            dataTask.cancel()
            finish(.failure(error))
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        var overflow = false
        stateLock.lock()
        if !finished {
            if !acceptedResponse
                || data.count > maximumBytes - payload.count
                || budget?.consume(data.count) == false {
                overflow = true
            } else {
                payload.append(data)
            }
        }
        stateLock.unlock()

        if overflow {
            dataTask.cancel()
            finish(.failure(BoundedDownloadError.tooLarge))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            stateLock.lock()
            let wasCancelled = cancellationRequested
            stateLock.unlock()
            if wasCancelled, (error as? URLError)?.code == .cancelled {
                finish(.failure(CancellationError()))
            } else {
                finish(.failure(error))
            }
            return
        }

        stateLock.lock()
        let complete = acceptedResponse
        let data = payload
        stateLock.unlock()
        finish(complete ? .success(data) : .failure(HLSResolverError.invalidResponse))
    }

    private func requestCancellation() {
        stateLock.lock()
        cancellationRequested = true
        let task = self.task
        stateLock.unlock()
        task?.cancel()
    }

    private func finish(_ result: Result<Data, Error>) {
        stateLock.lock()
        guard !finished else {
            stateLock.unlock()
            return
        }
        finished = true
        let continuation = self.continuation
        let session = self.session
        self.continuation = nil
        self.session = nil
        task = nil
        payload = Data()
        stateLock.unlock()

        session?.invalidateAndCancel()
        continuation?.resume(with: result)
    }
}

private func makeHLSURLSessionConfiguration() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 20
    configuration.timeoutIntervalForResource = 45
    configuration.httpMaximumConnectionsPerHost = 4
    return configuration
}

public actor HLSResolver {
    private let root: URL
    private let maximumManifestBytes = 2 * 1_024 * 1_024
    private let maximumChunkBytes = 128 * 1_024 * 1_024

    public init(root: URL? = nil) throws {
        let base = root ?? FileManager.default.temporaryDirectory
            .appendingPathComponent("koe-helper-hls", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        self.root = base
    }

    public func load(_ sourceURL: URL, headers: [String: String]) async throws -> HLSMediaPlaylist {
        let first = try await text(at: sourceURL, headers: headers)
        let variants = Self.variants(in: first, baseURL: sourceURL)
        let mediaURL = variants.min { $0.bandwidth < $1.bandwidth }?.url ?? sourceURL
        let mediaText = mediaURL == sourceURL ? first : try await text(at: mediaURL, headers: headers)
        return try Self.mediaPlaylist(in: mediaText, baseURL: mediaURL)
    }

    public func assemble(
        playlist: HLSMediaPlaylist,
        window: MediaWindow,
        headers: [String: String]
    ) async throws -> AssembledMedia {
        let matching = playlist.segments.filter { $0.endMs > window.startMs && $0.startMs < window.endMs }
        guard !matching.isEmpty, matching.count <= 40 else { throw HLSResolverError.emptyPlaylist }
        var pieces = Array<Data?>(repeating: nil, count: matching.count)
        let downloadBudget = HLSDownloadBudget(maximumBytes: maximumChunkBytes)
        let maximumChunkBytes = self.maximumChunkBytes
        try await withThrowingTaskGroup(of: (Int, Data).self) { group in
            var nextIndex = 0
            let initial = min(4, matching.count)
            for _ in 0..<initial {
                let index = nextIndex
                nextIndex += 1
                group.addTask {
                    (index, try await Self.data(
                        at: matching[index].url,
                        headers: headers,
                        maximumBytes: maximumChunkBytes,
                        budget: downloadBudget,
                        tooLargeError: .invalidResponse
                    ))
                }
            }
            do {
                while let (index, data) = try await group.next() {
                    pieces[index] = data
                    if nextIndex < matching.count {
                        let index = nextIndex
                        nextIndex += 1
                        group.addTask {
                            (index, try await Self.data(
                                at: matching[index].url,
                                headers: headers,
                                maximumBytes: maximumChunkBytes,
                                budget: downloadBudget,
                                tooLargeError: .invalidResponse
                            ))
                        }
                    }
                }
            } catch {
                group.cancelAll()
                throw error
            }
        }
        let completePieces = try pieces.map { piece -> Data in
            guard let piece else { throw HLSResolverError.invalidResponse }
            return piece
        }
        let media: Data
        let fileExtension: String
        if let initializationSegmentURL = playlist.initializationSegmentURL {
            let initialization = try await Self.data(
                at: initializationSegmentURL,
                headers: headers,
                maximumBytes: maximumChunkBytes,
                budget: downloadBudget,
                tooLargeError: .invalidResponse
            )
            let total = completePieces.reduce(initialization.count) { $0 + $1.count }
            guard total > initialization.count, total <= maximumChunkBytes else {
                throw HLSResolverError.invalidResponse
            }
            media = try Self.assembleFragmentedMP4(
                initialization: initialization,
                fragments: completePieces
            )
            fileExtension = "mp4"
        } else {
            let total = completePieces.reduce(0) { $0 + $1.count }
            guard total > 0, total <= maximumChunkBytes else {
                throw HLSResolverError.invalidResponse
            }
            media = try Self.demuxADTS(from: completePieces)
            fileExtension = "aac"
        }
        let outputURL = root.appendingPathComponent("\(UUID().uuidString).\(fileExtension)")
        do {
            try media.write(to: outputURL, options: .atomic)
        } catch {
            try? FileManager.default.removeItem(at: outputURL)
            throw error
        }
        return AssembledMedia(
            fileURL: outputURL,
            mediaStartMs: matching.first?.startMs ?? window.startMs,
            mediaEndMs: matching.last?.endMs ?? window.endMs
        )
    }

    public func remove(_ fileURL: URL) {
        guard fileURL.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL else { return }
        try? FileManager.default.removeItem(at: fileURL)
    }

    private func text(at url: URL, headers: [String: String]) async throws -> String {
        let data = try await Self.data(
            at: url,
            headers: headers,
            maximumBytes: maximumManifestBytes,
            tooLargeError: .manifestTooLarge
        )
        guard let value = String(data: data, encoding: .utf8), !value.isEmpty else {
            throw HLSResolverError.emptyPlaylist
        }
        return value
    }

    private static func data(
        at url: URL,
        headers: [String: String],
        maximumBytes: Int,
        budget: HLSDownloadBudget? = nil,
        tooLargeError: HLSResolverError,
        configuration: URLSessionConfiguration = makeHLSURLSessionConfiguration()
    ) async throws -> Data {
        guard MediaURLSafety.isResolvedPublic(url) else { throw HLSResolverError.unsafeRedirect }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        do {
            return try await BoundedDataLoader(maximumBytes: maximumBytes, budget: budget)
                .load(request, configuration: configuration)
        } catch BoundedDownloadError.tooLarge {
            throw tooLargeError
        }
    }

    package static func boundedDataForCoreChecks(
        at url: URL,
        maximumBytes: Int,
        configuration: URLSessionConfiguration
    ) async throws -> Data {
        try await data(
            at: url,
            headers: [:],
            maximumBytes: maximumBytes,
            tooLargeError: .manifestTooLarge,
            configuration: configuration
        )
    }

    /// Extracts an AAC/ADTS elementary stream from MPEG-TS HLS segments.
    /// Keeping the compressed audio avoids ffmpeg and avoids AVFoundation's
    /// inability to open standalone local transport-stream files on macOS.
    public static func demuxADTS(from segments: [Data]) throws -> Data {
        guard !segments.isEmpty,
              segments.allSatisfy({ !$0.isEmpty && $0.count.isMultiple(of: 188) }) else {
            throw HLSResolverError.invalidResponse
        }
        let audioPID = segments.lazy.compactMap(audioPID(in:)).first
        guard let audioPID else { throw HLSResolverError.unsupportedAudio }

        var elementary = Data()
        for segment in segments {
            var packetOffset = 0
            while packetOffset + 188 <= segment.count {
                guard segment[packetOffset] == 0x47 else { throw HLSResolverError.invalidResponse }
                let pid = (Int(segment[packetOffset + 1] & 0x1f) << 8)
                    | Int(segment[packetOffset + 2])
                defer { packetOffset += 188 }
                guard pid == audioPID,
                      let payload = payloadRange(in: segment, packetOffset: packetOffset) else { continue }
                var start = payload.lowerBound
                let startsPES = (segment[packetOffset + 1] & 0x40) != 0
                if startsPES {
                    guard payload.count >= 9,
                          segment[start] == 0,
                          segment[start + 1] == 0,
                          segment[start + 2] == 1 else { continue }
                    start += 9 + Int(segment[start + 8])
                }
                guard start < payload.upperBound else { continue }
                elementary.append(segment[start..<payload.upperBound])
            }
        }

        var audio = Data()
        var cursor = 0
        while cursor + 7 <= elementary.count {
            guard elementary[cursor] == 0xff,
                  (elementary[cursor + 1] & 0xf6) == 0xf0 else {
                cursor += 1
                continue
            }
            let headerLength = (elementary[cursor + 1] & 0x01) == 1 ? 7 : 9
            let frameLength = (Int(elementary[cursor + 3] & 0x03) << 11)
                | (Int(elementary[cursor + 4]) << 3)
                | Int((elementary[cursor + 5] & 0xe0) >> 5)
            guard frameLength >= headerLength, cursor + frameLength <= elementary.count else {
                cursor += 1
                continue
            }
            audio.append(elementary[cursor..<(cursor + frameLength)])
            cursor += frameLength
        }
        guard !audio.isEmpty else { throw HLSResolverError.unsupportedAudio }
        return audio
    }

    /// Rebuilds the bounded portion of a CMAF/fMP4 HLS stream as a local MP4.
    /// The initialization segment describes the tracks; each selected media
    /// fragment then contributes its original `moof`/`mdat` pair. AVFoundation
    /// can read the audio track directly without ffmpeg or a full-video fetch.
    public static func assembleFragmentedMP4(initialization: Data, fragments: [Data]) throws -> Data {
        guard let initializationBoxes = topLevelBoxTypes(in: initialization),
              let fileTypeIndex = initializationBoxes.firstIndex(of: "ftyp"),
              let movieIndex = initializationBoxes.firstIndex(of: "moov"),
              fileTypeIndex < movieIndex,
              !fragments.isEmpty,
              fragments.allSatisfy(isCompleteMediaFragment) else {
            throw HLSResolverError.invalidResponse
        }
        var output = Data(capacity: initialization.count + fragments.reduce(0) { $0 + $1.count })
        output.append(initialization)
        for fragment in fragments { output.append(fragment) }
        return output
    }

    private static func isCompleteMediaFragment(_ data: Data) -> Bool {
        guard let boxes = topLevelBoxTypes(in: data),
              let movieFragmentIndex = boxes.firstIndex(of: "moof") else { return false }
        return boxes.indices.contains { $0 > movieFragmentIndex && boxes[$0] == "mdat" }
    }

    /// Validates every top-level ISO BMFF box rather than assuming `moof` is
    /// first. CMAF permits metadata and packing boxes such as `emsg`, `prft`,
    /// `sidx`, and `free` before the media fragment.
    private static func topLevelBoxTypes(in data: Data) -> [String]? {
        guard !data.isEmpty else { return nil }
        var offset = 0
        var types: [String] = []
        while offset < data.count {
            let remaining = data.count - offset
            guard remaining >= 8,
                  let compactSize = unsignedInteger(in: data, offset: offset, byteCount: 4),
                  let typeBytes = bytes(in: data, offset: offset + 4, count: 4),
                  typeBytes.allSatisfy({ (0x20...0x7e).contains($0) }),
                  let type = String(bytes: typeBytes, encoding: .ascii) else { return nil }
            let headerSize: Int
            let boxSize: Int
            if compactSize == 1 {
                guard remaining >= 16,
                      let extendedSize = unsignedInteger(in: data, offset: offset + 8, byteCount: 8),
                      extendedSize <= UInt64(Int.max) else { return nil }
                headerSize = 16
                boxSize = Int(extendedSize)
            } else {
                headerSize = 8
                boxSize = compactSize == 0 ? remaining : Int(compactSize)
            }
            guard boxSize >= headerSize, boxSize <= remaining else { return nil }
            types.append(type)
            offset += boxSize
        }
        return offset == data.count ? types : nil
    }

    private static func unsignedInteger(in data: Data, offset: Int, byteCount: Int) -> UInt64? {
        guard (1...8).contains(byteCount), let values = bytes(in: data, offset: offset, count: byteCount) else {
            return nil
        }
        return values.reduce(0) { ($0 << 8) | UInt64($1) }
    }

    private static func bytes(in data: Data, offset: Int, count: Int) -> [UInt8]? {
        guard offset >= 0, count >= 0, offset <= data.count - count else { return nil }
        let start = data.index(data.startIndex, offsetBy: offset)
        let end = data.index(start, offsetBy: count)
        return Array(data[start..<end])
    }

    private static func audioPID(in segment: Data) -> Int? {
        guard let pat = psiSection(in: segment, pid: 0), pat.count >= 12 else { return nil }
        let patEnd = min(pat.count - 4, 3 + (((Int(pat[1]) & 0x0f) << 8) | Int(pat[2])))
        var pmtPID: Int?
        var cursor = 8
        while cursor + 3 < patEnd {
            let program = (Int(pat[cursor]) << 8) | Int(pat[cursor + 1])
            if program != 0 {
                pmtPID = (Int(pat[cursor + 2] & 0x1f) << 8) | Int(pat[cursor + 3])
                break
            }
            cursor += 4
        }
        guard let pmtPID,
              let pmt = psiSection(in: segment, pid: pmtPID), pmt.count >= 16 else { return nil }
        let pmtEnd = min(pmt.count - 4, 3 + (((Int(pmt[1]) & 0x0f) << 8) | Int(pmt[2])))
        let programInfoLength = (Int(pmt[10] & 0x0f) << 8) | Int(pmt[11])
        cursor = 12 + programInfoLength
        while cursor + 4 < pmtEnd {
            let streamType = pmt[cursor]
            let elementaryPID = (Int(pmt[cursor + 1] & 0x1f) << 8) | Int(pmt[cursor + 2])
            let infoLength = (Int(pmt[cursor + 3] & 0x0f) << 8) | Int(pmt[cursor + 4])
            if streamType == 0x0f { return elementaryPID }
            cursor += 5 + infoLength
        }
        return nil
    }

    private static func psiSection(in segment: Data, pid: Int) -> Data? {
        var section = Data()
        var expectedLength: Int?
        var collecting = false
        var packetOffset = 0
        while packetOffset + 188 <= segment.count {
            guard segment[packetOffset] == 0x47 else { return nil }
            let packetPID = (Int(segment[packetOffset + 1] & 0x1f) << 8)
                | Int(segment[packetOffset + 2])
            guard packetPID == pid,
                  let payload = payloadRange(in: segment, packetOffset: packetOffset),
                  !payload.isEmpty else {
                packetOffset += 188
                continue
            }

            var cursor = payload.lowerBound
            if (segment[packetOffset + 1] & 0x40) != 0 {
                let pointer = Int(segment[cursor])
                cursor += 1
                guard cursor + pointer <= payload.upperBound else { return nil }
                cursor += pointer
                section.removeAll(keepingCapacity: true)
                expectedLength = nil
                collecting = true
            }
            guard collecting, cursor < payload.upperBound else {
                packetOffset += 188
                continue
            }

            let availableEnd: Int
            if let expectedLength {
                availableEnd = min(payload.upperBound, cursor + expectedLength - section.count)
            } else {
                availableEnd = payload.upperBound
            }
            section.append(segment[cursor..<availableEnd])
            if expectedLength == nil, section.count >= 3 {
                expectedLength = 3 + ((Int(section[1]) & 0x0f) << 8) + Int(section[2])
            }
            if let expectedLength, section.count >= expectedLength {
                return Data(section.prefix(expectedLength))
            }
            packetOffset += 188
        }
        return nil
    }

    private static func payloadRange(in segment: Data, packetOffset: Int) -> Range<Int>? {
        let packetEnd = packetOffset + 188
        let adaptationControl = (segment[packetOffset + 3] >> 4) & 0x03
        if adaptationControl == 1 { return (packetOffset + 4)..<packetEnd }
        guard adaptationControl == 3, packetOffset + 5 <= packetEnd else { return nil }
        let adaptationLength = Int(segment[packetOffset + 4])
        let payloadStart = packetOffset + 5 + adaptationLength
        guard payloadStart < packetEnd else { return nil }
        return payloadStart..<packetEnd
    }

    public static func variants(in playlist: String, baseURL: URL) -> [HLSVariant] {
        let lines = playlist.components(separatedBy: .newlines)
        var variants: [HLSVariant] = []
        for index in lines.indices {
            let line = lines[index].trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.uppercased().hasPrefix("#EXT-X-STREAM-INF:") else { continue }
            let attributes = String(line.dropFirst("#EXT-X-STREAM-INF:".count))
            let bandwidth = attribute(named: "AVERAGE-BANDWIDTH", in: attributes)
                ?? attribute(named: "BANDWIDTH", in: attributes)
                // Some production manifests omit both bandwidth fields but do
                // provide RESOLUTION. Pixel area is only a fallback selection
                // weight; choosing the smallest picture also minimizes the
                // multiplexed audio download needed for transcription.
                ?? resolutionPixelArea(in: attributes)
                ?? Int.max
            guard let uri = nextURI(after: index, lines: lines),
                  let url = resolvedURL(uri, relativeTo: baseURL),
                  MediaURLSafety.isAllowed(url) else { continue }
            variants.append(HLSVariant(url: url, bandwidth: bandwidth))
        }
        return variants
    }

    public static func mediaPlaylist(in playlist: String, baseURL: URL) throws -> HLSMediaPlaylist {
        let lines = playlist.components(separatedBy: .newlines)
        if lines.contains(where: { $0.uppercased().hasPrefix("#EXT-X-BYTERANGE") }) {
            throw HLSResolverError.unsupportedByteRange
        }
        for line in lines where line.uppercased().hasPrefix("#EXT-X-KEY:") {
            let attributes = line.split(separator: ":", maxSplits: 1).dropFirst().first.map(String.init) ?? ""
            let method = attributeString(named: "METHOD", in: attributes) ?? "NONE"
            if method.uppercased() != "NONE" { throw HLSResolverError.unsupportedEncryption }
        }
        var initializationSegmentURL: URL?
        var sawMediaSegment = false
        for rawLine in lines {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.uppercased().hasPrefix("#EXTINF:") {
                sawMediaSegment = true
                continue
            }
            guard line.uppercased().hasPrefix("#EXT-X-MAP:") else { continue }
            if sawMediaSegment { throw HLSResolverError.unsupportedMediaChange }
            let attributes = String(line.dropFirst("#EXT-X-MAP:".count))
            if attributeString(named: "BYTERANGE", in: attributes) != nil {
                throw HLSResolverError.unsupportedByteRange
            }
            guard let uri = attributeString(named: "URI", in: attributes),
                  let url = resolvedURL(uri, relativeTo: baseURL),
                  MediaURLSafety.isAllowed(url) else {
                throw HLSResolverError.emptyPlaylist
            }
            if let existing = initializationSegmentURL, existing != url {
                throw HLSResolverError.unsupportedMediaChange
            }
            initializationSegmentURL = url
        }
        var segments: [HLSSegment] = []
        var cursorMs = 0.0
        for index in lines.indices {
            let line = lines[index].trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.uppercased().hasPrefix("#EXTINF:") else { continue }
            let value = line.dropFirst("#EXTINF:".count).split(separator: ",", maxSplits: 1).first
            guard let value, let seconds = Double(value), seconds > 0,
                  let uri = nextURI(after: index, lines: lines),
                  let url = resolvedURL(uri, relativeTo: baseURL),
                  MediaURLSafety.isAllowed(url) else { continue }
            let endMs = cursorMs + seconds * 1_000
            segments.append(HLSSegment(url: url, startMs: cursorMs, endMs: endMs))
            cursorMs = endMs
        }
        guard !segments.isEmpty else { throw HLSResolverError.emptyPlaylist }
        return HLSMediaPlaylist(
            url: baseURL,
            segments: segments,
            durationMs: cursorMs,
            initializationSegmentURL: initializationSegmentURL
        )
    }

    private static func nextURI(after index: Int, lines: [String]) -> String? {
        var next = index + 1
        while next < lines.count {
            let candidate = lines[next].trimmingCharacters(in: .whitespacesAndNewlines)
            if !candidate.isEmpty && !candidate.hasPrefix("#") { return candidate }
            next += 1
        }
        return nil
    }

    private static func attribute(named name: String, in attributes: String) -> Int? {
        attributeString(named: name, in: attributes).flatMap(Int.init)
    }

    private static func resolutionPixelArea(in attributes: String) -> Int? {
        guard let value = attributeString(named: "RESOLUTION", in: attributes)?.lowercased() else {
            return nil
        }
        let parts = value.split(separator: "x", maxSplits: 1)
        guard parts.count == 2,
              let width = Int(parts[0]),
              let height = Int(parts[1]),
              (1...16_384).contains(width),
              (1...16_384).contains(height) else { return nil }
        return width * height
    }

    private static func attributeString(named name: String, in attributes: String) -> String? {
        let prefix = "\(name)="
        return attributes.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { $0.uppercased().hasPrefix(prefix) }
            .map { String($0.dropFirst(prefix.count)).trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
    }

    private static func resolvedURL(_ raw: String, relativeTo baseURL: URL) -> URL? {
        guard var resolved = URL(string: raw, relativeTo: baseURL)?.absoluteURL else { return nil }
        guard resolved.query == nil, baseURL.query != nil,
              sameOrigin(resolved, baseURL),
              var components = URLComponents(url: resolved, resolvingAgainstBaseURL: false),
              let baseComponents = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return resolved
        }
        components.percentEncodedQuery = baseComponents.percentEncodedQuery
        if let value = components.url { resolved = value }
        return resolved
    }

    private static func sameOrigin(_ left: URL, _ right: URL) -> Bool {
        guard left.scheme?.lowercased() == right.scheme?.lowercased(),
              left.host?.lowercased() == right.host?.lowercased() else { return false }
        func effectivePort(_ url: URL) -> Int? {
            if let port = url.port { return port }
            switch url.scheme?.lowercased() {
            case "http": return 80
            case "https": return 443
            default: return nil
            }
        }
        return effectivePort(left) == effectivePort(right)
    }
}
