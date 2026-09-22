import XCTest
@testable import TypeByVoice

@MainActor
final class FakeHTTP: AuthHTTPClient {
    private var queued: [[String: Any]] = []
    var statusSequence: [Int] = []
    private(set) var calls: [String] = []
    private(set) var lastBody: [String: Any] = [:]

    func enqueue(json: [String: Any]) {
        queued.append(json)
    }

    func post(path: String, body: [String: Any]) async throws -> AuthHTTPResponse {
        calls.append(path)
        lastBody = body
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
            deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!
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
}
