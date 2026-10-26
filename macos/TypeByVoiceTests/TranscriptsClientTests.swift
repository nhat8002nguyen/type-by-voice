import XCTest
@testable import TypeByVoice

@MainActor
final class FakeTranscriptsTransport: TranscriptsTransport {
    struct Call {
        var method: String
        var path: String
        var query: [String: String]
        var bearer: String?
    }

    var results: [Result<TranscriptsHTTPResponse, Error>] = []
    private(set) var calls: [Call] = []

    func send(
        method: String,
        path: String,
        query: [String: String],
        bearer: String?
    ) async throws -> TranscriptsHTTPResponse {
        calls.append(Call(method: method, path: path, query: query, bearer: bearer))
        guard !results.isEmpty else {
            return TranscriptsHTTPResponse(status: 200, data: Data("{}".utf8))
        }
        return try results.removeFirst().get()
    }
}

@MainActor
final class TranscriptsClientTests: XCTestCase {
    func testListSendsQueryBearerAndDecodesItems() async throws {
        let transport = FakeTranscriptsTransport()
        let json = """
        {"items":[{"id":"a1","text":"hello","wordCount":1,"audioMs":800,"createdAt":"2026-10-24T14:58:00Z"}],"nextCursor":"a1"}
        """
        transport.results = [
            .success(TranscriptsHTTPResponse(status: 200, data: Data(json.utf8))),
        ]
        let client = TranscriptsClient(transport: transport, accessToken: { "tok" })
        let page = try await client.list(q: "hel", limit: 50, cursor: nil)
        XCTAssertEqual(transport.calls.map(\.method), ["GET"])
        XCTAssertEqual(transport.calls.map(\.path), ["/v1/transcripts"])
        XCTAssertEqual(transport.calls.first?.query["q"], "hel")
        XCTAssertEqual(transport.calls.first?.query["limit"], "50")
        XCTAssertEqual(transport.calls.first?.bearer, "tok")
        XCTAssertEqual(page.items.count, 1)
        XCTAssertEqual(page.items[0].id, "a1")
        XCTAssertEqual(page.items[0].text, "hello")
        XCTAssertEqual(page.items[0].wordCount, 1)
        XCTAssertEqual(page.items[0].audioMs, 800)
        XCTAssertEqual(page.nextCursor, "a1")
        XCTAssertFalse(page.items[0].isOptimistic)
    }

    func testListOmitsEmptyQuery() async throws {
        let transport = FakeTranscriptsTransport()
        transport.results = [
            .success(TranscriptsHTTPResponse(status: 200, data: Data("{\"items\":[]}".utf8))),
        ]
        let client = TranscriptsClient(transport: transport, accessToken: { "tok" })
        _ = try await client.list(q: "", limit: 50, cursor: nil)
        XCTAssertNil(transport.calls.first?.query["q"])
    }

    func testList401ThrowsUnauthorized() async {
        let transport = FakeTranscriptsTransport()
        transport.results = [
            .success(TranscriptsHTTPResponse(status: 401, data: Data())),
        ]
        let client = TranscriptsClient(transport: transport, accessToken: { "tok" })
        do {
            _ = try await client.list(q: nil, limit: 50, cursor: nil)
            XCTFail("expected throw")
        } catch let error as TranscriptsClientError {
            XCTAssertEqual(error, .unauthorized)
        } catch {
            XCTFail("wrong error \(error)")
        }
    }

    func testDeleteAllSendsDelete() async throws {
        let transport = FakeTranscriptsTransport()
        transport.results = [
            .success(TranscriptsHTTPResponse(status: 204, data: Data())),
        ]
        let client = TranscriptsClient(transport: transport, accessToken: { "tok" })
        try await client.deleteAll()
        XCTAssertEqual(transport.calls.map(\.method), ["DELETE"])
        XCTAssertEqual(transport.calls.map(\.path), ["/v1/transcripts"])
        XCTAssertEqual(transport.calls.first?.bearer, "tok")
    }

    func testMissingTokenThrowsUnauthorized() async {
        let transport = FakeTranscriptsTransport()
        let client = TranscriptsClient(transport: transport, accessToken: { nil })
        do {
            _ = try await client.list(q: nil, limit: 50, cursor: nil)
            XCTFail("expected throw")
        } catch let error as TranscriptsClientError {
            XCTAssertEqual(error, .unauthorized)
        } catch {
            XCTFail("wrong error \(error)")
        }
        XCTAssertTrue(transport.calls.isEmpty)
    }
}
