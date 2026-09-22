import { describe, expect, it, vi } from 'vitest';
import { NOTIFICATIONS_EMAIL_EVENT } from '../../../libs/notifications/src/tokens.js';
import { NotificationsController } from './notifications.controller.js';

describe('NotificationsController', () => {
  const dto = {
    type: 'verify-email' as const,
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'a@b.co',
    token: 'secret-token',
  };

  it('acks missing messageId without sending mail', async () => {
    const mailer = { send: vi.fn() };
    const controller = new NotificationsController(
      mailer as never,
      { storeIfNew: vi.fn(), exists: vi.fn() } as never,
    );
    await controller.onEmail({}, {
      getMessage: () => ({ properties: {} }),
      getChannelRef: () => ({ ack: vi.fn() }),
    } as never);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('sends mail before storing inbox when messageId is present', async () => {
    const order: string[] = [];
    const mailer = {
      send: vi.fn(() => {
        order.push('send');
      }),
    };
    const storeIfNew = vi.fn(async () => {
      order.push('store');
      return true;
    });
    const exists = vi.fn().mockResolvedValue(false);
    const ack = vi.fn();
    const controller = new NotificationsController(
      mailer as never,
      {
        storeIfNew,
        exists,
      } as never,
    );

    await controller.onEmail(dto, {
      getMessage: () => ({ properties: { messageId: 'outbox:9' } }),
      getChannelRef: () => ({ ack }),
    } as never);

    expect(order).toEqual(['send', 'store']);
    expect(mailer.send).toHaveBeenCalledWith(dto);
    expect(storeIfNew).toHaveBeenCalledWith({
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

  it('does not store or ack when send throws', async () => {
    const mailer = {
      send: vi.fn(() => {
        throw new Error('smtp down');
      }),
    };
    const storeIfNew = vi.fn();
    const ack = vi.fn();
    const controller = new NotificationsController(
      mailer as never,
      {
        storeIfNew,
        exists: vi.fn().mockResolvedValue(false),
      } as never,
    );

    await expect(
      controller.onEmail(dto, {
        getMessage: () => ({ properties: { messageId: 'outbox:9' } }),
        getChannelRef: () => ({ ack }),
      } as never),
    ).rejects.toThrow('smtp down');
    expect(storeIfNew).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it('acks duplicate messageId without sending mail', async () => {
    const mailer = { send: vi.fn() };
    const storeIfNew = vi.fn().mockResolvedValue(true);
    const exists = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const ack = vi.fn();
    const controller = new NotificationsController(
      mailer as never,
      {
        storeIfNew,
        exists,
      } as never,
    );
    const context = {
      getMessage: () => ({ properties: { messageId: 'outbox:9' } }),
      getChannelRef: () => ({ ack }),
    } as never;

    await controller.onEmail(dto, context);
    await controller.onEmail(dto, context);

    expect(exists).toHaveBeenCalledTimes(2);
    expect(storeIfNew).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(storeIfNew.mock.calls[0]?.[0])).not.toContain(
      'secret-token',
    );
    expect(mailer.send).toHaveBeenCalledOnce();
    expect(mailer.send).toHaveBeenCalledWith(dto);
    expect(ack).toHaveBeenCalledTimes(2);
  });
});
