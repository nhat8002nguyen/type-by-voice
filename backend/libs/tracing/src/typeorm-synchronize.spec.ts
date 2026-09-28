import { describe, expect, it } from 'vitest';
import { shouldSynchronizeTypeOrm } from './typeorm-synchronize.js';

describe('shouldSynchronizeTypeOrm', () => {
  it('is true in development', () => {
    expect(shouldSynchronizeTypeOrm({ NODE_ENV: 'development' })).toBe(true);
  });

  it('is false in production by default', () => {
    expect(shouldSynchronizeTypeOrm({ NODE_ENV: 'production' })).toBe(false);
  });

  it('is true in production when TYPEORM_SYNCHRONIZE=true', () => {
    expect(
      shouldSynchronizeTypeOrm({
        NODE_ENV: 'production',
        TYPEORM_SYNCHRONIZE: 'true',
      }),
    ).toBe(true);
  });

  it('ignores other TYPEORM_SYNCHRONIZE values', () => {
    expect(
      shouldSynchronizeTypeOrm({
        NODE_ENV: 'production',
        TYPEORM_SYNCHRONIZE: '1',
      }),
    ).toBe(false);
  });
});
