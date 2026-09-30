# Continuity Microphone Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When dictation starts and the system default mic is unusable (e.g. MacBook clamshell), bind an app-local Continuity Camera iPhone mic—or another external input—so capture works without changing the user’s system Sound default; if nothing is usable, fail immediately with `no_input_device`.

**Architecture:** Pure selection policy over an injectable device list lives in `AudioInputDeviceManager`. `AudioCaptureService.startCapture()` resolves + binds the engine input AudioUnit before installing the tap. Failure is signaled via `throws` (`AudioCaptureStartError.noInputDevice`); `SessionCoordinator` maps that to `failToIdle(code: "no_input_device", ...)`. No protocol/backend changes.

**Tech Stack:** Swift, CoreAudio (`AudioDeviceID`, transport types), AVFoundation (`AVAudioEngine` / input AudioUnit), XCTest on macOS.

**Spec:** `docs/superpowers/specs/2026-09-28-continuity-microphone-fallback-design.md` (also reflected in `docs/superpowers/specs/2026-09-13-macos-client-design.md` Connecting section).

## Global Constraints

- Do **not** mutate `kAudioHardwarePropertyDefaultInputDevice` (system Sound → Input stays unchanged).
- Continuity transport FourCC is `0x63637764` (`'ccwd'`). Built-in is `kAudioDeviceTransportTypeBuiltIn`.
- Selection policy (exact order): usable default → first Continuity usable → first non-built-in usable → `nil`.
- A device is usable iff input-scope stream configuration has `mNumberChannels > 0`.
- `startCapture()` failure signaling is **`throws`** (not `Bool` / `lastStartError`) — decided from design review.
- Exact user-facing message on no mic: `"No microphone available. Connect a mic or use Continuity Camera with your iPhone."` with `code: "no_input_device"`, `retryable: true`.
- `prepareEngine()` at launch stays as-is (no Continuity bind until capture).
- Refresh device list on each `startCapture()`; no background polling.
- Xcode uses `PBXFileSystemSynchronizedRootGroup` for `TypeByVoice` / `TypeByVoiceTests` — new files under those folders are picked up automatically; do **not** hand-edit `project.pbxproj` for source membership.
- Under XCTest, `prepareEngine()` still stubs HAL (engine stays `nil`). Keep that early-return so `AppModelErrorTests` stay green; exercise resolve/bind via the injectable seam + coordinator fakes, not live HAL in CI.

## File Structure

```
macos/TypeByVoice/Audio/AudioInputDevice.swift              # NEW — value type + Continuity constant
macos/TypeByVoice/Audio/AudioInputDeviceManager.swift       # NEW — CoreAudio enum + resolve + AudioUnit bind
macos/TypeByVoice/Audio/AudioCaptureStartError.swift        # NEW — thrown from startCapture
macos/TypeByVoice/Audio/AudioCaptureService.swift           # MODIFY — resolve/bind before tap; throws
macos/TypeByVoice/Session/AudioCaptureStarting.swift        # MODIFY — startCapture() throws; FakeAudioCapture
macos/TypeByVoice/Session/SessionCoordinator.swift          # MODIFY — catch → failToIdle no_input_device
macos/TypeByVoiceTests/AudioInputDeviceManagerTests.swift   # NEW — selection policy (injected list)
macos/TypeByVoiceTests/AudioCaptureResolveTests.swift       # NEW — resolve/bind seam + nil throws
macos/TypeByVoiceTests/SessionCoordinatorTests.swift        # MODIFY — startCapture throw → idle + error
```

Existing unchanged behavior: permission path, connecting timeout when Continuity is bound but silent, mid-session “device disappears” abort.

---

### Task 1: `AudioInputDevice` + injectable selection policy

**Files:**
- Create: `macos/TypeByVoice/Audio/AudioInputDevice.swift`
- Create: `macos/TypeByVoice/Audio/AudioInputDeviceManager.swift` (selection + provider protocol first; live CoreAudio filled in Task 2)
- Create: `macos/TypeByVoiceTests/AudioInputDeviceManagerTests.swift`

**Interfaces:**
- Consumes: nothing from later tasks
- Produces:
  - `struct AudioInputDevice: Equatable` with `id: AudioDeviceID`, `uid: String`, `name: String`, `transportType: UInt32`, `isBuiltIn: Bool`, `isContinuity: Bool`
  - `enum AudioInputDeviceTransport` with `static let continuity: UInt32 = 0x63637764`
  - `protocol AudioInputDeviceListing` with `func listedInputs() -> [AudioInputDevice]` and `func listedDefaultInputID() -> AudioDeviceID?`
  - `final class AudioInputDeviceManager` with `init(listing: AudioInputDeviceListing)`, `func allInputs() -> [AudioInputDevice]`, `func defaultInput() -> AudioInputDevice?`, `func resolveCaptureDevice() -> AudioInputDevice?`
  - `resolveCaptureDevice()` policy: usable default → first Continuity → first non-built-in → `nil` (all from `allInputs()`; “usable” = present in that list)

- [ ] **Step 1: Write the failing tests**

```swift
import CoreAudio
import XCTest
@testable import TypeByVoice

private struct FakeListing: AudioInputDeviceListing {
    var inputs: [AudioInputDevice]
    var defaultID: AudioDeviceID?

    func listedInputs() -> [AudioInputDevice] { inputs }
    func listedDefaultInputID() -> AudioDeviceID? { defaultID }
}

private func device(
    id: AudioDeviceID,
    uid: String,
    name: String,
    transport: UInt32,
) -> AudioInputDevice {
    AudioInputDevice(
        id: id,
        uid: uid,
        name: name,
        transportType: transport
    )
}

@MainActor
final class AudioInputDeviceManagerTests: XCTestCase {
    func testUsableDefaultPreferredOverContinuity() {
        let builtIn = device(
            id: 1,
            uid: "builtin",
            name: "MacBook Mic",
            transport: kAudioDeviceTransportTypeBuiltIn
        )
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuity
        )
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [builtIn, continuity], defaultID: 1)
        )
        XCTAssertEqual(manager.resolveCaptureDevice(), builtIn)
    }

    func testContinuityWhenDefaultMissing() {
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuity
        )
        let usb = device(
            id: 3,
            uid: "usb",
            name: "USB Mic",
            transport: kAudioDeviceTransportTypeUSB
        )
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [usb, continuity], defaultID: nil)
        )
        XCTAssertEqual(manager.resolveCaptureDevice(), continuity)
    }

    func testUnusableDefaultIDNotInInputsFallsThroughToContinuity() {
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuity
        )
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [continuity], defaultID: 99)
        )
        XCTAssertEqual(manager.resolveCaptureDevice(), continuity)
    }

    func testUSBWhenNoContinuityAndNoDefault() {
        let usb = device(
            id: 3,
            uid: "usb",
            name: "USB Mic",
            transport: kAudioDeviceTransportTypeUSB
        )
        let builtIn = device(
            id: 1,
            uid: "builtin",
            name: "MacBook Mic",
            transport: kAudioDeviceTransportTypeBuiltIn
        )
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [builtIn, usb], defaultID: nil)
        )
        XCTAssertEqual(manager.resolveCaptureDevice(), usb)
    }

    func testEmptyReturnsNil() {
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [], defaultID: nil)
        )
        XCTAssertNil(manager.resolveCaptureDevice())
    }

    func testOnlyUnusableBuiltInWithDefaultIDMissingFromListReturnsNil() {
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [], defaultID: 1)
        )
        XCTAssertNil(manager.resolveCaptureDevice())
    }

    func testContinuityFlagOnDevice() {
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuity
        )
        XCTAssertTrue(continuity.isContinuity)
        XCTAssertFalse(continuity.isBuiltIn)
    }
}
```

- [ ] **Step 2: Run tests — expect FAIL (types missing)**

Run:
```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests/AudioInputDeviceManagerTests
```

Expected: compile failure for `AudioInputDevice` / `AudioInputDeviceManager` / `AudioInputDeviceListing`.

- [ ] **Step 3: Implement model + manager selection (stub listing for live CoreAudio later)**

`macos/TypeByVoice/Audio/AudioInputDevice.swift`:

```swift
import CoreAudio
import Foundation

enum AudioInputDeviceTransport {
    /// Continuity Camera microphone FourCC `'ccwd'`.
    static let continuity: UInt32 = 0x63637764
}

struct AudioInputDevice: Equatable {
    var id: AudioDeviceID
    var uid: String
    var name: String
    var transportType: UInt32

    var isBuiltIn: Bool {
        transportType == kAudioDeviceTransportTypeBuiltIn
    }

    var isContinuity: Bool {
        transportType == AudioInputDeviceTransport.continuity
    }
}
```

`macos/TypeByVoice/Audio/AudioInputDeviceManager.swift` (selection only for this task):

```swift
import CoreAudio
import Foundation

protocol AudioInputDeviceListing {
    func listedInputs() -> [AudioInputDevice]
    func listedDefaultInputID() -> AudioDeviceID?
}

final class AudioInputDeviceManager {
    private let listing: AudioInputDeviceListing

    init(listing: AudioInputDeviceListing) {
        self.listing = listing
    }

    func allInputs() -> [AudioInputDevice] {
        listing.listedInputs()
    }

    func defaultInput() -> AudioInputDevice? {
        guard let id = listing.listedDefaultInputID() else { return nil }
        return allInputs().first { $0.id == id }
    }

    func resolveCaptureDevice() -> AudioInputDevice? {
        if let defaultInput = defaultInput() {
            return defaultInput
        }
        let inputs = allInputs()
        if let continuity = inputs.first(where: \.isContinuity) {
            return continuity
        }
        return inputs.first { !$0.isBuiltIn }
    }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run the same `xcodebuild test ... AudioInputDeviceManagerTests` command.
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/Audio/AudioInputDevice.swift \
  macos/TypeByVoice/Audio/AudioInputDeviceManager.swift \
  macos/TypeByVoiceTests/AudioInputDeviceManagerTests.swift
git commit -m "$(cat <<'EOF'
feat(macos): add Continuity-aware input device selection policy

EOF
)"
```

---

### Task 2: Live CoreAudio listing + AudioUnit device bind

**Files:**
- Modify: `macos/TypeByVoice/Audio/AudioInputDeviceManager.swift`
- Modify: `macos/TypeByVoiceTests/AudioInputDeviceManagerTests.swift` (only if needed for `LiveCoreAudioListing` compile; no live HAL assertions in CI)

**Interfaces:**
- Consumes: `AudioInputDevice`, `AudioInputDeviceListing`, `AudioInputDeviceManager` from Task 1
- Produces:
  - `struct LiveCoreAudioListing: AudioInputDeviceListing` — enumerates devices with input channels via CoreAudio; default from `kAudioHardwarePropertyDefaultInputDevice`
  - `AudioInputDeviceManager()` convenience init using `LiveCoreAudioListing()`
  - `func setEngineInputDevice(_ deviceID: AudioDeviceID, on audioUnit: AudioUnit) throws` on `AudioInputDeviceManager`
  - Do **not** write `kAudioHardwarePropertyDefaultInputDevice`

- [ ] **Step 1: Extend manager with live listing + bind (no new failing test required for HAL; selection already covered)**

Replace/extend `AudioInputDeviceManager.swift` so it contains:

```swift
import AudioToolbox
import CoreAudio
import Foundation

protocol AudioInputDeviceListing {
    func listedInputs() -> [AudioInputDevice]
    func listedDefaultInputID() -> AudioDeviceID?
}

struct LiveCoreAudioListing: AudioInputDeviceListing {
    func listedInputs() -> [AudioInputDevice] {
        deviceIDs().compactMap { id -> AudioInputDevice? in
            guard inputChannelCount(id) > 0 else { return nil }
            return AudioInputDevice(
                id: id,
                uid: stringProperty(id, kAudioDevicePropertyDeviceUID) ?? "\(id)",
                name: stringProperty(id, kAudioDevicePropertyDeviceNameCFString) ?? "Input \(id)",
                transportType: transportType(id)
            )
        }
    }

    func listedDefaultInputID() -> AudioDeviceID? {
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            &id
        )
        guard status == noErr, id != kAudioObjectUnknown else { return nil }
        return id
    }

    private func deviceIDs() -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &dataSize
        ) == noErr else {
            return []
        }
        let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var ids = [AudioDeviceID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &dataSize,
            &ids
        ) == noErr else {
            return []
        }
        return ids
    }

    private func inputChannelCount(_ id: AudioDeviceID) -> Int {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &dataSize) == noErr,
              dataSize > 0 else {
            return 0
        }
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: Int(dataSize),
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &dataSize, raw) == noErr else {
            return 0
        }
        let list = raw.assumingMemoryBound(to: AudioBufferList.self)
        var channels = 0
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        for buffer in buffers {
            channels += Int(buffer.mNumberChannels)
        }
        return channels
    }

    private func transportType(_ id: AudioDeviceID) -> UInt32 {
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else {
            return 0
        }
        return value
    }

    private func stringProperty(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size = UInt32(MemoryLayout<CFString?>.size)
        var cfString: CFString?
        let status = withUnsafeMutablePointer(to: &cfString) { ptr in
            AudioObjectGetPropertyData(id, &address, 0, nil, &size, ptr)
        }
        guard status == noErr, let cfString else { return nil }
        return cfString as String
    }
}

final class AudioInputDeviceManager {
    private let listing: AudioInputDeviceListing

    init(listing: AudioInputDeviceListing = LiveCoreAudioListing()) {
        self.listing = listing
    }

    func allInputs() -> [AudioInputDevice] {
        listing.listedInputs()
    }

    func defaultInput() -> AudioInputDevice? {
        guard let id = listing.listedDefaultInputID() else { return nil }
        return allInputs().first { $0.id == id }
    }

    func resolveCaptureDevice() -> AudioInputDevice? {
        if let defaultInput = defaultInput() {
            return defaultInput
        }
        let inputs = allInputs()
        if let continuity = inputs.first(where: \.isContinuity) {
            return continuity
        }
        return inputs.first { !$0.isBuiltIn }
    }

    func setEngineInputDevice(_ deviceID: AudioDeviceID, on audioUnit: AudioUnit) throws {
        var deviceID = deviceID
        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceID,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        guard status == noErr else {
            throw NSError(
                domain: NSOSStatusErrorDomain,
                code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "Failed to set input device (\(status))"]
            )
        }
    }
}
```

If `stringProperty` / `AudioBufferList` pointer code needs minor Swift concurrency or CF bridging tweaks to compile, fix until `xcodebuild` succeeds — keep semantics identical.

- [ ] **Step 2: Re-run selection tests + compile app target**

Run:
```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests/AudioInputDeviceManagerTests
```

Expected: PASS (same injected tests; live listing unused in CI).

- [ ] **Step 3: Commit**

```bash
git add macos/TypeByVoice/Audio/AudioInputDeviceManager.swift
git commit -m "$(cat <<'EOF'
feat(macos): enumerate CoreAudio inputs and bind engine device

EOF
)"
```

---

### Task 3: `startCapture() throws` + coordinator `no_input_device`

**Files:**
- Create: `macos/TypeByVoice/Audio/AudioCaptureStartError.swift`
- Modify: `macos/TypeByVoice/Session/AudioCaptureStarting.swift`
- Modify: `macos/TypeByVoice/Session/SessionCoordinator.swift` (`beginConnecting` around line 150)
- Modify: `macos/TypeByVoice/Audio/AudioCaptureService.swift` (minimal: `func startCapture() throws` so it still compiles; full resolve in Task 4)
- Modify: `macos/TypeByVoiceTests/SessionCoordinatorTests.swift`

**Interfaces:**
- Consumes: `failToIdle(code:message:retryable:)` already on `SessionCoordinator`
- Produces:
  - `enum AudioCaptureStartError: Error, Equatable { case noInputDevice }` with `code`, `message`, `retryable` matching Global Constraints
  - `protocol AudioCaptureStarting { func startCapture() throws; func stopCapture() }`
  - `FakeAudioCapture.startError: Error?` — when set, `startCapture()` throws it
  - `SessionCoordinator.beginConnecting()` catches throw **before** entering a lasting connecting session: calls `failToIdle` with capture error fields and returns (does not leave UI stuck waiting for the 5 s timeout)

- [ ] **Step 1: Write the failing coordinator test**

Add to `SessionCoordinatorTests.swift`:

```swift
func testStartCaptureFailureReturnsNoInputDevice() {
    let capture = FakeAudioCapture()
    capture.startError = AudioCaptureStartError.noInputDevice
    let coordinator = SessionCoordinator(
        engine: FakeTranscriptionEngine(),
        inserter: FakeInserter(),
        clock: Clock(),
        audioCapture: capture
    )
    coordinator.hotkeyPressed()
    XCTAssertEqual(coordinator.state, .idle)
    XCTAssertEqual(coordinator.lastError?.code, "no_input_device")
    XCTAssertEqual(
        coordinator.lastError?.message,
        "No microphone available. Connect a mic or use Continuity Camera with your iPhone."
    )
    XCTAssertEqual(coordinator.lastError?.retryable, true)
    XCTAssertFalse(capture.isCapturing)
}
```

- [ ] **Step 2: Run test — expect FAIL**

Run:
```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests/SessionCoordinatorTests/testStartCaptureFailureReturnsNoInputDevice
```

Expected: compile failure (`startError` / `throws` / `AudioCaptureStartError` missing) or test fails because hotkey still enters `.connecting`.

- [ ] **Step 3: Implement error type, protocol, fake, coordinator, and stub `throws` on real service**

`macos/TypeByVoice/Audio/AudioCaptureStartError.swift`:

```swift
import Foundation

enum AudioCaptureStartError: Error, Equatable {
    case noInputDevice

    var code: String {
        switch self {
        case .noInputDevice:
            return "no_input_device"
        }
    }

    var message: String {
        switch self {
        case .noInputDevice:
            return "No microphone available. Connect a mic or use Continuity Camera with your iPhone."
        }
    }

    var retryable: Bool {
        switch self {
        case .noInputDevice:
            return true
        }
    }
}
```

Update `AudioCaptureStarting.swift`:

```swift
import Foundation

@MainActor
protocol AudioCaptureStarting: AnyObject {
    func startCapture() throws
    func stopCapture()
}

final class FakeAudioCapture: AudioCaptureStarting {
    private(set) var isCapturing = false
    var startError: Error?

    func startCapture() throws {
        if let startError {
            throw startError
        }
        isCapturing = true
    }

    func stopCapture() {
        isCapturing = false
    }
}
```

In `SessionCoordinator.beginConnecting()`, replace `audioCapture.startCapture()` with:

```swift
do {
    try audioCapture.startCapture()
} catch let error as AudioCaptureStartError {
    failToIdle(code: error.code, message: error.message, retryable: error.retryable)
    return
} catch {
    failToIdle(
        code: AudioCaptureStartError.noInputDevice.code,
        message: error.localizedDescription,
        retryable: true
    )
    return
}
```

Keep the rest of `beginConnecting()` (transition to `.connecting`, engine start, etc.) **after** the successful `try`.

In `AudioCaptureService`, change signature only for now:

```swift
func startCapture() throws {
    // existing body unchanged (still silent-returns on bad format / nil engine)
    ...
}
```

- [ ] **Step 4: Run coordinator test + full SessionCoordinatorTests**

Run:
```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests/SessionCoordinatorTests
```

Expected: PASS (including `testStartCaptureFailureReturnsNoInputDevice`).

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/Audio/AudioCaptureStartError.swift \
  macos/TypeByVoice/Session/AudioCaptureStarting.swift \
  macos/TypeByVoice/Session/SessionCoordinator.swift \
  macos/TypeByVoice/Audio/AudioCaptureService.swift \
  macos/TypeByVoiceTests/SessionCoordinatorTests.swift
git commit -m "$(cat <<'EOF'
feat(macos): fail connecting immediately when capture start throws

EOF
)"
```

---

### Task 4: Wire resolve/bind into `AudioCaptureService`

**Files:**
- Modify: `macos/TypeByVoice/Audio/AudioCaptureService.swift`
- Create: `macos/TypeByVoiceTests/AudioCaptureResolveTests.swift`

**Interfaces:**
- Consumes: `AudioInputDeviceManager.resolveCaptureDevice()`, `setEngineInputDevice(_:on:)`, `AudioCaptureStartError`
- Produces:
  - `AudioCaptureService` init takes `deviceManager: AudioInputDeviceManager = AudioInputDeviceManager()`
  - `private(set) var activeInputUID: String?` updated when a device is bound
  - Package-visible seam for tests: `func resolveAndBindInput(audioUnit: AudioUnit?) throws -> AudioInputDevice` — resolves; throws `.noInputDevice` if `nil`; if `audioUnit != nil`, calls `setEngineInputDevice`; sets `activeInputUID`
  - `startCapture()` (after `guard let engine`): calls `try resolveAndBindInput(audioUnit: engine.inputNode.audioUnit)` before reading `inputFormat` / installing tap; if format still invalid after bind, throws `.noInputDevice` (no silent return when a real engine exists)
  - XCTest stub path (`engine == nil`): still early-return without throw (unchanged HAL avoid)

- [ ] **Step 1: Write failing resolve/bind tests**

```swift
import CoreAudio
import XCTest
@testable import TypeByVoice

private struct FakeListing: AudioInputDeviceListing {
    var inputs: [AudioInputDevice]
    var defaultID: AudioDeviceID?

    func listedInputs() -> [AudioInputDevice] { inputs }
    func listedDefaultInputID() -> AudioDeviceID? { defaultID }
}

@MainActor
final class AudioCaptureResolveTests: XCTestCase {
    func testResolveAndBindThrowsWhenNoDevice() throws {
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [], defaultID: nil)
        )
        let capture = AudioCaptureService(
            prepareImmediately: false,
            deviceManager: manager
        )
        XCTAssertThrowsError(try capture.resolveAndBindInput(audioUnit: nil)) { error in
            XCTAssertEqual(error as? AudioCaptureStartError, .noInputDevice)
        }
        XCTAssertNil(capture.activeInputUID)
    }

    func testResolveAndBindSetsActiveUIDWithoutAudioUnit() throws {
        let usb = AudioInputDevice(
            id: 3,
            uid: "usb-uid",
            name: "USB Mic",
            transportType: kAudioDeviceTransportTypeUSB
        )
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [usb], defaultID: 3)
        )
        let capture = AudioCaptureService(
            prepareImmediately: false,
            deviceManager: manager
        )
        let bound = try capture.resolveAndBindInput(audioUnit: nil)
        XCTAssertEqual(bound.uid, "usb-uid")
        XCTAssertEqual(capture.activeInputUID, "usb-uid")
    }
}
```

- [ ] **Step 2: Run tests — expect FAIL**

Run:
```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests/AudioCaptureResolveTests
```

Expected: compile failure for `deviceManager` / `resolveAndBindInput` / `activeInputUID`.

- [ ] **Step 3: Implement wiring in `AudioCaptureService`**

Key additions (keep existing tap/convert logic):

```swift
@MainActor
final class AudioCaptureService: AudioCaptureStarting {
    private var engine: AVAudioEngine?
    private var ringBuffer = AudioRingBuffer(capacitySamples: 16_000 * 120)
    private var isTapInstalled = false
    private var isPrepared = false
    private let deviceManager: AudioInputDeviceManager

    var onSamples: (([Float]) -> Void)?
    private(set) var lastLevel: Double = 0
    private(set) var activeInputUID: String?

    private let targetSampleRate: Double = 16_000

    init(
        prepareImmediately: Bool = true,
        deviceManager: AudioInputDeviceManager = AudioInputDeviceManager()
    ) {
        self.deviceManager = deviceManager
        if prepareImmediately {
            prepareEngine()
        }
    }

    func resolveAndBindInput(audioUnit: AudioUnit?) throws -> AudioInputDevice {
        guard let device = deviceManager.resolveCaptureDevice() else {
            throw AudioCaptureStartError.noInputDevice
        }
        if let audioUnit {
            try deviceManager.setEngineInputDevice(device.id, on: audioUnit)
        }
        activeInputUID = device.uid
        return device
    }

    func startCapture() throws {
        prepareEngine()
        guard let engine, !isTapInstalled else { return }

        _ = try resolveAndBindInput(audioUnit: engine.inputNode.audioUnit)

        let input = engine.inputNode
        let inputFormat = input.inputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw AudioCaptureStartError.noInputDevice
        }

        // ... existing converter / installTap / engine.start path ...
        // On engine.start failure: remove tap, isTapInstalled = false, then
        // throw AudioCaptureStartError.noInputDevice (or rethrow) so coordinator
        // does not hang in connecting with a dead tap.
    }

    // prepareEngine / stopCapture / installTap / convert unchanged in behavior
}
```

When `engine.start()` fails, prefer throwing after cleanup so the user gets `no_input_device` / a clear idle error rather than a silent half-started session.

- [ ] **Step 4: Run resolve tests + AppModelErrorTests + SessionCoordinatorTests**

Run:
```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests/AudioCaptureResolveTests \
  -only-testing:TypeByVoiceTests/SessionCoordinatorTests \
  -only-testing:TypeByVoiceTests/AppModelErrorTests
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/TypeByVoice/Audio/AudioCaptureService.swift \
  macos/TypeByVoiceTests/AudioCaptureResolveTests.swift
git commit -m "$(cat <<'EOF'
feat(macos): bind Continuity or external mic before capture tap

EOF
)"
```

---

### Task 5: Full macOS unit suite + manual verification checklist

**Files:**
- Modify (optional status bump only if product owner wants): `docs/superpowers/specs/2026-09-28-continuity-microphone-fallback-design.md` — set Status to `Approved` / `Implemented` after manual pass (do not invent other doc edits)

**Interfaces:**
- Consumes: Tasks 1–4 deliverables
- Produces: green CI-equivalent unit suite; documented manual checks from the spec

- [ ] **Step 1: Run full TypeByVoiceTests**

Run:
```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' \
  -only-testing:TypeByVoiceTests
```

Expected: PASS.

- [ ] **Step 2: Manual verification on a developer Mac (checklist)**

1. Lid open, built-in mic → dictation works; logs/UID should be built-in (no forced Continuity).
2. Clamshell, no USB/BT mic, iPhone Continuity available → dictation uses iPhone (`activeInputUID` / device name in logs if added).
3. Clamshell with USB mic as usable default → USB kept; Continuity not forced.
4. No usable inputs → immediate error with Continuity hint; does **not** wait solely for the 5 s connecting timeout.
5. System Settings → Sound → Input default unchanged after Continuity fallback sessions.

- [ ] **Step 3: Commit only if you bumped spec status**

```bash
git add docs/superpowers/specs/2026-09-28-continuity-microphone-fallback-design.md
git commit -m "$(cat <<'EOF'
docs: mark Continuity microphone fallback design implemented

EOF
)"
```

If status was left as Draft, skip this commit.

---

## Self-Review

**Spec coverage:**
| Spec requirement | Task |
|---|---|
| `AudioInputDevice` fields + Continuity `'ccwd'` | Task 1 |
| Usable = input channels > 0 | Task 2 (`LiveCoreAudioListing`) |
| Selection: default → Continuity → non-built-in → nil | Task 1 |
| Injectable list for CI | Task 1 (`AudioInputDeviceListing`) |
| `setEngineInputDevice` app-local only | Task 2 |
| Resolve/bind before tap; `prepareEngine` unchanged | Task 4 |
| `activeInputUID` observability | Task 4 |
| `startCapture() throws` → `no_input_device` message | Task 3 |
| Connecting timeout still for silent Continuity | Unchanged existing path |
| Permission / mid-session disappear unchanged | No task (leave alone) |
| Manual clamshell / Continuity / USB / empty | Task 5 |

**Placeholder scan:** No TBD/TODO/“similar to Task N” left; concrete code and commands included.

**Type consistency:** `AudioInputDeviceListing`, `AudioInputDeviceManager`, `AudioCaptureStartError.noInputDevice`, `resolveAndBindInput(audioUnit:)`, `FakeAudioCapture.startError`, `startCapture() throws` used consistently across tasks.
