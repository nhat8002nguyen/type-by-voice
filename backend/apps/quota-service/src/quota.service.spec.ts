import { describe, expect, it } from 'vitest';
import { QuotaService } from './quota.service.js';

const plan = {
  id: 'plan-free',
  wordLimit: 2000,
  periodLengthDays: 7,
  audioMinutesCeiling: 180,
};

describe('QuotaService.resolvePeriod', () => {
  it('opens the first period at signup', () => {
    const service = QuotaService.withMemory();
    const signup = new Date('2026-09-01T00:00:00Z');
    const now = new Date('2026-09-03T00:00:00Z');
    const period = service.resolvePeriod('user-1', now, signup, plan);
    expect(period.periodStart.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(period.periodEnd.toISOString()).toBe('2026-09-08T00:00:00.000Z');
    expect(period.wordsUsed).toBe(0);
  });

  it('rolls forward across a multi-week gap', () => {
    const service = QuotaService.withMemory();
    const signup = new Date('2026-09-01T00:00:00Z');
    service.resolvePeriod('user-1', new Date('2026-09-02T00:00:00Z'), signup, plan);
    const later = service.resolvePeriod('user-1', new Date('2026-09-20T00:00:00Z'), signup, plan);
    expect(later.periodStart.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(later.wordsUsed).toBe(0);
  });
});

describe('QuotaService.toSnapshot', () => {
  it('maps period usage onto a QuotaSnapshot', () => {
    const service = QuotaService.withMemory();
    const signup = new Date('2026-09-01T00:00:00Z');
    const now = new Date('2026-09-03T00:00:00Z');
    const period = service.resolvePeriod('user-1', now, signup, plan);
    expect(service.toSnapshot(period, plan)).toEqual({
      unit: 'words',
      limit: 2000,
      used: 0,
      resetAt: '2026-09-08T00:00:00.000Z',
    });
  });

  it('uses null limit when wordLimit is null', () => {
    const service = QuotaService.withMemory();
    const signup = new Date('2026-09-01T00:00:00Z');
    const now = new Date('2026-09-03T00:00:00Z');
    const unlimited = { ...plan, wordLimit: null };
    const period = service.resolvePeriod('user-1', now, signup, unlimited);
    expect(service.toSnapshot(period, unlimited).limit).toBeNull();
  });
});
