# macOS Transcription History UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the signed-in macOS dashboard with a Whisper-style transcriptions window backed by `GET`/`DELETE /v1/transcripts`, while hotkey dictation still pastes into other apps.

**Architecture:** `HistoryView` becomes the signed-in root for the Dock window and the menu bar extra.
`TranscriptHistoryStore` owns the list and talks only to `TranscriptsServing`.
`SessionCoordinator` gains a per-session destination (`.cursor` vs `.history`) so the in-window button can skip `TextInserter`.
Settings absorbs account, quota, hotkey, and Quit.

**Tech Stack:** Swift 6, SwiftUI, XCTest, Xcode, macOS 13+, existing `TypeByVoice` synchronized folder (new files are picked up without editing `project.pbxproj`).

**Spec:** `docs/superpowers/specs/2026-10-25-macos-history-ui-design.md`

## Global Constraints

- Deployment target **macOS 13.0**. Swift 6 language mode.
- No protocol or backend changes. `listInHistory` stays `true` on every `start`.
- Default window and menu bar extra size **420 x 620** (minWidth 420, minHeight 520).
- First page only: `GET /v1/transcripts?limit=50`. No infinite scroll.
- Search debounce **300 ms**. Placeholder **"Search in transcriptions"**.
- Delete-all copy: **"Delete all transcriptions?"** / **Delete** / **Cancel**.
- Load/search error copy: **"Could not load transcriptions."**
- In-window dictation does not paste.
- Hotkey dictation still pastes and still appears in the list.
- `.history` sessions do not show the overlay pill.
- Optimistic prepend, then refresh, then **two** retries **500 ms** apart.
- `401` on history: one `refreshIfNeeded`, retry once, then force reauthenticate / onboarding.
- Do not implement drop-audio, mini recorder, extra mic, per-item delete, local disk cache, or Upgrade.
- Use `let`/`var` in Swift.
- Do not add narrating comments.
- Xcode uses `PBXFileSystemSynchronizedRootGroup`: add files under `macos/TypeByVoice/` and `macos/TypeByVoiceTests/` only.

---

## File Structure

```
macos/TypeByVoice/
  History/
    TranscriptsClient.swift      TranscriptItem, page, errors, transport, client, NullTranscriptsClient
    TranscriptHistoryStore.swift list/search/deleteAll/optimistic prepend/expand
    HistoryView.swift            signed-in root UI
  Session/SessionCoordinator.swift   add SessionDestination + onTranscript
  App/AppModel.swift                 wire destination, store, overlay skip, settings opener
  TypeByVoiceApp.swift               HistoryView, 420x620
  Settings/SettingsView.swift        move + expand (from OnboardingView.swift)
  Onboarding/OnboardingView.swift    remove SettingsView
  Dashboard/DashboardView.swift      DELETE after HistoryView is wired
macos/TypeByVoiceTests/
  FakeTranscriptsClient.swift
  TranscriptsClientTests.swift
  TranscriptHistoryStoreTests.swift
  SessionCoordinatorTests.swift      destination tests
  AppModelHistoryTests.swift
```

---

### Task 1: Session destination

**Files:**
- Modify: `macos/TypeByVoice/Session/SessionCoordinator.swift`
- Test: `macos/TypeByVoiceTests/SessionCoordinatorTests.swift`

**Interfaces:**
- Consumes: existing `SessionCoordinator.hotkeyPressed()`, `EngineEvent.final`, `TextInserter.insert`.
- Produces:
  - `enum SessionDestination: Equatable { case cursor, case history }`
  - `SessionCoordinator.destination: SessionDestination` (`private(set)`, default `.cursor`)
  - `SessionCoordinator.onTranscript: ((String) -> Void)?`
  - `func hotkeyPressed(destination: SessionDestination = .cursor)`
  - On non-empty `final` + `.history`: call `onTranscript`, go `.idle`, do not call `insert`.
  - On non-empty `final` + `.cursor`: `insert`, then `onTranscript`, then `.idle`.
  - On empty/whitespace `final`: `.idle`, no `onTranscript`, no `insert`.

- [ ] **Step 1: Write the failing tests**

Add to `SessionCoordinatorTests` (keep `FakeInserter` and `makeRecording`; add a `destination` parameter to `makeRecording`):

```swift
func testHistoryDestinationSkipsInsertAndNotifies() async {
    let inserter = FakeInserter()
    let engine = FakeTranscriptionEngine()
    var transcripts: [String] = []
    let coordinator = makeRecording(engine: engine, inserter: inserter, destination: .history)
    coordinator.onTranscript = { transcripts.append($0) }
    coordinator.hotkeyPressed()
    engine.emitFinal(text: "list only")
    await waitUntil { coordinator.state == .idle }
    XCTAssertEqual(inserter.inserted, [])
    XCTAssertEqual(transcripts, ["list only"])
    XCTAssertEqual(coordinator.state, .idle)
    XCTAssertEqual(coordinator.destination, .history)
}

func testCursorDestinationStillInsertsAndNotifies() async {
    let inserter = FakeInserter()
    let engine = FakeTranscriptionEngine()
    var transcripts: [String] = []
    let coordinator = makeRecording(engine: engine, inserter: inserter, destination: .cursor)
    coordinator.onTranscript = { transcripts.append($0) }
    coordinator.hotkeyPressed()
    engine.emitFinal(text: "paste me")
    await waitUntil { !inserter.inserted.isEmpty && coordinator.state == .idle }
    XCTAssertEqual(inserter.inserted, ["paste me"])
    XCTAssertEqual(transcripts, ["paste me"])
}

func testEmptyFinalDoesNotNotifyHistory() async {
    let inserter = FakeInserter()
    let engine = FakeTranscriptionEngine()
    var transcripts: [String] = []
    let coordinator = makeRecording(engine: engine, inserter: inserter, destination: .history)
    coordinator.onTranscript = { transcripts.append($0) }
    coordinator.hotkeyPressed()
    engine.emitFinal(text: "   ")
    XCTAssertEqual(inserter.inserted, [])
    XCTAssertEqual(transcripts, [])
    XCTAssertEqual(coordinator.state, .idle)
}

func testStopDoesNotChangeDestination() async {
    let engine = FakeTranscriptionEngine()
    let coordinator = makeRecording(engine: engine, destination: .history)
    XCTAssertEqual(coordinator.destination, .history)
    coordinator.hotkeyPressed(destination: .cursor)
    XCTAssertEqual(coordinator.state, .transcribing)
    XCTAssertEqual(coordinator.destination, .history)
}
```

Update `makeRecording` signature to pass destination through:

```swift
private func makeRecording(
    engine: FakeTranscriptionEngine,
    inserter: TextInserter = FakeInserter(),
    clock: Clock = Clock(now: Date(timeIntervalSince1970: 0)),
    timeouts: SessionTimeouts = SessionTimeouts(),
    advanceRecordingMs: Int = 500,
    destination: SessionDestination = .cursor
) -> SessionCoordinator {
    let coordinator = SessionCoordinator(
        engine: engine,
        inserter: inserter,
        clock: clock,
        timeouts: timeouts
    )
    coordinator.hotkeyPressed(destination: destination)
    coordinator.micFrame(samples: [0.1, 0.1])
    engine.emitReady()
    XCTAssertEqual(coordinator.state, .recording)
    if advanceRecordingMs > 0 {
        clock.now = clock.now.addingTimeInterval(TimeInterval(advanceRecordingMs) / 1_000)
    }
    return coordinator
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests/SessionCoordinatorTests/testHistoryDestinationSkipsInsertAndNotifies \
  -derivedDataPath DerivedData
```

Expected: FAIL (no `SessionDestination` / `onTranscript`).

- [ ] **Step 3: Implement destination on SessionCoordinator**

In `SessionCoordinator.swift`, add:

```swift
enum SessionDestination: Equatable {
    case cursor
    case history
}
```

Add stored properties:

```swift
private(set) var destination: SessionDestination = .cursor
var onTranscript: ((String) -> Void)?
```

Replace `hotkeyPressed()` with:

```swift
func hotkeyPressed(destination: SessionDestination = .cursor) {
    switch state {
    case .idle:
        self.destination = destination
        beginConnecting()
    case .connecting:
        cancelSession()
    case .recording:
        requestStopFromRecording()
    case .transcribing, .inserting:
        break
    }
}
```

Replace the `.final` branch in `handleEngineEvent` with:

```swift
case let .final(text, _, _, quota):
    publishQuota(quota)
    guard state == .transcribing else { return }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
        transition(to: .idle)
        return
    }
    if destination == .history {
        onTranscript?(trimmed)
        transition(to: .idle)
        return
    }
    insertingStartedAt = clock.now
    transition(to: .inserting)
    Task { @MainActor [weak self] in
        guard let self else { return }
        await self.inserter.insert(trimmed)
        self.onTranscript?(trimmed)
        if self.state == .inserting {
            self.transition(to: .idle)
        }
    }
```

- [ ] **Step 4: Run the destination tests and the existing coordinator class**

Run:

```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests/SessionCoordinatorTests \
  -derivedDataPath DerivedData
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/Session/SessionCoordinator.swift macos/TypeByVoiceTests/SessionCoordinatorTests.swift
git commit -m "$(cat <<'EOF'
feat(macos): skip paste when a dictation is for history

In-window recording can finish into the list without inserting at the cursor.
EOF
)"
```

---

### Task 2: TranscriptsClient

**Files:**
- Create: `macos/TypeByVoice/History/TranscriptsClient.swift`
- Test: `macos/TypeByVoiceTests/TranscriptsClientTests.swift`

**Interfaces:**
- Consumes: `AppEndpoints.apiBaseURL()`, `ISO8601Parsing.date(from:)`.
- Produces:
  - `struct TranscriptItem: Equatable, Identifiable { var id: String; var text: String; var wordCount: Int; var audioMs: Int; var createdAt: Date; var isOptimistic: Bool }`
  - `struct TranscriptListPage: Equatable { var items: [TranscriptItem]; var nextCursor: String? }`
  - `enum TranscriptsClientError: Error, Equatable { case unauthorized, unreachable, httpStatus(Int), invalidResponse }`
  - `protocol TranscriptsServing: AnyObject { func list(q: String?, limit: Int, cursor: String?) async throws -> TranscriptListPage; func deleteAll() async throws }`
  - `protocol TranscriptsTransport: AnyObject { func send(method: String, path: String, query: [String: String], bearer: String?) async throws -> TranscriptsHTTPResponse }`
  - `struct TranscriptsHTTPResponse { var status: Int; var data: Data }`
  - `final class TranscriptsClient: TranscriptsServing`
  - `init(transport: TranscriptsTransport, accessToken: @escaping () -> String?)`
  - `final class NullTranscriptsClient: TranscriptsServing`
  - `final class URLSessionTranscriptsTransport: TranscriptsTransport` with `init(baseURL: URL, session: URLSession = .shared)`

- [ ] **Step 1: Write the failing tests**

Create `macos/TypeByVoiceTests/TranscriptsClientTests.swift`:

```swift
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests/TranscriptsClientTests \
  -derivedDataPath DerivedData
```

Expected: FAIL (`TranscriptsClient` missing).

- [ ] **Step 3: Implement TranscriptsClient**

Create `macos/TypeByVoice/History/TranscriptsClient.swift`:

```swift
import Foundation

struct TranscriptItem: Equatable, Identifiable {
    var id: String
    var text: String
    var wordCount: Int
    var audioMs: Int
    var createdAt: Date
    var isOptimistic: Bool = false
}

struct TranscriptListPage: Equatable {
    var items: [TranscriptItem]
    var nextCursor: String?
}

enum TranscriptsClientError: Error, Equatable {
    case unauthorized
    case unreachable
    case httpStatus(Int)
    case invalidResponse
}

struct TranscriptsHTTPResponse {
    var status: Int
    var data: Data
}

@MainActor
protocol TranscriptsTransport: AnyObject {
    func send(
        method: String,
        path: String,
        query: [String: String],
        bearer: String?
    ) async throws -> TranscriptsHTTPResponse
}

@MainActor
protocol TranscriptsServing: AnyObject {
    func list(q: String?, limit: Int, cursor: String?) async throws -> TranscriptListPage
    func deleteAll() async throws
}

@MainActor
final class TranscriptsClient: TranscriptsServing {
    private let transport: TranscriptsTransport
    private let accessToken: () -> String?

    init(transport: TranscriptsTransport, accessToken: @escaping () -> String?) {
        self.transport = transport
        self.accessToken = accessToken
    }

    func list(q: String?, limit: Int, cursor: String?) async throws -> TranscriptListPage {
        var query: [String: String] = ["limit": String(limit)]
        if let q, !q.isEmpty {
            query["q"] = q
        }
        if let cursor, !cursor.isEmpty {
            query["cursor"] = cursor
        }
        let json = try await sendJSON(method: "GET", path: "/v1/transcripts", query: query)
        return try Self.decodePage(json)
    }

    func deleteAll() async throws {
        _ = try await send(method: "DELETE", path: "/v1/transcripts", query: [:], allowEmpty: true)
    }

    private func sendJSON(
        method: String,
        path: String,
        query: [String: String]
    ) async throws -> Any {
        let response = try await send(method: method, path: path, query: query, allowEmpty: false)
        guard let json = try? JSONSerialization.jsonObject(with: response.data) else {
            throw TranscriptsClientError.invalidResponse
        }
        return json
    }

    private func send(
        method: String,
        path: String,
        query: [String: String],
        allowEmpty: Bool
    ) async throws -> TranscriptsHTTPResponse {
        guard let token = accessToken(), !token.isEmpty else {
            throw TranscriptsClientError.unauthorized
        }
        let response: TranscriptsHTTPResponse
        do {
            response = try await transport.send(
                method: method,
                path: path,
                query: query,
                bearer: token
            )
        } catch let error as TranscriptsClientError {
            throw error
        } catch {
            throw TranscriptsClientError.unreachable
        }
        if response.status == 401 {
            throw TranscriptsClientError.unauthorized
        }
        if response.status >= 400 {
            throw TranscriptsClientError.httpStatus(response.status)
        }
        if !allowEmpty, response.data.isEmpty {
            throw TranscriptsClientError.invalidResponse
        }
        return response
    }

    private static func decodePage(_ json: Any) throws -> TranscriptListPage {
        guard let object = json as? [String: Any], let rawItems = object["items"] as? [Any] else {
            throw TranscriptsClientError.invalidResponse
        }
        let items = try rawItems.map(decodeItem)
        let next = object["nextCursor"] as? String
        return TranscriptListPage(items: items, nextCursor: next)
    }

    private static func decodeItem(_ raw: Any) throws -> TranscriptItem {
        guard let object = raw as? [String: Any],
              let id = object["id"] as? String,
              let text = object["text"] as? String,
              let createdRaw = object["createdAt"] as? String,
              let createdAt = ISO8601Parsing.date(from: createdRaw)
        else {
            throw TranscriptsClientError.invalidResponse
        }
        let wordCount = (object["wordCount"] as? Int) ?? (object["wordCount"] as? NSNumber)?.intValue ?? 0
        let audioMs = (object["audioMs"] as? Int) ?? (object["audioMs"] as? NSNumber)?.intValue ?? 0
        return TranscriptItem(
            id: id,
            text: text,
            wordCount: wordCount,
            audioMs: audioMs,
            createdAt: createdAt
        )
    }
}

@MainActor
final class NullTranscriptsClient: TranscriptsServing {
    func list(q: String?, limit: Int, cursor: String?) async throws -> TranscriptListPage {
        TranscriptListPage(items: [], nextCursor: nil)
    }

    func deleteAll() async throws {}
}

@MainActor
final class URLSessionTranscriptsTransport: TranscriptsTransport {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func send(
        method: String,
        path: String,
        query: [String: String],
        bearer: String?
    ) async throws -> TranscriptsHTTPResponse {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
              var components = URLComponents(url: url, resolvingAgainstBaseURL: true)
        else {
            throw TranscriptsClientError.invalidResponse
        }
        if !query.isEmpty {
            components.queryItems = query.keys.sorted().map { URLQueryItem(name: $0, value: query[$0]) }
        }
        guard let finalURL = components.url else {
            throw TranscriptsClientError.invalidResponse
        }
        var request = URLRequest(url: finalURL)
        request.httpMethod = method
        if let bearer {
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw TranscriptsClientError.unreachable
        }
        guard let http = response as? HTTPURLResponse else {
            throw TranscriptsClientError.invalidResponse
        }
        return TranscriptsHTTPResponse(status: http.statusCode, data: data)
    }
}
```

- [ ] **Step 4: Run TranscriptsClientTests**

Run:

```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests/TranscriptsClientTests \
  -derivedDataPath DerivedData
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/History/TranscriptsClient.swift macos/TypeByVoiceTests/TranscriptsClientTests.swift
git commit -m "$(cat <<'EOF'
feat(macos): add authenticated transcripts HTTP client

The history window needs list and delete-all against the existing API.
EOF
)"
```

---

### Task 3: TranscriptHistoryStore

**Files:**
- Create: `macos/TypeByVoice/History/TranscriptHistoryStore.swift`
- Create: `macos/TypeByVoiceTests/FakeTranscriptsClient.swift`
- Test: `macos/TypeByVoiceTests/TranscriptHistoryStoreTests.swift`

**Interfaces:**
- Consumes: `TranscriptsServing`, `TranscriptItem`, `TranscriptListPage`, `TranscriptsClientError`.
- Produces:
  - `@MainActor final class TranscriptHistoryStore: ObservableObject`
  - `@Published var items: [TranscriptItem]`
  - `@Published var searchQuery: String`
  - `@Published var expandedId: String?`
  - `@Published var statusMessage: String?`
  - `@Published var isLoading: Bool`
  - `init(client: TranscriptsServing, refresh: @escaping () async throws -> Void, retryDelayNanoseconds: UInt64 = 500_000_000)`
  - `var onUnauthenticated: () async -> Void` (assign after `AppModel` finishes initializing `self`)
  - `func load() async`
  - `func search(query: String) async`
  - `func deleteAll() async`
  - `func didReceiveFinal(_ text: String) async`
  - `func toggleExpanded(id: String)`

- [ ] **Step 1: Write the fake and failing tests**

Create `macos/TypeByVoiceTests/FakeTranscriptsClient.swift`:

```swift
import Foundation
@testable import TypeByVoice

@MainActor
final class FakeTranscriptsClient: TranscriptsServing {
    var pages: [Result<TranscriptListPage, Error>] = []
    var deleteResults: [Result<Void, Error>] = []
    private(set) var listQueries: [String?] = []
    private(set) var deleteCount = 0

    func enqueue(items: [TranscriptItem], nextCursor: String? = nil) {
        pages.append(.success(TranscriptListPage(items: items, nextCursor: nextCursor)))
    }

    func enqueueListError(_ error: Error) {
        pages.append(.failure(error))
    }

    func list(q: String?, limit: Int, cursor: String?) async throws -> TranscriptListPage {
        listQueries.append(q)
        _ = limit
        _ = cursor
        guard !pages.isEmpty else {
            return TranscriptListPage(items: [], nextCursor: nil)
        }
        return try pages.removeFirst().get()
    }

    func deleteAll() async throws {
        deleteCount += 1
        if !deleteResults.isEmpty {
            try deleteResults.removeFirst().get()
        }
    }
}

enum FakeTranscripts {
    static func item(
        id: String,
        text: String,
        createdAt: Date = Date(timeIntervalSince1970: 1_772_000_000)
    ) -> TranscriptItem {
        TranscriptItem(id: id, text: text, wordCount: 1, audioMs: 800, createdAt: createdAt)
    }
}
```

Create `macos/TypeByVoiceTests/TranscriptHistoryStoreTests.swift`:

```swift
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
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests/TranscriptHistoryStoreTests \
  -derivedDataPath DerivedData
```

Expected: FAIL (`TranscriptHistoryStore` missing).

- [ ] **Step 3: Implement TranscriptHistoryStore**

Create `macos/TypeByVoice/History/TranscriptHistoryStore.swift`:

```swift
import Foundation

@MainActor
final class TranscriptHistoryStore: ObservableObject {
    @Published var items: [TranscriptItem] = []
    @Published var searchQuery = ""
    @Published var expandedId: String?
    @Published var statusMessage: String?
    @Published var isLoading = false

    private let client: TranscriptsServing
    private let refresh: () async throws -> Void
    var onUnauthenticated: () async -> Void = {}
    private let retryDelayNanoseconds: UInt64
    private var loadGeneration = 0
    private var optimistic: TranscriptItem?

    init(
        client: TranscriptsServing,
        refresh: @escaping () async throws -> Void = {},
        retryDelayNanoseconds: UInt64 = 500_000_000
    ) {
        self.client = client
        self.refresh = refresh
        self.retryDelayNanoseconds = retryDelayNanoseconds
    }

    func load() async {
        searchQuery = ""
        await fetch(q: nil, droppingOptimisticIfMissing: true)
    }

    func search(query: String) async {
        searchQuery = query
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        await fetch(q: q.isEmpty ? nil : q, droppingOptimisticIfMissing: true)
    }

    func deleteAll() async {
        do {
            try await perform { try await self.client.deleteAll() }
            optimistic = nil
            items = []
            statusMessage = nil
        } catch {
            statusMessage = "Could not load transcriptions."
        }
    }

    func didReceiveFinal(_ text: String) async {
        searchQuery = ""
        let placeholder = TranscriptItem(
            id: UUID().uuidString,
            text: text,
            wordCount: text.split { $0.isWhitespace || $0.isNewline }.count,
            audioMs: 0,
            createdAt: Date(),
            isOptimistic: true
        )
        optimistic = placeholder
        items.insert(placeholder, at: 0)
        await refreshUntilServerHasOptimistic()
    }

    func toggleExpanded(id: String) {
        expandedId = expandedId == id ? nil : id
    }

    private func refreshUntilServerHasOptimistic() async {
        for attempt in 0..<3 {
            await fetch(q: nil, droppingOptimisticIfMissing: false)
            if optimistic == nil { return }
            if attempt < 2, retryDelayNanoseconds > 0 {
                try? await Task.sleep(nanoseconds: retryDelayNanoseconds)
            }
        }
    }

    private func fetch(q: String?, droppingOptimisticIfMissing: Bool) async {
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        do {
            let page = try await perform {
                try await self.client.list(q: q, limit: 50, cursor: nil)
            }
            guard generation == loadGeneration else { return }
            apply(page, droppingOptimisticIfMissing: droppingOptimisticIfMissing)
            statusMessage = nil
        } catch {
            guard generation == loadGeneration else { return }
            statusMessage = "Could not load transcriptions."
        }
        isLoading = false
    }

    private func apply(_ page: TranscriptListPage, droppingOptimisticIfMissing: Bool) {
        if let optimistic {
            if page.items.contains(where: { $0.text == optimistic.text }) {
                self.optimistic = nil
                items = page.items
                return
            }
            if droppingOptimisticIfMissing {
                self.optimistic = nil
                items = page.items
                return
            }
            items = [optimistic] + page.items
            return
        }
        items = page.items
    }

    private func perform<T>(_ work: () async throws -> T) async throws -> T {
        do {
            return try await work()
        } catch TranscriptsClientError.unauthorized {
            do {
                try await refresh()
                return try await work()
            } catch TranscriptsClientError.unauthorized {
                await onUnauthenticated()
                throw TranscriptsClientError.unauthorized
            } catch {
                await onUnauthenticated()
                throw error
            }
        }
    }
}
```

If `refresh()` throws something other than unauthorized after the first 401, `onUnauthenticated` still runs so the user is sent back to login.

- [ ] **Step 4: Run TranscriptHistoryStoreTests**

Run:

```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests/TranscriptHistoryStoreTests \
  -derivedDataPath DerivedData
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/History/TranscriptHistoryStore.swift \
  macos/TypeByVoiceTests/FakeTranscriptsClient.swift \
  macos/TypeByVoiceTests/TranscriptHistoryStoreTests.swift
git commit -m "$(cat <<'EOF'
feat(macos): store searchable transcript history

The window list is a client of GET/DELETE /v1/transcripts with optimistic insert.
EOF
)"
```

---

### Task 4: AppModel wiring

**Files:**
- Modify: `macos/TypeByVoice/App/AppModel.swift`
- Test: `macos/TypeByVoiceTests/AppModelHistoryTests.swift`

**Interfaces:**
- Consumes: `SessionDestination`, `TranscriptHistoryStore`, `TranscriptsServing`, `TranscriptsClient`, `URLSessionTranscriptsTransport`, `NullTranscriptsClient`.
- Produces:
  - `AppModel.history: TranscriptHistoryStore`
  - `AppModel.sessionState: SessionState`
  - `AppModel.historyBanner: String?`
  - `func startOrStop(destination: SessionDestination = .cursor)`
  - `func openSettings()`
  - Hotkey register callback calls `hotkeyPressed(destination: .cursor)`.
  - `coordinator.onTranscript` forwards to `history.didReceiveFinal`.
  - While `coordinator.destination == .history`, skip overlay (render idle + `quota: nil` + `error: nil`) and put `lastError.message` on `historyBanner` when returning to idle.
  - Init: `transcripts: TranscriptsServing? = nil`. Production builds a `TranscriptsClient` with `URLSessionTranscriptsTransport(baseURL: apiBaseURL)` and `accessToken` from `authStore`. XCTest without an override uses `NullTranscriptsClient()`.
  - After `completeOnboarding()` / `didAuthenticate()`, `Task { await history.load() }`.

- [ ] **Step 1: Write the failing tests**

Create `macos/TypeByVoiceTests/AppModelHistoryTests.swift`:

```swift
import XCTest
@testable import TypeByVoice

@MainActor
final class AppModelHistoryTests: XCTestCase {
    func testInWindowStartUsesHistoryDestinationAndSkipsInsertSideEffectsOnStore() async {
        let client = FakeTranscriptsClient()
        client.enqueue(items: [FakeTranscripts.item(id: "srv", text: "from window")])
        let engine = FakeTranscriptionEngine()
        let overlay = OverlayController()
        let model = AppModel(
            authStore: AuthStore(
                http: FakeHTTP(),
                keychain: FakeKeychain(access: "tok"),
                deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!,
                clientVersion: "1.0.0+12"
            ),
            overlay: overlay,
            audioCapture: AudioCaptureService(prepareImmediately: false),
            transcriptionEngine: engine,
            transcripts: client
        )
        model.startOrStop(destination: .history)
        model.feedMicForTests(samples: [0.1, 0.1])
        engine.emitReady()
        XCTAssertTrue(model.isSessionActive)
        XCTAssertFalse(overlay.model.isVisible)
        model.startOrStop(destination: .cursor)
        engine.emitFinal(text: "from window")
        await waitUntil(timeout: 1) { model.history.items.contains { $0.text == "from window" } }
        XCTAssertFalse(model.isSessionActive)
        XCTAssertFalse(overlay.model.isVisible)
        XCTAssertEqual(model.history.items.first?.text, "from window")
    }

    func testHotkeyStartShowsOverlayAndForwardsFinal() async {
        let client = FakeTranscriptsClient()
        client.enqueue(items: [FakeTranscripts.item(id: "h", text: "from hotkey")])
        let engine = FakeTranscriptionEngine()
        let overlay = OverlayController()
        let model = AppModel(
            authStore: AuthStore(
                http: FakeHTTP(),
                keychain: FakeKeychain(access: "tok"),
                deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!,
                clientVersion: "1.0.0+12"
            ),
            overlay: overlay,
            audioCapture: AudioCaptureService(prepareImmediately: false),
            transcriptionEngine: engine,
            transcripts: client
        )
        model.startOrStop(destination: .cursor)
        model.feedMicForTests(samples: [0.1, 0.1])
        engine.emitReady()
        XCTAssertTrue(overlay.model.isVisible)
        model.startOrStop()
        engine.emitFinal(text: "from hotkey")
        await waitUntil(timeout: 1) { model.history.items.contains { $0.text == "from hotkey" } }
        XCTAssertEqual(model.history.items.first?.text, "from hotkey")
    }

    func testHistoryErrorSetsBannerNotOverlay() {
        let engine = FakeTranscriptionEngine()
        let overlay = OverlayController()
        let model = AppModel(
            authStore: AuthStore(
                http: FakeHTTP(),
                keychain: FakeKeychain(access: "tok"),
                deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!,
                clientVersion: "1.0.0+12"
            ),
            overlay: overlay,
            audioCapture: AudioCaptureService(prepareImmediately: false),
            transcriptionEngine: engine,
            transcripts: FakeTranscriptsClient()
        )
        model.startOrStop(destination: .history)
        engine.emitError(code: "offline", message: "Dictation unavailable", retryable: true)
        XCTAssertFalse(overlay.model.isVisible)
        XCTAssertEqual(model.historyBanner, "Dictation unavailable")
        XCTAssertFalse(model.isSessionActive)
    }

    private func waitUntil(timeout: TimeInterval, condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}
```

Note: `testHistoryErrorSetsBannerNotOverlay` depends on `emitError` during `.connecting` mapping to idle via the existing engine error path.
That already calls `failToIdle`.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests/AppModelHistoryTests \
  -derivedDataPath DerivedData
```

Expected: FAIL (`transcripts:` / `history` missing).

- [ ] **Step 3: Wire AppModel**

Add to `AppModel`:

```swift
@Published var sessionState: SessionState = .idle
@Published var historyBanner: String?
let history: TranscriptHistoryStore
```

Extend `init` with `transcripts: TranscriptsServing? = nil` after `transcriptionEngine`.

After `resolvedAuth` exists, before constructing the coordinator:

```swift
let serving: TranscriptsServing
if let transcripts {
    serving = transcripts
} else if runningUnderXCTest {
    serving = NullTranscriptsClient()
} else {
    serving = TranscriptsClient(
        transport: URLSessionTranscriptsTransport(baseURL: apiBaseURL),
        accessToken: { resolvedAuth.accessToken }
    )
}
self.history = TranscriptHistoryStore(
    client: serving,
    refresh: { try await resolvedAuth.refreshIfNeeded() }
)
```

Do not capture `self` in the `TranscriptHistoryStore` initializer.
`AppModel` is not finished initializing yet.

After every stored property is assigned (the same place as `coordinator.onQuotaChange`), set:

```swift
history.onUnauthenticated = { [weak self] in
    await self?.forceReauthenticate()
}
```

`forceReauthenticate` stays `private`.

After `coordinator.onQuotaChange` is set, add:

```swift
coordinator.onTranscript = { [weak self] text in
    Task { @MainActor in
        await self?.history.didReceiveFinal(text)
    }
}
```

Replace `startOrStop()`:

```swift
func startOrStop(destination: SessionDestination = .cursor) {
    coordinator.hotkeyPressed(destination: destination)
}
```

Hotkey register body must call `self?.coordinator.hotkeyPressed(destination: .cursor)` (not `startOrStop()` with a leftover destination).

Add:

```swift
func openSettings() {
    if #available(macOS 14.0, *) {
        NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
    } else {
        NSApp.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
    }
    NSApp.activate(ignoringOtherApps: true)
}
```

In `didAuthenticate()` and `completeOnboarding()`, after existing work:

```swift
Task { await history.load() }
```

In `handleStateChange`, set `sessionState = state` and `isSessionActive = state != .idle`.
Then, if `coordinator.destination == .history`:

```swift
updateTickLoop(for: state)
if state == .idle {
    recordingStartedAt = nil
    historyBanner = coordinator.lastError.map { error in
        if error.code == "engine_start_failed" || error.code == "offline" {
            return "Dictation unavailable"
        }
        return error.message
    }
    if coordinator.lastError?.code == "unauthenticated" {
        Task { await handleUnauthenticated() }
    }
} else {
    historyBanner = nil
    if state == .recording, recordingStartedAt == nil {
        recordingStartedAt = Date()
        clearUnauthenticatedEpisode()
    }
}
overlay.render(.idle, level: 0, elapsed: 0, quota: nil, error: nil)
return
```

Do not duplicate the cursor overlay path.
Leave the existing `switch state` overlay logic for `.cursor`.

`testEscapeWiringCancelsConnectingViaAppModelHook` still calls `startOrStop()` with the default `.cursor`.
Keep that compiling.

- [ ] **Step 4: Run AppModel history tests and existing AppModelErrorTests**

Run:

```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests/AppModelHistoryTests \
  -only-testing:TypeByVoiceTests/AppModelErrorTests \
  -derivedDataPath DerivedData
```

Expected: PASS.

If `testHistoryErrorSetsBannerNotOverlay` fails because emitError is ignored until connecting is fully set up, call `model.startOrStop(destination: .history)` then `engine.emitError` as written.
`handleEngineEvent` `.error` always `failToIdle`.

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/App/AppModel.swift macos/TypeByVoiceTests/AppModelHistoryTests.swift
git commit -m "$(cat <<'EOF'
feat(macos): wire history store into dictation sessions

Hotkey stays cursor-insert; the in-window button records into the list only.
EOF
)"
```

---

### Task 5: HistoryView and scenes

**Files:**
- Create: `macos/TypeByVoice/History/HistoryView.swift`
- Modify: `macos/TypeByVoice/TypeByVoiceApp.swift`

**Interfaces:**
- Consumes: `AppModel.history`, `startOrStop(destination:)`, `openSettings()`, `sessionState`, `historyBanner`, `isSessionActive`.
- Produces: signed-in root UI matching the spec (search, cards, floating dictation button, trash, settings).
- No new types.

- [ ] **Step 1: There is no meaningful XCTest for SwiftUI layout**

Do not add a snapshot test.
Cover expand/search/delete in the store (already done).
This task's automated check is: the macOS unit test target still builds after `DashboardView` is no longer referenced.

- [ ] **Step 2: Confirm current tests still pass (baseline)**

Run:

```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests \
  -derivedDataPath DerivedData
```

Expected: PASS before UI swap.

- [ ] **Step 3: Implement HistoryView**

Create `macos/TypeByVoice/History/HistoryView.swift`:

```swift
import AppKit
import SwiftUI

struct HistoryView: View {
    @ObservedObject var model: AppModel
    @State private var searchText = ""
    @State private var searchTask: Task<Void, Never>?
    @State private var confirmDeleteAll = false

    var body: some View {
        VStack(spacing: 0) {
            searchField
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 12)

            ZStack(alignment: .bottom) {
                listBody
                dictationButton
                    .padding(.bottom, 72)
            }

            bottomBar
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .alert("Delete all transcriptions?", isPresented: $confirmDeleteAll) {
            Button("Delete", role: .destructive) {
                Task { await model.history.deleteAll() }
            }
            Button("Cancel", role: .cancel) {}
        }
        .onAppear {
            searchText = model.history.searchQuery
            Task { await model.history.load() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
            Task { await model.history.load() }
        }
        .onChange(of: searchText) { newValue in
            searchTask?.cancel()
            searchTask = Task {
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard !Task.isCancelled else { return }
                await model.history.search(query: newValue)
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Search in transcriptions", text: $searchText)
                .textFieldStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(Capsule())
        .overlay(
            Capsule()
                .stroke(Color(nsColor: .separatorColor).opacity(0.5), lineWidth: 1)
        )
    }

    private var listBody: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if let banner = model.historyBanner ?? model.history.statusMessage {
                    Text(banner)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(model.history.items) { item in
                    card(item)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 120)
        }
    }

    private func card(_ item: TranscriptItem) -> some View {
        let expanded = model.history.expandedId == item.id
        return Button {
            model.history.toggleExpanded(id: item.id)
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                Text(item.text)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(expanded ? nil : 3)
                    .textSelection(.enabled)
                Divider()
                VStack(alignment: .leading, spacing: 2) {
                    Text(Self.dateFormatter.string(from: item.createdAt))
                    Text(Self.timeFormatter.string(from: item.createdAt))
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color(nsColor: .separatorColor).opacity(0.6), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var dictationButton: some View {
        Button {
            model.startOrStop(destination: .history)
        } label: {
            ZStack {
                Circle()
                    .fill(Color(red: 59 / 255, green: 130 / 255, blue: 246 / 255))
                    .frame(width: 64, height: 64)
                    .shadow(color: Color(red: 59 / 255, green: 130 / 255, blue: 246 / 255).opacity(0.35), radius: 12, y: 4)
                    .scaleEffect(model.sessionState == .recording ? 1.08 : 1.0)
                    .animation(
                        model.sessionState == .recording
                            ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true)
                            : .default,
                        value: model.sessionState
                    )
                if model.sessionState == .transcribing || model.sessionState == .connecting {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                }
            }
        }
        .buttonStyle(.plain)
        .help(model.isSessionActive ? "Stop dictation" : "Start dictation")
    }

    private var bottomBar: some View {
        HStack {
            Spacer()
            Button {
                confirmDeleteAll = true
            } label: {
                Image(systemName: "trash")
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.bordered)
            .help("Delete all transcriptions")
            Button {
                model.openSettings()
            } label: {
                Image(systemName: "gearshape")
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.bordered)
            .help("Settings")
        }
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()
}
```

Replace `TypeByVoiceApp` window and extra content:

```swift
Window("Type by Voice", id: "main") {
    Group {
        if model.showsWelcome {
            OnboardingView(model: model)
        } else {
            HistoryView(model: model)
        }
    }
    .frame(minWidth: 420, minHeight: 520)
}
.defaultSize(width: 420, height: 620)

MenuBarExtra {
    Group {
        if model.showsWelcome {
            OnboardingView(model: model)
        } else {
            HistoryView(model: model)
        }
    }
    .frame(width: 420, height: 620)
} label: {
    HStack(spacing: 4) {
        Image(systemName: model.isSessionActive ? "mic.fill" : "mic")
        Text("TBV")
    }
}
.menuBarExtraStyle(.window)
```

Leave `DashboardView.swift` on disk until Task 6 so this commit is only the new root.

- [ ] **Step 4: Run unit tests to verify the target still builds**

Run:

```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests \
  -derivedDataPath DerivedData
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/History/HistoryView.swift macos/TypeByVoice/TypeByVoiceApp.swift
git commit -m "$(cat <<'EOF'
feat(macos): show transcriptions as the signed-in home

Search, cards, and the in-window dictation button replace the dashboard.
EOF
)"
```

---

### Task 6: Settings absorbs dashboard controls

**Files:**
- Create: `macos/TypeByVoice/Settings/SettingsView.swift` (move out of `OnboardingView.swift`)
- Modify: `macos/TypeByVoice/Onboarding/OnboardingView.swift` (delete `SettingsView`)
- Delete: `macos/TypeByVoice/Dashboard/DashboardView.swift`

**Interfaces:**
- Consumes: `AppModel.quotaRemainingText`, `authStore.accountEmail`, `signOut()`, `quit()`, existing hotkey / launch-at-login.
- Produces: Settings sections Hotkey, General, Account (email + Log out), Usage, Quit.
- No Upgrade button.

- [ ] **Step 1: Write a failing assertion on Settings content**

There is no view test harness.
Keep verification as compile + the existing `SettingsStoreTests`.
After the move, `TypeByVoiceApp` `Settings { SettingsView(model: model) }` must still resolve.

- [ ] **Step 2: Confirm SettingsStoreTests pass**

Run:

```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests/SettingsStoreTests \
  -derivedDataPath DerivedData
```

Expected: PASS.

- [ ] **Step 3: Move and expand SettingsView, delete DashboardView**

Delete `struct SettingsView` from `OnboardingView.swift`.

Create `macos/TypeByVoice/Settings/SettingsView.swift`:

```swift
import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Form {
            Section("Hotkey") {
                HotkeyRecorderControl(
                    currentLabel: model.settings.hotkeyDisplayLabel,
                    onRecorded: { keyCode, modifiers in
                        model.updateHotkey(keyCode: keyCode, modifiers: modifiers)
                    }
                )
                Text("Silence duration: \(model.settings.silenceDurationMs) ms")
                Text("Hard cap: \(model.settings.hardCapMs) ms")
            }
            Section("General") {
                Toggle("Launch at login", isOn: Binding(
                    get: { model.settings.launchAtLogin },
                    set: { model.setLaunchAtLogin($0) }
                ))
            }
            Section("Account") {
                if model.authStore.accessToken != nil {
                    Text(model.authStore.accountEmail ?? "Signed in")
                    Button("Log out") {
                        Task { await model.signOut() }
                    }
                } else {
                    Text("Not signed in")
                    Button("Open onboarding") {
                        model.showOnboarding = true
                    }
                }
            }
            Section("Usage") {
                Text(model.quotaRemainingText ?? "Quota updates after your next dictation.")
                    .foregroundStyle(.secondary)
            }
            Section {
                Button("Quit") {
                    model.quit()
                }
            }
        }
        .padding()
        .frame(minWidth: 320, minHeight: 320)
    }
}
```

Delete `macos/TypeByVoice/Dashboard/DashboardView.swift`.
Grep the repo for `DashboardView` and ensure zero references.

Log out must call `model.signOut()` (sets `showOnboarding`, clears tokens), not the old Settings snippet that only called `authStore.logout()`.

- [ ] **Step 4: Run the full macOS unit test target**

Run:

```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests \
  -derivedDataPath DerivedData
```

Expected: PASS.

Then run:

```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -derivedDataPath DerivedData
```

Expected: unit and integration tests PASS (integration tests do not depend on DashboardView).

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/Settings/SettingsView.swift \
  macos/TypeByVoice/Onboarding/OnboardingView.swift \
  macos/TypeByVoice/Dashboard/DashboardView.swift
git commit -m "$(cat <<'EOF'
feat(macos): move account and quota into Settings

The history window no longer hosts account controls; Settings is the home for them.
EOF
)"
```

- [ ] **Step 6: Manual verification**

Build and run with `./macos/Scripts/build-and-run.sh` (re-enable Accessibility after the Debug re-sign).

Check:

1. Signed-in window matches the reference: search on top, cards, center blue button, trash + settings at bottom right, empty bottom left.
2. In-window dictation appears in the list and does not paste into another app.
3. Hotkey still pastes and the item appears in the list.
4. Overlay pill appears for hotkey dictation and does not appear for in-window dictation.
5. Search filters via the API.
6. Trash confirms and empties.
7. Settings shows email, quota, hotkey, Quit.
8. Menu bar extra shows the same history view at 420x620.

---

## Spec coverage

| Spec section | Task |
|---|---|
| Replace `DashboardView` | 5, 6 |
| Window + menu bar extra 420x620 | 5 |
| `TranscriptsClient` GET/DELETE | 2 |
| Store load/search/deleteAll/401/optimistic | 3 |
| Session `.cursor` / `.history` | 1 |
| AppModel wiring, overlay skip, banner | 4 |
| HistoryView layout + debounce + confirm | 5 |
| Settings account/quota/quit | 6 |
| Empty `final` adds no card | 1 |
| `listInHistory` unchanged | already true; no task |
| Non-goals | not implemented |
