import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessAuthGuard } from '../auth/access-auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { Session } from '../auth/entities/session.entity.js';
import { User } from '../auth/entities/user.entity.js';
import { UsersController } from './users.controller.js';

const user = {
  id: 'user-1',
  email: 'a@b.co',
  emailVerifiedAt: null,
  sessionId: 'sid-1',
};

describe('UsersController', () => {
  it('returns the current user profile', async () => {
    const profile = { id: user.id, email: user.email, emailVerifiedAt: null };
    const module = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: AuthService,
          useValue: { getMe: vi.fn().mockResolvedValue(profile) },
        },
      ],
    })
      .overrideGuard(AccessAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const controller = module.get(UsersController);
    await expect(controller.me(user)).resolves.toEqual(profile);
  });

  it('lists sessions for the current user', async () => {
    const sessions = [
      {
        id: 's1',
        platform: 'macos',
        clientVersion: '1.0.0+12',
        deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
        createdAt: new Date('2026-09-17T00:00:00.000Z'),
      },
    ];
    const module = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: AuthService,
          useValue: { listSessions: vi.fn().mockResolvedValue(sessions) },
        },
      ],
    })
      .overrideGuard(AccessAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const controller = module.get(UsersController);
    await expect(controller.listSessions(user)).resolves.toEqual(sessions);
  });

  it('revokes a session owned by the current user', async () => {
    const revokeSession = vi.fn().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: AuthService,
          useValue: { revokeSession },
        },
      ],
    })
      .overrideGuard(AccessAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const controller = module.get(UsersController);
    await expect(controller.revokeSession(user, 's1')).resolves.toBeUndefined();
    expect(revokeSession).toHaveBeenCalledWith(user.id, 's1');
  });
});

describe('Users HTTP access guard', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  it('returns 401 without a bearer token', async () => {
    const module = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        AccessAuthGuard,
        { provide: AuthService, useValue: { getMe: vi.fn() } },
        { provide: JwtService, useValue: new JwtService({ secret: 'test' }) },
        { provide: getRepositoryToken(Session), useValue: {} },
        { provide: getRepositoryToken(User), useValue: {} },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();

    const response = await request(app.getHttpServer()).get('/v1/me');
    expect(response.status).toBe(401);
  });
});
