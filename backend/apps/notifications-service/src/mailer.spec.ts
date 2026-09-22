import { describe, expect, it, vi } from 'vitest';
import { Mailer } from './mailer.js';

describe('Mailer', () => {
  it('writes type, userId, and email to stdout in development', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    new Mailer().send({
      type: 'verify-email',
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'a@b.co',
      token: 'secret-token',
    });

    expect(log).toHaveBeenCalledWith({
      type: 'verify-email',
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'a@b.co',
    });
    expect(JSON.stringify(log.mock.calls[0]?.[0])).not.toContain(
      'secret-token',
    );
    log.mockRestore();
    process.env.NODE_ENV = previous;
  });
});
