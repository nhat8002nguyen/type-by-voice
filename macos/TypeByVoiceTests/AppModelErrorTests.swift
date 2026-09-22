import XCTest
@testable import TypeByVoice

@MainActor
final class AppModelErrorTests: XCTestCase {
    func testUnauthenticatedTriggersOneRefreshThenLogin() async {
        let http = FakeHTTP()
        http.enqueue(json: [
            "accessToken": "fresh",
            "refreshToken": "r2",
            "expiresIn": 900,
        ])
        let auth = AuthStore(
            http: http,
            keychain: FakeKeychain(refresh: "r", access: "stale"),
            deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!
        )
        auth.forceAccessToken("stale")
        let engine = FakeTranscriptionEngine()
        engine.updateAccessToken("stale")
        let model = AppModel(
            authStore: auth,
            audioCapture: AudioCaptureService(prepareImmediately: false),
            transcriptionEngine: engine
        )

        let startsBefore = engine.startCallCount
        await model.handleUnauthenticated()
        XCTAssertEqual(http.calls.filter { $0.contains("/v1/auth/refresh") }.count, 1)
        XCTAssertEqual(auth.accessToken, "fresh")
        XCTAssertEqual(engine.accessToken, "fresh", "credentials must sync onto the engine")
        await waitUntil(timeout: 1) { engine.startCallCount > startsBefore }
        XCTAssertEqual(engine.startCallCount, startsBefore + 1, "must attempt a new session start")
        XCTAssertFalse(model.needsLogin)

        await model.handleUnauthenticated()
        XCTAssertEqual(http.calls.filter { $0.contains("/v1/auth/refresh") }.count, 1)
        XCTAssertTrue(model.needsLogin)
        XCTAssertTrue(model.showOnboarding)
    }

    func testRefreshFlagResetsAfterOnboardingSoNextEpisodeCanRefresh() async {
        let http = FakeHTTP()
        http.enqueue(json: [
            "accessToken": "fresh-1",
            "refreshToken": "r2",
            "expiresIn": 900,
        ])
        http.enqueue(json: [
            "accessToken": "fresh-2",
            "refreshToken": "r3",
            "expiresIn": 900,
        ])
        let auth = AuthStore(
            http: http,
            keychain: FakeKeychain(refresh: "r", access: "stale"),
            deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!
        )
        auth.forceAccessToken("stale")
        let engine = FakeTranscriptionEngine()
        let model = AppModel(
            authStore: auth,
            audioCapture: AudioCaptureService(prepareImmediately: false),
            transcriptionEngine: engine
        )

        await model.handleUnauthenticated()
        await model.handleUnauthenticated()
        XCTAssertTrue(model.needsLogin)

        model.completeOnboarding()
        XCTAssertFalse(model.needsLogin)

        auth.forceAccessToken("stale-again")
        await model.handleUnauthenticated()
        XCTAssertEqual(http.calls.filter { $0.contains("/v1/auth/refresh") }.count, 2)
        XCTAssertEqual(engine.accessToken, "fresh-2")
        XCTAssertFalse(model.needsLogin)
    }

    func testRefreshFlagResetsAfterSuccessfulReconnect() async {
        let http = FakeHTTP()
        http.enqueue(json: [
            "accessToken": "fresh-1",
            "refreshToken": "r2",
            "expiresIn": 900,
        ])
        http.enqueue(json: [
            "accessToken": "fresh-2",
            "refreshToken": "r3",
            "expiresIn": 900,
        ])
        let auth = AuthStore(
            http: http,
            keychain: FakeKeychain(refresh: "r", access: "stale"),
            deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!
        )
        auth.forceAccessToken("stale")
        let engine = FakeTranscriptionEngine()
        let model = AppModel(
            authStore: auth,
            audioCapture: AudioCaptureService(prepareImmediately: false),
            transcriptionEngine: engine
        )

        await model.handleUnauthenticated()
        XCTAssertEqual(http.calls.filter { $0.contains("/v1/auth/refresh") }.count, 1)

        // Successful reconnect (ready + frames → recording) ends the auth-failure episode.
        model.feedMicForTests(samples: [0.1, 0.1])
        engine.emitReady()
        model.cancelForTests()

        auth.forceAccessToken("stale-again")
        await model.handleUnauthenticated()
        XCTAssertEqual(http.calls.filter { $0.contains("/v1/auth/refresh") }.count, 2)
        XCTAssertFalse(model.needsLogin)
    }

    func testOverlayUsesSessionErrorRetryableFlag() {
        let overlay = OverlayController()
        let nonRetryable = OverlayError(message: "quota", retryable: false)
        overlay.render(.idle, level: 0, elapsed: 0, quota: nil, error: nonRetryable)
        XCTAssertFalse(overlay.model.showsRetry)

        let retryable = OverlayError(message: "rate limited", retryable: true)
        overlay.render(.idle, level: 0, elapsed: 0, quota: nil, error: retryable)
        XCTAssertTrue(overlay.model.showsRetry)
    }

    func testEscapeWiringCancelsConnectingViaAppModelHook() {
        let engine = FakeTranscriptionEngine()
        let model = AppModel(
            authStore: AuthStore(
                http: FakeHTTP(),
                keychain: FakeKeychain(),
                deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!,
                clientVersion: "1.0.0+12"
            ),
            audioCapture: AudioCaptureService(prepareImmediately: false),
            transcriptionEngine: engine
        )
        model.startOrStop()
        XCTAssertTrue(model.isSessionActive)
        model.installEscapeMonitorForTests()
        XCTAssertTrue(model.escapeMonitorInstalled)
        model.handleEscapeKeyForTests()
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
