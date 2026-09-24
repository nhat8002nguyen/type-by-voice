import {
  Inject,
  Injectable,
  Logger,
  LoggerService,
  Scope,
} from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import { TraceContextService } from './trace-context.service.js';

@Injectable({ scope: Scope.TRANSIENT })
export class TracingLogger implements LoggerService {
  readonly context: string;

  private readonly logger: Logger;

  constructor(
    @Inject(INQUIRER) inquirer: object | string,
    private readonly traceContext: TraceContextService,
  ) {
    this.context = resolveContextName(inquirer);
    this.logger = new Logger(this.context);
  }

  /** log writes an info log line with the active trace id when present. */
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.log(this.withTraceId(message), ...optionalParams);
  }

  /** error writes an error log line with the active trace id when present. */
  error(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.error(this.withTraceId(message), ...optionalParams);
  }

  /** warn writes a warning log line with the active trace id when present. */
  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.warn(this.withTraceId(message), ...optionalParams);
  }

  /** debug writes a debug log line with the active trace id when present. */
  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.debug(this.withTraceId(message), ...optionalParams);
  }

  /** verbose writes a verbose log line with the active trace id when present. */
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.verbose(this.withTraceId(message), ...optionalParams);
  }

  /** withTraceId prefixes a message with the current trace id when available. */
  private withTraceId(message: unknown): unknown {
    const traceId = this.traceContext.getTraceId();
    if (!traceId || typeof message !== 'string') {
      return message;
    }
    return `[trace:${traceId}] ${message}`;
  }
}

/** resolveContextName normalizes a Nest logger context argument to a string name. */
function resolveContextName(inquirer: object | string | undefined): string {
  if (typeof inquirer === 'string') {
    return inquirer;
  }
  return inquirer?.constructor?.name ?? TracingLogger.name;
}
