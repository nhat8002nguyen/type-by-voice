import { Logger } from '@nestjs/common';
import { vi } from 'vitest';
import { TraceContextService } from './trace-context.service.js';
import { TraceService } from './trace.service.js';
import { TracingLogger } from './tracing-logger.service.js';

class OrdersController {}

describe('TracingLogger', () => {
  let traceContext: TraceContextService;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    traceContext = new TraceContextService(new TraceService());
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names itself after the class that injected it', () => {
    const logger = new TracingLogger(new OrdersController(), traceContext);

    expect(logger.context).toBe('OrdersController');
  });

  it('accepts a plain string context', () => {
    const logger = new TracingLogger('Bootstrap', traceContext);

    expect(logger.context).toBe('Bootstrap');
  });

  it('prefixes messages with the ambient trace id', () => {
    const logger = new TracingLogger(new OrdersController(), traceContext);

    traceContext.run('trace-1', () => logger.log('order received'));

    expect(logSpy).toHaveBeenCalledWith('[trace:trace-1] order received');
  });

  it('leaves messages untouched outside a trace scope', () => {
    const logger = new TracingLogger(new OrdersController(), traceContext);

    logger.log('order received');

    expect(logSpy).toHaveBeenCalledWith('order received');
  });

  it('forwards optional params such as error stacks', () => {
    const logger = new TracingLogger(new OrdersController(), traceContext);

    traceContext.run('trace-1', () => logger.error('boom', 'stack-trace'));

    expect(errorSpy).toHaveBeenCalledWith(
      '[trace:trace-1] boom',
      'stack-trace',
    );
  });

  it('does not attempt to prefix non-string messages', () => {
    const logger = new TracingLogger(new OrdersController(), traceContext);
    const payload = { alarmId: 'a1' };

    traceContext.run('trace-1', () => logger.log(payload));

    expect(logSpy).toHaveBeenCalledWith(payload);
  });
});
