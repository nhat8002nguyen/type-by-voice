import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Platform } from '@type-by-voice/dictation-v1';
import { AuthService } from './auth.service.js';

export const REQUEST_USER_KEY = 'user';

export type RequestUser = {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  sessionId: string;
  platform: Platform;
  deviceId: string;
  clientVersion: string;
};

@Injectable()
export class AccessAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
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

    const { user, session } = await this.authService.loadAccessSession({
      sub: payload.sub,
      sid: payload.sid,
    });

    request[REQUEST_USER_KEY] = {
      id: user.id,
      email: user.email,
      emailVerifiedAt: user.emailVerifiedAt,
      sessionId: session.id,
      platform: session.platform,
      deviceId: session.deviceId,
      clientVersion: session.clientVersion,
    };
    return true;
  }
}
