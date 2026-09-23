import type { Platform } from '@type-by-voice/dictation-v1';
import { Injectable } from '@nestjs/common';

export type StageTimings = {
  platform: Platform;
  connectMs: number;
  audioReceivedMs: number;
  providerMs: number;
  totalMs: number;
};

export type StageSnapshot = Record<string, { count: number; sumMs: number }>;

export type MetricsSnapshot = {
  dictate_connect_ms: StageSnapshot;
  dictate_audio_received_ms: StageSnapshot;
  dictate_provider_ms: StageSnapshot;
  dictate_total_ms: StageSnapshot;
  provider_error_total: number;
  quota_rejected_total: number;
};

@Injectable()
export class DictateMetrics {
  readonly #connect = emptyStage();
  readonly #audioReceived = emptyStage();
  readonly #provider = emptyStage();
  readonly #total = emptyStage();
  #providerErrors = 0;
  #quotaRejected = 0;

  /** record accumulates per-platform stage timings for one completed dictation. */
  record(timings: StageTimings): void {
    add(this.#connect, timings.platform, timings.connectMs);
    add(this.#audioReceived, timings.platform, timings.audioReceivedMs);
    add(this.#provider, timings.platform, timings.providerMs);
    add(this.#total, timings.platform, timings.totalMs);
  }

  /** recordProviderError increments the speech-provider failure counter. */
  recordProviderError(): void {
    this.#providerErrors += 1;
  }

  /** recordQuotaRejected increments the pre-session quota rejection counter. */
  recordQuotaRejected(): void {
    this.#quotaRejected += 1;
  }

  /** snapshot returns a copy of accumulated dictate timing and error counters. */
  snapshot(): MetricsSnapshot {
    return {
      dictate_connect_ms: cloneStage(this.#connect),
      dictate_audio_received_ms: cloneStage(this.#audioReceived),
      dictate_provider_ms: cloneStage(this.#provider),
      dictate_total_ms: cloneStage(this.#total),
      provider_error_total: this.#providerErrors,
      quota_rejected_total: this.#quotaRejected,
    };
  }
}

/** emptyStage returns an empty per-platform stage accumulator. */
function emptyStage(): StageSnapshot {
  return {};
}

/** add increments count and sumMs for a platform bucket in a stage snapshot. */
function add(stage: StageSnapshot, platform: string, ms: number): void {
  const current = stage[platform] ?? { count: 0, sumMs: 0 };
  current.count += 1;
  current.sumMs += ms;
  stage[platform] = current;
}

/** cloneStage deep-copies a stage snapshot so callers cannot mutate internals. */
function cloneStage(stage: StageSnapshot): StageSnapshot {
  const copy: StageSnapshot = {};
  for (const [platform, value] of Object.entries(stage)) {
    copy[platform] = { ...value };
  }
  return copy;
}
