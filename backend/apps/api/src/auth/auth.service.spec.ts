import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { FindOperator } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { AuthService } from './auth.service.js';
import { Session } from './entities/session.entity.js';
import { User } from './entities/user.entity.js';

const identity = {
  platform: 'macos' as const,
  clientVersion: '1.0.0+12',
  deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
};

const credentials = {
  email: 'a@b.co',
  password: 'correct horse battery staple',
};

type Row = { id?: string } & Record<string, unknown>;

function createInMemoryRepo<T extends Row>(rows: T[]) {
  const matches = (row: T, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, expected]) => {
      const actual = row[key];
      if (expected instanceof FindOperator) {
        if (expected.type === 'isNull') {
          return actual === null || actual === undefined;
        }
        return false;
      }
      return actual === expected;
    });

  return {
    create: (data: Partial<T>) => ({ ...data }) as T,
    save: async (entity: T) => {
      const saved = { ...entity, id: entity.id ?? randomUUID() } as T;
      const index = rows.findIndex((row) => row.id === saved.id);
      if (index >= 0) {
        rows[index] = Object.assign(rows[index], saved);
        return rows[index];
      }
      rows.push(saved);
      return saved;
    },
    findOne: async (options: { where: Record<string, unknown> }) =>
      rows.find((row) => matches(row, options.where)) ?? null,
    findOneBy: async (where: Record<string, unknown>) =>
      rows.find((row) => matches(row, where)) ?? null,
  };
}

async function buildHarness() {
  const users: User[] = [];
  const sessions: Session[] = [];
  const module = await Test.createTestingModule({
    providers: [
      AuthService,
      {
        provide: getRepositoryToken(User),
        useValue: createInMemoryRepo(users),
      },
      {
        provide: getRepositoryToken(Session),
        useValue: createInMemoryRepo(sessions),
      },
      { provide: JwtService, useValue: new JwtService({ secret: 'test' }) },
    ],
  }).compile();

  return { service: module.get(AuthService), users, sessions };
}

async function buildService() {
  const { service } = await buildHarness();
  return service;
}

describe('AuthService.register', () => {
  it('rejects an unknown platform', async () => {
    const service = await buildService();
    await expect(
      service.register({
        email: 'a@b.co',
        password: 'correct horse battery staple',
        ...identity,
        platform: 'linux' as never,
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'invalid_request' },
    });
  });

  it('hashes the password with argon2id and returns tokens', async () => {
    const { service, users } = await buildHarness();
    const result = await service.register({
      email: 'a@b.co',
      password: 'correct horse battery staple',
      ...identity,
    });
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(result.expiresIn).toBe(900);
    expect(users[0]?.passwordHash.startsWith('$argon2id$')).toBe(true);
    await expect(
      argon2.verify(users[0]!.passwordHash, 'correct horse battery staple'),
    ).resolves.toBe(true);
  });

  it('rejects a malformed deviceId', async () => {
    const service = await buildService();
    await expect(
      service.register({
        ...credentials,
        ...identity,
        deviceId: 'not-a-uuid',
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'invalid_request' },
    });
  });

  it('rejects a duplicate email', async () => {
    const service = await buildService();
    await service.register({ ...credentials, ...identity });
    await expect(
      service.register({ ...credentials, ...identity }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('AuthService.login', () => {
  it('verifies argon2 and rotates the session for the device', async () => {
    const { service, sessions } = await buildHarness();
    const registered = await service.register({ ...credentials, ...identity });
    const loggedIn = await service.login({ ...credentials, ...identity });

    expect(loggedIn.accessToken).toEqual(expect.any(String));
    expect(loggedIn.refreshToken).toEqual(expect.any(String));
    expect(loggedIn.refreshToken).not.toBe(registered.refreshToken);
    expect(loggedIn.expiresIn).toBe(900);
    expect(sessions).toHaveLength(2);
    expect(
      sessions.filter((session) => session.revokedAt == null),
    ).toHaveLength(1);

    const payload = new JwtService({ secret: 'test' }).verify<{
      sub: string;
      sid: string;
      platform: string;
      deviceId: string;
    }>(loggedIn.accessToken);
    expect(payload).toMatchObject({
      platform: identity.platform,
      deviceId: identity.deviceId,
    });
    expect(payload.sid).toBe(
      sessions.find((session) => session.revokedAt == null)?.id,
    );
  });

  it('rejects an unknown platform', async () => {
    const service = await buildService();
    await service.register({ ...credentials, ...identity });
    await expect(
      service.login({
        ...credentials,
        ...identity,
        platform: 'linux' as never,
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'invalid_request' },
    });
  });

  it('rejects a bad password', async () => {
    const service = await buildService();
    await service.register({ ...credentials, ...identity });
    await expect(
      service.login({
        ...credentials,
        ...identity,
        password: 'wrong password',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
