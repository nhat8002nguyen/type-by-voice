# Vietnamese Dictation and vi→en Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users dictate Vietnamese (`vi → vi`), translate it to English (`vi → en`), or dictate English (`en → en`) — each in exactly one Groq call — and record the language mode per request.

**Architecture:** The shared `@type-by-voice/dictation-v1` contract validates the `start` message and threads `language` (optional, auto-detect when omitted) and `translateToEnglish` (default `false`) through the session state machine into the `transcribe` output. `api` forwards them over NATS to `speech-service`, whose Groq provider routes to the transcriptions or translations endpoint. `quota-service` persists the two fields on `usage_records`.

**Tech Stack:** Nest 12 / TypeScript, `@type-by-voice/dictation-v1` (shared contract), `class-validator` DTOs, Vitest, TypeORM entity (in-memory store in `quota-service`).

**Spec:** `docs/superpowers/specs/2026-09-13-dictation-protocol.md` and `docs/superpowers/specs/2026-09-13-backend-design.md` (the 2026-10-03 amendments; carried by PR #17 `docs/dictation-vi-translation`, which must merge first).

## Global Constraints

- Node.js 24 LTS; `engines.node` is `>=24.9.0` (Nest 12 ships ESM-only packages).
- TypeScript only; Nest 12 monorepo (`apps/*`, `libs/*`).
- One provider call per session, never two. `en → vi` is out of scope.
- Language codes are ISO 639-1 `en` / `vi`; an omitted `language` means auto-detect.
- `translateToEnglish` defaults to `false`; with `en` input it is ignored.
- Translation must use `whisper-large-v3` (turbo has no translation support); same-language transcription defaults to `whisper-large-v3-turbo`.
- Groq endpoints: `https://api.groq.com/openai/v1/audio/transcriptions` and `https://api.groq.com/openai/v1/audio/translations`. The translations endpoint takes no `language` form field.
- Tests run with `vitest run` (`npm test`); lint `npm run lint` (`oxlint --type-aware apps/`); format `npm run format` (Prettier on `apps/**/*.ts` and `libs/**/*.ts`).
- Go-style JSDoc on every new or changed TS function/method: `/** ... */` immediately above, first sentence starts with the identifier, no blank line before the declaration.

## Review Focus

1. `translateToEnglish: true` must never hit the transcriptions endpoint or `whisper-large-v3-turbo` — turbo silently lacks translation. → Task 3.
2. A `start` with no `language` must omit the `language` form field entirely (auto-detect), never send `language=undefined` or an empty string. → Task 1 and Task 3.
3. `language: 'vi'` must be accepted at every boundary (protocol validator, `TranscribeRequestDto`, `CommitQuotaRequestDto`). → Tasks 1, 2, 4.
4. Old clients sending only `language: 'en'` (no `translateToEnglish`) keep working — the field defaults to `false` and transcribes. → Task 1.
5. `language: 'en'` with `translateToEnglish: true` is ignored (stays a transcription to English). → Task 3.

---

### Task 1: Thread language and translateToEnglish through the dictation contract

**Files:**
- Modify: `contracts/dictation-v1/src/types.ts`
- Modify: `contracts/dictation-v1/src/validate-start.ts`
- Modify: `contracts/dictation-v1/src/session-machine.ts`
- Modify: `contracts/dictation-v1/test/session-machine.test.ts`

**Interfaces:**
- Produces: `StartMessage.language?: 'en' | 'vi'`, `StartMessage.translateToEnglish?: boolean`; `SessionOutput` transcribe variant gains `language?: 'en' | 'vi'` and `translateToEnglish: boolean`. Consumed by Tasks 5 and 6.

- [ ] **Step 1: Write failing tests** in `test/session-machine.test.ts` — extend the two existing `toEqual` transcribe assertions (in "buffers binary after ready and transcribes on stop" and "copies listInHistory false onto the transcribe output") to include `language: 'en', translateToEnglish: false`, then add:

```ts
it('carries vi and translateToEnglish onto the transcribe output', () => {
  const s = session();
  const start = {
    ...loadFixture<StartMessage>('start.valid.json'),
    language: 'vi',
    translateToEnglish: true,
  };
  s.handle({ kind: 'text', data: start });
  const chunk = new Uint8Array([9]);
  s.handle({ kind: 'binary', bytes: chunk });
  const out = s.handle({ kind: 'text', data: loadFixture('stop.valid.json') });
  expect(out).toEqual([
    {
      kind: 'transcribe',
      requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
      audio: chunk,
      listInHistory: true,
      language: 'vi',
      translateToEnglish: true,
    },
  ]);
});

it('auto-detects when language is omitted and defaults translateToEnglish to false', () => {
  const s = session();
  const { language: _omit, ...start } = loadFixture<StartMessage>('start.valid.json');
  s.handle({ kind: 'text', data: start });
  s.handle({ kind: 'binary', bytes: new Uint8Array([1]) });
  const out = s.handle({ kind: 'text', data: loadFixture('stop.valid.json') });
  expect(out[0]).toMatchObject({ kind: 'transcribe', translateToEnglish: false });
  expect((out[0] as { language?: string }).language).toBeUndefined();
});

it('rejects an unsupported language on start', () => {
  const s = session();
  const out = s.handle({
    kind: 'text',
    data: { ...loadFixture<StartMessage>('start.valid.json'), language: 'fr' },
  });
  expect(out[0]).toMatchObject({ kind: 'send', message: { type: 'error', code: 'invalid_request' } });
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd contracts/dictation-v1 && npm test -- test/session-machine.test.ts`
Expected: FAIL — the two updated `toEqual` assertions report extra `language`/`translateToEnglish` fields; the three new tests fail.

- [ ] **Step 3: Implement types, validation, and state machine**

In `types.ts`, change `StartMessage.language` to `language?: 'en' | 'vi';`, add `translateToEnglish?: boolean;`, and extend the transcribe `SessionOutput` variant to `{ kind: 'transcribe'; requestId: string; audio: Uint8Array; listInHistory: boolean; language?: 'en' | 'vi'; translateToEnglish: boolean }`.

In `validate-start.ts`, replace the `value.language !== 'en'` check and the normalized `language: 'en'` field with:

```ts
if (value.language !== undefined && value.language !== 'en' && value.language !== 'vi') {
  return fail('unsupported language');
}
if (value.translateToEnglish !== undefined && typeof value.translateToEnglish !== 'boolean') {
  return fail('translateToEnglish must be boolean');
}
```

and in the returned `value`, set `language: value.language as 'en' | 'vi' | undefined` and `translateToEnglish: value.translateToEnglish === true`.

In `session-machine.ts`, add `#language: 'en' | 'vi' | undefined;` and `#translateToEnglish = false;` fields; in `handleStart` after `this.#listInHistory = start.listInHistory;` add `this.#language = start.language;` and `this.#translateToEnglish = start.translateToEnglish ?? false;`; in `handleStop`, add `language: this.#language, translateToEnglish: this.#translateToEnglish,` to the transcribe output object. Add JSDoc to any changed function.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd contracts/dictation-v1 && npm test`
Expected: PASS (all contract tests, including the updated `session-machine.test.ts` and `fixtures.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add contracts/dictation-v1/src/types.ts contracts/dictation-v1/src/validate-start.ts contracts/dictation-v1/src/session-machine.ts contracts/dictation-v1/test/session-machine.test.ts
git commit -m "feat(dictation-v1): accept vi language and translateToEnglish in start"
```

---

### Task 2: Extend the speech provider interface and transcribe DTO

**Files:**
- Modify: `backend/libs/speech/src/speech-provider.ts`
- Modify: `backend/libs/speech/src/dto/transcribe.dto.ts`
- Modify: `backend/libs/speech/src/dto/transcribe.dto.spec.ts`

**Interfaces:**
- Produces: `SpeechProvider.transcribe(audio: Buffer, opts: { language?: string; translateToEnglish?: boolean })`; `TranscribeRequestDto.language?: 'en' | 'vi'`, `TranscribeRequestDto.translateToEnglish?: boolean`. Consumed by Tasks 3 and 5.

- [ ] **Step 1: Write failing test** in `transcribe.dto.spec.ts`:

```ts
it('accepts language vi and optional translateToEnglish', async () => {
  const dto = Object.assign(new TranscribeRequestDto(), {
    requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
    language: 'vi',
    translateToEnglish: true,
    audioBase64: 'Zg==',
  });
  expect(await validate(dto)).toEqual([]);
});

it('accepts an omitted language for auto-detect', async () => {
  const dto = Object.assign(new TranscribeRequestDto(), {
    requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
    audioBase64: 'Zg==',
  });
  expect(await validate(dto)).toEqual([]);
});

it('rejects an unsupported language', async () => {
  const dto = Object.assign(new TranscribeRequestDto(), {
    requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
    language: 'fr',
    audioBase64: 'Zg==',
  });
  const errors = await validate(dto);
  expect(errors.map((e) => e.property)).toEqual(['language']);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd backend && npm test -- libs/speech/src/dto/transcribe.dto.spec.ts`
Expected: FAIL — `validate` reports a `language` error for `'vi'` (and `'fr'` is already rejected), so the first two tests fail.

- [ ] **Step 3: Implement interface and DTO**

In `speech-provider.ts`, change the `transcribe` `opts` type to `{ language?: string; translateToEnglish?: boolean }`.

In `transcribe.dto.ts`, change `language` to:

```ts
@IsOptional()
@IsIn(['en', 'vi'])
language?: 'en' | 'vi';

@IsOptional()
@IsBoolean()
translateToEnglish?: boolean;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd backend && npm test -- libs/speech/src/dto/transcribe.dto.spec.ts libs/speech/src/speech-provider.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/libs/speech/src/speech-provider.ts backend/libs/speech/src/dto/transcribe.dto.ts backend/libs/speech/src/dto/transcribe.dto.spec.ts
git commit -m "feat(speech): make transcribe language optional and add translateToEnglish"
```

---

### Task 3: Route the Groq provider between transcription and translation

**Files:**
- Modify: `backend/apps/speech-service/src/groq.provider.ts`
- Modify: `backend/apps/speech-service/src/speech.controller.ts`
- Modify: `backend/apps/speech-service/src/speech.service.ts`
- Modify: `backend/apps/speech-service/src/groq.provider.spec.ts`

**Interfaces:**
- Consumes: `SpeechProvider.transcribe` signature from Task 2; `TranscribeRequestDto` from Task 2.
- Produces: unchanged `TranscribeResponseDto` (`{ text, provider, providerLatencyMs }`).

- [ ] **Step 1: Write failing tests** in `groq.provider.spec.ts` (using the existing `fetchMock` pattern from "posts ogg bytes and returns text plus latency"):

```ts
it('routes translateToEnglish to the translations endpoint with whisper-large-v3 and no language field', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'ok' }) });
  const provider = new GroqSpeechProvider({ apiKey: 'gsk_test', fetch: fetchMock });
  await provider.transcribe(Buffer.from('OggS'), { language: 'vi', translateToEnglish: true });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://api.groq.com/openai/v1/audio/translations');
  expect((init.body as FormData).get('model')).toBe('whisper-large-v3');
  expect((init.body as FormData).get('language')).toBeNull();
});

it('omits the language form field when language is not provided', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'ok' }) });
  const provider = new GroqSpeechProvider({ apiKey: 'gsk_test', fetch: fetchMock });
  await provider.transcribe(Buffer.from('OggS'), {});
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  expect((init.body as FormData).get('language')).toBeNull();
});

it('ignores translateToEnglish when language is en', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'ok' }) });
  const provider = new GroqSpeechProvider({ apiKey: 'gsk_test', fetch: fetchMock });
  await provider.transcribe(Buffer.from('OggS'), { language: 'en', translateToEnglish: true });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
  expect((init.body as FormData).get('model')).toBe('whisper-large-v3-turbo');
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd backend && npm test -- apps/speech-service/src/groq.provider.spec.ts`
Expected: FAIL — the three new tests fail (URL, model, and language-field assertions).

- [ ] **Step 3: Implement provider routing and controller pass-through**

In `groq.provider.ts`: add `const GROQ_TRANSLATIONS_URL = 'https://api.groq.com/openai/v1/audio/translations';` and `const TRANSLATION_MODEL = 'whisper-large-v3';`. Update both `FakeSpeechProvider.transcribe` and `GroqSpeechProvider.transcribe` `opts` types to `{ language?: string; translateToEnglish?: boolean }`. In `GroqSpeechProvider.transcribe`, replace the fixed URL/model/language logic with:

```ts
const translate = opts.translateToEnglish === true && opts.language !== 'en';
const url = translate ? GROQ_TRANSLATIONS_URL : GROQ_TRANSCRIPTIONS_URL;
body.append('model', translate ? TRANSLATION_MODEL : this.model);
if (!translate && opts.language !== undefined) {
  body.append('language', opts.language);
}
```

and POST to `url`. Add JSDoc to the changed `transcribe`.

In `speech.controller.ts`, pass `translateToEnglish: dto.translateToEnglish` alongside `language: dto.language`, and pass `dto.translateToEnglish` as a fourth argument to `this.speechService.logCompleted(...)`.

In `speech.service.ts`, add an optional `translateToEnglish?: boolean` parameter to `logCompleted` and log ` translate=${translateToEnglish}` when it is `true`. Add JSDoc.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd backend && npm test -- apps/speech-service/src/groq.provider.spec.ts apps/speech-service/src/speech.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/apps/speech-service/src/groq.provider.ts backend/apps/speech-service/src/speech.controller.ts backend/apps/speech-service/src/speech.service.ts backend/apps/speech-service/src/groq.provider.spec.ts
git commit -m "feat(speech-service): translate to English via Groq translations endpoint"
```

---

### Task 4: Record language and translateToEnglish on usage records

**Files:**
- Modify: `backend/libs/quota/src/dto/commit-quota.dto.ts`
- Modify: `backend/apps/quota-service/src/entities/usage-record.entity.ts`
- Modify: `backend/apps/quota-service/src/quota.service.ts`
- Add: `backend/libs/quota/src/dto/commit-quota.dto.spec.ts`
- Modify: `backend/apps/quota-service/src/quota.service.spec.ts`

**Interfaces:**
- Produces: `CommitQuotaRequestDto.language?: 'en' | 'vi'`, `CommitQuotaRequestDto.translateToEnglish?: boolean`; `UsageRecord.language: 'en' | 'vi' | null`, `UsageRecord.translateToEnglish: boolean`. Consumed by Task 5.

- [ ] **Step 1: Write failing tests**

New `commit-quota.dto.spec.ts` (mirroring `transcribe.dto.spec.ts`):

```ts
import 'reflect-metadata';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CommitQuotaRequestDto } from './commit-quota.dto.js';

const base = {
  userId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
  requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
  sessionId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
  platform: 'macos',
  clientVersion: '1.0.0+12',
  audioMs: 5000,
  wordCount: 20,
  provider: 'groq-whisper',
  providerLatencyMs: 300,
  estimatedCostMicros: 10,
};

describe('CommitQuotaRequestDto', () => {
  it('accepts language vi and translateToEnglish true', async () => {
    const dto = Object.assign(new CommitQuotaRequestDto(), base, { language: 'vi', translateToEnglish: true });
    expect(await validate(dto)).toEqual([]);
  });

  it('accepts an omitted language and translateToEnglish', async () => {
    const dto = Object.assign(new CommitQuotaRequestDto(), base);
    expect(await validate(dto)).toEqual([]);
  });
});
```

In `quota.service.spec.ts`, add:

```ts
it('records language and translateToEnglish on the usage record', async () => {
  const service = QuotaService.withMemory();
  service.seedUser('user-1', new Date('2026-09-01T00:00:00Z'), plan, { wordsUsed: 0 });
  await service.commit(
    { ...commitBody, language: 'vi', translateToEnglish: true },
    new Date('2026-09-02T00:00:00Z'),
  );
  const record = (
    service as unknown as { usageRecords: Map<string, { language: string | null; translateToEnglish: boolean }> }
  ).usageRecords.get(commitBody.requestId)!;
  expect(record.language).toBe('vi');
  expect(record.translateToEnglish).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd backend && npm test -- libs/quota/src/dto/commit-quota.dto.spec.ts apps/quota-service/src/quota.service.spec.ts`
Expected: FAIL — `language` and `translateToEnglish` are not accepted by the DTO, and the usage-record assertions fail.

- [ ] **Step 3: Implement DTO, entity columns, and mapping**

In `commit-quota.dto.ts`, add:

```ts
@IsOptional()
@IsIn(['en', 'vi'])
language?: 'en' | 'vi';

@IsOptional()
@IsBoolean()
translateToEnglish?: boolean;
```

In `usage-record.entity.ts`, add `@Column({ type: 'varchar', nullable: true }) language: 'en' | 'vi' | null;` and `@Column({ name: 'translate_to_english', type: 'boolean', default: false }) translateToEnglish: boolean;`.

In `quota.service.ts` `toUsageRecord`, add `record.language = dto.language ?? null;` and `record.translateToEnglish = dto.translateToEnglish ?? false;`.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd backend && npm test -- libs/quota apps/quota-service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/libs/quota/src/dto/commit-quota.dto.ts backend/libs/quota/src/dto/commit-quota.dto.spec.ts backend/apps/quota-service/src/entities/usage-record.entity.ts backend/apps/quota-service/src/quota.service.ts backend/apps/quota-service/src/quota.service.spec.ts
git commit -m "feat(quota): record language and translateToEnglish on usage records"
```

---

### Task 5: Forward language and translateToEnglish from api to speech and quota

**Files:**
- Modify: `backend/apps/api/src/dictate/dictate.service.ts`
- Modify: `backend/apps/api/src/dictate/dictate.service.spec.ts`

**Interfaces:**
- Consumes: `SessionOutput` transcribe fields from Task 1; `TranscribeRequestDto` from Task 2; `CommitQuotaRequestDto` from Task 4.

- [ ] **Step 1: Write failing test** in `dictate.service.spec.ts` (model it on "on stop sends one transcribe RPC then commits quota"):

```ts
it('forwards language and translateToEnglish to speech and quota', async () => {
  // …same quota/speech/outbox stubs as the existing commit test…
  const start = {
    ...loadFixture<StartMessage>('start.valid.json'),
    language: 'vi',
    translateToEnglish: true,
  };
  await service.onText(start);
  await service.onBinary(Buffer.from('OggS'));
  await service.onText(loadFixture('stop.valid.json'));
  expect(speech.send).toHaveBeenCalledWith(
    SPEECH_TRANSCRIBE_PATTERN,
    expect.objectContaining({ language: 'vi', translateToEnglish: true }),
  );
  expect(quota.send).toHaveBeenCalledWith(
    QUOTA_COMMIT_PATTERN,
    expect.objectContaining({ language: 'vi', translateToEnglish: true }),
  );
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd backend && npm test -- apps/api/src/dictate/dictate.service.spec.ts`
Expected: FAIL — speech receives `language: 'en'` (hardcoded) and neither payload carries `translateToEnglish`.

- [ ] **Step 3: Implement pass-through**

In `dictate.service.ts` `transcribeAndFinalize`, extend the `output` parameter type to `{ requestId: string; audio: Uint8Array; listInHistory: boolean; language?: 'en' | 'vi'; translateToEnglish: boolean }`. In the `SPEECH_TRANSCRIBE_PATTERN` payload, replace `language: 'en'` with `language: output.language, translateToEnglish: output.translateToEnglish`. In the `QUOTA_COMMIT_PATTERN` payload, add `language: output.language, translateToEnglish: output.translateToEnglish`. Add JSDoc to `transcribeAndFinalize` if its behavior changes.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd backend && npm test -- apps/api/src/dictate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/apps/api/src/dictate/dictate.service.ts backend/apps/api/src/dictate/dictate.service.spec.ts
git commit -m "feat(api): forward language and translateToEnglish to speech and quota"
```

---

### Task 6: Tag dictate latency metrics by language mode

**Files:**
- Modify: `backend/apps/api/src/metrics/dictate-metrics.ts`
- Modify: `backend/apps/api/src/metrics/dictate-metrics.spec.ts`
- Modify: `backend/apps/api/src/dictate/dictate.service.ts`
- Modify: `backend/apps/api/src/dictate/dictate.gateway.ts`
- Modify: `backend/apps/api/src/dictate/dictate.service.spec.ts`

**Interfaces:**
- Consumes: `SessionOutput` transcribe fields from Task 1 (via `transcribeAndFinalize`).
- Produces: `LanguageMode` type and `languageModeOf()` helper (exported from `dictate-metrics.ts`); `DictateService.languageMode` getter.

- [ ] **Step 1: Write failing tests**

In `dictate-metrics.spec.ts`, add a `mode` field to the existing `record` call (assert the snapshot buckets by `platform:mode`) and add helper tests:

```ts
it('buckets timings by platform and language mode', () => {
  const metrics = new DictateMetrics();
  metrics.record({ platform: 'macos', mode: 'vi-en', connectMs: 10, audioReceivedMs: 20, providerMs: 30, totalMs: 60 });
  const snap = metrics.snapshot();
  expect(snap.dictate_provider_ms['macos:vi-en']).toEqual({ count: 1, sumMs: 30 });
});

it('maps language and translateToEnglish to a mode', () => {
  expect(languageModeOf('vi', true)).toBe('vi-en');
  expect(languageModeOf('vi', false)).toBe('vi-vi');
  expect(languageModeOf('en', true)).toBe('en-en');
  expect(languageModeOf('en', false)).toBe('en-en');
  expect(languageModeOf(undefined, true)).toBe('auto-en');
  expect(languageModeOf(undefined, false)).toBe('auto');
});
```

In `dictate.service.spec.ts`, add:

```ts
it('exposes the language mode of the completed session', async () => {
  // …same stubs as the forwarding test, with start { ...valid, language: 'vi', translateToEnglish: true }…
  await service.onText(start);
  await service.onBinary(Buffer.from('OggS'));
  await service.onText(loadFixture('stop.valid.json'));
  expect(service.languageMode).toBe('vi-en');
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd backend && npm test -- apps/api/src/metrics/dictate-metrics.spec.ts apps/api/src/dictate/dictate.service.spec.ts`
Expected: FAIL — `mode` is not a known `StageTimings` field, `languageModeOf` is undefined, and `service.languageMode` is undefined.

- [ ] **Step 3: Implement mode type, metrics bucketing, capture, and gateway pass-through**

In `dictate-metrics.ts`, add `export type LanguageMode = 'en-en' | 'vi-vi' | 'vi-en' | 'auto-en' | 'auto';`, add `mode: LanguageMode` to `StageTimings`, change `record` to bucket with the key `` `${timings.platform}:${timings.mode}` `` (rename the `add` second parameter to `key: string`), and add:

```ts
/** languageModeOf maps input language and translation flag onto a latency-tagging mode. */
export function languageModeOf(language?: 'en' | 'vi', translateToEnglish?: boolean): LanguageMode {
  if (language === 'en') return 'en-en'; // translateToEnglish is ignored for English input
  if (translateToEnglish) return language === 'vi' ? 'vi-en' : 'auto-en';
  if (language === 'vi') return 'vi-vi';
  return 'auto';
}
```

In `dictate.service.ts`, import `languageModeOf` and `LanguageMode`; add a `#languageMode: LanguageMode = 'auto'` field and a `languageMode(): LanguageMode` getter; in `transcribeAndFinalize`, set `this.#languageMode = languageModeOf(output.language, output.translateToEnglish);`.

In `dictate.gateway.ts` `flush()`, add `mode: service.languageMode,` to the `this.metrics.record({ ... })` call. Add JSDoc to new/changed members.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd backend && npm test -- apps/api/src/metrics apps/api/src/dictate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/apps/api/src/metrics/dictate-metrics.ts backend/apps/api/src/metrics/dictate-metrics.spec.ts backend/apps/api/src/dictate/dictate.service.ts backend/apps/api/src/dictate/dictate.gateway.ts backend/apps/api/src/dictate/dictate.service.spec.ts
git commit -m "feat(api): tag dictate latency metrics by language mode"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the contract suite**

Run: `cd contracts/dictation-v1 && npm test`
Expected: PASS.

- [ ] **Step 2: Run the backend suite**

Run: `cd backend && npm test`
Expected: PASS.

- [ ] **Step 3: Lint and format-check**

Run: `cd backend && npm run lint && npm run format`
Expected: lint clean; Prettier applies no or only whitespace changes (review and commit any reformatting).

- [ ] **Step 4: Commit any formatting fallout**

```bash
git add -A && git commit -m "chore: lint and format" || echo "nothing to commit"
```
