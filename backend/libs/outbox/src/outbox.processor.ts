import { Inject, Logger } from '@nestjs/common';
import { ClientProxy, RmqRecordBuilder } from '@nestjs/microservices';
import { Cron, CronExpression } from '@nestjs/schedule';
import { lastValueFrom } from 'rxjs';
import { Outbox } from './entities/outbox.entity.js';
import { OUTBOX_CLIENT, OUTBOX_TARGET, outboxTargetName } from './outbox.constants.js';
import { OutboxService } from './outbox.service.js';

export class OutboxProcessor {
  private readonly logger = new Logger(OutboxProcessor.name);

  constructor(
    private readonly outboxService: OutboxService,
    @Inject(OUTBOX_CLIENT)
    private readonly client: ClientProxy,
    @Inject(OUTBOX_TARGET)
    private readonly target: string | symbol,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async processOutbox() {
    this.logger.log('Processing outbox messages');

    const messages = await this.outboxService.getPendingOutboxMessages({
      target: outboxTargetName(this.target),
      take: 100,
    });
    this.logger.log(`Found ${messages.length} messages to process`);

    for (const message of messages) {
      await this.dispatchWorkflowEvent(message);
      this.logger.log(`Marking message ${message.id} as processed`);
      await this.outboxService.markAsProcessed(message.id);
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
    await lastValueFrom(this.client.emit(message.type, record));
  }
}
