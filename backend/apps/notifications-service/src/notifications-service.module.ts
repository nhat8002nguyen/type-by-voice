import { Inbox, InboxService } from '@app/inbox';
import { isObserveEnabled } from '@app/tracing';
import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Mailer } from './mailer.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsServiceController } from './notifications-service.controller.js';
import { NotificationsServiceService } from './notifications-service.service.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ...(isObserveEnabled()
      ? [
          ObserveModule.forRoot({
            appKey: process.env.OBSERVE_APP_KEY ?? '',
            appSecret: process.env.OBSERVE_APP_SECRET ?? '',
            serviceId: 'notifications-service',
          }),
        ]
      : []),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.POSTGRES_HOST ?? 'notifications-db',
      port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
      username: process.env.POSTGRES_USER ?? 'postgres',
      password: process.env.POSTGRES_PASSWORD ?? 'postgres',
      database: process.env.POSTGRES_DB ?? 'notifications',
      autoLoadEntities: true,
      synchronize: process.env.NODE_ENV === 'development',
    }),
    TypeOrmModule.forFeature([Inbox]),
  ],
  controllers: [NotificationsServiceController, NotificationsController],
  providers: [NotificationsServiceService, Mailer, InboxService],
})
export class NotificationsServiceModule {}
