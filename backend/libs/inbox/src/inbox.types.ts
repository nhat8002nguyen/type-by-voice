import { FactoryProvider, ModuleMetadata } from '@nestjs/common';
import { EntityManager } from 'typeorm';

export type InboxHandler = (
  payload: unknown,
  em: EntityManager,
) => Promise<void>;

export interface InboxModuleOptions {
  redis: { host: string; port: number };
  repeatEveryMs: number;
  take: number;
  maxAttempts: number;
  handlers: Record<string, InboxHandler>;
}

export interface InboxModuleAsyncOptions {
  imports?: ModuleMetadata['imports'];
  inject?: FactoryProvider['inject'];
  useFactory: (
    ...args: any[]
  ) => InboxModuleOptions | Promise<InboxModuleOptions>;
}
