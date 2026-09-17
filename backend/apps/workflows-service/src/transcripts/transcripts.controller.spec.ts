import { Test, TestingModule } from '@nestjs/testing';
import { RmqContext } from '@nestjs/microservices';
import { describe, expect, it, vi } from 'vitest';
import { InboxService } from '../../../../libs/inbox/src/inbox.service.js';
import { WORKFLOWS_CREATE_EVENT } from '../../../../libs/workflows/src/tokens.js';
import { TranscriptsController } from './transcripts.controller.js';
import { TranscriptsService } from './transcripts.service.js';

const dto = {
  userId: 'user-1',
  requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
  text: 'the transcribed text',
  wordCount: 3,
  audioMs: 11800,
};

describe('TranscriptsController', () => {
  let controller: TranscriptsController;
  let inboxService: { store: ReturnType<typeof vi.fn> };
  let transcriptsService: TranscriptsService;

  beforeEach(async () => {
    inboxService = { store: vi.fn().mockResolvedValue({ id: 1 }) };
    transcriptsService = TranscriptsService.withMemory(Buffer.alloc(32, 7));

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TranscriptsController],
      providers: [
        { provide: TranscriptsService, useValue: transcriptsService },
        { provide: InboxService, useValue: inboxService },
      ],
    }).compile();

    controller = module.get(TranscriptsController);
  });

  function contextWith(message: { properties: { messageId?: string } }): {
    context: RmqContext;
    channel: { ack: ReturnType<typeof vi.fn> };
  } {
    const channel = { ack: vi.fn() };
    const context = {
      getChannelRef: () => channel,
      getMessage: () => message,
    } as unknown as RmqContext;
    return { context, channel };
  }

  it('acks missing messageId without storing or creating', async () => {
    const create = vi.spyOn(transcriptsService, 'create');
    const { context, channel } = contextWith({ properties: {} });

    await controller.create(dto, context);

    expect(inboxService.store).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('stores the inbox row and acks without creating', async () => {
    const create = vi.spyOn(transcriptsService, 'create');
    const { context, channel } = contextWith({
      properties: { messageId: 'outbox:9' },
    });

    await controller.create(dto, context);

    expect(inboxService.store).toHaveBeenCalledWith({
      messageId: 'outbox:9',
      type: WORKFLOWS_CREATE_EVENT,
      payload: dto,
    });
    expect(channel.ack).toHaveBeenCalledWith({
      properties: { messageId: 'outbox:9' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('does not ack when store fails', async () => {
    inboxService.store.mockRejectedValue(new Error('db down'));
    const { context, channel } = contextWith({
      properties: { messageId: 'outbox:9' },
    });

    await expect(controller.create(dto, context)).rejects.toThrow('db down');
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('lists, gets, searches, deletes, and exports over NATS', async () => {
    await transcriptsService.create(dto);
    const listed = await controller.list({ userId: 'user-1', limit: 10 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].text).toBe('the transcribed text');

    const found = await controller.get({
      userId: 'user-1',
      id: listed.items[0].id,
    });
    expect(found?.text).toBe('the transcribed text');

    const hits = await controller.search({
      userId: 'user-1',
      q: 'transcribed',
    });
    expect(hits).toHaveLength(1);

    const exported = await controller.export({ userId: 'user-1' });
    expect(exported).toHaveLength(1);

    await controller.delete({ userId: 'user-1', id: listed.items[0].id });
    expect(
      await controller.search({ userId: 'user-1', q: 'transcribed' }),
    ).toHaveLength(0);
    expect(await controller.export({ userId: 'user-1' })).toHaveLength(0);
  });
});
