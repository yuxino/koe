import Foundation
import KoeHelperCore

actor SessionCoordinator {
    private let writer: NativeMessageWriter
    private let resolver: HLSResolver
    private let transcriber: WhisperTranscriber
    private let preferenceStore: PreferenceStore
    private let scheduler = WindowScheduler()
    private let streamRoot: URL
    private var activeKey: SessionKey?
    private var activeTask: Task<Void, Never>?
    private var activeStream: StreamSession?
    private var streamTask: Task<Void, Never>?
    private var nextRunID = 0

    init(writer: NativeMessageWriter) throws {
        self.writer = writer
        self.resolver = try HLSResolver()
        self.transcriber = WhisperTranscriber()
        self.preferenceStore = try PreferenceStore()
        let streamRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("koe-helper-stream", isDirectory: true)
        try FileManager.default.createDirectory(at: streamRoot, withIntermediateDirectories: true)
        self.streamRoot = streamRoot
    }

    func handle(_ request: HostRequest) async {
        switch request.type {
        case "hello":
            let capable = await NativeTranslationCapability.available()
            await writer.send(.ready(nativeTranslation: capable))
        case "preferencesGet":
            await writer.send(.preferences(
                preferenceStore.load() ?? KoePreferences.normalized(KoePreferences())
            ))
        case "preferencesSet":
            guard let preferences = request.preferences else {
                await writer.send(.failure(
                    jobId: nil,
                    mediaEpoch: nil,
                    issueCode: NativeIssueCode.captureFailed.rawValue,
                    message: "Koe Helper 收到的设置不完整。"
                ))
                return
            }
            do {
                try preferenceStore.save(preferences)
                await writer.send(.preferences(KoePreferences.normalized(preferences)))
            } catch {
                await writer.send(.failure(
                    jobId: nil,
                    mediaEpoch: nil,
                    issueCode: NativeIssueCode.captureFailed.rawValue,
                    message: "Koe Helper 暂时无法保存设置。"
                ))
            }
        case "start":
            do {
                let start = try request.validatedStart()
                startSession(start)
            } catch {
                await writer.send(.failure(
                    jobId: request.jobId,
                    mediaEpoch: request.mediaEpoch,
                    issueCode: NativeIssueCode.classify(error).rawValue,
                    message: userFacing(error)
                ))
            }
        case "streamStart":
            do {
                try await startStream(request.validatedStreamStart())
            } catch {
                await writer.send(.failure(
                    jobId: request.jobId,
                    mediaEpoch: request.mediaEpoch,
                    issueCode: NativeIssueCode.classify(error).rawValue,
                    message: userFacing(error)
                ))
            }
        case "streamAudio":
            do {
                try appendStreamAudio(request.validatedStreamAudio())
            } catch {
                await writer.send(.failure(
                    jobId: request.jobId,
                    mediaEpoch: request.mediaEpoch,
                    issueCode: NativeIssueCode.classify(error).rawValue,
                    message: userFacing(error)
                ))
            }
        case "streamStop":
            cancel(jobId: request.jobId, mediaEpoch: request.mediaEpoch)
        case "cancel":
            cancel(jobId: request.jobId, mediaEpoch: request.mediaEpoch)
        default:
            await writer.send(.failure(
                jobId: request.jobId,
                mediaEpoch: request.mediaEpoch,
                issueCode: NativeIssueCode.helperIncompatible.rawValue,
                message: "Koe Helper 收到了未知请求。"
            ))
        }
    }

    func shutdown() {
        activeTask?.cancel()
        streamTask?.cancel()
        activeKey = nil
        activeStream = nil
    }

    private func startSession(_ request: StartRequest) {
        nextRunID += 1
        let key = SessionKey(
            jobId: request.jobId,
            mediaEpoch: request.mediaEpoch,
            runID: nextRunID
        )
        activeTask?.cancel()
        streamTask?.cancel()
        activeStream = nil
        activeKey = key
        let next = Task { [weak self] in
            guard let self else { return }
            await self.run(request, key: key)
        }
        activeTask = next
    }

    private func cancel(jobId: String?, mediaEpoch: Int?) {
        if let activeStream,
           activeStream.key.jobId == String(jobId ?? ""),
           activeStream.key.mediaEpoch == max(0, mediaEpoch ?? 0) {
            streamTask?.cancel()
            streamTask = nil
            self.activeStream = nil
        }
        guard let activeKey,
              activeKey.jobId == String(jobId ?? ""),
              activeKey.mediaEpoch == max(0, mediaEpoch ?? 0) else { return }
        activeTask?.cancel()
        self.activeKey = nil
    }

    private func startStream(_ request: StreamStartRequest) async throws {
        nextRunID += 1
        let key = SessionKey(
            jobId: request.jobId,
            mediaEpoch: request.mediaEpoch,
            runID: nextRunID
        )
        activeTask?.cancel()
        activeTask = nil
        activeKey = nil
        streamTask?.cancel()
        streamTask = nil
        activeStream = StreamSession(
            key: key,
            mediaKey: request.mediaKey.isEmpty
                ? "\(request.jobId)#\(request.mediaEpoch)"
                : request.mediaKey,
            translate: request.translate,
            buffer: try PCMStreamBuffer(
                sampleRate: request.sampleRate,
                channels: request.channels
            )
        )
        await writer.send(.status(
            jobId: key.jobId,
            mediaEpoch: key.mediaEpoch,
            stage: "stream-listening",
            detail: "正在本机听取这段视频，第一句马上出现…"
        ))
    }

    private func appendStreamAudio(_ request: StreamAudioRequest) throws {
        guard var stream = activeStream,
              stream.key.jobId == request.jobId,
              stream.key.mediaEpoch == request.mediaEpoch else { return }
        try stream.buffer.append(request.pcm)
        activeStream = stream
        startNextStreamWindowIfNeeded()
    }

    private func startNextStreamWindowIfNeeded() {
        guard streamTask == nil,
              var stream = activeStream,
              let window = stream.buffer.takeWindow() else { return }
        activeStream = stream
        let key = stream.key
        streamTask = Task { [weak self] in
            guard let self else { return }
            await self.processStreamWindow(window, key: key)
        }
    }

    private func processStreamWindow(_ window: PCMStreamWindow, key: SessionKey) async {
        let audioURL = streamRoot.appendingPathComponent("\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: audioURL) }
        do {
            try ensureStreamActive(key)
            let wav = try PCM16WAV.encode(pcm: window.pcm, sampleRate: 16_000, channels: 1)
            try wav.write(to: audioURL, options: .atomic)
            await writer.send(.status(
                jobId: key.jobId,
                mediaEpoch: key.mediaEpoch,
                stage: "stream-model",
                detail: "正在用本地高精度模型识别…"
            ))
            try await transcriber.prepare()
            try ensureStreamActive(key)
            guard let mediaKey = activeStream?.mediaKey else { throw CancellationError() }
            let raw = try await transcriber.transcribe(audioURL: audioURL, mediaKey: mediaKey)
            try ensureStreamActive(key)
            guard var stream = activeStream else { throw CancellationError() }
            let additions = stream.accumulator.merge(
                rawCues: raw,
                window: MediaWindow(
                    startMs: window.startMs,
                    endMs: window.endMs,
                    emitAfterMs: window.emitAfterMs
                ),
                durationMs: window.endMs
            )
            let revision = stream.accumulator.revision
            activeStream = stream
            if !additions.isEmpty {
                await writer.send(.streamCues(
                    jobId: key.jobId,
                    mediaEpoch: key.mediaEpoch,
                    revision: revision,
                    cues: additions
                ))
                if stream.translate {
                    let language = await transcriber.currentLanguage()
                    await emitStreamTranslations(
                        for: additions,
                        key: key,
                        sourceLanguage: language
                    )
                }
            }
            try ensureStreamActive(key)
            await writer.send(.status(
                jobId: key.jobId,
                mediaEpoch: key.mediaEpoch,
                stage: "stream-live",
                detail: "本地实时字幕运行中"
            ))
        } catch is CancellationError {
            return
        } catch {
            guard activeStream?.key == key else { return }
            NativeMessageWriter.log("stream-failed \(safeLogCode(error))")
            await writer.send(.failure(
                jobId: key.jobId,
                mediaEpoch: key.mediaEpoch,
                issueCode: NativeIssueCode.classify(error).rawValue,
                message: userFacing(error)
            ))
            activeStream = nil
        }
        if activeStream?.key == key {
            streamTask = nil
            startNextStreamWindowIfNeeded()
        } else if streamTask?.isCancelled == true {
            streamTask = nil
        }
    }

    private func emitStreamTranslations(
        for cues: [SubtitleCue],
        key: SessionKey,
        sourceLanguage: String?
    ) async {
        guard #available(macOS 26.0, *) else { return }
        let translator = LocalTranslator.shared
        var updated: [SubtitleCue] = []
        for cue in cues {
            guard activeStream?.key == key else { return }
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
        guard !updated.isEmpty, var stream = activeStream, stream.key == key else { return }
        stream.revision = max(stream.revision, stream.accumulator.revision) + 1
        activeStream = stream
        await writer.send(.streamCues(
            jobId: key.jobId,
            mediaEpoch: key.mediaEpoch,
            revision: stream.revision,
            cues: updated
        ))
    }

    private func ensureStreamActive(_ key: SessionKey) throws {
        try Task.checkCancellation()
        guard activeStream?.key == key else { throw CancellationError() }
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
                issueCode: NativeIssueCode.classify(error).rawValue,
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
        if let localized = error as? PCMStreamError,
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

private struct StreamSession {
    let key: SessionKey
    let mediaKey: String
    let translate: Bool
    var buffer: PCMStreamBuffer
    var accumulator = CueAccumulator()
    var revision = 0
}
