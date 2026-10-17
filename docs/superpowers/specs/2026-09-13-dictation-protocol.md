# Dictation Protocol v1

**Date:** 2026-09-13
**Amended:** 2026-09-14 — contract is for every official client (`macos`, `windows`, `ios`, `android`), not Mac-only. Capture may start before `ready`; upload and the listening indicator must not.
**Amended:** 2026-10-03 — `language` may be omitted to auto-detect, and a new `translateToEnglish` field supports `vi → en` in one provider call. `en → vi` is out of scope (it would require a second, non-speech provider call).
**Status:** Design approved, pending spec review

The contract between any official client and the backend. Both sides implement
this document; neither may assume behaviour not described here. The backend
must not require macOS-only headers, stores, or audio stacks. How a client
captures audio, stores tokens, or inserts text is out of scope for this
protocol.

## Transport

Endpoint: `wss://api.<domain>/v1/dictate`

Authentication is a bearer access token on the upgrade request:

```
Authorization: Bearer <accessToken>
```

The connection is opened when the user starts dictating and kept alive for a
short idle period afterwards (default 60s) so consecutive dictations reuse it
and skip the TLS handshake. The server may close idle connections at any time;
the client must treat that as normal and reconnect on the next dictation.

One connection carries at most one active dictation session at a time. A session
is identified by a client-generated `requestId` (UUID v4).

## Audio format

The client encodes captured audio as **Ogg Opus**: 16 kHz, mono, ~24 kbps,
20 ms frames. After `ready`, it streams the raw container bytes as they are
produced, so the server can concatenate them into a valid `.ogg` file without
muxing.

The client **may** open the microphone and encode locally before `ready`, and
**must** hold those bytes until `ready`, then flush them immediately as the
first binary frames. That is how leading words survive a slow handshake or
audio-route change. Binary frames before `ready` are `invalid_request`.

Binary frames should carry roughly 200 ms of audio each to balance overhead
against latency. Frame boundaries carry no meaning; the server treats the
binary stream as an ordered byte stream.

The client must not present a “listening / speak now” indicator until (1) the
microphone is producing frames and (2) `ready` has arrived. Until then, show
connecting. This is a client UX rule; the server only enforces the frame order
above. Mobile audio-session and speaker/mic route changes can take 1–2 s;
Connecting exists so the user does not speak into a dead route.

## Client to server messages

All control messages are JSON text frames with a `type` field.

### `start`

Opens a session. Must precede any binary frame.

```json
{
  "type": "start",
  "requestId": "3f2b...",
  "codec": "opus",
  "container": "ogg",
  "sampleRate": 16000,
  "channels": 1,
  "language": "vi",
  "translateToEnglish": false,
  "platform": "macos",
  "clientVersion": "1.0.0+12",
  "deviceId": "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77"
}
```

The server validates the audio parameters and rejects unsupported combinations
with `invalid_request`.

`language` is the input (spoken) language, ISO 639-1. v1 supports `en` and
`vi`. It may be omitted to let the server auto-detect the language. Omitting it
trades a little accuracy and latency for not requiring the user to pick a
language; supplying it skips detection and is faster and more accurate, so a
client should send it whenever the user has an explicit input-language setting.

`translateToEnglish` is an optional boolean, default `false`. When `true`, the
server transcribes and translates the audio to English instead of returning the
input language. It is meaningful for Vietnamese input (`vi → en`); with `en`
input the output is already English, so the field should be omitted and is
ignored if present. An unknown `language` value is `invalid_request`.

`platform`, `clientVersion`, and `deviceId` are required. `platform` is one of
`macos`, `windows`, `ios`, `android`. `clientVersion` is an opaque string the
client chooses (semver plus build is recommended, e.g. `1.0.0+12`). `deviceId`
is a UUID v4 generated once per install and reused for the life of that install.
`platform` and `deviceId` must match the auth session that issued the access
token; a mismatch is `invalid_request`. An unknown `platform` is
`invalid_request`. New platform values are added on the server before any
client sends them.

### `stop`

Signals the end of speech. No binary frames may follow for this session.

```json
{ "type": "stop", "requestId": "3f2b...", "durationMs": 11800 }
```

`durationMs` is advisory only. The server measures duration from the audio it
received and bills on its own measurement.

### `cancel`

Abandons the session. The server discards buffered audio, transcribes nothing,
and records no usage.

```json
{ "type": "cancel", "requestId": "3f2b..." }
```

## Server to client messages

### `ready`

Sent after a valid `start`. The client may begin **uploading** audio only after
receiving this. Local capture may already be running; flush the pre-`ready`
buffer immediately, then stream.

```json
{
  "type": "ready",
  "requestId": "3f2b...",
  "maxDurationMs": 300000,
  "quota": { "unit": "words", "limit": 2000, "used": 312, "resetAt": "2026-09-18T04:12:00Z" }
}
```

`maxDurationMs` is authoritative. The client should stop at that limit, and the
server enforces it regardless.

Quota is included here so the client can warn the user before they hit the wall
without needing a separate request.

### `final`

The transcription result. Terminal for the session.

```json
{
  "type": "final",
  "requestId": "3f2b...",
  "text": "the transcribed text",
  "wordCount": 42,
  "audioMs": 11800,
  "quota": { "unit": "words", "limit": 2000, "used": 354, "resetAt": "2026-09-18T04:12:00Z" }
}
```

`text` is raw provider output with no post-processing. It may be an empty
string, which means no speech was recognised; the client must insert nothing in
that case. When the session was started with `translateToEnglish: true`, `text`
is the English translation; otherwise it is in the input language.

`wordCount` is computed by the server and is the only authoritative count. The
client must never compute or display its own.

### `error`

Terminal for the session.

```json
{
  "type": "error",
  "requestId": "3f2b...",
  "code": "quota_exceeded",
  "message": "Weekly limit reached.",
  "retryable": false,
  "details": { "limit": 2000, "used": 2131, "resetAt": "2026-09-18T04:12:00Z" }
}
```

`retryable` tells the client whether retrying the same request could succeed. The
client must not retry when it is false.

## Error codes

| Code | Retryable | Meaning |
|---|---|---|
| `unauthenticated` | no | Missing, invalid, or expired token. Client should refresh and reconnect once |
| `quota_exceeded` | no | Word quota exhausted for the current period. Sent on a new `start` or as close `4403` at upgrade — never mid-utterance after `ready` |
| `audio_cap_exceeded` | no | Per-user audio-minute ceiling reached |
| `too_long` | no | Audio exceeded `maxDurationMs` |
| `invalid_request` | no | Malformed message or unsupported audio parameters |
| `rate_limited` | yes | Too many requests. `details.retryAfterMs` present |
| `provider_unavailable` | yes | Upstream speech provider failed |
| `internal` | yes | Unexpected server error |
| `session_timeout` | yes | No audio or no `stop` received within the server's session window |

## Close codes

| Code | Meaning |
|---|---|
| 1000 | Normal closure |
| 4401 | Authentication failed at upgrade |
| 4403 | Quota exhausted at upgrade |
| 4429 | Rate limited at upgrade |

## Idempotency

The server caches the outcome of each `requestId` for 5 minutes. Replaying a
`start`/`stop` with a `requestId` that already produced a `final` returns the
cached result and does not re-transcribe or double-count usage. This makes
retries over a flaky connection safe.

## Session limits

| Limit | Default | Enforced by |
|---|---|---|
| Max audio duration per session | 300 s | Both; server authoritative |
| Max time between `start` and first audio | 10 s | Server |
| Max time the client may stay in Connecting before `ready` + live mic | 5 s | Client; then error, do not look like listening |
| Max time between last audio and `stop` | 30 s | Server |
| Max concurrent sessions per user | 2 | Server (safety limit, not a Mac assumption) |
| Connection idle timeout | 60 s | Both |

## Versioning

The version lives in the path (`/v1/dictate`). Additive fields are allowed
within a version and both sides must ignore unknown fields. Removing or
repurposing a field requires a new version path, with the old one supported
until client telemetry shows it unused. Extending the `platform` enum is
additive: deploy the server first, then ship the new client.
