import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

@Injectable()
export class TraceService {
  generateTraceId(): string {
    return randomUUID();
  }
}
