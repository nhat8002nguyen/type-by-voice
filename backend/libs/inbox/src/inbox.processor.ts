import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource, EntityManager } from 'typeorm';
import {
  INBOX_JOB_NAME,
  INBOX_OPTIONS,
  INBOX_QUEUE,
  INBOX_REPEATABLE_JOB_ID,
} from './inbox.constants.js';
import { InboxService } from './inbox.service.js';
import type { InboxModuleOptions } from './inbox.types.js';

@Injectable()
@Processor(INBOX_QUEUE)
export class InboxProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(InboxProcessor.name);

  constructor(
    private readonly inboxService: InboxService,
    private readonly dataSource: DataSource,
    @Inject(INBOX_OPTIONS) private readonly options: InboxModuleOptions,
    @InjectQueue(INBOX_QUEUE) private readonly inboxQueue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.inboxQueue.upsertJobScheduler(
      INBOX_REPEATABLE_JOB_ID,
      { every: this.options.repeatEveryMs },
      { name: INBOX_JOB_NAME, data: {} },
    );
  }

  async process(): Promise<void> {
    await this.processPending();
  }

  async processPending(): Promise<void> {
    for (let i = 0; i < this.options.take; i++) {
      let claimedId: number | undefined;
      try {
        const hasRow = await this.dataSource.transaction(async (manager) => {
          const rows = await this.inboxService.claimPending({
            take: 1,
            maxAttempts: this.options.maxAttempts,
            manager,
          });
          const row = rows[0];
          if (!row) {
            return false;
          }
          claimedId = row.id;
          this.logger.log(
            `[inbox] claimed id=${row.id} messageId=${row.messageId} type=${row.type}`,
          );
          const handler = this.options.handlers[row.type];
          if (!handler) {
            this.logger.warn(
              `[inbox] no handler for type=${row.type} id=${row.id}; marking failed`,
            );
            await this.inboxService.markFailed(
              row.id,
              `no handler for ${row.type}`,
              manager,
            );
            return true;
          }
          await handler(row.payload, manager);
          await this.inboxService.markProcessed(row.id, manager);
          this.logger.log(
            `[inbox] processed id=${row.id} messageId=${row.messageId} type=${row.type}`,
          );
          return true;
        });
        if (!hasRow) {
          break;
        }
      } catch (error) {
        if (claimedId === undefined) {
          throw error;
        }
        const failedId = claimedId;
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `[inbox] handler failed id=${failedId}: ${reason}; recording attempt`,
        );
        await this.dataSource.transaction(async (manager: EntityManager) => {
          await this.inboxService.recordFailure(
            failedId,
            error,
            { maxAttempts: this.options.maxAttempts },
            manager,
          );
        });
      }
    }
  }
}
