import { IsInt, IsString, IsUUID } from 'class-validator';

export class CreateTranscriptDto {
  @IsUUID('4')
  userId: string;

  @IsUUID('4')
  requestId: string;

  @IsString()
  text: string;

  @IsInt()
  wordCount: number;

  @IsInt()
  audioMs: number;
}
