import { Test } from '@nestjs/testing';
import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('returns terminus health', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'ok' });
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: { check } },
        { provide: TypeOrmHealthIndicator, useValue: { pingCheck: vi.fn() } },
      ],
    }).compile();
    await expect(module.get(HealthController).check()).resolves.toEqual({ status: 'ok' });
  });
});
