import { headers as natsHeaders } from '@nats-io/transport-node';
import {
  extractTraceIdFromHttpRequest,
  extractTraceIdFromRpcContext,
} from './trace-headers.util.js';

describe('extractTraceIdFromHttpRequest', () => {
  it('reads the x-trace-id header', () => {
    const request = { headers: { 'x-trace-id': 'trace-1' } };

    expect(extractTraceIdFromHttpRequest(request)).toBe('trace-1');
  });

  it('takes the first value when the header is repeated', () => {
    const request = { headers: { 'x-trace-id': ['trace-1', 'trace-2'] } };

    expect(extractTraceIdFromHttpRequest(request)).toBe('trace-1');
  });

  it('returns undefined when the header is missing', () => {
    expect(extractTraceIdFromHttpRequest({ headers: {} })).toBeUndefined();
  });

  it('returns undefined when there is no request', () => {
    expect(extractTraceIdFromHttpRequest(undefined)).toBeUndefined();
  });
});

describe('extractTraceIdFromRpcContext', () => {
  it('reads the id from NATS message headers', () => {
    const msgHeaders = natsHeaders();
    msgHeaders.set('x-trace-id', 'trace-1');
    const context = { getHeaders: () => msgHeaders };

    expect(extractTraceIdFromRpcContext(context)).toBe('trace-1');
  });

  it('treats an empty NATS header value as absent', () => {
    const context = { getHeaders: () => natsHeaders() };

    expect(extractTraceIdFromRpcContext(context)).toBeUndefined();
  });

  it('returns undefined when a NATS message carries no headers', () => {
    const context = { getHeaders: () => undefined };

    expect(extractTraceIdFromRpcContext(context)).toBeUndefined();
  });

  it('reads the id from RabbitMQ message properties', () => {
    const context = {
      getMessage: () => ({
        properties: { headers: { 'x-trace-id': 'trace-1' } },
      }),
    };

    expect(extractTraceIdFromRpcContext(context)).toBe('trace-1');
  });

  it('decodes a RabbitMQ header delivered as a Buffer', () => {
    const context = {
      getMessage: () => ({
        properties: { headers: { 'x-trace-id': Buffer.from('trace-1') } },
      }),
    };

    expect(extractTraceIdFromRpcContext(context)).toBe('trace-1');
  });

  it('returns undefined for a RabbitMQ message without headers', () => {
    const context = { getMessage: () => ({ properties: {} }) };

    expect(extractTraceIdFromRpcContext(context)).toBeUndefined();
  });

  it('returns undefined for an unrecognised context', () => {
    expect(extractTraceIdFromRpcContext({})).toBeUndefined();
  });
});
