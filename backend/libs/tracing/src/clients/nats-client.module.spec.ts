import { Test } from '@nestjs/testing';
import { TracingModule } from '../tracing.module.js';
import {
  FirstConsumer,
  QUOTA_SERVICE,
  SecondConsumer,
} from './nats-client.module.fixture.js';
import { NatsClientModule } from './nats-client.module.js';
import { NatsClientProxy } from './nats-client.proxy.js';

describe('NatsClientModule', () => {
  it('gives every consumer its own proxy labelled with its own name', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TracingModule,
        NatsClientModule.register([
          { name: QUOTA_SERVICE, queue: 'quota-service' },
        ]),
      ],
      providers: [FirstConsumer, SecondConsumer],
    }).compile();

    const first = moduleRef.get(FirstConsumer);
    const second = moduleRef.get(SecondConsumer);

    expect(first.client).toBeInstanceOf(NatsClientProxy);
    expect(first.client).not.toBe(second.client);
    expect(first.client.context).toBe('FirstConsumer');
    expect(second.client.context).toBe('SecondConsumer');

    await moduleRef.close();
  });
});
