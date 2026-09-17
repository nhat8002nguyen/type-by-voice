import { WebSocketServer, type RawData } from 'ws';
import { CLOSE_CODES } from './constants.js';
import { IdempotencyCache } from './idempotency.js';
import { DictationSession, type SessionOutput } from './session-machine.js';
import type { QuotaSnapshot } from './types.js';
import { countWords } from './word-count.js';

const IDENTITY = {
  userId: 'user-1',
  platform: 'macos',
  deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
} as const;

const QUOTA: QuotaSnapshot = {
  unit: 'words',
  limit: 2000,
  used: 312,
  resetAt: '2026-09-18T04:12:00Z',
};

const BYTES_PER_MS = 3;

export async function startMockDictateServer(options?: {
  port?: number;
  transcript?: string;
  quotaExceeded?: boolean;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const cache = new IdempotencyCache({ nowMs: () => Date.now() });
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: options?.port ?? 0,
    path: '/v1/dictate',
  });

  await new Promise<void>((resolve, reject) => {
    if (wss.address() !== null) {
      resolve();
      return;
    }
    wss.once('listening', () => resolve());
    wss.once('error', reject);
  });

  wss.on('connection', (socket, req) => {
    if (req.headers.authorization !== 'Bearer test-token') {
      socket.close(CLOSE_CODES.unauthenticated);
      return;
    }
    if (options?.quotaExceeded) {
      socket.close(CLOSE_CODES.quota_exceeded);
      return;
    }

    let session = createSession();
    const tick = setInterval(() => {
      dispatch(session.handle({ kind: 'tick', nowMs: Date.now() }));
    }, 100);

    socket.on('close', () => {
      clearInterval(tick);
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        dispatch(session.handle({ kind: 'binary', bytes: toBytes(data) }));
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }

      if (isStart(parsed)) {
        const cached = cache.lookup(parsed.requestId);
        if (cached?.type === 'final') {
          socket.send(JSON.stringify(cached));
          return;
        }
      }

      if (session.status === 'closed') {
        session = createSession();
      }

      dispatch(session.handle({ kind: 'text', data: parsed }));
    });

    function dispatch(outputs: SessionOutput[]): void {
      for (const output of outputs) {
        if (output.kind === 'send') {
          socket.send(JSON.stringify(output.message));
          if (output.message.type === 'final' || output.message.type === 'error') {
            cache.remember(output.message.requestId, output.message);
          }
          continue;
        }
        if (output.kind === 'close') {
          socket.close(output.code);
          continue;
        }
        const text = options?.transcript ?? '';
        dispatch(
          session.completeTranscription({
            text,
            audioMs: Math.round(output.audio.byteLength / BYTES_PER_MS),
            quota: { ...QUOTA, used: QUOTA.used + countWords(text) },
          }),
        );
      }
    }
  });

  const address = wss.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP listen address');
  }

  return {
    url: `ws://127.0.0.1:${address.port}/v1/dictate`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}

function createSession(): DictationSession {
  return new DictationSession({
    nowMs: () => Date.now(),
    identity: IDENTITY,
    quota: QUOTA,
  });
}

function isStart(data: unknown): data is { type: 'start'; requestId: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'start' &&
    typeof (data as { requestId?: unknown }).requestId === 'string'
  );
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    const total = data.reduce((n, chunk) => n + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of data) {
      const bytes = new Uint8Array(chunk);
      out.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return out;
  }
  return new Uint8Array(data);
}
