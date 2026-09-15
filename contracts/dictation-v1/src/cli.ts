import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture } from './fixtures.js';
import { runHarness } from './latency-harness.js';
import { startMockDictateServer } from './mock-server.js';
import type { StartMessage } from './types.js';

const runs = Number(process.env.HARNESS_RUNS ?? 20);
const liveUrl = process.env.DICTATE_URL;
const token = process.env.DICTATE_TOKEN ?? 'test-token';
const audio = new Uint8Array(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../audio/speech-1s.ogg')),
);

const server = liveUrl ? null : await startMockDictateServer({ transcript: 'the transcribed text' });
const url = liveUrl ?? server!.url;
const report = await runHarness({
  url,
  token,
  audio,
  start: loadFixture<StartMessage>('start.valid.json'),
  runs,
});
console.log(JSON.stringify(report, null, 2));
if (report.stages.totalMs.p95 > 3000) {
  console.warn('WARNING: totalMs p95 exceeds 3000 ms budget');
}
await server?.close();
