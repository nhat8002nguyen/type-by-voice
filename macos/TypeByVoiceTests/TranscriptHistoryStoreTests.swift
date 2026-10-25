import XCTest
@testable import TypeByVoice

@MainActor
final class TranscriptHistoryStoreTests: XCTestCase {
    func testLoadFillsItems() async {
        let client = FakeTranscriptsClient()
        client.enqueue(items: [FakeTranscripts.item(id: "1", text: "hello")])
        let store = TranscriptHistoryStore(client: client, retryDelayNanoseconds: 0)
        await store.load()
        XCTAssertEqual(store.items.map(\.text), ["hello"])
        XCTAssertNil(store.statusMessage)
    }

    func testSearchSendsQuery() async {
        let client = FakeTranscriptsClient()
        client.enqueue(items: [])
        let store = TranscriptHistoryStore(client: client, retryDelayNanoseconds: 0)
        await store.search(query: "hel")
        XCTAssertEqual(client.listQueries, ["hel"])
        XCTAssertEqual(store.searchQuery, "hel")
    }

    func testDeleteAllClearsOnlyOnSuccess() async {
        let client = FakeTranscriptsClient()
        client.enqueue(items: [FakeTranscripts.item(id: "1", text: "hello")])
        let store = TranscriptHistoryStore(client: client, retryDelayNanoseconds: 0)
        await store.load()
        await store.deleteAll()
        XCTAssertEqual(client.deleteCount, 1)
        XCTAssertEqual(store.items, [])
    }

    func testDeleteAllFailureKeepsItems() async {
        let client = FakeTranscriptsClient()
        client.enqueue(items: [FakeTranscripts.item(id: "1", text: "hello")])
        client.deleteResults = [.failure(TranscriptsClientError.unreachable)]
        let store = TranscriptHistoryStore(client: client, retryDelayNanoseconds: 0)
        await store.load()
        await store.deleteAll()
        XCTAssertEqual(store.items.map(\.id), ["1"])
        XCTAssertEqual(store.statusMessage, "Could not load transcriptions.")
    }

    func testFailedLoadKeepsExistingItems() async {
        let client = FakeTranscriptsClient()
        client.enqueue(items: [FakeTranscripts.item(id: "1", text: "hello")])
        let store = TranscriptHistoryStore(client: client, retryDelayNanoseconds: 0)
        await store.load()
        client.enqueueListError(TranscriptsClientError.unreachable)
        await store.load()
        XCTAssertEqual(store.items.map(\.id), ["1"])
        XCTAssertEqual(store.statusMessage, "Could not load transcriptions.")
    }

    func testUnauthorizedRefreshesOnceThenRetries() async {
        let client = FakeTranscriptsClient()
        client.enqueueListError(TranscriptsClientError.unauthorized)
        client.enqueue(items: [FakeTranscripts.item(id: "2", text: "after")])
        var refreshCount = 0
        var unauthCount = 0
        let store = TranscriptHistoryStore(
            client: client,
            refresh: { refreshCount += 1 },
            retryDelayNanoseconds: 0
        )
        store.onUnauthenticated = { unauthCount += 1 }
        await store.load()
        XCTAssertEqual(refreshCount, 1)
        XCTAssertEqual(unauthCount, 0)
        XCTAssertEqual(store.items.map(\.id), ["2"])
    }

    func testUnauthorizedAfterRefreshForcesReauth() async {
        let client = FakeTranscriptsClient()
        client.enqueueListError(TranscriptsClientError.unauthorized)
        client.enqueueListError(TranscriptsClientError.unauthorized)
        var unauthCount = 0
        let store = TranscriptHistoryStore(
            client: client,
            refresh: {},
            retryDelayNanoseconds: 0
        )
        store.onUnauthenticated = { unauthCount += 1 }
        await store.load()
        XCTAssertEqual(unauthCount, 1)
    }

    func testOptimisticPrependThenServerId() async {
        let client = FakeTranscriptsClient()
        let store = TranscriptHistoryStore(client: client, retryDelayNanoseconds: 0)
        client.enqueue(items: [FakeTranscripts.item(id: "srv", text: "spoken")])
        await store.didReceiveFinal("spoken")
        XCTAssertEqual(store.items.first?.id, "srv")
        XCTAssertEqual(store.items.first?.text, "spoken")
        XCTAssertEqual(store.items.first?.isOptimistic, false)
        XCTAssertEqual(store.searchQuery, "")
    }

    func testOptimisticKeptWhenRefetchMissesThenDroppedOnLaterLoad() async {
        let client = FakeTranscriptsClient()
        let store = TranscriptHistoryStore(client: client, retryDelayNanoseconds: 0)
        client.enqueue(items: [])
        client.enqueue(items: [])
        client.enqueue(items: [])
        await store.didReceiveFinal("ghost")
        XCTAssertEqual(store.items.first?.text, "ghost")
        XCTAssertEqual(store.items.first?.isOptimistic, true)
        client.enqueue(items: [])
        await store.load()
        XCTAssertEqual(store.items, [])
    }

    func testToggleExpandedIsSingleSelection() {
        let store = TranscriptHistoryStore(client: FakeTranscriptsClient(), retryDelayNanoseconds: 0)
        store.toggleExpanded(id: "a")
        XCTAssertEqual(store.expandedId, "a")
        store.toggleExpanded(id: "b")
        XCTAssertEqual(store.expandedId, "b")
        store.toggleExpanded(id: "b")
        XCTAssertNil(store.expandedId)
    }

    func testCopyWritesTranscriptText() {
        var copied: String?
        let store = TranscriptHistoryStore(
            client: FakeTranscriptsClient(),
            retryDelayNanoseconds: 0,
            copyText: { copied = $0 }
        )
        store.copy("hello from history")
        XCTAssertEqual(copied, "hello from history")
    }
}
