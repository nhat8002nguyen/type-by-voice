import { Injectable } from '@nestjs/common';
import type { SpeechProvider } from '@app/speech';

export class FakeSpeechProvider implements SpeechProvider {
  readonly name = 'fake';

  async transcribe(
    _audio: Buffer,
    _opts: { language: string },
  ): Promise<{ text: string; providerLatencyMs: number }> {
    return { text: 'the transcribed text', providerLatencyMs: 0 };
  }
}

const GROQ_TRANSCRIPTIONS_URL =
  'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';

export class ProviderUnavailableError extends Error {
  constructor(message = 'Speech provider unavailable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderUnavailableError';
  }
}

export type GroqFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'json'> & { status?: number }>;

export type GroqSpeechProviderOptions = {
  apiKey: string;
  fetch?: GroqFetch;
};

@Injectable()
export class GroqSpeechProvider implements SpeechProvider {
  readonly name = 'groq-whisper';

  private readonly apiKey: string;
  private readonly fetchFn: GroqFetch;

  constructor(options: GroqSpeechProviderOptions) {
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async transcribe(
    audio: Buffer,
    opts: { language: string },
  ): Promise<{ text: string; providerLatencyMs: number }> {
    const body = new FormData();
    body.append('model', GROQ_MODEL);
    body.append('language', opts.language);
    body.append(
      'file',
      new Blob([new Uint8Array(audio)], { type: 'audio/ogg' }),
      'audio.ogg',
    );

    const startedAt = Date.now();
    let response: Awaited<ReturnType<GroqFetch>>;
    try {
      response = await this.fetchFn(GROQ_TRANSCRIPTIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
      });
    } catch (error) {
      throw new ProviderUnavailableError('Speech provider unavailable', {
        cause: error,
      });
    }
    const providerLatencyMs = Date.now() - startedAt;

    if (!response.ok) {
      if ((response.status ?? 500) >= 500) {
        throw new ProviderUnavailableError(
          `Groq transcription failed with status ${response.status ?? 'unknown'}`,
        );
      }
      throw new Error(
        `Groq transcription failed with status ${response.status}`,
      );
    }

    const payload = (await response.json()) as { text?: string };
    if (typeof payload.text !== 'string') {
      throw new Error('Groq transcription response missing text');
    }
    return { text: payload.text, providerLatencyMs };
  }
}
