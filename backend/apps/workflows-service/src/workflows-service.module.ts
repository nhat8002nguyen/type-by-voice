import { InboxModule } from '@app/inbox';
import { isObserveEnabled } from '@app/tracing';
import { WORKFLOWS_CREATE_EVENT } from '@app/workflows';
import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { Transcript } from './transcripts/transcript.entity.js';
import { TranscriptsController } from './transcripts/transcripts.controller.js';
import { TranscriptsService } from './transcripts/transcripts.service.js';
import { WorkflowsServiceController } from './workflows-service.controller.js';
import { WorkflowsServiceService } from './workflows-service.service.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [TypeOrmModule.forFeature([Transcript])],
  providers: [
    {
      provide: TranscriptsService,
      inject: [getRepositoryToken(Transcript)],
      useFactory: (repository: Repository<Transcript>) =>
        TranscriptsService.fromEnv(repository),
    },
  ],
  exports: [TranscriptsService],
})
class TranscriptsCoreModule {}

@Module({
  imports: [
    ...(isObserveEnabled()
      ? [
          ObserveModule.forRoot({
            appKey: process.env.OBSERVE_APP_KEY ?? '',
            appSecret: process.env.OBSERVE_APP_SECRET ?? '',
            serviceId: 'workflows-service',
          }),
        ]
      : []),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.POSTGRES_HOST ?? 'workflows-db',
      port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
      username: process.env.POSTGRES_USER ?? 'postgres',
      password: process.env.POSTGRES_PASSWORD ?? 'postgres',
      database: process.env.POSTGRES_DB ?? 'workflows',
      autoLoadEntities: true,
      synchronize: process.env.NODE_ENV === 'development',
    }),
    TranscriptsCoreModule,
    InboxModule.registerAsync({
      imports: [TranscriptsCoreModule],
      inject: [TranscriptsService],
      useFactory: (transcriptsService: TranscriptsService) => ({
        redis: {
          host: process.env.REDIS_HOST ?? 'redis',
          port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
        },
        repeatEveryMs: 10_000,
        take: 100,
        maxAttempts: 3,
        handlers: {
          [WORKFLOWS_CREATE_EVENT]: (payload, em) =>
            transcriptsService.handleInboxCreate(payload, em),
        },
      }),
    }),
  ],
  controllers: [WorkflowsServiceController, TranscriptsController],
  providers: [WorkflowsServiceService],
})
export class WorkflowsServiceModule {}
