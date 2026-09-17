import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError } from 'typeorm';
import { vi } from 'vitest';
import { Inbox } from './entities/inbox.entity.js';
import { InboxService } from './inbox.service.js';

describe('InboxService', () => {
  let service: InboxService;
  let repository: {
    create: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    findOneBy: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    repository = {
      create: vi.fn(),
      save: vi.fn(),
      findOneBy: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InboxService,
        { provide: getRepositoryToken(Inbox), useValue: repository },
      ],
    }).compile();

    service = module.get(InboxService);
  });

  it('store inserts a pending inbox row', async () => {
    const input = {
      messageId: 'outbox:1',
      type: 'workflows.create',
      payload: { name: 'wf', buildingId: 1 },
    };
    const created = { ...input, status: 'pending' };
    const saved = { id: 1, ...created };
    repository.create.mockReturnValue(created);
    repository.save.mockResolvedValue(saved);

    const result = await service.store(input);

    expect(repository.create).toHaveBeenCalledWith({
      messageId: input.messageId,
      type: input.type,
      payload: input.payload,
    });
    expect(repository.save).toHaveBeenCalledWith(created);
    expect(result).toEqual(saved);
  });

  it('store treats duplicate messageId as already stored', async () => {
    const input = {
      messageId: 'outbox:1',
      type: 'workflows.create',
      payload: { name: 'wf', buildingId: 1 },
    };
    const existing = { id: 1, ...input, status: 'pending' };
    repository.create.mockReturnValue(input);
    repository.save.mockRejectedValue(
      new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('duplicate'), { code: '23505' }),
      ),
    );
    repository.findOneBy.mockResolvedValue(existing);

    const result = await service.store(input);

    expect(result).toEqual(existing);
    expect(repository.findOneBy).toHaveBeenCalledWith({
      messageId: 'outbox:1',
    });
  });

  it('storeIfNew returns false on duplicate messageId', async () => {
    const input = {
      messageId: 'outbox:1',
      type: 'notifications.email',
      payload: { type: 'verify-email', userId: 'user-1', email: 'a@b.co' },
    };
    repository.create.mockReturnValue(input);
    repository.save.mockRejectedValue(
      new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('duplicate'), { code: '23505' }),
      ),
    );

    await expect(service.storeIfNew(input)).resolves.toBe(false);
  });

  it('storeIfNew returns true when the row is inserted', async () => {
    const input = {
      messageId: 'outbox:1',
      type: 'notifications.email',
      payload: { type: 'verify-email', userId: 'user-1', email: 'a@b.co' },
    };
    repository.create.mockReturnValue(input);
    repository.save.mockResolvedValue({ id: 1, ...input });

    await expect(service.storeIfNew(input)).resolves.toBe(true);
  });

  it('store rethrows errors that are not unique violations', async () => {
    repository.create.mockReturnValue({});
    repository.save.mockRejectedValue(new Error('db down'));

    await expect(
      service.store({
        messageId: 'outbox:1',
        type: 'workflows.create',
        payload: {},
      }),
    ).rejects.toThrow('db down');
  });

  it('claimPending locks pending rows with SKIP LOCKED', async () => {
    const rows = [{ id: 1, status: 'pending' }];
    const getMany = vi.fn().mockResolvedValue(rows);
    const take = vi.fn().mockReturnValue({ getMany });
    const orderBy = vi.fn().mockReturnValue({ take });
    const andWhere = vi.fn().mockReturnValue({ orderBy });
    const where = vi.fn().mockReturnValue({ andWhere });
    const setOnLocked = vi.fn().mockReturnValue({ where });
    const setLock = vi.fn().mockReturnValue({ setOnLocked });
    const createQueryBuilder = vi.fn().mockReturnValue({ setLock });
    const manager = { createQueryBuilder } as unknown as EntityManager;

    const result = await service.claimPending({
      take: 1,
      maxAttempts: 3,
      manager,
    });

    expect(createQueryBuilder).toHaveBeenCalledWith(Inbox, 'inbox');
    expect(setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(setOnLocked).toHaveBeenCalledWith('skip_locked');
    expect(where).toHaveBeenCalledWith('inbox.status = :status', {
      status: 'pending',
    });
    expect(andWhere).toHaveBeenCalledWith('inbox.attempts < :maxAttempts', {
      maxAttempts: 3,
    });
    expect(orderBy).toHaveBeenCalledWith('inbox.createdAt', 'ASC');
    expect(take).toHaveBeenCalledWith(1);
    expect(result).toEqual(rows);
  });

  it('markProcessed sets status to processed on the transaction manager', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const findOneByOrFail = vi.fn().mockResolvedValue({
      id: 7,
      status: 'pending',
    });
    const getRepository = vi.fn().mockReturnValue({ findOneByOrFail, save });
    const manager = { getRepository } as unknown as EntityManager;

    await service.markProcessed(7, manager);

    expect(getRepository).toHaveBeenCalledWith(Inbox);
    expect(save).toHaveBeenCalledWith({ id: 7, status: 'processed' });
  });

  it('recordFailure increments attempts and stays pending under the cap', async () => {
    const row = {
      id: 7,
      status: 'pending' as const,
      attempts: 0,
      lastError: null as string | null,
    };
    const save = vi.fn().mockResolvedValue(undefined);
    const findOneByOrFail = vi.fn().mockResolvedValue(row);
    const manager = {
      getRepository: vi.fn().mockReturnValue({ findOneByOrFail, save }),
    } as unknown as EntityManager;

    await service.recordFailure(
      7,
      new Error('boom'),
      { maxAttempts: 3 },
      manager,
    );

    expect(row.attempts).toBe(1);
    expect(row.status).toBe('pending');
    expect(row.lastError).toBe('boom');
    expect(save).toHaveBeenCalledWith(row);
  });

  it('recordFailure marks failed when attempts reach the cap', async () => {
    const row = {
      id: 7,
      status: 'pending' as const,
      attempts: 2,
      lastError: null as string | null,
    };
    const save = vi.fn().mockResolvedValue(undefined);
    const findOneByOrFail = vi.fn().mockResolvedValue(row);
    const manager = {
      getRepository: vi.fn().mockReturnValue({ findOneByOrFail, save }),
    } as unknown as EntityManager;

    await service.recordFailure(
      7,
      new Error('boom'),
      { maxAttempts: 3 },
      manager,
    );

    expect(row.attempts).toBe(3);
    expect(row.status).toBe('failed');
    expect(row.lastError).toBe('boom');
  });

  it('markFailed sets failed immediately with lastError', async () => {
    const row = {
      id: 7,
      status: 'pending' as const,
      lastError: null as string | null,
    };
    const save = vi.fn().mockResolvedValue(undefined);
    const findOneByOrFail = vi.fn().mockResolvedValue(row);
    const manager = {
      getRepository: vi.fn().mockReturnValue({ findOneByOrFail, save }),
    } as unknown as EntityManager;

    await service.markFailed(7, 'no handler for other.event', manager);

    expect(row.status).toBe('failed');
    expect(row.lastError).toBe('no handler for other.event');
    expect(save).toHaveBeenCalledWith(row);
  });
});
