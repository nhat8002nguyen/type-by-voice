import { TraceService } from './trace.service.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('TraceService', () => {
  const service = new TraceService();

  it('generates a v4 uuid', () => {
    expect(service.generateTraceId()).toMatch(UUID_V4);
  });

  it('generates a distinct id on every call', () => {
    const ids = new Set(
      Array.from({ length: 1000 }, () => service.generateTraceId()),
    );

    expect(ids.size).toBe(1000);
  });
});
