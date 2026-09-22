import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QUOTA_CHECK_PATTERN,
  QUOTA_SERVICE,
} from '../../../../libs/quota/src/tokens.js';
import { AccessAuthGuard } from '../auth/access-auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { MeQuotaController } from './quota.controller.js';

function sendProxy(send: ReturnType<typeof vi.fn>) {
  return { send } as never;
}

describe('MeQuotaController', () => {
  it('GET /v1/me/quota returns the check snapshot', async () => {
    const send = vi
      .fn()
      .mockReturnValue(
        of({
          allowed: true,
          quota: {
            unit: 'words',
            limit: 2000,
            used: 312,
            resetAt: '2026-09-18T04:12:00Z',
          },
        }),
      );
    const controller = new MeQuotaController(sendProxy(send));
    await expect(
      controller.get({
        userId: 'user-1',
        sessionId: 's',
        platform: 'macos',
        clientVersion: '1.0.0+12',
        deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
      }),
    ).resolves.toEqual({
      unit: 'words',
      limit: 2000,
      used: 312,
      resetAt: '2026-09-18T04:12:00Z',
    });
  });

  it('maps the current user onto quota.check', async () => {
    const send = vi.fn().mockReturnValue(
      of({
        allowed: true,
        quota: {
          unit: 'words',
          limit: 2000,
          used: 312,
          resetAt: '2026-09-18T04:12:00Z',
        },
      }),
    );
    const controller = new MeQuotaController(sendProxy(send));
    await controller.snapshot({
      id: 'user-1',
      email: 'a@b.co',
      emailVerifiedAt: null,
      sessionId: 's',
      platform: 'macos',
      clientVersion: '1.0.0+12',
      deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
    });
    expect(send).toHaveBeenCalledWith(QUOTA_CHECK_PATTERN, {
      userId: 'user-1',
      sessionId: 's',
      platform: 'macos',
      clientVersion: '1.0.0+12',
      deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
    });
  });
});

describe('MeQuota HTTP access guard', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  it('returns 401 without a bearer token', async () => {
    const module = await Test.createTestingModule({
      controllers: [MeQuotaController],
      providers: [
        AccessAuthGuard,
        { provide: QUOTA_SERVICE, useValue: { send: vi.fn() } },
        { provide: JwtService, useValue: new JwtService({ secret: 'test' }) },
        { provide: AuthService, useValue: {} },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();

    const response = await request(app.getHttpServer()).get('/v1/me/quota');
    expect(response.status).toBe(401);
  });
});
