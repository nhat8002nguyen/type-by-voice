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
});
