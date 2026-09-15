import { describe, expect, it } from 'vitest';
import { loadFixture } from '../src/fixtures.js';
import { IdempotencyCache } from '../src/idempotency.js';
import type { FinalMessage } from '../src/types.js';

describe('IdempotencyCache', () => {
  it('returns a cached final within 5 minutes and misses after', () => {
    let now = 1_000;
    const cache = new IdempotencyCache({ nowMs: () => now });
    const final = loadFixture<FinalMessage>('final.json');
    cache.remember(final.requestId, final);
    expect(cache.lookup(final.requestId)).toEqual(final);
    now += 5 * 60_000 - 1;
    expect(cache.lookup(final.requestId)?.type).toBe('final');
    now += 2;
    expect(cache.lookup(final.requestId)).toBeUndefined();
  });

  it('does not re-store a different outcome for the same requestId', () => {
    const cache = new IdempotencyCache({ nowMs: () => 0 });
    const final = loadFixture<FinalMessage>('final.json');
    cache.remember(final.requestId, final);
    cache.remember(final.requestId, { ...final, text: 'other' });
    expect(cache.lookup(final.requestId)?.type).toBe('final');
    if (cache.lookup(final.requestId)?.type === 'final') {
      expect((cache.lookup(final.requestId) as FinalMessage).text).toBe('the transcribed text');
    }
  });
});
