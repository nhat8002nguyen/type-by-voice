import { Module } from '@nestjs/common';
import { SpeechServiceController } from './speech-service.controller.js';
import { SpeechServiceService } from './speech-service.service.js';

@Module({
  imports: [],
  controllers: [SpeechServiceController],
  providers: [SpeechServiceService],
})
export class SpeechServiceModule {}
