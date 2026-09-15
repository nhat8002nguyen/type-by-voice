import {
  CLOSE_CODES,
  ERROR_CODES,
  SESSION_LIMITS,
  type ErrorCode,
  type Platform,
} from './constants.js';
import type {
  ErrorMessage,
  FinalMessage,
  QuotaSnapshot,
  ReadyMessage,
} from './types.js';
import { validateStart } from './validate-start.js';
import { countWords } from './word-count.js';

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

/** v1 estimate: 3 bytes ≈ 1 ms at ~24 kbps. Nest `api` may replace this with a real Ogg duration parser later without changing the error code. */
const BYTES_PER_MS = 3;

function estimateAudioMs(bytes: Uint8Array): number {
  return bytes.length / BYTES_PER_MS;
}

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

function closeCodeFor(code: ErrorCode): number {
  if (code === 'unauthenticated') {
    return CLOSE_CODES.unauthenticated;
  }
  if (code === 'quota_exceeded') {
    return CLOSE_CODES.quota_exceeded;
  }
  if (code === 'rate_limited') {
    return CLOSE_CODES.rate_limited;
  }
  return CLOSE_CODES.normal;
}

function requestIdOf(data: unknown, fallback: string | undefined): string {
  if (isRecord(data) && typeof data.requestId === 'string') {
    return data.requestId;
  }
  return fallback ?? '';
}

function isRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null;
}

export class DictationSession {
  #status: SessionStatus = 'open';
  #requestId: string | undefined;
  #audioChunks: Uint8Array[] = [];
  #readyAtMs: number | undefined;
  #lastAudioAtMs: number | undefined;
  #identity: SessionIdentity;
  #quota: QuotaSnapshot;
  #maxDurationMs: number;
  #nowMs: () => number;

  constructor(options: SessionMachineOptions) {
    this.#identity = options.identity;
    this.#quota = options.quota;
    this.#maxDurationMs = options.maxDurationMs ?? SESSION_LIMITS.maxDurationMs;
    this.#nowMs = options.nowMs;
  }

  get status(): SessionStatus {
    return this.#status;
  }

  get requestId(): string | undefined {
    return this.#requestId;
  }

  handle(event: SessionEvent): SessionOutput[] {
    if (event.kind === 'tick') {
      return [];
    }
    if (event.kind === 'binary') {
      return this.handleBinary(event.bytes);
    }
    return this.handleText(event.data);
  }

  completeTranscription(input: {
    text: string;
    audioMs: number;
    quota: QuotaSnapshot;
  }): SessionOutput[] {
    if (this.#status !== 'stopping' || this.#requestId === undefined) {
      return [];
    }
    this.#quota = input.quota;
    this.#status = 'closed';
    const message: FinalMessage = {
      type: 'final',
      requestId: this.#requestId,
      text: input.text,
      wordCount: countWords(input.text),
      audioMs: input.audioMs,
      quota: input.quota,
    };
    return [{ kind: 'send', message }];
  }

  failTranscription(code: 'provider_unavailable' | 'internal'): SessionOutput[] {
    if (this.#status !== 'stopping' || this.#requestId === undefined) {
      return [];
    }
    return this.error(code, this.#requestId);
  }

  private error(
    code: ErrorCode,
    requestId: string,
    details?: Record<string, unknown>,
  ): SessionOutput[] {
    this.#status = 'closed';
    this.#audioChunks = [];
    const message: ErrorMessage = {
      type: 'error',
      requestId,
      code,
      message: ERROR_MESSAGES[code],
      retryable: ERROR_CODES[code].retryable,
    };
    if (details !== undefined) {
      message.details = details;
    }
    return [
      { kind: 'send', message },
      { kind: 'close', code: closeCodeFor(code), reason: code },
    ];
  }

  private handleBinary(bytes: Uint8Array): SessionOutput[] {
    if (this.#status === 'ready') {
      this.#audioChunks.push(bytes);
      this.#lastAudioAtMs = this.#nowMs();
      return [];
    }
    if (this.#status === 'closed') {
      return [];
    }
    return this.error('invalid_request', this.#requestId ?? '');
  }

  private handleText(data: unknown): SessionOutput[] {
    if (!isRecord(data) || typeof data.type !== 'string') {
      return [];
    }
    switch (data.type) {
      case 'start':
        return this.handleStart(data);
      case 'stop':
        return this.handleStop(data);
      case 'cancel':
        return this.handleCancel(data);
      default:
        return [];
    }
  }

  private handleStart(data: unknown): SessionOutput[] {
    if (this.#status === 'ready' || this.#status === 'stopping') {
      return this.error('invalid_request', requestIdOf(data, this.#requestId));
    }
    if (this.#status !== 'open') {
      return [];
    }
    const result = validateStart(data);
    if (!result.ok) {
      return this.error('invalid_request', requestIdOf(data, this.#requestId));
    }
    const start = result.value;
    if (
      start.platform !== this.#identity.platform ||
      start.deviceId !== this.#identity.deviceId
    ) {
      return this.error('invalid_request', start.requestId);
    }
    this.#requestId = start.requestId;
    this.#audioChunks = [];
    this.#readyAtMs = this.#nowMs();
    this.#lastAudioAtMs = undefined;
    this.#status = 'ready';
    const message: ReadyMessage = {
      type: 'ready',
      requestId: start.requestId,
      maxDurationMs: this.#maxDurationMs,
      quota: this.#quota,
    };
    return [{ kind: 'send', message }];
  }

  private handleStop(data: Record<string, unknown>): SessionOutput[] {
    if (this.#status === 'closed' || this.#status === 'stopping') {
      return [];
    }
    if (this.#status !== 'ready' || this.#requestId === undefined || data.requestId !== this.#requestId) {
      return this.error('invalid_request', requestIdOf(data, this.#requestId));
    }
    const audio = concat(this.#audioChunks);
    this.#audioChunks = [];
    if (estimateAudioMs(audio) > this.#maxDurationMs) {
      return this.error('too_long', this.#requestId, {
        maxDurationMs: this.#maxDurationMs,
      });
    }
    this.#status = 'stopping';
    return [
      {
        kind: 'transcribe',
        requestId: this.#requestId,
        audio,
      },
    ];
  }

  private handleCancel(data: Record<string, unknown>): SessionOutput[] {
    if (this.#status !== 'open' && this.#status !== 'ready') {
      return [];
    }
    if (this.#status === 'ready' && data.requestId !== this.#requestId) {
      return this.error('invalid_request', requestIdOf(data, this.#requestId));
    }
    this.#audioChunks = [];
    this.#requestId = undefined;
    this.#readyAtMs = undefined;
    this.#lastAudioAtMs = undefined;
    this.#status = 'open';
    return [];
  }
}
