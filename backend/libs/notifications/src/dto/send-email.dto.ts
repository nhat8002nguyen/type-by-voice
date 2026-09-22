import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import type { QuotaSnapshot } from '@type-by-voice/dictation-v1';

export class SendEmailDto {
  @IsIn(['verify-email', 'reset-password', 'quota-warning', 'quota-exhausted'])
  type: 'verify-email' | 'reset-password' | 'quota-warning' | 'quota-exhausted';

  @IsUUID('4')
  userId: string;

  @IsString()
  email: string;

  @IsOptional()
  @IsString()
  token?: string;

  @IsOptional()
  quota?: QuotaSnapshot;
}
