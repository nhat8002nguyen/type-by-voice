import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
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
  controllers: [SpeechServiceController],
  providers: [SpeechServiceService],
})
export class SpeechServiceModule {}
