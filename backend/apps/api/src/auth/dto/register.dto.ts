import { IsEmail, IsString } from 'class-validator';
import { ClientIdentityDto } from './client-identity.dto.js';

export class RegisterDto extends ClientIdentityDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}
