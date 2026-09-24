import type { ClientProxy } from '@nestjs/microservices';
import {
  TRANSCRIPTS_DELETE_ALL_PATTERN,
  TRANSCRIPTS_DELETE_PATTERN,
  TRANSCRIPTS_EXPORT_PATTERN,
  TRANSCRIPTS_GET_PATTERN,
  TRANSCRIPTS_LIST_PATTERN,
  TRANSCRIPTS_SEARCH_PATTERN,
} from '@app/workflows';
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

  /** list proxies a user-scoped transcript list request to workflows-service. */
  async list(userId: string, query: ListTranscriptsQuery) {
    if (query.q) {
      const result = await firstValueFrom(
        this.workflows.send(TRANSCRIPTS_SEARCH_PATTERN, {
          userId,
          q: query.q,
          ...(query.cursor ? { cursor: query.cursor } : {}),
          limit: query.limit ?? DEFAULT_TRANSCRIPT_LIST_LIMIT,
        }),
      );
      return Array.isArray(result) ? { items: result } : result;
    }

    return firstValueFrom(
      this.workflows.send(TRANSCRIPTS_LIST_PATTERN, {
        userId,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: query.limit ?? DEFAULT_TRANSCRIPT_LIST_LIMIT,
      }),
    );
  }

  /** get proxies a user-scoped transcript get request to workflows-service. */
  get(userId: string, id: string) {
    return firstValueFrom(
      this.workflows.send(TRANSCRIPTS_GET_PATTERN, { userId, id }),
    );
  }

  /** delete proxies a user-scoped transcript delete request to workflows-service. */
  delete(userId: string, id: string) {
    return firstValueFrom(
      this.workflows.send(TRANSCRIPTS_DELETE_PATTERN, { userId, id }),
    );
  }

  /** deleteAll proxies a user-scoped delete-all request to workflows-service. */
  deleteAll(userId: string) {
    return firstValueFrom(
      this.workflows.send(TRANSCRIPTS_DELETE_ALL_PATTERN, { userId }),
    );
  }

  /** export proxies a user-scoped transcript export request to workflows-service. */
  export(userId: string) {
    return firstValueFrom(
      this.workflows.send(TRANSCRIPTS_EXPORT_PATTERN, { userId }),
    );
  }
}
