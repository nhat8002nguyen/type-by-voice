import { ClientProxy, RmqRecord } from '@nestjs/microservices';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { TraceContextService } from '../trace-context.service.js';
import { TraceService } from '../trace.service.js';
import { RmqClientProxy } from './rmq-client.proxy.js';

class NotificationsPublisher {}

describe('RmqClientProxy', () => {
  let traceContext: TraceContextService;
  let client: { send: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> };
  let proxy: RmqClientProxy;

  beforeEach(() => {
    traceContext = new TraceContextService(new TraceService());
    client = {
      send: vi.fn(() => of('ok')),
      emit: vi.fn(() => of(undefined)),
    };
    proxy = new RmqClientProxy(
      client as unknown as ClientProxy,
      traceContext,
      new NotificationsPublisher(),
    );
  });

  it('is labelled with the class that injected it', () => {
    expect(proxy.context).toBe('NotificationsPublisher');
  });

  it('attaches the ambient trace id as an amqp header on emit', () => {
    traceContext.run('trace-1', () =>
      proxy.emit('notifications.create', { alarmId: 'a1' }),
    );

    const [pattern, record] = client.emit.mock.calls[0] as [string, RmqRecord];
    expect(pattern).toBe('notifications.create');
    expect(record).toBeInstanceOf(RmqRecord);
    expect(record.data).toEqual({ alarmId: 'a1' });
    expect(record.options?.headers).toEqual({ 'x-trace-id': 'trace-1' });
  });

  it('attaches the ambient trace id as an amqp header on send', () => {
    traceContext.run('trace-1', () =>
      proxy.send('notifications.create', { alarmId: 'a1' }),
    );

    const [, record] = client.send.mock.calls[0] as [string, RmqRecord];
    expect(record.options?.headers).toEqual({ 'x-trace-id': 'trace-1' });
  });

  it('sends the payload untouched outside a trace scope', () => {
    proxy.emit('notifications.create', { alarmId: 'a1' });

    expect(client.emit).toHaveBeenCalledWith('notifications.create', {
      alarmId: 'a1',
    });
  });

  it('preserves caller-supplied options when merging into an RmqRecord', () => {
    const existing = new RmqRecord(
      { alarmId: 'a1' },
      { messageId: 'outbox:1', headers: { 'x-tenant': 'acme' } },
    );

    traceContext.run('trace-1', () =>
      proxy.emit('notifications.create', existing),
    );

    const [, record] = client.emit.mock.calls[0] as [string, RmqRecord];
    expect(record.data).toEqual({ alarmId: 'a1' });
    expect(record.options?.messageId).toBe('outbox:1');
    expect(record.options?.headers).toEqual({
      'x-tenant': 'acme',
      'x-trace-id': 'trace-1',
    });
  });
});
