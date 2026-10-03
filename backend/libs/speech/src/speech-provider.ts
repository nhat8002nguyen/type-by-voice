export interface SpeechProvider {
  readonly name: string;
  readonly model?: string;
  transcribe(
    audio: Buffer,
    opts: { language?: string; translateToEnglish?: boolean },
  ): Promise<{
    text: string;
    providerLatencyMs: number;
  }>;
}
