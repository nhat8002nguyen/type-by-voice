import { isObserveEnabled } from '@app/tracing';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule, ObserveInstrument } from './app.module.js';
import { createAppValidationPipe } from './create-app-validation-pipe.js';

async function bootstrap() {
  const app = await NestFactory.create(
    AppModule,
    isObserveEnabled() ? { instrument: ObserveInstrument } : {},
  );
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalPipes(createAppValidationPipe());
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
