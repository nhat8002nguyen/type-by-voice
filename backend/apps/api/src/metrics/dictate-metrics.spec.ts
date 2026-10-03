import { describe, expect, it } from 'vitest';
import { DictateMetrics, languageModeOf } from './dictate-metrics.js';

describe('DictateMetrics', () => {
  it('records stage timings tagged by platform and language mode', () => {
    const metrics = new DictateMetrics();
    metrics.record({
      platform: 'macos',
      mode: 'vi-en',
      connectMs: 5,
      audioReceivedMs: 20,
      providerMs: 30,
      totalMs: 60,
    });
    expect(metrics.snapshot().dictate_total_ms['macos:vi-en'].count).toBe(1);
    expect(metrics.snapshot().dictate_provider_ms['macos:vi-en']).toEqual({
      count: 1,
      sumMs: 30,
    });
  });

  it('counts provider errors and quota rejections', () => {
    const metrics = new DictateMetrics();
    metrics.recordProviderError();
    metrics.recordQuotaRejected();
    metrics.recordQuotaRejected();
    expect(metrics.snapshot().provider_error_total).toBe(1);
    expect(metrics.snapshot().quota_rejected_total).toBe(2);
  });
});

describe('languageModeOf', () => {
  it('maps language and translateToEnglish to a mode', () => {
    expect(languageModeOf('vi', true)).toBe('vi-en');
    expect(languageModeOf('vi', false)).toBe('vi-vi');
    expect(languageModeOf('en', true)).toBe('en-en');
    expect(languageModeOf('en', false)).toBe('en-en');
    expect(languageModeOf(undefined, true)).toBe('auto-en');
    expect(languageModeOf(undefined, false)).toBe('auto');
  });
});
