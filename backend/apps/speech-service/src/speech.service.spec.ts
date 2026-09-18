import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechService } from './speech.service.js';

describe('SpeechService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes the whisper model in the completed log', () => {
    const spy = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const service = new SpeechService();
    service.logCompleted('req-1', 42, 'whisper-large-v3');
    expect(spy).toHaveBeenCalledWith(
      'requestId=req-1 model=whisper-large-v3 providerLatencyMs=42',
    );
  });
});
