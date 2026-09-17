import { Module } from '@nestjs/common';
import { NotificationsServiceController } from './notifications-service.controller.js';
import { NotificationsServiceService } from './notifications-service.service.js';

@Module({
  imports: [],
  controllers: [NotificationsServiceController],
  providers: [NotificationsServiceService],
})
export class NotificationsServiceModule {}
