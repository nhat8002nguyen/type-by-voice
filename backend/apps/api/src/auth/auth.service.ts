import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { IsNull, QueryFailedError, Repository } from 'typeorm';
import { assertClientIdentity } from './assert-client-identity.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_MS,
} from './auth.constants.js';
import type { ClientIdentityDto } from './dto/client-identity.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { Session } from './entities/session.entity.js';
import { User } from './entities/user.entity.js';

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: typeof ACCESS_TOKEN_TTL_SECONDS;
};

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError = error.driverError as { code?: string };
  return driverError.code === '23505';
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Session)
    private readonly sessions: Repository<Session>,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthTokens> {
    assertClientIdentity(dto);
    const existing = await this.users.findOneBy({ email: dto.email });
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
          email: dto.email,
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

    return this.issueTokens(user, dto);
  }

  async login(dto: LoginDto): Promise<AuthTokens> {
    assertClientIdentity(dto);
    const user = await this.users.findOneBy({ email: dto.email });
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

    return this.issueTokens(user, dto, { rotate: true });
  }

  private async issueTokens(
    user: User,
    identity: ClientIdentityDto,
    options?: { rotate?: boolean },
  ): Promise<AuthTokens> {
    const deviceId = identity.deviceId.toLowerCase();
    if (options?.rotate) {
      const active = await this.sessions.findOne({
        where: { userId: user.id, deviceId, revokedAt: IsNull() },
      });
      if (active) {
        active.revokedAt = new Date();
        await this.sessions.save(active);
      }
    }

    const refreshToken = randomBytes(32).toString('hex');
    const refreshTokenHash = createHash('sha256')
      .update(refreshToken)
      .digest('hex');
    const session = await this.sessions.save(
      this.sessions.create({
        userId: user.id,
        refreshTokenHash,
        platform: identity.platform,
        clientVersion: identity.clientVersion,
        deviceId,
        userAgent: null,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        revokedAt: null,
      }),
    );

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
}
