# Dictation Protocol v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a language-agnostic dictation v1 contract package — JSON fixtures, TypeScript types/validators, a pure server session state machine, a mock WebSocket server, and a latency harness — so backend and every official client break together when the protocol changes.

**Architecture:** A standalone ESM package at `contracts/dictation-v1/` with no Nest or Swift dependency. Golden JSON fixtures are the shared source of truth (Swift tests load the JSON; the backend imports the TypeScript API). A clock-injected session machine encodes every server-side rule from the spec. A mock `ws` server speaks those fixtures so clients and the harness can run without the Nest stack. The harness is built here because round-trip latency is the riskiest product assumption and must be measurable before features.

**Tech Stack:** Node.js 24.9+, TypeScript (NodeNext / ESM), Vitest, `ws`, JSON Schema 2020-12. Optional live Groq probe when `GROQ_API_KEY` is set.

**Spec:** `docs/superpowers/specs/2026-09-13-dictation-protocol.md` (contract), `docs/superpowers/specs/2026-09-13-type-by-voice-overview.md` (latency budget and build order). Backend and macOS plans consume this package; they do not redefine message shapes.

**Follow-on plans:** `docs/superpowers/plans/2026-09-15-backend.md`, then `docs/superpowers/plans/2026-09-15-macos-client.md`.

## Global Constraints

- Node.js **24 LTS**, `engines.node` is `>=24.9.0`.
- TypeScript only. `"type": "module"`, `module`/`moduleResolution` `nodenext`, relative imports carry `.js` extensions.
- Package manager is **npm**. Do not add a Yarn `only-allow` hook.
- Use `const`/`let`, never `var`. Comments only where the code cannot explain itself.
- Official `platform` values are exactly `macos`, `windows`, `ios`, `android`. Unknown values are `invalid_request`.
- Additive JSON fields are ignored. Removing or repurposing a field requires `/v2`.
- Binary frames **before** `ready` are `invalid_request`. Local capture before `ready` is a client concern; this package only enforces wire order.
- Word count is trim, then split on whitespace runs. Empty/whitespace-only text is 0 words.
- `requestId` and `deviceId` are UUID v4 strings.
- Session timeouts (defaults): first audio 10s after `ready`, last-audio-to-stop 30s, max duration 120000 ms, idle connection 60s, idempotency cache 5 minutes, max concurrent sessions per user 2.
- Connecting UX timeout (5s) is **client-enforced**; do not encode it as a server close in this package.
- Never log transcript `text`. Harness output is stage timings and word counts only.
- Do not modify `nestjs-microservices/`. That tree is a course skeleton, not the product.

## File Structure

```
contracts/dictation-v1/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts                      public exports
    constants.ts                  platforms, close codes, limits, error catalog
    types.ts                      every wire message + QuotaSnapshot
    word-count.ts                 countWords()
    validate-start.ts             start-message structural validation
    session-machine.ts            server protocol state machine
    idempotency.ts                requestId outcome cache
    fixtures.ts                   load JSON from fixtures/
    mock-server.ts                in-process ws mock
    latency-harness.ts            p50/p95 stage timings
  fixtures/
    start.valid.json
    start.unknown-platform.json
    start.bad-codec.json
    start.missing-device-id.json
    stop.valid.json
    cancel.valid.json
    ready.json
    final.json
    final.empty.json
    error.unauthenticated.json
    error.quota_exceeded.json
    error.audio_cap_exceeded.json
    error.too_long.json
    error.invalid_request.json
    error.rate_limited.json
    error.provider_unavailable.json
    error.internal.json
    error.session_timeout.json
  audio/
    README.md                     how the ogg files were produced
    speech-1s.ogg                 committed 16 kHz mono Opus ~24 kbps
    silence-400ms.ogg
  test/
    word-count.test.ts
    validate-start.test.ts
    fixtures.test.ts
    session-machine.test.ts
    idempotency.test.ts
    mock-server.test.ts
    latency-harness.test.ts
```

**Responsibility split.** `constants.ts` and `types.ts` are the wire contract. `session-machine.ts` is the only place server session transitions live. `mock-server.ts` is a test double that drives the machine over real WebSocket frames. `latency-harness.ts` is a client of that socket (or a live URL) and never contains product features.

---

### Task 1: Package scaffold, constants, and types

**Files:**
- Create: `contracts/dictation-v1/package.json`
- Create: `contracts/dictation-v1/tsconfig.json`
- Create: `contracts/dictation-v1/vitest.config.ts`
- Create: `contracts/dictation-v1/src/constants.ts`
- Create: `contracts/dictation-v1/src/types.ts`
- Create: `contracts/dictation-v1/src/index.ts`
- Test: `contracts/dictation-v1/test/constants.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PLATFORMS`, `Platform`, `ERROR_CODES`, `ErrorCode`, `CLOSE_CODES`, `SESSION_LIMITS`, `QuotaSnapshot`, and every wire message type listed below.

- [ ] **Step 1: Write the failing test**

Create `contracts/dictation-v1/test/constants.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  CLOSE_CODES,
  ERROR_CODES,
  PLATFORMS,
  SESSION_LIMITS,
} from '../src/constants.js';

describe('dictation v1 constants', () => {
  it('lists the four official platforms', () => {
    expect([...PLATFORMS]).toEqual(['macos', 'windows', 'ios', 'android']);
  });

  it('marks quota_exceeded non-retryable and provider_unavailable retryable', () => {
    expect(ERROR_CODES.quota_exceeded.retryable).toBe(false);
    expect(ERROR_CODES.provider_unavailable.retryable).toBe(true);
  });

  it('uses the spec close codes', () => {
    expect(CLOSE_CODES.normal).toBe(1000);
    expect(CLOSE_CODES.unauthenticated).toBe(4401);
    expect(CLOSE_CODES.quota_exceeded).toBe(4403);
    expect(CLOSE_CODES.rate_limited).toBe(4429);
  });

  it('uses the spec session limits', () => {
    expect(SESSION_LIMITS.maxDurationMs).toBe(120_000);
    expect(SESSION_LIMITS.firstAudioTimeoutMs).toBe(10_000);
    expect(SESSION_LIMITS.stopTimeoutMs).toBe(30_000);
    expect(SESSION_LIMITS.idleTimeoutMs).toBe(60_000);
    expect(SESSION_LIMITS.idempotencyTtlMs).toBe(5 * 60_000);
    expect(SESSION_LIMITS.maxConcurrentSessions).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts/dictation-v1 && npm test -- test/constants.test.ts`
Expected: FAIL because the package and `src/constants.ts` do not exist.

- [ ] **Step 3: Write minimal implementation**

`package.json`:

```json
{
  "name": "@type-by-voice/dictation-v1",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.9.0" },
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^24.3.0",
    "@types/ws": "^8.18.0",
    "typescript": "^5.9.2",
    "vitest": "^3.2.4",
    "ws": "^8.18.3"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

`src/constants.ts`:

```ts
export const PLATFORMS = ['macos', 'windows', 'ios', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ERROR_CODES = {
  unauthenticated: { retryable: false },
  quota_exceeded: { retryable: false },
  audio_cap_exceeded: { retryable: false },
  too_long: { retryable: false },
  invalid_request: { retryable: false },
  rate_limited: { retryable: true },
  provider_unavailable: { retryable: true },
  internal: { retryable: true },
  session_timeout: { retryable: true },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const CLOSE_CODES = {
  normal: 1000,
  unauthenticated: 4401,
  quota_exceeded: 4403,
  rate_limited: 4429,
} as const;

export const SESSION_LIMITS = {
  maxDurationMs: 120_000,
  firstAudioTimeoutMs: 10_000,
  stopTimeoutMs: 30_000,
  idleTimeoutMs: 60_000,
  idempotencyTtlMs: 5 * 60_000,
  maxConcurrentSessions: 2,
} as const;
```

`src/types.ts`:

```ts
import type { ErrorCode, Platform } from './constants.js';

export interface QuotaSnapshot {
  unit: 'words';
  limit: number | null;
  used: number;
  resetAt: string;
}

export interface StartMessage {
  type: 'start';
  requestId: string;
  codec: 'opus';
  container: 'ogg';
  sampleRate: 16000;
  channels: 1;
  language: 'en';
  platform: Platform;
  clientVersion: string;
  deviceId: string;
}

export interface StopMessage {
  type: 'stop';
  requestId: string;
  durationMs: number;
}

export interface CancelMessage {
  type: 'cancel';
  requestId: string;
}

export type ClientTextMessage = StartMessage | StopMessage | CancelMessage;

export interface ReadyMessage {
  type: 'ready';
  requestId: string;
  maxDurationMs: number;
  quota: QuotaSnapshot;
}

export interface FinalMessage {
  type: 'final';
  requestId: string;
  text: string;
  wordCount: number;
  audioMs: number;
  quota: QuotaSnapshot;
}

export interface ErrorMessage {
  type: 'error';
  requestId: string;
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type ServerTextMessage = ReadyMessage | FinalMessage | ErrorMessage;
```

`src/index.ts` re-exports `constants.ts` and `types.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd contracts/dictation-v1 && npm install && npm test -- test/constants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/dictation-v1
git commit -m "feat: scaffold dictation v1 contract package with wire constants"
```

---

### Task 2: Golden JSON fixtures for every wire message

**Files:**
- Create: every file under `contracts/dictation-v1/fixtures/` listed in File Structure
- Create: `contracts/dictation-v1/src/fixtures.ts`
- Test: `contracts/dictation-v1/test/fixtures.test.ts`

**Interfaces:**
- Consumes: `StartMessage`, `StopMessage`, `CancelMessage`, `ReadyMessage`, `FinalMessage`, `ErrorMessage`, `ERROR_CODES`.
- Produces: `loadFixture<T>(name: string): T` and `FIXTURE_NAMES`.

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../src/constants.js';
import { loadFixture } from '../src/fixtures.js';
import type { ErrorMessage, StartMessage } from '../src/types.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

describe('protocol fixtures', () => {
  it('parses a valid start message', () => {
    const start = loadFixture<StartMessage>('start.valid.json');
    expect(start).toEqual({
      type: 'start',
      requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
      codec: 'opus',
      container: 'ogg',
      sampleRate: 16000,
      channels: 1,
      language: 'en',
      platform: 'macos',
      clientVersion: '1.0.0+12',
      deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
    });
  });

  it('has one error fixture per error code', () => {
    for (const code of Object.keys(ERROR_CODES)) {
      const error = loadFixture<ErrorMessage>(`error.${code}.json`);
      expect(error.type).toBe('error');
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(ERROR_CODES[code as keyof typeof ERROR_CODES].retryable);
    }
  });

  it('ignores unknown fields in a start fixture copy', () => {
    const raw = JSON.parse(
      readFileSync(join(fixturesDir, 'start.valid.json'), 'utf8'),
    ) as StartMessage & { extra?: string };
    raw.extra = 'future-field';
    expect(raw.type).toBe('start');
    expect(raw.extra).toBe('future-field');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts/dictation-v1 && npm test -- test/fixtures.test.ts`
Expected: FAIL with `Cannot find module '../src/fixtures.js'`.

- [ ] **Step 3: Write fixtures and loader**

Use these exact values (backend and Swift tests will copy them):

`fixtures/start.valid.json`:

```json
{
  "type": "start",
  "requestId": "3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f",
  "codec": "opus",
  "container": "ogg",
  "sampleRate": 16000,
  "channels": 1,
  "language": "en",
  "platform": "macos",
  "clientVersion": "1.0.0+12",
  "deviceId": "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77"
}
```

`fixtures/start.unknown-platform.json` — same as valid but `"platform": "linux"`.

`fixtures/start.bad-codec.json` — same as valid but `"codec": "pcm"`.

`fixtures/start.missing-device-id.json` — valid start without `deviceId`.

`fixtures/stop.valid.json`:

```json
{
  "type": "stop",
  "requestId": "3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f",
  "durationMs": 11800
}
```

`fixtures/cancel.valid.json`:

```json
{
  "type": "cancel",
  "requestId": "3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f"
}
```

`fixtures/ready.json`:

```json
{
  "type": "ready",
  "requestId": "3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f",
  "maxDurationMs": 120000,
  "quota": {
    "unit": "words",
    "limit": 2000,
    "used": 312,
    "resetAt": "2026-09-18T04:12:00Z"
  }
}
```

`fixtures/final.json`:

```json
{
  "type": "final",
  "requestId": "3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f",
  "text": "the transcribed text",
  "wordCount": 3,
  "audioMs": 11800,
  "quota": {
    "unit": "words",
    "limit": 2000,
    "used": 315,
    "resetAt": "2026-09-18T04:12:00Z"
  }
}
```

`fixtures/final.empty.json` — same as `final.json` but `"text": ""`, `"wordCount": 0`.

Error fixtures all use `requestId` `3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f` and `retryable` matching `ERROR_CODES`. Messages:

| File | code | message | details |
|---|---|---|---|
| `error.unauthenticated.json` | `unauthenticated` | `Missing, invalid, or expired token.` | omit |
| `error.quota_exceeded.json` | `quota_exceeded` | `Weekly limit reached.` | `{ "limit": 2000, "used": 2131, "resetAt": "2026-09-18T04:12:00Z" }` |
| `error.audio_cap_exceeded.json` | `audio_cap_exceeded` | `Audio-minute ceiling reached.` | `{ "limitMinutes": 180, "usedMinutes": 180 }` |
| `error.too_long.json` | `too_long` | `Audio exceeded maxDurationMs.` | `{ "maxDurationMs": 120000 }` |
| `error.invalid_request.json` | `invalid_request` | `Malformed message or unsupported audio parameters.` | omit |
| `error.rate_limited.json` | `rate_limited` | `Too many requests.` | `{ "retryAfterMs": 1000 }` |
| `error.provider_unavailable.json` | `provider_unavailable` | `Speech provider failed.` | omit |
| `error.internal.json` | `internal` | `Unexpected server error.` | omit |
| `error.session_timeout.json` | `session_timeout` | `No audio or no stop received within the session window.` | omit |

`src/fixtures.ts`:

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

export function loadFixture<T>(name: string): T {
  const raw = readFileSync(join(fixturesDir, name), 'utf8');
  return JSON.parse(raw) as T;
}
```

Re-export `loadFixture` from `src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd contracts/dictation-v1 && npm test -- test/fixtures.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/dictation-v1/fixtures contracts/dictation-v1/src/fixtures.ts contracts/dictation-v1/src/index.ts contracts/dictation-v1/test/fixtures.test.ts
git commit -m "feat: add dictation v1 golden JSON fixtures for every wire message"
```

---

### Task 3: Start-message validation and word count

**Files:**
- Create: `contracts/dictation-v1/src/word-count.ts`
- Create: `contracts/dictation-v1/src/validate-start.ts`
- Test: `contracts/dictation-v1/test/word-count.test.ts`
- Test: `contracts/dictation-v1/test/validate-start.test.ts`

**Interfaces:**
- Consumes: `StartMessage`, `PLATFORMS`, `loadFixture`.
- Produces: `countWords(text: string): number`; `validateStart(input: unknown): { ok: true; value: StartMessage } | { ok: false; code: 'invalid_request'; message: string }`.

- [ ] **Step 1: Write the failing tests**

`test/word-count.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { countWords } from '../src/word-count.js';

describe('countWords', () => {
  it('returns 0 for empty and whitespace-only text', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t  ')).toBe(0);
  });

  it('trims and splits on whitespace runs', () => {
    expect(countWords('the transcribed text')).toBe(3);
    expect(countWords('  hello   world  ')).toBe(2);
    expect(countWords('one\ttwo\nthree')).toBe(3);
  });
});
```

`test/validate-start.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../src/fixtures.js';
import { validateStart } from '../src/validate-start.js';
import type { StartMessage } from '../src/types.js';

describe('validateStart', () => {
  it('accepts the valid start fixture', () => {
    const result = validateStart(loadFixture('start.valid.json'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.platform).toBe('macos');
    }
  });

  it('rejects unknown platform, bad codec, and missing deviceId', () => {
    expect(validateStart(loadFixture('start.unknown-platform.json')).ok).toBe(false);
    expect(validateStart(loadFixture('start.bad-codec.json')).ok).toBe(false);
    expect(validateStart(loadFixture('start.missing-device-id.json')).ok).toBe(false);
  });

  it('ignores unknown fields', () => {
    const extra = { ...loadFixture<StartMessage>('start.valid.json'), extra: 1 };
    const result = validateStart(extra);
    expect(result.ok).toBe(true);
  });

  it('rejects a non-uuid deviceId', () => {
    const start = { ...loadFixture<StartMessage>('start.valid.json'), deviceId: 'not-a-uuid' };
    expect(validateStart(start).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd contracts/dictation-v1 && npm test -- test/word-count.test.ts test/validate-start.test.ts`
Expected: FAIL with modules not found.

- [ ] **Step 3: Write minimal implementation**

`src/word-count.ts`:

```ts
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}
```

`src/validate-start.ts`:

```ts
import { PLATFORMS, type Platform } from './constants.js';
import type { StartMessage } from './types.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message: string) {
  return { ok: false as const, code: 'invalid_request' as const, message };
}

export function validateStart(
  input: unknown,
): { ok: true; value: StartMessage } | { ok: false; code: 'invalid_request'; message: string } {
  if (typeof input !== 'object' || input === null) {
    return fail('start must be an object');
  }
  const value = input as Record<string, unknown>;
  if (value.type !== 'start') {
    return fail('type must be start');
  }
  if (typeof value.requestId !== 'string' || !UUID_V4.test(value.requestId)) {
    return fail('requestId must be UUID v4');
  }
  if (value.codec !== 'opus' || value.container !== 'ogg') {
    return fail('unsupported codec or container');
  }
  if (value.sampleRate !== 16000 || value.channels !== 1) {
    return fail('unsupported audio parameters');
  }
  if (value.language !== 'en') {
    return fail('unsupported language');
  }
  if (!PLATFORMS.includes(value.platform as Platform)) {
    return fail('unknown platform');
  }
  if (typeof value.clientVersion !== 'string' || value.clientVersion.length === 0) {
    return fail('clientVersion is required');
  }
  if (typeof value.deviceId !== 'string' || !UUID_V4.test(value.deviceId)) {
    return fail('deviceId must be UUID v4');
  }
  return {
    ok: true,
    value: {
      type: 'start',
      requestId: value.requestId,
      codec: 'opus',
      container: 'ogg',
      sampleRate: 16000,
      channels: 1,
      language: 'en',
      platform: value.platform as Platform,
      clientVersion: value.clientVersion,
      deviceId: value.deviceId,
    },
  };
}
```

Export both from `src/index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd contracts/dictation-v1 && npm test -- test/word-count.test.ts test/validate-start.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/dictation-v1/src/word-count.ts contracts/dictation-v1/src/validate-start.ts contracts/dictation-v1/src/index.ts contracts/dictation-v1/test
git commit -m "feat: validate dictation start messages and count words per spec"
```

---

### Task 4: Server session state machine — happy path

**Files:**
- Create: `contracts/dictation-v1/src/session-machine.ts`
- Test: `contracts/dictation-v1/test/session-machine.test.ts`

**Interfaces:**
- Consumes: `validateStart`, `countWords`, `SESSION_LIMITS`, `QuotaSnapshot`, `StartMessage`.
- Produces:

```ts
export type SessionStatus = 'open' | 'ready' | 'stopping' | 'closed';

export type SessionEvent =
  | { kind: 'text'; data: unknown }
  | { kind: 'binary'; bytes: Uint8Array }
  | { kind: 'tick'; nowMs: number };

export type SessionOutput =
  | { kind: 'send'; message: ReadyMessage | FinalMessage | ErrorMessage }
  | { kind: 'close'; code: number; reason: string }
  | { kind: 'transcribe'; requestId: string; audio: Uint8Array };

export interface SessionIdentity {
  userId: string;
  platform: Platform;
  deviceId: string;
}

export interface SessionMachineOptions {
  nowMs: () => number;
  identity: SessionIdentity;
  quota: QuotaSnapshot;
  maxDurationMs?: number;
}

export class DictationSession {
  constructor(options: SessionMachineOptions);
  readonly status: SessionStatus;
  readonly requestId: string | undefined;
  handle(event: SessionEvent): SessionOutput[];
  completeTranscription(input: {
    text: string;
    audioMs: number;
    quota: QuotaSnapshot;
  }): SessionOutput[];
  failTranscription(code: 'provider_unavailable' | 'internal'): SessionOutput[];
}
```

A later backend task constructs `DictationSession` per WebSocket. `completeTranscription` is how `speech-service` results re-enter the machine. The machine **never** calls a provider.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { SESSION_LIMITS } from '../src/constants.js';
import { loadFixture } from '../src/fixtures.js';
import { DictationSession } from '../src/session-machine.js';
import type { QuotaSnapshot, ReadyMessage, StartMessage } from '../src/types.js';

const quota: QuotaSnapshot = {
  unit: 'words',
  limit: 2000,
  used: 312,
  resetAt: '2026-09-18T04:12:00Z',
};

function session(now = 0) {
  let t = now;
  return new DictationSession({
    nowMs: () => t,
    identity: {
      userId: 'user-1',
      platform: 'macos',
      deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
    },
    quota,
  });
}

describe('DictationSession happy path', () => {
  it('sends ready after a valid start matching the auth identity', () => {
    const s = session();
    const out = s.handle({
      kind: 'text',
      data: loadFixture<StartMessage>('start.valid.json'),
    });
    expect(s.status).toBe('ready');
    expect(out).toEqual([
      {
        kind: 'send',
        message: {
          ...loadFixture<ReadyMessage>('ready.json'),
          maxDurationMs: SESSION_LIMITS.maxDurationMs,
          quota,
        },
      },
    ]);
  });

  it('buffers binary after ready and transcribes on stop', () => {
    const s = session();
    s.handle({ kind: 'text', data: loadFixture('start.valid.json') });
    const chunk = new Uint8Array([1, 2, 3]);
    expect(s.handle({ kind: 'binary', bytes: chunk })).toEqual([]);
    const out = s.handle({ kind: 'text', data: loadFixture('stop.valid.json') });
    expect(s.status).toBe('stopping');
    expect(out).toEqual([
      {
        kind: 'transcribe',
        requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
        audio: chunk,
      },
    ]);
  });

  it('emits final and closes after completeTranscription', () => {
    const s = session();
    s.handle({ kind: 'text', data: loadFixture('start.valid.json') });
    s.handle({ kind: 'binary', bytes: new Uint8Array([1]) });
    s.handle({ kind: 'text', data: loadFixture('stop.valid.json') });
    const out = s.completeTranscription({
      text: 'the transcribed text',
      audioMs: 11800,
      quota: { ...quota, used: 315 },
    });
    expect(s.status).toBe('closed');
    expect(out[0]).toMatchObject({
      kind: 'send',
      message: { type: 'final', text: 'the transcribed text', wordCount: 3, audioMs: 11800 },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts/dictation-v1 && npm test -- test/session-machine.test.ts`
Expected: FAIL with `DictationSession` not defined.

- [ ] **Step 3: Write the happy-path machine**

Implement `DictationSession` in `session-machine.ts` with private fields `status`, `requestId`, `audioChunks: Uint8Array[]`, `readyAtMs`, `lastAudioAtMs`, `identity`, `quota`, `maxDurationMs`, `nowMs`. On `start`: `validateStart`; reject if `platform`/`deviceId` !== `identity`; transition to `ready`; emit `ready`. On binary in `ready`: append bytes. On `stop`: concatenate chunks (empty `Uint8Array` if none), emit `transcribe`, status `stopping`. `completeTranscription` uses `countWords(text)` for `wordCount`, sends `final`, status `closed`. Ignore extra JSON fields by validating only known ones.

Concatenation helper:

```ts
function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
```

On `cancel` in `open` or `ready`: discard chunks, status `closed`, no `transcribe`, no `final`. Emit nothing (the socket stays up for a later `start` — one connection, at most one active session). After cancel, status is `open` again (idle, authenticated). Match this in the test once Task 5 adds the cancel case; for this task, implement cancel internally so Task 5 does not rewrite the constructor.

Idle-after-cancel: `status` becomes `'open'`, `requestId` `undefined`, `audioChunks` `[]`.

Export from `src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd contracts/dictation-v1 && npm test -- test/session-machine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/dictation-v1/src/session-machine.ts contracts/dictation-v1/src/index.ts contracts/dictation-v1/test/session-machine.test.ts
git commit -m "feat: add dictation session machine happy path"
```

---

### Task 5: Session machine — every error code and cancel

**Files:**
- Modify: `contracts/dictation-v1/src/session-machine.ts`
- Modify: `contracts/dictation-v1/test/session-machine.test.ts`

**Interfaces:**
- Consumes: `ERROR_CODES`, `CLOSE_CODES`, identity mismatch rule, binary-before-ready rule.
- Produces: `error` server messages with `retryable` taken from `ERROR_CODES[code]`; cancel discards audio and records no transcription.

- [ ] **Step 1: Write the failing tests**

Append to `test/session-machine.test.ts`:

```ts
describe('DictationSession errors', () => {
  it('rejects binary before ready as invalid_request', () => {
    const s = session();
    const out = s.handle({ kind: 'binary', bytes: new Uint8Array([1]) });
    expect(out[0]).toMatchObject({
      kind: 'send',
      message: { type: 'error', code: 'invalid_request', retryable: false },
    });
    expect(s.status).toBe('closed');
  });

  it('rejects start whose deviceId does not match the auth session', () => {
    const s = session();
    const start = {
      ...loadFixture<StartMessage>('start.valid.json'),
      deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    };
    const out = s.handle({ kind: 'text', data: start });
    expect(out[0]).toMatchObject({
      kind: 'send',
      message: { type: 'error', code: 'invalid_request', retryable: false },
    });
  });

  it('rejects unknown platform via the start fixture', () => {
    const s = session();
    const out = s.handle({
      kind: 'text',
      data: loadFixture('start.unknown-platform.json'),
    });
    expect(out[0]).toMatchObject({
      kind: 'send',
      message: { type: 'error', code: 'invalid_request' },
    });
  });

  it('rejects a second start while a session is active', () => {
    const s = session();
    s.handle({ kind: 'text', data: loadFixture('start.valid.json') });
    const out = s.handle({ kind: 'text', data: loadFixture('start.valid.json') });
    expect(out[0]).toMatchObject({
      kind: 'send',
      message: { type: 'error', code: 'invalid_request' },
    });
  });

  it('cancel discards audio and does not transcribe', () => {
    const s = session();
    s.handle({ kind: 'text', data: loadFixture('start.valid.json') });
    s.handle({ kind: 'binary', bytes: new Uint8Array([9]) });
    const out = s.handle({ kind: 'text', data: loadFixture('cancel.valid.json') });
    expect(out).toEqual([]);
    expect(s.status).toBe('open');
    expect(s.requestId).toBeUndefined();
  });

  it('too_long when received audio duration exceeds maxDurationMs', () => {
    const s = new DictationSession({
      nowMs: () => 0,
      identity: {
        userId: 'user-1',
        platform: 'macos',
        deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
      },
      quota,
      maxDurationMs: 20,
    });
    s.handle({ kind: 'text', data: loadFixture('start.valid.json') });
    // 20 ms Opus frame is 48 bytes at 24 kbps; send more than 20 ms worth by
    // telling the machine the advisory duration via a padded buffer plus stop.
    s.handle({ kind: 'binary', bytes: new Uint8Array(200) });
    const out = s.handle({
      kind: 'text',
      data: { type: 'stop', requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f', durationMs: 40 },
    });
    expect(out[0]).toMatchObject({
      kind: 'send',
      message: { type: 'error', code: 'too_long', retryable: false },
    });
    expect(s.status).toBe('closed');
  });

  it('failTranscription emits provider_unavailable as retryable', () => {
    const s = session();
    s.handle({ kind: 'text', data: loadFixture('start.valid.json') });
    s.handle({ kind: 'binary', bytes: new Uint8Array([1]) });
    s.handle({ kind: 'text', data: loadFixture('stop.valid.json') });
    const out = s.failTranscription('provider_unavailable');
    expect(out[0]).toMatchObject({
      kind: 'send',
      message: { type: 'error', code: 'provider_unavailable', retryable: true },
    });
  });
});
```

Duration enforcement: the server measures duration from audio it received. For this machine, compute `audioMs` as `bytes.length / 3` (3 bytes ≈ 1 ms at ~24 kbps). If `audioMs > maxDurationMs`, emit `too_long` instead of `transcribe`. Document that constant next to the helper as the v1 estimate; the Nest `api` may replace it with a real Ogg duration parser later without changing the error code.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts/dictation-v1 && npm test -- test/session-machine.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement error paths**

Add `error(code, requestId, details?)` helper that sets `retryable: ERROR_CODES[code].retryable` and uses the fixture messages from Task 2. Identity mismatch and `validateStart` failure both produce `invalid_request`. Binary while `status !== 'ready'` → `invalid_request` and `closed`. `stop`/`cancel` with unknown `requestId` → `invalid_request`. `failTranscription` only legal in `stopping`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd contracts/dictation-v1 && npm test -- test/session-machine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/dictation-v1/src/session-machine.ts contracts/dictation-v1/test/session-machine.test.ts
git commit -m "feat: cover dictation session error codes and cancel"
```

---

### Task 6: Session machine — timeouts via injected clock

**Files:**
- Modify: `contracts/dictation-v1/src/session-machine.ts`
- Modify: `contracts/dictation-v1/test/session-machine.test.ts`

**Interfaces:**
- Consumes: `SESSION_LIMITS.firstAudioTimeoutMs`, `SESSION_LIMITS.stopTimeoutMs`.
- Produces: on `tick`, `session_timeout` (retryable) when first audio is late or stop is late. Idle connection timeout is the WebSocket server's job, not this machine.

- [ ] **Step 1: Write the failing tests**

```ts
describe('DictationSession timeouts', () => {
  it('times out if no audio arrives within 10s of ready', () => {
    let now = 0;
    const s = new DictationSession({
      nowMs: () => now,
      identity: {
        userId: 'user-1',
        platform: 'macos',
        deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
      },
      quota,
    });
    s.handle({ kind: 'text', data: loadFixture('start.valid.json') });
    now = 10_001;
    const out = s.handle({ kind: 'tick', nowMs: now });
    expect(out[0]).toMatchObject({
      kind: 'send',
      message: { type: 'error', code: 'session_timeout', retryable: true },
    });
    expect(s.status).toBe('closed');
  });

  it('does not time out first-audio if a binary frame arrived', () => {
    let now = 0;
    const s = new DictationSession({
      nowMs: () => now,
      identity: {
        userId: 'user-1',
        platform: 'macos',
        deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
      },
      quota,
    });
    s.handle({ kind: 'text', data: loadFixture('start.valid.json') });
    s.handle({ kind: 'binary', bytes: new Uint8Array([1]) });
    now = 10_001;
    expect(s.handle({ kind: 'tick', nowMs: now })).toEqual([]);
    expect(s.status).toBe('ready');
  });

  it('times out if stop does not follow last audio within 30s', () => {
    let now = 0;
    const s = new DictationSession({
      nowMs: () => now,
      identity: {
        userId: 'user-1',
        platform: 'macos',
        deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
      },
      quota,
    });
    s.handle({ kind: 'text', data: loadFixture('start.valid.json') });
    now = 100;
    s.handle({ kind: 'binary', bytes: new Uint8Array([1]) });
    now = 100 + 30_001;
    const out = s.handle({ kind: 'tick', nowMs: now });
    expect(out[0]).toMatchObject({
      kind: 'send',
      message: { type: 'error', code: 'session_timeout', retryable: true },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts/dictation-v1 && npm test -- test/session-machine.test.ts`
Expected: FAIL on timeout cases (`tick` ignored).

- [ ] **Step 3: Implement ticks**

Store `readyAtMs` on ready and `lastAudioAtMs` on each binary. On `tick` while `ready`: if no audio and `now - readyAtMs >= 10000`, `session_timeout`; if audio exists and `now - lastAudioAtMs >= 30000`, `session_timeout`. Discard buffer. Do not tick in `stopping` (provider watchdog is the Nest gateway).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd contracts/dictation-v1 && npm test -- test/session-machine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/dictation-v1/src/session-machine.ts contracts/dictation-v1/test/session-machine.test.ts
git commit -m "feat: enforce dictation first-audio and stop timeouts"
```

---

### Task 7: Idempotency cache

**Files:**
- Create: `contracts/dictation-v1/src/idempotency.ts`
- Test: `contracts/dictation-v1/test/idempotency.test.ts`

**Interfaces:**
- Consumes: `FinalMessage`, `ErrorMessage`, `SESSION_LIMITS.idempotencyTtlMs`.
- Produces:

```ts
export class IdempotencyCache {
  constructor(options: { nowMs: () => number; ttlMs?: number });
  remember(requestId: string, outcome: FinalMessage | ErrorMessage): void;
  lookup(requestId: string): FinalMessage | ErrorMessage | undefined;
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../src/fixtures.js';
import { IdempotencyCache } from '../src/idempotency.js';
import type { FinalMessage } from '../src/types.js';

describe('IdempotencyCache', () => {
  it('returns a cached final within 5 minutes and misses after', () => {
    let now = 1_000;
    const cache = new IdempotencyCache({ nowMs: () => now });
    const final = loadFixture<FinalMessage>('final.json');
    cache.remember(final.requestId, final);
    expect(cache.lookup(final.requestId)).toEqual(final);
    now += 5 * 60_000 - 1;
    expect(cache.lookup(final.requestId)?.type).toBe('final');
    now += 2;
    expect(cache.lookup(final.requestId)).toBeUndefined();
  });

  it('does not re-store a different outcome for the same requestId', () => {
    const cache = new IdempotencyCache({ nowMs: () => 0 });
    const final = loadFixture<FinalMessage>('final.json');
    cache.remember(final.requestId, final);
    cache.remember(final.requestId, { ...final, text: 'other' });
    expect(cache.lookup(final.requestId)?.type).toBe('final');
    if (cache.lookup(final.requestId)?.type === 'final') {
      expect((cache.lookup(final.requestId) as FinalMessage).text).toBe('the transcribed text');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts/dictation-v1 && npm test -- test/idempotency.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

Map of `requestId` → `{ expiresAtMs, outcome }`. `remember` is no-op if the key exists and is unexpired. `lookup` deletes expired entries.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd contracts/dictation-v1 && npm test -- test/idempotency.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/dictation-v1/src/idempotency.ts contracts/dictation-v1/src/index.ts contracts/dictation-v1/test/idempotency.test.ts
git commit -m "feat: cache dictation outcomes by requestId for five minutes"
```

---

### Task 8: Mock WebSocket server and committed Ogg fixtures

**Files:**
- Create: `contracts/dictation-v1/src/mock-server.ts`
- Create: `contracts/dictation-v1/audio/speech-1s.ogg`
- Create: `contracts/dictation-v1/audio/silence-400ms.ogg`
- Create: `contracts/dictation-v1/audio/README.md`
- Test: `contracts/dictation-v1/test/mock-server.test.ts`

**Interfaces:**
- Consumes: `DictationSession`, `IdempotencyCache`, `CLOSE_CODES`, `loadFixture`.
- Produces: `startMockDictateServer(options?: { port?: number; transcript?: string }): Promise<{ url: string; close: () => Promise<void> }>`. Upgrade without `Authorization: Bearer test-token` closes `4401`. Quota exhausted mode: `startMockDictateServer({ quotaExceeded: true })` closes `4403`.

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadFixture } from '../src/fixtures.js';
import { startMockDictateServer } from '../src/mock-server.js';
import type { FinalMessage, ReadyMessage, StartMessage } from '../src/types.js';

const audioDir = join(dirname(fileURLToPath(import.meta.url)), '../audio');

function connect(url: string, headers?: Record<string, string>) {
  return new WebSocket(url, { headers });
}

describe('mock dictate server', () => {
  it('closes 4401 without a bearer token', async () => {
    const server = await startMockDictateServer({ port: 0 });
    const ws = connect(server.url);
    const code = await new Promise<number>((resolve) => ws.on('close', resolve));
    expect(code).toBe(4401);
    await server.close();
  });

  it('returns ready then a final transcript for start/audio/stop', async () => {
    const server = await startMockDictateServer({
      port: 0,
      transcript: 'the transcribed text',
    });
    const ws = connect(server.url, { Authorization: 'Bearer test-token' });
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify(loadFixture<StartMessage>('start.valid.json')));
    const ready = JSON.parse(
      (await new Promise<string>((resolve) => ws.on('message', (d) => resolve(String(d))))) as string,
    ) as ReadyMessage;
    expect(ready.type).toBe('ready');
    ws.send(readFileSync(join(audioDir, 'speech-1s.ogg')));
    ws.send(JSON.stringify(loadFixture('stop.valid.json')));
    const final = await new Promise<FinalMessage>((resolve) => {
      ws.on('message', (d) => {
        const parsed = JSON.parse(String(d)) as FinalMessage;
        if (parsed.type === 'final') {
          resolve(parsed);
        }
      });
    });
    expect(final.text).toBe('the transcribed text');
    expect(final.wordCount).toBe(3);
    ws.close();
    await server.close();
  });
});
```

The ready listener above only waits for the first message. Implement the test with a small helper that collects messages by `type` so `ready` and `final` cannot race:

```ts
async function nextTyped<T extends { type: string }>(ws: WebSocket, type: T['type']): Promise<T> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData) => {
      const parsed = JSON.parse(String(data)) as T;
      if (parsed.type === type) {
        ws.off('message', onMessage);
        resolve(parsed);
      }
    };
    ws.on('message', onMessage);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts/dictation-v1 && npm test -- test/mock-server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Generate audio fixtures and write the mock**

If `ffmpeg` is available:

```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -ar 16000 -ac 1 -c:a libopus -b:a 24k -vbr off -frame_duration 20 contracts/dictation-v1/audio/speech-1s.ogg
ffmpeg -f lavfi -i "anullsrc=r=16000:cl=mono" -t 0.4 -c:a libopus -b:a 24k -vbr off -frame_duration 20 contracts/dictation-v1/audio/silence-400ms.ogg
```

Commit the ogg files. `audio/README.md` records those two commands.

`startMockDictateServer`: listen on `port` (0 = ephemeral). `verifyClient` or `connection` handler: if `req.headers.authorization !== 'Bearer test-token'`, `socket.close(4401)`. If `quotaExceeded`, `close(4403)`. Otherwise construct `DictationSession` with the Task 4 identity (must match `start.valid.json`). Pump text JSON into `handle({ kind: 'text' })` and binary into `handle({ kind: 'binary' })`. On `transcribe`, immediately `completeTranscription` with `options.transcript ?? ''`. Tick every 100 ms with `Date.now()`. `url` is `ws://127.0.0.1:${address.port}/v1/dictate`.

Wire `IdempotencyCache`: if `start.requestId` hits a cached `final`, send that `final` again and do not transcribe.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd contracts/dictation-v1 && npm test -- test/mock-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/dictation-v1/src/mock-server.ts contracts/dictation-v1/audio contracts/dictation-v1/test/mock-server.test.ts contracts/dictation-v1/src/index.ts
git commit -m "feat: add dictation mock WebSocket server and Opus fixtures"
```

---

### Task 9: Latency harness

**Files:**
- Create: `contracts/dictation-v1/src/latency-harness.ts`
- Create: `contracts/dictation-v1/src/cli.ts`
- Test: `contracts/dictation-v1/test/latency-harness.test.ts`
- Modify: `contracts/dictation-v1/package.json` (add `harness` script)

**Interfaces:**
- Consumes: `startMockDictateServer`, `StartMessage` fixture, `speech-1s.ogg`.
- Produces:

```ts
export interface StageTimings {
  connectMs: number;
  readyMs: number;
  uploadMs: number;
  finalMs: number;
  totalMs: number;
}

export interface HarnessReport {
  runs: number;
  stages: {
    connectMs: { p50: number; p95: number };
    readyMs: { p50: number; p95: number };
    uploadMs: { p50: number; p95: number };
    finalMs: { p50: number; p95: number };
    totalMs: { p50: number; p95: number };
  };
}

export function percentile(values: number[], p: 50 | 95): number;

export function runOnce(options: {
  url: string;
  token: string;
  audio: Uint8Array;
  start: StartMessage;
}): Promise<StageTimings>;

export function runHarness(options: {
  url: string;
  token: string;
  audio: Uint8Array;
  start: StartMessage;
  runs: number;
}): Promise<HarnessReport>;
```

`connectMs` = socket `open`. `readyMs` = `open` → `ready`. `uploadMs` = `ready` → last binary send. `finalMs` = last binary/`stop` → `final`. `totalMs` = `open` → `final`.

Budget (from overview; harness **records**, it does not fail CI if over — print a warning if `totalMs.p95 > 3000`): provider inference 250–400 ms, network 30–80 ms, insertion is client-side and not measured here.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { percentile, runHarness } from '../src/latency-harness.js';
import { loadFixture } from '../src/fixtures.js';
import { startMockDictateServer } from '../src/mock-server.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StartMessage } from '../src/types.js';

describe('percentile', () => {
  it('computes p50 and p95 on a known series', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
  });
});

describe('runHarness', () => {
  it('returns finite p50/p95 against the mock server', async () => {
    const server = await startMockDictateServer({ port: 0, transcript: 'the transcribed text' });
    const audio = new Uint8Array(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../audio/speech-1s.ogg')),
    );
    const report = await runHarness({
      url: server.url,
      token: 'test-token',
      audio,
      start: loadFixture<StartMessage>('start.valid.json'),
      runs: 5,
    });
    expect(report.runs).toBe(5);
    expect(report.stages.totalMs.p50).toBeGreaterThanOrEqual(0);
    expect(report.stages.totalMs.p95).toBeGreaterThanOrEqual(report.stages.totalMs.p50);
    await server.close();
  });
});
```

Percentile: sort copy, index `Math.ceil(p / 100 * length) - 1`, clamp to `[0, length-1]`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts/dictation-v1 && npm test -- test/latency-harness.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement harness and CLI**

`runOnce` opens `ws` with `Authorization: Bearer ${token}`, waits for `open`, sends `start`, waits for `ready`, sends `audio` as one binary frame, sends `stop` with `durationMs: 1000`, waits for `final`. Use `performance.now()`.

`src/cli.ts`:

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture } from './fixtures.js';
import { runHarness } from './latency-harness.js';
import { startMockDictateServer } from './mock-server.js';
import type { StartMessage } from './types.js';

const runs = Number(process.env.HARNESS_RUNS ?? 20);
const liveUrl = process.env.DICTATE_URL;
const token = process.env.DICTATE_TOKEN ?? 'test-token';
const audio = new Uint8Array(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../audio/speech-1s.ogg')),
);

const server = liveUrl ? null : await startMockDictateServer({ transcript: 'the transcribed text' });
const url = liveUrl ?? server!.url;
const report = await runHarness({
  url,
  token,
  audio,
  start: loadFixture<StartMessage>('start.valid.json'),
  runs,
});
console.log(JSON.stringify(report, null, 2));
if (report.stages.totalMs.p95 > 3000) {
  console.warn('WARNING: totalMs p95 exceeds 3000 ms budget');
}
await server?.close();
```

Add to `package.json`:

```json
"harness": "node --experimental-strip-types src/cli.ts"
```

- [ ] **Step 4: Run tests and the harness**

Run: `cd contracts/dictation-v1 && npm test -- test/latency-harness.test.ts && npm run harness`
Expected: tests PASS; harness prints JSON with finite p50/p95. Mock totals should be well under 3000 ms.

- [ ] **Step 5: Commit**

```bash
git add contracts/dictation-v1/src/latency-harness.ts contracts/dictation-v1/src/cli.ts contracts/dictation-v1/src/index.ts contracts/dictation-v1/test/latency-harness.test.ts contracts/dictation-v1/package.json
git commit -m "feat: measure dictation stage latency p50 and p95"
```

---

## Self-review (this plan)

1. **Spec coverage:** Transport path `/v1/dictate`, bearer upgrade, audio format, `start`/`stop`/`cancel`, `ready`/`final`/`error`, every error code, close codes 1000/4401/4403/4429, idempotency 5 minutes, session limits, versioning/unknown fields, binary-before-ready, identity match, word count, latency harness. Client-only 5s Connecting timeout is explicitly out of this package (macOS plan). Quota check/commit and Groq live calls belong to the backend plan; the mock only fakes them.
2. **Placeholders:** none.
3. **Type consistency:** `DictationSession`, `QuotaSnapshot`, `StartMessage`, `countWords`, `IdempotencyCache`, `startMockDictateServer`, `runHarness` names are what the backend and macOS plans import.
