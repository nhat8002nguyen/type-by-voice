import XCTest
@testable import TypeByVoice

@MainActor
final class AppModelHistoryTests: XCTestCase {
    func testInWindowStartUsesHistoryDestinationAndSkipsInsertSideEffectsOnStore() async {
        let client = FakeTranscriptsClient()
        client.enqueue(items: [FakeTranscripts.item(id: "srv", text: "from window")])
        let engine = FakeTranscriptionEngine()
        let overlay = OverlayController()
        let model = AppModel(
            authStore: AuthStore(
                http: FakeHTTP(),
                keychain: FakeKeychain(access: "tok"),
                deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!,
                clientVersion: "1.0.0+12"
            ),
            overlay: overlay,
            audioCapture: AudioCaptureService(prepareImmediately: false),
            transcriptionEngine: engine,
            transcripts: client
        )
        model.startOrStop(destination: .history)
        model.feedMicForTests(samples: [0.1, 0.1])
        engine.emitReady()
        XCTAssertTrue(model.isSessionActive)
        XCTAssertFalse(overlay.model.isVisible)
        try? await Task.sleep(nanoseconds: 500_000_000)
        model.startOrStop(destination: .cursor)
        engine.emitFinal(text: "from window")
        await waitUntil(timeout: 1) { model.history.items.contains { $0.text == "from window" } }
        XCTAssertFalse(model.isSessionActive)
        XCTAssertFalse(overlay.model.isVisible)
        XCTAssertEqual(model.history.items.first?.text, "from window")
    }

    func testHotkeyStartShowsOverlayAndForwardsFinal() async {
        let client = FakeTranscriptsClient()
        client.enqueue(items: [FakeTranscripts.item(id: "h", text: "from hotkey")])
        let engine = FakeTranscriptionEngine()
        let overlay = OverlayController()
        let model = AppModel(
            authStore: AuthStore(
                http: FakeHTTP(),
                keychain: FakeKeychain(access: "tok"),
                deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!,
                clientVersion: "1.0.0+12"
            ),
            overlay: overlay,
            audioCapture: AudioCaptureService(prepareImmediately: false),
            transcriptionEngine: engine,
            transcripts: client
        )
        model.startOrStop(destination: .cursor)
        model.feedMicForTests(samples: [0.1, 0.1])
        engine.emitReady()
        XCTAssertTrue(overlay.model.isVisible)
        try? await Task.sleep(nanoseconds: 500_000_000)
        model.startOrStop()
        engine.emitFinal(text: "from hotkey")
        await waitUntil(timeout: 1) { model.history.items.contains { $0.text == "from hotkey" } }
        XCTAssertEqual(model.history.items.first?.text, "from hotkey")
    }

    func testHistoryErrorSetsBannerNotOverlay() {
        let engine = FakeTranscriptionEngine()
        let overlay = OverlayController()
        let model = AppModel(
            authStore: AuthStore(
                http: FakeHTTP(),
                keychain: FakeKeychain(access: "tok"),
                deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!,
                clientVersion: "1.0.0+12"
            ),
            overlay: overlay,
            audioCapture: AudioCaptureService(prepareImmediately: false),
            transcriptionEngine: engine,
            transcripts: FakeTranscriptsClient()
        )
        model.startOrStop(destination: .history)
        engine.emitError(code: "offline", message: "Dictation unavailable", retryable: true)
        XCTAssertFalse(overlay.model.isVisible)
        XCTAssertEqual(model.historyBanner, "Dictation unavailable")
        XCTAssertFalse(model.isSessionActive)
    }

    private func waitUntil(timeout: TimeInterval, condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}
