import { BadRequestException } from '@nestjs/common';
import { PLATFORMS, type Platform } from '@type-by-voice/dictation-v1';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** assertClientIdentity rejects requests missing a valid platform, UUID deviceId, or clientVersion. */
export function assertClientIdentity(dto: {
  platform: string;
  deviceId: string;
  clientVersion: string;
}): asserts dto is {
  platform: Platform;
  deviceId: string;
  clientVersion: string;
} {
  if (
    !PLATFORMS.includes(dto.platform as Platform) ||
    !UUID_V4.test(dto.deviceId) ||
    typeof dto.clientVersion !== 'string'
  ) {
    throw new BadRequestException({ code: 'invalid_request' });
  }
}
