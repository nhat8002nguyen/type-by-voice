import XCTest
@testable import TypeByVoice

final class PipelineInserter: TextInserter {
    private(set) var inserted: [String] = []

    func insert(_ text: String) async {
        inserted.append(text)
    }
}

@MainActor
final class MockServerPipelineTests: XCTestCase {
    func testCoordinatorPipelineReceivesFinalFromMock() async throws {
        let server = try MockDictateProcess.start()
        defer { server.stop() }

        let engine = RemoteTranscriptionEngine(
            url: server.url,
            token: "test-token",
            identity: .preview
        )
        let inserter = PipelineInserter()
        let clock = Clock(now: Date(timeIntervalSince1970: 0))
        let coordinator = SessionCoordinator(
            engine: engine,
            inserter: inserter,
            clock: clock,
            identity: .preview
        )

        coordinator.hotkeyPressed()

        let sampleRate = 16_000
        let sine = (0..<sampleRate).map { i in
            Float(sin(2 * Double.pi * 440 * Double(i) / Double(sampleRate))) * 0.35
        }

        let readyDeadline = Date().addingTimeInterval(5)
        var offset = 0
        let frame = 320
        while coordinator.state == .connecting, Date() < readyDeadline {
            let end = min(offset + frame, sine.count)
            if offset < end {
                coordinator.micFrame(samples: Array(sine[offset..<end]))
                offset = end
            } else {
                coordinator.micFrame(samples: Array(sine.prefix(frame)))
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertEqual(coordinator.state, .recording, "expected ready + frames to reach recording")

        while offset < sine.count {
            let end = min(offset + frame, sine.count)
            coordinator.micFrame(samples: Array(sine[offset..<end]))
            offset = end
        }

        clock.now = clock.now.addingTimeInterval(1.0)
        coordinator.hotkeyPressed()
        XCTAssertEqual(coordinator.state, .transcribing)

        let insertDeadline = Date().addingTimeInterval(5)
        while inserter.inserted.isEmpty, Date() < insertDeadline {
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        XCTAssertEqual(inserter.inserted, ["the transcribed text"])
        XCTAssertEqual(coordinator.state, .idle)
    }
}
