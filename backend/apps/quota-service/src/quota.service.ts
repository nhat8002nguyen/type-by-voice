import { Injectable } from '@nestjs/common';
import type { QuotaSnapshot } from '@type-by-voice/dictation-v1';
import { randomUUID } from 'node:crypto';
import { Plan } from './entities/plan.entity.js';
import { QuotaPeriod } from './entities/quota-period.entity.js';

export const DEFAULT_FREE_PLAN = {
  name: 'free',
  wordLimit: 2000,
  periodLengthDays: 7,
  audioMinutesCeiling: 180,
  isDefault: true,
} as const;

export type QuotaPlanWindow = Pick<
  Plan,
  'id' | 'wordLimit' | 'periodLengthDays' | 'audioMinutesCeiling'
>;

@Injectable()
export class QuotaService {
  private readonly periods = new Map<string, QuotaPeriod>();
  private readonly plans = new Map<string, Plan>();

  constructor() {
    this.seedDefaultFreePlan();
  }

  static withMemory(): QuotaService {
    return new QuotaService();
  }

  resolvePeriod(
    userId: string,
    now: Date,
    anchorAt: Date,
    plan: QuotaPlanWindow,
  ): QuotaPeriod {
    const ms = plan.periodLengthDays * 24 * 60 * 60 * 1000;
    const elapsed = now.getTime() - anchorAt.getTime();
    const n = Math.floor(elapsed / ms);
    const periodStart = new Date(anchorAt.getTime() + n * ms);
    const periodEnd = new Date(periodStart.getTime() + ms);
    const key = periodKey(userId, periodStart);
    const existing = this.periods.get(key);
    if (existing) {
      return existing;
    }

    const period = new QuotaPeriod();
    period.id = randomUUID();
    period.userId = userId;
    period.periodStart = periodStart;
    period.periodEnd = periodEnd;
    period.wordsUsed = 0;
    period.audioMsUsed = 0;
    period.updatedAt = now;
    this.periods.set(key, period);
    return period;
  }

  toSnapshot(
    period: QuotaPeriod,
    plan: Pick<Plan, 'wordLimit'>,
  ): QuotaSnapshot {
    return {
      unit: 'words',
      limit: plan.wordLimit,
      used: period.wordsUsed,
      resetAt: period.periodEnd.toISOString(),
    };
  }

  private seedDefaultFreePlan(): void {
    const plan = new Plan();
    plan.id = 'plan-free';
    plan.name = DEFAULT_FREE_PLAN.name;
    plan.wordLimit = DEFAULT_FREE_PLAN.wordLimit;
    plan.periodLengthDays = DEFAULT_FREE_PLAN.periodLengthDays;
    plan.audioMinutesCeiling = DEFAULT_FREE_PLAN.audioMinutesCeiling;
    plan.isDefault = DEFAULT_FREE_PLAN.isDefault;
    this.plans.set(plan.name, plan);
  }
}

function periodKey(userId: string, periodStart: Date): string {
  return `${userId}:${periodStart.toISOString()}`;
}
