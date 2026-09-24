import { DynamicModule, Module } from '@nestjs/common';
import { Transport } from '@nestjs/microservices';
import { RmqClientProxy } from './rmq-client.proxy.js';
import { createTracedClientModule } from './traced-client.module-factory.js';
import { ClientRegistration } from './tracing-client.types.js';

@Module({})
export class RmqClientModule {
  /** register builds a Nest dynamic module for a traced RMQ ClientProxy. */
  static register(registrations: ClientRegistration[]): DynamicModule {
    const urls = [process.env.RABBITMQ_HOST ?? 'amqp://rabbitmq:5672'];

    return createTracedClientModule({
      module: RmqClientModule,
      registrations,
      clientOptions: ({ queue }, name) => ({
        name,
        transport: Transport.RMQ,
        options: { urls, queue },
      }),
      createProxy: (client, traceContext, inquirer) =>
        new RmqClientProxy(client, traceContext, inquirer),
    });
  }
}
