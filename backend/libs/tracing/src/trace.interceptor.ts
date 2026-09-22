import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { TraceContextService } from './trace-context.service.js';
import { TraceService } from './trace.service.js';
import {
  extractTraceIdFromHttpRequest,
  extractTraceIdFromRpcContext,
} from './trace-headers.util.js';

@Injectable()
export class TraceInterceptor implements NestInterceptor {
  constructor(
    private readonly traceContext: TraceContextService,
    private readonly traceService: TraceService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const traceId = this.resolveTraceId(context);

    // next.handle() is lazy: the handler only runs on subscribe, so the trace
    // scope has to wrap the subscription rather than this method's body.
    return new Observable((subscriber) =>
      this.traceContext.run(traceId, () => next.handle().subscribe(subscriber)),
    );
  }

  private resolveTraceId(context: ExecutionContext): string {
    return this.extractTraceId(context) ?? this.traceService.generateTraceId();
  }

  private extractTraceId(context: ExecutionContext): string | undefined {
    switch (context.getType<string>()) {
      case 'rpc':
        return extractTraceIdFromRpcContext(context.switchToRpc().getContext());
      case 'http':
        return extractTraceIdFromHttpRequest(
          context.switchToHttp().getRequest(),
        );
      default:
        return undefined;
    }
  }
}
