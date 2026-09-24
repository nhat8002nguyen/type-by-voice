import { Injectable } from '@nestjs/common';

@Injectable()
export class SpeechServiceService {
  /** getHello returns the scaffold hello payload for speech-service. */
  getHello(): string {
    return 'Hello World!';
  }
}
