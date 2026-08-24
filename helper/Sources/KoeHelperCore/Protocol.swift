import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

public let koeNativeProtocolVersion = 1

public struct MediaSource: Codable, Equatable, Sendable {
    public let url: String
    public let headers: [String: String]

    public init(url: String, headers: [String: String] = [:]) {
        self.url = url
        self.headers = headers
    }
}

public struct HostRequest: Decodable, Sendable {
    public let type: String
    public let protocolVersion: Int?
    public let jobId: String?
    public let mediaEpoch: Int?
    public let mediaKey: String?
    public let source: MediaSource?
    public let currentTimeMs: Double?
    public let durationMs: Double?
    public let playbackRate: Double?
    public let translate: Bool?

    public init(
        type: String,
        protocolVersion: Int? = nil,
        jobId: String? = nil,
        mediaEpoch: Int? = nil,
        mediaKey: String? = nil,
        source: MediaSource? = nil,
        currentTimeMs: Double? = nil,
        durationMs: Double? = nil,
        playbackRate: Double? = nil,
        translate: Bool? = nil
    ) {
        self.type = type
        self.protocolVersion = protocolVersion
        self.jobId = jobId
        self.mediaEpoch = mediaEpoch
        self.mediaKey = mediaKey
        self.source = source
        self.currentTimeMs = currentTimeMs
        self.durationMs = durationMs
        self.playbackRate = playbackRate
        self.translate = translate
    }
}

public struct StartRequest: Equatable, Sendable {
    public let jobId: String
    public let mediaEpoch: Int
    public let mediaKey: String
    public let sourceURL: URL
    public let headers: [String: String]
    public let currentTimeMs: Double
    public let durationMs: Double
    public let playbackRate: Double
    public let translate: Bool

    public init(
        jobId: String,
        mediaEpoch: Int,
        mediaKey: String,
        sourceURL: URL,
        headers: [String: String],
        currentTimeMs: Double,
        durationMs: Double,
        playbackRate: Double,
        translate: Bool = false
    ) {
        self.jobId = jobId
        self.mediaEpoch = mediaEpoch
        self.mediaKey = mediaKey
        self.sourceURL = sourceURL
        self.headers = headers
        self.currentTimeMs = currentTimeMs
        self.durationMs = durationMs
        self.playbackRate = playbackRate
        self.translate = translate
    }
}

public enum RequestValidationError: LocalizedError, Equatable {
    case unsupportedProtocol
    case unsupportedMedia
    case missingField(String)
    case invalidURL
    case unsafeURL

    public var errorDescription: String? {
        switch self {
        case .unsupportedProtocol:
            return "Koe Helper 与扩展版本不兼容，请更新 Helper。"
        case .unsupportedMedia:
            return "本地精准字幕目前仅支持 HLS 视频（.m3u8）。"
        case let .missingField(field):
            return "本地字幕请求缺少字段：\(field)"
        case .invalidURL:
            return "没有找到可读取的视频地址。"
        case .unsafeURL:
            return "出于安全原因，Koe Helper 不会读取本机或内网地址。"
        }
    }
}

public extension HostRequest {
    func validatedStart() throws -> StartRequest {
        guard protocolVersion == koeNativeProtocolVersion else {
            throw RequestValidationError.unsupportedProtocol
        }
        let job = String(jobId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !job.isEmpty, job.count <= 200 else {
            throw RequestValidationError.missingField("jobId")
        }
        guard let source, source.url.utf8.count <= 16_384,
              let url = URL(string: source.url),
              let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              url.user == nil,
              url.password == nil,
              url.host != nil else {
            throw RequestValidationError.invalidURL
        }
        guard MediaURLSafety.isAllowed(url) else {
            throw RequestValidationError.unsafeURL
        }
        guard url.pathExtension.lowercased() == "m3u8" else {
            throw RequestValidationError.unsupportedMedia
        }
        let safeHeaders = source.headers.reduce(into: [String: String]()) { result, entry in
            let name = entry.key.lowercased()
            guard name == "referer" || name == "origin" else { return }
            let value = entry.value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard value.utf8.count <= 4_096,
                  let headerURL = URL(string: value),
                  ["http", "https"].contains(headerURL.scheme?.lowercased() ?? "") else { return }
            result[name == "referer" ? "Referer" : "Origin"] = value
        }
        return StartRequest(
            jobId: job,
            mediaEpoch: max(0, mediaEpoch ?? 0),
            mediaKey: String(mediaKey ?? "").prefix(1_024).description,
            sourceURL: url,
            headers: safeHeaders,
            currentTimeMs: max(0, currentTimeMs ?? 0),
            durationMs: max(0, durationMs ?? 0),
            playbackRate: min(4, max(0.25, playbackRate ?? 1)),
            translate: translate ?? false
        )
    }

}

public enum MediaURLSafety {
    public static func isAllowed(_ url: URL) -> Bool {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.user == nil,
              url.password == nil,
              let rawHost = url.host?.lowercased() else { return false }
        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host == "localhost.localdomain" || host.hasSuffix(".local") {
            return false
        }
        if host == "::1" || host.hasPrefix("fe80:") || host.hasPrefix("fc") || host.hasPrefix("fd") {
            return false
        }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else {
            return true
        }
        let isPrivate = octets[0] == 10
            || octets[0] == 127
            || (octets[0] == 169 && octets[1] == 254)
            || (octets[0] == 172 && (16...31).contains(octets[1]))
            || (octets[0] == 192 && octets[1] == 168)
            || octets[0] == 0
        return !isPrivate
    }

    /// Resolve the hostname before every outbound request. Rejecting a host when
    /// any answer is non-public prevents ordinary DNS-rebinding and mixed-answer
    /// tricks from turning the native helper into a localhost/private-LAN reader.
    public static func isResolvedPublic(_ url: URL) -> Bool {
        guard isAllowed(url), let rawHost = url.host?.lowercased() else { return false }
        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if let literal = publicAddressStatus(host) { return literal }

        var hints = addrinfo(
            ai_flags: AI_ADDRCONFIG,
            ai_family: AF_UNSPEC,
            ai_socktype: SOCK_STREAM,
            ai_protocol: IPPROTO_TCP,
            ai_addrlen: 0,
            ai_canonname: nil,
            ai_addr: nil,
            ai_next: nil
        )
        var result: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, nil, &hints, &result) == 0, let first = result else { return false }
        defer { freeaddrinfo(first) }

        var sawAddress = false
        var cursor: UnsafeMutablePointer<addrinfo>? = first
        while let info = cursor?.pointee {
            defer { cursor = info.ai_next }
            guard let address = info.ai_addr else { continue }
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(
                address,
                info.ai_addrlen,
                &buffer,
                socklen_t(buffer.count),
                nil,
                0,
                NI_NUMERICHOST
            ) == 0 else { return false }
            sawAddress = true
            let addressBytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
            guard publicAddressStatus(String(decoding: addressBytes, as: UTF8.self)) == true else { return false }
        }
        return sawAddress
    }

    /// `true`/`false` for numeric IPs, `nil` for hostnames.
    private static func publicAddressStatus(_ raw: String) -> Bool? {
        var ipv4 = in_addr()
        if raw.withCString({ inet_pton(AF_INET, $0, &ipv4) }) == 1 {
            let value = UInt32(bigEndian: ipv4.s_addr)
            let first = Int((value >> 24) & 0xff)
            let second = Int((value >> 16) & 0xff)
            return !(first == 0
                || first == 10
                || first == 127
                || (first == 100 && (64...127).contains(second))
                || (first == 169 && second == 254)
                || (first == 172 && (16...31).contains(second))
                || (first == 192 && second == 168)
                || first >= 224)
        }

        var ipv6 = in6_addr()
        if raw.withCString({ inet_pton(AF_INET6, $0, &ipv6) }) == 1 {
            let bytes = withUnsafeBytes(of: &ipv6) { Array($0) }
            let allZero = bytes.allSatisfy { $0 == 0 }
            let loopback = bytes.dropLast().allSatisfy { $0 == 0 } && bytes.last == 1
            let uniqueLocal = (bytes[0] & 0xfe) == 0xfc
            let linkLocal = bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80
            let multicast = bytes[0] == 0xff
            if allZero || loopback || uniqueLocal || linkLocal || multicast { return false }
            let mappedIPv4 = bytes.prefix(10).allSatisfy { $0 == 0 }
                && bytes[10] == 0xff && bytes[11] == 0xff
            if mappedIPv4 {
                return publicAddressStatus("\(bytes[12]).\(bytes[13]).\(bytes[14]).\(bytes[15])")
            }
            return true
        }
        return nil
    }
}

public struct SubtitleCue: Codable, Equatable, Sendable {
    public let cueId: String
    public let startMs: Double
    public let endMs: Double
    public let text: String
    public let translated: String

    public init(cueId: String, startMs: Double, endMs: Double, text: String, translated: String = "") {
        self.cueId = cueId
        self.startMs = startMs
        self.endMs = endMs
        self.text = text
        self.translated = translated
    }
}

public struct HostResponse: Encodable, Sendable {
    public let type: String
    public let protocolVersion: Int?
    public let jobId: String?
    public let mediaEpoch: Int?
    public let stage: String?
    public let detail: String?
    public let revision: Int?
    public let preparedUntilMs: Double?
    public let mediaComplete: Bool?
    public let cues: [SubtitleCue]?
    public let error: String?
    public let nativeTranslation: Bool?

    public init(
        type: String,
        protocolVersion: Int? = nil,
        jobId: String? = nil,
        mediaEpoch: Int? = nil,
        stage: String? = nil,
        detail: String? = nil,
        revision: Int? = nil,
        preparedUntilMs: Double? = nil,
        mediaComplete: Bool? = nil,
        cues: [SubtitleCue]? = nil,
        error: String? = nil,
        nativeTranslation: Bool? = nil
    ) {
        self.type = type
        self.protocolVersion = protocolVersion
        self.jobId = jobId
        self.mediaEpoch = mediaEpoch
        self.stage = stage
        self.detail = detail
        self.revision = revision
        self.preparedUntilMs = preparedUntilMs
        self.mediaComplete = mediaComplete
        self.cues = cues
        self.error = error
        self.nativeTranslation = nativeTranslation
    }

    public static func ready(nativeTranslation: Bool = false) -> HostResponse {
        HostResponse(
            type: "ready",
            protocolVersion: koeNativeProtocolVersion,
            nativeTranslation: nativeTranslation
        )
    }

    public static func status(
        jobId: String,
        mediaEpoch: Int,
        stage: String,
        detail: String,
        preparedUntilMs: Double? = nil,
        mediaComplete: Bool? = nil
    ) -> HostResponse {
        HostResponse(
            type: "status",
            jobId: jobId,
            mediaEpoch: mediaEpoch,
            stage: stage,
            detail: detail,
            preparedUntilMs: preparedUntilMs,
            mediaComplete: mediaComplete
        )
    }

    public static func cues(jobId: String, mediaEpoch: Int, revision: Int, cues: [SubtitleCue]) -> HostResponse {
        HostResponse(type: "cues", jobId: jobId, mediaEpoch: mediaEpoch, revision: revision, cues: cues)
    }

    public static func failure(jobId: String?, mediaEpoch: Int?, message: String) -> HostResponse {
        HostResponse(type: "error", jobId: jobId, mediaEpoch: mediaEpoch, error: message)
    }
}
