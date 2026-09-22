import Foundation

@MainActor
final class FakeTranscriptionEngine: TranscriptionEngine {
    private(set) var flushedBytes = 0
    private(set) var startCalled = false
    private(set) var stopCalled = false
    private(set) var cancelCalled = false
    private(set) var lastRequestId: UUID?
    private(set) var lastIdentity: ClientIdentity?

    var synchronousEventSink: ((EngineEvent) -> Void)?

    private var isReady = false
    private var preReadyBytes: [Data] = []
    private var eventsContinuation: AsyncStream<EngineEvent>.Continuation?

    lazy var events: AsyncStream<EngineEvent> = {
        AsyncStream { continuation in
            self.eventsContinuation = continuation
        }
    }()

    func start(requestId: UUID, identity: ClientIdentity) async throws {
        startCalled = true
        lastRequestId = requestId
        lastIdentity = identity
        isReady = false
        flushedBytes = 0
        preReadyBytes = []
    }

    func sendAudio(_ data: Data) async {
        applySendAudio(data)
    }

    func applySendAudio(_ data: Data) {
        if isReady {
            flushedBytes += data.count
        } else {
            preReadyBytes.append(data)
        }
    }

    func stop(durationMs: Int) async {
        stopCalled = true
        _ = durationMs
    }

    func cancel() async {
        cancelCalled = true
        isReady = false
        preReadyBytes = []
    }

    func emitReady(
        maxDurationMs: Int = 120_000,
        quota: QuotaSnapshot = QuotaSnapshot(
            unit: "seconds",
            limit: 3_600,
            used: 0,
            resetAt: Date(timeIntervalSince1970: 0)
        )
    ) {
        isReady = true
        let event = EngineEvent.ready(maxDurationMs: maxDurationMs, quota: quota)
        synchronousEventSink?(event)
        eventsContinuation?.yield(event)
    }

    func emitFinal(
        text: String,
        wordCount: Int? = nil,
        audioMs: Int = 0,
        quota: QuotaSnapshot = QuotaSnapshot(
            unit: "seconds",
            limit: 3_600,
            used: 0,
            resetAt: Date(timeIntervalSince1970: 0)
        )
    ) {
        let words = wordCount ?? text.split { $0.isWhitespace || $0.isNewline }.count
        let event = EngineEvent.final(text: text, wordCount: words, audioMs: audioMs, quota: quota)
        synchronousEventSink?(event)
        eventsContinuation?.yield(event)
    }

    func emitError(
        code: String,
        message: String,
        retryable: Bool = false,
        details: [String: String] = [:]
    ) {
        let event = EngineEvent.error(code: code, message: message, retryable: retryable, details: details)
        synchronousEventSink?(event)
        eventsContinuation?.yield(event)
    }
}
