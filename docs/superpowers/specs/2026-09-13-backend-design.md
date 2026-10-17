# Backend Design

**Date:** 2026-09-13
**Amended:** 2026-09-14 — public APIs are client-agnostic; sessions carry `platform` / `deviceId`
**Amended:** 2026-10-03 — Vietnamese in scope; `vi → en` via a single provider call. `en → vi` is out of scope.
**Status:** Design approved, pending spec review
**Depends on:** `2026-09-13-dictation-protocol.md`

Nest.js **12** monorepo (latest stable as of 2026-09-13: `12.0.1`), TypeScript,
containerised, deployed to a Singapore region to keep round trips to primary
users in the tens of milliseconds.

**Language:** TypeScript only. That is Nest's default (`nest new`). Do not pass
`--language js`. Application source is `.ts`; plain JavaScript is not an
option for the product backend.

**Runtime:** Node.js **24 LTS** (“Krypton”). Product Dockerfiles use
`node:24-alpine`. `engines.node` is `>=24.9.0` — Nest 12 ships ESM-only
packages, and Jest can `require()` them only on Node 24.9+. Do not target the
skeleton’s Node 20 image. Node 26 is Current, not LTS, and is out of scope.

**Framework:** Nest **12**. Nest does not publish an LTS channel; 12 is the
current stable major. New apps follow `nest new` v12 defaults (TypeScript,
ESM). The course skeleton is Nest 11 / CommonJS and is **not** upgraded in
place.

**Skeleton:** `nestjs-microservices/` — official NestJS course “virtual
facility” example. Copy its *mechanics* (apps + libs, hybrid HTTP/microservice
processes, NATS + RabbitMQ, transactional outbox, inbox idempotency, TypeORM,
Terminus, tracing). Replace the buildings/alarms domain. Do not copy its
`package.json` versions or `node:20-alpine` Dockerfile.

**Nest 12 deltas vs the skeleton (must follow):**

- NATS client is `@nats-io/transport-node`, not the old `nats` package.
  `Transport.NATS` and queue names stay; direct imports and custom
  deserializers change (`msg.json()`, JSON-string packets).
- Prefer `@nestjs/observe` for process tracing where it replaces ad-hoc
  interceptors; keep `libs/tracing` only if it still adds request correlation
  the SDK does not.
- Validation may use Standard Schema; `class-validator` remains acceptable if
  that is what shared DTOs already use.

**Package manager:** decided when the product app is scaffolded (`nest new`).
Do not inherit the skeleton’s Yarn 1 `only-allow` hook unless we choose Yarn
deliberately.

## Responsibilities

| Concern | Description |
|---|---|
| Gateway | Terminates dictation WebSocket sessions, buffers audio, returns transcripts |
| Provider adapter | Calls the hosted speech provider; swappable |
| Auth | Email/password accounts, verification, sessions |
| Quota | Enforces word limits per plan period; tracks an audio ceiling |
| Usage | Per-request records supporting any future billing model |
| Transcripts | Encrypted storage with search, delete, and export |

## Apps (course template → product)

Same Nest CLI monorepo shape as the skeleton (`apps/*`, `libs/*`, one
`docker-compose.yml`). Course app names are not reused.

| Product app | Course analog | Transport | Owns |
|---|---|---|---|
| `api` | `virtual-facility` | Public HTTP + WebSocket (port 3000) | Auth, sessions, REST for every official client (account, quota, history, devices), `/v1/dictate`, in-memory Opus buffer |
| `quota-service` | `alarms-service` | NATS queue `quota-service` | Plans, subscriptions, period counters, usage records. Sole writer of `words_used` |
| `speech-service` | `alarms-classifier-service` | NATS request/response `speech.transcribe` | Groq adapter. Receives **one** assembled Ogg payload per session, never a live stream. Transcribes or translates to English (see Language and translation) |
| `workflows-service` | `workflows-service` | RabbitMQ queue `workflows-service`, own Postgres | After-dictate work: persist transcript, side effects. Inbox + manual ack |
| `notifications-service` | `notifications-service` | RabbitMQ queue `notifications-service` | Verification, password reset, quota emails |
| *(omit)* | `alarms-generator` | — | Course load generator. Not a production app |

`api` is a hybrid Nest app like `virtual-facility`: HTTP for browsers and every
official client (macOS now; Windows, iOS, Android later), WebSocket for the
dictation protocol. Internal service-to-service clients use `ClientProxy` /
`TracingClientProxy` as in the course (`send` for NATS RPC, `emit` for RMQ
events, outbox for the latter). The public API must not assume a Mac: no
Keychain, hotkey, Accessibility, or App Store semantics.

### Shared libs (keep from skeleton)

| Lib | Role |
|---|---|
| `libs/outbox` | Write event + row in one TypeORM transaction; scheduled processor publishes to RMQ |
| `libs/inbox` | Idempotent RMQ consumers (`messageId` required, else ack and drop) |
| `libs/tracing` | `TracingLogger`, `TracingClientProxy`, interceptors with `inheritAppConfig: true` on microservice connect |

Add product DTO libs the same way `libs/workflows` exists today (for example
quota and dictate message payloads). Do not put audio bytes in shared “event”
DTOs except the single `speech.transcribe` request.

### Infra (from `docker-compose.yml`)

NATS, RabbitMQ, Redis, Postgres **per stateful service** (course uses separate
`virtual-facility-db` and `workflows-db`). `synchronize` only when
`NODE_ENV === 'development'`.

### Invariants

- Live Opus frames stay in `api` and are discarded after `final` or `cancel`.
  They are never published to NATS or RabbitMQ.
- On `stop`, `api` may NATS-`send` **one** assembled Ogg buffer to
  `speech-service` (same idea as `alarms.classify`). That is the only time audio
  crosses a process boundary.
- Quota check/commit is only `quota-service`. Finish-then-block still applies.
- Official apps speak only the HTTP API below and
  `2026-09-13-dictation-protocol.md` to `api`. Platform-specific behaviour stays
  in the client.

## Dictation session flow

1. `api` authenticates the WebSocket upgrade (local sessions / identity). Close
   `4401` on failure.
2. `api` NATS-`send`s a quota check to `quota-service`. If words or the audio
   ceiling are exhausted, close `4403` without accepting audio.
3. On `start`, validate audio parameters and `language` (if present, one of
   `en` / `vi`), and that `platform` / `deviceId` match the auth session, then
   send `ready` including the quota snapshot from that check.
4. Buffer binary frames in `api` memory only. Enforce duration and inter-message
   timeouts from the protocol.
5. On `stop`, assemble one Ogg Opus payload in `api` and NATS-`send`
   `speech.transcribe` to `speech-service` carrying `language` and
   `translateToEnglish`. Audio is never written to disk.
6. `speech-service` returns text. `api` (or `quota-service` on commit) counts
   words with the one documented rule: trim, then split on whitespace runs.
7. `api` NATS-`send`s quota commit to `quota-service` (overshoot allowed;
   next `start` hard-blocks). Then writes an outbox row in the same transaction
   as any `api`-local bookkeeping and lets the outbox processor RMQ-`emit`
   `workflows.create` (persist transcript) and notification events.
8. `api` sends `final` to the client and discards the audio buffer.

On `cancel`, discard the buffer, call no speech provider, record no usage,
publish no workflow.

## Provider adapter

```ts
interface SpeechProvider {
  readonly name: string;
  transcribe(audio: Buffer, opts: {
    language?: string;        // ISO 639-1; omit to auto-detect
    translateToEnglish?: boolean;
  }): Promise<{
    text: string;
    providerLatencyMs: number;
  }>;
}
```

The Groq implementation posts the Ogg payload to the hosted Whisper endpoint —
`/openai/v1/audio/transcriptions` for transcription, `/openai/v1/audio/translations`
when `translateToEnglish` is set. Provider failures map to
`provider_unavailable`, which is retryable, and are counted as a metric so an
outage is visible rather than inferred from user complaints.

### Language and translation

Exactly one provider call per session, never two. The route table:

| Input | Output | Groq endpoint | Model |
|---|---|---|---|
| `vi` | `vi` | transcriptions, `language=vi` | `whisper-large-v3-turbo` (or `whisper-large-v3`) |
| `vi` / auto | `en` | translations | `whisper-large-v3` |
| `en` | `en` | transcriptions, `language=en` | `whisper-large-v3-turbo` (or `whisper-large-v3`) |
| `en` | `vi` | — | not supported |

- `translateToEnglish: true` routes to the translations endpoint, which always
  uses `whisper-large-v3` (the turbo model has no translation support).
- The translations endpoint takes no source-language hint, so `vi → en` relies
  on Whisper's auto-detection.
- Same-language transcription may use `whisper-large-v3-turbo` (cheaper, faster)
  or `whisper-large-v3` (more accurate). Default is turbo; `whisper-large-v3` is
  a configuration switch.
- `en → vi` is dropped: Whisper only translates *to* English, and the other
  direction would need a second LLM call, which v1 avoids by design.
- No sanitization / post-processing LLM pass in v1. Whisper already emits
  punctuation and casing; the `prompt` parameter (≤ 224 tokens) steers style and
  terminology when needed.

A single provider means a provider outage is a total product outage. A second
adapter is the cheapest available insurance and should land before any real user
base exists.

## Quota

The user-facing unit is **words**, because that is what users understand. Costs
are driven by audio seconds, not words, so a second and much more generous
**audio-minute ceiling** sits underneath purely to catch abuse and forgotten
open microphones. A normal user never touches it.

### Period resolution

Periods are fixed-length windows anchored to the user's signup timestamp.
Default length is 7 days, but the length lives in plan configuration so changing
to monthly is a data change.

When a request arrives and `now >= periodStart + periodLength`, the period rolls
forward and the counter resets. This is lazy and self-healing: no scheduled job
is required, and a user who does not dictate for a month still gets a correct
period on their next request.

### Enforcement

Checked before audio is accepted; committed after transcription, because a word
count does not exist until the text does.

**Finish-then-block (approved):** a request that starts under the limit is
always allowed to finish, even if the returned text pushes `words_used` past
`word_limit`. The overshoot is recorded. The *next* `start` (and any new
WebSocket upgrade) is hard-blocked with `quota_exceeded` / close `4403` until
the period resets or the user is moved to a plan with remaining words. Never
truncate, interrupt, or withhold the current utterance to stay under the cap.

The commit is a single atomic conditional update, since two concurrent sessions
would otherwise both pass the check. A second session that starts while the
first is still in flight is allowed only if `words_used < word_limit` at its
own check time; after both commit, both subsequent requests are blocked if the
combined total is at or over the limit.

### Adjustments

An adjustment mechanism allows granting or deducting words for a period,
recorded with a reason. The first support email will be from someone who
deserves their words back.

## Plans as data

Plans are rows, not conditionals. The free tier is an ordinary plan. Adding a
paid tier is an insert.

```
plans(id, name, word_limit, period_length_days, audio_minutes_ceiling,
      is_default, created_at)
```

`word_limit` null means unlimited. Default free plan: 2000 words, 7-day period.

Subscriptions are modelled from the start even though billing is not
implemented, so the schema does not need reshaping later:

```
subscriptions(id, user_id, plan_id, status, current_period_start,
              current_period_end, external_ref, created_at, updated_at)
```

## Data model

```
users(id, email, email_verified_at, password_hash, created_at, deleted_at)
sessions(id, user_id, refresh_token_hash, platform, client_version, device_id,
         user_agent, expires_at, revoked_at)
plans(...)                    -- above
subscriptions(...)            -- above
quota_periods(id, user_id, period_start, period_end, words_used,
              audio_ms_used, updated_at)
quota_adjustments(id, user_id, quota_period_id, words_delta, reason, created_at)
usage_records(id, user_id, request_id, session_id, platform, client_version,
              audio_ms, word_count, provider, provider_latency_ms,
              estimated_cost_micros, language, translate_to_english,
              created_at)
transcripts(id, user_id, request_id, ciphertext, word_count, audio_ms,
            created_at, deleted_at)
```

`platform` is `macos` | `windows` | `ios` | `android`. `device_id` is the
client-generated install UUID. Unique among active rows per
`(user_id, device_id)`: a new login from the same install rotates the refresh
token and revokes the previous one. `user_agent` is stored as a raw fallback
and is never the source of platform identity.

`usage_records.request_id` is unique, which is what makes protocol idempotency
enforceable at the storage layer rather than by convention.

`usage_records` is intentionally granular: any future billing model can be
computed from history that already exists. `platform` / `client_version` on
each row is what makes later per-device telemetry possible without parsing
`user_agent`. `language` records the requested input language (null when the
client asked for auto-detection) and `translate_to_english` the translation
mode, so `vi → vi`, `vi → en`, and `en → en` can be attributed separately.

## Transcript storage and privacy

Transcripts are encrypted at rest with a server-held key; the database column
holds ciphertext. Deletion is honoured for real, and export returns a user's
full history.

Transcript content never appears in logs, even though it is stored in the
database. Logs sprawl to places databases do not.

Search over encrypted content is the one real constraint this creates. For v1,
search decrypts a user's own transcripts server-side per query, which is
acceptable at expected history sizes and avoids leaking a searchable plaintext
index. If it becomes slow, revisit deliberately rather than by quietly storing
plaintext.

## Auth

Email and password with verified addresses. Argon2id hashing. Short-lived access
tokens paired with long-lived rotating refresh tokens; refresh tokens are stored
hashed and revocable per device (`device_id`). Password reset via emailed
single-use token.

Where a client stores tokens (Keychain, Credential Manager, Keystore) is a
client concern. The API only issues and revokes them.

### Client identity (required on register, login, and refresh)

```json
{
  "platform": "macos",
  "clientVersion": "1.0.0+12",
  "deviceId": "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77"
}
```

Same meanings as the dictation `start` message. Missing fields, a malformed
`deviceId`, or an unknown `platform` → `400` with `invalid_request`. A new
platform value is deployed on the server before any client sends it.

## Public HTTP API

JSON over HTTPS, versioned under `/v1`. Every official client uses this surface.
No Mac-only routes or headers. Unauthenticated except where noted.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/v1/auth/register` | no | Create account; body includes email, password, client identity |
| `POST` | `/v1/auth/login` | no | Issue access + refresh tokens; body includes email, password, client identity |
| `POST` | `/v1/auth/refresh` | refresh token | Rotate tokens; body includes client identity (`platform` / `deviceId` must match the session) |
| `POST` | `/v1/auth/logout` | access | Revoke this device session |
| `POST` | `/v1/auth/verify-email` | no | Body: emailed token |
| `POST` | `/v1/auth/forgot-password` | no | Body: email |
| `POST` | `/v1/auth/reset-password` | no | Body: emailed token, new password |
| `GET` | `/v1/me` | access | Account profile |
| `GET` | `/v1/me/quota` | access | Current period snapshot (same `quota` object as protocol `ready`) |
| `GET` | `/v1/me/sessions` | access | Active devices (`id`, `platform`, `clientVersion`, `deviceId`, `createdAt`) |
| `DELETE` | `/v1/me/sessions/:id` | access | Revoke another (or this) device |
| `GET` | `/v1/transcripts` | access | History; `q` search, cursor pagination |
| `GET` | `/v1/transcripts/:id` | access | One transcript |
| `DELETE` | `/v1/transcripts/:id` | access | Delete |
| `GET` | `/v1/transcripts/export` | access | Full history download |

Unknown JSON fields are ignored. Breaking changes take a new `/v2` prefix, same
rule as the dictation path.

## Limits and abuse controls

| Control | Default |
|---|---|
| Max concurrent dictation sessions per user | 2 (server safety limit, not a Mac assumption; raise in config when a second client ships) |
| Max audio duration per session | 300 s |
| Auth endpoint rate limits | Per IP and per account, with lockout backoff |
| Audio-minute ceiling per period | Plan-configured, generous |
| Max request body / frame sizes | Bounded, rejected with `invalid_request` |

## Observability

Structured JSON logs with a request ID correlating to the client's `requestId`,
plus `platform` and `deviceId`. Per-stage latency metrics — connection, audio
received, provider call, total — tagged by `platform` and by language mode
(`vi → vi`, `vi → en`, `en → en`) so a latency regression can be attributed
rather than guessed at. Provider error rate and quota rejection rate are both
tracked, because a rising quota rejection rate is a pricing signal, not just an
error.

## Testing

Unit tests for the protocol state machine (including every error code and each
session timeout), quota period resolution across boundaries and long gaps, the
atomicity of quota commits under concurrency, and word counting.

The provider adapter is tested against recorded fixtures rather than live API
calls, so tests are deterministic and free. These cover the language route
table: `language` forwarded for same-language transcription, the translations
endpoint (and only `whisper-large-v3`) selected for `translateToEnglish`, an
omitted `language` leaving the provider to auto-detect, and `en → vi` rejected
as unsupported.

Protocol and HTTP fixtures are shared with every official client so a contract
change breaks both sides' test suites.

An end-to-end latency harness measures capture-to-result p50 and p95 broken down
by stage. This is built first, before features, because round-trip latency is
the riskiest assumption in the system.

## Deferred

Subscription billing and payment provider integration, multi-region deployment,
a second speech provider, languages beyond English and Vietnamese (notably
`en → vi`, which needs a second LLM call), any transcript post-processing,
shipping Windows / Android / iOS clients (the API already accepts them), and the
course `alarms-generator` app (not shipped).
