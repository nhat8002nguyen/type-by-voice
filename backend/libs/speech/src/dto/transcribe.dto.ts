import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID } from 'class-validator';

export class TranscribeRequestDto {
  @IsUUID('4')
  requestId: string;

  @IsOptional()
  @IsIn(['en', 'vi'])
  language?: 'en' | 'vi';

  @IsOptional()
  @IsBoolean()
  translateToEnglish?: boolean;

  @IsString()
  audioBase64: string;
}

export class TranscribeResponseDto {
  @IsString()
  text: string;

  @IsString()
  provider: string;

  @IsInt()
  providerLatencyMs: number;
}
