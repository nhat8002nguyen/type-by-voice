import { Controller, Get } from '@nestjs/common';
import { SpeechServiceService } from './speech-service.service.js';

@Controller()
export class SpeechServiceController {
  constructor(private readonly speechServiceService: SpeechServiceService) {}

  @Get()
  getHello(): string {
    return this.speechServiceService.getHello();
  }
}
