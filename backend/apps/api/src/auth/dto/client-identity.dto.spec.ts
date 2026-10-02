import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ClientIdentityDto } from './client-identity.dto.js';

function makeDto(platform: string): ClientIdentityDto {
  const dto = new ClientIdentityDto();
  dto.platform = platform as ClientIdentityDto['platform'];
  dto.clientVersion = '1.0.0+12';
  dto.deviceId = '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77';
  return dto;
}

describe('ClientIdentityDto', () => {
  it('accepts platform linux', async () => {
    await expect(validate(makeDto('linux'))).resolves.toHaveLength(0);
  });

  it('rejects an unknown platform', async () => {
    const errors = await validate(makeDto('beos'));
    expect(errors.length).toBeGreaterThan(0);
  });
});
