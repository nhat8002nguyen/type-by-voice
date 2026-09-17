import { describe, expect, it } from 'vitest';
import { CheckQuotaResponseDto } from './check-quota.dto.js';

describe('CheckQuotaResponseDto', () => {
  it('carries the protocol quota snapshot', () => {
    const dto: CheckQuotaResponseDto = {
      allowed: true,
      quota: { unit: 'words', limit: 2000, used: 312, resetAt: '2026-09-18T04:12:00Z' },
    };
    expect(dto.quota.unit).toBe('words');
  });
});
