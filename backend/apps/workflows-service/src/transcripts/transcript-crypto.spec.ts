import { describe, expect, it } from 'vitest';
import { decryptTranscript, encryptTranscript } from './transcript-crypto.js';

describe('transcript crypto', () => {
  it('round-trips plaintext', () => {
    const key = Buffer.alloc(32, 7);
    const blob = encryptTranscript('the transcribed text', key);
    expect(blob.includes(Buffer.from('the transcribed text'))).toBe(false);
    expect(decryptTranscript(blob, key)).toBe('the transcribed text');
  });
});
