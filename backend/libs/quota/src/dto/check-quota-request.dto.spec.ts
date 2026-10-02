import 'reflect-metadata';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CheckQuotaRequestDto } from './check-quota.dto.js';

const validUuid = '11111111-1111-4111-8111-111111111111';

function checkQuotaRequest(
  overrides: Partial<CheckQuotaRequestDto> = {},
): CheckQuotaRequestDto {
  return Object.assign(new CheckQuotaRequestDto(), {
    userId: validUuid,
    sessionId: '22222222-2222-4222-8222-222222222222',
    platform: 'macos',
    clientVersion: '1.0.0',
    deviceId: '33333333-3333-4333-8333-333333333333',
    ...overrides,
  });
}

describe('CheckQuotaRequestDto', () => {
  it('accepts macos with uuid v4 identities', async () => {
    const errors = await validate(checkQuotaRequest());
    expect(errors).toEqual([]);
  });

  it('rejects an unknown platform and a non-uuid deviceId', async () => {
    const errors = await validate(
      checkQuotaRequest({
        platform: 'beos' as CheckQuotaRequestDto['platform'],
        deviceId: 'not-a-uuid',
      }),
    );
    expect(errors.map((error) => error.property).sort()).toEqual([
      'deviceId',
      'platform',
    ]);
  });
});
