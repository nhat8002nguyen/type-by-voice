import { DynamicModule, Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { INBOX_OPTIONS, INBOX_QUEUE } from './inbox.constants.js';
import { Inbox } from './entities/inbox.entity.js';
import { InboxProcessor } from './inbox.processor.js';
import { InboxService } from './inbox.service.js';
import { InboxModuleAsyncOptions, InboxModuleOptions } from './inbox.types.js';

@Global()
@Module({})
export class InboxModule {
  /** registerAsync wires Nest module providers for the inbox feature with async options. */
  static registerAsync(options: InboxModuleAsyncOptions): DynamicModule {
    const optionsProvider = {
      provide: INBOX_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };

    return {
      module: InboxModule,
      global: true,
      imports: [
        ...(options.imports ?? []),
        TypeOrmModule.forFeature([Inbox]),
        BullModule.forRootAsync({
          imports: options.imports,
          inject: options.inject,
          useFactory: async (...args: any[]) => {
            const inboxOptions = await options.useFactory(...args);
            return {
              connection: {
                host: inboxOptions.redis.host,
                port: inboxOptions.redis.port,
              },
            };
          },
        }),
        BullModule.registerQueue({ name: INBOX_QUEUE }),
      ],
      providers: [optionsProvider, InboxService, InboxProcessor],
      exports: [InboxService],
    };
  }
}

export type { InboxModuleOptions };
