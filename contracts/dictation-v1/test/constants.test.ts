import { describe, expect, it } from 'vitest';
import {
  CLOSE_CODES,
  ERROR_CODES,
  PLATFORMS,
  SESSION_LIMITS,
} from '../src/constants.js';

describe('dictation v1 constants', () => {
  it('lists the four official platforms', () => {
    expect([...PLATFORMS]).toEqual(['macos', 'windows', 'ios', 'android']);
  });

  it('marks quota_exceeded non-retryable and provider_unavailable retryable', () => {
    expect(ERROR_CODES.quota_exceeded.retryable).toBe(false);
    expect(ERROR_CODES.provider_unavailable.retryable).toBe(true);
  });

  it('uses the spec close codes', () => {
    expect(CLOSE_CODES.normal).toBe(1000);
    expect(CLOSE_CODES.unauthenticated).toBe(4401);
    expect(CLOSE_CODES.quota_exceeded).toBe(4403);
    expect(CLOSE_CODES.rate_limited).toBe(4429);
  });

  it('uses the spec session limits', () => {
    expect(SESSION_LIMITS.maxDurationMs).toBe(120_000);
    expect(SESSION_LIMITS.firstAudioTimeoutMs).toBe(10_000);
    expect(SESSION_LIMITS.stopTimeoutMs).toBe(30_000);
    expect(SESSION_LIMITS.idleTimeoutMs).toBe(60_000);
    expect(SESSION_LIMITS.idempotencyTtlMs).toBe(5 * 60_000);
    expect(SESSION_LIMITS.maxConcurrentSessions).toBe(2);
  });
});
