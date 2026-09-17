import { Inject, Injectable } from '@nestjs/common';
import { NatsClientProxy } from './nats-client.proxy.js';

export const QUOTA_SERVICE = Symbol('QUOTA_SERVICE');

@Injectable()
export class FirstConsumer {
  constructor(@Inject(QUOTA_SERVICE) readonly client: NatsClientProxy) {}
}

@Injectable()
export class SecondConsumer {
  constructor(@Inject(QUOTA_SERVICE) readonly client: NatsClientProxy) {}
}
