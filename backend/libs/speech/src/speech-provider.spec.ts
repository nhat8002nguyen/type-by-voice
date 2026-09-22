import { describe, expect, it } from 'vitest';
import type { SpeechProvider } from './speech-provider.js';

describe('SpeechProvider', () => {
  it('returns text and providerLatencyMs', async () => {
    const fake: SpeechProvider = {
      name: 'fake',
      async transcribe() {
        return { text: 'hello', providerLatencyMs: 12 };
      },
    };
    await expect(fake.transcribe(Buffer.from(''), { language: 'en' })).resolves.toEqual({
      text: 'hello',
      providerLatencyMs: 12,
    });
  });
});
