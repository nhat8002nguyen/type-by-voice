import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { AccessAuthGuard } from './access-auth.guard.js';
import type { RequestUser } from './access-auth.guard.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './current-user.decorator.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshDto } from './dto/refresh.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { VerifyEmailDto } from './dto/verify-email.dto.js';
import { InvalidIdentityFilter } from './invalid-identity.filter.js';
import { RateLimitGuard, clientIp } from '../rate-limit/rate-limit.guard.js';

@Controller('v1/auth')
@UseFilters(InvalidIdentityFilter)
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  /** register handles POST /v1/auth/register and returns issued tokens. */
  register(
    @Body() dto: RegisterDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.authService.register(dto, userAgent);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  /** login handles POST /v1/auth/login with client IP for rate limiting. */
  login(
    @Body() dto: LoginDto,
    @Req() req: { ip?: string; socket?: { remoteAddress?: string } },
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.authService.login(dto, userAgent, clientIp(req));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  /** refresh handles POST /v1/auth/refresh for device session rotation. */
  refresh(@Body() dto: RefreshDto, @Headers('user-agent') userAgent?: string) {
    return this.authService.refresh(dto.refreshToken, dto, userAgent);
  }

  @Post('logout')
  @UseGuards(AccessAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  /** logout handles POST /v1/auth/logout for the authenticated session. */
  logout(@CurrentUser() user: RequestUser) {
    return this.authService.logout(user.sessionId);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  /** verifyEmail handles POST /v1/auth/verify-email with a one-time token. */
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto.token);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  /** forgotPassword handles POST /v1/auth/forgot-password without revealing whether the email exists. */
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  /** resetPassword handles POST /v1/auth/reset-password with a reset token and new password. */
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.password);
  }
}
