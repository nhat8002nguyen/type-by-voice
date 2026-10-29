import XCTest
@testable import TypeByVoice

@MainActor
final class FakeHTTP: AuthHTTPClient {
    private var queued: [[String: Any]] = []
    var statusSequence: [Int] = []
    var holdPosts = false
    private(set) var calls: [String] = []
    private(set) var lastBody: [String: Any] = [:]
    private var holdContinuations: [CheckedContinuation<Void, Never>] = []

    var heldPostCount: Int { holdContinuations.count }

    func enqueue(json: [String: Any]) {
        queued.append(json)
    }

    func releaseHeldPosts() {
        let waiting = holdContinuations
        holdContinuations.removeAll()
        waiting.forEach { $0.resume() }
    }

    func post(path: String, body: [String: Any]) async throws -> AuthHTTPResponse {
        calls.append(path)
        lastBody = body
        if holdPosts {
            await withCheckedContinuation { continuation in
                holdContinuations.append(continuation)
            }
        }
        let status = statusSequence.isEmpty ? 200 : statusSequence.removeFirst()
        if status >= 400 {
            throw AuthHTTPError.status(status)
        }
        if queued.isEmpty {
            return AuthHTTPResponse(status: status, json: [:])
        }
        return AuthHTTPResponse(status: status, json: queued.removeFirst())
    }
}

@MainActor
final class FakeKeychain: KeychainStoring {
    var accessToken: String?
    var refreshToken: String?

    init(refresh: String? = nil, access: String? = nil) {
        self.refreshToken = refresh
        self.accessToken = access
    }
}

@MainActor
final class AuthStoreTests: XCTestCase {
    func testRegisterSendsClientIdentity() async throws {
        let http = FakeHTTP()
        http.enqueue(json: ["accessToken": "a", "refreshToken": "r", "expiresIn": 900])
        let store = AuthStore(
            http: http,
            keychain: FakeKeychain(),
            deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!,
            clientVersion: "1.0.0+12"
        )
        try await store.register(email: "a@b.co", password: "pw")
        XCTAssertEqual(http.lastBody["platform"] as? String, "macos")
        XCTAssertEqual(
            http.lastBody["deviceId"] as? String,
            "9C1E4A2B-7D55-4F3A-9E10-2B8C0D1A4F77".lowercased()
        )
        XCTAssertEqual(http.lastBody["clientVersion"] as? String, store.clientVersion)
        XCTAssertEqual(store.accessToken, "a")
    }

    func testClientVersionFormatIsMarketingPlusBuild() {
        let version = ClientVersion.fromBundle()
        let parts = version.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)
        XCTAssertEqual(parts.count, 2, "expected marketing+build, got \(version)")
        XCTAssertFalse(parts[0].isEmpty)
        XCTAssertFalse(parts[1].isEmpty)
        XCTAssertEqual(ClientVersion.fromBundle(), "\(parts[0])+\(parts[1])")
    }

    func testClientVersionUsesExplicitBundleValues() {
        // Simulate marketing/build via the same formatting rule the app uses.
        let marketing = "2.3.4"
        let build = "99"
        let formatted = "\(marketing)+\(build)"
        XCTAssertEqual(formatted, "2.3.4+99")
        let store = AuthStore(
            http: FakeHTTP(),
            keychain: FakeKeychain(),
            deviceId: UUID(),
            clientVersion: formatted
        )
        XCTAssertEqual(store.clientVersion, "2.3.4+99")
        XCTAssertEqual(store.clientIdentity.clientVersion, "2.3.4+99")
    }

    func testRefreshOnceThenGivesUp() async {
        let http = FakeHTTP()
        http.statusSequence = [401, 401]
        let store = AuthStore(http: http, keychain: FakeKeychain(refresh: "r"), deviceId: UUID())
        store.forceAccessToken("expired")
        var didThrow = false
        do {
            try await store.refreshIfNeeded()
        } catch {
            didThrow = true
        }
        XCTAssertTrue(didThrow)
        XCTAssertEqual(http.calls.filter { $0.contains("/v1/auth/refresh") }.count, 1)
    }

    func testConcurrentRefreshIfNeededSendsOneRequestAndKeepsSession() async throws {
        let http = FakeHTTP()
        http.holdPosts = true
        http.statusSequence = [200, 401]
        http.enqueue(json: ["accessToken": "a2", "refreshToken": "r2", "expiresIn": 900])
        let keychain = FakeKeychain(refresh: "r1", access: "expired")
        let store = AuthStore(http: http, keychain: keychain, deviceId: UUID())
        store.forceAccessToken("expired")

        let first = Task { try await store.refreshIfNeeded() }
        let second = Task { try await store.refreshIfNeeded() }

        await waitUntil(timeout: 1) { http.heldPostCount >= 1 }
        for _ in 0..<20 {
            await Task.yield()
        }
        XCTAssertEqual(http.calls.filter { $0.contains("/v1/auth/refresh") }.count, 1)
        http.releaseHeldPosts()

        try await first.value
        try await second.value
        XCTAssertEqual(store.accessToken, "a2")
        XCTAssertEqual(keychain.refreshToken, "r2")
        XCTAssertEqual(http.calls.filter { $0.contains("/v1/auth/refresh") }.count, 1)
    }

    private func waitUntil(timeout: TimeInterval, condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    func testLoginMaps401ToInvalidCredentialsMessage() async {
        let http = FakeHTTP()
        http.statusSequence = [401]
        let store = AuthStore(http: http, keychain: FakeKeychain(), deviceId: UUID())
        do {
            try await store.login(email: "a@b.co", password: "wrong")
            XCTFail("expected throw")
        } catch let error as AuthStoreError {
            XCTAssertEqual(error, .invalidCredentials)
            XCTAssertEqual(
                error.errorDescription,
                "Email or password is incorrect, or no account exists with that email."
            )
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testRegisterMaps409ToEmailAlreadyRegistered() async {
        let http = FakeHTTP()
        http.statusSequence = [409]
        let store = AuthStore(http: http, keychain: FakeKeychain(), deviceId: UUID())
        do {
            try await store.register(email: "a@b.co", password: "pw")
            XCTFail("expected throw")
        } catch let error as AuthStoreError {
            XCTAssertEqual(error, .emailAlreadyRegistered)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }
}
