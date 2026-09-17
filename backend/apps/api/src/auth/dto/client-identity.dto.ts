import { IsIn, IsString, IsUUID } from 'class-validator';
import type { Platform } from '@type-by-voice/dictation-v1';

export class ClientIdentityDto {
  @IsIn(['macos', 'windows', 'ios', 'android'])
  platform: Platform;

  @IsString()
  clientVersion: string;

  @IsUUID('4')
  deviceId: string;
}
