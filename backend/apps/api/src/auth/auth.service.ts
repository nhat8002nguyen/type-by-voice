import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  NOTIFICATIONS_EMAIL_EVENT,
  NOTIFICATIONS_SERVICE,
} from '../../../../libs/notifications/src/tokens.js';
import { OutboxService } from '../../../../libs/outbox/src/outbox.service.js';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, IsNull, QueryFailedError, Repository } from 'typeorm';
import { assertClientIdentity } from './assert-client-identity.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
} from './auth.constants.js';
import type { ClientIdentityDto } from './dto/client-identity.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import {
  AuthToken,
  type AuthTokenPurpose,
} from './entities/auth-token.entity.js';
import { Session } from './entities/session.entity.js';
import { User } from './entities/user.entity.js';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard.js';

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: typeof ACCESS_TOKEN_TTL_SECONDS;
};

export type UserProfile = {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
};

export type SessionView = {
  id: string;
  platform: Session['platform'];
  clientVersion: string;
  deviceId: string;
  createdAt: Date;
};

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError = error.driverError as { code?: string };
  return driverError.code === '23505';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Session)
    private readonly sessions: Repository<Session>,
    @InjectRepository(AuthToken)
    private readonly tokens: Repository<AuthToken>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly outbox: OutboxService,
    @Optional() private readonly rateLimit?: RateLimitGuard,
  ) {}

  async register(dto: RegisterDto, userAgent?: string): Promise<AuthTokens> {
    assertClientIdentity(dto);
    const email = normalizeEmail(dto.email);
    const existing = await this.users.findOneBy({ email });
    if (existing) {
      throw new ConflictException();
    }

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });
    let user: User;
    try {
      user = await this.users.save(
        this.users.create({
          email,
          passwordHash,
          emailVerifiedAt: null,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException();
      }
      throw error;
    }

    const verifyToken = await this.issueAuthToken(user.id, 'verify-email');
    await this.enqueueEmail({
      type: 'verify-email',
      userId: user.id,
      email: user.email,
      token: verifyToken,
    });

    return this.issueTokens(user, dto, { userAgent });
  }

  async login(
    dto: LoginDto,
    userAgent?: string,
    ip?: string,
  ): Promise<AuthTokens> {
    assertClientIdentity(dto);
    const email = normalizeEmail(dto.email);
    try {
      const user = await this.users.findOneBy({ email });
      if (!user) {
        throw new UnauthorizedException();
      }

      const passwordMatches = await argon2.verify(
        user.passwordHash,
        dto.password,
      );
      if (!passwordMatches) {
        throw new UnauthorizedException();
      }

      const tokens = await this.issueTokens(user, dto, {
        rotate: true,
        userAgent,
      });
      await this.rateLimit?.recordSuccess(email);
      return tokens;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        await this.rateLimit?.recordFailure(email, ip ?? '');
      }
      throw error;
    }
  }

  async refresh(
    refreshToken: string,
    identity: ClientIdentityDto,
    userAgent?: string,
  ): Promise<AuthTokens> {
    assertClientIdentity(identity);
    const session = await this.sessions.findOneBy({
      refreshTokenHash: hashToken(refreshToken),
    });
    if (
      !session ||
      session.revokedAt != null ||
      session.expiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException();
    }

    const deviceId = identity.deviceId.toLowerCase();
    if (
      session.platform !== identity.platform ||
      session.deviceId !== deviceId
    ) {
      throw new BadRequestException({ code: 'invalid_request' });
    }

    const user = await this.users.findOneBy({ id: session.userId });
    if (!user) {
      throw new UnauthorizedException();
    }

    return this.issueTokens(user, identity, { rotate: true, userAgent });
  }

  async logout(sessionId: string): Promise<void> {
    const session = await this.sessions.findOneBy({ id: sessionId });
    if (!session || session.revokedAt != null) {
      return;
    }
    session.revokedAt = new Date();
    await this.sessions.save(session);
  }

  async verifyEmail(token: string): Promise<void> {
    const authToken = await this.consumeToken(token, 'verify-email');
    const user = await this.users.findOneBy({ id: authToken.userId });
    if (!user) {
      throw new UnauthorizedException();
    }
    user.emailVerifiedAt = new Date();
    await this.users.save(user);
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.users.findOneBy({ email: normalizeEmail(email) });
    if (!user) {
      return;
    }

    const token = await this.issueAuthToken(user.id, 'reset-password');
    await this.enqueueEmail({
      type: 'reset-password',
      userId: user.id,
      email: user.email,
      token,
    });
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
    });
    await this.dataSource.transaction(async (em) => {
      const tokens = em.getRepository(AuthToken);
      const users = em.getRepository(User);
      const sessions = em.getRepository(Session);
      const authToken = await this.consumeTokenIn(
        tokens,
        token,
        'reset-password',
      );
      const user = await users.findOneBy({ id: authToken.userId });
      if (!user) {
        throw new UnauthorizedException();
      }
      user.passwordHash = passwordHash;
      await users.save(user);
      await sessions.update(
        { userId: user.id, revokedAt: IsNull() },
        { revokedAt: new Date() },
      );
      await tokens.update(
        { userId: user.id, purpose: 'reset-password', consumedAt: IsNull() },
        { consumedAt: new Date() },
      );
    });
  }

  async loadAccessSession(payload: { sub: string; sid: string }): Promise<{
    user: User;
    session: Session;
  }> {
    const session = await this.sessions.findOneBy({ id: payload.sid });
    if (
      !session ||
      session.userId !== payload.sub ||
      session.revokedAt != null ||
      session.expiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException();
    }
    const user = await this.users.findOneBy({ id: payload.sub });
    if (!user) {
      throw new UnauthorizedException();
    }
    return { user, session };
  }

  async getMe(userId: string): Promise<UserProfile> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) {
      throw new UnauthorizedException();
    }
    return {
      id: user.id,
      email: user.email,
      emailVerifiedAt: user.emailVerifiedAt,
    };
  }

  async listSessions(userId: string): Promise<SessionView[]> {
    const rows = await this.sessions.find({
      where: { userId, revokedAt: IsNull() },
    });
    return rows.map((session) => ({
      id: session.id,
      platform: session.platform,
      clientVersion: session.clientVersion,
      deviceId: session.deviceId,
      createdAt: session.createdAt,
    }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.sessions.findOneBy({ id: sessionId, userId });
    if (!session || session.revokedAt != null) {
      throw new NotFoundException();
    }
    session.revokedAt = new Date();
    await this.sessions.save(session);
  }

  private async issueAuthToken(
    userId: string,
    purpose: AuthTokenPurpose,
  ): Promise<string> {
    const raw = randomBytes(32).toString('hex');
    await this.tokens.save(
      this.tokens.create({
        userId,
        purpose,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + AUTH_TOKEN_TTL_MS),
        consumedAt: null,
      }),
    );
    return raw;
  }

  private async consumeToken(
    token: string,
    purpose: AuthTokenPurpose,
  ): Promise<AuthToken> {
    return this.consumeTokenIn(this.tokens, token, purpose);
  }

  private async consumeTokenIn(
    tokens: Repository<AuthToken>,
    token: string,
    purpose: AuthTokenPurpose,
  ): Promise<AuthToken> {
    const authToken = await tokens.findOneBy({
      tokenHash: hashToken(token),
      purpose,
    });
    if (
      !authToken ||
      authToken.consumedAt != null ||
      authToken.expiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException();
    }
    authToken.consumedAt = new Date();
    await tokens.save(authToken);
    return authToken;
  }

  private async enqueueEmail(payload: {
    type: 'verify-email' | 'reset-password';
    userId: string;
    email: string;
    token: string;
  }): Promise<void> {
    await this.outbox.enqueue({
      type: NOTIFICATIONS_EMAIL_EVENT,
      target: NOTIFICATIONS_SERVICE,
      payload: { ...payload },
    });
  }

  private async issueTokens(
    user: User,
    identity: ClientIdentityDto,
    options?: { rotate?: boolean; userAgent?: string },
  ): Promise<AuthTokens> {
    const deviceId = identity.deviceId.toLowerCase();
    const refreshToken = randomBytes(32).toString('hex');
    const session = await this.saveRotatedSession({
      user,
      identity,
      deviceId,
      refreshToken,
      rotate: options?.rotate === true,
      userAgent: options?.userAgent,
    });

    const accessToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        sid: session.id,
        platform: identity.platform,
        deviceId,
      },
      { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  private async saveRotatedSession(input: {
    user: User;
    identity: ClientIdentityDto;
    deviceId: string;
    refreshToken: string;
    rotate: boolean;
    userAgent?: string;
  }): Promise<Session> {
    const persist = (): Promise<Session> =>
      this.dataSource.transaction(async (em) => {
        const sessions = em.getRepository(Session);
        if (input.rotate) {
          await sessions.update(
            {
              userId: input.user.id,
              deviceId: input.deviceId,
              revokedAt: IsNull(),
            },
            { revokedAt: new Date() },
          );
        }
        return sessions.save(
          sessions.create({
            userId: input.user.id,
            refreshTokenHash: hashToken(input.refreshToken),
            platform: input.identity.platform,
            clientVersion: input.identity.clientVersion,
            deviceId: input.deviceId,
            userAgent: input.userAgent ?? null,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
            revokedAt: null,
          }),
        );
      });

    try {
      return await persist();
    } catch (error) {
      if (!input.rotate || !isUniqueViolation(error)) {
        throw error;
      }
      return persist();
    }
  }
}
