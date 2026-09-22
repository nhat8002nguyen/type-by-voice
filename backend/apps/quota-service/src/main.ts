import { isObserveEnabled } from '@app/tracing';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import {
  ObserveInstrument,
  QuotaServiceModule,
} from './quota-service.module.js';

function natsServerUrl(): string {
  const host = process.env.NATS_SERVER_HOST ?? 'nats-server';
  return host.includes(':') ? host : `${host}:4222`;
}

async function bootstrap() {
  const app = await NestFactory.create(
    QuotaServiceModule,
    isObserveEnabled() ? { instrument: ObserveInstrument } : {},
  );
  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.NATS,
      options: {
        servers: [natsServerUrl()],
        queue: 'quota-service',
      },
    },
    { inheritAppConfig: true },
  );
  await app.startAllMicroservices();
  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();
