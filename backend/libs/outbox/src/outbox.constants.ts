export const OUTBOX_CLIENT = Symbol('OUTBOX_CLIENT');
export const OUTBOX_TARGET = Symbol('OUTBOX_TARGET');

export interface OutboxRegisterOptions {
  target: string | symbol;
  clientToken: string | symbol;
}

export function outboxTargetName(target: string | symbol): string {
  return typeof target === 'symbol' ? (target.description ?? String(target)) : target;
}
