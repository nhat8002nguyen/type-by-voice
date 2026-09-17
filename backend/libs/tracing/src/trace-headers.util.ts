import { TRACE_ID_HEADER } from './tracing.constants.js';

export interface HttpRequestLike {
  headers?: Record<string, unknown>;
}

export interface RpcContextLike {
  getHeaders?: () => { get?: (key: string) => unknown } | undefined;
  getMessage?: () => { properties?: { headers?: Record<string, unknown> } };
}

export function extractTraceIdFromHttpRequest(
  request: HttpRequestLike | undefined,
): string | undefined {
  const value = request?.headers?.[TRACE_ID_HEADER];
  return normalize(Array.isArray(value) ? value[0] : value);
}

export function extractTraceIdFromRpcContext(
  context: RpcContextLike | undefined,
): string | undefined {
  const fromNats = normalize(context?.getHeaders?.()?.get?.(TRACE_ID_HEADER));
  if (fromNats) {
    return fromNats;
  }

  const rmqHeaders = context?.getMessage?.()?.properties?.headers;
  return normalize(rmqHeaders?.[TRACE_ID_HEADER]);
}

function normalize(value: unknown): string | undefined {
  if (Buffer.isBuffer(value)) {
    return normalize(value.toString());
  }
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
