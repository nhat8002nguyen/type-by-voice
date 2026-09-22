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
        // Force expired access so refreshIfNeeded actually hits the network stub.
        auth.forceAccessToken("stale")
        let model = AppModel(
            authStore: auth,
            audioCapture: AudioCaptureService(prepareImmediately: false),
            engineURL: URL(string: "ws://127.0.0.1:9/v1/dictate")!,
            apiBaseURL: URL(string: "http://127.0.0.1:9")!
        )

        await model.handleUnauthenticated()
        XCTAssertEqual(http.calls.filter { $0.contains("/v1/auth/refresh") }.count, 1)
        XCTAssertEqual(auth.accessToken, "fresh")
        XCTAssertFalse(model.needsLogin)

        await model.handleUnauthenticated()
        XCTAssertEqual(http.calls.filter { $0.contains("/v1/auth/refresh") }.count, 1)
        XCTAssertTrue(model.needsLogin)
        XCTAssertTrue(model.showOnboarding)
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
}
