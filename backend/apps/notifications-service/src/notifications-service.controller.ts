import { Controller, Get } from '@nestjs/common';
import { NotificationsServiceService } from './notifications-service.service.js';

@Controller()
export class NotificationsServiceController {
  constructor(private readonly notificationsServiceService: NotificationsServiceService) {}

  @Get()
  /** getHello returns the scaffold hello string for notifications-service. */
  getHello(): string {
    return this.notificationsServiceService.getHello();
  }
}
