import { describe, expect, it, vi } from 'vitest';
import { NOTIFICATIONS_EMAIL_EVENT } from '../../../libs/notifications/src/tokens.js';
import { NotificationsController } from './notifications.controller.js';

describe('NotificationsController', () => {
  const inbox = { store: vi.fn() };

  it('acks missing messageId without sending mail', async () => {
    const mailer = { send: vi.fn() };
    const controller = new NotificationsController(
      mailer as never,
      inbox as never,
    );
    await controller.onEmail({}, {
      getMessage: () => ({ properties: {} }),
      getChannelRef: () => ({ ack: vi.fn() }),
    } as never);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('sends mail and stores inbox when messageId is present', async () => {
    const mailer = { send: vi.fn() };
    const store = vi.fn().mockResolvedValue({ id: 1 });
    const ack = vi.fn();
    const controller = new NotificationsController(
      mailer as never,
      {
        store,
      } as never,
    );
    const dto = {
      type: 'verify-email' as const,
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'a@b.co',
      token: 'secret-token',
    };

    await controller.onEmail(dto, {
      getMessage: () => ({ properties: { messageId: 'outbox:9' } }),
      getChannelRef: () => ({ ack }),
    } as never);

    expect(mailer.send).toHaveBeenCalledWith(dto);
    expect(store).toHaveBeenCalledWith({
      messageId: 'outbox:9',
      type: NOTIFICATIONS_EMAIL_EVENT,
      payload: {
        type: 'verify-email',
        userId: dto.userId,
        email: dto.email,
      },
    });
    expect(ack).toHaveBeenCalled();
  });
});
