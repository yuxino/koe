import Foundation
import KoeHelperCore
import Darwin

enum NativeMessagingError: LocalizedError {
    case truncatedFrame
    case frameTooLarge(Int)

    var errorDescription: String? {
        switch self {
        case .truncatedFrame:
            return "Native Messaging 消息不完整。"
        case let .frameTooLarge(size):
            return "Native Messaging 消息过大（\(size) bytes）。"
        }
    }
}

final class NativeMessageReader {
    private let input: FileHandle
    private let maximumBytes = 1_048_576

    init(input: FileHandle = .standardInput) {
        self.input = input
    }

    func next() throws -> HostRequest? {
        guard let header = try readExactly(4) else { return nil }
        let length = header.withUnsafeBytes { bytes -> UInt32 in
            bytes.loadUnaligned(as: UInt32.self).littleEndian
        }
        guard length <= maximumBytes else { throw NativeMessagingError.frameTooLarge(Int(length)) }
        guard let payload = try readExactly(Int(length)) else { throw NativeMessagingError.truncatedFrame }
        return try JSONDecoder().decode(HostRequest.self, from: payload)
    }

    private func readExactly(_ count: Int) throws -> Data? {
        if count == 0 { return Data() }
        var result = Data()
        while result.count < count {
            let chunk = try input.read(upToCount: count - result.count) ?? Data()
            if chunk.isEmpty {
                if result.isEmpty { return nil }
                throw NativeMessagingError.truncatedFrame
            }
            result.append(chunk)
        }
        return result
    }
}

actor NativeMessageWriter {
    private let output: FileHandle
    private let encoder: JSONEncoder

    init(output: FileHandle = .standardOutput) {
        self.output = output
        self.encoder = JSONEncoder()
    }

    func send(_ response: HostResponse) {
        do {
            let payload = try encoder.encode(response)
            guard payload.count <= 1_048_576 else { return }
            var length = UInt32(payload.count).littleEndian
            var frame = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
            frame.append(payload)
            try output.write(contentsOf: frame)
        } catch {
            Self.log("native-write-failed \(error.localizedDescription)")
        }
    }

    nonisolated static func log(_ message: String) {
        let line = "[koe-helper] \(message)\n"
        FileHandle.standardError.write(Data(line.utf8))
    }
}

enum NativeStandardIO {
    static func isolateProtocolOutput() throws -> FileHandle {
        let protocolDescriptor = dup(STDOUT_FILENO)
        guard protocolDescriptor >= 0 else { throw POSIXError(.EBADF) }
        guard dup2(STDERR_FILENO, STDOUT_FILENO) >= 0 else {
            close(protocolDescriptor)
            throw POSIXError(.EBADF)
        }
        return FileHandle(fileDescriptor: protocolDescriptor, closeOnDealloc: true)
    }
}
