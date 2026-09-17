import { InboxService } from '@app/inbox';
import {
  NOTIFICATIONS_EMAIL_EVENT,
  type SendEmailDto,
} from '@app/notifications';
import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import type { Channel, Message } from 'amqplib';
import { Mailer } from './mailer.js';

@Controller()
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);

  constructor(
    private readonly mailer: Mailer,
    private readonly inbox: InboxService,
  ) {}

  @EventPattern(NOTIFICATIONS_EMAIL_EVENT)
  async onEmail(
    @Payload() dto: SendEmailDto,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const channel = context.getChannelRef() as Channel;
    const originalMessage = context.getMessage() as Message;
    const messageId = originalMessage.properties.messageId as
      string | undefined;

    if (!messageId) {
      this.logger.error(
        'Missing messageId on notifications.email; acking without send',
      );
      channel.ack(originalMessage);
      return;
    }

    this.mailer.send(dto);
    await this.inbox.store({
      messageId,
      type: NOTIFICATIONS_EMAIL_EVENT,
      payload: {
        type: dto.type,
        userId: dto.userId,
        email: dto.email,
      },
    });
    channel.ack(originalMessage);
  }
}
