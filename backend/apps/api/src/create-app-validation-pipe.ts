import { ValidationPipe } from '@nestjs/common';

/** createAppValidationPipe builds the shared ValidationPipe used by api bootstrap. */
export function createAppValidationPipe() {
  return new ValidationPipe({ transform: true, whitelist: true });
}
