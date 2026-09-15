import { SESSION_LIMITS, type Platform } from './constants.js';
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

  failTranscription(_code: 'provider_unavailable' | 'internal'): SessionOutput[] {
    return [];
  }

  private handleBinary(bytes: Uint8Array): SessionOutput[] {
    if (this.#status !== 'ready') {
      return [];
    }
    this.#audioChunks.push(bytes);
    this.#lastAudioAtMs = this.#nowMs();
    return [];
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
    if (this.#status !== 'open') {
      return [];
    }
    const result = validateStart(data);
    if (!result.ok) {
      return [];
    }
    const start = result.value;
    if (
      start.platform !== this.#identity.platform ||
      start.deviceId !== this.#identity.deviceId
    ) {
      return [];
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
    if (this.#status !== 'ready' || this.#requestId === undefined) {
      return [];
    }
    if (data.requestId !== this.#requestId) {
      return [];
    }
    const audio = concat(this.#audioChunks);
    this.#audioChunks = [];
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
      return [];
    }
    this.#audioChunks = [];
    this.#requestId = undefined;
    this.#readyAtMs = undefined;
    this.#lastAudioAtMs = undefined;
    this.#status = 'open';
    return [];
  }
}
