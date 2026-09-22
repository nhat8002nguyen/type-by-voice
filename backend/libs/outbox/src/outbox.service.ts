import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Outbox } from './entities/outbox.entity.js';
import { outboxTargetName } from './outbox.constants.js';

@Injectable()
export class OutboxService {
  constructor(
    @InjectRepository(Outbox)
    private readonly outboxRepository: Repository<Outbox>,
  ) {}

  async enqueue(message: {
    type: string;
    payload: Record<string, unknown>;
    target: string | symbol;
  }): Promise<Outbox> {
    return this.outboxRepository.save(
      this.outboxRepository.create({
        type: message.type,
        payload: message.payload,
        target: outboxTargetName(message.target),
        status: 'pending',
      }),
    );
  }

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
    const row = await this.outboxRepository.findOneBy({ id });
    if (!row) {
      return;
    }
    const payload = { ...row.payload };
    if ('text' in payload) {
      delete payload.text;
    }
    await this.outboxRepository.update(id, { status: 'processed', payload });
  }
}
