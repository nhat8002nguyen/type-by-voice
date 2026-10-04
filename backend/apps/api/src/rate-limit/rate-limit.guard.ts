import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  OnModuleDestroy,
} from '@nestjs/common';
import { Redis } from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

const WINDOW_SEC = 60;
const IP_LIMIT_PER_MIN = 10;
const EMAIL_LIMIT_PER_MIN = 5;
const FAILURES_TO_LOCK = 5;
const DICTATE_IP_LIMIT_PER_MIN = 60;

/** lockSeconds computes the exponential lock duration in seconds capped at 60. */
export function lockSeconds(consecutiveFailures: number): number {
  return Math.min(60, 2 ** consecutiveFailures);
}

/** ipKey builds the Redis/memory key for per-IP auth rate limiting. */
export function ipKey(ip: string): string {
  return `rl:ip:${ip}`;
}

/** emailKey builds the Redis/memory key for per-email login rate limiting. */
export function emailKey(email: string): string {
  return `rl:email:${email}`;
}

/** lockKey builds the Redis/memory key for temporary email login locks. */
export function lockKey(email: string): string {
  return `lock:email:${email}`;
}

type Clock = { nowMs: () => number };

type HitWindow = { times: number[] };

/** prune drops hit timestamps older than the fixed rate-limit window. */
function prune(window: HitWindow, nowMs: number): number[] {
  const cutoff = nowMs - WINDOW_SEC * 1000;
  window.times = window.times.filter((time) => time > cutoff);
  return window.times;
}

/**
 * In-memory auth limiter used by unit tests.
 * Production multi-replica sharing uses Redis INCR + EXPIRE NX on
 * `rl:ip:{ip}` and `rl:email:{email}` (fixed 60s window from first hit),
 * and INCR+EXPIRE on every `lock:email:{email}` failure.
 */
export class AuthLimiter {
  readonly #nowMs: () => number;
  readonly #ipHits = new Map<string, HitWindow>();
  readonly #emailHits = new Map<string, HitWindow>();
  readonly #dictateHits = new Map<string, HitWindow>();
  readonly #failures = new Map<string, number>();
  readonly #lockUntil = new Map<string, number>();

  constructor(options?: Clock) {
    this.#nowMs = options?.nowMs ?? (() => Date.now());
  }

  /** recordFailure increments consecutive login failures and may lock the email. */
  recordFailure(email: string, _ip: string): void {
    const n = (this.#failures.get(email) ?? 0) + 1;
    this.#failures.set(email, n);
    if (n >= FAILURES_TO_LOCK) {
      this.#lockUntil.set(email, this.#nowMs() + lockSeconds(n) * 1000);
    }
  }

  /** recordSuccess clears failure and lock state after a successful login. */
  recordSuccess(email: string): void {
    this.#failures.delete(email);
    this.#lockUntil.delete(email);
  }

  /** isLocked reports whether the email is currently under a temporary login lock. */
  isLocked(email: string): boolean {
    return (this.#lockUntil.get(email) ?? 0) > this.#nowMs();
  }

  /** isBlocked reports whether the email or IP has already exhausted auth rate limits. */
  isBlocked(email: string, ip: string): boolean {
    if (this.isLocked(email)) {
      return true;
    }
    return (
      this.#count(this.#ipHits, ip) >= IP_LIMIT_PER_MIN ||
      this.#count(this.#emailHits, email) >= EMAIL_LIMIT_PER_MIN
    );
  }

  /** consumeIp records one IP auth attempt and returns false when the IP limit is exceeded. */
  consumeIp(ip: string): boolean {
    return this.#hit(this.#ipHits, ip, IP_LIMIT_PER_MIN);
  }

  /** consumeLoginEmail records one email login attempt and returns false when the email limit is exceeded. */
  consumeLoginEmail(email: string): boolean {
    return this.#hit(this.#emailHits, email, EMAIL_LIMIT_PER_MIN);
  }

  /** allowDictateUpgrade admits a dictate WebSocket upgrade under the per-IP dictate rate limit. */
  allowDictateUpgrade(ip: string): boolean {
    return this.#hit(this.#dictateHits, ip, DICTATE_IP_LIMIT_PER_MIN);
  }

  /** #count returns how many hits remain in the current window for a key. */
  #count(store: Map<string, HitWindow>, key: string): number {
    const window = store.get(key);
    if (!window) {
      return 0;
    }
    return prune(window, this.#nowMs()).length;
  }

  /** #hit records a hit and returns false when the key would exceed its limit. */
  #hit(store: Map<string, HitWindow>, key: string, limit: number): boolean {
    const window = store.get(key) ?? { times: [] };
    const times = prune(window, this.#nowMs());
    if (times.length >= limit) {
      store.set(key, window);
      return false;
    }
    times.push(this.#nowMs());
    store.set(key, window);
    return true;
  }
}

type RedisLike = Pick<Redis, 'incr' | 'get' | 'del' | 'ttl'> & {
  /** expire sets a Redis key TTL when the key has no expiry yet. */
  expire(key: string, seconds: number, mode?: 'NX'): Promise<unknown>;
};

@Injectable()
export class RateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly memory: AuthLimiter;

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: RedisLike,
    @Optional() memory?: AuthLimiter,
  ) {
    this.memory = memory ?? new AuthLimiter();
  }

  /** onModuleDestroy closes the optional Redis client when the module shuts down. */
  async onModuleDestroy(): Promise<void> {
    const redis = this.redis as Redis | undefined;
    if (redis && typeof redis.quit === 'function') {
      await redis.quit().catch(() => redis.disconnect());
    }
  }

  /** canActivate enforces auth HTTP rate limits (IP, email, lock) before the route handler runs. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      ip?: string;
      socket?: { remoteAddress?: string };
      url?: string;
      originalUrl?: string;
      method?: string;
      body?: { email?: string };
    }>();
    const ip = clientIp(request);
    const email =
      typeof request.body?.email === 'string' ? request.body.email : undefined;
    const login = isLoginRequest(request);

    if (login && email && (await this.isLocked(email))) {
      await this.recordFailure(email, ip);
      throw tooManyRequests();
    }
    if (!(await this.consumeIp(ip))) {
      throw tooManyRequests();
    }
    if (login && email && !(await this.consumeLoginEmail(email))) {
      throw tooManyRequests();
    }
    return true;
  }

  /** recordFailure increments consecutive login failures and may lock the email. */
  async recordFailure(email: string, ip: string): Promise<void> {
    if (!this.redis) {
      this.memory.recordFailure(email, ip);
      return;
    }
    await this.redis.incr(lockKey(email));
    await this.redis.expire(lockKey(email), WINDOW_SEC);
  }

  /** recordSuccess clears failure and lock state after a successful login. */
  async recordSuccess(email: string): Promise<void> {
    if (!this.redis) {
      this.memory.recordSuccess(email);
      return;
    }
    await this.redis.del(lockKey(email));
  }

  /** isLocked reports whether the email is currently under a temporary login lock. */
  async isLocked(email: string): Promise<boolean> {
    if (!this.redis) {
      return this.memory.isLocked(email);
    }
    const n = Number((await this.redis.get(lockKey(email))) ?? 0);
    if (n < FAILURES_TO_LOCK) {
      return false;
    }
    const ttl = await this.redis.ttl(lockKey(email));
    if (ttl === -1) {
      return true;
    }
    if (ttl <= 0) {
      return false;
    }
    return WINDOW_SEC - ttl < lockSeconds(n);
  }

  /** allowDictateUpgrade admits a dictate WebSocket upgrade under the per-IP dictate rate limit. */
  allowDictateUpgrade(ip: string): boolean {
    return this.memory.allowDictateUpgrade(ip);
  }

  /** consumeIp records one IP auth attempt and returns false when the IP limit is exceeded. */
  private async consumeIp(ip: string): Promise<boolean> {
    if (!this.redis) {
      return this.memory.consumeIp(ip);
    }
    return incrExpire(this.redis, ipKey(ip), IP_LIMIT_PER_MIN);
  }

  /** consumeLoginEmail records one email login attempt and returns false when the email limit is exceeded. */
  private async consumeLoginEmail(email: string): Promise<boolean> {
    if (!this.redis) {
      return this.memory.consumeLoginEmail(email);
    }
    return incrExpire(this.redis, emailKey(email), EMAIL_LIMIT_PER_MIN);
  }
}

/** incrExpire increments a Redis counter and sets a window TTL on first hit. */
async function incrExpire(
  redis: RedisLike,
  key: string,
  limit: number,
): Promise<boolean> {
  const n = await redis.incr(key);
  await redis.expire(key, WINDOW_SEC, 'NX');
  return n <= limit;
}

/** tooManyRequests builds the HTTP 429 response used by the rate-limit guard. */
function tooManyRequests(): HttpException {
  return new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
}

/**
 * clientIp resolves the caller's address from an Express request or a raw WebSocket
 * upgrade request.
 *
 * nginx overwrites X-Real-IP with the address it validated, honouring Cloudflare's
 * CF-Connecting-IP only when the peer is a Cloudflare edge (see deploy/nginx), so
 * the header is authoritative whether or not the DNS record is proxied. The later
 * branches cover requests that never reached nginx, such as unit tests.
 */
export function clientIp(request: {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  return (
    firstHeaderValue(request.headers?.['x-real-ip']) ||
    request.ip ||
    request.socket?.remoteAddress ||
    'unknown'
  );
}

/** firstHeaderValue returns the trimmed first value of a possibly repeated header. */
function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || undefined;
}

/** isLoginRequest reports whether the request targets the login route for email limiting. */
function isLoginRequest(request: {
  url?: string;
  originalUrl?: string;
  method?: string;
}): boolean {
  const path = request.originalUrl ?? request.url ?? '';
  return request.method === 'POST' && path.includes('/login');
}

/** createRedisClient constructs the shared Redis client used by RateLimitGuard in production. */
export function createRedisClient(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? 'redis',
    port: Number.parseInt(process.env.REDIS_PORT ?? '6379', 10),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
}
