import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppValidationPipe } from '../create-app-validation-pipe.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

const validBody = {
  email: 'a@b.co',
  password: 'correct horse battery staple',
  platform: 'macos',
  clientVersion: '1.0.0+12',
  deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
};

describe('Auth HTTP identity', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  async function createApp() {
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            register: vi.fn(),
            login: vi.fn(),
          },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    return app;
  }

  it('returns invalid_request for an unknown platform', async () => {
    await createApp();
    const response = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ ...validBody, platform: 'linux' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ code: 'invalid_request' });
  });

  it('returns invalid_request for a malformed deviceId', async () => {
    await createApp();
    const response = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ ...validBody, deviceId: 'not-a-uuid' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ code: 'invalid_request' });
  });

  it('does not remap an invalid email as invalid_request', async () => {
    await createApp();
    const response = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ ...validBody, email: 'not-an-email' });

    expect(response.status).toBe(400);
    expect(response.body).not.toEqual({ code: 'invalid_request' });
  });
});
