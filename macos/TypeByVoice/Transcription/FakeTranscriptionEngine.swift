import Foundation

@MainActor
final class FakeTranscriptionEngine: TranscriptionEngine {
    private(set) var flushedBytes = 0
    private(set) var startCalled = false
    private(set) var startCallCount = 0
    private(set) var stopCalled = false
    private(set) var cancelCalled = false
    private(set) var warmUntil: Date?
    private(set) var lastRequestId: UUID?
    private(set) var lastIdentity: ClientIdentity?
    private(set) var accessToken = ""

    let deliversEventsSynchronously = true

    private var eventHandler: (@MainActor (EngineEvent) -> Void)?
    private var eventsContinuation: AsyncStream<EngineEvent>.Continuation?

    lazy var events: AsyncStream<EngineEvent> = {
        AsyncStream { continuation in
            self.eventsContinuation = continuation
        }
    }()

    func setEventHandler(_ handler: (@MainActor (EngineEvent) -> Void)?) {
        eventHandler = handler
    }

    func updateAccessToken(_ token: String) {
        accessToken = token
    }

    func start(requestId: UUID, identity: ClientIdentity) async throws {
        startCalled = true
        startCallCount += 1
        lastRequestId = requestId
        lastIdentity = identity
        flushedBytes = 0
    }

    func sendAudio(_ data: Data) async {
        sendAudioNow(data)
    }

    func sendAudioNow(_ data: Data) {
        flushedBytes += data.count
    }

    func stop(durationMs: Int) async {
        stopCalled = true
        _ = durationMs
    }

    func cancel() async {
        cancelCalled = true
    }

    func keepWarm(until: Date) {
        warmUntil = until
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
        deliver(.ready(maxDurationMs: maxDurationMs, quota: quota))
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
        deliver(.final(text: text, wordCount: words, audioMs: audioMs, quota: quota))
    }

    func emitError(
        code: String,
        message: String,
        retryable: Bool = false,
        details: [String: String] = [:]
    ) {
        deliver(.error(code: code, message: message, retryable: retryable, details: details))
    }

    private func deliver(_ event: EngineEvent) {
        eventHandler?(event)
        eventsContinuation?.yield(event)
    }
}
