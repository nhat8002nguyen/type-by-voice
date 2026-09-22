import { describe, expect, it } from 'vitest';
import { isObserveEnabled } from './is-observe-enabled.js';

describe('isObserveEnabled', () => {
  it('is off when credentials are missing', () => {
    expect(isObserveEnabled({})).toBe(false);
    expect(isObserveEnabled({ OBSERVE_APP_KEY: '', OBSERVE_APP_SECRET: '' })).toBe(
      false,
    );
    expect(
      isObserveEnabled({ OBSERVE_APP_KEY: '  ', OBSERVE_APP_SECRET: 'secret' }),
    ).toBe(false);
  });

  it('is on when both key and secret are set', () => {
    expect(
      isObserveEnabled({
        OBSERVE_APP_KEY: 'key',
        OBSERVE_APP_SECRET: 'secret',
      }),
    ).toBe(true);
  });
});
