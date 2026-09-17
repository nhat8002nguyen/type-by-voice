import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  GroqSpeechProvider,
  ProviderUnavailableError,
} from './groq.provider.js';

describe('GroqSpeechProvider', () => {
  it('posts ogg bytes and returns text plus latency', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        JSON.parse(
          readFileSync(
            new URL(
              '../test/fixtures/groq-transcription.json',
              import.meta.url,
            ),
            'utf8',
          ),
        ),
    });
    const provider = new GroqSpeechProvider({
      apiKey: 'gsk_test',
      fetch: fetchMock,
    });
    const audio = Buffer.from('OggS');
    const result = await provider.transcribe(audio, { language: 'en' });
    expect(result.text).toBe('the transcribed text');
    expect(result.providerLatencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer gsk_test',
    );
  });

  it('maps 5xx to ProviderUnavailableError', async () => {
    const provider = new GroqSpeechProvider({
      apiKey: 'gsk_test',
      fetch: vi
        .fn()
        .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
    });
    await expect(
      provider.transcribe(Buffer.from('OggS'), { language: 'en' }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
