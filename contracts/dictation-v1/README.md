# `@type-by-voice/dictation-v1`

Language-agnostic dictation v1 contract: types, fixtures, session machine, mock WebSocket server, and latency harness.

Spec: [`docs/superpowers/specs/2026-09-13-dictation-protocol.md`](../../docs/superpowers/specs/2026-09-13-dictation-protocol.md). Backend HTTP + compose: [`backend/README.md`](../../backend/README.md).

Needs Node **≥ 24.9.0**.

```bash
cd contracts/dictation-v1
npm ci
npm test
```

Audio fixtures: [`audio/README.md`](./audio/README.md).

## Latency harness

```bash
npm run harness
```

With no env, this starts an in-process mock dictate server, uploads `audio/speech-1s.ogg`, and prints each `final.text` plus p50/p95 stage timings. Mock `final` text is `the transcribed text`. Default token is `test-token`.

Against a live `api` (compose on `:3000`):

```bash
DICTATE_URL=ws://127.0.0.1:3000/v1/dictate \
DICTATE_TOKEN=<accessToken> \
HARNESS_RUNS=1 \
HARNESS_AUDIO="$PWD/audio/local/speech.ogg" \
npm run harness
```

Get `<accessToken>` from `POST /v1/auth/register` or `/v1/auth/login` (see backend README). Optional: `HARNESS_RUNS` (default 20). `HARNESS_AUDIO` must be Ogg Opus (16 kHz, mono, ~24 kbps); unset uses `audio/speech-1s.ogg`.

Each run prints `run N final.text: …`. The JSON report includes a `finals` array. If `totalMs.p95` exceeds **3000 ms**, the CLI prints a warning (it does not fail).

| Stage | Meaning |
|---|---|
| `connectMs` | Until WebSocket `open` |
| `readyMs` | `open` → `ready` (after `start`) |
| `uploadMs` | `ready` → last binary send |
| `finalMs` | `stop` → `final` |
| `totalMs` | `open` → `final` (does not include connect) |

`p50` is the median over the runs; `p95` is the 95th percentile. With the default 20 runs, treat p95 as a smoke budget, not a production SLO.
