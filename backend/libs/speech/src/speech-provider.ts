export interface SpeechProvider {
  readonly name: string;
  readonly model?: string;
  transcribe(
    audio: Buffer,
    opts: { language: string },
  ): Promise<{
    text: string;
    providerLatencyMs: number;
  }>;
}
