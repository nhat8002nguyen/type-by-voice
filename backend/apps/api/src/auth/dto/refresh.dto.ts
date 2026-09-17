import { IsString } from 'class-validator';
import { ClientIdentityDto } from './client-identity.dto.js';

export class RefreshDto extends ClientIdentityDto {
  @IsString()
  refreshToken: string;
}
