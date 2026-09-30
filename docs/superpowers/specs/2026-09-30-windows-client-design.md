# Windows Client Design

**Date:** 2026-09-30
**Status:** Design approved, pending spec review
**Depends on:** `2026-09-13-dictation-protocol.md`, `2026-09-13-type-by-voice-overview.md`

C# / WPF on .NET 8, single-instance tray agent, targeting `win-x64` (default)
and `win-arm64`. Windows 10 1809+ / Windows 11.

This app is the second official client. It speaks the shared HTTP API and
dictation protocol with `platform: "windows"`. Hotkey, microphone, and clipboard
insertion are Windows concerns and are not part of the backend contract. The
backend already accepts `platform: "windows"` (the auth and quota DTOs include it),
so no server change is required; this client is built independently against the
existing contract.

This is the **MVP** of the Windows client. It delivers the core dictation loop
(hotkey → record → transcribe → paste) with the same latency and reliability
goals as the macOS client, and defers the non-core surfaces.

## Project structure

Two .NET projects mirror the macOS client's separation of testable logic from
platform UI:

```
windows/
  TypeByVoice.Core/              # net8.0 (portable) — builds and unit-tests on macOS
    Session/         SessionCoordinator, SessionState, SessionTimeouts
    Transcription/   RemoteTranscriptionEngine, DictationProtocol messages
    Audio/           SilenceDetector, AudioRingBuffer, OpusEncoder (Ogg Opus)
    Auth/            AuthStore, AuthHttpClient, ITokenStore
    Settings/        SettingsStore, HotkeyFormatter
    Platform/        IAudioCapture, ITextInserter, IHotkey — implemented by the WPF layer
  TypeByVoice.Windows/           # net8.0-windows (WPF) — compiles only on Windows
    App.xaml, tray icon, single-instance mutex
    Hotkeys/         HotkeyService (RegisterHotKey)
    Audio/           WasapiAudioCapture (implements IAudioCapture)
    Insertion/       ClipboardPasteInserter (implements ITextInserter)
    Overlay/         PillWindow
    Views/           OnboardingView, SettingsView
  TypeByVoice.Core.Tests/        # xUnit — runs on macOS and Windows CI
```

Everything testable lives in `TypeByVoice.Core` (`net8.0`, no WPF reference) so
it builds and runs on the developer's Mac. The WPF project is a thin shell of
Windows-native interop and cannot compile on macOS.

## Component boundaries

Every component reports to a single `SessionCoordinator` and never calls its
siblings directly. This is what makes each piece testable in isolation.

| Component | Responsibility |
|---|---|
| `SessionCoordinator` | Owns the state machine. The only component that knows the overall flow |
| `HotkeyService` | Registers the global shortcut via `RegisterHotKey`, emits a toggle event |
| `WasapiAudioCapture` | Captures via NAudio `WasapiCapture`, delivers 16 kHz mono 16-bit PCM |
| `SilenceDetector` | Consumes PCM frames, reports speech/silence transitions |
| `OpusEncoder` | Converts PCM frames to a continuous Ogg Opus byte stream |
| `RemoteTranscriptionEngine` | The only `TranscriptionEngine` implementation: speaks the dictation protocol, including `platform` / `clientVersion` / `deviceId` on `start` |
| `ITextInserter` | Gets a string into the frontmost application |
| `ClipboardPasteInserter` | Clipboard save/restore + synthesized Ctrl+V via `SendInput` |
| `OverlayController` / `PillWindow` | Owns the floating pill window |
| `AuthStore` | Tokens in DPAPI; stable `deviceId` per install; register/login/refresh send `platform`, `clientVersion`, `deviceId` |
| `SettingsStore` | Hotkey, silence threshold, hard cap, insertion mode, account email |

`TranscriptionEngine`, `ITextInserter`, `IAudioCapture`, and `ITokenStore` are
interfaces because that is where the real-world uncertainty lives: the engine
may gain a second implementation, insertion strategies change per misbehaving
target app, capture needs a fake for CI, and token storage may swap from DPAPI
to Credential Manager. Nothing else needs an abstraction.

## State machine

States: `idle`, `connecting`, `recording`, `transcribing`, `inserting` — a direct
port of the macOS state machine and its timeouts.

```
idle --hotkey--> connecting --mic live + ready--> recording --stop--> transcribing --result--> inserting --> idle
                     |                                  |                     |                      |
                     +---- cancel/timeout/error --------+---------------------+----------------------+--> idle
```

**Invariant: every non-idle state has a timeout that returns to `idle`.** A
dictation tool that can hang is worse than one that fails.

The pill must not look like it is listening until `recording`. Showing a live
waveform while the mic route or the socket is still coming up is how the first
words get dropped.

### Entering `connecting`

Three things happen concurrently. None of them is "listening" yet.

1. The microphone starts. `WasapiAudioCapture` uses the system default capture
   device in shared mode; the Windows audio engine performs sample-rate
   conversion to 16 kHz, with NAudio's `MediaFoundationResampler` as a fallback
   if a device cannot deliver 16 kHz directly. The capture device is opened
   once at first use and kept ready so a subsequent dictation starts in
   milliseconds. If no usable device exists, fail immediately with
   `no_input_device` rather than silent no-op. Encoded bytes go into a local
   buffer; they are not sent yet.
2. The pill appears in **Connecting**.
3. The WebSocket is opened and `start` is sent, unless a warm connection from a
   recent dictation is still alive.

Transition to `recording` only when **both** are true: capture is producing
frames, and `ready` has arrived. Then flush the pre-`ready` buffer as the first
binary frames.

If that does not happen within **5 s**, abort, discard the buffer, and show an
error. Do not sit on a fake Recording state. A second hotkey during `connecting`
cancels.

### While `recording`

This is the only state that means "speak now." Elapsed time and the
no-speech-in-10 s clock start here, not during `connecting`.

Captured PCM goes to a preallocated ring buffer (16 kHz mono 16-bit) bounded by
the hard cap. The same frames feed `SilenceDetector` and `OpusEncoder`. Encoded
bytes are streamed to the server as they are produced, so upload finishes while
the user is still speaking.

`SilenceDetector` calibrates a noise floor from the first ~300 ms of `recording`
and compares short-term loudness against it with hysteresis, so a pause
mid-sentence does not trip it and a noisy room does not defeat it.

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

Trailing silence is trimmed before the final bytes are flushed — Whisper-family
models invent text when fed silence.

Recordings shorter than 400 ms are discarded without contacting the server.

A watchdog bounds this state. If no `final` or `error` arrives within the
watchdog window, the session aborts, the pill reports the failure, and the state
returns to `idle`.

### Entering `inserting`

An empty or whitespace-only transcript skips insertion entirely.

## Audio and Opus/Ogg encoding

Capture produces 16 kHz mono 16-bit PCM. `OpusEncoder` wraps the managed
**Concentus** encoder (16 kHz, 1 channel, application `VOIP`, ~24 kbps, 20 ms
frames) and the **Concentus.Oggfile** muxer. No native DLL is shipped, so the
same code builds for both `win-x64` and `win-arm64` without a native toolchain.

The Ogg stream must be a single continuous logical stream — one serial number,
monotonic granule positions, pages flushed every ~200 ms (every ~10 frames) —
because the server concatenates the received bytes into a valid `.ogg` without
re-muxing. This framing is the one subtle risk area and is validated first
against the `contracts/dictation-v1` cli-mock before any other feature work
(mirrors the macOS "latency harness first" build order). If profiling later
shows encode cost matters, swap to native libopus behind the same interface;
the encoder is otherwise invisible to the rest of the system.

## Text insertion

Primary strategy, used by default on Windows:

1. Save the current clipboard contents, including formats.
2. Write the transcript to the clipboard.
3. Synthesize Ctrl+V via `SendInput` to the foreground window.
4. Restore the saved contents after a short delay (default 150 ms).

Windows requires **no accessibility-style permission** for `SendInput`; this is
simpler than macOS. The restore delay remains the fiddly part because clipboard
managers (and Windows clipboard history, Win+V) can observe the intermediate
state. It is a setting with a sensible default; known-incompatible apps are
documented rather than worked around.

Fallback strategy: leave the transcript on the clipboard and post a notification
telling the user to paste. The app remains fully functional in this mode.

## Permissions

| Permission | Required? | Why |
|---|---|---|
| Microphone | Yes | Capture. One-time consent in Windows Settings → Privacy → Microphone; unpackaged apps appear under their executable name |
| Accessibility / UI access | No | Not needed for `SendInput` Ctrl+V |
| Input monitoring | No equivalent | `RegisterHotKey` needs no prompt |

There is no macOS-style Accessibility permission model on Windows; insertion
degrades only via the clipboard-only fallback above, which is an app setting
rather than an OS grant.

## Onboarding

Welcome → sign in or create account → microphone consent → confirm default
hotkey (a simple field; the press-to-record recorder control is deferred) →
done.

Every step is re-checkable later from Settings. Launch at login is deferred.

## Overlay pill

A topmost, transparent, non-activating WPF `Window` (`WindowStyle=None`,
`AllowsTransparency=True`, `Topmost=True`, `ShowActivated=False`, extended styles
`WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`), positioned near the bottom centre of the
active screen. It must never steal focus, or the paste would land in the wrong
place.

| State | Display |
|---|---|
| Connecting | Explicit wait — not a live waveform |
| Recording (listening) | Live input level, elapsed time |
| Transcribing | Indeterminate progress |
| Error | Message, and a retry affordance when the error is retryable |
| Quota low | Remaining words, shown when under 20% of the limit |
| Quota exhausted | Limit reached, reset date, upgrade affordance |

Elapsed time is always visible while recording so the session never looks
ambiguous.

## App shell

Single-instance via a named `Mutex`; a second launch activates the existing
instance. Tray icon via `System.Windows.Forms.NotifyIcon` (with
`UseWindowsForms` enabled) — the only WinForms dependency, for the tray icon
only; swap to `Hardcodet.NotifyIcon.Wpf` later if a WPF-native API is preferred.

## Configuration and endpoints

Endpoint resolution mirrors the macOS client: `TBV_API_URL` and
`TBV_DICTATE_URL` environment variables take precedence, Debug builds fall back
to `http://127.0.0.1:3000` and `ws://127.0.0.1:3000/v1/dictate`, and Release
builds require the values to be baked at publish time. Settings live in
`%APPDATA%\TypeByVoice\settings.json` (`System.Text.Json`). Tokens are stored
via DPAPI (`ProtectedData`, `CurrentUser` scope) in
`%APPDATA%\TypeByVoice\`.

## Offline and error behaviour

There is no offline transcription. With no network or an unreachable backend,
the pill reports that dictation is unavailable and the audio is discarded. The
rest of the app remains usable.

Errors are surfaced from the protocol's `code` and `retryable` fields. The
client never retries a non-retryable error. `unauthenticated` triggers exactly
one token refresh and reconnect attempt before surfacing a login prompt.

## Resource behaviour

| Condition | Behaviour |
|---|---|
| Idle | No capture running, no open connection, no timers beyond hotkey registration |
| Idle CPU | Target under 1% of one core |
| Connecting | Capture running, local encode buffer, socket in flight; pill is Connecting |
| Recording | Ring buffer bounded by the hard duration cap |
| After dictation | Connection held warm for 60 s, then closed |

## Build, test, and development loop

The developer works on a Mac (Apple Silicon), with a Windows 11 ARM64 VM for
interactive testing.

- **Mac:** install the .NET 8 SDK (ARM64 native). `dotnet build` / `dotnet test`
  cover `TypeByVoice.Core` and `TypeByVoice.Core.Tests` directly on the Mac —
  fast iteration on all portable logic.
- **VM:** UTM (free) or Parallels Desktop, Windows 11 ARM64. Builds and runs the
  WPF project (`net8.0-windows`, which cannot compile on macOS). Windows 11
  ARM64 runs `win-arm64` builds natively and `win-x64` via emulation.
- **CI:** GitHub Actions on `windows-latest` builds both RIDs, runs unit tests,
  and runs pipeline integration tests against the `contracts/dictation-v1`
  `cli-mock`, so the VM is only needed for interactive work (hotkey, overlay,
  paste).
- **Publish:** `dotnet publish -r win-x64` (default) and `win-arm64`,
  self-contained; distribution is a zip for the MVP. Code signing, installer,
  and auto-update are deferred.

### Testing

Unit tests (xUnit, run on Mac and Windows CI) cover the ring buffer,
`SilenceDetector` against synthesised noisy and quiet audio, Ogg Opus framing
(continuous stream, page flush cadence), the Connecting → Recording gate (no
listening UI before frames + `ready`; flush of the pre-`ready` buffer), protocol
message serialization, `AuthStore` against a fake HTTP client, and — importantly
— every timeout path in the state machine.

`TranscriptionEngine` has a fake implementation for tests that can produce
results, empty results, each error code, and silence.

Integration tests run the real capture → encode → WebSocket → final pipeline
against the `contracts/dictation-v1` cli-mock (Node) so a protocol change breaks
both sides' tests rather than only production.

Manual insertion matrix (do not automate): Notepad, VS Code, PowerShell/cmd, and
a browser text field, each with and without a clipboard manager running (Ditto,
Windows clipboard history Win+V). For each cell, focus an editable field,
dictate a short phrase, verify insert, then verify the previous clipboard
contents are restored after `clipboardRestoreDelayMs`.

## MVP scope

**In scope:** tray agent + single-instance · global hotkey (toggle; default
`Ctrl+Shift+Space`, configurable) · mic capture → Ogg Opus → WebSocket upload
with pre-`ready` buffering · silence auto-stop (3 s) + manual stop · `final` →
clipboard-paste insertion · pill overlay (connecting/listening/transcribing) ·
auth (register/login/refresh, DPAPI tokens) · settings file + minimal settings
window.

**Deferred:** transcript history/dashboard, custom hotkey recorder UI,
launch-at-login, microphone device picker, code signing, installer/MSIX,
auto-update, Store distribution, languages beyond English, any transcript
post-processing.
