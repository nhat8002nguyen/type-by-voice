import XCTest
@testable import TypeByVoice

final class AppEndpointsTests: XCTestCase {
    func testEnvOverridesWin() {
        let env = [
            "TBV_API_URL": "https://example.test",
            "TBV_DICTATE_URL": "wss://example.test/v1/dictate",
        ]
        XCTAssertEqual(
            AppEndpoints.apiBaseURL(env: env, plist: [:]).absoluteString,
            "https://example.test"
        )
        XCTAssertEqual(
            AppEndpoints.dictateURL(env: env, plist: [:]).absoluteString,
            "wss://example.test/v1/dictate"
        )
    }

    func testMissingEnvUsesDebugLocalhost() {
        XCTAssertEqual(
            AppEndpoints.apiBaseURL(env: [:], plist: [:]).absoluteString,
            "http://127.0.0.1:3000"
        )
        XCTAssertEqual(
            AppEndpoints.dictateURL(env: [:], plist: [:]).absoluteString,
            "ws://127.0.0.1:3000/v1/dictate"
        )
    }

    func testPlistUsedWhenEnvMissing() {
        let plist = [
            "TBV_API_URL": "https://from-plist.test",
            "TBV_DICTATE_URL": "wss://from-plist.test/v1/dictate",
        ]
        XCTAssertEqual(
            AppEndpoints.apiBaseURL(env: [:], plist: plist).absoluteString,
            "https://from-plist.test"
        )
        XCTAssertEqual(
            AppEndpoints.dictateURL(env: [:], plist: plist).absoluteString,
            "wss://from-plist.test/v1/dictate"
        )
    }
}
