import { readFileSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RmqClientModule } from '../../tracing/src/clients/rmq-client.module.js';
import { Outbox } from './entities/outbox.entity.js';
import { OutboxModule } from './outbox.module.js';
import { OutboxProcessor } from './outbox.processor.js';

const WORKFLOWS_SERVICE = Symbol('WORKFLOWS_SERVICE');

describe('OutboxModule', () => {
  it('does not import a product app path', () => {
    const src = readFileSync(new URL('./outbox.module.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/apps\//);
    expect(src).toMatch(/OutboxModule\.register/);
  });

  it('injects the RMQ client registered by RmqClientModule', async () => {
    const fakeDataSource = {
      entityMetadatas: [],
      options: { type: 'postgres' },
      getRepository: () => ({
        find: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        {
          module: class FakeTypeOrmRoot {},
          global: true,
          providers: [{ provide: DataSource, useValue: fakeDataSource }],
          exports: [DataSource],
        },
        RmqClientModule.register([
          { name: WORKFLOWS_SERVICE, queue: 'workflows-service' },
        ]),
        OutboxModule.register({
          target: WORKFLOWS_SERVICE,
          clientToken: WORKFLOWS_SERVICE,
        }),
      ],
    }).compile();

    const processor = moduleRef.get(OutboxProcessor);
    const emit = vi
      .spyOn(processor['client'], 'emit')
      .mockReturnValue(of(undefined));

    await processor.dispatchWorkflowEvent({
      id: 7,
      type: 'workflows.create',
      payload: { name: 'wf' },
    } as Outbox);

    expect(emit).toHaveBeenCalledTimes(1);
    const [pattern, record] = emit.mock.calls[0] as [
      string,
      { options?: { messageId?: string } },
    ];
    expect(pattern).toBe('workflows.create');
    expect(record.options?.messageId).toBe('outbox:7');

    await moduleRef.close();
  });
});
