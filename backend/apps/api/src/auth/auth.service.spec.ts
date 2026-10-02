import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OutboxService } from '../../../../libs/outbox/src/outbox.service.js';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { DataSource, FindOperator } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { AuthService } from './auth.service.js';
import { AuthToken } from './entities/auth-token.entity.js';
import { Session } from './entities/session.entity.js';
import { User } from './entities/user.entity.js';

type OutboxRow = {
  type: string;
  payload: Record<string, unknown>;
  target: string;
};

const identity = {
  platform: 'macos' as const,
  clientVersion: '1.0.0+12',
  deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
};

const credentials = {
  email: 'a@b.co',
  password: 'correct horse battery staple',
};

type Row = { id?: string | number } & Record<string, unknown>;

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
    find: async (options: { where: Record<string, unknown> }) =>
      rows.filter((row) => matches(row, options.where)),
    findOne: async (options: { where: Record<string, unknown> }) =>
      rows.find((row) => matches(row, options.where)) ?? null,
    findOneBy: async (where: Record<string, unknown>) =>
      rows.find((row) => matches(row, where)) ?? null,
    update: async (
      where: Record<string, unknown>,
      partial: Record<string, unknown>,
    ) => {
      let affected = 0;
      for (const row of rows) {
        if (matches(row, where)) {
          Object.assign(row, partial);
          affected += 1;
        }
      }
      return { affected };
    },
  };
}

async function buildHarness() {
  const users: User[] = [];
  const sessions: Session[] = [];
  const tokens: AuthToken[] = [];
  const outbox: OutboxRow[] = [];
  const userRepo = createInMemoryRepo(users);
  const sessionRepo = createInMemoryRepo(sessions);
  const tokenRepo = createInMemoryRepo(tokens);
  const module = await Test.createTestingModule({
    providers: [
      AuthService,
      {
        provide: DataSource,
        useValue: {
          transaction: async (
            run: (em: {
              getRepository: (entity: unknown) => unknown;
            }) => Promise<unknown>,
          ) =>
            run({
              getRepository: (entity: unknown) => {
                if (entity === User) {
                  return userRepo;
                }
                if (entity === Session) {
                  return sessionRepo;
                }
                if (entity === AuthToken) {
                  return tokenRepo;
                }
                throw new Error('unknown entity');
              },
            }),
        },
      },
      {
        provide: OutboxService,
        useValue: {
          enqueue: async (message: {
            type: string;
            payload: Record<string, unknown>;
            target: string | symbol;
          }) => {
            const row = {
              type: message.type,
              payload: message.payload,
              target:
                typeof message.target === 'symbol'
                  ? (message.target.description ?? String(message.target))
                  : message.target,
            };
            outbox.push(row);
            return row;
          },
        },
      },
      {
        provide: getRepositoryToken(User),
        useValue: userRepo,
      },
      {
        provide: getRepositoryToken(Session),
        useValue: sessionRepo,
      },
      {
        provide: getRepositoryToken(AuthToken),
        useValue: tokenRepo,
      },
      { provide: JwtService, useValue: new JwtService({ secret: 'test' }) },
    ],
  }).compile();

  return {
    service: module.get(AuthService),
    users,
    sessions,
    tokens,
    outbox,
  };
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
        platform: 'beos' as never,
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

  it('normalizes email case on write so mixed-case duplicates conflict', async () => {
    const { service, users } = await buildHarness();
    await service.register({
      ...credentials,
      ...identity,
      email: 'A@B.CO',
    });
    expect(users[0]?.email).toBe('a@b.co');
    await expect(
      service.register({ ...credentials, ...identity, email: 'a@b.co' }),
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
        platform: 'beos' as never,
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

  it('looks up the account by normalized email', async () => {
    const service = await buildService();
    await service.register({ ...credentials, ...identity, email: 'A@B.CO' });
    const loggedIn = await service.login({
      ...credentials,
      ...identity,
      email: 'a@b.co',
    });
    expect(loggedIn.accessToken).toEqual(expect.any(String));
  });
});

describe('AuthService.refresh', () => {
  it('refresh rotates the refresh token and rejects platform mismatch', async () => {
    const service = await buildService();
    const registered = await service.register({
      email: 'a@b.co',
      password: 'correct horse battery staple',
      platform: 'macos',
      clientVersion: '1.0.0+12',
      deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
    });
    const next = await service.refresh(registered.refreshToken, {
      platform: 'macos',
      clientVersion: '1.0.0+12',
      deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
    });
    expect(next.refreshToken).not.toBe(registered.refreshToken);
    await expect(
      service.refresh(next.refreshToken, {
        platform: 'windows',
        clientVersion: '1.0.0+12',
        deviceId: '9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77',
      }),
    ).rejects.toMatchObject({ response: { code: 'invalid_request' } });
  });

  it('rejects a reused refresh token after rotate', async () => {
    const service = await buildService();
    const registered = await service.register({ ...credentials, ...identity });
    await service.refresh(registered.refreshToken, identity);
    await expect(
      service.refresh(registered.refreshToken, identity),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthService.forgotPassword', () => {
  it('forgot-password is idempotent for unknown emails', async () => {
    const service = await buildService();
    await expect(
      service.forgotPassword('nobody@x.co'),
    ).resolves.toBeUndefined();
  });

  it('enqueues a reset-password email for a known account', async () => {
    const { service, outbox, users } = await buildHarness();
    await service.register({ ...credentials, ...identity });
    outbox.length = 0;
    await expect(
      service.forgotPassword(credentials.email),
    ).resolves.toBeUndefined();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      type: 'notifications.email',
      target: 'NOTIFICATIONS_SERVICE',
      payload: {
        type: 'reset-password',
        userId: users[0]?.id,
        email: credentials.email,
      },
    });
    expect(outbox[0]?.payload.token).toEqual(expect.any(String));
  });
});

describe('AuthService.logout', () => {
  it('sets revokedAt on the current session', async () => {
    const { service, sessions } = await buildHarness();
    const registered = await service.register({ ...credentials, ...identity });
    const payload = new JwtService({ secret: 'test' }).verify<{ sid: string }>(
      registered.accessToken,
    );
    await service.logout(payload.sid);
    expect(
      sessions.find((session) => session.id === payload.sid)?.revokedAt,
    ).toEqual(expect.any(Date));
  });
});

describe('AuthService.verifyEmail', () => {
  it('marks the user verified from the emailed token', async () => {
    const { service, outbox, users } = await buildHarness();
    await service.register({ ...credentials, ...identity });
    const token = String(outbox[0]?.payload.token);
    await service.verifyEmail(token);
    expect(users[0]?.emailVerifiedAt).toEqual(expect.any(Date));
  });
});

describe('AuthService.resetPassword', () => {
  it('updates the password hash from the emailed token', async () => {
    const { service, outbox, users } = await buildHarness();
    await service.register({ ...credentials, ...identity });
    outbox.length = 0;
    await service.forgotPassword(credentials.email);
    const token = String(outbox[0]?.payload.token);
    await service.resetPassword(token, 'new horse battery staple');
    await expect(
      argon2.verify(users[0]!.passwordHash, 'new horse battery staple'),
    ).resolves.toBe(true);
  });

  it('revokes every session and remaining reset tokens with the password update', async () => {
    const { service, sessions, tokens, outbox } = await buildHarness();
    const registered = await service.register({ ...credentials, ...identity });
    await service.login({
      ...credentials,
      ...identity,
      deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
    });
    outbox.length = 0;
    await service.forgotPassword(credentials.email);
    await service.forgotPassword(credentials.email);
    const token = String(outbox[1]?.payload.token);
    await service.resetPassword(token, 'new horse battery staple');

    expect(sessions.every((session) => session.revokedAt != null)).toBe(true);
    expect(
      tokens
        .filter((row) => row.purpose === 'reset-password')
        .every((row) => row.consumedAt != null),
    ).toBe(true);
    await expect(
      service.refresh(registered.refreshToken, identity),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthService profile and sessions', () => {
  it('returns the account profile', async () => {
    const { service, users } = await buildHarness();
    await service.register({ ...credentials, ...identity });
    await expect(service.getMe(users[0]!.id)).resolves.toEqual({
      id: users[0]!.id,
      email: credentials.email,
      emailVerifiedAt: null,
    });
  });

  it('lists non-revoked sessions including createdAt', async () => {
    const { service, users, sessions } = await buildHarness();
    const registered = await service.register(
      { ...credentials, ...identity },
      'TypeByVoice/1.0',
    );
    const payload = new JwtService({ secret: 'test' }).verify<{ sid: string }>(
      registered.accessToken,
    );
    await service.logout(payload.sid);
    await service.login({ ...credentials, ...identity });
    const listed = await service.listSessions(users[0]!.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: sessions.find((session) => session.revokedAt == null)?.id,
      platform: 'macos',
      clientVersion: '1.0.0+12',
      deviceId: identity.deviceId,
    });
    expect(listed[0]?.createdAt).toEqual(expect.any(Date));
  });

  it('revokes a session by id for the owner', async () => {
    const { service, users, sessions } = await buildHarness();
    await service.register({ ...credentials, ...identity });
    const active = sessions.find((session) => session.revokedAt == null);
    await service.revokeSession(users[0]!.id, active!.id);
    expect(
      sessions.find((session) => session.id === active!.id)?.revokedAt,
    ).toEqual(expect.any(Date));
  });

  it('persists deviceId lowercase and stores userAgent', async () => {
    const { service, sessions } = await buildHarness();
    await service.register(
      {
        ...credentials,
        ...identity,
        deviceId: '9C1E4A2B-7D55-4F3A-9E10-2B8C0D1A4F77',
      },
      'TypeByVoice/1.0',
    );
    expect(sessions[0]?.deviceId).toBe('9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77');
    expect(sessions[0]?.userAgent).toBe('TypeByVoice/1.0');
  });

  it('rejects a revoked session on access load', async () => {
    const { service, sessions } = await buildHarness();
    const registered = await service.register({ ...credentials, ...identity });
    const payload = new JwtService({ secret: 'test' }).verify<{
      sub: string;
      sid: string;
    }>(registered.accessToken);
    sessions.find((session) => session.id === payload.sid)!.revokedAt =
      new Date();
    await expect(service.loadAccessSession(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('enqueues a verify-email outbox row on register', async () => {
    const { service, outbox, users } = await buildHarness();
    await service.register({ ...credentials, ...identity });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      type: 'notifications.email',
      target: 'NOTIFICATIONS_SERVICE',
      payload: {
        type: 'verify-email',
        userId: users[0]?.id,
        email: credentials.email,
      },
    });
    expect(outbox[0]?.payload.token).toEqual(expect.any(String));
  });
});
