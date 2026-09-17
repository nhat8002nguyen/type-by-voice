import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module.js';
import { createAppValidationPipe } from './create-app-validation-pipe.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  app.useGlobalPipes(createAppValidationPipe());
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
