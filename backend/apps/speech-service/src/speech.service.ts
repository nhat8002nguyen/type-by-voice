import { Injectable, Logger } from '@nestjs/common';

export const SPEECH_PROVIDER = Symbol('SPEECH_PROVIDER');

@Injectable()
export class SpeechService {
  private readonly logger = new Logger(SpeechService.name);

  logCompleted(requestId: string, providerLatencyMs: number): void {
    this.logger.log(
      `requestId=${requestId} providerLatencyMs=${providerLatencyMs}`,
    );
  }
}
