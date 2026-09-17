import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
  OnModuleDestroy,
  TooManyRequestsException,
} from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

const WINDOW_SEC = 60;
const IP_LIMIT_PER_MIN = 10;
const EMAIL_LIMIT_PER_MIN = 5;
const FAILURES_TO_LOCK = 5;
const DICTATE_IP_LIMIT_PER_MIN = 60;

export function lockSeconds(consecutiveFailures: number): number {
  return Math.min(60, 2 ** consecutiveFailures);
}

export function ipKey(ip: string): string {
  return `rl:ip:${ip}`;
}

export function emailKey(email: string): string {
  return `rl:email:${email}`;
}

export function lockKey(email: string): string {
  return `lock:email:${email}`;
}

type Clock = { nowMs: () => number };

type HitWindow = { times: number[] };

function prune(window: HitWindow, nowMs: number): number[] {
  const cutoff = nowMs - WINDOW_SEC * 1000;
  window.times = window.times.filter((time) => time > cutoff);
  return window.times;
}

/**
 * In-memory auth limiter used by unit tests.
 * Production multi-replica sharing uses Redis INCR+EXPIRE on
 * `rl:ip:{ip}`, `rl:email:{email}`, and `lock:email:{email}`.
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

  recordFailure(email: string, _ip: string): void {
    const n = (this.#failures.get(email) ?? 0) + 1;
    this.#failures.set(email, n);
    if (n >= FAILURES_TO_LOCK) {
      this.#lockUntil.set(email, this.#nowMs() + lockSeconds(n) * 1000);
    }
  }

  recordSuccess(email: string): void {
    this.#failures.delete(email);
    this.#lockUntil.delete(email);
  }

  isBlocked(email: string, ip: string): boolean {
    if ((this.#lockUntil.get(email) ?? 0) > this.#nowMs()) {
      return true;
    }
    return (
      this.#count(this.#ipHits, ip) >= IP_LIMIT_PER_MIN ||
      this.#count(this.#emailHits, email) >= EMAIL_LIMIT_PER_MIN
    );
  }

  consumeIp(ip: string): boolean {
    return this.#hit(this.#ipHits, ip, IP_LIMIT_PER_MIN);
  }

  consumeLoginEmail(email: string): boolean {
    return this.#hit(this.#emailHits, email, EMAIL_LIMIT_PER_MIN);
  }

  allowDictateUpgrade(ip: string): boolean {
    return this.#hit(this.#dictateHits, ip, DICTATE_IP_LIMIT_PER_MIN);
  }

  #count(store: Map<string, HitWindow>, key: string): number {
    const window = store.get(key);
    if (!window) {
      return 0;
    }
    return prune(window, this.#nowMs()).length;
  }

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

type RedisLike = Pick<Redis, 'incr' | 'expire' | 'get' | 'del' | 'ttl'>;

@Injectable()
export class RateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly memory: AuthLimiter;

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: RedisLike,
    @Optional() memory?: AuthLimiter,
  ) {
    this.memory = memory ?? new AuthLimiter();
  }

  async onModuleDestroy(): Promise<void> {
    const redis = this.redis as Redis | undefined;
    if (redis && typeof redis.quit === 'function') {
      await redis.quit().catch(() => redis.disconnect());
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
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
      throw new TooManyRequestsException();
    }
    if (!(await this.consumeIp(ip))) {
      throw new TooManyRequestsException();
    }
    if (login && email && !(await this.consumeLoginEmail(email))) {
      throw new TooManyRequestsException();
    }
    return true;
  }

  async recordFailure(email: string, ip: string): Promise<void> {
    if (!this.redis) {
      this.memory.recordFailure(email, ip);
      return;
    }
    const n = await this.redis.incr(lockKey(email));
    if (n >= FAILURES_TO_LOCK) {
      await this.redis.expire(lockKey(email), lockSeconds(n));
    }
  }

  async recordSuccess(email: string): Promise<void> {
    if (!this.redis) {
      this.memory.recordSuccess(email);
      return;
    }
    await this.redis.del(lockKey(email));
  }

  async isLocked(email: string): Promise<boolean> {
    if (!this.redis) {
      return this.memory.isBlocked(email, '');
    }
    const n = Number((await this.redis.get(lockKey(email))) ?? 0);
    if (n < FAILURES_TO_LOCK) {
      return false;
    }
    const ttl = await this.redis.ttl(lockKey(email));
    return ttl > 0 || ttl === -1;
  }

  allowDictateUpgrade(ip: string): boolean {
    return this.memory.allowDictateUpgrade(ip);
  }

  private async consumeIp(ip: string): Promise<boolean> {
    if (!this.redis) {
      return this.memory.consumeIp(ip);
    }
    return incrExpire(this.redis, ipKey(ip), IP_LIMIT_PER_MIN);
  }

  private async consumeLoginEmail(email: string): Promise<boolean> {
    if (!this.redis) {
      return this.memory.consumeLoginEmail(email);
    }
    return incrExpire(this.redis, emailKey(email), EMAIL_LIMIT_PER_MIN);
  }
}

async function incrExpire(
  redis: RedisLike,
  key: string,
  limit: number,
): Promise<boolean> {
  const n = await redis.incr(key);
  if (n === 1) {
    await redis.expire(key, WINDOW_SEC);
  }
  return n <= limit;
}

export function clientIp(request: {
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  return request.ip || request.socket?.remoteAddress || 'unknown';
}

function isLoginRequest(request: {
  url?: string;
  originalUrl?: string;
  method?: string;
}): boolean {
  const path = request.originalUrl ?? request.url ?? '';
  return request.method === 'POST' && path.includes('/login');
}

export function createRedisClient(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? 'redis',
    port: Number.parseInt(process.env.REDIS_PORT ?? '6379', 10),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
}
