import { isObserveEnabled } from '@app/tracing';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import {
  ObserveInstrument,
  WorkflowsServiceModule,
} from './workflows-service.module.js';

/** natsServerUrl resolves the NATS server URL from the environment. */
function natsServerUrl(): string {
  const host = process.env.NATS_SERVER_HOST ?? 'nats-server';
  return host.includes(':') ? host : `${host}:4222`;
}

/** bootstrap starts the workflows-service Nest microservice process. */
async function bootstrap() {
  const app = await NestFactory.create(
    WorkflowsServiceModule,
    /** isObserveEnabled reports whether Nest observe/tracing instrumentation should load. */
    isObserveEnabled() ? { instrument: ObserveInstrument } : {},
  );
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_HOST ?? 'amqp://rabbitmq:5672'],
        queue: 'workflows-service',
        noAck: false,
      },
    },
    { inheritAppConfig: true },
  );
  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.NATS,
      options: {
        servers: [natsServerUrl()],
        queue: 'workflows-service',
      },
    },
    { inheritAppConfig: true },
  );
  await app.startAllMicroservices();
  await app.listen(process.env.PORT ?? 3003);
}
void bootstrap();
