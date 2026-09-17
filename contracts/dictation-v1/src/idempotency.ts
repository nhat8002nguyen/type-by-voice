import { SESSION_LIMITS } from './constants.js';
import type { ErrorMessage, FinalMessage } from './types.js';

type Outcome = FinalMessage | ErrorMessage;

interface CacheEntry {
  expiresAtMs: number;
  outcome: Outcome;
}

export class IdempotencyCache {
  private readonly nowMs: () => number;
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(options: { nowMs: () => number; ttlMs?: number }) {
    this.nowMs = options.nowMs;
    this.ttlMs = options.ttlMs ?? SESSION_LIMITS.idempotencyTtlMs;
  }

  remember(requestId: string, outcome: Outcome): void {
    const now = this.nowMs();
    const existing = this.entries.get(requestId);
    if (existing !== undefined && existing.expiresAtMs > now) {
      return;
    }
    this.entries.set(requestId, {
      expiresAtMs: now + this.ttlMs,
      outcome,
    });
  }

  lookup(requestId: string): Outcome | undefined {
    const entry = this.entries.get(requestId);
    if (entry === undefined) {
      return undefined;
    }
    const now = this.nowMs();
    if (entry.expiresAtMs <= now) {
      this.entries.delete(requestId);
      return undefined;
    }
    return entry.outcome;
  }
}
