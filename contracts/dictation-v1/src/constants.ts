export const PLATFORMS = ['macos', 'windows', 'ios', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ERROR_CODES = {
  unauthenticated: { retryable: false },
  quota_exceeded: { retryable: false },
  audio_cap_exceeded: { retryable: false },
  too_long: { retryable: false },
  invalid_request: { retryable: false },
  rate_limited: { retryable: true },
  provider_unavailable: { retryable: true },
  internal: { retryable: true },
  session_timeout: { retryable: true },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const CLOSE_CODES = {
  normal: 1000,
  unauthenticated: 4401,
  quota_exceeded: 4403,
  rate_limited: 4429,
} as const;

export const SESSION_LIMITS = {
  maxDurationMs: 120_000,
  firstAudioTimeoutMs: 10_000,
  stopTimeoutMs: 30_000,
  idleTimeoutMs: 60_000,
  idempotencyTtlMs: 5 * 60_000,
  maxConcurrentSessions: 2,
} as const;
