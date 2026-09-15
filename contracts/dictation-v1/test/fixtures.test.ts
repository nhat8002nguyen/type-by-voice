import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../src/constants.js';
import { loadFixture } from '../src/fixtures.js';
import type { ErrorMessage, StartMessage } from '../src/types.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

describe('protocol fixtures', () => {
  it('parses a valid start message', () => {
    const start = loadFixture<StartMessage>('start.valid.json');
    expect(start).toEqual({
      type: 'start',
      requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
      codec: 'opus',
      container: 'ogg',
      sampleRate: 16000,
      channels: 1,
      language: 'en',
      platform: 'macos',
      clientVersion: '1.0.0+12',
      deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
    });
  });

  it('has one error fixture per error code', () => {
    for (const code of Object.keys(ERROR_CODES)) {
      const error = loadFixture<ErrorMessage>(`error.${code}.json`);
      expect(error.type).toBe('error');
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(ERROR_CODES[code as keyof typeof ERROR_CODES].retryable);
    }
  });

  it('ignores unknown fields in a start fixture copy', () => {
    const raw = JSON.parse(
      readFileSync(join(fixturesDir, 'start.valid.json'), 'utf8'),
    ) as StartMessage & { extra?: string };
    raw.extra = 'future-field';
    expect(raw.type).toBe('start');
    expect(raw.extra).toBe('future-field');
  });
});
