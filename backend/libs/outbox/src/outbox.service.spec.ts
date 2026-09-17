import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { vi } from 'vitest';
import { Outbox } from './entities/outbox.entity.js';
import { OutboxService } from './outbox.service.js';

describe('OutboxService', () => {
  let service: OutboxService;
  let repository: {
    find: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    repository = {
      find: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      save: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        { provide: getRepositoryToken(Outbox), useValue: repository },
      ],
    }).compile();

    service = module.get(OutboxService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('loads pending messages for a target in createdAt order', async () => {
    const rows = [{ id: 1, status: 'pending' }];
    repository.find.mockResolvedValue(rows);

    const result = await service.getPendingOutboxMessages({
      target: 'workflows-service',
      take: 100,
    });

    expect(repository.find).toHaveBeenCalledWith({
      where: { target: 'workflows-service', status: 'pending' },
      order: { createdAt: 'ASC' },
      take: 100,
    });
    expect(result).toEqual(rows);
  });

  it('marks a message as processed', async () => {
    repository.update.mockResolvedValue(undefined);

    await service.markAsProcessed(7);

    expect(repository.update).toHaveBeenCalledWith(7, { status: 'processed' });
  });

  it('inserts a pending outbox row', async () => {
    const created = { type: 'notifications.email' };
    const saved = { id: 3, status: 'pending' };
    repository.create.mockReturnValue(created);
    repository.save.mockResolvedValue(saved);

    const result = await service.enqueue({
      type: 'notifications.email',
      payload: { type: 'verify-email', userId: 'user-1', email: 'a@b.co' },
      target: Symbol('NOTIFICATIONS_SERVICE'),
    });

    expect(repository.create).toHaveBeenCalledWith({
      type: 'notifications.email',
      payload: { type: 'verify-email', userId: 'user-1', email: 'a@b.co' },
      target: 'NOTIFICATIONS_SERVICE',
      status: 'pending',
    });
    expect(repository.save).toHaveBeenCalledWith(created);
    expect(result).toEqual(saved);
  });
});
