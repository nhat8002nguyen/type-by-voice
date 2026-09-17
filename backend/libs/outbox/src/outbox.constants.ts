import type { ClientProxy } from '@nestjs/microservices';

export const OUTBOX_CLIENT = Symbol('OUTBOX_CLIENT');
export const OUTBOX_TARGET = Symbol('OUTBOX_TARGET');
export const OUTBOX_ROUTES = Symbol('OUTBOX_ROUTES');

export interface OutboxRegisterOptions {
  target: string | symbol;
  clientToken: string | symbol;
}

export type OutboxModuleRegisterOptions =
  OutboxRegisterOptions | { targets: OutboxRegisterOptions[] };

export type OutboxRoute = {
  target: string | symbol;
  client: ClientProxy;
};

export function outboxTargetName(target: string | symbol): string {
  return typeof target === 'symbol'
    ? (target.description ?? String(target))
    : target;
}

export function normalizeOutboxRegisterOptions(
  options: OutboxModuleRegisterOptions,
): OutboxRegisterOptions[] {
  return 'targets' in options ? options.targets : [options];
}
