import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ClientProxy } from '@nestjs/microservices';
import type { OutboxService } from '@app/outbox';
import {
  QUOTA_CHECK_PATTERN,
  QUOTA_COMMIT_PATTERN,
  type CheckQuotaRequestDto,
  type CheckQuotaResponseDto,
  type CommitQuotaRequestDto,
  type CommitQuotaResponseDto,
} from '@app/quota';
import {
  SPEECH_TRANSCRIBE_PATTERN,
  type TranscribeRequestDto,
  type TranscribeResponseDto,
} from '@app/speech';
import {
  NOTIFICATIONS_EMAIL_EVENT,
  NOTIFICATIONS_SERVICE,
} from '@app/notifications';
import { WORKFLOWS_CREATE_EVENT, WORKFLOWS_SERVICE } from '@app/workflows';
import {
  CLOSE_CODES,
  ERROR_CODES,
  DictationSession,
  IdempotencyCache,
  countWords,
  type ErrorCode,
  type ErrorMessage,
  type Platform,
  type ServerTextMessage,
  type QuotaSnapshot,
  type SessionOutput,
} from '@type-by-voice/dictation-v1';
import { firstValueFrom } from 'rxjs';
import { SessionRegistry } from './session-registry.js';
import { DictateMetrics } from '../metrics/dictate-metrics.js';

const BYTES_PER_MS = 3;
const COST_MICROS_PER_HOUR = 40_000;
const MS_PER_HOUR = 3_600_000;

const ERROR_MESSAGES: Record<ErrorCode, string> = {
  unauthenticated: 'Missing, invalid, or expired token.',
  quota_exceeded: 'Weekly limit reached.',
  audio_cap_exceeded: 'Audio-minute ceiling reached.',
  too_long: 'Audio exceeded maxDurationMs.',
  invalid_request: 'Malformed message or unsupported audio parameters.',
  rate_limited: 'Too many requests.',
  provider_unavailable: 'Speech provider failed.',
  internal: 'Unexpected server error.',
  session_timeout: 'No audio or no stop received within the session window.',
};

export type DictateUser = {
  userId: string;
  sessionId: string;
  platform: Platform;
  deviceId: string;
  clientVersion: string;
  email?: string;
};

export type DictateClose = {
  code: number;
  reason: string;
};

type QuotaClient = Pick<ClientProxy, 'send'>;
type SpeechClient = Pick<ClientProxy, 'send'>;
type Outbox = Pick<OutboxService, 'enqueue'>;

export class DictateService {
  readonly sessionKey = randomUUID();
  readonly #quota: QuotaClient;
  readonly #speech: SpeechClient;
  readonly #outbox: Outbox;
  readonly #user: DictateUser;
  readonly #cache: IdempotencyCache;
  readonly #registry: SessionRegistry | undefined;
  readonly #metrics: DictateMetrics | undefined;
  readonly #logger = new Logger(DictateService.name);
  readonly #startedAtMs = Date.now();
  #session: DictationSession | undefined;
  #pendingClose: DictateClose | undefined;
  #audioReceivedAtMs: number | undefined;
  #providerMs = 0;

  constructor(
    quota: QuotaClient,
    speech: SpeechClient,
    outbox: Outbox,
    user: DictateUser,
    cache: IdempotencyCache = new IdempotencyCache({ nowMs: () => Date.now() }),
    registry?: SessionRegistry,
    metrics?: DictateMetrics,
  ) {
    this.#quota = quota;
    this.#speech = speech;
    this.#outbox = outbox;
    this.#user = user;
    this.#cache = cache;
    this.#registry = registry;
    this.#metrics = metrics;
  }

  /** userId returns the authenticated user id for this WebSocket session. */
  get userId(): string {
    return this.#user.userId;
  }

  /** platform returns the client platform claimed at connection time. */
  get platform(): Platform {
    return this.#user.platform;
  }

  /** deviceId returns the client device id claimed at connection time. */
  get deviceId(): string {
    return this.#user.deviceId;
  }

  /** audioReceivedMs returns milliseconds from connect until the last binary audio frame (or connect if none). */
  get audioReceivedMs(): number {
    return (this.#audioReceivedAtMs ?? this.#startedAtMs) - this.#startedAtMs;
  }

  /** providerMs returns the last speech-provider round-trip duration in milliseconds. */
  get providerMs(): number {
    return this.#providerMs;
  }

  /** isBusy reports whether the session is waiting on transcription after stop. */
  get isBusy(): boolean {
    return this.#session?.status === 'stopping';
  }

  /**
   * failUnexpected maps unexpected errors to a protocol error message.
   * Syntax errors become invalid_request; failures during stopping fail the in-flight transcription.
   */
  failUnexpected(error?: unknown): ServerTextMessage {
    const requestId = this.#session?.requestId ?? '';
    if (error instanceof SyntaxError) {
      return this.protocolError('invalid_request', requestId);
    }
    if (this.#session?.status === 'stopping') {
      return (
        this.applyOutputs(this.#session.failTranscription('internal')) ??
        this.protocolError('internal', requestId)
      );
    }
    return this.protocolError('internal', requestId);
  }

  /** takePendingClose returns and clears a close instruction produced by the session state machine. */
  takePendingClose(): DictateClose | undefined {
    const close = this.#pendingClose;
    this.#pendingClose = undefined;
    return close;
  }

  /**
   * onText handles a client JSON control message (start/stop/cancel/…).
   * Replays idempotent finals from cache when a start repeats a finished requestId.
   */
  async onText(data: unknown): Promise<ServerTextMessage | undefined> {
    if (isStart(data)) {
      const cached = this.#cache.lookup(data.requestId);
      if (cached?.type === 'final') {
        return cached;
      }
      if (
        this.#session === undefined ||
        this.#session.status === 'open' ||
        this.#session.status === 'closed'
      ) {
        return this.startSession(data);
      }
    }

    if (this.#session === undefined) {
      return undefined;
    }

    const message = await this.consume(
      this.#session.handle({ kind: 'text', data }),
    );
    if (isCancel(data)) {
      this.#registry?.remove(this.#user.userId, this.sessionKey);
    }
    return message;
  }

  /** onBinary forwards one Opus frame into the active DictationSession buffer. */
  async onBinary(bytes: Buffer): Promise<ServerTextMessage | undefined> {
    if (this.#session === undefined) {
      return undefined;
    }
    this.#audioReceivedAtMs = Date.now();
    return this.consume(
      this.#session.handle({
        kind: 'binary',
        bytes: Uint8Array.from(bytes),
      }),
    );
  }

  /** onTick advances session timers (idle / max duration) and may emit timeout errors. */
  async onTick(nowMs: number): Promise<ServerTextMessage | undefined> {
    if (this.#session === undefined) {
      return undefined;
    }
    return this.consume(this.#session.handle({ kind: 'tick', nowMs }));
  }

  /**
   * startSession enforces per-user concurrency, checks quota via NATS, then opens a DictationSession.
   * Returns a protocol error when concurrency, quota, or the check RPC fails.
   */
  private async startSession(
    data: StartMessageLike,
  ): Promise<ServerTextMessage | undefined> {
    if (
      this.#registry &&
      !this.#registry.tryAdd(this.#user.userId, this.sessionKey)
    ) {
      return this.protocolError('invalid_request', data.requestId);
    }

    let check: CheckQuotaResponseDto;
    try {
      check = await firstValueFrom(
        this.#quota.send<CheckQuotaResponseDto, CheckQuotaRequestDto>(
          QUOTA_CHECK_PATTERN,
          {
            userId: this.#user.userId,
            sessionId: this.#user.sessionId,
            platform: this.#user.platform,
            clientVersion: this.#user.clientVersion,
            deviceId: this.#user.deviceId,
          },
        ),
      );
    } catch {
      this.#registry?.remove(this.#user.userId, this.sessionKey);
      return this.protocolError('internal', data.requestId);
    }

    if (!check.allowed) {
      this.#registry?.remove(this.#user.userId, this.sessionKey);
      this.#metrics?.recordQuotaRejected();
      const code: ErrorCode =
        check.reason === 'audio_cap_exceeded'
          ? 'audio_cap_exceeded'
          : 'quota_exceeded';
      return this.protocolError(code, data.requestId);
    }

    if (
      typeof data.clientVersion === 'string' &&
      data.clientVersion.length > 0
    ) {
      this.#user.clientVersion = data.clientVersion;
    }

    this.#session = new DictationSession({
      nowMs: () => Date.now(),
      identity: {
        userId: this.#user.userId,
        platform: this.#user.platform,
        deviceId: this.#user.deviceId,
      },
      quota: check.quota,
    });

    const message = await this.consume(
      this.#session.handle({ kind: 'text', data }),
    );
    if (message?.type !== 'ready') {
      this.#registry?.remove(this.#user.userId, this.sessionKey);
    }
    return message;
  }

  /**
   * consume applies SessionOutput list in order, running transcription when requested.
   * Returns the last server text message produced.
   */
  private async consume(
    outputs: SessionOutput[],
  ): Promise<ServerTextMessage | undefined> {
    let last: ServerTextMessage | undefined;
    for (const output of outputs) {
      if (output.kind === 'transcribe') {
        last = await this.transcribeAndFinalize(output);
        continue;
      }
      last = this.applyOutput(output) ?? last;
    }
    return last;
  }

  /** applyOutputs applies non-transcribe SessionOutputs (send/close) without calling speech. */
  private applyOutputs(
    outputs: SessionOutput[],
  ): ServerTextMessage | undefined {
    let last: ServerTextMessage | undefined;
    for (const output of outputs) {
      if (output.kind === 'transcribe') {
        continue;
      }
      last = this.applyOutput(output) ?? last;
    }
    return last;
  }

  /** applyOutput sends a message to the client path or records a pending WebSocket close. */
  private applyOutput(
    output: Extract<SessionOutput, { kind: 'send' } | { kind: 'close' }>,
  ): ServerTextMessage | undefined {
    if (output.kind === 'send') {
      if (output.message.type === 'final' || output.message.type === 'error') {
        this.#cache.remember(output.message.requestId, output.message);
        this.#registry?.remove(this.#user.userId, this.sessionKey);
      }
      return output.message;
    }
    this.#pendingClose = { code: output.code, reason: output.reason };
    return undefined;
  }

  /**
   * transcribeAndFinalize sends assembled audio to speech-service, commits quota, and enqueues transcript persistence.
   * Completes or fails the DictationSession based on provider and quota RPC outcomes.
   */
  /**
   * transcribeAndFinalize sends assembled audio to speech-service, commits quota, and enqueues transcript persistence.
   * Completes or fails the DictationSession based on provider and quota RPC outcomes.
   * Forwards the request's language and translation mode to speech-service and quota-service.
   */
  private async transcribeAndFinalize(output: {
    requestId: string;
    audio: Uint8Array;
    listInHistory: boolean;
    language?: 'en' | 'vi';
    translateToEnglish: boolean;
  }): Promise<ServerTextMessage | undefined> {
    const session = this.#session;
    if (session === undefined) {
      return undefined;
    }
    const audioMs = Math.round(output.audio.byteLength / BYTES_PER_MS);
    let result: TranscribeResponseDto;
    const providerStartedAt = Date.now();
    try {
      result = await firstValueFrom(
        this.#speech.send<TranscribeResponseDto, TranscribeRequestDto>(
          SPEECH_TRANSCRIBE_PATTERN,
          {
            requestId: output.requestId,
            language: output.language,
            translateToEnglish: output.translateToEnglish,
            audioBase64: Buffer.from(output.audio).toString('base64'),
          },
        ),
      );
      this.#providerMs = Date.now() - providerStartedAt;
    } catch {
      this.#providerMs = Date.now() - providerStartedAt;
      this.#metrics?.recordProviderError();
      return this.consume(session.failTranscription('provider_unavailable'));
    }

    const wordCount = countWords(result.text);
    let commit: CommitQuotaResponseDto;
    try {
      commit = await firstValueFrom(
        this.#quota.send<CommitQuotaResponseDto, CommitQuotaRequestDto>(
          QUOTA_COMMIT_PATTERN,
          {
            userId: this.#user.userId,
            requestId: output.requestId,
            sessionId: this.#user.sessionId,
            platform: this.#user.platform,
            clientVersion: this.#user.clientVersion,
            audioMs,
            wordCount,
            provider: result.provider,
            providerLatencyMs: result.providerLatencyMs,
            estimatedCostMicros: estimatedCostMicros(audioMs),
            language: output.language,
            translateToEnglish: output.translateToEnglish,
          },
        ),
      );
    } catch {
      return this.consume(session.failTranscription('internal'));
    }

    const createPayload = {
      userId: this.#user.userId,
      requestId: output.requestId,
      text: result.text,
      wordCount,
      audioMs,
      listInHistory: output.listInHistory,
    };
    try {
      await this.#outbox.enqueue({
        type: WORKFLOWS_CREATE_EVENT,
        target: WORKFLOWS_SERVICE,
        payload: createPayload,
      });
    } catch {
      this.#logger.error(
        `workflows outbox enqueue failed requestId=${output.requestId}`,
      );
      try {
        await this.#outbox.enqueue({
          type: WORKFLOWS_CREATE_EVENT,
          target: WORKFLOWS_SERVICE,
          payload: createPayload,
        });
      } catch {
        this.#logger.error(
          `workflows outbox enqueue retry failed requestId=${output.requestId}`,
        );
      }
    }

    await this.enqueueQuotaEmail(commit.quota).catch(() => undefined);

    return this.consume(
      session.completeTranscription({
        text: result.text,
        audioMs,
        quota: commit.quota,
      }),
    );
  }

  /**
   * enqueueQuotaEmail enqueues a warning or exhausted email when usage crosses thresholds.
   * No-ops when the user has no email or the plan has no word limit.
   */
  private async enqueueQuotaEmail(quota: QuotaSnapshot): Promise<void> {
    const email = this.#user.email;
    if (!email || quota.limit == null) {
      return;
    }
    const remaining = quota.limit - quota.used;
    let type: 'quota-warning' | 'quota-exhausted' | undefined;
    if (quota.used >= quota.limit) {
      type = 'quota-exhausted';
    } else if (remaining < quota.limit * 0.2) {
      type = 'quota-warning';
    }
    if (!type) {
      return;
    }
    await this.#outbox.enqueue({
      type: NOTIFICATIONS_EMAIL_EVENT,
      target: NOTIFICATIONS_SERVICE,
      payload: {
        type,
        userId: this.#user.userId,
        email,
        quota,
      },
    });
  }

  /**
   * protocolError builds an ErrorMessage, caches it for idempotency, and schedules the matching close code.
   */
  private protocolError(code: ErrorCode, requestId: string): ErrorMessage {
    this.#pendingClose = {
      code:
        code === 'quota_exceeded' || code === 'audio_cap_exceeded'
          ? CLOSE_CODES.quota_exceeded
          : CLOSE_CODES.normal,
      reason: code,
    };
    const message: ErrorMessage = {
      type: 'error',
      requestId,
      code,
      message: ERROR_MESSAGES[code],
      retryable: ERROR_CODES[code].retryable,
    };
    this.#cache.remember(requestId, message);
    return message;
  }
}

/** estimatedCostMicros estimates provider cost in micros from audio duration. */
export function estimatedCostMicros(audioMs: number): number {
  return Math.round((audioMs / MS_PER_HOUR) * COST_MICROS_PER_HOUR);
}

type StartMessageLike = {
  type: 'start';
  requestId: string;
  clientVersion?: unknown;
};

/** isStart is a type guard for client start control messages with a string requestId. */
function isStart(data: unknown): data is StartMessageLike {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'start' &&
    typeof (data as { requestId?: unknown }).requestId === 'string'
  );
}

/** isCancel reports whether the payload is a cancel control message. */
function isCancel(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'cancel'
  );
}
