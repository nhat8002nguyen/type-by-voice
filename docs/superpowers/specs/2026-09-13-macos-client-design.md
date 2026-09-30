# macOS Client Design

**Date:** 2026-09-13
**Amended:** 2026-09-14 — this client is one implementation of the shared API (`platform: macos`). Pill is Connecting until mic frames and server `ready`, then Listening.
**Amended:** 2026-09-28 — Continuity microphone fallback when no usable local input; see `2026-09-28-continuity-microphone-fallback-design.md`.
**Status:** Design approved, pending spec review
**Depends on:** `2026-09-13-dictation-protocol.md`

Swift 6 / SwiftUI, Xcode 26, deployment target macOS 13.0, universal binary
(Intel and Apple Silicon). Menu-bar-only agent: `LSUIElement` is true, so there
is no Dock icon and no main window.

This app is the v1 official client. It speaks the shared HTTP API and
dictation protocol with `platform: "macos"`. Hotkey, Keychain, Accessibility,
and clipboard insertion are Mac concerns and are not part of the backend
contract.

## Component boundaries

Every component reports to a single `SessionCoordinator` and never calls its
siblings directly. This is what makes each piece testable in isolation.

| Component | Responsibility |
|---|---|
| `SessionCoordinator` | Owns the state machine. The only component that knows the overall flow |
| `HotkeyService` | Registers the global shortcut, emits a toggle event |
| `AudioCaptureService` | Owns `AVAudioEngine`, taps input, converts to 16 kHz mono float; binds a resolved CoreAudio input before capture |
| `AudioInputDeviceManager` | Enumerates CoreAudio inputs; selects default or Continuity/external fallback when default is unusable |
| `SilenceDetector` | Consumes audio frames, reports speech/silence transitions |
| `OpusEncoder` | Converts float frames to an Ogg Opus byte stream |
| `TranscriptionEngine` (protocol) | Streaming session lifecycle, see below |
| `RemoteTranscriptionEngine` | The only implementation: speaks the dictation protocol, including `platform` / `clientVersion` / `deviceId` on `start` |
| `TextInserter` | Gets a string into the frontmost application |
| `OverlayController` | Owns the floating pill window |
| `PermissionService` | Reports microphone and accessibility status, drives prompts |
| `AuthStore` | Tokens in Keychain; stable `deviceId` per install; register/login/refresh send `platform`, `clientVersion`, `deviceId` |
| `Settings` | Hotkey, insertion mode, launch at login, account |

`TranscriptionEngine` and `TextInserter` are protocols because that is where the
real-world uncertainty lives: the engine may gain a second implementation, and
insertion strategies need to change per misbehaving target app. Nothing else
needs an abstraction.

## State machine

States: `idle`, `connecting`, `recording`, `transcribing`, `inserting`.

```
idle --hotkey--> connecting --mic live + ready--> recording --stop--> transcribing --result--> inserting --> idle
                     |                                  |                     |                      |
                     +---- cancel/timeout/error --------+---------------------+----------------------+--> idle
```

**Invariant: every non-idle state has a timeout that returns to `idle`.** A
dictation tool that can hang is worse than one that fails.

The pill must not look like it is listening until `recording`. Showing a live
waveform while the mic route or the socket is still coming up is how the first
words get dropped — the failure Wispr-style 1–2 s “connecting to speaker”
waits exist to prevent.

### Entering `connecting`

Three things happen concurrently. None of them is “listening” yet.

1. The audio tap starts. Before installing the tap, `AudioCaptureService`
   resolves a usable input via `AudioInputDeviceManager`: when the MacBook lid
   is closed, prefer Continuity Camera (iPhone, transport `'ccwd'` / `'ccwl'`);
   when the lid is open, keep the usable system default (built-in Mac mic).
   Binding is app-local on the engine’s input AudioUnit — the system Sound
   default is not changed. Details:
   `2026-09-28-continuity-microphone-fallback-design.md`.
   `AVAudioEngine` is prepared once at app launch and kept ready, so starting
   a capture costs milliseconds rather than tens when a device is available.
   If no usable device exists, fail immediately with `no_input_device` rather
   than silent no-op. Encoded bytes go into a local buffer; they are not sent
   yet.
2. The pill appears in **Connecting**.
3. The WebSocket is opened and `start` is sent, unless a warm connection from a
   recent dictation is still alive.

Transition to `recording` only when **both** are true: the tap is producing
frames, and `ready` has arrived. Then flush the pre-`ready` buffer as the first
binary frames.

If that does not happen within **5 s**, abort, discard the buffer, and show an
error. Do not sit on a fake Recording state. A second hotkey or Escape during
`connecting` cancels.

On a warm socket, Connecting should be tens of milliseconds. Cold TLS plus
`ready` is longer. Future iOS/Android clients use the same state because
activating the audio session (mic vs speaker, Bluetooth) often takes 1–2 s.

### While `recording`

This is the only state that means “speak now.” Elapsed time and the
no-speech-in-10 s clock start here, not during `connecting`.

Captured frames go to a preallocated ring buffer as 16 kHz mono floats — the
format the encoder wants, so no conversion happens at the end. The same frames
feed `SilenceDetector` and `OpusEncoder`. Encoded bytes are streamed to the
server as they are produced, so upload finishes while the user is still
speaking.

`SilenceDetector` calibrates a noise floor from the first ~300 ms of
`recording` and compares short-term loudness against it with hysteresis, so a
pause mid-sentence does not trip it and a noisy room does not defeat it.

Recording ends on any of:

| Trigger | Result |
|---|---|
| Second hotkey press | Transcribe (the low-latency path) |
| 3 s of continuous silence after speech | Transcribe |
| 120 s hard cap | Transcribe what was captured |
| No speech ever detected within 10 s | Discard, insert nothing, return to idle |
| Escape key | Cancel, discard, insert nothing |
| Audio device disappears | Abort with an error |

The silence threshold and hard cap are settings, not constants.

### Entering `transcribing`

Trailing silence is trimmed before the final bytes are flushed. This is not a
micro-optimisation: Whisper-family models invent text when fed silence, so
trimming improves output quality as well as cost.

Recordings shorter than 400 ms are discarded without contacting the server.

A watchdog bounds this state. If no `final` or `error` arrives within the
watchdog window, the session aborts, the pill reports the failure, and the state
returns to `idle`.

### Entering `inserting`

An empty or whitespace-only transcript skips insertion entirely.

## Text insertion

Primary strategy, used whenever Accessibility permission is granted:

1. Save the current pasteboard contents, including item types.
2. Write the transcript to the pasteboard.
3. Synthesise Command-V via `CGEvent`.
4. Restore the saved contents after a short delay.

This is chosen over writing directly to the focused element through the
accessibility API, which is cleaner but fails in Electron apps, terminals, and
browsers — most of where dictation actually happens.

The restore delay is the fiddly part, since clipboard-manager apps can observe
the intermediate state. It is a setting with a sensible default, and known
incompatible apps get documented rather than worked around.

Fallback strategy, used when Accessibility permission is absent or denied: leave
the transcript on the clipboard and post a notification telling the user to
paste. The app remains fully functional in this mode. A dictation tool that
refuses to work until a scary permission is granted is a tool people abandon
during onboarding.

## Permissions

| Permission | Required? | Why |
|---|---|---|
| Microphone | Yes | Capture |
| Accessibility | No, degrades | Synthesising the paste keystroke |
| Input Monitoring | Never requested | Avoided by using Carbon `RegisterEventHotKey` rather than an event tap |

The hotkey API choice is deliberate: the Carbon API works without any permission
prompt. The tradeoff is that modifier-only shortcuts (for example "hold right
Option") are not expressible. Given the chosen toggle interaction, an ordinary
key combination is sufficient.

## Onboarding

Welcome → sign in or create account → microphone permission → accessibility
permission (skippable) → choose hotkey → done.

Every step is re-checkable later from Settings. Launch at login is offered
through `SMAppService`.

## Overlay pill

A non-activating `NSPanel` hosting SwiftUI content, positioned near the bottom
centre of the active screen. It must never steal focus, or the paste would land
in the wrong place.

| State | Display |
|---|---|
| Connecting | Explicit wait — not a live waveform. Safe to speak only after this leaves |
| Recording (listening) | Live input level, elapsed time |
| Transcribing | Indeterminate progress |
| Error | Message, and a retry affordance when the error is retryable |
| Quota low | Remaining words, shown when under 20% of the limit |
| Quota exhausted | Limit reached, reset date, upgrade affordance. Shown after a finishing utterance that crossed the cap, and on every later hotkey until reset |

Elapsed time is always visible while recording so the session never looks
ambiguous. It starts when listening begins.

## Offline and error behaviour

There is no offline transcription. With no network or an unreachable backend,
the pill reports that dictation is unavailable and the audio is discarded. The
rest of the app — settings, account, transcript history — remains usable.

Errors are surfaced from the protocol's `code` and `retryable` fields. The
client never retries a non-retryable error. `unauthenticated` triggers exactly
one token refresh and reconnect attempt before surfacing a login prompt.

## Resource behaviour

| Condition | Behaviour |
|---|---|
| Idle | No audio tap running, no open connection, no timers beyond the hotkey registration |
| Idle CPU | Target under 1% of one core |
| Connecting | Tap running, local encode buffer, socket in flight; pill is Connecting |
| Recording | Ring buffer bounded by the hard duration cap |
| After dictation | Connection held warm for 60 s, then closed |

## Testing

Unit tests cover the ring buffer, `SilenceDetector` against synthesised noisy
and quiet audio, encoder framing, `AudioInputDeviceManager` selection policy
(Continuity preferred over built-in default; USB/BT default kept;
`nil` when nothing usable), the Connecting → Recording gate (no listening
UI before frames + `ready`; flush of the pre-`ready` buffer), and — importantly
— every timeout path in the state machine, since those are the behaviours that
prevent hangs and the ones least likely to be exercised by hand.

`TranscriptionEngine` has a fake implementation for tests that can produce
results, empty results, each error code, and silence.

Integration tests run the real client pipeline against a local mock server built
from the protocol fixtures shared with the backend, so a protocol change breaks
both sides' tests rather than only production.

Manual verification matrix for insertion: native apps (TextEdit, Notes), an
Electron app (VS Code, Slack), a terminal, and a browser text field, each with
and without a clipboard manager running.

## Deferred

Code signing, notarization, auto-update, App Store distribution, languages
beyond English, custom vocabulary, any post-processing of transcripts, and a
Settings microphone picker / ranked device list (Continuity fallback in
`2026-09-28-continuity-microphone-fallback-design.md` is automatic only).
