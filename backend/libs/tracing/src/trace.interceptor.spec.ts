import { CallHandler, ExecutionContext } from '@nestjs/common';
import { headers as natsHeaders } from '@nats-io/transport-node';
import { defer, firstValueFrom, of } from 'rxjs';
import { TraceContextService } from './trace-context.service.js';
import { TraceInterceptor } from './trace.interceptor.js';
import { TraceService } from './trace.service.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('TraceInterceptor', () => {
  let traceContext: TraceContextService;
  let interceptor: TraceInterceptor;

  beforeEach(() => {
    const traceService = new TraceService();
    traceContext = new TraceContextService(traceService);
    interceptor = new TraceInterceptor(traceContext, traceService);
  });

  // The handler must observe the trace id, so it has to read it lazily at
  // subscription time - exactly like a real Nest handler does.
  const handler: CallHandler = {
    handle: () => defer(() => of(traceContext.getTraceId())),
  };

  function httpContext(headers: Record<string, unknown>): ExecutionContext {
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    } as unknown as ExecutionContext;
  }

  function rpcContext(context: unknown): ExecutionContext {
    return {
      getType: () => 'rpc',
      switchToRpc: () => ({ getContext: () => context }),
    } as unknown as ExecutionContext;
  }

  it('runs an http handler inside the inbound trace scope', async () => {
    const observed = await firstValueFrom(
      interceptor.intercept(httpContext({ 'x-trace-id': 'trace-1' }), handler),
    );

    expect(observed).toBe('trace-1');
  });

  it('runs a nats handler inside the inbound trace scope', async () => {
    const msgHeaders = natsHeaders();
    msgHeaders.set('x-trace-id', 'trace-2');

    const observed = await firstValueFrom(
      interceptor.intercept(
        rpcContext({ getHeaders: () => msgHeaders }),
        handler,
      ),
    );

    expect(observed).toBe('trace-2');
  });

  it('runs an rmq handler inside the inbound trace scope', async () => {
    const observed = await firstValueFrom(
      interceptor.intercept(
        rpcContext({
          getMessage: () => ({
            properties: { headers: { 'x-trace-id': 'trace-3' } },
          }),
        }),
        handler,
      ),
    );

    expect(observed).toBe('trace-3');
  });

  it('starts a new trace when the inbound message carries none', async () => {
    const observed = await firstValueFrom(
      interceptor.intercept(
        rpcContext({ getHeaders: () => undefined }),
        handler,
      ),
    );

    expect(observed).toMatch(UUID_V4);
  });

  it('gives each request its own trace id', async () => {
    const context = httpContext({});

    const first = await firstValueFrom(interceptor.intercept(context, handler));
    const second = await firstValueFrom(
      interceptor.intercept(context, handler),
    );

    expect(first).not.toBe(second);
  });

  it('closes the scope once the handler completes', async () => {
    await firstValueFrom(
      interceptor.intercept(httpContext({ 'x-trace-id': 'trace-1' }), handler),
    );

    expect(traceContext.getTraceId()).toBeUndefined();
  });
});
