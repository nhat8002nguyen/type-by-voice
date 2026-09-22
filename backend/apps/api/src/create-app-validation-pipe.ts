import { ValidationPipe } from '@nestjs/common';

export function createAppValidationPipe() {
  return new ValidationPipe({ transform: true, whitelist: true });
}
