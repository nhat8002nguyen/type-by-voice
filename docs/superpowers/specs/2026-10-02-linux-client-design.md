# Linux Client Design

**Date:** 2026-10-02
**Status:** Design approved, pending spec review
**Depends on:** `2026-09-13-dictation-protocol.md`, `2026-09-13-type-by-voice-overview.md`, `2026-09-13-macos-client-design.md`

Go 1.24+ (latest stable at implementation time) / GTK4, single-instance tray
agent, targeting **Ubuntu 22.04 LTS as the
floor** through 24.04 / 24.10 / 25.04 (amd64 as the shipping architecture,
arm64 supported for development VMs).

This app is the third official client. It speaks the shared HTTP API and
dictation protocol with `platform: "linux"`. Hotkey, audio capture, clipboard
insertion, and the overlay pill are Linux concerns and are not part of the
backend contract. The backend does **not** yet accept `platform: "linux"` — the
enum and DTO validation must be extended server-side before this client ships,
exactly as was done for `windows` (see Prerequisites below).

Scope is **full macOS parity, built in phases**: the core dictation loop first,
then auth/onboarding/settings, then parity surfaces (dashboard, hotkey
recorder, mic picker), then Wayland best-effort and packaging. The macOS client
remains the behavioural reference; where Linux genuinely cannot match it
(global hotkey and synthesized paste on Wayland), this design degrades
honestly instead of pretending.

## Project structure

Two layers mirror the macOS client's separation of testable logic from
platform UI. The split line is **cgo**: pure-Go packages compile and unit-test
on the developer's Mac; cgo packages build only on Linux (VM or CI).

```
linux/
  core/                    # pure Go, CGO_ENABLED=0 — `go test` runs on macOS
    session/               SessionCoordinator, SessionState, SessionTimeouts
    transcription/         RemoteTranscriptionEngine, dictation protocol messages
    audio/                 SilenceDetector, AudioRingBuffer, OggFramer (pure Go), OpusEncoder interface
    auth/                  AuthStore, AuthHttpClient, ITokenStore
    settings/              SettingsStore, HotkeyFormatter
    platform/              IAudioCapture, ITextInserter, IHotkey, IClipboard, IPill  (interfaces only)
  app/                     # cgo, Linux-only (gotk4, malgo, xgb, appindicator)
    capture/               MiniaudioCapture (implements IAudioCapture)
    hotkey/                X11HotkeyService (implements IHotkey), WaylandHotkeyFallback
    insert/                X11PasteInserter, WaylandBestEffortInserter (implement ITextInserter)
    overlay/               Pill (GTK4 non-activating window)
    tray/                  AppIndicator tray
    ui/                    Onboarding, Settings, Dashboard (GTK4 windows)
  cmd/typebyvoice/         main.go
```

Everything testable lives in `core/` (no cgo, no GTK4, no X11) so it builds and
runs on the developer's Mac. The `app/` layer is a thin shell of Linux-native
interop.

## Component boundaries

Every component reports to a single `SessionCoordinator` and never calls its
siblings directly. This is what makes each piece testable in isolation.

| Component | Responsibility |
|---|---|
| `SessionCoordinator` | Owns the state machine. The only component that knows the overall flow |
| `IHotkey` / `X11HotkeyService` | Registers the global shortcut via `XGrabKey`, emits a toggle event |
| `IAudioCapture` / `MiniaudioCapture` | Captures via miniaudio (ALSA + PulseAudio backends), delivers 16 kHz mono PCM |
| `SilenceDetector` | Consumes PCM frames, reports speech/silence transitions |
| `OpusEncoder` | Converts PCM frames to a continuous Ogg Opus byte stream (see below) |
| `RemoteTranscriptionEngine` | The only `TranscriptionEngine` implementation: speaks the dictation protocol, including `platform` / `clientVersion` / `deviceId` on `start` |
| `ITextInserter` / `X11PasteInserter` / `WaylandBestEffortInserter` | Gets a string into the frontmost application |
| `IClipboard` | Save/restore of clipboard contents around the paste |
| `IPill` / `Pill` | Owns the floating pill window |
| `AuthStore` | Tokens in the Secret Service; stable `deviceId` per install; register/login/refresh send `platform`, `clientVersion`, `deviceId` |
| `SettingsStore` | Hotkey, silence threshold, hard cap, insertion mode, account email, launch-at-login |

`TranscriptionEngine`, `ITextInserter`, `IAudioCapture`, `IHotkey`, `IClipboard`,
and `ITokenStore` are interfaces because that is where the real-world
uncertainty lives: the engine may gain a second implementation, insertion
strategies change per misbehaving target app, capture and hotkey need fakes for
CI, clipboard save/restore is desktop-dependent, and token storage may swap
from Secret Service to a file. Nothing else needs an abstraction.

## State machine

States: `idle`, `connecting`, `recording`, `transcribing`, `inserting` — a
direct port of the macOS state machine and its timeouts.

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

1. The microphone starts. `MiniaudioCapture` opens the system default capture
   device through miniaudio's PulseAudio backend (which also serves PipeWire
   systems, since `pipewire-pulse` presents the standard PulseAudio socket) with
   an ALSA fallback, and is kept ready after first use so a subsequent dictation
   starts in milliseconds. If no usable device exists, fail immediately with
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

Captured PCM goes to a preallocated ring buffer (16 kHz mono) bounded by the
hard cap. The same frames feed `SilenceDetector` and `OpusEncoder`. Encoded
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

**Capture** uses `malgo` (miniaudio) — one API over **ALSA + PulseAudio**
backends. The PulseAudio backend covers PipeWire as well: Ubuntu 22.04+ ships
`pipewire-pulse`, which presents the standard PulseAudio client socket, so one
code path serves both server implementations. Capture is converted to 16 kHz
mono PCM before it reaches the ring buffer.

**Encoding** is a deliberate split between cgo and pure Go:

- **Opus packet encoding** is cgo: `hraban/opus.v2` wraps `libopus` (16 kHz,
  1 channel, application `VOIP`, ~24 kbps, 20 ms frames).
- **Ogg framing** is our own pure-Go `OggFramer`, because the server
  concatenates the received bytes into a valid `.ogg` without re-muxing. The
  stream must be a single continuous logical stream — one serial number,
  monotonic granule positions, pages flushed every ~200 ms (every ~10 frames).

Splitting the framing into pure Go is what lets it be unit-tested on the Mac
with synthetic packets, and it is validated **first** against the
`contracts/dictation-v1` cli-mock before any other feature work (mirrors the
macOS "latency harness first" and Windows "framing first" build orders). If
profiling later shows encode cost matters, swap to a different libopus binding
behind the same interface; the encoder is otherwise invisible to the rest of
the system.

## Text insertion

The primary strategy differs by session type, because Wayland deliberately
blocks untrusted synthesized keystrokes. The session is detected once at
startup from `XDG_SESSION_TYPE` (and re-checked when it can change).

### X11 (full parity)

1. Save the current clipboard contents (text; see clipboard note below).
2. Write the transcript to the clipboard.
3. Synthesize Ctrl+V to the focused window via **XTest**
   (`jezek/xgb` / `xtest` fake-input).
4. Restore the saved contents after a short delay (default 150 ms).

XTest is chosen over `XSendEvent` because many applications ignore synthetic
events but honour XTest. Linux requires **no accessibility-style permission**
for this; insertion just works.

The restore delay remains the fiddly part, since clipboard-manager apps can
observe the intermediate state. It is a setting with a sensible default, and
known incompatible apps get documented rather than worked around. The clipboard
save/restore is text-only for v1; full-format preservation (images, etc.) is
deferred.

### Wayland (best-effort)

If `wtype` (a `wlr-virtual-keyboard` client) is present and the compositor
supports virtual keyboards, use it to synthesize Ctrl+V. Otherwise leave the
transcript on the clipboard and post a notification telling the user to paste.
This is the honest macOS "clipboard-only fallback" — the app remains fully
functional, just without automatic insertion. A dictation tool that refuses to
work until a compositor-specific feature exists is a tool people abandon.

## Global hotkey

| Session | Mechanism |
|---|---|
| X11 | `XGrabKey` via `jezek/xgb` — works with no permission, same rationale as macOS's Carbon `RegisterEventHotKey`. Default `Ctrl+Shift+Space`, configurable. |
| Wayland | No portal-based global hotkey exists on Ubuntu ≤ 24.04's GNOME (the `GlobalShortcuts` portal only lands in newer GNOME/KDE). Best-effort fallback is **click-to-record** on the tray/pill. Document "use *Ubuntu on Xorg* for full hotkey parity" — a one-click login option on every Ubuntu, so full-featured users have a clear path. |

`IHotkey` is the seam: the Wayland fallback implements the same toggle event
from a user click instead of a key grab, so `SessionCoordinator` stays unaware
of the session type.

## Overlay pill

A GTK4 window, positioned near the bottom centre of the active screen, showing
the same five states as macOS.

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

The pill **must never steal focus**, or the paste would land in the wrong
place. On X11 this is an override-redirect window with
`accept-focus=false`, `_NET_WM_WINDOW_TYPE_NOTIFICATION`, and always-on-top —
the Linux analogue of the macOS non-activating `NSPanel`. On Wayland there is
no public non-activating overlay protocol on GNOME; use `accept-focus=false`
plus a popup hint and re-focus the prior window, and **validate this first** —
if a compositor cannot keep it focusless, the pill becomes informational and
insertion degrades to clipboard-only on that session. This is the one risky,
first-to-validate area of the Linux UI, alongside framing.

## Tray and windows

- **Tray:** `libayatana-appindicator` through a thin cgo binding. Ubuntu's GNOME
  ships the AppIndicator extension enabled by default, so a tray icon actually
  shows — this is the Linux stand-in for the macOS menu-bar agent. Single
  instance is enforced with a lock file (`flock` on a file under the XDG state
  directory); a second launch notifies the running instance and exits.
- **Windows (GTK4):** onboarding (welcome → sign in → mic → hotkey → done),
  settings (hotkey recorder, silence threshold, hard cap, insertion mode,
  account, launch-at-login), and the transcript-history dashboard
  (search/delete/export). Every onboarding step is re-checkable later from
  Settings.

Launch at login uses an XDG autostart entry in `~/.config/autostart/`.

## Auth and identity

`platform: "linux"`, `clientVersion`, and `deviceId` are sent on
register/login/refresh and on `start`, exactly as the protocol requires. Token
storage uses the **Secret Service** (D-Bus / GNOME Keyring) via
`zalando/go-keyring`, with a plain-file fallback behind `ITokenStore` for
headless or minimal systems. The stable `deviceId` is generated once per
install and reused for its life.

### Prerequisite (server)

Add `linux` to the server's `platform` enum and to the auth + protocol DTO
validation, and deploy it **before** this client ships. Until then, a Linux
client would be rejected with `invalid_request`. This is an additive change,
identical in shape to the earlier `windows` addition.

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
| Idle | No capture running, no open connection, no timers beyond hotkey registration |
| Idle CPU | Target under 1% of one core |
| Connecting | Capture running, local encode buffer, socket in flight; pill is Connecting |
| Recording | Ring buffer bounded by the hard duration cap |
| After dictation | Connection held warm for 60 s, then closed |

## Permissions

| Permission | Required? | Why |
|---|---|---|
| Microphone | — | Linux has no mic permission gate; capture just works |
| Accessibility | — | No equivalent; XTest needs no prompt |
| Input monitoring | — | `XGrabKey` needs no prompt |

The permissions table is effectively empty. Linux insertion degrades only via
the Wayland clipboard-only fallback, which is a session limitation rather than
an OS grant.

## Packaging

**AppImage + .deb**, matching the "works on every Ubuntu" goal.

- **AppImage:** self-contained, single file, runs on 22.04 → 25.04 (and works
  around GTK4 absence on anything older). Built in CI with `appimagetool` /
  `linuxdeploy`.
- **.deb:** native apt install/upgrade via a hosted apt repo (or PPA), one
  package per Ubuntu release (24.04, 24.10, 25.04; 22.04 as the floor).
  Depends on `libgtk-4-1`, `libayatana-appindicator3`, `libopus0`,
  `libpulse0` / `pipewire-pulse` — all present in the base 22.04 repos.

Deferred: code signing (GPG for the apt repo), auto-update, Snap/Flatpak
(sandboxing breaks the hotkey/paste loop — revisit later, not v1).

## Build, test, and development loop

The developer works on an Apple Silicon Mac, with Ubuntu VMs for interactive
testing. **UTM boots Ubuntu arm64 desktop ISOs (22.04 and 24.04 both work) and
is the right free choice**; Parallels Desktop is smoother (shared clipboard,
snapshots) but paid. Run two VMs — 24.04 (current default) and 22.04 (the
floor).

- **Mac:** `go test ./core/...` — full unit coverage of state machine timeouts,
  silence detector (synthetic noisy/quiet audio), ring buffer, Ogg framing,
  protocol serialization, auth, and settings. Fast iteration; no VM needed.
  Pure Go, so no cross-compile concerns.
- **VMs (UTM):** install `gcc libgtk-4-dev libayatana-appindicator3-dev
  libpulse-dev libasound2-dev libopus-dev`, then `CGO_ENABLED=1 go build`
  natively. Interactive testing only: hotkey, pill focus behaviour, paste,
  tray. These behave identically across arm64/x86_64, so the VM is
  authoritative for UX.
- **CI (GitHub Actions `ubuntu-latest`):** builds the shipping **amd64**
  `.deb` + AppImage, runs the full test suite, and runs pipeline integration
  tests against the `contracts/dictation-v1` cli-mock. amd64 is built in CI
  because cgo → GTK4/libopus/miniaudio does not cross-compile cleanly from
  macOS, and most Ubuntu desktops are amd64.

### Testing

Unit tests (`core/`, run on Mac and Ubuntu CI) cover the ring buffer,
`SilenceDetector` against synthesised noisy and quiet audio, Ogg Opus framing
(continuous stream, page flush cadence), the Connecting → Recording gate (no
listening UI before frames + `ready`; flush of the pre-`ready` buffer),
protocol message serialization, `AuthStore` against a fake HTTP client, and —
importantly — every timeout path in the state machine.

`TranscriptionEngine` has a fake implementation for tests that can produce
results, empty results, each error code, and silence.

Integration tests run the real capture → encode → WebSocket → final pipeline
against the `contracts/dictation-v1` cli-mock so a protocol change breaks both
sides' tests rather than only production.

Manual insertion matrix (do not automate): Gedit, VS Code, GNOME Terminal, and
a browser text field, each under X11 and Wayland, with and without a clipboard
manager running (CopyQ, the GNOME clipboard extension). For each cell, focus an
editable field, dictate a short phrase, verify insert, then verify the previous
clipboard contents are restored after `clipboardRestoreDelayMs`.

## Build order (phased — core loop first, then parity)

1. **Server:** add `platform: "linux"` (enum + DTO validation). Tiny, additive,
   unblocks everything.
2. **Ogg framer + protocol**, validated against the `contracts/dictation-v1`
   cli-mock — the riskiest assumption first.
3. **Core loop:** coordinator + capture + silence + encode → WebSocket → final →
   paste, pill, X11 hotkey. This is "works well" for most users.
4. **Auth/onboarding/settings**, tray, launch-at-login.
5. **Parity surfaces:** transcript dashboard, hotkey recorder UI, mic picker.
6. **Wayland best-effort:** click-to-record, wtype insertion, clipboard-only.
7. **Packaging:** AppImage, then .deb + apt repo.

## Deferred

Code signing (GPG), auto-update, Snap/Flatpak distribution, languages beyond
English, custom vocabulary, any post-processing of transcripts, and
full-format (non-text) clipboard preservation.
