import { IsBoolean, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import type { Platform, QuotaSnapshot } from '@type-by-voice/dictation-v1';

export class CheckQuotaRequestDto {
  @IsUUID('4')
  userId: string;

  @IsUUID('4')
  sessionId: string;

  @IsIn(['macos', 'windows', 'ios', 'android', 'linux'])
  platform: Platform;

  @IsString()
  clientVersion: string;

  @IsUUID('4')
  deviceId: string;
}

export class CheckQuotaResponseDto {
  @IsBoolean()
  allowed: boolean;

  @IsOptional()
  @IsIn(['quota_exceeded', 'audio_cap_exceeded'])
  reason?: 'quota_exceeded' | 'audio_cap_exceeded';

  quota: QuotaSnapshot;
}
