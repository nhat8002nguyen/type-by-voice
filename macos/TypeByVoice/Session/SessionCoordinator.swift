import Foundation

@MainActor
final class SessionCoordinator {
    private(set) var state: SessionState = .idle
    private(set) var lastError: SessionError?
    private(set) var lastQuota: QuotaSnapshot?
    var onStateChange: ((SessionState) -> Void)?
    var onQuotaChange: ((QuotaSnapshot) -> Void)?

    var isListeningUI: Bool { state == .recording }

    private let engine: TranscriptionEngine
    private let inserter: TextInserter
    private let clock: Clock
    private let audioCapture: AudioCaptureStarting
    private let identity: ClientIdentity
    private let timeouts: SessionTimeouts
    private var encoder: OpusEncoder
    private var silenceDetector: SilenceDetector

    private var hasMicFrames = false
    private var hasReady = false
    private var preReadyAudio: [Data] = []
    private var heldSilencePages: [(data: Data, durationMs: Int)] = []
    private var connectingStartedAt: Date?
    private var recordingStartedAt: Date?
    private var transcribingStartedAt: Date?
    private var insertingStartedAt: Date?
    private var eventLoopStarted = false
    private var effectiveRecordingHardCap: TimeInterval

    private static let sampleRate = 16_000

    init(
        engine: TranscriptionEngine,
        inserter: TextInserter,
        clock: Clock = Clock(),
        audioCapture: AudioCaptureStarting = FakeAudioCapture(),
        identity: ClientIdentity = .preview,
        timeouts: SessionTimeouts = SessionTimeouts(),
        encoder: OpusEncoder = OpusEncoder()
    ) {
        self.engine = engine
        self.inserter = inserter
        self.clock = clock
        self.audioCapture = audioCapture
        self.identity = identity
        self.timeouts = timeouts
        self.encoder = encoder
        self.effectiveRecordingHardCap = timeouts.recordingHardCap
        self.silenceDetector = SilenceDetector(
            silenceDurationMs: timeouts.silenceDurationMs,
            noSpeechTimeoutMs: timeouts.noSpeechTimeoutMs
        )

        engine.setEventHandler { [weak self] event in
            self?.handleEngineEvent(event)
        }
    }

    func hotkeyPressed() {
        switch state {
        case .idle:
            beginConnecting()
        case .connecting:
            cancelSession()
        case .recording:
            requestStopFromRecording()
        case .transcribing, .inserting:
            break
        }
    }

    func escapePressed() {
        switch state {
        case .connecting, .recording:
            cancelSession()
        case .idle, .transcribing, .inserting:
            break
        }
    }

    func micFrame(samples: [Float]) {
        guard state == .connecting || state == .recording else { return }

        hasMicFrames = true

        if state == .recording {
            handleSilenceEvents(silenceDetector.process(samples: samples, sampleRate: Self.sampleRate))
            guard state == .recording else { return }
        }

        let pages = encoder.encode(samples: samples)
        let isSilent = !silenceDetector.isSpeech(samples)
        let frameDurationMs = samples.isEmpty
            ? 0
            : max(1, samples.count * 1_000 / Self.sampleRate)

        for page in pages where !page.isEmpty {
            if state == .recording {
                enqueueEncodedPage(page, isSilent: isSilent, durationMs: frameDurationMs / max(pages.count, 1))
            } else {
                preReadyAudio.append(page)
            }
        }
        promoteToRecordingIfNeeded()
    }

    func tick(now: Date) {
        switch state {
        case .connecting:
            if let started = connectingStartedAt,
               now.timeIntervalSince(started) >= timeouts.connecting {
                failToIdle(code: "session_timeout", message: "Connecting timed out", retryable: true)
            }
        case .recording:
            if let started = recordingStartedAt,
               now.timeIntervalSince(started) >= effectiveRecordingHardCap {
                beginTranscribing()
            }
        case .transcribing:
            if let started = transcribingStartedAt,
               now.timeIntervalSince(started) >= timeouts.transcribing {
                failToIdle(code: "session_timeout", message: "Transcription timed out", retryable: true)
            }
        case .inserting:
            if let started = insertingStartedAt,
               now.timeIntervalSince(started) >= timeouts.inserting {
                failToIdle(code: "session_timeout", message: "Insert timed out", retryable: true)
            }
        case .idle:
            break
        }
    }

    private func beginConnecting() {
        lastError = nil
        hasMicFrames = false
        hasReady = false
        preReadyAudio = []
        heldSilencePages = []
        connectingStartedAt = clock.now
        recordingStartedAt = nil
        transcribingStartedAt = nil
        insertingStartedAt = nil
        effectiveRecordingHardCap = timeouts.recordingHardCap
        silenceDetector.reset()
        encoder.reset()
        audioCapture.startCapture()
        transition(to: .connecting)
        startEventLoopIfNeeded()

        let requestId = UUID()
        let clientIdentity = identity
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await self.engine.start(requestId: requestId, identity: clientIdentity)
            } catch {
                self.failToIdle(
                    code: "engine_start_failed",
                    message: error.localizedDescription,
                    retryable: true
                )
            }
        }
    }

    private func promoteToRecordingIfNeeded() {
        guard state == .connecting, hasMicFrames, hasReady else { return }
        recordingStartedAt = clock.now
        silenceDetector.reset()
        transition(to: .recording)
        flushPreReadyAudio()
    }

    private func flushPreReadyAudio() {
        let chunks = preReadyAudio
        preReadyAudio = []
        for chunk in chunks {
            transmitAudio(chunk)
        }
    }

    private func enqueueEncodedPage(_ data: Data, isSilent: Bool, durationMs: Int) {
        if isSilent {
            heldSilencePages.append((data, max(durationMs, 1)))
            return
        }
        flushHeldSilence(trimmingTrailing: false)
        transmitAudio(data)
    }

    private func flushHeldSilence(trimmingTrailing: Bool) {
        let pages: [(data: Data, durationMs: Int)]
        if trimmingTrailing {
            pages = trimmedTrailingHangover(from: heldSilencePages)
        } else {
            pages = heldSilencePages
        }
        heldSilencePages = []
        for page in pages {
            transmitAudio(page.data)
        }
    }

    private func trimmedTrailingHangover(
        from pages: [(data: Data, durationMs: Int)]
    ) -> [(data: Data, durationMs: Int)] {
        var kept: [(data: Data, durationMs: Int)] = []
        var keptMs = 0
        for page in pages {
            if keptMs >= timeouts.trailingHangoverMs { break }
            kept.append(page)
            keptMs += page.durationMs
        }
        return kept
    }

    private func transmitAudio(_ data: Data) {
        engine.sendAudioNow(data)
    }

    private func handleSilenceEvents(_ event: SilenceDetector.Event?) {
        guard let event else { return }
        switch event {
        case .speechStarted:
            break
        case .silenceReached:
            requestStopFromRecording()
        case .noSpeech:
            cancelSession()
        }
    }

    private func requestStopFromRecording() {
        guard state == .recording else { return }
        let durationMs = recordingDurationMs()
        if durationMs < timeouts.minDurationMs {
            cancelSession()
            return
        }
        beginTranscribing()
    }

    private func recordingDurationMs() -> Int {
        guard let started = recordingStartedAt else { return 0 }
        return Int((clock.now.timeIntervalSince(started) * 1_000).rounded())
    }

    private func beginTranscribing() {
        guard state == .recording else { return }
        audioCapture.stopCapture()
        flushHeldSilence(trimmingTrailing: true)
        let eos = encoder.finish()
        if !eos.isEmpty {
            transmitAudio(eos)
        }
        let durationMs = recordingDurationMs()
        transcribingStartedAt = clock.now
        transition(to: .transcribing)
        engine.keepWarm(until: clock.now.addingTimeInterval(timeouts.warmSocketSeconds))
        Task { @MainActor [weak self] in
            await self?.engine.stop(durationMs: durationMs)
        }
    }

    private func cancelSession() {
        audioCapture.stopCapture()
        preReadyAudio = []
        heldSilencePages = []
        hasMicFrames = false
        hasReady = false
        connectingStartedAt = nil
        recordingStartedAt = nil
        transcribingStartedAt = nil
        insertingStartedAt = nil
        Task { @MainActor [weak self] in
            await self?.engine.cancel()
        }
        transition(to: .idle)
    }

    private func failToIdle(code: String, message: String, retryable: Bool) {
        lastError = SessionError(code: code, message: message, retryable: retryable)
        audioCapture.stopCapture()
        preReadyAudio = []
        heldSilencePages = []
        hasMicFrames = false
        hasReady = false
        connectingStartedAt = nil
        recordingStartedAt = nil
        transcribingStartedAt = nil
        insertingStartedAt = nil
        Task { @MainActor [weak self] in
            await self?.engine.cancel()
        }
        transition(to: .idle)
    }

    private func handleEngineEvent(_ event: EngineEvent) {
        switch event {
        case let .ready(maxDurationMs, quota):
            publishQuota(quota)
            guard state == .connecting else { return }
            let serverCap = TimeInterval(maxDurationMs) / 1_000
            effectiveRecordingHardCap = min(timeouts.recordingHardCap, serverCap)
            hasReady = true
            promoteToRecordingIfNeeded()
        case let .final(text, _, _, quota):
            publishQuota(quota)
            guard state == .transcribing else { return }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                transition(to: .idle)
                return
            }
            insertingStartedAt = clock.now
            transition(to: .inserting)
            Task { @MainActor [weak self] in
                guard let self else { return }
                await self.inserter.insert(trimmed)
                if self.state == .inserting {
                    self.transition(to: .idle)
                }
            }
        case let .error(code, message, retryable, _):
            failToIdle(code: code, message: message, retryable: retryable)
        }
    }

    private func publishQuota(_ quota: QuotaSnapshot) {
        lastQuota = quota
        onQuotaChange?(quota)
    }

    private func startEventLoopIfNeeded() {
        guard !engine.deliversEventsSynchronously, !eventLoopStarted else { return }
        eventLoopStarted = true
        let stream = engine.events
        Task { @MainActor [weak self] in
            for await event in stream {
                self?.handleEngineEvent(event)
            }
        }
    }

    private func transition(to newState: SessionState) {
        state = newState
        onStateChange?(newState)
    }
}
