import { describe, expect, it } from 'vitest';
import { DictateMetrics } from './dictate-metrics.js';

describe('DictateMetrics', () => {
  it('records stage timings tagged by platform', () => {
    const metrics = new DictateMetrics();
    metrics.record({
      platform: 'macos',
      connectMs: 5,
      audioReceivedMs: 20,
      providerMs: 30,
      totalMs: 60,
    });
    expect(metrics.snapshot().dictate_total_ms.macos.count).toBe(1);
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
