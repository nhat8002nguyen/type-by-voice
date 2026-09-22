import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TraceService } from './trace.service.js';

export interface TraceStore {
  traceId: string;
}

@Injectable()
export class TraceContextService {
  private readonly storage = new AsyncLocalStorage<TraceStore>();

  constructor(private readonly traceService: TraceService) {}

  run<T>(traceId: string, callback: () => T): T {
    return this.storage.run({ traceId }, callback);
  }

  runWithNewTrace<T>(callback: (traceId: string) => T): T {
    const traceId = this.traceService.generateTraceId();
    return this.storage.run({ traceId }, () => callback(traceId));
  }

  getTraceId(): string | undefined {
    return this.storage.getStore()?.traceId;
  }
}
