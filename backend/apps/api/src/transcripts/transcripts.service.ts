import type { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

type WorkflowsClient = Pick<ClientProxy, 'send'>;

const DEFAULT_TRANSCRIPT_LIST_LIMIT = 20;

type ListTranscriptsQuery = {
  q?: string;
  cursor?: string;
  limit?: number;
};

export class TranscriptsService {
  constructor(private readonly workflows: WorkflowsClient) {}

  async list(userId: string, query: ListTranscriptsQuery) {
    if (query.q) {
      const result = await firstValueFrom(
        this.workflows.send('transcripts.search', {
          userId,
          q: query.q,
          ...(query.cursor ? { cursor: query.cursor } : {}),
          limit: query.limit ?? DEFAULT_TRANSCRIPT_LIST_LIMIT,
        }),
      );
      return Array.isArray(result) ? { items: result } : result;
    }

    return firstValueFrom(
      this.workflows.send('transcripts.list', {
        userId,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: query.limit ?? DEFAULT_TRANSCRIPT_LIST_LIMIT,
      }),
    );
  }

  get(userId: string, id: string) {
    return firstValueFrom(
      this.workflows.send('transcripts.get', { userId, id }),
    );
  }

  delete(userId: string, id: string) {
    return firstValueFrom(
      this.workflows.send('transcripts.delete', { userId, id }),
    );
  }

  export(userId: string) {
    return firstValueFrom(
      this.workflows.send('transcripts.export', { userId }),
    );
  }
}
