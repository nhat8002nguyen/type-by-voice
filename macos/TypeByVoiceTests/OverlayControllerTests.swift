import XCTest
@testable import TypeByVoice

@MainActor
final class OverlayControllerTests: XCTestCase {
    func testConnectingDoesNotShowLevel() {
        let overlay = OverlayController()
        overlay.render(.connecting, level: 0.9, elapsed: 0, quota: nil, error: nil)
        XCTAssertEqual(overlay.model.caption, "Connecting…")
        XCTAssertFalse(overlay.model.showsLevel)
    }

    func testRecordingShowsElapsed() {
        let overlay = OverlayController()
        overlay.render(.recording, level: 0.4, elapsed: 12, quota: nil, error: nil)
        XCTAssertTrue(overlay.model.showsLevel)
        XCTAssertEqual(overlay.model.elapsedText, "0:12")
    }
}
