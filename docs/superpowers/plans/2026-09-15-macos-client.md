# macOS Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v1 official macOS menu-bar dictation client: global hotkey, Connecting→Listening pill, Opus upload over the shared protocol, clipboard paste insertion, email/password auth.

**Architecture:** Swift 6 / SwiftUI app at `macos/TypeByVoice`. Every component reports only to `SessionCoordinator` — siblings never call each other. `TranscriptionEngine` and `TextInserter` are protocols (fake engine in tests; `RemoteTranscriptionEngine` in production). Capture may start before `ready`; upload and the Listening indicator must not. The app speaks `platform: "macos"` and loads golden JSON from `contracts/dictation-v1/fixtures/`.

**Tech Stack:** Swift 6, SwiftUI, Xcode 26, macOS 13.0+, universal binary, XCTest, `AVAudioEngine`, Carbon `RegisterEventHotKey`, Keychain, `SMAppService`, libopus + libogg via a Swift package (Opus 16 kHz mono ~24 kbps, 20 ms frames, Ogg container).

**Spec:** `docs/superpowers/specs/2026-09-13-macos-client-design.md`, `docs/superpowers/specs/2026-09-13-dictation-protocol.md`.

**Depends on:** `docs/superpowers/plans/2026-09-15-dictation-protocol.md` (fixtures + mock server). Backend is not required for client unit/integration tests; the mock server is.

## Global Constraints

- Deployment target **macOS 13.0**. Universal (Intel + Apple Silicon). Swift 6 language mode.
- Menu-bar-only: `LSUIElement` = `true`. No Dock icon, no main window.
- `platform` is always `"macos"`. `deviceId` is a UUID v4 generated once per install and stored in Keychain.
- `clientVersion` is `"\(marketingVersion)+\(buildNumber)"` from the bundle (example `1.0.0+12`).
- Connecting pill until **mic frames AND `ready`**. Then flush the pre-`ready` encode buffer. Connecting timeout **5 s**.
- Elapsed time and the 10 s no-speech clock start in `recording`, not `connecting`.
- Every non-idle state has a timeout back to `idle`.
- Recordings shorter than **400 ms** are discarded without contacting the server (after stop). Empty/whitespace transcript skips insertion.
- Trailing silence is trimmed before the final flush.
- Primary insertion: save pasteboard → write transcript → `CGEvent` Command-V → restore after `clipboardRestoreDelayMs` (default **150**). Fallback: leave on clipboard + notification.
- Microphone required. Accessibility optional. Input Monitoring never requested.
- Idle: no tap, no socket, no timers beyond the hotkey. After dictation, keep the socket warm **60 s**.
- Client never computes word counts. Display only server `quota` / `wordCount`.
- `unauthenticated` → exactly one refresh + reconnect, then login prompt.
- Non-retryable errors are never retried.
- No offline transcription. Unknown JSON fields ignored.
- Do not implement code signing, notarization, Sparkle, or App Store.
- Use `let`/`var` in Swift as usual; do not add narrating comments.

## File Structure

```
macos/
  TypeByVoice.xcodeproj
  TypeByVoice/
    TypeByVoiceApp.swift
    Info.plist                    LSUIElement, mic usage string
    TypeByVoice.entitlements
    Session/
      SessionState.swift
      SessionCoordinator.swift
    Audio/
      AudioRingBuffer.swift
      AudioCaptureService.swift
      SilenceDetector.swift
      OpusEncoder.swift
    Transcription/
      TranscriptionEngine.swift
      FakeTranscriptionEngine.swift
      RemoteTranscriptionEngine.swift
    Insertion/
      TextInserter.swift
      ClipboardPasteInserter.swift
    Overlay/
      OverlayController.swift
      PillView.swift
    Input/
      HotkeyService.swift
    Permissions/
      PermissionService.swift
    Auth/
      AuthStore.swift
      KeychainStore.swift
    Settings/
      SettingsStore.swift
    Onboarding/
      OnboardingView.swift
  TypeByVoiceTests/
    AudioRingBufferTests.swift
    SilenceDetectorTests.swift
    OpusEncoderTests.swift
    SessionCoordinatorTests.swift
    RemoteTranscriptionEngineTests.swift
    AuthStoreTests.swift
    FixtureLoader.swift           reads ../../contracts/dictation-v1/fixtures
  TypeByVoiceIntegrationTests/
    MockServerPipelineTests.swift
```

Components talk only to `SessionCoordinator`. `FakeTranscriptionEngine` can emit `ready`, `final`, each error code, and silence.

---

### Task 1: Xcode project, LSUIElement, fixture loader

**Files:**
- Create: `macos/TypeByVoice.xcodeproj` (and the app target)
- Create: `macos/TypeByVoice/TypeByVoiceApp.swift`
- Create: `macos/TypeByVoice/Info.plist`
- Create: `macos/TypeByVoiceTests/FixtureLoader.swift`
- Test: `macos/TypeByVoiceTests/FixtureLoaderTests.swift`

**Interfaces:**
- Consumes: `contracts/dictation-v1/fixtures/start.valid.json`.
- Produces: `FixtureLoader.data(named:)` / `FixtureLoader.json(named:)`; app is an agent (`LSUIElement`).

- [ ] **Step 1: Write the failing test**

```swift
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' -only-testing:TypeByVoiceTests/FixtureLoaderTests`
Expected: FAIL (project or `FixtureLoader` missing).

- [ ] **Step 3: Scaffold the app and loader**

Create an Xcode project (File layout above) with:

- `MACOSX_DEPLOYMENT_TARGET = 13.0`
- `SWIFT_VERSION = 6.0`
- `ARCHS = $(ARCHS_STANDARD)` (universal)
- `INFOPLIST_KEY_LSUIElement = YES`
- `NSMicrophoneUsageDescription` = `Type by Voice needs the microphone to dictate.`
- `TypeByVoiceApp`: `@main struct TypeByVoiceApp: App { var body: some Scene { MenuBarExtra("Type by Voice", systemImage: "mic") { ContentView() } } }` — temporary menu extra so the test host launches; Task 10 replaces the extra with the real menu.

`FixtureLoader.swift`:

```swift
enum FixtureLoader {
    static func url(named name: String) throws -> URL {
        let thisFile = URL(fileURLWithPath: #filePath)
        let fixtures = thisFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("contracts/dictation-v1/fixtures")
        let url = fixtures.appendingPathComponent("\(name).json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw NSError(domain: "FixtureLoader", code: 1)
        }
        return url
    }

    static func json(named name: String) throws -> [String: Any] {
        let data = try Data(contentsOf: try url(named: name))
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }
}
```

`#filePath` from `macos/TypeByVoiceTests/` goes up three levels to the repo root.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' -only-testing:TypeByVoiceTests/FixtureLoaderTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos
git commit -m "feat: scaffold macOS agent app and protocol fixture loader"
```

---

### Task 2: Audio ring buffer

**Files:**
- Create: `macos/TypeByVoice/Audio/AudioRingBuffer.swift`
- Test: `macos/TypeByVoiceTests/AudioRingBufferTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces:

```swift
struct AudioRingBuffer: Sendable {
    init(capacitySamples: Int)
    mutating func write(_ samples: [Float])
    mutating func read(count: Int) -> [Float]
    var available: Int { get }
    mutating func clear()
}
```

Capacity for 120 s × 16_000 samples = `1_920_000`. Writes that overflow drop the oldest samples (the 120 s cap is also enforced by the coordinator).

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import TypeByVoice

final class AudioRingBufferTests: XCTestCase {
    func testWriteReadRoundTrip() {
        var buffer = AudioRingBuffer(capacitySamples: 8)
        buffer.write([1, 2, 3])
        XCTAssertEqual(buffer.read(count: 3), [1, 2, 3])
        XCTAssertEqual(buffer.available, 0)
    }

    func testOverflowDropsOldest() {
        var buffer = AudioRingBuffer(capacitySamples: 4)
        buffer.write([1, 2, 3, 4, 5])
        XCTAssertEqual(buffer.read(count: 4), [2, 3, 4, 5])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `xcodebuild test ... -only-testing:TypeByVoiceTests/AudioRingBufferTests`
Expected: FAIL (`AudioRingBuffer` missing).

- [ ] **Step 3: Implement a circular Float buffer**

Single `[Float]` storage, `head`, `count`. `write` copies; if `samples.count > capacity` keep the suffix.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/Audio/AudioRingBuffer.swift macos/TypeByVoiceTests/AudioRingBufferTests.swift
git commit -m "feat: add bounded 16 kHz capture ring buffer"
```

---

### Task 3: Silence detector

**Files:**
- Create: `macos/TypeByVoice/Audio/SilenceDetector.swift`
- Test: `macos/TypeByVoiceTests/SilenceDetectorTests.swift`

**Interfaces:**
- Consumes: 16 kHz mono Float frames.
- Produces:

```swift
struct SilenceDetector {
    var silenceDurationMs: Int // setting, default 3000
    var noSpeechTimeoutMs: Int // setting, default 10000
    mutating func reset()
    mutating func process(samples: [Float], sampleRate: Int) -> SilenceDetector.Event?
    enum Event { case speechStarted, silenceReached, noSpeech }
}
```

Calibrate noise floor from the first ~300 ms of **recording**. Compare short-term RMS against `floor + 8 dB` with 200 ms hangover so a mid-sentence pause does not trip. `silenceReached` only after speech has been seen. `noSpeech` if no speech within `noSpeechTimeoutMs`.

- [ ] **Step 1: Write the failing test**

```swift
final class SilenceDetectorTests: XCTestCase {
    func testNoisyThenQuietEmitsSilenceReached() {
        var detector = SilenceDetector(silenceDurationMs: 300, noSpeechTimeoutMs: 10_000)
        let noise = [Float](repeating: 0.005, count: 1600 * 3) // 300 ms calibrate at 16 kHz
        XCTAssertNil(detector.process(samples: noise, sampleRate: 16_000))
        let speech = (0..<3200).map { Float(sin(Float($0) / 8)) * 0.4 }
        XCTAssertEqual(detector.process(samples: speech, sampleRate: 16_000), .speechStarted)
        let quiet = [Float](repeating: 0.005, count: 1600 * 4)
        XCTAssertEqual(detector.process(samples: quiet, sampleRate: 16_000), .silenceReached)
    }

    func testQuietOnlyEmitsNoSpeech() {
        var detector = SilenceDetector(silenceDurationMs: 3000, noSpeechTimeoutMs: 400)
        let quiet = [Float](repeating: 0.001, count: 16_000)
        XCTAssertEqual(detector.process(samples: quiet, sampleRate: 16_000), .noSpeech)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement RMS + hysteresis**

Keep running RMS in 20 ms windows. `noiseFloor` = max(mean RMS of first 15 windows, 1e-5). Speech if RMS > floor * 2.5 (≈ 8 dB). After speech, count consecutive silent windows; fire `silenceReached` when silent ms ≥ `silenceDurationMs`.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/Audio/SilenceDetector.swift macos/TypeByVoiceTests/SilenceDetectorTests.swift
git commit -m "feat: detect speech and silence with a calibrated noise floor"
```

---

### Task 4: Opus encoder framing

**Files:**
- Create: `macos/TypeByVoice/Audio/OpusEncoder.swift`
- Test: `macos/TypeByVoiceTests/OpusEncoderTests.swift`

**Interfaces:**
- Consumes: 16 kHz mono Float samples.
- Produces:

```swift
protocol OpusEncoding {
    mutating func encode(samples: [Float]) -> [Data] // 20 ms frames, ~24 kbps
    mutating func finish() -> Data // remaining Ogg pages
    mutating func reset()
}
```

Output is concatenated Ogg Opus pages. Server concatenates binary frames into a valid `.ogg`. Use `libopus` 20 ms (`320` samples/frame at 16 kHz), 24_000 bps, application `OPUS_APPLICATION_VOIP`. Pre-skip and identification headers must appear in the first `encode` or an explicit `startStream()` called once per session.

- [ ] **Step 1: Write the failing test**

```swift
final class OpusEncoderTests: XCTestCase {
    func testFirstBytesAreOggS() {
        var encoder = OpusEncoder()
        let frame = [Float](repeating: 0, count: 320)
        let pages = encoder.encode(samples: frame)
        let blob = pages.reduce(into: Data()) { $0.append($1) }
        XCTAssertEqual(Array(blob.prefix(4)), [0x4F, 0x67, 0x67, 0x53]) // "OggS"
    }

    func testTwentyMsFrameProducesBoundedPayload() {
        var encoder = OpusEncoder()
        let frame = [Float](repeating: 0.1, count: 320)
        let pages = encoder.encode(samples: frame)
        let size = pages.reduce(0) { $0 + $1.count }
        XCTAssertGreaterThan(size, 0)
        XCTAssertLessThan(size, 400) // 20 ms at 24 kbps is ~60 bytes plus page overhead
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Add libopus/libogg and implement**

Add a Swift package or xcframework wrapping libopus + libogg (vendored C sources under `macos/Vendor/opus` and `macos/Vendor/ogg` if no SPM package is pinned). `OpusEncoder` writes the OpusHead + OpusTags pages first, then one packet per 320-sample frame. Incomplete last frame is zero-padded in `finish()`.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/Audio/OpusEncoder.swift macos/TypeByVoiceTests/OpusEncoderTests.swift macos/Vendor
git commit -m "feat: encode 16 kHz capture as Ogg Opus frames"
```

---

### Task 5: SessionCoordinator state machine with fake engine

**Files:**
- Create: `macos/TypeByVoice/Session/SessionState.swift`
- Create: `macos/TypeByVoice/Session/SessionCoordinator.swift`
- Create: `macos/TypeByVoice/Transcription/TranscriptionEngine.swift`
- Create: `macos/TypeByVoice/Transcription/FakeTranscriptionEngine.swift`
- Test: `macos/TypeByVoiceTests/SessionCoordinatorTests.swift`

**Interfaces:**
- Consumes: `SilenceDetector.Event`, fake engine events.
- Produces:

```swift
enum SessionState: Equatable {
    case idle
    case connecting
    case recording
    case transcribing
    case inserting
}

protocol TranscriptionEngine: AnyObject {
    func start(requestId: UUID, identity: ClientIdentity) async throws
    func sendAudio(_ data: Data) async
    func stop(durationMs: Int) async
    func cancel() async
    var events: AsyncStream<EngineEvent> { get }
}

enum EngineEvent: Equatable {
    case ready(maxDurationMs: Int, quota: QuotaSnapshot)
    case final(text: String, wordCount: Int, audioMs: Int, quota: QuotaSnapshot)
    case error(code: String, message: String, retryable: Bool, details: [String: String])
}

struct QuotaSnapshot: Equatable {
    var unit: String
    var limit: Int?
    var used: Int
    var resetAt: Date
}

struct ClientIdentity: Equatable {
    var platform: String // always "macos"
    var clientVersion: String
    var deviceId: UUID
}

@MainActor
final class SessionCoordinator {
    private(set) var state: SessionState
    var onStateChange: ((SessionState) -> Void)?
    func hotkeyPressed()
    func escapePressed()
    func micFrame(samples: [Float])
    func tick(now: Date)
}
```

Timeouts (defaults, overridable in tests): connecting 5s, transcribing watchdog 15s, inserting 2s, recording hard cap from settings (120s).

- [ ] **Step 1: Write the failing tests**

```swift
@MainActor
final class SessionCoordinatorTests: XCTestCase {
    func testHotkeyEntersConnectingNotRecording() async {
        let engine = FakeTranscriptionEngine()
        let coordinator = SessionCoordinator(engine: engine, inserter: FakeInserter(), clock: Clock())
        coordinator.hotkeyPressed()
        XCTAssertEqual(coordinator.state, .connecting)
        XCTAssertFalse(coordinator.isListeningUI)
    }

    func testRecordingRequiresFramesAndReady() async {
        let engine = FakeTranscriptionEngine()
        let coordinator = SessionCoordinator(engine: engine, inserter: FakeInserter(), clock: Clock())
        coordinator.hotkeyPressed()
        coordinator.micFrame(samples: [0.1, 0.1])
        XCTAssertEqual(coordinator.state, .connecting)
        engine.emitReady()
        XCTAssertEqual(coordinator.state, .recording)
        XCTAssertTrue(coordinator.isListeningUI)
        XCTAssertGreaterThan(engine.flushedBytes, 0)
    }

    func testConnectingTimesOutAt5s() async {
        let clock = Clock(now: Date(timeIntervalSince1970: 0))
        let coordinator = SessionCoordinator(engine: FakeTranscriptionEngine(), inserter: FakeInserter(), clock: clock)
        coordinator.hotkeyPressed()
        clock.now = Date(timeIntervalSince1970: 5.1)
        coordinator.tick(now: clock.now)
        XCTAssertEqual(coordinator.state, .idle)
        XCTAssertEqual(coordinator.lastError?.code, "session_timeout")
    }
}
```

`FakeTranscriptionEngine` stores encoded bytes sent before `ready` and exposes `flushedBytes` after `emitReady()` (the coordinator must call `sendAudio` for the buffered bytes only once ready). `isListeningUI` is `state == .recording`.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement coordinator + fake**

On hotkey from idle: `state = .connecting`, start tap (inject `AudioCaptureStarting` protocol with a fake that immediately allows `micFrame` from the test), start engine `start`. Transition to `recording` only when `hasMicFrames && hasReady`. Escape or second hotkey in connecting → cancel. Inject `Clock` so tests do not sleep.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/Session macos/TypeByVoice/Transcription macos/TypeByVoiceTests/SessionCoordinatorTests.swift
git commit -m "feat: gate listening UI on mic frames and server ready"
```

---

### Task 6: Remaining coordinator timeouts and stop paths

**Files:**
- Modify: `macos/TypeByVoice/Session/SessionCoordinator.swift`
- Modify: `macos/TypeByVoiceTests/SessionCoordinatorTests.swift`

**Interfaces:**
- Consumes: `SilenceDetector`, settings `silenceDurationMs` (default 3000), `hardCapMs` (120000), `minDurationMs` (400).
- Produces: second hotkey / 3s silence after speech / 120s cap → `transcribing` (after trailing-silence trim). No speech in 10s → idle, insert nothing. `< 400 ms` → idle, no `stop`. Empty final text → skip inserting. Transcribe watchdog → idle + error.

- [ ] **Step 1: Write the failing tests**

```swift
func testSecondHotkeyStopsAndTranscribes() async {
    let engine = FakeTranscriptionEngine()
    let coordinator = makeRecording(engine: engine)
    coordinator.hotkeyPressed()
    XCTAssertEqual(coordinator.state, .transcribing)
    engine.emitFinal(text: "the transcribed text")
    XCTAssertEqual(coordinator.state, .inserting)
}

func testEmptyFinalSkipsInsert() async {
    let inserter = FakeInserter()
    let engine = FakeTranscriptionEngine()
    let coordinator = makeRecording(engine: engine, inserter: inserter)
    coordinator.hotkeyPressed()
    engine.emitFinal(text: "   ")
    XCTAssertEqual(inserter.inserted, [])
    XCTAssertEqual(coordinator.state, .idle)
}

func testShortRecordingDoesNotCallStop() async {
    let engine = FakeTranscriptionEngine()
    let coordinator = makeRecording(engine: engine)
    coordinator.hotkeyPressed() // duration ~0
    XCTAssertEqual(coordinator.state, .idle)
    XCTAssertFalse(engine.stopCalled)
}

func testTranscribeWatchdogReturnsIdle() async {
    let clock = Clock(now: Date(timeIntervalSince1970: 10))
    let engine = FakeTranscriptionEngine()
    let coordinator = makeRecording(engine: engine, clock: clock)
    coordinator.hotkeyPressed()
    clock.now = Date(timeIntervalSince1970: 26)
    coordinator.tick(now: clock.now)
    XCTAssertEqual(coordinator.state, .idle)
}
```

`makeRecording` is a helper that goes idle → connecting → micFrame → emitReady.

For the short-recording test, `recordingStartedAt` equals `clock.now` so duration is 0.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement stop paths**

Track `recordingStartedAt`, `speechSeen`, run `SilenceDetector` only in `recording`. Trim: drop trailing encoded frames that are silence (keep a 100 ms hangover). `minDurationMs` checked against wall clock of `recording`. Watchdog 15s in `transcribing`. After insert callback, `idle`. Keep socket warm flag `until: now + 60s` on the engine.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS (full `SessionCoordinatorTests`).

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/Session/SessionCoordinator.swift macos/TypeByVoiceTests/SessionCoordinatorTests.swift
git commit -m "feat: stop dictation on hotkey silence cap and timeouts"
```

---

### Task 7: RemoteTranscriptionEngine against the mock server

**Files:**
- Create: `macos/TypeByVoice/Transcription/RemoteTranscriptionEngine.swift`
- Test: `macos/TypeByVoiceTests/RemoteTranscriptionEngineTests.swift`

**Interfaces:**
- Consumes: protocol fixtures, `startMockDictateServer` from the contract package (run as a Node process), `ClientIdentity`.
- Produces: `RemoteTranscriptionEngine` opens `ws://` `/v1/dictate` with `Authorization: Bearer <accessToken>`, sends `start` JSON matching `start.valid.json` shape (new `requestId` per session), holds binary until `ready`, then flushes, then streams. Parses `final`/`error`. Ignores unknown fields.

- [ ] **Step 1: Write the failing test**

```swift
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
        try await engine.start(requestId: UUID(uuidString: "3F2B0C8E-1A2B-4C5D-8E9F-0A1B2C3D4E5F")!, identity: .preview)
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
}
```

`MockDictateProcess` spawns `npm run` is too heavy; instead spawn:

```
node --experimental-strip-types contracts/dictation-v1/src/cli-mock.ts
```

Add `contracts/dictation-v1/src/cli-mock.ts` in this task (small): listen, print `MOCK_URL=ws://127.0.0.1:PORT/v1/dictate` to stdout, SIGTERM closes. This is a contract-package addition required by the client tests.

If `emitReady` is already inside the mock on `start`, the engine must not send binary until that message arrives — queue internally if `sendAudio` is called early (coordinator also queues; double-queue is harmless).

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement URLSessionWebSocketTask client + cli-mock**

`cli-mock.ts`:

```ts
import { startMockDictateServer } from './mock-server.js';

const server = await startMockDictateServer({ transcript: 'the transcribed text' });
console.log(`MOCK_URL=${server.url}`);
process.on('SIGTERM', () => { void server.close().then(() => process.exit(0)); });
```

`RemoteTranscriptionEngine` uses `URLSessionWebSocketTask`. Text frames JSONEncoder with keys `type, requestId, codec, container, sampleRate, channels, language, platform, clientVersion, deviceId`. Binary frames `.data`. Map server `error.code` onto `EngineEvent.error`. Close 4401 → `unauthenticated`. Close 4403 → `quota_exceeded`.

`ClientIdentity.preview` = platform macos, version `1.0.0+12`, deviceId from the start fixture.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/Transcription/RemoteTranscriptionEngine.swift macos/TypeByVoiceTests/RemoteTranscriptionEngineTests.swift contracts/dictation-v1/src/cli-mock.ts contracts/dictation-v1/package.json
git commit -m "feat: stream dictation over WebSocket against the mock server"
```

Add `"mock": "node --experimental-strip-types src/cli-mock.ts"` to the contract `package.json` scripts.

---

### Task 8: Text insertion

**Files:**
- Create: `macos/TypeByVoice/Insertion/TextInserter.swift`
- Create: `macos/TypeByVoice/Insertion/ClipboardPasteInserter.swift`
- Test: `macos/TypeByVoiceTests/ClipboardPasteInserterTests.swift`

**Interfaces:**
- Consumes: Accessibility permission boolean from `PermissionService` (injected).
- Produces:

```swift
protocol TextInserter: AnyObject {
    func insert(_ text: String) async
}

enum InsertionMode { case paste, clipboardFallback }
```

`ClipboardPasteInserter.insert`: if accessibility granted, snapshot `NSPasteboard.general` items (types + data), set string, post `CGEvent` key down/up for `kVK_ANSI_V` with `.maskCommand`, wait `restoreDelay`, restore snapshot. If not granted, set string and `NSUserNotification` / `UNUserNotificationCenter` body `Transcript copied. Press ⌘V to paste.`

- [ ] **Step 1: Write the failing test**

```swift
final class ClipboardPasteInserterTests: XCTestCase {
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
```

Do not hit the real pasteboard in unit tests — inject protocols `PasteboardSnapshotting`, `KeyEventPosting`, `UserNotifying`.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement inserter**

Restore delay default 150 ms (`SettingsStore.clipboardRestoreDelayMs`). Production adapters wrap `NSPasteboard` and `CGEvent`.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/Insertion macos/TypeByVoiceTests/ClipboardPasteInserterTests.swift
git commit -m "feat: insert transcripts via clipboard paste with restore"
```

---

### Task 9: Overlay pill

**Files:**
- Create: `macos/TypeByVoice/Overlay/OverlayController.swift`
- Create: `macos/TypeByVoice/Overlay/PillView.swift`
- Test: `macos/TypeByVoiceTests/OverlayControllerTests.swift`

**Interfaces:**
- Consumes: `SessionState`, input level 0...1, elapsed, `EngineEvent.error`, quota snapshot.
- Produces: non-activating `NSPanel` (`becomesKeyOnlyIfNeeded`, `styleMask` `.nonactivatingPanel`), bottom-center of the active `NSScreen`. Mapping:

| State | UI |
|---|---|
| connecting | text `Connecting…`, no waveform |
| recording | live level + elapsed `mm:ss` |
| transcribing | indeterminate progress |
| error (retryable) | message + Retry |
| quota used ≥ 80% of limit | remaining words |
| quota used ≥ limit | limit reached, `resetAt`, Upgrade (button disabled in v1, still visible) |

- [ ] **Step 1: Write the failing test**

```swift
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
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement panel + SwiftUI**

`NSPanel` `level = .statusBar`, `collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]`, `isFloatingPanel = true`. Never `makeKey()`. Position: `screen.visibleFrame.midX - width/2`, `visibleFrame.minY + 64`.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/Overlay macos/TypeByVoiceTests/OverlayControllerTests.swift
git commit -m "feat: show a non-activating connecting and listening pill"
```

---

### Task 10: Hotkey, permissions, auth, onboarding, settings

**Files:**
- Create: `macos/TypeByVoice/Input/HotkeyService.swift`
- Create: `macos/TypeByVoice/Permissions/PermissionService.swift`
- Create: `macos/TypeByVoice/Auth/KeychainStore.swift`
- Create: `macos/TypeByVoice/Auth/AuthStore.swift`
- Create: `macos/TypeByVoice/Settings/SettingsStore.swift`
- Create: `macos/TypeByVoice/Onboarding/OnboardingView.swift`
- Modify: `macos/TypeByVoice/TypeByVoiceApp.swift` (MenuBarExtra: Start/Stop, Settings, Quit)
- Test: `macos/TypeByVoiceTests/AuthStoreTests.swift`
- Test: `macos/TypeByVoiceTests/HotkeyServiceTests.swift`

**Interfaces:**
- Consumes: HTTP `/v1/auth/*` (URLProtocol stub in tests).
- Produces:

```swift
final class HotkeyService {
    func register(keyCode: UInt32, modifiers: UInt32, handler: @escaping () -> Void) throws
    func unregister()
}

final class PermissionService {
    var microphone: PermissionState
    var accessibility: PermissionState
    func requestMicrophone()
    func requestAccessibility() // skippable
}

enum PermissionState { case unknown, granted, denied }

final class AuthStore {
    func register(email: String, password: String) async throws
    func login(email: String, password: String) async throws
    func refreshIfNeeded() async throws
    func logout() async throws
    var accessToken: String? { get }
    var deviceId: UUID { get }
    var clientVersion: String { get }
}

struct SettingsStore {
    var keyCode: UInt32 // default kVK_ANSI_D
    var modifiers: UInt32 // default cmd+shift
    var silenceDurationMs: Int // 3000
    var hardCapMs: Int // 120000
    var clipboardRestoreDelayMs: Int // 150
    var launchAtLogin: Bool
}
```

Hotkey uses Carbon `RegisterEventHotKey` (no event tap). Auth HTTP body always includes `platform`, `clientVersion`, `deviceId`. `deviceId` from Keychain service `app.typebyvoice.device`, created once.

Onboarding: Welcome → sign in/create → mic (blocking) → accessibility (Skip) → hotkey recorder → Done. Launch at login via `SMAppService.mainApp.register()`.

`unauthenticated` handling in coordinator: call `authStore.refreshIfNeeded()` once, reconnect engine, if still failing set error and show login.

- [ ] **Step 1: Write the failing tests**

```swift
final class AuthStoreTests: XCTestCase {
    func testRegisterSendsClientIdentity() async throws {
        let http = FakeHTTP()
        http.enqueue(json: ["accessToken": "a", "refreshToken": "r", "expiresIn": 900])
        let store = AuthStore(http: http, keychain: FakeKeychain(), deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!)
        try await store.register(email: "a@b.co", password: "pw")
        XCTAssertEqual(http.lastBody["platform"] as? String, "macos")
        XCTAssertEqual(http.lastBody["deviceId"] as? String, "9C1E4A2B-7D55-4F3A-9E10-2B8C0D1A4F77".lowercased())
        XCTAssertEqual(store.accessToken, "a")
    }

    func testRefreshOnceThenGivesUp() async {
        let http = FakeHTTP()
        http.statusSequence = [401, 401]
        let store = AuthStore(http: http, keychain: FakeKeychain(refresh: "r"), deviceId: UUID())
        store.forceAccessToken("expired")
        await XCTAssertThrowsError(try await store.refreshIfNeeded())
        XCTAssertEqual(http.calls.filter { $0.contains("/v1/auth/refresh") }.count, 1)
    }
}
```

`HotkeyServiceTests`: register with a fake `HotkeyRegistering` that records `keyCode`/`modifiers`; assert default is command+shift+D.

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL.

- [ ] **Step 3: Implement remaining app shell**

Wire `SessionCoordinator` to `HotkeyService`, `OverlayController`, `ClipboardPasteInserter`, `RemoteTranscriptionEngine`, `AudioCaptureService` (AVAudioEngine prepared at launch, tap started on connecting, stopped on idle). Menu bar: quota remaining from last `ready`/`final`. Settings window is a SwiftUI `Settings` scene (allowed; not a “main window”). Offline: if engine connect fails, pill `Dictation unavailable`, discard audio, settings still open.

Audio capture: convert hardware format to 16 kHz mono Float32 via `AVAudioConverter`, write ring buffer, encoder, detector, coordinator `micFrame`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `xcodebuild test -scheme TypeByVoice -destination 'platform=macOS'`
Expected: PASS (all unit tests).

- [ ] **Step 5: Commit**

```bash
git add macos
git commit -m "feat: add hotkey auth onboarding and settings to the macOS client"
```

---

### Task 11: Integration pipeline vs mock + error matrix

**Files:**
- Create: `macos/TypeByVoiceIntegrationTests/MockServerPipelineTests.swift`
- Modify: `macos/TypeByVoiceTests/SessionCoordinatorTests.swift` (error codes)

**Interfaces:**
- Consumes: `cli-mock`, `FakeTranscriptionEngine.emit(code:)`.
- Produces: one integration test: coordinator + real encoder + `RemoteTranscriptionEngine` + mock server → `final` received. Unit tests: each protocol error code surfaces `retryable` correctly; `unauthenticated` triggers one refresh.

- [ ] **Step 1: Write the failing tests**

```swift
func testEveryErrorCodeSurfacesRetryableFlag() {
    let codes: [(String, Bool)] = [
        ("unauthenticated", false),
        ("quota_exceeded", false),
        ("audio_cap_exceeded", false),
        ("too_long", false),
        ("invalid_request", false),
        ("rate_limited", true),
        ("provider_unavailable", true),
        ("internal", true),
        ("session_timeout", true),
    ]
    for (code, retryable) in codes {
        let engine = FakeTranscriptionEngine()
        let coordinator = makeConnecting(engine: engine)
        engine.emitError(code: code, retryable: retryable)
        XCTAssertEqual(coordinator.lastError?.retryable, retryable, code)
        XCTAssertEqual(coordinator.state, .idle)
    }
}
```

Integration: start mock, run coordinator with a 1 s sine into the encoder, assert `final` text.

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL if error routing missing.

- [ ] **Step 3: Map errors; never retry when `retryable == false`**

Coordinator `retryable` true + Retry button calls `hotkeyPressed` again. `unauthenticated`: `auth.refreshIfNeeded()` once then `engine.start` again; second failure opens onboarding login.

- [ ] **Step 4: Run full test suite**

Run: `xcodebuild test -scheme TypeByVoice -destination 'platform=macOS'`
Expected: PASS.

Manual insertion matrix (document in `macos/README.md`, do not automate): TextEdit, Notes, VS Code, Terminal, Safari text field, each with and without a clipboard manager.

- [ ] **Step 5: Commit**

```bash
git add macos contracts/dictation-v1/src/cli-mock.ts
git commit -m "feat: cover dictation error codes and mock-server integration"
```

---

## Self-review (this plan)

1. **Spec coverage:** component table, state machine + connecting gate + 5s timeout, recording triggers, 400 ms discard, trailing silence trim, insertion + fallback, permissions, onboarding, pill states including quota, offline error, idle resource behaviour, tests (ring buffer, silence, encoder, connecting gate, timeouts, fake engine, mock integration). Deferred signing/updates/languages left out.
2. **Type consistency:** `QuotaSnapshot`, `ClientIdentity`, `EngineEvent`, `SessionState` names match across tasks. Fixture `deviceId` matches protocol plan. Warm socket 60s matches protocol idle timeout.
3. **Placeholders:** none. `cli-mock.ts` is specified. Default hotkey is cmd+shift+D. Restore delay 150 ms.
