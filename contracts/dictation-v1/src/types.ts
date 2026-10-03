import type { ErrorCode, Platform } from './constants.js';

export interface QuotaSnapshot {
  unit: 'words';
  limit: number | null;
  used: number;
  resetAt: string;
}

export interface StartMessage {
  type: 'start';
  requestId: string;
  codec: 'opus';
  container: 'ogg';
  sampleRate: 16000;
  channels: 1;
  language?: 'en' | 'vi';
  translateToEnglish?: boolean;
  platform: Platform;
  clientVersion: string;
  deviceId: string;
  listInHistory: boolean;
}

export interface StopMessage {
  type: 'stop';
  requestId: string;
  durationMs: number;
}

export interface CancelMessage {
  type: 'cancel';
  requestId: string;
}

export type ClientTextMessage = StartMessage | StopMessage | CancelMessage;

export interface ReadyMessage {
  type: 'ready';
  requestId: string;
  maxDurationMs: number;
  quota: QuotaSnapshot;
}

export interface FinalMessage {
  type: 'final';
  requestId: string;
  text: string;
  wordCount: number;
  audioMs: number;
  quota: QuotaSnapshot;
}

export interface ErrorMessage {
  type: 'error';
  requestId: string;
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type ServerTextMessage = ReadyMessage | FinalMessage | ErrorMessage;
