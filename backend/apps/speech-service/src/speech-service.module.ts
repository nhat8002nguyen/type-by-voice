import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { FakeSpeechProvider, GroqSpeechProvider } from './groq.provider.js';
import { SpeechController } from './speech.controller.js';
import { SpeechService, SPEECH_PROVIDER } from './speech.service.js';
import { SpeechServiceController } from './speech-service.controller.js';
import { SpeechServiceService } from './speech-service.service.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? '',
      appSecret: process.env.OBSERVE_APP_SECRET ?? '',
      serviceId: 'speech-service',
    }),
  ],
  controllers: [SpeechServiceController, SpeechController],
  providers: [
    SpeechServiceService,
    SpeechService,
    {
      provide: SPEECH_PROVIDER,
      useFactory: () => {
        const apiKey = process.env.GROQ_API_KEY;
        if (apiKey) {
          return new GroqSpeechProvider({ apiKey });
        }
        return new FakeSpeechProvider();
      },
    },
  ],
})
export class SpeechServiceModule {}
