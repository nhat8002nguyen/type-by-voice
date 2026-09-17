import { describe, expect, it } from 'vitest';
import {
  AuthLimiter,
  RateLimitGuard,
  lockSeconds,
} from './rate-limit.guard.js';

describe('AuthLimiter', () => {
  it('locks after 5 failed logins', () => {
    const limiter = new AuthLimiter({ nowMs: () => 0 });
    for (let i = 0; i < 5; i += 1) limiter.recordFailure('a@b.co', '1.1.1.1');
    expect(limiter.isBlocked('a@b.co', '1.1.1.1')).toBe(true);
  });

  it('keeps the failure count after the lock window so backoff can reach 60s', () => {
    let nowMs = 0;
    const limiter = new AuthLimiter({ nowMs: () => nowMs });
    for (let i = 0; i < 5; i += 1) limiter.recordFailure('a@b.co', '1.1.1.1');
    nowMs = lockSeconds(5) * 1000 + 1;
    expect(limiter.isBlocked('a@b.co', '1.1.1.1')).toBe(false);
    limiter.recordFailure('a@b.co', '1.1.1.1');
    expect(limiter.isBlocked('a@b.co', '1.1.1.1')).toBe(true);
    nowMs += lockSeconds(6) * 1000 - 1;
    expect(limiter.isBlocked('a@b.co', '1.1.1.1')).toBe(true);
    expect(lockSeconds(6)).toBe(60);
  });
});

describe('RateLimitGuard Redis keys', () => {
  it('locks via lock:email after 5 failed logins', async () => {
    const redis = memoryRedis();
    const guard = new RateLimitGuard(redis.client);
    for (let i = 0; i < 5; i += 1) {
      await guard.recordFailure('a@b.co', '1.1.1.1');
    }
    expect(redis.values.get('lock:email:a@b.co')).toBe('5');
    expect(redis.ttls.get('lock:email:a@b.co')).toBe(60);
    await expect(guard.isLocked('a@b.co')).resolves.toBe(true);
  });

  it('expires lock:email on every INCR including failures before lock', async () => {
    const redis = memoryRedis();
    const guard = new RateLimitGuard(redis.client);
    await guard.recordFailure('a@b.co', '1.1.1.1');
    expect(redis.values.get('lock:email:a@b.co')).toBe('1');
    expect(redis.ttls.get('lock:email:a@b.co')).toBe(60);
  });

  it('expires rl:ip and rl:email only when the key is first created', async () => {
    const redis = memoryRedis();
    const guard = new RateLimitGuard(redis.client);
    await expect(
      guard.canActivate(loginContext('a@b.co', '1.1.1.1')),
    ).resolves.toBe(true);
    expect(redis.ttls.get('rl:ip:1.1.1.1')).toBe(60);
    expect(redis.ttls.get('rl:email:a@b.co')).toBe(60);
    expect(redis.expireCalls.get('rl:ip:1.1.1.1')).toBe(1);
    expect(redis.expireCalls.get('rl:email:a@b.co')).toBe(1);

    redis.ttls.set('rl:ip:1.1.1.1', 40);
    redis.ttls.set('rl:email:a@b.co', 40);

    await expect(
      guard.canActivate(loginContext('a@b.co', '1.1.1.1')),
    ).resolves.toBe(true);
    expect(redis.values.get('rl:ip:1.1.1.1')).toBe('2');
    expect(redis.values.get('rl:email:a@b.co')).toBe('2');
    expect(redis.ttls.get('rl:ip:1.1.1.1')).toBe(40);
    expect(redis.ttls.get('rl:email:a@b.co')).toBe(40);
    expect(redis.expireCalls.get('rl:ip:1.1.1.1')).toBe(1);
    expect(redis.expireCalls.get('rl:email:a@b.co')).toBe(1);
  });

  it('keeps n across the 32s lock so the next failure uses 60s backoff', async () => {
    const redis = memoryRedis();
    const guard = new RateLimitGuard(redis.client);
    for (let i = 0; i < 5; i += 1) {
      await guard.recordFailure('a@b.co', '1.1.1.1');
    }
    redis.ttls.set('lock:email:a@b.co', 27);
    await expect(guard.isLocked('a@b.co')).resolves.toBe(false);
    await guard.recordFailure('a@b.co', '1.1.1.1');
    expect(redis.values.get('lock:email:a@b.co')).toBe('6');
    expect(redis.ttls.get('lock:email:a@b.co')).toBe(60);
    await expect(guard.isLocked('a@b.co')).resolves.toBe(true);
  });

  it('records another failure when a locked login is rejected', async () => {
    const redis = memoryRedis();
    const guard = new RateLimitGuard(redis.client);
    for (let i = 0; i < 5; i += 1) {
      await guard.recordFailure('a@b.co', '1.1.1.1');
    }
    const error = await guard
      .canActivate(loginContext('a@b.co', '1.1.1.1'))
      .catch((caught: { getStatus: () => number }) => caught);
    expect(error.getStatus()).toBe(429);
    expect(redis.values.get('lock:email:a@b.co')).toBe('6');
    expect(redis.ttls.get('lock:email:a@b.co')).toBe(60);
  });
});

function memoryRedis() {
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  const expireCalls = new Map<string, number>();
  const client = {
    incr: async (key: string) => {
      const next = Number(values.get(key) ?? 0) + 1;
      values.set(key, String(next));
      return next;
    },
    expire: async (key: string, seconds: number) => {
      ttls.set(key, seconds);
      expireCalls.set(key, (expireCalls.get(key) ?? 0) + 1);
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
  return { client, values, ttls, expireCalls };
}

function loginContext(email: string, ip: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        ip,
        method: 'POST',
        url: '/v1/auth/login',
        originalUrl: '/v1/auth/login',
        body: { email },
      }),
    }),
  } as never;
}
