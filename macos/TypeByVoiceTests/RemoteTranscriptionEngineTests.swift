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
        engine.setEventHandler { event in
            events.append(event)
            if case .final = event { waiter.fulfill() }
        }
        try await engine.start(
            requestId: UUID(uuidString: "3F2B0C8E-1A2B-4C5D-8E9F-0A1B2C3D4E5F")!,
            identity: .preview
        )
        await engine.sendAudio(Data([1, 2, 3]))
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

    func testKeepWarmReusesSocketThenCloses() async throws {
        let server = try MockDictateProcess.start()
        defer { server.stop() }
        let engine = RemoteTranscriptionEngine(
            url: server.url,
            token: "test-token",
            identity: .preview
        )
        let ready1 = expectation(description: "ready-1")
        let final1 = expectation(description: "final-1")
        engine.setEventHandler { event in
            switch event {
            case .ready: ready1.fulfill()
            case .final: final1.fulfill()
            default: break
            }
        }

        try await engine.start(requestId: UUID(), identity: .preview)
        await fulfillment(of: [ready1], timeout: 3)
        engine.keepWarm(until: Date().addingTimeInterval(2))
        await engine.stop(durationMs: 500)
        await fulfillment(of: [final1], timeout: 3)

        let ready2 = expectation(description: "ready-2")
        engine.setEventHandler { event in
            if case .ready = event { ready2.fulfill() }
        }
        try await engine.start(requestId: UUID(), identity: .preview)
        XCTAssertTrue(engine.lastStartReusedWarmSocket)
        await fulfillment(of: [ready2], timeout: 3)

        // Short warm window so close runs without a long wait.
        engine.keepWarm(until: Date().addingTimeInterval(0.2))
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertNil(engine.warmUntil)

        let ready3 = expectation(description: "ready-3")
        engine.setEventHandler { event in
            if case .ready = event { ready3.fulfill() }
        }
        try await engine.start(requestId: UUID(), identity: .preview)
        XCTAssertFalse(engine.lastStartReusedWarmSocket)
        await fulfillment(of: [ready3], timeout: 3)
    }

    func testEventsDeliverOnceViaHandlerOnly() async throws {
        let server = try MockDictateProcess.start()
        defer { server.stop() }
        let engine = RemoteTranscriptionEngine(
            url: server.url,
            token: "test-token",
            identity: .preview
        )
        var handlerCount = 0
        var streamCount = 0
        engine.setEventHandler { _ in handlerCount += 1 }
        let streamTask = Task {
            for await _ in engine.events {
                streamCount += 1
            }
        }
        try await engine.start(requestId: UUID(), identity: .preview)
        try await Task.sleep(nanoseconds: 300_000_000)
        streamTask.cancel()
        XCTAssertGreaterThan(handlerCount, 0)
        XCTAssertEqual(streamCount, 0)
        XCTAssertTrue(engine.deliversEventsSynchronously)
    }
}
