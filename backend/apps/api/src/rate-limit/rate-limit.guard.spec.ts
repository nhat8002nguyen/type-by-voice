import { describe, expect, it } from 'vitest';
import { AuthLimiter, RateLimitGuard } from './rate-limit.guard.js';

describe('AuthLimiter', () => {
  it('locks after 5 failed logins', () => {
    const limiter = new AuthLimiter({ nowMs: () => 0 });
    for (let i = 0; i < 5; i += 1) limiter.recordFailure('a@b.co', '1.1.1.1');
    expect(limiter.isBlocked('a@b.co', '1.1.1.1')).toBe(true);
  });
});

describe('RateLimitGuard Redis keys', () => {
  it('locks via lock:email after 5 failed logins', async () => {
    const values = new Map<string, string>();
    const ttls = new Map<string, number>();
    const redis = {
      incr: async (key: string) => {
        const next = Number(values.get(key) ?? 0) + 1;
        values.set(key, String(next));
        return next;
      },
      expire: async (key: string, seconds: number) => {
        ttls.set(key, seconds);
        return 1;
      },
      get: async (key: string) => values.get(key) ?? null,
      del: async (key: string) => {
        values.delete(key);
        ttls.delete(key);
        return 1;
      },
      ttl: async (key: string) => ttls.get(key) ?? -2,
    };
    const guard = new RateLimitGuard(redis);
    for (let i = 0; i < 5; i += 1) {
      await guard.recordFailure('a@b.co', '1.1.1.1');
    }
    expect(values.get('lock:email:a@b.co')).toBe('5');
    expect(ttls.get('lock:email:a@b.co')).toBe(32);
    await expect(guard.isLocked('a@b.co')).resolves.toBe(true);
  });
});
