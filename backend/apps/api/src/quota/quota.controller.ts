import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import {
  QUOTA_CHECK_PATTERN,
  QUOTA_SERVICE,
  type CheckQuotaRequestDto,
  type CheckQuotaResponseDto,
} from '@app/quota';
import { firstValueFrom } from 'rxjs';
import {
  AccessAuthGuard,
  type RequestUser,
} from '../auth/access-auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';

@Controller('v1/me')
@UseGuards(AccessAuthGuard)
export class MeQuotaController {
  constructor(@Inject(QUOTA_SERVICE) private readonly quota: ClientProxy) {}

  @Get('quota')
  /** snapshot returns the caller's current quota snapshot from quota-service. */
  snapshot(@CurrentUser() user: RequestUser) {
    return this.get({
      userId: user.id,
      sessionId: user.sessionId,
      platform: user.platform,
      clientVersion: user.clientVersion,
      deviceId: user.deviceId,
    });
  }

  /** get returns the caller's current quota snapshot from quota-service. */
  async get(identity: CheckQuotaRequestDto) {
    const result = await firstValueFrom(
      this.quota.send<CheckQuotaResponseDto, CheckQuotaRequestDto>(
        QUOTA_CHECK_PATTERN,
        identity,
      ),
    );
    return result.quota;
  }
}
