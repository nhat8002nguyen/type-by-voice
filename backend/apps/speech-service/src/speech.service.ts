import { Injectable, Logger } from '@nestjs/common';

export const SPEECH_PROVIDER = Symbol('SPEECH_PROVIDER');

@Injectable()
export class SpeechService {
  private readonly logger = new Logger(SpeechService.name);

  /** logCompleted records a successful speech request metric/log line without logging transcript text. */
  logCompleted(
    requestId: string,
    providerLatencyMs: number,
    model?: string,
    translateToEnglish?: boolean,
  ): void {
    const modelPart = model ? ` model=${model}` : '';
    const translatePart = translateToEnglish ? ' translate=true' : '';
    this.logger.log(
      `requestId=${requestId}${modelPart}${translatePart} providerLatencyMs=${providerLatencyMs}`,
    );
  }
}
