import CoreGraphics
import XCTest
@testable import TypeByVoice

final class FakePasteboard: PasteboardSnapshotting {
    var string: String?
    private var storedItems: [[String: Data]] = []

    init(string: String? = nil) {
        self.string = string
        if let string {
            storedItems = [["public.utf8-plain-text": Data(string.utf8)]]
        }
    }

    func snapshot() -> PasteboardSnapshot {
        if let string {
            return PasteboardSnapshot(items: [["public.utf8-plain-text": Data(string.utf8)]])
        }
        return PasteboardSnapshot(items: storedItems)
    }

    func restore(_ snapshot: PasteboardSnapshot) {
        storedItems = snapshot.items
        if let data = snapshot.items.first?["public.utf8-plain-text"],
           let restored = String(data: data, encoding: .utf8) {
            string = restored
        } else if snapshot.items.isEmpty {
            string = nil
        } else {
            string = nil
        }
    }
}

final class FakeEventPoster: KeyEventPosting {
    private(set) var posted: [(keyCode: CGKeyCode, keyDown: Bool, flags: CGEventFlags)] = []
    nonisolated(unsafe) static var lastModifiers: CGEventFlags = []

    func postKey(keyCode: CGKeyCode, keyDown: Bool, flags: CGEventFlags) {
        posted.append((keyCode, keyDown, flags))
        Self.lastModifiers = flags
    }
}

final class FakeNotifier: UserNotifying {
    nonisolated(unsafe) static var messages: [String] = []

    func notify(body: String) {
        Self.messages.append(body)
    }
}

@MainActor
final class ClipboardPasteInserterTests: XCTestCase {
    override func setUp() {
        super.setUp()
        FakeNotifier.messages = []
        FakeEventPoster.lastModifiers = []
    }

    func testFallbackLeavesTextOnPasteboard() async {
        let pasteboard = FakePasteboard()
        let events = FakeEventPoster()
        let inserter = ClipboardPasteInserter(
            pasteboard: pasteboard,
            poster: events,
            notifications: FakeNotifier(),
            accessibilityGranted: { false },
            restoreDelayMs: 0
        )
        await inserter.insert("hello")
        XCTAssertEqual(pasteboard.string, "hello")
        XCTAssertEqual(events.posted.count, 0)
        XCTAssertEqual(FakeNotifier.messages.last, "Transcript copied. Press ⌘V to paste.")
    }

    func testPasteRestoresPreviousContents() async {
        let pasteboard = FakePasteboard(string: "previous")
        let inserter = ClipboardPasteInserter(
            pasteboard: pasteboard,
            poster: FakeEventPoster(),
            notifications: FakeNotifier(),
            accessibilityGranted: { true },
            restoreDelayMs: 0
        )
        await inserter.insert("hello")
        XCTAssertEqual(pasteboard.string, "previous")
        XCTAssertEqual(FakeEventPoster.lastModifiers.contains(.maskCommand), true)
    }
}
