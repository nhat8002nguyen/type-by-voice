import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID } from 'class-validator';
import type { Platform, QuotaSnapshot } from '@type-by-voice/dictation-v1';

export class CommitQuotaRequestDto {
  @IsUUID('4')
  userId: string;

  @IsUUID('4')
  requestId: string;

  @IsUUID('4')
  sessionId: string;

  @IsIn(['macos', 'windows', 'ios', 'android', 'linux'])
  platform: Platform;

  @IsString()
  clientVersion: string;

  @IsInt()
  audioMs: number;

  @IsInt()
  wordCount: number;

  @IsString()
  provider: string;

  @IsInt()
  providerLatencyMs: number;

  @IsInt()
  estimatedCostMicros: number;

  @IsOptional()
  @IsIn(['en', 'vi'])
  language?: 'en' | 'vi';

  @IsOptional()
  @IsBoolean()
  translateToEnglish?: boolean;
}

export class CommitQuotaResponseDto {
  quota: QuotaSnapshot;
}
