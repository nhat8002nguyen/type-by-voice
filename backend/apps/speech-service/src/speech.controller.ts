import { Controller, Inject } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { SpeechProvider } from '@app/speech';
import { TranscribeRequestDto, TranscribeResponseDto } from '@app/speech';
import { SPEECH_PROVIDER, SpeechService } from './speech.service.js';

@Controller()
export class SpeechController {
  constructor(
    @Inject(SPEECH_PROVIDER) private readonly provider: SpeechProvider,
    private readonly speechService: SpeechService,
  ) {}

  @MessagePattern('speech.transcribe')
  async transcribe(
    @Payload() dto: TranscribeRequestDto,
  ): Promise<TranscribeResponseDto> {
    const result = await this.provider.transcribe(
      Buffer.from(dto.audioBase64, 'base64'),
      {
        language: dto.language,
      },
    );
    this.speechService.logCompleted(dto.requestId, result.providerLatencyMs);
    return {
      text: result.text,
      provider: this.provider.name,
      providerLatencyMs: result.providerLatencyMs,
    };
  }
}
