import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { loadFixture } from '@type-by-voice/dictation-v1';
import {
  QUOTA_CHECK_PATTERN,
  QUOTA_COMMIT_PATTERN,
} from '../../../../libs/quota/src/tokens.js';
import { DictateService } from './dictate.service.js';
import type { ReadyMessage, StartMessage } from '@type-by-voice/dictation-v1';

describe('DictateService', () => {
  it('checks quota before ready and does not send audio on NATS until stop', async () => {
    const quota = {
      send: vi
        .fn()
        .mockReturnValue(
          of({ allowed: true, quota: loadFixture<ReadyMessage>('ready.json').quota }),
        ),
    };
    const speech = { send: vi.fn() };
    const service = new DictateService(
      quota as never,
      speech as never,
      outboxStub(),
      jwtUser(),
    );
    const ready = await service.onText(
      loadFixture<StartMessage>('start.valid.json'),
    );
    expect(ready).toMatchObject({ type: 'ready' });
    expect(speech.send).not.toHaveBeenCalled();
    await service.onBinary(Buffer.from('OggS'));
    expect(speech.send).not.toHaveBeenCalled();
  });

  it('on stop sends one transcribe RPC then commits quota', async () => {
    const quota = {
      send: vi.fn((pattern: string) =>
        of(
          pattern === QUOTA_CHECK_PATTERN
            ? {
                allowed: true,
                quota: {
                  unit: 'words',
                  limit: 2000,
                  used: 312,
                  resetAt: '2026-09-18T04:12:00Z',
                },
              }
            : {
                quota: {
                  unit: 'words',
                  limit: 2000,
                  used: 315,
                  resetAt: '2026-09-18T04:12:00Z',
                },
              },
        ),
      ),
    };
    const speech = {
      send: vi.fn().mockReturnValue(
        of({
          text: 'the transcribed text',
          provider: 'groq-whisper',
          providerLatencyMs: 20,
        }),
      ),
    };
    const service = new DictateService(
      quota as never,
      speech as never,
      outboxStub(),
      jwtUser(),
    );
    await service.onText(loadFixture<StartMessage>('start.valid.json'));
    await service.onBinary(Buffer.from('OggS'));
    const final = await service.onText(loadFixture('stop.valid.json'));
    expect(final).toMatchObject({
      type: 'final',
      text: 'the transcribed text',
      wordCount: 3,
    });
    expect(speech.send).toHaveBeenCalledOnce();
    expect(quota.send).toHaveBeenCalledWith(
      QUOTA_COMMIT_PATTERN,
      expect.objectContaining({ wordCount: 3 }),
    );
  });

  it('cancel never calls speech or quota commit', async () => {
    const speech = { send: vi.fn() };
    const quota = {
      send: vi.fn().mockReturnValue(
        of({
          allowed: true,
          quota: {
            unit: 'words',
            limit: 2000,
            used: 0,
            resetAt: '2026-09-18T04:12:00Z',
          },
        }),
      ),
    };
    const service = new DictateService(
      quota as never,
      speech as never,
      outboxStub(),
      jwtUser(),
    );
    await service.onText(loadFixture<StartMessage>('start.valid.json'));
    await service.onBinary(Buffer.from('OggS'));
    await service.onText(loadFixture('cancel.valid.json'));
    expect(speech.send).not.toHaveBeenCalled();
    expect(quota.send).not.toHaveBeenCalledWith(
      QUOTA_COMMIT_PATTERN,
      expect.anything(),
    );
  });

  it('provider throw fails transcription as provider_unavailable', async () => {
    const quota = {
      send: vi.fn().mockReturnValue(
        of({
          allowed: true,
          quota: {
            unit: 'words',
            limit: 2000,
            used: 0,
            resetAt: '2026-09-18T04:12:00Z',
          },
        }),
      ),
    };
    const speech = {
      send: vi.fn().mockReturnValue(throwError(() => new Error('groq down'))),
    };
    const service = new DictateService(
      quota as never,
      speech as never,
      outboxStub(),
      jwtUser(),
    );
    await service.onText(loadFixture<StartMessage>('start.valid.json'));
    await service.onBinary(Buffer.from('OggS'));
    const error = await service.onText(loadFixture('stop.valid.json'));
    expect(error).toMatchObject({
      type: 'error',
      code: 'provider_unavailable',
    });
    expect(quota.send).not.toHaveBeenCalledWith(
      QUOTA_COMMIT_PATTERN,
      expect.anything(),
    );
  });

  it('quota commit throw fails transcription as internal', async () => {
    const quota = {
      send: vi.fn((pattern: string) =>
        pattern === QUOTA_COMMIT_PATTERN
          ? throwError(() => new Error('quota down'))
          : of({
              allowed: true,
              quota: {
                unit: 'words',
                limit: 2000,
                used: 0,
                resetAt: '2026-09-18T04:12:00Z',
              },
            }),
      ),
    };
    const speech = {
      send: vi.fn().mockReturnValue(
        of({
          text: 'the transcribed text',
          provider: 'groq-whisper',
          providerLatencyMs: 20,
        }),
      ),
    };
    const service = new DictateService(
      quota as never,
      speech as never,
      outboxStub(),
      jwtUser(),
    );
    await service.onText(loadFixture<StartMessage>('start.valid.json'));
    await service.onBinary(Buffer.from('OggS'));
    const error = await service.onText(loadFixture('stop.valid.json'));
    expect(error).toMatchObject({ type: 'error', code: 'internal' });
    expect(service.takePendingClose()?.reason).toBe('internal');
  });

  it('still returns final when workflows outbox enqueue throws after commit', async () => {
    const quota = {
      send: vi.fn((pattern: string) =>
        of(
          pattern === QUOTA_CHECK_PATTERN
            ? {
                allowed: true,
                quota: {
                  unit: 'words',
                  limit: 2000,
                  used: 0,
                  resetAt: '2026-09-18T04:12:00Z',
                },
              }
            : {
                quota: {
                  unit: 'words',
                  limit: 2000,
                  used: 3,
                  resetAt: '2026-09-18T04:12:00Z',
                },
              },
        ),
      ),
    };
    const speech = {
      send: vi.fn().mockReturnValue(
        of({
          text: 'the transcribed text',
          provider: 'groq-whisper',
          providerLatencyMs: 20,
        }),
      ),
    };
    const outbox = {
      enqueue: vi.fn().mockRejectedValue(new Error('outbox down')),
    };
    const service = new DictateService(
      quota as never,
      speech as never,
      outbox as never,
      jwtUser(),
    );
    await service.onText(loadFixture<StartMessage>('start.valid.json'));
    await service.onBinary(Buffer.from('OggS'));
    const final = await service.onText(loadFixture('stop.valid.json'));
    expect(final).toMatchObject({
      type: 'final',
      text: 'the transcribed text',
      wordCount: 3,
    });
    expect(quota.send).toHaveBeenCalledWith(
      QUOTA_COMMIT_PATTERN,
      expect.objectContaining({ wordCount: 3 }),
    );
    expect(outbox.enqueue).toHaveBeenCalled();
  });

  it('enqueues quota-warning when remaining words are under 20% of limit', async () => {
    const quota = {
      send: vi.fn((pattern: string) =>
        of(
          pattern === QUOTA_CHECK_PATTERN
            ? {
                allowed: true,
                quota: {
                  unit: 'words',
                  limit: 2000,
                  used: 1590,
                  resetAt: '2026-09-18T04:12:00Z',
                },
              }
            : {
                quota: {
                  unit: 'words',
                  limit: 2000,
                  used: 1601,
                  resetAt: '2026-09-18T04:12:00Z',
                },
              },
        ),
      ),
    };
    const speech = {
      send: vi.fn().mockReturnValue(
        of({
          text: 'the transcribed text',
          provider: 'groq-whisper',
          providerLatencyMs: 20,
        }),
      ),
    };
    const outbox = outboxStub();
    const service = new DictateService(
      quota as never,
      speech as never,
      outbox as never,
      { ...jwtUser(), email: 'a@b.co' },
    );
    await service.onText(loadFixture<StartMessage>('start.valid.json'));
    await service.onBinary(Buffer.from('OggS'));
    await service.onText(loadFixture('stop.valid.json'));
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notifications.email',
        payload: expect.objectContaining({
          type: 'quota-warning',
          userId: jwtUser().userId,
          email: 'a@b.co',
          quota: {
            unit: 'words',
            limit: 2000,
            used: 1601,
            resetAt: '2026-09-18T04:12:00Z',
          },
        }),
      }),
    );
  });

  it('enqueues quota-exhausted when used reaches the limit', async () => {
    const quota = {
      send: vi.fn((pattern: string) =>
        of(
          pattern === QUOTA_CHECK_PATTERN
            ? {
                allowed: true,
                quota: {
                  unit: 'words',
                  limit: 2000,
                  used: 1997,
                  resetAt: '2026-09-18T04:12:00Z',
                },
              }
            : {
                quota: {
                  unit: 'words',
                  limit: 2000,
                  used: 2000,
                  resetAt: '2026-09-18T04:12:00Z',
                },
              },
        ),
      ),
    };
    const speech = {
      send: vi.fn().mockReturnValue(
        of({
          text: 'the transcribed text',
          provider: 'groq-whisper',
          providerLatencyMs: 20,
        }),
      ),
    };
    const outbox = outboxStub();
    const service = new DictateService(
      quota as never,
      speech as never,
      outbox as never,
      { ...jwtUser(), email: 'a@b.co' },
    );
    await service.onText(loadFixture<StartMessage>('start.valid.json'));
    await service.onBinary(Buffer.from('OggS'));
    await service.onText(loadFixture('stop.valid.json'));
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notifications.email',
        payload: expect.objectContaining({
          type: 'quota-exhausted',
          quota: {
            unit: 'words',
            limit: 2000,
            used: 2000,
            resetAt: '2026-09-18T04:12:00Z',
          },
        }),
      }),
    );
    expect(outbox.enqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ type: 'quota-warning' }),
      }),
    );
  });

  it('does not enqueue quota emails when the plan has a null limit', async () => {
    const quota = {
      send: vi.fn((pattern: string) =>
        of(
          pattern === QUOTA_CHECK_PATTERN
            ? {
                allowed: true,
                quota: {
                  unit: 'words',
                  limit: null,
                  used: 0,
                  resetAt: '2026-09-18T04:12:00Z',
                },
              }
            : {
                quota: {
                  unit: 'words',
                  limit: null,
                  used: 3,
                  resetAt: '2026-09-18T04:12:00Z',
                },
              },
        ),
      ),
    };
    const speech = {
      send: vi.fn().mockReturnValue(
        of({
          text: 'the transcribed text',
          provider: 'groq-whisper',
          providerLatencyMs: 20,
        }),
      ),
    };
    const outbox = outboxStub();
    const service = new DictateService(
      quota as never,
      speech as never,
      outbox as never,
      { ...jwtUser(), email: 'a@b.co' },
    );
    await service.onText(loadFixture<StartMessage>('start.valid.json'));
    await service.onBinary(Buffer.from('OggS'));
    await service.onText(loadFixture('stop.valid.json'));
    expect(outbox.enqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'notifications.email' }),
    );
  });

  it('still returns final when quota-email enqueue throws after commit', async () => {
    const quota = {
      send: vi.fn((pattern: string) =>
        of(
          pattern === QUOTA_CHECK_PATTERN
            ? {
                allowed: true,
                quota: {
                  unit: 'words',
                  limit: 2000,
                  used: 1590,
                  resetAt: '2026-09-18T04:12:00Z',
                },
              }
            : {
                quota: {
                  unit: 'words',
                  limit: 2000,
                  used: 1601,
                  resetAt: '2026-09-18T04:12:00Z',
                },
              },
        ),
      ),
    };
    const speech = {
      send: vi.fn().mockReturnValue(
        of({
          text: 'the transcribed text',
          provider: 'groq-whisper',
          providerLatencyMs: 20,
        }),
      ),
    };
    const outbox = {
      enqueue: vi.fn(async (message: { type: string }) => {
        if (message.type === 'notifications.email') {
          throw new Error('notifications outbox down');
        }
        return message;
      }),
    };
    const service = new DictateService(
      quota as never,
      speech as never,
      outbox as never,
      { ...jwtUser(), email: 'a@b.co' },
    );
    await service.onText(loadFixture<StartMessage>('start.valid.json'));
    await service.onBinary(Buffer.from('OggS'));
    const final = await service.onText(loadFixture('stop.valid.json'));
    expect(final).toMatchObject({
      type: 'final',
      text: 'the transcribed text',
      wordCount: 3,
    });
    expect(quota.send).toHaveBeenCalledWith(
      QUOTA_COMMIT_PATTERN,
      expect.objectContaining({ wordCount: 3 }),
    );
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'workflows.create' }),
    );
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'notifications.email' }),
    );
  });
});

function jwtUser() {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    platform: 'macos' as const,
    deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
    clientVersion: '1.0.0+12',
  };
}

function outboxStub() {
  return {
    enqueue: vi.fn(
      async (message: {
        type: string;
        payload: Record<string, unknown>;
        target: string | symbol;
      }) => message,
    ),
  };
}
