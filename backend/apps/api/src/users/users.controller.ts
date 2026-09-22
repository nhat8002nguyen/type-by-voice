import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  UseGuards,
} from '@nestjs/common';
import { AccessAuthGuard } from '../auth/access-auth.guard.js';
import type { RequestUser } from '../auth/access-auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';

@Controller('v1/me')
@UseGuards(AccessAuthGuard)
export class UsersController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  me(@CurrentUser() user: RequestUser) {
    return this.authService.getMe(user.id);
  }

  @Get('sessions')
  listSessions(@CurrentUser() user: RequestUser) {
    return this.authService.listSessions(user.id);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeSession(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.authService.revokeSession(user.id, id);
  }
}
