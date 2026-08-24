import Foundation
import KoeHelperCore

actor SessionCoordinator {
    private let writer: NativeMessageWriter
    private let resolver: HLSResolver
    private let transcriber: WhisperTranscriber
    private let scheduler = WindowScheduler()
    private var activeKey: SessionKey?
    private var activeTask: Task<Void, Never>?
    private var nextRunID = 0

    init(writer: NativeMessageWriter) throws {
        self.writer = writer
        self.resolver = try HLSResolver()
        self.transcriber = WhisperTranscriber()
    }

    func handle(_ request: HostRequest) async {
        switch request.type {
        case "hello":
            let capable = await NativeTranslationCapability.available()
            await writer.send(.ready(nativeTranslation: capable))
        case "start":
            do {
                let start = try request.validatedStart()
                startSession(start)
            } catch {
                await writer.send(.failure(
                    jobId: request.jobId,
                    mediaEpoch: request.mediaEpoch,
                    message: userFacing(error)
                ))
            }
        case "cancel":
            cancel(jobId: request.jobId, mediaEpoch: request.mediaEpoch)
        default:
            await writer.send(.failure(
                jobId: request.jobId,
                mediaEpoch: request.mediaEpoch,
                message: "Koe Helper 收到了未知请求。"
            ))
        }
    }

    func shutdown() {
        activeTask?.cancel()
        activeKey = nil
    }

    private func startSession(_ request: StartRequest) {
        nextRunID += 1
        let key = SessionKey(
            jobId: request.jobId,
            mediaEpoch: request.mediaEpoch,
            runID: nextRunID
        )
        activeTask?.cancel()
        activeKey = key
        let next = Task { [weak self] in
            guard let self else { return }
            await self.run(request, key: key)
        }
        activeTask = next
    }

    private func cancel(jobId: String?, mediaEpoch: Int?) {
        guard let activeKey,
              activeKey.jobId == String(jobId ?? ""),
              activeKey.mediaEpoch == max(0, mediaEpoch ?? 0) else { return }
        activeTask?.cancel()
        self.activeKey = nil
    }

    private func run(_ request: StartRequest, key: SessionKey) async {
        do {
            try ensureActive(key)
            await writer.send(.status(
                jobId: key.jobId,
                mediaEpoch: key.mediaEpoch,
                stage: "resolving",
                detail: "正在本机读取当前位置附近的音轨…"
            ))

            async let modelPreparation: Void = transcriber.prepare()
            let playlist = try await resolver.load(request.sourceURL, headers: request.headers)
            let measuredDuration = playlist.durationMs
            try ensureActive(key)

            let durationMs = request.durationMs > 0
                ? min(request.durationMs, measuredDuration + 1_000)
                : measuredDuration
            let windows = scheduler.windows(currentTimeMs: request.currentTimeMs, durationMs: durationMs)
            guard !windows.isEmpty else { throw HLSResolverError.emptyPlaylist }

            async let bootstrapAudioPreparation: ExtractedAudio = makeAudio(
                headers: request.headers,
                playlist: playlist,
                window: windows[0]
            )
            let bootstrapAudio = try await bootstrapAudioPreparation
            defer { try? FileManager.default.removeItem(at: bootstrapAudio.fileURL) }
            try ensureActive(key)
            await writer.send(.status(
                jobId: key.jobId,
                mediaEpoch: key.mediaEpoch,
                stage: "media-ready",
                detail: "当前位置音轨已在本机准备好"
            ))

            await writer.send(.status(
                jobId: key.jobId,
                mediaEpoch: key.mediaEpoch,
                stage: "model",
                detail: "正在准备本地高精度模型（首次需要下载）…"
            ))
            try await modelPreparation
            try ensureActive(key)

            var accumulator = CueAccumulator()
            var cueRevision = 0
            let languageMediaKey = request.mediaKey.isEmpty
                ? "\(request.jobId)#\(request.mediaEpoch)"
                : request.mediaKey
            for (index, window) in windows.enumerated() {
                try ensureActive(key)
                await writer.send(.status(
                    jobId: key.jobId,
                    mediaEpoch: key.mediaEpoch,
                    stage: index == 0 ? "bootstrap" : "forward",
                    detail: index == 0
                        ? "正在识别当前位置，字幕马上出现…"
                        : "已就绪，正在提前准备后续字幕…"
                ))
                let audio = index == 0
                    ? bootstrapAudio
                    : try await makeAudio(
                        headers: request.headers,
                        playlist: playlist,
                        window: window
                    )
                let raw: [RawCue]
                do {
                    raw = try await transcriber.transcribe(
                        audioURL: audio.fileURL,
                        mediaKey: languageMediaKey
                    )
                } catch {
                    await removeAudio(audio.fileURL)
                    throw error
                }
                await removeAudio(audio.fileURL)
                try ensureActive(key)
                let decodedWindow = MediaWindow(
                    startMs: audio.startMs,
                    endMs: audio.endMs,
                    emitAfterMs: window.emitAfterMs
                )
                let additions = accumulator.merge(rawCues: raw, window: decodedWindow, durationMs: durationMs)
                if !additions.isEmpty {
                    try ensureActive(key)
                    cueRevision += 1
                    await writer.send(.cues(
                        jobId: key.jobId,
                        mediaEpoch: key.mediaEpoch,
                        revision: cueRevision,
                        cues: additions
                    ))
                    if request.translate {
                        let sourceLanguage = await transcriber.currentLanguage()
                        await emitTranslations(
                            for: additions,
                            key: key,
                            sourceLanguage: sourceLanguage,
                            revision: &cueRevision
                        )
                    }
                }
            }
            try ensureActive(key)
            let preparedUntilMs = windows.last?.endMs ?? request.currentTimeMs
            let reachedMediaEnd = preparedUntilMs >= durationMs - 250
            await writer.send(.status(
                jobId: key.jobId,
                mediaEpoch: key.mediaEpoch,
                stage: "ready",
                detail: reachedMediaEnd
                    ? "本地精准字幕已准备完成"
                    : "后续字幕已提前准备，播放时会自动续接",
                preparedUntilMs: preparedUntilMs,
                mediaComplete: reachedMediaEnd
            ))
        } catch is CancellationError {
            return
        } catch {
            guard activeKey == key else { return }
            NativeMessageWriter.log("session-failed \(safeLogCode(error))")
            await writer.send(.failure(
                jobId: key.jobId,
                mediaEpoch: key.mediaEpoch,
                message: userFacing(error)
            ))
        }
        if activeKey == key { activeTask = nil }
    }

    private func makeAudio(
        headers: [String: String],
        playlist: HLSMediaPlaylist,
        window: MediaWindow
    ) async throws -> ExtractedAudio {
        let assembled = try await resolver.assemble(playlist: playlist, window: window, headers: headers)
        return ExtractedAudio(
            fileURL: assembled.fileURL,
            startMs: assembled.mediaStartMs,
            endMs: assembled.mediaEndMs
        )
    }

    /// Translate a batch of just-emitted cues to Simplified Chinese and send a
    /// follow-up `.cues` revision carrying the same cueIds with `translated`
    /// filled. The host merges revisions by cueId and re-renders the visible
    /// line, so the original appears immediately and the translation fills in
    /// when ready. Fails silently (keeps original) when translation is
    /// unavailable on this host.
    private func emitTranslations(
        for cues: [SubtitleCue],
        key: SessionKey,
        sourceLanguage: String?,
        revision: inout Int
    ) async {
        guard #available(macOS 26.0, *) else { return }
        let translator = LocalTranslator.shared
        var updated: [SubtitleCue] = []
        for cue in cues {
            guard let translated = await translator.translate(
                cue.text,
                sourceLanguageHint: sourceLanguage
            ) else { continue }
            updated.append(SubtitleCue(
                cueId: cue.cueId,
                startMs: cue.startMs,
                endMs: cue.endMs,
                text: cue.text,
                translated: translated
            ))
        }
        guard !updated.isEmpty, activeKey == key else { return }
        do { try Task.checkCancellation() } catch { return }
        guard activeKey == key else { return }
        revision += 1
        await writer.send(.cues(
            jobId: key.jobId,
            mediaEpoch: key.mediaEpoch,
            revision: revision,
            cues: updated
        ))
    }

    private func ensureActive(_ key: SessionKey) throws {
        try Task.checkCancellation()
        guard activeKey == key else { throw CancellationError() }
    }

    private func removeAudio(_ fileURL: URL) async {
        await resolver.remove(fileURL)
    }

    private func safeLogCode(_ error: Error) -> String {
        if let urlError = error as? URLError {
            return "url-\(urlError.code.rawValue)"
        }
        if error is HLSResolverError { return "hls" }
        if error is CancellationError { return "cancelled" }
        return "local-processing"
    }

    private func userFacing(_ error: Error) -> String {
        if let localized = error as? HLSResolverError,
           let description = localized.errorDescription,
           !description.isEmpty {
            return description
        }
        if let localized = error as? RequestValidationError,
           let description = localized.errorDescription,
           !description.isEmpty {
            return description
        }
        if let urlError = error as? URLError {
            return urlError.code == .timedOut
                ? "视频服务器读取超时，请重试。"
                : "暂时无法读取视频音轨，请重试。"
        }
        return "本地字幕处理失败，请重试。"
    }
}

private struct SessionKey: Equatable, Sendable {
    let jobId: String
    let mediaEpoch: Int
    /// Refill batches intentionally reuse the public job/epoch. Keep an
    /// internal identity so a cancelled older task cannot clear or report for
    /// the newer batch that replaced it.
    let runID: Int
}

private struct ExtractedAudio {
    let fileURL: URL
    let startMs: Double
    let endMs: Double
}
