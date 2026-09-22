import { ClientProxy } from '@nestjs/microservices';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { Outbox } from './entities/outbox.entity.js';
import { OutboxProcessor } from './outbox.processor.js';
import { OutboxService } from './outbox.service.js';

describe('OutboxProcessor', () => {
  it('emits with messageId outbox:{id}', async () => {
    const emit = vi.fn().mockReturnValue(of(undefined));
    const processor = new OutboxProcessor(
      {} as OutboxService,
      { emit } as unknown as ClientProxy,
      'workflows-service',
    );
    const message = {
      id: 42,
      type: 'workflows.create',
      payload: { name: 'wf', buildingId: 1 },
    } as unknown as Outbox;

    await processor.dispatchWorkflowEvent(message);

    expect(emit).toHaveBeenCalledTimes(1);
    const [pattern, record] = emit.mock.calls[0] as [
      string,
      { data: unknown; options?: { messageId?: string } },
    ];
    expect(pattern).toBe('workflows.create');
    expect(record.data).toEqual(message.payload);
    expect(record.options?.messageId).toBe('outbox:42');
  });

  it('emits to the client matching message.target', async () => {
    const workflowsEmit = vi.fn().mockReturnValue(of(undefined));
    const notificationsEmit = vi.fn().mockReturnValue(of(undefined));
    const processor = new OutboxProcessor(
      {} as OutboxService,
      {
        emit: workflowsEmit,
      } as unknown as ClientProxy,
      'WORKFLOWS_SERVICE',
      [
        {
          target: 'WORKFLOWS_SERVICE',
          client: { emit: workflowsEmit } as unknown as ClientProxy,
        },
        {
          target: 'NOTIFICATIONS_SERVICE',
          client: { emit: notificationsEmit } as unknown as ClientProxy,
        },
      ],
    );

    await processor.dispatchWorkflowEvent({
      id: 3,
      type: 'notifications.email',
      target: 'NOTIFICATIONS_SERVICE',
      payload: { type: 'verify-email', userId: 'user-1', email: 'a@b.co' },
    } as unknown as Outbox);

    expect(notificationsEmit).toHaveBeenCalledTimes(1);
    expect(workflowsEmit).not.toHaveBeenCalled();
    const [pattern, record] = notificationsEmit.mock.calls[0] as [
      string,
      { data: unknown; options?: { messageId?: string } },
    ];
    expect(pattern).toBe('notifications.email');
    expect(record.options?.messageId).toBe('outbox:3');
  });
});
