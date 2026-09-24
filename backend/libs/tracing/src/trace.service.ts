import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

@Injectable()
export class TraceService {
  /** generateTraceId creates a new opaque trace identifier. */
  generateTraceId(): string {
    return randomUUID();
  }
}
