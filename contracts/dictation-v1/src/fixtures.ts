import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

export function loadFixture<T>(name: string): T {
  const raw = readFileSync(join(fixturesDir, name), 'utf8');
  return JSON.parse(raw) as T;
}
