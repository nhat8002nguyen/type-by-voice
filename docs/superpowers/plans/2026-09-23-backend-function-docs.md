# Backend Function Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a short Go-godoc-style comment above every documentable function/method in `backend/` so a reader can understand purpose at a glance without reading the body.

**Architecture:** Comment-only pass. Use JSDoc blocks (`/** ... */`) placed immediately above each function/method, written in Go godoc style (first sentence starts with the identifier name; 1–4 complete sentences; abstract “what/why”, not line-by-line “how”). Prefer 1–2 for simple helpers; use up to 4 when the function is complex. No signature, control-flow, or dependency changes. When the writer cannot summarize confidently from call sites and surrounding code, leave an empty `/** */` block so the human can fill it later.

**Tech Stack:** NestJS 12 TypeScript monorepo under `backend/` (Node 24). Vitest for regression checks. No new runtime dependencies.

**Spec:** Ad-hoc (2026-09-23 chat): Go-style 1–4 sentence function docs across `backend/` (up to 4 for complex functions); leave uncertain explanations empty; do **not** change behavior. Domain context for accurate summaries: `docs/superpowers/specs/2026-09-13-backend-design.md`, `docs/superpowers/specs/2026-09-13-dictation-protocol.md`.

## Global Constraints

- **Comments only.** Do not change logic, signatures, types, imports, defaults, or test expectations.
- **Style:** Go godoc adapted to TypeScript JSDoc:
  - Block immediately above the declaration (no blank line between comment and `function` / method).
  - First sentence begins with the identifier name (e.g. `onText handles…`, not `This function handles…`).
  - 1–4 sentences. Prefer 1–2 for simple helpers; use 3–4 for complex flows (e.g. startSession, transcribeAndFinalize). Purpose at abstraction level; omit parameter laundry lists unless essential.
  - Prefer `/** */` (IDE hover). Do not use `@param` / `@returns` / `@throws` unless already present.
- **Uncertain:** Leave `/** */` with no body. Do not invent.
- **Skip (not documentable implementations):** `*.spec.ts`, `*.e2e-spec.ts`, `*.fixture.ts`; pure re-export `index.ts`; DTO/entity files with only properties and no methods; TypeScript `interface` / `type` method signatures (e.g. `DictateSocket.close`); Nest `@Module()` classes with no custom methods.
- **Include:** class methods (public/private), getters/setters, exported and file-local `function` / `const fn = () =>`, Nest lifecycle hooks (`onModuleInit`, `canActivate`, `handleConnection`, …). Constructors: one sentence only if non-obvious; otherwise empty `/** */` or skip if pure DI assignment.
- **Do not document** nested callbacks / inline lambdas inside method bodies.
- **Node:** `>=24.9.0` (see `backend/Dockerfile` `FROM node:24-alpine`). Optional chaining and modern syntax are fine; this task does not add code.
- **Verify each task:** `git diff` contains only comment additions (and empty `/** */`); then run the package’s existing unit tests. No new tests required for comment text.

---

## File Structure

No new production files. Touch only existing implementation `.ts` files under:

```
backend/apps/api/src/**           # dictate, auth, rate-limit, transcripts, …
backend/apps/quota-service/src/**
backend/apps/speech-service/src/**
backend/apps/workflows-service/src/**
backend/apps/notifications-service/src/**
backend/libs/{tracing,inbox,outbox,speech,quota,workflows,notifications}/src/**
```

Each file keeps its current responsibility; comments document existing units. Suggested comment text below is a starting draft for the implementer — edit for accuracy while reading the body; replace with empty `/** */` when unsure.

---

### Task 1: Convention sample — `DictateService` + helpers

**Files:**
- Modify: `backend/apps/api/src/dictate/dictate.service.ts`
- Test: existing `backend/apps/api/src/dictate/dictate.service.spec.ts` (run only; do not change)

**Interfaces:**
- Consumes: none (comment-only).
- Produces: JSDoc style locked for later tasks (name-first, 1–4 sentences, empty when unsure).

- [ ] **Step 1: Confirm no existing function docs**

Run: `rg -n "/\*\*" backend/apps/api/src/dictate/dictate.service.ts`
Expected: no matches (or only unrelated).

- [ ] **Step 2: Add docs above every method and helper**

Insert these blocks (adjust wording if the body disagrees; use empty `/** */` if unsure). Do not change method bodies.

```typescript
  /** userId returns the authenticated user id for this WebSocket session. */
  get userId(): string {

  /** platform returns the client platform claimed at connection time. */
  get platform(): Platform {

  /** deviceId returns the client device id claimed at connection time. */
  get deviceId(): string {

  /** audioReceivedMs returns milliseconds from connect until the last binary audio frame (or connect if none). */
  get audioReceivedMs(): number {

  /** providerMs returns the last speech-provider round-trip duration in milliseconds. */
  get providerMs(): number {

  /** isBusy reports whether the session is waiting on transcription after stop. */
  get isBusy(): boolean {

  /**
   * failUnexpected maps unexpected errors to a protocol error message.
   * Syntax errors become invalid_request; failures during stopping fail the in-flight transcription.
   */
  failUnexpected(error?: unknown): ServerTextMessage {

  /** takePendingClose returns and clears a close instruction produced by the session state machine. */
  takePendingClose(): DictateClose | undefined {

  /**
   * onText handles a client JSON control message (start/stop/cancel/…).
   * Replays idempotent finals from cache when a start repeats a finished requestId.
   */
  async onText(data: unknown): Promise<ServerTextMessage | undefined> {

  /** onBinary forwards one Opus frame into the active DictationSession buffer. */
  async onBinary(bytes: Buffer): Promise<ServerTextMessage | undefined> {

  /** onTick advances session timers (idle / max duration) and may emit timeout errors. */
  async onTick(nowMs: number): Promise<ServerTextMessage | undefined> {

  /**
   * startSession enforces per-user concurrency, checks quota via NATS, then opens a DictationSession.
   * Returns a protocol error when concurrency, quota, or the check RPC fails.
   */
  private async startSession(

  /**
   * consume applies SessionOutput list in order, running transcription when requested.
   * Returns the last server text message produced.
   */
  private async consume(

  /** applyOutputs applies non-transcribe SessionOutputs (send/close) without calling speech. */
  private applyOutputs(

  /** applyOutput sends a message to the client path or records a pending WebSocket close. */
  private applyOutput(

  /**
   * transcribeAndFinalize sends assembled audio to speech-service, commits quota, and enqueues transcript persistence.
   * Completes or fails the DictationSession based on provider and quota RPC outcomes.
   */
  private async transcribeAndFinalize(

  /**
   * enqueueQuotaEmail enqueues a warning or exhausted email when usage crosses thresholds.
   * No-ops when the user has no email or the plan has no word limit.
   */
  private async enqueueQuotaEmail(

  /**
   * protocolError builds an ErrorMessage, caches it for idempotency, and schedules the matching close code.
   */
  private protocolError(code: ErrorCode, requestId: string): ErrorMessage {

/** estimatedCostMicros estimates provider cost in micros from audio duration. */
export function estimatedCostMicros(audioMs: number): number {

/** isStart is a type guard for client start control messages with a string requestId. */
function isStart(data: unknown): data is StartMessageLike {

/** isCancel reports whether the payload is a cancel control message. */
function isCancel(data: unknown): boolean {
```

- [ ] **Step 3: Diff-check (comments only)**

Run:

```bash
cd backend && git diff -- apps/api/src/dictate/dictate.service.ts | head -200
```

Expected: only `+ /**` / `+  *` / `+ */` lines (and blank `/** */` if any). No `-` lines that remove statements.

- [ ] **Step 4: Run unit tests**

Run: `cd backend && npx vitest run apps/api/src/dictate/dictate.service.spec.ts`
Expected: PASS (same as before).

- [ ] **Step 5: Commit**

```bash
git add backend/apps/api/src/dictate/dictate.service.ts
git commit -m "$(cat <<'EOF'
docs(backend): add godoc-style comments on DictateService

EOF
)"
```

---

### Task 2: `api` dictation gateway, registry, metrics

**Files:**
- Modify: `backend/apps/api/src/dictate/dictate.gateway.ts`
- Modify: `backend/apps/api/src/dictate/session-registry.ts`
- Modify: `backend/apps/api/src/metrics/dictate-metrics.ts`
- Test: `backend/apps/api/src/dictate/dictate.service.spec.ts`, `backend/apps/api/src/metrics/dictate-metrics.spec.ts`

**Interfaces:**
- Consumes: comment style from Task 1.
- Produces: documented gateway entrypoints used by Nest WS lifecycle.

- [ ] **Step 1: Document `SessionRegistry`**

```typescript
  /** count returns how many concurrent dictation sessions the user currently holds. */
  count(userId: string): number {

  /**
   * tryAdd registers a session key for the user if under the concurrency cap.
   * Returns false when the user already has the maximum concurrent sessions.
   */
  tryAdd(userId: string, sessionKey: string): boolean {

  /** remove drops a session key and deletes the user entry when none remain. */
  remove(userId: string, sessionKey: string): void {
```

- [ ] **Step 2: Document `DictateMetrics` methods**

Read `dictate-metrics.ts` and add name-first 1–4 sentence docs above: `record`, `add`, `recordProviderError`, `recordQuotaRejected`, `snapshot`, and any private helpers (`emptyStage`, `cloneStage`, …). Use empty `/** */` when unsure.

- [ ] **Step 3: Document `DictateGateway` implementations only**

Document real methods (not `DictateSocket` interface members): `handleConnection`, `handleDisconnect`, `handleMessage`, `bindInbound`, `authenticateAndAttach`, `runTraced` (if present), `pumpTick`, `handleProcessingError`, `parseText`, `flush`, `clearTick`, plus file-level helpers (`isUtf8Json`, `bearerToken`, `toBuffer`, `peekRequestId`, `clientIp`, `closeCodeForAuthError`, `closeCodeForQuota`, `closeCodeForRateLimit`, …).

Suggested drafts (verify against bodies; empty if unsure):

```typescript
  /**
   * handleConnection authenticates the upgrade, attaches DictateService, and starts the idle tick timer.
   * Closes the socket on rate limit, auth, or pre-check quota failure.
   */
  async handleConnection(

  /** handleDisconnect clears timers and releases the user's session registry slot. */
  handleDisconnect(client: DictateSocket): void {

  /**
   * handleMessage routes one WebSocket frame (JSON text or binary audio) to DictateService.
   * Oversized frames and unexpected errors become protocol failures flushed to the client.
   */
  async handleMessage(

  /** bindInbound queues inbound messages until auth completes, then serializes handlers on messageChain. */
  private bindInbound(

  /**
   * authenticateAndAttach verifies JWT + session, checks quota, and constructs DictateService on the socket.
   */
  private async authenticateAndAttach(

  /** pumpTick fires session onTick and closes idle sockets that exceeded the inactivity window. */
  private async pumpTick(

  /** flush sends a server text message if present and applies any pending close from DictateService. */
  private flush(
```

- [ ] **Step 4: Run tests + commit**

Run: `cd backend && npx vitest run apps/api/src/dictate apps/api/src/metrics/dictate-metrics.spec.ts`
Expected: PASS.

```bash
git add backend/apps/api/src/dictate/dictate.gateway.ts \
  backend/apps/api/src/dictate/session-registry.ts \
  backend/apps/api/src/metrics/dictate-metrics.ts
git commit -m "$(cat <<'EOF'
docs(backend): document dictate gateway, registry, and metrics

EOF
)"
```

---

### Task 3: `api` auth module

**Files:**
- Modify: `backend/apps/api/src/auth/auth.service.ts`
- Modify: `backend/apps/api/src/auth/auth.controller.ts`
- Modify: `backend/apps/api/src/auth/access-auth.guard.ts`
- Modify: `backend/apps/api/src/auth/assert-client-identity.ts`
- Modify: `backend/apps/api/src/auth/invalid-identity.filter.ts`
- Modify: `backend/apps/api/src/users/users.controller.ts` (me / sessions — auth-adjacent)
- Test: `backend/apps/api/src/auth/auth.service.spec.ts`, `backend/apps/api/src/auth/auth.controller.spec.ts`, `backend/apps/api/src/users/users.controller.spec.ts`

**Interfaces:**
- Consumes: Task 1 comment style.
- Produces: documented auth HTTP surface and service API.

- [ ] **Step 1: Document file-local helpers in `auth.service.ts`**

```typescript
/** isUniqueViolation reports whether a TypeORM error is a Postgres unique-constraint violation (23505). */
function isUniqueViolation(error: unknown): boolean {

/** hashToken returns the SHA-256 hex digest used to store refresh/verify tokens at rest. */
function hashToken(token: string): string {

/** normalizeEmail trims and lowercases an email for stable lookups. */
function normalizeEmail(email: string): string {
```

- [ ] **Step 2: Document `AuthService` public and private methods**

Suggested drafts (verify; empty if unsure):

```typescript
  /** register creates a user, hashes the password with Argon2id, and returns access/refresh tokens. */
  async register(dto: RegisterDto, userAgent?: string): Promise<AuthTokens> {

  /** login verifies credentials, records rate-limit success/failure, and issues rotated session tokens. */
  async login(/* … */): Promise<AuthTokens> {

  /** refresh rotates the refresh token for a device and returns a new access/refresh pair. */
  async refresh(/* … */): Promise<AuthTokens> {

  /** logout revokes the session identified by sessionId when it is still active. */
  async logout(sessionId: string): Promise<void> {

  /** verifyEmail consumes a one-time verify token and sets emailVerifiedAt. */
  async verifyEmail(token: string): Promise<void> {

  /** forgotPassword enqueues a reset email when the address exists (always opaque to the caller). */
  async forgotPassword(email: string): Promise<void> {

  /** resetPassword consumes a reset token and stores a new Argon2id password hash. */
  async resetPassword(token: string, password: string): Promise<void> {

  /** loadAccessSession validates JWT claims against a non-revoked DB session for dictate/HTTP auth. */
  async loadAccessSession(/* … */) {

  /** getMe returns the public profile for userId or throws NotFound. */
  async getMe(userId: string): Promise<UserProfile> {

  /** listSessions returns active device sessions for the user. */
  async listSessions(userId: string): Promise<SessionView[]> {

  /** revokeSession revokes one device session owned by the user. */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
```

Document remaining private helpers (`issueAuthToken`, `consumeToken`, `consumeTokenIn`, `enqueueEmail`, `issueTokens`, `saveRotatedSession`, …) the same way after reading each body. Empty `/** */` when unsure.

- [ ] **Step 3: Document controllers, guard, assert, filter**

```typescript
// auth.controller.ts — one sentence per route handler (register/login/refresh/logout/verifyEmail/forgotPassword/resetPassword)
// users.controller.ts — me, listSessions, revokeSession
// access-auth.guard.ts — canActivate validates Bearer access JWT + session
/** assertClientIdentity rejects requests missing required platform/deviceId client fields. */
// invalid-identity.filter.ts — isIdentityValidationMessage / catch as applicable
```

- [ ] **Step 4: Run tests + commit**

Run: `cd backend && npx vitest run apps/api/src/auth apps/api/src/users`
Expected: PASS.

```bash
git add backend/apps/api/src/auth backend/apps/api/src/users/users.controller.ts
git commit -m "$(cat <<'EOF'
docs(backend): add godoc-style comments on auth and users HTTP

EOF
)"
```

---

### Task 4: `api` rate-limit, transcripts, quota HTTP, health, bootstrap

**Files:**
- Modify: `backend/apps/api/src/rate-limit/rate-limit.guard.ts`
- Modify: `backend/apps/api/src/transcripts/transcripts.controller.ts`
- Modify: `backend/apps/api/src/transcripts/transcripts.service.ts`
- Modify: `backend/apps/api/src/quota/quota.controller.ts`
- Modify: `backend/apps/api/src/health/health.controller.ts`
- Modify: `backend/apps/api/src/create-app-validation-pipe.ts`
- Modify: `backend/apps/api/src/app.controller.ts`, `backend/apps/api/src/app.service.ts` (scaffold `getHello` — one sentence each)
- Modify: `backend/apps/api/src/main.ts` (`bootstrap`, local helpers)
- Test: matching `*.spec.ts` under those folders

**Interfaces:**
- Consumes: Task 1 style.
- Produces: remaining `api` app methods documented.

- [ ] **Step 1: Document `RateLimitGuard` / `AuthLimiter`**

Keep the existing class-level note if present; add name-first docs above each method: `canActivate`, `recordFailure`, `recordSuccess`, `isLocked`, `isBlocked`, `consumeIp`, `consumeLoginEmail`, `allowDictateUpgrade`, `onModuleDestroy`, Redis helpers (`incrExpire`, `prune`, keys, …). Empty when unsure.

- [ ] **Step 2: Document transcripts HTTP facade**

`TranscriptsController` / `TranscriptsService`: `list`, `get`, `delete`, `deleteAll`, `export`, `toUserId` — each proxies or shapes user-scoped history calls to workflows-service. One sentence each after reading.

- [ ] **Step 3: Document quota HTTP, health, validation pipe, main**

```typescript
  /** snapshot/get returns the caller's current quota snapshot from quota-service. */
  // health.controller check — Terminus liveness/readiness aggregate
  /** createAppValidationPipe builds the shared ValidationPipe used by api bootstrap. */
  /** bootstrap creates the Nest api app (HTTP + WS + microservices) and listens. */
```

- [ ] **Step 4: Run tests + commit**

Run: `cd backend && npx vitest run apps/api/src/rate-limit apps/api/src/transcripts apps/api/src/quota apps/api/src/health apps/api/src/app.controller.spec.ts`
Expected: PASS.

```bash
git add backend/apps/api/src/rate-limit backend/apps/api/src/transcripts \
  backend/apps/api/src/quota backend/apps/api/src/health \
  backend/apps/api/src/create-app-validation-pipe.ts \
  backend/apps/api/src/app.controller.ts backend/apps/api/src/app.service.ts \
  backend/apps/api/src/main.ts
git commit -m "$(cat <<'EOF'
docs(backend): document remaining api app functions

EOF
)"
```

---

### Task 5: `quota-service`

**Files:**
- Modify: `backend/apps/quota-service/src/quota.service.ts`
- Modify: `backend/apps/quota-service/src/quota.controller.ts`
- Modify: `backend/apps/quota-service/src/quota-service.controller.ts` / `quota-service.service.ts` (scaffold `getHello` only)
- Modify: `backend/apps/quota-service/src/main.ts`
- Skip: `entities/*.ts` with no methods
- Test: `backend/apps/quota-service/src/quota.service.spec.ts`, `quota-service.controller.spec.ts`

**Interfaces:**
- Consumes: Task 1 style.
- Produces: documented sole writer of period counters (`check` / `commit` / `adjust`).

- [ ] **Step 1: Document `QuotaService` API**

Suggested drafts:

```typescript
  /** withMemory constructs an in-memory QuotaService for unit tests. */
  static withMemory(): QuotaService {

  /** resolvePeriod returns the open usage period for the user at now, creating one if needed. */
  resolvePeriod(/* … */) {

  /** toSnapshot maps plan + period counters into the client QuotaSnapshot shape. */
  toSnapshot(/* … */) {

  /** seedUser installs a subscription/period fixture for tests. */
  seedUser(/* … */) {

  /**
   * check reports whether the user may start dictation under word and audio ceilings.
   * Does not mutate counters.
   */
  check(userId: string, now: Date): CheckQuotaResponseDto {

  /** checkFor adapts a CheckQuotaRequestDto into check(). */
  checkFor(dto: CheckQuotaRequestDto): CheckQuotaResponseDto {

  /**
   * commit records usage for requestId (idempotent) and advances words/audio on the period.
   */
  commit(/* … */) {

  /** adjust applies a manual words delta with a reason (support/admin path). */
  adjust(userId: string, now: Date, wordsDelta: number, reason: string): void {
```

Document private helpers (`loadCurrent`, `insertSubscription`, `indexPlan`, `requirePlan`, `defaultPlan`, `defaultPlanOrUndefined`, `toUsageRecord`, `seedDefaultFreePlan`, `periodKey`) after reading; empty if unsure.

- [ ] **Step 2: Document NATS controller + bootstrap**

```typescript
  /** check handles quota.check NATS RPC. */
  /** commit handles quota.commit NATS RPC. */
  /** bootstrap starts the quota-service Nest microservice process. */
```

- [ ] **Step 3: Run tests + commit**

Run: `cd backend && npx vitest run apps/quota-service`
Expected: PASS.

```bash
git add backend/apps/quota-service/src
git commit -m "$(cat <<'EOF'
docs(backend): add godoc-style comments on quota-service

EOF
)"
```

---

### Task 6: `speech-service`

**Files:**
- Modify: `backend/apps/speech-service/src/speech.service.ts`
- Modify: `backend/apps/speech-service/src/speech.controller.ts`
- Modify: `backend/apps/speech-service/src/groq.provider.ts`
- Modify: `backend/apps/speech-service/src/speech-service.*.ts` (scaffold only)
- Modify: `backend/apps/speech-service/src/main.ts`
- Test: `speech.service.spec.ts`, `groq.provider.spec.ts`, `speech-service.controller.spec.ts`

**Interfaces:**
- Consumes: Task 1 style.
- Produces: documented `speech.transcribe` path and Groq adapter.

- [ ] **Step 1: Document provider + service + controller**

```typescript
  /**
   * transcribe (GroqSpeechProvider) sends base64 Ogg/Opus audio to Groq and returns text + latency metadata.
   */
  async transcribe(/* … */) {

  /** createSpeechProvider builds the configured SpeechProvider (Groq) from env. */
  /** resolveGroqModel returns the model id from env with a safe default. */

  /** transcribe (SpeechController) handles the speech.transcribe NATS request. */
  /** logCompleted records a successful transcription metric/log line without logging transcript text. */
  /** bootstrap starts the speech-service Nest microservice process. */
```

Leave empty `/** */` on any helper whose role is unclear after a first read.

- [ ] **Step 2: Run tests + commit**

Run: `cd backend && npx vitest run apps/speech-service`
Expected: PASS.

```bash
git add backend/apps/speech-service/src
git commit -m "$(cat <<'EOF'
docs(backend): add godoc-style comments on speech-service

EOF
)"
```

---

### Task 7: `workflows-service` transcripts

**Files:**
- Modify: `backend/apps/workflows-service/src/transcripts/transcripts.service.ts`
- Modify: `backend/apps/workflows-service/src/transcripts/transcripts.controller.ts`
- Modify: `backend/apps/workflows-service/src/transcripts/transcript-crypto.ts`
- Modify: `backend/apps/workflows-service/src/workflows-service.controller.ts` / `workflows-service.service.ts` / `main.ts` (scaffold + bootstrap)
- Skip: `transcript.entity.ts` if property-only
- Test: `transcripts.service.spec.ts`, `transcripts.controller.spec.ts`, `transcript-crypto.spec.ts`

**Interfaces:**
- Consumes: Task 1 style.
- Produces: documented encrypted history CRUD/search/export and inbox create handler.

- [ ] **Step 1: Document crypto**

```typescript
/** encryptTranscript seals plaintext under the configured key for DB storage. */
/** decryptTranscript opens stored ciphertext back to plaintext for authorized reads. */
/** parseTranscriptEncryptionKey (if present) validates/decodes the env key material. */
```

- [ ] **Step 2: Document `TranscriptsService`**

Name-first docs for: `withMemory`, `fromEnv`, `handleInboxCreate`, `create`, `search`, `get`, `delete`, `deleteAll`, `export`, `list`, and private helpers (`store`, `findByRequestId`, `findById`, `loadVisible`, `persist`, `toPublic`, `isUniqueViolation`, `paginatePublic`, `compareNewestFirst`, …). Emphasize: never log `text`; ciphertext at rest; idempotent create by `requestId`.

Example:

```typescript
  /**
   * handleInboxCreate persists a workflows.create payload from the inbox processor.
   * Deduplicates on requestId so RMQ redelivery is safe.
   */
  async handleInboxCreate(/* … */) {

  /** search returns user-visible transcripts matching a decrypted-side query window. */
  /** export returns a downloadable dump of the user's visible history. */
```

Use empty `/** */` wherever the encryption/search details are unclear without deeper study.

- [ ] **Step 3: Document controller + bootstrap + commit**

Run: `cd backend && npx vitest run apps/workflows-service`
Expected: PASS.

```bash
git add backend/apps/workflows-service/src
git commit -m "$(cat <<'EOF'
docs(backend): add godoc-style comments on workflows-service transcripts

EOF
)"
```

---

### Task 8: `notifications-service`

**Files:**
- Modify: `backend/apps/notifications-service/src/mailer.ts`
- Modify: `backend/apps/notifications-service/src/notifications.controller.ts`
- Modify: `backend/apps/notifications-service/src/notifications-service.*.ts` / `main.ts`
- Test: `mailer.spec.ts`, `notifications.controller.spec.ts`

**Interfaces:**
- Consumes: Task 1 style.
- Produces: documented email event consumer.

- [ ] **Step 1: Document mailer + controller**

```typescript
  /** send delivers one templated email (verify, reset, quota-warning, quota-exhausted). */
  /** onEmail handles NOTIFICATIONS_EMAIL_EVENT payloads from RabbitMQ. */
  /** bootstrap starts the notifications-service Nest microservice process. */
```

- [ ] **Step 2: Run tests + commit**

Run: `cd backend && npx vitest run apps/notifications-service`
Expected: PASS.

```bash
git add backend/apps/notifications-service/src
git commit -m "$(cat <<'EOF'
docs(backend): add godoc-style comments on notifications-service

EOF
)"
```

---

### Task 9: Shared libs (`tracing`, `inbox`, `outbox`, DTO libs)

**Files:**
- Modify (methods present):  
  - `backend/libs/inbox/src/inbox.service.ts`, `inbox.processor.ts`, `inbox.module.ts`  
  - `backend/libs/outbox/src/outbox.service.ts`, `outbox.processor.ts`, `outbox.module.ts`, `outbox.constants.ts`  
  - `backend/libs/tracing/src/**/*.ts` that define functions/methods (logger, interceptor, proxies, headers, context, `is-observe-enabled`, module factories)  
  - `backend/libs/speech/src/speech-provider.ts` (interface method — document implementing notes only if there is a concrete function; skip pure interface)  
- Skip: token-only / DTO-only files with no functions (`tokens.ts`, most `dto/*.ts` without methods)
- Test: corresponding `*.spec.ts` under each lib

**Interfaces:**
- Consumes: Task 1 style.
- Produces: documented shared messaging/tracing utilities used by all apps.

- [ ] **Step 1: Document inbox**

```typescript
  /** store inserts an inbox row for an incoming message id. */
  /** storeIfNew inserts only when the message id is new (idempotent intake). */
  /** exists reports whether message id was already seen. */
  /** claimPending claims a batch of unprocessed inbox rows for the worker. */
  /** markProcessed marks a row successfully handled. */
  /** recordFailure / markFailed record processing failure state for retry/dead-letter behavior. */
  /** process / processPending drive the inbox worker loop on schedule or init. */
```

- [ ] **Step 2: Document outbox**

```typescript
  /** enqueue writes a transactional outbox row for later RMQ/NATS dispatch. */
  /** getPendingOutboxMessages loads undispatched rows for the processor. */
  /** markAsProcessed marks a row as dispatched. */
  /** processOutbox claims pending rows and emits to the configured ClientProxy routes. */
  /** forFeature / register wire Nest module providers for a target client token. */
```

- [ ] **Step 3: Document tracing**

For each of: `TracingLoggerService` log methods, `TraceInterceptor.intercept`, `TraceService.generateTraceId`, `TraceContextService.getTraceId` / `run` / `runWithNewTrace` (if present), header extractors, `TracingClientProxy` `traced` / `attachTraceId`, NATS/RMQ `register` factories, `isObserveEnabled` — add name-first 1–4 sentences. Empty when the Nest observe interaction is unclear.

- [ ] **Step 4: Run lib tests + commit**

Run: `cd backend && npx vitest run libs/inbox libs/outbox libs/tracing libs/speech`
Expected: PASS.

```bash
git add backend/libs
git commit -m "$(cat <<'EOF'
docs(backend): add godoc-style comments on shared libs

EOF
)"
```

---

### Task 10: Repo-wide verification sweep

**Files:**
- Modify: only leftovers found by the sweep (no intentional logic edits)
- Test: full `backend` unit suite

**Interfaces:**
- Consumes: all prior tasks.
- Produces: confirmation that documentable functions either have a name-first summary or an empty `/** */` placeholder.

- [ ] **Step 1: List remaining undocumented methods**

Run from `backend/`:

```bash
python3 <<'PY'
import re, pathlib
root = pathlib.Path('.')
member_re = re.compile(
    r'^[ \t]+(?:(?:public|private|protected|static|async|readonly|abstract|override)\s+)*(?:get\s+|set\s+)?([a-zA-Z_][\w]*)\s*\('
)
top_fn = re.compile(r'^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][\w]*)\s*\(')
skip = {'if', 'for', 'while', 'switch', 'catch', 'constructor', 'super', 'return'}
missing = []
for p in list(root.glob('apps/**/*.ts')) + list(root.glob('libs/**/*.ts')):
    if any(x in str(p) for x in ('.spec.ts', '.e2e-spec.ts', '.fixture.ts')):
        continue
    lines = p.read_text().splitlines()
    for i, line in enumerate(lines):
        m = member_re.match(line) or top_fn.match(line)
        if not m:
            continue
        name = m.group(1)
        if name in skip:
            continue
        window = lines[max(0, i - 6) : i]
        if any('*/' in w for w in window):
            continue
        missing.append(f'{p}:{i + 1}:{name}')
print('\n'.join(missing[:200]))
print(f'TOTAL_CANDIDATES_MISSING={len(missing)}')
PY
```

Expected: only interface-signature false positives and intentional skips; fix any real gaps with a comment or empty `/** */`.

- [ ] **Step 2: Full unit test run**

Run: `cd backend && npm test`
Expected: PASS (same failures as baseline if any pre-existed — do not “fix” by changing logic).

- [ ] **Step 3: Final diff sanity**

Run: `cd /Users/nhatnguyen/SourceCode/type-by-voice && git diff main...HEAD --stat` (or `git log -5 --oneline`)
Expected: commits are docs-only under `backend/`.

- [ ] **Step 4: Commit sweep fixes if any**

```bash
git add backend
git commit -m "$(cat <<'EOF'
docs(backend): finish function-doc sweep placeholders

EOF
)"
```

If there is nothing left to commit, skip this step.

---

## Self-Review

1. **Spec coverage:** Every requirement mapped — Go-style 1–4 sentence docs (Global Constraints + Task 1 style lock); entire backend apps/libs (Tasks 1–9); empty when unsure (Global Constraints + each task); no behavior changes (Global Constraints + diff checks); verification (tests per task + Task 10).
2. **Placeholder scan:** No TBD/TODO implement-later steps; draft comments included for high-traffic files; uncertain cases explicitly use empty `/** */`.
3. **Type consistency:** No new types/APIs; documentation refers to existing names (`DictateService`, `onText`, `check`, `commit`, …).

---
