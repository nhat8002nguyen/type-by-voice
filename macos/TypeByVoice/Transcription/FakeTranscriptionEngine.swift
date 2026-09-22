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
    private(set) var isSocketOpen = false
    private(set) var lastStartReusedWarmSocket = false
    private(set) var warmCloseCount = 0

    let deliversEventsSynchronously = true

    private var eventHandler: (@MainActor (EngineEvent) -> Void)?
    private var warmCloseTask: Task<Void, Never>?

    var events: AsyncStream<EngineEvent> {
        AsyncStream { _ in }
    }

    func setEventHandler(_ handler: (@MainActor (EngineEvent) -> Void)?) {
        eventHandler = handler
    }

    func updateAccessToken(_ token: String) {
        accessToken = token
    }

    func start(requestId: UUID, identity: ClientIdentity) async throws {
        warmCloseTask?.cancel()
        warmCloseTask = nil

        let reuse = canReuseWarmSocket()
        lastStartReusedWarmSocket = reuse
        if !reuse {
            isSocketOpen = true
        }
        warmUntil = nil

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
        warmCloseTask?.cancel()
        warmCloseTask = nil
        warmUntil = nil
        cancelCalled = true
        isSocketOpen = false
    }

    func keepWarm(until: Date) {
        // Preserve the coordinator's deadline for assertions; keep the socket open.
        warmUntil = until
        isSocketOpen = true
        warmCloseTask?.cancel()
        warmCloseTask = nil
        // Only schedule wall-clock close for real future deadlines. Tests that inject
        // synthetic clocks call `expireWarmSocketForTests()` instead.
        let delay = until.timeIntervalSince(Date())
        guard delay > 0 else { return }
        let deadline = until
        warmCloseTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            guard self.warmUntil == deadline else { return }
            self.closeWarmSocket()
        }
    }

    /// Test helper: expire warm hold immediately (simulates wall-clock deadline).
    func expireWarmSocketForTests() {
        guard warmUntil != nil else { return }
        warmCloseTask?.cancel()
        warmCloseTask = nil
        closeWarmSocket()
    }

    private func canReuseWarmSocket() -> Bool {
        // Any active warm hold reuses the socket. Synthetic test clocks may put
        // `warmUntil` in the past; those stays warm until `expireWarmSocketForTests`.
        warmUntil != nil && isSocketOpen
    }

    private func closeWarmSocket() {
        warmUntil = nil
        isSocketOpen = false
        warmCloseCount += 1
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
    }
}
