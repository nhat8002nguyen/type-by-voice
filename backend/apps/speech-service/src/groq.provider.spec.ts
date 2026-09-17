import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  createSpeechProvider,
  FakeSpeechProvider,
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

  it('fake provider returns the transcribed text without Groq', async () => {
    const provider = new FakeSpeechProvider();
    const result = await provider.transcribe(Buffer.from('OggS'), {
      language: 'en',
    });
    expect(result.text).toBe('the transcribed text');
    expect(provider.name).toBe('fake');
  });

  it('selects fake when SPEECH_PROVIDER is fake and Groq key is absent', () => {
    const provider = createSpeechProvider({ SPEECH_PROVIDER: 'fake' });
    expect(provider).toBeInstanceOf(FakeSpeechProvider);
  });

  it('selects groq when GROQ_API_KEY is present even if SPEECH_PROVIDER is fake', () => {
    const provider = createSpeechProvider({
      SPEECH_PROVIDER: 'fake',
      GROQ_API_KEY: 'gsk_test',
    });
    expect(provider).toBeInstanceOf(GroqSpeechProvider);
  });

  it('selects groq when SPEECH_PROVIDER is groq and key is present', () => {
    const provider = createSpeechProvider({
      SPEECH_PROVIDER: 'groq',
      GROQ_API_KEY: 'gsk_test',
    });
    expect(provider).toBeInstanceOf(GroqSpeechProvider);
  });

  it('throws when SPEECH_PROVIDER is groq and GROQ_API_KEY is missing', () => {
    expect(() =>
      createSpeechProvider({ SPEECH_PROVIDER: 'groq' }),
    ).toThrow(/GROQ_API_KEY/);
  });

  it('throws in production when GROQ_API_KEY is missing', () => {
    expect(() =>
      createSpeechProvider({ NODE_ENV: 'production' }),
    ).toThrow(/GROQ_API_KEY/);
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
