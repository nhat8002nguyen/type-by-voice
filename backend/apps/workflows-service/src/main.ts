import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import {
  ObserveInstrument,
  WorkflowsServiceModule,
} from './workflows-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(WorkflowsServiceModule, {
    instrument: ObserveInstrument,
  });
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
  await app.startAllMicroservices();
  await app.listen(process.env.PORT ?? 3003);
}
void bootstrap();
