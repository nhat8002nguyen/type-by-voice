import XCTest
@testable import TypeByVoice

final class FakeInserter: TextInserter {
    private(set) var inserted: [String] = []

    func insert(_ text: String) async {
        inserted.append(text)
    }
}

@MainActor
final class SessionCoordinatorTests: XCTestCase {
    func testHotkeyEntersConnectingNotRecording() async {
        let engine = FakeTranscriptionEngine()
        let coordinator = SessionCoordinator(engine: engine, inserter: FakeInserter(), clock: Clock())
        coordinator.hotkeyPressed()
        XCTAssertEqual(coordinator.state, .connecting)
        XCTAssertFalse(coordinator.isListeningUI)
    }

    func testRecordingRequiresFramesAndReady() async {
        let engine = FakeTranscriptionEngine()
        let coordinator = SessionCoordinator(engine: engine, inserter: FakeInserter(), clock: Clock())
        coordinator.hotkeyPressed()
        coordinator.micFrame(samples: [0.1, 0.1])
        XCTAssertEqual(coordinator.state, .connecting)
        engine.emitReady()
        XCTAssertEqual(coordinator.state, .recording)
        XCTAssertTrue(coordinator.isListeningUI)
        XCTAssertGreaterThan(engine.flushedBytes, 0)
    }

    func testConnectingTimesOutAt5s() async {
        let clock = Clock(now: Date(timeIntervalSince1970: 0))
        let coordinator = SessionCoordinator(engine: FakeTranscriptionEngine(), inserter: FakeInserter(), clock: clock)
        coordinator.hotkeyPressed()
        clock.now = Date(timeIntervalSince1970: 5.1)
        coordinator.tick(now: clock.now)
        XCTAssertEqual(coordinator.state, .idle)
        XCTAssertEqual(coordinator.lastError?.code, "session_timeout")
    }

    func testSecondHotkeyStopsAndTranscribes() async {
        let engine = FakeTranscriptionEngine()
        let coordinator = makeRecording(engine: engine)
        coordinator.hotkeyPressed()
        XCTAssertEqual(coordinator.state, .transcribing)
        engine.emitFinal(text: "the transcribed text")
        XCTAssertEqual(coordinator.state, .inserting)
    }

    func testEmptyFinalSkipsInsert() async {
        let inserter = FakeInserter()
        let engine = FakeTranscriptionEngine()
        let coordinator = makeRecording(engine: engine, inserter: inserter)
        coordinator.hotkeyPressed()
        engine.emitFinal(text: "   ")
        XCTAssertEqual(inserter.inserted, [])
        XCTAssertEqual(coordinator.state, .idle)
    }

    func testShortRecordingDoesNotCallStop() async {
        let engine = FakeTranscriptionEngine()
        let coordinator = makeRecording(engine: engine, advanceRecordingMs: 0)
        coordinator.hotkeyPressed() // duration ~0
        XCTAssertEqual(coordinator.state, .idle)
        XCTAssertFalse(engine.stopCalled)
    }

    func testTranscribeWatchdogReturnsIdle() async {
        let clock = Clock(now: Date(timeIntervalSince1970: 10))
        let engine = FakeTranscriptionEngine()
        let coordinator = makeRecording(engine: engine, clock: clock)
        coordinator.hotkeyPressed()
        clock.now = Date(timeIntervalSince1970: 26)
        coordinator.tick(now: clock.now)
        XCTAssertEqual(coordinator.state, .idle)
    }

    func testSilenceAfterSpeechStopsAndTranscribes() async {
        let engine = FakeTranscriptionEngine()
        let clock = Clock(now: Date(timeIntervalSince1970: 0))
        let timeouts = SessionTimeouts(silenceDurationMs: 300)
        let coordinator = makeRecording(engine: engine, clock: clock, timeouts: timeouts)

        let noise = [Float](repeating: 0.005, count: 1600 * 3)
        coordinator.micFrame(samples: noise)
        let speech = (0..<3200).map { Float(sin(Float($0) / 8)) * 0.4 }
        coordinator.micFrame(samples: speech)
        clock.now = clock.now.addingTimeInterval(0.5)
        let quiet = [Float](repeating: 0.005, count: 1600 * 4)
        coordinator.micFrame(samples: quiet)

        XCTAssertEqual(coordinator.state, .transcribing)
    }

    func testNoSpeechReturnsIdleWithoutStop() async {
        let engine = FakeTranscriptionEngine()
        let timeouts = SessionTimeouts(noSpeechTimeoutMs: 400)
        let coordinator = makeRecording(engine: engine, timeouts: timeouts, advanceRecordingMs: 0)

        let quiet = [Float](repeating: 0.001, count: 16_000)
        coordinator.micFrame(samples: quiet)

        XCTAssertEqual(coordinator.state, .idle)
        XCTAssertFalse(engine.stopCalled)
    }

    func testTrailingSilenceIsTrimmedBeforeStop() async {
        let engine = FakeTranscriptionEngine()
        let clock = Clock(now: Date(timeIntervalSince1970: 0))
        let coordinator = makeRecording(engine: engine, clock: clock)

        let noise = [Float](repeating: 0.001, count: 1600 * 3)
        coordinator.micFrame(samples: noise)
        let speech = (0..<3200).map { Float(sin(Float($0) / 8)) * 0.4 }
        coordinator.micFrame(samples: speech)
        let bytesAfterSpeech = engine.flushedBytes

        let quiet = [Float](repeating: 0.001, count: 16_000)
        coordinator.micFrame(samples: quiet)
        XCTAssertEqual(engine.flushedBytes, bytesAfterSpeech)

        clock.now = clock.now.addingTimeInterval(0.5)
        coordinator.hotkeyPressed()
        XCTAssertEqual(coordinator.state, .transcribing)

        let hangoverBytes = engine.flushedBytes - bytesAfterSpeech
        XCTAssertGreaterThan(hangoverBytes, 0)
        XCTAssertLessThan(hangoverBytes, bytesAfterSpeech)
    }

    /// Soft speech above floor×2.5 but below the old fixed 0.02 RMS must flush, not hold as silence.
    func testTrailingSilenceUsesDetectorSpeechThreshold() async {
        let engine = FakeTranscriptionEngine()
        let clock = Clock(now: Date(timeIntervalSince1970: 0))
        let coordinator = makeRecording(engine: engine, clock: clock)

        let noise = [Float](repeating: 0.001, count: 1600 * 3)
        coordinator.micFrame(samples: noise)
        let afterCalibration = engine.flushedBytes

        let softSpeech = [Float](repeating: 0.01, count: 3200)
        coordinator.micFrame(samples: softSpeech)
        XCTAssertGreaterThan(engine.flushedBytes, afterCalibration)

        let bytesAfterSpeech = engine.flushedBytes
        let quiet = [Float](repeating: 0.001, count: 16_000)
        coordinator.micFrame(samples: quiet)
        XCTAssertEqual(engine.flushedBytes, bytesAfterSpeech)

        clock.now = clock.now.addingTimeInterval(0.5)
        coordinator.hotkeyPressed()
        let hangoverBytes = engine.flushedBytes - bytesAfterSpeech
        XCTAssertGreaterThan(hangoverBytes, 0)
        XCTAssertLessThan(hangoverBytes, bytesAfterSpeech)
    }

    func testStopKeepsSocketWarmFor60s() async {
        let engine = FakeTranscriptionEngine()
        let clock = Clock(now: Date(timeIntervalSince1970: 100))
        let coordinator = makeRecording(engine: engine, clock: clock)
        coordinator.hotkeyPressed()
        XCTAssertEqual(engine.warmUntil, clock.now.addingTimeInterval(60))
        XCTAssertTrue(engine.isSocketOpen)
    }

    func testWarmSocketReusedOnNextStart() async {
        let engine = FakeTranscriptionEngine()
        let clock = Clock(now: Date())
        let coordinator = makeRecording(engine: engine, clock: clock)
        await waitUntil { engine.startCallCount >= 1 }

        coordinator.hotkeyPressed()
        XCTAssertNotNil(engine.warmUntil)
        XCTAssertTrue(engine.isSocketOpen)

        engine.emitFinal(text: "hello")
        await waitUntil { coordinator.state == .idle }

        let startsBefore = engine.startCallCount
        coordinator.hotkeyPressed()
        await waitUntil { engine.startCallCount > startsBefore }
        XCTAssertEqual(engine.startCallCount, startsBefore + 1)
        XCTAssertTrue(engine.lastStartReusedWarmSocket)
    }

    func testWarmSocketClosesAfterExpire() async {
        let engine = FakeTranscriptionEngine()
        let clock = Clock(now: Date())
        let coordinator = makeRecording(engine: engine, clock: clock)
        await waitUntil { engine.startCallCount >= 1 }

        coordinator.hotkeyPressed()
        XCTAssertTrue(engine.isSocketOpen)
        XCTAssertEqual(engine.warmCloseCount, 0)

        engine.emitFinal(text: "done")
        await waitUntil { coordinator.state == .idle }

        engine.expireWarmSocketForTests()
        XCTAssertFalse(engine.isSocketOpen)
        XCTAssertNil(engine.warmUntil)
        XCTAssertEqual(engine.warmCloseCount, 1)

        let startsBefore = engine.startCallCount
        coordinator.hotkeyPressed()
        await waitUntil { engine.startCallCount > startsBefore }
        XCTAssertEqual(engine.startCallCount, startsBefore + 1)
        XCTAssertFalse(engine.lastStartReusedWarmSocket)
    }

    func testStopFlushesEncoderEOSPage() async {
        let engine = FakeTranscriptionEngine()
        let clock = Clock(now: Date(timeIntervalSince1970: 0))
        let coordinator = makeRecording(engine: engine, clock: clock)
        let beforeStop = engine.flushedBytes

        clock.now = clock.now.addingTimeInterval(0.5)
        coordinator.hotkeyPressed()
        XCTAssertEqual(coordinator.state, .transcribing)
        // finish() always emits at least an EOS Ogg page.
        XCTAssertGreaterThan(engine.flushedBytes, beforeStop)
    }

    func testServerMaxDurationMsCapsRecordingHardCap() async {
        let engine = FakeTranscriptionEngine()
        let clock = Clock(now: Date(timeIntervalSince1970: 0))
        let timeouts = SessionTimeouts(recordingHardCap: 120)
        let coordinator = SessionCoordinator(
            engine: engine,
            inserter: FakeInserter(),
            clock: clock,
            timeouts: timeouts
        )
        coordinator.hotkeyPressed()
        coordinator.micFrame(samples: [0.1, 0.1])
        engine.emitReady(maxDurationMs: 5_000)
        XCTAssertEqual(coordinator.state, .recording)

        clock.now = clock.now.addingTimeInterval(5.0)
        coordinator.tick(now: clock.now)
        XCTAssertEqual(coordinator.state, .transcribing)
    }

    func testEscapeCancelsConnecting() {
        let engine = FakeTranscriptionEngine()
        let coordinator = makeConnecting(engine: engine)
        coordinator.escapePressed()
        XCTAssertEqual(coordinator.state, .idle)
        XCTAssertNil(coordinator.lastError)
    }

    func testEscapeCancelsRecording() {
        let engine = FakeTranscriptionEngine()
        let coordinator = makeRecording(engine: engine)
        coordinator.escapePressed()
        XCTAssertEqual(coordinator.state, .idle)
        XCTAssertNil(coordinator.lastError)
        XCTAssertFalse(engine.stopCalled)
    }

    func testReadyAndFinalPublishQuota() async {
        let readyQuota = QuotaSnapshot(
            unit: "words",
            limit: 1_000,
            used: 100,
            resetAt: Date(timeIntervalSince1970: 1)
        )
        let finalQuota = QuotaSnapshot(
            unit: "words",
            limit: 1_000,
            used: 250,
            resetAt: Date(timeIntervalSince1970: 2)
        )

        let clock = Clock(now: Date(timeIntervalSince1970: 0))
        let engine = FakeTranscriptionEngine()
        let coordinator = SessionCoordinator(engine: engine, inserter: FakeInserter(), clock: clock)
        var seen: [QuotaSnapshot] = []
        coordinator.onQuotaChange = { seen.append($0) }

        coordinator.hotkeyPressed()
        coordinator.micFrame(samples: [0.1])
        engine.emitReady(quota: readyQuota)
        XCTAssertEqual(coordinator.lastQuota, readyQuota)

        clock.now = clock.now.addingTimeInterval(0.5)
        coordinator.hotkeyPressed()
        engine.emitFinal(text: "hello world", quota: finalQuota)
        XCTAssertEqual(coordinator.lastQuota, finalQuota)
        XCTAssertEqual(seen, [readyQuota, finalQuota])
    }

    func testEveryErrorCodeSurfacesRetryableFlag() {
        let codes: [(String, Bool)] = [
            ("unauthenticated", false),
            ("quota_exceeded", false),
            ("audio_cap_exceeded", false),
            ("too_long", false),
            ("invalid_request", false),
            ("rate_limited", true),
            ("provider_unavailable", true),
            ("internal", true),
            ("session_timeout", true),
        ]
        for (code, retryable) in codes {
            let engine = FakeTranscriptionEngine()
            let coordinator = makeConnecting(engine: engine)
            engine.emitError(code: code, message: code, retryable: retryable)
            XCTAssertEqual(coordinator.lastError?.retryable, retryable, code)
            XCTAssertEqual(coordinator.lastError?.code, code)
            XCTAssertEqual(coordinator.state, .idle)
        }
    }

    func testConnectingTimeoutIsRetryable() {
        let clock = Clock(now: Date(timeIntervalSince1970: 0))
        let coordinator = SessionCoordinator(engine: FakeTranscriptionEngine(), inserter: FakeInserter(), clock: clock)
        coordinator.hotkeyPressed()
        clock.now = Date(timeIntervalSince1970: 5.1)
        coordinator.tick(now: clock.now)
        XCTAssertEqual(coordinator.lastError?.code, "session_timeout")
        XCTAssertEqual(coordinator.lastError?.retryable, true)
    }

    private func makeConnecting(engine: FakeTranscriptionEngine) -> SessionCoordinator {
        let coordinator = SessionCoordinator(engine: engine, inserter: FakeInserter(), clock: Clock())
        coordinator.hotkeyPressed()
        XCTAssertEqual(coordinator.state, .connecting)
        return coordinator
    }

    private func waitBriefly() async {
        try? await Task.sleep(nanoseconds: 50_000_000)
    }

    private func waitUntil(timeout: TimeInterval = 1, condition: @escaping () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    private func makeRecording(
        engine: FakeTranscriptionEngine,
        inserter: TextInserter = FakeInserter(),
        clock: Clock = Clock(now: Date(timeIntervalSince1970: 0)),
        timeouts: SessionTimeouts = SessionTimeouts(),
        advanceRecordingMs: Int = 500
    ) -> SessionCoordinator {
        let coordinator = SessionCoordinator(
            engine: engine,
            inserter: inserter,
            clock: clock,
            timeouts: timeouts
        )
        coordinator.hotkeyPressed()
        coordinator.micFrame(samples: [0.1, 0.1])
        engine.emitReady()
        XCTAssertEqual(coordinator.state, .recording)
        if advanceRecordingMs > 0 {
            clock.now = clock.now.addingTimeInterval(TimeInterval(advanceRecordingMs) / 1_000)
        }
        return coordinator
    }
}
