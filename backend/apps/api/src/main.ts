import { isObserveEnabled } from '@app/tracing';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule, ObserveInstrument } from './app.module.js';
import { createAppValidationPipe } from './create-app-validation-pipe.js';

/** bootstrap creates the Nest api app (HTTP + WS + microservices) and listens. */
async function bootstrap() {
  const app = await NestFactory.create(
    AppModule,
    /** isObserveEnabled reports whether Nest observe/tracing instrumentation should load. */
    isObserveEnabled() ? { instrument: ObserveInstrument } : {},
  );
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalPipes(createAppValidationPipe());
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
