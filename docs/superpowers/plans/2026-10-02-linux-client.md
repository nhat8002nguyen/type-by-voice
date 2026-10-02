# Linux Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Linux dictation client — a single-instance GTK4 tray agent that captures mic audio, encodes it as Ogg Opus, streams it to the shared backend over the dictation v1 protocol, and pastes the transcript at the cursor, matching the macOS client's behaviour on Ubuntu 22.04+.

**Architecture:** A Go module split at the cgo line. `linux/core/` is pure Go (`CGO_ENABLED=0`, no GTK4/X11/libopus) and holds every testable piece — state machine, silence detection, Ogg framing, WebSocket transcription engine, auth, settings, session-type detection — behind platform interfaces. `linux/app/` is the cgo shell (GTK4, miniaudio, libopus, X11) that implements those interfaces and owns the tray, pill, windows, and packaging. Core unit tests run natively on the developer's Mac; the app layer builds on Linux in a Ubuntu VM and GitHub Actions `ubuntu-latest` (amd64).

**Tech Stack:** Go 1.24+, GTK4 (`github.com/diamondburned/gotk4`), miniaudio (`github.com/gen2brain/malgo`), libopus (`gopkg.in/hraban/opus.v2`), X11 (`github.com/jezek/xgb` + `xtest`), `github.com/coder/websocket` (pure Go), `github.com/zalando/go-keyring`, libayatana-appindicator3 (thin cgo binding), AppImage + Debian packaging, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-02-linux-client-design.md`

## Global Constraints

- Go 1.24+; module `github.com/nhat8002nguyen/type-by-voice/linux`; `linux/core/` is pure Go (`CGO_ENABLED=0`, must compile and test on macOS) and `linux/app/` is cgo, Linux-only.
- Target floor Ubuntu 22.04 LTS through 24.04 / 24.10 / 25.04; shipping architecture amd64 (arm64 supported for dev VMs).
- Protocol `platform` value is `"linux"` in both `start` and the auth identity body.
- `start` **also** carries `listInHistory: boolean` (the live contract requires it; see `contracts/dictation-v1/src/types.ts`); `quota.limit` is nullable.
- Audio: capture 16 kHz mono PCM in; Ogg Opus 16 kHz, 1 channel, `VOIP`, ~24 kbps, 20 ms frames (960 samples @ 48 kHz per packet); a single continuous Ogg stream (one serial, monotonic granule positions, pages flushed every ~200 ms = every ~10 packets).
- Timeouts (verbatim from the spec): connecting 5 s; transcribing 15 s; inserting 2 s; recording hard cap 120 s; silence auto-stop 3 000 ms; no-speech 10 000 ms; min duration 400 ms; trailing hangover 0 ms; warm socket 60 s.
- Clipboard restore delay: 150 ms.
- Default hotkey: `Ctrl+Shift+Space`.
- Endpoints: `TBV_API_URL` / `TBV_DICTATE_URL` env vars win; dev fallback `http://127.0.0.1:3000` and `ws://127.0.0.1:3000/v1/dictate`.
- Settings `~/.config/typebyvoice/settings.json` (`XDG_CONFIG_HOME`); single-instance lock `~/.local/state/typebyvoice/instance.lock` (`XDG_STATE_HOME`); tokens via Secret Service with a file fallback; launch-at-login `~/.config/autostart/typebyvoice.desktop`.
- Idle CPU under 1% of one core; no offline transcription; no Linux permission prompts (capture and XTest need none).

## Review Focus

The failure modes most likely to bite a real user, and the task that pins each:

1. **Speech before the mic/socket is live (leading words dropped).** The pill must stay on Connecting and the pre-`ready` audio must be flushed as the first frames. → Task 10 (`TestConnectingGateHoldsPillUntilFramesAndReady`, `TestPreReadyBufferFlushedAsFirstBinaryFrames`).
2. **Trailing silence makes Whisper invent text.** Trailing silence must be trimmed (hangover 0 ms) before the final flush. → Task 10 (`TestTrailingSilenceTrimmedBeforeFinalFlush`).
3. **A hotkey press with no speech records silence and bills for it.** <400 ms recordings are discarded before contacting the server; no-speech within 10 s discards. → Task 10 (`TestNoSpeechWithin10sDiscards`, `TestSub400msIsDiscarded`).
4. **On a Wayland session synthesized paste is impossible — the transcript must not be lost.** The client must detect the session and degrade to clipboard-plus-notify instead of dropping the text. → Task 18 (`TestChooseInsertionStrategy`).
5. **The pill stealing focus sends the paste to the wrong window.** The pill window must be non-focusable; focus must be unchanged after it appears and disappears. → Task 14 (manual verification: focus does not move).

---

## Phase 1 — Contract foundation

### Task 1: Go module scaffold + dictation protocol messages

**Files:**
- Create: `linux/go.mod`
- Create: `linux/core/transcription/protocol.go`
- Test: `linux/core/transcription/protocol_test.go`

**Interfaces:**
- Produces (package `transcription`): `QuotaSnapshot{ Unit string; Limit *int; Used int; ResetAt string }`; `StartMessage{ Type, RequestID, Codec, Container string; SampleRate, Channels int; Language, Platform, ClientVersion, DeviceID string; ListInHistory bool }`; `StopMessage{ Type, RequestID string; DurationMs int64 }`; `CancelMessage{ Type, RequestID string }`; `ReadyMessage{ Type, RequestID string; MaxDurationMs int64; Quota QuotaSnapshot }`; `FinalMessage{ Type, RequestID, Text string; WordCount int; AudioMs int64; Quota QuotaSnapshot }`; `ErrorMessage{ Type, RequestID, Code, Message string; Retryable bool; Details json.RawMessage }`; constructors `NewStart(requestID, clientVersion, deviceID string, listInHistory bool) StartMessage`, `NewStop(requestID string, durationMs int64) StopMessage`, `NewCancel(requestID string) CancelMessage`; and `DecodeServerMessage(data []byte) (ServerMessage, error)` returning `ServerMessage{ Type string; Ready *ReadyMessage; Final *FinalMessage; Error *ErrorMessage }`.
- JSON tags are camelCase and match `contracts/dictation-v1/src/types.ts` exactly (`requestId`, `sampleRate`, `maxDurationMs`, `wordCount`, `audioMs`, `resetAt`, `listInHistory`, `deviceId`).

- [ ] **Step 1: Write failing tests**

`TestStartSerializesToSpecShape` — `NewStart("3f2b", "1.0.0+12", "9c1e…", true)` marshals to `type=="start"`, `platform=="linux"`, `codec=="opus"`, `container=="ogg"`, `sampleRate==16000`, `channels==1`, `language=="en"`, `listInHistory==true`.

`TestStopSerializesToSpecShape` — `NewStop("3f2b", 11800)` → `type=="stop"`, `durationMs==11800`.

`TestCancelSerializesToSpecShape` — `NewCancel("3f2b")` → `type=="cancel"`.

`TestReadyDeserializes` — from the spec's `ready` JSON (nested `"quota":{"unit":"words","limit":2000,"used":312,"resetAt":"…"}`) assert `MaxDurationMs==120000`, `Quota.Limit != nil && *Quota.Limit==2000`, `Quota.Used==312`.

`TestReadyNullLimit` — `"limit": null` → `Quota.Limit == nil`.

`TestFinalDeserializes` — `Text`, `WordCount==42`, `AudioMs==11800`.

`TestErrorDeserializes` — `Code=="quota_exceeded"`, `Retryable==false`, `Details` non-nil.

`TestDecodeIgnoresUnknownFields` — a `final` JSON with an extra `"futureField":1` decodes without error and still reads `WordCount`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./core/transcription/`
Expected: FAIL (package/type undefined).

- [ ] **Step 3: Implement `protocol.go` and `go.mod`**

`NewStart` sets `Type="start"`, `Codec="opus"`, `Container="ogg"`, `SampleRate=16000`, `Channels=1`, `Language="en"`, `Platform="linux"` and leaves the rest to the caller. `DecodeServerMessage` unmarshals into a small struct with only `Type`, then switches to `json.Unmarshal` the full bytes into `ReadyMessage` / `FinalMessage` / `ErrorMessage`; an unknown `type` returns an error. Go's `encoding/json` ignores unknown fields, which satisfies `TestDecodeIgnoresUnknownFields` without extra code.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && go test ./core/transcription/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/go.mod linux/core/transcription
git commit -m "feat(linux): go module and dictation protocol messages"
```

---

### Task 2: Server and shared contract accept `platform: "linux"`

**Files:**
- Modify: `contracts/dictation-v1/src/constants.ts:1`
- Modify: `contracts/dictation-v1/test/constants.test.ts:10-12`
- Modify: `contracts/dictation-v1/test/validate-start.test.ts` (add one case)
- Modify: `backend/apps/api/src/auth/dto/client-identity.dto.ts:5`
- Modify: `backend/libs/quota/src/dto/commit-quota.dto.ts:14`
- Modify: `backend/libs/quota/src/dto/check-quota.dto.ts:11`
- Create: `backend/apps/api/src/auth/dto/client-identity.dto.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PLATFORMS` becomes `['macos','windows','ios','android','linux']`, and every `@IsIn([...])` platform list accepts `'linux'`.

- [ ] **Step 1: Write failing tests**

In `contracts/dictation-v1/test/constants.test.ts`, change the existing assertion to `expect([...PLATFORMS]).toEqual(['macos','windows','ios','android','linux'])`. In `contracts/dictation-v1/test/validate-start.test.ts`, add `accepts platform linux`: a valid `start` body with `platform:'linux'` (and the required `listInHistory:true`) returns `{ ok: true }`.

`backend/apps/api/src/auth/dto/client-identity.dto.spec.ts` — with `plainToInstance` + `validate`: `{platform:'linux',clientVersion:'1.0.0+12',deviceId:'<uuid4>'}` passes; `{platform:'beos', …}` fails.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd contracts/dictation-v1 && npm test` (constants test fails on the changed list; validate-start linux case fails)
Expected: FAIL.

- [ ] **Step 3: Add `'linux'` to the five lists**

Add `'linux'` to `PLATFORMS` in `constants.ts` and to the `@IsIn([...])` decorator in the three DTO files. Grep to confirm no other hardcoded list remains:
`grep -rn "'macos', 'windows', 'ios', 'android'" backend --include=*.ts | grep -v spec`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd contracts/dictation-v1 && npm test` then `cd backend && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/dictation-v1 backend/apps/api/src/auth/dto backend/libs/quota/src/dto
git commit -m "feat(contract,dictation): accept platform linux"
```

---

## Phase 2 — Pure-Go audio core

### Task 3: AudioRingBuffer

**Files:**
- Create: `linux/core/audio/ringbuffer.go`
- Test: `linux/core/audio/ringbuffer_test.go`

**Interfaces:**
- Produces: `NewRingBuffer(capacity int) *RingBuffer`; methods `Capacity() int`, `Len() int`, `Write(samples []int16)`, `Read(dst []int16) int`, `Clear()`. PCM samples are 16-bit; capacity is in samples.

- [ ] **Step 1: Write failing tests**

`TestWriteThenReadRoundTrips` — write `[1,2,3,4]`, read 4, assert order and `Len()==0`.

`TestOverflowOverwritesOldest` — capacity 4, write `[1..8]`, read all, assert surviving samples are `[5,6,7,8]`.

`TestClearEmptiesBuffer` — write, `Clear()`, assert `Len()==0` and read returns 0.

`TestReadDrainsReadSamples` — write 4, read 2, assert `Len()==2` and the next read yields the last two.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./core/audio/`
Expected: FAIL.

- [ ] **Step 3: Implement `RingBuffer`**

Backed by a preallocated `[]int16`; a write exceeding free space advances the read index (overwrite-oldest) instead of growing. `Read` copies out and advances the read index.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && go test ./core/audio/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/core/audio/ringbuffer.go linux/core/audio/ringbuffer_test.go
git commit -m "feat(linux): audio ring buffer"
```

---

### Task 4: SilenceDetector

**Files:**
- Create: `linux/core/audio/silence.go`
- Test: `linux/core/audio/silence_test.go`

**Interfaces:**
- Produces: `NewSilenceDetector(calibrationMs int) *SilenceDetector`; methods `OnSpeechStarted(fn func())`, `OnSilenceStarted(fn func())`, `Process(samples []int16)` (receives 16 kHz mono frames; the default frame size is 20 ms = 320 samples), `Reset()`. Calibration is the first `~300 ms`; transitions fire once per speech/silence run (hysteresis).

- [ ] **Step 1: Write failing tests**

`TestLoudAfterQuietRaisesSpeechStarted` — feed 300 ms near-zero (noise floor) then a loud 500 Hz tone; assert the speech callback fired exactly once.

`TestQuietAfterSpeechRaisesSilenceStarted` — after a loud run, feed 500 ms quiet; assert the silence callback fired exactly once.

`TestBriefPauseDoesNotRaiseSilenceStarted` — loud, 150 ms quiet (below the hold), loud; assert silence never fired.

`TestNoisyRoomCalibrationPreventsFalseSpeech` — 300 ms moderate noise then slightly-louder noise; assert speech does not fire.

`TestResetClearsState` — reach speech, `Reset()`, then quiet; assert no silence callback fires.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./core/audio/`
Expected: FAIL.

- [ ] **Step 3: Implement `SilenceDetector`**

Track short-term loudness (RMS or peak per frame) against a calibrated floor; a `speech` boolean plus a minimum-quiet hold prevents a mid-sentence pause from flipping state. Calibration computes the floor over the first `calibrationMs` regardless of content.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && go test ./core/audio/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/core/audio/silence.go linux/core/audio/silence_test.go
git commit -m "feat(linux): silence detector with calibration and hysteresis"
```

---

### Task 5: OggFramer (pure-Go Ogg Opus framing)

**Files:**
- Create: `linux/core/audio/oggframer.go`
- Test: `linux/core/audio/oggframer_test.go`
- Create: `linux/core/audio/oggtest/reader.go` (test-only Ogg page reader: capture pattern, serial, granule, CRC check)

**Interfaces:**
- Produces: `NewOggFramer(samplesPerPacket uint64) *OggFramer` (960 for 20 ms @ 48 kHz); methods `WritePacket(packet []byte) []byte` returning any completed page bytes (nil when none), `Flush() []byte` returning the current partial page plus the end-of-stream page, `Serial() uint32`.
- The framer emits the `OpusHead` page and the `OpusTags` page before the first audio page; granule positions accumulate `samplesPerPacket` per packet; a page is flushed every 10 packets (200 ms).

- [ ] **Step 1: Write failing tests**

`TestFirstPageIsOpusHead` — `WritePacket([]byte{…})`; output begins with `"OggS"` and the first page body contains `"OpusHead"` with channel count 1 and input sample rate 16000.

`TestSecondPageIsOpusTags` — the second page body contains `"OpusTags"`.

`TestSingleSerialAcrossStream` — the Ogg serial number is constant across all pages; a new `NewOggFramer` yields a different serial.

`TestGranulePositionsMonotonic` — parse pages; granule positions strictly increase across frames.

`TestPageFlushEvery200ms` — write 50 packets (1 s); assert a page boundary appears roughly every 10 packets (allow ±2).

`TestPagesHaveValidCRC` — every emitted page passes the Ogg CRC32 (polynomial `0x04c11db7`, init 0, no reflection, no final XOR) computed over the page with its CRC field zeroed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./core/audio/`
Expected: FAIL.

- [ ] **Step 3: Implement `OggFramer`**

Build `OpusHead` (`"OpusHead"`, version 1, channels 1, pre-skip 312, input sample rate 16000, output gain 0, mapping family 0) and `OpusTags` (`"OpusTags"`, a short vendor string, zero user comments) as two leading pages, then segment audio packets into pages of at most 10 packets, writing granule = cumulative samples at each page end and a valid Ogg CRC into a little-endian page header (`OggS`, version 0, header type, 8-byte granule, 4-byte serial, 4-byte page seq, 4-byte CRC, page-segments byte, segment table).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && go test ./core/audio/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/core/audio/oggframer.go linux/core/audio/oggframer_test.go linux/core/audio/oggtest
git commit -m "feat(linux): pure-go ogg opus framer"
```

---

### Task 6: Encoder seam + fake

**Files:**
- Create: `linux/core/audio/encoder.go`
- Test: `linux/core/audio/encoder_test.go`

**Interfaces:**
- Produces: `type Encoder interface { Encode(pcm []int16) ([]byte, error); Close() error }` and `type FakeEncoder struct{…}` with `NewFakeEncoder()` whose `Encode` returns a deterministic 1-byte packet per 320-sample frame (so framing can be tested without libopus) and records the number of frames encoded.

- [ ] **Step 1: Write failing tests**

`TestFakeEncoderEmitsOnePacketPerFrame` — feed 640 samples (two 20 ms frames) → two `Encode` calls, two packets.

`TestFakeEncoderRejectsPartialFrame` — feed 160 samples → error (a frame must be a whole 320 samples).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./core/audio/`
Expected: FAIL.

- [ ] **Step 3: Implement the `Encoder` interface and `FakeEncoder`**

The real libopus encoder lives in `linux/app/audio` (Task 11); this file defines only the seam so the core pipeline is testable on macOS.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && go test ./core/audio/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/core/audio/encoder.go linux/core/audio/encoder_test.go
git commit -m "feat(linux): encoder seam and fake encoder"
```

---

## Phase 3 — Auth, engine, and state machine

### Task 7: SettingsStore + HotkeyFormatter

**Files:**
- Create: `linux/core/settings/settings.go`
- Create: `linux/core/settings/hotkey.go`
- Test: `linux/core/settings/settings_test.go`

**Interfaces:**
- Produces (package `settings`): `type Hotkey struct { Modifiers []string; Key string }`; `type Store struct { Hotkey Hotkey; SilenceDurationMs int; HardCapMs int; ClipboardRestoreDelayMs int; InsertionMode string; Microphone string; LaunchAtLogin bool; AccountEmail string }`; `Defaults() Store`; `Load(data []byte) (Store, error)`; `(Store) JSON() ([]byte, error)`; `LoadFrom(configDir string) (Store, error)`; `(Store) SaveTo(configDir string) error`; `DisplayLabel(Hotkey) string`; `ApplyRecordedHotkey(mods []string, key string) (Hotkey, bool)`.
- Defaults: `Hotkey{Modifiers:["ctrl","shift"], Key:"space"}`, `SilenceDurationMs:3000`, `HardCapMs:120000`, `ClipboardRestoreDelayMs:150`, `InsertionMode:"paste"`, `Microphone:""`, `LaunchAtLogin:false`.

- [ ] **Step 1: Write failing tests**

`TestDefaultsMatchSpec` — the seven defaults above.

`TestRoundTripPreservesValues` — `Load(s.JSON())` equals `s` for a mutated store.

`TestLoadMalformedJsonReturnsDefaults`.

`TestSaveLoadFromDir` — `SaveTo(t.TempDir())` then `LoadFrom` returns the same store.

`TestApplyRecordedHotkeyRejectsModifierOnly` — `ApplyRecordedHotkey([]string{"ctrl"}, "")` returns `false` and leaves the hotkey unchanged; `ApplyRecordedHotkey([]string{"ctrl","shift"}, "space")` returns `true`.

`TestDisplayLabelCtrlShiftSpace` — `DisplayLabel(Hotkey{[]string{"ctrl","shift"}, "space"}) == "Ctrl+Shift+Space"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./core/settings/`
Expected: FAIL.

- [ ] **Step 3: Implement both files**

Settings serialize via `encoding/json`; `Defaults` returns a fresh value each call. `ApplyRecordedHotkey` rejects a bare modifier key (any key in the ctrl/alt/shift/super set). `DisplayLabel` renders modifiers in order `Ctrl, Alt, Shift, Super` then a key name (`space`→`Space`, single letters uppercase, else the raw key).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && go test ./core/settings/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/core/settings
git commit -m "feat(linux): settings store and hotkey formatter"
```

---

### Task 8: AuthStore + AuthHTTPClient + TokenStore

**Files:**
- Create: `linux/core/auth/tokenstore.go`
- Create: `linux/core/auth/client.go`
- Create: `linux/core/auth/store.go`
- Test: `linux/core/auth/store_test.go` (with `fakeTokenStore` and `fakeHTTPClient` in the test file)

**Interfaces:**
- Produces:
  - `type TokenStore interface { Get(refresh bool) (string, error); Set(refresh bool, value string) error }`; `NewFileTokenStore(path string) TokenStore`; `NewKeyringTokenStore(service string) TokenStore` (wraps `github.com/zalando/go-keyring`; pure Go, compiles on macOS).
  - `type HTTPClient interface { Post(ctx context.Context, path string, body any) (int, json.RawMessage, error) }`; `NewHTTPClient(baseURL string, hc *http.Client) HTTPClient`.
  - `type ClientIdentity struct { Platform, ClientVersion, DeviceID string }`.
  - `type Store struct{…}`; `NewStore(http HTTPClient, tokens TokenStore, identity ClientIdentity, configDir string) *Store`; methods `Register(ctx, email, password string) error`, `Login(ctx, email, password string) error`, `RefreshIfNeeded(ctx) error`, `Logout(ctx) error`, `AccessToken() string`, `AccountEmail() string`.
  - `type Error struct { Code Code; Message string }` implementing `error`; `type Code int` with `MissingRefreshToken, MissingAccessToken, InvalidTokenResponse, InvalidCredentials, EmailAlreadyRegistered, InvalidRequest, RateLimited, Unreachable, HTTPStatus`.
  - Identity body for every call: `{ platform, clientVersion, deviceId }` plus the call's fields; endpoints `/v1/auth/register`, `/v1/auth/login`, `/v1/auth/refresh`.

- [ ] **Step 1: Write failing tests**

`TestRegisterSendsIdentityAndStoresTokens` — fake client records path/body; assert path `/v1/auth/register`, body has `email`, `password`, `platform=="linux"`, `clientVersion`, `deviceId`; response `{accessToken,refreshToken,expiresIn:900}` is stored.

`TestLogin401MapsToInvalidCredentials` — `Code == InvalidCredentials`.

`TestRegister409MapsToEmailAlreadyRegistered`.

`TestLogin429MapsToRateLimited`.

`TestUnreachableMapsToUnreachable` — fake client returns an error.

`TestRefreshIfNeededSkipsWhenFresh` — token valid far in the future → no `/v1/auth/refresh` call.

`TestRefreshIfNeededOneAttemptWhenStale` — expired access token + valid refresh → exactly one refresh call, new tokens stored.

`TestLogoutClearsTokens` — after `Logout`, `AccessToken()==""` and the token store is empty.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./core/auth/`
Expected: FAIL.

- [ ] **Step 3: Implement the three files**

Keep `memoryAccessToken` + `accessExpiresAt`; `RefreshIfNeeded` returns early when the token is valid for >30 s; exactly one refresh attempt; `platform` is always `"linux"`. Persist `accountEmail` to a file under `configDir` so a cold start can still refresh. `FileTokenStore` writes a `0600` file; `KeyringTokenStore` uses the Secret Service.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && go test ./core/auth/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/core/auth
git commit -m "feat(linux): auth store over http plus token stores"
```

---

### Task 9: RemoteTranscriptionEngine + WebSocket socket

**Files:**
- Create: `linux/core/transcription/engine.go`
- Create: `linux/core/transcription/socket.go`
- Test: `linux/core/transcription/engine_test.go` (with `fakeSocket` in the test file)

**Interfaces:**
- Produces:
  - `type Engine interface { Start(ctx context.Context, requestID string) (ReadyMessage, error); SendAudio(ctx context.Context, oggBytes []byte) error; Stop(ctx context.Context, durationMs int64) (FinalMessage, error); Cancel(ctx context.Context) error; Close() error }`
  - `type Socket interface { Connect(ctx context.Context, url, accessToken string) error; SendText(ctx context.Context, s string) error; SendBinary(ctx context.Context, b []byte) error; Receive(ctx context.Context) (Message, error); Close() error }` with `type Message struct { IsText bool; Text string; Data []byte }`; `NewWebSocketSocket() Socket` implemented over `github.com/coder/websocket` (sets `Authorization: Bearer <token>` on upgrade).
  - `type RemoteEngine struct{…}`; `NewRemoteEngine(sock Socket, dictateURL string, accessToken func() string, now func() time.Time, warmSocket time.Duration) *RemoteEngine` (`warmSocket` is 60 s; `now` is injected so tests drive the warm-socket timer).
  - `type TranscriptionError struct { Code, Message string; Retryable bool }` implementing `error`.

- [ ] **Step 1: Write failing tests**

`TestStartSendsStartAndAwaitsReady` — fake socket captures text; assert the first text frame decodes to a `start` with `RequestID` matching and `Platform=="linux"`, then the engine returns the `ready` the fake replies with.

`TestBearerTokenOnConnect` — assert `Connect` received the token from the `func() string` provider.

`TestSendAudioSendsBinaryFrames` — the fake received the exact bytes as binary.

`TestStopSendsStopAndReturnsFinal` — `stop` text frame, then `final` returned.

`TestErrorThrowsWithCodeAndRetryable` — fake replies `{type:"error",code:"quota_exceeded",retryable:false,message:"…"}` to `stop`; assert a `*TranscriptionError` with `Code=="quota_exceeded"`, `Retryable==false`.

`TestWarmSocketReused` — run Start→Stop, then a second `Start` without a second `Connect`; assert one connect total.

`TestCancelSendsCancel` — assert a `cancel` text frame.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./core/transcription/`
Expected: FAIL.

- [ ] **Step 3: Implement engine and socket**

`WebSocketSocket` sets the bearer header on upgrade, sends text/binary frames, and surfaces `Receive` as `(isText, text, bytes)`. `RemoteEngine` parses JSON with Task 1's protocol, maps `error` frames into `*TranscriptionError`, and manages the warm-socket timer using the injected `now func() time.Time`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && go test ./core/transcription/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/core/transcription/engine.go linux/core/transcription/socket.go linux/core/transcription/engine_test.go
git commit -m "feat(linux): remote transcription engine over websocket"
```

---

### Task 10: Platform interfaces + SessionCoordinator (state machine)

**Files:**
- Create: `linux/core/platform/platform.go` (`AudioCapture`, `TextInserter`, `Hotkey`, `Clipboard`, `Pill`, `Notifier`, `PillState`, `PillStatus`)
- Create: `linux/core/session/coordinator.go`
- Create: `linux/core/session/types.go` (`State`, `Timeouts`, `Clock`)
- Test: `linux/core/session/coordinator_test.go` (with `fakeAudioCapture`, `fakeInserter`, `fakeEngine`, `fakePill`, `fakeClock` in the test file)

**Interfaces:**
- Consumes: `audio.SilenceDetector`, `audio.Encoder`, `audio.OggFramer`, `transcription.Engine`, `transcription.TranscriptionError`, `settings.Store`, `auth.Store`.
- Produces:
  - `type AudioCapture interface { Start(ctx context.Context) error; Stop() error; Frames() <-chan []int16; DeviceLost() <-chan struct{} }`
  - `type TextInserter interface { Insert(ctx context.Context, text string) error }`
  - `type Hotkey interface { Start() error; Stop() error; Toggled() <-chan struct{} }`
  - `type Clipboard interface { Save(ctx context.Context) error; SetText(ctx context.Context, s string) error; Restore(ctx context.Context) error }`
  - `type Pill interface { Show(status PillStatus); Hide() }`; `type PillState int` (`PillHidden, PillConnecting, PillListening, PillTranscribing, PillError, PillQuotaLow, PillQuotaExhausted`); `type PillStatus struct { State PillState; Message string; ElapsedSeconds int; CanRetry bool }`
  - `type Notifier interface { Notify(title, body string) }`
  - `type Clock interface { Now() time.Time }`; `type Timeouts struct { Connecting, Transcribing, Inserting, RecordingHardCap, WarmSocket, SilenceDuration, NoSpeechTimeout, MinDuration, TrailingHangover time.Duration }`; `NewTimeouts()` returning the spec values (5 s, 15 s, 2 s, 120 s, 60 s, 3000 ms, 10 s, 400 ms, 0).
  - `type State int` (`StateIdle, StateConnecting, StateRecording, StateTranscribing, StateInserting`).
  - `type Coordinator struct{…}`; `NewCoordinator(capture platform.AudioCapture, silence *audio.SilenceDetector, encoder audio.Encoder, framer *audio.OggFramer, engine transcription.Engine, inserter platform.TextInserter, settings *settings.Store, auth *auth.Store, clock Clock, t Timeouts) *Coordinator`; methods `OnStateChanged(fn func(State))`, `OnPillChanged(fn func(platform.PillStatus))`, `State() State`, `Toggle(ctx context.Context) error`, `Cancel(ctx context.Context) error`. Quota is surfaced through `PillStatus` (`PillQuotaLow` / `PillQuotaExhausted`), so there is no separate quota callback.

- [ ] **Step 1: Write failing tests (fakes driven by `fakeClock`)**

`TestToggleIdleToConnectingThenRecording` — `Toggle`; assert `State` goes `Idle → Connecting`; then the fake capture emits a frame and the fake engine returns `ready`; assert `State == Recording` and the last pill is `PillListening`.

`TestConnectingGateHoldsPillUntilFramesAndReady` — emit a frame but do not return `ready`; assert pill stays `PillConnecting`.

`TestPreReadyBufferFlushedAsFirstBinaryFrames` — while Connecting, emit PCM; after `ready`, assert the first bytes `SendAudio` received start with `"OggS"` and include the pre-`ready` audio.

`TestConnectingTimeoutAbortsToIdle` — no frames, no `ready`; advance `fakeClock` 5 s; assert `State == Idle` and pill is `PillError`.

`TestToggleDuringRecordingTranscribes` — reach Recording, `Toggle` again; assert `State` passes `Transcribing → Inserting → Idle` and the fake inserter received `FinalMessage.Text`.

`TestSilence3sAutoStops` — reach Recording, emit speech then 3 s quiet; assert transition to `Transcribing`.

`TestHardCap120sStops` — advance clock 120 s during Recording; assert `Transcribing` with whatever was captured.

`TestNoSpeechWithin10sDiscards` — reach Recording, no speech, advance 10 s; assert `State == Idle` and the fake engine never saw a `stop`.

`TestSub400msIsDiscarded` — reach Recording, <400 ms of speech, `Toggle`; assert `Idle` and no `stop` sent.

`TestTrailingSilenceTrimmedBeforeFinalFlush` — speech then 500 ms trailing quiet then stop; assert the final bytes omit the trailing-silence packets (hangover 0 ms).

`TestEmptyTranscriptSkipsInsertion` — fake engine returns `Text=="   "`; assert the inserter was never called.

`TestNonRetryableErrorNoRetry` — fake engine returns `&TranscriptionError{Code:"quota_exceeded",Retryable:false}` on `Stop`; assert pill `PillError` with `CanRetry==false` and `Start` not called again.

`TestEscapeCancels` — `Cancel` during Recording; assert `Idle`, the inserter not called, and engine `Cancel` called.

`TestAudioDeviceDisappearsAbortsToIdle` — during Recording, the fake capture closes `DeviceLost`; assert `State == Idle` and pill is `PillError`.

`TestUnauthenticatedRefreshesOnceAndReconnects` — engine returns `&TranscriptionError{Code:"unauthenticated"}`, `auth.RefreshIfNeeded` succeeds; assert exactly one reconnect attempt.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./core/session/`
Expected: FAIL.

- [ ] **Step 3: Implement the types, interfaces, and coordinator**

`Coordinator` is the only component that knows the flow. `Toggle` starts capture and `Start` concurrently, buffers pre-`ready` encoded Ogg bytes, transitions to Recording only when both frames and `ready` arrive, then flushes the buffer. Recording feeds the ring buffer → `SilenceDetector` + `Encoder` → `OggFramer`, streaming framed bytes as produced. All timers use `Clock.Now()` so tests drive them deterministically. `TrailingHangover=0` means silence packets are dropped before the final flush. On `final`, apply the min-duration/empty checks, then `TextInserter.Insert`; on insertion failure, fall back to the clipboard path via `Clipboard` + `Notifier`. `AudioCapture.DeviceLost` aborts to Idle with an error.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && go test ./core/session/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/core/platform linux/core/session
git commit -m "feat(linux): platform interfaces and session state machine"
```

---

## Phase 4 — Linux shell (cgo)

### Task 11: Audio capture + libopus encoder

**Files:**
- Create: `linux/app/audio/capture.go` (implements `platform.AudioCapture` via `github.com/gen2brain/malgo`)
- Create: `linux/app/audio/opus.go` (implements `audio.Encoder` via `gopkg.in/hraban/opus.v2`)
- Test: `linux/app/audio/opus_test.go`

**Interfaces:**
- Consumes: `platform.AudioCapture`, `audio.Encoder`.
- Produces: `NewCapture(deviceName string) (platform.AudioCapture, error)` — miniaudio's PulseAudio backend with an ALSA fallback, converter output 16 kHz mono `int16`, `Frames()` a buffered channel; `NewLibOpusEncoder() (audio.Encoder, error)` — 16 kHz, 1 channel, `Voip` application, 24000 bps, one 20 ms frame per `Encode`.

- [ ] **Step 1: Write failing tests (Linux only)**

`TestLibOpusEncoderRoundTripsFrame` — encode one 320-sample frame; assert the packet is non-empty and decodable back to 320 samples via `hraban/opus`'s decoder (or a length check if a decoder is unavailable).

`TestLibOpusEncoderRejectsPartialFrame` — 160 samples → error.

- [ ] **Step 2: Run tests to verify they fail (on Linux VM/CI)**

Run: `cd linux && CGO_ENABLED=1 go test ./app/audio/`
Expected: FAIL.

- [ ] **Step 3: Implement capture and encoder**

`malgo` default device in shared mode, `FormatS16`, `Channels=1`, `SampleRate=16000` (fall back to a `malgo` device-config conversion when a device refuses 16 kHz). Buffer frames into `Frames()`. The encoder wraps `opus.NewEncoder(16000, 1, opus.AppVoIP)` with `SetBitrate(24000)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && CGO_ENABLED=1 go test ./app/audio/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/app/audio
git commit -m "feat(linux): miniaudio capture and libopus encoder"
```

---

### Task 12: X11 global hotkey + session detection

**Files:**
- Create: `linux/core/sessiontype/sessiontype.go` (pure Go)
- Test: `linux/core/sessiontype/sessiontype_test.go`
- Create: `linux/app/hotkey/x11.go` (implements `platform.Hotkey` via `github.com/jezek/xgb`)
- Create: `linux/app/hotkey/select.go`

**Interfaces:**
- Produces: `type SessionType int` (`SessionX11`, `SessionWayland`, `SessionUnknown`); `Detect(getenv func(string) string) SessionType` (reads `XDG_SESSION_TYPE`); `NewHotkey(session SessionType, hk settings.Hotkey) (platform.Hotkey, error)` — returns the X11 grab on X11, and (Task 18) the click-to-record fallback on Wayland.

- [ ] **Step 1: Write failing tests**

`TestDetectX11` — `getenv` returns `"x11"` → `SessionX11`.
`TestDetectWayland` — `"wayland"` → `SessionWayland`.
`TestDetectUnknown` — `""` → `SessionUnknown`.
`TestDetectCaseInsensitive` — `"X11"` → `SessionX11`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./core/sessiontype/`
Expected: FAIL.

- [ ] **Step 3: Implement detection and the X11 grab**

`Detect` lower-cases `XDG_SESSION_TYPE`. The X11 hotkey opens a `jezek/xgb` connection, maps the configured keys (ctrl/shift/alt/super + key) to keycodes via `GetKeyboardMapping`, calls `xproto.GrabKey` with `ModMask`, and reads `KeyPress` events from `conn.WaitForEvent`, sending to the `Toggled()` channel. `GrabKey` needs no permission prompt.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && go test ./core/sessiontype/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/core/sessiontype linux/app/hotkey
git commit -m "feat(linux): session detection and x11 global hotkey"
```

---

### Task 13: Clipboard + X11 paste inserter

**Files:**
- Create: `linux/app/insert/clipboard.go` (implements `platform.Clipboard`; X11 via `golang.design/x/clipboard`, Wayland via `wl-clipboard` exec)
- Create: `linux/app/insert/inserter.go` (implements `platform.TextInserter`; X11 synthesized Ctrl+V via `xtest.FakeInput`)
- Test: `linux/app/insert/keysym_test.go` (pure mapping table — no X server)

**Interfaces:**
- Consumes: `platform.Clipboard`, `platform.TextInserter`.
- Produces: `NewClipboard(session sessiontype.SessionType) platform.Clipboard`; `NewInserter(session sessiontype.SessionType, cb platform.Clipboard, restoreDelay time.Duration, notify platform.Notifier) platform.TextInserter`.

- [ ] **Step 1: Write failing tests**

`TestModifierBits` — `ctrl`→ControlMask, `shift`→ShiftMask, `alt`→Mod1Mask, `super`→Mod4Mask (the X11 modifier bit table used by the fake-input path).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./app/insert/`
Expected: FAIL.

- [ ] **Step 3: Implement clipboard and inserter**

X11 insertion: `Clipboard.Save`, `Clipboard.SetText(transcript)`, synthesize Ctrl+V (press `Control_L`, press `v`, release `v`, release `Control_L`) via `xtest.FakeInput` with keycodes resolved from the keyboard mapping, then `Clipboard.Restore` after `restoreDelay` (150 ms). When the session is Wayland, `NewInserter` returns the clipboard-only inserter (Task 18), which sets the clipboard and calls `notify.Notify`. Text-only save/restore.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && go test ./app/insert/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/app/insert
git commit -m "feat(linux): x11 clipboard and paste inserter"
```

---

### Task 14: GTK4 pill overlay

**Files:**
- Create: `linux/app/overlay/pill.go` (implements `platform.Pill` using `github.com/diamondburned/gotk4/pkg/gtk/v4`)
- Create: `linux/app/overlay/render.go` (pure `PillStatus` → text/level mapping)

**Interfaces:**
- Consumes: `platform.PillStatus`.
- Produces: `NewPill(app *gtk.Application) platform.Pill`; `Render(status platform.PillStatus) (label string, showLevel bool, canRetry bool)`.

- [ ] **Step 1: Write failing tests**

`TestRenderPerState` — `PillConnecting` → "Connecting…", `showLevel=false`; `PillListening` → shows elapsed seconds, `showLevel=true`; `PillTranscribing` → indeterminate; `PillError` with `CanRetry=true` → `canRetry=true`; `PillQuotaLow`/`PillQuotaExhausted` → show remaining/reset text.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./app/overlay/`
Expected: FAIL.

- [ ] **Step 3: Implement the pill**

A GTK4 window positioned near the bottom centre of the active monitor, with `SetDecorated(false)`, `SetResizable(false)`, `SetFocusable(false)`, and `SetCanFocus(false)` so it never steals focus. Hide/Show per `PillStatus`; a retry button appears when `canRetry`. If a window manager still steals focus on X11, escalate to an override-redirect X11 window via a small cgo helper (`_NET_WM_WINDOW_TYPE_NOTIFICATION`).

- [ ] **Step 4: Run tests to verify they pass, then verify focus manually**

Run: `cd linux && go test ./app/overlay/`
Expected: PASS.

Manual (on the X11 VM): focus a text field in Gedit, trigger a dictation, and confirm keyboard focus does not move while the pill appears and disappears (typing continues to land in Gedit).

- [ ] **Step 5: Commit**

```bash
git add linux/app/overlay
git commit -m "feat(linux): gtk4 pill overlay"
```

---

### Task 15: Tray, single instance, and app wiring

**Files:**
- Create: `linux/app/tray/appindicator.go` (thin cgo binding to `libayatana-appindicator3`)
- Create: `linux/app/instance/instance.go` (flock single instance)
- Create: `linux/cmd/typebyvoice/main.go`
- Test: `linux/app/instance/instance_test.go`

**Interfaces:**
- Produces: `tray.New(onSettings, onQuit func()) (tray.Tray, error)` with `SetStatus(platform.PillStatus)`; `instance.Acquire(stateDir string) (*Lock, error)` (`ErrAlreadyRunning` when held) and `(*Lock) Release() error`; `main` wires endpoints (`TBV_API_URL`/`TBV_DICTATE_URL` with dev fallback), settings, auth, capture, engine, hotkey, inserter, pill, tray, and the coordinator.

- [ ] **Step 1: Write failing tests**

`TestAcquireTwiceFails` — `Acquire(dir)` then a second `Acquire(dir)` returns `ErrAlreadyRunning`; after `Release`, a fresh `Acquire` succeeds.

`TestLockFilePath` — the lock lives at `<dir>/instance.lock`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./app/instance/`
Expected: FAIL.

- [ ] **Step 3: Implement the tray, lock, and `main`**

`flock(LOCK_EX|LOCK_NB)` on `~/.local/state/typebyvoice/instance.lock`; a second launch notifies the running instance (best-effort) and exits 0. The tray uses `libayatana-appindicator3` with a menu (Settings, Dashboard, Quit) and reflects `PillStatus`. `main` builds every component and hands them to `NewCoordinator`, then runs the `gtk.Application`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && go test ./app/instance/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/app/tray linux/app/instance linux/cmd/typebyvoice
git commit -m "feat(linux): tray, single instance, and app wiring"
```

---

### Task 16: Onboarding and settings windows

**Files:**
- Create: `linux/app/ui/onboarding.go`
- Create: `linux/app/ui/settings.go`
- Create: `linux/app/ui/autostart.go` (XDG autostart)
- Test: `linux/app/ui/autostart_test.go`

**Interfaces:**
- Consumes: `auth.Store`, `settings.Store`, `platform.AudioCapture` (device enumeration via a new `app/audio.ListDevices()`).
- Produces: `ui.ShowOnboarding(app, auth, settings, onDone func())` and `ui.ShowSettings(app, settings, onSave func(settings.Store))`; `autostart.Enable(configDir string) error` / `autostart.Disable(configDir string) error` / `autostart.IsEnabled(configDir string) bool` writing `~/.config/autostart/typebyvoice.desktop`.

- [ ] **Step 1: Write failing tests**

`TestEnableWritesDesktopEntry` — `Enable(tmp)` creates `autostart/typebyvoice.desktop` containing `Type=Application`, `Exec=`, and `X-GNOME-Autostart-enabled=true`; `IsEnabled` returns true.

`TestDisableRemovesEntry` — after `Disable`, `IsEnabled` returns false and the file is gone.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./app/ui/`
Expected: FAIL.

- [ ] **Step 3: Implement the windows and autostart**

Onboarding: Welcome → sign in / create account (email + password, calling `auth.Register`/`auth.Login`) → a mic step that lists capture devices and confirms one is reachable → a hotkey step with a press-to-record control (reusing `settings.ApplyRecordedHotkey`) → Done. Settings surfaces the same plus silence threshold, hard cap, insertion mode, microphone picker, account, and the launch-at-login toggle bound to `autostart`. Linux needs no permission prompts, so those macOS/iOS steps are absent.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && go test ./app/ui/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/app/ui
git commit -m "feat(linux): onboarding, settings windows, and autostart"
```

---

## Phase 5 — Parity surfaces

### Task 17: Transcript history dashboard

**Files:**
- Create: `linux/core/history/client.go`
- Test: `linux/core/history/client_test.go` (with a fake `HTTPClient`)
- Create: `linux/app/ui/dashboard.go`

**Interfaces:**
- Consumes: `auth.Store` (access token), an `HTTPClient` (`Get`, `Delete`).
- Produces: `history.NewClient(http HTTPClient, token func() string) *Client`; methods `List(ctx, query string, cursor string) (Page, error)`, `Delete(ctx, id string) error`, `Export(ctx) ([]byte, error)`; `type Page struct { Items []Transcript; NextCursor string }`; `type Transcript struct { ID, Text string; WordCount int; CreatedAt string }`.

- [ ] **Step 1: Write failing tests**

`TestListSendsQueryAndCursor` — fake records `GET /v1/transcripts?q=…&cursor=…` with the bearer token; returns `Page.Items`.

`TestDeleteSendsID` — `DELETE /v1/transcripts/<id>`.

`TestExportReturnsBody` — `GET /v1/transcripts/export` body returned verbatim.

`TestListParsesNextCursor` — cursor present in the response is surfaced.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./core/history/`
Expected: FAIL.

- [ ] **Step 3: Implement the client and the dashboard window**

`Client` calls the `/v1/transcripts` endpoints from the backend design. The GTK4 dashboard is a searchable list with delete and an export-to-file action; it is opened from the tray menu.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && go test ./core/history/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/core/history linux/app/ui/dashboard.go
git commit -m "feat(linux): transcript history client and dashboard"
```

---

## Phase 6 — Wayland best-effort

### Task 18: Wayland fallbacks (click-to-record, wtype, clipboard-only)

**Files:**
- Create: `linux/core/insertion/strategy.go` (pure decision logic)
- Test: `linux/core/insertion/strategy_test.go`
- Create: `linux/app/hotkey/wayland.go` (implements `platform.Hotkey` as a no-op grab)
- Create: `linux/app/insert/wayland.go` (`wtype` exec + clipboard-only)

**Interfaces:**
- Produces: `type Strategy int` (`StrategySynthesizeX11`, `StrategyWtype`, `StrategyClipboardOnly`); `ChooseInsertionStrategy(session sessiontype.SessionType, wtypeAvailable bool) Strategy`; `type FallbackHotkey struct{…}` whose `Toggled()` is fed by a tray/pill click; `NewWaylandInserter(hasWtype bool, cb platform.Clipboard, notify platform.Notifier) platform.TextInserter`.

- [ ] **Step 1: Write failing tests**

`TestChooseInsertionStrategy` — `(SessionX11, _)` → `StrategySynthesizeX11`; `(SessionWayland, true)` → `StrategyWtype`; `(SessionWayland, false)` → `StrategyClipboardOnly`; `(SessionUnknown, false)` → `StrategyClipboardOnly`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd linux && go test ./core/insertion/`
Expected: FAIL.

- [ ] **Step 3: Implement the strategy, fallback hotkey, and Wayland inserter**

The Wayland hotkey cannot grab globally, so `Toggled()` is driven by a tray/pill click. The Wayland inserter runs `wtype -M ctrl v -m ctrl` when available; otherwise it sets the clipboard and notifies "Transcription copied — press Ctrl+V". The transcript is never dropped.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd linux && go test ./core/insertion/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add linux/core/insertion linux/app/hotkey/wayland.go linux/app/insert/wayland.go
git commit -m "feat(linux): wayland click-to-record, wtype, and clipboard-only fallback"
```

---

## Phase 7 — CI and packaging

### Task 19: CI workflow, AppImage, and .deb

**Files:**
- Create: `.github/workflows/linux-client.yml`
- Create: `linux/dist/appimage/AppRun` + `linux/dist/appimage/typebyvoice.desktop`
- Create: `linux/dist/debian/control` + `linux/dist/debian/postinst` (skeleton for `dpkg-deb`)
- Create: `linux/README.md`

**Interfaces:**
- Consumes: the built `cmd/typebyvoice` binary.
- Produces: a CI job on `ubuntu-latest` that runs `go vet ./...`, `go test ./core/...` (with `CGO_ENABLED=0`) and `CGO_ENABLED=1 go test ./app/...` after installing `libgtk-4-dev libayatana-appindicator3-dev libpulse-dev libasound2-dev libopus-dev`, runs the pipeline integration test against `contracts/dictation-v1`'s cli-mock, and produces `typebyvoice-amd64.AppImage` and `typebyvoice_<version>_amd64.deb` artifacts.

- [ ] **Step 1: Write the workflow and packaging skeletons**

Install the apt build deps; `npm ci` the contracts; start the cli-mock (`npm run mock`); run `go test ./...` with the mock's `ws://127.0.0.1:...` endpoint; build the binary with `linuxdeploy`-based AppImage generation and `dpkg-deb --build` for the `.deb` (depends `libgtk-4-1, libayatana-appindicator3, libopus0, libpulse0`).

- [ ] **Step 2: Run the workflow locally to verify it fails without the artifacts**

Run: `cd linux && CGO_ENABLED=1 go build ./cmd/typebyvoice`
Expected: FAIL until the apt deps are installed (documents the dependency list).

- [ ] **Step 3: Implement the workflow and packaging files**

Pin `actions/checkout` and `actions/setup-go` (Go 1.24) and `actions/setup-node` (Node 24.9+). Upload both artifacts.

- [ ] **Step 4: Run the workflow and verify green**

Run: `gh workflow run linux-client.yml` (or push the branch)
Expected: PASS; both artifacts attached.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/linux-client.yml linux/dist linux/README.md
git commit -m "ci(linux): build, test, appimage, and deb packaging"
```

---

## Self-review notes

- **Spec coverage:** every spec section maps to a task — protocol (1), server enum (2), audio ring/silence/framing/encode (3–6), settings (7), auth (8), engine (9), state machine (10), capture/encoder (11), hotkey+session (12), insertion (13), pill (14), tray/wiring (15), onboarding/settings/autostart (16), dashboard (17), Wayland (18), packaging/CI (19).
- **Type consistency:** `platform.PillStatus` is defined in `core/platform` (not `core/session`) so the coordinator can emit it without an import cycle; `audio.Encoder` is the seam between core and the libopus cgo implementation.
- **Open risk carried from the spec:** the GTK4 non-focusable pill and the Ogg framing are the two first-to-validate areas; both are pinned early (Task 5 framing, Task 14 pill) and both have explicit manual/early verification.
