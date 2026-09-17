import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { NotificationsServiceController } from './notifications-service.controller.js';
import { NotificationsServiceService } from './notifications-service.service.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? '',
      appSecret: process.env.OBSERVE_APP_SECRET ?? '',
      serviceId: 'notifications-service',
    }),
  ],
  controllers: [NotificationsServiceController],
  providers: [NotificationsServiceService],
})
export class NotificationsServiceModule {}
