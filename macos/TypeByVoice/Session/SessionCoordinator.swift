import Foundation

@MainActor
final class SessionCoordinator {
    private(set) var state: SessionState = .idle
    private(set) var lastError: SessionError?
    var onStateChange: ((SessionState) -> Void)?

    var isListeningUI: Bool { state == .recording }

    private let engine: TranscriptionEngine
    private let inserter: TextInserter
    private let clock: Clock
    private let audioCapture: AudioCaptureStarting
    private let identity: ClientIdentity
    private let timeouts: SessionTimeouts
    private var encoder: OpusEncoder

    private var hasMicFrames = false
    private var hasReady = false
    private var preReadyAudio: [Data] = []
    private var connectingStartedAt: Date?
    private var recordingStartedAt: Date?
    private var transcribingStartedAt: Date?
    private var insertingStartedAt: Date?
    private var eventLoopStarted = false

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
            beginTranscribing()
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
        let pages = encoder.encode(samples: samples)
        for page in pages where !page.isEmpty {
            if state == .recording {
                transmitAudio(page)
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
                failToIdle(code: "session_timeout", message: "Connecting timed out")
            }
        case .recording:
            if let started = recordingStartedAt,
               now.timeIntervalSince(started) >= timeouts.recordingHardCap {
                beginTranscribing()
            }
        case .transcribing:
            if let started = transcribingStartedAt,
               now.timeIntervalSince(started) >= timeouts.transcribing {
                failToIdle(code: "session_timeout", message: "Transcription timed out")
            }
        case .inserting:
            if let started = insertingStartedAt,
               now.timeIntervalSince(started) >= timeouts.inserting {
                failToIdle(code: "session_timeout", message: "Insert timed out")
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
        connectingStartedAt = clock.now
        recordingStartedAt = nil
        transcribingStartedAt = nil
        insertingStartedAt = nil
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
                self.failToIdle(code: "engine_start_failed", message: error.localizedDescription)
            }
        }
    }

    private func promoteToRecordingIfNeeded() {
        guard state == .connecting, hasMicFrames, hasReady else { return }
        recordingStartedAt = clock.now
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

    private func transmitAudio(_ data: Data) {
        engine.sendAudioNow(data)
    }

    private func beginTranscribing() {
        guard state == .recording else { return }
        audioCapture.stopCapture()
        let durationMs: Int
        if let started = recordingStartedAt {
            durationMs = Int(clock.now.timeIntervalSince(started) * 1_000)
        } else {
            durationMs = 0
        }
        transcribingStartedAt = clock.now
        transition(to: .transcribing)
        Task { @MainActor [weak self] in
            await self?.engine.stop(durationMs: durationMs)
        }
    }

    private func cancelSession() {
        audioCapture.stopCapture()
        preReadyAudio = []
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

    private func failToIdle(code: String, message: String) {
        lastError = SessionError(code: code, message: message)
        audioCapture.stopCapture()
        preReadyAudio = []
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
        case .ready:
            guard state == .connecting else { return }
            hasReady = true
            promoteToRecordingIfNeeded()
        case let .final(text, _, _, _):
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
        case let .error(code, message, _, _):
            failToIdle(code: code, message: message)
        }
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
