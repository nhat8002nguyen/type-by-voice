import { ClientProxy } from '@nestjs/microservices';
import { Observable } from 'rxjs';
import { TraceContextService } from '../trace-context.service.js';
import { TracingLogger } from '../tracing-logger.service.js';
import { TracingClientProxy } from './tracing-client.types.js';

export abstract class TracingClientProxyBase implements TracingClientProxy {
  readonly context: string;

  private readonly logger: TracingLogger;

  constructor(
    private readonly client: ClientProxy,
    private readonly traceContext: TraceContextService,
    inquirer: object | string,
    private readonly transport: string,
  ) {
    this.logger = new TracingLogger(inquirer, traceContext);
    this.context = this.logger.context;
  }

  /** send logs and forwards a request/response pattern with the active trace id attached. */
  send<TResult = unknown, TInput = unknown>(
    pattern: unknown,
    data: TInput,
  ): Observable<TResult> {
    this.logger.log(`[${this.transport}] send ${String(pattern)}`);
    return this.client.send<TResult>(pattern, this.traced(data));
  }

  /** emit logs and forwards an event pattern with the active trace id attached. */
  emit<TResult = unknown, TInput = unknown>(
    pattern: unknown,
    data: TInput,
  ): Observable<TResult> {
    this.logger.log(`[${this.transport}] emit ${String(pattern)}`);
    return this.client.emit<TResult>(pattern, this.traced(data));
  }

  /** traced returns data with the active trace id attached when present. */
  private traced(data: unknown): unknown {
    const traceId = this.traceContext.getTraceId();
    return traceId ? this.attachTraceId(data, traceId) : data;
  }

  /** attachTraceId injects the active trace id into outbound message metadata. */
  protected abstract attachTraceId(data: unknown, traceId: string): unknown;
}
