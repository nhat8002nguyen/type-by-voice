import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { Inbox } from './entities/inbox.entity.js';

/** isUniqueViolation reports whether a DB error is a unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError = error.driverError as { code?: string };
  return driverError.code === '23505';
}

@Injectable()
export class InboxService {
  constructor(
    @InjectRepository(Inbox)
    private readonly inboxRepository: Repository<Inbox>,
  ) {}

  /** store inserts an inbox row for an incoming message id. */
  async store(input: {
    messageId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<Inbox> {
    try {
      const row = this.inboxRepository.create({
        messageId: input.messageId,
        type: input.type,
        payload: input.payload,
      });
      return await this.inboxRepository.save(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.inboxRepository.findOneBy({
          messageId: input.messageId,
        });
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  /** storeIfNew inserts only when the message id is new (idempotent intake). */
  async storeIfNew(input: {
    messageId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<boolean> {
    try {
      const row = this.inboxRepository.create({
        messageId: input.messageId,
        type: input.type,
        payload: input.payload,
      });
      await this.inboxRepository.save(row);
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return false;
      }
      throw error;
    }
  }

  /** exists reports whether message id was already seen. */
  async exists(messageId: string): Promise<boolean> {
    const row = await this.inboxRepository.findOneBy({ messageId });
    return row != null;
  }

  /** claimPending claims a batch of unprocessed inbox rows for the worker. */
  async claimPending(options: {
    take: number;
    maxAttempts: number;
    manager: EntityManager;
  }): Promise<Inbox[]> {
    return options.manager
      .createQueryBuilder(Inbox, 'inbox')
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .where('inbox.status = :status', { status: 'pending' })
      .andWhere('inbox.attempts < :maxAttempts', {
        maxAttempts: options.maxAttempts,
      })
      .orderBy('inbox.createdAt', 'ASC')
      .take(options.take)
      .getMany();
  }

  /** markProcessed marks a row successfully handled. */
  async markProcessed(id: number, manager: EntityManager): Promise<void> {
    const repository = manager.getRepository(Inbox);
    const row = await repository.findOneByOrFail({ id });
    row.status = 'processed';
    await repository.save(row);
  }

  /** recordFailure records processing failure state for retry/dead-letter behavior. */
  async recordFailure(
    id: number,
    error: unknown,
    options: { maxAttempts: number },
    manager: EntityManager,
  ): Promise<void> {
    const repository = manager.getRepository(Inbox);
    const row = await repository.findOneByOrFail({ id });
    row.attempts += 1;
    row.lastError = error instanceof Error ? error.message : String(error);
    if (row.attempts >= options.maxAttempts) {
      row.status = 'failed';
    }
    await repository.save(row);
  }

  /** markFailed marks an inbox row as failed after exhausting processing attempts. */
  async markFailed(
    id: number,
    lastError: string,
    manager: EntityManager,
  ): Promise<void> {
    const repository = manager.getRepository(Inbox);
    const row = await repository.findOneByOrFail({ id });
    row.status = 'failed';
    row.lastError = lastError;
    await repository.save(row);
  }
}
