import { Injectable } from '@nestjs/common';

@Injectable()
export class NotificationsServiceService {
  /** getHello returns the scaffold hello payload for notifications-service. */
  getHello(): string {
    return 'Hello World!';
  }
}
