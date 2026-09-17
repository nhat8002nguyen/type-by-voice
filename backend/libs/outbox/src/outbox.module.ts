import { DynamicModule, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClientProxy } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Outbox } from './entities/outbox.entity.js';
import {
  OUTBOX_CLIENT,
  OUTBOX_TARGET,
  type OutboxRegisterOptions,
} from './outbox.constants.js';
import { OutboxProcessor } from './outbox.processor.js';
import { OutboxService } from './outbox.service.js';

@Module({})
export class OutboxModule {
  static register(options: OutboxRegisterOptions): DynamicModule {
    return {
      module: OutboxModule,
      imports: [
        ScheduleModule.forRoot(),
        TypeOrmModule.forFeature([Outbox]),
      ],
      providers: [
        OutboxService,
        { provide: OUTBOX_TARGET, useValue: options.target },
        {
          provide: OUTBOX_CLIENT,
          inject: [ModuleRef],
          useFactory: (moduleRef: ModuleRef) =>
            moduleRef.get<ClientProxy>(options.clientToken, { strict: false }),
        },
        OutboxProcessor,
      ],
      exports: [OutboxService, OutboxProcessor],
    };
  }
}

export type OutboxModuleRegister = typeof OutboxModule.register;
