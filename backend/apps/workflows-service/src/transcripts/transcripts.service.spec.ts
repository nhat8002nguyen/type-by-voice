import { randomUUID } from 'node:crypto';
import { FindOperator } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { decryptTranscript } from './transcript-crypto.js';
import { Transcript } from './transcript.entity.js';
import { TranscriptsService } from './transcripts.service.js';

const body = {
  userId: 'user-1',
  requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
  text: 'the transcribed text',
  wordCount: 3,
  audioMs: 11800,
};

describe('TranscriptsService', () => {
  it('create encrypts and search decrypts only this user', async () => {
    const service = TranscriptsService.withMemory(Buffer.alloc(32, 7));
    await service.create({
      userId: 'user-1',
      requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
      text: 'the transcribed text',
      wordCount: 3,
      audioMs: 11800,
    });
    const hits = await service.search('user-1', 'transcribed');
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe('the transcribed text');
    expect(await service.search('user-2', 'transcribed')).toHaveLength(0);
  });

  it('create is idempotent on requestId', async () => {
    const service = TranscriptsService.withMemory(Buffer.alloc(32, 7));
    const first = await service.create(body);
    const second = await service.create({
      ...body,
      text: 'other text',
      wordCount: 2,
    });
    expect(second.id).toBe(first.id);
    expect(second.text).toBe('the transcribed text');
    expect(await service.search('user-1', 'transcribed')).toHaveLength(1);
  });

  it('search matches case-insensitively', async () => {
    const service = TranscriptsService.withMemory(Buffer.alloc(32, 7));
    await service.create(body);
    expect(await service.search('user-1', 'TRANSCRIBED')).toHaveLength(1);
  });

  it('soft-deletes so search, get, and export omit the row', async () => {
    const service = TranscriptsService.withMemory(Buffer.alloc(32, 7));
    const created = await service.create(body);
    await service.delete('user-1', created.id);
    expect(await service.search('user-1', 'transcribed')).toHaveLength(0);
    expect(await service.get('user-1', created.id)).toBeNull();
    expect(await service.export('user-1')).toHaveLength(0);
  });

  it('export returns all non-deleted transcripts for this user', async () => {
    const service = TranscriptsService.withMemory(Buffer.alloc(32, 7));
    await service.create(body);
    await service.create({
      ...body,
      userId: 'user-2',
      requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
      text: 'other user text',
    });
    const exported = await service.export('user-1');
    expect(exported).toHaveLength(1);
    expect(exported[0].text).toBe('the transcribed text');
  });

  it('lists with cursor pagination and hides other users', async () => {
    const service = TranscriptsService.withMemory(Buffer.alloc(32, 7));
    await service.create(body);
    await service.create({
      ...body,
      requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2',
      text: 'second transcript',
      wordCount: 2,
    });
    await service.create({
      ...body,
      userId: 'user-2',
      requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3',
      text: 'other user',
    });
    const page = await service.list('user-1', { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    const next = await service.list('user-1', {
      cursor: page.nextCursor,
      limit: 1,
    });
    expect(next.items).toHaveLength(1);
    expect(next.items[0].id).not.toBe(page.items[0].id);
    expect(next.nextCursor).toBeUndefined();
    const ids = [page.items[0].id, next.items[0].id];
    expect(new Set(ids).size).toBe(2);
  });

  it('gets a decrypted transcript for the owner only', async () => {
    const service = TranscriptsService.withMemory(Buffer.alloc(32, 7));
    const created = await service.create(body);
    expect(await service.get('user-1', created.id)).toMatchObject({
      text: 'the transcribed text',
      wordCount: 3,
      audioMs: 11800,
    });
    expect(await service.get('user-2', created.id)).toBeNull();
  });

  it('inbox handler creates from payload', async () => {
    const service = TranscriptsService.withMemory(Buffer.alloc(32, 7));
    await service.handleInboxCreate(body);
    const hits = await service.search('user-1', 'transcribed');
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe('the transcribed text');
  });

  it('create persists ciphertext through a TypeORM repository', async () => {
    const rows: Transcript[] = [];
    const repository = createInMemoryRepo(rows);
    const service = new TranscriptsService(
      Buffer.alloc(32, 7),
      repository as never,
    );
    await service.create(body);
    expect(rows).toHaveLength(1);
    expect(
      rows[0].ciphertext.includes(Buffer.from('the transcribed text')),
    ).toBe(false);
    expect(decryptTranscript(rows[0].ciphertext, Buffer.alloc(32, 7))).toBe(
      'the transcribed text',
    );
    expect(await service.search('user-1', 'transcribed')).toHaveLength(1);
  });

  it('handleInboxCreate writes through the provided EntityManager', async () => {
    const rows: Transcript[] = [];
    const repository = createInMemoryRepo(rows);
    const service = TranscriptsService.withMemory(Buffer.alloc(32, 7));
    await service.handleInboxCreate(body, {
      getRepository: () => repository,
    } as never);
    expect(rows).toHaveLength(1);
    expect(
      rows[0].ciphertext.includes(Buffer.from('the transcribed text')),
    ).toBe(false);
  });

  it('inbox handler without text is a no-op when the row already exists', async () => {
    const service = TranscriptsService.withMemory(Buffer.alloc(32, 7));
    await service.create(body);
    await service.handleInboxCreate({
      userId: body.userId,
      requestId: body.requestId,
      wordCount: body.wordCount,
      audioMs: body.audioMs,
    });
    expect(await service.search('user-1', 'transcribed')).toHaveLength(1);
  });
});

type Row = { id?: string } & Record<string, unknown>;

function createInMemoryRepo<T extends Row>(rows: T[]) {
  const matches = (row: T, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, expected]) => {
      const actual = row[key];
      if (expected instanceof FindOperator) {
        if (expected.type === 'isNull') {
          return actual === null || actual === undefined;
        }
        return false;
      }
      return actual === expected;
    });

  return {
    create: (data: Partial<T>) => ({ ...data }) as T,
    save: async (entity: T) => {
      const saved = { ...entity, id: entity.id ?? randomUUID() } as T;
      const index = rows.findIndex((row) => row.id === saved.id);
      if (index >= 0) {
        rows[index] = Object.assign(rows[index], saved);
        return rows[index];
      }
      rows.push(saved);
      return saved;
    },
    find: async (options: { where: Record<string, unknown> }) =>
      rows.filter((row) => matches(row, options.where)),
    findOne: async (options: { where: Record<string, unknown> }) =>
      rows.find((row) => matches(row, options.where)) ?? null,
  };
}
