import { Injectable } from '@nestjs/common';
import { SESSION_LIMITS } from '@type-by-voice/dictation-v1';

@Injectable()
export class SessionRegistry {
  readonly #byUser = new Map<string, Set<string>>();

  count(userId: string): number {
    return this.#byUser.get(userId)?.size ?? 0;
  }

  tryAdd(userId: string, sessionKey: string): boolean {
    const current = this.#byUser.get(userId) ?? new Set<string>();
    if (current.has(sessionKey)) {
      return true;
    }
    if (current.size >= SESSION_LIMITS.maxConcurrentSessions) {
      return false;
    }
    current.add(sessionKey);
    this.#byUser.set(userId, current);
    return true;
  }

  remove(userId: string, sessionKey: string): void {
    const current = this.#byUser.get(userId);
    if (!current) {
      return;
    }
    current.delete(sessionKey);
    if (current.size === 0) {
      this.#byUser.delete(userId);
    }
  }
}
