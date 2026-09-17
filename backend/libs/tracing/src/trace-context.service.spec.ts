import { TraceContextService } from './trace-context.service.js';
import { TraceService } from './trace.service.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TraceContextService', () => {
  let context: TraceContextService;

  beforeEach(() => {
    context = new TraceContextService(new TraceService());
  });

  it('returns undefined outside of any trace scope', () => {
    expect(context.getTraceId()).toBeUndefined();
  });

  it('exposes the trace id inside the scope', () => {
    const seen = context.run('trace-1', () => context.getTraceId());

    expect(seen).toBe('trace-1');
  });

  it('keeps trace ids isolated across concurrent async flows', async () => {
    const flow = (traceId: string, wait: number) =>
      context.run(traceId, async () => {
        await delay(wait);
        return context.getTraceId();
      });

    const results = await Promise.all([
      flow('trace-a', 30),
      flow('trace-b', 10),
      flow('trace-c', 20),
    ]);

    expect(results).toEqual(['trace-a', 'trace-b', 'trace-c']);
  });

  it('restores the outer trace id after a nested scope ends', () => {
    context.run('outer', () => {
      context.run('inner', () => {
        expect(context.getTraceId()).toBe('inner');
      });

      expect(context.getTraceId()).toBe('outer');
    });
  });

  it('runWithNewTrace generates a fresh id per invocation', () => {
    const first = context.runWithNewTrace((traceId) => traceId);
    const second = context.runWithNewTrace((traceId) => traceId);

    expect(first).not.toBe(second);
  });

  it('runWithNewTrace exposes the generated id through getTraceId', () => {
    const [generated, observed] = context.runWithNewTrace(
      (traceId) => [traceId, context.getTraceId()] as const,
    );

    expect(observed).toBe(generated);
  });
});
