import { describe, expect, it } from 'vitest';
import { percentile, runHarness } from '../src/latency-harness.js';
import { loadFixture } from '../src/fixtures.js';
import { startMockDictateServer } from '../src/mock-server.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StartMessage } from '../src/types.js';

describe('percentile', () => {
  it('computes p50 and p95 on a known series', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
  });
});

describe('runHarness', () => {
  it('returns finite p50/p95 against the mock server', async () => {
    const server = await startMockDictateServer({ port: 0, transcript: 'the transcribed text' });
    const audio = new Uint8Array(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../audio/speech-1s.ogg')),
    );
    const report = await runHarness({
      url: server.url,
      token: 'test-token',
      audio,
      start: loadFixture<StartMessage>('start.valid.json'),
      runs: 5,
    });
    expect(report.runs).toBe(5);
    expect(report.stages.totalMs.p50).toBeGreaterThanOrEqual(0);
    expect(report.stages.totalMs.p95).toBeGreaterThanOrEqual(report.stages.totalMs.p50);
    await server.close();
  });
});
