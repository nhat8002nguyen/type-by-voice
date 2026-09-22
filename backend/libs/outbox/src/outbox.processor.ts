import { Inject, Logger, Optional } from '@nestjs/common';
import { ClientProxy, RmqRecordBuilder } from '@nestjs/microservices';
import { Cron, CronExpression } from '@nestjs/schedule';
import { lastValueFrom } from 'rxjs';
import { Outbox } from './entities/outbox.entity.js';
import {
  OUTBOX_CLIENT,
  OUTBOX_ROUTES,
  OUTBOX_TARGET,
  outboxTargetName,
  type OutboxRoute,
} from './outbox.constants.js';
import { OutboxService } from './outbox.service.js';

export class OutboxProcessor {
  private readonly logger = new Logger(OutboxProcessor.name);

  constructor(
    private readonly outboxService: OutboxService,
    @Inject(OUTBOX_CLIENT)
    private readonly client: ClientProxy,
    @Inject(OUTBOX_TARGET)
    private readonly target: string | symbol,
    @Optional()
    @Inject(OUTBOX_ROUTES)
    private readonly routes?: OutboxRoute[],
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async processOutbox() {
    this.logger.log('Processing outbox messages');

    for (const route of this.resolveRoutes()) {
      const messages = await this.outboxService.getPendingOutboxMessages({
        target: outboxTargetName(route.target),
        take: 100,
      });
      this.logger.log(
        `Found ${messages.length} messages to process for ${outboxTargetName(route.target)}`,
      );

      for (const message of messages) {
        await this.dispatchWorkflowEvent(message);
        this.logger.log(`Marking message ${message.id} as processed`);
        await this.outboxService.markAsProcessed(message.id);
      }
    }
  }

  async dispatchWorkflowEvent(message: Outbox) {
    const messageId = `outbox:${message.id}`;
    this.logger.log(
      `[outbox → rmq] emit ${message.type} messageId=${messageId}`,
    );
    const record = new RmqRecordBuilder(message.payload)
      .setOptions({ messageId })
      .build();
    await lastValueFrom(this.clientFor(message).emit(message.type, record));
  }

  private resolveRoutes(): OutboxRoute[] {
    return this.routes?.length
      ? this.routes
      : [{ target: this.target, client: this.client }];
  }

  private clientFor(message: Outbox): ClientProxy {
    if (!message.target) {
      return this.client;
    }
    const match = this.resolveRoutes().find(
      (route) => outboxTargetName(route.target) === message.target,
    );
    return match?.client ?? this.client;
  }
}
