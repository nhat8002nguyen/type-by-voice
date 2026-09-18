import { NOTIFICATIONS_SERVICE } from '@app/notifications';
import { OutboxModule } from '@app/outbox';
import { WORKFLOWS_SERVICE } from '@app/workflows';
import { isObserveEnabled, RmqClientModule } from '@app/tracing';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { DictateModule } from './dictate/dictate.module.js';
import { HealthModule } from './health/health.module.js';
import { TranscriptsModule } from './transcripts/transcripts.module.js';
import { UsersModule } from './users/users.module.js';

const WORKFLOWS_RMQ_CLIENT = Symbol('WORKFLOWS_RMQ_CLIENT');

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ...(isObserveEnabled()
      ? [
          ObserveModule.forRoot({
            appKey: process.env.OBSERVE_APP_KEY ?? '',
            appSecret: process.env.OBSERVE_APP_SECRET ?? '',
            serviceId: 'api',
          }),
        ]
      : []),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.POSTGRES_HOST ?? 'api-db',
      port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
      username: process.env.POSTGRES_USER ?? 'postgres',
      password: process.env.POSTGRES_PASSWORD ?? 'postgres',
      database: process.env.POSTGRES_DB ?? 'api',
      autoLoadEntities: true,
      synchronize: process.env.NODE_ENV === 'development',
    }),
    HealthModule,
    AuthModule,
    UsersModule,
    TranscriptsModule,
    DictateModule,
    RmqClientModule.register([
      { name: NOTIFICATIONS_SERVICE, queue: 'notifications-service' },
      { name: WORKFLOWS_RMQ_CLIENT, queue: 'workflows-service' },
    ]),
    OutboxModule.register({
      targets: [
        {
          target: NOTIFICATIONS_SERVICE,
          clientToken: NOTIFICATIONS_SERVICE,
        },
        { target: WORKFLOWS_SERVICE, clientToken: WORKFLOWS_RMQ_CLIENT },
      ],
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
