import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Session } from './entities/session.entity.js';
import { User } from './entities/user.entity.js';

export const REQUEST_USER_KEY = 'user';

export type RequestUser = {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  sessionId: string;
};

@Injectable()
export class AccessAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(Session)
    private readonly sessions: Repository<Session>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      [REQUEST_USER_KEY]?: RequestUser;
    }>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException();
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException();
    }

    let payload: { sub?: string; sid?: string };
    try {
      payload = await this.jwtService.verifyAsync(token);
    } catch {
      throw new UnauthorizedException();
    }
    if (!payload.sub || !payload.sid) {
      throw new UnauthorizedException();
    }

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

    request[REQUEST_USER_KEY] = {
      id: user.id,
      email: user.email,
      emailVerifiedAt: user.emailVerifiedAt,
      sessionId: session.id,
    };
    return true;
  }
}
