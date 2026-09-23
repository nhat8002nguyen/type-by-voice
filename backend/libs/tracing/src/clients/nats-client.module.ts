import { DynamicModule, Module } from '@nestjs/common';
import { Transport } from '@nestjs/microservices';
import { NatsClientProxy } from './nats-client.proxy.js';
import { createTracedClientModule } from './traced-client.module-factory.js';
import { ClientRegistration } from './tracing-client.types.js';

@Module({})
export class NatsClientModule {
  /** register builds a Nest dynamic module for a traced NATS ClientProxy. */
  static register(registrations: ClientRegistration[]): DynamicModule {
    const servers = [process.env.NATS_SERVER_HOST ?? 'nats-server:4222'];

    return createTracedClientModule({
      module: NatsClientModule,
      registrations,
      clientOptions: ({ queue }, name) => ({
        name,
        transport: Transport.NATS,
        options: { servers, queue },
      }),
      createProxy: (client, traceContext, inquirer) =>
        new NatsClientProxy(client, traceContext, inquirer),
    });
  }
}
