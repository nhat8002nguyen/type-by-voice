import { isObserveEnabled } from '@app/tracing';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import {
  ObserveInstrument,
  SpeechServiceModule,
} from './speech-service.module.js';

/** natsServerUrl resolves the NATS server URL from the environment. */
function natsServerUrl(): string {
  const host = process.env.NATS_SERVER_HOST ?? 'nats-server';
  return host.includes(':') ? host : `${host}:4222`;
}

/** bootstrap starts the speech-service Nest microservice process. */
async function bootstrap() {
  const app = await NestFactory.create(
    SpeechServiceModule,
    /** isObserveEnabled reports whether Nest observe/tracing instrumentation should load. */
    isObserveEnabled() ? { instrument: ObserveInstrument } : {},
  );
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
