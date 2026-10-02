import { describe, expect, it } from 'vitest';
import { loadFixture } from '../src/fixtures.js';
import { validateStart } from '../src/validate-start.js';
import type { StartMessage } from '../src/types.js';

describe('validateStart', () => {
  it('accepts the valid start fixture', () => {
    const result = validateStart(loadFixture('start.valid.json'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.platform).toBe('macos');
    }
  });

  it('accepts platform linux', () => {
    const start = { ...loadFixture<StartMessage>('start.valid.json'), platform: 'linux' };
    const result = validateStart(start);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.platform).toBe('linux');
    }
  });

  it('rejects unknown platform, bad codec, and missing deviceId', () => {
    expect(validateStart(loadFixture('start.unknown-platform.json')).ok).toBe(false);
    expect(validateStart(loadFixture('start.bad-codec.json')).ok).toBe(false);
    expect(validateStart(loadFixture('start.missing-device-id.json')).ok).toBe(false);
  });

  it('ignores unknown fields', () => {
    const extra = { ...loadFixture<StartMessage>('start.valid.json'), extra: 1 };
    const result = validateStart(extra);
    expect(result.ok).toBe(true);
  });

  it('rejects a non-uuid deviceId', () => {
    const start = { ...loadFixture<StartMessage>('start.valid.json'), deviceId: 'not-a-uuid' };
    expect(validateStart(start).ok).toBe(false);
  });

  it('requires a boolean listInHistory', () => {
    const start = loadFixture<StartMessage>('start.valid.json');
    const result = validateStart(start);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.listInHistory).toBe(true);
    }
    const { listInHistory: _ignored, ...without } = {
      ...start,
      listInHistory: true,
    };
    expect(validateStart(without).ok).toBe(false);
    expect(validateStart({ ...start, listInHistory: 'yes' }).ok).toBe(false);
  });
});
