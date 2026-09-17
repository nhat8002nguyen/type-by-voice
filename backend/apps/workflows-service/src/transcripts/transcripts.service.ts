import type { CreateTranscriptDto } from '@app/workflows';
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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

@Injectable()
export class TranscriptsService {
  private readonly logger = new Logger(TranscriptsService.name);
  private readonly byId = new Map<string, Transcript>();
  private readonly byRequestId = new Map<string, Transcript>();

  constructor(private readonly key: Buffer) {}

  static withMemory(key: Buffer): TranscriptsService {
    return new TranscriptsService(key);
  }

  static fromEnv(): TranscriptsService {
    const hex = process.env.TRANSCRIPT_ENCRYPTION_KEY;
    if (!hex || hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error('TRANSCRIPT_ENCRYPTION_KEY must be 64 hex characters');
    }
    return new TranscriptsService(Buffer.from(hex, 'hex'));
  }

  async handleInboxCreate(payload: unknown): Promise<void> {
    const dto = payload as CreateTranscriptDto;
    this.logger.log(`requestId=${dto.requestId} wordCount=${dto.wordCount}`);
    await this.create(dto);
  }

  async create(input: {
    userId: string;
    requestId: string;
    text: string;
    wordCount: number;
    audioMs: number;
  }): Promise<PublicTranscript> {
    const existing = this.byRequestId.get(input.requestId);
    if (existing) {
      return this.toPublic(existing);
    }

    const row = new Transcript();
    row.id = randomUUID();
    row.userId = input.userId;
    row.requestId = input.requestId;
    row.ciphertext = encryptTranscript(input.text, this.key);
    row.wordCount = input.wordCount;
    row.audioMs = input.audioMs;
    row.createdAt = new Date();
    row.deletedAt = null;
    this.byId.set(row.id, row);
    this.byRequestId.set(row.requestId, row);
    return this.toPublic(row);
  }

  async search(userId: string, q: string): Promise<PublicTranscript[]> {
    const needle = q.toLowerCase();
    return this.visibleFor(userId)
      .map((row) => this.toPublic(row))
      .filter((item) => item.text.toLowerCase().includes(needle));
  }

  async get(userId: string, id: string): Promise<PublicTranscript | null> {
    const row = this.byId.get(id);
    if (!row || row.userId !== userId || row.deletedAt) {
      return null;
    }
    return this.toPublic(row);
  }

  async delete(userId: string, id: string): Promise<void> {
    const row = this.byId.get(id);
    if (!row || row.userId !== userId || row.deletedAt) {
      return;
    }
    row.deletedAt = new Date();
  }

  async export(userId: string): Promise<PublicTranscript[]> {
    return this.visibleFor(userId).map((row) => this.toPublic(row));
  }

  async list(
    userId: string,
    options: { cursor?: string; limit: number },
  ): Promise<TranscriptListPage> {
    const rows = this.visibleFor(userId).sort(compareNewestFirst);
    let start = 0;
    if (options.cursor) {
      const index = rows.findIndex((row) => row.id === options.cursor);
      start = index === -1 ? rows.length : index + 1;
    }
    const sliced = rows.slice(start, start + options.limit);
    const hasMore = start + options.limit < rows.length;
    return {
      items: sliced.map((row) => this.toPublic(row)),
      ...(hasMore && sliced.length > 0
        ? { nextCursor: sliced[sliced.length - 1].id }
        : {}),
    };
  }

  private visibleFor(userId: string): Transcript[] {
    return [...this.byId.values()].filter(
      (row) => row.userId === userId && !row.deletedAt,
    );
  }

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

function compareNewestFirst(a: Transcript, b: Transcript): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
