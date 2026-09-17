import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { Inbox } from './entities/inbox.entity.js';

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

  async markProcessed(id: number, manager: EntityManager): Promise<void> {
    const repository = manager.getRepository(Inbox);
    const row = await repository.findOneByOrFail({ id });
    row.status = 'processed';
    await repository.save(row);
  }

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
