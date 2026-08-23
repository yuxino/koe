import Foundation
import KoeHelperCore

@main
struct KoeHelperMain {
    static func main() async {
        let reader = NativeMessageReader()
        let protocolOutput: FileHandle
        do {
            protocolOutput = try NativeStandardIO.isolateProtocolOutput()
        } catch {
            return
        }
        let writer = NativeMessageWriter(output: protocolOutput)
        let coordinator: SessionCoordinator
        do {
            coordinator = try SessionCoordinator(writer: writer)
        } catch {
            await writer.send(.failure(jobId: nil, mediaEpoch: nil, message: "无法初始化本地字幕工作目录。"))
            return
        }

        await writer.send(.ready(nativeTranslation: await NativeTranslationCapability.available()))
        do {
            while let request = try reader.next() {
                await coordinator.handle(request)
            }
        } catch {
            NativeMessageWriter.log("native-read-failed \(error.localizedDescription)")
        }
        await coordinator.shutdown()
    }
}
