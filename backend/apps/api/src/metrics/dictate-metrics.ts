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

  record(timings: StageTimings): void {
    add(this.#connect, timings.platform, timings.connectMs);
    add(this.#audioReceived, timings.platform, timings.audioReceivedMs);
    add(this.#provider, timings.platform, timings.providerMs);
    add(this.#total, timings.platform, timings.totalMs);
  }

  recordProviderError(): void {
    this.#providerErrors += 1;
  }

  recordQuotaRejected(): void {
    this.#quotaRejected += 1;
  }

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

function emptyStage(): StageSnapshot {
  return {};
}

function add(stage: StageSnapshot, platform: string, ms: number): void {
  const current = stage[platform] ?? { count: 0, sumMs: 0 };
  current.count += 1;
  current.sumMs += ms;
  stage[platform] = current;
}

function cloneStage(stage: StageSnapshot): StageSnapshot {
  const copy: StageSnapshot = {};
  for (const [platform, value] of Object.entries(stage)) {
    copy[platform] = { ...value };
  }
  return copy;
}
