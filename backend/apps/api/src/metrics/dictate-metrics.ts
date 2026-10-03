import type { Platform } from '@type-by-voice/dictation-v1';
import { Injectable } from '@nestjs/common';

export type LanguageMode = 'en-en' | 'vi-vi' | 'vi-en' | 'auto-en' | 'auto';

export type StageTimings = {
  platform: Platform;
  mode: LanguageMode;
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

  /** record accumulates stage timings for one completed dictation, bucketed by platform and language mode. */
  record(timings: StageTimings): void {
    const key = `${timings.platform}:${timings.mode}`;
    add(this.#connect, key, timings.connectMs);
    add(this.#audioReceived, key, timings.audioReceivedMs);
    add(this.#provider, key, timings.providerMs);
    add(this.#total, key, timings.totalMs);
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

/** add increments count and sumMs for a bucket key in a stage snapshot. */
function add(stage: StageSnapshot, key: string, ms: number): void {
  const current = stage[key] ?? { count: 0, sumMs: 0 };
  current.count += 1;
  current.sumMs += ms;
  stage[key] = current;
}

/** languageModeOf maps the input language and translation flag onto a latency-tagging mode. */
export function languageModeOf(
  language?: 'en' | 'vi',
  translateToEnglish?: boolean,
): LanguageMode {
  if (language === 'en') return 'en-en';
  if (translateToEnglish) return language === 'vi' ? 'vi-en' : 'auto-en';
  if (language === 'vi') return 'vi-vi';
  return 'auto';
}

/** cloneStage deep-copies a stage snapshot so callers cannot mutate internals. */
function cloneStage(stage: StageSnapshot): StageSnapshot {
  const copy: StageSnapshot = {};
  for (const [platform, value] of Object.entries(stage)) {
    copy[platform] = { ...value };
  }
  return copy;
}
