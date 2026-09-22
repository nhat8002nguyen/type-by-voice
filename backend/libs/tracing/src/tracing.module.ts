import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TraceContextService } from './trace-context.service.js';
import { TraceInterceptor } from './trace.interceptor.js';
import { TraceService } from './trace.service.js';
import { TracingLogger } from './tracing-logger.service.js';

@Global()
@Module({
  providers: [
    TraceService,
    TraceContextService,
    TracingLogger,
    { provide: APP_INTERCEPTOR, useClass: TraceInterceptor },
  ],
  exports: [TraceService, TraceContextService, TracingLogger],
})
export class TracingModule {}
