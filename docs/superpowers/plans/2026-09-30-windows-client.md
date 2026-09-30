# Windows Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MVP Windows dictation client — a single-instance WPF tray agent that captures mic audio, encodes it as Ogg Opus, streams it to the shared backend over the dictation v1 protocol, and pastes the transcript at the cursor.

**Architecture:** Two .NET projects mirroring the macOS client's separation. `TypeByVoice.Core` (`net8.0`) holds all testable logic — state machine, silence detection, Opus/Ogg encoding, WebSocket transcription engine, auth, settings — behind platform interfaces. `TypeByVoice.Windows` (`net8.0-windows`, WPF) is a thin shell of Windows-native interop (hotkey, WASAPI, clipboard paste, tray, overlay). Core unit-tests run on macOS; the WPF shell builds and is verified in a Windows VM and GitHub Actions `windows-latest`.

**Tech Stack:** .NET 8 / C# 12, WPF, NAudio, Concentus + Concentus.Oggfile, System.Text.Json, System.Net.WebSockets (ClientWebSocket), xUnit, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-30-windows-client-design.md`

## Global Constraints

- Target frameworks: `TypeByVoice.Core` = `net8.0`; `TypeByVoice.Windows` = `net8.0-windows` (`UseWPF`, `UseWindowsForms`); publish RIDs `win-x64` (default) and `win-arm64`; Windows 10 1809+ / Windows 11.
- Protocol `platform` value is `"windows"` in both `start` and the auth identity body.
- Audio: 16 kHz mono 16-bit PCM in; Ogg Opus 16 kHz, 1 channel, `VOIP`, ~24 kbps, 20 ms frames; a single continuous Ogg stream (one serial, monotonic granule positions, pages flushed every ~200 ms).
- Timeouts (verbatim): connecting 5 s; transcribing 15 s; inserting 2 s; recording hard cap 120 s; silence auto-stop 3 000 ms; no-speech 10 000 ms; min duration 400 ms; trailing hangover 0 ms; warm socket 60 s.
- Clipboard restore delay: 150 ms.
- Default hotkey: `Ctrl+Shift+Space` → `MOD_CONTROL | MOD_SHIFT` (0x0002 | 0x0004) + `VK_SPACE` (0x20).
- Endpoints: `TBV_API_URL` / `TBV_DICTATE_URL` env vars win; Debug falls back to `http://127.0.0.1:3000` and `ws://127.0.0.1:3000/v1/dictate`; Release requires baked values.
- Idle CPU target under 1% of one core; no offline transcription; settings at `%APPDATA%\TypeByVoice\settings.json`; tokens via DPAPI `CurrentUser` in `%APPDATA%\TypeByVoice\`.

## Review Focus

The failure modes most likely to bite a real user, and the task that pins each:

1. **Speech before the mic/socket is live (leading words dropped).** The pill must stay on Connecting and the pre-`ready` audio must be flushed as the first frames. → pinned in Task 8 (`ConnectingGate_HoldsPreReadyAudioUntilFramesAndReady`, `PreReadyBufferFlushedAsFirstBinaryFrames`).
2. **Trailing silence makes Whisper invent "Thank you."** Trailing silence must be trimmed (hangover 0 ms) before the final flush. → pinned in Task 8 (`TrailingSilenceTrimmedBeforeFinalFlush`).
3. **A hotkey press with no speech records silence and bills for it.** <400 ms recordings are discarded before contacting the server; no-speech within 10 s discards. → pinned in Task 8 (`NoSpeechWithin10s_Discards`, `Sub400ms_IsDiscarded`).
4. **Clipboard save/restore racing a clipboard manager (Win+V, Ditto).** Previous clipboard contents must be restored after 150 ms. → pinned to the manual matrix + `DpapiTokenStore`/restore-delay wiring in Task 12.
5. **A malformed or versioned server message breaking the client.** Unknown fields must be ignored; missing optional fields must not throw. → pinned in Task 1 (`Deserialize_IgnoresUnknownFields`).

---

### Task 1: Solution scaffold + dictation protocol messages

**Files:**
- Create: `windows/TypeByVoice.sln`
- Create: `windows/TypeByVoice.Core/TypeByVoice.Core.csproj` (`net8.0`)
- Create: `windows/TypeByVoice.Core.Tests/TypeByVoice.Core.Tests.csproj` (xUnit, references Core)
- Create: `windows/TypeByVoice.Windows/TypeByVoice.Windows.csproj` (`net8.0-windows`, `UseWPF`, `UseWindowsForms`, references Core)
- Create: `windows/TypeByVoice.Core/Transcription/DictationProtocol.cs`
- Test: `windows/TypeByVoice.Core.Tests/DictationProtocolTests.cs`

**Interfaces:**
- Produces (records, serialized with `System.Text.Json`, `PropertyNamingPolicy = CamelCase`): `StartMessage(string Type, string RequestId, string Codec, string Container, int SampleRate, int Channels, string Language, string Platform, string ClientVersion, string DeviceId)`, `StopMessage(string Type, string RequestId, long DurationMs)`, `CancelMessage(string Type, string RequestId)`, `ReadyMessage(string Type, string RequestId, long MaxDurationMs, QuotaInfo Quota)`, `FinalMessage(string Type, string RequestId, string Text, int WordCount, long AudioMs, QuotaInfo Quota)`, `ErrorMessage(string Type, string RequestId, string Code, string Message, bool Retryable, JsonElement Details)`, `QuotaInfo(string Unit, int Limit, int Used, string ResetAt)`, `ClientIdentity(string Platform, string ClientVersion, string DeviceId)`.

- [ ] **Step 1: Write failing tests for message round-trips**

`StartMessage_SerializesToSpecShape` — serialize `StartMessage(Type: "start", RequestId: "3f2b", Codec: "opus", Container: "ogg", SampleRate: 16000, Channels: 1, Language: "en", Platform: "windows", ClientVersion: "1.0.0+12", DeviceId: "9c1e…")` and assert `type == "start"`, `codec == "opus"`, `container == "ogg"`, `sampleRate == 16000`, `channels == 1`, `language == "en"`, `platform == "windows"`.

`StopMessage_SerializesToSpecShape` — assert `type == "stop"`, `durationMs == 11800`.

`CancelMessage_SerializesToSpecShape` — assert `type == "cancel"`.

`ReadyMessage_DeserializesFromSpecJson` — from the spec's `ready` JSON (with `maxDurationMs: 120000` and nested `quota`) assert `MaxDurationMs == 120000`, `Quota.Unit == "words"`, `Quota.Limit == 2000`, `Quota.Used == 312`.

`FinalMessage_DeserializesFromSpecJson` — assert `Text`, `WordCount == 42`, `AudioMs == 11800`.

`ErrorMessage_DeserializesFromSpecJson` — assert `Code == "quota_exceeded"`, `Retryable == false`.

`Deserialize_IgnoresUnknownFields` — feed a `final` JSON with an extra `"futureField": 1`; assert deserialization succeeds and `WordCount` is still read.

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: FAIL (types undefined).

- [ ] **Step 3: Implement the records in `DictationProtocol.cs`**

One `sealed record` per message with `positional` properties exactly as named in Interfaces. `Details` is `JsonElement` so unknown error detail shapes do not throw. Default `Type` to the message's literal so callers only set the per-message fields. Add xUnit packages (`xunit`, `xunit.runner.visualstudio`, `Microsoft.NET.Test.Sdk`) to `TypeByVoice.Core.Tests`; add a `<ProjectReference>` from the tests and the Windows project to `TypeByVoice.Core`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add windows/TypeByVoice.sln windows/TypeByVoice.Core windows/TypeByVoice.Core.Tests windows/TypeByVoice.Windows
git commit -m "feat(windows): scaffold solution and dictation protocol messages"
```

---

### Task 2: AudioRingBuffer

**Files:**
- Create: `windows/TypeByVoice.Core/Audio/AudioRingBuffer.cs`
- Test: `windows/TypeByVoice.Core.Tests/AudioRingBufferTests.cs`

**Interfaces:**
- Produces: `public sealed class AudioRingBuffer { public AudioRingBuffer(int capacity); public int Capacity { get; } public int Count { get; } public void Write(ReadOnlySpan<short> samples); public int Read(Span<short> destination); public void Clear(); }`

- [ ] **Step 1: Write failing tests**

`WriteThenRead_RoundTrips` — write `[1,2,3,4]`, read 4, assert order and `Count == 0`.

`Overflow_OverwritesOldest` — capacity 4, write `[1..8]`, read all, assert the surviving samples are `[5,6,7,8]`.

`Clear_EmptiesBuffer` — write then `Clear()`, assert `Count == 0` and read returns 0.

`Read_DrainsReadSamples` — write 4, read 2, assert remaining `Count == 2` and next read yields the last two.

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: FAIL.

- [ ] **Step 3: Implement `AudioRingBuffer` in `Audio/AudioRingBuffer.cs`**

Backed by a preallocated `short[]`; a write that exceeds free space advances the read index (overwrite-oldest) rather than growing. `Read` copies out and advances the read index.

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add windows/TypeByVoice.Core/Audio/AudioRingBuffer.cs windows/TypeByVoice.Core.Tests/AudioRingBufferTests.cs
git commit -m "feat(windows): audio ring buffer"
```

---

### Task 3: SilenceDetector

**Files:**
- Create: `windows/TypeByVoice.Core/Audio/SilenceDetector.cs`
- Test: `windows/TypeByVoice.Core.Tests/SilenceDetectorTests.cs`

**Interfaces:**
- Produces: `public sealed class SilenceDetector { public SilenceDetector(int calibrationMs = 300); public event Action? SpeechStarted; public event Action? SilenceStarted; public void Process(ReadOnlySpan<short> samples); public void Reset(); }`
- `Process` receives 16 kHz mono PCM16 frames; calibration is the first ~300 ms; transitions fire only once per speech/silence run (hysteresis).

- [ ] **Step 1: Write failing tests**

`LoudAfterQuiet_RaisesSpeechStarted` — feed 300 ms of near-zero samples (noise floor), then a loud 500 Hz tone; assert `SpeechStarted` fired exactly once.

`QuietAfterSpeech_RaisesSilenceStarted` — after a loud run, feed 500 ms of quiet; assert `SilenceStarted` fired exactly once.

`BriefPause_DoesNotRaiseSilenceStarted` — loud, 150 ms quiet (below the hysteresis hold), loud again; assert `SilenceStarted` never fired.

`NoisyRoom_CalibrationPreventsFalseSpeech` — feed 300 ms of moderate noise, then slightly-louder noise; assert `SpeechStarted` does not fire (calibration floor accounts for room noise).

`Reset_ClearsState` — reach speech, `Reset()`, then quiet; assert no `SilenceStarted` fires (detector returns to calibration).

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: FAIL.

- [ ] **Step 3: Implement `SilenceDetector` in `Audio/SilenceDetector.cs`**

Track short-term loudness (RMS or peak of each frame) vs a calibrated floor; a `speech` boolean plus a minimum-quiet hold prevents a mid-sentence pause from flipping state. Calibration computes the floor over the first 300 ms regardless of content.

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add windows/TypeByVoice.Core/Audio/SilenceDetector.cs windows/TypeByVoice.Core.Tests/SilenceDetectorTests.cs
git commit -m "feat(windows): silence detector with calibration and hysteresis"
```

---

### Task 4: OpusEncoder (Ogg Opus)

**Files:**
- Create: `windows/TypeByVoice.Core/Audio/OpusEncoder.cs`
- Create: `windows/TypeByVoice.Core.Tests/OggTestHelpers.cs` (minimal Ogg page reader)
- Test: `windows/TypeByVoice.Core.Tests/OpusEncoderTests.cs`

**Interfaces:**
- Produces: `public sealed class OpusEncoder : IDisposable { public OpusEncoder(int sampleRate = 16000, int channels = 1, int bitrate = 24000, int frameMs = 20); public void Reset(); public int Encode(ReadOnlySpan<short> pcm, IBufferWriter<byte> output); }`
- `Encode` feeds 20 ms frames of PCM16 to Concentus and appends the resulting Ogg Opus bytes to `output`; it flushes an Ogg page every ~10 frames (200 ms). `Reset` starts a fresh Ogg stream (new serial).

- [ ] **Step 1: Write failing tests**

`Encode_ProducesOggStream` — encode 2 s of silence; assert output begins with `"OggS"` and the first page is an OpusHead.

`Encode_SingleSerialAcrossCalls` — encode across multiple calls; assert the Ogg serial number is constant; call `Reset()`, encode again, assert the serial changed.

`Encode_GranulePositionsMonotonic` — parse pages; assert granule positions strictly increase across frames.

`Encode_FlushesPageEvery200ms` — encode 1 s (50 frames); assert a page boundary appears roughly every 10 frames (allow ±2 frames).

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: FAIL.

- [ ] **Step 3: Implement `OpusEncoder` in `Audio/OpusEncoder.cs`**

Add NuGet packages `Concentus` and `Concentus.Oggfile` to `TypeByVoice.Core`. Use `Concentus.OpusEncoder` (16 kHz, 1 channel, `OpusApplication.OPUS_APPLICATION_VOIP`, bitrate 24000) and `Concentus.Oggfile.OpusOggWriteStream` over an in-memory stream; after each encode, copy newly written bytes to `output` and reset the stream cursor. Call `Flush()` on the Ogg writer every 10 frames. `Reset()` disposes and recreates the writer.

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add windows/TypeByVoice.Core/Audio/OpusEncoder.cs windows/TypeByVoice.Core.Tests/OggTestHelpers.cs windows/TypeByVoice.Core.Tests/OpusEncoderTests.cs
git commit -m "feat(windows): Ogg Opus encoder (Concentus)"
```

---

### Task 5: SettingsStore + HotkeyFormatter

**Files:**
- Create: `windows/TypeByVoice.Core/Settings/SettingsStore.cs`
- Create: `windows/TypeByVoice.Core/Settings/HotkeyFormatter.cs`
- Test: `windows/TypeByVoice.Core.Tests/SettingsStoreTests.cs`

**Interfaces:**
- Produces: `public sealed class SettingsStore { public uint VirtualKey; public uint Modifiers; public int SilenceDurationMs; public int HardCapMs; public int ClipboardRestoreDelayMs; public bool LaunchAtLogin; public static SettingsStore Defaults { get; } public static SettingsStore Load(string json); public string ToJson(); public bool ApplyRecordedHotkey(uint virtualKey, uint modifiers); }` and `public static class HotkeyFormatter { public static string DisplayLabel(uint modifiers, uint virtualKey); }`
- Defaults: `VirtualKey = 0x20`, `Modifiers = 0x0002 | 0x0004`, `SilenceDurationMs = 3000`, `HardCapMs = 120000`, `ClipboardRestoreDelayMs = 150`, `LaunchAtLogin = false`.

- [ ] **Step 1: Write failing tests**

`Defaults_MatchSpec` — assert the six default values above.

`RoundTrip_PreservesValues` — `Load(s.ToJson())` equals `s` for a mutated store.

`Load_MalformedJson_ReturnsDefaults`.

`ApplyRecordedHotkey_RejectsModifierOnly` — `ApplyRecordedHotkey(0x11 /*VK_CONTROL*/, 0)` returns false and leaves values unchanged; `ApplyRecordedHotkey(0x20, 0x0002|0x0004)` returns true.

`DisplayLabel_CtrlShiftSpace` — `DisplayLabel(0x0002|0x0004, 0x20)` returns `"Ctrl+Shift+Space"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: FAIL.

- [ ] **Step 3: Implement both classes**

`SettingsStore` serializes via `System.Text.Json`; `Defaults` returns a new instance each call. `ApplyRecordedHotkey` rejects bare modifier virtual keys (`VK_CONTROL`, `VK_SHIFT`, `VK_MENU`, `VK_LWIN`, `VK_RWIN`, left/right variants). `HotkeyFormatter.DisplayLabel` renders modifiers in order `Ctrl, Alt, Shift, Win` then the key name from `VK_SPACE` → `"Space"`, letters → uppercase, digits → the digit, else `"VK<code>"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add windows/TypeByVoice.Core/Settings windows/TypeByVoice.Core.Tests/SettingsStoreTests.cs
git commit -m "feat(windows): settings store and hotkey formatter"
```

---

### Task 6: AuthStore + AuthHttpClient + ITokenStore

**Files:**
- Create: `windows/TypeByVoice.Core/Auth/ITokenStore.cs`
- Create: `windows/TypeByVoice.Core/Auth/AuthHttpClient.cs`
- Create: `windows/TypeByVoice.Core/Auth/AuthStore.cs`
- Test: `windows/TypeByVoice.Core.Tests/AuthStoreTests.cs` (with an in-memory `FakeTokenStore` and `FakeAuthHttpClient` in the test file)

**Interfaces:**
- Produces:
  - `public interface ITokenStore { string? AccessToken { get; set; } string? RefreshToken { get; set; } }`
  - `public interface IAuthHttpClient { Task<AuthHttpResponse> PostAsync(string path, object body, CancellationToken ct); }` where `public sealed record AuthHttpResponse(int Status, JsonElement Body);`
  - `public sealed class HttpAuthHttpClient : IAuthHttpClient { public HttpAuthHttpClient(Uri baseUrl, HttpClient client); }` — posts JSON to `baseUrl + path`, returns `(status, body)`.
  - `public sealed class AuthStore { public AuthStore(IAuthHttpClient http, ITokenStore tokens, ClientIdentity identity, string settingsDir); public Task RegisterAsync(string email, string password, CancellationToken ct); public Task LoginAsync(string email, string password, CancellationToken ct); public Task RefreshIfNeededAsync(CancellationToken ct); public Task LogoutAsync(CancellationToken ct); public string? AccessToken { get; } public string? AccountEmail { get; } }`
  - `public sealed class AuthStoreException : Exception { public AuthErrorCode Code { get; } public AuthStoreException(AuthErrorCode code, string message); }` and `public enum AuthErrorCode { MissingRefreshToken, MissingAccessToken, InvalidTokenResponse, InvalidCredentials, EmailAlreadyRegistered, InvalidRequest, RateLimited, Unreachable, HttpStatus }`.
  - Identity body for every call: `{ platform, clientVersion, deviceId }` plus the call's fields; endpoints `/v1/auth/register`, `/v1/auth/login`, `/v1/auth/refresh`.

- [ ] **Step 1: Write failing tests**

`Register_SendsIdentityAndStoresTokens` — fake client records path/body; assert path `/v1/auth/register`, body has `email`, `password`, `platform == "windows"`, `clientVersion`, `deviceId`; response `{accessToken, refreshToken, expiresIn:900}` is stored.

`Login_401_MapsToInvalidCredentials` — 401 on login → `AuthStoreException` with `InvalidCredentials`.

`Register_409_MapsToEmailAlreadyRegistered` — 409 → `EmailAlreadyRegistered`.

`Login_429_MapsToRateLimited` — 429 → `RateLimited`.

`Unreachable_MapsToUnreachable` — fake client throws → `Unreachable`.

`RefreshIfNeeded_SkipsWhenFresh` — token set with `expiresIn` far in future → no `/v1/auth/refresh` call.

`RefreshIfNeeded_OneAttemptWhenStale` — expired token + valid refresh → exactly one refresh call, new tokens stored.

`Logout_ClearsTokens` — after `LogoutAsync`, `AccessToken` is null and token store is empty.

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: FAIL.

- [ ] **Step 3: Implement the three files**

`AuthStore` mirrors the macOS `AuthStore`: keep `memoryAccessToken` + `accessExpiresAt`; `RefreshIfNeededAsync` returns early when the token is valid for >30 s; exactly one refresh attempt; `platform` is always `"windows"`. Store `accountEmail` in a file `%APPDATA%\TypeByVoice\account-email` (path built from `settingsDir`) so a cold start can still refresh.

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add windows/TypeByVoice.Core/Auth windows/TypeByVoice.Core.Tests/AuthStoreTests.cs
git commit -m "feat(windows): auth store over HTTP + token abstraction"
```

---

### Task 7: RemoteTranscriptionEngine

**Files:**
- Create: `windows/TypeByVoice.Core/Transcription/ITranscriptionEngine.cs`
- Create: `windows/TypeByVoice.Core/Transcription/RemoteTranscriptionEngine.cs`
- Create: `windows/TypeByVoice.Core/Transcription/IDictationSocket.cs` (+ `ClientWebSocketDictationSocket` wrapping `ClientWebSocket`)
- Test: `windows/TypeByVoice.Core.Tests/RemoteTranscriptionEngineTests.cs` (with `FakeDictationSocket` and `FakeTranscriptionEngine` in the test file)

**Interfaces:**
- Produces:
  - `public interface ITranscriptionEngine : IAsyncDisposable { Task<ReadyMessage> StartAsync(StartMessage start, CancellationToken ct); Task SendAudioAsync(ReadOnlyMemory<byte> oggBytes, CancellationToken ct); Task<FinalMessage> StopAsync(CancellationToken ct); Task CancelAsync(CancellationToken ct); }`
  - `public interface IDictationSocket : IAsyncDisposable { Task ConnectAsync(Uri uri, string accessToken, CancellationToken ct); Task SendTextAsync(string json, CancellationToken ct); Task SendBinaryAsync(ReadOnlyMemory<byte> bytes, CancellationToken ct); Task<(bool IsText, string Text, ReadOnlyMemory<byte> Bytes)> ReceiveAsync(CancellationToken ct); void Close(); }`
  - `public sealed class RemoteTranscriptionEngine : ITranscriptionEngine { public RemoteTranscriptionEngine(IDictationSocket socket, Uri dictateUri, Func<string?> accessToken); }`
  - Engine keeps the socket warm for 60 s after a session ends, and reuses it for the next `StartAsync`.

- [ ] **Step 1: Write failing tests**

`StartAsync_SendsStartAndAwaitsReady` — fake socket captures text; assert the first text frame parses to a `start` with `RequestId` matching the input and `Platform == "windows"`; then the engine returns the `ready` the fake replies with.

`StartAsync_BearerTokenOnConnect` — assert `ConnectAsync` received the access token returned by the `Func<string?>`.

`SendAudioAsync_SendsBinaryFrames` — assert the fake received the exact bytes as binary.

`StopAsync_SendsStopAndReturnsFinal` — assert `stop` text frame, then `final` result returned.

`Error_ThrowsWithCodeAndRetryable` — fake replies with `{type:"error", code:"quota_exceeded", retryable:false, message:"…"}` to `stop`; assert an exception carrying `code == "quota_exceeded"` and `retryable == false`.

`Session_WarmSocketReused` — run `Start→Stop`, then a second `StartAsync` without the fake seeing a second `ConnectAsync`; assert one connect total.

`CancelAsync_SendsCancel` — assert a `cancel` text frame.

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: FAIL.

- [ ] **Step 3: Implement `RemoteTranscriptionEngine`, `IDictationSocket`, `ClientWebSocketDictationSocket`**

`ClientWebSocketDictationSocket` sets the `Authorization: Bearer <token>` header on upgrade, sends text/binary frames, and surfaces `ReceiveAsync` as `(isText, text, bytes)`. `RemoteTranscriptionEngine` parses JSON with the protocol options from Task 1, maps `error` frames into an `TranscriptionException(string Code, string Message, bool Retryable)`, and manages the 60 s warm-socket timer.

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add windows/TypeByVoice.Core/Transcription windows/TypeByVoice.Core.Tests/RemoteTranscriptionEngineTests.cs
git commit -m "feat(windows): remote transcription engine over WebSocket"
```

---

### Task 8: SessionCoordinator (state machine) + platform interfaces

**Files:**
- Create: `windows/TypeByVoice.Core/Platform/IAudioCapture.cs`
- Create: `windows/TypeByVoice.Core/Platform/ITextInserter.cs`
- Create: `windows/TypeByVoice.Core/Platform/IHotkey.cs`
- Create: `windows/TypeByVoice.Core/Session/SessionState.cs` (`enum SessionState { Idle, Connecting, Recording, Transcribing, Inserting }`, `SessionError`, `SessionTimeouts`, `IClock`)
- Create: `windows/TypeByVoice.Core/Session/SessionCoordinator.cs`
- Test: `windows/TypeByVoice.Core.Tests/SessionCoordinatorTests.cs` (with `FakeAudioCapture`, `FakeTextInserter`, `FakeTranscriptionEngine`, `FakeClock` in the test file)

**Interfaces:**
- Consumes: `IAudioCapture`, `ITextInserter`, `ITranscriptionEngine`, `SilenceDetector`, `OpusEncoder`, `SettingsStore`, `AuthStore`.
- Produces:
  - `public interface IAudioCapture : IAsyncDisposable { event Action<ReadOnlyMemory<short>>? SamplesAvailable; event Action? DeviceLost; Task StartAsync(CancellationToken ct); Task StopAsync(CancellationToken ct); }`
  - `public interface ITextInserter { Task InsertAsync(string text, CancellationToken ct); }`
  - `public interface IHotkey : IDisposable { event Action? Toggled; void Start(); void Stop(); }`
  - `public interface IClock { DateTimeOffset UtcNow { get; } }`
  - `public sealed record SessionTimeouts { TimeSpan Connecting = 5s, Transcribing = 15s, Inserting = 2s, RecordingHardCap = 120s, WarmSocketSeconds = 60s; int SilenceDurationMs = 3000, NoSpeechTimeoutMs = 10000, MinDurationMs = 400, TrailingHangoverMs = 0; }`
  - `public enum PillState { Hidden, Connecting, Listening, Transcribing, Error, QuotaLow, QuotaExhausted }`
  - `public readonly record struct PillStatus(PillState State, string? Message, int ElapsedSeconds, bool CanRetry);`
  - `public sealed class SessionCoordinator { public SessionCoordinator(IAudioCapture capture, SilenceDetector silence, OpusEncoder encoder, ITranscriptionEngine engine, ITextInserter inserter, SettingsStore settings, AuthStore auth, IClock clock, SessionTimeouts timeouts); public event Action<SessionState>? StateChanged; public event Action<PillStatus>? PillChanged; public SessionState State { get; } public Task ToggleAsync(CancellationToken ct); public Task CancelAsync(CancellationToken ct); }`

- [ ] **Step 1: Write failing tests (fakes driven by a `FakeClock`)**

`Toggle_IdleToConnectingThenRecording` — `ToggleAsync`; assert `State` goes `Idle → Connecting`; then fake capture emits a frame and fake engine returns `ready`; assert `State == Recording` and `PillChanged` last reports `Listening`.

`PreReadyBufferFlushedAsFirstBinaryFrames` — while Connecting, emit PCM; after `ready`, assert the first bytes `SendAudioAsync` received start with `"OggS"` and include the pre-`ready` audio (encode output length > 0 before any post-`ready` frame).

`ConnectingTimeout_AbortsToIdle` — no frames and no `ready`; advance `FakeClock` 5 s; assert `State == Idle` and pill is `Error`.

`ToggleDuringRecording_Transcribes` — reach Recording, `ToggleAsync` again; assert `State` passes `Transcribing → Inserting → Idle` and `FakeTextInserter` received the `FinalMessage.Text`.

`Silence3s_AutoStops` — reach Recording, emit speech then 3 s of quiet; assert transition to `Transcribing`.

`HardCap120s_Stops` — advance clock 120 s during Recording; assert `Transcribing` with whatever was captured.

`NoSpeechWithin10s_Discards` — reach Recording, emit no speech, advance 10 s; assert `State == Idle` and the fake engine never saw a `stop`.

`Sub400ms_IsDiscarded` — reach Recording, emit <400 ms of speech, `ToggleAsync`; assert `Idle` and no `stop` sent.

`TrailingSilenceTrimmedBeforeFinalFlush` — speech then 500 ms trailing quiet then stop; assert the last bytes sent end at the speech boundary (no trailing silence frames in the final flush).

`EmptyTranscript_SkipsInsertion` — fake engine returns `Text = "   "`; assert `FakeTextInserter` never called.

`Error_NonRetryable_NoRetry` — fake engine throws `TranscriptionException(code:"quota_exceeded", retryable:false)` on `StopAsync`; assert pill `Error` with `CanRetry == false` and the engine's `StartAsync` not called again.

`Escape_Cancels` — `CancelAsync` during Recording; assert `Idle`, `FakeTextInserter` not called, engine `CancelAsync` called.

`AudioDeviceDisappears_AbortsToIdle` — during Recording, fake capture raises `DeviceLost`; assert `State == Idle` and pill is `Error`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: FAIL.

- [ ] **Step 3: Implement the state machine and interfaces**

`SessionCoordinator` is the only component that knows the flow. On `ToggleAsync` it starts capture and `StartAsync` concurrently, buffers pre-`ready` encoded Ogg bytes, transitions to Recording only when both frames and `ready` arrive, then flushes the buffer. Recording feeds the ring buffer → `SilenceDetector` + `OpusEncoder`, streaming encoded bytes as produced. Timers (connecting/transcribing/inserting/silence/no-speech/hard-cap) all use `IClock.UtcNow` so tests drive them deterministically. `TrailingHangoverMs = 0` means silence frames are trimmed before the final flush. On `final`, trim to `MinDurationMs`/empty checks, then `ITextInserter.InsertAsync`. `IAudioCapture.DeviceLost` aborts to `Idle` with an error. `unauthenticated` triggers exactly one `AuthStore.RefreshIfNeededAsync` + reconnect.

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add windows/TypeByVoice.Core/Platform windows/TypeByVoice.Core/Session windows/TypeByVoice.Core.Tests/SessionCoordinatorTests.cs
git commit -m "feat(windows): session state machine and platform interfaces"
```

---

### Task 9: Windows app shell (tray, single instance)

**Files:**
- Create: `windows/TypeByVoice.Windows/App.xaml` + `App.xaml.cs`
- Create: `windows/TypeByVoice.Windows/SingleInstance.cs`
- Create: `windows/TypeByVoice.Windows/TrayIconController.cs`

**Interfaces:**
- Consumes: (none from earlier tasks beyond the project references)
- Produces: `public static class SingleInstance { public static bool TryAcquire(out IDisposable mutex); }`; `public sealed class TrayIconController : IDisposable { public TrayIconController(Action onOpenSettings, Action onQuit); }` (uses `System.Windows.Forms.NotifyIcon` with a context menu: Settings, Quit).

- [ ] **Step 1: Write the shell** — `App.xaml` is `ShutdownMode="OnExplicitShutdown"` (tray app, no main window); `OnStartup` calls `SingleInstance.TryAcquire`, exits if a second instance, else builds the tray icon.

- [ ] **Step 2: Build on Windows**

Run (in the VM or CI): `dotnet build windows/TypeByVoice.sln -c Debug`
Expected: BUILD succeeds (this is the first task that requires a Windows toolchain — on the Mac this task is unverified and is reviewed in the VM).

- [ ] **Step 3: Manual verification**

Run: launch twice; second launch activates the first and exits; tray icon appears with Settings and Quit; Quit exits.

- [ ] **Step 4: Commit**

```bash
git add windows/TypeByVoice.Windows/App.xaml windows/TypeByVoice.Windows/App.xaml.cs windows/TypeByVoice.Windows/SingleInstance.cs windows/TypeByVoice.Windows/TrayIconController.cs
git commit -m "feat(windows): tray app shell and single instance"
```

---

### Task 10: HotkeyService

**Files:**
- Create: `windows/TypeByVoice.Windows/Hotkeys/HotkeyService.cs`
- Create: `windows/TypeByVoice.Windows/Hotkeys/NativeMethods.cs` (`RegisterHotKey`, `UnregisterHotKey`, `WM_HOTKEY`)

**Interfaces:**
- Produces: `public sealed class HotkeyService : IHotkey { public HotkeyService(uint modifiers, uint virtualKey); public event Action? Toggled; public void Start(); public void Stop(); }` — registers a global hotkey on a message-only window and raises `Toggled` on `WM_HOTKEY`; throws if `RegisterHotKey` fails (already taken).

- [ ] **Step 1: Implement** `HotkeyService` per the interface, reading modifiers/virtual key from `SettingsStore` at construction.

- [ ] **Step 2: Build on Windows**

Run: `dotnet build windows/TypeByVoice.sln -c Debug`
Expected: BUILD succeeds.

- [ ] **Step 3: Manual verification**

Run: with the default `Ctrl+Shift+Space`, press it; the toggle fires (wire a temporary `Console.WriteLine`); change the hotkey in `settings.json` and restart; confirm the new combination works and a conflicting combination (e.g. `Ctrl+C`) fails fast with an error dialog.

- [ ] **Step 4: Commit**

```bash
git add windows/TypeByVoice.Windows/Hotkeys
git commit -m "feat(windows): global hotkey via RegisterHotKey"
```

---

### Task 11: WasapiAudioCapture

**Files:**
- Create: `windows/TypeByVoice.Windows/Audio/WasapiAudioCapture.cs`

**Interfaces:**
- Produces: `public sealed class WasapiAudioCapture : IAudioCapture { public WasapiAudioCapture(); public event Action<ReadOnlyMemory<short>>? SamplesAvailable; public event Action? DeviceLost; public Task StartAsync(CancellationToken ct); public Task StopAsync(CancellationToken ct); }` — NAudio `WasapiCapture` on the default device delivering 16 kHz mono 16-bit PCM; `MediaFoundationResampler` fallback when the device cannot deliver 16 kHz directly; raises `DeviceLost` when NAudio reports the device stopped; throws a `NoInputDeviceException` when no usable device exists.

- [ ] **Step 1: Implement** `WasapiAudioCapture` per the interface (add NuGet `NAudio` to `TypeByVoice.Windows`); capture callback converts to `short[]`, raises `SamplesAvailable`, and maps NAudio's recording-stopped event to `DeviceLost`.

- [ ] **Step 2: Build on Windows**

Run: `dotnet build windows/TypeByVoice.sln -c Debug`
Expected: BUILD succeeds.

- [ ] **Step 3: Manual verification**

Run: with a temporary listener, start capture and speak; confirm PCM frames arrive at 16 kHz mono; deny the mic in Settings and confirm `StartAsync` surfaces the failure immediately rather than a silent no-op.

- [ ] **Step 4: Commit**

```bash
git add windows/TypeByVoice.Windows/Audio/WasapiAudioCapture.cs
git commit -m "feat(windows): WASAPI microphone capture via NAudio"
```

---

### Task 12: ClipboardPasteInserter + DpapiTokenStore

**Files:**
- Create: `windows/TypeByVoice.Windows/Insertion/ClipboardPasteInserter.cs`
- Create: `windows/TypeByVoice.Core/Auth/DpapiTokenStore.cs` (in Core so `Core.Tests` can reference it; DPAPI compiles cross-platform but is Windows-only at runtime)
- Test: `windows/TypeByVoice.Core.Tests/DpapiTokenStoreTests.cs` (runs on Windows CI only)

**Interfaces:**
- Produces: `public sealed class ClipboardPasteInserter : ITextInserter { public ClipboardPasteInserter(int restoreDelayMs = 150); public Task InsertAsync(string text, CancellationToken ct); }` — save clipboard (all formats) → set text → `SendInput` Ctrl+V → restore after `restoreDelayMs`; falls back to leaving the transcript on the clipboard + a notification when paste is unavailable. `public sealed class DpapiTokenStore : ITokenStore` — DPAPI `ProtectedData` (`CurrentUser`) persisted under `%APPDATA%\TypeByVoice\`.

- [ ] **Step 1: Implement** both classes. `ClipboardPasteInserter` uses `System.Windows.Clipboard` + `SendInput` (P/Invoke) for the Ctrl+V keystroke. `DpapiTokenStore` adds NuGet `System.Security.Cryptography.ProtectedData` to `TypeByVoice.Core` and persists protected blobs under `%APPDATA%\TypeByVoice\`.

- [ ] **Step 2: DPAPI round-trip test (Windows CI)**

`DpapiTokenStore_RoundTrips` — guard with `if (!OperatingSystem.IsWindows()) return;`; set access+refresh, create a new store instance, assert both read back equal; assert the on-disk bytes do not contain the plaintext.

Run: `dotnet test windows/TypeByVoice.Core.Tests -v minimal` (on `windows-latest`).
Expected: PASS.

- [ ] **Step 3: Build on Windows**

Run: `dotnet build windows/TypeByVoice.sln -c Debug`
Expected: BUILD succeeds.

- [ ] **Step 4: Manual insertion matrix (do not automate)**

For each cell, focus an editable field, dictate a short phrase, verify insert, then verify prior clipboard contents are restored after 150 ms: Notepad, VS Code, PowerShell/cmd, a browser text field — each **with and without** a clipboard manager (Ditto, Windows clipboard history Win+V). Record any app that only keeps the transcript on the clipboard (fallback).

- [ ] **Step 5: Commit**

```bash
git add windows/TypeByVoice.Windows/Insertion windows/TypeByVoice.Core/Auth/DpapiTokenStore.cs windows/TypeByVoice.Core.Tests/DpapiTokenStoreTests.cs
git commit -m "feat(windows): clipboard paste inserter and DPAPI token store"
```

---

### Task 13: PillWindow + OverlayController

**Files:**
- Create: `windows/TypeByVoice.Windows/Overlay/PillWindow.xaml` + `.cs`
- Create: `windows/TypeByVoice.Windows/Overlay/OverlayController.cs`

**Interfaces:**
- Produces: `public sealed class OverlayController { public void Apply(PillStatus status); public void Hide(); }` — drives a topmost, transparent, non-activating `PillWindow` (`WindowStyle=None`, `AllowsTransparency=True`, `Topmost=True`, `ShowActivated=False`, `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`) positioned bottom-centre of the active screen; renders `Connecting` / `Listening` (live level + elapsed seconds) / `Transcribing` (indeterminate progress) / `Error` (message + retry when `CanRetry`) / `QuotaLow` / `QuotaExhausted`.

- [ ] **Step 1: Implement** the window and controller per the interface.

- [ ] **Step 2: Build on Windows**

Run: `dotnet build windows/TypeByVoice.sln -c Debug`
Expected: BUILD succeeds.

- [ ] **Step 3: Manual verification**

Run: drive each `PillStatus` from a temporary button; confirm the window never steals focus (click into Notepad, show pill, confirm caret stays in Notepad); confirm Listening shows elapsed time.

- [ ] **Step 4: Commit**

```bash
git add windows/TypeByVoice.Windows/Overlay
git commit -m "feat(windows): floating pill overlay"
```

---

### Task 14: Onboarding + Settings views

**Files:**
- Create: `windows/TypeByVoice.Windows/Views/OnboardingWindow.xaml` + `.cs`
- Create: `windows/TypeByVoice.Windows/Views/SettingsWindow.xaml` + `.cs`

**Interfaces:**
- Consumes: `AuthStore`, `SettingsStore`.
- Produces: onboarding flow Welcome → sign in / create account (`AuthStore.LoginAsync` / `RegisterAsync`) → microphone consent note → confirm default hotkey (simple field, no recorder); Settings re-checkable: hotkey field, silence threshold, clipboard restore delay, sign out.

- [ ] **Step 1: Implement** both windows; wire buttons to `AuthStore` and `SettingsStore` calls with simple error text on failure.

- [ ] **Step 2: Build on Windows**

Run: `dotnet build windows/TypeByVoice.sln -c Debug`
Expected: BUILD succeeds.

- [ ] **Step 3: Manual verification**

Run: sign in and create an account against the local backend; confirm tokens persist across restart; confirm hotkey change persists to `settings.json`.

- [ ] **Step 4: Commit**

```bash
git add windows/TypeByVoice.Windows/Views
git commit -m "feat(windows): onboarding and settings windows"
```

---

### Task 15: Composition root (AppModel) + endpoint config

**Files:**
- Create: `windows/TypeByVoice.Windows/AppModel.cs`
- Create: `windows/TypeByVoice.Windows/AppEndpoints.cs`

**Interfaces:**
- Produces: `public static class AppEndpoints { public static Uri ApiBaseUrl(); public static Uri DictateUrl(); }` — env `TBV_API_URL` / `TBV_DICTATE_URL` first; Debug falls back to `http://127.0.0.1:3000` / `ws://127.0.0.1:3000/v1/dictate`; Release requires the values. `public sealed class AppModel` — constructs `AuthStore`, `SettingsStore`, `SessionCoordinator`, `HotkeyService`, `WasapiAudioCapture`, `RemoteTranscriptionEngine`, `ClipboardPasteInserter`, `OverlayController`, and connects `HotkeyService.Toggled → SessionCoordinator.ToggleAsync`, `StateChanged/PillChanged → OverlayController`.

- [ ] **Step 1: Implement** `AppEndpoints` and `AppModel`; wire the full loop in `App.OnStartup`.

- [ ] **Step 2: Build on Windows**

Run: `dotnet build windows/TypeByVoice.sln -c Debug`
Expected: BUILD succeeds.

- [ ] **Step 3: Manual end-to-end verification**

Run against the local backend: dictate a short phrase via the hotkey and confirm it lands at the caret; confirm the pill cycles Connecting → Listening → Transcribing; confirm idle CPU under ~1% of one core.

- [ ] **Step 4: Commit**

```bash
git add windows/TypeByVoice.Windows/AppModel.cs windows/TypeByVoice.Windows/AppEndpoints.cs windows/TypeByVoice.Windows/App.xaml.cs
git commit -m "feat(windows): composition root and endpoint config"
```

---

### Task 16: Publish + CI

**Files:**
- Create: `.github/workflows/windows-client.yml`
- Create: `windows/Scripts/publish.sh`

**Interfaces:**
- Produces: CI on `windows-latest` that (1) installs .NET 8, (2) `dotnet test windows/TypeByVoice.Core.Tests`, (3) runs a pipeline integration test — real `WasapiAudioCapture` (or a PCM fixture) → `OpusEncoder` → `RemoteTranscriptionEngine` against the `contracts/dictation-v1` cli-mock — asserting the mock returns a `final`, (4) `dotnet publish -r win-x64` and `-r win-arm64` self-contained. `publish.sh` documents the same two `dotnet publish` commands locally.

- [ ] **Step 1: Write the pipeline integration test**

`windows/TypeByVoice.Core.Tests/DictationPipelineIntegrationTests.cs` — start the Node `cli-mock` (`contracts/dictation-v1`), connect `RemoteTranscriptionEngine` with a `ClientWebSocketDictationSocket`, feed ~2 s of synthesized PCM through `OpusEncoder`, `StopAsync`, assert a non-empty `final.Text`. Mark `[Trait("Category","Integration")]` and skip unless `TBV_CLI_MOCK` is set.

- [ ] **Step 2: Run the integration test in the VM**

Run: `TBV_CLI_MOCK=1 dotnet test windows/TypeByVoice.Core.Tests --filter "Category=Integration"`
Expected: PASS (proves the Ogg framing is server-compatible — the Task 4 risk, closed here).

- [ ] **Step 3: Write the workflow and publish script**

Workflow triggers on push/PR to paths `windows/**`; runs the unit tests, the integration test (with cli-mock), and both publishes; uploads the zips as artifacts. `publish.sh` runs the same `dotnet publish` commands.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/windows-client.yml windows/Scripts/publish.sh windows/TypeByVoice.Core.Tests/DictationPipelineIntegrationTests.cs
git commit -m "ci(windows): build, test, and publish workflow"
```

---

## Notes for the implementer

- Tasks 1–8 are buildable and testable on macOS (`dotnet test windows/TypeByVoice.Core.Tests`); tasks 9–16 require the Windows VM or `windows-latest` CI and are verified by build + the manual matrix rather than xUnit, by design (WPF/Win32 interop is not unit-testable off-Windows).
- `.NET 8 SDK` must be installed on the Mac before Task 1's `dotnet test` (per spec §Build, test, and development loop).
- The dictation protocol contract is `docs/superpowers/specs/2026-09-13-dictation-protocol.md`; message field names must match it exactly.
