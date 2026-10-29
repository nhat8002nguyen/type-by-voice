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

    func testConcurrentUnauthorizedLoadsShareRefreshAndStaySignedIn() async {
        let http = FakeHTTP()
        http.holdPosts = true
        http.statusSequence = [200, 401]
        http.enqueue(json: ["accessToken": "a2", "refreshToken": "r2", "expiresIn": 900])
        let keychain = FakeKeychain(refresh: "r1", access: "expired")
        let auth = AuthStore(
            http: http,
            keychain: keychain,
            deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!
        )
        auth.forceAccessToken("expired")

        let client = FakeTranscriptsClient()
        client.listUnauthorized = { auth.accessToken == "expired" }
        client.enqueue(items: [FakeTranscripts.item(id: "1", text: "hello")])
        client.enqueue(items: [FakeTranscripts.item(id: "1", text: "hello")])

        var unauthCount = 0
        let store = TranscriptHistoryStore(
            client: client,
            refresh: { try await auth.refreshIfNeeded() },
            retryDelayNanoseconds: 0
        )
        store.onUnauthenticated = { unauthCount += 1 }

        let first = Task { await store.load() }
        let second = Task { await store.load() }
        let deadline = Date().addingTimeInterval(1)
        while Date() < deadline, http.heldPostCount < 1 {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        for _ in 0..<20 {
            await Task.yield()
        }
        http.releaseHeldPosts()
        await first.value
        await second.value

        XCTAssertEqual(unauthCount, 0)
        XCTAssertEqual(http.calls.filter { $0.contains("/v1/auth/refresh") }.count, 1)
        XCTAssertEqual(store.items.map(\.id), ["1"])
        XCTAssertEqual(keychain.refreshToken, "r2")
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

    func testLoadKeepsOptimisticWhenServerStillMissing() async {
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
        XCTAssertEqual(store.items.first?.text, "ghost")
        XCTAssertEqual(store.items.first?.isOptimistic, true)
    }

    func testDidReceiveFinalDoesNotDuplicateTextAlreadyLoaded() async {
        let client = FakeTranscriptsClient()
        client.enqueue(items: [FakeTranscripts.item(id: "srv", text: "spoken")])
        let store = TranscriptHistoryStore(client: client, retryDelayNanoseconds: 0)
        await store.load()
        client.enqueueListError(TranscriptsClientError.unreachable)
        client.enqueueListError(TranscriptsClientError.unreachable)
        client.enqueueListError(TranscriptsClientError.unreachable)
        await store.didReceiveFinal("spoken")
        XCTAssertEqual(store.items.map(\.text), ["spoken"])
        XCTAssertEqual(Set(store.items.map(\.id)).count, 1)
    }

    func testRepeatedFinalDoesNotDuplicateTextWhenRefreshFails() async {
        let client = FakeTranscriptsClient()
        let store = TranscriptHistoryStore(client: client, retryDelayNanoseconds: 0)
        client.enqueue(items: [])
        client.enqueue(items: [])
        client.enqueue(items: [])
        await store.didReceiveFinal("spoken")
        client.enqueueListError(TranscriptsClientError.unreachable)
        client.enqueueListError(TranscriptsClientError.unreachable)
        client.enqueueListError(TranscriptsClientError.unreachable)
        await store.didReceiveFinal("spoken")
        XCTAssertEqual(store.items.map(\.text), ["spoken"])
        XCTAssertEqual(store.items.count, 1)
    }

    func testLoadDoesNotShowOptimisticAndServerRowForSameText() async {
        let client = FakeTranscriptsClient()
        let store = TranscriptHistoryStore(client: client, retryDelayNanoseconds: 0)
        client.enqueue(items: [])
        client.enqueue(items: [])
        client.enqueue(items: [])
        await store.didReceiveFinal("spoken")
        client.enqueue(items: [FakeTranscripts.item(id: "srv", text: "spoken")])
        await store.load()
        XCTAssertEqual(store.items.map(\.id), ["srv"])
        XCTAssertEqual(store.items.map(\.text), ["spoken"])
    }

    func testSearchDropsOptimisticWhenServerStillMissing() async {
        let client = FakeTranscriptsClient()
        let store = TranscriptHistoryStore(client: client, retryDelayNanoseconds: 0)
        client.enqueue(items: [])
        client.enqueue(items: [])
        client.enqueue(items: [])
        await store.didReceiveFinal("ghost")
        client.enqueue(items: [])
        await store.search(query: "zzz")
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
