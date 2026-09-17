import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import {
  ObserveInstrument,
  SpeechServiceModule,
} from './speech-service.module.js';

function natsServerUrl(): string {
  const host = process.env.NATS_SERVER_HOST ?? 'nats-server';
  return host.includes(':') ? host : `${host}:4222`;
}

async function bootstrap() {
  const app = await NestFactory.create(SpeechServiceModule, {
    instrument: ObserveInstrument,
  });
  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.NATS,
      options: {
        servers: [natsServerUrl()],
        queue: 'speech-service',
      },
    },
    { inheritAppConfig: true },
  );
  await app.startAllMicroservices();
  await app.listen(process.env.PORT ?? 3002);
}
void bootstrap();
