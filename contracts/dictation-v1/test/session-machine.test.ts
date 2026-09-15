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
