# Continuity Microphone Fallback Design

**Date:** 2026-09-28  
**Status:** Draft — awaiting user review  
**Depends on:** `2026-09-13-macos-client-design.md`  
**Amends:** macOS client audio capture path only (no protocol or backend changes)

## Problem

On a MacBook used in clamshell mode (lid closed, external display), the built-in
microphone is unavailable. If no headphones or USB mic is connected, the system
default input is unusable. `AudioCaptureService` currently binds to the default
input via `AVAudioEngine` and silently returns when
`inputFormat.sampleRate == 0` or `channelCount == 0`, so dictation never produces
mic frames.

Apple Continuity Camera already exposes a nearby iPhone as a CoreAudio sound
input (transport type Continuity / FourCC `'ccwd'`). macOS does not reliably
auto-select that input when the built-in mic dies. Wispr-style apps detect “no
usable local input” and route to the Continuity mic.

## Goal

When starting capture, if the current default input is not usable, automatically
prefer a Continuity Camera (iPhone) microphone, then any other non-built-in
input. Do not change the user’s system Sound default. Do not switch when a
usable local input already exists.

## Non-goals (v1)

- Settings microphone picker or ranked device list
- Switching the system-wide default input device
- Clamshell-only switching while another USB/BT mic is usable
- Companion iPhone app or custom network audio streaming
- Continuity Camera *video*

## Platform prerequisites (user / OS)

Documented for support copy and onboarding hints; not enforced in code beyond
device enumeration:

- macOS 13+ / iOS 16+ Continuity Camera mic support
- Same Apple Account on Mac and iPhone; Wi-Fi and Bluetooth on; devices nearby
- iPhone in landscape, stationary, screen off while used as Continuity mic
  (Apple requirement)

## Architecture

```
SessionCoordinator.beginConnecting()
        │
        ▼
AudioCaptureService.startCapture()
        │
        ├── AudioInputDeviceManager.defaultInput()  usable? ──yes──► use default
        │                                              │
        │                                             no
        │                                              ▼
        │                         resolveFallback(): Continuity ('ccwd') first,
        │                         else first non-built-in with input channels
        │                                              │
        ├── set AVAudioEngine input AudioUnit device (app-local only)
        └── install tap / start engine (existing path)
```

`SessionCoordinator` stays unaware of Continuity. Device resolution lives under
`macos/TypeByVoice/Audio/`.

## Components

### `AudioInputDevice` (value type)

| Field | Type | Notes |
|---|---|---|
| `id` | `AudioDeviceID` | CoreAudio object ID |
| `uid` | `String` | Stable `kAudioDevicePropertyDeviceUID` |
| `name` | `String` | Localized name for logs / future UI |
| `transportType` | `UInt32` | From `kAudioDevicePropertyTransportType` |
| `isBuiltIn` | `Bool` | `transportType == kAudioDeviceTransportTypeBuiltIn` |
| `isContinuity` | `Bool` | `transportType == 0x63637764` (`'ccwd'`) |

A device is **usable** if it has at least one input channel
(`kAudioDevicePropertyStreamConfiguration` on the input scope with
`mNumberChannels > 0`).

### `AudioInputDeviceManager`

Pure CoreAudio helper (no `AVAudioEngine` ownership):

- `allInputs() -> [AudioInputDevice]` — devices with input channels
- `defaultInput() -> AudioInputDevice?` — current
  `kAudioHardwarePropertyDefaultInputDevice` if usable
- `resolveCaptureDevice() -> AudioInputDevice?` — selection policy below
- `setEngineInputDevice(_ deviceID: AudioDeviceID, on audioUnit: AudioUnit) throws`
  — sets `kAudioOutputUnitProperty_CurrentDevice` on the engine’s input node
  audio unit

Selection policy for `resolveCaptureDevice()`:

1. If `defaultInput()` is usable → return it (no Continuity preference).
2. Else prefer the first Continuity (`isContinuity`) usable input.
3. Else prefer the first non-built-in usable input.
4. Else return `nil`.

### `AudioCaptureService` changes

Before installing the tap in `startCapture()`:

1. Call `resolveCaptureDevice()`.
2. If `nil`, do **not** silent-return: surface failure so connecting can fail
   with a clear error (see Error handling).
3. If non-nil and not already the engine’s current device, set the input
   AudioUnit device, then re-query `inputFormat` and proceed as today.

`prepareEngine()` at launch stays as-is (no Continuity bind until capture).

Optional observability for debugging: `private(set) var activeInputUID: String?`
updated when a device is bound.

### Protocol / coordinator

Prefer a small, explicit failure path over relying only on the 5 s connecting
timeout:

- Extend `AudioCaptureStarting` so `startCapture()` can signal failure, e.g.
  `func startCapture() throws` with an error whose `code` maps to
  `no_input_device`, **or** return `Bool` / set `lastStartError` that
  `SessionCoordinator` checks immediately after `startCapture()`.
- On failure: `failToIdle(code: "no_input_device", message: "No microphone available. Connect a mic or use Continuity Camera with your iPhone.", retryable: true)`.

If Continuity is selected but the phone never starts delivering frames, keep the
existing connecting timeout (`hasMicFrames` never becomes true).

## Data flow

1. User presses hotkey → `beginConnecting()` → `audioCapture.startCapture()`.
2. Manager reads default input; if usable, engine keeps/binds that device.
3. If unusable, manager picks Continuity if present, else other external input.
4. Capture service sets the AudioUnit device (app-local), installs tap, starts
   engine.
5. Frames flow unchanged into ring buffer → Opus → existing session path.

Device list is refreshed on each `startCapture()` (devices appear/disappear when
the iPhone connects). No background polling required for v1.

## Error handling

| Situation | Behavior |
|---|---|
| Default input usable | Use it; no Continuity switch |
| Default unusable, Continuity present | Bind Continuity; continue |
| Default unusable, no Continuity, USB/BT mic present | Bind that external input |
| No usable inputs at all | Immediate `no_input_device` failure |
| Continuity bound but no frames within connecting timeout | Existing connecting timeout / abort |
| Permission denied | Existing microphone permission path (unchanged) |
| Device disappears mid-recording | Existing “Audio device disappears” abort (unchanged) |

Do **not** mutate `kAudioHardwarePropertyDefaultInputDevice`.

## Testing

Unit-test `AudioInputDeviceManager` selection with a injectable device list
(protocol or package-internal seam), not live CoreAudio in CI:

| Case | Expected |
|---|---|
| Usable default (built-in or USB) | Returns default; ignores Continuity |
| Unusable / missing default + Continuity present | Returns Continuity |
| Unusable default + no Continuity + USB present | Returns USB |
| Empty / all unusable | Returns `nil` |

`AudioCaptureService` tests: with a fake manager returning `nil`,
`startCapture` surfaces failure; with a fake returning a device id, binding is
attempted (mock AudioUnit setter if needed). Keep existing
`prepareImmediately: false` test pattern for XCTest host.

Manual verification (developer machine):

1. Lid open, built-in mic → dictation works (no Continuity forced).
2. Clamshell, no USB/BT mic, iPhone Continuity available → dictation uses iPhone.
3. Clamshell, USB mic plugged → USB preferred over Continuity when default or
   only external usable path applies per policy (default usable → keep default).
4. No devices → clear error, not silent hang until timeout only.

## Files

| Path | Action |
|---|---|
| `macos/TypeByVoice/Audio/AudioInputDevice.swift` | Create |
| `macos/TypeByVoice/Audio/AudioInputDeviceManager.swift` | Create |
| `macos/TypeByVoice/Audio/AudioCaptureService.swift` | Modify — resolve + bind before tap |
| `macos/TypeByVoice/Session/AudioCaptureStarting.swift` | Modify — failure signaling |
| `macos/TypeByVoice/Session/SessionCoordinator.swift` | Modify — handle capture start failure |
| `macos/TypeByVoiceTests/AudioInputDeviceManagerTests.swift` | Create |
| `macos/TypeByVoiceTests/…` | Adjust fakes / capture start failure tests as needed |

## Success criteria

- Clamshell + Continuity iPhone mic → dictation records without plugging a
  dedicated headset/USB mic.
- Open lid / usable default → behavior unchanged (no forced Continuity).
- System Sound → Input preference left alone.
- No usable mic → user-visible error with Continuity hint, not silent failure.
