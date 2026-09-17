export interface SpeechProvider {
  readonly name: string;
  transcribe(
    audio: Buffer,
    opts: { language: string },
  ): Promise<{
    text: string;
    providerLatencyMs: number;
  }>;
}
