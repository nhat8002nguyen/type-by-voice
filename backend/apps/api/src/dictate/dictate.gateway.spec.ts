import { CLOSE_CODES } from '@type-by-voice/dictation-v1';
import { describe, expect, it } from 'vitest';
import { closeCodeForAuthError, closeCodeForQuota } from './dictate.gateway.js';

describe('DictateGateway close codes', () => {
  it('maps auth errors to 4401', () => {
    expect(closeCodeForAuthError()).toBe(CLOSE_CODES.unauthenticated);
    expect(closeCodeForAuthError()).toBe(4401);
  });

  it('maps quota exceeded to 4403', () => {
    expect(closeCodeForQuota()).toBe(CLOSE_CODES.quota_exceeded);
    expect(closeCodeForQuota()).toBe(4403);
  });
});
