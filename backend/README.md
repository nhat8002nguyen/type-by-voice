# Type by Voice — backend

Nest 12 ESM monorepo. The only public process is `api` on port **3000** (HTTP + WebSocket `/v1/dictate`). Other apps are internal (NATS / RabbitMQ).

Specs: [`docs/superpowers/specs/2026-09-13-backend-design.md`](../docs/superpowers/specs/2026-09-13-backend-design.md), [`docs/superpowers/specs/2026-09-13-dictation-protocol.md`](../docs/superpowers/specs/2026-09-13-dictation-protocol.md).

## Run the stack

Needs Docker. Compose builds with Node 24 (`Dockerfile.dev`) and does **not** mount host `node_modules`.

```bash
cd backend
docker compose up -d
```

Wait until `api` is up, then:

```bash
curl -s http://127.0.0.1:3000/health
```

Expect Terminus JSON with `"status": "ok"` (Postgres ping).

Default speech backend is **fake** (`SPEECH_PROVIDER=fake` in compose). It returns `the transcribed text` and does not need `GROQ_API_KEY`. To use Groq:

```bash
GROQ_API_KEY=... docker compose up -d
```

Set `SPEECH_PROVIDER=groq` on `speech-service` (or just set the key — a non-empty `GROQ_API_KEY` selects Groq). Switch models at deploy with `GROQ_MODEL`:

- `whisper-large-v3-turbo` (default) — faster
- `whisper-large-v3` — slightly more accurate

```bash
GROQ_MODEL=whisper-large-v3 docker compose up -d --force-recreate speech-service
```

Nest Observe is **off** unless both `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` are set. Empty keys caused `Telemetry rejected (401)` in `api` logs. To enable it, create an app at [observe.nestjs.com](https://observe.nestjs.com) and restart compose:

```bash
OBSERVE_APP_KEY=... OBSERVE_APP_SECRET=... docker compose up -d
```

Credentials are read once at process start; change them only with a restart.

Stop:

```bash
docker compose down
```

Unit tests (host Node **≥ 24.9.0**):

```bash
cd backend
npm ci
npm test
```

`npm run test:e2e` is leftover Nest Hello World specs. They boot app modules in-process and are not a product suite. Live dictation uses the harness below.

## Manual HTTP

Base URL: `http://127.0.0.1:3000`. Register, login, and refresh **require** client identity:

- `platform`: `macos` | `windows` | `ios` | `android`
- `clientVersion`: any string (example: `1.0.0+12`)
- `deviceId`: UUID v4

Reuse the same `deviceId` for login/refresh of that install. Access JWT TTL is **15 minutes**; send `Authorization: Bearer <accessToken>`.

Auth routes are limited to **10/min/IP** and **5/min/email** (login). Five consecutive login failures lock the account briefly.

```bash
IDENTITY='"platform":"macos","clientVersion":"1.0.0+12","deviceId":"9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77"'

# Register — 201 { accessToken, refreshToken, expiresIn }
curl -s http://127.0.0.1:3000/v1/auth/register \
  -H 'content-type: application/json' \
  -d "{\"email\":\"dev@example.com\",\"password\":\"a-long-enough-password\",$IDENTITY}"

# Login — 200, same token shape
curl -s http://127.0.0.1:3000/v1/auth/login \
  -H 'content-type: application/json' \
  -d "{\"email\":\"dev@example.com\",\"password\":\"a-long-enough-password\",$IDENTITY}"

export TOKEN='<accessToken>'
export REFRESH='<refreshToken>'

# Refresh — 200; rotate refresh. platform + deviceId must match the session
curl -s http://127.0.0.1:3000/v1/auth/refresh \
  -H 'content-type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH\",$IDENTITY}"

# Logout this device — 204
curl -s -X POST http://127.0.0.1:3000/v1/auth/logout \
  -H "authorization: Bearer $TOKEN"

# Profile / quota / devices
curl -s http://127.0.0.1:3000/v1/me -H "authorization: Bearer $TOKEN"
curl -s http://127.0.0.1:3000/v1/me/quota -H "authorization: Bearer $TOKEN"
curl -s http://127.0.0.1:3000/v1/me/sessions -H "authorization: Bearer $TOKEN"
curl -s -X DELETE http://127.0.0.1:3000/v1/me/sessions/<sessionId> \
  -H "authorization: Bearer $TOKEN"

# Transcripts (empty until a dictation `final` has been persisted)
curl -s 'http://127.0.0.1:3000/v1/transcripts?limit=20' -H "authorization: Bearer $TOKEN"
curl -s 'http://127.0.0.1:3000/v1/transcripts?q=hello' -H "authorization: Bearer $TOKEN"
curl -s http://127.0.0.1:3000/v1/transcripts/<id> -H "authorization: Bearer $TOKEN"
curl -s http://127.0.0.1:3000/v1/transcripts/export -H "authorization: Bearer $TOKEN"
curl -s -X DELETE http://127.0.0.1:3000/v1/transcripts/<id> \
  -H "authorization: Bearer $TOKEN"
```

Email verification is **not** required to login. Dev mailer logs `{ type, userId, email }` only (no token). `POST /v1/auth/verify-email` and `reset-password` need the token from the `auth_token` row in `api-db` if you want to exercise those paths:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/auth/forgot-password \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'

curl -s -X POST http://127.0.0.1:3000/v1/auth/verify-email \
  -H 'content-type: application/json' \
  -d '{"token":"<from-db>"}'

curl -s -X POST http://127.0.0.1:3000/v1/auth/reset-password \
  -H 'content-type: application/json' \
  -d '{"token":"<from-db>","password":"new-password"}'
```

Unknown `platform` or a non-UUID-v4 `deviceId` → `400` `{ "code": "invalid_request" }`.

## Manual dictation

Protocol: [`docs/superpowers/specs/2026-09-13-dictation-protocol.md`](../docs/superpowers/specs/2026-09-13-dictation-protocol.md). The contract package drives a live session for you.

1. Compose is up (`api` on `:3000`).
2. Register or login; copy `accessToken`.
3. From `contracts/dictation-v1` (host Node ≥ 24.9.0):

```bash
cd contracts/dictation-v1
npm ci
DICTATE_URL=ws://127.0.0.1:3000/v1/dictate \
DICTATE_TOKEN=<accessToken> \
HARNESS_RUNS=1 \
HARNESS_AUDIO=/path/to/speech.ogg \
npm run harness
```

Optional: `HARNESS_RUNS` (default 20). `HARNESS_AUDIO` defaults to `audio/speech-1s.ogg`. Each run prints `final.text`; the JSON report includes `finals`. Fake-provider localhost budget: **`totalMs.p95` under 3000 ms**.

Without `DICTATE_URL`, the same script talks to an in-process mock (no backend). See [`contracts/dictation-v1/README.md`](../contracts/dictation-v1/README.md).

WebSocket upgrade uses `Authorization: Bearer <accessToken>`. Failed auth closes **4401**; quota exhausted **4403**; rate limited **4429**.
