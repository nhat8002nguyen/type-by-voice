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
}
