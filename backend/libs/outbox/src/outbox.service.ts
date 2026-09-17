import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Outbox } from './entities/outbox.entity.js';

@Injectable()
export class OutboxService {
  constructor(
    @InjectRepository(Outbox)
    private readonly outboxRepository: Repository<Outbox>,
  ) {}

  async getPendingOutboxMessages(options: {
    target: string;
    take: number;
  }): Promise<Outbox[]> {
    return this.outboxRepository.find({
      where: { target: options.target, status: 'pending' },
      order: { createdAt: 'ASC' },
      take: options.take,
    });
  }

  async markAsProcessed(id: number): Promise<void> {
    await this.outboxRepository.update(id, { status: 'processed' });
  }
}
