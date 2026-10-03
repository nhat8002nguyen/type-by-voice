import { Injectable, Logger } from '@nestjs/common';
import type { SpeechProvider } from '@app/speech';

/** createSpeechProvider builds the configured SpeechProvider (Groq or fake) from env. */
export function createSpeechProvider(
  env: NodeJS.Dict<string> = process.env,
): SpeechProvider {
  const apiKey = env.GROQ_API_KEY;
  const requested = env.SPEECH_PROVIDER ?? 'fake';
  if (apiKey) {
    return new GroqSpeechProvider({
      apiKey,
      model: env.GROQ_MODEL,
    });
  }
  if (requested === 'groq' || env.NODE_ENV === 'production') {
    throw new Error(
      'GROQ_API_KEY is required when SPEECH_PROVIDER=groq or NODE_ENV=production',
    );
  }
  return new FakeSpeechProvider();
}

export class FakeSpeechProvider implements SpeechProvider {
  readonly name = 'fake';

  /** transcribe converts audio into text and reports provider latency metadata. */
  async transcribe(
    _audio: Buffer,
    _opts: { language?: string; translateToEnglish?: boolean },
  ): Promise<{ text: string; providerLatencyMs: number }> {
    return { text: 'the transcribed text', providerLatencyMs: 0 };
  }
}

const GROQ_TRANSCRIPTIONS_URL =
  'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_TRANSLATIONS_URL =
  'https://api.groq.com/openai/v1/audio/translations';
const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo';
const TRANSLATION_MODEL = 'whisper-large-v3';

/** resolveGroqModel returns the model id from env with a safe default. */
export function resolveGroqModel(env: NodeJS.Dict<string> = process.env): string {
  const custom = env.GROQ_MODEL?.trim();
  return custom ? custom : DEFAULT_GROQ_MODEL;
}

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
  model?: string;
  fetch?: GroqFetch;
};

@Injectable()
export class GroqSpeechProvider implements SpeechProvider {
  readonly name = 'groq-whisper';
  readonly model: string;

  private readonly logger = new Logger(GroqSpeechProvider.name);
  private readonly apiKey: string;
  private readonly fetchFn: GroqFetch;

  constructor(options: GroqSpeechProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = resolveGroqModel({ GROQ_MODEL: options.model });
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.logger.log(`whisper model=${this.model}`);
  }

  /** transcribe posts one Ogg payload to Groq, transcribing or translating to English in a single call, and reports provider latency. */
  async transcribe(
    audio: Buffer,
    opts: { language?: string; translateToEnglish?: boolean },
  ): Promise<{ text: string; providerLatencyMs: number }> {
    const translate =
      opts.translateToEnglish === true && opts.language !== 'en';
    const url = translate ? GROQ_TRANSLATIONS_URL : GROQ_TRANSCRIPTIONS_URL;
    const body = new FormData();
    body.append('model', translate ? TRANSLATION_MODEL : this.model);
    if (!translate && opts.language !== undefined) {
      body.append('language', opts.language);
    }
    body.append(
      'file',
      new Blob([new Uint8Array(audio)], { type: 'audio/ogg' }),
      'audio.ogg',
    );

    const startedAt = Date.now();
    let response: Awaited<ReturnType<GroqFetch>>;
    try {
      response = await this.fetchFn(url, {
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
          `Groq speech request failed with status ${response.status ?? 'unknown'}`,
        );
      }
      throw new Error(
        `Groq speech request failed with status ${response.status}`,
      );
    }

    const payload = (await response.json()) as { text?: string };
    if (typeof payload.text !== 'string') {
      throw new Error('Groq transcription response missing text');
    }
    return { text: payload.text, providerLatencyMs };
  }
}
