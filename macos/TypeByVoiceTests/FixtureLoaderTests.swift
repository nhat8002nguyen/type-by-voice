import XCTest
@testable import TypeByVoice

final class FixtureLoaderTests: XCTestCase {
    func testStartFixturePlatformIsMacos() throws {
        let json = try FixtureLoader.json(named: "start.valid")
        XCTAssertEqual(json["type"] as? String, "start")
        XCTAssertEqual(json["platform"] as? String, "macos")
        XCTAssertEqual(json["sampleRate"] as? Int, 16000)
    }
}
