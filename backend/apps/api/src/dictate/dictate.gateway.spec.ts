import { CLOSE_CODES, loadFixture } from '@type-by-voice/dictation-v1';
import type { IncomingMessage } from 'node:http';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeCodeForAuthError,
  closeCodeForQuota,
  closeCodeForRateLimit,
  DictateGateway,
} from './dictate.gateway.js';
import { SessionRegistry } from './session-registry.js';

describe('DictateGateway close codes', () => {
  it('maps auth errors to 4401', () => {
    expect(closeCodeForAuthError()).toBe(CLOSE_CODES.unauthenticated);
    expect(closeCodeForAuthError()).toBe(4401);
  });

  it('maps quota exceeded to 4403', () => {
    expect(closeCodeForQuota()).toBe(CLOSE_CODES.quota_exceeded);
    expect(closeCodeForQuota()).toBe(4403);
  });

  it('maps rate limited to 4429', () => {
    expect(closeCodeForRateLimit()).toBe(CLOSE_CODES.rate_limited);
    expect(closeCodeForRateLimit()).toBe(4429);
  });
});

describe('DictateGateway connection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues start received while upgrade auth is in flight', async () => {
    const jwt = Promise.withResolvers<JwtPayload>();
    const { gateway, socket } = createHarness({
      verifyAsync: vi.fn().mockReturnValue(jwt.promise),
    });

    const connecting = gateway.handleConnection(socket, authReq());
    socket.emitMessage(JSON.stringify(loadFixture('start.valid.json')));

    jwt.resolve(jwtPayload());
    await connecting;
    await socket.flush();

    expect(socket.sent[0]).toMatchObject({ type: 'ready' });
  });

  it('sends a protocol error instead of swallowing handleMessage throws', async () => {
    const { gateway, socket } = createHarness();
    await gateway.handleConnection(socket, authReq());
    socket.dictateService!.onText = vi
      .fn()
      .mockRejectedValue(new Error('boom'));

    socket.emitMessage(JSON.stringify(loadFixture('start.valid.json')));
    await socket.flush();

    expect(socket.sent[0]).toMatchObject({ type: 'error', code: 'internal' });
    expect(socket.closeCalls.length).toBeGreaterThan(0);
  });

  it('closes 4429 when dictate upgrade is over limit', async () => {
    const { gateway, socket } = createHarness({
      limiter: { allowDictateUpgrade: () => false },
    });
    await gateway.handleConnection(socket, authReq());
    expect(socket.closeCalls[0]?.code).toBe(4429);
  });

  it('does not idle-close while stop is awaiting transcribe', async () => {
    vi.useFakeTimers();
    const transcribe = Promise.withResolvers<{
      text: string;
      provider: string;
      providerLatencyMs: number;
    }>();
    const { gateway, socket } = createHarness({
      speechSend: vi.fn().mockReturnValue(fromPromise(transcribe.promise)),
    });

    await gateway.handleConnection(socket, authReq());
    socket.emitMessage(JSON.stringify(loadFixture('start.valid.json')));
    await socket.flush();
    socket.emitMessage(Buffer.from('OggS'));
    socket.emitMessage(JSON.stringify(loadFixture('stop.valid.json')));
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS);
    expect(socket.closeCalls).toEqual([]);

    transcribe.resolve({
      text: 'the transcribed text',
      provider: 'groq-whisper',
      providerLatencyMs: 20,
    });
    await socket.flush();
    expect(socket.sent.some((message) => message.type === 'final')).toBe(true);
    expect(socket.closeCalls).toEqual([]);
  });
});

const SESSION_IDLE_MS = 60_000;

type JwtPayload = {
  sub: string;
  sid: string;
  platform: 'macos';
  deviceId: string;
};

function jwtPayload(): JwtPayload {
  return {
    sub: '11111111-1111-4111-8111-111111111111',
    sid: '22222222-2222-4222-8222-222222222222',
    platform: 'macos',
    deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
  };
}

function authReq(): IncomingMessage {
  return { headers: { authorization: 'Bearer test-token' } } as IncomingMessage;
}

function fromPromise<T>(promise: Promise<T>) {
  return {
    subscribe(observer: {
      next: (value: T) => void;
      complete: () => void;
      error: (err: unknown) => void;
    }) {
      void promise.then(
        (value) => {
          observer.next(value);
          observer.complete();
        },
        (err: unknown) => observer.error(err),
      );
      return { unsubscribe() {} };
    },
  };
}

function createHarness(options?: {
  verifyAsync?: ReturnType<typeof vi.fn>;
  speechSend?: ReturnType<typeof vi.fn>;
  limiter?: { allowDictateUpgrade: (ip: string) => boolean };
}) {
  const quotaSnapshot = {
    unit: 'words' as const,
    limit: 2000,
    used: 312,
    resetAt: '2026-09-18T04:12:00Z',
  };
  const socket = new FakeSocket();
  const gateway = new DictateGateway(
    {
      verifyAsync:
        options?.verifyAsync ?? vi.fn().mockResolvedValue(jwtPayload()),
    } as never,
    {
      send: vi.fn((pattern: string) =>
        of(
          pattern === 'quota.commit'
            ? { quota: { ...quotaSnapshot, used: 315 } }
            : { allowed: true, quota: quotaSnapshot },
        ),
      ),
    } as never,
    {
      send:
        options?.speechSend ??
        vi
          .fn()
          .mockReturnValue(
            of({ text: '', provider: 'groq-whisper', providerLatencyMs: 0 }),
          ),
    } as never,
    {
      enqueue: vi.fn(async (message: unknown) => message),
    } as never,
    new SessionRegistry(),
    {
      getMe: vi.fn().mockResolvedValue({
        id: jwtPayload().sub,
        email: 'a@b.co',
        emailVerifiedAt: null,
      }),
    } as never,
    undefined,
    options?.limiter as never,
  );
  return { gateway, socket };
}

class FakeSocket {
  dictateService?: { onText: (...args: never[]) => unknown };
  dictateTimer?: ReturnType<typeof setInterval>;
  lastActivityMs?: number;
  messageChain?: Promise<void>;
  sent: Array<{ type: string; code?: string }> = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  readonly #listeners = new Map<string, Array<(data: Buffer) => void>>();

  on(event: string, listener: (data: Buffer) => void): void {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
  }

  emitMessage(data: string | Buffer): void {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    for (const listener of this.#listeners.get('message') ?? []) {
      listener(buffer);
    }
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as { type: string; code?: string });
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  async flush(): Promise<void> {
    await this.messageChain;
    await Promise.resolve();
    await this.messageChain;
  }
}
