import { isObserveEnabled } from '@app/tracing';
import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { createSpeechProvider } from './groq.provider.js';
import { SpeechController } from './speech.controller.js';
import { SpeechService, SPEECH_PROVIDER } from './speech.service.js';
import { SpeechServiceController } from './speech-service.controller.js';
import { SpeechServiceService } from './speech-service.service.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: isObserveEnabled()
    ? [
        ObserveModule.forRoot({
          appKey: process.env.OBSERVE_APP_KEY ?? '',
          appSecret: process.env.OBSERVE_APP_SECRET ?? '',
          serviceId: 'speech-service',
        }),
      ]
    : [],
  controllers: [SpeechServiceController, SpeechController],
  providers: [
    SpeechServiceService,
    SpeechService,
    {
      provide: SPEECH_PROVIDER,
      useFactory: () => createSpeechProvider(),
    },
  ],
})
export class SpeechServiceModule {}
