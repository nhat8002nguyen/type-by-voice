import type { CreateTranscriptDto } from '@app/workflows';
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager, IsNull, QueryFailedError, Repository } from 'typeorm';
import { decryptTranscript, encryptTranscript } from './transcript-crypto.js';
import { Transcript } from './transcript.entity.js';

export type PublicTranscript = {
  id: string;
  text: string;
  wordCount: number;
  audioMs: number;
  createdAt: Date;
};

export type TranscriptListPage = {
  items: PublicTranscript[];
  nextCursor?: string;
};

/** isUniqueViolation reports whether a TypeORM error is a Postgres unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError = error.driverError as { code?: string };
  return driverError.code === '23505';
}

/** parseTranscriptEncryptionKey validates and decodes the env key material for AES-GCM. */
export function parseTranscriptEncryptionKey(
  hex = process.env.TRANSCRIPT_ENCRYPTION_KEY,
): Buffer {
  if (!hex || hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('TRANSCRIPT_ENCRYPTION_KEY must be 64 hex characters');
  }
  return Buffer.from(hex, 'hex');
}

@Injectable()
export class TranscriptsService {
  private readonly logger = new Logger(TranscriptsService.name);
  private readonly byId = new Map<string, Transcript>();
  private readonly byRequestId = new Map<string, Transcript>();

  constructor(
    private readonly key: Buffer,
    private readonly repository?: Repository<Transcript>,
  ) {}

  /** withMemory constructs an in-memory TranscriptsService for unit tests. */
  static withMemory(key: Buffer): TranscriptsService {
    return new TranscriptsService(key);
  }

  /** fromEnv constructs a TranscriptsService using encryption key material from the environment. */
  static fromEnv(repository: Repository<Transcript>): TranscriptsService {
    return new TranscriptsService(parseTranscriptEncryptionKey(), repository);
  }

  /**
   * handleInboxCreate persists a workflows.create payload from the inbox processor.
   * Deduplicates on requestId so RMQ redelivery is safe.
   */
  async handleInboxCreate(payload: unknown, em?: EntityManager): Promise<void> {
    const dto = payload as CreateTranscriptDto;
    this.logger.log(`requestId=${dto.requestId} wordCount=${dto.wordCount}`);
    if (typeof dto.text === 'string') {
      await this.create(dto, em);
      return;
    }
    const existing = await this.findByRequestId(dto.requestId, em);
    if (existing) {
      return;
    }
    throw new Error(`transcript missing for requestId=${dto.requestId}`);
  }

  /** create encrypts and stores a transcript, idempotent on requestId, without logging plaintext text. */
  async create(
    input: {
      userId: string;
      requestId: string;
      text: string;
      wordCount: number;
      audioMs: number;
      listInHistory?: boolean;
    },
    em?: EntityManager,
  ): Promise<PublicTranscript> {
    const existing = await this.findByRequestId(input.requestId, em);
    if (existing) {
      return this.toPublic(existing);
    }

    const listInHistory = input.listInHistory ?? true;

    const row = new Transcript();
    row.id = randomUUID();
    row.userId = input.userId;
    row.requestId = input.requestId;
    row.ciphertext = encryptTranscript(input.text, this.key);
    row.wordCount = input.wordCount;
    row.audioMs = input.audioMs;
    row.createdAt = new Date();
    row.deletedAt = null;
    row.listInHistory = listInHistory;
    return this.toPublic(await this.persist(row, em));
  }

  /** search returns user-visible transcripts matching a decrypted-side query window. */
  async search(
    userId: string,
    q: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<TranscriptListPage> {
    const needle = q.toLowerCase();
    const items = (await this.loadVisible(userId))
      .sort(compareNewestFirst)
      .map((row) => this.toPublic(row))
      .filter((item) => item.text.toLowerCase().includes(needle));
    return paginatePublic(items, {
      cursor: options?.cursor,
      limit: options?.limit ?? Math.max(items.length, 1),
    });
  }

  /** get returns one user-visible transcript by id after decrypting ciphertext at rest. */
  async get(userId: string, id: string): Promise<PublicTranscript | null> {
    const row = await this.findById(id);
    if (!row || row.userId !== userId || row.deletedAt || !row.listInHistory) {
      return null;
    }
    return this.toPublic(row);
  }

  /** delete soft-deletes one user-owned transcript. */
  async delete(userId: string, id: string): Promise<void> {
    const row = await this.findById(id);
    if (!row || row.userId !== userId || row.deletedAt) {
      return;
    }
    row.deletedAt = new Date();
    await this.persist(row);
  }

  /** deleteAll soft-deletes all transcripts owned by the user. */
  async deleteAll(userId: string, em?: EntityManager): Promise<void> {
    const now = new Date();
    const repository = this.store(em);
    if (!repository) {
      for (const row of this.byId.values()) {
        if (row.userId === userId && row.deletedAt == null) {
          row.deletedAt = now;
        }
      }
      return;
    }
    await repository.update({ userId, deletedAt: IsNull() }, { deletedAt: now });
  }

  /** export returns a downloadable dump of the user's visible history. */
  async export(userId: string): Promise<PublicTranscript[]> {
    return (await this.loadVisible(userId)).map((row) => this.toPublic(row));
  }

  /** list returns a newest-first page of the user's visible transcripts. */
  async list(
    userId: string,
    options: { cursor?: string; limit: number },
  ): Promise<TranscriptListPage> {
    const items = (await this.loadVisible(userId))
      .sort(compareNewestFirst)
      .map((row) => this.toPublic(row));
    return paginatePublic(items, options);
  }

  /** store inserts an encrypted transcript row into the persistence backend. */
  private store(em?: EntityManager): Repository<Transcript> | undefined {
    if (em) {
      return em.getRepository(Transcript);
    }
    return this.repository;
  }

  /** findByRequestId looks up a transcript by idempotency requestId. */
  private async findByRequestId(
    requestId: string,
    em?: EntityManager,
  ): Promise<Transcript | undefined> {
    const repository = this.store(em);
    if (!repository) {
      return this.byRequestId.get(requestId);
    }
    return (await repository.findOne({ where: { requestId } })) ?? undefined;
  }

  /** findById loads a transcript entity by primary key. */
  private async findById(
    id: string,
    em?: EntityManager,
  ): Promise<Transcript | undefined> {
    const repository = this.store(em);
    if (!repository) {
      return this.byId.get(id);
    }
    return (await repository.findOne({ where: { id } })) ?? undefined;
  }

  /** loadVisible loads non-deleted transcripts for the user. */
  private async loadVisible(
    userId: string,
    em?: EntityManager,
  ): Promise<Transcript[]> {
    const repository = this.store(em);
    if (!repository) {
      return [...this.byId.values()].filter(
        (row) => row.userId === userId && !row.deletedAt && row.listInHistory,
      );
    }
    return repository.find({
      where: { userId, deletedAt: IsNull(), listInHistory: true },
    });
  }

  /** persist writes transcript entity changes to the persistence backend. */
  private async persist(
    row: Transcript,
    em?: EntityManager,
  ): Promise<Transcript> {
    const repository = this.store(em);
    if (!repository) {
      this.byId.set(row.id, row);
      this.byRequestId.set(row.requestId, row);
      return row;
    }
    try {
      return await repository.save(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.findByRequestId(row.requestId, em);
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  /** toPublic maps a stored transcript into the public API shape after decryption. */
  private toPublic(row: Transcript): PublicTranscript {
    return {
      id: row.id,
      text: decryptTranscript(row.ciphertext, this.key),
      wordCount: row.wordCount,
      audioMs: row.audioMs,
      createdAt: row.createdAt,
    };
  }
}

/** paginatePublic slices decrypted public transcripts into a page. */
function paginatePublic(
  items: PublicTranscript[],
  options: { cursor?: string; limit: number },
): TranscriptListPage {
  let start = 0;
  if (options.cursor) {
    const index = items.findIndex((item) => item.id === options.cursor);
    start = index === -1 ? items.length : index + 1;
  }
  const sliced = items.slice(start, start + options.limit);
  const hasMore = start + options.limit < items.length;
  return {
    items: sliced,
    ...(hasMore && sliced.length > 0
      ? { nextCursor: sliced[sliced.length - 1].id }
      : {}),
  };
}

/** compareNewestFirst orders transcripts by createdAt descending. */
function compareNewestFirst(a: Transcript, b: Transcript): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
