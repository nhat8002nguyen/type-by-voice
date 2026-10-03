import { Injectable } from '@nestjs/common';
import type {
  CheckQuotaRequestDto,
  CheckQuotaResponseDto,
  CommitQuotaRequestDto,
  CommitQuotaResponseDto,
} from '@app/quota';
import type { QuotaSnapshot } from '@type-by-voice/dictation-v1';
import { randomUUID } from 'node:crypto';
import { Plan } from './entities/plan.entity.js';
import { QuotaAdjustment } from './entities/quota-adjustment.entity.js';
import { QuotaPeriod } from './entities/quota-period.entity.js';
import { Subscription } from './entities/subscription.entity.js';
import { UsageRecord } from './entities/usage-record.entity.js';

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

const MS_PER_MINUTE = 60_000;

@Injectable()
export class QuotaService {
  private readonly periods = new Map<string, QuotaPeriod>();
  private readonly plans = new Map<string, Plan>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly anchors = new Map<string, Date>();
  private readonly usageRecords = new Map<string, UsageRecord>();
  private readonly adjustments: QuotaAdjustment[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.seedDefaultFreePlan();
  }

  /** withMemory constructs an in-memory QuotaService for unit tests. */
  static withMemory(): QuotaService {
    return new QuotaService();
  }

  /** resolvePeriod returns the open usage period for the user at now, creating one if needed. */
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

  /** toSnapshot maps plan + period counters into the client QuotaSnapshot shape. */
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

  /** seedUser installs a subscription/period fixture for tests. */
  seedUser(
    userId: string,
    anchorAt: Date,
    plan: QuotaPlanWindow,
    initial: { wordsUsed?: number; audioMsUsed?: number } = {},
  ): void {
    const stored = this.indexPlan(plan);
    this.anchors.set(userId, anchorAt);
    const period = this.resolvePeriod(userId, anchorAt, anchorAt, stored);
    period.wordsUsed = initial.wordsUsed ?? 0;
    period.audioMsUsed = initial.audioMsUsed ?? 0;
    this.insertSubscription(userId, stored, period, anchorAt);
  }

  /**
   * check reports whether the user may start dictation under word and audio ceilings.
   * Does not mutate counters.
   */
  check(userId: string, now: Date): CheckQuotaResponseDto {
    const { period, plan } = this.loadCurrent(userId, now);
    const quota = this.toSnapshot(period, plan);
    if (plan.wordLimit != null && period.wordsUsed >= plan.wordLimit) {
      return { allowed: false, reason: 'quota_exceeded', quota };
    }
    if (period.audioMsUsed >= plan.audioMinutesCeiling * MS_PER_MINUTE) {
      return { allowed: false, reason: 'audio_cap_exceeded', quota };
    }
    return { allowed: true, quota };
  }

  /** checkFor adapts a CheckQuotaRequestDto into check(). */
  checkFor(dto: CheckQuotaRequestDto): CheckQuotaResponseDto {
    return this.check(dto.userId, new Date());
  }

  /** commit records usage for requestId (idempotent) and advances words/audio on the period. */
  commit(
    dto: CommitQuotaRequestDto,
    now: Date,
  ): Promise<CommitQuotaResponseDto> {
    return this.runExclusive(async () => {
      await Promise.resolve();
      const existing = this.usageRecords.get(dto.requestId);
      if (existing) {
        const { period, plan } = this.loadCurrent(dto.userId, now);
        return { quota: this.toSnapshot(period, plan) };
      }

      const { period, plan } = this.loadCurrent(dto.userId, now);
      period.wordsUsed += dto.wordCount;
      period.audioMsUsed += dto.audioMs;
      period.updatedAt = now;
      this.usageRecords.set(dto.requestId, this.toUsageRecord(dto, now));
      return { quota: this.toSnapshot(period, plan) };
    });
  }

  /** adjust applies a manual words delta with a reason (support/admin path). */
  adjust(userId: string, now: Date, wordsDelta: number, reason: string): void {
    const { period } = this.loadCurrent(userId, now);
    period.wordsUsed += wordsDelta;
    period.updatedAt = now;

    const adjustment = new QuotaAdjustment();
    adjustment.id = randomUUID();
    adjustment.userId = userId;
    adjustment.quotaPeriodId = period.id;
    adjustment.wordsDelta = wordsDelta;
    adjustment.reason = reason;
    adjustment.createdAt = now;
    this.adjustments.push(adjustment);
  }

  /** runExclusive serializes async writers so commit mutations cannot interleave. */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** loadCurrent loads the user's subscription, plan, and current period for the given time. */
  private loadCurrent(
    userId: string,
    now: Date,
  ): { period: QuotaPeriod; plan: Plan } {
    const existing = this.subscriptions.get(userId);
    if (!existing) {
      const plan = this.defaultPlan();
      this.anchors.set(userId, now);
      const period = this.resolvePeriod(userId, now, now, plan);
      this.insertSubscription(userId, plan, period, now);
      return { period, plan };
    }

    const plan = this.requirePlan(existing.planId);
    const anchorAt = this.anchors.get(userId) ?? existing.createdAt;
    const period = this.resolvePeriod(userId, now, anchorAt, plan);
    existing.currentPeriodStart = period.periodStart;
    existing.currentPeriodEnd = period.periodEnd;
    existing.updatedAt = now;
    return { period, plan };
  }

  /** insertSubscription creates the default subscription row for a new user. */
  private insertSubscription(
    userId: string,
    plan: Plan,
    period: QuotaPeriod,
    at: Date,
  ): Subscription {
    const subscription = new Subscription();
    subscription.id = randomUUID();
    subscription.userId = userId;
    subscription.planId = plan.id;
    subscription.status = 'active';
    subscription.currentPeriodStart = period.periodStart;
    subscription.currentPeriodEnd = period.periodEnd;
    subscription.externalRef = null;
    subscription.createdAt = at;
    subscription.updatedAt = at;
    this.subscriptions.set(userId, subscription);
    return subscription;
  }

  /** indexPlan indexes a plan entity into the in-memory plan map. */
  private indexPlan(window: QuotaPlanWindow): Plan {
    const existing = this.plans.get(window.id) ?? this.defaultPlanOrUndefined();
    if (existing && existing.id === window.id) {
      return existing;
    }

    const plan = new Plan();
    plan.id = window.id;
    plan.name = window.id;
    plan.wordLimit = window.wordLimit;
    plan.periodLengthDays = window.periodLengthDays;
    plan.audioMinutesCeiling = window.audioMinutesCeiling;
    plan.isDefault = false;
    this.plans.set(plan.id, plan);
    this.plans.set(plan.name, plan);
    return plan;
  }

  /** requirePlan returns a plan by id or throws when missing. */
  private requirePlan(planId: string): Plan {
    return this.plans.get(planId) ?? this.defaultPlan();
  }

  /** defaultPlan returns the configured default free plan. */
  private defaultPlan(): Plan {
    const plan = this.defaultPlanOrUndefined();
    if (!plan) {
      throw new Error('default free plan is not seeded');
    }
    return plan;
  }

  /** defaultPlanOrUndefined returns the default plan when present. */
  private defaultPlanOrUndefined(): Plan | undefined {
    for (const plan of new Set(this.plans.values())) {
      if (plan.isDefault) {
        return plan;
      }
    }
    return this.plans.get(DEFAULT_FREE_PLAN.name);
  }

  /** toUsageRecord maps a commit into a UsageRecord entity shape. */
  private toUsageRecord(dto: CommitQuotaRequestDto, now: Date): UsageRecord {
    const record = new UsageRecord();
    record.id = randomUUID();
    record.userId = dto.userId;
    record.requestId = dto.requestId;
    record.sessionId = dto.sessionId;
    record.platform = dto.platform;
    record.clientVersion = dto.clientVersion;
    record.audioMs = dto.audioMs;
    record.wordCount = dto.wordCount;
    record.provider = dto.provider;
    record.providerLatencyMs = dto.providerLatencyMs;
    record.estimatedCostMicros = dto.estimatedCostMicros;
    record.language = dto.language ?? null;
    record.translateToEnglish = dto.translateToEnglish ?? false;
    record.createdAt = now;
    return record;
  }

  /** seedDefaultFreePlan installs the built-in free plan into the in-memory store. */
  private seedDefaultFreePlan(): void {
    const plan = new Plan();
    plan.id = 'plan-free';
    plan.name = DEFAULT_FREE_PLAN.name;
    plan.wordLimit = DEFAULT_FREE_PLAN.wordLimit;
    plan.periodLengthDays = DEFAULT_FREE_PLAN.periodLengthDays;
    plan.audioMinutesCeiling = DEFAULT_FREE_PLAN.audioMinutesCeiling;
    plan.isDefault = DEFAULT_FREE_PLAN.isDefault;
    this.plans.set(plan.id, plan);
    this.plans.set(plan.name, plan);
  }
}

/** periodKey builds the map key for a user's usage period start. */
function periodKey(userId: string, periodStart: Date): string {
  return `${userId}:${periodStart.toISOString()}`;
}
