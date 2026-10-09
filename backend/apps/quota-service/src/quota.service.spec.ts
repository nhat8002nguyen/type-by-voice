import type { CommitQuotaRequestDto } from '@app/quota';
import { describe, expect, it } from 'vitest';
import { QuotaService } from './quota.service.js';

const plan = {
  id: 'plan-test-weekly',
  wordLimit: 2000,
  periodLengthDays: 7,
  audioMinutesCeiling: 180,
};

const commitBody: CommitQuotaRequestDto = {
  userId: 'user-1',
  requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
  sessionId: 'sess-1',
  platform: 'macos',
  clientVersion: '1.0.0+12',
  audioMs: 5000,
  wordCount: 20,
  provider: 'groq-whisper',
  providerLatencyMs: 300,
  estimatedCostMicros: 10,
};

describe('QuotaService default free plan', () => {
  it('grants 2000 words over a one-day period', () => {
    const service = QuotaService.withMemory();
    const now = new Date('2026-09-02T00:00:00Z');
    const { quota } = service.check('user-1', now);
    expect(quota.limit).toBe(2000);
    expect(quota.resetAt).toBe('2026-09-03T00:00:00.000Z');
  });
});

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
    service.resolvePeriod(
      'user-1',
      new Date('2026-09-02T00:00:00Z'),
      signup,
      plan,
    );
    const later = service.resolvePeriod(
      'user-1',
      new Date('2026-09-20T00:00:00Z'),
      signup,
      plan,
    );
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

describe('QuotaService check and commit', () => {
  it('allows a start under the limit and records overshoot on commit', async () => {
    const service = QuotaService.withMemory();
    const signup = new Date('2026-09-01T00:00:00Z');
    const now = new Date('2026-09-02T00:00:00Z');
    service.seedUser('user-1', signup, plan, { wordsUsed: 1990 });
    const check = service.check('user-1', now);
    expect(check.allowed).toBe(true);
    const committed = await service.commit(
      {
        userId: 'user-1',
        requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
        sessionId: 'sess-1',
        platform: 'macos',
        clientVersion: '1.0.0+12',
        audioMs: 5000,
        wordCount: 20,
        provider: 'groq-whisper',
        providerLatencyMs: 300,
        estimatedCostMicros: 10,
      },
      now,
    );
    expect(committed.quota.used).toBe(2010);
    expect(service.check('user-1', now).allowed).toBe(false);
    expect(service.check('user-1', now).reason).toBe('quota_exceeded');
  });

  it('serializes two concurrent commits without dropping usage', async () => {
    const service = QuotaService.withMemory();
    service.seedUser('user-1', new Date('2026-09-01T00:00:00Z'), plan, {
      wordsUsed: 0,
    });
    const now = new Date('2026-09-02T00:00:00Z');
    await Promise.all([
      service.commit(
        {
          ...commitBody,
          requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
          wordCount: 5,
        },
        now,
      ),
      service.commit(
        {
          ...commitBody,
          requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2',
          wordCount: 7,
        },
        now,
      ),
    ]);
    expect(service.check('user-1', now).quota.used).toBe(12);
  });

  it('is idempotent on requestId', async () => {
    const service = QuotaService.withMemory();
    service.seedUser('user-1', new Date('2026-09-01T00:00:00Z'), plan, {
      wordsUsed: 0,
    });
    const now = new Date('2026-09-02T00:00:00Z');
    const body = {
      ...commitBody,
      requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
      wordCount: 3,
    };
    await service.commit(body, now);
    await service.commit(body, now);
    expect(service.check('user-1', now).quota.used).toBe(3);
  });

  it('applies a negative adjustment', () => {
    const service = QuotaService.withMemory();
    service.seedUser('user-1', new Date('2026-09-01T00:00:00Z'), plan, {
      wordsUsed: 50,
    });
    service.adjust(
      'user-1',
      new Date('2026-09-02T00:00:00Z'),
      -20,
      'support goodwill',
    );
    expect(
      service.check('user-1', new Date('2026-09-02T00:00:00Z')).quota.used,
    ).toBe(30);
  });

  it('records language and translateToEnglish on the usage record', async () => {
    const service = QuotaService.withMemory();
    service.seedUser('user-1', new Date('2026-09-01T00:00:00Z'), plan, {
      wordsUsed: 0,
    });
    await service.commit(
      { ...commitBody, language: 'vi', translateToEnglish: true },
      new Date('2026-09-02T00:00:00Z'),
    );
    const record = (
      service as unknown as {
        usageRecords: Map<
          string,
          { language: string | null; translateToEnglish: boolean }
        >;
      }
    ).usageRecords.get(commitBody.requestId);
    expect(record?.language).toBe('vi');
    expect(record?.translateToEnglish).toBe(true);
  });
});
