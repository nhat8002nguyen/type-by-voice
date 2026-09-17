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

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.log(this.withTraceId(message), ...optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.error(this.withTraceId(message), ...optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.warn(this.withTraceId(message), ...optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.debug(this.withTraceId(message), ...optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.verbose(this.withTraceId(message), ...optionalParams);
  }

  private withTraceId(message: unknown): unknown {
    const traceId = this.traceContext.getTraceId();
    if (!traceId || typeof message !== 'string') {
      return message;
    }
    return `[trace:${traceId}] ${message}`;
  }
}

function resolveContextName(inquirer: object | string | undefined): string {
  if (typeof inquirer === 'string') {
    return inquirer;
  }
  return inquirer?.constructor?.name ?? TracingLogger.name;
}
