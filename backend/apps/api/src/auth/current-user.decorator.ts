import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { REQUEST_USER_KEY, type RequestUser } from './access-auth.guard.js';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser => {
    return ctx.switchToHttp().getRequest()[REQUEST_USER_KEY];
  },
);
