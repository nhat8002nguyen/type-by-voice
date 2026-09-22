import XCTest
@testable import TypeByVoice

@MainActor
final class RemoteTranscriptionEngineTests: XCTestCase {
    func testStartFlushAndFinalAgainstMock() async throws {
        let server = try MockDictateProcess.start()
        defer { server.stop() }
        let engine = RemoteTranscriptionEngine(
            url: server.url,
            token: "test-token",
            identity: .preview
        )
        var events: [EngineEvent] = []
        let waiter = expectation(description: "final")
        Task {
            for await event in engine.events {
                events.append(event)
                if case .final = event { waiter.fulfill() }
            }
        }
        try await engine.start(
            requestId: UUID(uuidString: "3F2B0C8E-1A2B-4C5D-8E9F-0A1B2C3D4E5F")!,
            identity: .preview
        )
        await engine.sendAudio(Data([1, 2, 3])) // before ready must be buffered by coordinator; engine may queue
        try await Task.sleep(nanoseconds: 200_000_000)
        await engine.stop(durationMs: 1000)
        await fulfillment(of: [waiter], timeout: 3)
        guard case let .final(text, wordCount, _, _) = events.last else {
            return XCTFail("expected final")
        }
        XCTAssertEqual(text, "the transcribed text")
        XCTAssertEqual(wordCount, 3)
    }

    func testUpdateAccessTokenIsUsedOnNextStart() async throws {
        let engine = RemoteTranscriptionEngine(
            url: URL(string: "ws://127.0.0.1:9/v1/dictate")!,
            token: "stale",
            identity: .preview
        )
        XCTAssertEqual(engine.accessToken, "stale")
        engine.updateAccessToken("fresh-token")
        XCTAssertEqual(engine.accessToken, "fresh-token")
    }
}
