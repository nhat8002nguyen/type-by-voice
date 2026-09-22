import { IsIn, IsInt, IsString, IsUUID } from 'class-validator';

export class TranscribeRequestDto {
  @IsUUID('4')
  requestId: string;

  @IsIn(['en'])
  language: 'en';

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
