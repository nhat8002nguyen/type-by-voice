import { DynamicModule, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClientProxy } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { underlyingClientToken } from '@app/tracing';
import { Outbox } from './entities/outbox.entity.js';
import {
  OUTBOX_CLIENT,
  OUTBOX_ROUTES,
  OUTBOX_TARGET,
  normalizeOutboxRegisterOptions,
  type OutboxModuleRegisterOptions,
  type OutboxRoute,
} from './outbox.constants.js';
import { OutboxProcessor } from './outbox.processor.js';
import { OutboxService } from './outbox.service.js';

@Module({})
export class OutboxModule {
  static forFeature(): DynamicModule {
    return {
      module: OutboxModule,
      imports: [TypeOrmModule.forFeature([Outbox])],
      providers: [OutboxService],
      exports: [OutboxService],
    };
  }

  /** OutboxModule.register({ target, clientToken }) injects that RMQ client. */
  static register(options: OutboxModuleRegisterOptions): DynamicModule {
    const entries = normalizeOutboxRegisterOptions(options);
    const primary = entries[0];
    if (!primary) {
      throw new Error('OutboxModule.register requires at least one target');
    }

    @Module({})
    class RegisteredOutboxModule {}

    return {
      module: RegisteredOutboxModule,
      imports: [ScheduleModule.forRoot(), TypeOrmModule.forFeature([Outbox])],
      providers: [
        OutboxService,
        { provide: OUTBOX_TARGET, useValue: primary.target },
        {
          provide: OUTBOX_CLIENT,
          inject: [ModuleRef],
          useFactory: (moduleRef: ModuleRef) =>
            resolveClient(moduleRef, primary.clientToken),
        },
        {
          provide: OUTBOX_ROUTES,
          inject: [ModuleRef],
          useFactory: (moduleRef: ModuleRef): OutboxRoute[] =>
            entries.map((entry) => ({
              target: entry.target,
              client: resolveClient(moduleRef, entry.clientToken),
            })),
        },
        OutboxProcessor,
      ],
      exports: [OutboxService, OutboxProcessor],
    };
  }
}

function resolveClient(
  moduleRef: ModuleRef,
  clientToken: string | symbol,
): ClientProxy {
  return moduleRef.get<ClientProxy>(underlyingClientToken(clientToken), {
    strict: false,
  });
}
