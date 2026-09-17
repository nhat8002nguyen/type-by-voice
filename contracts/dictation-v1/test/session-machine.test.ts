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
